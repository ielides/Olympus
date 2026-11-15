"""Generate combined GeoTIFF and individual layer preview PNGs in a single pass."""
import argparse
from contextlib import ExitStack
from datetime import datetime, timezone
import json
from pathlib import Path
import time
import numpy as np
import rasterio
from rasterio.windows import Window

ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    "geologia": "geologia_viabilidad_1a4.tif",
    "accidentes": "accidentes_viabilidad_1a4.tif",
    "radiacion": "radiacion_viabilidad_1a4.tif",
    "pendientes": "pendientesviables0.tif",
}
LAYER_META = {
    "combinada": {
        "id": "combinada",
        "title": "Peligrosidad Combinada",
        "description": "Integración conservadora de las 4 capas: cualquier 4 veta la celda. El valor máximo (1-3) determina el riesgo.",
        "file": "combinada.png"
    },
    "radiacion": {
        "id": "radiacion",
        "title": "Radiación Cósmica / Solar",
        "description": "Dosis estimada anual en función de la elevación y columna atmosférica protectora.",
        "file": "radiacion.png"
    },
    "geologia": {
        "id": "geologia",
        "title": "Geología y Unidades de Superficie",
        "description": "Clasificación de 44 unidades geológicas del mapa global USGS/NASA según firmeza y rugosidad.",
        "file": "geologia.png"
    },
    "accidentes": {
        "id": "accidentes",
        "title": "Accidentes Geológicos y Morfológicos",
        "description": "Bordes de cráter, calderas, rilles, escarpes, fallas tectónicas y crestas.",
        "file": "accidentes.png"
    },
    "pendientes": {
        "id": "pendientes",
        "title": "Inclinación y Pendientes",
        "description": "Inclinación del terreno: <5° suave (1), 5-10° moderada (2), 10-20° difícil (3), >20° intransitable (4).",
        "file": "pendientes.png"
    }
}
COLORS = [[32, 43, 58], [51, 180, 122], [244, 203, 82], [235, 133, 60], [169, 48, 64]]


def check_grid(source, reference):
    if source.count != 1 or source.crs != reference.crs or source.shape != reference.shape:
        raise ValueError(f"Cuadrícula o CRS incompatible: {source.name}")
    if not source.transform.almost_equals(reference.transform, precision=1e-5):
        raise ValueError(f"Transformación incompatible: {source.name}")
    if not source.crs or not source.crs.is_projected or source.crs.linear_units != "metre":
        raise ValueError("Se requiere una cuadrícula marciana proyectada en metros")
    if not all(350 <= resolution <= 500 for resolution in source.res):
        raise ValueError("Solo se admiten datos de aproximadamente 400 m (350–500 m)")
    if "mars" not in source.crs.to_wkt().lower() or "jezero_dem" in str(source.name).lower():
        raise ValueError("Se requiere CRS de Marte; no se admite el DEM de Jezero")


def overview_block(values, factor):
    h, w = values.shape
    blocks = values.reshape(h // factor, factor, w // factor, factor)
    result = blocks.max(axis=(1, 3))
    unknown = (blocks == 0).any(axis=(1, 3))
    result[unknown & (result != 4)] = 0
    return result


def clean_array(arr):
    values = np.ma.getdata(arr)
    valid = (~np.ma.getmaskarray(arr)) & np.isin(values, [1, 2, 3, 4])
    return np.where(valid, values, 0).astype(np.uint8), valid


def build_all(input_dir, output_dir, public_dir, factor=16):
    input_dir, output_dir, public_dir = map(Path, (input_dir, output_dir, public_dir))
    output_dir.mkdir(parents=True, exist_ok=True)
    layers_dir = public_dir / "layers"
    layers_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.time()

    with ExitStack() as stack:
        sources_dict = {key: stack.enter_context(rasterio.open(input_dir / name))
                        for key, name in SOURCES.items()}
        ref = next(iter(sources_dict.values()))
        for source in sources_dict.values():
            check_grid(source, ref)

        projection = ref.crs.to_dict()
        radius = float(projection.get("R", projection.get("a", 0)))
        if projection.get("proj") != "eqc" or radius <= 0 or abs(float(projection.get("lat_ts", 0))) > 1e-9:
            raise ValueError("La visualización requiere proyección equirrectangular ecuatorial")

        profile = ref.profile.copy()
        profile.update(driver="GTiff", dtype="uint8", nodata=0, compress="deflate", predictor=2,
                       tiled=True, blockxsize=256, blockysize=256, BIGTIFF="IF_SAFER")

        target = output_dir / "peligrosidad_combinada.tif"
        temporary = output_dir / "peligrosidad_combinada.partial.tif"

        oh, ow = ref.height // factor, ref.width // factor
        overviews = {k: np.zeros((oh, ow), dtype=np.uint8) for k in LAYER_META.keys()}
        counts = {k: np.zeros(5, dtype=np.int64) for k in LAYER_META.keys()}

        with rasterio.open(temporary, "w", **profile) as dst:
            dst.update_tags(rule="maximum; any 4 blocked; missing data blocked",
                            sources=json.dumps(SOURCES), excluded_from_routes="0,4", no_dem="true")
            dst.write_colormap(1, {i: tuple(c) + (255,) for i, c in enumerate(COLORS)})

            for row in range(0, ref.height, 256):
                height = min(256, ref.height - row)
                window = Window(0, row, ref.width, height)

                # Read and clean each layer
                clean_layers = {}
                known_all = np.ones((height, ref.width), dtype=bool)
                blocked_any = np.zeros((height, ref.width), dtype=bool)
                combined = np.zeros((height, ref.width), dtype=np.uint8)

                for k, src in sources_dict.items():
                    raw = src.read(1, window=window, masked=True)
                    clean, valid = clean_array(raw)
                    clean_layers[k] = clean
                    known_all &= valid
                    blocked_any |= valid & (clean == 4)
                    np.maximum(combined, clean, out=combined)
                    counts[k] += np.bincount(clean.ravel(), minlength=5)
                    overviews[k][row // factor:(row + height) // factor] = overview_block(clean, factor)

                combined[~known_all] = 0
                combined[blocked_any] = 4
                counts["combinada"] += np.bincount(combined.ravel(), minlength=5)
                overviews["combinada"][row // factor:(row + height) // factor] = overview_block(combined, factor)

                dst.write(combined, 1, window=window)

                if row % 2560 == 0:
                    pct = 100 * row / ref.height
                    elapsed = time.time() - t0
                    print(f"Progreso: {pct:.1f}% ({elapsed:.1f}s transcurridos)", flush=True)

        temporary.replace(target)
        print(f"GeoTIFF guardado en {target} ({time.time() - t0:.1f}s)", flush=True)

        # Generate PNGs and manifests for each layer
        for k, meta in LAYER_META.items():
            rgb = np.asarray(COLORS, dtype=np.uint8)[overviews[k]]
            png_path = layers_dir / meta["file"]
            with rasterio.open(png_path, "w", driver="PNG", width=rgb.shape[1],
                               height=rgb.shape[0], count=3, dtype="uint8") as dst_png:
                dst_png.write(rgb.transpose(2, 0, 1))

            if k == "combinada":
                # Also save as default public/data/hazard.png
                with rasterio.open(public_dir / "hazard.png", "w", driver="PNG", width=rgb.shape[1],
                                   height=rgb.shape[0], count=3, dtype="uint8") as dst_png:
                    dst_png.write(rgb.transpose(2, 0, 1))

        # Build manifests
        total_cells = ref.width * ref.height
        layers_manifest = {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "width": ref.width, "height": ref.height, "radiusM": radius,
            "resolutionM": ref.res[0],
            "boundsLonLat": (np.asarray(ref.bounds) / radius * 180 / np.pi).tolist(),
            "previewFactor": factor,
            "colors": COLORS,
            "layers": {}
        }

        for k, meta in LAYER_META.items():
            layer_counts = {str(i): int(n) for i, n in enumerate(counts[k])}
            layers_manifest["layers"][k] = {
                **meta,
                "counts": layer_counts,
                "percentages": {str(i): round(100 * int(n) / total_cells, 2) for i, n in enumerate(counts[k])},
                "source": SOURCES.get(k, "combinada")
            }

        (layers_dir / "layers.json").write_text(json.dumps(layers_manifest, indent=2), encoding="utf-8")

        # Keep backwards-compatible hazard.json
        hazard_manifest = {
            "generatedAt": layers_manifest["generatedAt"], "rule": "maximum",
            "sources": SOURCES, "excludedLevels": [0, 4], "resolutionM": ref.res[0],
            "width": ref.width, "height": ref.height, "radiusM": radius,
            "boundsLonLat": layers_manifest["boundsLonLat"],
            "counts": layers_manifest["layers"]["combinada"]["counts"],
            "previewFactor": factor, "previewRule": "4 > sin datos > máximo de 1–3",
            "previewNote": "Vista global conservadora; las rutas usan el GeoTIFF a resolución original.",
            "colors": COLORS, "raster": "peligrosidad_combinada.tif",
            "activeLayers": list(LAYER_META.keys())
        }
        (public_dir / "hazard.json").write_text(json.dumps(hazard_manifest, indent=2), encoding="utf-8")

        print("Todo completado con éxito en", f"{time.time() - t0:.1f}s", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", default="/home/brauliolite/hackaton mapamars/raster")
    parser.add_argument("--output-dir", default=ROOT / "data" / "generated")
    parser.add_argument("--public-dir", default=ROOT / "public" / "data")
    parser.add_argument("--preview-factor", type=int, default=16)
    args = parser.parse_args()
    build_all(args.input_dir, args.output_dir, args.public_dir, args.preview_factor)

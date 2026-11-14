"""Combine already-classified Mars rasters without averaging away exclusions."""
import argparse
from contextlib import ExitStack
from datetime import datetime, timezone
import json
from pathlib import Path

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
COLORS = [[32, 43, 58], [51, 180, 122], [244, 203, 82], [235, 133, 60], [169, 48, 64]]


def combine(arrays):
    """4 vetoes exploration. Otherwise missing/invalid in ANY input yields 0."""
    shape = arrays[0].shape
    risk = np.zeros(shape, dtype=np.uint8)
    known = np.ones(shape, dtype=bool)
    blocked = np.zeros(shape, dtype=bool)
    for array in arrays:
        values = np.ma.getdata(array)
        valid = (~np.ma.getmaskarray(array)) & np.isin(values, [1, 2, 3, 4])
        known &= valid
        blocked |= valid & (values == 4)
        np.maximum(risk, np.where(valid, values, 0).astype(np.uint8), out=risk)
    risk[~known] = 0
    risk[blocked] = 4
    return risk


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
    """Conservative display aggregation: any 4 wins, then unknown, then maximum."""
    h, w = values.shape
    blocks = values.reshape(h // factor, factor, w // factor, factor)
    result = blocks.max(axis=(1, 3))
    unknown = (blocks == 0).any(axis=(1, 3))
    result[unknown & (result != 4)] = 0
    return result


def build(input_dir, output_dir, public_dir, factor=16):
    input_dir, output_dir, public_dir = map(Path, (input_dir, output_dir, public_dir))
    output_dir.mkdir(parents=True, exist_ok=True)
    public_dir.mkdir(parents=True, exist_ok=True)
    with ExitStack() as stack:
        sources = [stack.enter_context(rasterio.open(input_dir / name)) for name in SOURCES.values()]
        ref = sources[0]
        for source in sources:
            check_grid(source, ref)
        # This visualization is a full-world equirectangular texture, not a local map.
        projection = ref.crs.to_dict()
        radius = float(projection.get("R", projection.get("a", 0)))
        if projection.get("proj") != "eqc" or radius <= 0 or abs(float(projection.get("lat_ts", 0))) > 1e-9:
            raise ValueError("La visualización requiere proyección equirrectangular ecuatorial")
        expected = np.array([-np.pi * radius, -np.pi * radius / 2, np.pi * radius, np.pi * radius / 2])
        if not np.allclose(ref.bounds, expected, rtol=0, atol=ref.res[0]):
            raise ValueError("La textura requiere cobertura global -180..180, -90..90")
        if factor < 1 or ref.width % factor or ref.height % factor or 256 % factor:
            raise ValueError("El factor debe dividir 256 y ambas dimensiones")
        profile = ref.profile.copy()
        profile.update(driver="GTiff", dtype="uint8", nodata=0, compress="deflate", predictor=2,
                       tiled=True, blockxsize=256, blockysize=256, BIGTIFF="IF_SAFER")
        target = output_dir / "peligrosidad_combinada.tif"
        temporary = output_dir / "peligrosidad_combinada.partial.tif"
        overview = np.zeros((ref.height // factor, ref.width // factor), dtype=np.uint8)
        counts = np.zeros(5, dtype=np.int64)
        with rasterio.open(temporary, "w", **profile) as dst:
            dst.update_tags(rule="maximum; any 4 blocked; missing data blocked", sources=json.dumps(SOURCES),
                            excluded_from_routes="0,4", no_dem="true")
            dst.write_colormap(1, {i: tuple(c) + (255,) for i, c in enumerate(COLORS)})
            for row in range(0, ref.height, 256):
                height = min(256, ref.height - row)
                window = Window(0, row, ref.width, height)
                values = combine([s.read(1, window=window, masked=True) for s in sources])
                dst.write(values, 1, window=window)
                counts += np.bincount(values.ravel(), minlength=5)
                overview[row // factor:(row + height) // factor] = overview_block(values, factor)
                if row % 2560 == 0:
                    print(f"Combinación: {100 * row / ref.height:.0f}%", flush=True)
        temporary.replace(target)
        rgb = np.asarray(COLORS, dtype=np.uint8)[overview]
        with rasterio.open(public_dir / "hazard.png", "w", driver="PNG", width=rgb.shape[1],
                           height=rgb.shape[0], count=3, dtype="uint8") as dst:
            dst.write(rgb.transpose(2, 0, 1))
        manifest = {
            "generatedAt": datetime.now(timezone.utc).isoformat(), "rule": "maximum",
            "sources": SOURCES, "excludedLevels": [0, 4], "resolutionM": ref.res[0],
            "width": ref.width, "height": ref.height, "radiusM": radius,
            "boundsLonLat": (np.asarray(ref.bounds) / radius * 180 / np.pi).tolist(),
            "counts": {str(i): int(n) for i, n in enumerate(counts)},
            "previewFactor": factor, "previewRule": "4 > sin datos > máximo de 1–3",
            "previewNote": "Vista global conservadora; las rutas usan el GeoTIFF a resolución original.",
            "colors": COLORS, "raster": "peligrosidad_combinada.tif",
        }
        (public_dir / "hazard.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        print(json.dumps(manifest, indent=2), flush=True)
        return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", default=ROOT / "data" / "generated")
    parser.add_argument("--public-dir", default=ROOT / "public" / "data")
    parser.add_argument("--preview-factor", type=int, default=16)
    args = parser.parse_args()
    build(args.input_dir, args.output_dir, args.public_dir, args.preview_factor)

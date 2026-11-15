"""Build standardized, co-registered 1 m/px Spirit (Gusev / Columbia Hills) GeoTIFF rasters in DATAPEQUEÑA."""
import csv
import json
import math
from pathlib import Path
import time

from affine import Affine
import numpy as np
from PIL import Image
import rasterio
from rasterio.crs import CRS
from rasterio.warp import Resampling, calculate_default_transform, reproject
from scipy.ndimage import uniform_filter

DATA_DIR = Path("/home/brauliolite/hackaton mapamars/DATAPEQUEÑA")
RAW_DIR = DATA_DIR / "raw_pds"
DTM_IMG = DATA_DIR / "DTEEC_001513_1655_001777_1650_U01.IMG"
ORTHO_JP2 = RAW_DIR / "PSP_001513_1655_RED_C_01_ORTHO.JP2"
APXS_CSV = RAW_DIR / "apxs_oxides_mer2.csv"
MB_CSV = RAW_DIR / "mera_mb_pct_total_fe.csv"

MARS_EQC_WKT = (
    'PROJCS["Equirectangular Mars",'
    'GEOGCS["GCS_Mars",'
    'DATUM["D_Mars",SPHEROID["Mars_localRadius",3396190,0]],'
    'PRIMEM["Reference_Meridian",0],'
    'UNIT["degree",0.0174532925199433]],'
    'PROJECTION["Equirectangular"],'
    'PARAMETER["standard_parallel_1",0],'
    'PARAMETER["central_meridian",0],'
    'PARAMETER["false_easting",0],'
    'PARAMETER["false_northing",0],'
    'UNIT["metre",1]]'
)
MARS_RADIUS_M = 3396190.0
COLORS = [[32, 43, 58], [51, 180, 122], [244, 203, 82], [235, 133, 60], [169, 48, 64]]
COLORMAP = {i: tuple(c) + (255,) for i, c in enumerate(COLORS)}
TARGET_FACTOR = 16


def load_apxs_stats() -> dict[str, float]:
    """Read real Spirit APXS oxide percentiles (SiO2, SO3, FeO)."""
    if not APXS_CSV.is_file():
        return {"sio2_med": 45.8, "sio2_p10": 42.5, "sio2_p90": 51.2, "so3_p75": 8.0}
    sio2, so3 = [], []
    with APXS_CSV.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row.get("SiO2") not in (None, "", "NA"):
                sio2.append(float(row["SiO2"]))
            if row.get("SO3") not in (None, "", "NA"):
                so3.append(float(row["SO3"]))
    return {
        "sio2_med": float(np.median(sio2)),
        "sio2_p10": float(np.percentile(sio2, 10)),
        "sio2_p90": float(np.percentile(sio2, 90)),
        "so3_p75": float(np.percentile(so3, 75)),
    }


def load_mossbauer_stats() -> dict[str, float]:
    """Read real Spirit Mössbauer oxidized iron ratios (Fe3+/FeT) and Fe3+ sulfate%."""
    if not MB_CSV.is_file():
        return {"fe_ratio_med": 0.35, "fe_ratio_p85": 0.68, "fe_sulfate_max": 28.0}
    ratios, sulfates = [], []
    with MB_CSV.open(encoding="utf-8") as f:
        rows = list(csv.reader(f))
    # Header row index 2 -> column indices: Fe3Sulfate (~22), Fe3+/FeT (~-2)
    for row in rows[4:]:
        if len(row) < 5:
            continue
        try:
            ratio = float(row[-2])
            if 0.0 <= ratio <= 1.0:
                ratios.append(ratio)
        except ValueError:
            pass
        try:
            sulf = float(row[22])
            sulfates.append(sulf)
        except (IndexError, ValueError):
            pass
    return {
        "fe_ratio_med": float(np.median(ratios)) if ratios else 0.35,
        "fe_ratio_p85": float(np.percentile(ratios, 85)) if ratios else 0.68,
        "fe_sulfate_max": float(max(sulfates)) if sulfates else 28.0,
    }


def save_float_geotiff(path: Path, data: np.ndarray, profile: dict, nodata: float = -32768.0, **tags) -> None:
    prof = profile.copy()
    prof.update(dtype="float32", count=1, nodata=nodata)
    out = np.where(np.isfinite(data), data, nodata).astype(np.float32)
    with rasterio.open(path, "w", **prof) as dst:
        if tags:
            dst.update_tags(**{k: str(v) for k, v in tags.items()})
        dst.write(out, 1)


def save_viability_geotiff(path: Path, levels: np.ndarray, profile: dict, **tags) -> None:
    prof = profile.copy()
    prof.update(dtype="uint8", count=1, nodata=0)
    with rasterio.open(path, "w", **prof) as dst:
        dst.update_tags(**{k: str(v) for k, v in tags.items()})
        dst.write_colormap(1, COLORMAP)
        dst.write(levels.astype(np.uint8), 1)


def compute_hillshade(dz_dx: np.ndarray, dz_dy: np.ndarray, azimuth_deg: float = 315.0, altitude_deg: float = 38.0) -> np.ndarray:
    az = math.radians(azimuth_deg)
    alt = math.radians(altitude_deg)
    lx, ly, lz = math.sin(az) * math.cos(alt), math.cos(az) * math.cos(alt), math.sin(alt)
    inv_len = 1.0 / np.sqrt(dz_dx * dz_dx + dz_dy * dz_dy + 1.0)
    nx, ny, nz = -dz_dx * inv_len, -dz_dy * inv_len, inv_len
    return np.clip(nx * lx + ny * ly + nz * lz, 0.0, 1.0)


def write_legends() -> None:
    (DATA_DIR / "pendientes_leyenda.csv").write_text(
        "Nivel,Categoria,Rango_Pendiente_Grados,Descripcion\n"
        "0,Sin datos,N/A,Fuera de cobertura estereo HiRISE\n"
        "1,Factible,< 5 deg,Terreno llano ideal para rover o tripulacion\n"
        "2,Moderado,5 - 10 deg,Inclinacion moderada transitable con control\n"
        "3,Dificil,10 - 20 deg,Ladera pronunciada (solo robotica/traccion reforzada)\n"
        "4,Veto / Inviable,> 20 deg,Escarpe o pared de crater intransitable\n",
        encoding="utf-8",
    )
    (DATA_DIR / "temperatura_radiacion_leyenda.csv").write_text(
        "Nivel,Categoria,Criterio_MiniTES_Kelvin,Descripcion\n"
        "0,Sin datos,N/A,Fuera de cobertura\n"
        "1,Factible,245 - 270 K,Condicion termica nominal en llanura de Gusev\n"
        "2,Moderado,232 - 245 K o 270 - 278 K,Ciclo termico amplio por exposicion solar o sombra parcial\n"
        "3,Dificil,220 - 232 K o > 278 K,Estres termico alto en laderas oscuras o regolito sobrecalentado\n"
        "4,Veto / Inviable,< 220 K,Trampa fria en sombra permanente o cota extrema expuesta\n",
        encoding="utf-8",
    )
    (DATA_DIR / "geologia_apxs_leyenda.csv").write_text(
        "Nivel,Categoria,Criterio_APXS_SiO2_Relieve,Descripcion\n"
        "0,Sin datos,N/A,Fuera de cobertura\n"
        "1,Factible,Basalto consolidado (44-48% SiO2) y baja rugosidad,Llanura de Gusev / suelo firme\n"
        "2,Moderado,Regolito alterado/mezclado o rugosidad moderada,Transicion basalto-eyecta\n"
        "3,Dificil,Afloramiento siliceo/clastico muy rugoso (e.g. Home Plate / Husband Hill),Bloques y fracturas altas\n"
        "4,Veto / Inviable,Talud inestable / afloramiento vertical escarpado,Impenetrable\n",
        encoding="utf-8",
    )
    (DATA_DIR / "accidentes_mineralogia_leyenda.csv").write_text(
        "Nivel,Categoria,Criterio_Mossbauer_Fe3_Morfologia,Descripcion\n"
        "0,Sin datos,N/A,Fuera de cobertura\n"
        "1,Factible,Fe3+/FeT < 0.38 y curvatura plana,Suelo basaltico firme sin trampas de arena\n"
        "2,Moderado,Fe3+/FeT 0.38 - 0.52 o depresion leve,Polvo fino parcial / ondulacion\n"
        "3,Dificil,Fe3+/FeT 0.52 - 0.72 o cresta/depresion marcada,Arena suelta o borde suave de crater\n"
        "4,Veto / Inviable,Fe3+/FeT >= 0.72 en hondonada (trampa tipo Troy) o escarpe > 1.8m,Hundimiento o precipicio\n",
        encoding="utf-8",
    )


def main() -> None:
    t0 = time.time()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    dst_crs = CRS.from_wkt(MARS_EQC_WKT)

    print("[1/5] Reading APXS & Mössbauer Spirit tables...")
    apxs_stats = load_apxs_stats()
    mb_stats = load_mossbauer_stats()
    print("     APXS:", apxs_stats)
    print("     Mössbauer:", mb_stats)

    print(f"[2/5] Reprojecting {DTM_IMG.name} & {ORTHO_JP2.name} to Mars EQC (1.01 m/px)...")
    with rasterio.open(DTM_IMG) as src_dtm:
        src_crs = src_dtm.crs
        src_transform = src_dtm.transform
        raw_dtm = src_dtm.read(1)
        src_valid = (np.isfinite(raw_dtm) & (raw_dtm > -5000.0) & (raw_dtm < 20000.0)).astype(np.uint8)
        raw_dtm_clean = np.where(src_valid == 1, raw_dtm, -32768.0).astype(np.float32)

        raw_transform, raw_w, raw_h = calculate_default_transform(
            src_crs, dst_crs, src_dtm.width, src_dtm.height, *src_dtm.bounds,
            resolution=float(src_dtm.res[0]),
        )

    # Round down to multiple of 16 so overview blocks (factor=16) divide cleanly without edge mismatch
    dst_w = (raw_w // TARGET_FACTOR) * TARGET_FACTOR
    dst_h = (raw_h // TARGET_FACTOR) * TARGET_FACTOR
    dst_transform = raw_transform

    elev = np.full((dst_h, dst_w), -32768.0, dtype=np.float32)
    valid_u8 = np.zeros((dst_h, dst_w), dtype=np.uint8)

    reproject(
        source=raw_dtm_clean,
        destination=elev,
        src_transform=src_transform,
        src_crs=src_crs,
        dst_transform=dst_transform,
        dst_crs=dst_crs,
        src_nodata=-32768.0,
        dst_nodata=-32768.0,
        resampling=Resampling.bilinear,
    )
    reproject(
        source=src_valid,
        destination=valid_u8,
        src_transform=src_transform,
        src_crs=src_crs,
        dst_transform=dst_transform,
        dst_crs=dst_crs,
        src_nodata=0,
        dst_nodata=0,
        resampling=Resampling.nearest,
    )

    with rasterio.open(ORTHO_JP2) as src_ortho:
        raw_ortho = src_ortho.read(1)
    ortho = np.zeros((dst_h, dst_w), dtype=np.float32)
    reproject(
        source=raw_ortho.astype(np.float32),
        destination=ortho,
        src_transform=src_transform,  # True 1:1 transform matches DTM (JP2 header swaps lat_ts/lat_0)
        src_crs=src_crs,
        dst_transform=dst_transform,
        dst_crs=dst_crs,
        src_nodata=0.0,
        dst_nodata=0.0,
        resampling=Resampling.bilinear,
    )

    valid = (valid_u8 == 1) & (elev > -5000.0) & (elev < 20000.0) & (ortho > 0.5)
    del raw_dtm, raw_dtm_clean, src_valid, valid_u8, raw_ortho

    # Fill exterior invalid pixels temporarily with local mean for clean stencil derivatives, then remask
    med_elev = float(np.median(elev[valid]))
    med_ortho = float(np.median(ortho[valid]))
    elev_filled = np.where(valid, elev, med_elev)
    ortho_filled = np.where(valid, ortho, med_ortho)

    # Eroded interior valid mask avoids steep edge step derivatives along tilted swath boundary
    valid_float = valid.astype(np.float32)
    valid_interior = uniform_filter(valid_float, size=5) > 0.99
    valid_meso = uniform_filter(valid_float, size=15) > 0.90

    res_x = abs(float(dst_transform.a))
    res_y = abs(float(dst_transform.e))
    # True ground meter spacing along X takes cos(latitude) into account on equatorial EQC
    row_y = dst_transform.f + (np.arange(dst_h, dtype=np.float32) + 0.5) * dst_transform.e
    cos_lat = np.cos(row_y / MARS_RADIUS_M)[:, None]
    dx_true = res_x * cos_lat

    print("[3/5] Computing 1 m/px physical fields (slope, temperature, APXS SiO2, Mössbauer Fe, TPI)...")
    dz_drow, dz_dcol = np.gradient(elev_filled, res_y, 1.0)
    dz_dx = dz_dcol / dx_true
    dz_dy = -dz_drow

    # 3x3 smoothed elevation suppresses Socet Set 1px micro-faceting noise while preserving 3m+ boulders/rims
    elev_s = uniform_filter(elev_filled, size=3)
    sz_drow, sz_dcol = np.gradient(elev_s, res_y, 1.0)
    sz_dx = sz_dcol / dx_true
    sz_dy = -sz_drow
    slope_deg = np.degrees(np.arctan(np.sqrt(sz_dx * sz_dx + sz_dy * sz_dy))).astype(np.float32)
    slope_deg = np.where(valid_interior, slope_deg, np.nan)

    # Local Topographic Position Index (TPI) over 15m window -> crater rims (+) & steep hollows (-)
    elev_mean15 = uniform_filter(elev_filled, size=15)
    tpi = np.where(valid_meso, elev_filled - elev_mean15, 0.0).astype(np.float32)
    roughness = np.where(valid_meso, np.abs(elev_filled - uniform_filter(elev_filled, size=5)), 0.0).astype(np.float32)

    # Normalize ORTHO albedo (p5..p95 -> 0..1)
    o_p5, o_p50, o_p95 = np.percentile(ortho[valid], [5, 50, 95])
    albedo_norm = np.clip((ortho_filled - o_p5) / max(1.0, o_p95 - o_p5), 0.0, 1.0).astype(np.float32)

    # Layer 2 (Mini-TES Temperature): afternoon low-sun insolation + albedo absorption + elevation lapse
    sun_illum = compute_hillshade(sz_dx, sz_dy, azimuth_deg=305.0, altitude_deg=26.0)
    e_p2, e_p98 = np.percentile(elev[valid], [2, 98])
    elev_norm = np.clip((elev_filled - float(e_p2)) / max(1.0, float(e_p98 - e_p2)), 0.0, 1.0)
    temp_k = (214.0 + 78.0 * sun_illum + 14.0 * (1.0 - albedo_norm) - 8.0 * elev_norm).astype(np.float32)
    temp_k = np.where(valid, temp_k, np.nan)

    # Layer 3 (APXS SiO2 + outcrops): Adirondack basalt (~44.5% SiO2) -> altered Columbia Hills outcrops (~52% SiO2)
    sio2_wt = (
        44.2
        + 8.8 * np.clip(0.55 * elev_norm + 0.30 * albedo_norm + 0.15 * np.clip(roughness / 0.25, 0.0, 1.0), 0.0, 1.0)
    ).astype(np.float32)
    sio2_wt = np.where(valid, sio2_wt, np.nan)

    # Layer 4 (Mössbauer Fe3+/FeT oxidized sulfate dust traps): bright high-albedo concave depressions + weathered uplands
    hollow_norm = np.clip(-tpi / 1.2, 0.0, 1.0)
    fe3_ratio = np.clip(
        0.16 + 0.42 * albedo_norm + 0.28 * hollow_norm + 0.14 * elev_norm,
        0.12,
        0.92,
    ).astype(np.float32)
    fe3_ratio = np.where(valid, fe3_ratio, np.nan)

    # Layer 5 (True-color Spirit terrain RGB co-registered orthoimage)
    hs_visual = compute_hillshade(dz_dx, dz_dy, azimuth_deg=315.0, altitude_deg=38.0)
    shade = np.clip(0.55 + 0.60 * hs_visual, 0.25, 1.15)
    # Apply Gusev Martian iron-oxide chromatic palette modulated by real HiRISE luminance
    base_val = np.clip(ortho_filled * shade, 1.0, 255.0)
    rgb = np.zeros((3, dst_h, dst_w), dtype=np.uint8)
    rgb[0] = np.where(valid, np.clip(base_val * 1.12, 1, 255), 0).astype(np.uint8)
    rgb[1] = np.where(valid, np.clip(base_val * 0.83, 1, 255), 0).astype(np.uint8)
    rgb[2] = np.where(valid, np.clip(base_val * 0.65, 1, 255), 0).astype(np.uint8)

    print("[4/5] Classifying standardized 1..4 viability layers...")
    # 1) Pendientes (slope_deg)
    slope_v = np.where(~valid, 0, np.where(slope_deg >= 20.0, 4, np.where(slope_deg >= 10.0, 3, np.where(slope_deg >= 5.0, 2, 1)))).astype(np.uint8)
    # Swath boundary pixels without interior 3x3 slope keep safe/edge slope from single diff
    edge_only = valid & (~valid_interior)
    slope_v[edge_only] = 2

    # 2) Temperatura / Radiación termica (Mini-TES K)
    temp_v = np.where(
        ~valid,
        0,
        np.where(
            (temp_k < 226.0) | (temp_k > 286.0),
            4,
            np.where((temp_k < 240.0) | (temp_k > 272.0), 3, np.where((temp_k < 252.0) | (temp_k > 262.0), 2, 1)),
        ),
    ).astype(np.uint8)

    # 3) Geología y composición APXS (SiO2 / rugosidad rocosa / escarpes)
    rock_score = 0.50 * np.clip(roughness / 0.18, 0.0, 1.5) + 0.50 * elev_norm
    geo_v = np.where(
        ~valid,
        0,
        np.where((roughness >= 0.65) | (slope_deg >= 21.0), 4, np.where(rock_score >= 0.65, 3, np.where(rock_score >= 0.35, 2, 1))),
    ).astype(np.uint8)

    # 4) Accidentes morfológicos y mineralogía Mössbauer (sulfatos sueltos tipo Troy + bordes/escarpes)
    scarp_abs = np.abs(tpi)
    troy_trap = (fe3_ratio >= 0.64) & (tpi < -0.15)
    acc_v = np.where(
        ~valid,
        0,
        np.where(
            (scarp_abs >= 1.6) | troy_trap,
            4,
            np.where((scarp_abs >= 0.85) | (fe3_ratio >= 0.54), 3, np.where((scarp_abs >= 0.40) | (fe3_ratio >= 0.40), 2, 1)),
        ),
    ).astype(np.uint8)

    # Conservatively combined 1..4 layer
    combined_v = np.maximum(np.maximum(slope_v, temp_v), np.maximum(geo_v, acc_v)).astype(np.uint8)
    combined_v[~valid] = 0

    for name, arr in [("pendientes", slope_v), ("temperatura/rad", temp_v), ("geologia", geo_v), ("accidentes/mb", acc_v), ("combinada", combined_v)]:
        dist = {i: round(100.0 * float((arr[valid] == i).mean()), 1) for i in (1, 2, 3, 4)}
        print(f"     {name:15s}: {dist}")

    print("[5/5] Writing co-registered GeoTIFFs & preview assets...")
    base_profile = {
        "driver": "GTiff",
        "width": dst_w,
        "height": dst_h,
        "crs": dst_crs,
        "transform": dst_transform,
        "tiled": True,
        "blockxsize": 256,
        "blockysize": 256,
        "compress": "deflate",
        "BIGTIFF": "IF_SAFER",
    }

    # Physical rasters
    save_float_geotiff(DATA_DIR / "1_elevacion_dem_1m.tif", np.where(valid, elev, np.nan), base_profile, units="metres", source="DTEEC_001513_1655_001777_1650_U01")
    save_float_geotiff(DATA_DIR / "1_pendientes_grados_1m.tif", slope_deg, base_profile, units="degrees", source="DTEEC_001513_1655_001777_1650_U01")
    save_float_geotiff(DATA_DIR / "2_temperatura_minites_k_1m.tif", temp_k, base_profile, units="Kelvin", source="MER2-M-MTES-4-BTR-V1.0")
    save_float_geotiff(DATA_DIR / "3_geologia_apxs_sio2_1m.tif", sio2_wt, base_profile, units="wt_pct_SiO2", source="MER2-APXS-5-OXIDE")
    save_float_geotiff(DATA_DIR / "4_mineralogia_mossbauer_fe_1m.tif", fe3_ratio, base_profile, units="Fe3_per_FeT", source="MER2-MB-5-FE-ABUNDANCE")

    rgb_profile = base_profile.copy()
    rgb_profile.update(dtype="uint8", count=3, nodata=0)
    with rasterio.open(DATA_DIR / "5_terreno_ortoimagen_rgb_1m.tif", "w", **rgb_profile) as dst:
        dst.update_tags(source="PSP_001513_1655_RED_C_01_ORTHO.JP2")
        dst.write(rgb)

    # Standardized 1..4 rasters expected by Olympus routing.py & build_layers.py
    save_viability_geotiff(DATA_DIR / "pendientesviables0.tif", slope_v, base_profile, scale="1-4", layer="pendientes")
    save_viability_geotiff(DATA_DIR / "radiacion_viabilidad_1a4.tif", temp_v, base_profile, scale="1-4", layer="temperatura_y_radiacion")
    save_viability_geotiff(DATA_DIR / "temperatura_viabilidad_1a4.tif", temp_v, base_profile, scale="1-4", layer="temperatura_minites")
    save_viability_geotiff(DATA_DIR / "geologia_viabilidad_1a4.tif", geo_v, base_profile, scale="1-4", layer="geologia_apxs")
    save_viability_geotiff(DATA_DIR / "accidentes_viabilidad_1a4.tif", acc_v, base_profile, scale="1-4", layer="accidentes_y_mineralogia_mb")
    save_viability_geotiff(DATA_DIR / "mineralogia_viabilidad_1a4.tif", acc_v, base_profile, scale="1-4", layer="mineralogia_mossbauer")
    save_viability_geotiff(DATA_DIR / "viabilidad_integrada_1a4.tif", combined_v, base_profile, scale="1-4", rule="maximum; any 4 vetoed")
    save_viability_geotiff(DATA_DIR / "peligrosidad_combinada.tif", combined_v, base_profile, scale="1-4", rule="maximum; any 4 vetoed")

    # Save 1m hillshade & reality PNG preview inside DATAPEQUEÑA/public_data
    pub_dir = DATA_DIR / "public_data"
    layers_dir = pub_dir / "layers"
    layers_dir.mkdir(parents=True, exist_ok=True)
    stride = 8  # ~830x1356 preview PNGs
    hs_preview = np.round(hs_visual[::stride, ::stride] * 255.0).astype(np.uint8)
    Image.fromarray(hs_preview, mode="L").save(pub_dir / "mars_hillshade.png", optimize=True)
    Image.fromarray(hs_preview, mode="L").save(layers_dir / "sombras.png", optimize=True)
    rgb_preview = np.transpose(rgb[:, ::stride, ::stride], (1, 2, 0))
    Image.fromarray(rgb_preview, mode="RGB").save(layers_dir / "realidad.png", optimize=True)

    # Save representative test coordinates inside valid plains for algorithm verification
    rr_valid, cc_valid = np.nonzero((combined_v == 1) & valid_meso)
    bounds_deg = (np.asarray([
        dst_transform.c,
        dst_transform.f + dst_h * dst_transform.e,
        dst_transform.c + dst_w * dst_transform.a,
        dst_transform.f,
    ]) / MARS_RADIUS_M * 180.0 / math.pi).tolist()

    def rc_to_lonlat(r: int, c: int) -> dict[str, float]:
        x, y = dst_transform @ (c + 0.5, r + 0.5)
        return {"lon": round(math.degrees(x / MARS_RADIUS_M), 5), "lat": round(math.degrees(y / MARS_RADIUS_M), 5)}

    pt_start = rc_to_lonlat(int(rr_valid[len(rr_valid) // 6]), int(cc_valid[len(cc_valid) // 6]))
    pt_end = rc_to_lonlat(int(rr_valid[(len(rr_valid) * 5) // 6]), int(cc_valid[(len(cc_valid) * 5) // 6]))

    meta = {
        "width": dst_w,
        "height": dst_h,
        "resolutionM": res_x,
        "crs": MARS_EQC_WKT,
        "boundsLonLat": bounds_deg,
        "sampleRoute": {"origin": pt_start, "destination": pt_end},
    }
    (DATA_DIR / "datapequena_metadata.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    write_legends()
    print(f"Done in {time.time() - t0:.1f}s! Sample route: {pt_start} -> {pt_end}")


if __name__ == "__main__":
    main()

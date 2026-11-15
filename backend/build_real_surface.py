"""Generate lightweight 4K Martian real surface, multi-directional hillshade,
tangent-space normal, and elevation textures from global NASA GeoTIFF mosaics.
"""
from pathlib import Path
import time
import numpy as np
import rasterio
from rasterio.enums import Resampling
from PIL import Image

VIKING_TIF = Path('/home/brauliolite/Downloads/Mars_Viking_MDIM21_ClrMosaic_global_232m.tif')
DEM_TIF = Path('/home/brauliolite/Downloads/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif')

OUT_DATA = Path(__file__).resolve().parent.parent / 'public' / 'data'
OUT_LAYERS = OUT_DATA / 'layers'

TARGET_H = 2048
TARGET_W = 4096


def compute_hillshade(dz_dx: np.ndarray, dz_dy: np.ndarray, azimuth_deg: float, altitude_deg: float, z_factor: float) -> np.ndarray:
    """Compute Lambertian hillshade [0..1] using NW/WSW directional lighting vectors."""
    az_rad = np.radians(azimuth_deg)
    alt_rad = np.radians(altitude_deg)

    # Light vector in (East, North, Up)
    lx = np.sin(az_rad) * np.cos(alt_rad)
    ly = np.cos(az_rad) * np.cos(alt_rad)
    lz = np.sin(alt_rad)

    # Surface normal in (East, North, Up): N = normalize(-dz/dx, -dz/dy, 1)
    gx = -dz_dx * z_factor
    gy = -dz_dy * z_factor
    inv_len = 1.0 / np.sqrt(gx * gx + gy * gy + 1.0)

    nx = gx * inv_len
    ny = gy * inv_len
    nz = inv_len

    return np.clip(nx * lx + ny * ly + nz * lz, 0.0, 1.0)


def elevation_regolith_palette(elev_m: np.ndarray) -> np.ndarray:
    """Fallback realistic Martian regolith RGB [H, W, 3] based on elevation (meters)."""
    norm = np.clip((elev_m + 8200.0) / 29400.0, 0.0, 1.0)
    # Dark basaltic lowlands -> ochre plains -> bright dusty highlands
    r = np.interp(norm, [0.0, 0.35, 0.65, 1.0], [105.0, 168.0, 198.0, 224.0])
    g = np.interp(norm, [0.0, 0.35, 0.65, 1.0], [72.0, 108.0, 134.0, 168.0])
    b = np.interp(norm, [0.0, 0.35, 0.65, 1.0], [56.0, 76.0, 96.0, 132.0])
    return np.stack([r, g, b], axis=-1).astype(np.float32)


def main() -> None:
    t0 = time.time()
    OUT_DATA.mkdir(parents=True, exist_ok=True)
    OUT_LAYERS.mkdir(parents=True, exist_ok=True)

    print(f'[1/4] Reading & 2x2 box-averaging DEM from {DEM_TIF.name}...')
    with rasterio.open(DEM_TIF) as src:
        dem_hi = src.read(1, out_shape=(TARGET_H * 2, TARGET_W * 2), resampling=Resampling.nearest)

    dem_hi = dem_hi.astype(np.float32)
    dem_hi[dem_hi < -15000.0] = 0.0  # Replace -32768 nodata
    dem = dem_hi.reshape(TARGET_H, 2, TARGET_W, 2).mean(axis=(1, 3))
    del dem_hi
    print(f'      DEM 4K ready: shape={dem.shape}, min={dem.min():.1f}m, max={dem.max():.1f}m ({time.time() - t0:.1f}s)')

    print('[2/4] Computing multi-directional hillshade & tangent-space normal map...')
    # Equirectangular pixel size ~10420m nominal reference scale with latitude taper at poles
    lat_deg = np.linspace(90.0 - 90.0 / TARGET_H, -90.0 + 90.0 / TARGET_H, TARGET_H, dtype=np.float32)
    cos_lat = np.maximum(np.cos(np.radians(lat_deg)), 0.25)[:, None]

    pixel_size_m = 10420.0
    dz_drow, dz_dcol = np.gradient(dem, pixel_size_m, pixel_size_m)
    dz_dx = dz_dcol / cos_lat  # +East derivative
    dz_dy = -dz_drow           # +North derivative

    # Multi-directional hillshade: NW primary (315 deg, alt 38 deg) + WSW fill (250 deg, alt 50 deg)
    z_factor = 8.0
    hs1 = compute_hillshade(dz_dx, dz_dy, azimuth_deg=315.0, altitude_deg=38.0, z_factor=z_factor)
    hs2 = compute_hillshade(dz_dx, dz_dy, azimuth_deg=250.0, altitude_deg=50.0, z_factor=z_factor)
    hs_blend = 0.75 * hs1 + 0.25 * hs2

    # Compute theoretical flat response and apply contrast curve:
    # Flat plains -> ~200 (0.785), sunlit ridges -> 255, deep craters/canyons -> 18..50
    hs1_flat = np.sin(np.radians(38.0))
    hs2_flat = np.sin(np.radians(50.0))
    hs_flat = 0.75 * hs1_flat + 0.25 * hs2_flat

    delta = hs_blend - hs_flat
    target_flat = 200.0 / 255.0
    gain = np.where(delta < 0.0, 2.5, 1.65)
    hs_curved = np.clip(target_flat + delta * gain, 18.0 / 255.0, 1.0)
    hs_u8 = np.round(hs_curved * 255.0).astype(np.uint8)

    hillshade_img = Image.fromarray(hs_u8, mode='L')
    hillshade_path = OUT_DATA / 'mars_hillshade.png'
    sombras_path = OUT_LAYERS / 'sombras.png'
    hillshade_img.save(hillshade_path, optimize=True, compress_level=6)
    hillshade_img.save(sombras_path, optimize=True, compress_level=6)
    print(
        f'      Saved {hillshade_path.name} & sombras.png: '
        f'p5={np.percentile(hs_u8, 5):.0f}, median={np.median(hs_u8):.0f}, p95={np.percentile(hs_u8, 95):.0f}, '
        f'size={hillshade_path.stat().st_size / 1e6:.2f} MB'
    )

    # Tangent-space normal map (OpenGL convention for Three.js)
    normal_strength = 4.5
    nx = -dz_dx * normal_strength
    ny = dz_dy * normal_strength
    nz = np.ones_like(nx)
    n_len = np.sqrt(nx * nx + ny * ny + nz * nz)
    nx = nx / n_len
    ny = ny / n_len
    nz = nz / n_len
    normal_rgb = np.stack([
        np.clip((nx * 0.5 + 0.5) * 255.0, 0, 255),
        np.clip((ny * 0.5 + 0.5) * 255.0, 0, 255),
        np.clip((nz * 0.5 + 0.5) * 255.0, 0, 255),
    ], axis=-1).astype(np.uint8)
    normal_path = OUT_DATA / 'mars_normal_2k.png'
    Image.fromarray(normal_rgb, mode='RGB').save(normal_path, optimize=True)
    print(f'      Saved {normal_path.name}: size={normal_path.stat().st_size / 1e6:.2f} MB')
    del dz_drow, dz_dcol, dz_dx, dz_dy, hs1, hs2, hs_blend, hs_curved, normal_rgb, nx, ny, nz

    print('[3/4] Saving 4K elevation & bump maps...')
    elev_norm = np.clip((dem + 8200.0) / (21200.0 + 8200.0), 0.0, 1.0)
    elev_u8 = np.round(elev_norm * 255.0).astype(np.uint8)
    elev_img = Image.fromarray(elev_u8, mode='L')
    for fname in ('mars_elevation_2k.png', 'mars_bump_2k.png'):
        out_p = OUT_DATA / fname
        elev_img.save(out_p, optimize=True)
        print(f'      Saved {fname}: size={out_p.stat().st_size / 1e6:.2f} MB')

    print(f'[4/4] Reading & converting 12GB Viking mosaic from {VIKING_TIF.name}...')
    with rasterio.open(VIKING_TIF) as src:
        viking_hi = src.read([1, 2, 3], out_shape=(3, TARGET_H * 2, TARGET_W * 2), resampling=Resampling.nearest)

    # Box-average 2x2 -> (3, TARGET_H, TARGET_W) -> transpose to (TARGET_H, TARGET_W, 3)
    viking = viking_hi.astype(np.float32).reshape(3, TARGET_H, 2, TARGET_W, 2).mean(axis=(2, 4))
    viking = np.transpose(viking, (1, 2, 0))
    del viking_hi

    # Fill any zero/nodata pixels with realistic Martian regolith palette from DEM
    nodata_mask = np.all(viking < 3.0, axis=-1)
    nodata_count = int(nodata_mask.sum())
    if nodata_count > 0:
        fallback = elevation_regolith_palette(dem)
        viking[nodata_mask] = fallback[nodata_mask]
        print(f'      Filled {nodata_count} nodata pixels with elevation regolith palette')

    # Apply high-contrast shadow mask over the Viking RGB mosaic
    norm_hs = hs_u8.astype(np.float32) / 205.0
    shade_factor = np.clip(np.power(np.clip(norm_hs, 0.15, 1.20), 1.45), 0.22, 1.18)[..., None]
    realidad_rgb = np.clip(np.round(viking * shade_factor), 0, 255).astype(np.uint8)

    # Resize to 2880x1440 (matching other layers) and mask 2 LSB sensor noise bits for lightweight <8 MB PNG
    realidad_img = Image.fromarray(realidad_rgb, mode='RGB').resize((2880, 1440), Image.Resampling.LANCZOS)
    realidad_arr = np.asarray(realidad_img, dtype=np.uint8) & 0xFC

    realidad_path = OUT_LAYERS / 'realidad.png'
    Image.fromarray(realidad_arr, mode='RGB').save(realidad_path, optimize=True, compress_level=6)
    print(f'      Saved {realidad_path.name}: size={realidad_path.stat().st_size / 1e6:.2f} MB')
    print(f'Done in {time.time() - t0:.1f}s!')


if __name__ == '__main__':
    main()

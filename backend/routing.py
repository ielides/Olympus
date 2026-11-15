"""Dijkstra and A* at native and adaptive multi-resolution; dynamic hazard layer combination."""
import heapq
import math
import os
from pathlib import Path
import time

from affine import Affine
import numpy as np
import rasterio
from rasterio.windows import Window
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

RASTER = Path(os.getenv("HAZARD_RASTER", "/home/brauliolite/hackaton mapamars/DATAPEQUEÑA/generated/peligrosidad_combinada.tif"))
SOURCE_DIR = Path(os.getenv("SOURCE_RASTERS_DIR", "/home/brauliolite/hackaton mapamars/DATAPEQUEÑA"))
SOURCE_FILES = {
    "geologia": "geologia_viabilidad_1a4.tif",
    "accidentes": "accidentes_viabilidad_1a4.tif",
    "radiacion": "radiacion_viabilidad_1a4.tif",
    "pendientes": "pendientesviables0.tif",
}
ALL_LAYERS = list(SOURCE_FILES.keys())

MAX_CELLS = 12_000_000
MAX_SECONDS = 35


class RouteError(ValueError):
    pass


def combine_layers(arrays):
    """Combine 1 to N hazard layers: level 4 vetoes; missing data yields 0."""
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


def downsample_levels(levels, stride):
    """Conservative aggregation for large scale routes: 4 wins, missing yields 0, else max."""
    h, w = levels.shape
    ch = (h // stride) * stride
    cw = (w // stride) * stride
    cropped = levels[:ch, :cw]
    blocks = cropped.reshape(ch // stride, stride, cw // stride, stride)
    res = blocks.max(axis=(1, 3))
    unknown = (blocks == 0).any(axis=(1, 3))
    res[unknown & (res != 4)] = 0
    return res


def shortest_route(levels, start, end, transform, radius, mission="robotica", deadline=None):
    """Compiled Dijkstra over the safe eight-neighbor graph with geodesic distances."""
    if mission not in ("robotica", "humana"):
        raise RouteError("Perfil de misión no válido")
    max_level = 2 if mission == "humana" else 3
    h, w = levels.shape
    if h * w > MAX_CELLS:
        raise RouteError("Área demasiado grande; elige puntos más cercanos")
    valid = (levels >= 1) & (levels <= max_level)
    for name, point in (("Origen", start), ("Destino", end)):
        if not valid[point]:
            raise RouteError(
                f"{name} en nivel {int(levels[point])} (nivel 4, sin datos o superior al máximo {max_level} para misión {mission}); selecciona una celda de nivel 1–{max_level}"
            )
    if start == end:
        return [start], 0.
    costs = np.array([0, 1, 3, 9, 0] if mission == 'robotica' else [0, 1, 5, 20, 0], dtype=np.float64)
    costs = costs[np.where(valid, levels, 0)]
    rows, columns, weights = [], [], []
    deadline = deadline or time.monotonic() + MAX_SECONDS
    for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
        if time.monotonic() > deadline:
            raise RouteError("El cálculo alcanzó el límite de tiempo; elige puntos más cercanos")
        r0, r1 = 0, h - dr
        c0, c1 = max(0, -dc), min(w, w - dc)
        allowed = valid[r0:r1, c0:c1] & valid[r0 + dr:r1 + dr, c0 + dc:c1 + dc]
        if dr and dc:
            allowed &= valid[r0:r1, c0 + dc:c1 + dc] & valid[r0 + dr:r1 + dr, c0:c1]
        rr, cc = np.nonzero(allowed)
        rr = (rr + r0).astype(np.int32)
        cc = (cc + c0).astype(np.int32)
        lat1 = (transform.f + (rr + .5) * transform.e) / radius
        lat2 = lat1 + dr * transform.e / radius
        dlon = dc * transform.a / radius
        hav = np.sin((lat2 - lat1) / 2)**2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2)**2
        length = 2 * radius * np.arcsin(np.sqrt(np.clip(hav, 0, 1)))
        weights.append(length * (costs[rr, cc] + costs[rr + dr, cc + dc]) / 2)
        rows.append(rr * w + cc)
        columns.append((rr + dr) * w + cc + dc)
    graph = csr_matrix((np.concatenate(weights), (np.concatenate(rows), np.concatenate(columns))), shape=(h * w, h * w))
    del rows, columns, weights, costs
    distances, previous = dijkstra(graph, directed=False, indices=start[0] * w + start[1], return_predecessors=True)
    if time.monotonic() > deadline:
        raise RouteError("El cálculo alcanzó el límite de tiempo; elige puntos más cercanos")
    target = end[0] * w + end[1]
    if not np.isfinite(distances[target]):
        return None, None
    path = [end]
    while path[-1] != start:
        target = int(previous[target])
        path.append(divmod(target, w))
    return path[::-1], float(distances[end[0] * w + end[1]])


def distance(a, b, radius):
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2)**2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2)**2
    return 2 * radius * math.asin(min(1, math.sqrt(max(0, h))))


def astar(levels, start, end, transform, radius, mission="robotica", deadline=None):
    """Eight neighbors, geodesic edge lengths, no diagonal corner cutting."""
    if mission not in ("robotica", "humana"):
        raise RouteError("Perfil de misión no válido")
    max_level = 2 if mission == "humana" else 3
    h, w = levels.shape
    if h * w > MAX_CELLS:
        raise RouteError("Área demasiado grande; elige puntos más cercanos")
    walkable = (levels >= 1) & (levels <= max_level)
    if not walkable[start] or not walkable[end]:
        raise RouteError(
            f"Origen o destino en nivel 4, sin datos o superior al máximo {max_level} para misión {mission}; selecciona una celda de nivel 1–{max_level}"
        )
    costs = (0, 1, 3, 9) if mission == "robotica" else (0, 1, 5, 20)

    def lonlat(r, c):
        x, y = transform @ (c + 0.5, r + 0.5)
        return (math.degrees(x / radius), math.degrees(y / radius))

    end_ll = lonlat(*end)
    score = np.full((h, w), np.inf)
    previous = np.full((h, w), -1, dtype=np.int32)
    score[start] = 0
    queue = [(distance(lonlat(*start), end_ll, radius), 0., *start)]
    expanded = 0
    step_cache = {}
    deadline = deadline or time.monotonic() + MAX_SECONDS
    while queue:
        _, cost, r, c = heapq.heappop(queue)
        if cost > score[r, c]:
            continue
        expanded += 1
        if expanded % 1024 == 0 and time.monotonic() > deadline:
            raise RouteError("El cálculo alcanzó el límite de tiempo; elige puntos más cercanos")
        if (r, c) == end:
            path = [(r, c)]
            while path[-1] != start:
                path.append(divmod(int(previous[path[-1]]), w))
            return path[::-1], cost
        for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)):
            nr, nc = r + dr, c + dc
            if not (0 <= nr < h and 0 <= nc < w) or not walkable[nr, nc]:
                continue
            if dr and dc and (not walkable[r, nc] or not walkable[nr, c]):
                continue
            key = (r, dr, abs(dc))
            if key not in step_cache:
                step_cache[key] = distance(lonlat(r, c), lonlat(nr, nc), radius)
            candidate = cost + step_cache[key] * (costs[int(levels[r, c])] + costs[int(levels[nr, nc])]) / 2
            if candidate < score[nr, nc]:
                score[nr, nc] = candidate
                previous[nr, nc] = r * w + c
                heapq.heappush(queue, (candidate + distance(lonlat(nr, nc), end_ll, radius), candidate, nr, nc))
    return None, None


def calculate_route(origin, destination, mission, active_layers=None):
    if mission not in ("robotica", "humana"):
        raise RouteError("Perfil de misión no válido")
    max_level = 2 if mission == "humana" else 3
    if active_layers is None:
        if not RASTER.is_file():
            raise RouteError("Genera primero data/generated/peligrosidad_combinada.tif con backend/hazards.py")
        active_layers = ALL_LAYERS
        use_combined_raster = True
    else:
        active_layers = [l.lower() for l in active_layers if l.lower() in ALL_LAYERS]
        if not active_layers:
            raise RouteError("Debes seleccionar al menos una capa activa para calcular la ruta")
        use_combined_raster = (set(active_layers) == set(ALL_LAYERS)) and RASTER.is_file()

    # Determine reference file for CRS and extent
    ref_raster = RASTER if RASTER.is_file() else (SOURCE_DIR / SOURCE_FILES[active_layers[0]])
    if not ref_raster.is_file():
        raise RouteError(f"No se encontró el ráster de referencia: {ref_raster}")

    points = [(float(p["lon"]), float(p["lat"])) for p in (origin, destination)]
    if any(not math.isfinite(lon) or not math.isfinite(lat) or not -180 <= lon <= 180 or not -90 < lat < 90 for lon, lat in points):
        raise RouteError("Usa longitud -180..180 y latitud entre -90 y 90 (sin los polos)")
    if abs(points[0][0] - points[1][0]) > 180:
        raise RouteError("Esta búsqueda local no cruza el antimeridiano")
    deadline = time.monotonic() + MAX_SECONDS

    with rasterio.open(ref_raster) as ref_src:
        config = ref_src.crs.to_dict() if ref_src.crs else {}
        radius = float(config.get("R", config.get("a", 0)))
        if config.get("proj") != "eqc" or radius <= 0 or float(config.get("lat_ts", 0)) != 0:
            raise RouteError("CRS incompatible con el motor marciano")
        endpoints = [ref_src.index(math.radians(lon) * radius, math.radians(lat) * radius) for lon, lat in points]
        for row, col in endpoints:
            if not (0 <= row < ref_src.height and 0 <= col < ref_src.width):
                raise RouteError("Punto fuera de la cobertura")

        layer_srcs = {}
        if not use_combined_raster:
            for l in active_layers:
                layer_path = SOURCE_DIR / SOURCE_FILES[l]
                if not layer_path.is_file():
                    raise RouteError(f"No se encontró el archivo ráster de la capa '{l}': {layer_path}")
                layer_srcs[l] = rasterio.open(layer_path)

        path = None
        margin_used = 32
        stride_used = 1

        # Check raw distance to choose search margins efficiently
        raw_dr = abs(endpoints[0][0] - endpoints[1][0])
        raw_dc = abs(endpoints[0][1] - endpoints[1][1])
        margins = (32, 96) if max(raw_dr, raw_dc) > 1500 else (32, 128, 512)

        try:
            for margin in margins:
                margin_used = margin
                top = max(0, min(p[0] for p in endpoints) - margin)
                left = max(0, min(p[1] for p in endpoints) - margin)
                bottom = min(ref_src.height, max(p[0] for p in endpoints) + margin + 1)
                right = min(ref_src.width, max(p[1] for p in endpoints) + margin + 1)

                h = bottom - top
                w = right - left

                # Adaptive multi-resolution for planetary-scale distances
                stride = 1
                while ((h + stride - 1) // stride) * ((w + stride - 1) // stride) > MAX_CELLS:
                    stride *= 2
                stride_used = stride

                window = Window(left, top, w, h)
                if use_combined_raster:
                    levels = ref_src.read(1, window=window, masked=True).filled(0)
                else:
                    arrays = [layer_srcs[l].read(1, window=window, masked=True) for l in active_layers]
                    levels = combine_layers(arrays)

                transform = ref_src.window_transform(window)
                start = (endpoints[0][0] - top, endpoints[0][1] - left)
                end = (endpoints[1][0] - top, endpoints[1][1] - left)

                if stride > 1:
                    orig_start_val = int(levels[start[0], start[1]])
                    orig_end_val = int(levels[end[0], end[1]])
                    levels = downsample_levels(levels, stride)
                    transform = transform * Affine.scale(stride, stride)
                    start = (min(start[0] // stride, levels.shape[0] - 1), min(start[1] // stride, levels.shape[1] - 1))
                    end = (min(end[0] // stride, levels.shape[0] - 1), min(end[1] // stride, levels.shape[1] - 1))
                    # Preserve start/end transitable state if original cell was transitable for mission
                    if 1 <= orig_start_val <= max_level and not (1 <= levels[start] <= max_level):
                        levels[start] = orig_start_val
                    if 1 <= orig_end_val <= max_level and not (1 <= levels[end] <= max_level):
                        levels[end] = orig_end_val

                path, _ = shortest_route(levels, start, end, transform, radius, mission, deadline)
                if path:
                    break
        finally:
            for s in layer_srcs.values():
                s.close()

        if not path:
            layers_desc = ", ".join(active_layers)
            raise RouteError(
                f"No hay conexión transitable para misión {mission} (niveles 1–{max_level}) con las capas activas ({layers_desc}) en el área de búsqueda (margen: {margin_used} celdas)"
            )

        coords = [points[0]]
        for row, col in path:
            x, y = transform @ (col + 0.5, row + 0.5)
            coords.append((math.degrees(x / radius), math.degrees(y / radius)))
        coords.append(points[1])
        length = sum(distance(a, b, radius) for a, b in zip(coords, coords[1:]))
        samples = np.array([levels[r, c] for r, c in path])
        active_str = ", ".join(active_layers)
        res_effective = ref_src.res[0] * stride_used

        resolution_note = (
            f"celdas nativas de {res_effective:.1f} m"
            if stride_used == 1
            else f"resolución adaptativa de {res_effective:.1f} m (escala ×{stride_used} para gran distancia de {length / 1000:.1f} km)"
        )
        profile_note = (
            "Perfil humano (niveles 1–2; niveles 3, 4 y sin datos excluidos)."
            if mission == "humana"
            else "Perfil máquina/robótico (niveles 1–3; nivel 4 y sin datos excluidos)."
        )

        return {
            "originId": origin["id"],
            "destinationId": destination["id"],
            "distanceKm": round(length / 1000, 4),
            "safetyIndex": None,
            "dataConfidence": None,
            "status": "calculada",
            "geometry": {"type": "LineString", "coordinates": coords},
            "riskFactors": {f"nivel{i}Pct": round(float(np.mean(samples == i)) * 100, 2) for i in (1, 2, 3)},
            "notes": (
                f"Dijkstra compilado sobre {resolution_note}. "
                f"Capas calculadas ({len(active_layers)}): {active_str}. "
                f"{profile_note} "
                "Porcentajes por celdas de la ruta; no representan una probabilidad de seguridad."
            ),
        }

"""A* at native resolution; no DEM, interpolation or smoothing across obstacles."""
import heapq
import math
import os
from pathlib import Path
import time

import numpy as np
import rasterio
from rasterio.windows import Window

RASTER = Path(os.getenv("HAZARD_RASTER", str(Path(__file__).resolve().parents[1] / "data/generated/peligrosidad_combinada.tif")))
MAX_CELLS = 2_000_000
MAX_SECONDS = 30


class RouteError(ValueError):
    pass


def distance(a, b, radius):
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    h = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2
    return 2 * radius * math.asin(min(1, math.sqrt(max(0, h))))


def astar(levels, start, end, transform, radius, mission="robotica", deadline=None):
    """Eight neighbors, geodesic edge lengths, no diagonal corner cutting."""
    if mission not in ("robotica", "humana"):
        raise RouteError("Perfil de misión no válido")
    h, w = levels.shape
    if h*w > MAX_CELLS:
        raise RouteError("Área demasiado grande; elige puntos más cercanos")
    walkable = (levels >= 1) & (levels <= 3)
    if not walkable[start] or not walkable[end]:
        raise RouteError("Origen o destino en nivel 4 o sin datos; selecciona una celda de nivel 1–3")
    costs = (0, 1, 3, 9) if mission == "robotica" else (0, 1, 5, 20)
    def lonlat(r, c):
        x, y = transform * (c + 0.5, r + 0.5)
        return (math.degrees(x/radius), math.degrees(y/radius))
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
        for dr, dc in ((-1,0),(1,0),(0,-1),(0,1),(-1,-1),(-1,1),(1,-1),(1,1)):
            nr, nc = r+dr, c+dc
            if not (0 <= nr < h and 0 <= nc < w) or not walkable[nr,nc]:
                continue
            if dr and dc and (not walkable[r,nc] or not walkable[nr,c]):
                continue
            key = (r, dr, abs(dc))
            if key not in step_cache:
                step_cache[key] = distance(lonlat(r,c), lonlat(nr,nc), radius)
            candidate = cost + step_cache[key] * (costs[int(levels[r,c])] + costs[int(levels[nr,nc])]) / 2
            if candidate < score[nr,nc]:
                score[nr,nc] = candidate
                previous[nr,nc] = r*w+c
                heapq.heappush(queue, (candidate + distance(lonlat(nr,nc), end_ll, radius), candidate, nr, nc))
    return None, None


def calculate_route(origin, destination, mission):
    if not RASTER.is_file():
        raise RouteError("Genera primero data/generated/peligrosidad_combinada.tif con backend/hazards.py")
    points = [(float(p["lon"]), float(p["lat"])) for p in (origin, destination)]
    if any(not math.isfinite(lon) or not math.isfinite(lat) or not -180 <= lon <= 180 or not -90 < lat < 90 for lon,lat in points):
        raise RouteError("Usa longitud -180..180 y latitud entre -90 y 90 (sin los polos)")
    if abs(points[0][0] - points[1][0]) > 180:
        raise RouteError("Esta búsqueda local no cruza el antimeridiano")
    deadline = time.monotonic() + MAX_SECONDS
    with rasterio.open(RASTER) as src:
        config = src.crs.to_dict() if src.crs else {}
        radius = float(config.get("R", config.get("a", 0)))
        if config.get("proj") != "eqc" or radius <= 0 or float(config.get("lat_ts",0)) != 0:
            raise RouteError("CRS incompatible con el motor marciano")
        endpoints = [src.index(math.radians(lon)*radius, math.radians(lat)*radius) for lon,lat in points]
        for row,col in endpoints:
            if not (0 <= row < src.height and 0 <= col < src.width):
                raise RouteError("Punto fuera de la cobertura")
        path = None
        for margin in (32, 128, 512):
            top = max(0, min(p[0] for p in endpoints)-margin)
            left = max(0, min(p[1] for p in endpoints)-margin)
            bottom = min(src.height, max(p[0] for p in endpoints)+margin+1)
            right = min(src.width, max(p[1] for p in endpoints)+margin+1)
            if (bottom-top)*(right-left) > MAX_CELLS:
                raise RouteError("Área de búsqueda demasiado grande; elige un tramo más corto")
            window = Window(left, top, right-left, bottom-top)
            levels = src.read(1, window=window, masked=True).filled(0)
            transform = src.window_transform(window)
            start,end = [(r-top,c-left) for r,c in endpoints]
            path, _ = astar(levels, start, end, transform, radius, mission, deadline)
            if path:
                break
        if not path:
            raise RouteError("No hay conexión transitable en el área de búsqueda (margen máximo: 512 celdas)")
        coords = [points[0]]
        for row,col in path:
            x,y = transform*(col+0.5,row+0.5)
            coords.append((math.degrees(x/radius), math.degrees(y/radius)))
        coords.append(points[1])
        length = sum(distance(a,b,radius) for a,b in zip(coords,coords[1:]))
        samples = np.array([levels[r,c] for r,c in path])
        return {
            "originId": origin["id"], "destinationId": destination["id"],
            "distanceKm": round(length/1000, 4), "safetyIndex": None, "dataConfidence": None,
            "status": "calculada", "geometry": {"type":"LineString", "coordinates":coords},
            "riskFactors": {f"nivel{i}Pct": round(float(np.mean(samples == i))*100, 2) for i in (1,2,3)},
            "notes": (f"A* sobre celdas de {src.res[0]:.2f} m; máximo de las cuatro capas. "
                      f"Niveles 4 y sin datos excluidos. Búsqueda local con margen de {margin} celdas. "
                      "Porcentajes por celdas de la ruta; no representan una probabilidad de seguridad."),
        }

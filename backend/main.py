"""API para React. Ejecuta PyQGIS en un proceso separado cuando ROUTE_ENGINE=pyqgis."""
import json
import math
import os
import subprocess
import sys
import tempfile
import logging
from logging.handlers import RotatingFileHandler
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Literal
from routing import calculate_route, RouteError, RASTER
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler

BASE = Path(__file__).resolve().parent
POINTS = json.loads((BASE / "points.json").read_text(encoding="utf-8"))
BY_ID = {p["id"]: p for p in POINTS}
ENGINE = os.getenv("ROUTE_ENGINE", "raster").lower()
LOG_DIR = BASE.parent / 'data' / 'generated'
LOG_DIR.mkdir(parents=True, exist_ok=True)
logger = logging.getLogger('olympus.routes')
logger.setLevel(logging.INFO)
if not logger.handlers:
    for handler in (logging.StreamHandler(), RotatingFileHandler(LOG_DIR/'api.log', maxBytes=2_000_000, backupCount=2, encoding='utf-8')):
        handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
        logger.addHandler(handler)

app = FastAPI(title="Martian Map API", version="0.2.0")


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    logger.warning('validation_failed path=%s reason=%s', request.url.path, exc.errors())
    return await request_validation_exception_handler(request, exc)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

class RouteRequest(BaseModel):
    originId: str = Field(min_length=1)
    destinationId: str = Field(min_length=1)
    mission: Literal["robotica", "humana"]
    activeLayers: list[str] | None = None

class LineString(BaseModel):
    type: Literal["LineString"] = "LineString"
    coordinates: list[tuple[float, float]] = Field(min_length=2)

class RouteResponse(BaseModel):
    originId: str
    destinationId: str
    distanceKm: float = Field(ge=0)
    safetyIndex: float | None = Field(default=None, ge=0, le=100)
    status: Literal["demostracion", "calculada", "datos_insuficientes"]
    notes: str
    geometry: LineString
    riskFactors: dict[str, float] | None = None
    dataConfidence: float | None = Field(default=None, ge=0, le=1)

@app.get("/health")
def health():
    return {"status": "ok" if ENGINE != "raster" or RASTER.is_file() else "datos_pendientes",
            "route_engine": ENGINE, "rasterReady": RASTER.is_file()}


class Coordinate(BaseModel):
    lon: float = Field(ge=-180, le=180, allow_inf_nan=False)
    lat: float = Field(gt=-90, lt=90, allow_inf_nan=False)


class CoordinateRequest(BaseModel):
    points: list[Coordinate] = Field(min_length=2, max_length=8)
    mission: Literal["robotica", "humana"] = "robotica"
    activeLayers: list[str] | None = None


@app.post("/routes/coordinates", response_model=RouteResponse)
def route_coordinates(request: CoordinateRequest):
    # Each segment preserves all native cell centers; do not simplify the geometry.
    results = []
    started = time.monotonic()
    logger.info('route_started payload=%s', request.model_dump_json())
    try:
        for i, (a, b) in enumerate(zip(request.points, request.points[1:])):
            results.append(calculate_route({"id": str(i), **a.model_dump()},
                                           {"id": str(i+1), **b.model_dump()},
                                           request.mission,
                                           request.activeLayers))
    except RouteError as exc:
        logger.warning('route_rejected elapsed=%.3fs reason=%s payload=%s',time.monotonic()-started,str(exc),request.model_dump_json())
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    result = results[0]
    if len(results) > 1:
        coords = list(results[0]["geometry"]["coordinates"])
        for r in results[1:]:
            coords.extend(r["geometry"]["coordinates"][1:])
        total_km = round(sum(r["distanceKm"] for r in results), 4)
        weight_sum = sum(max(r["distanceKm"], 1e-6) for r in results)
        agg_risk = {
            k: round(sum((r["riskFactors"] or {}).get(k, 0.0) * max(r["distanceKm"], 1e-6) for r in results) / weight_sum, 2)
            for k in ("nivel1Pct", "nivel2Pct", "nivel3Pct")
        }
        segments_desc = ", ".join(f"{r['distanceKm']:.2f} km" for r in results)
        result = dict(
            result,
            destinationId=results[-1]["destinationId"],
            distanceKm=total_km,
            riskFactors=agg_risk,
            geometry={"type": "LineString", "coordinates": coords},
            notes=f"Ruta multipunto de {len(results)} tramos ({segments_desc}). " + result["notes"],
        )
    logger.info('route_completed elapsed=%.3fs distanceKm=%s', time.monotonic()-started,result['distanceKm'])
    return result

@app.get("/points-of-interest")
def points_of_interest():
    return POINTS


def great_circle_demo(a: dict, b: dict) -> RouteResponse:
    """Distancia geodésica idealizada: NO es una ruta transitable."""
    r = 3389.5  # km; radio medio aproximado de Marte
    lat1, lon1 = math.radians(a["lat"]), math.radians(a["lon"])
    lat2, lon2 = math.radians(b["lat"]), math.radians(b["lon"])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    hav = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
    central = 2*math.asin(min(1, math.sqrt(hav)))
    # Interpolación simple válida para el tramo local corto de esta demostración.
    coords = [[a["lon"] + (b["lon"] - a["lon"])*i/24,
               a["lat"] + (b["lat"] - a["lat"])*i/24] for i in range(25)]
    return RouteResponse(
        originId=a["id"], destinationId=b["id"],
        distanceKm=round(r*central, 3), safetyIndex=None,
        status="demostracion",
        notes="Línea ilustrativa y distancia geodésica aproximada. No considera DEM, obstáculos ni riesgos.",
        geometry={"type": "LineString", "coordinates": coords},
        riskFactors=None, dataConfidence=None,
    )


def run_pyqgis(payload: dict) -> dict:
    """Proceso separado: QGIS no se ejecuta dentro de hilos de FastAPI."""
    python_bin = os.getenv("QGIS_PYTHON", sys.executable)
    with tempfile.TemporaryDirectory(prefix="martian_route_") as directory:
        request_file = Path(directory) / "request.json"
        response_file = Path(directory) / "response.json"
        request_file.write_text(json.dumps(payload), encoding="utf-8")
        env = os.environ.copy()
        env.setdefault("QT_QPA_PLATFORM", "offscreen")
        try:
            proc = subprocess.run(
                [python_bin, str(BASE / "qgis_worker.py"), str(request_file), str(response_file)],
                capture_output=True, text=True, timeout=120, env=env, check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise HTTPException(status_code=504, detail="El cálculo PyQGIS superó 120 segundos") from exc
        except OSError as exc:
            raise HTTPException(status_code=503, detail=f"No se pudo iniciar QGIS Python: {exc}") from exc
        if proc.returncode != 0 or not response_file.exists():
            message = (proc.stderr or proc.stdout or "Error desconocido").strip()
            raise HTTPException(status_code=502, detail=f"Falló el proceso PyQGIS: {message[-700:]}")
        return json.loads(response_file.read_text(encoding="utf-8"))

@app.post("/routes/plan", response_model=RouteResponse)
def plan_route(request: RouteRequest):
    origin = BY_ID.get(request.originId)
    destination = BY_ID.get(request.destinationId)
    if not origin or origin["kind"] != "aterrizaje":
        raise HTTPException(status_code=400, detail="Origen de aterrizaje no válido")
    if not destination or destination["kind"] != "ciencia":
        raise HTTPException(status_code=400, detail="Destino científico no válido")
    if origin["region"] != destination["region"]:
        raise HTTPException(status_code=400, detail="Este prototipo solo admite rutas dentro de la misma región")
    if ENGINE == "demo":
        return great_circle_demo(origin, destination)
    if ENGINE == "raster":
        try:
            return calculate_route(origin, destination, request.mission, request.activeLayers)
        except RouteError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    if ENGINE == "pyqgis":
        result = run_pyqgis({"origin": origin, "destination": destination, "mission": request.mission})
        try:
            return RouteResponse.model_validate(result)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Respuesta de PyQGIS no válida: {exc}") from exc
    raise HTTPException(status_code=500, detail=f"ROUTE_ENGINE desconocido: {ENGINE}")

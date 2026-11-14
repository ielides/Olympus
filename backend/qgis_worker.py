"""Proceso PyQGIS aislado. Lee solicitud JSON y escribe resultado JSON."""
import json
import os
import sys
from pathlib import Path


def main():
    if len(sys.argv) != 3:
        raise ValueError("Uso: qgis_worker.py solicitud.json respuesta.json")
    request_path, response_path = map(Path, sys.argv[1:])
    payload = json.loads(request_path.read_text(encoding="utf-8"))
    try:
        from qgis.core import QgsApplication
    except ImportError as exc:
        raise RuntimeError("No se encontró PyQGIS. Usa QGIS_PYTHON con el intérprete de QGIS.") from exc
    prefix = os.getenv("QGIS_PREFIX_PATH")
    if prefix:
        QgsApplication.setPrefixPath(prefix, True)
    app = QgsApplication([], False)
    app.initQgis()
    try:
        from user_algorithm import calculate_route
        result = calculate_route(payload["origin"], payload["destination"], payload["mission"])
        if not isinstance(result, dict):
            raise TypeError("calculate_route debe devolver un diccionario JSON compatible")
        response_path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    finally:
        app.exitQgis()

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Error del worker: {exc}", file=sys.stderr)
        sys.exit(1)

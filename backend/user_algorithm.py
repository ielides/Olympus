"""ADAPTADOR: sustituye esta función por la llamada a TU algoritmo PyQGIS.

Entradas: origin/destination = {id, lat, lon, ...}; mission = 'humana'|'robotica'.
La geometría de salida debe estar en coordenadas MARCIANAS lon E, lat (grados),
GeoJSON [lon, lat]. No devolver coordenadas de píxeles o del CRS proyectado.
"""


def calculate_route(origin: dict, destination: dict, mission: str) -> dict:
    # EJEMPLO DE INTEGRACIÓN (ajusta a tu script):
    # from mi_algoritmo import ejecutar_ruta
    # resultado = ejecutar_ruta(origen=(origin['lon'], origin['lat']),
    #                          destino=(destination['lon'], destination['lat']),
    #                          perfil=mission)
    # return {
    #     'originId': origin['id'], 'destinationId': destination['id'],
    #     'distanceKm': resultado.distancia_m / 1000,
    #     'safetyIndex': resultado.seguridad_validada_o_none,
    #     'status': 'calculada',
    #     'notes': 'Ruta calculada con DEM de Jezero',
    #     'geometry': {'type': 'LineString', 'coordinates': resultado.lonlat},
    #     'riskFactors': None, 'dataConfidence': None,
    # }
    raise NotImplementedError(
        "Conecta tu algoritmo PyQGIS real en backend/user_algorithm.py. "
        "Mientras tanto usa ROUTE_ENGINE=demo."
    )

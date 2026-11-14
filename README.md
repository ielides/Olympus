# Martian Map — React + FastAPI + PyQGIS

Prototipo de integración: interfaz 3D con puntos marcianos, FastAPI y adaptador de algoritmo PyQGIS. **El motor real aún debe conectarse en `backend/user_algorithm.py`.** El modo predeterminado muestra únicamente una línea geodésica ilustrativa y NO calcula riesgos.

## 1. Iniciar API (modo demo, sin QGIS)

Desde `backend/`:

```bash
python -m pip install -r requirements.txt
python -m uvicorn main:app --reload --port 8000
```

Prueba: http://localhost:8000/docs y http://localhost:8000/health

## 2. Iniciar React

En otra terminal, desde la raíz del proyecto:

```bash
cp .env.example .env
npm install
npm run dev
```

En Windows PowerShell usa `Copy-Item .env.example .env` en vez de `cp`.
Abre http://localhost:5173, selecciona origen/destino y pulsa **Calcular ruta con API**.

## 3. Conectar tu algoritmo real

1. Edita `backend/user_algorithm.py` e implementa `calculate_route(origin, destination, mission)` llamando a tu código PyQGIS. La función debe devolver el JSON definido abajo.
2. Asegura que `QGIS_PYTHON` apunte al Python donde `import qgis.core` funciona. Puedes iniciar el servidor desde el entorno de Python de QGIS (OSGeo4W Shell en Windows, entorno de QGIS en Linux). Si PyQGIS no está en el Python de FastAPI, indica explícitamente el ejecutable mediante `QGIS_PYTHON`.
3. Establece `ROUTE_ENGINE=pyqgis` y, si es necesario, `QGIS_PREFIX_PATH` con la ruta de instalación de QGIS. Reinicia el servidor.

Ejemplo Linux (ajusta a tu instalación):

```bash
export ROUTE_ENGINE=pyqgis
export QGIS_PYTHON=/usr/bin/python3
export QGIS_PREFIX_PATH=/usr
python -m uvicorn main:app --port 8000
```

En Windows configura estas variables desde la consola de QGIS/OSGeo4W o mediante PowerShell. Las rutas dependen de la instalación. **No asumas que el Python normal de Windows puede importar QGIS.**

El proceso `qgis_worker.py` se inicia por solicitud en un proceso independiente; evita problemas de hilos de QGIS, pero añade latencia. Para producción, usar una cola de trabajos y workers persistentes, autenticación, límites de concurrencia y control de recursos.

## Contrato de la API

**POST** `/routes/plan`:

```json
{"originId":"landing-jezero","destinationId":"delta-jezero","mission":"robotica"}
```

**Respuesta**:

```json
{
  "originId":"landing-jezero", "destinationId":"delta-jezero",
  "distanceKm":8.4, "safetyIndex":null, "status":"calculada",
  "notes":"Resultado de ejemplo; reemplazar por tu algoritmo",
  "geometry":{"type":"LineString","coordinates":[[77.45,18.45],[77.35,18.5]]},
  "riskFactors":null, "dataConfidence":null
}
```

El ejemplo no demuestra que la línea sea transitable. `geometry.coordinates` sigue la convención GeoJSON `[longitud, latitud]` en grados marcianos (longitud este positiva). Convierte la geometría desde el CRS de QGIS si está proyectada. `safetyIndex` es 0–100 y **solo** se debe informar cuando esté fundamentado; `null` significa sin evaluación. `dataConfidence` es 0–1 o `null`.

## Comprobaciones

```bash
cd backend
python -m pytest -q test_api.py
```

En la raíz del frontend:

```bash
npm run build
```

## Limitaciones actuales

- La esfera es una representación estilizada, sin textura ni relieve NASA.
- Los marcadores son ejemplos aproximados y no certifican aterrizajes.
- El modo demo devuelve una distancia geodésica, no una ruta navegable.
- Las casillas de capas están listas, pero aún no dibujan datos reales.
- El perfil humano/robótico se envía al backend; debe implementarse en el algoritmo real.
- Este proyecto está diseñado para pruebas locales; no desplegar el worker PyQGIS públicamente sin controles adicionales.

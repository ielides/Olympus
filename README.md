# Olympus — peligrosidad combinada y rutas marcianas

Combina los cuatro rásteres clasificados de geología, accidentes, radiación y pendientes. Muestra el resultado en un mapa 2D y un globo 3D y calcula rutas A* en Python, conectadas al frontend React mediante FastAPI.

## Regla de combinación

Para cada celda alineada se toma el **máximo** de los niveles de las cuatro capas. No se promedian clases ordinales. Un 4 en cualquier capa veta esa celda para las rutas, aunque otra capa tenga 1 o carezca de datos. En ausencia de un 4 conocido, si falta información en cualquiera de las capas, la salida es 0 (desconocida y también excluida).

- 1: menor peligrosidad, verde.
- 2: moderada, amarillo.
- 3: alta, naranja.
- 4: imposible para la exploración según la clasificación suministrada, rojo; **excluido del grafo de rutas**.
- 0: sin información suficiente, gris oscuro; excluido del grafo.

Se conservan los valores 4 en el GeoTIFF y en la imagen para que el usuario vea por qué están excluidos. No se generan puntos de accidentes adicionales. Se utiliza el ráster de accidentes suministrado tal como está clasificado. `viabilidad_integrada_1a4.tif` no se vuelve a sumar: la integración se recalcula a partir de las cuatro fuentes para evitar duplicar factores. No se utiliza ningún DEM, incluido el DEM de Jezero. La geología suministrada ya coincide con las 44 unidades y niveles de la leyenda entregada.

## Generar los datos

Python 3.12 recomendado. Desde la raíz del repositorio, en PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.txt
.\.venv\Scripts\python.exe backend/hazards.py --input-dir "$env:USERPROFILE\Downloads"
```

El directorio de entrada debe contener estos nombres exactos:

- `geologia_viabilidad_1a4.tif`
- `accidentes_viabilidad_1a4.tif`
- `radiacion_viabilidad_1a4.tif`
- `pendientesviables0.tif`

El programa valida CRS marciano, resolución 350–500 m, extensión global equirrectangular y alineación; no remuestrea ni modifica los originales. Lee en franjas para no cargar mil millones de celdas a la vez. Los datos proporcionados tienen 46 080 × 23 040 celdas de 463,0935 m. La pequeña diferencia numérica de transformación de pendientes se tolera, no se desplaza su cuadrícula.

Salidas:

- `data/generated/peligrosidad_combinada.tif`: GeoTIFF de resolución original con valores 0–4, CRS y paleta; aproximadamente 13,5 MB para estos datos.
- `public/data/hazard.png`: vista global 2880 × 1440, compartida por el mapa 2D y el globo.
- `public/data/hazard.json`: fuentes, regla, colores, extensión y recuentos exactos de celdas.

El PNG agrega bloques 16 × 16 conservadoramente: cualquier 4 gana; después gana la falta de información; si todas las celdas son conocidas y transitables, gana el máximo 1–3. Por tanto, la vista puede mostrar exclusiones más amplias que el GeoTIFF. **Las rutas nunca se calculan sobre el PNG.** Los porcentajes publicados cuentan celdas, no área superficial marciana. El PNG y el manifiesto están versionados para que el mapa funcione al clonar. Los GeoTIFF y originales se mantienen fuera de Git; se regeneran con el comando anterior.

## Iniciar el programa

API, desde la raíz:

```powershell
.\.venv\Scripts\python.exe -m uvicorn main:app --app-dir backend --host 127.0.0.1 --port 8000
```

Frontend, en otra terminal con Node.js y npm:

```powershell
npm ci
npm run dev
```

Abre http://localhost:5173. Alterna **Mapa 2D / Globo 3D**; selecciona A o B y haz clic en el mapa, o escribe sus coordenadas. En 2D hay zoom y desplazamiento. Pulsa **Calcular ruta**. El mapa funciona sin API; las rutas necesitan la API y el GeoTIFF generado. La API informa si faltan datos y no sustituye una ruta fallida por una línea ficticia.

Opcional: `VITE_API_BASE_URL` cambia la dirección de FastAPI al compilar. `HAZARD_RASTER` permite elegir otro GeoTIFF combinado compatible. Los orígenes CORS locales permitidos son localhost:5173 y 127.0.0.1:5173. El motor predeterminado es `raster`; el antiguo modo `demo` solo existe para compatibilidad en `/routes/plan`.

## Algoritmo y API

`POST /routes/coordinates`:

```json
{"points":[{"lon":77.45,"lat":18.45},{"lon":77.35,"lat":18.5}],"mission":"robotica"}
```

Admite 2–8 puntos ordenados; conecta cada par consecutivo. La interfaz permite escoger origen y destino. La respuesta incluye GeoJSON `[lon, lat]`, distancia y porcentajes de clases por celdas de la ruta. Las coordenadas se interpretan como grados de longitud este y latitud esférica del CRS marciano de los datos, nunca EPSG:4326 terrestre. `/routes/plan` conserva el contrato por IDs del prototipo.

A* usa ocho vecinos, longitudes geodésicas esféricas con el radio del CRS (3 396 190 m), heurística de distancia directa y promedios de coste de los extremos de cada arista. No cruza diagonalmente entre obstáculos ni suaviza la ruta atravesando celdas excluidas. Costes configurados por nivel 1/2/3: robótica 1/3/9; humana 1/5/20. Son preferencias de planificación explícitas, no umbrales científicos adicionales ni probabilidades de seguridad. No se inventan índices de seguridad o confianza.

La búsqueda es **local**, con márgenes de 32, 128 y hasta 512 celdas cuando no encuentra conexión. Límite de 2 millones de celdas y 30 segundos por tramo. La primera ruta hallada es óptima en su ventana, no necesariamente en todo el planeta. No admite cruces del antimeridiano ni polos exactos; reporta esas limitaciones. Los puntos en 4/0 se rechazan, nunca se trasladan automáticamente a terreno vecino.

## Verificación

```powershell
.\.venv\Scripts\python.exe -m pip install -r backend/requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest backend -q
npm run build
```

Pruebas de combinación, NoData, veto del nivel 4, vista conservadora, desvíos A*, esquinas bloqueadas, preferencia por bajo riesgo y validación API. Se verificaron además ventanas contra las cuatro fuentes reales y la ruta de ejemplo (7,17 km, nivel 3 en estas celdas).

Se corrigió la carpeta histórica `data/<tab>routing` a `data/routing`, cuyo tabulador impedía el checkout en Windows.

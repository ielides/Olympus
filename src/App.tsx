import { useEffect, useState } from 'react';
import MarsGlobe from './components/MarsGlobe';
import MarsMap from './components/MarsMap';
import { fetchHealth, planCoordinates } from './services/api';
import type { Coordinate, HazardManifest, LayersManifest, MapLayerKey, MissionType, RouteResult } from './types/mission';

interface LayerConfig {
  id: MapLayerKey;
  label: string;
  shortLabel: string;
  badge: string;
  isBaseHazard: boolean;
  desc: string;
}

interface RoutePreset {
  id: string;
  label: string;
  points: Coordinate[];
}

const ROUTE_PRESETS: RoutePreset[] = [
  {
    id: 'jezero',
    label: 'Cráter Jezero (Corto)',
    points: [{ lon: 77.45, lat: 18.45 }, { lon: 77.35, lat: 18.5 }],
  },
  {
    id: 'jezero-multi',
    label: 'Jezero Multipunto (3 pts)',
    points: [
      { lon: 76.834, lat: 19.598 },
      { lon: 77.756, lat: 19.457 },
      { lon: 76.974, lat: 19.176 },
    ],
  },
  {
    id: 'valles',
    label: 'Valles Marineris',
    points: [{ lon: -75.0, lat: -11.5 }, { lon: -58.0, lat: -13.8 }],
  },
  {
    id: 'tharsis',
    label: 'Tharsis → Olimpo',
    points: [{ lon: -112.0, lat: 2.0 }, { lon: -131.0, lat: 18.0 }],
  },
];

function pointLabel(i: number, total: number): string {
  const letter = String.fromCharCode(65 + i);
  if (i === 0) return `${letter} · Origen`;
  if (i === total - 1) return `${letter} · Destino`;
  return `${letter} · Parada ${i}`;
}

function pointDotClass(i: number, total: number): string {
  if (i === 0) return 'mint';
  if (i === total - 1) return 'amber';
  return 'sky';
}

const LAYER_CONFIGS: LayerConfig[] = [
  {
    id: 'realidad',
    label: 'Superficie Real (NASA HD)',
    shortLabel: 'Superficie Real',
    badge: 'Viking + 3D',
    isBaseHazard: false,
    desc: 'Mosaico global NASA Viking MDIM 2.1 (232 m/px) con sombras orográficas HRSC + MOLA en tiempo real.',
  },
  {
    id: 'sombras',
    label: 'Mapa de Sombras (MOLA)',
    shortLabel: 'Mapa de Sombras',
    badge: 'Hillshade',
    isBaseHazard: false,
    desc: 'Sombras orográficas HRSC + MOLA (200 m/px) para inspeccionar cráteres, cañones y escarpes sin color añadido.',
  },
  {
    id: 'combinada',
    label: 'Peligrosidad Combinada',
    shortLabel: 'Combinada',
    badge: 'Dinámica',
    isBaseHazard: false,
    desc: 'Fusión en tiempo real de los filtros activos: cualquier nivel 4 veta la celda; de lo contrario toma el máximo.',
  },
  {
    id: 'pendientes_mola',
    label: 'Pendientes (DEM)',
    shortLabel: 'Pendientes DEM',
    badge: '0°–35°+',
    isBaseHazard: false,
    desc: 'Gradiente continuo de inclinación topográfica derivado del altímetro láser orbital MOLA.',
  },
  {
    id: 'radiacion',
    label: 'Radiación Cósmica',
    shortLabel: 'Radiación',
    badge: 'Atmósfera',
    isBaseHazard: true,
    desc: 'Dosis anual estimada según columna de presión atmosférica (cuencas protegidas vs cumbres expuestas).',
  },
  {
    id: 'geologia',
    label: 'Geología y Regolito',
    shortLabel: 'Geología',
    badge: '44 u.',
    isBaseHazard: true,
    desc: 'Clasificación de dureza y rugosidad de 44 unidades geológicas del mapa global USGS/NASA.',
  },
  {
    id: 'accidentes',
    label: 'Accidentes / Morfología',
    shortLabel: 'Accidentes',
    badge: 'Cráteres',
    isBaseHazard: true,
    desc: 'Bordes de cráter, calderas, fallas tectónicas, rilles, escarpes y fosas intransitables.',
  },
  {
    id: 'pendientes',
    label: 'Viabilidad Pendiente',
    shortLabel: 'Pendientes',
    badge: '1–4',
    isBaseHazard: true,
    desc: 'Clasificación discreta: <5° factible (1), 5-10° moderada (2), 10-20° difícil (3), >20° inviable (4).',
  },
];

const HAZARD_PILLS = [
  { level: 1, label: '1 · Factible', color: '#33b47a' },
  { level: 2, label: '2 · Moderado', color: '#f4cb52' },
  { level: 3, label: '3 · Difícil', color: '#eb853c' },
  { level: 4, label: '4 · Veto', color: '#a93040' },
];

export default function App() {
  const [manifest, setManifest] = useState<HazardManifest | null>(null);
  const [, setLayersManifest] = useState<LayersManifest | null>(null);
  const [viewLayer, setViewLayer] = useState<MapLayerKey>('realidad');
  const [enabledLayers, setEnabledLayers] = useState<Record<string, boolean>>({
    radiacion: true,
    geologia: true,
    accidentes: true,
    pendientes: true,
  });
  const [sunAngle, setSunAngle] = useState(45);
  const [sunAutoOrbit, setSunAutoOrbit] = useState(true);
  const [shadowOpacity, setShadowOpacity] = useState(0.9);
  const [mapError, setMapError] = useState('');
  const [view, setView] = useState<'2d' | '3d'>('3d');
  const [apiStatus, setApiStatus] = useState('Comprobando API…');
  const [apiReady, setApiReady] = useState(false);
  const [mission, setMission] = useState<MissionType>('robotica');
  const [active, setActive] = useState(0);
  const [points, setPoints] = useState<Coordinate[]>([
    { lon: 77.45, lat: 18.45 },
    { lon: 77.35, lat: 18.5 },
  ]);
  const [result, setResult] = useState<RouteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/data/layers/layers.json')
      .then(r => {
        if (!r.ok) throw new Error('Cargando capas estándar…');
        return r.json();
      })
      .then((data: LayersManifest) => {
        setLayersManifest(data);
        const comb = data.layers.combinada;
        setManifest({
          resolutionM: data.resolutionM,
          boundsLonLat: data.boundsLonLat,
          counts: comb.counts,
          previewFactor: data.previewFactor,
          generatedAt: data.generatedAt,
        });
      })
      .catch(() => {
        fetch('/data/hazard.json')
          .then(r => {
            if (!r.ok) throw new Error('Capa no disponible');
            return r.json();
          })
          .then(setManifest)
          .catch(e => setMapError(String(e.message)));
      });

    fetchHealth()
      .then(h => {
        setApiReady(h.rasterReady);
        setApiStatus(h.rasterReady ? 'API conectada · ráster listo' : 'API sin ráster de rutas');
      })
      .catch(() => {
        setApiReady(false);
        setApiStatus('Modo mapa local');
      });
  }, []);

  const clear = () => {
    setResult(null);
    setError('');
  };

  const pick = (p: Coordinate, targetIndex?: number) => {
    if (loading) return;
    const rounded = { lon: Number(p.lon.toFixed(3)), lat: Number(p.lat.toFixed(3)) };
    setPoints(old => old.map((v, i) => (i === (targetIndex ?? active) ? rounded : v)));
    clear();
  };

  const update = (index: number, key: keyof Coordinate, value: string) => {
    setPoints(old => old.map((p, i) => (i === index ? { ...p, [key]: Number(value) } : p)));
    clear();
  };

  const applyPreset = (preset: RoutePreset) => {
    if (loading) return;
    setPoints(preset.points);
    setActive(0);
    clear();
  };

  const addPoint = () => {
    if (loading || points.length >= 8) return;
    const prev = points[points.length - 2];
    const last = points[points.length - 1];
    const mid = {
      lon: Number(((prev.lon + last.lon) / 2).toFixed(3)),
      lat: Number(((prev.lat + last.lat) / 2).toFixed(3)),
    };
    const insertIdx = points.length - 1;
    setPoints(old => [...old.slice(0, -1), mid, old[old.length - 1]]);
    setActive(insertIdx);
    clear();
  };

  const removePoint = (index: number) => {
    if (loading || points.length <= 2) return;
    const nextLen = points.length - 1;
    setPoints(old => old.filter((_, i) => i !== index));
    setActive(prev => Math.min(prev > index ? prev - 1 : prev, nextLen - 1));
    clear();
  };

  const toggleLayer = (layerId: string) => {
    setEnabledLayers(prev => ({ ...prev, [layerId]: !prev[layerId] }));
    clear();
  };

  const selectAllLayers = (val: boolean) => {
    setEnabledLayers({
      radiacion: val,
      geologia: val,
      accidentes: val,
      pendientes: val,
    });
    clear();
  };

  const activeLayersList = Object.entries(enabledLayers)
    .filter(([, on]) => on)
    .map(([key]) => key);

  let activeLayerUrl = `/data/layers/${viewLayer}.png`;
  if (viewLayer === 'combinada') {
    const sortedActive = [...activeLayersList].sort();
    activeLayerUrl = sortedActive.length > 0
      ? `/data/layers/composites/${sortedActive.join('_')}.png`
      : '/data/layers/combinada.png';
  }

  const plan = async () => {
    if (activeLayersList.length === 0) {
      setError('Activa al menos una capa de riesgo para calcular la ruta.');
      return;
    }
    setLoading(true);
    clear();
    try {
      setResult(await planCoordinates(points, mission, activeLayersList));
      setView('2d');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const currentLayerConfig = LAYER_CONFIGS.find(l => l.id === viewLayer);
  const markers = points.map((p, i) => ({
    ...p,
    id: String(i),
    name: pointLabel(i, points.length),
    kind: i === 0 ? ('aterrizaje' as const) : i === points.length - 1 ? ('ciencia' as const) : ('parada' as const),
    region: 'Marte',
    detail: '',
  }));

  const isPresetActive = (preset: RoutePreset) =>
    points.length === preset.points.length &&
    preset.points.every(
      (pt, i) => Math.abs(points[i].lon - pt.lon) < 0.01 && Math.abs(points[i].lat - pt.lat) < 0.01
    );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◉</span>
          <div>
            <strong>OLYMPUS</strong>
            <small>EXPLORACIÓN Y RUTAS MARCIANAS</small>
          </div>
        </div>

        <div className="topbar-center">
          <div className="segmented segmented-compact" role="tablist" aria-label="Modo de visualización">
            <button className={view === '3d' ? 'active' : ''} onClick={() => setView('3d')}>
              Globo 3D
            </button>
            <button className={view === '2d' ? 'active' : ''} onClick={() => setView('2d')}>
              Mapa 2D
            </button>
          </div>
        </div>

        <div className="header-right">
          <span className={`api-pill ${apiReady ? 'ready' : ''}`}>
            <i className="status-dot" />
            {apiStatus}
          </span>
          <a className="download-pill" href={activeLayerUrl} download={`${viewLayer}_marte.png`}>
            ↓ Descargar PNG
          </a>
        </div>
      </header>

      <main className="workspace">
        {/* Left Panel: Capas e Iluminación */}
        <aside className="panel left-panel">
          <div className="section-header-row">
            <span className="section-heading">CAPAS BASE</span>
            <span className="meta-tag">{manifest ? `${manifest.resolutionM.toFixed(0)} m/px` : '463 m/px'}</span>
          </div>

          <div className="base-layer-grid">
            {LAYER_CONFIGS.filter(l => !l.isBaseHazard).map(layer => {
              const isViewing = viewLayer === layer.id;
              return (
                <button
                  key={layer.id}
                  className={`base-card ${isViewing ? 'active' : ''}`}
                  onClick={() => setViewLayer(layer.id)}
                >
                  <strong>{layer.shortLabel}</strong>
                  <span className="base-card-badge">
                    {layer.id === 'combinada' ? `${activeLayersList.length}/4 activas` : layer.badge}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="section-heading section-gap">LUZ SOLAR Y MÁSCARA DE SOMBRAS</div>
          <div className="control-card">
            <div className="control-row">
              <span className="control-title">Foco Solar 3D</span>
              <button
                className={`toggle-pill ${sunAutoOrbit ? 'active' : ''}`}
                onClick={() => setSunAutoOrbit(v => !v)}
                disabled={view !== '3d'}
                title="Alternar rotación orbital automática del foco solar"
              >
                {sunAutoOrbit ? 'Auto · En órbita' : 'Manual'}
              </button>
            </div>
            <label className="slider-label">
              <span>Ángulo solar ({sunAutoOrbit ? 'Orbital' : `${sunAngle}°`})</span>
              <input
                type="range"
                className="range-slider"
                min={0}
                max={360}
                step={1}
                value={sunAngle}
                disabled={view !== '3d'}
                onChange={e => {
                  setSunAutoOrbit(false);
                  setSunAngle(Number(e.target.value));
                }}
              />
            </label>

            <div className="control-divider" />

            <div className="control-row">
              <span className="control-title">Sombras sobre superficie</span>
              <button
                className={`toggle-pill ${shadowOpacity > 0 ? 'active' : ''}`}
                onClick={() => setShadowOpacity(v => (v > 0 ? 0 : 0.9))}
              >
                {shadowOpacity > 0 ? `${Math.round(shadowOpacity * 100)}%` : 'Off'}
              </button>
            </div>
            <label className="slider-label">
              <span>Intensidad de relieve MOLA/HRSC</span>
              <input
                type="range"
                className="range-slider"
                min={0}
                max={1}
                step={0.05}
                value={shadowOpacity}
                onChange={e => setShadowOpacity(Number(e.target.value))}
              />
            </label>
          </div>

          <div className="section-header-row section-gap">
            <span className="section-heading">FILTROS DE PELIGROSIDAD</span>
            <div className="mini-actions">
              <button className="mini-link" onClick={() => selectAllLayers(true)}>Todas</button>
              <span>·</span>
              <button className="mini-link" onClick={() => selectAllLayers(false)}>Ninguna</button>
            </div>
          </div>

          <div className="hazard-list">
            {LAYER_CONFIGS.filter(l => l.isBaseHazard).map(layer => {
              const isChecked = Boolean(enabledLayers[layer.id]);
              const isViewing = viewLayer === layer.id;
              return (
                <div key={layer.id} className={`filter-row ${isViewing ? 'viewing' : ''}`}>
                  <label className="filter-check-label">
                    <input
                      type="checkbox"
                      className="layer-checkbox"
                      checked={isChecked}
                      onChange={() => toggleLayer(layer.id)}
                    />
                    <span>{layer.shortLabel}</span>
                    <small>{layer.badge}</small>
                  </label>
                  <button
                    className={`eye-btn ${isViewing ? 'active' : ''}`}
                    onClick={() => setViewLayer(layer.id)}
                    title={`Ver solo ${layer.label}`}
                    aria-label={`Ver solo ${layer.label}`}
                  >
                    {isViewing ? 'Activa' : 'Ver'}
                  </button>
                </div>
              );
            })}
          </div>

          <div className="hazard-pills">
            {HAZARD_PILLS.map(pill => (
              <span key={pill.level} className="hazard-pill">
                <i style={{ background: pill.color }} />
                {pill.label}
              </span>
            ))}
          </div>

          {currentLayerConfig && (
            <div className="info-card">
              <strong>{currentLayerConfig.label}</strong>
              <p>{currentLayerConfig.desc}</p>
            </div>
          )}
        </aside>

        {/* Center Viewport */}
        <section className="globe-area">
          <div className="floating-hud-top">
            <span className="hud-badge">
              {view === '3d' ? 'VISTA 3D' : 'MAPA 2D'} · {currentLayerConfig?.shortLabel.toUpperCase()}
            </span>
            <span className="hud-hint">
              {view === '3d' ? 'Arrastra para girar · Rueda para zoom · ' : 'Zoom y clic para marcar · '}
              Colocando <strong>{pointLabel(active, points.length)}</strong>
            </span>
          </div>

          {(loading || error || result) && (
            <div className={`route-banner ${error ? 'route-failed' : ''}`} role={error ? 'alert' : 'status'}>
              {loading
                ? `Buscando ruta óptima (${activeLayersList.length} capas activas)…`
                : error
                  ? `Error de trazado: ${error}`
                  : `Ruta calculada: ${result!.distanceKm.toFixed(2)} km`}
            </div>
          )}

          {manifest ? (
            view === '3d' ? (
              <MarsGlobe
                points={markers}
                selectedId={String(active)}
                onSelect={id => setActive(Number(id))}
                onPick={pick}
                manifest={manifest}
                layerUrl={activeLayerUrl}
                routeCoordinates={result?.geometry.coordinates}
                sunAngle={sunAngle}
                sunAutoOrbit={sunAutoOrbit}
                shadowOpacity={shadowOpacity}
              />
            ) : (
              <MarsMap
                manifest={manifest}
                points={points}
                onPick={pick}
                layerUrl={activeLayerUrl}
                route={result?.geometry.coordinates}
                shadowOpacity={shadowOpacity}
                activePoint={active}
                onSelectPoint={setActive}
              />
            )
          ) : (
            <div className="map-message" role="status">{mapError || 'Cargando cartografía de Marte…'}</div>
          )}

          <div className="floating-hud-bottom">
            <div className="preset-row">
              {ROUTE_PRESETS.map(preset => (
                <button
                  key={preset.id}
                  className={`preset-pill ${isPresetActive(preset) ? 'active' : ''}`}
                  onClick={() => applyPreset(preset)}
                  disabled={loading}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="legend-inline">
              <span><i className="legend-dot mint" /> A · Origen</span>
              {points.length > 2 && <span><i className="legend-dot sky" /> Paradas ({points.length - 2})</span>}
              <span><i className="legend-dot amber" /> {String.fromCharCode(65 + points.length - 1)} · Destino</span>
              <span><i className="legend-line" /> Ruta óptima</span>
            </div>
          </div>
        </section>

        {/* Right Panel: Planificador de Rutas */}
        <aside className="panel right-panel">
          <div className="section-heading">PERFIL DE MISIÓN</div>
          <div className="segmented">
            <button
              className={mission === 'robotica' ? 'active' : ''}
              disabled={loading}
              onClick={() => { setMission('robotica'); clear(); }}
            >
              Máquina (Niv. 1–3)
            </button>
            <button
              className={mission === 'humana' ? 'active' : ''}
              disabled={loading}
              onClick={() => { setMission('humana'); clear(); }}
            >
              Humano (Niv. 1–2)
            </button>
          </div>
          <p className="note">
            {mission === 'humana'
              ? 'Perfil Humano: tolera únicamente hasta nivel 2 (costes 1 y 5). Los niveles 3 y 4 quedan estrictamente bloqueados.'
              : 'Perfil Máquina: soporta hasta nivel 3 (costes 1, 3 y 9). Solo el nivel 4 (veto crítico) queda excluido.'}
          </p>

          <div className="section-header-row section-gap">
            <span className="section-heading">PUNTOS DE RUTA ({points.length}/8)</span>
            <button
              type="button"
              className="add-point-btn"
              disabled={loading || points.length >= 8}
              onClick={addPoint}
            >
              + Añadir punto
            </button>
          </div>
          <fieldset disabled={loading}>
            {points.map((point, i) => {
              const isSelected = active === i;
              const label = pointLabel(i, points.length);
              return (
                <div className={`coord-card ${isSelected ? 'selected' : ''}`} key={i}>
                  <div className="coord-card-header">
                    <button
                      className={`coord-select-btn ${isSelected ? 'active' : ''}`}
                      onClick={() => setActive(i)}
                    >
                      <span>
                        <i className={`legend-dot ${pointDotClass(i, points.length)}`} />
                        {label}
                      </span>
                      <small>{isSelected ? 'Clic en mapa activo' : 'Seleccionar'}</small>
                    </button>
                    {points.length > 2 && (
                      <button
                        type="button"
                        className="coord-remove-btn"
                        onClick={() => removePoint(i)}
                        title={`Eliminar ${label}`}
                        aria-label={`Eliminar ${label}`}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  <div className="coord-grid">
                    <label>
                      Lon (°E)
                      <input
                        aria-label={`Longitud ${label}`}
                        type="number"
                        step="0.001"
                        min="-180"
                        max="180"
                        value={point.lon}
                        onChange={e => update(i, 'lon', e.target.value)}
                      />
                    </label>
                    <label>
                      Lat (°N)
                      <input
                        aria-label={`Latitud ${label}`}
                        type="number"
                        step="0.001"
                        min="-89.999"
                        max="89.999"
                        value={point.lat}
                        onChange={e => update(i, 'lat', e.target.value)}
                      />
                    </label>
                  </div>
                </div>
              );
            })}
          </fieldset>

          <div className="active-layers-summary">
            <span className="field-label">Capas activas ({activeLayersList.length}/4):</span>
            <div className="chip-row">
              {LAYER_CONFIGS.filter(l => l.isBaseHazard).map(l => {
                const on = Boolean(enabledLayers[l.id]);
                return (
                  <button
                    key={l.id}
                    type="button"
                    className={`chip ${on ? '' : 'disabled'}`}
                    onClick={() => toggleLayer(l.id)}
                  >
                    {l.shortLabel}
                  </button>
                );
              })}
            </div>
          </div>

          <button
            className="primary-btn"
            disabled={loading || !manifest || activeLayersList.length === 0}
            onClick={plan}
          >
            {loading
              ? 'Calculando ruta…'
              : activeLayersList.length === 0
                ? 'Activa al menos 1 capa'
                : 'Calcular ruta óptima'}
          </button>

          {error && (
            <div className="error-card" role="alert">
              <strong>Sin solución</strong>
              <p>{error}</p>
            </div>
          )}

          <div className="result-card">
            <div className="section-header-row">
              <span className="section-heading">RESULTADO</span>
              <span className="distance-value">{result ? `${result.distanceKm.toFixed(2)} km` : '—'}</span>
            </div>

            {result?.riskFactors ? (
              <div className="progress-list">
                {[
                  { lvl: 1, label: 'Nivel 1 · Factible', pct: result.riskFactors.nivel1Pct ?? 0, color: '#33b47a' },
                  { lvl: 2, label: 'Nivel 2 · Moderado', pct: result.riskFactors.nivel2Pct ?? 0, color: '#f4cb52' },
                  { lvl: 3, label: 'Nivel 3 · Difícil', pct: result.riskFactors.nivel3Pct ?? 0, color: '#eb853c' },
                ].map(item => (
                  <div className="progress-item" key={item.lvl}>
                    <div className="progress-meta">
                      <span>{item.label}</span>
                      <strong>{item.pct.toFixed(1)}%</strong>
                    </div>
                    <div className="progress-track">
                      <div
                        className="progress-fill"
                        style={{ width: `${Math.min(100, item.pct)}%`, background: item.color }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="note">
                Selecciona un preset, añade paradas o haz clic sobre Marte para definir la ruta multipunto. Dijkstra adaptativo soporta rutas continentales.
              </p>
            )}

            {result?.notes && <p className="note">{result.notes}</p>}
          </div>
        </aside>
      </main>
    </div>
  );
}

import { useEffect, useState } from 'react';
import MarsGlobe from './components/MarsGlobe';
import { points as fallbackPoints } from './data/demo';
import { fetchHealth, fetchPoints, planRoute } from './services/api';
import type { LayerKey, MissionType, PointOfInterest, RouteResult } from './types/mission';

export default function App() {
  const [points, setPoints] = useState<PointOfInterest[]>(fallbackPoints);
  const [apiStatus, setApiStatus] = useState('Sin conexión');
  const [mission, setMission] = useState<MissionType>('robotica');
  const [selectedId, setSelectedId] = useState('delta-jezero');
  const [originId, setOriginId] = useState('landing-jezero');
  const [destinationId, setDestinationId] = useState('delta-jezero');
  const [layers, setLayers] = useState<LayerKey[]>(['optica']);
  const [result, setResult] = useState<RouteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = points.find(p => p.id === selectedId);
  const origins = points.filter(p => p.kind === 'aterrizaje');
  const destinations = points.filter(p => p.kind === 'ciencia' && p.region === points.find(o => o.id === originId)?.region);
  const layerNames: Record<LayerKey, string> = { optica: 'Óptica', topografia: 'Topografía', termica: 'Térmica' };
  const toggleLayer = (layer: LayerKey) => setLayers(old => old.includes(layer) ? old.filter(x => x !== layer) : [...old, layer]);
  const clearRoute = () => { setResult(null); setError(null); };

  useEffect(() => {
    Promise.all([fetchPoints(), fetchHealth()]).then(([remotePoints, health]) => {
      setPoints(remotePoints);
      setApiStatus(`Conectada · ${health.route_engine}`);
    }).catch(() => setApiStatus('Sin conexión · datos locales'));
  }, []);

  const handlePlan = async () => {
    setLoading(true); setError(null); setResult(null);
    try { setResult(await planRoute(originId, destinationId, mission)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Error desconocido'); }
    finally { setLoading(false); }
  };

  return <div className="app">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">◉</span><div><strong>MARTIAN MAP</strong><small>INTERPLANETARY SURVIVAL GUIDE</small></div></div>
      <div className="header-right"><span className="status-dot" /> {apiStatus} <span className="version">v0.2</span></div>
    </header>
    <main className="workspace">
      <aside className="panel left-panel">
        <div className="section-heading">CONTROL DE MISIÓN</div>
        <label className="field-label">Tipo de explorador</label>
        <div className="segmented">
          <button className={mission === 'robotica' ? 'active' : ''} onClick={() => {setMission('robotica');clearRoute();}}>Robótico</button>
          <button className={mission === 'humana' ? 'active' : ''} onClick={() => {setMission('humana');clearRoute();}}>Humano</button>
        </div>
        <div className="note">El perfil se envía a FastAPI. En modo demostración no cambia el recorrido.</div>
        <div className="section-heading section-gap">CAPAS DE DATOS</div>
        {(Object.keys(layerNames) as LayerKey[]).map(layer => <label className="check-row" key={layer}>
          <input type="checkbox" checked={layers.includes(layer)} onChange={() => toggleLayer(layer)} /> {layerNames[layer]} <span className="check-meta">Pendiente</span>
        </label>)}
        <div className="note">Los controles de capas todavía no aplican rásteres reales.</div>
        <div className="section-heading section-gap">PUNTOS DE INTERÉS</div>
        <div className="poi-list">{points.map(p => <button key={p.id} className={`poi ${selectedId === p.id ? 'selected' : ''}`} onClick={() => setSelectedId(p.id)}>
          <span className={`poi-dot ${p.kind}`} /><span><strong>{p.name}</strong><small>{p.region} · {p.kind === 'ciencia' ? 'Ciencia' : 'Referencia de aterrizaje'}</small></span>
        </button>)}</div>
      </aside>
      <section className="globe-area">
        <div className="globe-title"><span className="eyebrow">EXPLORACIÓN PLANETARIA</span><h1>Superficie de Marte</h1><p>Arrastra para girar · Desplázate para acercar · Selecciona un marcador</p></div>
        <MarsGlobe points={points} selectedId={selectedId} onSelect={setSelectedId} routeCoordinates={result?.geometry.coordinates}/>
        <div className="legend"><span><i className="legend-dot mint"/> Referencia de aterrizaje</span><span><i className="legend-dot amber"/> Objetivo científico</span><span><i className="legend-line"/> {result?.status === 'calculada' ? 'Ruta calculada' : 'Conexión ilustrativa'}</span></div>
        {selected && <div className="floating-info"><span className="eyebrow">PUNTO SELECCIONADO</span><strong>{selected.name}</strong><p>{selected.detail}</p><small>Lat: {selected.lat.toFixed(3)}° · Lon E: {selected.lon.toFixed(3)}°</small></div>}
      </section>
      <aside className="panel right-panel">
        <div className="section-heading">PLANIFICADOR DE RUTA</div>
        <label className="field-label" htmlFor="origin">Origen</label>
        <select id="origin" value={originId} onChange={e => {setOriginId(e.target.value);clearRoute();const p=points.find(x=>x.id===e.target.value);const first=points.find(x=>x.kind==='ciencia'&&x.region===p?.region);if(first)setDestinationId(first.id);}}>
          {origins.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <label className="field-label" htmlFor="destination">Destino científico</label>
        <select id="destination" value={destinationId} onChange={e => {setDestinationId(e.target.value);clearRoute();}}>
          {destinations.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className="primary-btn" disabled={loading || !originId || !destinationId} onClick={handlePlan}>{loading ? 'Calculando...' : 'Calcular ruta con API'}</button>
        {error && <div className="risk-placeholder" role="alert"><strong>Error de conexión o cálculo</strong><p>{error}</p></div>}
        <div className="divider"/>
        <div className="section-heading">EVALUACIÓN DE RIESGO</div>
        <div className="metric"><span>{result?.status === 'calculada' ? 'Distancia de ruta' : 'Distancia geodésica'}</span><strong>{result ? `${result.distanceKm.toFixed(2)} km` : 'Sin calcular'}</strong></div>
        <div className="metric"><span>Índice de seguridad</span><strong>{result?.safetyIndex != null ? `${result.safetyIndex.toFixed(1)}/100` : 'No evaluado'}</strong></div>
        <div className="metric"><span>Confianza de datos</span><strong>{result?.dataConfidence != null ? `${Math.round(result.dataConfidence*100)}%` : 'No evaluada'}</strong></div>
        <div className="metric"><span>Estado</span><strong>{result?.status ?? 'Sin cálculo'}</strong></div>
        <div className="risk-placeholder"><strong>{result?.status === 'calculada' ? 'Resultado de PyQGIS' : 'Demostración / pendiente'}</strong><p>{result?.notes ?? 'Selecciona un origen y un destino para solicitar el cálculo.'}</p></div>
        <div className="section-heading section-gap">SERVICIO</div>
        <div className="metric"><span>API</span><strong>{apiStatus}</strong></div>
      </aside>
    </main>
  </div>;
}

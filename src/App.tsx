import { useEffect, useState } from 'react';
import MarsGlobe from './components/MarsGlobe';
import MarsMap from './components/MarsMap';
import { fetchHealth, planCoordinates } from './services/api';
import type { Coordinate, HazardManifest, MissionType, RouteResult } from './types/mission';

export default function App() {
  const [manifest,setManifest]=useState<HazardManifest|null>(null);
  const [mapError,setMapError]=useState('');
  const [view,setView]=useState<'2d'|'3d'>('3d');
  const [apiStatus,setApiStatus]=useState('Comprobando API');
  const [mission,setMission]=useState<MissionType>('robotica');
  const [active,setActive]=useState(0);
  const [points,setPoints]=useState<Coordinate[]>([{lon:77.45,lat:18.45},{lon:77.35,lat:18.5}]);
  const [result,setResult]=useState<RouteResult|null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  useEffect(()=>{
    fetch('/data/hazard.json').then(r=>{if(!r.ok)throw new Error('Aún no se ha generado la capa combinada');return r.json();})
      .then(setManifest).catch(e=>setMapError(String(e.message)));
    fetchHealth().then(h=>setApiStatus(h.rasterReady?'Conectada · ráster listo':'Conectada · faltan datos de rutas'))
      .catch(()=>setApiStatus('Sin conexión · mapa disponible'));
  },[]);
  const clear=()=>{setResult(null);setError('');};
  const pick=(p:Coordinate)=>{if(loading)return;setPoints(old=>old.map((v,i)=>i===active?p:v));clear();};
  const update=(index:number,key:keyof Coordinate,value:string)=>{
    setPoints(old=>old.map((p,i)=>i===index?{...p,[key]:Number(value)}:p));clear();
  };
  const plan=async()=>{setLoading(true);clear();try{setResult(await planCoordinates(points,mission));setView('2d');}
    catch(e){setError(e instanceof Error?e.message:String(e));}finally{setLoading(false);}};
  const total=manifest?Object.values(manifest.counts).reduce((a,b)=>a+b,0):0;
  const labels=['Sin datos · excluido','1 · Menor peligrosidad','2 · Moderada','3 · Alta','4 · Exploración excluida'];
  const colors=['#202b3a','#33b47a','#f4cb52','#eb853c','#a93040'];
  const markers=points.map((p,i)=>({...p,id:String(i),name:i?'Destino':'Origen',kind:i?'ciencia' as const:'aterrizaje' as const,region:'Marte',detail:''}));
  return <div className="app">
    <header className="topbar"><div className="brand"><span className="brand-mark">◉</span><div><strong>OLYMPUS</strong><small>PELIGROSIDAD DE MARTE</small></div></div><div className="header-right">{apiStatus}<span className="version">v0.3</span></div></header>
    <main className="workspace">
      <aside className="panel left-panel">
        <div className="section-heading">PELIGROSIDAD COMBINADA</div>
        <p className="description">Geología, accidentes, radiación y pendientes en una sola capa.</p>
        <div className="risk-placeholder"><strong>El mayor nivel determina la celda</strong><p>Si cualquiera de las cuatro capas tiene valor 4, la celda queda excluida de la exploración. Los valores 1–3 permanecen disponibles para calcular rutas.</p></div>
        <div className="section-heading section-gap">LEYENDA</div>
        {labels.map((label,i)=><div className="risk-row" key={label}><i style={{background:colors[i]}}/><span>{label}</span><small>{total?`${(100*manifest!.counts[String(i)]/total).toFixed(1)}%`:''}</small></div>)}
        <p className="note">Porcentajes de celdas de la cuadrícula, no de superficie planetaria.</p>
        <div className="section-heading section-gap">DATOS DE LA CAPA</div>
        <div className="metric"><span>Resolución de cálculo</span><strong>{manifest?`${manifest.resolutionM.toFixed(2)} m`:'—'}</strong></div>
        <div className="metric"><span>Datos de origen</span><strong>4 rásteres clasificados</strong></div>
        <p className="note">La vista global agrupa {manifest?.previewFactor??16} × {manifest?.previewFactor??16} celdas y conserva las exclusiones. Las rutas consultan el ráster original combinado, sin reducir su resolución.</p>
        <a className="download" href="/data/hazard.png" download>Descargar PNG combinado ↓</a>
      </aside>
      <section className="globe-area">
        <div className="globe-title"><span className="eyebrow">EXPLORACIÓN PLANETARIA</span><h1>Un planeta, cuatro factores</h1><p>{view==='3d'?'Arrastra para girar · Desplázate para acercar':'Amplía el mapa para explorar'} · Clic para colocar {active===0?'origen':'destino'}</p></div>
        <div className="view-toggle segmented"><button className={view==='3d'?'active':''} onClick={()=>setView('3d')}>Globo 3D</button><button className={view==='2d'?'active':''} onClick={()=>setView('2d')}>Mapa 2D</button></div>
        {(loading||error||result)&&<div className={`route-banner ${error?'route-failed':''}`} role={error?'alert':'status'}>{loading?'Buscando conexión entre celdas transitables…':error?`No se pudo calcular: ${error}`:`Ruta calculada: ${result!.distanceKm.toFixed(2)} km · Vista ampliada en 2D`}</div>}
        {manifest ? view==='3d'?<MarsGlobe points={markers} selectedId={String(active)} onSelect={id=>setActive(Number(id))} onPick={pick} manifest={manifest} routeCoordinates={result?.geometry.coordinates}/>:<MarsMap manifest={manifest} points={points} onPick={pick} route={result?.geometry.coordinates}/>:<div className="map-message" role="status">{mapError||'Cargando peligrosidad combinada…'}</div>}
        <div className="legend"><span><i className="legend-dot mint"/> A · Origen</span><span><i className="legend-dot amber"/> B · Destino</span><span><i className="legend-line"/> Ruta sin nivel 4</span></div>
      </section>
      <aside className="panel right-panel">
        <div className="section-heading">PLANIFICADOR DE RUTAS</div>
        <div className="segmented"><button className={mission==='robotica'?'active':''} disabled={loading} onClick={()=>{setMission('robotica');clear();}}>Robótica</button><button className={mission==='humana'?'active':''} disabled={loading} onClick={()=>{setMission('humana');clear();}}>Humana</button></div>
        <p className="note">El perfil humano penaliza más los niveles 2 y 3. Ambos excluyen el nivel 4.</p>
        <fieldset disabled={loading}>
          {points.map((point,i)=><div className="coordinate-block" key={i}>
            <button className={`point-button ${active===i?'active':''}`} onClick={()=>setActive(i)}>{i===0?'A · Origen':'B · Destino'} {active===i?'· Seleccionando en mapa':''}</button>
            <label>Longitud E<input aria-label={`Longitud ${i===0?'origen':'destino'}`} type="number" step="0.001" min="-180" max="180" value={point.lon} onChange={e=>update(i,'lon',e.target.value)}/></label>
            <label>Latitud<input aria-label={`Latitud ${i===0?'origen':'destino'}`} type="number" step="0.001" min="-89.999" max="89.999" value={point.lat} onChange={e=>update(i,'lat',e.target.value)}/></label>
          </div>)}
        </fieldset>
        <button className="primary-btn" disabled={loading||!manifest} onClick={plan}>{loading?'Calculando ruta…':'Calcular ruta'}</button>
        {error&&<div className="risk-placeholder" role="alert"><strong>No se pudo trazar la ruta</strong><p>{error}</p></div>}
        <div className="divider"/><div className="section-heading">RESULTADO</div>
        <div className="metric"><span>Distancia</span><strong>{result?`${result.distanceKm.toFixed(2)} km`:'Sin calcular'}</strong></div>
        {result?.riskFactors&&[1,2,3].map(i=><div className="metric" key={i}><span>Celdas de nivel {i}</span><strong>{result.riskFactors![`nivel${i}Pct`]}%</strong></div>)}
        <p className="note">{result?.notes??'Selecciona puntos próximos entre sí. El algoritmo busca conexiones entre celdas transitables y comunica cuando un punto está excluido o no encuentra conexión.'}</p>
      </aside>
    </main>
  </div>;
}

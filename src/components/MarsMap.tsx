import { useState } from 'react';
import type { Coordinate, HazardManifest } from '../types/mission';

type Props = { manifest: HazardManifest; points: Coordinate[]; route?: [number,number][];
  onPick: (point: Coordinate) => void };
export default function MarsMap({manifest, points, route, onPick}: Props) {
  const [zoom, setZoom] = useState(1);
  const [west,south,east,north] = manifest.boundsLonLat;
  return <div className="map-container">
    <div className="map-tools"><button onClick={()=>setZoom(z=>Math.max(1,z/2))} aria-label="Alejar mapa">−</button>
      <span>{zoom}×</span><button onClick={()=>setZoom(z=>Math.min(32,z*2))} aria-label="Acercar mapa">+</button></div>
    <div className="map-scroll"><svg viewBox="0 0 360 180" style={{width:`${zoom*100}%`}} role="img" aria-label="Mapa 2D de peligrosidad combinada"
      onClick={e=>{const rect=e.currentTarget.getBoundingClientRect();onPick({lon:(e.clientX-rect.left)/rect.width*360-180,lat:90-(e.clientY-rect.top)/rect.height*180});}}>
      <image href="/data/hazard.png" x={west+180} y={90-north} width={east-west} height={north-south} preserveAspectRatio="none"/>
      {[-120,-60,0,60,120].map(lon=><line key={lon} x1={lon+180} x2={lon+180} y1={0} y2={180} stroke="#ffffff25" strokeWidth=".2"/>)}
      {[-60,-30,0,30,60].map(lat=><line key={lat} x1={0} x2={360} y1={90-lat} y2={90-lat} stroke="#ffffff25" strokeWidth=".2"/>)}
      {route && <polyline points={route.map(([lon,lat])=>`${lon+180},${90-lat}`).join(' ')} fill="none" stroke="white" strokeWidth={.65/zoom}/>}
      {points.map((p,i)=><g key={i}><circle cx={p.lon+180} cy={90-p.lat} r={2/Math.sqrt(zoom)} fill={i===0?'#65e8ff':'#fff'} stroke="#152337" strokeWidth={.4/zoom}/><text x={p.lon+180+3/zoom} y={90-p.lat} fill="white" fontSize={5/zoom}>{i===0?'A':'B'}</text></g>)}
    </svg></div>
    <p className="note">Norte arriba · Longitud −180° a 180° · Haz clic para colocar el punto activo. Desplázate por el mapa ampliado.</p>
  </div>;
}

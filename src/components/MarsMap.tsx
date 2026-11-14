import { useEffect, useState } from 'react';
import type { Coordinate, HazardManifest } from '../types/mission';

type Props = { manifest: HazardManifest; points: Coordinate[]; route?: [number,number][];
  onPick: (point: Coordinate) => void };
export default function MarsMap({manifest, points, route, onPick}: Props) {
  const [zoom, setZoom] = useState(1);
  const [focus, setFocus] = useState(true);
  useEffect(()=>{setFocus(true);setZoom(1);},[route]);
  let x=0,y=0,width=360,height=180;
  if (focus && route?.length) {
    const [minX,maxX,minY,maxY]=route.reduce(([a,b,c,d],[lon,lat])=>[Math.min(a,lon+180),Math.max(b,lon+180),Math.min(c,90-lat),Math.max(d,90-lat)],[Infinity,-Infinity,Infinity,-Infinity]);
    width=Math.max(.04,(maxX-minX)*1.5,(maxY-minY)*3);
    height=width/2;x=(minX+maxX-width)/2;y=(minY+maxY-height)/2;
  }
  const scale=width/360;
  const [west,south,east,north] = manifest.boundsLonLat;
  return <div className="map-container">
    <div className="map-tools"><button onClick={()=>setZoom(z=>Math.max(1,z/2))} aria-label="Alejar mapa">−</button>
      <span>{zoom}×</span><button onClick={()=>setZoom(z=>Math.min(32,z*2))} aria-label="Acercar mapa">+</button>
      {route&&<button onClick={()=>{setFocus(v=>!v);setZoom(1);}}>{focus?'Ver planeta':'Enfocar ruta'}</button>}</div>
    <div className="map-scroll"><svg viewBox={`${x} ${y} ${width} ${height}`} style={{width:`${zoom*100}%`,aspectRatio:'2 / 1'}} role="img" aria-label="Mapa 2D de peligrosidad combinada"
      onClick={e=>{const rect=e.currentTarget.getBoundingClientRect();onPick({lon:x+(e.clientX-rect.left)/rect.width*width-180,lat:90-y-(e.clientY-rect.top)/rect.height*height});}}>
      <image href="/data/hazard.png" x={west+180} y={90-north} width={east-west} height={north-south} preserveAspectRatio="none"/>
      {[-120,-60,0,60,120].map(lon=><line key={lon} x1={lon+180} x2={lon+180} y1={0} y2={180} stroke="#ffffff25" strokeWidth={.2*scale}/>)}
      {[-60,-30,0,30,60].map(lat=><line key={lat} x1={0} x2={360} y1={90-lat} y2={90-lat} stroke="#ffffff25" strokeWidth={.2*scale}/>)}
      {route && <polyline points={route.map(([lon,lat])=>`${lon+180},${90-lat}`).join(' ')} fill="none" stroke="white" strokeWidth={1.2*scale/zoom}/>}
      {points.map((p,i)=><g key={i}><circle cx={p.lon+180} cy={90-p.lat} r={2*scale/Math.sqrt(zoom)} fill={i===0?'#65e8ff':'#fff'} stroke="#152337" strokeWidth={.4*scale/zoom}/><text x={p.lon+180+3*scale/zoom} y={90-p.lat} fill="white" fontSize={7*scale/zoom}>{i===0?'A':'B'}</text></g>)}
    </svg></div>
    <p className="note">Norte arriba · Longitud −180° a 180° · Haz clic para colocar el punto activo. Desplázate por el mapa ampliado.</p>
    {focus&&route&&<p className="note">Ruta ampliada automáticamente. El fondo es la vista global agregada; no representa el detalle de las celdas usadas para calcular esta ruta.</p>}
  </div>;
}

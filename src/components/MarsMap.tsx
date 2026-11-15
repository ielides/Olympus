import { useCallback, useEffect, useRef, useState } from 'react';
import type { Coordinate, HazardManifest } from '../types/mission';

type Props = {
  manifest: HazardManifest;
  points: Coordinate[];
  route?: [number, number][];
  layerUrl?: string;
  onPick: (point: Coordinate, targetIndex?: number) => void;
  shadowOpacity?: number;
  activePoint?: number;
  onSelectPoint?: (index: number) => void;
};

type DragState =
  | { mode: 'none' }
  | { mode: 'marker'; index: number }
  | { mode: 'pan'; startX: number; startY: number; startCenter: { x: number; y: number }; moved: boolean };

const MIN_ZOOM = 1;
const MAX_ZOOM = 40;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampCenter(x: number, y: number, zoom: number): { x: number; y: number } {
  const halfW = 180 / zoom;
  const halfH = 90 / zoom;
  return {
    x: clamp(x, halfW, 360 - halfW),
    y: clamp(y, halfH, 180 - halfH),
  };
}

function clientToSvg(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const ctm = svg.getScreenCTM();
  if (ctm) {
    const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: clamp(pt.x, 0, 360), y: clamp(pt.y, 0, 180) };
  }
  const rect = svg.getBoundingClientRect();
  return {
    x: clamp(((clientX - rect.left) / rect.width) * 360, 0, 360),
    y: clamp(((clientY - rect.top) / rect.height) * 180, 0, 180),
  };
}

function svgToCoord(x: number, y: number): Coordinate {
  return {
    lon: Number(clamp(x - 180, -180, 180).toFixed(3)),
    lat: Number(clamp(90 - y, -89.999, 89.999).toFixed(3)),
  };
}

export default function MarsMap({
  manifest,
  points,
  route,
  layerUrl = '/data/hazard.png',
  onPick,
  shadowOpacity = 0.85,
  activePoint = 0,
  onSelectPoint,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<DragState>({ mode: 'none' });

  const [zoom, setZoom] = useState(1);
  const [center, setCenter] = useState({ x: 180, y: 90 });
  const [isPanning, setIsPanning] = useState(false);
  const [isDraggingMarker, setIsDraggingMarker] = useState(false);
  const [hoverCoord, setHoverCoord] = useState<Coordinate | null>(null);

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const centerRef = useRef(center);
  centerRef.current = center;

  const focusBounds = useCallback((coords: [number, number][]) => {
    if (!coords.length) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const [lon, lat] of coords) {
      const sx = lon + 180;
      const sy = 90 - lat;
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }

    const spanX = Math.max(0.06, (maxX - minX) * 1.5);
    const spanY = Math.max(0.03, (maxY - minY) * 1.5);
    const nextZoom = clamp(Math.min(360 / spanX, 180 / spanY), MIN_ZOOM, MAX_ZOOM);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    setZoom(nextZoom);
    setCenter(clampCenter(cx, cy, nextZoom));
  }, []);

  useEffect(() => {
    if (route && route.length >= 2) {
      focusBounds(route);
    }
  }, [route, focusBounds]);

  // Native non-passive wheel listener for smooth zoom-to-cursor
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const oldZoom = zoomRef.current;
      const oldCenter = centerRef.current;
      const factor = e.deltaY < 0 ? 1.25 : 0.8;
      const nextZoom = clamp(oldZoom * factor, MIN_ZOOM, MAX_ZOOM);
      if (Math.abs(nextZoom - oldZoom) < 1e-4) return;

      const oldW = 360 / oldZoom;
      const oldH = 180 / oldZoom;
      const oldViewX = clamp(oldCenter.x - oldW / 2, 0, 360 - oldW);
      const oldViewY = clamp(oldCenter.y - oldH / 2, 0, 180 - oldH);

      const cursor = clientToSvg(svg, e.clientX, e.clientY);
      const fx = (cursor.x - oldViewX) / oldW;
      const fy = (cursor.y - oldViewY) / oldH;

      const nextW = 360 / nextZoom;
      const nextH = 180 / nextZoom;
      const nextViewX = cursor.x - fx * nextW;
      const nextViewY = cursor.y - fy * nextH;

      setZoom(nextZoom);
      setCenter(clampCenter(nextViewX + nextW / 2, nextViewY + nextH / 2, nextZoom));
    };

    svg.addEventListener('wheel', handleWheel, { passive: false });
    return () => svg.removeEventListener('wheel', handleWheel);
  }, []);

  const zoomAroundCenter = (factor: number) => {
    const nextZoom = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    setZoom(nextZoom);
    setCenter(prev => clampCenter(prev.x, prev.y, nextZoom));
  };

  const resetGlobalView = () => {
    setZoom(1);
    setCenter({ x: 180, y: 90 });
  };

  const viewWidth = 360 / zoom;
  const viewHeight = 180 / zoom;
  const viewX = clamp(center.x - viewWidth / 2, 0, 360 - viewWidth);
  const viewY = clamp(center.y - viewHeight / 2, 0, 180 - viewHeight);
  const scale = viewWidth / 360;

  const [west, south, east, north] = manifest.boundsLonLat;

  const majorLons = [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150];
  const majorLats = [-60, -30, 0, 30, 60];
  const minorLons = zoom >= 4 ? Array.from({ length: 35 }, (_, i) => -170 + i * 10).filter(v => v % 30 !== 0) : [];
  const minorLats = zoom >= 4 ? Array.from({ length: 17 }, (_, i) => -80 + i * 10).filter(v => v % 30 !== 0) : [];

  const handleSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const svg = svgRef.current;
    if (!svg) return;
    svg.setPointerCapture(e.pointerId);
    dragRef.current = {
      mode: 'pan',
      startX: e.clientX,
      startY: e.clientY,
      startCenter: { ...center },
      moved: false,
    };
  };

  const handleMarkerPointerDown = (e: React.PointerEvent<SVGGElement>, index: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const svg = svgRef.current;
    if (!svg) return;
    svg.setPointerCapture(e.pointerId);
    onSelectPoint?.(index);
    dragRef.current = { mode: 'marker', index };
    setIsDraggingMarker(true);
  };

  const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const svgPt = clientToSvg(svg, e.clientX, e.clientY);
    const coord = svgToCoord(svgPt.x, svgPt.y);
    setHoverCoord(coord);

    const state = dragRef.current;
    if (state.mode === 'marker') {
      onPick(coord, state.index);
      return;
    }

    if (state.mode === 'pan') {
      const dxPx = e.clientX - state.startX;
      const dyPx = e.clientY - state.startY;
      if (!state.moved && Math.hypot(dxPx, dyPx) <= 4) return;
      state.moved = true;
      setIsPanning(true);

      const ctm = svg.getScreenCTM();
      const pxPerDegX = ctm ? Math.abs(ctm.a) : svg.getBoundingClientRect().width / viewWidth;
      const pxPerDegY = ctm ? Math.abs(ctm.d) : svg.getBoundingClientRect().height / viewHeight;
      if (pxPerDegX > 0 && pxPerDegY > 0) {
        setCenter(
          clampCenter(
            state.startCenter.x - dxPx / pxPerDegX,
            state.startCenter.y - dyPx / pxPerDegY,
            zoom
          )
        );
      }
    }
  };

  const handleSvgPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (svg && svg.hasPointerCapture(e.pointerId)) {
      svg.releasePointerCapture(e.pointerId);
    }

    const state = dragRef.current;
    dragRef.current = { mode: 'none' };
    setIsPanning(false);
    setIsDraggingMarker(false);

    if (state.mode === 'pan' && !state.moved && svg) {
      const svgPt = clientToSvg(svg, e.clientX, e.clientY);
      onPick(svgToCoord(svgPt.x, svgPt.y));
    }
  };

  return (
    <div className="map-container">
      <div className="map-tools">
        <div className="map-tools-left">
          <button onClick={() => zoomAroundCenter(0.75)} aria-label="Alejar mapa" disabled={zoom <= MIN_ZOOM}>
            −
          </button>
          <span className="zoom-badge">{zoom.toFixed(1)}×</span>
          <button onClick={() => zoomAroundCenter(1.35)} aria-label="Acercar mapa" disabled={zoom >= MAX_ZOOM}>
            +
          </button>
          <button onClick={resetGlobalView}>Vista global</button>
          <button
            onClick={() =>
              focusBounds(
                route && route.length >= 2 ? route : points.map(p => [p.lon, p.lat] as [number, number])
              )
            }
          >
            {route && route.length >= 2 ? 'Enfocar ruta' : 'Enfocar A–B'}
          </button>
        </div>

        <div className="map-coords-readout">
          {hoverCoord
            ? `Lon: ${hoverCoord.lon.toFixed(3)}° · Lat: ${hoverCoord.lat.toFixed(3)}°`
            : 'Arrastra para mover · Rueda para zoom · Arrastra A/B o clic para situar'}
        </div>
      </div>

      <div className="map-viewport">
        <svg
          ref={svgRef}
          viewBox={`${viewX} ${viewY} ${viewWidth} ${viewHeight}`}
          className={isDraggingMarker ? 'dragging-marker' : isPanning ? 'panning' : ''}
          role="img"
          aria-label="Mapa 2D interactivo de Marte"
          onPointerDown={handleSvgPointerDown}
          onPointerMove={handleSvgPointerMove}
          onPointerUp={handleSvgPointerUp}
          onPointerCancel={handleSvgPointerUp}
          onPointerLeave={() => setHoverCoord(null)}
        >
          {/* Base Layer Texture */}
          <image
            href={layerUrl}
            x={west + 180}
            y={90 - north}
            width={east - west}
            height={north - south}
            preserveAspectRatio="none"
          />

          {/* MOLA/HRSC Topographical Hillshade Shadow Layer */}
          {shadowOpacity > 0 && (
            <image
              href="/data/mars_hillshade.png"
              x={west + 180}
              y={90 - north}
              width={east - west}
              height={north - south}
              preserveAspectRatio="none"
              style={{ mixBlendMode: 'multiply', opacity: shadowOpacity, pointerEvents: 'none' }}
            />
          )}

          {/* Minor 10 deg graticule when zoomed */}
          {minorLons.map(lon => (
            <line
              key={`mlon-${lon}`}
              x1={lon + 180}
              x2={lon + 180}
              y1={0}
              y2={180}
              stroke="#ffffff14"
              strokeWidth={0.12 * scale}
              pointerEvents="none"
            />
          ))}
          {minorLats.map(lat => (
            <line
              key={`mlat-${lat}`}
              x1={0}
              x2={360}
              y1={90 - lat}
              y2={90 - lat}
              stroke="#ffffff14"
              strokeWidth={0.12 * scale}
              pointerEvents="none"
            />
          ))}

          {/* Major 30 deg graticule + coordinate labels */}
          {majorLons.map(lon => (
            <g key={`lon-${lon}`} pointerEvents="none">
              <line x1={lon + 180} x2={lon + 180} y1={0} y2={180} stroke="#ffffff2b" strokeWidth={0.18 * scale} />
              <text
                x={lon + 180 + 1.2 * scale}
                y={viewY + 5.5 * scale}
                fill="#dbe8f8a8"
                fontSize={3.6 * scale}
              >
                {lon}°
              </text>
            </g>
          ))}
          {majorLats.map(lat => (
            <g key={`lat-${lat}`} pointerEvents="none">
              <line x1={0} x2={360} y1={90 - lat} y2={90 - lat} stroke="#ffffff2b" strokeWidth={0.18 * scale} />
              <text
                x={viewX + 2.0 * scale}
                y={90 - lat - 1.2 * scale}
                fill="#dbe8f8a8"
                fontSize={3.6 * scale}
              >
                {lat}°
              </text>
            </g>
          ))}

          {/* High-contrast route path (casing + inner line) */}
          {route && route.length >= 2 && (
            <g pointerEvents="none">
              <polyline
                points={route.map(([lon, lat]) => `${lon + 180},${90 - lat}`).join(' ')}
                fill="none"
                stroke="#07101c"
                strokeOpacity={0.85}
                strokeWidth={2.2 * scale}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <polyline
                points={route.map(([lon, lat]) => `${lon + 180},${90 - lat}`).join(' ')}
                fill="none"
                stroke="#ffd27c"
                strokeWidth={1.15 * scale}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          )}

          {/* Interactive draggable markers A & B */}
          {points.map((p, i) => {
            const cx = p.lon + 180;
            const cy = 90 - p.lat;
            const isSelected = activePoint === i;
            const fill = i === 0 ? '#6dd5c2' : '#ffc078';
            const tag = i === 0 ? 'A' : 'B';

            return (
              <g
                key={i}
                style={{ cursor: 'move' }}
                onPointerDown={e => handleMarkerPointerDown(e, i)}
              >
                {isSelected && (
                  <circle
                    cx={cx}
                    cy={cy}
                    r={4.2 * scale}
                    fill="none"
                    stroke="#ffffff"
                    strokeWidth={0.55 * scale}
                    strokeOpacity={0.9}
                  />
                )}
                <circle
                  cx={cx}
                  cy={cy}
                  r={2.5 * scale}
                  fill={fill}
                  stroke="#091321"
                  strokeWidth={0.7 * scale}
                />
                <rect
                  x={cx + 3.4 * scale}
                  y={cy - 4.0 * scale}
                  width={27 * scale}
                  height={6.6 * scale}
                  rx={1.5 * scale}
                  fill="#0b1422e0"
                  stroke={fill}
                  strokeWidth={0.35 * scale}
                />
                <text
                  x={cx + 4.8 * scale}
                  y={cy + 0.5 * scale}
                  fill="#eef4fb"
                  fontSize={3.6 * scale}
                  fontWeight={700}
                >
                  {tag} ({p.lon.toFixed(1)}, {p.lat.toFixed(1)})
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

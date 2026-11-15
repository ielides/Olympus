import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  | {
      mode: 'pan';
      button: number;
      startX: number;
      startY: number;
      startCenter: Coordinate;
      moved: boolean;
    };

const MIN_ZOOM = 0.85;
const MAX_ZOOM = 50;
const MARS_RADIUS_M = 3396190;
const METERS_PER_DEG = (Math.PI / 180) * MARS_RADIUS_M;

const GRID_STEPS = [
  { major: 0.002, minor: 0.0005, dec: 3 },
  { major: 0.005, minor: 0.001, dec: 3 },
  { major: 0.01, minor: 0.0025, dec: 2 },
  { major: 0.02, minor: 0.005, dec: 2 },
  { major: 0.05, minor: 0.01, dec: 2 },
  { major: 0.1, minor: 0.025, dec: 2 },
  { major: 0.2, minor: 0.05, dec: 2 },
  { major: 0.5, minor: 0.1, dec: 1 },
  { major: 1, minor: 0.25, dec: 1 },
  { major: 2, minor: 0.5, dec: 1 },
  { major: 5, minor: 1, dec: 0 },
  { major: 10, minor: 5, dec: 0 },
  { major: 15, minor: 5, dec: 0 },
  { major: 30, minor: 10, dec: 0 },
];

const SCALE_CANDIDATES_M = [
  2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000, 2000000,
  5000000,
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function gridSteps(minVal: number, maxVal: number, step: number): number[] {
  const first = Math.ceil((minVal - 1e-9) / step) * step;
  const out: number[] = [];
  for (let v = first; v <= maxVal + 1e-9; v += step) {
    out.push(Number(v.toFixed(6)));
  }
  return out;
}

function zoomToSlider(zoom: number): number {
  const norm = Math.log(clamp(zoom, MIN_ZOOM, MAX_ZOOM) / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM);
  return Math.round(norm * 100);
}

function sliderToZoom(val: number): number {
  const t = clamp(val, 0, 100) / 100;
  return MIN_ZOOM * Math.pow(MAX_ZOOM / MIN_ZOOM, t);
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
  const [west, south, east, north] = manifest.boundsLonLat;
  const baseW = Math.max(1e-4, east - west);
  const baseH = Math.max(1e-4, north - south);
  const isLocalSite = baseW < 5.0;
  const midLat = (south + north) / 2;
  const cosMidLat = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const aspectX = isLocalSite ? cosMidLat : 1;

  const viewportRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState>({ mode: 'none' });
  const minimapDragRef = useRef(false);
  const didInitRef = useRef(false);

  const [vpSize, setVpSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(isLocalSite ? 1.8 : 1);
  const [center, setCenter] = useState<Coordinate>({
    lon: (west + east) / 2,
    lat: (south + north) / 2,
  });
  const [isPanning, setIsPanning] = useState(false);
  const [isDraggingMarker, setIsDraggingMarker] = useState(false);
  const [hoverCoord, setHoverCoord] = useState<Coordinate | null>(null);

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const centerRef = useRef(center);
  centerRef.current = center;
  const vpSizeRef = useRef(vpSize);
  vpSizeRef.current = vpSize;

  // Measure .map-viewport dimensions cleanly via ResizeObserver
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const updateSize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) {
        setVpSize(prev => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const vpW = vpSize.width;
  const vpH = vpSize.height;
  const pad = Math.min(28, vpW * 0.04, vpH * 0.04);
  const fitPxPerDeg =
    vpW > 0 && vpH > 0
      ? Math.max(1e-3, Math.min((vpW - pad) / (baseW * aspectX), (vpH - pad) / baseH))
      : 100;

  const fillWidthZoom =
    vpW > 0 && vpH > 0
      ? clamp((vpW - 24) / (baseW * aspectX * fitPxPerDeg), 1, MAX_ZOOM)
      : isLocalSite
        ? 2.2
        : 1;

  const pxPerDegY = fitPxPerDeg * zoom;
  const pxPerDegX = fitPxPerDeg * aspectX * zoom;

  const clampCenter = useCallback(
    (lon: number, lat: number): Coordinate => ({
      lon: clamp(lon, west, east),
      lat: clamp(lat, south, north),
    }),
    [west, east, south, north]
  );

  // Reset initial framing when dataset bounds change
  useEffect(() => {
    didInitRef.current = false;
  }, [west, south, east, north]);

  useEffect(() => {
    if (didInitRef.current || vpW === 0 || vpH === 0) return;
    didInitRef.current = true;

    if (isLocalSite) {
      const targetLon =
        points.length >= 2 ? clamp((points[0].lon + points[1].lon) / 2, west, east) : (west + east) / 2;
      const targetLat =
        points.length >= 2 ? clamp((points[0].lat + points[1].lat) / 2, south, north) : (south + north) / 2;
      setZoom(1.8);
      setCenter({ lon: targetLon, lat: targetLat });
    } else {
      setZoom(1);
      setCenter({ lon: (west + east) / 2, lat: (south + north) / 2 });
    }
  }, [vpW, vpH, isLocalSite, points, west, east, south, north]);

  const roundCoord = useCallback(
    (lon: number, lat: number): Coordinate => {
      const dec = isLocalSite ? 5 : 3;
      return {
        lon: Number(clamp(lon, west, east).toFixed(dec)),
        lat: Number(clamp(lat, south, north).toFixed(dec)),
      };
    },
    [isLocalSite, west, east, south, north]
  );

  const clientToCoord = useCallback(
    (clientX: number, clientY: number): Coordinate | null => {
      const el = viewportRef.current;
      if (!el || vpW <= 0 || vpH <= 0) return null;
      const rect = el.getBoundingClientRect();
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      const lon = centerRef.current.lon + (mx - vpW / 2) / pxPerDegX;
      const lat = centerRef.current.lat - (my - vpH / 2) / pxPerDegY;
      return roundCoord(lon, lat);
    },
    [vpW, vpH, pxPerDegX, pxPerDegY, roundCoord]
  );

  const zoomAtViewportPoint = useCallback(
    (factor: number, mx: number, my: number) => {
      const curW = vpSizeRef.current.width;
      const curH = vpSizeRef.current.height;
      if (curW <= 0 || curH <= 0) return;

      const curPad = Math.min(28, curW * 0.04, curH * 0.04);
      const curFit = Math.max(1e-3, Math.min((curW - curPad) / (baseW * aspectX), (curH - curPad) / baseH));
      const oldZoom = zoomRef.current;
      const nextZoom = clamp(oldZoom * factor, MIN_ZOOM, MAX_ZOOM);
      if (Math.abs(nextZoom - oldZoom) < 1e-4) return;

      const oldPxX = curFit * aspectX * oldZoom;
      const oldPxY = curFit * oldZoom;
      const newPxX = curFit * aspectX * nextZoom;
      const newPxY = curFit * nextZoom;

      const cursorLon = centerRef.current.lon + (mx - curW / 2) / oldPxX;
      const cursorLat = centerRef.current.lat - (my - curH / 2) / oldPxY;

      const nextCenterLon = cursorLon - (mx - curW / 2) / newPxX;
      const nextCenterLat = cursorLat + (my - curH / 2) / newPxY;

      setZoom(nextZoom);
      setCenter(clampCenter(nextCenterLon, nextCenterLat));
    },
    [baseW, baseH, aspectX, clampCenter]
  );

  const zoomAroundCenter = useCallback(
    (factor: number) => {
      const nextZoom = clamp(zoomRef.current * factor, MIN_ZOOM, MAX_ZOOM);
      setZoom(nextZoom);
      setCenter(prev => clampCenter(prev.lon, prev.lat));
    },
    [clampCenter]
  );

  const setExactZoom = useCallback(
    (nextZoom: number) => {
      setZoom(clamp(nextZoom, MIN_ZOOM, MAX_ZOOM));
      setCenter(prev => clampCenter(prev.lon, prev.lat));
    },
    [clampCenter]
  );

  const resetSiteView = useCallback(() => {
    setZoom(1);
    setCenter({ lon: (west + east) / 2, lat: (south + north) / 2 });
  }, [west, east, south, north]);

  const fitWidthView = useCallback(() => {
    setZoom(fillWidthZoom);
    setCenter(prev => clampCenter((west + east) / 2, prev.lat));
  }, [fillWidthZoom, west, east, clampCenter]);

  const focusBounds = useCallback(
    (coords: [number, number][]) => {
      if (!coords.length || vpW <= 0 || vpH <= 0) return;
      let minLon = Infinity;
      let maxLon = -Infinity;
      let minLat = Infinity;
      let maxLat = -Infinity;

      for (const [lon, lat] of coords) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }

      const spanLon = Math.max(baseW / MAX_ZOOM, (maxLon - minLon) * 1.45);
      const spanLat = Math.max(baseH / MAX_ZOOM, (maxLat - minLat) * 1.45);
      const neededZoom = Math.min((vpW - 48) / (spanLon * aspectX * fitPxPerDeg), (vpH - 48) / (spanLat * fitPxPerDeg));
      const nextZoom = clamp(neededZoom, MIN_ZOOM, MAX_ZOOM);

      setZoom(nextZoom);
      setCenter(clampCenter((minLon + maxLon) / 2, (minLat + maxLat) / 2));
    },
    [vpW, vpH, baseW, baseH, aspectX, fitPxPerDeg, clampCenter]
  );

  useEffect(() => {
    if (route && route.length >= 2) {
      focusBounds(route);
    }
  }, [route, focusBounds]);

  // Smooth cursor-centered wheel zoom
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const rawFactor = Math.exp(-e.deltaY * 0.0018);
      const factor = clamp(rawFactor, 0.72, 1.38);
      zoomAtViewportPoint(factor, mx, my);
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [zoomAtViewportPoint]);

  const lonLatToPx = useCallback(
    (lon: number, lat: number) => ({
      x: vpW / 2 + (lon - center.lon) * pxPerDegX,
      y: vpH / 2 + (center.lat - lat) * pxPerDegY,
    }),
    [vpW, vpH, center.lon, center.lat, pxPerDegX, pxPerDegY]
  );

  // Raster image box in exact CSS pixels
  const mapLeft = vpW / 2 + (west - center.lon) * pxPerDegX;
  const mapTop = vpH / 2 + (center.lat - north) * pxPerDegY;
  const mapWidth = baseW * pxPerDegX;
  const mapHeight = baseH * pxPerDegY;

  // Dynamic coordinate graticule computed in crisp screen pixels
  const visibleLatSpan = vpH > 0 ? vpH / pxPerDegY : baseH;
  const gridSpec = useMemo(() => {
    const target = visibleLatSpan / 5;
    return GRID_STEPS.find(s => s.major >= target) ?? GRID_STEPS[GRID_STEPS.length - 1];
  }, [visibleLatSpan]);

  const visWest = vpW > 0 ? clamp(center.lon - vpW / (2 * pxPerDegX), west, east) : west;
  const visEast = vpW > 0 ? clamp(center.lon + vpW / (2 * pxPerDegX), west, east) : east;
  const visSouth = vpH > 0 ? clamp(center.lat - vpH / (2 * pxPerDegY), south, north) : south;
  const visNorth = vpH > 0 ? clamp(center.lat + vpH / (2 * pxPerDegY), south, north) : north;

  const majorLons = useMemo(() => gridSteps(visWest, visEast, gridSpec.major), [visWest, visEast, gridSpec.major]);
  const majorLats = useMemo(() => gridSteps(visSouth, visNorth, gridSpec.major), [visSouth, visNorth, gridSpec.major]);
  const minorLons = useMemo(
    () =>
      zoom >= 1.5
        ? gridSteps(visWest, visEast, gridSpec.minor).filter(
            v => Math.abs(v / gridSpec.major - Math.round(v / gridSpec.major)) > 1e-4
          )
        : [],
    [zoom, visWest, visEast, gridSpec.minor, gridSpec.major]
  );
  const minorLats = useMemo(
    () =>
      zoom >= 1.5
        ? gridSteps(visSouth, visNorth, gridSpec.minor).filter(
            v => Math.abs(v / gridSpec.major - Math.round(v / gridSpec.major)) > 1e-4
          )
        : [],
    [zoom, visSouth, visNorth, gridSpec.minor, gridSpec.major]
  );

  // Metric scale bar
  const scaleInfo = useMemo(() => {
    if (vpW <= 0) return { label: '1 km', widthPx: 72 };
    const cosRef = isLocalSite ? aspectX : Math.max(0.15, Math.cos((center.lat * Math.PI) / 180));
    const mPerPx = (METERS_PER_DEG * cosRef) / pxPerDegX;
    let chosen = SCALE_CANDIDATES_M.find(cand => {
      const px = cand / mPerPx;
      return px >= 46 && px <= 132;
    });
    if (!chosen) {
      const ideal = 85 * mPerPx;
      chosen = SCALE_CANDIDATES_M.reduce((best, cand) =>
        Math.abs(cand - ideal) < Math.abs(best - ideal) ? cand : best
      );
    }
    const widthPx = clamp(Math.round(chosen / mPerPx), 36, 150);
    const label = chosen >= 1000 ? `${chosen / 1000} km` : `${chosen} m`;
    return { label, widthPx };
  }, [vpW, isLocalSite, aspectX, center.lat, pxPerDegX]);

  // Pointer handlers on viewport
  const handleViewportPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    const el = viewportRef.current;
    if (!el) return;
    el.focus();
    el.setPointerCapture(e.pointerId);
    dragRef.current = {
      mode: 'pan',
      button: e.button,
      startX: e.clientX,
      startY: e.clientY,
      startCenter: { ...center },
      moved: false,
    };
  };

  const handleMarkerPointerDown = (e: React.PointerEvent<SVGGElement>, index: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const el = viewportRef.current;
    if (!el) return;
    el.focus();
    el.setPointerCapture(e.pointerId);
    onSelectPoint?.(index);
    dragRef.current = { mode: 'marker', index };
    setIsDraggingMarker(true);
  };

  const handleViewportPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const coord = clientToCoord(e.clientX, e.clientY);
    if (coord) setHoverCoord(coord);

    const state = dragRef.current;
    if (state.mode === 'marker') {
      if (coord) onPick(coord, state.index);
      return;
    }

    if (state.mode === 'pan') {
      const dxPx = e.clientX - state.startX;
      const dyPx = e.clientY - state.startY;
      if (!state.moved && Math.hypot(dxPx, dyPx) <= 5) return;
      state.moved = true;
      setIsPanning(true);

      setCenter(clampCenter(state.startCenter.lon - dxPx / pxPerDegX, state.startCenter.lat + dyPx / pxPerDegY));
    }
  };

  const handleViewportPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = viewportRef.current;
    if (el && el.hasPointerCapture(e.pointerId)) {
      el.releasePointerCapture(e.pointerId);
    }

    const state = dragRef.current;
    dragRef.current = { mode: 'none' };
    setIsPanning(false);
    setIsDraggingMarker(false);

    if (state.mode === 'pan' && !state.moved && state.button === 0 && el) {
      if (e.detail >= 2) {
        const rect = el.getBoundingClientRect();
        zoomAtViewportPoint(1.6, e.clientX - rect.left, e.clientY - rect.top);
      } else {
        const coord = clientToCoord(e.clientX, e.clientY);
        if (coord) onPick(coord);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const stepLon = (vpW * 0.14) / pxPerDegX;
    const stepLat = (vpH * 0.14) / pxPerDegY;

    switch (e.key) {
      case 'ArrowLeft':
      case 'a':
      case 'A':
        e.preventDefault();
        setCenter(prev => clampCenter(prev.lon - stepLon, prev.lat));
        break;
      case 'ArrowRight':
      case 'd':
      case 'D':
        e.preventDefault();
        setCenter(prev => clampCenter(prev.lon + stepLon, prev.lat));
        break;
      case 'ArrowUp':
      case 'w':
      case 'W':
        e.preventDefault();
        setCenter(prev => clampCenter(prev.lon, prev.lat + stepLat));
        break;
      case 'ArrowDown':
      case 's':
      case 'S':
        e.preventDefault();
        setCenter(prev => clampCenter(prev.lon, prev.lat - stepLat));
        break;
      case '+':
      case '=':
        e.preventDefault();
        zoomAroundCenter(1.25);
        break;
      case '-':
      case '_':
        e.preventDefault();
        zoomAroundCenter(0.8);
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        resetSiteView();
        break;
      case 'h':
      case 'H':
        e.preventDefault();
        fitWidthView();
        break;
      case 'r':
      case 'R':
        e.preventDefault();
        focusBounds(route && route.length >= 2 ? route : points.map(p => [p.lon, p.lat] as [number, number]));
        break;
      default:
        break;
    }
  };

  // Interactive Mini-Map dimensions & handlers
  const mmW = isLocalSite ? Math.max(64, Math.round(112 * ((baseW * aspectX) / baseH))) : 128;
  const mmH = isLocalSite ? 112 : Math.max(58, Math.round(128 * (baseH / (baseW * aspectX))));
  const showMinimap = vpW >= 420 && vpH >= 280;

  const panToMinimapClient = (clientX: number, clientY: number) => {
    const mm = minimapRef.current;
    if (!mm) return;
    const rect = mm.getBoundingClientRect();
    const u = clamp((clientX - rect.left) / rect.width, 0, 1);
    const v = clamp((clientY - rect.top) / rect.height, 0, 1);
    setCenter(clampCenter(west + u * baseW, north - v * baseH));
  };

  const mmBoxLeft = clamp(((visWest - west) / baseW) * mmW, 0, mmW - 4);
  const mmBoxTop = clamp(((north - visNorth) / baseH) * mmH, 0, mmH - 4);
  const mmBoxW = clamp(((visEast - visWest) / baseW) * mmW, 4, mmW - mmBoxLeft);
  const mmBoxH = clamp(((visNorth - visSouth) / baseH) * mmH, 4, mmH - mmBoxTop);

  const routeSvgPoints = useMemo(() => {
    if (!route || route.length < 2 || vpW <= 0) return '';
    return route
      .map(([lon, lat]) => {
        const pt = lonLatToPx(lon, lat);
        return `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
      })
      .join(' ');
  }, [route, vpW, lonLatToPx]);

  const topClipPx = clamp(mapTop, 0, vpH);
  const bottomClipPx = clamp(mapTop + mapHeight, 0, vpH);
  const leftClipPx = clamp(mapLeft, 0, vpW);
  const rightClipPx = clamp(mapLeft + mapWidth, 0, vpW);

  return (
    <div className="map-container">
      <div className="map-tools">
        <div className="map-tools-left">
          <button onClick={() => zoomAroundCenter(0.75)} aria-label="Alejar mapa" disabled={zoom <= MIN_ZOOM + 1e-3}>
            −
          </button>
          <input
            type="range"
            className="zoom-slider"
            min={0}
            max={100}
            value={zoomToSlider(zoom)}
            onChange={e => setExactZoom(sliderToZoom(Number(e.target.value)))}
            aria-label="Control de zoom del mapa"
          />
          <span className="zoom-badge">{zoom.toFixed(1)}×</span>
          <button onClick={() => zoomAroundCenter(1.35)} aria-label="Acercar mapa" disabled={zoom >= MAX_ZOOM - 1e-3}>
            +
          </button>
          <button onClick={resetSiteView} title="Ver toda la extensión del mapa (Tecla F)">
            Mapa completo
          </button>
          {isLocalSite && (
            <button onClick={fitWidthView} title="Ajustar ancho a la ventana para recorrer de Norte a Sur (Tecla H)">
              Ajustar ancho
            </button>
          )}
          <button
            onClick={() =>
              focusBounds(route && route.length >= 2 ? route : points.map(p => [p.lon, p.lat] as [number, number]))
            }
            title="Centrar puntos o ruta calculada (Tecla R)"
          >
            {route && route.length >= 2 ? 'Enfocar ruta' : points.length > 2 ? 'Enfocar puntos' : 'Enfocar A–B'}
          </button>
        </div>

        <div className="map-coords-readout">
          {hoverCoord
            ? `Lon: ${hoverCoord.lon.toFixed(isLocalSite ? 5 : 3)}° · Lat: ${hoverCoord.lat.toFixed(isLocalSite ? 5 : 3)}°`
            : 'Arrastra para mover · Rueda o doble clic para zoom · Clic para situar'}
        </div>
      </div>

      <div
        ref={viewportRef}
        tabIndex={0}
        className={`map-viewport ${isDraggingMarker ? 'dragging-marker' : isPanning ? 'panning' : ''}`}
        role="region"
        aria-label={isLocalSite ? 'Mapa 2D interactivo de Spirit / Cráter Gusev' : 'Mapa 2D interactivo de Marte'}
        onPointerDown={handleViewportPointerDown}
        onPointerMove={handleViewportPointerMove}
        onPointerUp={handleViewportPointerUp}
        onPointerCancel={handleViewportPointerUp}
        onPointerLeave={() => setHoverCoord(null)}
        onKeyDown={handleKeyDown}
      >
        {/* 1. Isolated Raster Layer Stack (blend stays isolated from crisp SVG text) */}
        <div className="map-raster-clip" aria-hidden="true">
          <div
            className="map-raster-stage"
            style={{
              left: `${mapLeft}px`,
              top: `${mapTop}px`,
              width: `${mapWidth}px`,
              height: `${mapHeight}px`,
            }}
          >
            <img
              src={layerUrl}
              alt=""
              draggable={false}
              className="map-raster-img"
              style={{ imageRendering: zoom > 8 ? 'pixelated' : 'auto' }}
            />
            {shadowOpacity > 0 && (
              <img
                src="/data/mars_hillshade.png"
                alt=""
                draggable={false}
                className="map-raster-img map-hillshade-img"
                style={{ opacity: shadowOpacity }}
              />
            )}
          </div>
        </div>

        {/* 2. Crisp 1:1 Screen-Space SVG Vector & Text Overlay */}
        {vpW > 0 && vpH > 0 && (
          <svg
            className="map-vector-overlay"
            width={vpW}
            height={vpH}
            viewBox={`0 0 ${vpW} ${vpH}`}
            shapeRendering="geometricPrecision"
            textRendering="geometricPrecision"
          >
            {/* Minor graticule */}
            {minorLons.map(lon => {
              const x = lonLatToPx(lon, north).x;
              if (x < 0 || x > vpW) return null;
              return (
                <line
                  key={`mlon-${lon}`}
                  x1={x}
                  x2={x}
                  y1={topClipPx}
                  y2={bottomClipPx}
                  stroke="#ffffff1a"
                  strokeWidth={1}
                  pointerEvents="none"
                />
              );
            })}
            {minorLats.map(lat => {
              const y = lonLatToPx(west, lat).y;
              if (y < 0 || y > vpH) return null;
              return (
                <line
                  key={`mlat-${lat}`}
                  x1={leftClipPx}
                  x2={rightClipPx}
                  y1={y}
                  y2={y}
                  stroke="#ffffff1a"
                  strokeWidth={1}
                  pointerEvents="none"
                />
              );
            })}

            {/* Major graticule + non-blurred CSS pixel coordinate labels */}
            {majorLons.map(lon => {
              const x = lonLatToPx(lon, north).x;
              if (x < 2 || x > vpW - 4) return null;
              const labelY = clamp(topClipPx + 15, 16, vpH - 22);
              const textAnchor = x > vpW - 62 ? 'end' : 'start';
              const textX = textAnchor === 'end' ? x - 5 : x + 5;
              return (
                <g key={`lon-${lon}`} pointerEvents="none">
                  <line x1={x} x2={x} y1={topClipPx} y2={bottomClipPx} stroke="#ffffff33" strokeWidth={1} />
                  <text
                    x={textX}
                    y={labelY}
                    textAnchor={textAnchor}
                    fill="#eef4fb"
                    fillOpacity={0.9}
                    stroke="#060d18"
                    strokeWidth={3.2}
                    strokeLinejoin="round"
                    paintOrder="stroke"
                    fontSize={11}
                    fontWeight={600}
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
                  >
                    {`${lon.toFixed(gridSpec.dec)}°`}
                  </text>
                </g>
              );
            })}
            {majorLats.map(lat => {
              const y = lonLatToPx(west, lat).y;
              if (y < 14 || y > vpH - 6) return null;
              const labelX = clamp(leftClipPx + 6, 8, vpW - 68);
              return (
                <g key={`lat-${lat}`} pointerEvents="none">
                  <line x1={leftClipPx} x2={rightClipPx} y1={y} y2={y} stroke="#ffffff33" strokeWidth={1} />
                  <text
                    x={labelX}
                    y={y - 5}
                    fill="#eef4fb"
                    fillOpacity={0.9}
                    stroke="#060d18"
                    strokeWidth={3.2}
                    strokeLinejoin="round"
                    paintOrder="stroke"
                    fontSize={11}
                    fontWeight={600}
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
                  >
                    {`${lat.toFixed(gridSpec.dec)}°`}
                  </text>
                </g>
              );
            })}

            {/* Route polyline (high-contrast casing + amber line) */}
            {routeSvgPoints && (
              <g pointerEvents="none">
                <polyline
                  points={routeSvgPoints}
                  fill="none"
                  stroke="#07101c"
                  strokeOpacity={0.88}
                  strokeWidth={5.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <polyline
                  points={routeSvgPoints}
                  fill="none"
                  stroke="#ffd27c"
                  strokeWidth={2.8}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            )}

            {/* Draggable Markers A..H */}
            {points.map((p, i) => {
              const { x: cx, y: cy } = lonLatToPx(p.lon, p.lat);
              const isSelected = activePoint === i;
              const fill = i === 0 ? '#6dd5c2' : i === points.length - 1 ? '#ffc078' : '#65a7eb';
              const tag = String.fromCharCode(65 + i);
              const coordStr = `${tag} (${p.lon.toFixed(isLocalSite ? 4 : 1)}, ${p.lat.toFixed(isLocalSite ? 4 : 1)})`;
              const pillW = isLocalSite ? 162 : 112;
              const pillH = 22;
              const placeLeft = cx + 14 + pillW > vpW - 8;
              const pillX = placeLeft ? cx - 14 - pillW : cx + 14;
              const pillY = clamp(cy - pillH / 2, 6, vpH - pillH - 6);

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
                      r={14}
                      fill="none"
                      stroke="#ffffff"
                      strokeWidth={2}
                      strokeOpacity={0.92}
                    />
                  )}
                  <circle cx={cx} cy={cy} r={8.5} fill={fill} stroke="#091321" strokeWidth={2.5} />
                  <rect
                    x={pillX}
                    y={pillY}
                    width={pillW}
                    height={pillH}
                    rx={6}
                    fill="#0b1422eb"
                    stroke={fill}
                    strokeWidth={1.3}
                  />
                  <text
                    x={pillX + 8}
                    y={pillY + 15}
                    fill="#eef4fb"
                    fontSize={11.5}
                    fontWeight={700}
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
                  >
                    {coordStr}
                  </text>
                </g>
              );
            })}
          </svg>
        )}

        {/* 3. Dynamic Metric Scale Bar */}
        <div className="map-scalebar" aria-hidden="true">
          <span>{scaleInfo.label}</span>
          <div className="map-scalebar-line" style={{ width: `${scaleInfo.widthPx}px` }} />
        </div>

        {/* 4. Interactive Mini-Map Radar */}
        {showMinimap && (
          <div
            ref={minimapRef}
            className="map-minimap"
            style={{ width: `${mmW}px`, height: `${mmH}px` }}
            title="Mini-mapa: haz clic o arrastra para navegar"
            onPointerDown={e => {
              e.stopPropagation();
              minimapDragRef.current = true;
              minimapRef.current?.setPointerCapture(e.pointerId);
              panToMinimapClient(e.clientX, e.clientY);
            }}
            onPointerMove={e => {
              if (!minimapDragRef.current) return;
              e.stopPropagation();
              panToMinimapClient(e.clientX, e.clientY);
            }}
            onPointerUp={e => {
              e.stopPropagation();
              minimapDragRef.current = false;
              if (minimapRef.current?.hasPointerCapture(e.pointerId)) {
                minimapRef.current.releasePointerCapture(e.pointerId);
              }
            }}
            onWheel={e => e.stopPropagation()}
          >
            <img src={layerUrl} alt="" draggable={false} className="map-minimap-img" />
            {route && route.length >= 2 && (
              <svg className="map-minimap-route" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                <polyline
                  points={route
                    .map(([lon, lat]) => `${(((lon - west) / baseW) * 100).toFixed(2)},${(((north - lat) / baseH) * 100).toFixed(2)}`)
                    .join(' ')}
                  fill="none"
                  stroke="#ffd27c"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            )}
            <div
              className="map-minimap-viewport"
              style={{
                left: `${mmBoxLeft}px`,
                top: `${mmBoxTop}px`,
                width: `${mmBoxW}px`,
                height: `${mmBoxH}px`,
              }}
            />
            {points.map((p, i) => {
              const leftPct = clamp(((p.lon - west) / baseW) * 100, 2, 98);
              const topPct = clamp(((north - p.lat) / baseH) * 100, 2, 98);
              const dotCls = i === 0 ? 'mint' : i === points.length - 1 ? 'amber' : 'sky';
              return (
                <span
                  key={i}
                  className={`map-minimap-dot ${dotCls}`}
                  style={{ left: `${leftPct}%`, top: `${topPct}%` }}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

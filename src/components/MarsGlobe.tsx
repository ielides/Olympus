import { useEffect, useRef } from 'react';
import { ArcRotateCamera, Color3, Color4, Engine, HemisphericLight, MeshBuilder, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import type { PointOfInterest } from '../types/mission';

type Props = {
  points: PointOfInterest[]; selectedId: string; onSelect: (id: string) => void;
  routeCoordinates?: [number, number][];
};
const RADIUS = 4;

function toPosition(lat: number, lon: number, radius = RADIUS) {
  const phi = lat * Math.PI / 180;
  const theta = lon * Math.PI / 180;
  return new Vector3(radius * Math.cos(phi) * Math.cos(theta), radius * Math.sin(phi), radius * Math.cos(phi) * Math.sin(theta));
}

function interpolateOnSphere(a: Vector3, b: Vector3, count = 8): Vector3[] {
  const v0 = a.normalize(), v1 = b.normalize();
  const angle = Math.acos(Math.max(-1, Math.min(1, Vector3.Dot(v0, v1))));
  if (angle < 1e-8) return [v0.scale(RADIUS + 0.15), v1.scale(RADIUS + 0.15)];
  const sinAngle = Math.sin(angle);
  if (Math.abs(sinAngle) < 1e-8) return [v0.scale(RADIUS + 0.15), v1.scale(RADIUS + 0.15)];
  return Array.from({length: count + 1}, (_, i) => {
    const t = i / count;
    return v0.scale(Math.sin((1-t)*angle)/sinAngle)
      .add(v1.scale(Math.sin(t*angle)/sinAngle))
      .normalize().scale(RADIUS + 0.15);
  });
}

export default function MarsGlobe({ points, selectedId, onSelect, routeCoordinates }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new Engine(canvas, true, { preserveDrawingBuffer: true });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.035, 0.075, 0.13, 1);
    const camera = new ArcRotateCamera('camera', -Math.PI / 2.8, Math.PI / 2.45, 12.5, Vector3.Zero(), scene);
    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = 5.3;
    camera.upperRadiusLimit = 22;
    camera.wheelPrecision = 38;
    const sun = new HemisphericLight('light', new Vector3(1, 1, 0), scene);
    sun.intensity = 1.35;
    const globe = MeshBuilder.CreateSphere('mars', { diameter: RADIUS * 2, segments: 64 }, scene);
    const mat = new StandardMaterial('mars-material', scene);
    mat.diffuseColor = new Color3(0.61, 0.31, 0.19);
    mat.specularColor = new Color3(0.07, 0.04, 0.03);
    globe.material = mat; // Esfera provisional: sustituir por textura de Marte.
    const markers = points.map(p => {
      const marker = MeshBuilder.CreateSphere(p.id, { diameter: p.kind === 'aterrizaje' ? 0.19 : 0.14, segments: 12 }, scene);
      marker.position = toPosition(p.lat, p.lon, RADIUS + 0.12);
      const material = new StandardMaterial(`${p.id}-mat`, scene);
      material.emissiveColor = p.kind === 'aterrizaje' ? Color3.FromHexString('#76d7c4') : Color3.FromHexString('#ffc078');
      if (p.id === selectedId) { marker.scaling.setAll(1.6); material.emissiveColor = Color3.White(); }
      marker.material = material;
      return marker;
    });
    const observer = scene.onPointerObservable.add(info => {
      if (info.type !== 1) return;
      const id = info.pickInfo?.pickedMesh?.name;
      if (id && points.some(p => p.id === id)) selectRef.current(id);
    });
    let routeMesh: ReturnType<typeof MeshBuilder.CreateLines> | undefined;
    if (routeCoordinates && routeCoordinates.length >= 2) {
      const path: Vector3[] = [];
      for (let i = 0; i < routeCoordinates.length - 1; i++) {
        const [lonA, latA] = routeCoordinates[i];
        const [lonB, latB] = routeCoordinates[i+1];
        const segment = interpolateOnSphere(toPosition(latA, lonA), toPosition(latB, lonB));
        path.push(...(i === 0 ? segment : segment.slice(1)));
      }
      routeMesh = MeshBuilder.CreateLines('ruta-api', { points: path }, scene);
      routeMesh.color = Color3.FromHexString('#ffd27c');
    }
    engine.runRenderLoop(() => scene.render());
    const observerResize = new ResizeObserver(() => engine.resize());
    observerResize.observe(canvas);
    return () => {
      observerResize.disconnect();
      if (observer) scene.onPointerObservable.remove(observer);
      routeMesh?.dispose();
      markers.forEach(m => m.dispose());
      scene.dispose(); engine.dispose();
    };
  }, [points, selectedId, routeCoordinates]);
  return <canvas ref={canvasRef} className="mars-canvas" aria-label="Globo marciano tridimensional interactivo" />;
}

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { PointOfInterest, Coordinate, HazardManifest } from '../types/mission';

type Props = {
  points: PointOfInterest[];
  selectedId: string;
  onSelect: (id: string) => void;
  routeCoordinates?: [number, number][];
  manifest: HazardManifest;
  layerUrl?: string;
  onPick: (point: Coordinate) => void;
  sunAngle?: number;
  sunAutoOrbit?: boolean;
  shadowOpacity?: number;
};

type DemGrid = {
  width: number;
  height: number;
  boundsLonLat: [number, number, number, number];
  elevNorm: number[];
};

const DISPLACEMENT_SCALE = 0.65;
const DISPLACEMENT_BIAS = -0.15;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function updateSunPosition(angleDeg: number, light: THREE.DirectionalLight, indicator?: THREE.Mesh | null) {
  const rad = (angleDeg * Math.PI) / 180.0;
  const dist = 14.0;
  const x = Math.cos(rad) * dist;
  const y = 6.5 + Math.sin(rad * 0.5) * 3.0;
  const z = Math.sin(rad) * dist;
  light.position.set(x, y, z);
  if (indicator) {
    indicator.position.set(x * 0.62, y * 0.62, z * 0.62);
  }
}

function sampleElevation(
  lon: number,
  lat: number,
  bounds: [number, number, number, number],
  grid: DemGrid | null
): number {
  if (!grid || !grid.elevNorm.length) {
    return DISPLACEMENT_BIAS + 0.35 * DISPLACEMENT_SCALE;
  }
  const [west, south, east, north] = bounds;
  const u = clamp((lon - west) / Math.max(1e-6, east - west), 0, 1);
  const vRow = clamp((north - lat) / Math.max(1e-6, north - south), 0, 1);
  const cf = u * (grid.width - 1);
  const rf = vRow * (grid.height - 1);
  const c0 = Math.floor(cf);
  const r0 = Math.floor(rf);
  const c1 = Math.min(grid.width - 1, c0 + 1);
  const r1 = Math.min(grid.height - 1, r0 + 1);
  const tx = cf - c0;
  const ty = rf - r0;

  const h00 = grid.elevNorm[r0 * grid.width + c0];
  const h10 = grid.elevNorm[r0 * grid.width + c1];
  const h01 = grid.elevNorm[r1 * grid.width + c0];
  const h11 = grid.elevNorm[r1 * grid.width + c1];
  const h = (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
  return DISPLACEMENT_BIAS + h * DISPLACEMENT_SCALE;
}

function lonLatToWorld(
  lon: number,
  lat: number,
  bounds: [number, number, number, number],
  terrainW: number,
  terrainD: number,
  grid: DemGrid | null,
  heightOffset = 0.05
): THREE.Vector3 {
  const [west, south, east, north] = bounds;
  const u = clamp((lon - west) / Math.max(1e-6, east - west), 0, 1);
  const vRow = clamp((north - lat) / Math.max(1e-6, north - south), 0, 1);
  const x = (u - 0.5) * terrainW;
  const z = (vRow - 0.5) * terrainD;
  const y = sampleElevation(lon, lat, bounds, grid) + heightOffset;
  return new THREE.Vector3(x, y, z);
}

function worldToLatLon(
  point: THREE.Vector3,
  bounds: [number, number, number, number],
  terrainW: number,
  terrainD: number
): Coordinate {
  const [west, south, east, north] = bounds;
  const u = clamp(point.x / terrainW + 0.5, 0, 1);
  const vRow = clamp(point.z / terrainD + 0.5, 0, 1);
  return {
    lon: Number((west + u * (east - west)).toFixed(5)),
    lat: Number((north - vRow * (north - south)).toFixed(5)),
  };
}

export default function MarsGlobe({
  points,
  selectedId,
  onSelect,
  routeCoordinates,
  manifest,
  layerUrl = '/data/layers/realidad.png',
  onPick,
  sunAngle = 45,
  sunAutoOrbit = true,
  shadowOpacity = 0.9,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const boundsRef = useRef(manifest.boundsLonLat);
  boundsRef.current = manifest.boundsLonLat;

  const [west, south, east, north] = manifest.boundsLonLat;
  const midLatRad = ((south + north) / 2) * (Math.PI / 180);
  const aspectWH = ((east - west) * Math.cos(midLatRad)) / Math.max(1e-5, north - south);
  const terrainW = 6.7;
  const terrainD = Number((terrainW / Math.max(0.25, aspectWH)).toFixed(3));
  const dimsRef = useRef({ terrainW, terrainD });
  dimsRef.current = { terrainW, terrainD };

  const demGridRef = useRef<DemGrid | null>(null);
  const [demVersion, setDemVersion] = useState(0);

  const terrainMeshRef = useRef<THREE.Mesh | null>(null);
  const terrainMatRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const markersGroupRef = useRef<THREE.Group | null>(null);
  const routeGroupRef = useRef<THREE.Group | null>(null);
  const textureLoaderRef = useRef<THREE.TextureLoader | null>(null);
  const sunLightRef = useRef<THREE.DirectionalLight | null>(null);
  const sunIndicatorRef = useRef<THREE.Mesh | null>(null);
  const shaderRef = useRef<{ uniforms: Record<string, THREE.IUniform> } | null>(null);
  const sunAngleRef = useRef(sunAngle);
  const sunAutoOrbitRef = useRef(sunAutoOrbit);
  const shadowOpacityRef = useRef(shadowOpacity);

  // Load compact Gusev DEM elevation grid for accurate surface snapping of pins & routes
  useEffect(() => {
    let active = true;
    fetch('/data/gusev_dem_grid.json')
      .then(r => (r.ok ? r.json() : null))
      .then((data: DemGrid | null) => {
        if (active && data?.elevNorm?.length) {
          demGridRef.current = data;
          setDemVersion(v => v + 1);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // 1. 3D Topographic Terrain Scene Initialization
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
    });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x060911);

    const camera = new THREE.PerspectiveCamera(44, container.clientWidth / container.clientHeight, 0.1, 200);
    camera.position.set(-4.6, 7.8, 8.6);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.15, 0);
    controls.screenSpacePanning = true;
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 2.0;
    controls.maxDistance = 24.0;
    controls.maxPolarAngle = Math.PI * 0.47;

    // Subtle spatial reference grid beneath terrain slab
    const gridHelper = new THREE.GridHelper(16, 24, 0x26415f, 0x111d2e);
    gridHelper.position.y = -0.22;
    scene.add(gridHelper);

    const sunLight = new THREE.DirectionalLight(0xfff5e4, 2.8);
    scene.add(sunLight);
    sunLightRef.current = sunLight;

    const sunGeo = new THREE.SphereGeometry(0.18, 16, 16);
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xffdd99 });
    const sunIndicator = new THREE.Mesh(sunGeo, sunMat);
    scene.add(sunIndicator);
    sunIndicatorRef.current = sunIndicator;
    updateSunPosition(sunAngleRef.current, sunLight, sunIndicator);

    const ambientLight = new THREE.AmbientLight(0x3a3234, 0.55);
    scene.add(ambientLight);
    const hemiLight = new THREE.HemisphereLight(0xd9e8ff, 0x2a1814, 0.4);
    scene.add(hemiLight);

    const textureLoader = new THREE.TextureLoader();
    textureLoaderRef.current = textureLoader;

    const bumpTexture = textureLoader.load('/data/mars_bump_2k.png');
    bumpTexture.colorSpace = THREE.LinearSRGBColorSpace;

    const normalTexture = textureLoader.load('/data/mars_normal_2k.png');
    normalTexture.colorSpace = THREE.NoColorSpace;

    const displacementTexture = textureLoader.load('/data/mars_elevation_2k.png');
    displacementTexture.colorSpace = THREE.NoColorSpace;

    const hillshadeTexture = textureLoader.load('/data/mars_hillshade.png');
    hillshadeTexture.colorSpace = THREE.LinearSRGBColorSpace;

    const layerTexture = textureLoader.load(layerUrl);
    layerTexture.colorSpace = THREE.SRGBColorSpace;
    layerTexture.generateMipmaps = true;
    layerTexture.minFilter = THREE.LinearMipmapLinearFilter;
    layerTexture.magFilter = THREE.LinearFilter;

    const terrainMat = new THREE.MeshStandardMaterial({
      map: layerTexture,
      normalMap: normalTexture,
      normalScale: new THREE.Vector2(1.4, 1.4),
      bumpMap: bumpTexture,
      bumpScale: 0.035,
      displacementMap: displacementTexture,
      displacementScale: DISPLACEMENT_SCALE,
      displacementBias: DISPLACEMENT_BIAS,
      roughness: 0.9,
      metalness: 0.02,
      side: THREE.DoubleSide,
    });

    terrainMat.onBeforeCompile = shader => {
      shader.uniforms.uHillshade = { value: hillshadeTexture };
      shader.uniforms.uHillshadeStrength = { value: shadowOpacityRef.current };
      shaderRef.current = shader;

      shader.fragmentShader =
        `
        uniform sampler2D uHillshade;
        uniform float uHillshadeStrength;
      ` + shader.fragmentShader;

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `
        #include <map_fragment>
        vec4 hill = texture2D(uHillshade, vMapUv);
        float reliefFactor = clamp((hill.r - 0.86) * 1.9 + 0.94, 0.18, 1.15);
        diffuseColor.rgb *= mix(1.0, reliefFactor, uHillshadeStrength);
        `
      );
    };

    const terrainGeo = new THREE.PlaneGeometry(terrainW, terrainD, 192, 320);
    terrainGeo.rotateX(-Math.PI / 2);

    const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
    terrainMesh.name = 'gusev-terrain';
    scene.add(terrainMesh);
    terrainMeshRef.current = terrainMesh;
    terrainMatRef.current = terrainMat;

    const markersGroup = new THREE.Group();
    scene.add(markersGroup);
    markersGroupRef.current = markersGroup;

    const routeGroup = new THREE.Group();
    scene.add(routeGroup);
    routeGroupRef.current = routeGroup;

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let downPos = { x: 0, y: 0 };

    const onPointerDown = (e: MouseEvent) => {
      downPos = { x: e.clientX, y: e.clientY };
    };

    const onPointerUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const dx = Math.abs(e.clientX - downPos.x);
      const dy = Math.abs(e.clientY - downPos.y);
      if (dx > 5 || dy > 5) return;

      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);

      if (markersGroupRef.current) {
        const markerHits = raycaster.intersectObjects(markersGroupRef.current.children, true);
        if (markerHits.length > 0) {
          let obj: THREE.Object3D | null = markerHits[0].object;
          while (obj && !obj.userData?.id) {
            obj = obj.parent;
          }
          if (obj?.userData?.id) {
            selectRef.current(obj.userData.id);
            return;
          }
        }
      }

      if (terrainMeshRef.current) {
        const terrainHits = raycaster.intersectObject(terrainMeshRef.current);
        if (terrainHits.length > 0) {
          const hitPt = terrainHits[0].point;
          const coord = worldToLatLon(hitPt, boundsRef.current, dimsRef.current.terrainW, dimsRef.current.terrainD);
          pickRef.current(coord);
        }
      }
    };

    const dom = renderer.domElement;
    dom.addEventListener('pointerdown', onPointerDown);
    dom.addEventListener('pointerup', onPointerUp);

    let animationFrameId: number;
    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      if (sunAutoOrbitRef.current && sunLightRef.current) {
        sunAngleRef.current = (sunAngleRef.current + 0.35) % 360;
        updateSunPosition(sunAngleRef.current, sunLightRef.current, sunIndicatorRef.current);
      }
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const resizeObserver = new ResizeObserver(() => {
      if (!container) return;
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width <= 0 || height <= 0) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    });
    resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
      dom.removeEventListener('pointerdown', onPointerDown);
      dom.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      renderer.dispose();
      terrainGeo.dispose();
      terrainMat.dispose();
      sunGeo.dispose();
      sunMat.dispose();
      bumpTexture.dispose();
      normalTexture.dispose();
      displacementTexture.dispose();
      hillshadeTexture.dispose();
      layerTexture.dispose();
      gridHelper.dispose();
      scene.clear();
      terrainMeshRef.current = null;
      terrainMatRef.current = null;
      sunLightRef.current = null;
      sunIndicatorRef.current = null;
      shaderRef.current = null;
    };
  }, [terrainW, terrainD]);

  // 1b. Sun Position & Auto-Orbit
  useEffect(() => {
    sunAngleRef.current = sunAngle;
    sunAutoOrbitRef.current = sunAutoOrbit;
    if (sunLightRef.current) {
      updateSunPosition(sunAngle, sunLightRef.current, sunIndicatorRef.current);
    }
  }, [sunAngle, sunAutoOrbit]);

  // 1c. Topographical Shadow Strength
  useEffect(() => {
    shadowOpacityRef.current = shadowOpacity;
    if (shaderRef.current?.uniforms?.uHillshadeStrength) {
      shaderRef.current.uniforms.uHillshadeStrength.value = shadowOpacity;
    }
  }, [shadowOpacity]);

  // 2. Real-Time Layer Texture Swapping
  useEffect(() => {
    if (!terrainMatRef.current || !textureLoaderRef.current) return;
    const loader = textureLoaderRef.current;
    const material = terrainMatRef.current;

    loader.load(
      layerUrl,
      newTex => {
        newTex.colorSpace = THREE.SRGBColorSpace;
        newTex.generateMipmaps = true;
        newTex.minFilter = THREE.LinearMipmapLinearFilter;
        newTex.magFilter = THREE.LinearFilter;

        const oldTex = material.map;
        material.map = newTex;
        material.needsUpdate = true;
        if (oldTex && oldTex !== newTex) {
          oldTex.dispose();
        }
      },
      undefined,
      err => {
        console.warn('Error loading 3D texture:', layerUrl, err);
      }
    );
  }, [layerUrl]);

  // 3. Real-Time 3D Markers snapped onto DEM elevation
  useEffect(() => {
    const group = markersGroupRef.current;
    if (!group) return;

    while (group.children.length > 0) {
      const child = group.children[0] as THREE.Mesh;
      if (child.geometry) child.geometry.dispose();
      if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
      else if (child.material) child.material.dispose();
      group.remove(child);
    }

    points.forEach(p => {
      const isSelected = p.id === selectedId;
      const isLanding = p.kind === 'aterrizaje';
      const isWaypoint = p.kind === 'parada';
      const color = isLanding ? 0x76d7c4 : isWaypoint ? 0x65a7eb : 0xffc078;
      const basePos = lonLatToWorld(
        p.lon,
        p.lat,
        manifest.boundsLonLat,
        terrainW,
        terrainD,
        demGridRef.current,
        0
      );

      // Vertical beacon stem + sphere pin above terrain surface
      const stemGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.24, 8);
      const stemMat = new THREE.MeshBasicMaterial({ color });
      const stem = new THREE.Mesh(stemGeo, stemMat);
      stem.position.set(basePos.x, basePos.y + 0.12, basePos.z);
      stem.userData = { id: p.id };
      group.add(stem);

      const sphereGeo = new THREE.SphereGeometry(isSelected ? 0.11 : 0.085, 16, 16);
      const sphereMat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: isSelected ? 0.9 : 0.55,
        roughness: 0.25,
      });
      const pin = new THREE.Mesh(sphereGeo, sphereMat);
      pin.position.set(basePos.x, basePos.y + 0.26, basePos.z);
      pin.userData = { id: p.id };
      group.add(pin);

      if (isSelected) {
        const ringGeo = new THREE.RingGeometry(0.14, 0.19, 24);
        ringGeo.rotateX(-Math.PI / 2);
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.85,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.set(basePos.x, basePos.y + 0.025, basePos.z);
        group.add(ring);
      }
    });
  }, [points, selectedId, manifest.boundsLonLat, terrainW, terrainD, demVersion]);

  // 4. Real-Time 3D Route Tube conformed to Gusev DEM relief
  useEffect(() => {
    const group = routeGroupRef.current;
    if (!group) return;

    while (group.children.length > 0) {
      const child = group.children[0] as THREE.Mesh;
      if (child.geometry) child.geometry.dispose();
      if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
      else if (child.material) child.material.dispose();
      group.remove(child);
    }

    if (!routeCoordinates || routeCoordinates.length < 2) return;

    const stride = Math.max(1, Math.floor(routeCoordinates.length / 260));
    const sampled: THREE.Vector3[] = [];
    for (let i = 0; i < routeCoordinates.length; i += stride) {
      const [lon, lat] = routeCoordinates[i];
      sampled.push(lonLatToWorld(lon, lat, manifest.boundsLonLat, terrainW, terrainD, demGridRef.current, 0.045));
    }
    const [lastLon, lastLat] = routeCoordinates[routeCoordinates.length - 1];
    const lastVec = lonLatToWorld(lastLon, lastLat, manifest.boundsLonLat, terrainW, terrainD, demGridRef.current, 0.045);
    if (sampled[sampled.length - 1].distanceTo(lastVec) > 1e-4) {
      sampled.push(lastVec);
    }
    if (sampled.length < 2) return;

    const curve = new THREE.CatmullRomCurve3(sampled);
    const tubeGeo = new THREE.TubeGeometry(curve, Math.min(320, sampled.length * 2), 0.028, 6, false);
    const tubeMat = new THREE.MeshBasicMaterial({ color: 0xffd27c });
    group.add(new THREE.Mesh(tubeGeo, tubeMat));
  }, [routeCoordinates, manifest.boundsLonLat, terrainW, terrainD, demVersion]);

  return (
    <div
      ref={containerRef}
      className="mars-canvas"
      style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}
      aria-label="Relieve topográfico 3D interactivo de Spirit / Cráter Gusev en Three.js"
    />
  );
}

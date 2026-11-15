import { useEffect, useRef } from 'react';
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

const RADIUS = 4.0;

/**
 * Position the directional solar light and visual sun indicator along an orbital angle.
 */
function updateSunPosition(
  angleDeg: number,
  light: THREE.DirectionalLight,
  indicator?: THREE.Mesh | null
) {
  const rad = (angleDeg * Math.PI) / 180.0;
  const dist = 12.0;
  const x = Math.cos(rad) * dist;
  const y = Math.sin(rad * 0.5) * 2.5 + 2.2;
  const z = Math.sin(rad) * dist;
  light.position.set(x, y, z);
  if (indicator) {
    indicator.position.set(x * 0.52, y * 0.52, z * 0.52);
  }
}

/**
 * Convert lat/lon (degrees, [-90, 90] and [-180, 180]) to 3D Cartesian coordinates
 * exactly matching Three.js equirectangular UV mapping.
 */
function toPosition(lat: number, lon: number, radius = RADIUS): THREE.Vector3 {
  const u = (lon + 180.0) / 360.0;
  const v = (lat + 90.0) / 180.0;
  const phi = (1.0 - v) * Math.PI;
  const theta = u * 2.0 * Math.PI;

  const x = -radius * Math.cos(theta) * Math.sin(phi);
  const y = radius * Math.cos(phi);
  const z = radius * Math.sin(theta) * Math.sin(phi);

  return new THREE.Vector3(x, y, z);
}

/**
 * Inverse conversion: from 3D point on globe surface back to (lat, lon) in degrees.
 */
function toLatLon(point: THREE.Vector3): Coordinate {
  const r = point.length();
  const phi = Math.acos(Math.max(-1.0, Math.min(1.0, point.y / r)));
  const lat = 90.0 - (phi / Math.PI) * 180.0;

  const theta = Math.atan2(point.z, -point.x);
  const u = ((theta / (2.0 * Math.PI)) + 1.0) % 1.0;
  let lon = u * 360.0 - 180.0;

  return { lat, lon };
}

/**
 * Spherical linear interpolation (Slerp) along great circle path between two 3D positions.
 */
function interpolateGreatCircle(v0: THREE.Vector3, v1: THREE.Vector3, count = 12, heightOffset = 0.04): THREE.Vector3[] {
  const p0 = v0.clone().normalize();
  const p1 = v1.clone().normalize();
  const dot = Math.max(-1.0, Math.min(1.0, p0.dot(p1)));
  const omega = Math.acos(dot);
  const sinOmega = Math.sin(omega);

  if (sinOmega < 1e-6) {
    return [p0.multiplyScalar(RADIUS + heightOffset), p1.multiplyScalar(RADIUS + heightOffset)];
  }

  const result: THREE.Vector3[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const s0 = Math.sin((1.0 - t) * omega) / sinOmega;
    const s1 = Math.sin(t * omega) / sinOmega;
    const pt = new THREE.Vector3()
      .addScaledVector(p0, s0)
      .addScaledVector(p1, s1)
      .normalize()
      .multiplyScalar(RADIUS + heightOffset);
    result.push(pt);
  }
  return result;
}

export default function MarsGlobe({
  points,
  selectedId,
  onSelect,
  routeCoordinates,
  layerUrl = '/data/layers/combinada.png',
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

  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const marsMeshRef = useRef<THREE.Mesh | null>(null);
  const marsMaterialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const markersGroupRef = useRef<THREE.Group | null>(null);
  const routeGroupRef = useRef<THREE.Group | null>(null);
  const textureLoaderRef = useRef<THREE.TextureLoader | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const sunLightRef = useRef<THREE.DirectionalLight | null>(null);
  const sunIndicatorRef = useRef<THREE.Mesh | null>(null);
  const shaderRef = useRef<{ uniforms: Record<string, THREE.IUniform> } | null>(null);
  const sunAngleRef = useRef(sunAngle);
  const sunAutoOrbitRef = useRef(sunAutoOrbit);
  const shadowOpacityRef = useRef(shadowOpacity);

  // 1. Scene Initialization
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Renderer setup with ACES Filmic Tone Mapping to prevent plastic appearance
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
    });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    renderer.shadowMap.enabled = true;
    container.innerHTML = '';
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x060911);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / container.clientHeight,
      0.1,
      1000
    );
    camera.position.set(0, 3.2, 8.8);
    cameraRef.current = camera;

    // Controls (planet steady while solar focus orbits/moves)
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 4.3;
    controls.maxDistance = 25.0;
    controls.autoRotate = false;
    controlsRef.current = controls;

    // Martian Lighting: Movable high-contrast directional Sunlight + Soft ambient
    const sunLight = new THREE.DirectionalLight(0xfff5e4, 3.2);
    scene.add(sunLight);
    sunLightRef.current = sunLight;

    // Visual orbital Sun focus indicator
    const sunGeo = new THREE.SphereGeometry(0.18, 16, 16);
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xffdd99 });
    const sunIndicator = new THREE.Mesh(sunGeo, sunMat);
    scene.add(sunIndicator);
    sunIndicatorRef.current = sunIndicator;

    updateSunPosition(sunAngleRef.current, sunLight, sunIndicator);

    const ambientLight = new THREE.AmbientLight(0x241c1c, 0.28);
    scene.add(ambientLight);

    // Texture Loader
    const textureLoader = new THREE.TextureLoader();
    textureLoaderRef.current = textureLoader;

    // Bump & Tangent-Space Normal relief textures (HRSC + MOLA DEM)
    const bumpTexture = textureLoader.load('/data/mars_bump_2k.png');
    bumpTexture.colorSpace = THREE.LinearSRGBColorSpace;

    const normalTexture = textureLoader.load('/data/mars_normal_2k.png');
    normalTexture.colorSpace = THREE.NoColorSpace;

    const displacementTexture = textureLoader.load('/data/mars_elevation_2k.png');
    displacementTexture.colorSpace = THREE.NoColorSpace;

    // NASA HRSC + MOLA Hillshade shadow map texture: imparts real topographic shadows inside craters/chasms
    const hillshadeTexture = textureLoader.load('/data/mars_hillshade.png');
    hillshadeTexture.colorSpace = THREE.LinearSRGBColorSpace;

    // Initial surface / layer texture
    const layerTexture = textureLoader.load(layerUrl);
    layerTexture.colorSpace = THREE.SRGBColorSpace;
    layerTexture.generateMipmaps = true;
    layerTexture.minFilter = THREE.LinearMipmapLinearFilter;
    layerTexture.magFilter = THREE.LinearFilter;

    // High quality MeshStandardMaterial: matte regolith, completely removing "plastilina" look
    const marsMaterial = new THREE.MeshStandardMaterial({
      map: layerTexture,
      normalMap: normalTexture,
      normalScale: new THREE.Vector2(2.2, 2.2),
      bumpMap: bumpTexture,
      bumpScale: 0.05,
      displacementMap: displacementTexture,
      displacementScale: 0.08,
      displacementBias: -0.025,
      roughness: 0.88,
      metalness: 0.03,
      flatShading: false,
    });

    // Inject hillshade topographic crater shadow blending into shader with centered relief contrast
    marsMaterial.onBeforeCompile = shader => {
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
        float reliefFactor = clamp((hill.r - 0.78) * 1.85 + 0.92, 0.16, 1.18);
        diffuseColor.rgb *= mix(1.0, reliefFactor, uHillshadeStrength);
        `
      );
    };

    const marsGeometry = new THREE.SphereGeometry(RADIUS, 192, 96);
    const marsMesh = new THREE.Mesh(marsGeometry, marsMaterial);
    marsMesh.name = 'mars-globe';
    scene.add(marsMesh);
    marsMeshRef.current = marsMesh;
    marsMaterialRef.current = marsMaterial;

    // Mars Atmospheric Glow (thin reddish-orange Fresnel limb)
    const atmosGeometry = new THREE.SphereGeometry(RADIUS * 1.018, 64, 64);
    const atmosMaterial = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        void main() {
          float intensity = pow(0.68 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.8);
          gl_FragColor = vec4(0.85, 0.42, 0.25, 1.0) * intensity * 0.85;
        }
      `,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
    });
    scene.add(new THREE.Mesh(atmosGeometry, atmosMaterial));

    // Groups for dynamic overlays
    const markersGroup = new THREE.Group();
    scene.add(markersGroup);
    markersGroupRef.current = markersGroup;

    const routeGroup = new THREE.Group();
    scene.add(routeGroup);
    routeGroupRef.current = routeGroup;

    // Pointer event handling with drag detection
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let downPos = { x: 0, y: 0 };

    const onPointerDown = (e: MouseEvent) => {
      downPos = { x: e.clientX, y: e.clientY };
      controls.autoRotate = false; // User engaged with globe
    };

    const onPointerUp = (e: MouseEvent) => {
      const dx = Math.abs(e.clientX - downPos.x);
      const dy = Math.abs(e.clientY - downPos.y);
      if (dx > 5 || dy > 5) return; // Ignore drag operations

      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);

      // Check click on existing markers first
      if (markersGroupRef.current) {
        const markerHits = raycaster.intersectObjects(markersGroupRef.current.children, true);
        if (markerHits.length > 0) {
          const hit = markerHits[0];
          let obj: THREE.Object3D | null = hit.object;
          while (obj && !obj.userData?.id) {
            obj = obj.parent;
          }
          if (obj?.userData?.id) {
            selectRef.current(obj.userData.id);
            return;
          }
        }
      }

      // Check click on Mars Globe to pick coordinates
      if (marsMeshRef.current) {
        const globeHits = raycaster.intersectObject(marsMeshRef.current);
        if (globeHits.length > 0) {
          const point = globeHits[0].point;
          const coord = toLatLon(point);
          pickRef.current(coord);
        }
      }
    };

    const dom = renderer.domElement;
    dom.addEventListener('pointerdown', onPointerDown);
    dom.addEventListener('pointerup', onPointerUp);

    // Animation Render Loop
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

    // Responsive Resize Observer
    const resizeObserver = new ResizeObserver(() => {
      if (!container || !renderer || !camera) return;
      const width = container.clientWidth;
      const height = container.clientHeight;
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
      marsGeometry.dispose();
      marsMaterial.dispose();
      sunGeo.dispose();
      sunMat.dispose();
      bumpTexture.dispose();
      normalTexture.dispose();
      displacementTexture.dispose();
      hillshadeTexture.dispose();
      layerTexture.dispose();
      atmosGeometry.dispose();
      atmosMaterial.dispose();
      scene.clear();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      marsMeshRef.current = null;
      marsMaterialRef.current = null;
      sunLightRef.current = null;
      sunIndicatorRef.current = null;
      shaderRef.current = null;
    };
  }, []);

  // 1b. Update Sun Position & Auto-Orbit State
  useEffect(() => {
    sunAngleRef.current = sunAngle;
    sunAutoOrbitRef.current = sunAutoOrbit;
    if (sunLightRef.current) {
      updateSunPosition(sunAngle, sunLightRef.current, sunIndicatorRef.current);
    }
  }, [sunAngle, sunAutoOrbit]);

  // 1c. Update Topographical Shadow Mask Strength in Real Time
  useEffect(() => {
    shadowOpacityRef.current = shadowOpacity;
    if (shaderRef.current?.uniforms?.uHillshadeStrength) {
      shaderRef.current.uniforms.uHillshadeStrength.value = shadowOpacity;
    }
  }, [shadowOpacity]);

  // 2. Real-Time Layer Texture Swapping (zero-lag on checkbox toggle)
  useEffect(() => {
    if (!marsMaterialRef.current || !textureLoaderRef.current) return;
    const loader = textureLoaderRef.current;
    const material = marsMaterialRef.current;

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
        console.warn('Error loading dynamic texture:', layerUrl, err);
      }
    );
  }, [layerUrl]);

  // 3. Real-Time Interactive Markers (Origin & Destination)
  useEffect(() => {
    if (!markersGroupRef.current) return;
    const group = markersGroupRef.current;

    // Clear old markers
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
      const radius = isLanding ? 0.11 : isWaypoint ? 0.085 : 0.095;

      // Base marker sphere
      const geo = new THREE.SphereGeometry(radius * (isSelected ? 1.4 : 1.0), 16, 16);
      const mat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: isSelected ? 0.9 : 0.5,
        roughness: 0.2,
        metalness: 0.1,
      });

      const mesh = new THREE.Mesh(geo, mat);
      const pos = toPosition(p.lat, p.lon, RADIUS + 0.06);
      mesh.position.copy(pos);
      mesh.userData = { id: p.id };
      group.add(mesh);

      // Outer ring for selected marker
      if (isSelected) {
        const ringGeo = new THREE.RingGeometry(radius * 1.6, radius * 2.1, 24);
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.8,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.copy(toPosition(p.lat, p.lon, RADIUS + 0.08));
        ring.lookAt(new THREE.Vector3(0, 0, 0));
        group.add(ring);
      }
    });
  }, [points, selectedId]);

  // 4. Real-Time Geodesic Route Mesh Update
  useEffect(() => {
    if (!routeGroupRef.current) return;
    const group = routeGroupRef.current;

    while (group.children.length > 0) {
      const child = group.children[0] as THREE.Mesh;
      if (child.geometry) child.geometry.dispose();
      if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
      else if (child.material) child.material.dispose();
      group.remove(child);
    }

    if (!routeCoordinates || routeCoordinates.length < 2) return;

    // Collect slerp path coordinates along great circle segments
    const fullPath: THREE.Vector3[] = [];
    for (let i = 0; i < routeCoordinates.length - 1; i++) {
      const [lonA, latA] = routeCoordinates[i];
      const [lonB, latB] = routeCoordinates[i + 1];
      const seg = interpolateGreatCircle(toPosition(latA, lonA), toPosition(latB, lonB), 10, 0.04);
      fullPath.push(...(i === 0 ? seg : seg.slice(1)));
    }

    const routeGeo = new THREE.BufferGeometry().setFromPoints(fullPath);
    const routeMat = new THREE.LineBasicMaterial({
      color: 0xffd27c,
      linewidth: 3,
    });

    const routeLine = new THREE.Line(routeGeo, routeMat);
    group.add(routeLine);
  }, [routeCoordinates]);

  return (
    <div
      ref={containerRef}
      className="mars-canvas"
      style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}
      aria-label="Globo marciano tridimensional interactivo con relieve y sombras MOLA en Three.js"
    />
  );
}

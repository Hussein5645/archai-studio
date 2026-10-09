/**
 * The site concept editor's live 3D view: the massing (solids − voids, via Manifold), voids as
 * translucent volumes, the site boundary and the surrounding context buildings for scale.
 * Works in metres around the site centre so the camera never fights float precision.
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { geometryFromPositions, prismGeometry, type Form, type Plan } from './massing';
import styles from './SiteConcept.module.css';

export interface ContextSolid {
  profile: Plan;
  height: number;
}

interface Props {
  forms: Form[];
  boundary: Plan;
  context: ContextSolid[];
  /** Solid - void mesh from the massing worker; undefined while it is being computed. */
  massing: Float32Array | null | undefined;
  selectedId: string | null;
  /** Receives the built volume (m³) each time the massing is rebuilt. */
  onVolume?: (volume: number) => void;
}

interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  content: THREE.Group;
  render: () => void;
  framed: boolean;
}

function signedVolume(geometry: THREE.BufferGeometry): number {
  const p = geometry.getAttribute('position');
  let sum = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1);
    c.fromBufferAttribute(p, i + 2);
    sum += a.dot(b.clone().cross(c));
  }
  return sum / 6;
}

function dispose(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments || child instanceof THREE.Line) {
      child.geometry.dispose();
      const material = child.material as THREE.Material | THREE.Material[];
      for (const m of Array.isArray(material) ? material : [material]) m.dispose();
    }
  });
}

export function ConceptPreview({ forms, boundary, context, massing, selectedId, onVolume }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor('#eef1f5');
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight('#ffffff', '#b8bcc4', 1.6));
    const sun = new THREE.DirectionalLight('#ffffff', 1.6);
    sun.position.set(-60, 120, 80);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 20_000);
    camera.position.set(120, 110, 160);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    const content = new THREE.Group();
    scene.add(content);
    const render = () => renderer.render(scene, camera);
    controls.addEventListener('change', render);
    const resize = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width < 1 || height < 1) return;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    stage.current = { renderer, scene, camera, controls, content, render, framed: false };
    resize();
    return () => {
      observer.disconnect();
      controls.dispose();
      dispose(content);
      renderer.dispose();
      renderer.domElement.remove();
      stage.current = null;
    };
  }, []);

  useEffect(() => {
    const s = stage.current;
    if (!s) return;
    for (const child of [...s.content.children]) { s.content.remove(child); dispose(child); }
    // Centre on the site (or the forms) and work in metres.
    const all = boundary.length ? boundary : forms.flatMap((f) => f.profile);
    const cx = all.length ? (Math.min(...all.map((p) => p[0])) + Math.max(...all.map((p) => p[0]))) / 2 : 0;
    const cy = all.length ? (Math.min(...all.map((p) => p[1])) + Math.max(...all.map((p) => p[1]))) / 2 : 0;
    const frame = new THREE.Group();
    frame.scale.setScalar(0.001);
    frame.position.set(-cx * 0.001, 0, -cy * 0.001);
    s.content.add(frame);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(2000, 48), new THREE.MeshStandardMaterial({ color: '#e3e6ea', roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    s.content.add(ground);

    const edges = (geometry: THREE.BufferGeometry, colour: string, opacity = 1) =>
      new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 25), new THREE.LineBasicMaterial({ color: colour, transparent: opacity < 1, opacity }));

    for (const building of context) {
      if (building.profile.length < 3 || building.height <= 0) continue;
      const geometry = prismGeometry({ visible: true, profile: building.profile, meta: { kind: 'solid', start: 0, end: building.height } });
      if (!geometry) continue;
      frame.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#cfd3d9', roughness: 1, transparent: true, opacity: 0.55 })));
      frame.add(edges(geometry, '#9aa1ab', 0.6));
    }

    if (boundary.length >= 3) {
      const line = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(boundary.map(([x, y]) => new THREE.Vector3(x, 60, y))),
        new THREE.LineBasicMaterial({ color: '#2563eb' }),
      );
      frame.add(line);
    }

    let volume = 0;
    if (massing) {
      const geometry = geometryFromPositions(massing.slice());
      {
        frame.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#f4f1ea', roughness: 0.8, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })));
        frame.add(edges(geometry, '#3f3f46'));
        volume = signedVolume(geometry) / 1e9;
      }
    }
    for (const form of forms) {
      if (!form.visible) continue;
      const isVoid = form.meta.kind === 'void';
      // Voids stay visible as ghosts; without Manifold (still loading) solids show as plain prisms.
      if (!isVoid && massing !== undefined && form.id !== selectedId) continue;
      const geometry = prismGeometry(form);
      if (!geometry) continue;
      const colour = isVoid ? '#dc2626' : '#2563eb';
      if (isVoid || massing === undefined) frame.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: isVoid ? '#fca5a5' : '#f4f1ea', transparent: isVoid, opacity: isVoid ? 0.18 : 1, depthWrite: !isVoid })));
      frame.add(edges(geometry, form.id === selectedId ? '#2563eb' : colour, form.id === selectedId ? 1 : 0.7));
    }
    onVolume?.(volume);

    if (!s.framed && all.length) {
      const size = Math.max(...all.map((p) => p[0])) - Math.min(...all.map((p) => p[0])) + Math.max(...all.map((p) => p[1])) - Math.min(...all.map((p) => p[1]));
      const d = Math.max(40, (size / 1000) * 1.1);
      s.camera.position.set(-d * 0.7, d * 0.65, d * 0.9);
      s.controls.target.set(0, 0, 0);
      s.controls.update();
      s.framed = true;
    }
    s.render();
  }, [forms, boundary, context, massing, selectedId, onVolume]);

  return <div ref={host} className={styles.preview} aria-label="3D preview of the site concept" />;
}

/**
 * Live 3D preview of a material: a sphere, cube or wall panel lit like the realistic 3D view
 * (sun, sky light and studio reflections), with world-millimetre UVs so textures show at their
 * real size. Drag to turn the object.
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { ArchaiDocument, Material } from '@/document';
import { onMaterialTextures, threeMaterial } from '@/materials/three';
import { applyWorldUvs } from '@/view3d/surfaceUv';

export type PreviewShape = 'sphere' | 'cube' | 'wall';

function shapeGeometry(shape: PreviewShape): THREE.BufferGeometry {
  if (shape === 'sphere') return new THREE.SphereGeometry(700, 64, 32);
  if (shape === 'cube') return new THREE.BoxGeometry(1100, 1100, 1100);
  return new THREE.BoxGeometry(2400, 1500, 120);
}

export function MaterialPreview({ material, doc, shape }: { material: Material; doc: Pick<ArchaiDocument, 'blobs'>; shape: PreviewShape }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; pivot: THREE.Group; render: () => void } | null>(null);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    container.append(renderer.domElement);
    const scene = new THREE.Scene();
    const generator = new THREE.PMREMGenerator(renderer);
    scene.environment = generator.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.7;
    generator.dispose();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa0aa, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(3000, 4000, 2500);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(30, 1, 10, 50_000);
    camera.position.set(2600, 1600, 3400);
    camera.lookAt(0, 0, 0);
    const pivot = new THREE.Group();
    scene.add(pivot);
    const render = () => renderer.render(scene, camera);
    const fit = () => {
      const { width, height } = container.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    };
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    let drag: { x: number; y: number } | null = null;
    const down = (event: PointerEvent) => {
      drag = { x: event.clientX, y: event.clientY };
      renderer.domElement.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!drag) return;
      pivot.rotation.y += (event.clientX - drag.x) * 0.01;
      pivot.rotation.x = Math.max(-1.2, Math.min(1.2, pivot.rotation.x + (event.clientY - drag.y) * 0.01));
      drag = { x: event.clientX, y: event.clientY };
      render();
    };
    const up = () => {
      drag = null;
    };
    renderer.domElement.addEventListener('pointerdown', down);
    renderer.domElement.addEventListener('pointermove', move);
    renderer.domElement.addEventListener('pointerup', up);
    const unsubscribe = onMaterialTextures(render);
    view.current = { renderer, scene, camera, pivot, render };
    fit();
    return () => {
      unsubscribe();
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', down);
      renderer.domElement.removeEventListener('pointermove', move);
      renderer.domElement.removeEventListener('pointerup', up);
      scene.environment?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const current = view.current;
    if (!current) return;
    current.pivot.clear();
    const mesh = new THREE.Mesh(shapeGeometry(shape), threeMaterial(material, doc));
    current.pivot.add(mesh);
    // UVs in world mm, computed before the user turns it: the texture stays glued to the object.
    const rotation = current.pivot.rotation.clone();
    current.pivot.rotation.set(0, 0, 0);
    applyWorldUvs(current.pivot);
    current.pivot.rotation.copy(rotation);
    current.render();
  }, [material, doc, shape]);

  return <div ref={host} style={{ width: '100%', height: '100%', cursor: 'grab', touchAction: 'none' }} data-testid="material-preview" />;
}

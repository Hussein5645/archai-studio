import * as THREE from 'three';
import { expect, it } from 'vitest';
import { checkBrowserBakeMemory, prepareBakeGeometry } from './bakeGeometry';

it('allows more than one million triangles when memory permits and rejects excessive browser allocations', () => {
  expect(() => checkBrowserBakeMemory(1_100_000)).not.toThrow();
  expect(() => checkBrowserBakeMemory(10_000_000)).toThrow('memory budget');
});

it('keeps separately selectable element identities when elements share a material', () => {
  const scene = new THREE.Group();
  const material = new THREE.MeshStandardMaterial();
  for (const id of ['wall-a', 'wall-b']) {
    const group = new THREE.Group(); group.userData['archai'] = { id }; group.name = id;
    group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material)); scene.add(group);
  }
  const baked = prepareBakeGeometry(scene, 1, 1000);
  expect(baked.children.map((item) => item.userData['archai'].id).sort()).toEqual(['wall-a', 'wall-b']);
  baked.traverse((item) => { if (item instanceof THREE.Mesh) item.geometry.dispose(); });
  scene.traverse((item) => { if (item instanceof THREE.Mesh) item.geometry.dispose(); }); material.dispose();
});

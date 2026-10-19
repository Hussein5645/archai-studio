import { expect, it } from 'vitest';
import * as THREE from 'three';
import { previewTriangleTargets, sceneTriangles } from './largeScene';

it('shares low-detail triangles across many imported models instead of granting each a full budget', () => {
  const models = Array.from({ length: 66 }, (_, id) => ({ id: String(id), triangles: 70000, copies: 1 }));
  const targets = previewTriangleTargets(models);
  expect([...targets.values()].reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(350000);
  expect(targets.get('0')).toBeLessThan(6000);
});

it('accounts for repeated copies without reducing small documents unnecessarily', () => {
  expect(previewTriangleTargets([{ id: 'chair', triangles: 1000, copies: 2 }]).get('chair')).toBe(1000);
  const targets = previewTriangleTargets([{ id: 'chair', triangles: 10000, copies: 100 }]);
  expect(targets.get('chair')! * 100).toBeLessThanOrEqual(350000);
});

it('counts hardware-instanced geometry when estimating scene load', () => {
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.InstancedMesh(geometry, material, 100);
  expect(sceneTriangles(mesh)).toBe(1200);
  geometry.dispose(); material.dispose();
});

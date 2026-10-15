import * as THREE from 'three';
import { expect, it } from 'vitest';
import { inspectNormals, repairNormals } from './meshNormals';
it('detects inverted shading normals and repairs them without mutating source geometry', () => {
  const source = new THREE.PlaneGeometry();
  const normal = source.getAttribute('normal');
  for (let i = 0; i < normal.count; i++) normal.setXYZ(i, 0, 0, -1);
  expect(inspectNormals(new THREE.Mesh(source))).toContain('2 faces with normals opposing winding');
  const repaired = repairNormals(source, 'recompute');
  expect(repaired.getAttribute('normal').getZ(0)).toBe(1);
  expect(source.getAttribute('normal').getZ(0)).toBe(-1);
});
it('flips nonindexed faces preserving UVs and groups and reverses shading normals', () => {
  const source = new THREE.PlaneGeometry().toNonIndexed();
  const repaired = repairNormals(source, 'flip');
  expect(Array.from(repaired.index!.array)).toEqual([0, 2, 1, 3, 5, 4]);
  expect(repaired.getAttribute('normal').getZ(0)).toBe(-1);
  expect(Array.from(repaired.getAttribute('uv').array)).toEqual(Array.from(source.getAttribute('uv').array));
  expect(source.index).toBeNull();
});

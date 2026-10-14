import * as THREE from 'three';
import { expect, it } from 'vitest';
import { simplifyMesh, type SimplifyInput } from './simplifyMesh';

function input(geometry: THREE.BufferGeometry): SimplifyInput {
  const p = geometry.getAttribute('position');
  return {
    positions: Float32Array.from(p.array),
    indices: geometry.index
      ? Uint32Array.from(geometry.index.array)
      : Uint32Array.from({ length: p.count }, (_, i) => i),
    attributes: Object.entries(geometry.attributes)
      .filter(([name]) => name !== 'position')
      .map(([name, a]) => ({ name, size: a.itemSize, values: Float32Array.from(a.array) })),
    groups: [{ start: 0, count: geometry.index?.count ?? p.count, materialIndex: 2 }],
    ratio: 0.1,
    error: 0.01,
  };
}

it('reduces a dense non-indexed plane and compacts all attributes without changing the source', async () => {
  const geometry = new THREE.PlaneGeometry(10, 10, 100, 100).toNonIndexed();
  const source = Float32Array.from(geometry.getAttribute('position').array);
  const result = await simplifyMesh(input(geometry));
  expect(result.indices.length).toBeLessThanOrEqual(6000);
  expect(result.positions.length).toBeLessThan(source.length / 2);
  expect(geometry.getAttribute('position').array).toEqual(source);
  for (const attribute of result.attributes)
    expect(attribute.values.length / attribute.size).toBe(result.positions.length / 3);
  expect(Math.max(...result.indices)).toBeLessThan(result.positions.length / 3);
  expect(result.groups).toEqual([{ start: 0, count: result.indices.length, materialIndex: 2 }]);
  expect(Math.min(...result.positions.filter((_, i) => i % 3 === 0))).toBe(-5);
  expect(Math.max(...result.positions.filter((_, i) => i % 3 === 0))).toBe(5);
});

it('retains coincident vertices with different normals and preserves material groups', async () => {
  const geometry = new THREE.BoxGeometry();
  const data = input(geometry);
  data.groups = geometry.groups;
  data.ratio = 1;
  const result = await simplifyMesh(data);
  expect(result.indices.length).toBe(36);
  expect(result.positions.length / 3).toBe(24);
  expect(result.groups.map((g) => g.materialIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  const normals = result.attributes.find((a) => a.name === 'normal')!.values;
  expect(
    new Set(
      Array.from({ length: normals.length / 3 }, (_, i) =>
        Array.from(normals.slice(i * 3, i * 3 + 3)).join(','),
      ),
    ).size,
  ).toBe(6);
});

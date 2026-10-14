import * as THREE from 'three';
import { expect, it } from 'vitest';
import { isCanonicalShadowFace } from './bakeOcclusion';
import { traceBake } from './bakeTrace';

it('keeps one shadow winding per double-sided face with identical occlusion from either side', () => {
  const positions = new THREE.Float32BufferAttribute([-10, 1, -10, 10, 1, -10, 0, 1, 10], 3);
  expect(isCanonicalShadowFace(positions, 0, 1, 2)).not.toBe(
    isCanonicalShadowFace(positions, 2, 1, 0),
  );
  const triangle = Array.from(positions.array);
  const reverse = [...triangle.slice(6, 9), ...triangle.slice(3, 6), ...triangle.slice(0, 3)];
  const single = isCanonicalShadowFace(positions, 0, 1, 2) ? triangle : reverse;
  const input = {
    positions: new Float32Array([0, 0, 0, 0, 2, 0]),
    normals: new Float32Array([0, 1, 0, 0, -1, 0]),
    albedos: new Float32Array(6),
    emission: new Float32Array(6),
    sun: [0, 1, 0] as [number, number, number],
    sunIntensity: Math.PI,
    skyIntensity: 0,
    environment: null,
    samples: 1,
    bounces: 0,
  };
  const both = traceBake({ ...input, triangles: new Float32Array([...triangle, ...reverse]) });
  const reduced = traceBake({ ...input, triangles: new Float32Array(single) });
  expect(reduced).toEqual(both);
});

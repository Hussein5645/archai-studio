import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { edgesOf } from './edges';

describe('cached feature edges', () => {
  it('computes once per geometry and angle, shares them with clones, and frees them with the geometry', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const edges = edgesOf(mesh.geometry, 25);
    expect(edgesOf((mesh.clone() as THREE.Mesh).geometry, 25)).toBe(edges);
    expect(edgesOf(mesh.geometry, 28)).not.toBe(edges);
    const dispose = vi.spyOn(edges, 'dispose');
    mesh.geometry.dispose();
    expect(dispose).toHaveBeenCalled();
  });
});

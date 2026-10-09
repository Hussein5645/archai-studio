/**
 * Feature edges (hidden line style, section "beyond" lines, selection outlines, stills), cached
 * per geometry and angle. Model elements share their decoded geometry across clones, rebuilds and
 * views, so a 500k-triangle import computes its edges once instead of on every edit (seconds).
 *
 * The cached geometry belongs to the cache: callers never dispose it. It is disposed with its
 * source geometry.
 */
import * as THREE from 'three';

const cache = new WeakMap<THREE.BufferGeometry, Map<number, THREE.EdgesGeometry>>();

export function edgesOf(geometry: THREE.BufferGeometry, thresholdAngle: number): THREE.EdgesGeometry {
  let byAngle = cache.get(geometry);
  if (!byAngle) {
    const entries = new Map<number, THREE.EdgesGeometry>();
    byAngle = entries;
    cache.set(geometry, entries);
    geometry.addEventListener('dispose', () => {
      for (const edges of entries.values()) edges.dispose();
      cache.delete(geometry);
    });
  }
  let edges = byAngle.get(thresholdAngle);
  if (!edges) {
    edges = new THREE.EdgesGeometry(geometry, thresholdAngle);
    byAngle.set(thresholdAngle, edges);
  }
  return edges;
}

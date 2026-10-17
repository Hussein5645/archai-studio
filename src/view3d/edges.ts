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
const pending = new WeakMap<THREE.BufferGeometry, Promise<void>>();
let worker: Worker | null = null;
let nextId = 0;
type Result = { angle: number; positions: Float32Array };
const jobs = new Map<number, { resolve: (result: Result[]) => void; reject: (error: Error) => void }>();

/** Dense feature extraction runs off the UI thread; small procedural meshes stay synchronous. */
export async function prepareEdges(geometry: THREE.BufferGeometry, angles: number[]): Promise<void> {
  if (typeof Worker === 'undefined' || (geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0) < 60_000 || !angles.length) return;
  const previous = pending.get(geometry);
  if (previous) { await previous; return prepareEdges(geometry, angles); }
  const missing = angles.filter((angle) => !cache.get(geometry)?.has(angle));
  if (!missing.length) return;
  // Establish cache ownership/disposal without computing a feature map on the main thread.
  const byAngle = edgeCache(geometry);
  const job = (async () => {
    if (!worker) {
      worker = new Worker(new URL('./edges.worker.ts', import.meta.url), { type: 'module', name: 'mesh-edges' });
      worker.onmessage = (event: MessageEvent<{ id: number; results: Result[]; error?: string }>) => {
        const waiting = jobs.get(event.data.id);
        jobs.delete(event.data.id);
        if (event.data.error) waiting?.reject(new Error(event.data.error));
        else waiting?.resolve(event.data.results);
      };
      worker.onerror = () => {
        worker?.terminate(); worker = null;
        for (const waiting of jobs.values()) waiting.reject(new Error('Feature edge worker failed'));
        jobs.clear();
      };
    }
    const attribute = geometry.getAttribute('position');
    const positions = new Float32Array(attribute.count * 3);
    if (attribute instanceof THREE.BufferAttribute && attribute.itemSize === 3 && !attribute.normalized) positions.set(attribute.array);
    else for (let i = 0; i < attribute.count; i++) positions.set([attribute.getX(i), attribute.getY(i), attribute.getZ(i)], i * 3);
    const indices = geometry.index ? Uint32Array.from(geometry.index.array) : null;
    const id = ++nextId;
    const result = await new Promise<Result[]>((resolve, reject) => {
      jobs.set(id, { resolve, reject });
      try { worker!.postMessage({ id, positions, indices, angles: missing }, [positions.buffer, ...(indices ? [indices.buffer] : [])]); }
      catch (error) { jobs.delete(id); reject(error); }
    });
    if (cache.get(geometry) !== byAngle) return; // The view closed and disposed its geometry.
    for (const { angle, positions } of result) {
      const edges = new THREE.EdgesGeometry();
      edges.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      byAngle.set(angle, edges);
    }
  })().finally(() => pending.delete(geometry));
  pending.set(geometry, job);
  return job;
}

function edgeCache(geometry: THREE.BufferGeometry): Map<number, THREE.EdgesGeometry> {
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
  return byAngle;
}

export function edgesOf(geometry: THREE.BufferGeometry, thresholdAngle: number): THREE.EdgesGeometry {
  const byAngle = edgeCache(geometry);
  let edges = byAngle.get(thresholdAngle);
  if (!edges) {
    edges = new THREE.EdgesGeometry(geometry, thresholdAngle);
    byAngle.set(thresholdAngle, edges);
  }
  return edges;
}

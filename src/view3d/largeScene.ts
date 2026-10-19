import * as THREE from 'three';
import type { SimplifyInput } from './simplifyMesh';

export function sceneTriangles(root: THREE.Object3D): number {
  let count = 0;
  root.traverseVisible((object) => {
    if (object instanceof THREE.Mesh)
      count +=
        (object.geometry.index?.count ?? object.geometry.getAttribute('position')?.count ?? 0) / 3 * (object instanceof THREE.InstancedMesh ? object.count : 1);
  });
  return count;
}

/** Share a preview budget across the document, including repeated copies of a mesh. */
export function previewTriangleTargets(models: readonly { id: string; triangles: number; copies: number }[], budget = 350_000): Map<string, number> {
  const total = models.reduce((sum, model) => sum + model.triangles * model.copies, 0);
  const ratio = total > budget ? budget / total : 1;
  return new Map(models.map(model => [model.id, Math.min(model.triangles, Math.max(1, Math.floor(model.triangles * ratio)))]));
}

/** Detached preview geometry. Original geometry/materials remain owned by the document cache. */
export async function reduceLargeScene<T extends THREE.Object3D>(
  source: T,
  target: number,
  maxWorldError: number,
  signal?: AbortSignal,
  preserveUnusedUvs = true,
  previewMode = false,
): Promise<T> {
  const root = source.clone(true) as T;
  const count = sceneTriangles(root);
  if (count <= target) return root;
  root.updateWorldMatrix(true, true);
  const cache = new Map<THREE.BufferGeometry, Map<string, THREE.BufferGeometry>>();
  const worker = new Worker(new URL('./simplify.worker.ts', import.meta.url), { type: 'module' });
  const cancel = () => worker.terminate();
  signal?.addEventListener('abort', cancel, { once: true });
  const check = () => {
    if (signal?.aborted) throw new DOMException('Preparation cancelled', 'AbortError');
  };
  const meshes: THREE.Mesh[] = [];
  root.traverseVisible((object) => {
    if (object instanceof THREE.Mesh) meshes.push(object);
  });
  try {
    for (const mesh of meshes) {
      check();
      const geometry = mesh.geometry;
      if (
        mesh instanceof THREE.SkinnedMesh ||
        mesh instanceof THREE.InstancedMesh ||
        Object.keys(geometry.morphAttributes).length ||
        geometry.drawRange.count !== Infinity
      )
        continue;
      const scale = mesh.matrixWorld.getMaxScaleOnAxis();
      const error = maxWorldError / Math.max(scale, 1e-12);
      const protectUv =
        preserveUnusedUvs ||
        (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some((material) =>
          Object.values(material).some((value) => value instanceof THREE.Texture),
        );
      const key = `${error}:${protectUv}`;
      const cached = cache.get(geometry)?.get(key);
      if (cached) {
        mesh.geometry = cached;
        if (!cached.index?.count) mesh.removeFromParent();
        continue;
      }
      const position = geometry.getAttribute('position');
      if (!position || position.count < 30) continue;
      const read = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) => {
        const values = new Float32Array(attribute.count * attribute.itemSize);
        for (let i = 0; i < attribute.count; i++)
          for (let c = 0; c < attribute.itemSize; c++)
            values[i * attribute.itemSize + c] = attribute.getComponent(i, c);
        return values;
      };
      const input: SimplifyInput = {
        positions: read(position),
        indices: geometry.index
          ? Uint32Array.from(geometry.index.array)
          : Uint32Array.from({ length: position.count }, (_, i) => i),
        attributes: Object.entries(geometry.attributes)
          .filter(([name]) => name !== 'position')
          .map(([name, a]) => ({ name, size: a.itemSize, values: read(a) })),
        groups: geometry.groups.length
          ? geometry.groups
          : [{ start: 0, count: geometry.index?.count ?? position.count, materialIndex: 0 }],
        ratio: target / count,
        error,
        protectUv,
        allowTopologyReduction: previewMode,
      };
      const result = await new Promise<SimplifyInput>((resolve, reject) => {
        const abort = () => reject(new DOMException('Preparation cancelled', 'AbortError'));
        const cleanup = () => signal?.removeEventListener('abort', abort);
        signal?.addEventListener('abort', abort, { once: true });
        worker.onmessage = (event: MessageEvent<{ result: SimplifyInput; error?: string }>) => {
          cleanup();
          if (event.data.error) reject(new Error(event.data.error));
          else resolve(event.data.result);
        };
        worker.onerror = (event) => {
          cleanup();
          reject(new Error(event.message));
        };
        worker.postMessage(input, [
          input.positions.buffer,
          input.indices.buffer,
          ...input.attributes.map((a) => a.values.buffer),
        ]);
        if (signal?.aborted) abort();
      });
      const reduced = new THREE.BufferGeometry();
      reduced.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
      for (const a of result.attributes)
        reduced.setAttribute(a.name, new THREE.BufferAttribute(a.values, a.size));
      reduced.setIndex(new THREE.BufferAttribute(result.indices, 1));
      for (const group of result.groups)
        reduced.addGroup(group.start, group.count, group.materialIndex);
      if (result.indices.length) {
        reduced.computeBoundingBox();
        reduced.computeBoundingSphere();
      }
      const variants = cache.get(geometry) ?? new Map<string, THREE.BufferGeometry>();
      variants.set(key, reduced);
      cache.set(geometry, variants);
      mesh.geometry = reduced;
      if (!result.indices.length) mesh.removeFromParent();
    }
    check();
    return root;
  } catch (error) {
    for (const variants of cache.values())
      for (const geometry of variants.values()) geometry.dispose();
    throw error;
  } finally {
    worker.terminate();
    signal?.removeEventListener('abort', cancel);
  }
}

export function disposeReducedScene(root: THREE.Object3D, source: THREE.Object3D): void {
  const originals = new Set<THREE.BufferGeometry>();
  source.traverse((object) => {
    if (object instanceof THREE.Mesh) originals.add(object.geometry);
  });
  const disposed = new Set<THREE.BufferGeometry>();
  root.traverse((object) => {
    if (
      object instanceof THREE.Mesh &&
      !originals.has(object.geometry) &&
      !disposed.has(object.geometry)
    ) {
      object.geometry.dispose();
      disposed.add(object.geometry);
    }
  });
}

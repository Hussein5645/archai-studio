/**
 * Converts an evaluated solid into GL-ready arrays: positions, angle-smoothed normals, indices,
 * per-triangle face ids and the triangle runs per feature. Manifold splits vertices along sharp
 * edges itself (`calculateNormals` with the sharp angle), so cylinders come out round and boxes
 * crisp (docs/modeling-tools.md §7.1). No three.js here: this runs in the worker.
 */
import type { Evaluated } from './evaluate';
import { SMOOTH_ANGLE, type FeatureRun, type MeshData, type Vec3 } from './types';

export function meshOf(evaluated: Evaluated, smoothAngle = SMOOTH_ANGLE): MeshData {
  const { manifold, originals } = evaluated;
  const smoothed = manifold.calculateNormals(0, smoothAngle);
  try {
    const mesh = smoothed.getMesh();
    const stride = mesh.numProp;
    const count = mesh.vertProperties.length / stride;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const at = i * stride;
      positions[i * 3] = mesh.vertProperties[at]!;
      positions[i * 3 + 1] = mesh.vertProperties[at + 1]!;
      positions[i * 3 + 2] = mesh.vertProperties[at + 2]!;
      // Channels 3–5 hold the normals when they were calculated; a flat mesh gets none.
      if (stride >= 6) {
        normals[i * 3] = mesh.vertProperties[at + 3]!;
        normals[i * 3 + 1] = mesh.vertProperties[at + 4]!;
        normals[i * 3 + 2] = mesh.vertProperties[at + 5]!;
      }
    }
    const indices = new Uint32Array(mesh.triVerts);
    const triangles = mesh.numTri;
    const faceIds = mesh.faceID.length === triangles ? new Uint32Array(mesh.faceID) : new Uint32Array(triangles);
    const runs: FeatureRun[] = [];
    for (let r = 0; r < mesh.runOriginalID.length; r++) {
      const start = mesh.runIndex[r]!;
      const end = mesh.runIndex[r + 1] ?? indices.length;
      runs.push({ start, count: end - start, featureId: originals.get(mesh.runOriginalID[r]!) ?? '' });
    }
    const box = manifold.boundingBox();
    return {
      positions,
      normals,
      indices,
      faceIds,
      runs,
      groups: [{ start: 0, count: indices.length, material: null }],
      triangles,
      volume: manifold.volume(),
      bounds: { min: [...box.min] as Vec3, max: [...box.max] as Vec3 },
    };
  } finally {
    smoothed.delete();
  }
}

/** The buffers to hand over with `postMessage` so the worker does not copy them. */
export function transferables(mesh: MeshData): ArrayBuffer[] {
  return [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, mesh.faceIds.buffer] as ArrayBuffer[];
}

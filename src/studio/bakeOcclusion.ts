import type * as THREE from 'three';

/** A double-sided bake has both windings; the shadow BVH already tests either side. */
export function isCanonicalShadowFace(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  a: number,
  b: number,
  c: number,
): boolean {
  const ux = position.getX(b) - position.getX(a),
    uy = position.getY(b) - position.getY(a),
    uz = position.getZ(b) - position.getZ(a);
  const vx = position.getX(c) - position.getX(a),
    vy = position.getY(c) - position.getY(a),
    vz = position.getZ(c) - position.getZ(a);
  const nx = uy * vz - uz * vy,
    ny = uz * vx - ux * vz,
    nz = ux * vy - uy * vx;
  return (nx !== 0 ? nx : ny !== 0 ? ny : nz) > 0;
}

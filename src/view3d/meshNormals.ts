import * as THREE from 'three';

export type NormalMode = 'source' | 'recompute' | 'flip' | 'recompute-flip';

/** Checks shading normals against triangle winding; outward direction needs visual review. */
export function inspectNormals(root: THREE.Object3D): string {
  let missing = 0, invalid = 0, opposed = 0, degenerate = 0, triangles = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), corner = new THREE.Vector3(), face = new THREE.Vector3();
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const g = child.geometry, p = g.getAttribute('position'), normal = g.getAttribute('normal');
    if (!p) return;
    if (!normal) missing++;
    for (let i = 0; i < (g.index?.count ?? p.count); i += 3) {
      const ids = [0, 1, 2].map((j) => g.index?.getX(i + j) ?? i + j);
      a.fromBufferAttribute(p, ids[0]!); b.fromBufferAttribute(p, ids[1]!); c.fromBufferAttribute(p, ids[2]!);
      face.crossVectors(b.sub(a), c.sub(a));
      triangles++;
      if (face.lengthSq() < 1e-20) { degenerate++; continue; }
      if (!normal) continue;
      n.set(0, 0, 0);
      for (const id of ids) {
        const x = normal.getX(id), y = normal.getY(id), z = normal.getZ(id);
        if (!Number.isFinite(x + y + z) || x * x + y * y + z * z < 1e-12) invalid++;
        n.add(corner.set(x, y, z));
      }
      if (face.dot(n) < 0) opposed++;
    }
  });
  return `${triangles.toLocaleString()} triangles; ${missing} meshes missing normals; ${invalid} invalid normal corners; ${opposed} faces with normals opposing winding; ${degenerate} degenerate faces. Outward direction cannot be inferred for open surfaces: visually check before flipping.`;
}

/** Work on a clone: cached source geometry and other instances must remain intact. */
export function repairNormals(source: THREE.BufferGeometry, mode: NormalMode): THREE.BufferGeometry {
  const g = source.clone();
  if (mode === 'flip' || mode === 'recompute-flip') {
    const count = g.index?.count ?? g.getAttribute('position').count;
    const index = Array.from({ length: count }, (_, i) => g.index?.getX(i) ?? i);
    for (let i = 0; i < count; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2]!, index[i + 1]!];
    g.setIndex(index);
    const n = g.getAttribute('normal');
    if (n) { for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i)); n.needsUpdate = true; }
    g.deleteAttribute('tangent');
  }
  if (mode === 'recompute' || mode === 'recompute-flip' || !g.getAttribute('normal')) {
    g.computeVertexNormals();
    g.deleteAttribute('tangent');
  }
  return g;
}

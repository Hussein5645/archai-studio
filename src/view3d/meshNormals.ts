import * as THREE from 'three';

export type NormalMode = 'source' | 'auto' | 'recompute' | 'flip' | 'recompute-flip';

/** Orient connected triangles across position seams, then turn closed shells outward.
 * UV/material seams remain separate vertices; only the triangle index order changes.
 * Open components choose the orientation requiring the fewest source-face flips.
 */
export function autoOrientNormals(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = source.clone(), p = g.getAttribute('position');
  if (!p) return g;
  const index = Array.from({ length: g.index?.count ?? p.count }, (_, i) => g.index?.getX(i) ?? i);
  const count = Math.floor(index.length / 3);
  g.computeBoundingBox();
  const box = g.boundingBox!;
  const size = box.getSize(new THREE.Vector3());
  const epsilon = Math.max(size.x, size.y, size.z, 1e-3) * 1e-8;
  const welded = new Int32Array(p.count), vertices = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const key = `${Math.round((p.getX(i) - box.min.x) / epsilon)},${Math.round((p.getY(i) - box.min.y) / epsilon)},${Math.round((p.getZ(i) - box.min.z) / epsilon)}`;
    let id = vertices.get(key);
    if (id === undefined) { id = vertices.size; vertices.set(key, id); }
    welded[i] = id;
  }
  type Edge = { face: number; forward: boolean };
  const edges = new Map<string, Edge[]>();
  const faceEdges = (face: number) => {
    const ids = [0, 1, 2].map((i) => welded[index[face * 3 + i]!]!);
    return ids.map((a, i) => { const b = ids[(i + 1) % 3]!; return { key: `${Math.min(a, b)}/${Math.max(a, b)}`, forward: a < b, degenerate: a === b }; });
  };
  for (let face = 0; face < count; face++) for (const e of faceEdges(face)) {
    if (e.degenerate) continue;
    const list = edges.get(e.key) ?? [];
    // Three entries already prove a non-manifold edge; do not grow pathological buckets.
    if (list.length < 3) list.push({ face, forward: e.forward });
    edges.set(e.key, list);
  }
  const flips = new Int8Array(count).fill(-1);
  const origin = box.getCenter(new THREE.Vector3());
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let closedShells = 0, ambiguousShells = 0, flippedFaces = 0;
  for (let seed = 0; seed < count; seed++) {
    if (flips[seed] !== -1) continue;
    const queue = [seed]; flips[seed] = 0;
    let closed = true, conflict = false, inverted = 0;
    for (let q = 0; q < queue.length; q++) {
      const face = queue[q]!;
      inverted += flips[face]!;
      for (const e of faceEdges(face)) {
        const neighbors = edges.get(e.key);
        if (e.degenerate || neighbors?.length !== 2 || neighbors[0]!.face === neighbors[1]!.face) { closed = false; continue; }
        const other = neighbors.find((n) => n.face !== face)!;
        const want = flips[face]! ^ Number(e.forward === other.forward);
        if (flips[other.face] === -1) { flips[other.face] = want; queue.push(other.face); }
        else if (flips[other.face] !== want) conflict = true;
      }
    }
    let reverse = inverted > queue.length / 2;
    if (closed && !conflict) {
      origin.fromBufferAttribute(p, index[seed * 3]!);
      let volume = 0;
      for (const face of queue) {
        a.fromBufferAttribute(p, index[face * 3]!).sub(origin);
        b.fromBufferAttribute(p, index[face * 3 + 1]!).sub(origin);
        c.fromBufferAttribute(p, index[face * 3 + 2]!).sub(origin);
        volume += a.dot(b.cross(c)) * (flips[face] ? -1 : 1);
      }
      if (Math.abs(volume) > epsilon ** 3 && Number.isFinite(volume)) { reverse = volume < 0; closedShells++; }
      else ambiguousShells++;
    } else ambiguousShells++;
    for (const face of queue) {
      // Contradictory topology has no consistent solution. Preserve its source winding.
      if (conflict || !(flips[face]! ^ Number(reverse))) continue;
      const i = face * 3;
      [index[i + 1], index[i + 2]] = [index[i + 2]!, index[i + 1]!];
      flippedFaces++;
    }
  }
  g.setIndex(index);
  g.computeVertexNormals();
  g.deleteAttribute('tangent');
  g.userData.normalRepair = { closedShells, ambiguousShells, flippedFaces };
  return g;
}

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
  if (mode === 'auto') return autoOrientNormals(source);
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

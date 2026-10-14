import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { applyStaticTransform } from '@/view3d/staticGeometry';

type Vertex = { p: THREE.Vector3; n: THREE.Vector3; uv: THREE.Vector2; c: THREE.Color };
const midpoint = (a: Vertex, b: Vertex): Vertex => ({
  p: a.p.clone().lerp(b.p, 0.5),
  n: a.n.clone().lerp(b.n, 0.5).normalize(),
  uv: a.uv.clone().lerp(b.uv, 0.5),
  c: a.c.clone().lerp(b.c, 0.5),
});

/** Detached, world-space meshes: preserves source UVs, material groups and vertex colours. */
export function prepareBakeGeometry(
  root: THREE.Object3D,
  edge: number,
  triangleBudget: number,
): THREE.Group {
  root.updateWorldMatrix(true, true);
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  let originalTriangles = 0;
  root.traverseVisible((object) => {
    if (object instanceof THREE.Mesh)
      originalTriangles +=
        (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3;
  });
  if (originalTriangles > 1_000_000)
    throw new Error(
      'This scene exceeds one million triangles. Reduce model detail before baking for VR.',
    );
  let remaining = Math.max(0, triangleBudget - originalTriangles);
  root.traverseVisible((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry.index
      ? object.geometry.toNonIndexed()
      : object.geometry.clone();
    applyStaticTransform(geometry, object.matrixWorld);
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    const color = geometry.getAttribute('color');
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const groups = geometry.groups.length
      ? geometry.groups
      : [{ start: 0, count: position.count, materialIndex: 0 }];
    const read = (i: number): Vertex => ({
      p: new THREE.Vector3().fromBufferAttribute(position, i),
      n: new THREE.Vector3().fromBufferAttribute(normal, i).normalize(),
      uv: uv ? new THREE.Vector2().fromBufferAttribute(uv, i) : new THREE.Vector2(),
      c:
        color && materials.some((m) => m.vertexColors)
          ? new THREE.Color(color.getX(i), color.getY(i), color.getZ(i))
          : new THREE.Color(1, 1, 1),
    });
    for (const group of groups) {
      const material = materials[group.materialIndex ?? 0];
      if (!material) continue;
      const p: number[] = [],
        n: number[] = [],
        u: number[] = [],
        c: number[] = [];
      const write = (a: Vertex, b: Vertex, d: Vertex, depth: number) => {
        const lengths = [
          a.p.distanceToSquared(b.p),
          b.p.distanceToSquared(d.p),
          d.p.distanceToSquared(a.p),
        ];
        const longest = Math.max(...lengths);
        if (remaining > 0 && depth < 8 && longest > edge * edge) {
          remaining--;
          if (longest === lengths[0]) {
            const m = midpoint(a, b);
            write(a, m, d, depth + 1);
            write(m, b, d, depth + 1);
          } else if (longest === lengths[1]) {
            const m = midpoint(b, d);
            write(a, b, m, depth + 1);
            write(a, m, d, depth + 1);
          } else {
            const m = midpoint(d, a);
            write(a, b, m, depth + 1);
            write(m, b, d, depth + 1);
          }
          return;
        }
        for (const v of [a, b, d]) {
          p.push(v.p.x, v.p.y, v.p.z);
          n.push(v.n.x, v.n.y, v.n.z);
          u.push(v.uv.x, v.uv.y);
          c.push(v.c.r, v.c.g, v.c.b);
        }
      };
      const end = Math.min(position.count, group.start + group.count);
      for (let i = group.start; i + 2 < end; i += 3) write(read(i), read(i + 1), read(i + 2), 0);
      if (!p.length) continue;
      const piece = new THREE.BufferGeometry();
      piece.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      piece.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
      piece.setAttribute('uv', new THREE.Float32BufferAttribute(u, 2));
      piece.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
      buckets.set(material, [...(buckets.get(material) ?? []), piece]);
    }
    geometry.dispose();
  });
  const output = new THREE.Group();
  for (const [material, pieces] of buckets) {
    const merged = mergeGeometries(pieces, false)!;
    const geometry = mergeVertices(merged, 0.00001);
    merged.dispose();
    for (const piece of pieces) piece.dispose();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = material.name || 'Baked surface';
    output.add(mesh);
  }
  return output;
}

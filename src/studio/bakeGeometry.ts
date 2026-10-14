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
  let outputTriangles = 0;
  root.traverseVisible((object) => {
    if (object instanceof THREE.Mesh) {
      const count =
        (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3;
      originalTriangles += count;
      outputTriangles +=
        count *
        ((Array.isArray(object.material) ? object.material : [object.material]).some(
          (m) => m.side === THREE.DoubleSide,
        )
          ? 2
          : 1);
    }
  });
  if (originalTriangles > 1_000_000)
    throw new Error(
      'This scene still exceeds one million triangles after safe reduction. Split the project into smaller VR areas or use a panorama tour.',
    );
  let remaining = Math.max(0, triangleBudget - outputTriangles);
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
      const twoSided = material.side === THREE.DoubleSide;
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
        if (remaining >= (twoSided ? 2 : 1) && depth < 8 && longest > edge * edge) {
          remaining -= twoSided ? 2 : 1;
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
        // A double-sided import may have inward winding (Revit terrain/roofs).
        // Each visible side needs its own lighting, not one interpolated colour
        // sampled on the underside and then displayed from both directions.
        if (twoSided)
          for (const v of [d, b, a]) {
            p.push(v.p.x, v.p.y, v.p.z);
            n.push(-v.n.x, -v.n.y, -v.n.z);
            u.push(v.uv.x, v.uv.y);
            c.push(v.c.r, v.c.g, v.c.b);
          }
      };
      const end = Math.min(position.count, group.start + group.count);
      for (let i = group.start; i + 2 < end; i += 3) {
        const a = read(i),
          b = read(i + 1),
          d = read(i + 2);
        if ((material as THREE.MeshStandardMaterial).flatShading) {
          const face = b.p.clone().sub(a.p).cross(d.p.clone().sub(a.p)).normalize();
          a.n.copy(face);
          b.n.copy(face);
          d.n.copy(face);
        }
        write(a, b, d, 0);
      }
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
    // Some imports already contain both windings of a two-sided face. Adding
    // independently lit sides must not leave coincident front faces that z-fight.
    const index = geometry.index!;
    const seen = new Set<string>();
    const unique: number[] = [];
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i),
        b = index.getX(i + 1),
        c = index.getX(i + 2);
      const key = [a, b, c].sort((x, y) => x - y).join(',');
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(a, b, c);
      }
    }
    geometry.setIndex(unique);
    for (const piece of pieces) piece.dispose();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = material.name || 'Baked surface';
    output.add(mesh);
  }
  return output;
}

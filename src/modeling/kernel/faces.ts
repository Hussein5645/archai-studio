/**
 * Faces of an evaluated mesh: Manifold tags every triangle with a coplanar face id, so a face
 * is the set of triangles sharing one. This finds a face's plane and its boundary loops (outer
 * outline and holes) so push/pull can sketch on it. Pure TypeScript over `MeshData`.
 */
import { cross, dot, normalize } from './sketch';
import type { MeshData, SketchPlane, Vec2, Vec3 } from './types';

export interface FaceOutline {
  /** Face id as in `MeshData.faceIds`. */
  faceId: number;
  /** A point on the face (the centroid of its triangles). */
  origin: Vec3;
  /** Outward normal. */
  normal: Vec3;
  /** A direction in the face used as sketch +u. */
  xAxis: Vec3;
  /** Boundary loops in sketch coordinates of the face plane; the largest is the outline, others are holes. */
  loops: Vec2[][];
  /** mm² */
  area: number;
}

function key(p: Vec3): string {
  return `${Math.round(p[0] * 1e4)}|${Math.round(p[1] * 1e4)}|${Math.round(p[2] * 1e4)}`;
}

/**
 * Rounds to 0.1 µm: float noise in the projected outline would otherwise leave hair-thin skins
 * when the outline is extruded back into the body (a cut 6e-14 mm narrower than the face).
 */
function tidy(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/** The face containing triangle `triangle`, or null when the mesh has no such triangle. */
export function faceOfTriangle(mesh: MeshData, triangle: number): number | null {
  return triangle >= 0 && triangle < mesh.triangles ? (mesh.faceIds[triangle] ?? null) : null;
}

/** The plane and boundary loops of a face, in the mesh's own (body-local) coordinates. */
export function faceOutline(mesh: MeshData, faceId: number): FaceOutline | null {
  const { positions, indices, faceIds } = mesh;
  const vertex = (index: number): Vec3 => [positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!];
  const triangles: number[] = [];
  for (let t = 0; t < mesh.triangles; t++) if (faceIds[t] === faceId) triangles.push(t);
  if (triangles.length === 0) return null;

  // Normal and centroid: area-weighted over the face's triangles.
  let normal: Vec3 = [0, 0, 0];
  let centroid: Vec3 = [0, 0, 0];
  let area = 0;
  const edges = new Map<string, { from: Vec3; to: Vec3 }>();
  for (const t of triangles) {
    const a = vertex(indices[t * 3]!);
    const b = vertex(indices[t * 3 + 1]!);
    const c = vertex(indices[t * 3 + 2]!);
    const n = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
    const weight = Math.hypot(n[0], n[1], n[2]) / 2;
    normal = [normal[0] + n[0], normal[1] + n[1], normal[2] + n[2]];
    centroid = [centroid[0] + ((a[0] + b[0] + c[0]) / 3) * weight, centroid[1] + ((a[1] + b[1] + c[1]) / 3) * weight, centroid[2] + ((a[2] + b[2] + c[2]) / 3) * weight];
    area += weight;
    // Directed edges by position, so split vertices along the outline still match.
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ] as [Vec3, Vec3][]) {
      edges.set(`${key(from)}>${key(to)}`, { from, to });
    }
  }
  if (area < 1e-9) return null;
  normal = normalize(normal);
  centroid = [centroid[0] / area, centroid[1] / area, centroid[2] / area];

  // Boundary edges are those whose reverse is not part of the face.
  const boundaryEdges: Array<{ from: Vec3; to: Vec3 }> = [];
  for (const edge of edges.values()) {
    const reverse = `${key(edge.to)}>${key(edge.from)}`;
    if (!edges.has(reverse)) boundaryEdges.push(edge);
  }
  if (boundaryEdges.length < 3) return null;

  // Chain the boundary into loops and project them onto the face plane.
  const first = boundaryEdges[0]!;
  const xAxis = normalize([first.to[0] - first.from[0], first.to[1] - first.from[1], first.to[2] - first.from[2]]);
  const yAxis = cross(normal, xAxis);
  const project = (p: Vec3): Vec2 => {
    const d: Vec3 = [p[0] - centroid[0], p[1] - centroid[1], p[2] - centroid[2]];
    return [tidy(dot(d, xAxis)), tidy(dot(d, yAxis))];
  };
  const loops: Vec2[][] = [];
  const remaining = new Set(boundaryEdges);
  while (remaining.size > 0) {
    const startEdge = remaining.values().next().value!;
    remaining.delete(startEdge);
    const loop: Vec2[] = [project(startEdge.from)];
    let current = key(startEdge.to);
    const startKey = key(startEdge.from);
    while (current !== startKey) {
      let nextEdge: { from: Vec3; to: Vec3 } | null = null;
      for (const edge of remaining) {
        if (key(edge.from) === current) {
          nextEdge = edge;
          break;
        }
      }
      if (!nextEdge) break;
      remaining.delete(nextEdge);
      loop.push(project(nextEdge.from));
      current = key(nextEdge.to);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  if (loops.length === 0) return null;
  // The axes stay exact (rounding them would tilt the plane of a slanted face); the loops and the
  // origin are rounded, which is what makes an axis-aligned outline land exactly on the face.
  return { faceId, origin: centroid.map(tidy) as Vec3, normal, xAxis, loops, area };
}

/** Applies a body placement to a face outline so its plane can become a world-space sketch plane. */
export function facePlane(outline: FaceOutline, placement: { position: Vec3; rotation: Vec3 }): SketchPlane {
  const rotate = (v: Vec3): Vec3 => {
    // World X, then Y, then Z, matching the kernel's placement convention.
    let [x, y, z] = v;
    const [rx, ry, rz] = placement.rotation.map((deg) => (deg * Math.PI) / 180) as Vec3;
    [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
    [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
    [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
    return [x, y, z];
  };
  const origin = rotate(outline.origin);
  return {
    kind: 'custom',
    origin: [origin[0] + placement.position[0], origin[1] + placement.position[1], origin[2] + placement.position[2]],
    normal: rotate(outline.normal),
    xAxis: rotate(outline.xAxis),
  };
}

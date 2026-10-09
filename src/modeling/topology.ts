/**
 * Vertex / edge / face picking on rendered meshes: modeled bodies and the locked project
 * reference alike. Edges are the mesh's feature edges (creases, not triangulation diagonals),
 * vertices are their ends, and a face is the connected run of coplanar triangles under the
 * pointer. Everything is measured in screen pixels so a vertex is as easy to hit zoomed in as
 * zoomed out. Results are in world coordinates; nothing here touches the store.
 */
import * as THREE from 'three';
import type { Vec3 } from './kernel/types';

/** A modeled body, an imported layer of this asset, or the locked project reference. */
export type TopologySource = { kind: 'project' } | { kind: 'body'; bodyId: string } | { kind: 'layer' };

export type TopologyHit =
  | { kind: 'vertex'; source: TopologySource; point: Vec3 }
  | { kind: 'edge'; source: TopologySource; a: Vec3; b: Vec3; point: Vec3 }
  | { kind: 'face'; source: TopologySource; point: Vec3; normal: Vec3; triangles: number[]; area: number };

export interface PickTarget {
  mesh: THREE.Mesh;
  source: TopologySource;
}

export interface PickView {
  camera: THREE.Camera;
  /** The pane's box in client pixels. */
  rect: { left: number; top: number; width: number; height: number };
  clientX: number;
  clientY: number;
}

export interface PickOptions {
  /** Screen radius for vertices (px). */
  vertexPx?: number;
  /** Screen radius for edges (px). */
  edgePx?: number;
  /** Fall back to the face under the pointer. */
  faces?: boolean;
}

interface MeshTopology {
  /** Feature edges as pairs of local points (6 numbers each). */
  edges: Float32Array;
  /** Unique feature-edge ends (3 numbers each). */
  vertices: Float32Array;
  /** Triangle adjacency for coplanar face growth, built on first face pick. */
  adjacency?: Int32Array[];
}

const CREASE_DEGREES = 20;
const cache = new WeakMap<THREE.BufferGeometry, MeshTopology>();

function topologyOf(geometry: THREE.BufferGeometry): MeshTopology {
  const cached = cache.get(geometry);
  if (cached) return cached;
  const edgesGeometry = new THREE.EdgesGeometry(geometry, CREASE_DEGREES);
  const edges = new Float32Array((edgesGeometry.getAttribute('position') as THREE.BufferAttribute).array);
  edgesGeometry.dispose();
  const seen = new Map<string, number>();
  const vertices: number[] = [];
  for (let i = 0; i < edges.length; i += 3) {
    const key = `${Math.round(edges[i]! * 10)},${Math.round(edges[i + 1]! * 10)},${Math.round(edges[i + 2]! * 10)}`;
    if (seen.has(key)) continue;
    seen.set(key, vertices.length);
    vertices.push(edges[i]!, edges[i + 1]!, edges[i + 2]!);
  }
  const topology: MeshTopology = { edges, vertices: new Float32Array(vertices) };
  cache.set(geometry, topology);
  return topology;
}

function triangleIndices(geometry: THREE.BufferGeometry, triangle: number): [number, number, number] {
  const index = geometry.index;
  return index ? [index.getX(triangle * 3), index.getX(triangle * 3 + 1), index.getX(triangle * 3 + 2)] : [triangle * 3, triangle * 3 + 1, triangle * 3 + 2];
}

function adjacencyOf(geometry: THREE.BufferGeometry, topology: MeshTopology): Int32Array[] {
  if (topology.adjacency) return topology.adjacency;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const count = geometry.index ? geometry.index.count / 3 : position.count / 3;
  // Welded by position so meshes with split normals (one vertex per face corner) still connect.
  const key = (i: number) => `${Math.round(position.getX(i) * 10)},${Math.round(position.getY(i) * 10)},${Math.round(position.getZ(i) * 10)}`;
  const byEdge = new Map<string, number[]>();
  for (let t = 0; t < count; t++) {
    const ids = triangleIndices(geometry, t).map(key);
    for (let e = 0; e < 3; e++) {
      const a = ids[e]!, b = ids[(e + 1) % 3]!;
      const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
      const list = byEdge.get(edge);
      if (list) list.push(t);
      else byEdge.set(edge, [t]);
    }
  }
  const neighbours: number[][] = Array.from({ length: count }, () => []);
  for (const list of byEdge.values()) for (const a of list) for (const b of list) if (a !== b) neighbours[a]!.push(b);
  topology.adjacency = neighbours.map((list) => Int32Array.from(list));
  return topology.adjacency;
}

const scratch = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), n: new THREE.Vector3() };

function triangleWorld(mesh: THREE.Mesh, triangle: number, out: [THREE.Vector3, THREE.Vector3, THREE.Vector3]): void {
  const geometry = mesh.geometry as THREE.BufferGeometry;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const ids = triangleIndices(geometry, triangle);
  for (let i = 0; i < 3; i++) out[i]!.fromBufferAttribute(position, ids[i]!).applyMatrix4(mesh.matrixWorld);
}

/** The connected coplanar triangles around `seed`, in world coordinates. */
export function coplanarFace(mesh: THREE.Mesh, seed: number): { triangles: number[]; normal: Vec3; area: number } {
  const geometry = mesh.geometry as THREE.BufferGeometry;
  const adjacency = adjacencyOf(geometry, topologyOf(geometry));
  const corners: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const normalOf = (t: number, out: THREE.Vector3) => {
    triangleWorld(mesh, t, corners);
    return out.subVectors(corners[1], corners[0]).cross(scratch.c.subVectors(corners[2], corners[0]));
  };
  const normal = normalOf(seed, new THREE.Vector3()).normalize();
  triangleWorld(mesh, seed, corners);
  const offset = normal.dot(corners[0]);
  const visited = new Set<number>([seed]);
  const queue = [seed];
  const triangles: number[] = [];
  let area = 0;
  const cross = new THREE.Vector3();
  while (queue.length) {
    const t = queue.pop()!;
    triangleWorld(mesh, t, corners);
    for (const corner of corners) triangles.push(corner.x, corner.y, corner.z);
    area += cross.subVectors(corners[1], corners[0]).cross(scratch.c.subVectors(corners[2], corners[0])).length() / 2;
    for (const next of adjacency[t] ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      const n = normalOf(next, scratch.n);
      const length = n.length();
      if (length < 1e-9 || n.divideScalar(length).dot(normal) < 0.9995) continue;
      triangleWorld(mesh, next, corners);
      if (Math.abs(normal.dot(corners[0]) - offset) > 0.5) continue;
      queue.push(next);
    }
  }
  return { triangles, normal: [normal.x, normal.y, normal.z], area };
}

function toScreen(view: PickView, point: THREE.Vector3, out: THREE.Vector3): boolean {
  out.copy(point).project(view.camera);
  if (out.z > 1 || out.z < -1) return false;
  out.set(view.rect.left + ((out.x + 1) / 2) * view.rect.width, view.rect.top + ((1 - out.y) / 2) * view.rect.height, out.z);
  return true;
}

function cameraDistance(camera: THREE.Camera, point: THREE.Vector3): number {
  if (camera instanceof THREE.OrthographicCamera) {
    const direction = camera.getWorldDirection(scratch.n);
    return scratch.c.subVectors(point, camera.position).dot(direction);
  }
  return point.distanceTo(camera.position);
}

const toVec3 = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];

/**
 * What the pointer is on: the nearest vertex within `vertexPx`, else the nearest edge within
 * `edgePx`, else (with `faces`) the face under it. Geometry hidden behind the first surface under
 * the pointer does not count.
 */
export function pickTopology(targets: readonly PickTarget[], view: PickView, options: PickOptions = {}): TopologyHit | null {
  const vertexPx = options.vertexPx ?? 12;
  const edgePx = options.edgePx ?? 8;
  const ndc = new THREE.Vector2(((view.clientX - view.rect.left) / view.rect.width) * 2 - 1, -((view.clientY - view.rect.top) / view.rect.height) * 2 + 1);
  const raycaster = new THREE.Raycaster();
  view.camera.updateMatrixWorld();
  raycaster.setFromCamera(ndc, view.camera);
  const meshes = targets.map((target) => target.mesh);
  const surface = raycaster.intersectObjects(meshes, false).find((hit) => hit.object instanceof THREE.Mesh && hit.faceIndex !== undefined && hit.faceIndex !== null);
  // Anything farther than the surface under the pointer is behind it (a little slack for the edges of that surface itself).
  const limit = surface ? cameraDistance(view.camera, surface.point) * 1.002 + 2 : Infinity;

  let vertex: { d: number; point: THREE.Vector3; source: TopologySource } | null = null;
  let edge: { d: number; a: THREE.Vector3; b: THREE.Vector3; point: THREE.Vector3; source: TopologySource } | null = null;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), sa = new THREE.Vector3(), sb = new THREE.Vector3();
  for (const target of targets) {
    const { mesh } = target;
    if (!mesh.geometry) continue;
    mesh.updateMatrixWorld();
    const topology = topologyOf(mesh.geometry as THREE.BufferGeometry);
    const v = topology.vertices;
    for (let i = 0; i < v.length; i += 3) {
      a.set(v[i]!, v[i + 1]!, v[i + 2]!).applyMatrix4(mesh.matrixWorld);
      if (!toScreen(view, a, sa)) continue;
      const d = Math.hypot(sa.x - view.clientX, sa.y - view.clientY);
      if (d > vertexPx || (vertex && d >= vertex.d)) continue;
      if (cameraDistance(view.camera, a) > limit) continue;
      vertex = { d, point: a.clone(), source: target.source };
    }
    if (vertex) continue;
    const e = topology.edges;
    for (let i = 0; i < e.length; i += 6) {
      a.set(e[i]!, e[i + 1]!, e[i + 2]!).applyMatrix4(mesh.matrixWorld);
      b.set(e[i + 3]!, e[i + 4]!, e[i + 5]!).applyMatrix4(mesh.matrixWorld);
      if (!toScreen(view, a, sa) || !toScreen(view, b, sb)) continue;
      const vx = sb.x - sa.x, vy = sb.y - sa.y;
      const length2 = vx * vx + vy * vy;
      const t = length2 > 1e-9 ? Math.max(0, Math.min(1, ((view.clientX - sa.x) * vx + (view.clientY - sa.y) * vy) / length2)) : 0;
      const d = Math.hypot(view.clientX - (sa.x + vx * t), view.clientY - (sa.y + vy * t));
      if (d > edgePx || (edge && d >= edge.d)) continue;
      // Screen-space t is not world t under perspective: take the point on the edge nearest the pointer ray.
      const point = closestOnSegmentToRay(a, b, raycaster.ray);
      if (cameraDistance(view.camera, point) > limit) continue;
      edge = { d, a: a.clone(), b: b.clone(), point, source: target.source };
    }
  }
  if (vertex) return { kind: 'vertex', source: vertex.source, point: toVec3(vertex.point) };
  if (edge) return { kind: 'edge', source: edge.source, a: toVec3(edge.a), b: toVec3(edge.b), point: toVec3(edge.point) };
  if (options.faces && surface) {
    const target = targets.find((item) => item.mesh === surface.object)!;
    const face = coplanarFace(target.mesh, surface.faceIndex!);
    return { kind: 'face', source: target.source, point: toVec3(surface.point), ...face };
  }
  return null;
}

/** The point of segment ab closest to a ray. */
export function closestOnSegmentToRay(a: THREE.Vector3, b: THREE.Vector3, ray: THREE.Ray): THREE.Vector3 {
  const point = new THREE.Vector3();
  ray.distanceSqToSegment(a, b, undefined, point);
  return point;
}

/** A short human description of a hit, for labels and the inspector. */
export function describeTopology(hit: TopologyHit): string {
  const from = hit.source.kind === 'project' ? 'Project ' : '';
  if (hit.kind === 'vertex') return `${from}${from ? 'vertex' : 'Vertex'}`;
  if (hit.kind === 'edge') return `${from}${from ? 'edge' : 'Edge'}`;
  return `${from}${from ? 'face' : 'Face'}`;
}

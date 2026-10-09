/**
 * What can be done with a picked vertex / edge / face (of the project reference or a body):
 * move the work plane onto it, or trace it onto the work plane as sketch curves to model from.
 * Pure geometry, no store or three.js, so it is unit-testable.
 */
import { planeFrame, toPlane } from './kernel/sketch';
import type { Shape2D, SketchPlane, Vec2, Vec3 } from './kernel/types';
import type { TopologyHit } from './topology';

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const key = (p: Vec3) => p.map((value) => Math.round(value * 10)).join(',');

/** The work plane moved (not turned) so that it passes through `point`. */
export function planeThroughPoint(plane: SketchPlane, point: Vec3): SketchPlane {
  const frame = planeFrame(plane);
  return { kind: 'custom', origin: [...point], normal: [...frame.normal], xAxis: [...frame.u] };
}

/** The outer and inner boundaries of a set of coplanar triangles (world points, 9 per triangle). */
export function faceBoundaryLoops(triangles: readonly number[]): Vec3[][] {
  const points = new Map<string, Vec3>();
  const count = new Map<string, number>();
  const directed: [string, string][] = [];
  for (let i = 0; i + 8 < triangles.length; i += 9) {
    const corners: Vec3[] = [0, 1, 2].map((c) => [triangles[i + c * 3]!, triangles[i + c * 3 + 1]!, triangles[i + c * 3 + 2]!]);
    const keys = corners.map(key);
    corners.forEach((corner, c) => points.set(keys[c]!, corner));
    for (let e = 0; e < 3; e++) {
      const a = keys[e]!, b = keys[(e + 1) % 3]!;
      if (a === b) continue;
      const undirected = a < b ? `${a}|${b}` : `${b}|${a}`;
      count.set(undirected, (count.get(undirected) ?? 0) + 1);
      directed.push([a, b]);
    }
  }
  // Boundary edges belong to exactly one triangle; chain them head to tail.
  const next = new Map<string, string>();
  for (const [a, b] of directed) if (count.get(a < b ? `${a}|${b}` : `${b}|${a}`) === 1) next.set(a, b);
  const loops: Vec3[][] = [];
  const used = new Set<string>();
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const loop: Vec3[] = [];
    let current: string | undefined = start;
    while (current !== undefined && !used.has(current)) {
      used.add(current);
      loop.push(points.get(current)!);
      current = next.get(current);
    }
    if (loop.length >= 3) loops.push(dropCollinear(loop));
  }
  return loops;
}

/** Removes the in-between points of straight runs (triangulations add them). */
function dropCollinear(loop: Vec3[]): Vec3[] {
  const result = loop.filter((point, index) => {
    const before = loop[(index - 1 + loop.length) % loop.length]!;
    const after = loop[(index + 1) % loop.length]!;
    const a = sub(point, before), b = sub(after, point);
    const la = length(a), lb = length(b);
    if (la < 1e-6 || lb < 1e-6) return false;
    const cross = length([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
    return cross / (la * lb) > 1e-4;
  });
  return result.length >= 3 ? result : loop;
}

/** A work plane lying on a face: through the picked point, x along the face's longest edge. */
export function planeOnFace(hit: Extract<TopologyHit, { kind: 'face' }>): SketchPlane {
  let xAxis: Vec3 = [1, 0, 0];
  let longest = 0;
  for (const loop of faceBoundaryLoops(hit.triangles)) {
    for (let i = 0; i < loop.length; i++) {
      const edge = sub(loop[(i + 1) % loop.length]!, loop[i]!);
      const size = length(edge);
      if (size > longest) { longest = size; xAxis = edge; }
    }
  }
  return { kind: 'custom', origin: [...hit.point], normal: [...hit.normal], xAxis };
}

/**
 * The picked part as sketch curves on `plane` (projected straight onto it). Parts seen edge-on
 * from the plane (a wall face traced onto the ground) collapse and are left out.
 */
export function traceOntoPlane(plane: SketchPlane, hit: TopologyHit, newId: () => string): Shape2D[] {
  const flat = (point: Vec3): Vec2 => toPlane(plane, point);
  if (hit.kind === 'vertex') return [];
  if (hit.kind === 'edge') {
    const a = flat(hit.a), b = flat(hit.b);
    return Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.5 ? [] : [{ id: newId(), kind: 'polyline', points: [a, b], closed: false }];
  }
  const shapes: Shape2D[] = [];
  for (const loop of faceBoundaryLoops(hit.triangles)) {
    const points = loop.map(flat).filter((point, index, all) => {
      const previous = all[(index - 1 + all.length) % all.length]!;
      return Math.hypot(point[0] - previous[0], point[1] - previous[1]) >= 0.5;
    });
    let area = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!, q = points[(i + 1) % points.length]!;
      area += p[0] * q[1] - q[0] * p[1];
    }
    if (points.length >= 3 && Math.abs(area) / 2 >= 1) shapes.push({ id: newId(), kind: 'polyline', points });
  }
  return shapes;
}

/** Plain facts about a picked part for the inspector. */
export function topologyFacts(hit: TopologyHit): { label: string; value: string }[] {
  const mm = (value: number) => `${Math.round(value)} mm`;
  const at = (point: Vec3) => point.map((value) => Math.round(value)).join(', ');
  if (hit.kind === 'vertex') return [{ label: 'Position', value: `${at(hit.point)} mm` }];
  if (hit.kind === 'edge') return [{ label: 'Length', value: mm(length(sub(hit.b, hit.a))) }, { label: 'From', value: `${at(hit.a)} mm` }, { label: 'To', value: `${at(hit.b)} mm` }];
  return [{ label: 'Area', value: `${(hit.area / 1e6).toFixed(2)} m²` }, { label: 'Normal', value: hit.normal.map((value) => value.toFixed(2)).join(', ') }];
}

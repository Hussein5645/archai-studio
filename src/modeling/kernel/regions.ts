/**
 * Planar arrangement of sketch curves: every curve is split where it meets another one, loose
 * ends are trimmed away, and the closed faces that remain are found and nested. This is what
 * turns "a handful of selected curves" into regions the way Revit's sketch mode does:
 *
 * - curves that touch or cross form one connected network; all of its closed faces are solid
 *   (two overlapping rectangles merge, a line across a rectangle just splits it in two);
 * - a network lying entirely inside a face of another network is an opening in it, a network
 *   inside that opening is an island again (even / odd nesting depth);
 * - dangling lines, open ends, duplicate lines and crossings are reported for diagnostics.
 *
 * Pure TypeScript on tessellated contours (no WASM), so the tools, the scene overlay and the
 * kernel all share it. Coordinates are sketch millimetres.
 */
import type { Vec2 } from './types';

/** One input curve: a tessellated contour and whether its last point joins the first. */
export interface ArrangementCurve {
  shapeId: string;
  points: readonly Vec2[];
  closed: boolean;
}

/** A pickable region: the face of a network with the networks nested directly inside cut out. */
export interface RegionFace {
  /** Stable within one arrangement only; persist `seed` instead. */
  index: number;
  /** Connected network the face belongs to. */
  component: number;
  /** How many networks enclose this one; even = solid by default, odd = opening. */
  depth: number;
  /** Counter-clockwise outline. */
  outer: Vec2[];
  /** Counter-clockwise outlines of the networks nested directly inside (to be subtracted). */
  holes: Vec2[][];
  /** Area of the outline minus the holes. */
  area: number;
  /** A point inside the region (not in a hole), used to persist region picks. */
  seed: Vec2;
  /** Default participation: faces of even-depth networks. */
  solid: boolean;
  /** Shapes whose segments bound the face. */
  shapeIds: string[];
}

export interface SketchArrangement {
  faces: RegionFace[];
  /** Curve ends not joined to anything (the red markers of "lines must form closed loops"). */
  openEnds: Vec2[];
  /** Segments that do not bound any face (open lines, tails past a corner). */
  dangling: [Vec2, Vec2][];
  /** Points where two segments cross (not at a shared end). */
  crossings: Vec2[];
  /** Shapes that lie (partly) on top of another shape's line. */
  overlapping: string[];
}

/** Points closer than this are the same vertex. */
export const ARRANGEMENT_TOLERANCE = 1e-3;

interface Segment {
  a: Vec2;
  b: Vec2;
  shapeId: string;
  /** Split parameters along a→b (0 and 1 included later). */
  cuts: number[];
}

export function signedArea(points: readonly Vec2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[(i + 1) % points.length]!;
    area += x0 * y1 - x1 * y0;
  }
  return area / 2;
}

/** Even-odd point in polygon. */
export function pointInPolygon(point: Vec2, polygon: readonly Vec2[]): boolean {
  let inside = false;
  const [x, y] = point;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when the point is inside the face's outline and not in one of its holes. */
export function pointInFace(point: Vec2, face: Pick<RegionFace, 'outer' | 'holes'>): boolean {
  return pointInPolygon(point, face.outer) && !face.holes.some((hole) => pointInPolygon(point, hole));
}

function segmentsOf(curves: readonly ArrangementCurve[]): Segment[] {
  const segments: Segment[] = [];
  for (const curve of curves) {
    const count = curve.closed ? curve.points.length : curve.points.length - 1;
    for (let i = 0; i < count; i++) {
      const a = curve.points[i]!;
      const b = curve.points[(i + 1) % curve.points.length]!;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= ARRANGEMENT_TOLERANCE) continue;
      segments.push({ a, b, shapeId: curve.shapeId, cuts: [] });
    }
  }
  return segments;
}

/** Parameter of `p` projected on a→b, and its distance from the segment line. */
function project(p: Vec2, a: Vec2, b: Vec2): { t: number; distance: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2;
  const distance = Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / Math.sqrt(length2);
  return { t, distance };
}

/**
 * Records where two segments meet: a proper crossing, an end of one lying on the other
 * (T-junction), or a collinear overlap (each end of one that lies inside the other).
 * Returns 'cross' for a proper crossing, 'overlap' for collinear overlap, else null.
 */
function intersect(s: Segment, r: Segment, tol: number): 'cross' | 'overlap' | 'touch' | null {
  const d1x = s.b[0] - s.a[0];
  const d1y = s.b[1] - s.a[1];
  const d2x = r.b[0] - r.a[0];
  const d2y = r.b[1] - r.a[1];
  const len1 = Math.hypot(d1x, d1y);
  const len2 = Math.hypot(d2x, d2y);
  const denom = d1x * d2y - d1y * d2x;
  const tol1 = tol / len1;
  const tol2 = tol / len2;
  let result: 'overlap' | 'touch' | null = null;
  // Ends of one segment lying on the other: T-junctions and collinear overlaps.
  const onSegment = (p: Vec2, seg: Segment, segTol: number) => {
    const { t, distance } = project(p, seg.a, seg.b);
    return distance <= tol && t > segTol && t < 1 - segTol ? t : null;
  };
  let ends = 0;
  for (const p of [r.a, r.b]) {
    const t = onSegment(p, s, tol1);
    if (t !== null) {
      s.cuts.push(t);
      ends++;
    }
  }
  for (const p of [s.a, s.b]) {
    const t = onSegment(p, r, tol2);
    if (t !== null) {
      r.cuts.push(t);
      ends++;
    }
  }
  const parallel = Math.abs(denom) <= 1e-12 * len1 * len2;
  if (parallel) {
    if (ends === 0) {
      // Identical segments (both ends shared) also overlap.
      const same = (Math.hypot(s.a[0] - r.a[0], s.a[1] - r.a[1]) <= tol && Math.hypot(s.b[0] - r.b[0], s.b[1] - r.b[1]) <= tol) || (Math.hypot(s.a[0] - r.b[0], s.a[1] - r.b[1]) <= tol && Math.hypot(s.b[0] - r.a[0], s.b[1] - r.a[1]) <= tol);
      return same ? 'overlap' : null;
    }
    const collinear = project(r.a, s.a, s.b).distance <= tol && project(r.b, s.a, s.b).distance <= tol;
    return collinear ? 'overlap' : 'touch';
  }
  if (ends > 0) result = 'touch';
  const ex = r.a[0] - s.a[0];
  const ey = r.a[1] - s.a[1];
  const t = (ex * d2y - ey * d2x) / denom;
  const u = (ex * d1y - ey * d1x) / denom;
  if (t > tol1 && t < 1 - tol1 && u > tol2 && u < 1 - tol2) {
    s.cuts.push(t);
    r.cuts.push(u);
    return 'cross';
  }
  return result;
}

/** Merges nearby points into shared vertices through a hash grid. */
class VertexPool {
  readonly points: Vec2[] = [];
  private readonly cells = new Map<string, number[]>();
  constructor(private readonly tol: number) {}

  private key(x: number, y: number): string {
    return `${x},${y}`;
  }

  add(p: Vec2): number {
    const cx = Math.floor(p[0] / this.tol);
    const cy = Math.floor(p[1] / this.tol);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const index of this.cells.get(this.key(cx + dx, cy + dy)) ?? []) {
          const q = this.points[index]!;
          if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= this.tol) return index;
        }
      }
    }
    const index = this.points.length;
    this.points.push(p);
    const key = this.key(cx, cy);
    const cell = this.cells.get(key);
    if (cell) cell.push(index);
    else this.cells.set(key, [index]);
    return index;
  }
}

interface Edge {
  u: number;
  v: number;
  shapeIds: Set<string>;
  alive: boolean;
}

/** An interior point of a polygon with holes: the middle of the widest span on a few scanlines. */
export function interiorPoint(outer: readonly Vec2[], holes: readonly (readonly Vec2[])[] = []): Vec2 {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of outer) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  let best: { width: number; point: Vec2 } | null = null;
  const rings = [outer, ...holes];
  for (const fraction of [0.5, 0.3, 0.7, 0.15, 0.85, 0.41, 0.59]) {
    // A slightly irrational offset keeps the scanline off vertices.
    const y = minY + (maxY - minY) * fraction + (maxY - minY) * 1.234567e-5;
    const xs: number[] = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]!;
        const [xj, yj] = ring[j]!;
        if (yi > y !== yj > y) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const width = xs[i + 1]! - xs[i]!;
      if (!best || width > best.width) best = { width, point: [(xs[i]! + xs[i + 1]!) / 2, y] };
    }
    if (best && best.width > (maxY - minY) * 0.25) break;
  }
  return best?.point ?? outer[0] ?? [0, 0];
}

/** Builds the arrangement of the curves (see the module comment). */
export function arrange(curves: readonly ArrangementCurve[], tol = ARRANGEMENT_TOLERANCE): SketchArrangement {
  const segments = segmentsOf(curves);
  const crossings: Vec2[] = [];
  const overlapping = new Set<string>();

  // Pairwise intersections, pruned by a sweep over x.
  const order = segments.map((segment, index) => ({ index, min: Math.min(segment.a[0], segment.b[0]) - tol, max: Math.max(segment.a[0], segment.b[0]) + tol })).sort((p, q) => p.min - q.min);
  for (let i = 0; i < order.length; i++) {
    const oi = order[i]!;
    const s = segments[oi.index]!;
    const sMinY = Math.min(s.a[1], s.b[1]) - tol;
    const sMaxY = Math.max(s.a[1], s.b[1]) + tol;
    for (let j = i + 1; j < order.length && order[j]!.min <= oi.max; j++) {
      const r = segments[order[j]!.index]!;
      if (Math.max(r.a[1], r.b[1]) < sMinY || Math.min(r.a[1], r.b[1]) > sMaxY) continue;
      const kind = intersect(s, r, tol);
      if (kind === 'cross') {
        const t = s.cuts[s.cuts.length - 1]!;
        crossings.push([s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t]);
      } else if (kind === 'overlap') {
        overlapping.add(s.shapeId);
        overlapping.add(r.shapeId);
      }
    }
  }

  // Split into edges between shared vertices; duplicate edges collapse into one.
  const pool = new VertexPool(tol);
  const edges = new Map<string, Edge>();
  for (const segment of segments) {
    const cuts = [0, ...segment.cuts.filter((t) => t > 0 && t < 1).sort((a, b) => a - b), 1];
    let previous = pool.add(segment.a);
    for (let k = 1; k < cuts.length; k++) {
      const t = cuts[k]!;
      const point: Vec2 = t === 1 ? segment.b : [segment.a[0] + (segment.b[0] - segment.a[0]) * t, segment.a[1] + (segment.b[1] - segment.a[1]) * t];
      const next = pool.add(point);
      if (next !== previous) {
        const key = previous < next ? `${previous}:${next}` : `${next}:${previous}`;
        const edge = edges.get(key);
        if (edge) edge.shapeIds.add(segment.shapeId);
        else edges.set(key, { u: previous, v: next, shapeIds: new Set([segment.shapeId]), alive: true });
      }
      previous = next;
    }
  }
  const points = pool.points;
  const edgeList = [...edges.values()];
  const incident: number[][] = points.map(() => []);
  edgeList.forEach((edge, index) => {
    incident[edge.u]!.push(index);
    incident[edge.v]!.push(index);
  });

  const openEnds = incident.flatMap((list, vertex) => (list.length === 1 ? [points[vertex]!] : []));

  // Trim filaments: repeatedly drop edges ending in a vertex with a single live edge.
  const degree = incident.map((list) => list.length);
  const stack = degree.flatMap((d, vertex) => (d === 1 ? [vertex] : []));
  const dangling: [Vec2, Vec2][] = [];
  while (stack.length) {
    const vertex = stack.pop()!;
    if (degree[vertex] !== 1) continue;
    const edgeIndex = incident[vertex]!.find((index) => edgeList[index]!.alive);
    if (edgeIndex === undefined) continue;
    const edge = edgeList[edgeIndex]!;
    edge.alive = false;
    dangling.push([points[edge.u]!, points[edge.v]!]);
    degree[edge.u]!--;
    degree[edge.v]!--;
    const other = edge.u === vertex ? edge.v : edge.u;
    if (degree[other] === 1) stack.push(other);
  }

  // Connected components of the live network.
  const parent = points.map((_, index) => index);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  for (const edge of edgeList) if (edge.alive) parent[find(edge.u)] = find(edge.v);

  // Half-edges sorted by angle around each vertex; walking "next clockwise from the twin"
  // keeps the face on the left, so bounded faces come out counter-clockwise.
  const outgoing: { to: number; angle: number; edge: number }[][] = points.map(() => []);
  edgeList.forEach((edge, index) => {
    if (!edge.alive) return;
    const a = points[edge.u]!;
    const b = points[edge.v]!;
    outgoing[edge.u]!.push({ to: edge.v, angle: Math.atan2(b[1] - a[1], b[0] - a[0]), edge: index });
    outgoing[edge.v]!.push({ to: edge.u, angle: Math.atan2(a[1] - b[1], a[0] - b[0]), edge: index });
  });
  for (const list of outgoing) list.sort((p, q) => p.angle - q.angle);
  const visited = new Set<string>();
  const cycles: { component: number; vertices: number[]; edges: number[]; area: number }[] = [];
  for (let start = 0; start < points.length; start++) {
    for (const first of outgoing[start]!) {
      if (visited.has(`${start}>${first.to}`)) continue;
      const vertices: number[] = [];
      const cycleEdges: number[] = [];
      let from = start;
      let half = first;
      for (let guard = 0; guard < edgeList.length * 2 + 2; guard++) {
        const key = `${from}>${half.to}`;
        if (visited.has(key)) break;
        visited.add(key);
        vertices.push(from);
        cycleEdges.push(half.edge);
        const at = half.to;
        const around = outgoing[at]!;
        const twin = around.findIndex((item) => item.to === from && item.edge === half.edge);
        const next = around[(twin - 1 + around.length) % around.length]!;
        from = at;
        half = next;
      }
      const area = signedArea(vertices.map((index) => points[index]!));
      cycles.push({ component: find(start), vertices, edges: cycleEdges, area });
    }
  }

  // Bounded faces (positive) and each network's outline (its outer, negative cycle, reversed).
  const minArea = tol * tol;
  const bounded = cycles.filter((cycle) => cycle.area > minArea);
  const outlines = new Map<number, Vec2[]>();
  for (const cycle of cycles) {
    if (cycle.area >= -minArea) continue;
    const outline = cycle.vertices.map((index) => points[index]!).reverse();
    const current = outlines.get(cycle.component);
    // A network has a single outer cycle; keep the largest if tolerance splits it.
    if (!current || Math.abs(signedArea(outline)) > Math.abs(signedArea(current))) outlines.set(cycle.component, outline);
  }

  // Nesting: which bounded face of another network holds each network.
  const components = [...new Set(bounded.map((cycle) => cycle.component))];
  const facePolygon = bounded.map((cycle) => cycle.vertices.map((index) => points[index]!));
  const sample = new Map<number, Vec2>();
  for (const component of components) {
    const vertex = points.findIndex((_, index) => find(index) === component && degree[index]! > 0);
    sample.set(component, points[vertex]!);
  }
  /** The face (index into `bounded`) that directly contains a network: the smallest one. */
  const container = new Map<number, number | null>();
  for (const component of components) {
    const probe = sample.get(component)!;
    let best: number | null = null;
    bounded.forEach((cycle, index) => {
      if (cycle.component === component) return;
      if (!pointInPolygon(probe, facePolygon[index]!)) return;
      if (best === null || cycle.area < bounded[best]!.area) best = index;
    });
    container.set(component, best);
  }
  const depthOf = new Map<number, number>();
  const depth = (component: number, guard = 0): number => {
    const known = depthOf.get(component);
    if (known !== undefined) return known;
    const holder = container.get(component);
    const value = holder === null || holder === undefined || guard > components.length ? 0 : depth(bounded[holder]!.component, guard + 1) + 1;
    depthOf.set(component, value);
    return value;
  };

  const faces: RegionFace[] = bounded.map((cycle, index) => {
    const outer = facePolygon[index]!;
    const holes = components.filter((component) => container.get(component) === index).map((component) => outlines.get(component)).filter((outline): outline is Vec2[] => Boolean(outline));
    const componentDepth = depth(cycle.component);
    const shapeIds = new Set<string>();
    for (const edgeIndex of cycle.edges) for (const id of edgeList[edgeIndex]!.shapeIds) shapeIds.add(id);
    return {
      index,
      component: cycle.component,
      depth: componentDepth,
      outer,
      holes,
      area: cycle.area - holes.reduce((sum, hole) => sum + Math.abs(signedArea(hole)), 0),
      seed: interiorPoint(outer, holes),
      solid: componentDepth % 2 === 0,
      shapeIds: [...shapeIds],
    };
  });

  return { faces, openEnds, dangling, crossings, overlapping: [...overlapping] };
}

/**
 * The faces a set of picked seed points selects (a face is picked when a seed lies inside it).
 * Without seeds, or when none of them hits a face any more, the default solid faces are used.
 */
export function pickedFaces(faces: readonly RegionFace[], seeds?: readonly Vec2[]): RegionFace[] {
  if (seeds?.length) {
    const picked = faces.filter((face) => seeds.some((seed) => pointInFace(seed, face)));
    if (picked.length) return picked;
  }
  return faces.filter((face) => face.solid);
}

/** The face under a point: the innermost one (smallest area) whose region contains it. */
export function faceAt(faces: readonly RegionFace[], point: Vec2): RegionFace | null {
  let best: RegionFace | null = null;
  for (const face of faces) if (pointInFace(point, face) && (!best || face.area < best.area)) best = face;
  return best;
}

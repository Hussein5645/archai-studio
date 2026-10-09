import type { ArchaiDocument, Element, LineElement } from '@/document';
import { worldMatrix } from './bounds';
import { applyToPoint } from './matrix';
import { distance, type Vec2 } from './vec';
import { linePoints } from './curves';

const EPSILON = 1e-7;

function archType(element: Element): string | null {
  const value = element.meta?.['arch'];
  return value && typeof value === 'object' && !Array.isArray(value) && typeof value['type'] === 'string' ? value['type'] : null;
}

export function isBoundaryLine(element: Element): element is LineElement {
  const type = archType(element);
  return element.kind === 'line' && (type === 'wall' || type === 'curtain-wall' || type === 'room-divider');
}

export interface BoundaryEndpoint {
  point: Vec2;
  elementId: string;
  endpoint: 'start' | 'end';
}

export function boundaryEndpoints(doc: ArchaiDocument): BoundaryEndpoint[] {
  const result: BoundaryEndpoint[] = [];
  for (const element of Object.values(doc.elements)) {
    if (!element.visible || !isBoundaryLine(element)) continue;
    const matrix = worldMatrix(doc.elements, element);
    const points = linePoints(element);
    if (points.length < 2) continue;
    result.push({ point: applyToPoint(matrix, { x: points[0]![0], y: points[0]![1] }), elementId: element.id, endpoint: 'start' });
    const last = points.at(-1)!;
    result.push({ point: applyToPoint(matrix, { x: last[0], y: last[1] }), elementId: element.id, endpoint: 'end' });
  }
  return result;
}

export function snapToBoundaryEndpoint(doc: ArchaiDocument, point: Vec2, tolerance: number): Vec2 {
  let best: Vec2 | null = null;
  let bestDistance = tolerance;
  for (const endpoint of boundaryEndpoints(doc)) {
    const gap = distance(point, endpoint.point);
    if (gap <= bestDistance) {
      best = endpoint.point;
      bestDistance = gap;
    }
  }
  return best ?? point;
}

interface Segment { a: Vec2; b: Vec2 }

function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

function segmentIntersection(first: Segment, second: Segment): { point: Vec2; firstT: number; secondT: number } | null {
  const r = { x: first.b.x - first.a.x, y: first.b.y - first.a.y };
  const s = { x: second.b.x - second.a.x, y: second.b.y - second.a.y };
  const denominator = cross(r, s);
  if (Math.abs(denominator) < EPSILON) return null;
  const delta = { x: second.a.x - first.a.x, y: second.a.y - first.a.y };
  const firstT = cross(delta, s) / denominator;
  const secondT = cross(delta, r) / denominator;
  if (firstT < -EPSILON || firstT > 1 + EPSILON || secondT < -EPSILON || secondT > 1 + EPSILON) return null;
  return { point: { x: first.a.x + r.x * firstT, y: first.a.y + r.y * firstT }, firstT, secondT };
}

/** The level an element is constrained to, or null when it floats on the board. */
export function levelIdOf(element: Element): string | null {
  const constraint = element.meta?.['levelConstraint'];
  if (!constraint || typeof constraint !== 'object' || Array.isArray(constraint)) return null;
  return typeof constraint['levelId'] === 'string' ? constraint['levelId'] : null;
}

/**
 * `levelId` undefined considers every boundary; a string keeps that level's boundaries plus
 * unlevelled ones, since stacked levels share plan coordinates and would otherwise cut each other.
 */
function boundarySegments(doc: ArchaiDocument, levelId?: string | null): Segment[] {
  const result: Segment[] = [];
  for (const element of Object.values(doc.elements)) {
    if (!element.visible || !isBoundaryLine(element)) continue;
    if (levelId !== undefined) {
      const own = levelIdOf(element);
      if (own !== null && own !== levelId) continue;
    }
    const matrix = worldMatrix(doc.elements, element);
    const points = linePoints(element, 32).map(([x, y]) => applyToPoint(matrix, { x, y }));
    for (let index = 0; index < points.length - 1; index++) {
      const a = points[index]!;
      const b = points[index + 1]!;
      if (distance(a, b) > EPSILON) result.push({ a, b });
    }
  }
  return result;
}

function splitAtIntersections(segments: Segment[]): Segment[] {
  const cuts = segments.map(() => [0, 1]);
  for (let first = 0; first < segments.length; first++) {
    for (let second = first + 1; second < segments.length; second++) {
      const hit = segmentIntersection(segments[first]!, segments[second]!);
      if (!hit) continue;
      cuts[first]!.push(Math.max(0, Math.min(1, hit.firstT)));
      cuts[second]!.push(Math.max(0, Math.min(1, hit.secondT)));
    }
  }
  const result: Segment[] = [];
  segments.forEach((segment, index) => {
    const values = [...new Set(cuts[index]!.map((value) => Math.round(value * 1e7) / 1e7))].sort((a, b) => a - b);
    for (let cut = 0; cut < values.length - 1; cut++) {
      const from = values[cut]!;
      const to = values[cut + 1]!;
      if (to - from < EPSILON) continue;
      const point = (t: number) => ({ x: segment.a.x + (segment.b.x - segment.a.x) * t, y: segment.a.y + (segment.b.y - segment.a.y) * t });
      result.push({ a: point(from), b: point(to) });
    }
  });
  return result;
}

function polygonArea(points: readonly Vec2[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

export function polygonCentroid(points: readonly Vec2[]): Vec2 {
  const area = polygonArea(points);
  if (Math.abs(area) < EPSILON) {
    return points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 });
  }
  let x = 0;
  let y = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    const factor = a.x * b.y - b.x * a.y;
    x += (a.x + b.x) * factor;
    y += (a.y + b.y) * factor;
  }
  return { x: x / (6 * area), y: y / (6 * area) };
}

export function polygonContainsPoint(points: readonly Vec2[], point: Vec2): boolean {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[index]!;
    const b = points[previous]!;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Every closed face of the wall/divider graph. Building it is the expensive part of an enclosure
 * lookup, so callers that look up many points in one document (room refresh) build it once.
 */
export function enclosureFaces(doc: ArchaiDocument, mergeTolerance = 5, levelId?: string | null): Vec2[][] {
  const segments = splitAtIntersections(boundarySegments(doc, levelId));
  const nodes: Vec2[] = [];
  const nodeFor = (candidate: Vec2) => {
    const found = nodes.findIndex((node) => distance(node, candidate) <= mergeTolerance);
    if (found >= 0) return found;
    nodes.push(candidate);
    return nodes.length - 1;
  };
  const neighbours = new Map<number, Set<number>>();
  for (const segment of segments) {
    const a = nodeFor(segment.a);
    const b = nodeFor(segment.b);
    if (a === b) continue;
    (neighbours.get(a) ?? (neighbours.set(a, new Set()), neighbours.get(a)!)).add(b);
    (neighbours.get(b) ?? (neighbours.set(b, new Set()), neighbours.get(b)!)).add(a);
  }

  const directedVisited = new Set<string>();
  const faces: Vec2[][] = [];
  for (const [from, nextNodes] of neighbours) {
    for (const to of nextNodes) {
      const directedKey = `${from}:${to}`;
      if (directedVisited.has(directedKey)) continue;
      const cycle: number[] = [];
      let previous = from;
      let current = to;
      for (let guard = 0; guard < segments.length * 2 + 4; guard++) {
        directedVisited.add(`${previous}:${current}`);
        cycle.push(previous);
        const options = [...(neighbours.get(current) ?? [])];
        if (options.length === 0) break;
        const backAngle = Math.atan2(nodes[previous]!.y - nodes[current]!.y, nodes[previous]!.x - nodes[current]!.x);
        options.sort((left, right) => {
          const leftTurn = (Math.atan2(nodes[left]!.y - nodes[current]!.y, nodes[left]!.x - nodes[current]!.x) - backAngle + Math.PI * 2) % (Math.PI * 2);
          const rightTurn = (Math.atan2(nodes[right]!.y - nodes[current]!.y, nodes[right]!.x - nodes[current]!.x) - backAngle + Math.PI * 2) % (Math.PI * 2);
          return rightTurn - leftTurn;
        });
        const next = options.find((candidate) => candidate !== previous) ?? previous;
        previous = current;
        current = next;
        if (previous === from && current === to) {
          const polygon = cycle.map((id) => nodes[id]!);
          if (polygon.length >= 3 && Math.abs(polygonArea(polygon)) > 1) faces.push(polygon);
          break;
        }
      }
    }
  }
  return faces;
}

/** The smallest of `faces` containing `point`. */
export function smallestFaceContaining(faces: readonly Vec2[][], point: Vec2): Vec2[] | null {
  let best: Vec2[] | null = null;
  let bestArea = Infinity;
  for (const face of faces) {
    if (!polygonContainsPoint(face, point)) continue;
    const area = Math.abs(polygonArea(face));
    if (area < bestArea) {
      best = face;
      bestArea = area;
    }
  }
  return best;
}

/** Returns the smallest closed wall/divider face containing `point`. */
export function findEnclosure(doc: ArchaiDocument, point: Vec2, mergeTolerance = 5, levelId?: string | null): Vec2[] | null {
  return smallestFaceContaining(enclosureFaces(doc, mergeTolerance, levelId), point);
}

export function enclosureArea(points: readonly Vec2[]): number {
  return Math.abs(polygonArea(points));
}

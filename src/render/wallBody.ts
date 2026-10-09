/**
 * Plan geometry of a wall as a filled body: the centre line offset to both faces, ends mitred
 * against the walls it is joined to (square corners, no caps), door/window intervals cut out as
 * holes, and layer boundaries as offset lines that run into the joint. All in the wall's local
 * frame; joined walls are brought into it through their world matrices.
 */
import { archOf, archTypeOf, isArchType } from '@/assets/arch-meta';
import type { Element, ElementTable, LineElement } from '@/document';
import { applyToPoint, invert, linePoints, pointAtLine, projectOnLine, worldMatrix, type Vec2 } from '@/geometry';
import { wallOpeningCandidates, wallOpeningsFor } from '@/interaction/wallSnap';
import { instanceElevationOf } from '@/view3d/geometry';
import { parseSystemParameters } from '@/catalog';

const fmt = (p: Vec2): string => `${+p.x.toFixed(3)} ${+p.y.toFixed(3)}`;
/** Endpoints closer than this count as meeting (joint metadata decides, this only re-checks). */
const MEET_TOLERANCE = 2;

interface Line {
  p: Vec2;
  d: Vec2;
}

function intersect(a: Line, b: Line): Vec2 | null {
  const cross = a.d.x * b.d.y - a.d.y * b.d.x;
  if (Math.abs(cross) < 1e-9) return null;
  const t = ((b.p.x - a.p.x) * b.d.y - (b.p.y - a.p.y) * b.d.x) / cross;
  return { x: a.p.x + a.d.x * t, y: a.p.y + a.d.y * t };
}

function normal(d: Vec2): Vec2 {
  return { x: -d.y, y: d.x };
}

function unit(a: Vec2, b: Vec2): Vec2 | null {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  return length > 0 ? { x: (b.x - a.x) / length, y: (b.y - a.y) / length } : null;
}

function jointIds(wall: Element, endpoint: 'start' | 'end' | 'body'): string[] {
  const joints = archOf(wall)?.['joints'];
  const joint = joints && typeof joints === 'object' && !Array.isArray(joints) ? joints[endpoint] : null;
  if (!joint || typeof joint !== 'object' || Array.isArray(joint) || joint['enabled'] !== true) return [];
  return Array.isArray(joint['with']) ? joint['with'].filter((id): id is string => typeof id === 'string') : [];
}

function thicknessOf(wall: Element): number {
  return wall.kind === 'line' ? wall.style.strokeWidth : 0;
}

/** A joined neighbour oriented to flow through the shared point: its direction leaving `at`. */
interface Neighbour {
  direction: Vec2;
  thickness: number;
  through?: boolean;
}

function neighbourAt(wall: LineElement, elements: ElementTable, endpoint: 'start' | 'end', at: Vec2): Neighbour[] {
  const toLocal = invert(worldMatrix(elements, wall));
  const result: Neighbour[] = [];
  for (const id of jointIds(wall, endpoint)) {
    const other = elements[id];
    if (!other || other.kind !== 'line' || other.points.length < 2 || !isArchType(other, 'wall', 'curtain-wall', 'room-divider')) continue;
    const matrix = worldMatrix(elements, other);
    const local = linePoints(other).map(([x, y]) => applyToPoint(toLocal, applyToPoint(matrix, { x, y })));
    const first = local[0]!;
    const last = local.at(-1)!;
    // Flow: for our end the neighbour leaves the point; for our start it arrives at the point.
    let direction: Vec2 | null = null;
    if (Math.hypot(first.x - at.x, first.y - at.y) <= MEET_TOLERANCE) direction = unit(first, local[1]!);
    else if (Math.hypot(last.x - at.x, last.y - at.y) <= MEET_TOLERANCE) direction = unit(last, local[local.length - 2]!);
    if (!direction) {
      const otherLocal = applyToPoint(invert(matrix), applyToPoint(worldMatrix(elements, wall), at));
      const projected = projectOnLine(other, otherLocal);
      if (!projected || projected.distance > MEET_TOLERANCE || projected.along <= MEET_TOLERANCE || projected.totalLength - projected.along <= MEET_TOLERANCE) continue;
      const ahead = applyToPoint(toLocal, applyToPoint(matrix, { x: projected.point.x + projected.tangent.x, y: projected.point.y + projected.tangent.y }));
      const meet = applyToPoint(toLocal, applyToPoint(matrix, projected.point));
      const tangent = unit(meet, ahead);
      if (tangent) result.push({ direction: tangent, thickness: thicknessOf(other), through: true });
      continue;
    }
    // Both cases give the direction pointing away from the shared point along the neighbour;
    // orient it so the path flows continuously (arriving at our start, leaving our end).
    if (endpoint === 'start') direction = { x: -direction.x, y: -direction.y };
    result.push({ direction, thickness: thicknessOf(other) });
  }
  return result;
}

/**
 * The end point of an offset line (offset `o` from the centre line, positive = right-hand side)
 * at one wall end: mitred into a single joined wall, squared off by half the neighbour's
 * thickness for T/multi-joints, or a plain butt end.
 */
function offsetEnd(at: Vec2, direction: Vec2, offset: number, neighbours: Neighbour[], thickness: number, endpoint: 'start' | 'end'): Vec2 {
  const n = normal(direction);
  const base = { x: at.x + n.x * offset, y: at.y + n.y * offset };
  if (neighbours.length === 0) return base;
  // Along-wall extension for a butt joint that fills the corner of a square meeting.
  const away = endpoint === 'end' ? 1 : -1;
  const through = neighbours.find((neighbour) => neighbour.through);
  if (through) {
    const faceNormal = normal(through.direction);
    const side = (faceNormal.x * direction.x + faceNormal.y * direction.y) * -away >= 0 ? 1 : -1;
    const face = { p: { x: at.x + faceNormal.x * side * through.thickness / 2, y: at.y + faceNormal.y * side * through.thickness / 2 }, d: through.direction };
    return intersect({ p: base, d: direction }, face) ?? base;
  }
  const extend = (amount: number): Vec2 => ({ x: base.x + direction.x * away * amount, y: base.y + direction.y * away * amount });
  if (neighbours.length > 1) return extend(Math.max(...neighbours.map((item) => item.thickness)) / 2);
  const other = neighbours[0]!;
  const cross = direction.x * other.direction.y - direction.y * other.direction.x;
  const dot = direction.x * other.direction.x + direction.y * other.direction.y;
  if (Math.abs(cross) < 1e-6) return dot > 0 ? base : extend(other.thickness / 2); // straight continuation or a fold-back
  const scale = other.thickness / Math.max(thickness, 1e-6);
  const otherNormal = normal(other.direction);
  const otherLine: Line = { p: { x: at.x + otherNormal.x * offset * scale, y: at.y + otherNormal.y * offset * scale }, d: other.direction };
  const point = intersect({ p: base, d: direction }, otherLine);
  if (!point) return base;
  // Very acute corners would shoot far past the wall; square them off instead.
  const reach = Math.hypot(point.x - base.x, point.y - base.y);
  if (reach > Math.max(thickness, other.thickness) * 3) return extend(other.thickness / 2);
  return point;
}

/** Offset polyline of the wall with mitred internal vertices and joint-aware ends. */
export function wallOffsetLine(wall: LineElement, elements: ElementTable, offset: number): Vec2[] {
  const points = linePoints(wall).map(([x, y]) => ({ x, y }));
  const thickness = thicknessOf(wall);
  const segments: Line[] = [];
  for (let index = 0; index < points.length - 1; index++) {
    const direction = unit(points[index]!, points[index + 1]!);
    if (!direction) continue;
    const n = normal(direction);
    segments.push({ p: { x: points[index]!.x + n.x * offset, y: points[index]!.y + n.y * offset }, d: direction });
  }
  if (segments.length === 0) return [];
  const first = segments[0]!;
  const last = segments.at(-1)!;
  const start = offsetEnd(points[0]!, first.d, offset, neighbourAt(wall, elements, 'start', points[0]!), thickness, 'start');
  const end = offsetEnd(points.at(-1)!, last.d, offset, neighbourAt(wall, elements, 'end', points.at(-1)!), thickness, 'end');
  const result: Vec2[] = [start];
  for (let index = 0; index < segments.length - 1; index++) {
    const corner = intersect(segments[index]!, segments[index + 1]!);
    const vertex = points[index + 1]!;
    const n = normal(segments[index]!.d);
    result.push(corner && Math.hypot(corner.x - vertex.x, corner.y - vertex.y) < Math.abs(offset) * 4 + 1 ? corner : { x: vertex.x + n.x * offset, y: vertex.y + n.y * offset });
  }
  result.push(end);
  return result;
}

/** Rectangles (in local space) covering each door/window interval across the wall thickness. */
function openingHoles(wall: LineElement, elements: ElementTable): Vec2[][] {
  const half = thicknessOf(wall) / 2 + 1;
  const holes: Vec2[][] = [];
  const wallParams = parseSystemParameters('wall', archOf(wall)?.['parameters']);
  const wallWorldBottom = instanceElevationOf(wall, elements);
  const wallWorldTop = wallWorldBottom + wallParams.height;

  const openings = wallOpeningsFor(wall, elements);
  for (const { element, opening } of openings) {
    const type = archTypeOf(element);
    let height = 0;
    if (type === 'door') {
      height = parseSystemParameters('door', archOf(element)?.['parameters']).height;
    } else if (type === 'window') {
      height = parseSystemParameters('window', archOf(element)?.['parameters']).height;
    }
    const openingWorldBottom = instanceElevationOf(element, elements);
    const openingWorldTop = openingWorldBottom + height;
    if (openingWorldTop <= wallWorldBottom || openingWorldBottom >= wallWorldTop) {
      continue;
    }

    if (wall.path && opening.curveAlong !== undefined) {
      const start = pointAtLine(wall, opening.start);
      const end = pointAtLine(wall, opening.end);
      if (!start || !end) continue;
      const startNormal = normal(start.tangent);
      const endNormal = normal(end.tangent);
      holes.push([
        { x: start.point.x - startNormal.x * half, y: start.point.y - startNormal.y * half },
        { x: end.point.x - endNormal.x * half, y: end.point.y - endNormal.y * half },
        { x: end.point.x + endNormal.x * half, y: end.point.y + endNormal.y * half },
        { x: start.point.x + startNormal.x * half, y: start.point.y + startNormal.y * half },
      ]);
      continue;
    }
    const sampled = linePoints(wall);
    const a = sampled[opening.segment];
    const b = sampled[opening.segment + 1];
    if (!a || !b) continue;
    const direction = unit({ x: a[0], y: a[1] }, { x: b[0], y: b[1] });
    if (!direction) continue;
    const n = normal(direction);
    const at = (along: number, side: number): Vec2 => ({ x: a[0] + direction.x * along + n.x * side, y: a[1] + direction.y * along + n.y * side });
    holes.push([at(opening.start, -half), at(opening.end, -half), at(opening.end, half), at(opening.start, half)]);
  }
  return holes;
}

/**
 * Ids of the other elements this wall's plan paths read: joined walls (mitres, junction gaps)
 * and door/window candidates (holes). Their ancestors and hosts matter too; callers add those.
 */
export function wallPathDependencies(wall: LineElement, elements: ElementTable): string[] {
  const ids = [...jointIds(wall, 'start'), ...jointIds(wall, 'end'), ...jointIds(wall, 'body')];
  for (const opening of wallOpeningCandidates(wall.id, elements)) ids.push(opening.id);
  return ids;
}

/** SVG path of the wall body (faces + mitred ends) with openings as even-odd holes. */
export function wallBodyPath(wall: LineElement, elements: ElementTable): string {
  const half = thicknessOf(wall) / 2;
  const left = wallOffsetLine(wall, elements, -half);
  const right = wallOffsetLine(wall, elements, half);
  if (left.length < 2 || right.length < 2) return '';
  const ring = [...left, ...right.reverse()];
  const parts = [`M ${ring.map(fmt).join(' L ')} Z`];
  for (const hole of openingHoles(wall, elements)) parts.push(`M ${hole.map(fmt).join(' L ')} Z`);
  return parts.join(' ');
}

/**
 * Visible wall edges without the artificial cap across a joined end. The body remains a closed
 * fill path, but its outline is drawn separately so two mitred walls read as one continuous body.
 */
export function wallOutlinePath(wall: LineElement, elements: ElementTable): string {
  const half = thicknessOf(wall) / 2;
  const left = wallOffsetLine(wall, elements, -half);
  const right = wallOffsetLine(wall, elements, half);
  const centre = linePoints(wall);
  if (left.length < 2 || right.length < 2 || centre.length < 2) return '';
  const start = { x: centre[0]![0], y: centre[0]![1] };
  const endPoint = centre.at(-1)!;
  const end = { x: endPoint[0], y: endPoint[1] };
  const parts = [outlineWithJunctions(left, wall, elements), outlineWithJunctions(right, wall, elements)];
  if (neighbourAt(wall, elements, 'start', start).length === 0) parts.push(`M ${fmt(left[0]!)} L ${fmt(right[0]!)}`);
  if (neighbourAt(wall, elements, 'end', end).length === 0) parts.push(`M ${fmt(left.at(-1)!)} L ${fmt(right.at(-1)!)}`);
  for (const hole of openingHoles(wall, elements)) parts.push(`M ${hole.map(fmt).join(' L ')} Z`);
  return parts.join(' ');
}

/** Remove only the near-face outline where a recorded branch enters the through-wall. */
function outlineWithJunctions(points: Vec2[], wall: LineElement, elements: ElementTable): string {
  const inverse = invert(worldMatrix(elements, wall));
  const branches: { at: Vec2; direction: Vec2; half: number }[] = [];
  for (const id of jointIds(wall, 'body')) {
    const branch = elements[id];
    if (!branch || branch.kind !== 'line' || !branch.visible) continue;
    const matrix = worldMatrix(elements, branch);
    const path = linePoints(branch).map(([x, y]) => applyToPoint(inverse, applyToPoint(matrix, { x, y })));
    for (const end of ['start', 'end'] as const) {
      if (!jointIds(branch, end).includes(wall.id)) continue;
      const at = path[end === 'start' ? 0 : path.length - 1]!;
      const direction = unit(at, path[end === 'start' ? 1 : path.length - 2]!);
      const projection = projectOnLine(wall, at);
      if (direction && projection && projection.distance <= MEET_TOLERANCE) branches.push({ at, direction, half: thicknessOf(branch) / 2 });
    }
  }
  if (branches.length === 0) return `M ${points.map(fmt).join(' L ')}`;
  const result: string[] = [];
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index]!, b = points[index + 1]!;
    const cuts: [number, number][] = [];
    for (const branch of branches) {
      let low = 0, high = 1;
      const n = normal(branch.direction);
      for (const [axis, min, max] of [[n, -branch.half, branch.half], [branch.direction, 0, thicknessOf(wall) * 4]] as const) {
        const origin = (a.x - branch.at.x) * axis.x + (a.y - branch.at.y) * axis.y;
        const slope = (b.x - a.x) * axis.x + (b.y - a.y) * axis.y;
        if (Math.abs(slope) < 1e-9) {
          if (origin < min || origin > max) { low = 1; high = 0; break; }
        } else {
          const first = (min - origin) / slope, last = (max - origin) / slope;
          low = Math.max(low, Math.min(first, last)); high = Math.min(high, Math.max(first, last));
        }
      }
      if (high > low) cuts.push([low, high]);
    }
    const at = (t: number) => fmt({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    let cursor = 0;
    for (const [start, end] of cuts.sort((a, b) => a[0] - b[0])) {
      if (start > cursor) result.push(`M ${at(cursor)} L ${at(start)}`);
      cursor = Math.max(cursor, end);
    }
    if (cursor < 1) result.push(`M ${at(cursor)} L ${at(1)}`);
  }
  return result.join(' ');
}

/** SVG path of one layer boundary (offset from the centre line), broken at openings. */
export function wallLayerPath(wall: LineElement, elements: ElementTable, offset: number): string {
  const line = wallOffsetLine(wall, elements, offset);
  return line.length < 2 ? '' : `M ${line.map(fmt).join(' L ')}`;
}

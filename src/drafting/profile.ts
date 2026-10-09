/**
 * Profile (boundary) drawing mode for floors, ceilings and levels: which board curves belong to
 * the profile being drawn, and the closed loop they make. The curves are ordinary board lines and
 * rectangles (every drafting tool works on them); anything drawn since the mode started counts,
 * plus the sketch line seeded from an existing boundary. Pure.
 */
import type { Element, ElementTable, LineElement } from '@/document';
import type { ProfileEdit, ProfileKind } from '@/store';
import { pointInPolygon } from '@/assets/slabOpenings';
import type { Vec2 } from '@/geometry';
import { elementPath, elementSegments } from './lines';
import { joinPaths, pathEnd, pathStart, samplePath, type Path } from './paths';

/** Ends closer than this (mm) count as joined. */
export const PROFILE_TOLERANCE = 0.5;

/** A plain board curve: a line or rectangle with no architectural or annotation meaning. */
function isSketchCurve(element: Element): boolean {
  if (!element.visible) return false;
  const meta = element.meta ?? {};
  if (element.kind === 'rect') return Object.keys(meta).length === 0;
  if (element.kind !== 'line') return false;
  return !meta['arch'] && !meta['measure'] && !meta['cameraMarker'] && !meta['sectionLine'] && !meta['diagram'];
}

/** The curves of the profile being drawn. */
export function profileMembers(elements: ElementTable, edit: ProfileEdit): Element[] {
  const before = new Set(edit.startIds);
  return Object.values(elements).filter((element) => isSketchCurve(element) && (!before.has(element.id) || Boolean(element.meta?.['profileSketch'])));
}

export interface ProfileLoops {
  members: Element[];
  /** Closed loops the curves make. */
  closed: Path[];
  /** Chains that do not close. */
  open: Path[];
  /** Free ends of curves that do not close. */
  openEnds: Vec2[];
}

/** Joins the profile's curves end to end into loops. */
export function profileLoops(elements: ElementTable, edit: ProfileEdit): ProfileLoops {
  const members = profileMembers(elements, edit);
  const paths: Path[] = [];
  for (const element of members) {
    if (element.kind === 'line') {
      const path = elementPath(elements, element as LineElement);
      if (path.segs.length) paths.push(path);
    } else {
      const segs = elementSegments(elements, element);
      if (segs.length) paths.push({ segs, closed: true });
    }
  }
  const joined = joinPaths(paths, PROFILE_TOLERANCE);
  const closed = joined.filter((path) => path.closed);
  const open = joined.filter((path) => !path.closed);
  const openEnds = open.flatMap((path) => [pathStart(path), pathEnd(path)]);
  return { members, closed, open, openEnds };
}

/** Area of a closed path (mm²). */
export function pathArea(path: Path): number {
  // Finely sampled: curved edges keep the area within a few mm² per metre.
  const points = samplePath(path, 256);
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** The boundary (the largest loop) and the openings inside it. */
export interface ProfileShape {
  outer: Path;
  openings: Path[];
  /** Net area in mm² (the boundary less its openings). */
  area: number;
}

/**
 * Splits the closed loops into the boundary and its openings: the largest loop is the boundary,
 * every other loop must lie inside it and outside the other openings. Levels take no openings.
 * Returns the reason when the loops do not make such a shape.
 */
export function profileShape(loops: ProfileLoops, kind: ProfileKind): ProfileShape | string {
  if (!loops.members.length) return 'Draw the boundary: one closed loop';
  if (loops.openEnds.length) return `The boundary has ${loops.openEnds.length} open end${loops.openEnds.length === 1 ? '' : 's'}: join or trim them into closed loops`;
  if (!loops.closed.length) return 'The boundary has no area';
  if (kind === 'level' && loops.closed.length > 1) return `A level boundary is one closed loop (there are ${loops.closed.length})`;
  const sized = loops.closed.map((path) => ({ path, area: pathArea(path), ring: samplePath(path, 64) })).sort((a, b) => b.area - a.area);
  const [outer, ...holes] = sized;
  if (outer!.area < 1) return 'The boundary has no area';
  for (const hole of holes) {
    const probe = hole.ring[0]!;
    if (!hole.ring.every((point) => pointInPolygon(point, outer!.ring))) return 'Openings must lie inside the boundary';
    if (holes.some((other) => other !== hole && pointInPolygon(probe, other.ring))) return 'Openings cannot overlap or sit inside another opening';
  }
  return { outer: outer!.path, openings: holes.map((hole) => hole.path), area: outer!.area - holes.reduce((sum, hole) => sum + hole.area, 0) };
}

/** What the boundary still needs, or null when the loops make a boundary (with openings). */
export function profileProblem(loops: ProfileLoops, kind: ProfileKind = 'floor'): string | null {
  const shape = profileShape(loops, kind);
  return typeof shape === 'string' ? shape : null;
}

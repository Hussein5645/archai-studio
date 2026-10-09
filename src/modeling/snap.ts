/**
 * 2D snapping for the sketch tools (docs/modeling-tools.md, sketch tools): shape points win
 * within the snap radius, then alignment with the anchor (the previous point) on either axis,
 * then the grid. Shift constrains the direction from the anchor to 45° steps. Pure functions so
 * the tools can be tested with synthetic pointer sequences.
 */
import { shapeContour } from './kernel/sketch';
import type { Shape2D, Vec2 } from './kernel/types';
import { DEFAULT_INFERENCE_SETTINGS, InferenceEngine, type InferenceCandidate } from './inference';
import { parseDimensions } from './measurement';
import { bulgeArc } from './curves';

export interface SnapOptions {
  /** Grid pitch in mm; 0 disables the grid. */
  grid: number;
  /** Snap to points and alignments at all (the grid still applies when on). */
  snap: boolean;
  /** Snap radius in sketch units (converted from pixels by the caller). */
  radius: number;
  /** Points worth snapping to: vertices and centres of the shapes already drawn. */
  points: readonly Vec2[];
  /** Points from project elements or scene solids. */
  projectPoints?: readonly Vec2[];
  /** The previous point of the shape being drawn (alignment and Shift constraint). */
  anchor?: Vec2 | null;
  shift?: boolean;
}

export interface SnapResult {
  point: Vec2;
  /** What the point locked onto, for the marker; null when it is the free (or grid) position. */
  kind: 'point' | 'align' | 'grid' | null;
}

/** Vertices and centres of the shapes: the points the tools snap to. */
export function snapPointsOf(shapes: readonly Shape2D[]): Vec2[] {
  const points: Vec2[] = [];
  for (const shape of shapes) {
    if (shape.kind === 'circle' || shape.kind === 'polygon') points.push([shape.cx, shape.cy]);
    if (shape.kind === 'rect') points.push([shape.x + shape.width / 2, shape.y + shape.height / 2]);
    if (shape.kind === 'circle') {
      points.push([shape.cx + shape.radius, shape.cy], [shape.cx - shape.radius, shape.cy], [shape.cx, shape.cy + shape.radius], [shape.cx, shape.cy - shape.radius]);
      continue;
    }
    for (const point of shapeContour(shape)) points.push(point);
  }
  return points;
}

function roundTo(value: number, pitch: number): number {
  return pitch > 0 ? Math.round(value / pitch) * pitch : value;
}

export function snapPoint(raw: Vec2, options: SnapOptions): SnapResult {
  const { grid, snap, radius, points, projectPoints, anchor, shift } = options;
  let candidate: Vec2 = raw;
  // Shift: lock the direction from the anchor to the nearest 45° and project onto it.
  if (shift && anchor) {
    const dx = raw[0] - anchor[0];
    const dy = raw[1] - anchor[1];
    const length = Math.hypot(dx, dy);
    if (length > 1e-9) {
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      candidate = [anchor[0] + Math.cos(angle) * length, anchor[1] + Math.sin(angle) * length];
    }
  }
  if (snap) {
    const engine = new InferenceEngine({ ...DEFAULT_INFERENCE_SETTINGS, tolerance: radius, grid: false, disabledTypes: {} });
    const allCandidates: InferenceCandidate[] = [
      ...(points ?? []).map<InferenceCandidate>((point) => ({ position: [point[0], point[1], 0], type: 'endpoint', screenDistance: Math.hypot(point[0] - candidate[0], point[1] - candidate[1]), label: 'Endpoint', marker: 'square' })),
      ...(projectPoints ?? []).map<InferenceCandidate>((point) => ({ position: [point[0], point[1], 0], type: 'body-vertex', screenDistance: Math.hypot(point[0] - candidate[0], point[1] - candidate[1]), label: 'Project Element', marker: 'square', priority: 125 })),
    ];
    const ranked = engine.resolve(allCandidates);

    if (ranked) return { point: [ranked.position[0], ranked.position[1]], kind: 'point' };
    if (anchor && !shift) {
      const alignedX = Math.abs(candidate[0] - anchor[0]) < radius;
      const alignedY = Math.abs(candidate[1] - anchor[1]) < radius;
      if (alignedX || alignedY) {
        return { point: [alignedX ? anchor[0] : roundTo(candidate[0], grid), alignedY ? anchor[1] : roundTo(candidate[1], grid)], kind: 'align' };
      }
    }
  }
  if (grid > 0 && !(shift && anchor)) return { point: [roundTo(candidate[0], grid), roundTo(candidate[1], grid)], kind: 'grid' };
  return { point: [candidate[0], candidate[1]], kind: null };
}

/**
 * Parses what the user typed during a drag: "1200x800" / "1200,800" / "1200 800" gives two
 * numbers, "300" one; a leading minus is kept. Returns null for anything else.
 */
export function parseTypedDimensions(text: string): number[] | null {
  // Keep the sketch-tool API while routing all entry through the universal parser.
  if (/^\s*[-+]?\d+(?:\.\d+)?\s+[-+]?\d+(?:\.\d+)?\s*$/i.test(text)) return text.trim().split(/\s+/).map(Number);
  return parseDimensions(text);
}

/** Straight pieces of a shape (arcs tessellated). */
function curveSegments(shape: Shape2D): [Vec2, Vec2][] {
  const contour = shapeContour(shape);
  const open = shape.kind === 'polyline' && shape.closed === false;
  const segments: [Vec2, Vec2][] = [];
  const count = open ? contour.length - 1 : contour.length;
  for (let i = 0; i < count; i++) segments.push([contour[i]!, contour[(i + 1) % contour.length]!]);
  return segments;
}

function candidate(position: Vec2, type: InferenceCandidate['type'], raw: Vec2, label: string, marker: InferenceCandidate['marker'], extra: Partial<InferenceCandidate> = {}): InferenceCandidate {
  return { position: [position[0], position[1], 0], type, screenDistance: Math.hypot(position[0] - raw[0], position[1] - raw[1]), label, marker, ...extra };
}

/**
 * Every snap the sketch curves offer near `raw` (Revit / SketchUp style): end points, midpoints,
 * centres and quadrants, intersections, the nearest point on a curve, and, from the previous point
 * (`anchor`), perpendicular feet, tangent points on circles and extensions of lines past their ends.
 * Distances are in sketch units; the inference engine ranks and filters them by the snap radius.
 */
export function curveSnapCandidates(shapes: readonly Shape2D[], raw: Vec2, anchor: Vec2 | null, radius: number): InferenceCandidate[] {
  const out: InferenceCandidate[] = [];
  const near = (a: Vec2, b: Vec2, margin: number) => Math.min(a[0], b[0]) - margin <= raw[0] && raw[0] <= Math.max(a[0], b[0]) + margin && Math.min(a[1], b[1]) - margin <= raw[1] && raw[1] <= Math.max(a[1], b[1]) + margin;
  const nearby: { shape: number; a: Vec2; b: Vec2 }[] = [];
  shapes.forEach((shape, index) => {
    // Centres and quadrants.
    if (shape.kind === 'circle') {
      out.push(candidate([shape.cx, shape.cy], 'center', raw, 'Centre', 'circle'));
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) out.push(candidate([shape.cx + dx * shape.radius, shape.cy + dy * shape.radius], 'quadrant', raw, 'Quadrant', 'circle'));
    } else if (shape.kind === 'polygon') out.push(candidate([shape.cx, shape.cy], 'center', raw, 'Centre', 'circle'));
    else if (shape.kind === 'rect') out.push(candidate([shape.x + shape.width / 2, shape.y + shape.height / 2], 'center', raw, 'Centre', 'circle'));
    // Vertices: a polyline's own points (arc ends count, tessellation points do not).
    const vertices: Vec2[] = shape.kind === 'polyline' ? shape.points : shape.kind === 'circle' ? [] : shapeContour(shape);
    for (const vertex of vertices) out.push(candidate(vertex, 'endpoint', raw, 'Endpoint', 'square'));
    // Midpoints of the drawn segments (for arcs, the middle of the arc).
    if (shape.kind === 'polyline') {
      const count = shape.closed === false ? shape.points.length - 1 : shape.points.length;
      for (let i = 0; i < count; i++) {
        const a = shape.points[i]!;
        const b = shape.points[(i + 1) % shape.points.length]!;
        const bulge = shape.bulges?.[i] ?? 0;
        const handle = shape.handles?.[i];
        const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (handle) {
          // The middle of a Bézier segment (t = 0.5).
          mid[0] = (a[0] + 3 * handle[0][0] + 3 * handle[1][0] + b[0]) / 8;
          mid[1] = (a[1] + 3 * handle[0][1] + 3 * handle[1][1] + b[1]) / 8;
        } else if (bulge) {
          // Arcs also offer their centre.
          out.push(candidate(bulgeArc(a, b, bulge).c, 'center', raw, 'Arc centre', 'circle'));
          const chord = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          const sagitta = (bulge * chord) / 2;
          // A positive bulge swings to the right of the chord direction.
          mid[0] += ((b[1] - a[1]) / chord) * sagitta;
          mid[1] -= ((b[0] - a[0]) / chord) * sagitta;
        }
        out.push(candidate(mid, 'midpoint', raw, 'Midpoint', 'triangle'));
      }
    } else if (shape.kind === 'rect' || shape.kind === 'polygon') {
      const contour = shapeContour(shape);
      contour.forEach((a, i) => {
        const b = contour[(i + 1) % contour.length]!;
        out.push(candidate([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], 'midpoint', raw, 'Midpoint', 'triangle'));
      });
    }
    const straight = shape.kind === 'polyline' && !shape.bulges?.some((bulge) => bulge);
    for (const [a, b] of curveSegments(shape)) {
      if (near(a, b, radius)) nearby.push({ shape: index, a, b });
      if (!straight) continue;
      // Extension of a straight line past its ends.
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length2 = dx * dx + dy * dy;
      if (length2 < 1e-12) continue;
      const t = ((raw[0] - a[0]) * dx + (raw[1] - a[1]) * dy) / length2;
      if (t > 1 || t < 0) {
        const foot: Vec2 = [a[0] + dx * t, a[1] + dy * t];
        if (Math.hypot(foot[0] - raw[0], foot[1] - raw[1]) <= radius) out.push(candidate(foot, 'extension', raw, 'Extension', 'line', { direction: [dx, dy, 0] }));
      }
    }
  });
  // Nearest points, perpendicular feet and intersections among segments close to the pointer.
  for (let i = 0; i < nearby.length; i++) {
    const { a, b } = nearby[i]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length2 = dx * dx + dy * dy;
    if (length2 > 1e-12) {
      const t = Math.max(0, Math.min(1, ((raw[0] - a[0]) * dx + (raw[1] - a[1]) * dy) / length2));
      out.push(candidate([a[0] + dx * t, a[1] + dy * t], 'point-on-edge', raw, 'On curve', 'diamond'));
      if (anchor) {
        const u = ((anchor[0] - a[0]) * dx + (anchor[1] - a[1]) * dy) / length2;
        if (u >= 0 && u <= 1) out.push(candidate([a[0] + dx * u, a[1] + dy * u], 'perpendicular', raw, 'Perpendicular', 'line'));
      }
    }
    for (let j = i + 1; j < nearby.length; j++) {
      const other = nearby[j]!;
      const ex = other.b[0] - other.a[0];
      const ey = other.b[1] - other.a[1];
      const denom = dx * ey - dy * ex;
      if (Math.abs(denom) < 1e-12) continue;
      const s = ((other.a[0] - a[0]) * ey - (other.a[1] - a[1]) * ex) / denom;
      const r = ((other.a[0] - a[0]) * dy - (other.a[1] - a[1]) * dx) / denom;
      if (s < -1e-9 || s > 1 + 1e-9 || r < -1e-9 || r > 1 + 1e-9) continue;
      const point: Vec2 = [a[0] + dx * s, a[1] + dy * s];
      // Neighbouring segments of one curve meet at a vertex, which is already an end point.
      if (other.shape === nearby[i]!.shape && [a, b].some((p) => Math.hypot(p[0] - point[0], p[1] - point[1]) < 1e-9)) continue;
      out.push(candidate(point, 'edge-intersection', raw, 'Intersection', 'cross'));
    }
  }
  // Tangent points on circles from the previous point.
  if (anchor) {
    for (const shape of shapes) {
      if (shape.kind !== 'circle') continue;
      const cx = anchor[0] - shape.cx;
      const cy = anchor[1] - shape.cy;
      const d = Math.hypot(cx, cy);
      if (d <= shape.radius) continue;
      const base = Math.atan2(cy, cx);
      const spread = Math.acos(shape.radius / d);
      for (const angle of [base + spread, base - spread]) out.push(candidate([shape.cx + Math.cos(angle) * shape.radius, shape.cy + Math.sin(angle) * shape.radius], 'tangent', raw, 'Tangent', 'circle'));
    }
  }
  return out;
}

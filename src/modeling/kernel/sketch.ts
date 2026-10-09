/**
 * Sketch geometry: the frame of each sketch plane (sketch (u, v) ↔ world), the outline of every
 * shape as a contour (arcs tessellated), and the sketch's closed region as a Manifold
 * `CrossSection` (shapes fully inside another shape become holes, overlapping shapes merge,
 * shape offsets and the corner radius applied). Pure: shared by the worker, the tools and the
 * scene overlay.
 */
import type { CrossSection, Mat4, ManifoldToplevel } from 'manifold-3d';
import { arrange, pickedFaces, type ArrangementCurve, type SketchArrangement } from './regions';
import { circleSegments, type PlaneId, type Shape2D, type Sketch, type SketchPlane, type Vec2, type Vec3 } from './types';

export interface PlaneFrame {
  origin: Vec3;
  /** World direction of sketch +u (right on screen in the 2D pane). */
  u: Vec3;
  /** World direction of sketch +v (up on screen). */
  v: Vec3;
  /** Plane normal; positive extrude distances go this way. */
  normal: Vec3;
}

/** The world axis each view plane slides along (mirrors PLANE_AXIS in the store). */
const AXIS: Record<PlaneId, 0 | 1 | 2> = { top: 1, front: 2, side: 0 };

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function normalize(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
}

/**
 * Frames match the 2D panes: top looks down -Y with -Z up on screen (plan "up"), front looks
 * down -Z with Y up, side looks down -X with Y up (so screen right is -Z). All right-handed.
 * A custom plane uses its own axes (`xAxis` is made perpendicular to the normal).
 */
export function planeFrame(plane: SketchPlane): PlaneFrame {
  if (plane.kind === 'custom') {
    const normal = normalize(plane.normal);
    const along = dot(plane.xAxis, normal);
    const u = normalize([plane.xAxis[0] - normal[0] * along, plane.xAxis[1] - normal[1] * along, plane.xAxis[2] - normal[2] * along]);
    return { origin: plane.origin, u, v: cross(normal, u), normal };
  }
  const origin: Vec3 = [0, 0, 0];
  origin[AXIS[plane.id]] = plane.offset;
  switch (plane.id) {
    case 'top':
      return { origin, u: [1, 0, 0], v: [0, 0, -1], normal: [0, 1, 0] };
    case 'front':
      return { origin, u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] };
    case 'side':
      return { origin, u: [0, 0, -1], v: [0, 1, 0], normal: [1, 0, 0] };
  }
}

export function toWorld(plane: SketchPlane, [u, v]: Vec2, along = 0): Vec3 {
  const frame = planeFrame(plane);
  return [0, 1, 2].map((i) => frame.origin[i]! + frame.u[i]! * u + frame.v[i]! * v + frame.normal[i]! * along) as Vec3;
}

/** A sketch direction as a world direction. */
export function toWorldDirection(plane: SketchPlane, [u, v]: Vec2): Vec3 {
  const frame = planeFrame(plane);
  return [0, 1, 2].map((i) => frame.u[i]! * u + frame.v[i]! * v) as Vec3;
}

/** Projects a world point onto the plane's (u, v); the distance along the normal is dropped. */
export function toPlane(plane: SketchPlane, point: Vec3): Vec2 {
  const frame = planeFrame(plane);
  const d: Vec3 = [point[0] - frame.origin[0], point[1] - frame.origin[1], point[2] - frame.origin[2]];
  return [dot(d, frame.u), dot(d, frame.v)];
}

/** Column-major matrix taking sketch space (u, v, along-normal) to world space. */
export function planeMatrix(plane: SketchPlane): Mat4 {
  const { origin, u, v, normal } = planeFrame(plane);
  return frameMatrix(origin, u, v, normal);
}

export function frameMatrix(origin: Vec3, x: Vec3, y: Vec3, z: Vec3): Mat4 {
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, origin[0], origin[1], origin[2], 1];
}

export function samePlane(a: SketchPlane, b: SketchPlane): boolean {
  if (a.kind === 'plane' && b.kind === 'plane') return a.id === b.id && Math.abs(a.offset - b.offset) < 1e-6;
  if (a.kind === 'custom' && b.kind === 'custom') {
    const near = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-6;
    return near(a.origin, b.origin) && near(a.normal, b.normal) && near(a.xAxis, b.xAxis);
  }
  return false;
}

export function planeLabel(plane: SketchPlane): string {
  return plane.kind === 'plane' ? `${plane.id} ${Math.round(plane.offset)}` : 'face';
}

/** Points along an arc from `from` to `to` with the given bulge (excluding `from`, including `to`). */
export function arcPoints(from: Vec2, to: Vec2, bulge: number): Vec2[] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-9 || Math.abs(bulge) < 1e-9) return [to];
  const theta = 4 * Math.atan(bulge);
  const radius = (chord * (1 + bulge * bulge)) / (4 * bulge);
  const sagitta = (bulge * chord) / 2;
  const nx = -dy / chord;
  const ny = dx / chord;
  const mx = (from[0] + to[0]) / 2;
  const my = (from[1] + to[1]) / 2;
  // A counter-clockwise arc (positive bulge) swings to the right of the chord direction, so its
  // midpoint sits `sagitta` to the right and the centre `radius` back from it (to the left).
  const cx = mx + nx * (radius - sagitta);
  const cy = my + ny * (radius - sagitta);
  const start = Math.atan2(from[1] - cy, from[0] - cx);
  const segments = Math.max(2, Math.ceil((Math.abs(theta) / (Math.PI * 2)) * circleSegments(Math.abs(radius) * 2)));
  const points: Vec2[] = [];
  for (let i = 1; i <= segments; i++) {
    const angle = start + (theta * i) / segments;
    points.push(i === segments ? to : [cx + Math.cos(angle) * Math.abs(radius), cy + Math.sin(angle) * Math.abs(radius)]);
  }
  return points;
}

/**
 * The bulge of an arc from `from` to `to` passing through `through` (0 when collinear). A point
 * to the right of the chord direction gives a counter-clockwise arc (positive bulge).
 */
export function bulgeThrough(from: Vec2, to: Vec2, through: Vec2): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-9) return 0;
  // Signed distance of the through point from the chord (positive on the left).
  const sag = ((through[0] - from[0]) * -dy + (through[1] - from[1]) * dx) / chord;
  const along = ((through[0] - from[0]) * dx + (through[1] - from[1]) * dy) / chord;
  if (Math.abs(sag) < 1e-9) return 0;
  // Circle through the three points, in chord space (x along the chord, y to its left): the
  // centre is at (c, d) with |P - C| = |A - C|.
  const c = chord / 2;
  const t = along - c;
  const d = (t * t + sag * sag - c * c) / (2 * sag);
  // A centre on the far side of the chord from P means a minor arc (half angle below 90°).
  const away = -d * Math.sign(sag);
  const half = Math.atan2(c, away);
  return Math.tan(half / 2) * (sag < 0 ? 1 : -1);
}

/** The shape's outline as a counter-clockwise contour (closing edge implied; arcs tessellated). */
export function shapeContour(shape: Shape2D): Vec2[] {
  switch (shape.kind) {
    case 'rect': {
      const x0 = Math.min(shape.x, shape.x + shape.width);
      const x1 = Math.max(shape.x, shape.x + shape.width);
      const y0 = Math.min(shape.y, shape.y + shape.height);
      const y1 = Math.max(shape.y, shape.y + shape.height);
      return [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ];
    }
    case 'circle':
      return ring(shape.cx, shape.cy, shape.radius, circleSegments(shape.radius * 2), 0);
    case 'polygon':
      return ring(shape.cx, shape.cy, shape.radius, Math.max(3, Math.round(shape.sides)), shape.rotation);
    case 'polyline': {
      const points = polylinePoints(shape.points, shape.bulges, shape.closed !== false, shape.handles);
      if (shape.closed === false) return points;
      return signedArea(points) < 0 ? points.reverse() : points;
    }
  }
}

/**
 * A polyline's vertices with its arc and Bézier segments tessellated (closed: the last segment
 * returns to the first point).
 */
export function polylinePoints(points: readonly Vec2[], bulges?: readonly number[], closed = true, handles?: readonly (readonly [Vec2, Vec2] | null)[]): Vec2[] {
  if ((!bulges || bulges.every((bulge) => !bulge)) && (!handles || handles.every((handle) => !handle))) {
    // An open polyline keeps its last point; a closed one implies the closing segment.
    return [...points];
  }
  const result: Vec2[] = [];
  const segments = closed ? points.length : Math.max(0, points.length - 1);
  for (let i = 0; i < segments; i++) {
    const from = points[i]!;
    const to = points[(i + 1) % points.length]!;
    result.push(from);
    const handle = handles?.[i];
    if (handle) {
      const [c1, c2] = handle;
      const steps = Math.max(8, Math.min(48, Math.ceil((Math.hypot(c1[0] - from[0], c1[1] - from[1]) + Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) + Math.hypot(to[0] - c2[0], to[1] - c2[1])) / 20)));
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        const u = 1 - t;
        result.push([
          u * u * u * from[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * to[0],
          u * u * u * from[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * to[1],
        ]);
      }
      continue;
    }
    const bulge = bulges?.[i] ?? 0;
    if (bulge) {
      const arc = arcPoints(from, to, bulge);
      arc.pop();
      result.push(...arc);
    }
  }
  // An open curve ends on its last point (the loop only adds each segment's start).
  if (!closed && points.length > 1) result.push(points[points.length - 1]!);
  return result;
}

const LOOP_TOLERANCE = 1e-4;

function nearPoint(a: Vec2, b: Vec2, tolerance = LOOP_TOLERANCE): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance;
}

/** Result used by Select's loop inspection and by the kernel when open line shapes form a ring. */
export interface LineLoopCheck {
  shapeIds: string[];
  closed: boolean;
  openings: Vec2[];
  contour: Vec2[];
}

/**
 * Follows the connected open-line component containing `seedId`. Endpoints with anything other
 * than two incident chains are reported as openings/junctions. A valid result has real area, so
 * doubled or backtracking lines are not advertised as extrudable.
 */
export function checkLineLoop(shapes: readonly Shape2D[], seedId: string): LineLoopCheck | null {
  const lines = shapes.filter((shape): shape is Extract<Shape2D, { kind: 'polyline' }> => shape.kind === 'polyline' && shape.closed === false && shape.points.length >= 2);
  const seed = lines.find((shape) => shape.id === seedId);
  if (!seed) {
    const closed = shapes.find((shape) => shape.id === seedId && shapeIsValid(shape) && !(shape.kind === 'polyline' && shape.closed === false));
    return closed ? { shapeIds: [closed.id], closed: true, openings: [], contour: shapeContour(closed) } : null;
  }

  const component: typeof lines = [];
  const queued = [seed];
  const seen = new Set<string>();
  while (queued.length) {
    const line = queued.shift()!;
    if (seen.has(line.id)) continue;
    seen.add(line.id);
    component.push(line);
    const ends = [line.points[0]!, line.points[line.points.length - 1]!];
    for (const candidate of lines) {
      if (seen.has(candidate.id)) continue;
      const candidateEnds = [candidate.points[0]!, candidate.points[candidate.points.length - 1]!];
      if (ends.some((end) => candidateEnds.some((other) => nearPoint(end, other)))) queued.push(candidate);
    }
  }

  const nodes: { point: Vec2; degree: number }[] = [];
  const nodeFor = (point: Vec2) => {
    let node = nodes.find((entry) => nearPoint(entry.point, point));
    if (!node) {
      node = { point, degree: 0 };
      nodes.push(node);
    }
    return node;
  };
  for (const line of component) {
    nodeFor(line.points[0]!).degree++;
    nodeFor(line.points[line.points.length - 1]!).degree++;
  }
  const openings = nodes.filter((node) => node.degree !== 2).map((node) => node.point);

  const unused = new Map(component.map((line) => [line.id, line]));
  const first = component[0]!;
  const contour = polylinePoints(first.points, first.bulges, false, first.handles);
  const orderedIds = [first.id];
  unused.delete(first.id);
  let cursor = contour[contour.length - 1]!;
  while (unused.size) {
    const next = [...unused.values()].find((line) => nearPoint(line.points[0]!, cursor) || nearPoint(line.points[line.points.length - 1]!, cursor));
    if (!next) break;
    let points = polylinePoints(next.points, next.bulges, false, next.handles);
    if (!nearPoint(points[0]!, cursor)) points = [...points].reverse();
    contour.push(...points.slice(1));
    cursor = contour[contour.length - 1]!;
    orderedIds.push(next.id);
    unused.delete(next.id);
  }
  if (contour.length > 1 && nearPoint(contour[0]!, contour[contour.length - 1]!)) contour.pop();
  const closed = openings.length === 0 && unused.size === 0 && contour.length >= 3 && Math.abs(signedArea(contour)) > 1e-6;
  // If not all lines were used in the chain, include remaining component ids
  for (const line of component) {
    if (!orderedIds.includes(line.id)) orderedIds.push(line.id);
  }
  return { shapeIds: orderedIds, closed, openings, contour };
}

/** Every disjoint loop assembled from individual open line shapes, once each. */
export function stitchedLineLoops(shapes: readonly Shape2D[]): LineLoopCheck[] {
  const used = new Set<string>();
  const loops: LineLoopCheck[] = [];
  for (const shape of shapes) {
    if (shape.kind !== 'polyline' || shape.closed !== false || used.has(shape.id)) continue;
    const check = checkLineLoop(shapes, shape.id);
    if (!check) continue;
    check.shapeIds.forEach((id) => used.add(id));
    if (check.closed) loops.push(check);
  }
  return loops;
}

function ring(cx: number, cy: number, radius: number, segments: number, rotationDeg: number): Vec2[] {
  const points: Vec2[] = [];
  const start = (rotationDeg * Math.PI) / 180;
  for (let i = 0; i < segments; i++) {
    const angle = start + (i / segments) * Math.PI * 2;
    points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
  }
  return points;
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

/** A shape is drawable when it encloses some area. */
export function shapeIsValid(shape: Shape2D): boolean {
  switch (shape.kind) {
    case 'rect':
      return Math.abs(shape.width) > 1e-6 && Math.abs(shape.height) > 1e-6;
    case 'circle':
    case 'polygon':
      return shape.radius > 1e-6;
    case 'polyline':
      return shape.closed === false ? shape.points.length >= 2 : shape.points.length >= 3 && Math.abs(signedArea(shapeContour(shape))) > 1e-6;
  }
}

/** Axis-aligned bounds of the shapes, or null for an empty sketch. */
export function shapesBounds(shapes: readonly Shape2D[]): { min: Vec2; max: Vec2 } | null {
  let bounds: { min: Vec2; max: Vec2 } | null = null;
  for (const shape of shapes) {
    for (const [x, y] of shapeContour(shape)) {
      if (!bounds) bounds = { min: [x, y], max: [x, y] };
      else {
        bounds.min = [Math.min(bounds.min[0], x), Math.min(bounds.min[1], y)];
        bounds.max = [Math.max(bounds.max[0], x), Math.max(bounds.max[1], y)];
      }
    }
  }
  return bounds;
}

/** Moves a shape by (dx, dy). */
export function translateShape(shape: Shape2D, dx: number, dy: number): Shape2D {
  switch (shape.kind) {
    case 'rect':
      return { ...shape, x: shape.x + dx, y: shape.y + dy };
    case 'circle':
    case 'polygon':
      return { ...shape, cx: shape.cx + dx, cy: shape.cy + dy };
    case 'polyline':
      return {
        ...shape,
        points: shape.points.map(([x, y]) => [x + dx, y + dy] as Vec2),
        ...(shape.handles ? { handles: shape.handles.map((handle) => (handle ? (handle.map(([x, y]) => [x + dx, y + dy]) as [Vec2, Vec2]) : null)) } : {}),
      };
  }
}

/**
 * Douglas–Peucker simplification of a stroke: keeps the endpoints and every point further than
 * `tolerance` from the simplified line.
 */
export function simplifyStroke(points: readonly Vec2[], tolerance: number): Vec2[] {
  if (points.length <= 2) return [...points];
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    const a = points[start]!;
    const b = points[end]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = start + 1; i < end; i++) {
      const p = points[i]!;
      const distance = length < 1e-9 ? Math.hypot(p[0] - a[0], p[1] - a[1]) : Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / length;
      if (distance > worstDistance) {
        worst = i;
        worstDistance = distance;
      }
    }
    if (worst >= 0) {
      keep[worst] = true;
      stack.push([start, worst], [worst, end]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

/** One shape as a cross-section, with its offset (round joins) applied. */
function shapeSection(wasm: ManifoldToplevel, shape: Shape2D): CrossSection {
  const { CrossSection } = wasm;
  const piece: CrossSection = new CrossSection([shapeContour(shape)], 'Positive');
  if (!shape.offset) return piece;
  const grown: CrossSection = piece.offset(shape.offset, 'Round', 2, circleSegments(Math.abs(shape.offset) * 2));
  piece.delete();
  return grown;
}

/**
 * The input curves of a sketch's arrangement: closed shapes as rings, open polylines as chains.
 * `offsetContours` supplies the grown / shrunk outline of shapes with an offset (the kernel
 * computes it with Manifold); without it the drawn outline is used (overlay previews).
 */
export function sketchCurves(shapes: readonly Shape2D[], offsetContours?: (shape: Shape2D) => Vec2[][]): ArrangementCurve[] {
  const curves: ArrangementCurve[] = [];
  for (const shape of shapes) {
    if (!shapeIsValid(shape)) continue;
    const open = shape.kind === 'polyline' && shape.closed === false;
    if (open) {
      curves.push({ shapeId: shape.id, points: polylinePoints(shape.points, shape.bulges, false, shape.handles), closed: false });
      continue;
    }
    if (shape.offset && offsetContours) {
      for (const contour of offsetContours(shape)) curves.push({ shapeId: shape.id, points: contour, closed: true });
      continue;
    }
    curves.push({ shapeId: shape.id, points: shapeContour(shape), closed: true });
  }
  return curves;
}

/** The planar arrangement of a sketch's shapes (see ./regions.ts), without offsets applied. */
export function arrangeSketch(shapes: readonly Shape2D[]): SketchArrangement {
  return arrange(sketchCurves(shapes));
}

/**
 * The sketch's region, from the planar arrangement of its curves (./regions.ts): curves that
 * touch or cross merge into one network whose closed faces are solid; a network inside another
 * network's face is an opening, one inside that an island again. Dangling lines are ignored.
 * `seeds` picks particular faces instead (points inside them, as stored on the feature). The
 * corner radius rounds convex corners at the end. Returns an empty cross-section for a sketch
 * without a closed region.
 */
export function sketchRegion(wasm: ManifoldToplevel, sketch: Sketch, seeds?: readonly Vec2[]): CrossSection {
  const { CrossSection } = wasm;
  const offsetContours = (shape: Shape2D): Vec2[][] => {
    const section = shapeSection(wasm, shape);
    const polygons = section.toPolygons().map((polygon) => polygon.map((point) => [point[0], point[1]] as Vec2));
    section.delete();
    return polygons;
  };
  const arrangement = arrange(sketchCurves(sketch.shapes, offsetContours));
  const pieces: CrossSection[] = [];
  for (const face of pickedFaces(arrangement.faces, seeds)) {
    let piece: CrossSection = new CrossSection([face.outer], 'Positive');
    for (const hole of face.holes) {
      const cutter: CrossSection = new CrossSection([hole], 'Positive');
      const next: CrossSection = piece.subtract(cutter);
      cutter.delete();
      piece.delete();
      piece = next;
    }
    pieces.push(piece);
  }
  let region: CrossSection | null = null;
  if (pieces.length === 1) region = pieces[0]!;
  else if (pieces.length > 1) {
    region = CrossSection.union(pieces);
    pieces.forEach((piece) => piece.delete());
  }
  // A zero-size square is Manifold's way of spelling an empty cross-section.
  if (!region) return CrossSection.square([0, 0]);
  const radius = sketch.cornerRadius ?? 0;
  if (radius > 0 && !region.isEmpty()) {
    // Shrinking then growing with round joins rounds every convex corner (docs §7.3).
    const segments = circleSegments(radius * 2);
    const shrunk: CrossSection = region.offset(-radius, 'Round', 2, segments);
    const rounded: CrossSection = shrunk.offset(radius, 'Round', 2, segments);
    shrunk.delete();
    region.delete();
    return rounded;
  }
  return region;
}

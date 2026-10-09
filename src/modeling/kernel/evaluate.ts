/**
 * Turns a body's feature list into a Manifold solid, feature by feature, in the body's local
 * frame (the body placement is applied by the scene, not baked in). Pure TypeScript over the
 * Manifold WASM API: no three.js, no DOM, so it runs in the worker and in Node tests.
 *
 * Each intermediate result is memoised by the hash of the feature chain up to it, so editing
 * the last feature re-runs only the last feature (docs/modeling-tools.md §4).
 */
import type { CrossSection, Manifold, ManifoldToplevel, Vec3 as MVec3 } from 'manifold-3d';
import { cross, dot, frameMatrix, planeFrame, planeMatrix, shapeContour, sketchRegion, toPlane, toWorld, toWorldDirection } from './sketch';
import { circleSegments, type Body, type CurveRef, type DirectEdit, type EvaluationContext, type Extrude, type FaceMaterial, type Feature, type Mirror, type Pattern, type Placement, type Primitive, type Revolve, type Smooth, type Sweep, type Transform, type Vec3 } from './types';

export class FeatureError extends Error {
  constructor(
    readonly featureId: string,
    message: string,
  ) {
    super(message);
  }
}

interface Entry {
  manifold: Manifold;
  /** Manifold original id → feature id, for the triangle runs of the output mesh. */
  originals: Map<number, string>;
  /** Face material overrides in effect after this feature (later features win). */
  faceMaterials: FaceMaterial[];
}

export interface Evaluated {
  manifold: Manifold;
  originals: Map<number, string>;
  faceMaterials: FaceMaterial[];
}

const NO_FACES: FaceMaterial[] = [];

/** Cheap, stable string hash (FNV-1a) for cache keys; collisions only cost a wrong cache hit. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + text.length.toString(36);
}

/**
 * Sketch ids a feature reads directly (its profile, plus a sweep's path or a revolve's axis
 * sketch), or the tool body id a boolean reads. Exported so BodyRuntime's change-detection cache
 * can tell what a body actually depends on without re-deriving this from scratch.
 */
export function featureDependencyIds(feature: Feature): { profile?: string; driver?: string; tool?: string } {
  if (feature.kind === 'extrude' || feature.kind === 'revolve' || feature.kind === 'sweep') {
    const driver = feature.kind === 'sweep' ? feature.path.sketchId : feature.kind === 'revolve' && feature.axisRef ? feature.axisRef.sketchId : undefined;
    return { profile: feature.profile, driver };
  }
  if (feature.kind === 'boolean') return { tool: feature.tool };
  return {};
}

/**
 * Everything outside the feature that its result depends on: the sketch it reads (and the body
 * placement, which world-space sketches are brought into), or the tool body's whole recipe.
 */
function featureInputs(feature: Feature, body: Body, context: EvaluationContext, seen: Set<string>): string {
  const deps = featureDependencyIds(feature);
  if (deps.profile !== undefined) {
    const driver = deps.driver !== undefined ? context.sketches[deps.driver] : null;
    return JSON.stringify(context.sketches[deps.profile] ?? null) + JSON.stringify(driver) + JSON.stringify(body.placement);
  }
  if (deps.tool !== undefined) {
    const tool = context.bodies?.[deps.tool];
    return (tool ? recipeSignature(tool, context, seen) : 'missing') + JSON.stringify(body.placement);
  }
  return '';
}

/**
 * A string that changes whenever the body's evaluation would: its features, its placement
 * where sketch-based features read it, the sketches it uses and the recipes of its tool bodies.
 */
export function recipeSignature(body: Body, context: EvaluationContext, seen = new Set<string>()): string {
  if (seen.has(body.id)) return `cycle:${body.id}`;
  seen.add(body.id);
  const parts = body.features.map((feature) => JSON.stringify(feature) + featureInputs(feature, body, context, seen));
  seen.delete(body.id);
  return JSON.stringify(body.placement) + '|' + parts.join('|');
}

/** The chain key also covers what the feature reads from outside the body. */
function featureKey(previous: string, feature: Feature, body: Body, context: EvaluationContext): string {
  return hash(previous + '|' + JSON.stringify(feature) + featureInputs(feature, body, context, new Set([body.id])));
}

/** Memoised intermediate results per body; prune after every evaluation to free WASM memory. */
export class KernelCache {
  private readonly bodies = new Map<string, Map<string, Entry>>();

  get(bodyId: string, key: string): Entry | undefined {
    return this.bodies.get(bodyId)?.get(key);
  }

  set(bodyId: string, key: string, entry: Entry): void {
    let entries = this.bodies.get(bodyId);
    if (!entries) {
      entries = new Map();
      this.bodies.set(bodyId, entries);
    }
    entries.set(key, entry);
  }

  /** Drops (and deletes) every entry of the body that the latest evaluation did not touch. */
  prune(bodyId: string, keep: Set<string>): void {
    const entries = this.bodies.get(bodyId);
    if (!entries) return;
    for (const [key, entry] of entries) {
      if (keep.has(key)) continue;
      entry.manifold.delete();
      entries.delete(key);
    }
  }

  drop(bodyId: string): void {
    this.prune(bodyId, new Set());
    this.bodies.delete(bodyId);
  }
}

/** Replaces an intermediate solid with its successor, freeing the WASM handle. */
function step(previous: Manifold, next: Manifold): Manifold {
  previous.delete();
  return next;
}

function assertSize(feature: Feature, size: Vec3): void {
  if (size.some((value) => !Number.isFinite(value) || value <= 0)) throw new FeatureError(feature.id, 'Every dimension must be greater than zero');
}

/** Builds the primitive resting on Y = 0, centred in plan, then applies its own placement. */
function primitive(wasm: ManifoldToplevel, feature: Primitive): Manifold {
  const { Manifold } = wasm;
  const [w, h, d] = feature.size;
  assertSize(feature, feature.size);
  const segments = feature.segments ?? circleSegments(w);
  let solid: Manifold;
  switch (feature.shape) {
    case 'box':
      solid = Manifold.cube([w, h, d], false);
      solid = step(solid, solid.translate([-w / 2, 0, -d / 2]));
      break;
    case 'cylinder':
      // Manifold's cylinder grows along Z; turn it upright (Z → Y) so it stands on the ground.
      solid = Manifold.cylinder(h, w / 2, w / 2, segments, false);
      solid = step(solid, solid.rotate([-90, 0, 0]));
      break;
    case 'cone':
      solid = Manifold.cylinder(h, w / 2, 0, segments, false);
      solid = step(solid, solid.rotate([-90, 0, 0]));
      break;
    case 'sphere':
      solid = Manifold.sphere(w / 2, segments);
      solid = step(solid, solid.translate([0, w / 2, 0]));
      break;
  }
  return placed(solid, feature.placement.rotation, feature.placement.position);
}

/** Applies a rotation then a translation, freeing the intermediate handles. */
function placed(solid: Manifold, rotation: Vec3, position: Vec3): Manifold {
  let result = solid;
  if (rotation.some((value) => value !== 0)) result = step(result, result.rotate(rotation as MVec3));
  if (position.some((value) => value !== 0)) result = step(result, result.translate(position as MVec3));
  return result;
}

function transform(feature: Transform, input: Manifold): Manifold {
  // `input` belongs to the cache and must survive; only the handles made here are freed.
  let result = input;
  const next = (value: Manifold) => (result = result === input ? value : step(result, value));
  if (feature.scale !== undefined) {
    const scale = typeof feature.scale === 'number' ? [feature.scale, feature.scale, feature.scale] : feature.scale;
    if (scale.some((value) => !Number.isFinite(value) || value === 0)) throw new FeatureError(feature.id, 'Scale must not be zero');
    next(result.scale(scale as MVec3));
  }
  if (feature.rotate) next(result.rotate(feature.rotate as MVec3));
  if (feature.translate) next(result.translate(feature.translate as MVec3));
  if (result === input) next(input.translate([0, 0, 0]));
  return result;
}

/** Moves all manifold vertices coincident with the picked vertex/edge endpoints. */
function directEdit(feature: DirectEdit, input: Manifold): Manifold {
  const tolerance = Math.max(feature.tolerance ?? 1e-3, 1e-6);
  const tolerance2 = tolerance * tolerance;
  const [dx, dy, dz] = feature.delta;
  if (![dx, dy, dz].every(Number.isFinite)) throw new FeatureError(feature.id, 'The direct-edit movement is invalid');
  return input.warp((vertex) => {
    const matches = feature.points.some((point) => {
      const x = vertex[0] - point[0];
      const y = vertex[1] - point[1];
      const z = vertex[2] - point[2];
      return x * x + y * y + z * z <= tolerance2;
    });
    if (!matches) return;
    vertex[0] += dx;
    vertex[1] += dy;
    vertex[2] += dz;
  });
}

/**
 * The prism of an extrude in world space: the sketch region pushed along the plane normal
 * (negative distances go the other way, symmetric ones straddle the plane).
 */
function extrudePrism(wasm: ManifoldToplevel, feature: Extrude, context: EvaluationContext): Manifold {
  const sketch = context.sketches[feature.profile];
  if (!sketch) throw new FeatureError(feature.id, 'The sketch this extrude uses no longer exists');
  if (!Number.isFinite(feature.distance) || Math.abs(feature.distance) < 1e-6) throw new FeatureError(feature.id, 'The extrude distance must not be zero');
  const source = filteredSketch(sketch, feature.profileShapes);
  const region = feature.surface ? openCurveRegion(wasm, source) : sketchRegion(wasm, source, feature.regions);
  try {
    if (region.isEmpty()) throw new FeatureError(feature.id, `${sketch.name} has no closed region to extrude`);
    const length = Math.abs(feature.distance);
    let prism = region.extrude(length);
    const shift = feature.symmetric ? -length / 2 : feature.distance < 0 ? -length : 0;
    if (shift !== 0) prism = step(prism, prism.translate([0, 0, shift]));
    return step(prism, prism.transform(planeMatrix(sketch.plane)));
  } finally {
    region.delete();
  }
}

/** Manifold is a solid kernel; represent an open-curve surface as a 0.05 mm selectable ribbon. */
function openCurveRegion(wasm: ManifoldToplevel, sketch: import('./types').Sketch): CrossSection {
  const strips: CrossSection[] = [];
  for (const shape of sketch.shapes) {
    const points = shapeContour(shape);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (length < 1e-6) continue;
      const strip = wasm.CrossSection.square([length, 0.05], true).rotate((Math.atan2(dy, dx) * 180) / Math.PI).translate([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      strips.push(strip);
    }
  }
  if (strips.length === 0) return wasm.CrossSection.square([0, 0]);
  const result = strips.length === 1 ? strips[0]! : wasm.CrossSection.union(strips);
  if (strips.length > 1) strips.forEach((strip) => strip.delete());
  return result;
}

/** The solid of a revolve in world space: the region spun about its axis line in the sketch plane. */
function revolveSolid(wasm: ManifoldToplevel, feature: Revolve, context: EvaluationContext): Manifold {
  const sketch = context.sketches[feature.profile];
  if (!sketch) throw new FeatureError(feature.id, 'The sketch this revolve uses no longer exists');
  const liveAxis = feature.axisRef ? axisInProfile(feature.id, feature.axisRef, sketch, context) : feature.axis;
  const [dx, dy] = liveAxis.direction;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) throw new FeatureError(feature.id, 'The revolve axis has no direction');
  if (!Number.isFinite(feature.angle) || feature.angle <= 0 || feature.angle > 360) throw new FeatureError(feature.id, 'The revolve angle must be between 0 and 360 degrees');
  const region = sketchRegion(wasm, filteredSketch(sketch, feature.profileShapes));
  try {
    if (region.isEmpty()) throw new FeatureError(feature.id, `${sketch.name} has no closed region to revolve`);
    // Manifold revolves about the cross-section's +Y axis (the +X side only): move the axis to
    // the origin and turn it to +Y first. `perp` is the sketch direction that becomes +X.
    const axis = [dx / length, dy / length];
    const perp = [axis[1]!, -axis[0]!];
    const angle = (Math.atan2(axis[1]!, axis[0]!) * 180) / Math.PI;
    const centred: CrossSection = region.translate([-liveAxis.origin[0], -liveAxis.origin[1]]);
    const upright: CrossSection = centred.rotate(90 - angle);
    centred.delete();
    const bounds = upright.bounds();
    if (bounds.min[0] < -1e-6 && bounds.max[0] > 1e-6) {
      upright.delete();
      throw new FeatureError(feature.id, 'The profile crosses the revolve axis; keep it on one side');
    }
    // A profile on the negative side is mirrored across the axis, which revolves to the same solid.
    const side: CrossSection = bounds.max[0] <= 1e-6 ? upright.mirror([1, 0]) : upright;
    if (side !== upright) upright.delete();
    const radius = Math.max(Math.abs(bounds.min[0]), Math.abs(bounds.max[0]));
    const solid = side.revolve(circleSegments(radius * 2), feature.angle);
    side.delete();
    // Revolve output: X = radius direction (perp), Z = the axis; map that frame into the world.
    const x = toWorldDirection(sketch.plane, [perp[0]!, perp[1]!]);
    const z = toWorldDirection(sketch.plane, [axis[0]!, axis[1]!]);
    return step(solid, solid.transform(frameMatrix(toWorld(sketch.plane, liveAxis.origin), x, cross(z, x), z)));
  } finally {
    region.delete();
  }
}

function filteredSketch(sketch: import('./types').Sketch, shapeIds?: string[]): import('./types').Sketch {
  if (!shapeIds?.length) return sketch;
  const wanted = new Set(shapeIds);
  return { ...sketch, shapes: sketch.shapes.filter((shape) => wanted.has(shape.id)) };
}

function curveWorldPoints(featureId: string, ref: CurveRef, context: EvaluationContext): Vec3[] {
  const sketch = context.sketches[ref.sketchId];
  if (!sketch) throw new FeatureError(featureId, 'A driving curve no longer exists');
  const shapes = ref.shapeIds.map((id) => sketch.shapes.find((shape) => shape.id === id)).filter(Boolean);
  if (shapes.length !== ref.shapeIds.length || shapes.length === 0) throw new FeatureError(featureId, 'A driving curve no longer exists');
  const remaining = shapes.map((shape) => [...shapeContour(shape!)]);
  const ordered = remaining.shift() ?? [];
  while (remaining.length > 0 && ordered.length > 0) {
    const tail = ordered[ordered.length - 1]!;
    let best = 0;
    let reverse = false;
    let distance = Infinity;
    remaining.forEach((points, index) => {
      const first = Math.hypot(points[0]![0] - tail[0], points[0]![1] - tail[1]);
      const last = Math.hypot(points[points.length - 1]![0] - tail[0], points[points.length - 1]![1] - tail[1]);
      if (first < distance) { best = index; reverse = false; distance = first; }
      if (last < distance) { best = index; reverse = true; distance = last; }
    });
    const next = remaining.splice(best, 1)[0]!;
    if (reverse) next.reverse();
    if (Math.hypot(next[0]![0] - tail[0], next[0]![1] - tail[1]) < 1e-5) next.shift();
    ordered.push(...next);
  }
  if (ordered.length < 2) throw new FeatureError(featureId, 'The driving curve is too short');
  return ordered.map((point) => toWorld(sketch.plane, point));
}

function curveEnds(featureId: string, ref: CurveRef, context: EvaluationContext): { start: Vec3; end: Vec3 } {
  const points = curveWorldPoints(featureId, ref, context);
  return { start: points[0]!, end: points[points.length - 1]! };
}

function axisInProfile(featureId: string, ref: CurveRef, profile: import('./types').Sketch, context: EvaluationContext): Revolve['axis'] {
  const { start, end } = curveEnds(featureId, ref, context);
  const a = toPlane(profile.plane, start);
  const b = toPlane(profile.plane, end);
  return { origin: a, direction: [b[0] - a[0], b[1] - a[1]] };
}

/** Straight-path sweep. The profile stays editable and is regenerated from its exact curves. */
function sweepSolid(wasm: ManifoldToplevel, feature: Sweep, context: EvaluationContext): Manifold {
  const sketch = context.sketches[feature.profile];
  if (!sketch) throw new FeatureError(feature.id, 'The sweep profile no longer exists');
  const path = curveWorldPoints(feature.id, feature.path, context);
  const start = path[0]!;
  const frame = planeFrame(sketch.plane);
  const region = sketchRegion(wasm, filteredSketch(sketch, feature.profileShapes));
  try {
    if (region.isEmpty()) throw new FeatureError(feature.id, `${sketch.name} has no closed profile to sweep`);
    const at = toPlane(sketch.plane, start);
    const pieces: Manifold[] = [];
    for (let index = 1; index < path.length; index++) {
      const a = path[index - 1]!;
      const b = path[index]!;
      const direction: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const length = Math.hypot(...direction);
      if (length < 1e-6) continue;
      const z: Vec3 = [direction[0] / length, direction[1] / length, direction[2] / length];
      const candidate = Math.abs(dot(frame.u, z)) < 0.98 ? frame.u : frame.v;
      const along = dot(candidate, z);
      const rawX: Vec3 = [candidate[0] - z[0] * along, candidate[1] - z[1] * along, candidate[2] - z[2] * along];
      const xLength = Math.hypot(...rawX);
      const x: Vec3 = [rawX[0] / xLength, rawX[1] / xLength, rawX[2] / xLength];
      const y = cross(z, x);
      const centred = region.translate([-at[0], -at[1]]);
      let piece = centred.extrude(length);
      centred.delete();
      piece = step(piece, piece.transform(frameMatrix(a, x, y, z)));
      pieces.push(piece);
    }
    if (pieces.length === 0) throw new FeatureError(feature.id, 'The sweep path must be an open curve');
    if (pieces.length === 1) return pieces[0]!;
    const result = wasm.Manifold.union(pieces);
    pieces.forEach((piece) => piece.delete());
    return result;
  } finally {
    region.delete();
  }
}

/** The body so far reflected across a plane perpendicular to one of its axes, optionally kept with the original. */
function mirrored(feature: Mirror, input: Manifold): Manifold {
  const axis: Vec3 = [feature.axis === 'x' ? 1 : 0, feature.axis === 'y' ? 1 : 0, feature.axis === 'z' ? 1 : 0];
  const shift: Vec3 = [axis[0] * feature.offset, axis[1] * feature.offset, axis[2] * feature.offset];
  let copy: Manifold = input.translate([-shift[0], -shift[1], -shift[2]]);
  copy = step(copy, copy.mirror(axis as MVec3));
  copy = step(copy, copy.translate(shift as MVec3));
  if (!feature.keepOriginal) return copy;
  return step(copy, input.add(copy));
}

/** The body so far repeated along a step or around an axis (the first copy is the original). */
function patterned(wasm: ManifoldToplevel, feature: Pattern, input: Manifold): Manifold {
  const count = Math.round(feature.count);
  if (!Number.isFinite(count) || count < 1 || count > 200) throw new FeatureError(feature.id, 'The pattern count must be between 1 and 200');
  const copies: Manifold[] = [];
  for (let i = 1; i < count; i++) {
    if (feature.mode === 'linear') {
      copies.push(input.translate([feature.step[0] * i, feature.step[1] * i, feature.step[2] * i]));
    } else {
      // Full turns spread the copies evenly; partial sweeps end on the last copy.
      const full = Math.abs(feature.angle) >= 360 - 1e-6;
      const turn = (feature.angle * i) / (full ? count : Math.max(1, count - 1));
      const rotation: Vec3 = [feature.axis === 'x' ? turn : 0, feature.axis === 'y' ? turn : 0, feature.axis === 'z' ? turn : 0];
      let copy: Manifold = input.translate([-feature.center[0], -feature.center[1], -feature.center[2]]);
      copy = step(copy, copy.rotate(rotation as MVec3));
      copies.push(step(copy, copy.translate(feature.center as MVec3)));
    }
  }
  if (copies.length === 0) return input.translate([0, 0, 0]);
  const result = wasm.Manifold.union([input, ...copies]);
  for (const copy of copies) copy.delete();
  return result;
}

/** The tool body's solid as placed in the asset, evaluated with the same cache. */
function toolSolid(wasm: ManifoldToplevel, featureId: string, toolId: string, cache: KernelCache, context: EvaluationContext, stack: Set<string>): Manifold {
  const tool = context.bodies?.[toolId];
  if (!tool) throw new FeatureError(featureId, 'The tool body no longer exists');
  if (stack.has(tool.id)) throw new FeatureError(featureId, `${tool.name} would depend on itself`);
  const { manifold } = evaluateWith(wasm, tool, cache, context, stack);
  let world = manifold.translate([0, 0, 0]);
  const scale = tool.placement.scale ?? [1, 1, 1];
  if (scale.some((value) => value !== 1)) world = step(world, world.scale(scale as MVec3));
  return placed(world, tool.placement.rotation, tool.placement.position);
}

/** Brings a world-space solid into the frame of a placed body (the inverse of its placement). */
function intoBodyFrame(solid: Manifold, placement: Placement): Manifold {
  const [x, y, z] = placement.position;
  const [rx, ry, rz] = placement.rotation;
  let result = solid;
  if (x !== 0 || y !== 0 || z !== 0) result = step(result, result.translate([-x, -y, -z]));
  // Placement rotates about X, then Y, then Z; undo it by rotating -Z, -Y, -X in turn.
  if (rz !== 0) result = step(result, result.rotate([0, 0, -rz]));
  if (ry !== 0) result = step(result, result.rotate([0, -ry, 0]));
  if (rx !== 0) result = step(result, result.rotate([-rx, 0, 0]));
  const [sx, sy, sz] = placement.scale ?? [1, 1, 1];
  if (sx !== 1 || sy !== 1 || sz !== 1) result = step(result, result.scale([1 / sx, 1 / sy, 1 / sz]));
  return result;
}

const EMPTY_CONTEXT: EvaluationContext = { sketches: {} };

/**
 * Evaluates the body and returns its solid with the map of triangle-run ids to feature ids.
 * Throws a `FeatureError` naming the first feature that failed; cached results stay valid.
 */
export function evaluateBody(wasm: ManifoldToplevel, body: Body, cache: KernelCache = new KernelCache(), context: EvaluationContext = EMPTY_CONTEXT): Evaluated {
  return evaluateWith(wasm, body, cache, context, new Set());
}

/** Starts (or ends) the body with a new solid, or combines it with the body so far. */
function combine(feature: Feature & { op: 'new' | 'add' | 'cut' }, solid: Manifold, current: Entry | null): Entry {
  if (!current) {
    if (feature.op === 'cut') {
      solid.delete();
      throw new FeatureError(feature.id, 'Nothing to cut yet: the body has no solid before this feature');
    }
    return { manifold: solid, originals: new Map([[solid.originalID(), feature.id]]), faceMaterials: NO_FACES };
  }
  if (feature.op === 'new') {
    solid.delete();
    throw new FeatureError(feature.id, 'A new-body feature can only start a body; use add or cut here');
  }
  const originalId = solid.originalID();
  const combined = feature.op === 'add' ? current.manifold.add(solid) : current.manifold.subtract(solid);
  solid.delete();
  return { manifold: combined, originals: new Map([...current.originals, [originalId, feature.id]]), faceMaterials: current.faceMaterials };
}

/** Smooths the body so far: sharp edges stay creases, the rest is refined into a G1 surface. */
function smoothed(feature: Smooth, input: Manifold): Manifold {
  if (!Number.isFinite(feature.creaseAngle) || feature.creaseAngle < 0 || feature.creaseAngle > 180) throw new FeatureError(feature.id, 'The crease angle must be between 0 and 180 degrees');
  const tangents: Manifold = input.smoothOut(feature.creaseAngle, 0);
  return step(tangents, tangents.refine(feature.level >= 2 ? 4 : 2));
}

function evaluateWith(wasm: ManifoldToplevel, body: Body, cache: KernelCache, context: EvaluationContext, stack: Set<string>): Evaluated {
  if (body.features.length === 0) throw new FeatureError('', 'The body has no features');
  stack.add(body.id);
  try {
    return evaluateFeatures(wasm, body, cache, context, stack);
  } finally {
    stack.delete(body.id);
  }
}

function evaluateFeatures(wasm: ManifoldToplevel, body: Body, cache: KernelCache, context: EvaluationContext, stack: Set<string>): Evaluated {
  let key = '';
  let current: Entry | null = null;
  const touched = new Set<string>();
  try {
    for (const feature of body.features) {
      key = featureKey(key, feature, body, context);
      touched.add(key);
      const cached = cache.get(body.id, key);
      if (cached) {
        current = cached;
        continue;
      }
      let entry: Entry;
      if (feature.kind === 'primitive') {
        if (current) throw new FeatureError(feature.id, 'Only the first feature of a body can be a primitive for now');
        const built = primitive(wasm, feature);
        const solid = step(built, built.asOriginal());
        entry = { manifold: solid, originals: new Map([[solid.originalID(), feature.id]]), faceMaterials: NO_FACES };
      } else if (feature.kind === 'mesh') {
        if (current) throw new FeatureError(feature.id, 'A baked mesh can only start a body');
        const built = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: new Float32Array(feature.positions), triVerts: new Uint32Array(feature.indices) }));
        const solid = step(built, built.asOriginal());
        entry = { manifold: solid, originals: new Map([[solid.originalID(), feature.id]]), faceMaterials: NO_FACES };
      } else if (feature.kind === 'transform') {
        if (!current) throw new FeatureError(feature.id, 'Nothing to transform yet');
        entry = { ...current, manifold: transform(feature, current.manifold) };
      } else if (feature.kind === 'direct-edit') {
        if (!current) throw new FeatureError(feature.id, 'Nothing to edit yet');
        entry = { ...current, manifold: directEdit(feature, current.manifold) };
      } else if (feature.kind === 'extrude' || feature.kind === 'revolve' || feature.kind === 'sweep') {
        const world = feature.kind === 'extrude' ? extrudePrism(wasm, feature, context) : feature.kind === 'revolve' ? revolveSolid(wasm, feature, context) : sweepSolid(wasm, feature, context);
        const local = intoBodyFrame(world, body.placement);
        entry = combine(feature, step(local, local.asOriginal()), current);
      } else if (feature.kind === 'mirror') {
        if (!current) throw new FeatureError(feature.id, 'Nothing to mirror yet');
        entry = { ...current, manifold: mirrored(feature, current.manifold) };
      } else if (feature.kind === 'pattern') {
        if (!current) throw new FeatureError(feature.id, 'Nothing to repeat yet');
        entry = { ...current, manifold: patterned(wasm, feature, current.manifold) };
      } else if (feature.kind === 'smooth') {
        if (!current) throw new FeatureError(feature.id, 'Nothing to smooth yet');
        entry = { ...current, manifold: smoothed(feature, current.manifold) };
      } else if (feature.kind === 'face-material') {
        if (!current) throw new FeatureError(feature.id, 'Nothing to paint yet');
        // Geometry is untouched; a fresh handle keeps the cache entries independently deletable.
        entry = { ...current, manifold: current.manifold.translate([0, 0, 0]), faceMaterials: [...current.faceMaterials, feature] };
      } else if (feature.kind === 'boolean') {
        if (!current) throw new FeatureError(feature.id, 'Nothing to combine yet: the body has no solid before this feature');
        if (feature.tool === body.id) throw new FeatureError(feature.id, 'A body cannot be its own tool');
        const world = toolSolid(wasm, feature.id, feature.tool, cache, context, stack);
        const local = intoBodyFrame(world, body.placement);
        const tool = step(local, local.asOriginal());
        const originalId = tool.originalID();
        const combined = feature.op === 'union' ? current.manifold.add(tool) : feature.op === 'subtract' ? current.manifold.subtract(tool) : current.manifold.intersect(tool);
        tool.delete();
        entry = { manifold: combined, originals: new Map([...current.originals, [originalId, feature.id]]), faceMaterials: current.faceMaterials };
      } else {
        throw new FeatureError((feature as Feature).id, 'Unknown feature kind');
      }
      if (entry.manifold.isEmpty()) {
        entry.manifold.delete();
        const cut = ((feature.kind === 'extrude' || feature.kind === 'revolve' || feature.kind === 'sweep') && feature.op === 'cut') || (feature.kind === 'boolean' && feature.op !== 'union');
        throw new FeatureError(feature.id, cut ? 'Nothing is left of the body after this feature' : 'The result is empty');
      }
      cache.set(body.id, key, entry);
      current = entry;
    }
  } finally {
    // Entries the failed feature never reached are stale; the good prefix stays cached.
    cache.prune(body.id, touched);
  }
  return current!;
}

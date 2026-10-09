/**
 * The modeling recipe: a body is a list of features evaluated in order by the solid kernel
 * (see ./evaluate.ts); the mesh is never stored, only regenerated. Plain JSON throughout so the
 * recipe autosaves, travels through the worker and (later) ships inside a `.CAI`.
 *
 * Axes follow the project's 3D convention: X = width, Y = height (up), Z = depth. Lengths are
 * millimetres, angles degrees. See docs/modeling-tools.md §3.
 */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type PlaneId = 'top' | 'front' | 'side';

/** Where a body (or a primitive inside it) sits: its ground-centre point and Euler angles (deg). */
export interface Placement {
  position: Vec3;
  rotation: Vec3;
  /** Non-uniform body scale. Older assets omit it and are treated as [1, 1, 1]. */
  scale?: Vec3;
}

export type PrimitiveShape = 'box' | 'cylinder' | 'sphere' | 'cone';

/**
 * A solid drawn straight into the body. It rests on Y = 0 and is centred in plan on its
 * placement point: `size` is width (X), height (Y), depth (Z); round shapes take their diameter
 * from the width (a cylinder's depth mirrors its width).
 */
export interface Primitive {
  kind: 'primitive';
  id: string;
  shape: PrimitiveShape;
  size: Vec3;
  /** Segments around a circle; default derived from the size (docs §7.2). */
  segments?: number;
  placement: Placement;
}

/** Moves, turns or scales everything the body has produced so far. */
export interface Transform {
  kind: 'transform';
  id: string;
  translate?: Vec3;
  rotate?: Vec3;
  scale?: Vec3 | number;
}

/**
 * A persistent direct edit made with a vertex or edge gizmo.  The picked positions live in the
 * body's local frame so the edit remains stable when the whole body is moved or rotated.
 */
export interface DirectEdit {
  kind: 'direct-edit';
  id: string;
  points: Vec3[];
  delta: Vec3;
  /** Position matching tolerance in millimetres. */
  tolerance?: number;
}

/**
 * The plane a sketch is drawn on: one of the view planes at a fixed offset along its axis
 * (frozen when the sketch is started, so moving the view plane later does not move the sketch),
 * or a custom plane in world space (a face of a body, from push/pull). Sketch coordinates
 * (u, v) map to a view plane as the 2D pane shows it: u to the right, v up.
 */
export type SketchPlane = { kind: 'plane'; id: PlaneId; offset: number } | { kind: 'custom'; origin: Vec3; normal: Vec3; xAxis: Vec3 };

/** Every shape may be grown (positive) or shrunk (negative) by an offset with round joins. */
interface ShapeBase {
  id: string;
  /** User-facing label for this contour/segment in the Layers hierarchy. */
  name?: string;
  offset?: number;
}

/**
 * A 2D shape in sketch coordinates (mm). Polylines are closed unless `closed` is false. A
 * polyline segment from point i to i + 1 is an
 * arc when `bulges[i]` is non-zero (tan of a quarter of its angle, positive = counter-clockwise,
 * i.e. swinging to the right of the segment direction, as in DXF). It is a cubic Bézier when
 * `handles[i]` holds its two control points (the one leaving point i, the one arriving at point
 * i + 1); handles win over a bulge.
 */
export type Shape2D =
  | (ShapeBase & { kind: 'rect'; x: number; y: number; width: number; height: number })
  | (ShapeBase & { kind: 'circle'; cx: number; cy: number; radius: number })
  | (ShapeBase & { kind: 'polygon'; cx: number; cy: number; radius: number; sides: number; rotation: number })
  | (ShapeBase & { kind: 'polyline'; points: Vec2[]; bulges?: number[]; handles?: (CurveHandles | null)[]; closed?: boolean });

/** The two control points of a cubic polyline segment (absolute sketch coordinates). */
export type CurveHandles = [Vec2, Vec2];

/**
 * A drawing on a plane, shared by the asset (bodies reference it by id from their extrude and
 * revolve features). Its closed shapes form regions: a shape fully inside another cuts a hole
 * in it, overlapping shapes merge.
 */
export interface Sketch {
  id: string;
  name: string;
  visible: boolean;
  plane: SketchPlane;
  shapes: Shape2D[];
  /** Rounds every convex corner of the region (docs §7.3). */
  cornerRadius?: number;
}

/** Pushes a sketch's regions out along the plane normal to make a solid, or adds/cuts one. */
export interface Extrude {
  kind: 'extrude';
  id: string;
  /** Sketch id. */
  profile: string;
  /** Exact curve(s) that drive this feature. Omitted only by legacy assets. */
  profileShapes?: string[];
  /** Open profiles create a surface-like ribbon rather than a closed solid profile. */
  surface?: boolean;
  /**
   * Picked regions: a point inside each face of the profile's arrangement to extrude (see
   * ./regions.ts). Omitted: every solid face (openings by even / odd nesting).
   */
  regions?: Vec2[];
  /** mm along the plane normal; negative goes the other way. */
  distance: number;
  /** Extrude half the distance to each side of the plane. */
  symmetric?: boolean;
  /** `new` starts the body; `add` unions with and `cut` subtracts from what the body has so far. */
  op: 'new' | 'add' | 'cut';
}

/** Spins a sketch's regions about a line in the sketch plane (lamps, bowls, turned legs). */
export interface Revolve {
  kind: 'revolve';
  id: string;
  profile: string;
  profileShapes?: string[];
  /** Editable open curve used as the axis. Legacy features keep the geometric `axis`. */
  axisRef?: CurveRef;
  /** The axis in sketch coordinates; the region must lie on one side of it. */
  axis: { origin: Vec2; direction: Vec2 };
  /** Degrees, 360 for a full turn. */
  angle: number;
  op: 'new' | 'add' | 'cut';
}

/** A stable reference to one or more editable curves in a sketch. */
export interface CurveRef {
  sketchId: string;
  shapeIds: string[];
}

/** Carries a profile along an editable open curve. */
export interface Sweep {
  kind: 'sweep';
  id: string;
  profile: string;
  profileShapes: string[];
  path: CurveRef;
  op: 'new' | 'add' | 'cut';
}

/** A baked independent solid used after breaking parametric links. */
export interface BakedMesh {
  kind: 'mesh';
  id: string;
  positions: number[];
  indices: number[];
}

/** Reflects the body so far across a plane perpendicular to a body axis. */
export interface Mirror {
  kind: 'mirror';
  id: string;
  axis: 'x' | 'y' | 'z';
  /** Where the mirror plane crosses the axis, in the body's frame. */
  offset: number;
  keepOriginal: boolean;
}

/** Repeats the body so far: `count` copies along `step`, or around an axis. */
export type Pattern =
  | { kind: 'pattern'; id: string; mode: 'linear'; count: number; step: Vec3 }
  | { kind: 'pattern'; id: string; mode: 'radial'; count: number; axis: 'x' | 'y' | 'z'; center: Vec3; angle: number };

/** Combines the body so far with another body (the tool), placed as it is in the asset. */
export interface Boolean {
  kind: 'boolean';
  id: string;
  op: 'union' | 'subtract' | 'intersect';
  /** Body id; a body cannot use itself or one of its own users. */
  tool: string;
}

/**
 * Rounds the body so far: edges sharper than `creaseAngle` stay sharp, everything else becomes a
 * smooth (G1) surface subdivided `level` times (docs §7.2). Display / export geometry: keep it
 * as the last feature.
 */
export interface Smooth {
  kind: 'smooth';
  id: string;
  level: 1 | 2;
  /** Degrees; edges with a larger dihedral angle stay creases. */
  creaseAngle: number;
}

/**
 * A face of the evaluated body, identified by its plane in the body's frame (unit normal and
 * signed distance from the origin). Regeneration keeps the plane of a face that did not move;
 * a face that vanished simply drops its override.
 */
export interface FaceRef {
  normal: Vec3;
  offset: number;
}

/** Gives faces a material other than the body's. */
export interface FaceMaterial {
  kind: 'face-material';
  id: string;
  material: string;
  faces: FaceRef[];
}

export type Feature = (Primitive | BakedMesh | Transform | DirectEdit | Extrude | Revolve | Sweep | Mirror | Pattern | Boolean | Smooth | FaceMaterial) & { name?: string };

/** What a body's evaluation reads besides its own features. */
export interface EvaluationContext {
  sketches: Record<string, Sketch>;
  /** Other bodies, for boolean tool bodies. */
  bodies?: Record<string, Body>;
}

export interface Body {
  id: string;
  name: string;
  visible: boolean;
  /** Part of the low level of detail model (same meaning as for imported layers). */
  lowLod: boolean;
  /** Material id for faces without an override (see ./materials.ts). */
  material: string;
  /**
   * Where the evaluated solid is placed in the asset; edited by the gizmo without re-evaluating.
   * Rotation is applied about the world X, then Y, then Z axis (Manifold's and three.js' `ZYX`
   * Euler order). Sketch-based features are drawn in world space and brought into this frame.
   */
  placement: Placement;
  /** Evaluated left to right; the first feature must create a solid. */
  features: Feature[];
}

export interface PbrMaterial {
  name: string;
  /** `#rrggbb` */
  color: string;
  roughness: number;
  metalness: number;
  /** Alpha-blended when below 1. */
  opacity: number;
}

/** A run of triangles that came from one feature (Manifold keeps runs through booleans). */
export interface FeatureRun {
  /** First index into `indices` (a multiple of 3). */
  start: number;
  count: number;
  featureId: string;
}

/**
 * What the kernel hands back for a body: GL-ready flat arrays in the body's local frame. The
 * typed arrays are transferred out of the worker, not copied.
 */
export interface MeshData {
  positions: Float32Array;
  /** Angle-smoothed vertex normals (docs §7.1). */
  normals: Float32Array;
  indices: Uint32Array;
  /** Per triangle: Manifold's coplanar face id, used later for face picking and materials. */
  faceIds: Uint32Array;
  runs: FeatureRun[];
  /** Consecutive index ranges per material; `material` is null for the body's own material. */
  groups: MaterialGroup[];
  triangles: number;
  /** mm³ */
  volume: number;
  bounds: { min: Vec3; max: Vec3 };
}

export interface MaterialGroup {
  start: number;
  count: number;
  material: string | null;
}

export function identityPlacement(): Placement {
  return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
}

/** The angle above which an edge stays sharp when normals are smoothed (docs §7.1). */
export const SMOOTH_ANGLE = 30;

/** Segments around a circle so that a 20 mm knob and a 600 mm top both look round (docs §7.2). */
export function circleSegments(diameter: number): number {
  const circumference = Math.PI * Math.max(diameter, 1);
  return Math.min(128, Math.max(24, Math.ceil(circumference / 4)));
}

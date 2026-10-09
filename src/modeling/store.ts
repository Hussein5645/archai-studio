/**
 * State of the modeling workspace (`/modeling`): the asset being authored, its imported layers
 * (with the GLB node tree under each), the three fixed 2D view planes, the cameras, the pane
 * layout with a display style per pane, and what is selected. Everything here is plain data;
 * the three.js objects live in ./scene.ts keyed by the same ids.
 *
 * Axes follow the project's 3D convention: X = width, Y = height (up), Z = depth (plan "down").
 */
import { createStore, type StoreApi } from 'zustand';
import { useStore } from 'zustand';
import { DEFAULT_MATERIAL, presetMaterials } from './kernel/materials';
import { identityPlacement, type Body, type CurveRef, type Extrude, type Feature, type PbrMaterial, type Placement, type Primitive, type PrimitiveShape, type Shape2D, type Sketch, type SketchPlane, type Vec2, type Vec3 } from './kernel/types';
import { arrangeSketch, planeFrame, samePlane, shapeContour, toWorld, translateShape } from './kernel/sketch';
import { DEFAULT_INFERENCE_SETTINGS, type InferenceSettings } from './inference';
import { WorkPlaneService } from './work-plane';
import type { TopologyHit } from './topology';
import { applyParameters, renameInFormula, uniqueParameterName, validParameterName, type Binding, type Bindings, type Parameter } from './parameters';

export type { Body, CurveRef, Extrude, Feature, PbrMaterial, Placement, Primitive, PrimitiveShape, Shape2D, Sketch, SketchPlane, Sweep, Vec2, Vec3 } from './kernel/types';

export type PlaneId = 'top' | 'front' | 'side';
/** The orthographic views; bottom, back and left look at a view plane from its other side. */
export type OrthoViewId = PlaneId | 'bottom' | 'back' | 'left';
/**
 * What a pane shows: the free 3D view, an orthographic view, the work plane square-on, or one of
 * the cameras. Views only change what is seen: drawing always goes on the work plane.
 */
export type PaneView = '3d' | OrthoViewId | 'workplane' | `camera:${string}`;

/** The view plane an orthographic view looks at, and whether it looks from the far side. */
export const ORTHO_VIEWS: Record<OrthoViewId, { plane: PlaneId; flipped: boolean; label: string }> = {
  top: { plane: 'top', flipped: false, label: 'Top' },
  bottom: { plane: 'top', flipped: true, label: 'Bottom' },
  front: { plane: 'front', flipped: false, label: 'Front' },
  back: { plane: 'front', flipped: true, label: 'Back' },
  side: { plane: 'side', flipped: false, label: 'Right' },
  left: { plane: 'side', flipped: true, label: 'Left' },
};

export function isOrthoView(view: PaneView): view is OrthoViewId {
  return Object.prototype.hasOwnProperty.call(ORTHO_VIEWS, view);
}

/** The plane an orthographic pane looks at (and clips the model at); null for 3D and cameras. */
export function viewPlaneOf(view: PaneView, state: { planes: Record<PlaneId, number>; workPlane: SketchPlane }): SketchPlane | null {
  if (view === 'workplane') return state.workPlane;
  if (!isOrthoView(view)) return null;
  const { plane: id, flipped } = ORTHO_VIEWS[view];
  const plane: SketchPlane = { kind: 'plane', id, offset: state.planes[id] };
  if (!flipped) return plane;
  // Seen from behind: the normal and the screen's right both reverse, so up stays up.
  const frame = planeFrame(plane);
  return { kind: 'custom', origin: frame.origin, normal: [-frame.normal[0], -frame.normal[1], -frame.normal[2]], xAxis: [-frame.u[0], -frame.u[1], -frame.u[2]] };
}
export type Layout = 'single' | 'split-2' | 'split-4';
export type ViewStyle = 'realistic' | 'color' | 'shaded' | 'wireframe' | 'hidden-line';
export type Lod = 'high' | 'low';

export interface Metadata {
  name: string;
  id: string;
  idEdited: boolean;
  category: string;
  tags: string;
}

/** One node of an imported model (the GLB scene graph), shown under its layer in Layers. */
export interface LayerNode {
  id: string;
  name: string;
  visible: boolean;
  /** Part of the low level of detail model. */
  lowLod: boolean;
  children: LayerNode[];
  /** Geometry directly on this node (not its children). */
  triangles: number;
  vertices: number;
  materials: string[];
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  /** Import scale to millimetres (glTF files are in metres). */
  scale: number;
  /** Bounding size of the imported object in millimetres (after `scale`). */
  size: [number, number, number];
  /** Any node of the layer is part of the low level of detail model (`model-low.glb`). */
  lowLod: boolean;
  nodes: LayerNode[];
}

export interface ModelingCamera {
  id: string;
  name: string;
  visible: boolean;
  /** The camera whose hidden-line view becomes the package thumbnail (exactly one). */
  preview: boolean;
  eye: [number, number, number];
  aim: [number, number, number];
  fov: number;
}

/** What the gizmo does to a selected body. */
export type GizmoMode = 'translate' | 'rotate' | 'scale';

/** Facts about a body's last evaluation (transient; the mesh itself lives in the scene). */
export interface BodyInfo {
  triangles: number;
  volume: number;
  /** Set when the last evaluation failed; the body keeps its previous mesh. */
  error?: { featureId: string; message: string };
}

/** The undoable slice: recipes, sketches and materials (layers, cameras and planes are not yet in it). */
interface HistoryEntry {
  bodies: Body[];
  sketches: Sketch[];
  parameters: Parameter[];
  bindings: Bindings;
  materials: Record<string, PbrMaterial>;
  workPlane: SketchPlane;
  workPlaneVisible: boolean;
  workPlaneLocked: boolean;
}

/**
 * Sketch edit mode (Revit's "Edit Boundary"): one sketch is edited in isolation; everything done
 * inside becomes one undo step on Finish, and Cancel restores the sketch as it was.
 */
export interface SketchEditSession {
  sketchId: string;
  /** `past.length` right after the entry snapshot; undo stops here while editing. */
  base: number;
  /** The document when the session started (Cancel restores it). */
  entry: HistoryEntry;
}

/** The active tool (docs/modeling-tools.md, tools). Sketch tools draw in the 2D panes. */
export type Tool = 'select' | 'line' | 'rect' | 'circle' | 'polygon' | 'polyline' | 'arc' | 'ellipse' | 'spline' | 'freehand' | 'knife' | 'offset' | 'pickline' | 'smove' | 'scopy' | 'srotate' | 'smirror' | 'sscale' | 'trim' | 'extend' | 'split' | 'fillet' | 'extrude' | 'pushpull' | 'revolve' | 'sweep' | 'mirror' | 'pattern' | 'boolean' | 'paint';
/** Tools that draw in the 2D panes. */
export const SKETCH_TOOLS: Tool[] = ['line', 'rect', 'circle', 'polygon', 'polyline', 'arc', 'ellipse', 'spline', 'freehand', 'knife', 'offset'];
/** Tools that add curves to a sketch without drawing them (picked from bodies or other sketches). */
export const PICK_TOOLS: Tool[] = ['pickline'];
/** Tools that modify existing sketch curves by picking points on the drawing plane (tools/modify.ts). */
export const MODIFY_TOOLS: Tool[] = ['smove', 'scopy', 'srotate', 'smirror', 'sscale', 'trim', 'extend', 'split', 'fillet'];
/** Tools whose clicks land on the drawing plane (drawing, picking lines, modifying curves). */
export const PLANE_TOOLS: Tool[] = [...SKETCH_TOOLS, ...PICK_TOOLS, ...MODIFY_TOOLS];

export type LastAction =
  | { kind: 'tool'; tool: Tool }
  | { kind: 'primitive'; shape: PrimitiveShape }
  | { kind: 'workplane'; mode: WorkPlaneSetupMode }
  | null;

/** Curves of one sketch used as an extrude profile, with the faces picked inside them (seeds). */
export interface ProfileGroup extends CurveRef {
  regions?: Vec2[];
}

export interface ToolOptions {
  /** Sketch grid in mm (0 = off). */
  grid: number;
  /** Snap to shape points and the grid. */
  snap: boolean;
  /** Polygon sides. */
  sides: number;
  /**
   * `profile` is the first of `profiles`: every selected curve, grouped by sketch (one feature
   * each). Each group may carry picked regions. `separate` makes one body per region.
   */
  extrude: { distance: number; symmetric: boolean; op: Extrude['op']; target: string | null; profile: CurveRef | null; profiles: ProfileGroup[]; separate: boolean };
  /** The next polyline segment is an arc (toggled with A while drawing). */
  arc: boolean;
  /** Offset tool distance in mm (negative = inward). */
  offset: number;
  /** Options of the curve modify tools. */
  modify: {
    /** Copy: how many copies are placed along the picked offset (an array). */
    copies: number;
    /** Mirror keeps the original curves and adds the mirrored ones (Revit's default). */
    mirrorCopy: boolean;
    /** Rotate keeps the original curves and adds rotated copies. */
    rotateCopy: boolean;
    /** Trim: 'corner' trims / extends two lines to their corner, 'segment' deletes the clicked piece. */
    trimMode: 'corner' | 'segment';
    filletMode: 'fillet' | 'chamfer';
    /** Fillet radius or chamfer distance (mm). */
    filletSize: number;
  };
  /** Arc tool: through a third point, or from a centre (centre, start, end). */
  arcMode: 'three-point' | 'center' | 'tangent';
  /** Circle tool: centre and radius, two ends of a diameter, or three points on it. */
  circleMode: 'center' | '2p' | '3p';
  /** Polyline: the next segment is an arc tangent to the previous one (T while drawing). */
  tangentArc: boolean;
  /** Line tool: each line starts where the previous one ended (Revit's Chain). */
  chain: boolean;
  /** Polylines get this corner radius when finished (0 = sharp corners). */
  drawRadius: number;
  /** Drawn and picked curves are placed this far to the left of the drawn line (0 = on it). */
  drawOffset: number;
  revolve: { axis: 'u' | 'v'; at: number; angle: number; op: Extrude['op']; target: string | null; axisRef: CurveRef | null; profile: CurveRef | null };
  sweep: { op: Extrude['op']; target: string | null; path: CurveRef | null; profile: CurveRef | null };
  mirror: { axis: 'x' | 'y' | 'z'; offset: number; keepOriginal: boolean };
  pattern: { mode: 'linear' | 'radial'; count: number; step: [number, number, number]; axis: 'x' | 'y' | 'z'; center: [number, number, number]; angle: number };
  boolean: { op: 'union' | 'subtract' | 'intersect'; tool: string | null };
  /** Material the paint tool applies. */
  paintMaterial: string;
}

/** What the sketch tools show while working (transient): the shape being drawn and the snap marker. */
export interface SketchPreview {
  plane: SketchPlane;
  shape: Shape2D | null;
  /** Extra ghost shapes (curves being moved, copied, rotated, mirrored or scaled). */
  shapes?: Shape2D[];
  snap: Vec2 | null;
  inference?: { label: string; type: string; locked: boolean; screen?: [number, number]; measurement?: string; target?: TopologyHit };
  /** A temporary construction line that explains an alignment or locked direction. */
  guide?: { from: Vec2; to: Vec2 };
  /** A shape is being drawn (not just a hover preview): touch offers Done / Undo point / Cancel. */
  drawing?: boolean;
}

/** Temporary Select-tool diagnostics; never persisted in the asset. */
export interface LoopCheckPreview {
  sketchId: string;
  shapeIds: string[];
  closed: boolean;
  openings: Vec2[];
  message: string;
}

const HISTORY_LIMIT = 100;

/** What is selected: a layer, a node inside a layer, a body, a view plane, or a camera (eye or aim point). */
export type Selection =
  | { kind: 'layer'; id: string }
  | { kind: 'body'; id: string }
  | { kind: 'feature'; bodyId: string; featureId: string }
  | { kind: 'sketch'; id: string }
  | { kind: 'shape'; sketchId: string; shapeId: string }
  | { kind: 'curve-point'; sketchId: string; shapeId: string; pointIndex: number }
  | { kind: 'loop'; sketchId: string; loopIndex: number; shapeIds: string[] }
  | { kind: 'vertex'; bodyId: string; vertexIndex: number; point?: Vec3 }
  | { kind: 'edge'; bodyId: string; edgeIndex: number; p1?: [number, number, number]; p2?: [number, number, number] }
  | { kind: 'face'; bodyId: string; faceId: number }
  | { kind: 'node'; layerId: string; nodeId: string }
  | { kind: 'plane'; id: PlaneId }
  | { kind: 'workplane' }
  | { kind: 'camera'; id: string; part: 'eye' | 'aim' }
  /** A vertex, edge or face of the locked project reference (world coordinates). */
  | { kind: 'reference'; target: TopologyHit }
  | null;

export type SelectedItem = Exclude<Selection, null>;

function referenceKey(target: TopologyHit): string {
  const round = (values: readonly number[]) => values.map((value) => Math.round(value)).join(',');
  if (target.kind === 'vertex') return `v:${round(target.point)}`;
  if (target.kind === 'edge') return `e:${round(target.a)}:${round(target.b)}`;
  return `f:${round(target.triangles.slice(0, 9))}:${target.triangles.length}`;
}

/** Stable identity used by additive selection in both Layers and the viewport. */
export function selectionKey(selection: SelectedItem): string {
  if (selection.kind === 'workplane') return selection.kind;
  if (selection.kind === 'node') return `${selection.kind}:${selection.layerId}:${selection.nodeId}`;
  if (selection.kind === 'feature') return `${selection.kind}:${selection.bodyId}:${selection.featureId}`;
  if (selection.kind === 'shape') return `${selection.kind}:${selection.sketchId}:${selection.shapeId}`;
  if (selection.kind === 'curve-point') return `${selection.kind}:${selection.sketchId}:${selection.shapeId}:${selection.pointIndex}`;
  if (selection.kind === 'loop') return `${selection.kind}:${selection.sketchId}:${selection.loopIndex}`;
  if (selection.kind === 'vertex') return `${selection.kind}:${selection.bodyId}:${selection.vertexIndex}`;
  if (selection.kind === 'edge') return `${selection.kind}:${selection.bodyId}:${selection.edgeIndex}`;
  if (selection.kind === 'face') return `${selection.kind}:${selection.bodyId}:${selection.faceId}`;
  if (selection.kind === 'camera') return `${selection.kind}:${selection.id}:${selection.part}`;
  if (selection.kind === 'reference') return `${selection.kind}:${referenceKey(selection.target)}`;
  return `${selection.kind}:${selection.id}`;
}

export interface CameraMenu {
  x: number;
  y: number;
  cameraId: string;
  paneIndex: number;
}

export type WorkPlaneSetupMode = 'surface' | 'plane' | '3points';

export interface ModelingState {
  metadata: Metadata;
  /** Width, height and depth of the visible model in millimetres (derived from the layers). */
  modelSize: [number, number, number];
  layers: Layer[];
  /** Modeled solids: each a recipe evaluated by the kernel (docs/modeling-tools.md, data model). */
  bodies: Body[];
  /** The asset's PBR materials, seeded from the presets. */
  materials: Record<string, PbrMaterial>;
  bodyInfo: Record<string, BodyInfo>;
  /** Named values of the asset (see ./parameters.ts); exposed ones are editable on the board. */
  parameters: Parameter[];
  /** Formulas driving recipe numbers, by field path. */
  bindings: Bindings;
  /** Current parameter values by name (derived ones computed). */
  parameterValues: Record<string, number>;
  /** Formula problems by parameter id or binding path. */
  parameterErrors: Record<string, string>;
  /** Drawings on the view planes, referenced by extrude features. */
  sketches: Sketch[];
  tool: Tool;
  lastActiveTool: Tool | null;
  lastAction: LastAction;
  lastReusedNotice: string | null;
  toolOptions: ToolOptions;
  inferenceSettings: InferenceSettings;
  sketchPreview: SketchPreview | null;
  hoveredShape: { sketchId: string; shapeId: string } | null;
  loopCheck: LoopCheckPreview | null;
  /** Digits typed while a drag is live (a dimension or an extrude distance). */
  numericEntry: string;
  gizmoMode: GizmoMode;
  past: HistoryEntry[];
  /** The sketch being edited in isolation, if any. */
  sketchEdit: SketchEditSession | null;
  /** Transient: how far the active curve modify tool is (points picked, a first curve picked). */
  modifyProgress: { points: number; picked: boolean };
  future: HistoryEntry[];
  cameras: ModelingCamera[];
  /** Position of each 2D view plane along its axis (top → Y, front → Z, side → X). */
  planes: Record<PlaneId, number>;
  /** Hidden planes are neither drawn nor pickable in 3D (their 2D view still works). */
  planeVisible: Record<PlaneId, boolean>;
  /** User-defined drawing plane, copied from a model face or one of the fixed view planes. */
  workPlane: SketchPlane;
  workPlaneVisible: boolean;
  workPlaneLocked: boolean;
  /** While true, the next face or fixed plane clicked in 3D becomes the work plane. */
  settingWorkPlane: boolean;
  workPlaneMode: WorkPlaneSetupMode;
  workPlanePoints: [number, number, number][];
  selection: Selection;
  /** All selected items. `selection` remains the active/most recently selected item. */
  selectionSet: SelectedItem[];
  layout: Layout;
  /** One view per pane; only the first 1, 2 or 4 are shown depending on the layout. */
  panes: [PaneView, PaneView, PaneView, PaneView];
  styles: [ViewStyle, ViewStyle, ViewStyle, ViewStyle];
  /** Level of detail each pane shows: high = every layer, low = only the low-LOD layers. */
  lods: [Lod, Lod, Lod, Lod];
  activePane: number;
  cameraMenu: CameraMenu | null;

  /** Restores a saved asset (see ./persistence.ts); layers are re-imported by the caller. */
  hydrate: (saved: Partial<Pick<ModelingState, 'metadata' | 'layers' | 'bodies' | 'sketches' | 'parameters' | 'bindings' | 'materials' | 'cameras' | 'planes' | 'planeVisible' | 'workPlane' | 'workPlaneVisible' | 'workPlaneLocked' | 'layout' | 'panes' | 'styles' | 'lods'>>) => void;
  setMetadata: (patch: Partial<Metadata>) => void;
  setModelSize: (size: [number, number, number]) => void;
  addLayer: (layer: Layer) => void;
  updateLayer: (id: string, patch: Partial<Pick<Layer, 'name' | 'visible' | 'scale' | 'size' | 'lowLod'>>) => void;
  setNodeVisible: (layerId: string, nodeId: string, visible: boolean) => void;
  /** Flags a node and everything under it for the low LOD; the layer flag follows its nodes. */
  setNodeLowLod: (layerId: string, nodeId: string, lowLod: boolean) => void;
  removeLayer: (id: string) => void;
  addBody: (body: Body) => void;
  updateBody: (id: string, patch: Partial<Pick<Body, 'name' | 'visible' | 'lowLod' | 'material'>>) => void;
  /** Moves the body; transient updates (gizmo drags) skip the history, `recordHistory` first. */
  setBodyPlacement: (id: string, placement: Placement, transient?: boolean) => void;
  removeBody: (id: string) => void;
  /** Bakes the evaluated mesh and removes every sketch/axis/path dependency. */
  convertBodyToSolid: (id: string, positions: ArrayLike<number>, indices: ArrayLike<number>) => void;
  /** Adds a primitive body resting on the ground at `position` and selects it; returns its id. */
  addPrimitive: (shape: PrimitiveShape, position?: [number, number, number]) => string;
  addFeature: (bodyId: string, feature: Feature) => void;
  /** New bodies and features on existing bodies in one undo step (multi-profile extrude). */
  addSolids: (bodies: Body[], features: { bodyId: string; feature: Feature }[]) => void;
  /** Replaces the shapes of sketches in one undo step (sketch edits touching many curves). */
  setSketchShapes: (shapes: Record<string, Shape2D[]>, transient?: boolean) => void;
  updateFeature: (bodyId: string, featureId: string, patch: Partial<Feature>) => void;
  removeFeature: (bodyId: string, featureId: string) => void;
  addSketch: (plane: SketchPlane) => string;
  addSketchAndFeature: (sketch: Sketch, bodyId: string, feature: Feature) => void;
  updateSketch: (id: string, patch: Partial<Sketch>) => void;
  removeSketch: (id: string) => void;
  addShape: (sketchId: string, shape: Shape2D) => void;
  /** Replaces a shape; transient updates (drags) skip the history, `recordHistory` first. */
  updateShape: (sketchId: string, shape: Shape2D, transient?: boolean) => void;
  removeShape: (sketchId: string, shapeId: string) => void;
  renameLayer: (id: string, name: string) => void;
  renameBody: (id: string, name: string) => void;
  renameSketch: (id: string, name: string) => void;
  renameFeature: (bodyId: string, featureId: string, name: string) => void;
  moveSketchLoop: (sketchId: string, shapeIds: string[], dx: number, dy: number, transient?: boolean) => void;
  transformCurve: (sketchId: string, shapeId: string, transform: { translate?: Vec2; rotate?: number; scale?: Vec2 }, transient?: boolean) => void;
  transformSketchShapes: (sketchId: string, shapeIds: string[], transform: { translate?: Vec2; rotate?: number; scale?: Vec2 }, transient?: boolean) => void;
  moveCurvePoint: (sketchId: string, shapeId: string, pointIndex: number, point: Vec2, transient?: boolean) => void;
  moveVertex: (bodyId: string, vertexIndex: number, delta: [number, number, number], transient?: boolean) => void;
  moveEdge: (bodyId: string, edgeIndex: number, delta: [number, number, number], transient?: boolean) => void;
  setTool: (tool: Tool) => void;
  reuseLastToolOrAction: () => void;
  clearLastReusedNotice: () => void;
  setLastAction: (action: LastAction) => void;
  setToolOptions: (patch: Partial<ToolOptions>) => void;
  setInferenceSettings: (patch: Partial<InferenceSettings>) => void;
  setSketchPreview: (preview: SketchPreview | null) => void;
  setHoveredShape: (shape: { sketchId: string; shapeId: string } | null) => void;
  setLoopCheck: (check: LoopCheckPreview | null) => void;
  setNumericEntry: (text: string) => void;
  setBodyInfo: (id: string, info: BodyInfo | null) => void;
  updateMaterial: (id: string, patch: Partial<PbrMaterial>) => void;
  setGizmoMode: (mode: GizmoMode) => void;
  /** Pushes the current undoable slice; called by the actions above and at the start of a drag. */
  /** Adds a parameter (a unique name is chosen when none is given); returns its id. */
  addParameter: (parameter?: Partial<Parameter>) => string;
  updateParameter: (id: string, patch: Partial<Parameter>) => void;
  removeParameter: (id: string) => void;
  /** Drives a recipe number by a formula, or frees it (null). */
  setBinding: (path: string, binding: Binding | null) => void;
  recordHistory: () => void;
  /** Starts editing one sketch in isolation (see SketchEditSession). */
  enterSketchEdit: (sketchId: string) => void;
  /** Ends the edit session keeping the changes as one undo step. */
  finishSketchEdit: () => void;
  /** Ends the edit session discarding every change made in it. */
  cancelSketchEdit: () => void;
  undo: () => void;
  redo: () => void;
  setPlane: (id: PlaneId, offset: number) => void;
  setPlaneVisible: (id: PlaneId, visible: boolean) => void;
  setWorkPlane: (plane: SketchPlane, options?: { skipPrompt?: boolean }) => boolean;
  /** Slides the work plane along its own normal without changing the current view. */
  moveWorkPlane: (distance: number, transient?: boolean, options?: { skipPrompt?: boolean }) => boolean;
  flipWorkPlane: (options?: { skipPrompt?: boolean }) => boolean;
  rotateWorkPlane: (axis: 'x' | 'y', degrees: number, options?: { skipPrompt?: boolean }) => boolean;
  resetWorkPlane: (id?: PlaneId, options?: { skipPrompt?: boolean }) => boolean;
  setWorkPlaneLocked: (locked: boolean) => void;
  setWorkPlaneVisible: (visible: boolean) => void;
  startSettingWorkPlane: (mode?: WorkPlaneSetupMode) => void;
  setWorkPlaneMode: (mode: WorkPlaneSetupMode) => void;
  addWorkPlanePoint: (point: [number, number, number]) => void;
  clearWorkPlanePoints: () => void;
  cancelSettingWorkPlane: () => void;
  /** Puts each plane just outside the model on its axis, so the 2D views show the whole model. */
  fitPlanes: (max: [number, number, number]) => void;
  addCamera: () => string;
  updateCamera: (id: string, patch: Partial<Omit<ModelingCamera, 'id'>>) => void;
  /** Marks one camera as the preview camera (clearing the others). */
  setPreviewCamera: (id: string) => void;
  removeCamera: (id: string) => void;
  select: (selection: Selection, additive?: boolean) => void;
  selectMany: (selections: SelectedItem[], additive?: boolean) => void;
  setLayout: (layout: Layout) => void;
  setPane: (index: number, view: PaneView) => void;
  setStyle: (index: number, style: ViewStyle) => void;
  setLod: (index: number, lod: Lod) => void;
  setActivePane: (index: number) => void;
  openCameraMenu: (menu: CameraMenu | null) => void;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function sameDirectEditPoints(a: Vec3[], b: Vec3[]): boolean {
  return a.length === b.length && a.every((point, index) => point.every((value, axis) => Math.abs(value - b[index]![axis]!) < 1e-5));
}

/** Accumulates one gizmo drag into a single feature instead of creating a feature per frame. */
function withDirectEdit(body: Body, points: Vec3[], delta: Vec3, name: string): Body {
  const last = body.features.at(-1);
  if (last?.kind === 'direct-edit' && sameDirectEditPoints(last.points, points)) {
    const moved: Vec3 = [last.delta[0] + delta[0], last.delta[1] + delta[1], last.delta[2] + delta[2]];
    return { ...body, features: [...body.features.slice(0, -1), { ...last, delta: moved }] };
  }
  return { ...body, features: [...body.features, { kind: 'direct-edit', id: newId('feature'), name, points, delta }] };
}

function transformedShape(shape: Shape2D, transform: { translate?: Vec2; rotate?: number; scale?: Vec2 }): Shape2D {
  if (transform.translate) return translateShape(shape, transform.translate[0], transform.translate[1]);
  const contour = shape.kind === 'polyline' ? shape.points : shapeContour(shape);
  if (contour.length === 0) return shape;
  const minX = Math.min(...contour.map((point) => point[0]));
  const maxX = Math.max(...contour.map((point) => point[0]));
  const minY = Math.min(...contour.map((point) => point[1]));
  const maxY = Math.max(...contour.map((point) => point[1]));
  const center: Vec2 = [(minX + maxX) / 2, (minY + maxY) / 2];
  if (transform.rotate) {
    if (shape.kind === 'circle') return shape;
    if (shape.kind === 'polygon') return { ...shape, rotation: shape.rotation + transform.rotate };
    const angle = transform.rotate * Math.PI / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const points = contour.map(([x, y]) => {
      const dx = x - center[0];
      const dy = y - center[1];
      return [center[0] + dx * cos - dy * sin, center[1] + dx * sin + dy * cos] as Vec2;
    });
    return { kind: 'polyline', id: shape.id, name: shape.name, points, closed: shape.kind === 'polyline' ? shape.closed : true };
  }
  if (transform.scale) {
    const [sx, sy] = transform.scale;
    if (shape.kind === 'rect') return { ...shape, x: center[0] + (shape.x - center[0]) * sx, y: center[1] + (shape.y - center[1]) * sy, width: shape.width * sx, height: shape.height * sy };
    if (shape.kind === 'circle' && Math.abs(sx - sy) < 1e-4) return { ...shape, radius: shape.radius * Math.abs(sx) };
    if (shape.kind === 'polygon' && Math.abs(sx - sy) < 1e-4) return { ...shape, radius: shape.radius * Math.abs(sx) };
    const points = contour.map(([x, y]) => [center[0] + (x - center[0]) * sx, center[1] + (y - center[1]) * sy] as Vec2);
    return { kind: 'polyline', id: shape.id, name: shape.name, points, closed: shape.kind === 'polyline' ? shape.closed : true };
  }
  return shape;
}

function mapNodes(nodes: LayerNode[], fn: (node: LayerNode) => LayerNode): LayerNode[] {
  return nodes.map((node) => fn({ ...node, children: mapNodes(node.children, fn) }));
}

function anyNode(nodes: LayerNode[], test: (node: LayerNode) => boolean): boolean {
  return nodes.some((node) => test(node) || anyNode(node.children, test));
}

/** Sets `lowLod` on a subtree (the node and all descendants). */
function flagSubtree(nodes: LayerNode[], nodeId: string, lowLod: boolean): LayerNode[] {
  const flagAll = (list: LayerNode[]): LayerNode[] => list.map((node) => ({ ...node, lowLod, children: flagAll(node.children) }));
  return nodes.map((node) => (node.id === nodeId ? { ...node, lowLod, children: flagAll(node.children) } : { ...node, children: flagSubtree(node.children, nodeId, lowLod) }));
}

/** Layer-level `lowLod` mirrors its nodes; `undefined` nodes (older saves) inherit the layer flag. */
export function withLodFlags(layer: Layer): Layer {
  const fill = (nodes: LayerNode[]): LayerNode[] => nodes.map((node) => ({ ...node, lowLod: node.lowLod ?? layer.lowLod ?? false, children: fill(node.children) }));
  const nodes = fill(layer.nodes);
  return { ...layer, nodes, lowLod: anyNode(nodes, (node) => node.lowLod) };
}

/**
 * Bound recipe numbers follow their formulas: whenever the recipe, the parameters or the
 * bindings change, the formulas are applied in the same update (one notification, so nothing
 * ever sees an undriven recipe). Unchanged bodies and sketches keep their identity.
 */
function drive(state: ModelingState, patch: Partial<ModelingState>): Partial<ModelingState> {
  const touched = 'bodies' in patch || 'sketches' in patch || 'parameters' in patch || 'bindings' in patch;
  if (!touched) return patch;
  const next = { ...state, ...patch };
  if (next.parameters.length === 0 && Object.keys(next.bindings).length === 0) {
    return Object.keys(state.parameterValues).length || Object.keys(state.parameterErrors).length ? { ...patch, parameterValues: {}, parameterErrors: {} } : patch;
  }
  const driven = applyParameters(next, next.parameters, next.bindings);
  return {
    ...patch,
    ...(driven.bodies !== next.bodies ? { bodies: driven.bodies } : {}),
    ...(driven.sketches !== next.sketches ? { sketches: driven.sketches } : {}),
    parameterValues: driven.values,
    parameterErrors: driven.errors,
  };
}

export function createModelingStore(): StoreApi<ModelingState> {
  /** The last sketch the work plane created on its own (dropped again if it stays empty). */
  let autoSketchId: string | null = null;
  return createStore<ModelingState>((rawSet, get) => {
    const set = (partial: Partial<ModelingState> | ((state: ModelingState) => Partial<ModelingState>)) =>
      rawSet((state) => drive(state, typeof partial === 'function' ? partial(state) : partial));
    return {
    metadata: { name: '', id: '', idEdited: false, category: 'Personal/My Assets', tags: '' },
    modelSize: [0, 0, 0],
    layers: [],
    bodies: [],
    materials: presetMaterials(),
    bodyInfo: {},
    sketches: [],
    parameters: [],
    bindings: {},
    parameterValues: {},
    parameterErrors: {},
    tool: 'select',
    lastActiveTool: 'line',
    lastAction: { kind: 'tool', tool: 'line' },
    lastReusedNotice: null,
    toolOptions: {
      grid: 10,
      snap: true,
      sides: 6,
      extrude: { distance: 100, symmetric: false, op: 'new', target: null, profile: null, profiles: [], separate: false },
      modify: { copies: 1, mirrorCopy: true, rotateCopy: false, trimMode: 'corner', filletMode: 'fillet', filletSize: 50 },
      arcMode: 'three-point',
      circleMode: 'center',
      tangentArc: false,
      chain: true,
      drawRadius: 0,
      drawOffset: 0,
      arc: false,
      offset: -20,
      revolve: { axis: 'v', at: 0, angle: 360, op: 'new', target: null, axisRef: null, profile: null },
      sweep: { op: 'new', target: null, path: null, profile: null },
      mirror: { axis: 'x', offset: 0, keepOriginal: true },
      pattern: { mode: 'linear', count: 3, step: [200, 0, 0], axis: 'y', center: [0, 0, 0], angle: 360 },
      boolean: { op: 'subtract', tool: null },
      paintMaterial: DEFAULT_MATERIAL,
    },
    inferenceSettings: { ...DEFAULT_INFERENCE_SETTINGS, disabledTypes: {} },
    sketchPreview: null,
    hoveredShape: null,
    loopCheck: null,
    numericEntry: '',
    gizmoMode: 'translate',
    past: [],
    sketchEdit: null,
    modifyProgress: { points: 0, picked: false },
    future: [],
    cameras: [],
    planes: { top: 1100, front: 600, side: 600 },
    planeVisible: { top: true, front: true, side: true },
    workPlane: { kind: 'plane', id: 'top', offset: 0 },
    workPlaneVisible: true,
    workPlaneLocked: false,
    settingWorkPlane: false,
    workPlaneMode: 'surface',
    workPlanePoints: [],
    selection: null,
    selectionSet: [],
    layout: 'single',
    panes: ['3d', 'top', 'front', 'side'],
    styles: ['realistic', 'hidden-line', 'hidden-line', 'hidden-line'],
    lods: ['high', 'high', 'high', 'high'],
    activePane: 0,
    cameraMenu: null,

    hydrate: (saved) =>
      set((state) => ({
        metadata: saved.metadata ?? state.metadata,
        layers: (saved.layers ?? state.layers).map((layer) => withLodFlags({ ...layer, lowLod: layer.lowLod ?? false })),
        bodies: (saved.bodies ?? state.bodies).map((body) => ({ ...body, placement: { ...identityPlacement(), ...(body.placement ?? {}) }, material: body.material ?? DEFAULT_MATERIAL })),
        sketches: saved.sketches ?? state.sketches,
        parameters: saved.parameters ?? [],
        bindings: saved.bindings ?? {},
        materials: { ...presetMaterials(), ...(saved.materials ?? state.materials) },
        past: [],
        sketchEdit: null,
        modifyProgress: { points: 0, picked: false },
        future: [],
        cameras: (saved.cameras ?? state.cameras).map((camera, index, list) => ({ ...camera, visible: camera.visible ?? true, preview: camera.preview ?? (index === 0 && !list.some((item) => item.preview)) })),
        planes: saved.planes ?? state.planes,
        planeVisible: saved.planeVisible ?? state.planeVisible,
        workPlane: saved.workPlane ?? state.workPlane,
        workPlaneVisible: saved.workPlaneVisible ?? state.workPlaneVisible,
        workPlaneLocked: saved.workPlaneLocked ?? state.workPlaneLocked,
        layout: saved.layout ?? state.layout,
        panes: saved.panes ?? state.panes,
        styles: saved.styles ?? state.styles,
        lods: saved.lods ?? state.lods,
        selection: null,
        selectionSet: [],
      })),
    setMetadata: (patch) =>
      set((state) => {
        const next = { ...state.metadata, ...patch };
        if (patch.name !== undefined && !next.idEdited) next.id = slugify(patch.name);
        if (patch.id !== undefined) next.idEdited = true;
        return { metadata: next };
      }),
    setModelSize: (modelSize) => set({ modelSize }),
    addLayer: (layer) => set((state) => ({ layers: [...state.layers, layer] })),
    updateLayer: (id, patch) =>
      set((state) => ({
        layers: state.layers.map((layer) => {
          if (layer.id !== id) return layer;
          const next = { ...layer, ...patch };
          // The layer checkbox drives every node.
          if (patch.lowLod !== undefined) next.nodes = mapNodes(layer.nodes, (node) => ({ ...node, lowLod: patch.lowLod! }));
          return next;
        }),
      })),
    setNodeLowLod: (layerId, nodeId, lowLod) =>
      set((state) => ({
        layers: state.layers.map((layer) => (layer.id === layerId ? withLodFlags({ ...layer, nodes: flagSubtree(layer.nodes, nodeId, lowLod) }) : layer)),
      })),
    setNodeVisible: (layerId, nodeId, visible) =>
      set((state) => ({
        layers: state.layers.map((layer) => (layer.id === layerId ? { ...layer, nodes: mapNodes(layer.nodes, (node) => (node.id === nodeId ? { ...node, visible } : node)) } : layer)),
      })),
    removeLayer: (id) =>
      set((state) => ({
        layers: state.layers.filter((layer) => layer.id !== id),
        selection: state.selection && (state.selection.kind === 'layer' ? state.selection.id === id : state.selection.kind === 'node' && state.selection.layerId === id) ? null : state.selection,
        selectionSet: state.selectionSet.filter((item) => !((item.kind === 'layer' && item.id === id) || (item.kind === 'node' && item.layerId === id))),
      })),
    addPrimitive: (shape, position = [0, 0, 0]) => {
      get().recordHistory();
      const id = newId('body');
      const count = get().bodies.filter((body) => body.features[0]?.kind === 'primitive' && body.features[0].shape === shape).length + 1;
      const primitive: Primitive = { kind: 'primitive', id: newId('feature'), shape, size: PRIMITIVE_SIZES[shape], placement: identityPlacement() };
      const body: Body = { id, name: `${PRIMITIVE_LABELS[shape]} ${count}`, visible: true, lowLod: false, material: DEFAULT_MATERIAL, placement: { position, rotation: [0, 0, 0] }, features: [primitive] };
      set((state) => ({
        bodies: [...state.bodies, body],
        selection: { kind: 'body', id },
        selectionSet: [{ kind: 'body', id }],
        cameraMenu: null,
        lastAction: { kind: 'primitive', shape },
      }));
      return id;
    },
    updateBody: (id, patch) => {
      get().recordHistory();
      set((state) => ({ bodies: state.bodies.map((body) => (body.id === id ? { ...body, ...patch } : body)) }));
    },
    setBodyPlacement: (id, placement, transient = false) => {
      if (!transient) get().recordHistory();
      set((state) => ({ bodies: state.bodies.map((body) => (body.id === id ? { ...body, placement } : body)) }));
    },
    updateFeature: (bodyId, featureId, patch) => {
      get().recordHistory();
      set((state) => ({
        bodies: state.bodies.map((body) => (body.id === bodyId ? { ...body, features: body.features.map((feature) => (feature.id === featureId ? ({ ...feature, ...patch } as Feature) : feature)) } : body)),
      }));
    },
    addBody: (body) => {
      get().recordHistory();
      set((state) => ({ bodies: [...state.bodies, body], selection: { kind: 'body', id: body.id }, selectionSet: [{ kind: 'body', id: body.id }], cameraMenu: null }));
    },
    addFeature: (bodyId, feature) => {
      get().recordHistory();
      set((state) => ({ bodies: state.bodies.map((body) => (body.id === bodyId ? { ...body, features: [...body.features, feature] } : body)), selection: { kind: 'feature', bodyId, featureId: feature.id }, selectionSet: [{ kind: 'feature', bodyId, featureId: feature.id }] }));
    },
    addSolids: (bodies, features) => {
      if (!bodies.length && !features.length) return;
      get().recordHistory();
      set((state) => {
        const next = state.bodies.map((body) => {
          const added = features.filter((item) => item.bodyId === body.id).map((item) => item.feature);
          return added.length ? { ...body, features: [...body.features, ...added] } : body;
        });
        const selectionSet: SelectedItem[] = bodies.length ? bodies.map((body) => ({ kind: 'body', id: body.id })) : features.map((item) => ({ kind: 'feature', bodyId: item.bodyId, featureId: item.feature.id }));
        return { bodies: [...next, ...bodies], selection: selectionSet.at(-1) ?? null, selectionSet, cameraMenu: null };
      });
    },
    setSketchShapes: (shapes, transient = false) => {
      if (!transient) get().recordHistory();
      set((state) => ({ sketches: state.sketches.map((sketch) => (shapes[sketch.id] ? { ...sketch, shapes: shapes[sketch.id]! } : sketch)) }));
    },
    removeFeature: (bodyId, featureId) => {
      const body = findBody(get().bodies, bodyId);
      if (!body) return;
      if (body.features.length <= 1) {
        get().removeBody(bodyId);
        return;
      }
      get().recordHistory();
      set((state) => ({
        bodies: state.bodies.map((item) => (item.id === bodyId ? { ...item, features: item.features.filter((feature) => feature.id !== featureId) } : item)),
        selection: state.selection?.kind === 'feature' && state.selection.featureId === featureId ? { kind: 'body', id: bodyId } : state.selection,
        selectionSet: state.selectionSet.filter((item) => !(item.kind === 'feature' && item.bodyId === bodyId && item.featureId === featureId)),
      }));
    },
    addSketch: (plane) => {
      get().recordHistory();
      const id = newId('sketch');
      const count = get().sketches.length + 1;
      set((state) => ({ sketches: [...state.sketches, { id, name: `Sketch ${count}`, visible: true, plane, shapes: [] }], selection: { kind: 'sketch', id }, selectionSet: [{ kind: 'sketch', id }] }));
      return id;
    },
    addSketchAndFeature: (sketch, bodyId, feature) => {
      get().recordHistory();
      set((state) => ({
        sketches: [...state.sketches, sketch],
        bodies: state.bodies.map((body) => (body.id === bodyId ? { ...body, features: [...body.features, feature] } : body)),
        selection: { kind: 'feature', bodyId, featureId: feature.id },
        selectionSet: [{ kind: 'feature', bodyId, featureId: feature.id }],
      }));
    },
    updateSketch: (id, patch) => {
      get().recordHistory();
      // Reference plane of a sketch is permanently fixed to it and cannot be modified
      const { plane: _ignored, ...allowedPatch } = patch;
      set((state) => ({ sketches: state.sketches.map((sketch) => (sketch.id === id ? { ...sketch, ...allowedPatch } : sketch)) }));
    },
    removeSketch: (id) => {
      get().recordHistory();
      set((state) => ({
        sketches: state.sketches.filter((sketch) => sketch.id !== id),
        selection:
          (state.selection?.kind === 'sketch' && state.selection.id === id) ||
          ((state.selection?.kind === 'shape' || state.selection?.kind === 'loop') && state.selection.sketchId === id)
            ? null
            : state.selection,
        selectionSet: state.selectionSet.filter((item) => !((item.kind === 'sketch' && item.id === id) || ((item.kind === 'shape' || item.kind === 'curve-point' || item.kind === 'loop') && item.sketchId === id))),
      }));
    },
    addShape: (sketchId, shape) => {
      get().recordHistory();
      set((state) => {
        const targetSketch = state.sketches.find((s) => s.id === sketchId);
        const workPlane = targetSketch && !state.workPlaneLocked && !samePlane(state.workPlane, targetSketch.plane) ? targetSketch.plane : state.workPlane;
        return {
          sketches: state.sketches.map((sketch) => (sketch.id === sketchId ? { ...sketch, shapes: [...sketch.shapes, shape] } : sketch)),
          selection: { kind: 'shape', sketchId, shapeId: shape.id },
          selectionSet: [{ kind: 'shape', sketchId, shapeId: shape.id }],
          workPlane,
        };
      });
    },
    updateShape: (sketchId, shape, transient = false) => {
      if (!transient) get().recordHistory();
      set((state) => ({ sketches: state.sketches.map((sketch) => (sketch.id === sketchId ? { ...sketch, shapes: sketch.shapes.map((item) => (item.id === shape.id ? shape : item)) } : sketch)) }));
    },
    removeShape: (sketchId, shapeId) => {
      get().recordHistory();
      set((state) => ({
        sketches: state.sketches.map((sketch) => (sketch.id === sketchId ? { ...sketch, shapes: sketch.shapes.filter((shape) => shape.id !== shapeId) } : sketch)),
        selection:
          (state.selection?.kind === 'shape' && state.selection.shapeId === shapeId) ||
          (state.selection?.kind === 'loop' && state.selection.shapeIds.includes(shapeId))
            ? { kind: 'sketch', id: sketchId }
            : state.selection,
        selectionSet: state.selectionSet.filter((item) => !((item.kind === 'shape' || item.kind === 'curve-point') && item.sketchId === sketchId && item.shapeId === shapeId) && !(item.kind === 'loop' && item.sketchId === sketchId && item.shapeIds.includes(shapeId))),
      }));
    },
    renameLayer: (id, name) => {
      get().recordHistory();
      set((state) => ({ layers: state.layers.map((layer) => (layer.id === id ? { ...layer, name } : layer)) }));
    },
    renameBody: (id, name) => {
      get().recordHistory();
      set((state) => ({ bodies: state.bodies.map((body) => (body.id === id ? { ...body, name } : body)) }));
    },
    renameSketch: (id, name) => {
      get().recordHistory();
      set((state) => ({ sketches: state.sketches.map((sketch) => (sketch.id === id ? { ...sketch, name } : sketch)) }));
    },
    renameFeature: (bodyId, featureId, name) => {
      get().recordHistory();
      set((state) => ({
        bodies: state.bodies.map((body) =>
          body.id === bodyId
            ? {
                ...body,
                features: body.features.map((f) => (f.id === featureId ? { ...f, name } : f)),
              }
            : body,
        ),
      }));
    },
    moveSketchLoop: (sketchId, shapeIds, dx, dy, transient = false) => {
      if (!transient) get().recordHistory();
      set((state) => {
        const sketch = state.sketches.find((s) => s.id === sketchId);
        if (!sketch) return state;
        const setIds = new Set(shapeIds);
        const nextSketches = state.sketches.map((s) => {
          if (s.id !== sketchId) return s;
          return {
            ...s,
            shapes: s.shapes.map((sh) => (setIds.has(sh.id) ? translateShape(sh, dx, dy) : sh)),
          };
        });
        const p0 = toWorld(sketch.plane, [0, 0], 0);
        const p1 = toWorld(sketch.plane, [dx, dy], 0);
        const worldDelta: [number, number, number] = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
        const nextBodies = state.bodies.map((body) => {
          const usesSketch = body.features.some(
            (f) => (f.kind === 'extrude' || f.kind === 'revolve' || f.kind === 'sweep') && f.profile === sketchId,
          );
          if (!usesSketch) return body;
          const pos = body.placement.position;
          return {
            ...body,
            placement: {
              ...body.placement,
              position: [pos[0] + worldDelta[0], pos[1] + worldDelta[1], pos[2] + worldDelta[2]] as Vec3,
            },
          };
        });
        return { sketches: nextSketches, bodies: nextBodies };
      });
    },
    transformCurve: (sketchId, shapeId, transform, transient = false) => {
      if (!transient) get().recordHistory();
      set((state) => ({ sketches: state.sketches.map((sketch) => sketch.id !== sketchId ? sketch : {
        ...sketch,
        shapes: sketch.shapes.map((shape) => shape.id === shapeId ? transformedShape(shape, transform) : shape),
      }) }));
    },
    transformSketchShapes: (sketchId, shapeIds, transform, transient = false) => {
      if (!transient) get().recordHistory();
      const ids = new Set(shapeIds);
      set((state) => ({ sketches: state.sketches.map((sketch) => sketch.id !== sketchId ? sketch : {
        ...sketch,
        shapes: sketch.shapes.map((shape) => ids.has(shape.id) ? transformedShape(shape, transform) : shape),
      }) }));
    },
    moveCurvePoint: (sketchId, shapeId, pointIndex, point, transient = false) => {
      if (!transient) get().recordHistory();
      set((state) => ({ sketches: state.sketches.map((sketch) => sketch.id !== sketchId ? sketch : {
        ...sketch,
        shapes: sketch.shapes.map((shape) => {
          if (shape.id !== shapeId || shape.kind !== 'polyline' || !shape.points[pointIndex]) return shape;
          const points = shape.points.map((value, index) => index === pointIndex ? point : value);
          return { ...shape, points };
        }),
      }) }));
    },
    moveVertex: (bodyId, _vertexIndex, delta, transient = false) => {
      if (!transient) get().recordHistory();
      set((state) => {
        const selection = state.selection;
        if (selection?.kind !== 'vertex' || selection.bodyId !== bodyId || !selection.point) return state;
        return { bodies: state.bodies.map((body) => (body.id === bodyId ? withDirectEdit(body, [selection.point!], delta, 'Move vertex') : body)) };
      });
    },
    moveEdge: (bodyId, _edgeIndex, delta, transient = false) => {
      if (!transient) get().recordHistory();
      set((state) => {
        const selection = state.selection;
        if (selection?.kind !== 'edge' || selection.bodyId !== bodyId || !selection.p1 || !selection.p2) return state;
        return { bodies: state.bodies.map((body) => (body.id === bodyId ? withDirectEdit(body, [selection.p1!, selection.p2!], delta, 'Move edge') : body)) };
      });
    },
    setTool: (tool) =>
      set((state) => {
        const selected = curveRefFromSelection(state.selection);
        const closed = selected ? curveRefIsClosed(state.sketches, selected) : false;
        const toolOptions = { ...state.toolOptions };
        if (tool === 'extrude') {
          const profiles = profileGroupsFromSelection(state.selectionSet.length ? state.selectionSet : state.selection ? [state.selection] : []);
          toolOptions.extrude = { ...toolOptions.extrude, profile: profiles[0] ?? null, profiles };
        }
        if (tool === 'revolve') {
          toolOptions.revolve = closed
            ? { ...toolOptions.revolve, axisRef: null, profile: selected }
            : { ...toolOptions.revolve, axisRef: selected, profile: null };
        }
        if (tool === 'sweep') toolOptions.sweep = closed
          ? { ...toolOptions.sweep, path: null, profile: selected }
          : { ...toolOptions.sweep, path: selected, profile: null };
        return ({
        tool,
        toolOptions,
        lastActiveTool: tool !== 'select' ? tool : (state.tool !== 'select' ? state.tool : state.lastActiveTool),
        lastAction: tool !== 'select' ? { kind: 'tool', tool } : state.lastAction,
        sketchPreview: null,
        hoveredShape: null,
        loopCheck: null,
        numericEntry: '',
        cameraMenu: null,
        settingWorkPlane: false,
        workPlanePoints: [],
      }); }),
    reuseLastToolOrAction: () => {
      const state = get();
      const action = state.lastAction;
      let notice = '';
      if (action) {
        if (action.kind === 'tool') {
          get().setTool(action.tool);
          notice = `Re-used: ${action.tool}`;
        } else if (action.kind === 'primitive') {
          get().addPrimitive(action.shape);
          notice = `Re-used: Add ${action.shape}`;
        } else if (action.kind === 'workplane') {
          get().startSettingWorkPlane(action.mode);
          notice = `Re-used: Set work plane (${action.mode})`;
        }
      } else if (state.lastActiveTool && state.lastActiveTool !== 'select') {
        get().setTool(state.lastActiveTool);
        notice = `Re-used: ${state.lastActiveTool}`;
      } else {
        get().setTool('line');
        notice = 'Re-used: line';
      }
      set({ lastReusedNotice: notice });
    },
    clearLastReusedNotice: () => set({ lastReusedNotice: null }),
    setLastAction: (lastAction) => set({ lastAction }),
    setToolOptions: (patch) => set((state) => ({ toolOptions: { ...state.toolOptions, ...patch } })),
    setInferenceSettings: (patch) => set((state) => ({ inferenceSettings: { ...state.inferenceSettings, ...patch } })),
    setSketchPreview: (sketchPreview) => set({ sketchPreview }),
    setHoveredShape: (hoveredShape) => set((state) => {
      if (state.hoveredShape?.sketchId === hoveredShape?.sketchId && state.hoveredShape?.shapeId === hoveredShape?.shapeId) return state;
      return { hoveredShape };
    }),
    setLoopCheck: (loopCheck) => set({ loopCheck }),
    setNumericEntry: (numericEntry) => set({ numericEntry }),
    removeBody: (id) => {
      get().recordHistory();
      set((state) => {
        const bodyInfo = { ...state.bodyInfo };
        delete bodyInfo[id];
        const selection = state.selection;
        const gone =
          (selection?.kind === 'body' && selection.id === id) ||
          ((selection?.kind === 'face' || selection?.kind === 'feature' || selection?.kind === 'vertex' || selection?.kind === 'edge') && selection.bodyId === id);
        return { bodies: state.bodies.filter((body) => body.id !== id), bodyInfo, selection: gone ? null : selection, selectionSet: state.selectionSet.filter((item) => !((item.kind === 'body' && item.id === id) || ((item.kind === 'face' || item.kind === 'feature' || item.kind === 'vertex' || item.kind === 'edge') && item.bodyId === id))) };
      });
    },
    convertBodyToSolid: (id, positions, indices) => {
      get().recordHistory();
      set((state) => ({
        bodies: state.bodies.map((body) => body.id === id ? {
          ...body,
          features: [{ kind: 'mesh', id: newId('feature'), name: 'Converted solid', positions: Array.from(positions), indices: Array.from(indices) }],
        } : body),
        selection: { kind: 'body', id },
        selectionSet: [{ kind: 'body', id }],
      }));
    },
    setBodyInfo: (id, info) =>
      set((state) => {
        const bodyInfo = { ...state.bodyInfo };
        if (info) bodyInfo[id] = info;
        else delete bodyInfo[id];
        return { bodyInfo };
      }),
    updateMaterial: (id, patch) => {
      get().recordHistory();
      set((state) => ({ materials: { ...state.materials, [id]: { ...(state.materials[id] ?? { name: id, color: '#9a9aa3', roughness: 0.8, metalness: 0, opacity: 1 }), ...patch } } }));
    },
    setGizmoMode: (gizmoMode) => set({ gizmoMode }),
    addParameter: (parameter = {}) => {
      get().recordHistory();
      const id = newId('param');
      set((state) => ({
        parameters: [...state.parameters, { id, type: 'length', value: 1000, exposed: true, ...parameter, name: parameter.name && validParameterName(parameter.name) ? parameter.name : uniqueParameterName(state.parameters, parameter.type === 'count' ? 'count' : 'width') }],
      }));
      return id;
    },
    updateParameter: (id, patch) => {
      const state = get();
      const current = state.parameters.find((parameter) => parameter.id === id);
      if (!current) return;
      if (patch.name !== undefined && patch.name !== current.name) {
        if (!validParameterName(patch.name)) throw new Error('Use letters, digits and _ (not starting with a digit), and not a function name');
        if (state.parameters.some((parameter) => parameter.id !== id && parameter.name.toLowerCase() === patch.name!.toLowerCase())) throw new Error(`There is already a parameter called ${patch.name}`);
      }
      get().recordHistory();
      const rename = patch.name !== undefined && patch.name !== current.name ? { from: current.name, to: patch.name } : null;
      set((now) => ({
        parameters: now.parameters.map((parameter) => {
          const next = parameter.id === id ? { ...parameter, ...patch } : parameter;
          return rename && next.expression ? { ...next, expression: renameInFormula(next.expression, rename.from, rename.to) } : next;
        }),
        // Formulas follow a renamed parameter.
        bindings: rename ? Object.fromEntries(Object.entries(now.bindings).map(([path, binding]) => [path, { ...binding, expression: renameInFormula(binding.expression, rename.from, rename.to) }])) : now.bindings,
      }));
    },
    removeParameter: (id) => {
      get().recordHistory();
      set((state) => ({ parameters: state.parameters.filter((parameter) => parameter.id !== id) }));
    },
    setBinding: (path, binding) => {
      get().recordHistory();
      set((state) => {
        const bindings = { ...state.bindings };
        if (binding && binding.expression.trim()) bindings[path] = { ...binding, expression: binding.expression.trim().replace(/^=\s*/, '') };
        else delete bindings[path];
        return { bindings };
      });
    },
    recordHistory: () =>
      set((state) => {
        const trimmed = state.past.length >= HISTORY_LIMIT;
        const past = [...state.past.slice(-(HISTORY_LIMIT - 1)), snapshot(state)];
        // Trimming the oldest entry shifts where the edit session started.
        const sketchEdit = state.sketchEdit && trimmed ? { ...state.sketchEdit, base: Math.max(1, state.sketchEdit.base - 1) } : state.sketchEdit;
        return { past, future: [], sketchEdit };
      }),
    enterSketchEdit: (sketchId) => {
      const state = get();
      const sketch = state.sketches.find((item) => item.id === sketchId);
      if (!sketch) return;
      if (state.sketchEdit) {
        if (state.sketchEdit.sketchId === sketchId) return;
        get().finishSketchEdit();
      }
      get().recordHistory();
      set((current) => ({
        sketchEdit: { sketchId, base: current.past.length, entry: current.past[current.past.length - 1]! },
        sketches: current.sketches.map((item) => (item.id === sketchId ? { ...item, visible: true } : item)),
        workPlane: sketch.plane,
        workPlaneVisible: true,
        workPlaneLocked: true,
        selection: { kind: 'sketch', id: sketchId },
        selectionSet: [{ kind: 'sketch', id: sketchId }],
        tool: 'select',
        sketchPreview: null,
        cameraMenu: null,
      }));
    },
    finishSketchEdit: () =>
      set((state) => {
        const session = state.sketchEdit;
        if (!session) return state;
        return {
          sketchEdit: null,
          modifyProgress: { points: 0, picked: false },
          // Everything since the entry snapshot folds into it: one undo returns to before the session.
          past: state.past.slice(0, session.base),
          future: [],
          workPlaneLocked: session.entry.workPlaneLocked,
          selection: { kind: 'sketch', id: session.sketchId },
          selectionSet: [{ kind: 'sketch', id: session.sketchId }],
          tool: 'select',
          sketchPreview: null,
        };
      }),
    cancelSketchEdit: () =>
      set((state) => {
        const session = state.sketchEdit;
        if (!session) return state;
        return {
          ...session.entry,
          sketchEdit: null,
          modifyProgress: { points: 0, picked: false },
          past: state.past.slice(0, session.base - 1),
          future: [],
          selection: { kind: 'sketch', id: session.sketchId },
          selectionSet: [{ kind: 'sketch', id: session.sketchId }],
          tool: 'select',
          sketchPreview: null,
        };
      }),
    undo: () =>
      set((state) => {
        // Inside a sketch edit session undo stops at the session start (Cancel goes further).
        if (state.sketchEdit && state.past.length <= state.sketchEdit.base) return state;
        const entry = state.past[state.past.length - 1];
        if (!entry) return {};
        const selection = keepSelection(state.selection, entry);
        return { past: state.past.slice(0, -1), future: [...state.future, snapshot(state)], ...entry, selection, selectionSet: selection ? [selection] : [], sketchPreview: null };
      }),
    redo: () =>
      set((state) => {
        const entry = state.future[state.future.length - 1];
        if (!entry) return {};
        const selection = keepSelection(state.selection, entry);
        return { future: state.future.slice(0, -1), past: [...state.past, snapshot(state)], ...entry, selection, selectionSet: selection ? [selection] : [], sketchPreview: null };
      }),
    setPlane: (id, value) => set((state) => ({ planes: { ...state.planes, [id]: Math.round(value) } })),
    setPlaneVisible: (id, visible) => set((state) => ({ planeVisible: { ...state.planeVisible, [id]: visible } })),
    setWorkPlane: (workPlane, _options) => {
      if (get().workPlaneLocked) return false;
      const existing = get().sketches.find((sketch) => samePlane(sketch.plane, workPlane));
      if (samePlane(get().workPlane, workPlane)) {
        set({ settingWorkPlane: false, workPlanePoints: [], ...(existing ? { selection: { kind: 'sketch', id: existing.id }, selectionSet: [{ kind: 'sketch', id: existing.id }] } : {}) });
        if (existing) return true;
      }
      get().recordHistory();
      // The plane always gets a sketch to draw into: the one already on it, else a new one. An
      // empty sketch made automatically for the previous plane is dropped (moving the plane
      // around must not leave a trail of empty sketches).
      set((state) => {
        const previous = state.sketches.find((sketch) => sketch.id === autoSketchId && sketch.shapes.length === 0 && !samePlane(sketch.plane, workPlane));
        let sketches = previous ? state.sketches.filter((sketch) => sketch !== previous) : state.sketches;
        let sketchId = existing?.id;
        if (!sketchId) {
          sketchId = newId('sketch');
          autoSketchId = sketchId;
          sketches = [...sketches, { id: sketchId, name: `Sketch ${sketches.length + 1}`, visible: true, plane: workPlane, shapes: [] }];
        }
        return {
          workPlane,
          workPlaneVisible: true,
          settingWorkPlane: false,
          workPlanePoints: [],
          sketches,
          selection: { kind: 'sketch', id: sketchId },
          selectionSet: [{ kind: 'sketch', id: sketchId }],
        };
      });
      return true;
    },
    moveWorkPlane: (distance, _transient = false, options) => {
      if (get().workPlaneLocked) return false;
      if (Math.abs(distance) < 1e-6) return true;
      const nextPlane = WorkPlaneService.offset(get().workPlane, distance);
      return get().setWorkPlane(nextPlane, options);
    },
    flipWorkPlane: (options) => {
      if (get().workPlaneLocked) return false;
      const nextPlane = WorkPlaneService.flip(get().workPlane);
      return get().setWorkPlane(nextPlane, options);
    },
    rotateWorkPlane: (axis, degrees, options) => {
      if (get().workPlaneLocked) return false;
      if (Math.abs(degrees) < 1e-6) return true;
      const nextPlane = WorkPlaneService.rotate(get().workPlane, axis, degrees);
      return get().setWorkPlane(nextPlane, options);
    },
    resetWorkPlane: (id = 'top', options) => {
      if (get().workPlaneLocked) return false;
      const nextPlane: SketchPlane = { kind: 'plane', id, offset: 0 };
      return get().setWorkPlane(nextPlane, options);
    },
    setWorkPlaneLocked: (workPlaneLocked) => set({ workPlaneLocked, settingWorkPlane: false, workPlanePoints: [] }),
    setWorkPlaneVisible: (workPlaneVisible) => set({ workPlaneVisible }),
    startSettingWorkPlane: (mode = 'surface') => {
      if (!get().workPlaneLocked) {
        set({
          settingWorkPlane: true,
          workPlaneMode: mode,
          workPlanePoints: [],
          tool: 'select',
          sketchPreview: null,
          selection: null,
          selectionSet: [],
          lastAction: { kind: 'workplane', mode },
        });
      }
    },
    setWorkPlaneMode: (mode) => set({ workPlaneMode: mode, workPlanePoints: [] }),
    addWorkPlanePoint: (point) => {
      const current = get().workPlanePoints;
      const next = [...current, point];
      if (next.length >= 3) {
        try {
          const p1 = next[0]!;
          const p2 = next[1]!;
          const p3 = next[2]!;
          const plane = WorkPlaneService.fromThreePoints(p1, p2, p3);
          get().setWorkPlane(plane);
        } catch {
          // Keep the first 2 points if 3rd point is collinear
          set({ workPlanePoints: [next[0]!, next[1]!] });
        }
      } else {
        set({ workPlanePoints: next });
      }
    },
    clearWorkPlanePoints: () => set({ workPlanePoints: [] }),
    cancelSettingWorkPlane: () => set({ settingWorkPlane: false, workPlanePoints: [] }),
    fitPlanes: ([x, y, z]) => set({ planes: { top: Math.round(y + 100), front: Math.round(z + 100), side: Math.round(x + 100) } }),
    addCamera: () => {
      const id = newId('camera');
      const count = get().cameras.length + 1;
      const [w, h, d] = get().modelSize;
      const reach = Math.max(1500, Math.max(w, h, d) * 1.8);
      const camera: ModelingCamera = { id, name: `Camera ${count}`, visible: true, preview: get().cameras.length === 0, eye: [Math.round(reach), Math.round(Math.max(900, h * 0.9)), Math.round(reach)], aim: [0, Math.round(h / 2), 0], fov: 60 };
      set((state) => ({ cameras: [...state.cameras, camera], selection: { kind: 'camera', id, part: 'eye' }, selectionSet: [{ kind: 'camera', id, part: 'eye' }] }));
      return id;
    },
    updateCamera: (id, patch) => set((state) => ({ cameras: state.cameras.map((camera) => (camera.id === id ? { ...camera, ...patch } : camera)) })),
    setPreviewCamera: (id) => set((state) => ({ cameras: state.cameras.map((camera) => ({ ...camera, preview: camera.id === id })) })),
    removeCamera: (id) =>
      set((state) => ({
        // Deleting the preview camera hands the role to the first remaining one.
        cameras: state.cameras.filter((camera) => camera.id !== id).map((camera, index, list) => (list.some((item) => item.preview) ? camera : { ...camera, preview: index === 0 })),
        panes: state.panes.map((pane) => (pane === `camera:${id}` ? '3d' : pane)) as ModelingState['panes'],
        selection: state.selection?.kind === 'camera' && state.selection.id === id ? null : state.selection,
        selectionSet: state.selectionSet.filter((item) => !(item.kind === 'camera' && item.id === id)),
        cameraMenu: null,
      })),
    select: (selection, additive = false) => set((state) => {
      const current = state.selectionSet.length > 0 ? state.selectionSet : (state.selection ? [state.selection] : []);
      let selectionSet: SelectedItem[] = [];
      let active = selection;
      if (selection && additive) {
        const key = selectionKey(selection);
        const exists = current.some((item) => selectionKey(item) === key);
        selectionSet = exists ? current.filter((item) => selectionKey(item) !== key) : [...current, selection];
        active = exists ? (selectionSet.at(-1) ?? null) : selection;
      } else if (selection) selectionSet = [selection];

      let workPlane = state.workPlane;
      let workPlaneVisible = state.workPlaneVisible;
      const targetSketchId = selectedSketchId(active, state.bodies);
      if (targetSketchId && !state.workPlaneLocked) {
        const targetSketch = state.sketches.find((s) => s.id === targetSketchId);
        if (targetSketch && !samePlane(workPlane, targetSketch.plane)) {
          workPlane = targetSketch.plane;
          workPlaneVisible = true;
        }
      }

      const ref = curveRefFromSelection(selection);
      if (!ref || (state.tool !== 'extrude' && state.tool !== 'revolve' && state.tool !== 'sweep')) {
        return { selection: active, selectionSet, cameraMenu: null, workPlane, workPlaneVisible };
      }
      const closed = curveRefIsClosed(state.sketches, ref);
      if (state.tool === 'extrude') return { selection: active, selectionSet, cameraMenu: null, workPlane, workPlaneVisible, toolOptions: { ...state.toolOptions, extrude: withProfiles(state.toolOptions.extrude, selectionSet) } };
      if (state.tool === 'revolve') {
        const revolve = state.toolOptions.revolve;
        const next = !revolve.axisRef && !closed ? { ...revolve, axisRef: ref } : { ...revolve, profile: ref };
        return { selection: active, selectionSet, cameraMenu: null, workPlane, workPlaneVisible, toolOptions: { ...state.toolOptions, revolve: next } };
      }
      const sweep = state.toolOptions.sweep;
      const next = !sweep.path && !closed ? { ...sweep, path: ref } : { ...sweep, profile: ref };
      return { selection: active, selectionSet, cameraMenu: null, workPlane, workPlaneVisible, toolOptions: { ...state.toolOptions, sweep: next } };
    }),
    selectMany: (selections, additive = false) => {
      if (!additive) {
        const unique = [...new Map(selections.map((item) => [selectionKey(item), item])).values()];
        const active = unique.at(-1) ?? null;
        set((state) => {
          let workPlane = state.workPlane;
          let workPlaneVisible = state.workPlaneVisible;
          const targetSketchId = unique.map((item) => selectedSketchId(item, state.bodies)).find(Boolean);
          if (targetSketchId && !state.workPlaneLocked) {
            const targetSketch = state.sketches.find((s) => s.id === targetSketchId);
            if (targetSketch && !samePlane(workPlane, targetSketch.plane)) {
              workPlane = targetSketch.plane;
              workPlaneVisible = true;
            }
          }
          return { selectionSet: unique, selection: active, cameraMenu: null, workPlane, workPlaneVisible, ...(state.tool === 'extrude' ? { toolOptions: { ...state.toolOptions, extrude: withProfiles(state.toolOptions.extrude, unique) } } : {}) };
        });
        return;
      }
      set((state) => {
        const byKey = new Map((state.selectionSet.length ? state.selectionSet : state.selection ? [state.selection] : []).map((item) => [selectionKey(item), item]));
        for (const item of selections) byKey.set(selectionKey(item), item);
        const selectionSet = [...byKey.values()];
        const active = selections.at(-1) ?? state.selection;
        let workPlane = state.workPlane;
        let workPlaneVisible = state.workPlaneVisible;
        const targetSketchId = selectedSketchId(active, state.bodies);
        if (targetSketchId && !state.workPlaneLocked) {
          const targetSketch = state.sketches.find((s) => s.id === targetSketchId);
          if (targetSketch && !samePlane(workPlane, targetSketch.plane)) {
            workPlane = targetSketch.plane;
            workPlaneVisible = true;
          }
        }
        return { selectionSet, selection: active, cameraMenu: null, workPlane, workPlaneVisible, ...(state.tool === 'extrude' ? { toolOptions: { ...state.toolOptions, extrude: withProfiles(state.toolOptions.extrude, selectionSet) } } : {}) };
      });
    },
    setLayout: (layout) => set((state) => ({ layout, activePane: Math.min(state.activePane, paneCount(layout) - 1) })),
    setPane: (index, view) =>
      set((state) => {
        const panes = [...state.panes] as ModelingState['panes'];
        panes[index] = view;
        return { panes, cameraMenu: null };
      }),
    setLod: (index, lod) =>
      set((state) => {
        const lods = [...state.lods] as ModelingState['lods'];
        lods[index] = lod;
        return { lods };
      }),
    setStyle: (index, style) =>
      set((state) => {
        const styles = [...state.styles] as ModelingState['styles'];
        styles[index] = style;
        return { styles };
      }),
    setActivePane: (index) => set({ activePane: index }),
    openCameraMenu: (cameraMenu) => set({ cameraMenu }),
    };
  });
}

function snapshot(state: ModelingState): HistoryEntry {
  return { bodies: state.bodies, sketches: state.sketches, parameters: state.parameters, bindings: state.bindings, materials: state.materials, workPlane: state.workPlane, workPlaneVisible: state.workPlaneVisible, workPlaneLocked: state.workPlaneLocked };
}

/** A body / feature / sketch / shape selection survives undo/redo only while its target exists. */
function keepSelection(selection: Selection, entry: HistoryEntry): Selection {
  if (!selection) return null;
  if (selection.kind === 'body') return entry.bodies.some((body) => body.id === selection.id) ? selection : null;
  if (selection.kind === 'face') return entry.bodies.some((body) => body.id === selection.bodyId) ? selection : null;
  if (selection.kind === 'vertex' || selection.kind === 'edge') return entry.bodies.some((body) => body.id === selection.bodyId) ? selection : null;
  if (selection.kind === 'feature') return entry.bodies.some((body) => body.id === selection.bodyId && body.features.some((feature) => feature.id === selection.featureId)) ? selection : null;
  if (selection.kind === 'sketch') return entry.sketches.some((sketch) => sketch.id === selection.id) ? selection : null;
  if (selection.kind === 'shape') return entry.sketches.some((sketch) => sketch.id === selection.sketchId && sketch.shapes.some((shape) => shape.id === selection.shapeId)) ? selection : null;
  if (selection.kind === 'curve-point') return entry.sketches.some((sketch) => sketch.id === selection.sketchId && sketch.shapes.some((shape) => shape.id === selection.shapeId && shape.kind === 'polyline' && Boolean(shape.points[selection.pointIndex]))) ? selection : null;
  if (selection.kind === 'loop') return entry.sketches.some((sketch) => sketch.id === selection.sketchId && selection.shapeIds.every((id) => sketch.shapes.some((shape) => shape.id === id))) ? selection : null;
  return selection;
}

export function findSketch(sketches: Sketch[], id: string): Sketch | null {
  return sketches.find((sketch) => sketch.id === id) ?? null;
}

/** Converts a viewport or Layers curve/loop selection into a persistent feature driver. */
export function curveRefFromSelection(selection: Selection): CurveRef | null {
  if (selection?.kind === 'shape') return { sketchId: selection.sketchId, shapeIds: [selection.shapeId] };
  if (selection?.kind === 'curve-point') return { sketchId: selection.sketchId, shapeIds: [selection.shapeId] };
  if (selection?.kind === 'loop') return { sketchId: selection.sketchId, shapeIds: [...selection.shapeIds] };
  return null;
}

/**
 * Groups every selected curve (shapes, curve points, loops) by sketch, in selection order: each
 * group becomes one extrude feature. Regions picked earlier survive for sketches still present.
 */
export function profileGroupsFromSelection(items: readonly SelectedItem[], previous: readonly ProfileGroup[] = []): ProfileGroup[] {
  const groups = new Map<string, ProfileGroup>();
  for (const item of items) {
    const ref = curveRefFromSelection(item);
    if (!ref) continue;
    const group = groups.get(ref.sketchId) ?? { sketchId: ref.sketchId, shapeIds: [] };
    for (const id of ref.shapeIds) if (!group.shapeIds.includes(id)) group.shapeIds.push(id);
    groups.set(ref.sketchId, group);
  }
  return [...groups.values()].map((group) => {
    const before = previous.find((item) => item.sketchId === group.sketchId);
    return before?.regions?.length ? { ...group, regions: before.regions } : group;
  });
}

function withProfiles(extrude: ToolOptions['extrude'], items: readonly SelectedItem[]): ToolOptions['extrude'] {
  const profiles = profileGroupsFromSelection(items, extrude.profiles);
  return { ...extrude, profile: profiles[0] ?? null, profiles };
}

/** True when the curves enclose at least one region (see kernel/regions.ts): closed shapes, lines meeting or crossing into loops. */
export function curveRefIsClosed(sketches: Sketch[], ref: CurveRef): boolean {
  const sketch = sketches.find((item) => item.id === ref.sketchId);
  if (!sketch || ref.shapeIds.length === 0) return false;
  const shapes = sketch.shapes.filter((shape) => ref.shapeIds.includes(shape.id));
  if (shapes.length !== ref.shapeIds.length) return false;
  if (shapes.length === 1) {
    const shape = shapes[0]!;
    if (shape.kind !== 'polyline' || shape.closed !== false) return true;
  }
  return arrangeSketch(shapes).faces.length > 0;
}

/** The sketch a selection points at (a sketch itself, one of its shapes, loops, curve-points, or linked features), if any. */
export function selectedSketchId(selection: Selection, bodies?: Body[]): string | null {
  if (selection?.kind === 'sketch') return selection.id;
  if (selection?.kind === 'shape') return selection.sketchId;
  if (selection?.kind === 'curve-point') return selection.sketchId;
  if (selection?.kind === 'loop') return selection.sketchId;
  if (selection?.kind === 'feature' && bodies) {
    const body = bodies.find((b) => b.id === selection.bodyId);
    const feature = body?.features.find((f) => f.id === selection.featureId);
    if (feature && ('profile' in feature) && typeof feature.profile === 'string') {
      return feature.profile;
    }
  }
  return null;
}

export function newFeatureId(): string {
  return newId('feature');
}

export function newShapeId(): string {
  return newId('shape');
}

export function newBodyId(): string {
  return newId('body');
}

/** Default sizes (width, height, depth in mm) for freshly added primitives. */
export const PRIMITIVE_SIZES: Record<PrimitiveShape, [number, number, number]> = {
  box: [600, 400, 600],
  cylinder: [300, 600, 300],
  sphere: [400, 400, 400],
  cone: [400, 500, 400],
};

export const PRIMITIVE_LABELS: Record<PrimitiveShape, string> = { box: 'Box', cylinder: 'Cylinder', sphere: 'Sphere', cone: 'Cone' };

export function findBody(bodies: Body[], id: string): Body | null {
  return bodies.find((body) => body.id === id) ?? null;
}

/** Curve-driven bodies keep their topology controlled by editable sketch geometry. */
export function isParametricBody(body: Body | null | undefined): boolean {
  return Boolean(body?.features.some((feature) => feature.kind === 'extrude' || feature.kind === 'revolve' || feature.kind === 'sweep'));
}

export function paneCount(layout: Layout): 1 | 2 | 4 {
  return layout === 'single' ? 1 : layout === 'split-2' ? 2 : 4;
}

export function cameraOfPane(view: PaneView): string | null {
  return view.startsWith('camera:') ? view.slice('camera:'.length) : null;
}

export function findNode(nodes: LayerNode[], id: string): LayerNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const inner = findNode(node.children, id);
    if (inner) return inner;
  }
  return null;
}

export const modelingStore = createModelingStore();

export function useModeling<T>(selector: (state: ModelingState) => T): T {
  return useStore(modelingStore, selector);
}

export const PLANE_LABELS: Record<PlaneId, string> = { top: 'Top plane', front: 'Front plane', side: 'Side plane' };
/** The world axis each plane slides along. */
export const PLANE_AXIS: Record<PlaneId, 'x' | 'y' | 'z'> = { top: 'y', front: 'z', side: 'x' };
export const STYLE_LABELS: Record<ViewStyle, string> = { realistic: 'Realistic', color: 'Color', shaded: 'Shaded', wireframe: 'Wireframe', 'hidden-line': 'Hidden line' };

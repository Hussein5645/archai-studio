/**
 * The 2D tools' state machine: rectangle, circle, polygon, polyline (with arc segments) and
 * freehand drawing, the offset tool, plus selecting and dragging shapes with the select tool. It works in sketch coordinates on the plane of the
 * pane the pointer is in (the viewport converts pointer positions and reports what was hit),
 * and writes shapes into the store. Typed dimensions during a drag come in through `keyDown`.
 * No three.js here, so the sequences are unit-testable.
 */
import type { StoreApi } from 'zustand';
import { bulgeThrough, samePlane, shapeIsValid, simplifyStroke, translateShape } from '../kernel/sketch';
import type { Shape2D, SketchPlane, Vec2 } from '../kernel/types';
import { DEFAULT_INFERENCE_SETTINGS, InferenceEngine, type InferenceCandidate } from '../inference';
import { curveSnapCandidates, parseTypedDimensions, snapPoint } from '../snap';
import type { TopologyHit } from '../topology';
import { newShapeId, selectedSketchId, SKETCH_TOOLS, type ModelingState } from '../store';
import { carryJoined, dragGrip, filletAll, filletJoint, gripAt, gripMovedPoints, insertVertex, offsetPoints, type Grip } from '../sketchEdit';
import { ModifyTool } from './modify';
import { circleThrough, distanceFromAxis, ellipseShape, endTangent, pathToPolyline, penShape, shapeToPath, tangentArcBulge, type PenNode, type Polyline } from '../curves';
import { offsetPath } from '@/drafting/paths';

export interface ToolHits {
  /** The nearest sketch shape under the pointer (shapes on the pane's own plane offset win). */
  shape: { sketchId: string; shapeId: string } | null;
  /** The nearest body under the pointer. */
  body: string | null;
}

export interface ToolPointer {
  /** The pane's plane at its current position. */
  plane: SketchPlane;
  /** Pointer position in sketch coordinates (unsnapped). */
  point: Vec2;
  hit: ToolHits;
  shift: boolean;
  alt: boolean;
  /** Shift/Ctrl/Cmd keeps the existing selection when using Select. */
  additive?: boolean;
  /** Snap radius in sketch units (8 px with a mouse, 18 px with touch, at the pane's zoom). */
  radius: number;
  /** Browser coordinates used only to place the inference label beside the cursor. */
  screen?: [number, number];
  /** Snap candidates from project elements or scene geometry. */
  projectSnapPoints?: readonly {
    point: Vec2;
    label?: string;
    type?: 'body-vertex' | 'edge-intersection' | 'endpoint' | 'midpoint' | 'body-edge';
    screenDistance?: number;
    priority?: number;
    /** The vertex / edge this came from, highlighted while it is the active snap. */
    target?: TopologyHit;
  }[];
}

type Drag =
  /** `secondCorner`: placed by a click (press and release in place); the next press finishes it. */
  | { kind: 'rect' | 'circle' | 'polygon'; sketchId: string; plane: SketchPlane; start: Vec2; last: Vec2; alt: boolean; secondCorner?: boolean; startScreen?: [number, number] }
  | { kind: 'line'; sketchId: string; plane: SketchPlane; start: Vec2; last: Vec2 }
  | { kind: 'knife'; sketchId: string; plane: SketchPlane; start: Vec2; last: Vec2 }
  | { kind: 'polyline'; sketchId: string; plane: SketchPlane; points: Vec2[]; bulges: number[]; last: Vec2; arcPending: boolean }
  | { kind: 'freehand'; sketchId: string; plane: SketchPlane; points: Vec2[] }
  /** Centre-ends arc: the centre, then the start (radius), then the sweep follows the pointer. */
  | { kind: 'centerArc'; sketchId: string; plane: SketchPlane; center: Vec2; start: Vec2 | null; sweep: number; lastAngle: number; last: Vec2 }
  /** Circle through three clicked points. */
  | { kind: 'circle3'; sketchId: string; plane: SketchPlane; points: Vec2[]; last: Vec2 }
  /** Ellipse: centre, the end of one axis, then the other radius. */
  | { kind: 'ellipse'; sketchId: string; plane: SketchPlane; center: Vec2; axis: Vec2 | null; last: Vec2 }
  /** Tangent arc: leaves the start along `direction` (a picked curve end's, else a clicked one). */
  | { kind: 'tangentArc'; sketchId: string; plane: SketchPlane; start: Vec2; direction: Vec2 | null; last: Vec2 }
  /** Pen: click corner nodes, press and drag for smooth ones (their handles). */
  | { kind: 'spline'; sketchId: string; plane: SketchPlane; nodes: PenNode[]; pressing: boolean; last: Vec2 }
  /** Dragging the selected curves of one sketch (all of them move together). */
  | { kind: 'move'; sketchId: string; shapes: Shape2D[]; start: Vec2; plane: SketchPlane }
  /** Dragging a grip of a selected curve; ends of other curves joined to the moved points follow. */
  | { kind: 'grip'; sketchId: string; shape: Shape2D; grip: Grip; plane: SketchPlane; others: Shape2D[] };

const CLICK_TOLERANCE = 1e-6;
/** Press and release closer than this (screen pixels) is a click, even for a wobbly finger. */
const CLICK_SLOP_PX = 10;

export class SketchTool {
  private drag: Drag | null = null;
  private readonly inference = new InferenceEngine();
  private lastInference: { label: string; type: string; locked: boolean; screen?: [number, number]; measurement?: string; target?: TopologyHit } | undefined;
  private lastAnchor: Vec2 | null = null;
  private axisLock: 'x' | 'y' | null = null;
  /** The last line of a chain (Chain option): its shape, so a corner radius can round the joint. */
  private chainPrevious: { sketchId: string; shapeId: string; from: Vec2; to: Vec2 } | null = null;

  /** Move / copy / rotate / mirror / scale / trim / extend / split / fillet on existing curves. */
  readonly modify: ModifyTool;

  constructor(private readonly store: StoreApi<ModelingState>) {
    this.modify = new ModifyTool(store, this);
  }

  /** True while a shape is being drawn or moved (typed numbers then go to the tool). */
  get active(): boolean {
    return this.drag !== null || this.modify.active;
  }

  get currentPlane(): SketchPlane | null {
    return this.drag?.plane ?? null;
  }

  /**
   * New geometry goes into the selected sketch (or the sketch of the selected shape) when it is
   * on this plane; otherwise drawing starts a new sketch there, so a drawing tool never silently
   * ignores the pointer (on a tablet there is no hint cursor to explain why).
   */
  sketchFor(plane: SketchPlane): string {
    const state = this.store.getState();
    // Sketch edit mode: everything drawn goes into the edited sketch.
    if (state.sketchEdit) return state.sketchEdit.sketchId;
    const selected = selectedSketchId(state.selection);
    const chosen = selected ? state.sketches.find((sketch) => sketch.id === selected) : null;
    if (chosen && samePlane(chosen.plane, plane)) return chosen.id;
    return state.addSketch(plane);
  }

  /** Snaps against the shapes of every visible sketch on the same plane. */
  snap(pointer: ToolPointer, anchor: Vec2 | null, exclude?: string | ReadonlySet<string>): Vec2 {
    this.lastAnchor = anchor;
    const state = this.store.getState();
    const shapes = state.sketches.filter((sketch) => sketch.visible && samePlane(sketch.plane, pointer.plane)).flatMap((sketch) => sketch.shapes.filter((shape) => (typeof exclude === 'string' ? shape.id !== exclude : !exclude?.has(shape.id))));
    const { grid, snap } = state.toolOptions;
    const enabled = snap && !pointer.alt && state.inferenceSettings.enabled;
    const settings = state.inferenceSettings;
    this.inference.settings = { ...DEFAULT_INFERENCE_SETTINGS, ...settings, enabled, tolerance: pointer.radius, disabledTypes: settings.disabledTypes };
    if (!pointer.shift && !this.axisLock) this.inference.clearLock();
    let raw: Vec2 = pointer.point;
    if (anchor && (pointer.shift || this.axisLock)) {
      const dx = raw[0] - anchor[0];
      const dy = raw[1] - anchor[1];
      if (this.axisLock === 'x') raw = [raw[0], anchor[1]];
      else if (this.axisLock === 'y') raw = [anchor[0], raw[1]];
      else {
        const length = Math.hypot(dx, dy);
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        raw = [anchor[0] + Math.cos(angle) * length, anchor[1] + Math.sin(angle) * length];
      }
    }
    const candidates: InferenceCandidate[] = curveSnapCandidates(shapes, raw, anchor, pointer.radius);
    if (pointer.projectSnapPoints) {
      for (const p of pointer.projectSnapPoints) {
        const dist = p.screenDistance ?? Math.hypot(p.point[0] - raw[0], p.point[1] - raw[1]);
        candidates.push({
          position: [p.point[0], p.point[1], 0],
          type: p.type ?? 'body-vertex',
          screenDistance: dist,
          label: p.label ?? 'Project Element',
          marker: 'square',
          priority: p.priority ?? 125,
          ...(p.target ? { source: p.target } : {}),
        });
      }
    }
    if (anchor && !pointer.shift && !this.axisLock) {
      candidates.push(
        { position: [anchor[0], raw[1], 0], type: 'alignment', screenDistance: Math.abs(raw[0] - anchor[0]), label: 'Aligned', marker: 'line', direction: [0, 1, 0] },
        { position: [raw[0], anchor[1], 0], type: 'alignment', screenDistance: Math.abs(raw[1] - anchor[1]), label: 'Aligned', marker: 'line', direction: [1, 0, 0] },
      );
    }
    if (grid > 0 && settings.grid) {
      const gridPoint: Vec2 = [Math.round(raw[0] / grid) * grid, Math.round(raw[1] / grid) * grid];
      candidates.push({ position: [gridPoint[0], gridPoint[1], 0], type: 'grid', screenDistance: Math.hypot(gridPoint[0] - raw[0], gridPoint[1] - raw[1]), label: 'Grid', marker: 'cross' });
    }
    if (anchor && (pointer.shift || this.axisLock)) {
      candidates.push({ position: [raw[0], raw[1], 0], type: 'axis', screenDistance: 0, priority: 100, label: this.axisLock ? `${this.axisLock.toUpperCase()} axis locked` : 'Direction locked', marker: 'line' });
    }
    const resolved = this.inference.resolve(candidates, { tool: state.tool });
    const target = resolved?.source as TopologyHit | undefined;
    this.lastInference = resolved ? { label: resolved.label, type: resolved.type, locked: Boolean(pointer.shift || this.axisLock), screen: pointer.screen, ...(target ? { target } : {}) } : undefined;
    if (resolved) return [resolved.position[0], resolved.position[1]];
    // Grid remains available when semantic snapping is off, unless Alt temporarily disables all snaps.
    return snapPoint(raw, {
      grid: pointer.alt || !settings.grid ? 0 : grid,
      snap: false,
      radius: pointer.radius,
      points: [],
      projectPoints: pointer.projectSnapPoints?.map((p) => p.point),
      anchor,
    }).point;
  }

  preview(plane: SketchPlane, shape: Shape2D | null, snap: Vec2 | null, measurement = shape ? shapeMeasurement(shape) : undefined, shapes?: Shape2D[]): void {
    const inference = this.lastInference ? { ...this.lastInference, ...(measurement ? { measurement } : {}) } : undefined;
    const guide = snap && this.lastAnchor && inference && (inference.type === 'alignment' || inference.type === 'axis') ? { from: this.lastAnchor, to: snap } : undefined;
    this.store.getState().setSketchPreview({ plane, shape, snap, ...(shapes?.length ? { shapes } : {}), ...(inference ? { inference } : {}), ...(guide ? { guide } : {}), ...(this.drag && this.drag.kind !== 'move' && this.drag.kind !== 'grip' ? { drawing: true } : {}) });
  }

  /** The shape a drag would produce right now. */
  private shapeOf(drag: Drag, end: Vec2): Shape2D | null {
    switch (drag.kind) {
      case 'rect': {
        const [x0, y0] = drag.start;
        if (drag.alt) return { kind: 'rect', id: 'preview', x: 2 * x0 - end[0], y: 2 * y0 - end[1], width: 2 * (end[0] - x0), height: 2 * (end[1] - y0) };
        return { kind: 'rect', id: 'preview', x: x0, y: y0, width: end[0] - x0, height: end[1] - y0 };
      }
      case 'circle':
        if (this.store.getState().toolOptions.circleMode === '2p') {
          // Two ends of a diameter.
          return { kind: 'circle', id: 'preview', cx: (drag.start[0] + end[0]) / 2, cy: (drag.start[1] + end[1]) / 2, radius: Math.hypot(end[0] - drag.start[0], end[1] - drag.start[1]) / 2 };
        }
        return { kind: 'circle', id: 'preview', cx: drag.start[0], cy: drag.start[1], radius: Math.hypot(end[0] - drag.start[0], end[1] - drag.start[1]) };
      case 'circle3': {
        if (drag.points.length < 2) return { kind: 'polyline', id: 'preview', points: [drag.points[0]!, end], closed: false };
        const circle = circleThrough(drag.points[0]!, drag.points[1]!, end);
        return circle ? { kind: 'circle', id: 'preview', cx: circle.center[0], cy: circle.center[1], radius: circle.radius } : { kind: 'polyline', id: 'preview', points: [drag.points[0]!, drag.points[1]!, end], closed: false };
      }
      case 'ellipse': {
        if (!drag.axis) return { kind: 'polyline', id: 'preview', points: [drag.center, end], closed: false };
        const other = distanceFromAxis(drag.center, drag.axis, end);
        if (other < 1e-6) return { kind: 'polyline', id: 'preview', points: [[2 * drag.center[0] - drag.axis[0], 2 * drag.center[1] - drag.axis[1]], drag.axis], closed: false };
        return ellipseShape(drag.center, drag.axis, other);
      }
      case 'tangentArc':
        if (!drag.direction) return { kind: 'polyline', id: 'preview', points: [drag.start, end], closed: false };
        return { kind: 'polyline', id: 'preview', points: [drag.start, end], bulges: [tangentArcBulge(drag.start, drag.direction, end)], closed: false };
      case 'spline':
        return penShape(drag.pressing ? drag.nodes : [...drag.nodes, { point: end, handle: null }], false);
      case 'line':
      case 'knife':
        return { kind: 'polyline', id: 'preview', points: [drag.start, end], closed: false };
      case 'polygon': {
        const radius = Math.hypot(end[0] - drag.start[0], end[1] - drag.start[1]);
        const rotation = (Math.atan2(end[1] - drag.start[1], end[0] - drag.start[0]) * 180) / Math.PI;
        return { kind: 'polygon', id: 'preview', cx: drag.start[0], cy: drag.start[1], radius, sides: this.store.getState().toolOptions.sides, rotation };
      }
      case 'polyline': {
        // While an arc's through point is being picked the last point is already in place.
        const points = drag.arcPending ? drag.points : [...drag.points, end];
        const bulges = drag.arcPending ? drag.bulges : [...drag.bulges, this.store.getState().toolOptions.tangentArc ? tangentBulge(drag.points, drag.bulges, end) : 0];
        return { kind: 'polyline', id: 'preview', points, bulges };
      }
      case 'centerArc': {
        if (!drag.start) return { kind: 'polyline', id: 'preview', points: [drag.center, end], closed: false };
        return centerArcShape(drag.center, drag.start, drag.sweep);
      }
      case 'freehand':
        return { kind: 'polyline', id: 'preview', points: drag.points };
      case 'move':
      case 'grip':
        return null;
    }
  }

  pointerDown(pointer: ToolPointer): void {
    const state = this.store.getState();
    const tool = state.tool;
    if (ModifyTool.handles(tool)) {
      this.modify.pointerDown(pointer);
      return;
    }
    if (!SKETCH_TOOLS.includes(tool)) {
      this.selectAt(pointer);
      return;
    }
    if (tool === 'offset') {
      this.offsetAt(pointer);
      return;
    }
    if (tool === 'line' || tool === 'knife') {
      if (this.drag?.kind === tool) {
        const point = this.snap(pointer, this.drag.start);
        if (tool === 'line') this.commitLine(this.drag as Extract<Drag, { kind: 'line' }>, point);
        else this.commitDrag(this.shapeOf(this.drag, point));
      } else {
        // Knife keeps the cut segment in the surface/sketch that was picked when possible.
        const sketchId = tool === 'knife' && pointer.hit.shape ? pointer.hit.shape.sketchId : this.sketchFor(pointer.plane);
        const start = this.snap(pointer, null);
        this.drag = { kind: tool, sketchId, plane: pointer.plane, start, last: start };
        this.preview(pointer.plane, null, start);
      }
      return;
    }
    if (tool === 'freehand') {
      const sketchId = this.sketchFor(pointer.plane);
      this.drag = { kind: 'freehand', sketchId, plane: pointer.plane, points: [pointer.point] };
      return;
    }
    if (tool === 'circle' && state.toolOptions.circleMode === '3p') {
      const drag = this.drag?.kind === 'circle3' ? this.drag : null;
      const point = this.snap(pointer, drag?.points[drag.points.length - 1] ?? null);
      if (!drag) {
        this.drag = { kind: 'circle3', sketchId: this.sketchFor(pointer.plane), plane: pointer.plane, points: [point], last: point };
        this.preview(pointer.plane, null, point);
        return;
      }
      const previous = drag.points[drag.points.length - 1]!;
      if (Math.hypot(point[0] - previous[0], point[1] - previous[1]) < 1e-6) return;
      if (drag.points.length < 2) {
        drag.points.push(point);
        return;
      }
      this.commitDrag(this.shapeOf(drag, point)?.kind === 'circle' ? this.shapeOf(drag, point) : null);
      return;
    }
    if (tool === 'ellipse') {
      const drag = this.drag?.kind === 'ellipse' ? this.drag : null;
      if (!drag) {
        const center = this.snap(pointer, null);
        this.drag = { kind: 'ellipse', sketchId: this.sketchFor(pointer.plane), plane: pointer.plane, center, axis: null, last: center };
        this.preview(pointer.plane, null, center);
        return;
      }
      const point = this.snap(pointer, drag.center);
      if (!drag.axis) {
        if (Math.hypot(point[0] - drag.center[0], point[1] - drag.center[1]) > 1e-6) drag.axis = point;
        return;
      }
      if (distanceFromAxis(drag.center, drag.axis, point) > 1e-6) this.commitDrag(this.shapeOf(drag, point));
      return;
    }
    if (tool === 'arc' && state.toolOptions.arcMode === 'tangent') {
      const drag = this.drag?.kind === 'tangentArc' ? this.drag : null;
      if (!drag) {
        const start = this.snap(pointer, null);
        this.drag = { kind: 'tangentArc', sketchId: this.sketchFor(pointer.plane), plane: pointer.plane, start, direction: this.curveEndDirection(pointer.plane, start, pointer.radius), last: start };
        this.preview(pointer.plane, null, start);
        return;
      }
      const point = this.snap(pointer, drag.start);
      const dx = point[0] - drag.start[0];
      const dy = point[1] - drag.start[1];
      const length = Math.hypot(dx, dy);
      if (length < 1e-6) return;
      if (!drag.direction) {
        // No curve end to follow: this click gives the direction the arc leaves in.
        drag.direction = [dx / length, dy / length];
        return;
      }
      this.commitDrag(this.shapeOf(drag, point));
      return;
    }
    if (tool === 'spline') {
      const drag = this.drag?.kind === 'spline' ? this.drag : null;
      const point = this.snap(pointer, drag?.nodes[drag.nodes.length - 1]?.point ?? null);
      if (!drag) {
        this.drag = { kind: 'spline', sketchId: this.sketchFor(pointer.plane), plane: pointer.plane, nodes: [{ point, handle: null }], pressing: true, last: point };
        this.preview(pointer.plane, null, point);
        return;
      }
      const first = drag.nodes[0]!.point;
      const last = drag.nodes[drag.nodes.length - 1]!.point;
      // Clicking the first node again closes the curve; a second click in place (double-click) is ignored.
      if (drag.nodes.length >= 2 && Math.hypot(point[0] - first[0], point[1] - first[1]) <= pointer.radius) {
        this.commitDrag(penShape(drag.nodes, true));
        return;
      }
      if (Math.hypot(point[0] - last[0], point[1] - last[1]) <= pointer.radius / 2) return;
      drag.nodes.push({ point, handle: null });
      drag.pressing = true;
      drag.last = point;
      this.preview(drag.plane, this.shapeOf(drag, point), point, undefined, penTies(drag.nodes));
      return;
    }
    if (tool === 'arc' && state.toolOptions.arcMode === 'center') {
      const drag = this.drag?.kind === 'centerArc' ? this.drag : null;
      if (!drag) {
        const center = this.snap(pointer, null);
        this.drag = { kind: 'centerArc', sketchId: this.sketchFor(pointer.plane), plane: pointer.plane, center, start: null, sweep: 0, lastAngle: 0, last: center };
        this.preview(pointer.plane, null, center);
        return;
      }
      if (!drag.start) {
        const start = this.snap(pointer, drag.center);
        if (Math.hypot(start[0] - drag.center[0], start[1] - drag.center[1]) < 1e-6) return;
        drag.start = start;
        drag.lastAngle = Math.atan2(start[1] - drag.center[1], start[0] - drag.center[0]);
        drag.sweep = 0;
        return;
      }
      if (Math.abs(drag.sweep) < 1e-6) return;
      this.commitDrag(centerArcShape(drag.center, drag.start, drag.sweep));
      return;
    }
    if (tool === 'polyline' || tool === 'arc') {
      if (!this.drag || this.drag.kind !== 'polyline') {
        const sketchId = this.sketchFor(pointer.plane);
        const start = this.snap(pointer, null);
        this.drag = { kind: 'polyline', sketchId, plane: pointer.plane, points: [start], bulges: [], last: start, arcPending: false };
        this.preview(pointer.plane, null, start);
        return;
      }
      const drag = this.drag;
      if (drag.arcPending) {
        // The through point is set: the arc is fixed, back to straight segments.
        drag.arcPending = false;
        state.setToolOptions({ arc: tool === 'arc' });
        this.preview(drag.plane, this.shapeOf(drag, drag.last), drag.last);
        return;
      }
      const point = this.snap(pointer, drag.points[drag.points.length - 1] ?? null);
      const first = drag.points[0]!;
      // Clicking the first point again closes the shape.
      if (drag.points.length >= 3 && Math.hypot(point[0] - first[0], point[1] - first[1]) <= pointer.radius) {
        this.finishPolyline();
        return;
      }
      drag.bulges.push(state.toolOptions.tangentArc ? tangentBulge(drag.points, drag.bulges, point) : 0);
      drag.points.push(point);
      drag.last = point;
      // In arc mode the segment just placed waits for its through point.
      if (tool === 'arc' || state.toolOptions.arc) drag.arcPending = true;
      this.preview(drag.plane, this.shapeOf(drag, point), point);
      return;
    }
    if (tool === 'rect' || tool === 'circle' || tool === 'polygon') {
      // Click-click: the first press/release placed the start; this press places the end.
      if (this.drag?.kind === tool && this.drag.secondCorner) {
        this.commitDrag(this.shapeOf(this.drag, this.snap(pointer, this.endAnchor(this.drag))));
        return;
      }
      const sketchId = this.sketchFor(pointer.plane);
      const start = this.snap(pointer, null);
      this.drag = { kind: tool, sketchId, plane: pointer.plane, start, last: start, alt: pointer.alt, ...(pointer.screen ? { startScreen: pointer.screen } : {}) };
      this.preview(pointer.plane, null, start);
    }
  }

  /** The offset tool: a click on a shape adds a copy grown or shrunk by the option distance. */
  private offsetAt(pointer: ToolPointer): void {
    const state = this.store.getState();
    const hit = pointer.hit.shape;
    if (!hit) return;
    const sketch = state.sketches.find((item) => item.id === hit.sketchId);
    const shape = sketch?.shapes.find((item) => item.id === hit.shapeId);
    if (!sketch || !shape) return;
    if (shape.kind === 'polyline' && shape.closed === false) {
      // An open curve gets a parallel copy (arcs and pen curves stay curved), to its left for a
      // positive distance.
      const parallel = offsetPath(shapeToPath(shape), state.toolOptions.offset);
      if (parallel?.segs.length) state.addShape(sketch.id, pathToPolyline(parallel, { id: newShapeId() }));
      state.setTool('select');
      return;
    }
    state.addShape(sketch.id, { ...shape, id: newShapeId(), offset: (shape.offset ?? 0) + state.toolOptions.offset });
    state.setTool('select');
  }

  private selectAt(pointer: ToolPointer): void {
    const state = this.store.getState();
    const editing = state.sketchEdit?.sketchId;
    // Sketch edit mode: only the edited sketch's curves can be picked; bodies and other sketches are locked.
    const hit: ToolHits = editing ? { shape: pointer.hit.shape?.sketchId === editing ? pointer.hit.shape : null, body: null } : pointer.hit;
    if (state.tool === 'paint') {
      if (hit.body) {
        state.updateBody(hit.body, { material: state.toolOptions.paintMaterial });
        state.setTool('select');
      }
      return;
    }
    if (state.tool === 'boolean' && hit.body && state.selection?.kind === 'body' && state.selection.id !== hit.body) {
      // Second click: the tool body.
      state.setToolOptions({ boolean: { ...state.toolOptions.boolean, tool: hit.body } });
      return;
    }
    // A grip of a selected curve under the pointer: reshape it (vertices also select the point).
    if (state.tool === 'select' && !pointer.additive && this.startGrip(pointer)) return;
    if (hit.shape) {
      const sketch = state.sketches.find((item) => item.id === hit.shape!.sketchId);
      const shape = sketch?.shapes.find((item) => item.id === hit.shape!.shapeId);
      const selected = this.selectedShapeIds(hit.shape.sketchId);
      // Pressing a curve that is part of a multi-selection drags the whole selection.
      if (sketch && shape && state.tool === 'select' && !pointer.additive && selected.size > 1 && selected.has(shape.id)) {
        this.drag = { kind: 'move', sketchId: sketch.id, shapes: sketch.shapes.filter((item) => selected.has(item.id)), start: pointer.point, plane: sketch.plane };
        return;
      }
      state.select({ kind: 'shape', sketchId: hit.shape.sketchId, shapeId: hit.shape.shapeId }, pointer.additive);
      if (sketch && shape && state.tool === 'select' && !pointer.additive) this.drag = { kind: 'move', sketchId: sketch.id, shapes: [shape], start: pointer.point, plane: sketch.plane };
      return;
    }
    if (hit.body) {
      state.select({ kind: 'body', id: hit.body }, pointer.additive);
      return;
    }
    if (state.tool === 'select' && !pointer.additive) state.select(null);
  }

  pointerMove(pointer: ToolPointer): void {
    const drag = this.drag;
    if (!drag) {
      // Hovering with a sketch tool shows where the next point would land.
      const tool = this.store.getState().tool;
      if (ModifyTool.handles(tool)) {
        this.modify.pointerMove(pointer);
        return;
      }
      if (tool === 'line' || tool === 'knife' || tool === 'rect' || tool === 'circle' || tool === 'polygon' || tool === 'polyline' || tool === 'arc' || tool === 'ellipse' || tool === 'spline') this.preview(pointer.plane, null, this.snap(pointer, null));
      return;
    }
    if (drag.kind === 'freehand') {
      const last = drag.points[drag.points.length - 1]!;
      if (Math.hypot(pointer.point[0] - last[0], pointer.point[1] - last[1]) < pointer.radius / 4) return;
      drag.points.push(pointer.point);
      this.preview(drag.plane, this.shapeOf(drag, pointer.point), null);
      return;
    }
    if (drag.kind === 'polyline' && drag.arcPending) {
      // The cursor is the through point of the arc just placed.
      const from = drag.points[drag.points.length - 2]!;
      const to = drag.points[drag.points.length - 1]!;
      drag.bulges[drag.bulges.length - 1] = bulgeThrough(from, to, pointer.point);
      this.preview(drag.plane, this.shapeOf(drag, to), null);
      return;
    }
    if (drag.kind === 'grip') {
      const state = this.store.getState();
      const moving = new Set([drag.shape.id]);
      const anchor = drag.shape.kind === 'polyline' && drag.grip.kind === 'vertex' ? (drag.shape.points[drag.grip.index - 1] ?? drag.shape.points[drag.grip.index + 1] ?? null) : null;
      const target = this.snap(pointer, anchor, moving);
      if (Math.hypot(target[0] - drag.grip.point[0], target[1] - drag.grip.point[1]) < CLICK_TOLERANCE && !this.moved) return;
      if (!this.moved) {
        state.recordHistory();
        this.moved = true;
      }
      const next = dragGrip(drag.shape, drag.grip, target);
      const from = gripMovedPoints(drag.shape, drag.grip);
      const to = gripMovedPoints(next, drag.grip);
      const others = carryJoined(drag.others, drag.shape.id, from.map((point, index) => ({ from: point, to: to[index]! })));
      const sketch = state.sketches.find((item) => item.id === drag.sketchId);
      if (sketch) state.setSketchShapes({ [sketch.id]: sketch.shapes.map((item) => (item.id === next.id ? next : (others.find((other) => other.id === item.id) ?? item))) }, true);
      this.preview(drag.plane, null, target, gripMeasurement(next, drag.grip));
      return;
    }
    if (drag.kind === 'move') {
      const snapped = this.snap(pointer, drag.start, new Set(drag.shapes.map((shape) => shape.id)));
      let dx = snapped[0] - drag.start[0];
      let dy = snapped[1] - drag.start[1];
      const state = this.store.getState();
      // Geometry points stay exact. Grid/alignment movement remains relative to the grab point,
      // so a shape does not jump merely because it was grabbed away from the grid.
      if (this.lastInference?.type !== 'endpoint' && state.toolOptions.grid > 0 && state.toolOptions.snap && !pointer.alt) {
        dx = Math.round(dx / state.toolOptions.grid) * state.toolOptions.grid;
        dy = Math.round(dy / state.toolOptions.grid) * state.toolOptions.grid;
      }
      if (Math.hypot(dx, dy) < CLICK_TOLERANCE) return;
      if (!this.moved) {
        state.recordHistory();
        this.moved = true;
      }
      const moved = new Map(drag.shapes.map((shape) => [shape.id, translateShape(shape, dx, dy)]));
      const sketch = state.sketches.find((item) => item.id === drag.sketchId);
      if (sketch) state.setSketchShapes({ [sketch.id]: sketch.shapes.map((item) => moved.get(item.id) ?? item) }, true);
      this.preview(drag.plane, null, [drag.start[0] + dx, drag.start[1] + dy], `ΔX ${formatMm(dx)}  ΔY ${formatMm(dy)}`);
      return;
    }
    if (drag.kind === 'spline') {
      const node = drag.nodes[drag.nodes.length - 1]!;
      if (drag.pressing) {
        // Dragging from a node pulls its handle out: a smooth node (the curve passes through it).
        const far = Math.hypot(pointer.point[0] - node.point[0], pointer.point[1] - node.point[1]) > pointer.radius / 2;
        node.handle = far ? pointer.point : null;
        this.preview(drag.plane, this.shapeOf(drag, node.point), node.point, undefined, penTies(drag.nodes));
        return;
      }
      const point = this.snap(pointer, node.point);
      drag.last = point;
      this.preview(drag.plane, this.shapeOf(drag, point), point, undefined, penTies(drag.nodes));
      return;
    }
    if (drag.kind === 'circle3' || drag.kind === 'ellipse' || drag.kind === 'tangentArc') {
      const anchor = drag.kind === 'circle3' ? drag.points[drag.points.length - 1]! : drag.kind === 'ellipse' ? drag.center : drag.start;
      const point = this.snap(pointer, anchor);
      drag.last = point;
      const shape = this.shapeOf(drag, point);
      const measurement = shape?.kind === 'circle' ? `R ${formatMm(shape.radius)}` : drag.kind === 'ellipse' && drag.axis ? `${formatMm(Math.hypot(drag.axis[0] - drag.center[0], drag.axis[1] - drag.center[1]))} × ${formatMm(distanceFromAxis(drag.center, drag.axis, point))}` : undefined;
      this.preview(drag.plane, shape, point, measurement);
      return;
    }
    if (drag.kind === 'centerArc') {
      const point = this.snap(pointer, drag.start ? null : drag.center);
      drag.last = point;
      if (drag.start) {
        // The sweep follows the pointer round the centre, in whichever direction it travels.
        const angle = Math.atan2(point[1] - drag.center[1], point[0] - drag.center[0]);
        let delta = angle - drag.lastAngle;
        if (delta > Math.PI) delta -= Math.PI * 2;
        if (delta < -Math.PI) delta += Math.PI * 2;
        drag.sweep = Math.max(-Math.PI * 2 + 1e-3, Math.min(Math.PI * 2 - 1e-3, drag.sweep + delta));
        drag.lastAngle = angle;
      }
      const shape = this.shapeOf(drag, point);
      const measurement = drag.start ? `R ${formatMm(Math.hypot(drag.start[0] - drag.center[0], drag.start[1] - drag.center[1]))} · ${Math.round((Math.abs(drag.sweep) * 180) / Math.PI)}°` : undefined;
      this.preview(drag.plane, shape, point, measurement);
      return;
    }
    const anchor = drag.kind === 'polyline' ? (drag.points[drag.points.length - 1] ?? null) : this.endAnchor(drag);
    const point = this.snap(pointer, anchor);
    drag.last = point;
    this.preview(drag.plane, this.shapeOf(drag, point), point);
  }

  /**
   * What the end point aligns to. A rectangle's opposite corner never aligns with its first
   * corner: that snap flattens it to zero height or width (easily with a finger's larger radius).
   */
  private endAnchor(drag: Drag): Vec2 | null {
    return drag.kind === 'rect' ? null : 'start' in drag ? drag.start : null;
  }

  private moved = false;

  pointerUp(pointer: ToolPointer): void {
    const drag = this.drag;
    if (!drag) return;
    if (drag.kind === 'move' || drag.kind === 'grip') {
      this.drag = null;
      this.moved = false;
      this.lastInference = undefined;
      this.lastAnchor = null;
      this.store.getState().setSketchPreview(null);
      return;
    }
    if (drag.kind === 'spline') {
      drag.pressing = false;
      return;
    }
    if (drag.kind === 'polyline' || drag.kind === 'line' || drag.kind === 'knife' || drag.kind === 'centerArc' || drag.kind === 'circle3' || drag.kind === 'ellipse' || drag.kind === 'tangentArc') return;
    if (drag.kind === 'freehand') {
      // Simplify the stroke to its corners; it closes back to its first point.
      const points = simplifyStroke(drag.points, Math.max(0.5, pointer.radius / 2));
      this.commitDrag(points.length >= 3 ? { kind: 'polyline', id: 'preview', points } : null);
      return;
    }
    const point = this.snap(pointer, this.endAnchor(drag));
    // In place is judged on screen when possible: the first shape of a fresh sketch can shift the
    // layout (the options bar changes), which moves the same finger to another sketch point.
    const inPlace = drag.kind === 'rect' || drag.kind === 'circle' || drag.kind === 'polygon'
      ? drag.startScreen && pointer.screen
        ? Math.hypot(pointer.screen[0] - drag.startScreen[0], pointer.screen[1] - drag.startScreen[1]) <= CLICK_SLOP_PX
        : Math.hypot(point[0] - drag.start[0], point[1] - drag.start[1]) <= pointer.radius
      : false;
    if ((drag.kind === 'rect' || drag.kind === 'circle' || drag.kind === 'polygon') && !drag.secondCorner && inPlace) {
      // Released where it was pressed: a click (or tap) placed the first corner; the next one
      // places the opposite corner (the documented click-click way, and the easy one on touch).
      drag.secondCorner = true;
      return;
    }
    this.commitDrag(this.shapeOf(drag, point));
  }

  /** Ids of the selected curves of one sketch. */
  private selectedShapeIds(sketchId: string): Set<string> {
    const state = this.store.getState();
    const items = state.selectionSet.length ? state.selectionSet : state.selection ? [state.selection] : [];
    const ids = new Set<string>();
    for (const item of items) {
      if ((item.kind === 'shape' || item.kind === 'curve-point') && item.sketchId === sketchId) ids.add(item.shapeId);
      if (item.kind === 'loop' && item.sketchId === sketchId) item.shapeIds.forEach((id) => ids.add(id));
    }
    return ids;
  }

  /** Starts dragging the grip of a selected curve near the pointer (on the pointer's plane). */
  private startGrip(pointer: ToolPointer): boolean {
    const state = this.store.getState();
    const radius = pointer.radius * 1.2;
    let best: { sketchId: string; shape: Shape2D; grip: Grip; distance: number; plane: SketchPlane; others: Shape2D[] } | null = null;
    for (const sketch of state.sketches) {
      if (!sketch.visible || !samePlane(sketch.plane, pointer.plane)) continue;
      if (state.sketchEdit && state.sketchEdit.sketchId !== sketch.id) continue;
      const ids = this.selectedShapeIds(sketch.id);
      for (const shape of sketch.shapes) {
        if (!ids.has(shape.id)) continue;
        const grip = gripAt(shape, pointer.point, radius);
        if (!grip) continue;
        const distance = Math.hypot(grip.point[0] - pointer.point[0], grip.point[1] - pointer.point[1]);
        if (!best || distance < best.distance) best = { sketchId: sketch.id, shape, grip, distance, plane: sketch.plane, others: sketch.shapes.filter((item) => item.id !== shape.id) };
      }
    }
    if (!best) return false;
    // A centre grip is the same as dragging the whole curve (the move drag handles snapping).
    if (best.grip.kind === 'center') return false;
    if (best.grip.kind === 'vertex') state.select({ kind: 'curve-point', sketchId: best.sketchId, shapeId: best.shape.id, pointIndex: best.grip.index });
    this.drag = { kind: 'grip', sketchId: best.sketchId, shape: best.shape, grip: best.grip, plane: best.plane, others: best.others };
    return true;
  }

  /**
   * The direction a curve leaves in at `point` when it is the free end of an open curve on this
   * plane (the tangent arc continues it smoothly), else null.
   */
  private curveEndDirection(plane: SketchPlane, point: Vec2, radius: number): Vec2 | null {
    const state = this.store.getState();
    let best: { direction: Vec2; distance: number } | null = null;
    for (const sketch of state.sketches) {
      if (!sketch.visible || !samePlane(sketch.plane, plane)) continue;
      for (const shape of sketch.shapes) {
        if (shape.kind !== 'polyline' || shape.closed !== false || shape.points.length < 2) continue;
        const ends: [Vec2, boolean][] = [[shape.points[shape.points.length - 1]!, true], [shape.points[0]!, false]];
        for (const [end, atEnd] of ends) {
          const distance = Math.hypot(end[0] - point[0], end[1] - point[1]);
          if (distance > radius || (best && distance >= best.distance)) continue;
          const tangent = endTangent(shape as Polyline, atEnd);
          // Leaving the start of a curve means going back along it.
          best = { direction: atEnd ? tangent : [-tangent[0], -tangent[1]], distance };
        }
      }
    }
    return best?.direction ?? null;
  }

  /** Double-click on a selected polyline: adds a vertex there. Returns true when one was added. */
  insertVertexAt(pointer: ToolPointer): boolean {
    const state = this.store.getState();
    for (const sketch of state.sketches) {
      if (!samePlane(sketch.plane, pointer.plane)) continue;
      const ids = this.selectedShapeIds(sketch.id);
      for (const shape of sketch.shapes) {
        if (!ids.has(shape.id) || shape.kind !== 'polyline') continue;
        const next = insertVertex(shape, pointer.point);
        if (!next || next.kind !== 'polyline') continue;
        const index = next.points.findIndex((point, i) => !shape.points[i] || point !== shape.points[i]);
        if (Math.hypot(next.points[index]![0] - pointer.point[0], next.points[index]![1] - pointer.point[1]) > pointer.radius * 1.5) continue;
        state.setSketchShapes({ [sketch.id]: sketch.shapes.map((item) => (item.id === shape.id ? next : item)) });
        state.select({ kind: 'curve-point', sketchId: sketch.id, shapeId: shape.id, pointIndex: index });
        return true;
      }
    }
    return false;
  }

  /** Adds the shape (normalised) to the drag's sketch and ends the drag. */
  private commitDrag(shape: Shape2D | null): void {
    const drag = this.drag;
    if (!drag || drag.kind === 'move' || drag.kind === 'grip') return;
    this.drag = null;
    const state = this.store.getState();
    state.setSketchPreview(null);
    state.setNumericEntry('');
    if (!shape || !shapeIsValid(shape)) return;
    state.addShape(drag.sketchId, this.finishShape(normalise({ ...shape, id: newShapeId() }), drag.kind));
    // In sketch edit mode the drawing tool stays active (Revit's draw mode); otherwise back to Select.
    if (!state.sketchEdit) state.setTool('select');
  }

  /** Applies the draw options: offset to the left of the drawn direction, then the corner radius. */
  private finishShape(shape: Shape2D, kind: Drag['kind']): Shape2D {
    const { drawOffset, drawRadius } = this.store.getState().toolOptions;
    let result = shape;
    if (drawOffset && result.kind === 'polyline' && (kind === 'line' || kind === 'polyline')) {
      result = { ...result, points: offsetPoints(result.points, drawOffset, result.closed !== false) };
    }
    if (drawRadius > 0 && (kind === 'polyline' || kind === 'rect')) result = filletAll(result, drawRadius);
    return result;
  }

  /**
   * Commits a line; with Chain the next line starts at its end (and a corner radius rounds the
   * joint with the previous line of the chain). Without Chain the drawing ends as for any shape.
   */
  private commitLine(drag: Extract<Drag, { kind: 'line' }>, end: Vec2): void {
    const state = this.store.getState();
    const { chain, drawRadius } = state.toolOptions;
    if (!chain) {
      this.commitDrag(this.shapeOf(drag, end));
      return;
    }
    const raw = this.shapeOf(drag, end);
    if (!raw || !shapeIsValid(raw)) return;
    const shape = this.finishShape({ ...raw, id: newShapeId() }, 'line') as Extract<Shape2D, { kind: 'polyline' }>;
    const [from, to] = shape.points as [Vec2, Vec2];
    const previous = this.chainPrevious;
    const sketch = state.sketches.find((item) => item.id === drag.sketchId);
    const joint = previous && previous.sketchId === drag.sketchId && drawRadius > 0 && Math.hypot(previous.to[0] - from[0], previous.to[1] - from[1]) < 1e-6 ? filletJoint(previous.from, from, to, drawRadius) : null;
    if (joint && sketch) {
      const arc: Shape2D = { kind: 'polyline', id: newShapeId(), points: joint.arc.points, bulges: [joint.arc.bulge], closed: false };
      const second: Shape2D = { ...shape, points: joint.second };
      const shapes = sketch.shapes.map((item) => (item.id === previous!.shapeId && item.kind === 'polyline' ? { ...item, points: joint.first } : item));
      state.setSketchShapes({ [sketch.id]: [...shapes, arc, second] });
      this.chainPrevious = { sketchId: drag.sketchId, shapeId: second.id, from: joint.second[0], to: joint.second[1] };
    } else {
      state.addShape(drag.sketchId, shape);
      this.chainPrevious = { sketchId: drag.sketchId, shapeId: shape.id, from, to };
    }
    // The next line of the chain starts at the drawn end (not the offset one).
    this.drag = { kind: 'line', sketchId: drag.sketchId, plane: drag.plane, start: end, last: end };
    state.setNumericEntry('');
    this.preview(drag.plane, null, end);
  }

  private finishPolyline(): void {
    const drag = this.drag;
    if (!drag || drag.kind !== 'polyline') return;
    const bulges = drag.arcPending ? drag.bulges.slice(0, -1) : drag.bulges;
    const points = drag.arcPending ? drag.points.slice(0, -1) : drag.points;
    this.commitDrag({ kind: 'polyline', id: 'preview', points, ...(bulges.some((bulge) => bulge) ? { bulges } : {}) });
  }

  /** Enter / Escape / Backspace and typed digits while drawing. Returns true when consumed. */
  keyDown(event: { key: string; ctrlKey?: boolean; metaKey?: boolean }): boolean {
    if (!this.drag && this.modify.active) return this.modify.keyDown(event);
    const drag = this.drag;
    if (!drag || drag.kind === 'move' || drag.kind === 'grip') return false;
    const state = this.store.getState();
    if (event.key === 'Tab') {
      const cycled = this.inference.cycle();
      if (cycled && drag.kind !== 'freehand') {
        this.lastInference = { label: cycled.label, type: cycled.type, locked: false, screen: this.lastInference?.screen };
        const point: Vec2 = [cycled.position[0], cycled.position[1]];
        drag.last = point;
        this.preview(drag.plane, this.shapeOf(drag, point), point);
      }
      return true;
    }
    if (event.key.startsWith('Arrow')) {
      this.axisLock = event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? 'x' : 'y';
      return true;
    }
    if (event.key === 'Escape' && (this.axisLock || this.inference.currentLock)) {
      this.axisLock = null;
      this.inference.clearLock();
      return true;
    }
    if (event.key === 'Escape') {
      this.cancel();
      return true;
    }
    if (event.key === 'Enter') {
      const typed = parseTypedDimensions(state.numericEntry);
      if (drag.kind === 'polyline') {
        if (typed) this.extendPolyline(drag, typed[0]!);
        else this.finishPolyline();
      } else if (drag.kind === 'line' || drag.kind === 'knife') {
        const length = typed?.[0];
        if (length) {
          const angle = Math.atan2(drag.last[1] - drag.start[1], drag.last[0] - drag.start[0]);
          const end: Vec2 = [drag.start[0] + Math.cos(angle) * length, drag.start[1] + Math.sin(angle) * length];
          if (drag.kind === 'line') this.commitLine(drag, end);
          else this.commitDrag(this.shapeOf(drag, end));
        } else if (drag.kind === 'line' && this.chainPrevious && Math.hypot(drag.last[0] - drag.start[0], drag.last[1] - drag.start[1]) < 1e-6) this.cancel();
        else if (drag.kind === 'line') {
          // Enter places the line where the pointer is and ends the chain.
          this.commitLine(drag, drag.last);
          this.cancel();
        } else this.commitDrag(this.shapeOf(drag, drag.last));
      } else if (drag.kind === 'freehand') {
        this.cancel();
      } else if (drag.kind === 'spline') {
        if (drag.nodes.length >= 2) this.commitDrag(penShape(drag.nodes, false));
        else this.cancel();
      } else if (drag.kind === 'circle3' || drag.kind === 'tangentArc') {
        const shape = this.shapeOf(drag, drag.last);
        if (drag.kind === 'circle3' ? shape?.kind === 'circle' : drag.direction) this.commitDrag(shape);
        else this.cancel();
      } else if (drag.kind === 'ellipse') {
        // Typed: the other radius once the axis is placed (else the axis length along the pointer).
        const value = typed?.[0];
        if (!drag.axis) {
          const angle = Math.atan2(drag.last[1] - drag.center[1], drag.last[0] - drag.center[0]);
          if (value) {
            drag.axis = [drag.center[0] + Math.cos(angle) * value, drag.center[1] + Math.sin(angle) * value];
            state.setNumericEntry('');
          } else this.cancel();
        } else if (value) this.commitDrag(ellipseShape(drag.center, drag.axis, Math.abs(value)));
        else if (distanceFromAxis(drag.center, drag.axis, drag.last) > 1e-6) this.commitDrag(this.shapeOf(drag, drag.last));
        else this.cancel();
      } else if (drag.kind === 'centerArc') {
        // A typed number is the sweep in degrees (the sign follows the drawn direction).
        const sweep = typed?.[0] !== undefined && drag.start ? (typed[0] * Math.PI) / 180 * (drag.sweep < 0 ? -1 : 1) : drag.sweep;
        if (drag.start && Math.abs(sweep) > 1e-6) this.commitDrag(centerArcShape(drag.center, drag.start, sweep));
        else this.cancel();
      } else {
        this.commitDrag(typed ? this.typedShape(drag, typed) : this.shapeOf(drag, drag.last));
      }
      return true;
    }
    if (event.key === 'Backspace') {
      if (state.numericEntry) state.setNumericEntry(state.numericEntry.slice(0, -1));
      else if (drag.kind === 'polyline' && drag.points.length > 1) {
        drag.points.pop();
        drag.bulges.pop();
        drag.arcPending = false;
        this.preview(drag.plane, this.shapeOf(drag, drag.last), drag.last);
      } else if (drag.kind === 'spline' && drag.nodes.length > 1) {
        drag.nodes.pop();
        this.preview(drag.plane, this.shapeOf(drag, drag.last), drag.last, undefined, penTies(drag.nodes));
      }
      return true;
    }
    if (event.key.toLowerCase() === 't' && drag.kind === 'polyline' && !drag.arcPending) {
      state.setToolOptions({ tangentArc: !state.toolOptions.tangentArc });
      this.preview(drag.plane, this.shapeOf(drag, drag.last), drag.last);
      return true;
    }
    if (event.key.toLowerCase() === 'a' && drag.kind === 'polyline' && !drag.arcPending) {
      state.setToolOptions({ arc: !state.toolOptions.arc });
      return true;
    }
    if (/^[0-9.,x\-\s]$/i.test(event.key) && !event.ctrlKey && !event.metaKey) {
      state.setNumericEntry(state.numericEntry + event.key);
      return true;
    }
    return false;
  }

  /** A typed length extends the current segment along its direction, then drawing goes on. */
  private extendPolyline(drag: Extract<Drag, { kind: 'polyline' }>, length: number): void {
    const anchor = drag.points[drag.points.length - 1]!;
    const angle = Math.atan2(drag.last[1] - anchor[1], drag.last[0] - anchor[0]);
    const point: Vec2 = [anchor[0] + Math.cos(angle) * length, anchor[1] + Math.sin(angle) * length];
    drag.points.push(point);
    drag.bulges.push(0);
    drag.last = point;
    this.store.getState().setNumericEntry('');
    this.preview(drag.plane, this.shapeOf(drag, point), point);
  }

  /** The shape a typed dimension gives: sizes replace the drag length, the drag direction stays. */
  private typedShape(drag: Extract<Drag, { kind: 'rect' | 'circle' | 'polygon' }>, typed: number[]): Shape2D | null {
    const [a, b] = typed;
    const sign = (value: number) => (value < 0 ? -1 : 1);
    switch (drag.kind) {
      case 'rect': {
        const width = (a ?? 0) * sign(drag.last[0] - drag.start[0] || 1);
        const height = (b ?? a ?? 0) * sign(drag.last[1] - drag.start[1] || 1);
        return this.shapeOf(drag, [drag.start[0] + width, drag.start[1] + height]);
      }
      case 'circle':
      case 'polygon': {
        const radius = Math.abs(a ?? 0) * (drag.kind === 'circle' && this.store.getState().toolOptions.circleMode === '2p' ? 2 : 1);
        const angle = Math.atan2(drag.last[1] - drag.start[1], drag.last[0] - drag.start[0]);
        return this.shapeOf(drag, [drag.start[0] + Math.cos(angle) * radius, drag.start[1] + Math.sin(angle) * radius]);
      }
    }
  }

  /** Drops the shape in progress (a moved shape keeps its new place; undo reverts it). */
  cancel(): void {
    this.drag = null;
    this.chainPrevious = null;
    this.modify.cancel();
    this.moved = false;
    this.axisLock = null;
    this.inference.clearLock();
    this.lastInference = undefined;
    this.lastAnchor = null;
    const state = this.store.getState();
    state.setSketchPreview(null);
    state.setNumericEntry('');
  }
}

/**
 * The bulge of an arc from the last point of a chain to `end` that leaves tangent to the chain's
 * last segment (straight or arc). 0 when there is no previous segment.
 */
export function tangentBulge(points: readonly Vec2[], bulges: readonly number[], end: Vec2): number {
  if (points.length < 2) return 0;
  const a = points[points.length - 2]!;
  const p = points[points.length - 1]!;
  const previous = bulges[points.length - 2] ?? 0;
  // Direction at the end of the previous segment: its chord turned by half its sweep.
  const chordAngle = Math.atan2(p[1] - a[1], p[0] - a[0]);
  const direction = chordAngle + 2 * Math.atan(previous);
  let alpha = Math.atan2(end[1] - p[1], end[0] - p[0]) - direction;
  while (alpha > Math.PI) alpha -= Math.PI * 2;
  while (alpha < -Math.PI) alpha += Math.PI * 2;
  // A tangent arc's sweep is twice the angle between its start tangent and its chord.
  return Math.tan(alpha / 2);
}

/** A centre-ends arc as an open polyline with one bulge (a near-full sweep stays an arc). */
export function centerArcShape(center: Vec2, start: Vec2, sweep: number): Shape2D {
  const radius = Math.hypot(start[0] - center[0], start[1] - center[1]);
  const angle = Math.atan2(start[1] - center[1], start[0] - center[0]) + sweep;
  const end: Vec2 = [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius];
  return { kind: 'polyline', id: 'preview', points: [start, end], bulges: [Math.tan(sweep / 4)], closed: false };
}

/** Handle lines of the pen's smooth nodes (drawn as ghosts while drawing). */
function penTies(nodes: readonly PenNode[]): Shape2D[] {
  return nodes.flatMap((node): Shape2D[] => {
    if (!node.handle) return [];
    const into: Vec2 = [2 * node.point[0] - node.handle[0], 2 * node.point[1] - node.handle[1]];
    return [{ kind: 'polyline', id: 'tie', points: [into, node.handle], closed: false }];
  });
}

/** What the status label shows while a grip is dragged. */
function gripMeasurement(shape: Shape2D, grip: Grip): string | undefined {
  if (shape.kind === 'rect') return `${formatMm(shape.width)} × ${formatMm(shape.height)}`;
  if (shape.kind === 'circle' || shape.kind === 'polygon') return `R ${formatMm(shape.radius)}`;
  if (shape.kind === 'polyline' && (grip.kind === 'vertex' || grip.kind === 'segment')) {
    const index = grip.index;
    const a = shape.points[index - (grip.kind === 'vertex' ? 1 : 0)];
    const b = shape.points[grip.kind === 'vertex' ? index : (index + 1) % shape.points.length];
    return a && b ? `L ${formatMm(Math.hypot(b[0] - a[0], b[1] - a[1]))}` : undefined;
  }
  return undefined;
}

function formatMm(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Object.is(rounded, -0) ? 0 : rounded} mm`;
}

function shapeMeasurement(shape: Shape2D): string | undefined {
  switch (shape.kind) {
    case 'rect':
      return `${formatMm(Math.abs(shape.width))} × ${formatMm(Math.abs(shape.height))}`;
    case 'circle':
    case 'polygon':
      return `R ${formatMm(shape.radius)}`;
    case 'polyline': {
      const to = shape.points.at(-1);
      const from = shape.points.at(-2);
      return from && to ? `L ${formatMm(Math.hypot(to[0] - from[0], to[1] - from[1]))}` : undefined;
    }
  }
}

/** Rectangles are stored with positive sizes so the Inspector shows plain width/height. */
function normalise(shape: Shape2D): Shape2D {
  if (shape.kind !== 'rect') return shape;
  return { ...shape, x: Math.min(shape.x, shape.x + shape.width), y: Math.min(shape.y, shape.y + shape.height), width: Math.abs(shape.width), height: Math.abs(shape.height) };
}

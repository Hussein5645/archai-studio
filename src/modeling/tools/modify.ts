/**
 * The curve modify tools (Revit's Modify tab for sketch lines): Move, Copy, Rotate, Mirror,
 * Scale by picked points, and Trim / Extend, Split, Fillet by picking curves. They work on the
 * selected curves (or the curve clicked first when nothing is selected), snap through the
 * sketch tool's inference, show ghost previews, accept typed values (distance, angle, factor)
 * and write each operation as one undo step. Pure state machine: no three.js.
 */
import type { StoreApi } from 'zustand';
import { samePlane } from '../kernel/sketch';
import type { Shape2D, Sketch, SketchPlane, Vec2 } from '../kernel/types';
import { cornerShapes, extendShapeTo, filletCorner, joinShapes, mirrorShape, moveShape, nearestSegment, rotateShape, scaleShape, splitShapeAt, trimShape } from '../sketchEdit';
import { parseTypedDimensions } from '../snap';
import { MODIFY_TOOLS, newShapeId, type ModelingState, type SelectedItem, type Tool } from '../store';
import type { ToolPointer } from './sketch';

/** What the modify tool needs from the sketch tool: snapping and the preview overlay. */
export interface ModifyHost {
  snap(pointer: ToolPointer, anchor: Vec2 | null, exclude?: string): Vec2;
  preview(plane: SketchPlane, shape: Shape2D | null, snap: Vec2 | null, measurement?: string, shapes?: Shape2D[]): void;
}

interface Target {
  sketch: Sketch;
  shapes: Shape2D[];
}

const TRANSFORM_TOOLS: Tool[] = ['smove', 'scopy', 'srotate', 'smirror', 'sscale'];

function format(value: number, unit = 'mm'): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Object.is(rounded, -0) ? 0 : rounded}${unit ? ` ${unit}` : ''}`;
}

function angleOf(from: Vec2, to: Vec2): number {
  return (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;
}

export class ModifyTool {
  /** Points picked so far (base, reference, …) for the transform tools. */
  private points: Vec2[] = [];
  /** A curve picked first: trim's first line, extend's boundary, mirror's axis line. */
  private picked: { sketchId: string; shapeId: string; point: Vec2 } | null = null;
  private last: Vec2 | null = null;
  private lastPlane: SketchPlane | null = null;

  constructor(
    private readonly store: StoreApi<ModelingState>,
    private readonly host: ModifyHost,
  ) {}

  static handles(tool: Tool): boolean {
    return MODIFY_TOOLS.includes(tool);
  }

  get active(): boolean {
    return this.points.length > 0 || this.picked !== null;
  }

  /** Selected curves grouped by sketch; in sketch edit mode only the edited sketch's. */
  targets(): Target[] {
    const state = this.store.getState();
    const items: SelectedItem[] = state.selectionSet.length ? state.selectionSet : state.selection ? [state.selection] : [];
    const bySketch = new Map<string, Set<string>>();
    for (const item of items) {
      if (item.kind !== 'shape' && item.kind !== 'curve-point' && item.kind !== 'loop') continue;
      if (state.sketchEdit && item.sketchId !== state.sketchEdit.sketchId) continue;
      const ids = bySketch.get(item.sketchId) ?? new Set<string>();
      for (const id of item.kind === 'loop' ? item.shapeIds : [item.shapeId]) ids.add(id);
      bySketch.set(item.sketchId, ids);
    }
    const targets: Target[] = [];
    for (const [sketchId, ids] of bySketch) {
      const sketch = state.sketches.find((item) => item.id === sketchId);
      const shapes = sketch?.shapes.filter((shape) => ids.has(shape.id)) ?? [];
      if (sketch && shapes.length) targets.push({ sketch, shapes });
    }
    return targets;
  }

  /** The plane the tool works in: that of the selected curves (else null → the work plane). */
  plane(): SketchPlane | null {
    return this.targets()[0]?.sketch.plane ?? null;
  }

  /** Mirrors the progress into the store so the options bar can explain the next click. */
  private publish(): void {
    const progress = { points: this.points.length, picked: this.picked !== null };
    const current = this.store.getState().modifyProgress;
    if (current.points !== progress.points || current.picked !== progress.picked) this.store.setState({ modifyProgress: progress });
  }

  pointerDown(pointer: ToolPointer): void {
    this.handleDown(pointer);
    this.publish();
  }

  private handleDown(pointer: ToolPointer): void {
    const state = this.store.getState();
    const tool = state.tool;
    const hit = this.hitShape(pointer);
    if (TRANSFORM_TOOLS.includes(tool)) {
      // Nothing selected yet: the first click picks the curve (Shift adds more).
      if (this.targets().length === 0 || (pointer.additive && this.points.length === 0 && hit)) {
        if (hit) state.select({ kind: 'shape', sketchId: hit.sketchId, shapeId: hit.shapeId }, pointer.additive);
        return;
      }
      // Mirror: clicking a line (not one being mirrored) uses it as the axis right away.
      if (tool === 'smirror' && this.points.length === 0 && hit && !this.isTarget(hit.shapeId)) {
        const segment = this.segmentAt(hit, pointer.point);
        if (segment) {
          this.apply(this.transformed([segment[0], segment[1]]));
          return;
        }
      }
      const plane = this.plane() ?? pointer.plane;
      const point = this.host.snap({ ...pointer, plane }, this.points[this.points.length - 1] ?? null);
      this.points.push(point);
      this.last = point;
      this.lastPlane = plane;
      const needed = tool === 'srotate' || tool === 'sscale' ? 3 : 2;
      if (this.points.length >= needed) {
        this.apply(this.transformed(this.points));
        return;
      }
      this.showPreview(point);
      return;
    }
    if (!hit) return;
    const sketch = state.sketches.find((item) => item.id === hit.sketchId);
    const shape = sketch?.shapes.find((item) => item.id === hit.shapeId);
    if (!sketch || !shape) return;
    const point = pointer.point;
    const others = sketch.shapes.filter((item) => item.id !== shape.id);
    const { modify } = state.toolOptions;
    switch (tool) {
      case 'split': {
        const at = this.host.snap({ ...pointer, plane: sketch.plane }, null);
        const pieces = splitShapeAt(shape, at, newShapeId);
        this.replace(sketch, [shape.id], pieces);
        return;
      }
      case 'trim': {
        if (modify.trimMode === 'segment') {
          const pieces = trimShape(shape, point, others, newShapeId);
          this.replace(sketch, [shape.id], pieces);
          return;
        }
        if (!this.picked || this.picked.sketchId !== sketch.id) {
          this.picked = { sketchId: sketch.id, shapeId: shape.id, point };
          state.select({ kind: 'shape', sketchId: sketch.id, shapeId: shape.id });
          return;
        }
        const first = sketch.shapes.find((item) => item.id === this.picked!.shapeId);
        const result = first && first.id !== shape.id ? cornerShapes(first, this.picked.point, shape, point) : null;
        this.picked = null;
        if (result) this.replace(sketch, [first!.id, shape.id], result);
        return;
      }
      case 'extend': {
        if (!this.picked || this.picked.sketchId !== sketch.id) {
          this.picked = { sketchId: sketch.id, shapeId: shape.id, point };
          state.select({ kind: 'shape', sketchId: sketch.id, shapeId: shape.id });
          return;
        }
        const boundary = sketch.shapes.find((item) => item.id === this.picked!.shapeId);
        const extended = boundary && boundary.id !== shape.id ? extendShapeTo(shape, point, boundary) : null;
        if (extended) this.replace(sketch, [shape.id], [extended], true);
        return;
      }
      case 'fillet': {
        const size = Math.max(0, modify.filletSize);
        let result = filletCorner(shape, point, size, modify.filletMode);
        let removed = [shape.id];
        if (!result && shape.kind === 'polyline' && shape.closed === false) {
          // Two separate lines meeting at the clicked end: join them, then round the corner.
          const end = [shape.points[0]!, shape.points[shape.points.length - 1]!].sort((a, b) => Math.hypot(a[0] - point[0], a[1] - point[1]) - Math.hypot(b[0] - point[0], b[1] - point[1]))[0]!;
          const partner = others.find((other) => other.kind === 'polyline' && other.closed === false && [other.points[0]!, other.points[other.points.length - 1]!].some((p) => Math.hypot(p[0] - end[0], p[1] - end[1]) < 1e-3));
          if (partner) {
            const joined = joinShapes([shape, partner]);
            if (joined.length === 1) {
              result = filletCorner(joined[0]!, end, size, modify.filletMode);
              removed = [shape.id, partner.id];
            }
          }
        }
        if (result) this.replace(sketch, removed, [result]);
        return;
      }
    }
  }

  pointerMove(pointer: ToolPointer): void {
    const tool = this.store.getState().tool;
    if (!TRANSFORM_TOOLS.includes(tool) || this.points.length === 0) return;
    const plane = this.plane() ?? pointer.plane;
    const point = this.host.snap({ ...pointer, plane }, this.points[this.points.length - 1] ?? null);
    this.last = point;
    this.lastPlane = plane;
    this.showPreview(point);
  }

  /** Enter applies a typed distance / angle / factor; Escape steps back. Returns true when consumed. */
  keyDown(event: { key: string }): boolean {
    const state = this.store.getState();
    if (!this.active) return false;
    if (event.key === 'Escape') {
      this.cancel();
      return true;
    }
    if (event.key === 'Backspace' && state.numericEntry) {
      state.setNumericEntry(state.numericEntry.slice(0, -1));
      return true;
    }
    if (/^[0-9.,\-\s]$/.test(event.key)) {
      state.setNumericEntry(state.numericEntry + event.key);
      return true;
    }
    if (event.key !== 'Enter') return false;
    const typed = parseTypedDimensions(state.numericEntry)?.[0];
    state.setNumericEntry('');
    if (typed === undefined || !Number.isFinite(typed)) return true;
    const tool = state.tool;
    const base = this.points[0]!;
    const last = this.last ?? base;
    if (tool === 'smove' || tool === 'scopy') {
      const angle = Math.atan2(last[1] - base[1], last[0] - base[0]) || 0;
      this.apply(this.transformed([base, [base[0] + Math.cos(angle) * typed, base[1] + Math.sin(angle) * typed]]));
    } else if (tool === 'srotate') {
      const start = this.points.length >= 2 ? angleOf(base, this.points[1]!) : 0;
      const rad = ((start + typed) * Math.PI) / 180;
      const reference: Vec2 = this.points[1] ?? [base[0] + 1, base[1]];
      this.apply(this.transformed([base, reference, [base[0] + Math.cos(rad), base[1] + Math.sin(rad)]]));
    } else if (tool === 'sscale' && typed !== 0) {
      const reference: Vec2 = this.points[1] ?? [base[0] + 1, base[1]];
      this.apply(this.transformed([base, reference, [base[0] + (reference[0] - base[0]) * typed, base[1] + (reference[1] - base[1]) * typed]]));
    }
    return true;
  }

  cancel(): void {
    this.points = [];
    this.picked = null;
    this.last = null;
    this.publish();
    const state = this.store.getState();
    state.setSketchPreview(null);
    state.setNumericEntry('');
  }

  // ---- internals ------------------------------------------------------------------------------

  private hitShape(pointer: ToolPointer): { sketchId: string; shapeId: string } | null {
    const hit = pointer.hit.shape;
    const editing = this.store.getState().sketchEdit?.sketchId;
    if (!hit || (editing && hit.sketchId !== editing)) return null;
    return hit;
  }

  private isTarget(shapeId: string): boolean {
    return this.targets().some((target) => target.shapes.some((shape) => shape.id === shapeId));
  }

  /** The straight segment of a curve nearest to a point (a mirror axis). */
  private segmentAt(hit: { sketchId: string; shapeId: string }, point: Vec2): [Vec2, Vec2] | null {
    const shape = this.store.getState().sketches.find((item) => item.id === hit.sketchId)?.shapes.find((item) => item.id === hit.shapeId);
    if (!shape || shape.kind === 'circle') return null;
    const nearest = nearestSegment(shape, point);
    if (!nearest) return null;
    const line = shape.kind === 'polyline' ? shape.points : null;
    if (line) return [line[nearest.index]!, line[(nearest.index + 1) % line.length]!];
    return null;
  }

  /**
   * The targets after the current tool's transform given its picked points. Returns, per sketch,
   * the shapes to remove and the shapes to add (copies keep the originals).
   */
  private transformed(points: readonly Vec2[]): { sketch: Sketch; remove: string[]; add: Shape2D[] }[] {
    const state = this.store.getState();
    const { modify } = state.toolOptions;
    const tool = state.tool;
    const [a, b, c] = points as [Vec2, Vec2 | undefined, Vec2 | undefined];
    return this.targets().map(({ sketch, shapes }) => {
      const ids = shapes.map((shape) => shape.id);
      switch (tool) {
        case 'smove':
          return { sketch, remove: ids, add: shapes.map((shape) => moveShape(shape, [b![0] - a[0], b![1] - a[1]])) };
        case 'scopy': {
          const copies = Math.max(1, Math.round(modify.copies));
          const add: Shape2D[] = [];
          for (let k = 1; k <= copies; k++) for (const shape of shapes) add.push({ ...moveShape(shape, [(b![0] - a[0]) * k, (b![1] - a[1]) * k]), id: newShapeId() });
          return { sketch, remove: [], add };
        }
        case 'srotate': {
          const angle = angleOf(a, c!) - angleOf(a, b!);
          const add = shapes.map((shape) => ({ ...rotateShape(shape, a, angle), ...(modify.rotateCopy ? { id: newShapeId() } : {}) }));
          return { sketch, remove: modify.rotateCopy ? [] : ids, add };
        }
        case 'smirror': {
          const add = shapes.map((shape) => ({ ...mirrorShape(shape, a, b!), ...(modify.mirrorCopy ? { id: newShapeId() } : {}) }));
          return { sketch, remove: modify.mirrorCopy ? [] : ids, add };
        }
        case 'sscale': {
          const reference = Math.hypot(b![0] - a[0], b![1] - a[1]);
          const factor = reference > 1e-9 ? Math.hypot(c![0] - a[0], c![1] - a[1]) / reference : 1;
          return { sketch, remove: ids, add: factor > 1e-6 ? shapes.map((shape) => scaleShape(shape, a, factor)) : shapes };
        }
        default:
          return { sketch, remove: [], add: [] };
      }
    });
  }

  private showPreview(point: Vec2): void {
    const state = this.store.getState();
    const tool = state.tool;
    const plane = this.lastPlane ?? this.plane();
    if (!plane) return;
    const base = this.points[0]!;
    let ghosts: Shape2D[] = [];
    let measurement: string | undefined;
    if (tool === 'smove' || tool === 'scopy') {
      ghosts = this.transformed([base, point]).flatMap((item) => item.add);
      measurement = `${format(Math.hypot(point[0] - base[0], point[1] - base[1]))} · ${format(angleOf(base, point), '°')}`;
    } else if (tool === 'srotate' && this.points.length >= 2) {
      ghosts = this.transformed([base, this.points[1]!, point]).flatMap((item) => item.add);
      let angle = angleOf(base, point) - angleOf(base, this.points[1]!);
      if (angle > 180) angle -= 360;
      if (angle < -180) angle += 360;
      measurement = format(angle, '°');
    } else if (tool === 'smirror') {
      ghosts = this.transformed([base, point]).flatMap((item) => item.add);
    } else if (tool === 'sscale' && this.points.length >= 2) {
      ghosts = this.transformed([base, this.points[1]!, point]).flatMap((item) => item.add);
      const reference = Math.hypot(this.points[1]![0] - base[0], this.points[1]![1] - base[1]);
      measurement = reference > 1e-9 ? `× ${Math.round((Math.hypot(point[0] - base[0], point[1] - base[1]) / reference) * 1000) / 1000}` : undefined;
    }
    const guide: Shape2D = { kind: 'polyline', id: 'modify-guide', points: [this.points[this.points.length - 1]!, point], closed: false };
    this.host.preview(plane, guide, point, measurement, ghosts);
  }

  /** Writes a transform: one undo step across sketches, and selects the result. */
  private apply(changes: { sketch: Sketch; remove: string[]; add: Shape2D[] }[]): void {
    const state = this.store.getState();
    const next: Record<string, Shape2D[]> = {};
    const selected: SelectedItem[] = [];
    for (const { sketch, remove, add } of changes) {
      if (!add.length && !remove.length) continue;
      const removed = new Set(remove);
      const kept = sketch.shapes.flatMap((shape) => {
        if (!removed.has(shape.id)) return [shape];
        const replacement = add.find((item) => item.id === shape.id);
        return replacement ? [replacement] : [];
      });
      const fresh = add.filter((item) => !sketch.shapes.some((shape) => shape.id === item.id));
      next[sketch.id] = [...kept, ...fresh];
      for (const shape of add) selected.push({ kind: 'shape', sketchId: sketch.id, shapeId: shape.id });
    }
    this.cancel();
    if (!Object.keys(next).length) return;
    state.setSketchShapes(next);
    if (selected.length) this.store.getState().selectMany(selected);
  }

  /** Replaces some curves of a sketch with others (one undo step) and selects the new ones. */
  private replace(sketch: Sketch, remove: string[], add: Shape2D[], keepPicked = false): void {
    const state = this.store.getState();
    const current = state.sketches.find((item) => item.id === sketch.id) ?? sketch;
    const removed = new Set(remove);
    const shapes: Shape2D[] = [];
    let inserted = false;
    for (const shape of current.shapes) {
      if (!removed.has(shape.id)) shapes.push(shape);
      else if (!inserted) {
        // The results take the place of the first replaced curve (keeps Layers order stable).
        shapes.push(...add);
        inserted = true;
      }
    }
    if (!inserted) shapes.push(...add);
    const picked = this.picked;
    this.cancel();
    if (keepPicked) {
      this.picked = picked;
      this.publish();
    }
    state.setSketchShapes({ [sketch.id]: shapes });
    if (add.length) this.store.getState().selectMany(add.map((shape) => ({ kind: 'shape', sketchId: sketch.id, shapeId: shape.id })));
    else this.store.getState().select(null);
  }

  /** Whether a plane is the one the tool is working in (pointer events from other planes are ignored). */
  accepts(plane: SketchPlane): boolean {
    const own = this.plane();
    return !own || samePlane(own, plane);
  }
}

/** What the options bar says the next click of a modify tool does. */
export function modifyInstruction(state: Pick<ModelingState, 'tool' | 'toolOptions' | 'modifyProgress'>, hasTargets: boolean): string {
  const n = state.modifyProgress.points;
  const picked = state.modifyProgress.picked;
  switch (state.tool) {
    case 'smove':
    case 'scopy':
      return !hasTargets ? 'Click the curves to move (or select them first)' : n === 0 ? 'Click the base point' : 'Click the target point · or type a distance and Enter';
    case 'srotate':
      return !hasTargets ? 'Click the curves to rotate' : n === 0 ? 'Click the centre of rotation' : n === 1 ? 'Click the start direction · or type an angle and Enter' : 'Click the end direction · or type an angle and Enter';
    case 'smirror':
      return !hasTargets ? 'Click the curves to mirror' : n === 0 ? 'Click a line to mirror about, or the first point of the axis' : 'Click the second point of the axis';
    case 'sscale':
      return !hasTargets ? 'Click the curves to scale' : n === 0 ? 'Click the base point' : n === 1 ? 'Click a reference point · or type a factor and Enter' : 'Click the new position of the reference point';
    case 'trim':
      return state.toolOptions.modify.trimMode === 'segment' ? 'Click the piece of a curve to delete (between intersections)' : picked ? 'Click the second line (the side to keep)' : 'Click the first line (the side to keep)';
    case 'extend':
      return picked ? 'Click the lines to extend to the boundary · Esc to pick another boundary' : 'Click the boundary curve';
    case 'split':
      return 'Click a curve where it should split';
    case 'fillet':
      return 'Click near a corner to round (or chamfer) it';
    default:
      return '';
  }
}

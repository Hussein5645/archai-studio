/**
 * The board's drafting and modify tools (AutoCAD / Revit style), as a small state machine the
 * pointer layer (useInteractions) delegates to:
 *
 * - draw: rectangle (click-click or drag, typed W×H, rounded corners), circle (centre / 2 / 3
 *   points), arc (3 points, centre-ends, tangent), polygon, ellipse;
 * - modify: move, copy (repeatable, with a count), rotate, mirror, scale, array (linear / polar,
 *   live), offset, trim / extend, split, fillet / chamfer, match properties.
 *
 * Every pick snaps through the drafting engine (object snaps, tracking, polar, grid), every step
 * accepts typed values (see src/drafting/input.ts), and every result is one command, previewed
 * live with the executor against the document as it was when the step began.
 */
import type { AppStore, ToolId } from '@/store';
import type { ArchaiDocument, Element, ElementTable, LineElement } from '@/document';

type PenSegments = NonNullable<LineElement['path']>['segments'];
import { distance, formatLength, sampleCurvePath, type Vec2 } from '@/geometry';
import { draftGeometry } from '@/drafting/geometry';
import { isTypedCharacter, parseNumber, parseTyped, typedPoint } from '@/drafting/input';
import { acquires, SNAP_CAPTIONS, type Guide, type OsnapResult } from '@/drafting/osnap';
import { arcCentre, arcTangent, arcThrough, circleFrom2, circleFrom3, circlePath, distanceFromAxis, ellipsePath, polygonPoints } from '@/drafting/shapes';
import { snapBoardPoint } from './boardSnap';

type Tuple = [number, number];

/** What the drafting tools draw over the board (world coordinates). */
export interface DraftingOverlay {
  /** Preview outlines of the shape being drawn. */
  paths: { points: Vec2[]; closed: boolean }[];
  /** Rubber-band line from the last picked point (dashed). */
  rubber: { a: Vec2; b: Vec2 } | null;
  /** Points picked so far in this step. */
  picks: Vec2[];
  /** The instruction for the next click, the typed value and a live measurement, near the cursor. */
  prompt: { text: string; typed: string; measure: string | null; at: Vec2 } | null;
}

export interface SnapOverlay {
  point: Vec2;
  text: string;
  kind: string;
  guides: Guide[];
}

export interface DraftingHost {
  store: AppStore;
  dispatch: (commandId: string, input?: unknown) => { ok: boolean; value?: unknown; error?: { message: string } };
  preview: (commandId: string, input: unknown, base: ArchaiDocument) => void;
  clearPreview: () => void;
  /** The selectable element under a world point (for picking curves), or null. */
  pick: (world: Vec2) => Element | null;
  /** The leaf element under a world point (a line inside a group), or null. */
  pickLeaf: (world: Vec2) => Element | null;
  toast: (message: string) => void;
}

export interface PointerInfo {
  alt: boolean;
  shift: boolean;
  /** Screen pixels → world mm at the current zoom. */
  pixel: number;
  /** The primary button is held (dragging out pen handles). */
  pressed?: boolean;
}

/** A point of the pen tool's path with its Bézier handles (absolute points), if dragged out. */
interface PenNode {
  p: Vec2;
  in?: Vec2;
  out?: Vec2;
}

const TOOL_VERBS: Record<string, string> = { 'modify:move': 'move', 'modify:copy': 'copy', 'modify:rotate': 'rotate', 'modify:mirror': 'mirror', 'modify:scale': 'scale', 'modify:array': 'array' };

const DRAW_TOOLS: ReadonlySet<string> = new Set(['rect', 'draw:circle', 'draw:arc', 'draw:polygon', 'draw:ellipse', 'draw:pen']);

function fmt(mm: number): string {
  const rounded = Math.round(mm * 10) / 10;
  return `${Object.is(rounded, -0) ? 0 : rounded}`;
}

/** Angle on screen in degrees, counter-clockwise from +x (board y points down). */
function screenAngle(from: Vec2, to: Vec2): number {
  return (Math.atan2(-(to.y - from.y), to.x - from.x) * 180) / Math.PI;
}

function toTuple(p: Vec2): Tuple {
  return [p.x, p.y];
}

export class DraftingController {
  private points: Vec2[] = [];
  /** Picked elements with where they were picked (trim, extend, match, fillet). */
  private picked: { id: string; at: Vec2 }[] = [];
  private track: Vec2[] = [];
  private cursor: Vec2 | null = null;
  private lastSnap: OsnapResult | null = null;
  /** Centre-ends arc: the sweep accumulated while the pointer circles the centre. */
  private sweep = 0;
  private lastAngle = 0;
  /** Base document for live previews of the current modify step. */
  private base: ArchaiDocument | null = null;
  /** Rectangle drag: where the press started, to tell a drag from a click. */
  private pressAt: Vec2 | null = null;
  typed = '';
  /** Pen tool: the nodes placed so far, and whether the last one's handles are being dragged. */
  private pen: PenNode[] = [];
  private penDragging = false;
  /** Transform tools started with nothing selected: clicks select, Enter continues. */
  private selecting = false;
  private renderer: ((overlay: DraftingOverlay | null, snap: SnapOverlay | null) => void) | null = null;

  constructor(private readonly host: DraftingHost) {}

  private hoverer: ((id: string | null) => void) | null = null;

  /**
   * Where previews and prompts go (the board overlay), and how the element the next click would
   * select or pick is highlighted; returns the disconnect function.
   */
  connect(render: (overlay: DraftingOverlay | null, snap: SnapOverlay | null) => void, hover: (id: string | null) => void): () => void {
    this.renderer = render;
    this.hoverer = hover;
    return () => {
      if (this.renderer === render) this.renderer = null;
      if (this.hoverer === hover) this.hoverer = null;
    };
  }

  private render(overlay: DraftingOverlay | null, snap: SnapOverlay | null): void {
    this.renderer?.(overlay, snap);
  }

  handles(tool: ToolId): boolean {
    return DRAW_TOOLS.has(tool) || tool.startsWith('modify:');
  }

  /** A step is in progress (Escape cancels it before leaving the tool). */
  get active(): boolean {
    return this.points.length > 0 || this.picked.length > 0 || this.typed.length > 0 || this.pen.length > 0;
  }

  private get state() {
    return this.host.store.getState();
  }

  private get tool(): ToolId {
    return this.state.ui.tool;
  }

  private selection(): string[] {
    return this.state.ui.selection.filter((id) => id in this.state.doc.elements);
  }

  // ---- snapping (shared with the other board tools) ------------------------------------------

  /**
   * The drafting point for a pointer position: object snaps, tracking and polar lines from
   * `anchor`, the grid, or the raw point with Alt. Shift locks the direction from the anchor to
   * the polar increment (45° when polar is off).
   */
  snap(world: Vec2, info: PointerInfo, anchor: Vec2 | null = null, exclude?: ReadonlySet<string>): OsnapResult {
    const state = this.state;
    if (info.alt) return { point: world, kind: null, guides: [] };
    let cursor = world;
    const settings = state.ui.drafting.osnap;
    if (anchor && info.shift) {
      const step = ((settings.polar || 45) * Math.PI) / 180;
      const angle = Math.round(Math.atan2(world.y - anchor.y, world.x - anchor.x) / step) * step;
      const len = distance(anchor, world);
      cursor = { x: anchor.x + Math.cos(angle) * len, y: anchor.y + Math.sin(angle) * len };
      return { point: cursor, kind: 'polar', guides: [{ a: anchor, b: cursor }] };
    }
    const result = snapBoardPoint(state, cursor, { pixel: info.pixel, anchor, trackPoints: this.track, ...(exclude ? { exclude } : {}) });
    if (acquires(result.kind) && !this.track.some((p) => distance(p, result.point) < 1e-6)) {
      this.track = [result.point, ...this.track].slice(0, 6);
    }
    return result;
  }

  snapOverlay(result: OsnapResult | null): SnapOverlay | null {
    if (!result?.kind) return null;
    return { point: result.point, text: SNAP_CAPTIONS[result.kind], kind: result.kind, guides: result.guides };
  }

  /** Forgets acquired tracking points (a new drawing starts). */
  resetTracking(): void {
    this.track = [];
  }

  // ---- lifecycle -----------------------------------------------------------------------------

  cancel(): void {
    this.pen = [];
    this.penDragging = false;
    this.points = [];
    this.picked = [];
    this.typed = '';
    this.sweep = 0;
    this.base = null;
    this.pressAt = null;
    this.host.clearPreview();
    this.render(null, null);
  }

  /** Called when the tool changes: drop the step and the acquired points. */
  reset(): void {
    this.cancel();
    this.track = [];
    this.cursor = null;
    const tool = this.tool;
    this.selecting = this.isTransform(tool) && this.selection().length === 0;
    this.publishPrompt();
  }

  /** Continues from the selection step to the first point (Enter / Done / right-click). */
  doneSelecting(): boolean {
    if (!this.selecting) return false;
    if (this.selection().length === 0) {
      this.host.toast('Select at least one object first');
      return true;
    }
    this.selecting = false;
    this.hoverer?.(null);
    this.refresh(this.cursor, null);
    return true;
  }

  /** The banner above the board: what the tool needs next. */
  private publishPrompt(): void {
    const tool = this.tool;
    const store = this.host.store;
    const ui = store.getState().ui;
    let prompt: NonNullable<typeof ui.toolPrompt> | null = null;
    if (this.handles(tool)) {
      const pickTool = tool === 'modify:offset' || tool === 'modify:trim' || tool === 'modify:extend' || tool === 'modify:split' || tool === 'modify:fillet' || tool === 'modify:match';
      if (this.selecting) prompt = { phase: 'select', text: this.instruction(), count: this.selection().length };
      else prompt = { phase: pickTool ? 'pick' : 'point', text: this.instruction() };
    }
    const current = ui.toolPrompt;
    if (current?.text === prompt?.text && current?.phase === prompt?.phase && current?.count === prompt?.count) return;
    store.setState({ ui: { ...ui, toolPrompt: prompt } });
  }

  private finishStep(): void {
    this.points = [];
    this.picked = [];
    this.typed = '';
    this.sweep = 0;
    this.base = null;
    this.host.clearPreview();
  }

  // ---- pointer -------------------------------------------------------------------------------

  down(world: Vec2, info: PointerInfo): void {
    const tool = this.tool;
    if (tool.startsWith('modify:')) {
      this.modifyDown(world, info);
      return;
    }
    if (tool === 'draw:pen') {
      this.penDown(world, info);
      return;
    }
    const anchor = this.points.at(-1) ?? null;
    const point = this.snap(world, info, anchor).point;
    if (tool === 'rect' && this.points.length === 0) this.pressAt = point;
    this.addPoint(point);
    this.refresh(point, info);
  }

  up(world: Vec2, info: PointerInfo): void {
    if (this.tool === 'draw:pen') {
      this.penDragging = false;
      this.refresh(this.cursor, info);
      return;
    }
    // A rectangle dragged out (press here, release there) completes on release.
    if (this.tool !== 'rect' || !this.pressAt || this.points.length !== 1) return;
    const end = this.snap(world, info, this.pressAt).point;
    if (distance(end, this.pressAt) / info.pixel > 6) this.addPoint(end);
    this.pressAt = null;
  }

  move(world: Vec2, info: PointerInfo): void {
    const tool = this.tool;
    if (tool === 'draw:pen' && this.penDragging && info.pressed) {
      // Dragging out the handles of the node just placed: the out handle follows the pointer,
      // the in handle mirrors it (Alt breaks the symmetry and keeps the in handle).
      const node = this.pen.at(-1)!;
      node.out = world;
      if (!info.alt || !node.in) node.in = { x: 2 * node.p.x - world.x, y: 2 * node.p.y - world.y };
      this.cursor = world;
      this.lastSnap = null;
      this.refresh(world, info);
      return;
    }
    // Selecting, or picking a curve: highlight what the click would take.
    const picking = tool === 'modify:offset' || tool === 'modify:trim' || tool === 'modify:extend' || tool === 'modify:split' || tool === 'modify:fillet' || tool === 'modify:match';
    if (this.selecting || picking) {
      const hit = this.selecting || tool === 'modify:match' ? this.host.pick(world) : this.host.pickLeaf(world);
      this.hoverer?.(hit?.id ?? null);
      if (this.selecting) {
        this.cursor = world;
        this.lastSnap = null;
        this.refresh(world, info);
        return;
      }
    }
    const anchor = this.anchorFor(tool);
    const exclude = tool.startsWith('modify:') && this.isTransform(tool) ? new Set(this.selection()) : undefined;
    const result = this.snap(world, info, anchor, exclude);
    this.cursor = result.point;
    this.lastSnap = result;
    if (tool === 'draw:arc' && this.state.ui.drafting.arcMode === 'center' && this.points.length === 2) {
      const [center] = this.points as [Vec2];
      const angle = Math.atan2(result.point.y - center.y, result.point.x - center.x);
      let delta = angle - this.lastAngle;
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      this.sweep = Math.max(-Math.PI * 2 + 1e-3, Math.min(Math.PI * 2 - 1e-3, this.sweep + delta));
      this.lastAngle = angle;
    }
    this.refresh(result.point, info);
  }

  private anchorFor(tool: ToolId): Vec2 | null {
    if (tool === 'draw:pen') return this.pen.at(-1)?.p ?? null;
    if (tool === 'draw:circle' || tool === 'draw:polygon' || tool === 'draw:ellipse' || tool === 'draw:arc' || tool === 'rect') return this.points.at(-1) ?? null;
    return this.points.at(-1) ?? null;
  }

  // ---- keyboard ------------------------------------------------------------------------------

  /** Handles a key while a drafting tool is active. Returns true when consumed. */
  key(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): boolean {
    if (event.ctrlKey || event.metaKey) return false;
    if (event.key === 'Escape') {
      if (this.typed) {
        this.typed = '';
        this.refresh(this.cursor, null);
        return true;
      }
      if (this.active) {
        this.cancel();
        return true;
      }
      return false;
    }
    if (event.key === 'Backspace' && !this.typed && this.pen.length) {
      this.pen.pop();
      this.refresh(this.cursor, null);
      return true;
    }
    if (event.key === 'Backspace' && this.typed) {
      this.typed = this.typed.slice(0, -1);
      this.refresh(this.cursor, null);
      return true;
    }
    if (event.key === 'Enter') {
      if (this.typed) {
        this.applyTyped();
        return true;
      }
      return this.enter();
    }
    if (isTypedCharacter(event.key, this.typed)) {
      this.typed += event.key;
      this.refresh(this.cursor, null);
      return true;
    }
    return false;
  }

  /** Pen: finishes the path drawn so far (Enter, double-click). */
  finishPen(close = false): boolean {
    if (this.tool !== 'draw:pen' || this.pen.length === 0) return false;
    // A double-click leaves a duplicate last node.
    const nodes = this.pen.filter((node, i, all) => i === 0 || distance(node.p, all[i - 1]!.p) > 1e-6 || node.out);
    this.pen = [];
    this.penDragging = false;
    if (nodes.length >= 2) {
      const segs = penSegments(nodes, close);
      const path = { start: toTuple(nodes[0]!.p), segments: segs };
      this.host.dispatch('create-line', { points: sampleCurvePath(path, 32), path, closed: close });
    }
    this.refresh(this.cursor, null);
    return true;
  }

  private penDown(world: Vec2, info: PointerInfo): void {
    const last = this.pen.at(-1);
    const point = this.snap(world, info, last?.p ?? null).point;
    // Clicking the first node again closes the path.
    if (this.pen.length >= 2 && distance(point, this.pen[0]!.p) <= 10 * info.pixel) {
      this.finishPen(true);
      return;
    }
    this.pen.push({ p: point });
    this.penDragging = true;
    this.refresh(point, info);
  }

  /** Enter without a typed value: finish what can be finished (copy / extend / match stop). */
  private enter(): boolean {
    if (this.tool === 'draw:pen' && this.pen.length) return this.finishPen(false);
    if (this.selecting) return this.doneSelecting();
    if (this.active) {
      this.cancel();
      return true;
    }
    return false;
  }

  private applyTyped(): void {
    const text = this.typed;
    this.typed = '';
    const unit = this.state.doc.workspace.unit;
    const tool = this.tool;
    const drafting = this.state.ui.drafting;
    const cursor = this.cursor ?? this.points.at(-1) ?? { x: 0, y: 0 };
    const value = parseTyped(text, unit);
    const number = parseNumber(text);
    // Tools where a bare number is an angle, a factor, a count or a size rather than a length.
    if (tool === 'modify:rotate' && this.points.length >= 1 && number !== null) {
      const pivot = this.points[0]!;
      const reference = this.points[1] ?? { x: pivot.x + 1, y: pivot.y };
      const refAngle = Math.atan2(reference.y - pivot.y, reference.x - pivot.x);
      // Typed angles turn counter-clockwise on screen (board rotation is clockwise-positive).
      const target = { x: pivot.x + Math.cos(refAngle - (number * Math.PI) / 180), y: pivot.y + Math.sin(refAngle - (number * Math.PI) / 180) };
      this.commitModify([pivot, reference, target]);
      return;
    }
    if (tool === 'modify:scale' && this.points.length >= 1 && number !== null && number > 0) {
      const basePoint = this.points[0]!;
      const reference = this.points[1] ?? { x: basePoint.x + 1, y: basePoint.y };
      this.commitModify([basePoint, reference, { x: basePoint.x + (reference.x - basePoint.x) * number, y: basePoint.y + (reference.y - basePoint.y) * number }]);
      return;
    }
    if (tool === 'modify:offset' && value?.kind === 'length') {
      this.host.dispatch('set-drafting', { offset: Math.abs(value.length) });
      this.refresh(this.cursor, null);
      return;
    }
    if (tool === 'modify:fillet' && value?.kind === 'length') {
      this.host.dispatch('set-drafting', { filletSize: Math.abs(value.length) });
      this.refresh(this.cursor, null);
      return;
    }
    if (tool === 'modify:array' && drafting.arrayKind === 'polar' && number !== null && this.points.length === 0) {
      this.host.dispatch('set-drafting', { arrayCount: Math.max(2, Math.round(number)) });
      this.refresh(this.cursor, null);
      return;
    }
    if (tool === 'draw:polygon' && this.points.length === 0 && number !== null) {
      this.host.dispatch('set-drafting', { polygonSides: Math.max(3, Math.min(64, Math.round(number))) });
      this.refresh(this.cursor, null);
      return;
    }
    if (tool === 'draw:arc' && drafting.arcMode === 'center' && this.points.length === 2 && number !== null) {
      this.sweep = (number * Math.PI) / 180 * -1;
      this.commitArcCentre();
      return;
    }
    if ((tool === 'draw:circle' && drafting.circleMode === 'center') || tool === 'draw:polygon') {
      if (this.points.length === 1 && value?.kind === 'length') {
        const center = this.points[0]!;
        const direction = this.cursor && distance(this.cursor, center) > 1e-6 ? this.cursor : { x: center.x + 1, y: center.y };
        this.addPoint(typedPoint(value, center, direction)!);
        return;
      }
    }
    if (tool === 'draw:ellipse' && this.points.length === 2 && value?.kind === 'length') {
      this.commitEllipse(Math.abs(value.length));
      return;
    }
    if (!value) {
      this.host.toast(`Could not read “${text}”`);
      this.refresh(this.cursor, null);
      return;
    }
    if (tool === 'draw:pen' && this.pen.length) {
      const point = typedPoint(value, this.pen.at(-1)!.p, cursor);
      if (point) this.pen.push({ p: point });
      this.refresh(this.cursor, null);
      return;
    }
    const from = this.points.at(-1);
    if (!from) {
      if (value.kind === 'absolute') {
        if (tool.startsWith('modify:')) this.modifyDown({ x: value.x, y: value.y }, { alt: true, shift: false, pixel: 1 });
        else this.addPoint({ x: value.x, y: value.y });
      }
      return;
    }
    if (tool === 'rect' && value.kind === 'length') {
      // A single number is a square.
      const size = Math.abs(value.length);
      this.addPoint({ x: from.x + size * Math.sign(cursor.x - from.x || 1), y: from.y + size * Math.sign(cursor.y - from.y || 1) });
      return;
    }
    const point = typedPoint(value, from, cursor);
    if (!point) return;
    if (tool.startsWith('modify:')) this.modifyDown(point, { alt: true, shift: false, pixel: 1 });
    else this.addPoint(point);
  }

  // ---- drawing -------------------------------------------------------------------------------

  private addPoint(point: Vec2): void {
    const tool = this.tool;
    const drafting = this.state.ui.drafting;
    this.points.push(point);
    const n = this.points.length;
    if (tool === 'rect' && n === 2) {
      const [a, b] = this.points as [Vec2, Vec2];
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const width = Math.abs(b.x - a.x);
      const height = Math.abs(b.y - a.y);
      this.finishStep();
      if (width >= 1 && height >= 1) this.host.dispatch('create-rect', { x, y, width, height, radius: Math.min(drafting.rectRadius, width / 2, height / 2) });
    } else if (tool === 'draw:circle') {
      const needed = drafting.circleMode === '3p' ? 3 : 2;
      if (n === needed) {
        const circle = drafting.circleMode === 'center' ? { center: this.points[0]!, radius: distance(this.points[0]!, this.points[1]!) } : drafting.circleMode === '2p' ? circleFrom2(this.points[0]!, this.points[1]!) : circleFrom3(this.points[0]!, this.points[1]!, this.points[2]!);
        this.finishStep();
        if (circle && circle.radius > 0.5) this.createPath(circlePath(circle.center, circle.radius), true);
      }
    } else if (tool === 'draw:arc') {
      if (drafting.arcMode === 'three-point' && n === 3) {
        const [start, through, end] = this.points as [Vec2, Vec2, Vec2];
        const path = arcThrough(start, through, end);
        this.finishStep();
        if (path) this.createPath(path, false);
        else this.host.toast('The three points are in a line');
      } else if (drafting.arcMode === 'center') {
        if (n === 2) {
          const [center, start] = this.points as [Vec2, Vec2];
          this.lastAngle = Math.atan2(start.y - center.y, start.x - center.x);
          this.sweep = 0;
        } else if (n === 3) this.commitArcCentre();
      } else if (drafting.arcMode === 'tangent' && n === 2) {
        const [start, end] = this.points as [Vec2, Vec2];
        const direction = this.tangentAt(start);
        this.finishStep();
        const path = direction ? arcTangent(start, direction, end) : null;
        if (path) this.createPath(path, false);
        else this.host.toast('Start a tangent arc on the end of a line');
      }
    } else if (tool === 'draw:polygon' && n === 2) {
      const [center, corner] = this.points as [Vec2, Vec2];
      const points = polygonPoints(center, corner, drafting.polygonSides, drafting.polygonCircumscribed);
      this.finishStep();
      if (distance(center, corner) > 0.5) this.host.dispatch('create-line', { points: points.map(toTuple), closed: true });
    } else if (tool === 'draw:ellipse' && n === 3) {
      const [center, axis, other] = this.points as [Vec2, Vec2, Vec2];
      this.points = [center, axis];
      this.commitEllipse(distanceFromAxis(center, axis, other));
    }
    this.refresh(this.cursor ?? point, null);
  }

  private commitArcCentre(): void {
    const [center, start] = this.points as [Vec2, Vec2];
    const sweep = this.sweep;
    this.finishStep();
    if (Math.abs(sweep) > 1e-3) this.createPath(arcCentre(center, start, sweep), false);
  }

  private commitEllipse(other: number): void {
    const [center, axis] = this.points as [Vec2, Vec2];
    this.finishStep();
    if (other > 0.5 && distance(center, axis) > 0.5) this.createPath(ellipsePath(center, axis, other), true);
  }

  private createPath(path: ReturnType<typeof circlePath>, closed: boolean): void {
    this.host.dispatch('create-line', { points: sampleCurvePath(path, 32), path, closed });
  }

  /** The direction a line leaves an endpoint at `point` (for tangent arcs), if one ends there. */
  private tangentAt(point: Vec2): Vec2 | null {
    const geometry = draftGeometry(this.state.doc.elements as ElementTable);
    for (const segment of geometry.segments) {
      if (distance(segment.b, point) < 1e-3) return { x: segment.b.x - segment.a.x, y: segment.b.y - segment.a.y };
      if (distance(segment.a, point) < 1e-3) return { x: segment.a.x - segment.b.x, y: segment.a.y - segment.b.y };
    }
    return null;
  }

  // ---- modify --------------------------------------------------------------------------------

  private isTransform(tool: ToolId): boolean {
    return tool === 'modify:move' || tool === 'modify:copy' || tool === 'modify:rotate' || tool === 'modify:mirror' || tool === 'modify:scale' || tool === 'modify:array';
  }

  private modifyDown(world: Vec2, info: PointerInfo): void {
    const tool = this.tool;
    const drafting = this.state.ui.drafting;
    if (this.isTransform(tool)) {
      // Selection step: clicks add or remove objects; Enter (or Done) continues.
      if (this.selecting || this.selection().length === 0) {
        this.selecting = true;
        const hit = this.host.pick(world);
        if (hit) this.host.dispatch('select', { ids: [hit.id], mode: 'toggle' });
        this.refresh(world, info);
        return;
      }
      // Mirror: a click on a line not being mirrored uses it as the axis at once.
      if (tool === 'modify:mirror' && this.points.length === 0 && !info.alt) {
        const leaf = this.host.pickLeaf(world);
        if (leaf && leaf.kind === 'line' && !this.selection().includes(leaf.id)) {
          const geometry = draftGeometry(this.state.doc.elements as ElementTable);
          const segment = geometry.segments.filter((s) => s.id === leaf.id).sort((p, q) => distanceToSeg(world, p) - distanceToSeg(world, q))[0];
          if (segment) {
            this.commitModify([segment.a, segment.b]);
            return;
          }
        }
      }
      const anchor = this.points.at(-1) ?? null;
      const point = info.alt && info.pixel === 1 ? world : this.snap(world, info, anchor, new Set(this.selection())).point;
      if (this.points.length === 0) this.base = this.state.doc;
      this.points.push(point);
      const needed = tool === 'modify:rotate' || tool === 'modify:scale' ? 3 : tool === 'modify:array' && drafting.arrayKind === 'polar' ? 1 : 2;
      if (this.points.length >= needed) this.commitModify(this.points);
      else this.refresh(point, info);
      return;
    }
    const leaf = this.host.pickLeaf(world);
    switch (tool) {
      case 'modify:offset': {
        if (!leaf) return;
        this.host.clearPreview();
        const result = this.host.dispatch('offset-element', { id: leaf.id, distance: Math.max(1, drafting.offset), toward: world });
        if (!result.ok && result.error) this.host.toast(result.error.message);
        return;
      }
      case 'modify:split': {
        if (!leaf) return;
        this.host.dispatch('split-line', { id: leaf.id, at: this.snap(world, info).point });
        return;
      }
      case 'modify:trim': {
        if (!leaf) return;
        if (drafting.trimMode === 'segment') {
          this.host.dispatch('trim-line', { id: leaf.id, at: world });
          return;
        }
        const first = this.picked[0];
        if (!first) {
          this.picked = [{ id: leaf.id, at: world }];
          this.host.dispatch('select', { ids: [leaf.id] });
          this.refresh(world, info);
          return;
        }
        this.picked = [];
        if (first.id !== leaf.id) this.host.dispatch('corner-lines', { a: first.id, atA: first.at, b: leaf.id, atB: world });
        this.refresh(world, info);
        return;
      }
      case 'modify:extend': {
        if (!leaf) return;
        const boundary = this.picked[0];
        if (!boundary) {
          this.picked = [{ id: leaf.id, at: world }];
          this.host.dispatch('select', { ids: [leaf.id] });
        } else if (boundary.id !== leaf.id) this.host.dispatch('extend-line', { id: leaf.id, at: world, boundaryId: boundary.id });
        this.refresh(world, info);
        return;
      }
      case 'modify:fillet': {
        if (!leaf || leaf.kind !== 'line') return;
        const at = this.snap(world, info).point;
        // A line ending here with another line starting there: join them round the corner.
        const geometry = draftGeometry(this.state.doc.elements as ElementTable);
        const ends = geometry.points.filter((p) => p.kind === 'endpoint' && distance(p.p, at) < 10 * info.pixel);
        const other = ends.find((p) => p.id !== leaf.id && this.state.doc.elements[p.id]?.kind === 'line');
        const corner = ends.find((p) => p.id === leaf.id)?.p ?? at;
        const input = { id: leaf.id, at: corner, size: Math.max(1, drafting.filletSize), mode: drafting.filletMode, ...(other ? { otherId: other.id } : {}) };
        const result = this.host.dispatch('fillet-lines', input);
        if (!result.ok && result.error) this.host.toast(result.error.message);
        return;
      }
      case 'modify:match': {
        const hit = this.host.pick(world);
        if (!hit) return;
        const source = this.picked[0];
        if (!source) {
          this.picked = [{ id: hit.id, at: world }];
          this.host.dispatch('select', { ids: [hit.id] });
        } else if (source.id !== hit.id) this.host.dispatch('match-properties', { sourceId: source.id, ids: [hit.id] });
        this.refresh(world, info);
        return;
      }
    }
  }

  /** The command a transform step describes with its picked points. */
  private transformCommand(points: readonly Vec2[]): { id: string; input: unknown } | null {
    const tool = this.tool;
    const drafting = this.state.ui.drafting;
    const ids = this.selection();
    const [a, b, c] = points as [Vec2, Vec2 | undefined, Vec2 | undefined];
    switch (tool) {
      case 'modify:move':
        return b ? { id: 'move-selection', input: { ids, dx: b.x - a.x, dy: b.y - a.y } } : null;
      case 'modify:copy':
        return b ? { id: 'copy-by-offset', input: { ids, dx: b.x - a.x, dy: b.y - a.y, count: drafting.copies } } : null;
      case 'modify:mirror':
        return b && distance(a, b) > 1e-6 ? { id: 'mirror-selection', input: { ids, a, b, keepOriginal: drafting.mirrorKeepOriginal } } : null;
      case 'modify:rotate': {
        if (!b || !c) return null;
        let degrees = ((Math.atan2(c.y - a.y, c.x - a.x) - Math.atan2(b.y - a.y, b.x - a.x)) * 180) / Math.PI;
        if (degrees > 180) degrees -= 360;
        if (degrees < -180) degrees += 360;
        return { id: drafting.keepOriginal ? 'rotate-copy-selection' : 'rotate-selection', input: { ids, degrees, pivot: a } };
      }
      case 'modify:scale': {
        if (!b || !c) return null;
        const reference = distance(a, b);
        const factor = reference > 1e-9 ? distance(a, c) / reference : 1;
        return factor > 1e-6 ? { id: 'scale-selection', input: { ids, base: a, factor } } : null;
      }
      case 'modify:array':
        if (drafting.arrayKind === 'polar') return { id: 'create-array', input: { ids, spec: { kind: 'polar', count: drafting.arrayCount, cx: a.x, cy: a.y, angle: drafting.arrayAngle } } };
        return b ? { id: 'create-array', input: { ids, spec: { kind: 'linear', count: drafting.arrayCount, dx: b.x - a.x, dy: b.y - a.y } } } : null;
    }
    return null;
  }

  private commitModify(points: readonly Vec2[]): void {
    const command = this.transformCommand(points);
    const tool = this.tool;
    this.host.clearPreview();
    // Copy repeats from the same base point (Revit's Multiple); everything else ends the step.
    const keepBase = tool === 'modify:copy' && points.length >= 2 ? points[0]! : null;
    this.finishStep();
    if (command) {
      const result = this.host.dispatch(command.id, command.input);
      if (!result.ok && result.error) this.host.toast(result.error.message);
      // Copies are selected after a copy: the next placement copies the originals again.
      if (keepBase && result.ok) {
        this.host.dispatch('select', { ids: (command.input as { ids: string[] }).ids });
        this.points = [keepBase];
        this.base = this.state.doc;
      }
    }
    this.refresh(this.cursor, null);
  }

  // ---- overlay -------------------------------------------------------------------------------

  private refresh(cursor: Vec2 | null, info: PointerInfo | null): void {
    void info;
    const tool = this.tool;
    const at = cursor ?? this.points.at(-1) ?? null;
    const paths: DraftingOverlay['paths'] = [];
    let measure: string | null = null;
    const drafting = this.state.ui.drafting;
    const n = this.points.length;
    let last = this.points.at(-1) ?? null;
    let picks = [...this.points];
    if (tool === 'draw:pen' && this.pen.length) {
      const nodes = this.penDragging ? this.pen : [...this.pen, { p: at ?? this.pen.at(-1)!.p }];
      if (nodes.length >= 2) {
        const segs = penSegments(nodes, false);
        paths.push({ points: sampleCurvePath({ start: toTuple(nodes[0]!.p), segments: segs }, 24).map(([x, y]) => ({ x, y })), closed: false });
      }
      // Handles of the nodes, drawn as tie lines with their ends as picks.
      for (const node of this.pen) {
        if (node.in) paths.push({ points: [node.in, node.p], closed: false });
        if (node.out) paths.push({ points: [node.p, node.out], closed: false });
      }
      picks = this.pen.flatMap((node) => [node.p, ...(node.in ? [node.in] : []), ...(node.out ? [node.out] : [])]);
      last = this.pen.at(-1)!.p;
      if (at && !this.penDragging) measure = `${this.len(distance(last, at))} · ${fmt(screenAngle(last, at))}°`;
    }
    if (at && n > 0) {
      if (tool === 'rect' && n === 1) {
        const a = this.points[0]!;
        paths.push({ points: [a, { x: at.x, y: a.y }, at, { x: a.x, y: at.y }], closed: true });
        measure = `${this.len(Math.abs(at.x - a.x))} × ${this.len(Math.abs(at.y - a.y))}`;
      } else if (tool === 'draw:circle') {
        const circle = drafting.circleMode === 'center' ? { center: this.points[0]!, radius: distance(this.points[0]!, at) } : drafting.circleMode === '2p' || n === 1 ? circleFrom2(this.points[0]!, at) : circleFrom3(this.points[0]!, this.points[1]!, at);
        if (circle) {
          paths.push({ points: sampleCurvePath(circlePath(circle.center, circle.radius), 32).map(([x, y]) => ({ x, y })), closed: true });
          measure = `R ${this.len(circle.radius)}`;
        }
      } else if (tool === 'draw:arc') {
        let path = null;
        if (drafting.arcMode === 'three-point' && n === 2) path = arcThrough(this.points[0]!, this.points[1]!, at);
        if (drafting.arcMode === 'center' && n === 2) {
          path = arcCentre(this.points[0]!, this.points[1]!, this.sweep);
          measure = `R ${this.len(distance(this.points[0]!, this.points[1]!))} · ${fmt(Math.abs((this.sweep * 180) / Math.PI))}°`;
        }
        if (drafting.arcMode === 'tangent' && n === 1) {
          const direction = this.tangentAt(this.points[0]!);
          path = direction ? arcTangent(this.points[0]!, direction, at) : null;
        }
        if (path) paths.push({ points: sampleCurvePath(path, 32).map(([x, y]) => ({ x, y })), closed: false });
      } else if (tool === 'draw:polygon' && n === 1) {
        paths.push({ points: polygonPoints(this.points[0]!, at, drafting.polygonSides, drafting.polygonCircumscribed), closed: true });
        measure = `R ${this.len(distance(this.points[0]!, at))} · ${drafting.polygonSides} sides`;
      } else if (tool === 'draw:ellipse') {
        if (n === 2) {
          const other = distanceFromAxis(this.points[0]!, this.points[1]!, at);
          paths.push({ points: sampleCurvePath(ellipsePath(this.points[0]!, this.points[1]!, Math.max(other, 0.5)), 16).map(([x, y]) => ({ x, y })), closed: true });
          measure = `${this.len(distance(this.points[0]!, this.points[1]!))} × ${this.len(other)}`;
        }
      } else if (this.isTransform(tool)) {
        const command = this.transformCommand([...this.points, at]);
        if (command && this.base) this.host.preview(command.id, command.input, this.base);
        if (last) measure = tool === 'modify:rotate' && n === 2 ? `${fmt(-(((Math.atan2(at.y - this.points[0]!.y, at.x - this.points[0]!.x) - Math.atan2(this.points[1]!.y - this.points[0]!.y, this.points[1]!.x - this.points[0]!.x)) * 180) / Math.PI))}°` : tool === 'modify:scale' && n === 2 ? `× ${fmt(distance(this.points[0]!, at) / Math.max(1e-9, distance(this.points[0]!, this.points[1]!)))}` : `${this.len(distance(last, at))} · ${fmt(screenAngle(last, at))}°`;
      }
      if (!measure && last) measure = `${this.len(distance(last, at))} · ${fmt(screenAngle(last, at))}°`;
    }
    const overlay: DraftingOverlay = {
      paths,
      rubber: last && at && tool !== 'rect' && tool !== 'draw:pen' ? { a: last, b: at } : null,
      picks,
      prompt: at ? { text: this.instruction(), typed: this.typed, measure, at } : null,
    };
    this.render(overlay, this.selecting ? null : this.snapOverlay(this.lastSnap));
    this.publishPrompt();
  }

  /** A length in the workspace's display unit and precision. */
  private len(mm: number): string {
    const { unit, precision } = this.state.doc.workspace;
    return formatLength(mm, unit, precision);
  }

  /** What the next click does, for the prompt beside the cursor. */
  instruction(): string {
    const tool = this.tool;
    const drafting = this.state.ui.drafting;
    const n = this.points.length;
    const none = this.isTransform(tool) && this.selection().length === 0;
    if (this.selecting) {
      const verb = TOOL_VERBS[tool] ?? 'modify';
      const count = this.selection().length;
      return count ? `${count} selected · click to add or remove · Enter (or Done) to ${verb} them` : `Select the objects to ${verb} · click them, Shift for more · then Enter`;
    }
    switch (tool) {
      case 'rect':
        return n === 0 ? 'First corner · or drag' : 'Opposite corner · type W×H or a size';
      case 'draw:circle':
        return drafting.circleMode === 'center' ? (n === 0 ? 'Centre' : 'Radius · type a length') : drafting.circleMode === '2p' ? (n === 0 ? 'First end of the diameter' : 'Other end') : ['First point', 'Second point', 'Third point'][n] ?? '';
      case 'draw:arc':
        if (drafting.arcMode === 'three-point') return ['Start', 'A point on the arc', 'End'][n] ?? '';
        if (drafting.arcMode === 'center') return ['Centre', 'Start (radius)', 'End · or type the angle'][n] ?? '';
        return n === 0 ? 'Start on the end of a line' : 'End of the tangent arc';
      case 'draw:polygon':
        return n === 0 ? `Centre · type the number of sides (${drafting.polygonSides})` : `${drafting.polygonCircumscribed ? 'Middle of a side' : 'A corner'} · type the radius`;
      case 'draw:pen':
        return this.pen.length === 0 ? 'Click a corner, or click and drag out a smooth curve' : this.penDragging ? 'Drag to shape the curve · Alt breaks the handles' : 'Next point: click for a corner, drag for a curve · click the first point to close · Enter / double-click to finish';
      case 'draw:ellipse':
        return ['Centre', 'End of the first axis', 'Other radius · type a length'][n] ?? '';
      case 'modify:move':
        return none ? 'Click what to move' : n === 0 ? 'Base point' : 'Target point · or type a distance';
      case 'modify:copy':
        return none ? 'Click what to copy' : n === 0 ? 'Base point' : `Place ${drafting.copies > 1 ? `${drafting.copies} copies` : 'a copy'} · Esc to stop`;
      case 'modify:rotate':
        return none ? 'Click what to rotate' : ['Centre of rotation', 'Start direction · or type an angle', 'End direction · or type an angle'][n] ?? '';
      case 'modify:mirror':
        return none ? 'Click what to mirror' : n === 0 ? 'Click a line as the axis, or its first point' : 'Second point of the axis';
      case 'modify:scale':
        return none ? 'Click what to scale' : ['Base point', 'Reference point · or type a factor', 'New position of the reference'][n] ?? '';
      case 'modify:array':
        if (none) return 'Click what to array';
        return drafting.arrayKind === 'polar' ? `Centre of the polar array (${drafting.arrayCount} items)` : n === 0 ? 'Base point' : `Position of the second item (${drafting.arrayCount} items)`;
      case 'modify:offset':
        return `Click a line, arc, circle or rectangle on the side to offset (${this.len(drafting.offset)} · type to change)`;
      case 'modify:trim':
        return drafting.trimMode === 'segment' ? 'Click the piece to delete' : this.picked.length ? 'Second line (the side to keep)' : 'First line (the side to keep)';
      case 'modify:extend':
        return this.picked.length ? 'Click lines to extend · Esc for a new boundary' : 'Click the boundary';
      case 'modify:split':
        return 'Click a line where it should split';
      case 'modify:fillet':
        return `Click near a corner (${drafting.filletMode} ${this.len(drafting.filletSize)} · type to change)`;
      case 'modify:match':
        return this.picked.length ? 'Click elements to receive the look · Esc to stop' : 'Click the source element';
      default:
        return '';
    }
  }
}

/** The line element path segments of pen nodes: a Bézier wherever a handle was dragged out. */
function penSegments(nodes: readonly PenNode[], close: boolean): PenSegments {
  const segs: PenSegments = [];
  const count = close ? nodes.length : nodes.length - 1;
  for (let i = 0; i < count; i++) {
    const a = nodes[i]!;
    const b = nodes[(i + 1) % nodes.length]!;
    if (a.out || b.in) segs.push({ kind: 'bezier', control1: toTuple(a.out ?? a.p), control2: toTuple(b.in ?? b.p), to: toTuple(b.p) });
    else segs.push({ kind: 'line', to: toTuple(b.p) });
  }
  return segs;
}

function distanceToSeg(p: Vec2, s: { a: Vec2; b: Vec2 }): number {
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / len2));
  return Math.hypot(p.x - (s.a.x + dx * t), p.y - (s.a.y + dy * t));
}

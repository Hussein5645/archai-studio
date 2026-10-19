/**
 * Pointer/keyboard state machine for the workboard. Gestures never edit the document directly:
 * drags preview a command against a captured base document (into `state.preview`, which only the
 * board draws) and commit that command once on release, so every gesture is exactly one undo
 * step and the same code path an agent would use.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { PROFILE_SKETCH_STYLE } from '@/commands/profileMode';
import { profileKindOf } from '@/commands/builtin/profileEdit';
import { useApp } from '@/app/context';
import { LIBRARY_DRAG_TYPE, MATERIAL_DRAG_TYPE, materialUi } from '@/materials/uiStore';
import { droppedMaterial } from '@/materials/library';
import { archOf, resizeRuleFor } from '@/assets/arch-meta';
import { facadeElement, getArchTool, type ArchTemplate } from '@/assets/arch-tools';
import {
  columnRect,
  doorMountOffset,
  doorTemplate,
  flightEnd,
  runAfterLanding,
  stairPreviewTable,
  stairRiserCount,
  stairTreadsPlaced,
  windowMountOffset,
  windowTemplate,
  type StairFlight,
} from '@/assets/system-geometry';
import { parseSystemParameters, type SystemAssetType } from '@/catalog';
import { CatalogAssetInput, isEditableTarget } from '@/commands';
import { descendantsOf, isEffectivelyLocked, type ArchaiDocument, type Element, type Style } from '@/document';
import {
  angleOf,
  applyToPoint,
  boundsOfIds,
  distance,
  elementsInArea,
  formatLength,
  worldBounds,
  findEnclosure,
  hitTest,
  invert,
  localBounds,
  rectFromPoints,
  rotate,
  screenToWorld,
  sub,
  worldMatrix,
  zoomAt,
  type Rect,
  type Vec2,
} from '@/geometry';
import { selectableTarget } from '@/selection';
import { editableGroup, selectionScope } from '@/selection/groupScope';
import { cycleCandidates, type CycleCandidate } from '@/selection/cycle';
import type { AppStore, ToolId, Viewport } from '@/store';
import { computeSelectionFrame, hitHandle, type CursorKind, type Handle, type SelectionFrame } from './handles';
import { gridStepForZoom, snapMoveDelta, snapPoint, snapValue } from './snap';
import { DraftingController, type DraftingOverlay, type PointerInfo } from './drafting';
import { draftGeometry } from '@/drafting/geometry';
import { isTypedCharacter, parseTyped, typedPoint } from '@/drafting/input';
import type { OsnapResult } from '@/drafting/osnap';
import { snapToBoundary, type BoundarySnapKind } from './wallFaceSnap';
import { findWallSnap } from './wallSnap';
import { effectiveModifiers, isOn, PalmRejection, touchModifiers } from './touchModifiers';
import { fadeOnBoard, inkCandidates, inkUnder, penPressure, type InkCandidate } from './annotate';
import { stickyOf, thinStroke } from '@/annotations/model';
import { preferences } from '@/ui/preferences';
import { RIG_HANDLE_RADIUS, RIG_HANDLE_RADIUS_TOUCH, rigHandleAt } from '@/layers/viewRig';
import { paperScaleOf, sheetViewOf } from '@/sheets/model';
import { paperLines, smartGuides } from '@/sheets/guides';
import { pickInFrame } from '@/sheets/pick';
import { bytesToBase64 } from '@/persistence/base64';
import { MODEL_EXTENSION, modelToast } from '@/view3d/modelFiles';

export const DRAG_THRESHOLD_PX = 3;
/** A finger wobbles more than a mouse: movement below this is still a tap. */
const TOUCH_TAP_SLOP_PX = 10;
/** A pen tip skids a little on glass when it taps: less than a finger, more than a mouse. */
const PEN_TAP_SLOP_PX = 6;

/** Tools that draw by dragging a rectangle; every other drawing tool places by tapping. */
const RECT_DRAG_TOOLS: ReadonlySet<string> = new Set(['rect', 'view3d', 'paper', 'ai-portal', 'arch:level', 'parametric', 'diagram:zone', 'analysis-location', 'analysis-sun', 'analysis-wind', 'analysis-noise', 'noise-area-emitter']);

/** Diagram tools drawn click by click (see src/diagrams); the rest finish after two points. */
const DIAGRAM_LINE_TOOLS: ReadonlySet<string> = new Set(['diagram:arrow', 'diagram:connector', 'diagram:callout', 'diagram:dimension', 'diagram:adjacency']);
const TWO_POINT_TOOLS: ReadonlySet<string> = new Set(['measure', 'section', 'camera', 'diagram:connector', 'diagram:callout', 'diagram:adjacency']);

/** Tools where a touch aims first (live preview and snaps follow the finger) and places on lift. */
function placesOnLift(tool: ToolId): boolean {
  return tool !== 'select' && tool !== 'hand' && !RECT_DRAG_TOOLS.has(tool) && !FREEHAND_TOOLS.has(tool);
}

/** Annotation tools that follow the pointer while it is down (a finger draws with them too). */
const FREEHAND_TOOLS: ReadonlySet<string> = new Set(['annotate:pen', 'annotate:highlighter', 'annotate:eraser']);
const DEFAULT_RECT_SIZE = 1000;
const MIN_SIZE = 10;

export type Draft =
  | { kind: 'rect'; rect: Rect; radius?: number }
  | { kind: 'polyline'; points: Vec2[]; cursor: Vec2 | null; style: Style }
  | { kind: 'enclosure'; points: Vec2[] }
  | { kind: 'placement'; x: number; y: number; width: number; height: number; rotation: number; template?: ArchTemplate; imageUrl?: string }
  /** Stair being drawn: committed flights plus the pending run and concise canvas guidance. */
  | { kind: 'stair'; table: Record<string, Element>; status: string; hint: string; origin: Vec2; anchor: Vec2 }
  /** A pen / highlighter stroke being drawn (world points, pressure per point when the pen reports it). */
  | { kind: 'ink'; points: Vec2[]; pressure: number[]; width: number; color: string; highlighter: boolean };

export interface SnapLabel {
  point: Vec2;
  text: string;
  /** Snap kind (marker shape): endpoint, midpoint, intersection, … */
  kind?: string;
  /** Alignment / extension / polar lines that explain the snap (world). */
  guides?: { a: Vec2; b: Vec2 }[];
}

export interface OverlayState {
  /** Screen-space marquee. */
  marquee: Rect | null;
  /** World-space drawing preview. */
  draft: Draft | null;
  /** What the cursor snapped to while drawing walls/railings (world point + caption). */
  snap: SnapLabel | null;
  hoverId: string | null;
  cursor: CursorKind;
  panning: boolean;
  dragging: boolean;
  /** A multi-step drawing in progress (walls/lines/polylines, stairs): touch shows Done/Undo. */
  drawing: 'polyline' | 'stair' | null;
  /** Drafting / modify tool previews and the prompt beside the cursor (see ./drafting.ts). */
  drafting: DraftingOverlay | null;
  /** The marquee selects only what it fully contains (dragged left to right). */
  marqueeWindow?: boolean;
  /** Tab selection cycling: the highlighted candidate and its caption at the cursor (screen). */
  cycle?: { ids: string[]; label: string; at: Vec2 } | null;
}

/**
 * The size of a new section / camera view: a fixed share of the visible board, so the linked view
 * reads clearly at whatever zoom it is made (a fixed 6 m portal is a speck zoomed out on a site
 * and fills the screen zoomed in on a detail). `gap` keeps it clear of the cut line.
 */
function linkedViewSize(ui: { viewport: Viewport; canvasSize: { width: number; height: number } }, aspect: number): { width: number; height: number; gap: number } {
  const zoom = ui.viewport.zoom;
  const width = Math.max(ui.canvasSize.width * 0.38, Math.min(ui.canvasSize.height * 0.5 * aspect, 520)) / zoom;
  return { width, height: width / aspect, gap: 28 / zoom };
}

function inkDraft(s: { points: Vec2[]; pressure: number[]; width: number; color: string; highlighter: boolean }): Draft {
  return { kind: 'ink', points: [...s.points], pressure: [...s.pressure], width: s.width, color: s.color, highlighter: s.highlighter };
}

const IDLE_OVERLAY: OverlayState = { marquee: null, draft: null, snap: null, hoverId: null, cursor: null, panning: false, dragging: false, drawing: null, drafting: null };

const SNAP_CAPTIONS: Record<BoundarySnapKind, string> = { endpoint: 'end', centre: 'centre', inside: 'inside', outside: 'outside' };

type Session =
  /** `tapClears`: a finger that went down on empty space and did not move deselects, like a click. */
  | { type: 'pan'; startScreen: Vec2; startViewport: Viewport; tapClears?: boolean }
  | { type: 'pending'; startScreen: Vec2; startWorld: Vec2; ids: string[]; clickedId: string; reselectOnClick: boolean }
  /** `grab`: the key point of the moved geometry under the cursor, snapped onto other geometry; `exclude`: the moved elements and their contents. */
  | { type: 'move'; startWorld: Vec2; base: ArchaiDocument; ids: string[]; bounds: Rect; grab?: Vec2; exclude?: Set<string> }
  | { type: 'marquee'; startWorld: Vec2; additive: boolean; baseSelection: string[] }
  | { type: 'resize'; base: ArchaiDocument; ids: string[]; handle: Handle; frame: SelectionFrame; startWorld: Vec2 }
  | { type: 'rotate'; base: ArchaiDocument; ids: string[]; pivot: Vec2; startAngle: number }
  | { type: 'draw-rect'; startWorld: Vec2 }
  /** Dragging one end of a wall or railing. */
  | { type: 'endpoint'; base: ArchaiDocument; id: string; endpoint: 'start' | 'end' | `point:${number}` }
  | { type: 'curve-handle'; base: ArchaiDocument; id: string; segment: number; handle: 'control' | 'control1' | 'control2' | 'center' }
  /** A grip of a plain line: a vertex, a segment middle or an arc's radius (see handles.ts). */
  | { type: 'grip'; base: ArchaiDocument; id: string; grip: string; startWorld: Vec2; origin: Vec2 }
  /** Dragging a window jamb along its wall. */
  | { type: 'window-resize'; base: ArchaiDocument; id: string; jamb: 'start' | 'end'; startWorld: Vec2; startWidth: number }
  /** A freehand annotation stroke (pen or highlighter). */
  | { type: 'ink'; points: Vec2[]; pressure: number[]; width: number; color: string; highlighter: boolean }
  /** The annotation eraser (or a pen's eraser end): strokes it passes over go on release. */
  | { type: 'erase'; ids: Set<string>; candidates: InkCandidate[]; radius: number; last: Vec2 };

interface Polyline {
  toolId: ToolId;
  points: Vec2[];
  style: Style;
  /** Element hit by the first measurement point; the completed measure rides with it. */
  parentId?: string;
}

/** Step-by-step stair drawing state. */
interface StairDraft {
  parameters: ReturnType<typeof parseSystemParameters<'stair'>>;
  flights: StairFlight[];
  past: StairSnapshot[];
  future: StairSnapshot[];
  selectionBefore: string[];
  /** Fixed first point, retained for the start marker throughout the gesture. */
  origin: Vec2;
  /** Start of the run being drawn (the click point or the end of the last flight). */
  start: Vec2;
  /** Direction the pending run points in, once the cursor has moved. */
  angle: number;
  treads: number;
  /** Flights as last previewed (committed ones plus the pending run), for committing a turn. */
  preview?: StairFlight[];
}

interface StairSnapshot {
  flights: StairFlight[];
  start: Vec2;
  angle: number;
}

function stairSnapshot(draft: StairDraft): StairSnapshot {
  return { flights: draft.flights.map((flight) => ({ ...flight })), start: { ...draft.start }, angle: draft.angle };
}

function restoreStairSnapshot(draft: StairDraft, snapshot: StairSnapshot): void {
  draft.flights = snapshot.flights.map((flight) => ({ ...flight }));
  draft.start = { ...snapshot.start };
  draft.angle = snapshot.angle;
  draft.treads = 0;
  draft.preview = undefined;
}

function setViewportDirect(store: AppStore, viewport: Viewport): void {
  const state = store.getState();
  store.setState({ ui: { ...state.ui, viewport } });
}

function isPolylineTool(tool: ToolId): boolean {
  if (tool === 'line' || tool === 'measure' || tool === 'section' || tool === 'camera' || tool === 'arch:floor' || tool === 'arch:ceiling') return true;
  if (DIAGRAM_LINE_TOOLS.has(tool)) return true;
  if (tool.startsWith('arch:')) return getArchTool(tool.slice(5))?.mode.kind === 'polyline';
  return false;
}

/** Line tools whose cursor snaps to wall ends and faces. */
function snapsToBoundaries(tool: ToolId): boolean {
  return tool === 'arch:wall' || tool === 'arch:room-divider' || tool === 'arch:railing' || tool === 'arch:curtain-wall' || tool === 'diagram:dimension';
}

function polylineStyle(tool: ToolId): Style {
  if (tool === 'measure' || tool === 'section') return { fill: null, stroke: '#2563eb', strokeWidth: 12, opacity: 1 };
  if (tool === 'arch:floor') return { fill: '#d9dde3', stroke: '#737983', strokeWidth: 12, opacity: 0.72 };
  if (tool === 'arch:ceiling') return { fill: '#eef0f4', stroke: '#8a9099', strokeWidth: 12, opacity: 0.58 };
  if (tool === 'camera') return { fill: null, stroke: '#8b5cf6', strokeWidth: 16, opacity: 1 };
  if (tool.startsWith('diagram:')) return { fill: null, stroke: '#e11d48', strokeWidth: 12, opacity: 1 };
  if (tool.startsWith('arch:')) {
    const arch = getArchTool(tool.slice(5));
    if (arch && arch.mode.kind === 'polyline') return arch.mode.style;
  }
  return { fill: null, stroke: '#3a3a3f', strokeWidth: 12, opacity: 1 };
}

function wallMountInfo(element: Element | undefined): { width: number; centerY: number } | null {
  const arch = archOf(element);
  if (!arch) return null;
  if (arch['type'] !== 'door' && arch['type'] !== 'window' && arch['type'] !== 'facade-element') return null;
  if (typeof arch['width'] !== 'number' || arch['width'] <= 0 || typeof arch['wallMountOffset'] !== 'number') return null;
  return { width: arch['width'], centerY: arch['wallMountOffset'] };
}

/** Parameters the placement tools use: the chosen system type's defaults, else the built-in ones. */
function placementParametersFor<T extends SystemAssetType>(state: { ui: { systemAssets: Partial<Record<SystemAssetType, { systemParameters?: unknown }>> } }, type: T) {
  return parseSystemParameters(type, state.ui.systemAssets[type]?.systemParameters ?? {});
}

export interface InteractionHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onDoubleClick: (e: React.MouseEvent<HTMLDivElement>) => void;
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
}

export interface UseInteractionsOptions {
  onContextMenu: (position: Vec2) => void;
}

export function useInteractions(containerRef: RefObject<HTMLDivElement | null>, options: UseInteractionsOptions) {
  const { store, executor, toasts, platform } = useApp();
  const session = useRef<Session | null>(null);
  const polyline = useRef<Polyline | null>(null);
  const stair = useRef<StairDraft | null>(null);
  /** A touch aiming a tap-to-place tool; its press is replayed where the finger lifts. */
  const aimPointer = useRef<number | null>(null);
  const replayingAim = useRef(false);
  const [palm] = useState(() => new PalmRejection());
  const pressRef = useRef<((e: ReactPointerEvent<HTMLDivElement>) => void) | null>(null);
  const spaceDown = useRef(false);
  const spaceGesture = useRef<{ previousTool: 'select' | 'hand'; pressedAt: number; panned: boolean } | null>(null);
  const activePointers = useRef(new Map<number, Vec2>());
  /** Last hover position over the board (screen) and the Tab cycle there (see selection/cycle). */
  const hoverScreen = useRef<Vec2 | null>(null);
  const tabCycle = useRef<{ screen: Vec2; candidates: CycleCandidate[]; index: number } | null>(null);
  const pinchState = useRef<{
    initialDistance: number;
    initialZoom: number;
    initialMidpoint: Vec2;
    initialViewport: Viewport;
  } | null>(null);
  const longPressTimer = useRef<number | null>(null);
  /** Where the finger went down; a long press is cancelled once it moves further than a tap. */
  const longPressStart = useRef<Vec2 | null>(null);
  const [overlay, setOverlayState] = useState<OverlayState>(IDLE_OVERLAY);
  const overlayRef = useRef(overlay);

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const setOverlay = useCallback((patch: Partial<OverlayState>) => {
    const next: OverlayState = { ...overlayRef.current, ...patch, drawing: polyline.current ? 'polyline' : stair.current ? 'stair' : null };
    const keys = Object.keys(next) as (keyof OverlayState)[];
    if (keys.every((k) => Object.is(next[k], overlayRef.current[k]))) return;
    overlayRef.current = next;
    setOverlayState(next);
  }, []);

  const dispatch = useCallback(
    (commandId: string, input?: unknown) => {
      const result = executor.dispatchSync(commandId, input);
      if (!result.ok && result.error.code !== 'unavailable') toasts.push({ kind: 'error', message: result.error.message });
      return result;
    },
    [executor, toasts],
  );

  const screenPoint = useCallback(
    (e: { clientX: number; clientY: number }): Vec2 => {
      const rect = containerRef.current?.getBoundingClientRect();
      return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
    },
    [containerRef],
  );

  const toWorld = useCallback((screen: Vec2): Vec2 => screenToWorld(store.getState().ui.viewport, screen), [store]);

  const snapStep = useCallback((): number | null => {
    const { doc, ui } = store.getState();
    return doc.workspace.snap.enabled ? gridStepForZoom(doc.workspace.grid.size, ui.viewport.zoom) : null;
  }, [store]);

  const maybeSnap = useCallback(
    (p: Vec2, disabled: boolean): Vec2 => {
      const step = disabled ? null : snapStep();
      return step ? snapPoint(p, step) : p;
    },
    [snapStep],
  );

  const currentFrame = useCallback((): SelectionFrame | null => {
    const { doc, ui } = store.getState();
    return computeSelectionFrame(doc, ui.selection, ui.viewport);
  }, [store]);

  const clearPreview = useCallback(() => {
    if (store.getState().preview) store.setState({ preview: null });
  }, [store]);

  /** Drafting and modify tools (circle, arc, polygon, move, copy, mirror, array, trim, …). */
  const [drafting] = useState(() => {
    const pickAt = (world: Vec2, leaf: boolean) => {
      const state = store.getState();
      const hit = hitTest(state.doc, world, { tolerance: 8 / state.ui.viewport.zoom, scopeId: selectionScope(state.ui) });
      if (!hit) return null;
      return leaf ? hit : selectableTarget(state.doc.elements, hit, false, selectionScope(state.ui));
    };
    return new DraftingController({
      store,
      dispatch: (commandId, input) => {
        const result = executor.dispatchSync(commandId, input);
        return result.ok ? { ok: true, value: result.value } : { ok: false, error: { message: result.error.message } };
      },
      preview: (commandId, input, base) => store.setState({ preview: executor.preview(commandId, input, base) }),
      clearPreview: () => {
        if (store.getState().preview) store.setState({ preview: null });
      },
      pick: (world) => pickAt(world, false),
      pickLeaf: (world) => pickAt(world, true),
      toast: (message) => toasts.push({ kind: 'error', message }),
    });
  });
  // The controller draws into the overlay once mounted.
  useEffect(() => drafting.connect((draft, snap) => setOverlay({ drafting: draft, snap }), (hoverId) => setOverlay({ hoverId })), [drafting, setOverlay]);
  /** Pointer info for the drafting engine: modifiers and the size of a screen pixel in mm. */
  const pointerInfo = useCallback((mods: { alt: boolean; shift: boolean }): PointerInfo => ({ alt: mods.alt, shift: mods.shift, pixel: 1 / store.getState().ui.viewport.zoom }), [store]);
  /** A value typed while drawing a polyline / wall (length, length<angle, dx,dy). */
  const polyTyped = useRef('');
  const polyCursor = useRef<Vec2 | null>(null);

  const finishPolyline = useCallback(() => {
    const current = polyline.current;
    polyline.current = null;
    setOverlay({ draft: null });
    if (!current) return;
    // A double-click leaves a duplicate last point behind.
    const points = current.points.filter((p, i, all) => i === 0 || distance(p, all[i - 1]!) > 0.5);
    if (points.length >= 2) {
      const tuples = points.map((p) => [p.x, p.y] as [number, number]);
      if (current.toolId === 'line') dispatch('create-line', { points: tuples });
      else if (current.toolId === 'measure') {
        const first = points[0]!;
        const last = points.at(-1)!;
        const parent = current.parentId ? store.getState().doc.elements[current.parentId] : undefined;
        const parentInverse = parent ? invert(worldMatrix(store.getState().doc.elements, parent)) : null;
        const measurePoints = parentInverse ? points.map((point) => applyToPoint(parentInverse, point)) : points;
        dispatch('create-line', {
          points: measurePoints.map((point) => [point.x, point.y] as [number, number]),
          parentId: parent?.id ?? null,
          name: 'Measure',
          style: current.style,
          meta: { measure: { distance: distance(first, last) } },
        });
      }
      else if (current.toolId.startsWith('diagram:')) dispatch('create-diagram', { kind: current.toolId.slice('diagram:'.length), points: tuples });
      else if (current.toolId === 'section') dispatch('create-section-view', { a: tuples[0], b: tuples.at(-1), ...linkedViewSize(store.getState().ui, 6000 / 3500) });
      else if (current.toolId === 'camera') dispatch('create-camera-view', { a: tuples[0], b: tuples.at(-1), ...linkedViewSize(store.getState().ui, 6000 / 4000) });
      else if ((current.toolId === 'arch:floor' || current.toolId === 'arch:ceiling') && tuples.length >= 3) {
        // In the profile mode the outline is a sketch loop; Finish makes the slab.
        if (store.getState().ui.profileEdit) {
          dispatch('create-line', { points: tuples, closed: true, style: PROFILE_SKETCH_STYLE, name: 'Boundary sketch' });
          setOverlay({ snap: null });
          return;
        }
        dispatch('create-slab-enclosure', { points: tuples, type: current.toolId === 'arch:floor' ? 'floor' : 'ceiling' });
      }
      else if (current.toolId === 'arch:wall' || current.toolId === 'arch:curtain-wall') {
        dispatch('create-wall-segments', { points: tuples, type: current.toolId === 'arch:curtain-wall' ? 'curtain-wall' : 'wall' });
      }
      else dispatch('create-arch-element', { tool: current.toolId.slice(5), points: tuples });
    }
    setOverlay({ snap: null });
    dispatch('set-tool', { tool: 'select' });
  }, [dispatch, setOverlay, store]);

  const archPlacementAt = useCallback(
    (toolId: string, world: Vec2, disableSnap: boolean) => {
      const state = store.getState();
      const archTool = getArchTool(toolId);
      if (!archTool || archTool.mode.kind !== 'place') return null;
      const archType = archTool.systemType;
      const tolerance = 18 / state.ui.viewport.zoom;
      if (archType === 'door') {
        const parameters = placementParametersFor(state, 'door');
        const template = doorTemplate(parameters);
        const centerY = doorMountOffset(parameters, template);
        const wallSnap = disableSnap ? null : findWallSnap(state.doc, world, template.width, centerY, tolerance);
        const p = wallSnap ? { x: wallSnap.x, y: wallSnap.y } : maybeSnap(world, disableSnap);
        const meta = { arch: { type: 'door', width: template.width, wallMountOffset: centerY, ...(wallSnap ? { opening: wallSnap.opening } : {}) } };
        return { archTool, template, p, rotation: wallSnap?.rotation ?? 0, meta };
      }
      if (archType === 'window') {
        const parameters = placementParametersFor(state, 'window');
        // Probe the wall first: the window's depth is the wall's thickness.
        const probe = disableSnap ? null : findWallSnap(state.doc, world, parameters.width, windowMountOffset(150), tolerance);
        const depth = probe?.thickness ?? 150;
        const template = windowTemplate(parameters, depth);
        const centerY = windowMountOffset(depth);
        const wallSnap = probe ? findWallSnap(state.doc, world, template.width, centerY, tolerance) : null;
        const p = wallSnap ? { x: wallSnap.x, y: wallSnap.y } : maybeSnap(world, disableSnap);
        const meta = { arch: { type: 'window', width: template.width, wallMountOffset: centerY, ...(wallSnap ? { opening: wallSnap.opening } : {}) } };
        return { archTool, template, p, rotation: wallSnap?.rotation ?? 0, meta };
      }
      if (archType === 'facade-element') {
        const parameters = placementParametersFor(state, 'facade-element');
        const template = facadeElement(parameters.width, parameters.depth);
        const probe = disableSnap ? null : findWallSnap(state.doc, world, template.width, template.height / 2, tolerance);
        if (!probe) return { archTool, template, p: maybeSnap(world, disableSnap), rotation: 0, meta: undefined };
        const normal = rotate({ x: 1, y: 0 }, probe.rotation + 90);
        const centre = {
          x: probe.x + rotate({ x: template.width / 2, y: template.height / 2 }, probe.rotation).x,
          y: probe.y + rotate({ x: template.width / 2, y: template.height / 2 }, probe.rotation).y,
        };
        const clickedInside = (world.x - centre.x) * normal.x + (world.y - centre.y) * normal.y >= 0;
        const centerY = clickedInside ? -probe.thickness / 2 : template.height + probe.thickness / 2;
        const wallSnap = findWallSnap(state.doc, world, template.width, centerY, tolerance) ?? probe;
        const meta = { arch: { type: 'facade-element', width: template.width, wallMountOffset: centerY, opening: wallSnap.opening } };
        return { archTool, template, p: { x: wallSnap.x, y: wallSnap.y }, rotation: wallSnap.rotation, meta };
      }
      const template = archTool.mode.template();
      return { archTool, template, p: maybeSnap(world, disableSnap), rotation: 0, meta: undefined };
    },
    [maybeSnap, store],
  );

  /** Column preview/placement: a parameter-sized rect centred on the (snapped) cursor. */
  const columnDraftAt = useCallback(
    (world: Vec2, disableSnap: boolean): Extract<Draft, { kind: 'rect' }> & { centre: Vec2 } => {
      const state = store.getState();
      const spec = columnRect(placementParametersFor(state, 'column'));
      const centre = maybeSnap(world, disableSnap);
      return { kind: 'rect', rect: { x: centre.x - spec.width / 2, y: centre.y - spec.height / 2, width: spec.width, height: spec.height }, radius: spec.radius, centre };
    },
    [maybeSnap, store],
  );

  // ---- stairs: click start → click each flight end; landings are inserted automatically ------


  /**
   * Updates the pending run from the cursor and redraws the preview. After a landing the run
   * starts where the user heads (straight on, a 90-degree turn from the landing's side, or a
   * U-turn beside the previous run); `fine` (Shift) allows 15-degree steps instead of 45/90.
   */
  const stairOverlay = useCallback(
    (draft: StairDraft, cursor: Vec2 | null, fine = false) => {
      const flights = [...draft.flights];
      const placed = stairTreadsPlaced(flights);
      const total = stairRiserCount(draft.parameters);
      const remaining = total - placed;
      const last = flights.at(-1);
      if (cursor && remaining > 0) {
        const from = last?.kind === 'landing' ? { x: last.x, y: last.y } : draft.start;
        const d = sub(cursor, from);
        const length = Math.hypot(d.x, d.y);
        if (length > draft.parameters.treadDepth / 2) {
          const raw = angleOf(d);
          if (last?.kind === 'landing') {
            const relative = fine ? Math.round((raw - last.angle) / 15) * 15 : Math.round((raw - last.angle) / 90) * 90;
            const next = runAfterLanding(last, last.angle + relative, draft.parameters);
            flights[flights.length - 1] = next.landing;
            draft.start = next.start;
            draft.angle = next.angle;
            const reach = Math.hypot(cursor.x - next.start.x, cursor.y - next.start.y);
            draft.treads = Math.max(1, Math.min(remaining, Math.round(reach / draft.parameters.treadDepth)));
          } else {
            const step = fine ? 15 : 45;
            draft.angle = Math.round(raw / step) * step;
            draft.treads = Math.max(1, Math.min(remaining, Math.round(length / draft.parameters.treadDepth)));
          }
        }
      }
      if (remaining > 0 && draft.treads > 0) flights.push({ kind: 'run', x: draft.start.x, y: draft.start.y, angle: draft.angle, treads: draft.treads });
      const runLength = draft.treads * draft.parameters.treadDepth;
      const current = Math.min(total, placed + draft.treads);
      const status = draft.treads > 0 ? `${current} of ${total} risers · ${Math.round(runLength)} mm flight` : `${placed} of ${total} risers`;
      const hint = remaining <= 0
        ? 'Stair complete · click, Enter or right-click to place'
        : draft.flights.length === 0
          ? 'Move to set direction and length · click the flight end'
          : 'Move to choose straight, L or U turn · click the next flight end';
      draft.preview = flights;
      setOverlay({ draft: { kind: 'stair', table: stairPreviewTable(draft.parameters, flights), status, hint, origin: draft.origin, anchor: cursor ?? draft.start }, hoverId: null, cursor: null });
    },
    [setOverlay],
  );

  const finishStair = useCallback(() => {
    const draft = stair.current;
    stair.current = null;
    setOverlay({ draft: null });
    if (draft) dispatch('select', { ids: draft.selectionBefore });
    if (draft && draft.flights.some((flight) => flight.kind === 'run')) {
      const flights = draft.flights.at(-1)?.kind === 'landing' ? draft.flights.slice(0, -1) : draft.flights;
      dispatch('create-stair', { flights, parameters: draft.parameters });
    }
    dispatch('set-tool', { tool: 'select' });
  }, [dispatch, setOverlay]);

  const cancelStair = useCallback(() => {
    const draft = stair.current;
    stair.current = null;
    setOverlay({ draft: null });
    if (draft) dispatch('select', { ids: draft.selectionBefore });
  }, [dispatch, setOverlay]);

  const addStairLanding = useCallback(() => {
    const draft = stair.current;
    if (!draft) return;
    const remaining = stairRiserCount(draft.parameters) - stairTreadsPlaced(draft.flights);
    if (remaining <= 0 || draft.flights.at(-1)?.kind === 'landing' || draft.flights.length === 0) return;
    const landing: StairFlight = { kind: 'landing', x: draft.start.x, y: draft.start.y, angle: draft.angle };
    draft.flights.push(landing);
    draft.start = flightEnd(landing, draft.parameters);
    draft.treads = 0;
    stairOverlay(draft, null);
  }, [stairOverlay]);

  /** Commits the pending run (and the landing it leaves from, if any). */
  const commitStairRun = useCallback(
    (point: Vec2, fine: boolean) => {
      const draft = stair.current;
      if (!draft) return;
      if (stairTreadsPlaced(draft.flights) >= stairRiserCount(draft.parameters)) {
        finishStair();
        return;
      }
      stairOverlay(draft, point, fine);
      const remaining = stairRiserCount(draft.parameters) - stairTreadsPlaced(draft.flights);
      if (remaining <= 0 || draft.treads <= 0) return;
      const preview = draft.preview ?? [];
      const landing = preview.at(-2);
      if (draft.flights.at(-1)?.kind === 'landing' && landing?.kind === 'landing') draft.flights[draft.flights.length - 1] = landing;
      const run: StairFlight = { kind: 'run', x: draft.start.x, y: draft.start.y, angle: draft.angle, treads: draft.treads };
      draft.flights.push(run);
      draft.start = flightEnd(run, draft.parameters);
      draft.treads = 0;
      if (stairTreadsPlaced(draft.flights) < stairRiserCount(draft.parameters)) {
        // Ending a partial flight means the user is changing direction. Insert the landing
        // immediately, then let pointer movement choose straight, quarter-turn, or U-turn.
        const landing: StairFlight = { kind: 'landing', x: draft.start.x, y: draft.start.y, angle: draft.angle };
        draft.flights.push(landing);
        draft.start = flightEnd(landing, draft.parameters);
      }
      draft.past.push(stairSnapshot(draft));
      draft.future = [];
      stairOverlay(draft, null);
    },
    [finishStair, stairOverlay],
  );

  const undoStairFlight = useCallback(() => {
    const draft = stair.current;
    if (!draft) return;
    if (draft.past.length <= 1) {
      restoreStairSnapshot(draft, draft.past[0]!);
      stairOverlay(draft, null);
      return;
    }
    const current = draft.past.pop()!;
    draft.future.push(current);
    restoreStairSnapshot(draft, draft.past.at(-1)!);
    stairOverlay(draft, null);
  }, [stairOverlay]);

  const redoStairFlight = useCallback(() => {
    const draft = stair.current;
    const next = draft?.future.pop();
    if (!draft || !next) return;
    draft.past.push(next);
    restoreStairSnapshot(draft, next);
    stairOverlay(draft, null);
  }, [stairOverlay]);

  const cancelPolyline = useCallback(() => {
    polyline.current = null;
    setOverlay({ draft: null, snap: null });
  }, [setOverlay]);

  const cancelSession = useCallback(() => {
    const current = session.current;
    session.current = null;
    aimPointer.current = null;
    clearPreview();
    if (current?.type === 'erase') fadeOnBoard(containerRef.current, current.ids, false);
    if (current?.type === 'marquee') dispatch('select', { ids: current.baseSelection });
    setOverlay({ marquee: null, draft: null, panning: false, dragging: false });
  }, [containerRef, dispatch, clearPreview, setOverlay]);

  // ---- resize maths ------------------------------------------------------------------------

  const resizeInput = useCallback(
    (s: Extract<Session, { type: 'resize' }>, worldNow: Vec2, shiftKey: boolean, alt: boolean, snap: boolean) => {
      const { handle, frame } = s;
      const element = frame.element;
      // Catalog assets only ever scale uniformly, whatever the modifier keys say.
      const shift = shiftKey || s.ids.some((id) => resizeRuleFor(s.base.elements[id]) === 'uniform');
      const rotated = frame.kind === 'single' && element && element.kind !== 'line' && element.kind !== 'group' && Math.abs(frame.rotation) > 1e-6;
      const step = snap ? snapStep() : null;

      if (rotated && element) {
        // Rotated single element: work in its local frame so edges stay aligned with the shape.
        const m = worldMatrix(s.base.elements, element);
        const inv = invert(m);
        const d = sub(applyToPoint(inv, worldNow), applyToPoint(inv, s.startWorld));
        const box = localBounds(s.base.elements, element);
        let left = box.x;
        let top = box.y;
        let right = box.x + box.width;
        let bottom = box.y + box.height;
        if (handle.hx === -1) left += d.x;
        if (handle.hx === 1) right += d.x;
        if (handle.hy === -1) top += d.y;
        if (handle.hy === 1) bottom += d.y;
        if (alt) {
          if (handle.hx === -1) right -= d.x;
          if (handle.hx === 1) left -= d.x;
          if (handle.hy === -1) bottom -= d.y;
          if (handle.hy === 1) top -= d.y;
        }
        if (shift && box.width > 0 && box.height > 0) {
          const ratio = box.width / box.height;
          const w = right - left;
          const h = bottom - top;
          if (handle.hx !== 0 && (handle.hy === 0 || Math.abs(w / box.width) > Math.abs(h / box.height))) {
            const targetH = Math.abs(w) / ratio;
            if (handle.hy === -1) top = bottom - targetH;
            else bottom = top + targetH;
          } else {
            const targetW = Math.abs(h) * ratio;
            if (handle.hx === -1) left = right - targetW;
            else right = left + targetW;
          }
        }
        if (right - left < MIN_SIZE) {
          if (handle.hx === -1) left = right - MIN_SIZE;
          else right = left + MIN_SIZE;
        }
        if (bottom - top < MIN_SIZE) {
          if (handle.hy === -1) top = bottom - MIN_SIZE;
          else bottom = top + MIN_SIZE;
        }
        const shift2 = rotate({ x: left - box.x, y: top - box.y }, element.rotation);
        return {
          command: 'set-transform',
          input: { id: element.id, x: element.x + shift2.x, y: element.y + shift2.y, width: right - left, height: bottom - top },
        };
      }

      const from = frame.bounds;
      const d = sub(worldNow, s.startWorld);
      let left = from.x;
      let top = from.y;
      let right = from.x + from.width;
      let bottom = from.y + from.height;
      if (handle.hx === -1) left += d.x;
      if (handle.hx === 1) right += d.x;
      if (handle.hy === -1) top += d.y;
      if (handle.hy === 1) bottom += d.y;
      if (step) {
        if (handle.hx === -1) left = snapValue(left, step);
        if (handle.hx === 1) right = snapValue(right, step);
        if (handle.hy === -1) top = snapValue(top, step);
        if (handle.hy === 1) bottom = snapValue(bottom, step);
      }
      if (alt) {
        if (handle.hx === -1) right = from.x + from.width - (left - from.x);
        if (handle.hx === 1) left = from.x - (right - (from.x + from.width));
        if (handle.hy === -1) bottom = from.y + from.height - (top - from.y);
        if (handle.hy === 1) top = from.y - (bottom - (from.y + from.height));
      }
      if (shift && from.width > 0 && from.height > 0) {
        const ratio = from.width / from.height;
        const w = right - left;
        const h = bottom - top;
        if (handle.hx !== 0 && (handle.hy === 0 || Math.abs(w / from.width) > Math.abs(h / from.height))) {
          const targetH = Math.abs(w) / ratio;
          if (handle.hy === -1) top = bottom - targetH;
          else bottom = top + targetH;
        } else {
          const targetW = Math.abs(h) * ratio;
          if (handle.hx === -1) left = right - targetW;
          else right = left + targetW;
        }
      }
      if (right - left < MIN_SIZE) {
        if (handle.hx === -1) left = right - MIN_SIZE;
        else right = left + MIN_SIZE;
      }
      if (bottom - top < MIN_SIZE) {
        if (handle.hy === -1) top = bottom - MIN_SIZE;
        else bottom = top + MIN_SIZE;
      }
      return {
        command: 'resize-selection',
        input: { ids: s.ids, from, to: { x: left, y: top, width: right - left, height: bottom - top } },
      };
    },
    [snapStep],
  );

  const moveInput = useCallback(
    (s: Extract<Session, { type: 'move' }>, worldNow: Vec2, shift: boolean, alt: boolean) => {
      let delta = sub(worldNow, s.startWorld);
      if (shift) delta = Math.abs(delta.x) > Math.abs(delta.y) ? { x: delta.x, y: 0 } : { x: 0, y: delta.y };
      // On a sheet, items line up with the margins, centre lines, other items and equal gaps.
      const sheetId = store.getState().ui.sheet?.paperId;
      const paper = sheetId ? s.base.elements[sheetId] : undefined;
      if (!alt && paper && s.ids.every((id) => s.base.elements[id]?.parentId === paper.id)) {
        const paperBox = worldBounds(s.base.elements, paper);
        const scale = paperScaleOf(paper);
        const items = Object.values(s.base.elements).filter((e) => e.parentId === paper.id && e.visible && !s.ids.includes(e.id)).map((e) => worldBounds(s.base.elements, e));
        const moving = { ...s.bounds, x: s.bounds.x + delta.x, y: s.bounds.y + delta.y };
        const origin = boundsOfIds(s.base.elements, s.ids);
        if (origin) {
          moving.x = origin.x + delta.x;
          moving.y = origin.y + delta.y;
          moving.width = origin.width;
          moving.height = origin.height;
        }
        const guide = smartGuides(moving, { items, ...paperLines(paperBox, 10 * scale), paper: paperBox }, 8 / store.getState().ui.viewport.zoom);
        setOverlay({ snap: guide.guides.length ? { point: { x: moving.x + guide.dx, y: moving.y + guide.dy }, text: '', kind: 'tracking', guides: guide.guides } : null });
        return { ids: s.ids, dx: delta.x + guide.dx, dy: delta.y + guide.dy };
      }
      // A grabbed corner / end snaps onto other geometry (object snaps, tracking) before the grid.
      if (!alt && !shift && s.grab) {
        const target = drafting.snap({ x: s.grab.x + delta.x, y: s.grab.y + delta.y }, { alt: false, shift: false, pixel: 1 / store.getState().ui.viewport.zoom }, s.startWorld, s.exclude);
        if (target.kind && target.kind !== 'grid') {
          setOverlay({ snap: drafting.snapOverlay(target) });
          return { ids: s.ids, dx: target.point.x - s.grab.x, dy: target.point.y - s.grab.y };
        }
      }
      if (overlayRef.current.snap) setOverlay({ snap: null });
      const step = alt ? null : snapStep();
      if (step) {
        const snapped = snapMoveDelta(s.bounds, delta, step);
        delta = shift ? (Math.abs(delta.x) > Math.abs(delta.y) ? { x: snapped.x, y: 0 } : { x: 0, y: snapped.y }) : snapped;
      }
      return { ids: s.ids, dx: delta.x, dy: delta.y };
    },
    [drafting, setOverlay, snapStep, store],
  );

  const moveGestureInput = useCallback(
    (s: Extract<Session, { type: 'move' }>, worldNow: Vec2, shift: boolean, alt: boolean) => {
      const move = moveInput(s, worldNow, shift, alt);
      if (s.ids.length !== 1) return { command: 'move-selection', input: move };
      const element = s.base.elements[s.ids[0]!];
      const mount = wallMountInfo(element);
      if (!element || !mount) return { command: 'move-selection', input: move };

      const x = element.x + move.dx;
      const y = element.y + move.dy;
      const centreOffset = rotate({ x: mount.width / 2, y: mount.centerY }, element.rotation);
      const intendedCentre = { x: x + centreOffset.x, y: y + centreOffset.y };
      const viewport = store.getState().ui.viewport;
      const wallSnap = alt ? null : findWallSnap(s.base, intendedCentre, mount.width, mount.centerY, 18 / viewport.zoom);
      return {
        command: 'set-wall-mounted-transform',
        input: {
          id: element.id,
          x: wallSnap?.x ?? x,
          y: wallSnap?.y ?? y,
          rotation: wallSnap?.rotation ?? element.rotation,
          opening: wallSnap?.opening ?? null,
        },
      };
    },
    [moveInput, store],
  );

  const rotateInput = useCallback((s: Extract<Session, { type: 'rotate' }>, worldNow: Vec2, shift: boolean) => {
    let degrees = angleOf(sub(worldNow, s.pivot)) - s.startAngle;
    if (shift) degrees = Math.round(degrees / 15) * 15;
    return { ids: s.ids, degrees, pivot: s.pivot };
  }, []);

  // ---- annotations -------------------------------------------------------------------------

  /** Marks the strokes the eraser passed over since its last sample (faded until release). */
  const eraseAlong = useCallback(
    (s: Extract<Session, { type: 'erase' }>, world: Vec2) => {
      const fresh = inkUnder(s.candidates, s.last, world, s.radius).filter((id) => !s.ids.has(id));
      s.last = world;
      if (!fresh.length) return;
      for (const id of fresh) s.ids.add(id);
      fadeOnBoard(containerRef.current, fresh, true);
    },
    [containerRef],
  );

  // ---- pointer handlers --------------------------------------------------------------------

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;
      // A pen's eraser end reports button 5; it erases annotations whatever the tool.
      const penEraser = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0);
      if (e.button !== 0 && e.button !== 1 && !penEraser) return;
      container.focus({ preventScroll: true });
      const state = store.getState();
      const screen = screenPoint(e);
      const world = toWorld(screen);
      const tool = state.ui.tool;
      const mods = effectiveModifiers(e);
      // Palm rejection: a palm under the pen is ignored altogether; shortly after the pen lifts,
      // fingers only pan and zoom.
      const palmVerdict = replayingAim.current ? null : palm.down(e.nativeEvent);
      if (palmVerdict === 'ignore') return;
      const navigateOnly = palmVerdict === 'navigate';

      // A pen never pinches: it draws alone, and forgets any pointer whose release was lost.
      if (e.pointerType === 'pen') activePointers.current.clear();
      activePointers.current.set(e.pointerId, screen);
      const isTouchPointer = e.pointerType === 'touch' || (typeof document !== 'undefined' && document.documentElement.getAttribute('data-touch') === 'true');
      const isPen = e.pointerType === 'pen';
      const handleHitRadius = isTouchPointer ? 18 : isPen ? 12 : 7;
      const hitTolerance = (isTouchPointer ? 14 : isPen ? 10 : 6) / state.ui.viewport.zoom;

      if (state.ui.editingTextId) dispatch('end-text-edit');

      // Multi-touch pinch-to-zoom & two-finger pan
      if (activePointers.current.size >= 2) {
        clearLongPress();
        cancelSession();
        // A second finger turns an aim into navigation; the drawing itself stays open.
        aimPointer.current = null;
        const pts = Array.from(activePointers.current.values());
        const p1 = pts[0]!;
        const p2 = pts[1]!;
        const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const midpoint = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
        pinchState.current = {
          initialDistance: Math.max(1, dist),
          initialZoom: state.ui.viewport.zoom,
          initialMidpoint: midpoint,
          initialViewport: { ...state.ui.viewport },
        };
        setOverlay({ panning: true, cursor: null, draft: null, marquee: null });
        return;
      }

      if (e.pointerType === 'touch' && !replayingAim.current && (tool === 'select' || navigateOnly)) {
        clearLongPress();
        const clientPos = { x: e.clientX, y: e.clientY };
        const touchStartScreen = screen;
        longPressStart.current = screen;
        longPressTimer.current = window.setTimeout(() => {
          longPressTimer.current = null;
          cancelSession();
          if (navigator.vibrate) navigator.vibrate(40);
          const worldPoint = toWorld(touchStartScreen);
          const hit = hitTest(store.getState().doc, worldPoint, { tolerance: hitTolerance, includeLocked: true, scopeId: selectionScope(store.getState().ui) });
          if (hit) {
            const target = selectableTarget(store.getState().doc.elements, hit, false, selectionScope(store.getState().ui));
            if (!store.getState().ui.selection.includes(target.id)) {
              dispatch('select', { ids: [target.id] });
            }
          }
          options.onContextMenu(clientPos);
        }, 500);
      }

      if (e.button === 1 || spaceDown.current || tool === 'hand' || navigateOnly) {
        if (spaceDown.current && spaceGesture.current) spaceGesture.current.panned = true;
        container.setPointerCapture(e.pointerId);
        session.current = { type: 'pan', startScreen: screen, startViewport: state.ui.viewport };
        setOverlay({ panning: true });
        e.preventDefault();
        return;
      }

      // Board annotations: the eraser wipes the strokes it passes over, pen and highlighter follow
      // the pointer, and a sticky note lands where you tap.
      if (penEraser || tool === 'annotate:eraser') {
        clearLongPress();
        container.setPointerCapture(e.pointerId);
        const erase: Extract<Session, { type: 'erase' }> = { type: 'erase', ids: new Set(), candidates: inkCandidates(state.doc), radius: (isTouchPointer ? 14 : 8) / state.ui.viewport.zoom, last: world };
        session.current = erase;
        eraseAlong(erase, world);
        e.preventDefault();
        return;
      }
      if (tool === 'annotate:pen' || tool === 'annotate:highlighter') {
        clearLongPress();
        container.setPointerCapture(e.pointerId);
        const options = state.ui.annotation;
        const highlighter = tool === 'annotate:highlighter';
        const pressure = !highlighter && options.pressure ? penPressure(e.nativeEvent) : null;
        session.current = {
          type: 'ink',
          points: [world],
          pressure: pressure === null ? [] : [pressure],
          width: (highlighter ? options.highlighterSize : options.penSize) / state.ui.viewport.zoom,
          color: highlighter ? options.highlighterColor : options.penColor,
          highlighter,
        };
        setOverlay({ draft: inkDraft(session.current), cursor: null, hoverId: null });
        e.preventDefault();
        return;
      }
      if (tool === 'annotate:sticky') {
        const created = dispatch('create-sticky', { x: world.x, y: world.y, size: 200 / state.ui.viewport.zoom });
        if (created.ok) dispatch('begin-text-edit', { id: created.value as string });
        return;
      }

      // Touch aims before it places: the preview and snaps follow the finger (the hover path of
      // onPointerMove), and the tool's press is replayed where the finger lifts.
      if (e.pointerType === 'touch' && !replayingAim.current && placesOnLift(tool)) {
        aimPointer.current = e.pointerId;
        container.setPointerCapture(e.pointerId);
        return;
      }

      if (drafting.handles(tool)) {
        container.setPointerCapture(e.pointerId);
        drafting.down(world, pointerInfo(mods));
        return;
      }

      if (isPolylineTool(tool)) {
        if ((tool === 'arch:floor' || tool === 'arch:ceiling') && !polyline.current) {
          const enclosure = findEnclosure(state.doc, world, 18 / state.ui.viewport.zoom);
          if (enclosure) {
            const points = enclosure.map((point) => [point.x, point.y] as [number, number]);
            setOverlay({ draft: null });
            // In the profile mode the picked walls give a sketch loop (Revit's Pick Walls).
            if (state.ui.profileEdit) {
              dispatch('create-line', { points, closed: true, style: PROFILE_SKETCH_STYLE, name: 'Boundary sketch' });
              return;
            }
            dispatch('create-slab-enclosure', { points, type: tool === 'arch:floor' ? 'floor' : 'ceiling' });
            dispatch('set-tool', { tool: 'select' });
            return;
          }
        }
        const last = polyline.current?.points.at(-1);
        // Object snaps, tracking and polar lines from the previous point; Shift locks the angle.
        let point = drafting.snap(world, pointerInfo(mods), last ?? null).point;
        if (!mods.alt && !mods.shift && snapsToBoundaries(tool)) {
          const snap = snapToBoundary(state.doc, point, 18 / state.ui.viewport.zoom, { faces: tool === 'arch:wall' || tool === 'arch:curtain-wall' || tool === 'arch:railing' });
          if (snap) point = snap.point;
        }
        polyTyped.current = '';
        if (last && distance(last, point) * state.ui.viewport.zoom < 4) {
          finishPolyline();
          return;
        }
        if (!polyline.current) {
          const hit = tool === 'measure'
            ? hitTest(state.doc, point, { tolerance: hitTolerance, includeLocked: true, scopeId: selectionScope(state.ui) })
            : null;
          polyline.current = {
            toolId: tool,
            points: [],
            style: polylineStyle(tool),
            ...(hit && !hit.meta?.['measure'] ? { parentId: hit.id } : {}),
          };
        }
        polyline.current.points.push(point);
        setOverlay({ draft: { kind: 'polyline', points: [...polyline.current.points], cursor: point, style: polyline.current.style } });
        if (TWO_POINT_TOOLS.has(tool) && polyline.current.points.length === 2) finishPolyline();
        return;
      }

      if (tool === 'point') {
        const p = maybeSnap(world, mods.alt);
        dispatch('create-point', { x: p.x, y: p.y });
        return;
      }

      if (tool === 'noise-emitter') {
        const originId = store.getState().ui.analysisTargetId;
        const p = maybeSnap(world, mods.alt);
        if (originId) dispatch('create-noise-emitter', { originId, x: p.x, y: p.y });
        return;
      }

      if (tool === 'diagram:tag') {
        const p = maybeSnap(world, true);
        const created = dispatch('create-diagram', { kind: 'tag', x: p.x, y: p.y });
        if (!created.ok) toasts.push({ kind: 'error', message: created.error.message });
        return;
      }

      if (tool === 'rect' || tool === 'view3d' || tool === 'paper' || tool === 'ai-portal' || tool === 'arch:level' || tool === 'parametric' || tool === 'analysis-location' || tool === 'analysis-sun' || tool === 'analysis-wind' || tool === 'analysis-noise' || tool === 'diagram:zone' || tool === 'noise-area-emitter') {
        container.setPointerCapture(e.pointerId);
        session.current = { type: 'draw-rect', startWorld: drafting.snap(world, pointerInfo(mods)).point };
        return;
      }

      if (tool === 'text') {
        const p = maybeSnap(world, mods.alt);
        const created = dispatch('create-text', { x: p.x, y: p.y, text: '' });
        if (created.ok) dispatch('begin-text-edit', { id: created.value });
        return;
      }

      if (tool === 'model') {
        const p = maybeSnap(world, mods.alt);
        dispatch('set-tool', { tool: 'select' });
        void executor.dispatch('import-3d-model', { x: p.x, y: p.y }).then((r) => {
          if (r.ok && r.value) toasts.push({ kind: 'success', message: modelToast(r.value) });
          else if (!r.ok && r.error.code !== 'cancelled') toasts.push({ kind: 'error', message: r.error.message });
        });
        return;
      }

      if (tool === 'image') {
        const p = maybeSnap(world, mods.alt);
        dispatch('set-tool', { tool: 'select' });
        void executor.dispatch('import-image', { x: p.x, y: p.y }).then((r) => {
          if (!r.ok) toasts.push({ kind: 'error', message: r.error.message });
        });
        return;
      }

      if (tool === 'catalog' && state.ui.placingAsset) {
        const asset = state.ui.placingAsset;
        const p = maybeSnap({ x: world.x - asset.size.width / 2, y: world.y - asset.size.height / 2 }, mods.alt);
        void executor.dispatch('place-catalog-asset', { asset, x: p.x, y: p.y }).then((result) => {
          if (!result.ok) toasts.push({ kind: 'error', message: result.error.message });
        });
        setOverlay({ draft: null });
        dispatch('set-tool', { tool: 'select' });
        return;
      }

      if (tool === 'arch:room' || tool === 'arch:floor' || tool === 'arch:ceiling') {
        const enclosure = findEnclosure(state.doc, world, 18 / state.ui.viewport.zoom);
        if (enclosure) {
          const points = enclosure.map((point) => [point.x, point.y]);
          setOverlay({ draft: null });
          if (tool !== 'arch:room' && state.ui.profileEdit) {
            dispatch('create-line', { points, closed: true, style: PROFILE_SKETCH_STYLE, name: 'Boundary sketch' });
            return;
          }
          if (tool === 'arch:room') dispatch('create-room-enclosure', { points, seed: [world.x, world.y] });
          else dispatch('create-slab-enclosure', { points, type: tool === 'arch:floor' ? 'floor' : 'ceiling' });
          dispatch('set-tool', { tool: 'select' });
        }
        return;
      }

      if (tool === 'arch:column') {
        const draft = columnDraftAt(world, mods.alt);
        dispatch('create-arch-element', { tool: 'column', x: draft.centre.x, y: draft.centre.y });
        setOverlay({ draft: null });
        dispatch('set-tool', { tool: 'select' });
        return;
      }

      if (tool === 'arch:stairs' || tool === 'arch:stair') {
        const point = maybeSnap(world, mods.alt);
        if (!stair.current) {
          const initial: StairSnapshot = { flights: [], start: point, angle: 0 };
          stair.current = {
            parameters: placementParametersFor(state, 'stair'),
            flights: [],
            past: [initial],
            future: [],
            selectionBefore: [...state.ui.selection],
            origin: point,
            start: point,
            angle: 0,
            treads: 0,
          };
          if (state.ui.selection.length > 0) dispatch('clear-selection');
          stairOverlay(stair.current, null);
          return;
        }
        commitStairRun(point, mods.shift);
        return;
      }

      if (tool.startsWith('arch:')) {
        const placement = archPlacementAt(tool.slice(5), world, mods.alt);
        if (!placement) return;
        dispatch('create-arch-element', {
          tool: tool.slice(5),
          x: placement.p.x,
          y: placement.p.y,
          rotation: placement.rotation,
          ...(placement.meta ? { meta: placement.meta } : {}),
        });
        setOverlay({ draft: null });
        dispatch('set-tool', { tool: 'select' });
        return;
      }

      // ---- select tool ----
      // Styling inside a view frame: clicks pick the elements it shows; a click outside leaves it.
      const viewEdit = state.ui.sheet?.viewEdit;
      if (viewEdit) {
        const picked = pickInFrame(state.doc, viewEdit.frameId, world, hitTolerance);
        if (picked === undefined) dispatch('exit-sheet-view');
        else if (picked) dispatch('pick-in-view', { ids: [picked], mode: mods.additive ? 'toggle' : 'replace' });
        else if (!mods.additive) dispatch('pick-in-view', { ids: [], mode: 'replace' });
        return;
      }
      container.setPointerCapture(e.pointerId);
      const frame = currentFrame();
      const selectionLocked = state.ui.selection.some((id) => isEffectivelyLocked(state.doc.elements, id));
      const handle = selectionLocked ? null : hitHandle(frame, screen, handleHitRadius);
      if (frame && handle) {
        const ids = state.ui.selection;
        const single = frame.element;
        if ((handle.id.startsWith('vertex:') || handle.id.startsWith('seg:') || handle.id.startsWith('radius:') || handle.id.startsWith('node:')) && single && handle.world) {
          session.current = { type: 'grip', base: state.doc, id: single.id, grip: handle.id, startWorld: world, origin: handle.world };
          setOverlay({ dragging: true, cursor: 'move' });
          return;
        }
        if (handle.id.startsWith('curve:') && single) {
          const [, segment, curveHandle] = handle.id.split(':');
          session.current = { type: 'curve-handle', base: state.doc, id: single.id, segment: Number(segment), handle: curveHandle as 'control' | 'control1' | 'control2' | 'center' };
          setOverlay({ dragging: true, cursor: 'move' });
          return;
        }
        if ((handle.id === 'start' || handle.id === 'end' || handle.id.startsWith('point:')) && single) {
          container.setPointerCapture(e.pointerId);
          session.current = { type: 'endpoint', base: state.doc, id: single.id, endpoint: handle.id as 'start' | 'end' | `point:${number}` };
          setOverlay({ dragging: true, cursor: 'move' });
          return;
        }
        if (single && single.kind === 'instance' && resizeRuleFor(single) === 'width') {
          container.setPointerCapture(e.pointerId);
          session.current = { type: 'window-resize', base: state.doc, id: single.id, jamb: handle.id === 'w' ? 'start' : 'end', startWorld: world, startWidth: single.width };
          setOverlay({ dragging: true, cursor: handle.cursor });
          return;
        }
        if (handle.id === 'rotate') {
          const pivot = { x: frame.bounds.x + frame.bounds.width / 2, y: frame.bounds.y + frame.bounds.height / 2 };
          session.current = { type: 'rotate', base: state.doc, ids, pivot, startAngle: angleOf(sub(world, pivot)) };
        } else {
          session.current = { type: 'resize', base: state.doc, ids, handle, frame, startWorld: world };
        }
        setOverlay({ dragging: true, cursor: handle.cursor });
        return;
      }

      // Tab cycling (Revit): a click where Tab highlighted a candidate selects that candidate.
      const cycle = tabCycle.current;
      tabCycle.current = null;
      if (cycle) setOverlay({ cycle: null });
      const cycled = cycle && distance(screen, cycle.screen) <= 8 ? cycle.candidates[cycle.index] : undefined;
      if (cycled) {
        const result = dispatch('select', { ids: cycled.ids, mode: mods.additive ? 'add' : 'replace' });
        const ids = result.ok ? (result.value as string[]) : state.ui.selection;
        if (cycled.ids.some((id) => isEffectivelyLocked(state.doc.elements, id))) return;
        session.current = { type: 'pending', startScreen: screen, startWorld: world, ids, clickedId: cycled.ids[0]!, reselectOnClick: false };
        return;
      }

      // A camera/section origin handle sits over its marker: it wins, so the rig can be grabbed.
      const rigHit = state.ui.sheet || state.ui.groupEditId ? null : rigHandleAt(state.doc.elements, state.ui.viewport, screen, (isTouchPointer ? RIG_HANDLE_RADIUS_TOUCH : RIG_HANDLE_RADIUS) + 3);
      const hit = rigHit ?? hitTest(state.doc, world, { tolerance: hitTolerance, includeLocked: true, scopeId: selectionScope(state.ui) });
      if (hit) {
        const target = selectableTarget(state.doc.elements, hit, false, selectionScope(state.ui));
        const selected = state.ui.selection.includes(target.id);
        let ids: string[];
        if (mods.additive) {
          const result = dispatch('select', { ids: [target.id], mode: 'toggle' });
          ids = result.ok ? (result.value as string[]) : state.ui.selection;
        } else if (!selected) {
          dispatch('select', { ids: [target.id] });
          ids = [target.id];
        } else {
          ids = state.ui.selection;
        }
        if (!ids.includes(target.id)) return;
        if (isEffectivelyLocked(state.doc.elements, target.id)) {
          session.current = null;
          return;
        }
        session.current = {
          type: 'pending',
          startScreen: screen,
          startWorld: world,
          ids,
          clickedId: target.id,
          reselectOnClick: selected && !mods.additive && ids.length > 1,
        };
        return;
      }

      if (e.pointerType === 'touch' && !isOn(touchModifiers.get().selectArea)) {
        // A finger on empty space moves around the board; "Select area" turns it into a box.
        session.current = { type: 'pan', startScreen: screen, startViewport: state.ui.viewport, tapClears: !mods.additive };
        setOverlay({ panning: true });
        return;
      }
      if (!mods.additive && state.ui.selection.length > 0) dispatch('clear-selection');
      session.current = { type: 'marquee', startWorld: world, additive: mods.additive, baseSelection: mods.additive ? state.ui.selection : [] };
    },
    [archPlacementAt, palm, cancelSession, clearLongPress, columnDraftAt, commitStairRun, containerRef, currentFrame, dispatch, drafting, eraseAlong, executor, finishPolyline, maybeSnap, options, pointerInfo, screenPoint, setOverlay, stairOverlay, store, toWorld, toasts],
  );

  /** World delta of a jamb drag projected onto the window's own axis. */
  const windowResizeInput = useCallback((s: Extract<Session, { type: 'window-resize' }>, worldNow: Vec2, snap: boolean) => {
    const element = s.base.elements[s.id];
    if (!element) return null;
    const along = rotate({ x: 1, y: 0 }, element.rotation);
    const d = sub(worldNow, s.startWorld);
    let delta = d.x * along.x + d.y * along.y;
    if (s.jamb === 'start') delta = -delta;
    let width = Math.max(200, s.startWidth + delta);
    const step = snap ? snapStep() : null;
    if (step) width = Math.max(200, snapValue(width, step));
    return { id: s.id, width, anchor: s.jamb === 'start' ? 'end' : 'start' };
  }, [snapStep]);

  const endpointInput = useCallback(
    (s: Extract<Session, { type: 'endpoint' }>, worldNow: Vec2, alt: boolean) => {
      const state = store.getState();
      let point = maybeSnap(worldNow, alt);
      if (!alt) {
        const snap = snapToBoundary(s.base, point, 18 / state.ui.viewport.zoom, { faces: true, excludeIds: [s.id] });
        if (snap) point = snap.point;
      }
      return { id: s.id, endpoint: s.endpoint, x: point.x, y: point.y };
    },
    [maybeSnap, store],
  );

  /** The command a plain-line grip drag describes (vertex, segment or radius), snapped. */
  const gripInput = useCallback(
    (s: Extract<Session, { type: 'grip' }>, worldNow: Vec2, mods: { alt: boolean; shift: boolean }): { command: string; input: unknown; snap: OsnapResult | null } | null => {
      const [kind, raw] = s.grip.split(':') as [string, string];
      const index = Number(raw);
      const info = pointerInfo(mods);
      const exclude = new Set([s.id]);
      const element = s.base.elements[s.id];
      if (!element || element.kind !== 'line') return null;
      if (kind === 'vertex') {
        // Shift / polar measure from the neighbouring vertex.
        const m = worldMatrix(s.base.elements, element);
        const local = element.path ? [element.path.start, ...element.path.segments.map((seg) => (seg as { to: [number, number] }).to)] : element.points;
        const neighbour = local[index - 1] ?? local[index + 1];
        const anchor = neighbour ? applyToPoint(m, { x: neighbour[0], y: neighbour[1] }) : null;
        const snap = drafting.snap(worldNow, info, anchor, exclude);
        return { command: 'move-line-vertex', input: { id: s.id, index, x: snap.point.x, y: snap.point.y }, snap };
      }
      if (kind === 'node') {
        const snap = drafting.snap(worldNow, info, null, exclude);
        return { command: 'move-path-node', input: { id: s.id, index, x: snap.point.x, y: snap.point.y }, snap };
      }
      if (kind === 'seg') {
        let dx = worldNow.x - s.startWorld.x;
        let dy = worldNow.y - s.startWorld.y;
        const snap = drafting.snap({ x: s.origin.x + dx, y: s.origin.y + dy }, info, s.origin, exclude);
        if (snap.kind) {
          dx = snap.point.x - s.origin.x;
          dy = snap.point.y - s.origin.y;
        }
        return { command: 'move-line-segment', input: { id: s.id, segment: index, dx, dy }, snap };
      }
      const segment = element.path?.segments[index];
      if (segment?.kind !== 'arc') return null;
      const center = applyToPoint(worldMatrix(s.base.elements, element), { x: segment.center[0], y: segment.center[1] });
      const snap = drafting.snap(worldNow, info, center, exclude);
      const radius = distance(center, snap.point);
      return radius > 0.5 ? { command: 'set-line-radius', input: { id: s.id, segment: index, radius }, snap } : null;
    },
    [drafting, pointerInfo],
  );

  const curveHandleInput = useCallback((s: Extract<Session, { type: 'curve-handle' }>, worldNow: Vec2, alt: boolean) => {
    const point = maybeSnap(worldNow, alt);
    return { id: s.id, segment: s.segment, handle: s.handle, x: point.x, y: point.y };
  }, [maybeSnap]);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (palm.ignores(e)) return;
      const s = session.current;
      const state = store.getState();
      const screen = screenPoint(e);
      const world = toWorld(screen);
      const mods = effectiveModifiers(e);

      // Only pointers that are down are tracked: a hovering pen (a new pointer id each time it
      // comes into range) must not count as a second finger and turn the next stroke into a pinch.
      if (activePointers.current.has(e.pointerId)) activePointers.current.set(e.pointerId, screen);
      if (e.pointerType !== 'touch') hoverScreen.current = screen;
      const isTouchPointer = e.pointerType === 'touch' || (typeof document !== 'undefined' && document.documentElement.getAttribute('data-touch') === 'true');
      const isPen = e.pointerType === 'pen';
      const handleHitRadius = isTouchPointer ? 18 : isPen ? 12 : 7;
      const hitTolerance = (isTouchPointer ? 14 : isPen ? 10 : 6) / state.ui.viewport.zoom;

      if (longPressTimer.current !== null) {
        const start = longPressStart.current;
        if (start && Math.hypot(screen.x - start.x, screen.y - start.y) > 8) {
          clearLongPress();
        }
      }

      if (activePointers.current.size >= 2 && pinchState.current) {
        const pts = Array.from(activePointers.current.values());
        const p1 = pts[0]!;
        const p2 = pts[1]!;
        const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const midpoint = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
        const scale = dist / pinchState.current.initialDistance;
        const { initialViewport, initialMidpoint } = pinchState.current;
        const dx = midpoint.x - initialMidpoint.x;
        const dy = midpoint.y - initialMidpoint.y;
        const next = zoomAt(initialViewport, initialMidpoint, scale);
        setViewportDirect(store, {
          zoom: next.zoom,
          x: next.x + dx,
          y: next.y + dy,
        });
        return;
      }

      if (!s) {
        if (drafting.handles(state.ui.tool)) {
          drafting.move(world, { ...pointerInfo(mods), pressed: (e.buttons & 1) === 1 });
          if (overlayRef.current.cursor) setOverlay({ cursor: null });
          return;
        }
        if (polyline.current || snapsToBoundaries(state.ui.tool) || isPolylineTool(state.ui.tool)) {
          const last = polyline.current?.points.at(-1);
          const result: OsnapResult = drafting.snap(world, pointerInfo(mods), last ?? null);
          let cursor = result.point;
          let snapLabel: SnapLabel | null = drafting.snapOverlay(result);
          if (!mods.alt && !mods.shift && snapsToBoundaries(state.ui.tool)) {
            const tool = state.ui.tool;
            const snap = snapToBoundary(state.doc, cursor, 18 / state.ui.viewport.zoom, { faces: tool === 'arch:wall' || tool === 'arch:curtain-wall' || tool === 'arch:railing' });
            if (snap) {
              cursor = snap.point;
              snapLabel = { point: snap.point, text: SNAP_CAPTIONS[snap.kind] };
            }
          }
          polyCursor.current = cursor;
          const length = last ? Math.hypot(cursor.x - last.x, cursor.y - last.y) : 0;
          const angle = last ? (Math.atan2(-(cursor.y - last.y), cursor.x - last.x) * 180) / Math.PI : 0;
          setOverlay({
            draft: polyline.current ? { kind: 'polyline', points: [...polyline.current.points], cursor, style: polyline.current.style } : null,
            snap: snapLabel,
            drafting: {
              paths: [],
              rubber: null,
              picks: [],
              prompt: { text: polyline.current ? 'Next point · Enter finishes · type a length, 3000<30 or dx,dy' : 'Start point', typed: polyTyped.current, measure: last ? `${formatLength(length, state.doc.workspace.unit, state.doc.workspace.precision)} · ${Math.round(angle * 10) / 10}°` : null, at: cursor },
            },
            hoverId: null,
            cursor: null,
          });
          return;
        }
        if (state.ui.tool === 'arch:column') {
          const draft = columnDraftAt(world, mods.alt);
          setOverlay({ draft: { kind: 'rect', rect: draft.rect, radius: draft.radius }, hoverId: null, cursor: null });
          return;
        }
        if (state.ui.tool === 'arch:stairs' || state.ui.tool === 'arch:stair') {
          if (stair.current) stairOverlay(stair.current, maybeSnap(world, mods.alt), mods.shift);
          else setOverlay({ draft: null, hoverId: null, cursor: null });
          return;
        }
        if (state.ui.tool === 'catalog' && state.ui.placingAsset) {
          const asset = state.ui.placingAsset;
          const p = maybeSnap({ x: world.x - asset.size.width / 2, y: world.y - asset.size.height / 2 }, mods.alt);
          setOverlay({
            draft: { kind: 'placement', x: p.x, y: p.y, width: asset.size.width, height: asset.size.height, rotation: 0, imageUrl: asset.image.url },
            hoverId: null,
            cursor: null,
          });
          return;
        }
        if (state.ui.tool === 'arch:room' || state.ui.tool === 'arch:floor' || state.ui.tool === 'arch:ceiling') {
          const enclosure = findEnclosure(state.doc, world, 18 / state.ui.viewport.zoom);
          setOverlay({ draft: enclosure ? { kind: 'enclosure', points: enclosure } : null, hoverId: null, cursor: null });
          return;
        }
        if (state.ui.tool.startsWith('arch:')) {
          const placement = archPlacementAt(state.ui.tool.slice(5), world, mods.alt);
          if (placement) {
            setOverlay({
              draft: {
                kind: 'placement',
                x: placement.p.x,
                y: placement.p.y,
                width: placement.template.width,
                height: placement.template.height,
                rotation: placement.rotation,
                template: placement.template,
              },
              hoverId: null,
              cursor: null,
            });
            return;
          }
        }
        if (state.ui.tool !== 'select') {
          setOverlay({ hoverId: null, cursor: null, draft: null });
          return;
        }
        // A Tab cycle stays while the cursor stays put; moving away ends it.
        if (tabCycle.current) {
          if (distance(screen, tabCycle.current.screen) <= 6) return;
          tabCycle.current = null;
          setOverlay({ cycle: null });
        }
        const handle = hitHandle(currentFrame(), screen, handleHitRadius);
        if (handle) {
          setOverlay({ cursor: handle.cursor, hoverId: null });
          return;
        }
        const hit = hitTest(state.doc, world, { tolerance: hitTolerance, includeLocked: true, scopeId: selectionScope(state.ui) });
        const target = hit ? selectableTarget(state.doc.elements, hit, false, selectionScope(state.ui)) : null;
        setOverlay({
          hoverId: target?.id ?? null,
          cursor: target && state.ui.selection.includes(target.id) && !isEffectivelyLocked(state.doc.elements, target.id) ? 'move' : null,
        });
        return;
      }

      switch (s.type) {
        case 'ink': {
          // Coalesced samples keep fast pen strokes smooth (the browser batches them per frame).
          const samples = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [];
          for (const sample of samples.length ? samples : [e.nativeEvent]) {
            s.points.push(toWorld(screenPoint(sample)));
            if (s.pressure.length) s.pressure.push(penPressure(sample) ?? s.pressure.at(-1)!);
          }
          setOverlay({ draft: inkDraft(s) });
          return;
        }
        case 'erase':
          eraseAlong(s, world);
          return;
        case 'pan': {
          setViewportDirect(store, {
            ...s.startViewport,
            x: s.startViewport.x + (screen.x - s.startScreen.x),
            y: s.startViewport.y + (screen.y - s.startScreen.y),
          });
          return;
        }
        case 'pending': {
          if (distance(screen, s.startScreen) < (e.pointerType === 'touch' ? TOUCH_TAP_SLOP_PX : e.pointerType === 'pen' ? PEN_TAP_SLOP_PX : DRAG_THRESHOLD_PX)) return;
          let ids = s.ids;
          let base = state.doc;
          if (e.altKey) {
            // Alt-drag moves a copy: duplicate in place first, then drag the clones.
            const result = executor.dispatchSync('duplicate-selection', { ids, offset: { x: 0, y: 0 } });
            if (result.ok && Array.isArray(result.value) && result.value.length > 0) {
              ids = result.value as string[];
              base = store.getState().doc;
            }
          }
          const frame = computeSelectionFrame(base, ids, state.ui.viewport);
          if (!frame) return;
          const single = ids.length === 1 ? base.elements[ids[0]!] : null;
          const anchor = single && single.kind !== 'group' ? applyToPoint(worldMatrix(base.elements, single), single.kind === 'line' ? { x: single.points[0]![0], y: single.points[0]![1] } : { x: 0, y: 0 }) : frame.bounds;
          // The nearest corner / end / midpoint of what is moved becomes the point that snaps.
          const exclude = new Set(ids.flatMap((id) => [id, ...descendantsOf(base.elements, id).map((child) => child.id)]));
          const reach = 14 / state.ui.viewport.zoom;
          let grab: Vec2 | undefined;
          for (const point of draftGeometry(base.elements).points) {
            if (!exclude.has(point.id) || point.kind === 'quadrant') continue;
            const d = distance(point.p, s.startWorld);
            if (d <= reach && (!grab || d < distance(grab, s.startWorld))) grab = point.p;
          }
          session.current = { type: 'move', startWorld: s.startWorld, base, ids, bounds: { ...frame.bounds, x: anchor.x, y: anchor.y }, ...(grab ? { grab } : {}), exclude };
          setOverlay({ dragging: true, cursor: 'move', hoverId: null });
          return;
        }
        case 'move': {
          const { command, input } = moveGestureInput(s, world, mods.shift, mods.alt);
          store.setState({ preview: executor.preview(command, input, s.base) });
          return;
        }
        case 'marquee': {
          const area = rectFromPoints(s.startWorld, world);
          // Left to right selects what is fully inside (window); right to left what it touches (crossing).
          const windowMode = world.x >= s.startWorld.x;
          const found = elementsInArea(state.doc, area, windowMode ? 'contain' : 'intersect', { scopeId: selectionScope(state.ui) }).map((el) => el.id);
          const ids = s.additive ? [...s.baseSelection, ...found] : found;
          dispatch('select', { ids });
          const viewport = state.ui.viewport;
          const a = { x: s.startWorld.x * viewport.zoom + viewport.x, y: s.startWorld.y * viewport.zoom + viewport.y };
          setOverlay({ marquee: rectFromPoints(a, screen), marqueeWindow: windowMode, dragging: true });
          return;
        }
        case 'resize': {
          const { command, input } = resizeInput(s, world, mods.shift, mods.alt, !mods.alt);
          store.setState({ preview: executor.preview(command, input, s.base) });
          return;
        }
        case 'rotate': {
          store.setState({ preview: executor.preview('rotate-selection', rotateInput(s, world, mods.shift), s.base) });
          return;
        }
        case 'draw-rect': {
          const result = drafting.snap(world, pointerInfo(mods), s.startWorld);
          const end = result.point;
          setOverlay({ draft: { kind: 'rect', rect: rectFromPoints(s.startWorld, end) }, snap: drafting.snapOverlay(result), dragging: true });
          return;
        }
        case 'endpoint': {
          const input = endpointInput(s, world, mods.alt);
          store.setState({ preview: executor.preview('move-line-endpoint', input, s.base) });
          return;
        }
        case 'curve-handle': {
          store.setState({ preview: executor.preview('move-line-curve-handle', curveHandleInput(s, world, mods.alt), s.base) });
          return;
        }
        case 'grip': {
          const grip = gripInput(s, world, mods);
          if (grip) {
            store.setState({ preview: executor.preview(grip.command, grip.input, s.base) });
            setOverlay({ snap: drafting.snapOverlay(grip.snap) });
          }
          return;
        }
        case 'window-resize': {
          const input = windowResizeInput(s, world, !mods.alt);
          if (input) store.setState({ preview: executor.preview('resize-window', input, s.base) });
          return;
        }
      }
    },
    [archPlacementAt, palm, clearLongPress, columnDraftAt, currentFrame, curveHandleInput, dispatch, drafting, endpointInput, eraseAlong, gripInput, executor, maybeSnap, moveGestureInput, pointerInfo, resizeInput, rotateInput, screenPoint, setOverlay, stairOverlay, store, toWorld, windowResizeInput],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (palm.up(e)) return;
      clearLongPress();
      activePointers.current.delete(e.pointerId);
      if (activePointers.current.size < 2) {
        pinchState.current = null;
      }
      if (aimPointer.current === e.pointerId) {
        // Place where the finger lifted: replay the tool's press there.
        aimPointer.current = null;
        replayingAim.current = true;
        try {
          pressRef.current?.(e);
        } finally {
          replayingAim.current = false;
          activePointers.current.delete(e.pointerId);
          clearLongPress();
        }
        touchModifiers.consumeOnce();
        return;
      }
      // A rectangle dragged out with the drafting rectangle tool completes on release.
      if (drafting.handles(store.getState().ui.tool)) drafting.up(toWorld(screenPoint(e)), pointerInfo(effectiveModifiers(e)));
      const s = session.current;
      if (!s) return;
      session.current = null;
      const screen = screenPoint(e);
      const world = toWorld(screen);
      const mods = effectiveModifiers(e);
      // The "once" toggles applied to this gesture; navigation does not use them up.
      if (s.type !== 'pan') touchModifiers.consumeOnce();
      setOverlay({ marquee: null, draft: null, panning: false, dragging: false });

      switch (s.type) {
        case 'ink': {
          const zoom = store.getState().ui.viewport.zoom;
          const thin = thinStroke(s.points, s.pressure, 1.5 / zoom);
          dispatch('create-ink', {
            points: thin.points.map((p) => [p.x, p.y]),
            pressure: thin.pressure,
            color: s.color,
            width: s.width,
            highlighter: s.highlighter,
          });
          return;
        }
        case 'erase':
          eraseAlong(s, world);
          if (s.ids.size) {
            const result = dispatch('erase-annotations', { ids: [...s.ids] });
            if (!result.ok) fadeOnBoard(containerRef.current, s.ids, false);
          }
          return;
        case 'pan':
          if (s.tapClears && distance(screen, s.startScreen) < TOUCH_TAP_SLOP_PX && store.getState().ui.selection.length > 0) dispatch('clear-selection');
          return;
        case 'pending':
          if (s.reselectOnClick) dispatch('select', { ids: [s.clickedId] });
          return;
        case 'move': {
          const { command, input } = moveGestureInput(s, world, mods.shift, mods.alt);
          clearPreview();
          setOverlay({ snap: null });
          if (command !== 'move-selection' || (input as { dx: number; dy: number }).dx !== 0 || (input as { dx: number; dy: number }).dy !== 0) {
            dispatch(command, input);
          }
          return;
        }
        case 'marquee':
          return;
        case 'resize': {
          const { command, input } = resizeInput(s, world, mods.shift, mods.alt, !mods.alt);
          clearPreview();
          dispatch(command, input);
          return;
        }
        case 'rotate': {
          const input = rotateInput(s, world, mods.shift);
          clearPreview();
          if (input.degrees !== 0) dispatch('rotate-selection', input);
          return;
        }
        case 'draw-rect': {
          const end = drafting.snap(world, pointerInfo(mods), s.startWorld).point;
          setOverlay({ snap: null });
          const dragged = distance(screenPoint(e), {
            x: s.startWorld.x * store.getState().ui.viewport.zoom + store.getState().ui.viewport.x,
            y: s.startWorld.y * store.getState().ui.viewport.zoom + store.getState().ui.viewport.y,
          });
          if (store.getState().ui.tool === 'parametric') {
            if (dragged <= DRAG_THRESHOLD_PX) return;
            const rect = rectFromPoints(s.startWorld, end);
            if (rect.width >= 100 && rect.height >= 100) dispatch('create-parametric-component', { ...rect, openEditor: false });
            return;
          }
          if (store.getState().ui.tool === 'arch:level') {
            const rect = dragged > DRAG_THRESHOLD_PX ? rectFromPoints(s.startWorld, end) : { ...s.startWorld, width: 6000, height: 4000 };
            if (store.getState().ui.profileEdit) {
              // In the profile mode the rectangle is a sketch loop; Finish makes the level.
              if (rect.width >= 100 && rect.height >= 100) {
                const { x, y, width, height } = rect;
                dispatch('create-line', { points: [[x, y], [x + width, y], [x + width, y + height], [x, y + height]], closed: true, style: PROFILE_SKETCH_STYLE, name: 'Boundary sketch' });
              }
              return;
            }
            if (rect.width >= 100 && rect.height >= 100) dispatch('create-level', { ...rect, planView: true });
            dispatch('set-tool', { tool: 'select' });
            return;
          }
          if (store.getState().ui.tool === 'paper') {
            if (dragged > DRAG_THRESHOLD_PX) {
              const rect = rectFromPoints(s.startWorld, end);
              if (rect.width >= 100 && rect.height >= 100) dispatch('create-paper', rect);
            } else dispatch('create-paper', { x: s.startWorld.x, y: s.startWorld.y });
            dispatch('set-tool', { tool: 'select' });
            return;
          }
          if (store.getState().ui.tool === 'view3d') {
            const rect = dragged > DRAG_THRESHOLD_PX ? rectFromPoints(s.startWorld, end) : { ...s.startWorld, width: 6000, height: 4000 };
            if (rect.width >= 100 && rect.height >= 100) dispatch('create-view3d', rect);
            dispatch('set-tool', { tool: 'select' });
            return;
          }
          const analysisTool = store.getState().ui.tool;
          if (analysisTool === 'noise-area-emitter') {
            const rect = rectFromPoints(s.startWorld, end);
            const originId = store.getState().ui.analysisTargetId;
            if (originId && dragged > DRAG_THRESHOLD_PX && rect.width >= 100 && rect.height >= 100)
              dispatch('create-noise-emitter', { originId, shape: 'area', x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, depth: rect.height });
            return;
          }
          if (analysisTool === 'analysis-sun' || analysisTool === 'analysis-wind' || analysisTool === 'analysis-noise') {
            if (dragged > DRAG_THRESHOLD_PX) {
              const rect = rectFromPoints(s.startWorld, end);
              if (rect.width >= 1 && rect.height >= 1) dispatch('create-analysis-origin', { kind: analysisTool.slice('analysis-'.length), ...rect });
            }
            dispatch('set-tool', { tool: 'select' });
            return;
          }
          if (store.getState().ui.tool === 'analysis-location') {
            const rect = dragged > DRAG_THRESHOLD_PX ? rectFromPoints(s.startWorld, end) : { ...s.startWorld, width: 200_000, height: 140_000 };
            if (rect.width >= 1000 && rect.height >= 1000) {
              const created = dispatch('create-location', rect);
              // Start where the user is (asks for location permission); stays at the default otherwise.
              if (created.ok) void executor.dispatch('locate-project', { id: created.value, onlyIfDefault: true });
              else if (created.error.code === 'unavailable') toasts.push({ kind: 'error', message: 'This project already has a location; select the existing map to edit it' });
            }
            dispatch('set-tool', { tool: 'select' });
            return;
          }
          if (store.getState().ui.tool === 'diagram:zone') {
            const rect = dragged > DRAG_THRESHOLD_PX ? rectFromPoints(s.startWorld, end) : { ...s.startWorld, width: 4000, height: 3000 };
            if (rect.width >= 10 && rect.height >= 10) dispatch('create-diagram', { kind: 'zone', ...rect });
            dispatch('set-tool', { tool: 'select' });
            return;
          }
          if (store.getState().ui.tool === 'ai-portal') {
            const rect = dragged > DRAG_THRESHOLD_PX ? rectFromPoints(s.startWorld, end) : { ...s.startWorld, width: 4000, height: 3000 };
            if (rect.width >= 100 && rect.height >= 100) dispatch('create-ai-portal', rect);
            dispatch('set-tool', { tool: 'select' });
            return;
          }
          const rect = dragged > DRAG_THRESHOLD_PX ? rectFromPoints(s.startWorld, end) : { ...s.startWorld, width: DEFAULT_RECT_SIZE, height: DEFAULT_RECT_SIZE };
          if (rect.width >= 1 && rect.height >= 1) dispatch('create-rect', rect);
          dispatch('set-tool', { tool: 'select' });
          return;
        }
        case 'endpoint': {
          const input = endpointInput(s, world, mods.alt);
          clearPreview();
          dispatch('move-line-endpoint', input);
          return;
        }
        case 'curve-handle': {
          const input = curveHandleInput(s, world, mods.alt);
          clearPreview();
          dispatch('move-line-curve-handle', input);
          return;
        }
        case 'grip': {
          const grip = gripInput(s, world, mods);
          clearPreview();
          setOverlay({ snap: null });
          if (grip && distance(world, s.startWorld) > 1e-6) dispatch(grip.command, grip.input);
          return;
        }
        case 'window-resize': {
          const input = windowResizeInput(s, world, !mods.alt);
          clearPreview();
          if (input && Math.abs(input.width - s.startWidth) > 1e-6) dispatch('resize-window', input);
          return;
        }
      }
    },
    [clearLongPress, palm, containerRef, curveHandleInput, dispatch, drafting, endpointInput, eraseAlong, gripInput, executor, moveGestureInput, pointerInfo, resizeInput, clearPreview, rotateInput, screenPoint, setOverlay, store, toasts, toWorld, windowResizeInput],
  );

  const onPointerCancel = useCallback((e?: ReactPointerEvent<HTMLDivElement>) => {
    if (e) palm.up(e);
    clearLongPress();
    aimPointer.current = null;
    activePointers.current.clear();
    pinchState.current = null;
    cancelSession();
  }, [cancelSession, clearLongPress, palm]);

  const onDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (drafting.finishPen(false)) return;
      if (polyline.current) {
        finishPolyline();
        return;
      }
      if (stair.current) {
        finishStair();
        return;
      }
      const state = store.getState();
      if (state.ui.tool !== 'select') return;
      const isTouch = typeof document !== 'undefined' && document.documentElement.getAttribute('data-touch') === 'true';
      const hitTolerance = (isTouch ? 14 : 6) / state.ui.viewport.zoom;
      const world = toWorld(screenPoint(e));
      const hit = hitTest(state.doc, world, { tolerance: hitTolerance, includeLocked: true, scopeId: selectionScope(state.ui) });
      if (!hit) {
        if (state.ui.groupEditId) dispatch('exit-group');
        return;
      }
      if (hit.meta?.['parametricMarker'] && hit.parentId && state.doc.elements[hit.parentId]?.meta?.['parametricGraph']) {
        dispatch('open-parametric-editor', { id: hit.parentId });
        return;
      }
      const initiallyTargeted = selectableTarget(state.doc.elements, hit, false, selectionScope(state.ui));
      if (initiallyTargeted.meta?.['parametricGraph']) {
        dispatch('open-parametric-editor', { id: initiallyTargeted.id });
        return;
      }
      // In sheet mode, double-clicking a view frame enters it to style what it shows.
      if (state.ui.sheet && !state.ui.sheet.viewEdit && sheetViewOf(initiallyTargeted)) {
        dispatch('enter-sheet-view', { id: initiallyTargeted.id });
        return;
      }
      // Double-clicking a paper sheet itself (not what is on it) opens it for sheet editing.
      if (!state.ui.sheet && hit.id === initiallyTargeted.id && hit.meta?.['paper']) {
        dispatch('open-sheet', { id: hit.id });
        return;
      }
      if (isEffectivelyLocked(state.doc.elements, initiallyTargeted.id)) {
        if (initiallyTargeted.id !== state.ui.selection[0]) dispatch('select', { ids: [initiallyTargeted.id] });
        return;
      }
      if (editableGroup(initiallyTargeted)) {
        dispatch('enter-group', { id: initiallyTargeted.id });
        return;
      }
      if (hit.kind === 'text' || stickyOf(hit)) {
        dispatch('begin-text-edit', { id: hit.id });
        return;
      }
      if (!state.ui.profileEdit && profileKindOf(initiallyTargeted)) {
        dispatch('begin-profile-edit', { id: initiallyTargeted.id });
        return;
      }
      // Double-clicking into a group selects the element underneath.
      const target = selectableTarget(state.doc.elements, hit, true, selectionScope(state.ui));
      if (target.id !== state.ui.selection[0]) dispatch('select', { ids: [target.id] });
    },
    [dispatch, drafting, finishPolyline, finishStair, screenPoint, store, toWorld],
  );

  const onContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      // Windows turns a pen's press-and-hold into a right-click: ignore it while a gesture (a
      // stroke, a drag) is going on, and whenever an annotation tool draws.
      const pointerType = (e.nativeEvent as PointerEvent).pointerType;
      if (session.current || (pointerType === 'pen' && store.getState().ui.tool.startsWith('annotate:'))) return;
      if (stair.current) {
        finishStair();
        return;
      }
      // Right-click finishes a modify tool's selection step (Revit).
      if (drafting.handles(store.getState().ui.tool) && drafting.doneSelecting()) return;
      const state = store.getState();
      const isTouch = typeof document !== 'undefined' && document.documentElement.getAttribute('data-touch') === 'true';
      const hitTolerance = (isTouch ? 14 : 6) / state.ui.viewport.zoom;
      const screen = screenPoint(e);
      const world = toWorld(screen);
      const hit = hitTest(state.doc, world, { tolerance: hitTolerance, includeLocked: true, scopeId: selectionScope(state.ui) });
      if (hit) {
        const target = selectableTarget(state.doc.elements, hit, false, selectionScope(state.ui));
        if (!state.ui.selection.includes(target.id)) dispatch('select', { ids: [target.id] });
      }
      options.onContextMenu({ x: e.clientX, y: e.clientY });
    },
    [dispatch, drafting, finishStair, options, screenPoint, store, toWorld],
  );

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const types = e.dataTransfer.types;
    if (types.includes('application/x-archai-asset') || types.includes('application/x-archai-definition') || types.includes('Files') || types.includes('application/x-archai-sheet-source') || types.includes(MATERIAL_DRAG_TYPE) || types.includes(LIBRARY_DRAG_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      // A material dropped on the board: take it in hand and paint in the 3D workspace.
      const droppedId = e.dataTransfer.getData(MATERIAL_DRAG_TYPE);
      const droppedEntry = e.dataTransfer.getData(LIBRARY_DRAG_TYPE);
      if (droppedId || droppedEntry) {
        const startPainting = (id: string) => {
          materialUi.set({ active: id, painting: true, picking: false });
          if (!store.getState().ui.view3d.open) void dispatch('open-view3d', {});
          toasts.push({ kind: 'info', message: 'Painting: click surfaces in 3D (Esc to stop)' });
        };
        if (droppedId) startPainting(droppedId);
        else void droppedMaterial(droppedEntry, (id, input) => executor.dispatch(id, input), store.getState().doc, platform).then(startPainting, (error: unknown) => toasts.push({ kind: 'error', message: error instanceof Error ? error.message : String(error) }));
        return;
      }
      const world = toWorld(screenPoint(e));
      // A view dragged from the sheet panel: placed with its top-left corner at the drop point.
      const sheetSource = e.dataTransfer.getData('application/x-archai-sheet-source');
      const openPaperId = store.getState().ui.sheet?.paperId;
      if (sheetSource && openPaperId) {
        const paper = store.getState().doc.elements[openPaperId];
        if (paper) {
          const scale = paperScaleOf(paper);
          const origin = worldBounds(store.getState().doc.elements, paper);
          dispatch('add-sheet-view', { paperId: openPaperId, sourceId: sheetSource, x: (world.x - origin.x) / scale, y: (world.y - origin.y) / scale });
        }
        return;
      }
      const definitionId = e.dataTransfer.getData('application/x-archai-definition');
      if (definitionId) {
        const definition = store.getState().doc.definitions[definitionId];
        if (!definition) return;
        const p = maybeSnap({ x: world.x - definition.width / 2, y: world.y - definition.height / 2 }, e.altKey);
        dispatch('create-asset-instance', { definitionId, x: p.x, y: p.y });
        return;
      }
      const assetJson = e.dataTransfer.getData('application/x-archai-asset');
      if (assetJson) {
        const parsed = CatalogAssetInput.safeParse(JSON.parse(assetJson));
        if (!parsed.success) return;
        const p = maybeSnap(world, e.altKey);
        void executor.dispatch('place-catalog-asset', { asset: parsed.data, x: p.x, y: p.y, centered: true }).then((r) => {
          if (!r.ok) toasts.push({ kind: 'error', message: r.error.message });
        });
        return;
      }
      // 3D files (with their companions: .mtl, textures, .bin) become a 3D model at the drop point.
      const dropped = [...e.dataTransfer.files];
      if (dropped.some((f) => MODEL_EXTENSION.test(f.name))) {
        void (async () => {
          const files = await Promise.all(dropped.map(async (f) => ({ name: f.name, data: bytesToBase64(new Uint8Array(await f.arrayBuffer())) })));
          const r = await executor.dispatch('import-3d-model', { files, x: world.x, y: world.y });
          if (r.ok && r.value) toasts.push({ kind: 'success', message: modelToast(r.value) });
          else if (!r.ok) toasts.push({ kind: 'error', message: r.error.message });
        })();
        return;
      }
      const file = dropped.find((f) => f.type.startsWith('image/'));
      if (file) {
        void (async () => {
          const bytes = new Uint8Array(await file.arrayBuffer());
          let size = { width: 0, height: 0 };
          try {
            const bitmap = await createImageBitmap(file);
            size = { width: bitmap.width, height: bitmap.height };
            bitmap.close();
          } catch {
            // unknown size; create-image falls back to a default
          }
          const { bytesToBase64 } = await import('@/persistence/base64');
          const p = maybeSnap(world, e.altKey);
          dispatch('create-image', {
            x: p.x,
            y: p.y,
            blob: { mime: file.type, data: bytesToBase64(bytes), width: size.width, height: size.height },
            name: file.name,
          });
        })();
      }
    },
    [dispatch, executor, maybeSnap, platform, screenPoint, store, toWorld, toasts],
  );

  // ---- wheel: zoom with ctrl/cmd (and trackpad pinch), otherwise pan ------------------------

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const state = store.getState();
      const rect = container.getBoundingClientRect();
      const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      // Ctrl / Cmd + wheel (and a trackpad pinch, which arrives as Ctrl + wheel) always zooms.
      // The plain wheel pans (trackpads) or, with the "zoom" setting (CAD mice), zooms; Shift +
      // wheel then still pans.
      const zooms = e.ctrlKey || e.metaKey || (preferences.get().wheel === 'zoom' && !e.shiftKey);
      // The view moves under the cursor: a Tab cycle there no longer applies.
      if (tabCycle.current) {
        tabCycle.current = null;
        setOverlay({ cycle: null });
      }
      if (zooms) {
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
        const next = zoomAt(state.ui.viewport, screen, factor);
        setViewportDirect(store, { x: next.x, y: next.y, zoom: next.zoom });
      } else {
        const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
        setViewportDirect(store, { ...state.ui.viewport, x: state.ui.viewport.x - dx, y: state.ui.viewport.y - dy });
      }
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [containerRef, store, dispatch, setOverlay]);

  // ---- keyboard: space to pan, escape/enter for gestures ------------------------------------

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (store.getState().ui.parametricEditor.open) return;
      if (isEditableTarget(e.target)) return;
      const activeTool = store.getState().ui.tool;
      // Tab / Shift+Tab over the board steps through the elements under the cursor (Revit).
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && activeTool === 'select' && !session.current && hoverScreen.current && containerRef.current?.matches(':hover')) {
        const state = store.getState();
        const screen = hoverScreen.current;
        let cycle = tabCycle.current;
        if (!cycle || distance(cycle.screen, screen) > 6) {
          const tolerance = (document.documentElement.getAttribute('data-touch') === 'true' ? 14 : 6) / state.ui.viewport.zoom;
          const candidates = cycleCandidates(state.doc, toWorld(screen), tolerance, selectionScope(state.ui) ?? null);
          if (!candidates.length) return;
          // Index 0 is what the hover already shows: the first Tab moves on from it.
          cycle = { screen, candidates, index: 0 };
          tabCycle.current = cycle;
        }
        e.preventDefault();
        e.stopPropagation();
        const count = cycle.candidates.length;
        cycle.index = (cycle.index + (e.shiftKey ? -1 : 1) + count) % count;
        const candidate = cycle.candidates[cycle.index]!;
        setOverlay({ hoverId: null, cursor: null, cycle: { ids: candidate.ids, label: `${candidate.label}  ${cycle.index + 1}/${count}`, at: screen } });
        return;
      }
      if (e.key === 'Escape' && tabCycle.current) {
        tabCycle.current = null;
        setOverlay({ cycle: null });
      }
      if (drafting.handles(activeTool) && !session.current) {
        if (drafting.key(e)) {
          e.stopPropagation();
          e.preventDefault();
          return;
        }
        if (e.key === 'Escape') {
          drafting.reset();
          dispatch('set-tool', { tool: 'select' });
          e.stopPropagation();
          return;
        }
      }
      // Typed values while drawing a line, wall or other polyline: 3000, 3000<30, 300,-150, #x,y.
      if (polyline.current && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const refreshPrompt = () => {
          const current = overlayRef.current.drafting;
          if (current?.prompt) setOverlay({ drafting: { ...current, prompt: { ...current.prompt, typed: polyTyped.current } } });
        };
        if (isTypedCharacter(e.key, polyTyped.current)) {
          polyTyped.current += e.key;
          refreshPrompt();
          e.stopPropagation();
          e.preventDefault();
          return;
        }
        if (polyTyped.current && (e.key === 'Backspace' || e.key === 'Escape')) {
          polyTyped.current = e.key === 'Escape' ? '' : polyTyped.current.slice(0, -1);
          refreshPrompt();
          e.stopPropagation();
          e.preventDefault();
          return;
        }
        if (polyTyped.current && e.key === 'Enter') {
          const text = polyTyped.current;
          polyTyped.current = '';
          const current = polyline.current;
          const last = current.points.at(-1);
          const value = parseTyped(text, store.getState().doc.workspace.unit);
          const point = value && last ? typedPoint(value, last, polyCursor.current ?? last) : value?.kind === 'absolute' ? { x: value.x, y: value.y } : null;
          if (!point) toasts.push({ kind: 'error', message: `Could not read “${text}”` });
          else {
            current.points.push(point);
            polyCursor.current = point;
            setOverlay({ draft: { kind: 'polyline', points: [...current.points], cursor: point, style: current.style } });
            if (TWO_POINT_TOOLS.has(current.toolId) && current.points.length === 2) finishPolyline();
          }
          refreshPrompt();
          e.stopPropagation();
          e.preventDefault();
          return;
        }
      }
      if (e.code === 'Space' && !e.repeat) {
        const currentTool = store.getState().ui.tool;
        if (currentTool !== 'select' && currentTool !== 'hand') return;
        spaceDown.current = true;
        spaceGesture.current = { previousTool: currentTool, pressedAt: performance.now(), panned: false };
        dispatch('set-tool', { tool: currentTool === 'select' ? 'hand' : 'select' });
        setOverlay({ panning: true });
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        if (session.current) {
          cancelSession();
          e.stopPropagation();
        } else if (polyline.current) {
          cancelPolyline();
          dispatch('set-tool', { tool: 'select' });
          e.stopPropagation();
        } else if (stair.current) {
          cancelStair();
          dispatch('set-tool', { tool: 'select' });
          e.stopPropagation();
        }
        return;
      }
      if (stair.current && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (e.shiftKey) redoStairFlight();
        else undoStairFlight();
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      if (stair.current && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        redoStairFlight();
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter' && polyline.current) {
        finishPolyline();
        e.stopPropagation();
        return;
      }
      if (e.key === 'Enter' && stair.current) {
        finishStair();
        e.stopPropagation();
        return;
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && stair.current) {
        undoStairFlight();
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      if ((e.key === 'l' || e.key === 'L') && stair.current && !e.ctrlKey && !e.metaKey) {
        addStairLanding();
        e.stopPropagation();
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (store.getState().ui.parametricEditor.open) return;
      if (e.code === 'Space') {
        const gesture = spaceGesture.current;
        spaceDown.current = false;
        spaceGesture.current = null;
        // A tap toggles persistently. Holding, or using Space to pan, restores the old tool.
        if (gesture && (gesture.panned || performance.now() - gesture.pressedAt >= 220)) {
          dispatch('set-tool', { tool: gesture.previousTool });
        }
        if (session.current?.type !== 'pan') setOverlay({ panning: false });
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    const onBlur = () => {
      const gesture = spaceGesture.current;
      spaceDown.current = false;
      spaceGesture.current = null;
      if (gesture) dispatch('set-tool', { tool: gesture.previousTool });
      setOverlay({ panning: false });
    };
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [addStairLanding, cancelPolyline, cancelSession, cancelStair, containerRef, dispatch, drafting, finishPolyline, finishStair, redoStairFlight, setOverlay, store, toasts, toWorld, undoStairFlight]);

  // Leaving a drawing tool via the toolbar or a shortcut abandons any half-drawn polyline or stair.
  useEffect(() => {
    return store.subscribe((state, previous) => {
      if (state.ui.tool !== previous.ui.tool && polyline.current && !isPolylineTool(state.ui.tool)) cancelPolyline();
      if (state.ui.tool !== previous.ui.tool && stair.current && state.ui.tool !== 'arch:stairs' && state.ui.tool !== 'arch:stair') cancelStair();
      if (state.ui.tool !== previous.ui.tool) {
        drafting.reset();
        polyTyped.current = '';
        setOverlay({ draft: null, snap: null, drafting: null });
      }
    });
  }, [cancelPolyline, cancelStair, drafting, setOverlay, store]);

  const handlers = useMemo<InteractionHandlers>(
    () => ({ onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onDoubleClick, onContextMenu, onDragOver, onDrop }),
    [onContextMenu, onDoubleClick, onDragOver, onDrop, onPointerCancel, onPointerDown, onPointerMove, onPointerUp],
  );

  // The aim replay calls the latest press handler.
  useEffect(() => {
    pressRef.current = onPointerDown;
  }, [onPointerDown]);

  /** Removes the last placed point; removing the first abandons the drawing. */
  const undoPolylinePoint = useCallback(() => {
    const current = polyline.current;
    if (!current) return;
    current.points.pop();
    const last = current.points.at(-1);
    if (!last) {
      cancelPolyline();
      return;
    }
    setOverlay({ draft: { kind: 'polyline', points: [...current.points], cursor: last, style: current.style } });
  }, [cancelPolyline, setOverlay]);

  /** Keyboard-free stand-ins for Enter, Esc and Backspace while drawing (the touch action bar). */
  const drawingActions = useMemo(
    () => ({
      finish: () => (polyline.current ? finishPolyline() : stair.current ? finishStair() : undefined),
      cancel: () => {
        if (polyline.current) cancelPolyline();
        else if (stair.current) cancelStair();
        else cancelSession();
      },
      undoPoint: () => (polyline.current ? undoPolylinePoint() : stair.current ? undoStairFlight() : undefined),
      /** Continues a modify tool from its selection step (the banner's Done). */
      doneSelecting: () => void drafting.doneSelecting(),
    }),
    [cancelPolyline, cancelSession, cancelStair, drafting, finishPolyline, finishStair, undoPolylinePoint, undoStairFlight],
  );

  return { overlay, handlers, drawingActions };
}

export type { Element };

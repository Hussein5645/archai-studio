import type { Patch } from 'immer';
import type { CatalogAsset, SystemAssetType } from '@/catalog';
import type { ArchaiDocument } from '@/document';
import { DEFAULT_OSNAP, type OsnapSettings } from '@/drafting/osnap';

/** screen = world · zoom + (x, y) */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export type ToolId =
  | 'select' | 'hand' | 'rect' | 'line' | 'point' | 'text' | 'image' | 'model' | 'measure' | 'catalog' | 'view3d' | 'section' | 'camera' | 'paper' | 'ai-portal' | 'parametric'
  | 'analysis-sun' | 'analysis-wind' | 'analysis-noise' | 'analysis-location' | 'noise-emitter'
  | `arch:${string}`
  | `diagram:${string}`
  /** Drafting shapes: circle, arc, polygon, ellipse (src/drafting). */
  | `draw:${string}`
  /** Edit tools: move, copy, rotate, mirror, scale, array, offset, trim, extend, split, fillet. */
  | `modify:${string}`
  /** Board annotations: pen, highlighter, eraser, sticky (src/annotations). */
  | `annotate:${string}`;

/** Options of the drafting and edit tools (the options bar), and object snapping. */
export interface DraftingOptions {
  osnap: OsnapSettings;
  circleMode: 'center' | '2p' | '3p';
  arcMode: 'three-point' | 'center' | 'tangent';
  polygonSides: number;
  polygonCircumscribed: boolean;
  /** Corner radius given to new rectangles (mm). */
  rectRadius: number;
  /** Copy: how many copies are placed along the picked offset. */
  copies: number;
  /** Rotate / mirror / scale keep the originals and add the result as copies. */
  keepOriginal: boolean;
  mirrorKeepOriginal: boolean;
  arrayKind: 'linear' | 'polar';
  arrayCount: number;
  /** Polar array: the angle filled by the copies (360 = a full turn). */
  arrayAngle: number;
  /** Offset distance (mm). */
  offset: number;
  trimMode: 'corner' | 'segment';
  filletMode: 'fillet' | 'chamfer';
  filletSize: number;
}

export const DEFAULT_DRAFTING: DraftingOptions = {
  osnap: DEFAULT_OSNAP,
  circleMode: 'center',
  arcMode: 'three-point',
  polygonSides: 6,
  polygonCircumscribed: false,
  rectRadius: 0,
  copies: 1,
  keepOriginal: false,
  mirrorKeepOriginal: true,
  arrayKind: 'linear',
  arrayCount: 4,
  arrayAngle: 360,
  offset: 200,
  trimMode: 'corner',
  filletMode: 'fillet',
  filletSize: 300,
};

export interface UiState {
  viewport: Viewport;
  /** Size of the workboard in CSS pixels; kept current by the renderer. */
  canvasSize: { width: number; height: number };
  selection: string[];
  /** Transient group isolation context; nested paths follow document parents. */
  groupEditId: string | null;
  tool: ToolId;
  editingTextId: string | null;
  panels: { left: boolean; inspector: boolean; leftTab: 'layers' | 'assets' | 'materials' };
  /** R2-backed appearances selected for built-in door/window placement tools. */
  systemAssets: Partial<Record<SystemAssetType, CatalogAsset>>;
  /** Regular catalog asset currently following the pointer before placement. */
  placingAsset: CatalogAsset | null;
  paletteOpen: boolean;
  /** "Create .CAI asset" name prompt (the asset is then modeled in its own window). */
  assetNamePrompt: boolean;
  /** New/open file prompt: asks for a name and whether to save a copy of the current file first. */
  documentPrompt: 'new' | 'open' | null;
  /** Main application view: 'home' for landing page dashboard, 'project' for document editor. */
  screen: 'home' | 'project';
  /** Save template prompt dialog state. */
  templateSavePrompt: boolean;
  /** Create project with template prompt dialog state. */
  templateCreatePrompt: boolean;
  /** Full-screen 3D workspace, opened from a 3D view portal on the board. */
  view3d: { open: boolean; portalId: string | null };
  /** Element graphics dialog; `type` is the graphic type it opens on. */
  graphicsDialog: { open: boolean; type: string | null; elementId: string | null };
  parametricEditor: { open: boolean; elementId: string | null };
  /** Export dialog, opened on a paper sheet. */
  exportDialog: { open: boolean; paperId: string | null };
  d5ImportOpen: boolean;
  /** Sheet mode: a paper edited full screen, and the board viewport to return to. */
  sheet: { paperId: string; returnViewport: Viewport; /** A view frame entered for styling, and the elements picked in it. */ viewEdit?: { frameId: string; picked: string[] } | null } | null;
  /** Noise origin that the noise-emitter tool adds sources to. */
  analysisTargetId: string | null;
  drafting: DraftingOptions;
  /** The last drawing / modify tool used, for Enter = repeat (Revit). */
  lastTool: ToolId | null;
  /**
   * What the active drafting / modify tool asks for next (the banner above the board): select
   * objects, pick a curve, or pick points. Written by the interaction layer, never recorded.
   */
  toolPrompt: ToolPrompt | null;
  /**
   * Profile (boundary) drawing mode for floors, ceilings and levels (Revit's sketch mode): the
   * board's line tools draw a closed loop, Finish turns it into the element. Never recorded.
   */
  profileEdit: ProfileEdit | null;
  /** Board annotation tools: pen / highlighter / sticky options and the layer they draw into. */
  annotation: AnnotationOptions;
}

export interface AnnotationOptions {
  penColor: string;
  /** Pen width in screen pixels at the zoom the stroke is drawn at. */
  penSize: number;
  highlighterColor: string;
  highlighterSize: number;
  stickyColor: string;
  /** Use pen pressure for the stroke width. */
  pressure: boolean;
  /** The annotation layer new strokes and notes go into; null picks the top one (or makes one). */
  layerId: string | null;
}

export const DEFAULT_ANNOTATION: AnnotationOptions = {
  penColor: '#1f2024',
  penSize: 4,
  highlighterColor: '#fde047',
  highlighterSize: 24,
  stickyColor: '#fef08a',
  pressure: true,
  layerId: null,
};

export type ProfileKind = 'floor' | 'ceiling' | 'level';

export interface ProfileEdit {
  kind: ProfileKind;
  /** The element whose boundary is edited; null creates a new one. */
  targetId: string | null;
  /** Elements that existed when the mode started: anything drawn since belongs to the profile. */
  startIds: string[];
}

export interface ToolPrompt {
  phase: 'select' | 'pick' | 'point';
  text: string;
  /** Selection phase: how many objects are selected so far. */
  count?: number;
}

export interface HistoryEntry {
  id: string;
  label: string;
  commandId: string;
  input: unknown;
  patches: Patch[];
  inversePatches: Patch[];
  selectionBefore: string[];
  selectionAfter: string[];
  at: string;
}

export interface HistoryState {
  past: HistoryEntry[];
  future: HistoryEntry[];
}

/** Per-open-document, transient. */
export interface SessionState {
  filePath: string | null;
  dirty: boolean;
  savedAt: string | null;
}

export interface AppState {
  doc: ArchaiDocument;
  /**
   * Live result of an in-progress gesture (drag, resize, rotate): the gesture's command applied
   * to `doc`, which stays the untouched base until the command commits on release. Only views
   * that follow the pointer draw it (see `boardDoc`), so panels, autosave and 3D thumbnails don't
   * react to every pointermove. Committing any document change clears it.
   */
  preview: ArchaiDocument | null;
  ui: UiState;
  history: HistoryState;
  session: SessionState;
}

/** The document as the board draws it: a gesture's live preview while one is in progress. */
export function boardDoc(state: AppState): ArchaiDocument {
  return state.preview ?? state.doc;
}

export const HISTORY_LIMIT = 200;

export const DEFAULT_VIEWPORT: Viewport = { x: 240, y: 160, zoom: 0.06 };

export function createInitialUi(): UiState {
  return {
    screen: 'home',
    templateSavePrompt: false,
    templateCreatePrompt: false,
    viewport: { ...DEFAULT_VIEWPORT },
    canvasSize: { width: 1200, height: 800 },
    selection: [],
    groupEditId: null,
    tool: 'select',
    editingTextId: null,
    panels: { left: true, inspector: true, leftTab: 'layers' },
    systemAssets: {},
    placingAsset: null,
    paletteOpen: false,
    assetNamePrompt: false,
    documentPrompt: null,
    view3d: { open: false, portalId: null },
    graphicsDialog: { open: false, type: null, elementId: null },
    parametricEditor: { open: false, elementId: null },
    exportDialog: { open: false, paperId: null },
    d5ImportOpen: false,
    sheet: null,
    analysisTargetId: null,
    lastTool: null,
    toolPrompt: null,
    profileEdit: null,
    drafting: { ...DEFAULT_DRAFTING, osnap: { ...DEFAULT_DRAFTING.osnap, kinds: { ...DEFAULT_DRAFTING.osnap.kinds } } },
    annotation: { ...DEFAULT_ANNOTATION },
  };
}

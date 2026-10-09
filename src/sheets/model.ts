/**
 * Sheets: a paper (see commands/builtin/views.ts) edited full screen, holding sheet items as its
 * children. Everything lives in element `meta`, so it saves, undoes and syncs like any element:
 * - `meta.sheetView`: a view frame, a window onto a plan (a level), a board area or a 3D /
 *   section / camera view, drawn at its own scale;
 * - `meta.titleBlock`: the sheet's title block, reading the paper's title, number and scale live;
 * - `meta.scaleBar` / `meta.northArrow`: annotation that follows a view frame's scale.
 */
import type { ArchaiDocument, Element, ElementTable, JsonValue } from '@/document';
import { worldBounds, worldMatrix, type Rect } from '@/geometry';
import { layerChildrenOf, layerPaintOrder } from '@/layers/hierarchy';
import { viewRigKind } from '@/layers/viewRig';
import { isBoardOnly } from '@/annotations/model';

export type SheetViewSource = 'plan' | 'board' | 'view';

export interface SheetViewMeta {
  /** `plan`: a level's elements (vector); `board`: everything in the crop (vector); `view`: a 3D portal (raster). */
  source: SheetViewSource;
  /** Level id (plan) or view portal id (view); null for a board area. */
  sourceId: string | null;
  /** What the frame shows, in board millimetres (world). */
  crop: Rect;
  /** Drawing scale of this view (1:100 → 100). */
  scale: number;
  title: string;
  /** Drawing number on the sheet ("1", "A"). */
  number: string;
  showTitle: boolean;
  /** Per-element styling in this view only, keyed by board element id (the model is untouched). */
  overrides: Record<string, ViewOverride>;
  adjustments: ViewAdjustments;
  /** 3D / section / camera frames: the render style used for this view (null: the source's own). */
  style: FrameStyle | null;
}

/** How one element looks in one view frame. Every field is optional; absent means "as drawn". */
export interface ViewOverride {
  /** Fill / surface colour. */
  fill?: string;
  /** Line colour (vector frames). */
  stroke?: string;
  /** Line weight in printed millimetres (vector frames). */
  weight?: number;
  opacity?: number;
  /** `ghost`: faint grey; `hidden`: not drawn. */
  visibility?: 'ghost' | 'hidden';
  emphasis?: 'outline' | 'glow' | 'shadow';
  /** Colour of the emphasis (default red). */
  accent?: string;
  /** Raised by this many millimetres (3D frames: exploded axonometrics). */
  lift?: number;
  label?: string;
}

/** Whole-view image adjustments, as in image software. Neutral values change nothing. */
export interface ViewAdjustments {
  brightness: number;
  contrast: number;
  saturation: number;
  /** Multiply tint (duotone-like) and its strength 0..1. */
  tint: string | null;
  tintAmount: number;
  /** Frame background; null keeps the source's. */
  background: string | null;
  /** Paper grain 0..1. */
  grain: number;
  /** Elements without an override are ghosted ("pop out" what is styled). */
  fadeOthers: boolean;
}

/** The part of a view frame that styles its content. */
export type FrameStyling = Pick<SheetViewMeta, 'overrides' | 'adjustments' | 'style'>;

export const FRAME_STYLES = ['realistic', 'shaded', 'consistent', 'hidden-line', 'wireframe'] as const;
export type FrameStyle = (typeof FRAME_STYLES)[number];

export const NEUTRAL_ADJUSTMENTS: ViewAdjustments = { brightness: 1, contrast: 1, saturation: 1, tint: null, tintAmount: 0.35, background: null, grain: 0, fadeOthers: false };

export const GHOST = { fill: '#eceef1', stroke: '#b9bec7', opacity: 0.55 } as const;
export const DEFAULT_ACCENT = '#e11d48';

export function isNeutral(adjustments: ViewAdjustments): boolean {
  return adjustments.brightness === 1 && adjustments.contrast === 1 && adjustments.saturation === 1 && !(adjustments.tint && adjustments.tintAmount > 0) && adjustments.grain === 0;
}

/** What actually applies to an element in a view: its override, or a ghost when others fade. */
export function effectiveOverride(view: FrameStyling, id: string): ViewOverride | null {
  const own = view.overrides[id];
  if (own) return own;
  return view.adjustments.fadeOthers ? { visibility: 'ghost' } : null;
}

function parseOverride(value: unknown): ViewOverride | null {
  const o = record(value);
  if (!o) return null;
  const out: ViewOverride = {};
  if (typeof o['fill'] === 'string') out.fill = o['fill'];
  if (typeof o['stroke'] === 'string') out.stroke = o['stroke'];
  if (typeof o['weight'] === 'number' && o['weight'] > 0) out.weight = o['weight'];
  if (typeof o['opacity'] === 'number') out.opacity = Math.max(0, Math.min(1, o['opacity']));
  if (o['visibility'] === 'ghost' || o['visibility'] === 'hidden') out.visibility = o['visibility'];
  if (o['emphasis'] === 'outline' || o['emphasis'] === 'glow' || o['emphasis'] === 'shadow') out.emphasis = o['emphasis'];
  if (typeof o['accent'] === 'string') out.accent = o['accent'];
  if (typeof o['lift'] === 'number' && Number.isFinite(o['lift'])) out.lift = o['lift'];
  if (typeof o['label'] === 'string' && o['label']) out.label = o['label'];
  return Object.keys(out).length > 0 ? out : null;
}

function parseAdjustments(value: unknown): ViewAdjustments {
  const a = record(value) ?? {};
  const num = (key: keyof ViewAdjustments, min: number, max: number) => {
    const v = a[key];
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : (NEUTRAL_ADJUSTMENTS[key] as number);
  };
  return {
    brightness: num('brightness', 0.2, 2),
    contrast: num('contrast', 0.2, 2),
    saturation: num('saturation', 0, 2),
    tint: typeof a['tint'] === 'string' ? a['tint'] : null,
    tintAmount: num('tintAmount', 0, 1),
    background: typeof a['background'] === 'string' ? a['background'] : null,
    grain: num('grain', 0, 1),
    fadeOthers: a['fadeOthers'] === true,
  };
}

export interface TitleBlockMeta {
  project: string;
  client: string;
  drawnBy: string;
  checkedBy: string;
  date: string;
  revision: string;
}

export interface ScaleBarMeta {
  /** View frame whose scale the bar follows; null follows the paper's scale. */
  frameId: string | null;
}

export interface NorthArrowMeta {
  /** Clockwise degrees from sheet-up to north. */
  rotation: number;
}

export const DRAWING_SCALES = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 200, 250, 500, 1000, 1250, 2000, 2500, 5000];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function sheetViewOf(element: Element | undefined | null): SheetViewMeta | null {
  const meta = record(element?.meta?.['sheetView']);
  if (!meta) return null;
  const crop = record(meta['crop']);
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    source: meta['source'] === 'plan' || meta['source'] === 'view' ? meta['source'] : 'board',
    sourceId: typeof meta['sourceId'] === 'string' ? meta['sourceId'] : null,
    crop: { x: num(crop?.['x'], 0), y: num(crop?.['y'], 0), width: Math.max(1, num(crop?.['width'], 1000)), height: Math.max(1, num(crop?.['height'], 1000)) },
    scale: num(meta['scale'], 100) > 0 ? num(meta['scale'], 100) : 100,
    title: text(meta['title'], 'View'),
    number: text(meta['number']),
    showTitle: meta['showTitle'] !== false,
    overrides: Object.fromEntries(Object.entries(record(meta['overrides']) ?? {}).flatMap(([id, value]) => {
      const parsed = parseOverride(value);
      return parsed ? [[id, parsed]] : [];
    })),
    adjustments: parseAdjustments(meta['adjustments']),
    style: (FRAME_STYLES as readonly string[]).includes(meta['style'] as string) ? (meta['style'] as FrameStyle) : null,
  };
}

export function titleBlockOf(element: Element | undefined | null): TitleBlockMeta | null {
  const meta = record(element?.meta?.['titleBlock']);
  if (!meta) return null;
  return { project: text(meta['project']), client: text(meta['client']), drawnBy: text(meta['drawnBy']), checkedBy: text(meta['checkedBy']), date: text(meta['date']), revision: text(meta['revision']) };
}

export function scaleBarOf(element: Element | undefined | null): ScaleBarMeta | null {
  const meta = record(element?.meta?.['scaleBar']);
  return meta ? { frameId: typeof meta['frameId'] === 'string' ? meta['frameId'] : null } : null;
}

export function northArrowOf(element: Element | undefined | null): NorthArrowMeta | null {
  const meta = record(element?.meta?.['northArrow']);
  return meta ? { rotation: typeof meta['rotation'] === 'number' ? meta['rotation'] : 0 } : null;
}

export function isSheetItem(element: Element | undefined | null): boolean {
  const meta = element?.meta;
  return Boolean(meta && (meta['sheetView'] || meta['titleBlock'] || meta['scaleBar'] || meta['northArrow'] || meta['chart']));
}

export const CHART_KINDS = ['sun-path', 'wind-rose', 'legend', 'table'] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

/** One row of a stored summary table (see analysis/dataExport.ts). */
export interface ChartTableRow {
  name: string;
  kind: string;
  min: number;
  mean: number;
  max: number;
  share: number;
}

/**
 * An analysis chart on a sheet: a sun path, wind rose or colour legend drawn live from its
 * analysis origin, or a summary table stored when it was made (the samples need the 3D view).
 */
export interface ChartMeta {
  kind: ChartKind;
  originId: string | null;
  title: string;
  unit: string;
  threshold: number;
  rows: ChartTableRow[];
}

export function chartOf(element: Element | undefined | null): ChartMeta | null {
  const meta = record(element?.meta?.['chart']);
  if (!meta || !(CHART_KINDS as readonly unknown[]).includes(meta['kind'])) return null;
  return {
    kind: meta['kind'] as ChartKind,
    originId: typeof meta['originId'] === 'string' ? meta['originId'] : null,
    title: text(meta['title']),
    unit: text(meta['unit']),
    threshold: typeof meta['threshold'] === 'number' ? meta['threshold'] : 0,
    rows: Array.isArray(meta['rows']) ? (meta['rows'] as unknown as ChartTableRow[]) : [],
  };
}

export function asJson<T>(value: T): JsonValue {
  return value as unknown as JsonValue;
}

/** The paper an element sits on (itself if it is one). */
export function paperAncestor(elements: ElementTable, element: Element | undefined | null): Element | null {
  let current = element ?? null;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (record(current.meta?.['paper'])) return current;
    seen.add(current.id);
    current = current.parentId ? (elements[current.parentId] ?? null) : null;
  }
  return null;
}

export function paperScaleOf(element: Element | null): number {
  const scale = record(element?.meta?.['paper'])?.['scale'];
  return typeof scale === 'number' && scale > 0 ? scale : 50;
}

/** A paper and everything painted under it in Layers (what sheet mode shows). */
export function sheetSubtree(elements: ElementTable, paperId: string): Set<string> {
  const ids = new Set<string>();
  const visit = (id: string) => {
    if (ids.has(id) || !elements[id]) return;
    ids.add(id);
    for (const child of layerChildrenOf(elements, id)) visit(child);
  };
  visit(paperId);
  return ids;
}

/** Board element kinds a vector view frame never redraws: sheets, frames, portals, rigs and level extents. */
function isViewInfrastructure(element: Element): boolean {
  const meta = element.meta;
  return Boolean(meta && (meta['paper'] || meta['view3d'] || meta['aiPortal'] || meta['level'] || meta['planRegion'] || meta['analysis'] || meta['location'] || isSheetItem(element))) || viewRigKind(element) !== null;
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

const contentCache = new WeakMap<ElementTable, Map<string, string[]>>();

/**
 * Ids a vector frame redraws, in board paint order: a level plan shows the level's own elements
 * (levels share plan coordinates, so the crop alone would mix floors); a board area shows
 * whatever lies in the crop. Anything on a paper, and view infrastructure, is left out.
 */
export function frameContentIds(elements: ElementTable, view: Pick<SheetViewMeta, 'source' | 'sourceId' | 'crop'>): string[] {
  if (view.source === 'view') return [];
  const key = `${view.source}|${view.sourceId ?? ''}|${view.crop.x}|${view.crop.y}|${view.crop.width}|${view.crop.height}`;
  let cache = contentCache.get(elements);
  if (!cache) {
    cache = new Map();
    contentCache.set(elements, cache);
  }
  const cached = cache.get(key);
  if (cached) return cached;

  let allowed: Set<string> | null = null;
  if (view.source === 'plan' && view.sourceId && elements[view.sourceId]) {
    allowed = new Set();
    const visit = (id: string) => {
      for (const child of layerChildrenOf(elements, id)) {
        if (allowed!.has(child)) continue;
        const element = elements[child];
        if (!element || isViewInfrastructure(element)) continue;
        allowed!.add(child);
        visit(child);
      }
    };
    visit(view.sourceId);
  }
  const onPaper = new Set<string>();
  for (const element of Object.values(elements)) if (record(element.meta?.['paper'])) for (const id of sheetSubtree(elements, element.id)) onPaper.add(id);

  const ids = layerPaintOrder(elements).filter((id) => {
    const element = elements[id];
    if (!element || onPaper.has(id) || isViewInfrastructure(element) || isBoardOnly(elements, id)) return false;
    if (allowed && !allowed.has(id)) return false;
    try {
      return intersects(worldBounds(elements, element), view.crop);
    } catch {
      return false;
    }
  });
  cache.set(key, ids);
  return ids;
}

export interface SheetSource {
  kind: 'plan' | 'section' | 'camera' | '3d';
  /** Level id for plans; portal id for views. */
  id: string;
  name: string;
  /** Default crop in board millimetres. */
  crop: Rect;
}

/** Everything that can be placed on a sheet: level plans (vector) and 3D/section/camera views. */
export function sheetSources(doc: ArchaiDocument): SheetSource[] {
  const elements = doc.elements;
  const sources: SheetSource[] = [];
  for (const element of Object.values(elements)) {
    if (element.kind !== 'rect') continue;
    if (record(element.meta?.['level'])) {
      // A level plan's region (its crop) when it has one, else the level extent.
      const region = Object.values(elements).find((candidate) => record(candidate.meta?.['planRegion'])?.['levelId'] === element.id);
      sources.push({ kind: 'plan', id: element.id, name: `${element.name ?? 'Level'} plan`, crop: worldBounds(elements, region ?? element) });
      continue;
    }
    const view = record(element.meta?.['view3d']);
    if (!view || paperAncestor(elements, element)) continue;
    const kind = view['sectionLineId'] ? 'section' : view['cameraId'] || view['cameraMode'] ? 'camera' : view['planRegionId'] ? 'plan' : '3d';
    // A level plan portal is already offered as a vector plan.
    if (kind === 'plan') continue;
    const matrix = worldMatrix(elements, element);
    sources.push({ kind, id: element.id, name: element.name ?? 'View', crop: { x: matrix[4], y: matrix[5], width: element.width, height: element.height } });
  }
  const order = { plan: 0, section: 1, camera: 2, '3d': 3 } as const;
  return sources.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
}

/** A round length (1, 2, 5 × 10ⁿ) not above `max`. */
export function niceLength(max: number): number {
  if (!(max > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  const n = max / power;
  return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * power;
}

/** Frame size on the board for a crop at a view scale on a paper at `paperScale`. */
export function frameSize(crop: Rect, viewScale: number, paperScale: number): { width: number; height: number } {
  const k = paperScale / viewScale;
  return { width: crop.width * k, height: crop.height * k };
}

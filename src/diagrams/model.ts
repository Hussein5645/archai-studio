/**
 * Presentation diagramming on the board and on sheets. Diagram elements are ordinary lines and
 * rects carrying `meta.diagram`, so they select, move, undo, save and export like anything else:
 * - lines: `arrow`, `connector` (glued to elements, straight/curved/orthogonal), `callout`
 *   (leader and note), `dimension` (chained dimension string), `adjacency` (bubble-diagram link);
 * - rects: `zone` (soft area/bubble with a label and area), `tag` (live label of an element).
 * Pens and text are specified in printed millimetres and drawn at the scale of the sheet they
 * sit on (1:100 on the open board), so a diagram prints the same at any scale. Colours default
 * to the document's diagram theme.
 */
import type { ArchaiDocument, Element, ElementTable, JsonValue } from '@/document';
import { isArchType, archOf } from '@/assets/arch-meta';
import { applyToPoint, invert, worldBounds, worldMatrix, type Rect, type Vec2 } from '@/geometry';
import { paperAncestor, paperScaleOf } from '@/sheets/model';

export const DIAGRAM_LINE_KINDS = ['arrow', 'connector', 'callout', 'dimension', 'adjacency'] as const;
export const DIAGRAM_BOX_KINDS = ['zone', 'tag'] as const;
export const DIAGRAM_KINDS = [...DIAGRAM_LINE_KINDS, ...DIAGRAM_BOX_KINDS] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

export const ARROW_HEADS = ['none', 'arrow', 'open', 'dot', 'bar'] as const;
export type ArrowHead = (typeof ARROW_HEADS)[number];
export const ROUTES = ['straight', 'curved', 'orthogonal'] as const;
export type Route = (typeof ROUTES)[number];
export const ZONE_SHAPES = ['rounded', 'ellipse', 'rect'] as const;
export type ZoneShape = (typeof ZONE_SHAPES)[number];

export interface DiagramMeta {
  kind: DiagramKind;
  /** Pen colour; null follows the theme. */
  color: string | null;
  /** Fill of zones and tags; null follows the theme. */
  fill: string | null;
  /** Pen weight in printed millimetres; null follows the theme. */
  weight: number | null;
  dashed: boolean;
  /** Heads at the end / start of line kinds. */
  head: ArrowHead;
  tail: ArrowHead;
  route: Route;
  /** Connector / adjacency ends glued to elements. */
  from: string | null;
  to: string | null;
  /** Callout note, zone label, adjacency label; tag template (`{name}`, `{area}`, `{level}`, `{type}`). */
  text: string;
  shape: ZoneShape;
  showArea: boolean;
  /** Tag: the element it labels. */
  target: string | null;
  /** Dimension: offset of the dimension line from the measured points, printed mm (sign = side). */
  offset: number;
}

export const DIAGRAM_THEMES = ['technical', 'soft', 'mono', 'bold'] as const;
export type DiagramTheme = (typeof DIAGRAM_THEMES)[number];

export interface ThemeSpec {
  label: string;
  ink: string;
  accent: string;
  /** Zone fills, picked by label so equal labels match. */
  palette: readonly string[];
  zoneOpacity: number;
  /** Printed millimetres. */
  pen: number;
  text: number;
  corner: number;
  fontWeight: number;
}

export const THEMES: Record<DiagramTheme, ThemeSpec> = {
  technical: { label: 'Technical', ink: '#1f2024', accent: '#1f2024', palette: ['#e5e7eb', '#d1d5db', '#f3f4f6', '#e2e8f0'], zoneOpacity: 0.6, pen: 0.25, text: 2.5, corner: 0, fontWeight: 500 },
  soft: { label: 'Soft', ink: '#475569', accent: '#6366f1', palette: ['#c7d2fe', '#bbf7d0', '#fde68a', '#fecaca', '#bae6fd', '#e9d5ff', '#fed7aa'], zoneOpacity: 0.55, pen: 0.35, text: 2.8, corner: 6, fontWeight: 500 },
  mono: { label: 'Mono', ink: '#111111', accent: '#111111', palette: ['#d4d4d4', '#a3a3a3', '#e5e5e5', '#bdbdbd'], zoneOpacity: 0.5, pen: 0.3, text: 2.5, corner: 3, fontWeight: 600 },
  bold: { label: 'Bold', ink: '#0f172a', accent: '#e11d48', palette: ['#fb7185', '#38bdf8', '#facc15', '#4ade80', '#a78bfa', '#fb923c'], zoneOpacity: 0.45, pen: 0.5, text: 3.2, corner: 4, fontWeight: 700 },
};

export const DEFAULT_DIAGRAM: Omit<DiagramMeta, 'kind'> = {
  color: null,
  fill: null,
  weight: null,
  dashed: false,
  head: 'none',
  tail: 'none',
  route: 'straight',
  from: null,
  to: null,
  text: '',
  shape: 'rounded',
  showArea: false,
  target: null,
  offset: 8,
};

/** Defaults per kind (what a new element of that kind starts with). */
export function diagramDefaults(kind: DiagramKind): DiagramMeta {
  const base: DiagramMeta = { ...DEFAULT_DIAGRAM, kind };
  switch (kind) {
    case 'arrow':
      return { ...base, head: 'arrow' };
    case 'connector':
      return { ...base, head: 'arrow', route: 'orthogonal' };
    case 'callout':
      return { ...base, tail: 'dot', text: 'Note' };
    case 'dimension':
      return { ...base, head: 'bar', tail: 'bar' };
    case 'adjacency':
      return { ...base, dashed: true };
    case 'zone':
      return { ...base, text: 'Zone', showArea: true };
    case 'tag':
      return { ...base, text: '{name}' };
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function diagramOf(element: Element | undefined | null): DiagramMeta | null {
  const meta = record(element?.meta?.['diagram']);
  const kind = meta?.['kind'];
  if (!meta || !(DIAGRAM_KINDS as readonly unknown[]).includes(kind)) return null;
  const base = diagramDefaults(kind as DiagramKind);
  const pick = <T>(key: keyof DiagramMeta, valid: (v: unknown) => boolean): T => (valid(meta[key]) ? meta[key] : base[key]) as T;
  const str = (v: unknown) => typeof v === 'string';
  const strOrNull = (v: unknown) => typeof v === 'string' || v === null;
  return {
    kind: kind as DiagramKind,
    color: pick('color', strOrNull),
    fill: pick('fill', strOrNull),
    weight: pick('weight', (v) => v === null || (typeof v === 'number' && v > 0)),
    dashed: pick('dashed', (v) => typeof v === 'boolean'),
    head: pick('head', (v) => (ARROW_HEADS as readonly unknown[]).includes(v)),
    tail: pick('tail', (v) => (ARROW_HEADS as readonly unknown[]).includes(v)),
    route: pick('route', (v) => (ROUTES as readonly unknown[]).includes(v)),
    from: pick('from', strOrNull),
    to: pick('to', strOrNull),
    text: pick('text', str),
    shape: pick('shape', (v) => (ZONE_SHAPES as readonly unknown[]).includes(v)),
    showArea: pick('showArea', (v) => typeof v === 'boolean'),
    target: pick('target', strOrNull),
    offset: pick('offset', (v) => typeof v === 'number' && Number.isFinite(v)),
  };
}

export function asJson(meta: DiagramMeta): JsonValue {
  return meta as unknown as JsonValue;
}

export function themeOf(doc: Pick<ArchaiDocument, 'workspace'> | undefined): ThemeSpec {
  const theme = (doc?.workspace as { diagramTheme?: DiagramTheme } | undefined)?.diagramTheme;
  return THEMES[theme && THEMES[theme] ? theme : 'technical'];
}

/** Board millimetres per printed millimetre where an element sits: its sheet's scale, else 1:100. */
export const BOARD_PRINT_SCALE = 100;
export function printScaleOf(elements: ElementTable | undefined, element: Element): number {
  const paper = elements ? paperAncestor(elements, element) : null;
  return paper ? paperScaleOf(paper) : BOARD_PRINT_SCALE;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A zone's fill: its own, else the theme colour its label maps to. */
export function zoneFill(meta: DiagramMeta, theme: ThemeSpec): string {
  return meta.fill ?? theme.palette[hash(meta.text.trim().toLowerCase()) % theme.palette.length]!;
}

/** A tag's text for its target, from the template. */
export function tagText(template: string, elements: ElementTable, target: Element | undefined, unitArea = (mm2: number) => `${(mm2 / 1_000_000).toFixed(1)} m²`): string {
  if (!target) return template.replace(/\{[a-z]+\}/g, '—');
  const arch = archOf(target);
  const area = typeof arch?.['area'] === 'number' ? arch['area'] : target.kind === 'rect' ? target.width * target.height : null;
  const levelId = record(target.meta?.['levelConstraint'])?.['levelId'];
  const level = typeof levelId === 'string' ? elements[levelId] : undefined;
  const type = typeof arch?.['type'] === 'string' ? arch['type'].replace(/-/g, ' ') : target.kind;
  return template
    .replace(/\{name\}/g, target.name ?? (isArchType(target, 'room') ? 'Room' : type))
    .replace(/\{area\}/g, area !== null ? unitArea(area) : '—')
    .replace(/\{level\}/g, level?.name ?? '—')
    .replace(/\{type\}/g, type);
}

/** Where the segment from `inside` towards `outside` leaves `box` (the box edge point). */
export function exitPoint(box: Rect, inside: Vec2, outside: Vec2): Vec2 {
  const dx = outside.x - inside.x;
  const dy = outside.y - inside.y;
  const tx = dx > 0 ? (box.x + box.width - inside.x) / dx : dx < 0 ? (box.x - inside.x) / dx : Infinity;
  const ty = dy > 0 ? (box.y + box.height - inside.y) / dy : dy < 0 ? (box.y - inside.y) / dy : Infinity;
  const t = Math.min(tx, ty, 1);
  return { x: inside.x + dx * t, y: inside.y + dy * t };
}

function centre(box: Rect): Vec2 {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * World endpoints of a glued connector: box centres of its ends, clipped at the box edges (a
 * free end keeps its stored world point).
 */
export function connectorEnds(elements: ElementTable, meta: DiagramMeta, stored: [Vec2, Vec2]): [Vec2, Vec2] {
  const fromEl = meta.from ? elements[meta.from] : undefined;
  const toEl = meta.to ? elements[meta.to] : undefined;
  const fromBox = fromEl ? worldBounds(elements, fromEl) : null;
  const toBox = toEl ? worldBounds(elements, toEl) : null;
  const a = fromBox ? centre(fromBox) : stored[0];
  const b = toBox ? centre(toBox) : stored[1];
  return [fromBox ? exitPoint(fromBox, a, b) : a, toBox ? exitPoint(toBox, b, a) : b];
}

/** The drawn path of a connector between two world points. */
export function routePoints(a: Vec2, b: Vec2, route: Route): Vec2[] {
  if (route !== 'orthogonal') return [a, b];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) < 1 || Math.abs(dy) < 1) return [a, b];
  // Leave horizontally when the ends are further apart across than down, and vice versa.
  return Math.abs(dx) >= Math.abs(dy)
    ? [a, { x: a.x + dx / 2, y: a.y }, { x: a.x + dx / 2, y: b.y }, b]
    : [a, { x: a.x, y: a.y + dy / 2 }, { x: b.x, y: a.y + dy / 2 }, b];
}

/**
 * Keeps glued connectors on their elements after an edit: their stored points follow the ends,
 * so selection and hit-testing match what is drawn. Runs after every mutation (see executor).
 */
export function refreshConnectors(doc: ArchaiDocument): void {
  const elements = doc.elements as ElementTable;
  for (const element of Object.values(elements)) {
    if (element.kind !== 'line' || element.points.length < 2) continue;
    const meta = diagramOf(element);
    if (!meta || (!meta.from && !meta.to)) continue;
    // Glue to a deleted element is dropped; the end stays where it was.
    const missing = (id: string | null) => id !== null && !elements[id];
    if (missing(meta.from) || missing(meta.to)) {
      element.meta = { ...element.meta, diagram: asJson({ ...meta, from: missing(meta.from) ? null : meta.from, to: missing(meta.to) ? null : meta.to }) };
    }
    const m = worldMatrix(elements, element);
    const stored: [Vec2, Vec2] = [applyToPoint(m, { x: element.points[0]![0], y: element.points[0]![1] }), applyToPoint(m, { x: element.points.at(-1)![0], y: element.points.at(-1)![1] })];
    const [a, b] = connectorEnds(elements, diagramOf(element)!, stored);
    const inverse = invert(m);
    const la = applyToPoint(inverse, a);
    const lb = applyToPoint(inverse, b);
    const same = (p: readonly number[], q: Vec2) => Math.abs(p[0]! - q.x) < 0.01 && Math.abs(p[1]! - q.y) < 0.01;
    if (element.points.length === 2 && same(element.points[0]!, la) && same(element.points[1]!, lb)) continue;
    element.points = [
      [la.x, la.y],
      [lb.x, lb.y],
    ];
  }
}

/**
 * Board annotations: quick sketching and sticky notes (Miro-style) that live on the board only.
 * - An annotation layer is a group carrying `meta.annotationLayer`; hide or lock it in Layers.
 * - Ink strokes are lines carrying `meta.annotation = { kind: 'ink', pressure, highlighter }`;
 *   they draw as a variable-width outline from the pen pressure.
 * - Sticky notes are rects carrying `meta.annotation = { kind: 'sticky', text, color }`.
 * Anything inside an annotation layer (or marked as an annotation) never reaches sheets, exports,
 * 3D views or section cuts: see `isBoardOnly`.
 */
import type { Element, ElementTable, JsonValue } from '@/document';
import type { Vec2 } from '@/geometry';

export const PEN_COLORS = ['#1f2024', '#e11d48', '#2563eb', '#16a34a', '#f59e0b', '#9333ea', '#ffffff'] as const;
export const HIGHLIGHTER_COLORS = ['#fde047', '#86efac', '#93c5fd', '#f9a8d4', '#fdba74'] as const;
export const STICKY_COLORS = ['#fef08a', '#fbcfe8', '#bbf7d0', '#bfdbfe', '#fed7aa', '#e9d5ff'] as const;
/** Pen widths in screen pixels at the zoom the stroke is drawn at. */
export const PEN_SIZES = [2, 4, 8, 16] as const;

export interface InkMeta {
  kind: 'ink';
  /** Pen pressure per point (0..1); empty for mouse / touch strokes (uniform width). */
  pressure: number[];
  highlighter: boolean;
}

export interface StickyMeta {
  kind: 'sticky';
  text: string;
  color: string;
}

export type AnnotationMeta = InkMeta | StickyMeta;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function annotationOf(element: Element | undefined | null): AnnotationMeta | null {
  const meta = record(element?.meta?.['annotation']);
  if (!meta) return null;
  if (meta['kind'] === 'ink') {
    const pressure = Array.isArray(meta['pressure']) ? meta['pressure'].filter((value): value is number => typeof value === 'number') : [];
    return { kind: 'ink', pressure, highlighter: meta['highlighter'] === true };
  }
  if (meta['kind'] === 'sticky') {
    return { kind: 'sticky', text: typeof meta['text'] === 'string' ? meta['text'] : '', color: typeof meta['color'] === 'string' ? meta['color'] : STICKY_COLORS[0] };
  }
  return null;
}

export function stickyOf(element: Element | undefined | null): StickyMeta | null {
  const meta = annotationOf(element);
  return meta?.kind === 'sticky' ? meta : null;
}

export function isAnnotationLayer(element: Element | undefined | null): boolean {
  return Boolean(element?.kind === 'group' && element.meta?.['annotationLayer']);
}

export function asJson(meta: AnnotationMeta): JsonValue {
  return meta as unknown as JsonValue;
}

/** The element or one of its ancestors is an annotation (layer): shown on the board only. */
export function isBoardOnly(elements: ElementTable, id: string): boolean {
  const seen = new Set<string>();
  let current = elements[id];
  while (current && !seen.has(current.id)) {
    if (current.meta?.['annotation'] || current.meta?.['annotationLayer']) return true;
    seen.add(current.id);
    current = current.parentId ? elements[current.parentId] : undefined;
  }
  return false;
}

/** Annotation layers, bottom to top of Layers. */
export function annotationLayers(elements: ElementTable): Element[] {
  return Object.values(elements)
    .filter(isAnnotationLayer)
    .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
}

/**
 * The outline of a pressure-sensitive stroke: offsets each point by half its width along the
 * local normal and closes the ends with round caps. `widths` has one entry per point.
 */
export function inkOutline(points: readonly Vec2[], widths: readonly number[]): string {
  if (points.length === 0) return '';
  const w = (i: number) => Math.max(0.01, widths[Math.min(i, widths.length - 1)] ?? 1) / 2;
  if (points.length === 1) {
    const p = points[0]!;
    const r = w(0);
    return `M ${p.x - r} ${p.y} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0 Z`;
  }
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)]!;
    const next = points[Math.min(points.length - 1, i + 1)]!;
    let dx = next.x - prev.x;
    let dy = next.y - prev.y;
    const length = Math.hypot(dx, dy) || 1;
    dx /= length;
    dy /= length;
    const r = w(i);
    const p = points[i]!;
    left.push({ x: p.x - dy * r, y: p.y + dx * r });
    right.push({ x: p.x + dy * r, y: p.y - dx * r });
  }
  const f = (n: number) => Math.round(n * 100) / 100;
  const start = w(0);
  const end = w(points.length - 1);
  let d = `M ${f(left[0]!.x)} ${f(left[0]!.y)}`;
  for (let i = 1; i < left.length; i++) d += ` L ${f(left[i]!.x)} ${f(left[i]!.y)}`;
  d += ` A ${f(end)} ${f(end)} 0 0 1 ${f(right.at(-1)!.x)} ${f(right.at(-1)!.y)}`;
  for (let i = right.length - 2; i >= 0; i--) d += ` L ${f(right[i]!.x)} ${f(right[i]!.y)}`;
  d += ` A ${f(start)} ${f(start)} 0 0 1 ${f(left[0]!.x)} ${f(left[0]!.y)} Z`;
  return d;
}

/** Stroke widths per point: pressure scales the nominal width (0.35x..1.35x), none keeps it. */
export function inkWidths(count: number, width: number, pressure: readonly number[]): number[] {
  if (pressure.length === 0) return new Array<number>(count).fill(width);
  return Array.from({ length: count }, (_, i) => width * (0.35 + Math.min(1, Math.max(0, pressure[Math.min(i, pressure.length - 1)] ?? 0.5))));
}

/**
 * Drops points closer than `minStep` to the previous kept point (a pen sends many per pixel),
 * keeping the last one so the stroke ends where the pen lifted.
 */
export function thinStroke(points: readonly Vec2[], pressure: readonly number[], minStep: number): { points: Vec2[]; pressure: number[] } {
  const outPoints: Vec2[] = [];
  const outPressure: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const last = outPoints.at(-1);
    const isLast = i === points.length - 1;
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < minStep && !isLast) continue;
    if (last && isLast && Math.hypot(p.x - last.x, p.y - last.y) < minStep * 0.25 && outPoints.length > 1) continue;
    outPoints.push(p);
    if (pressure.length) outPressure.push(pressure[i] ?? 0.5);
  }
  return { points: outPoints, pressure: outPressure };
}

/** Distance from `p` to a polyline. */
export function distanceToPolyline(p: Vec2, points: readonly Vec2[]): number {
  if (points.length === 1) return Math.hypot(p.x - points[0]!.x, p.y - points[0]!.y);
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

/** Wraps sticky text into lines for a box `width` wide (approximate glyph widths). */
export function wrapStickyText(text: string, fontSize: number, width: number): string[] {
  const perLine = Math.max(1, Math.floor(width / (fontSize * 0.55)));
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      if (!line) line = word;
      else if ((line + ' ' + word).length <= perLine) line += ' ' + word;
      else {
        lines.push(line);
        line = word;
      }
      while (line.length > perLine) {
        lines.push(line.slice(0, perLine));
        line = line.slice(perLine);
      }
    }
    lines.push(line);
  }
  return lines;
}

/** The largest font (of a few steps) whose wrapped text fits the note. */
export function stickyFontSize(text: string, width: number, height: number): number {
  const inner = width * 0.84;
  for (const ratio of [0.13, 0.105, 0.085, 0.07, 0.058, 0.048, 0.04]) {
    const size = width * ratio;
    if (wrapStickyText(text, size, inner).length * size * 1.25 <= height * 0.84) return size;
  }
  return width * 0.04;
}

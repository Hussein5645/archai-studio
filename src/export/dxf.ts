/**
 * DXF (CAD) export. The composed sheet SVG (the same one the PDF draws; see compose.ts) is
 * converted into CAD primitives, so every element renderer (walls, symbols, stairs, frames, title
 * blocks) is reused and CAD output matches the drawing:
 * - `sheet` scope: everything on the paper at 1:1 paper millimetres, ready to plot;
 * - `model` scope: the drawing content only (view frame contents un-scaled from their crops,
 *   plus model content under the paper) in true millimetres at real board coordinates.
 * Y is flipped (CAD is y-up). Layers follow AIA-style names per element type, lineweights are
 * the printed widths, and hatches carry fills. Written as AutoCAD 2007 DXF.
 */
import type { ArchaiDocument, Element } from '@/document';
import type { Rect } from '@/geometry';
import { archTypeOf } from '@/assets/arch-meta';
import { diagramOf } from '@/diagrams/model';
import { isSheetItem, northArrowOf, paperAncestor, scaleBarOf, sheetViewOf, titleBlockOf } from '@/sheets/model';
import { apply, compose, ellipsePoints, flattenPath, IDENTITY_AFFINE, parseTransform, rotationOf, scaleOf, type Affine } from './svgGeometry';
import { luminance, parseColor, type ColorMode } from './quality';

export type DxfScope = 'sheet' | 'model';

/** The slice of an SVG element the converter reads (DOM elements and test fixtures alike). */
export interface VNode {
  tag: string;
  attr(name: string): string | null;
  /** Inlined style value (compose.ts inlines computed styles), else '' . */
  style(name: string): string;
  children: VNode[];
  text: string;
}

export function domNode(element: globalThis.Element): VNode {
  let children: VNode[] | null = null;
  return {
    tag: element.localName,
    attr: (name) => element.getAttribute(name),
    style: (name) => (element as SVGElement).style?.getPropertyValue(name) ?? '',
    get children() {
      children ??= [...element.children].map(domNode);
      return children;
    },
    text: element.textContent ?? '',
  };
}

export interface CadLayer {
  name: string;
  /** AutoCAD colour index. */
  aci: number;
  /** Default lineweight in millimetres. */
  lineweight: number;
}

export const CAD_LAYERS: Record<string, CadLayer> = Object.fromEntries(
  (
    [
      ['A-WALL', 7, 0.5],
      ['A-DOOR', 3, 0.25],
      ['A-GLAZ', 4, 0.25],
      ['A-GLAZ-CWMG', 4, 0.25],
      ['A-FLOR-STRS', 2, 0.25],
      ['A-FLOR-HRAL', 2, 0.18],
      ['A-FLOR', 8, 0.18],
      ['S-COLS', 1, 0.5],
      ['A-AREA', 8, 0.13],
      ['A-FURN', 9, 0.18],
      ['A-SITE', 3, 0.18],
      ['A-DETL', 7, 0.25],
      ['A-ANNO-TEXT', 7, 0.18],
      ['A-ANNO-DIMS', 1, 0.18],
      ['A-ANNO-DIAG', 6, 0.25],
      ['A-ANNO-SYMB', 7, 0.25],
      ['A-ANNO-TTLB', 7, 0.35],
      ['A-ANNO-VIEW', 8, 0.13],
      ['A-ANNO-SHEET', 8, 0.13],
    ] as const
  ).map(([name, aci, lineweight]) => [name, { name, aci, lineweight }]),
);

const ARCH_LAYER: Record<string, string> = {
  wall: 'A-WALL',
  'curtain-wall': 'A-GLAZ-CWMG',
  door: 'A-DOOR',
  window: 'A-GLAZ',
  'facade-element': 'A-GLAZ',
  stair: 'A-FLOR-STRS',
  railing: 'A-FLOR-HRAL',
  column: 'S-COLS',
  room: 'A-AREA',
  floor: 'A-FLOR',
  ceiling: 'A-FLOR',
  'room-divider': 'A-AREA',
};

/** The CAD layer an element's drawing goes on. */
export function cadLayerOf(element: Element | undefined): string {
  if (!element) return 'A-DETL';
  const arch = archTypeOf(element);
  if (arch && ARCH_LAYER[arch]) return ARCH_LAYER[arch]!;
  const meta = element.meta ?? {};
  const diagram = diagramOf(element);
  if (diagram) return diagram.kind === 'dimension' ? 'A-ANNO-DIMS' : 'A-ANNO-DIAG';
  if (titleBlockOf(element)) return 'A-ANNO-TTLB';
  if (scaleBarOf(element) || northArrowOf(element) || meta['sectionLine'] || meta['cameraMarker']) return 'A-ANNO-SYMB';
  if (sheetViewOf(element)) return 'A-ANNO-VIEW';
  if (meta['measure']) return 'A-ANNO-DIMS';
  if (meta['siteContext'] || meta['location']) return 'A-SITE';
  if (element.kind === 'text') return 'A-ANNO-TEXT';
  if (element.kind === 'instance') return 'A-FURN';
  return 'A-DETL';
}

export type CadPrimitive =
  | { kind: 'poly'; layer: string; color: string | null; lineweight: number; points: [number, number][]; closed: boolean; stroke: boolean; fill: string | null; pattern: boolean }
  | { kind: 'text'; layer: string; color: string | null; x: number; y: number; height: number; rotation: number; value: string; align: 'left' | 'center' | 'right'; middle: boolean };

const SKIP_TAGS = new Set(['defs', 'pattern', 'filter', 'clippath', 'mask', 'marker', 'symbol', 'style', 'title', 'desc', 'lineargradient', 'radialgradient', 'foreignobject', 'use', 'script']);

function paint(node: VNode, name: 'fill' | 'stroke'): string | null {
  const value = (node.style(name) || node.attr(name) || '').trim();
  if (!value || value === 'none' || value === 'transparent') return null;
  if (value.startsWith('url(')) return 'pattern';
  const color = parseColor(value);
  if (!color || color.a === 0) return null;
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
}

function number(value: string | null | undefined, fallback = 0): number {
  const parsed = parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

interface Context {
  /** Local → board (world) millimetres. */
  m: Affine;
  /** Board → output (paper or true millimetres, y-up). */
  out: Affine;
  /** Board millimetres per printed millimetre, for lineweights. */
  printScale: number;
  layer: string;
}

export interface ConvertOptions {
  doc: ArchaiDocument;
  scope: DxfScope;
  region: Rect;
  /** The paper's scale (board mm per paper mm). */
  scale: number;
  paperId: string | null;
}

/**
 * Converts composed vector layers into CAD primitives. In model scope, view frames contribute
 * their content in true (board) coordinates and sheet annotation is left out.
 */
export function svgToCad(roots: VNode[], options: ConvertOptions): CadPrimitive[] {
  const { doc, scope, region, scale } = options;
  const out: CadPrimitive[] = [];
  const sheetOut: Affine = [1 / scale, 0, 0, -1 / scale, -region.x / scale, (region.y + region.height) / scale];
  const modelOut: Affine = [1, 0, 0, -1, 0, 0];
  const base: Context = { m: IDENTITY_AFFINE, out: scope === 'sheet' ? sheetOut : modelOut, printScale: scale, layer: 'A-DETL' };

  const onSheet = (element: Element | undefined) => Boolean(element && options.paperId && (element.id === options.paperId || paperAncestor(doc.elements, element)?.id === options.paperId));

  const emitPoly = (node: VNode, context: Context, points: [number, number][], closed: boolean) => {
    if (points.length < 2) return;
    const opacity = number(node.style('opacity') || node.attr('opacity'), 1);
    if (opacity <= 0.01) return;
    const stroke = paint(node, 'stroke');
    const fill = closed || node.tag === 'path' ? paint(node, 'fill') : null;
    const full = compose(context.out, context.m);
    const mapped = points.map(([x, y]) => apply(full, x, y));
    const widthLocal = number(node.style('stroke-width') || node.attr('stroke-width'), 1);
    const lineweight = (widthLocal * scaleOf(context.m)) / context.printScale;
    // Near-white fills are paper masks on screen; in CAD they would only hide linework.
    const fillColor = fill && fill !== 'pattern' && luminance(...(hexRgb(fill) as [number, number, number])) > 245 ? null : fill;
    const hasStroke = stroke !== null && stroke !== 'pattern' && widthLocal > 0;
    if (!hasStroke && !fillColor) return;
    out.push({ kind: 'poly', layer: context.layer, color: hasStroke ? stroke : fillColor === 'pattern' ? null : fillColor, lineweight, points: mapped, closed, stroke: hasStroke, fill: fillColor === 'pattern' ? null : fillColor, pattern: fillColor === 'pattern' });
  };

  const walk = (node: VNode, context: Context) => {
    const tag = node.tag.toLowerCase();
    if (SKIP_TAGS.has(tag) || node.attr('data-screen-only') !== null) return;
    if ((node.style('display') || node.attr('display')) === 'none' || (node.style('visibility') || node.attr('visibility')) === 'hidden') return;
    let local = context;
    const elementId = node.attr('data-element-id');
    if (elementId !== null) {
      const element = doc.elements[elementId];
      if (scope === 'model' && (onSheet(element) || isSheetItem(element))) {
        // On the sheet: only a view frame's drawing counts, at true size and position.
        const view = sheetViewOf(element);
        if (!view || view.source === 'view') return;
        const inner = findSvg(node);
        if (!inner) return;
        const frameContext: Context = { ...context, m: IDENTITY_AFFINE, printScale: view.scale };
        for (const child of inner.children) walkFrameContent(child, frameContext);
        return;
      }
      local = { ...context, layer: cadLayerOf(element) };
    }
    const transform = parseTransform(node.attr('transform'));
    if (transform !== IDENTITY_AFFINE) local = { ...local, m: compose(local.m, transform) };
    shape(tag, node, local);
  };

  /** Inside a frame's nested SVG in model scope: element nodes carry their own world transforms. */
  const walkFrameContent = (node: VNode, context: Context) => {
    if (node.attr('data-vo') !== null) {
      for (const child of node.children) walkFrameContent(child, context);
      return;
    }
    const tag = node.tag.toLowerCase();
    if (tag === 'rect' || tag === 'text' || tag === 'filter' || tag === 'style') {
      // Frame backgrounds, overlays and labels are sheet-side decoration.
      if (node.attr('data-element-id') === null) return;
    }
    walk(node, context);
  };

  const shape = (tag: string, node: VNode, context: Context) => {
    switch (tag) {
      case 'svg': {
        // A nested SVG maps its viewBox onto its x/y/width/height box (view frames).
        const viewBox = (node.attr('viewBox') ?? '').split(/[\s,]+/).map(Number);
        const x = number(node.attr('x'));
        const y = number(node.attr('y'));
        const width = number(node.attr('width'), viewBox[2] ?? 1);
        const height = number(node.attr('height'), viewBox[3] ?? 1);
        let m = compose(context.m, [1, 0, 0, 1, x, y]);
        if (viewBox.length === 4 && viewBox[2]! > 0 && viewBox[3]! > 0) m = compose(m, [width / viewBox[2]!, 0, 0, height / viewBox[3]!, -viewBox[0]! * (width / viewBox[2]!), -viewBox[1]! * (height / viewBox[3]!)]);
        for (const child of node.children) walk(child, { ...context, m });
        return;
      }
      case 'g':
      case 'a':
        for (const child of node.children) walk(child, context);
        return;
      case 'line':
        emitPoly(node, context, [[number(node.attr('x1')), number(node.attr('y1'))], [number(node.attr('x2')), number(node.attr('y2'))]], false);
        return;
      case 'polyline':
      case 'polygon': {
        const values = (node.attr('points') ?? '').match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
        const points: [number, number][] = [];
        for (let i = 0; i + 1 < values.length; i += 2) points.push([values[i]!, values[i + 1]!]);
        emitPoly(node, context, points, tag === 'polygon');
        return;
      }
      case 'rect': {
        const x = number(node.attr('x'));
        const y = number(node.attr('y'));
        const w = number(node.attr('width'));
        const h = number(node.attr('height'));
        if (w <= 0 || h <= 0) return;
        emitPoly(node, context, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true);
        return;
      }
      case 'circle':
      case 'ellipse': {
        const r = number(node.attr('r'));
        const rx = tag === 'circle' ? r : number(node.attr('rx'));
        const ry = tag === 'circle' ? r : number(node.attr('ry'));
        if (rx <= 0 || ry <= 0) return;
        emitPoly(node, context, ellipsePoints(number(node.attr('cx')), number(node.attr('cy')), rx, ry), true);
        return;
      }
      case 'image': {
        // Raster content (3D view renders) is not exported; its frame is, so the layout reads.
        if (node.attr('data-sheet-view-source') === null) return;
        const w = number(node.attr('width'));
        const h = number(node.attr('height'));
        const full = compose(context.out, context.m);
        const points = ([[0, 0], [w, 0], [w, h], [0, h]] as [number, number][]).map(([x, y]) => apply(full, x, y));
        out.push({ kind: 'poly', layer: 'A-ANNO-VIEW', color: null, lineweight: 0.13, points, closed: true, stroke: true, fill: null, pattern: false });
        return;
      }
      case 'path':
        for (const sub of flattenPath(node.attr('d') ?? '')) emitPoly(node, context, sub.points, sub.closed);
        return;
      case 'text': {
        const value = node.text.replace(/\s+/g, ' ').trim();
        if (!value) return;
        const full = compose(context.out, context.m);
        const [x, y] = apply(full, number(node.attr('x')), number(node.attr('y')));
        const size = number(node.style('font-size') || node.attr('font-size'), 12);
        const anchor = node.style('text-anchor') || node.attr('text-anchor') || 'start';
        const baseline = node.style('dominant-baseline') || node.attr('dominant-baseline') || '';
        const fill = paint(node, 'fill');
        out.push({
          kind: 'text',
          layer: context.layer === 'A-DETL' ? 'A-ANNO-TEXT' : context.layer,
          color: fill && fill !== 'pattern' ? fill : null,
          x,
          y,
          // SVG sizes the em box; CAD text height is the cap height.
          height: size * scaleOf(full) * 0.72,
          rotation: rotationOf(full),
          value,
          align: anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left',
          middle: baseline === 'central' || baseline === 'middle',
        });
        return;
      }
      default:
        for (const child of node.children) walk(child, context);
    }
  };

  // Each root is a page-level <svg> whose viewBox is the export region (already board
  // coordinates): its children are walked directly, only nested <svg>s map their viewBox.
  for (const root of roots) {
    if (root.tag.toLowerCase() === 'svg') for (const child of root.children) walk(child, base);
    else walk(root, base);
  }
  return out;
}

/** The first nested <svg> under a node (a view frame's drawing), depth first. */
function findSvg(node: VNode): VNode | null {
  for (const child of node.children) {
    if (child.tag.toLowerCase() === 'svg') return child;
    const found = findSvg(child);
    if (found) return found;
  }
  return null;
}

function hexRgb(hex: string): [number, number, number] {
  const c = parseColor(hex);
  return c ? [c.r, c.g, c.b] : [0, 0, 0];
}

/** Standard DXF lineweights, hundredths of a millimetre. */
const LINEWEIGHTS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];

export function dxfLineweight(mm: number): number {
  const target = mm * 100;
  return LINEWEIGHTS.reduce((best, value) => (Math.abs(value - target) < Math.abs(best - target) ? value : best), LINEWEIGHTS[0]!);
}

/** Near-black prints as colour 7 (black on paper, white on a dark CAD screen); others as true colour. */
function colorOptions(color: string | null): { colorNumber?: number; trueColor?: string } {
  if (!color) return {};
  const [r, g, b] = hexRgb(color);
  if (luminance(r, g, b) < 40) return { colorNumber: 7 };
  return { trueColor: String((r << 16) | (g << 8) | b) };
}

type Dxfier = { push(code: number, value: unknown): void; subclassMarker(name: string | undefined): void };

/**
 * The library writes no per-entity lineweight and a fixed 0 for layers: code 370 is injected
 * through a thin proxy around its writer (entity: just before its own subclass group).
 */
function withLineweight<T extends { dxfy(dx: Dxfier): void }>(record: T, hundredths: number, entity: boolean): T {
  const original = record.dxfy.bind(record);
  record.dxfy = (dx: Dxfier) => {
    let written = false;
    const proxy = new Proxy(dx, {
      get(target, property, receiver) {
        if (property === 'push') {
          return (code: number, value: unknown) => {
            if (!entity && code === 370) return target.push(370, hundredths);
            return target.push(code, value);
          };
        }
        if (entity && property === 'subclassMarker') {
          return (name: string | undefined) => {
            if (!written && name && name !== 'AcDbEntity') {
              target.push(370, hundredths);
              written = true;
            }
            return target.subclassMarker(name);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    original(proxy);
  };
  return record;
}

/** Writes CAD primitives as a DXF document (millimetres). */
export async function writeDxf(primitives: CadPrimitive[], title = 'ArchAI'): Promise<string> {
  const dxf = await import('@tarikjabiri/dxf');
  const writer = new dxf.DxfWriter();
  writer.setUnits(dxf.Units.Millimeters);
  const used = new Set(primitives.map((p) => p.layer));
  for (const primitive of primitives) if (primitive.kind === 'poly' && (primitive.fill || primitive.pattern)) used.add(`${primitive.layer}-PATT`);
  for (const name of used) {
    const base = CAD_LAYERS[name.replace(/-PATT$/, '')] ?? CAD_LAYERS['A-DETL']!;
    const pattern = name.endsWith('-PATT');
    withLineweight(writer.addLayer(name, pattern ? 8 : base.aci, 'Continuous') as unknown as { dxfy(dx: Dxfier): void }, dxfLineweight(pattern ? 0.09 : base.lineweight), false);
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const p of primitives) {
    if (p.kind === 'text') {
      extend(p.x, p.y);
      const options = {
        layerName: p.layer,
        rotation: p.rotation,
        ...colorOptions(p.color),
        ...(p.align !== 'left' || p.middle
          ? {
              horizontalAlignment: p.align === 'center' ? dxf.TextHorizontalAlignment.Center : p.align === 'right' ? dxf.TextHorizontalAlignment.Right : dxf.TextHorizontalAlignment.Left,
              verticalAlignment: p.middle ? dxf.TextVerticalAlignment.Middle : dxf.TextVerticalAlignment.BaseLine,
              secondAlignmentPoint: dxf.point3d(p.x, p.y),
            }
          : {}),
      };
      writer.addText(dxf.point3d(p.x, p.y), Math.max(0.01, p.height), p.value, options);
      continue;
    }
    for (const [x, y] of p.points) extend(x, y);
    if ((p.fill || p.pattern) && p.closed && p.points.length >= 3) {
      const boundary = new dxf.HatchBoundaryPaths();
      boundary.addPolylineBoundary(new dxf.HatchPolylineBoundary(p.points.map(([x, y]) => dxf.vertex(x, y))));
      const fill = p.pattern ? dxf.pattern({ name: dxf.HatchPredefinedPatterns.ANSI31, scale: 1 }) : dxf.pattern({ name: dxf.HatchPredefinedPatterns.SOLID });
      writer.addHatch(boundary, fill, { layerName: `${p.layer}-PATT`, ...colorOptions(p.pattern ? null : p.fill) });
    }
    if (p.stroke) {
      const entity = writer.addLWPolyline(
        p.points.map(([x, y]) => ({ point: dxf.point2d(x, y) })),
        { layerName: p.layer, flags: p.closed ? dxf.LWPolylineFlags.Closed : dxf.LWPolylineFlags.None, ...colorOptions(p.color) },
      );
      withLineweight(entity as unknown as { dxfy(dx: Dxfier): void }, dxfLineweight(p.lineweight), true);
    }
  }
  if (Number.isFinite(minX)) {
    writer.setVariable('$EXTMIN', { 10: minX, 20: minY, 30: 0 });
    writer.setVariable('$EXTMAX', { 10: maxX, 20: maxY, 30: 0 });
  }
  void title;
  return writer.stringify();
}

/**
 * A paper sheet as DXF. `sheet` scope: everything on the paper at 1:1 paper millimetres, with the
 * sheet border and outlines (and names) where 3D views and maps sit; `model` scope: the drawing
 * content at true size in real coordinates.
 */
export async function paperDxf(doc: ArchaiDocument, page: { region: Rect; scale: number; title: string; paperId: string | null; excludeIds?: string[] }, scope: DxfScope, colorMode: ColorMode = 'color'): Promise<string> {
  const { composeSheet } = await import('./compose');
  // Raster content is not exported; render it tiny.
  const layers = await composeSheet(doc, { region: page.region, pxPerMm: 0.02, excludeIds: page.excludeIds, colorMode });
  const roots = layers.flatMap((layer) => (layer.kind === 'vector' ? [domNode(layer.svg)] : []));
  const primitives = svgToCad(roots, { doc, scope, region: page.region, scale: page.scale, paperId: page.paperId });
  if (scope === 'sheet') {
    const s = page.scale;
    const toPaper = (x: number, y: number): [number, number] => [(x - page.region.x) / s, (page.region.y + page.region.height - y) / s];
    primitives.unshift({ kind: 'poly', layer: 'A-ANNO-SHEET', color: null, lineweight: 0.13, points: [toPaper(page.region.x, page.region.y), toPaper(page.region.x + page.region.width, page.region.y), toPaper(page.region.x + page.region.width, page.region.y + page.region.height), toPaper(page.region.x, page.region.y + page.region.height)], closed: true, stroke: true, fill: null, pattern: false });
    for (const layer of layers) {
      if (layer.kind !== 'raster') continue;
      const r = (layer.rotation * Math.PI) / 180;
      const corner = (u: number, v: number) => toPaper(layer.x + u * Math.cos(r) - v * Math.sin(r), layer.y + u * Math.sin(r) + v * Math.cos(r));
      const points = [corner(0, 0), corner(layer.width, 0), corner(layer.width, layer.height), corner(0, layer.height)];
      primitives.push({ kind: 'poly', layer: 'A-ANNO-VIEW', color: null, lineweight: 0.13, points, closed: true, stroke: true, fill: null, pattern: false });
    }
  }
  return writeDxf(primitives, page.title);
}

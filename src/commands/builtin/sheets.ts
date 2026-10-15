/**
 * Sheet editing: open a paper full screen (sheet mode), and place sheet items on it: view frames
 * of level plans, board areas and 3D/section/camera views at their own scales, a title block, a
 * scale bar and a north arrow. Items are children of the paper, so they move with it, show on the
 * board and export with it (see src/sheets/model.ts).
 */
import { z } from 'zod';
import { IdSchema, type ElementTable, type JsonValue, type RectElement } from '@/document';
import { fitBounds, worldBounds, type Rect } from '@/geometry';
import { asJson, DRAWING_SCALES, NEUTRAL_ADJUSTMENTS, frameSize, northArrowOf, paperAncestor, paperScaleOf, scaleBarOf, sheetSources, sheetViewOf, titleBlockOf, type SheetViewMeta, type TitleBlockMeta } from '@/sheets/model';
import { CommandError, defineMutation, type MutationContext } from '../contract';
import { setSelection, snapshot, topIndex } from '../helpers';
import { paperOf } from './views';

/** Screen room the floating panels take around the sheet (px): left panel, inspector, bars. */
const INSETS = { left: 300, right: 320, top: 72, bottom: 104 };

function fitSheet(ctx: MutationContext, bounds: Rect): void {
  const canvas = ctx.ui.canvasSize;
  const inner = { width: Math.max(200, canvas.width - INSETS.left - INSETS.right), height: Math.max(200, canvas.height - INSETS.top - INSETS.bottom) };
  const fit = fitBounds(bounds, inner, 24, 4);
  ctx.ui.viewport = { x: fit.x + INSETS.left, y: fit.y + INSETS.top, zoom: fit.zoom };
}

function requirePaper(ctx: MutationContext, id: string | undefined): RectElement {
  const paperId = id ?? ctx.ui.sheet?.paperId ?? ctx.ui.selection.find((candidate) => paperOf(ctx.doc.elements[candidate]?.meta));
  const paper = paperId ? ctx.doc.elements[paperId] : undefined;
  if (!paper || paper.kind !== 'rect' || !paperOf(paper.meta)) throw new CommandError('rejected', 'Select or open a paper');
  return paper;
}

/** A new rect child of the paper, in the paper's own millimetres (board units). */
function addItem(ctx: MutationContext, paper: RectElement, rect: Rect, name: string, meta: Record<string, JsonValue>): string {
  const id = ctx.ids.next('el');
  const element: RectElement = {
    id,
    kind: 'rect',
    parentId: paper.id,
    index: topIndex(ctx.doc.elements as ElementTable, paper.id),
    x: rect.x,
    y: rect.y,
    rotation: 0,
    visible: true,
    locked: false,
    width: rect.width,
    height: rect.height,
    radius: 0,
    // Filled so the whole item is clickable; sheet items draw themselves (see render/sheetShapes).
    style: { fill: '#ffffff', stroke: null, strokeWidth: 0, opacity: 1 },
    name,
    meta,
  };
  ctx.doc.elements[id] = element;
  setSelection(ctx, [id]);
  return id;
}

export const openSheet = defineMutation({
  id: 'open-sheet',
  label: 'Open sheet',
  description: 'Opens a paper full screen for sheet editing: only the sheet shows, new drawing goes onto it, and views, title block, scale bar and north arrow can be added.',
  aliases: ['sheet editor', 'layout', 'edit sheet'],
  group: 'view',
  history: 'none',
  input: z.object({ id: IdSchema.optional() }).prefault({}),
  run: (ctx, input) => {
    const paper = requirePaper(ctx, input.id);
    const returnViewport = ctx.ui.sheet?.returnViewport ?? { ...ctx.ui.viewport };
    ctx.ui.sheet = { paperId: paper.id, returnViewport };
    ctx.ui.groupEditId = null;
    ctx.ui.tool = 'select';
    setSelection(ctx, []);
    fitSheet(ctx, worldBounds(ctx.doc.elements as ElementTable, paper));
    return paper.id;
  },
});

export const closeSheet = defineMutation({
  id: 'close-sheet',
  label: 'Back to board',
  description: 'Leaves sheet editing and returns to the board where it was.',
  aliases: ['exit sheet', 'board'],
  group: 'view',
  history: 'none',
  input: z.object({}).prefault({}),
  when: (ctx) => ctx.ui.sheet !== null,
  run: (ctx) => {
    const sheet = ctx.ui.sheet;
    if (!sheet) return;
    ctx.ui.sheet = null;
    ctx.ui.groupEditId = null;
    ctx.ui.viewport = { ...sheet.returnViewport };
    ctx.ui.tool = 'select';
    if (ctx.doc.elements[sheet.paperId]) setSelection(ctx, [sheet.paperId]);
  },
});

export const fitSheetView = defineMutation({
  id: 'fit-sheet',
  label: 'Fit sheet',
  group: 'view',
  palette: false,
  history: 'none',
  input: z.object({}).prefault({}),
  when: (ctx) => ctx.ui.sheet !== null,
  run: (ctx) => {
    const paper = ctx.ui.sheet ? ctx.doc.elements[ctx.ui.sheet.paperId] : undefined;
    if (paper) fitSheet(ctx, worldBounds(ctx.doc.elements as ElementTable, paper));
  },
});

const CropSchema = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().positive(), height: z.number().positive() });

export const addSheetView = defineMutation({
  id: 'add-sheet-view',
  label: 'Add view to sheet',
  description: 'Places a view frame on a paper: a level plan (vector), a 3D/section/camera view (live image), or a board area (vector, give `crop`). Size follows the crop at the view scale.',
  aliases: ['place view', 'viewport', 'drawing'],
  group: 'create',
  history: 'record',
  input: z.object({
    paperId: IdSchema.optional(),
    /** Level or view portal id; omit with `crop` for a board area. */
    sourceId: IdSchema.optional(),
    crop: CropSchema.optional(),
    scale: z.number().positive().optional(),
    /** Top-left on the paper, in paper millimetres from its corner (defaults to the free centre). */
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    title: z.string().max(120).optional(),
  }).prefault({}),
  run: (ctx, input) => {
    const paper = requirePaper(ctx, input.paperId);
    const paperScale = paperScaleOf(paper);
    const source = input.sourceId ? sheetSources(ctx.doc).find((candidate) => candidate.id === input.sourceId) : undefined;
    if (input.sourceId && !source) throw new CommandError('rejected', 'That element is not a level or a view that can go on a sheet');
    const crop = input.crop ?? source?.crop;
    if (!crop) throw new CommandError('rejected', 'Pick a level or view to place, or give a crop (board area)');
    // Default scale: the largest standard scale that fits 80% of the paper.
    const fits = (scale: number) => {
      const size = frameSize(crop, scale, paperScale);
      return size.width <= paper.width * 0.8 && size.height <= paper.height * 0.8;
    };
    const scale = input.scale ?? DRAWING_SCALES.find(fits) ?? DRAWING_SCALES.at(-1)!;
    const size = frameSize(crop, scale, paperScale);
    const count = Object.values(ctx.doc.elements).filter((element) => element.parentId === paper.id && sheetViewOf(element)).length + 1;
    const view: SheetViewMeta = {
      source: source ? (source.kind === 'plan' ? 'plan' : 'view') : 'board',
      sourceId: source?.id ?? null,
      crop,
      scale,
      title: input.title ?? source?.name ?? 'Board area',
      number: String(count),
      showTitle: true,
      overrides: {},
      adjustments: { ...NEUTRAL_ADJUSTMENTS },
      style: null,
    };
    const x = input.x !== undefined ? input.x * paperScale : (paper.width - size.width) / 2;
    const y = input.y !== undefined ? input.y * paperScale : Math.max(10 * paperScale, (paper.height - size.height) / 2 - 6 * paperScale);
    return addItem(ctx, paper, { x, y, ...size }, view.title, { sheetView: asJson(view) });
  },
});

export const setSheetView = defineMutation({
  id: 'set-sheet-view',
  label: 'Set sheet view',
  description: 'Changes a view frame: scale (resizes the frame, keeps the crop), crop, title, number, title visibility.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, scale: z.number().positive().optional(), crop: CropSchema.optional(), title: z.string().max(120).optional(), number: z.string().max(12).optional(), showTitle: z.boolean().optional() }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    const view = sheetViewOf(element);
    if (!element || element.kind !== 'rect' || !view) throw new CommandError('rejected', 'Select a view frame');
    const next: SheetViewMeta = {
      ...view,
      ...(input.scale ? { scale: input.scale } : {}),
      ...(input.crop ? { crop: input.crop } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.number !== undefined ? { number: input.number } : {}),
      ...(input.showTitle !== undefined ? { showTitle: input.showTitle } : {}),
    };
    if (input.scale || input.crop) {
      const size = frameSize(next.crop, next.scale, paperScaleOf(paperAncestor(ctx.doc.elements as ElementTable, element)));
      // Resized about the frame's centre, so the drawing stays where it was placed.
      element.x += (element.width - size.width) / 2;
      element.y += (element.height - size.height) / 2;
      element.width = size.width;
      element.height = size.height;
    }
    if (input.title !== undefined) element.name = input.title;
    element.meta = { ...snapshot(element.meta ?? {}), sheetView: asJson(next) };
    return element.id;
  },
});

export const addTitleBlock = defineMutation({
  id: 'add-title-block',
  label: 'Add title block',
  description: "Adds a title block to the paper's bottom-right corner; it shows the project, the sheet title and number, the scale and the date.",
  aliases: ['title block', 'titleblock', 'stamp'],
  group: 'create',
  history: 'record',
  input: z.object({ paperId: IdSchema.optional(), project: z.string().max(120).optional() }).prefault({}),
  run: (ctx, input) => {
    const paper = requirePaper(ctx, input.paperId);
    const s = paperScaleOf(paper);
    const width = Math.min(180 * s, paper.width - 20 * s);
    const height = 32 * s;
    const meta: TitleBlockMeta = { project: input.project ?? ctx.doc.meta.name, client: '', drawnBy: '', checkedBy: '', date: ctx.now().slice(0, 10), revision: 'A' };
    return addItem(ctx, paper, { x: paper.width - width - 10 * s, y: paper.height - height - 10 * s, width, height }, 'Title block', { titleBlock: asJson(meta) });
  },
});

export const setTitleBlock = defineMutation({
  id: 'set-title-block',
  label: 'Set title block',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, project: z.string().max(120).optional(), client: z.string().max(120).optional(), drawnBy: z.string().max(60).optional(), checkedBy: z.string().max(60).optional(), date: z.string().max(30).optional(), revision: z.string().max(12).optional() }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    const block = titleBlockOf(element);
    if (!element || !block) throw new CommandError('rejected', 'Select a title block');
    const { id: _id, ...patch } = input;
    void _id;
    element.meta = { ...snapshot(element.meta ?? {}), titleBlock: asJson({ ...block, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) }) };
    return element.id;
  },
});

/** The view frame an annotation should follow: the given one, the selected one, or the paper's first. */
function frameFor(ctx: MutationContext, paper: RectElement, frameId: string | undefined): string | null {
  const candidates = Object.values(ctx.doc.elements).filter((element) => element.parentId === paper.id && sheetViewOf(element));
  if (frameId) return candidates.some((element) => element.id === frameId) ? frameId : null;
  return candidates.find((element) => ctx.ui.selection.includes(element.id))?.id ?? candidates[0]?.id ?? null;
}

export const addScaleBar = defineMutation({
  id: 'add-scale-bar',
  label: 'Add scale bar',
  description: "Adds a graphic scale bar that follows a view frame's scale (or the paper's).",
  aliases: ['scale bar', 'graphic scale'],
  group: 'create',
  history: 'record',
  input: z.object({ paperId: IdSchema.optional(), frameId: IdSchema.optional() }).prefault({}),
  run: (ctx, input) => {
    const paper = requirePaper(ctx, input.paperId);
    const s = paperScaleOf(paper);
    const frameId = frameFor(ctx, paper, input.frameId);
    const frame = frameId ? ctx.doc.elements[frameId] : undefined;
    const x = frame ? frame.x : 15 * s;
    const y = frame && frame.kind === 'rect' ? Math.min(paper.height - 22 * s, frame.y + frame.height + 14 * s) : paper.height - 22 * s;
    return addItem(ctx, paper, { x, y, width: 60 * s, height: 10 * s }, 'Scale bar', { scaleBar: asJson({ frameId }) });
  },
});

export const addNorthArrow = defineMutation({
  id: 'add-north-arrow',
  label: 'Add north arrow',
  description: 'Adds a north arrow; `rotation` is clockwise degrees from sheet-up to north.',
  aliases: ['north', 'north point', 'compass'],
  group: 'create',
  history: 'record',
  input: z.object({ paperId: IdSchema.optional(), rotation: z.number().finite().optional() }).prefault({}),
  run: (ctx, input) => {
    const paper = requirePaper(ctx, input.paperId);
    const s = paperScaleOf(paper);
    // The site's north (analysis origins carry it) unless given.
    const analysis = Object.values(ctx.doc.elements).map((element) => element.meta?.['analysis'] as { northAngle?: number } | undefined).find((meta) => typeof meta?.northAngle === 'number');
    const rotation = input.rotation ?? analysis?.northAngle ?? 0;
    return addItem(ctx, paper, { x: paper.width - 30 * s, y: 12 * s, width: 18 * s, height: 18 * s }, 'North arrow', { northArrow: asJson({ rotation }) });
  },
});

export const setNorthArrow = defineMutation({
  id: 'set-north-arrow',
  label: 'Set north arrow',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, rotation: z.number().finite() }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    if (!element || !northArrowOf(element)) throw new CommandError('rejected', 'Select a north arrow');
    element.meta = { ...snapshot(element.meta ?? {}), northArrow: asJson({ rotation: input.rotation }) };
    return element.id;
  },
});

export const setScaleBar = defineMutation({
  id: 'set-scale-bar',
  label: 'Set scale bar',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, frameId: IdSchema.nullable() }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    if (!element || !scaleBarOf(element)) throw new CommandError('rejected', 'Select a scale bar');
    element.meta = { ...snapshot(element.meta ?? {}), scaleBar: asJson({ frameId: input.frameId }) };
    return element.id;
  },
});

export const sheetCommands = [openSheet, closeSheet, fitSheetView, addSheetView, setSheetView, addTitleBlock, setTitleBlock, addScaleBar, setScaleBar, addNorthArrow, setNorthArrow];

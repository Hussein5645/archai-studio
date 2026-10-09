/**
 * Sheet layout helpers: arrange the view frames of a sheet in a grid / row / column inside its
 * margins, create one sheet per level plan in one go (numbered), and save or reuse sheet
 * templates (paper, title block, scale bar, notes — without the views) kept in the app's
 * storage so they work across projects.
 */
import { z } from 'zod';
import { IdSchema, type ElementTable, type RectElement } from '@/document';
import { worldBounds } from '@/geometry';
import { paperScaleOf, sheetSources, sheetSubtree, sheetViewOf } from '@/sheets/model';
import { CommandError, defineEffect, defineMutation, type MutationContext } from '../contract';
import { setSelection } from '../helpers';
import { collectPayload, ElementsPayload } from './arrange';
import { addSheetView } from './sheets';
import { createPaper, paperOf } from './views';

function paperFor(ctx: MutationContext, id: string | undefined): RectElement {
  const paperId = id ?? ctx.ui.sheet?.paperId ?? ctx.ui.selection.find((candidate) => paperOf(ctx.doc.elements[candidate]?.meta));
  const paper = paperId ? ctx.doc.elements[paperId] : undefined;
  if (!paper || paper.kind !== 'rect' || !paperOf(paper.meta)) throw new CommandError('rejected', 'Select or open a paper');
  return paper as RectElement;
}

export const arrangeSheetViews = defineMutation({
  id: 'arrange-sheet-views',
  label: 'Arrange views on sheet',
  description: 'Lays out the view frames of a sheet inside its margins: `grid`, `row` or `column`, with `gap` and `margin` in paper millimetres. Frames keep their scale; the title block area on the right bottom is kept free when present.',
  aliases: ['tidy sheet', 'layout views'],
  group: 'arrange',
  history: 'record',
  input: z.object({ paperId: IdSchema.optional(), layout: z.enum(['grid', 'row', 'column']).default('grid'), gap: z.number().min(0).default(10), margin: z.number().min(0).default(15) }).prefault({}),
  run: (ctx, input) => {
    const paper = paperFor(ctx, input.paperId);
    const scale = paperScaleOf(paper);
    const views = Object.values(ctx.doc.elements)
      .filter((e) => e.parentId === paper.id && sheetViewOf(e) && e.kind === 'rect')
      .sort((a, b) => a.y - b.y || a.x - b.x) as RectElement[];
    if (!views.length) throw new CommandError('rejected', 'This sheet has no views to arrange');
    const margin = input.margin * scale;
    const gap = input.gap * scale;
    const area = { x: margin, y: margin, width: paper.width - 2 * margin, height: paper.height - 2 * margin };
    const n = views.length;
    const columns = input.layout === 'row' ? n : input.layout === 'column' ? 1 : Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / columns);
    const cellW = (area.width - gap * (columns - 1)) / columns;
    const cellH = (area.height - gap * (rows - 1)) / rows;
    views.forEach((view, i) => {
      const col = i % columns;
      const row = Math.floor(i / columns);
      const draft = ctx.doc.elements[view.id] as RectElement;
      // Centred in its cell; frames larger than the cell stay at its top-left.
      draft.x = area.x + col * (cellW + gap) + Math.max(0, (cellW - view.width) / 2);
      draft.y = area.y + row * (cellH + gap) + Math.max(0, (cellH - view.height) / 2);
    });
    return views.map((v) => v.id);
  },
});

export const createLevelSheets = defineMutation({
  id: 'create-level-sheets',
  label: 'Sheets for all levels',
  description: 'Creates one sheet per level plan (not yet on a sheet), each with its plan placed, titled and numbered in order, laid out in a row to the right of the drawing.',
  aliases: ['batch sheets', 'plan sheets'],
  group: 'create',
  history: 'record',
  input: z.object({ size: z.string().default('A3'), orientation: z.enum(['portrait', 'landscape']).default('landscape'), scale: z.number().positive().default(100), onlyMissing: z.boolean().default(true) }).prefault({}),
  run: (ctx, input) => {
    const elements = ctx.doc.elements as ElementTable;
    const placed = new Set(Object.values(elements).flatMap((e) => { const view = sheetViewOf(e); return view?.sourceId ? [view.sourceId] : []; }));
    const plans = sheetSources(ctx.doc).filter((source) => source.kind === 'plan' && (!input.onlyMissing || !placed.has(source.id)));
    if (!plans.length) throw new CommandError('rejected', input.onlyMissing ? 'Every level plan is already on a sheet' : 'There are no level plans yet; add a level first');
    const all = Object.values(elements).map((e) => worldBounds(elements, e));
    let x = all.length ? Math.max(...all.map((b) => b.x + b.width)) + 5000 : 0;
    const y = all.length ? Math.min(...all.map((b) => b.y)) : 0;
    const ids: string[] = [];
    for (const plan of plans) {
      const id = createPaper.run(ctx, { x, y, size: input.size, orientation: input.orientation, scale: input.scale, title: plan.name }) as string;
      addSheetView.run(ctx, { paperId: id, sourceId: plan.id, title: plan.name });
      x += (ctx.doc.elements[id] as RectElement).width + 2000;
      ids.push(id);
    }
    setSelection(ctx, ids);
    return ids;
  },
});

// ---- templates -------------------------------------------------------------------------------

const TEMPLATE_KEY = 'sheet-templates';
const StoredTemplate = z.object({ name: z.string(), savedAt: z.string(), payload: ElementsPayload });
export type SheetTemplate = z.infer<typeof StoredTemplate>;

export async function readSheetTemplates(storage: { get(key: string): Promise<string | null> }): Promise<SheetTemplate[]> {
  try {
    const raw = await storage.get(TEMPLATE_KEY);
    const parsed = z.array(StoredTemplate).safeParse(raw ? JSON.parse(raw) : []);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export const saveSheetTemplate = defineEffect({
  id: 'save-sheet-template',
  label: 'Save sheet as template',
  description: 'Saves a sheet (paper, title block, scale bar, north arrow, notes — without its views) as a named template in the app, for new sheets in any project.',
  group: 'document',
  input: z.object({ paperId: IdSchema.optional(), name: z.string().min(1).max(80).default('Sheet template') }).prefault({}),
  run: async (ctx, input) => {
    const state = ctx.getState();
    const paperId = input.paperId ?? state.ui.sheet?.paperId ?? state.ui.selection.find((id) => paperOf(state.doc.elements[id]?.meta));
    if (!paperId || !paperOf(state.doc.elements[paperId]?.meta)) throw new CommandError('rejected', 'Open or select a paper');
    const views = new Set(Object.values(state.doc.elements).filter((e) => sheetViewOf(e) && sheetSubtree(state.doc.elements, paperId).has(e.id)).flatMap((e) => [e.id, ...sheetSubtree(state.doc.elements, e.id)]));
    const payload = collectPayload(state.doc, [paperId]);
    payload.elements = payload.elements.filter((e) => !views.has(e.id));
    const templates = (await readSheetTemplates(ctx.platform.storage)).filter((t) => t.name !== input.name);
    templates.push({ name: input.name, savedAt: ctx.now(), payload });
    await ctx.platform.storage.set(TEMPLATE_KEY, JSON.stringify(templates));
    return input.name;
  },
});

export const newSheetFromTemplate = defineEffect({
  id: 'new-sheet-from-template',
  label: 'New sheet from template',
  description: 'Places a new sheet from a saved template (at `x`, `y` board mm, else the view centre) and selects it.',
  group: 'create',
  palette: false,
  input: z.object({ name: z.string().min(1), x: z.number().finite().optional(), y: z.number().finite().optional() }),
  run: async (ctx, input) => {
    const template = (await readSheetTemplates(ctx.platform.storage)).find((t) => t.name === input.name);
    if (!template) throw new CommandError('rejected', `No sheet template called “${input.name}”`);
    const root = template.payload.elements.find((e) => e.meta?.['paper']);
    if (!root || root.kind !== 'rect') throw new CommandError('failed', 'The template has no paper');
    const { viewport, canvasSize } = ctx.getState().ui;
    const x = input.x ?? (canvasSize.width / 2 - viewport.x) / viewport.zoom - root.width / 2;
    const y = input.y ?? (canvasSize.height / 2 - viewport.y) / viewport.zoom - root.height / 2;
    const result = ctx.dispatchSync('insert-elements', { ...template.payload, offset: { x: x - root.x, y: y - root.y } });
    if (!result.ok) throw new CommandError(result.error.code, result.error.message);
    return result.value;
  },
});

export const deleteSheetTemplate = defineEffect({
  id: 'delete-sheet-template',
  label: 'Delete sheet template',
  group: 'document',
  palette: false,
  input: z.object({ name: z.string().min(1) }),
  run: async (ctx, input) => {
    const templates = (await readSheetTemplates(ctx.platform.storage)).filter((t) => t.name !== input.name);
    await ctx.platform.storage.set(TEMPLATE_KEY, JSON.stringify(templates));
    return input.name;
  },
});

export const sheetLayoutCommands = [arrangeSheetViews, createLevelSheets, saveSheetTemplate, newSheetFromTemplate, deleteSheetTemplate];

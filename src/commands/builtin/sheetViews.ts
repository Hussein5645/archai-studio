/**
 * Styling inside a view frame, like editing a layer group in image software: enter a frame, pick
 * the elements it shows, and give them per-view overrides (colour, line, ghost/hide, emphasis,
 * lift, label); adjust the whole view (brightness, contrast, saturation, tint, background, grain,
 * fade the rest); apply a diagram recipe; or flatten the view into a plain image. The model and
 * other views are never changed: everything is stored on the frame (see src/sheets/model.ts).
 */
import { z } from 'zod';
import { archTypeOf } from '@/assets/arch-meta';
import { IdSchema, type ArchaiDocument, type Element } from '@/document';
import { worldBounds } from '@/geometry';
import { asJson, FRAME_STYLES, frameContentIds, paperAncestor, sheetViewOf, type SheetViewMeta, type ViewOverride } from '@/sheets/model';
import { DIAGRAM_RECIPES, recipeStyling } from '@/sheets/recipes';
import { CommandError, defineEffect, defineMutation, type MutationContext, type ReadContext } from '../contract';
import { setSelection, snapshot } from '../helpers';

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, 'Use a #rrggbb colour');

/** Override fields; `null` removes a field. */
const OverridePatch = z.object({
  fill: Hex.nullable().optional(),
  stroke: Hex.nullable().optional(),
  weight: z.number().positive().max(10).nullable().optional(),
  opacity: z.number().min(0).max(1).nullable().optional(),
  visibility: z.enum(['ghost', 'hidden']).nullable().optional(),
  emphasis: z.enum(['outline', 'glow', 'shadow']).nullable().optional(),
  accent: Hex.nullable().optional(),
  lift: z.number().finite().nullable().optional(),
  label: z.string().max(80).nullable().optional(),
});

const AdjustmentsPatch = z.object({
  brightness: z.number().min(0.2).max(2).optional(),
  contrast: z.number().min(0.2).max(2).optional(),
  saturation: z.number().min(0).max(2).optional(),
  tint: Hex.nullable().optional(),
  tintAmount: z.number().min(0).max(1).optional(),
  background: Hex.nullable().optional(),
  grain: z.number().min(0).max(1).optional(),
  fadeOthers: z.boolean().optional(),
});

function frameOf(ctx: MutationContext | ReadContext, id: string | undefined): { element: Element; view: SheetViewMeta } {
  const frameId = id ?? ctx.ui.sheet?.viewEdit?.frameId ?? ctx.ui.selection.find((candidate) => sheetViewOf(ctx.doc.elements[candidate]));
  const element = frameId ? ctx.doc.elements[frameId] : undefined;
  const view = sheetViewOf(element);
  if (!element || !view) throw new CommandError('rejected', 'Select or enter a view frame');
  return { element, view };
}

function writeView(element: Element, view: SheetViewMeta): void {
  element.meta = { ...snapshot(element.meta ?? {}), sheetView: asJson(view) };
}

/** Element ids a frame shows: its vector content, or every modelled element for 3D views. */
export function frameElementIds(doc: ArchaiDocument, view: SheetViewMeta): string[] {
  if (view.source !== 'view') return frameContentIds(doc.elements, view);
  return Object.values(doc.elements)
    .filter((element) => archTypeOf(element) !== null)
    .map((element) => element.id);
}

export const enterSheetView = defineMutation({
  id: 'enter-sheet-view',
  label: 'Style view elements',
  description: 'Enters a view frame on the open sheet to pick and style the elements it shows (per view only).',
  aliases: ['edit view', 'enter view', 'style view'],
  group: 'edit',
  history: 'none',
  input: z.object({ id: IdSchema.optional() }).prefault({}),
  when: (ctx) => ctx.ui.sheet !== null,
  run: (ctx, input) => {
    const { element } = frameOf(ctx, input.id);
    const sheet = ctx.ui.sheet;
    if (!sheet || paperAncestor(ctx.doc.elements, element)?.id !== sheet.paperId) throw new CommandError('rejected', 'Open the sheet this view is on first');
    ctx.ui.sheet = { ...sheet, viewEdit: { frameId: element.id, picked: [] } };
    setSelection(ctx, [element.id]);
    ctx.ui.tool = 'select';
    return element.id;
  },
});

export const exitSheetView = defineMutation({
  id: 'exit-sheet-view',
  label: 'Done styling view',
  group: 'edit',
  palette: false,
  history: 'none',
  input: z.object({}).prefault({}),
  when: (ctx) => Boolean(ctx.ui.sheet?.viewEdit),
  run: (ctx) => {
    const sheet = ctx.ui.sheet;
    if (!sheet?.viewEdit) return;
    const frameId = sheet.viewEdit.frameId;
    ctx.ui.sheet = { ...sheet, viewEdit: null };
    if (ctx.doc.elements[frameId]) setSelection(ctx, [frameId]);
  },
});

export const pickInView = defineMutation({
  id: 'pick-in-view',
  label: 'Pick elements in view',
  description: 'Sets which elements of the entered view frame are picked for styling.',
  group: 'select',
  palette: false,
  history: 'none',
  input: z.object({ ids: z.array(IdSchema), mode: z.enum(['replace', 'add', 'toggle']).default('replace') }),
  when: (ctx) => Boolean(ctx.ui.sheet?.viewEdit),
  run: (ctx, input) => {
    const sheet = ctx.ui.sheet;
    if (!sheet?.viewEdit) throw new CommandError('unavailable', 'Enter a view frame first');
    const { view } = frameOf(ctx, sheet.viewEdit.frameId);
    const shown = new Set(frameElementIds(ctx.doc as ArchaiDocument, view));
    const ids = input.ids.filter((id) => shown.has(id));
    const current = sheet.viewEdit.picked;
    const picked =
      input.mode === 'replace' ? ids : input.mode === 'add' ? [...new Set([...current, ...ids])] : [...current.filter((id) => !ids.includes(id)), ...ids.filter((id) => !current.includes(id))];
    ctx.ui.sheet = { ...sheet, viewEdit: { ...sheet.viewEdit, picked } };
    return picked;
  },
});

export const selectSimilarInView = defineMutation({
  id: 'select-similar-in-view',
  label: 'Pick similar elements',
  description: 'Adds every element of the same type (all walls, all rooms named the same...) to the picked elements of the entered view.',
  aliases: ['select similar', 'pick similar'],
  group: 'select',
  history: 'none',
  input: z.object({}).prefault({}),
  when: (ctx) => Boolean(ctx.ui.sheet?.viewEdit?.picked.length),
  run: (ctx) => {
    const sheet = ctx.ui.sheet;
    if (!sheet?.viewEdit) return [];
    const { view } = frameOf(ctx, sheet.viewEdit.frameId);
    const keyOf = (element: Element) => archTypeOf(element) ?? element.kind;
    const keys = new Set(sheet.viewEdit.picked.flatMap((id) => (ctx.doc.elements[id] ? [keyOf(ctx.doc.elements[id]!)] : [])));
    const picked = frameElementIds(ctx.doc as ArchaiDocument, view).filter((id) => keys.has(keyOf(ctx.doc.elements[id]!)));
    ctx.ui.sheet = { ...sheet, viewEdit: { ...sheet.viewEdit, picked } };
    return picked;
  },
});

export const setViewOverride = defineMutation({
  id: 'set-view-override',
  label: 'Style elements in view',
  description: 'Styles elements in one view frame only: fill, stroke, weight (printed mm), opacity, visibility (ghost/hidden), emphasis (outline/glow/shadow), accent, lift (mm, 3D), label. `null` removes a setting. Defaults to the entered frame and its picked elements.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema.optional(), elementIds: z.array(IdSchema).optional(), patch: OverridePatch }),
  run: (ctx, input) => {
    const { element, view } = frameOf(ctx, input.id);
    const ids = input.elementIds ?? (ctx.ui.sheet?.viewEdit?.frameId === element.id ? ctx.ui.sheet.viewEdit.picked : []);
    if (ids.length === 0) throw new CommandError('rejected', 'Pick elements in the view first');
    const overrides = { ...view.overrides };
    for (const id of ids) {
      const next: Record<string, unknown> = { ...(overrides[id] ?? {}) };
      for (const [key, value] of Object.entries(input.patch)) {
        if (value === undefined) continue;
        if (value === null) delete next[key];
        else next[key] = value;
      }
      if (Object.keys(next).length > 0) overrides[id] = next as ViewOverride;
      else delete overrides[id];
    }
    writeView(element, { ...view, overrides });
    return ids;
  },
});

export const clearViewOverride = defineMutation({
  id: 'clear-view-override',
  label: 'Reset element styling in view',
  description: 'Removes per-view styling from elements (all of them when no ids are given and nothing is picked).',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema.optional(), elementIds: z.array(IdSchema).optional() }).prefault({}),
  run: (ctx, input) => {
    const { element, view } = frameOf(ctx, input.id);
    const picked = ctx.ui.sheet?.viewEdit?.frameId === element.id ? ctx.ui.sheet.viewEdit.picked : [];
    const ids = input.elementIds ?? (picked.length > 0 ? picked : null);
    const overrides = ids ? Object.fromEntries(Object.entries(view.overrides).filter(([id]) => !ids.includes(id))) : {};
    writeView(element, { ...view, overrides });
    return element.id;
  },
});

export const setViewAdjustments = defineMutation({
  id: 'set-view-adjustments',
  label: 'Adjust view image',
  description: 'Whole-view adjustments of a view frame: brightness, contrast, saturation (1 = unchanged), multiply tint and amount, background, grain, and fadeOthers (ghost everything not styled).',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema.optional(), patch: AdjustmentsPatch }),
  run: (ctx, input) => {
    const { element, view } = frameOf(ctx, input.id);
    const patch = Object.fromEntries(Object.entries(input.patch).filter(([, value]) => value !== undefined));
    writeView(element, { ...view, adjustments: { ...view.adjustments, ...patch } });
    return element.id;
  },
});

export const setViewStyle = defineMutation({
  id: 'set-view-render-style',
  label: 'Set view render style',
  description: "Render style of a 3D/section/camera view frame on the sheet (null uses the source view's own).",
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema.optional(), style: z.enum(FRAME_STYLES).nullable() }),
  run: (ctx, input) => {
    const { element, view } = frameOf(ctx, input.id);
    if (view.source !== 'view') throw new CommandError('rejected', 'Render styles apply to 3D, section and camera views');
    writeView(element, { ...view, style: input.style });
    return element.id;
  },
});

export const applyDiagramRecipe = defineMutation({
  id: 'apply-diagram-recipe',
  label: 'Apply diagram style',
  description: 'Turns a view frame into a presentation diagram: massing, zoning (rooms coloured and labelled), circulation, structure, exploded (3D) or clear. Replaces the frame styling; everything stays editable.',
  aliases: ['diagram', 'massing diagram', 'zoning diagram', 'program diagram', 'circulation diagram', 'exploded axon'],
  group: 'edit',
  history: 'record',
  input: z.object({ id: IdSchema.optional(), recipe: z.enum(DIAGRAM_RECIPES).default('massing') }).prefault({}),
  when: (ctx) => ctx.ui.sheet !== null,
  run: (ctx, input) => {
    const { element, view } = frameOf(ctx, input.id);
    let styling;
    try {
      styling = recipeStyling(input.recipe, ctx.doc as ArchaiDocument, view, frameElementIds(ctx.doc as ArchaiDocument, view));
    } catch (error) {
      throw new CommandError('rejected', error instanceof Error ? error.message : String(error));
    }
    writeView(element, { ...view, ...styling });
    return element.id;
  },
});

export const flattenSheetView = defineEffect({
  id: 'flatten-sheet-view',
  label: 'Flatten view to image',
  description: 'Replaces a view frame with a plain image of it (with its styling) at the given DPI, like rasterizing a layer.',
  aliases: ['rasterize view', 'flatten'],
  group: 'edit',
  input: z.object({ id: IdSchema.optional(), dpi: z.number().int().min(72).max(600).default(300) }).prefault({}),
  run: async (ctx, input) => {
    const state = ctx.getState();
    const { element, view } = frameOf(ctx.read(), input.id);
    const paper = paperAncestor(state.doc.elements, element);
    if (!paper || element.kind !== 'rect') throw new CommandError('rejected', 'That view is not on a sheet');
    const paperScale = Number((paper.meta?.['paper'] as { scale?: number }).scale ?? 50);
    const region = worldBounds(state.doc.elements, element);
    // Only the frame itself: every other sheet item and the paper are left out.
    const others = Object.values(state.doc.elements).filter((candidate) => candidate.id !== element.id && (candidate.id === paper.id || paperAncestor(state.doc.elements, candidate)?.id === paper.id));
    // Leave view editing so picked-element highlights are not in the image.
    if (ctx.getState().ui.sheet?.viewEdit) ctx.dispatchSync('exit-sheet-view', {});
    const { rasterizeBoard, canvasBytes } = await import('@/export/raster');
    const canvas = await rasterizeBoard(state.doc, { ...region, height: element.height }, { pixelsPerMm: input.dpi / 25.4 / paperScale, background: view.adjustments.background ?? '#ffffff', excludeIds: others.map((other) => other.id) });
    const { dataUrl } = await canvasBytes(canvas, 'image/png');
    const [, data] = dataUrl.split(',');
    return ctx.transaction('Flatten view to image', () => {
      const created = ctx.dispatchSync('create-image', {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        rotation: element.rotation,
        parentId: paper.id,
        name: `${view.title} (image)`,
        blob: { mime: 'image/png', data: data!, width: canvas.width, height: canvas.height },
      });
      if (!created.ok) throw new CommandError(created.error.code, created.error.message);
      // delete-selection acts on a selection: select the frame first.
      ctx.dispatchSync('select', { ids: [element.id] });
      const removed = ctx.dispatchSync('delete-selection', { ids: [element.id] });
      if (!removed.ok) throw new CommandError(removed.error.code, removed.error.message);
      ctx.dispatchSync('select', { ids: [created.value as string] });
      return created.value as string;
    });
  },
});

export const sheetViewCommands = [enterSheetView, exitSheetView, pickInView, selectSimilarInView, setViewOverride, clearViewOverride, setViewAdjustments, setViewStyle, applyDiagramRecipe, flattenSheetView];

/**
 * Board annotations (see src/annotations/model.ts): annotation layers, pen / highlighter ink,
 * the eraser and sticky notes. Strokes and notes go into the active annotation layer, which is
 * made on first use, and stay on the board only (never on sheets, exports or 3D).
 */
import { z } from 'zod';
import { ColorSchema, IdSchema, type ElementTable, type GroupElement } from '@/document';
import { applyToPoint, invert, worldMatrix } from '@/geometry';
import { annotationLayers, annotationOf, asJson, isAnnotationLayer, STICKY_COLORS, stickyOf } from '@/annotations/model';
import { DEFAULT_ANNOTATION } from '@/store';
import { CommandError, defineMutation, type MutationContext } from '../contract';
import { removeSubtree, setSelection, topIndex } from '../helpers';
import { createLine, createRect } from './create';

const Point = z.tuple([z.number().finite(), z.number().finite()]);

function newLayer(ctx: MutationContext, name?: string): string {
  const count = annotationLayers(ctx.doc.elements as ElementTable).length + 1;
  const layer: GroupElement = {
    id: ctx.ids.next('el'),
    kind: 'group',
    parentId: null,
    index: topIndex(ctx.doc.elements as ElementTable, null),
    x: 0,
    y: 0,
    rotation: 0,
    visible: true,
    locked: false,
    name: name ?? `Annotations ${count}`,
    meta: { annotationLayer: {} },
  };
  ctx.doc.elements[layer.id] = layer;
  ctx.ui.annotation.layerId = layer.id;
  return layer.id;
}

/** The layer to draw into: the chosen one if usable, else the top usable one, else a new one. */
function activeLayer(ctx: MutationContext, requested?: string): string {
  const elements = ctx.doc.elements as ElementTable;
  const usable = (id: string | null | undefined) => {
    const element = id ? elements[id] : undefined;
    return element && isAnnotationLayer(element) && element.visible && !element.locked ? element.id : null;
  };
  const chosen = usable(requested) ?? usable(ctx.ui.annotation.layerId);
  if (chosen) return chosen;
  const top = [...annotationLayers(elements)].reverse().find((layer) => usable(layer.id));
  if (top) {
    ctx.ui.annotation.layerId = top.id;
    return top.id;
  }
  return newLayer(ctx);
}

function toLayer(ctx: MutationContext, layerId: string, point: readonly [number, number]): [number, number] {
  const layer = ctx.doc.elements[layerId]!;
  const local = applyToPoint(invert(worldMatrix(ctx.doc.elements as ElementTable, layer)), { x: point[0], y: point[1] });
  return [local.x, local.y];
}

export const createAnnotationLayer = defineMutation({
  id: 'create-annotation-layer',
  label: 'New annotation layer',
  description: 'Adds an annotation layer (board-only sketches and sticky notes) on top of the board and makes it the one new annotations go into.',
  aliases: ['annotation layer', 'sketch layer', 'markup layer'],
  group: 'create',
  history: 'record',
  input: z.object({ name: z.string().max(200).optional() }).prefault({}),
  run: (ctx, input) => newLayer(ctx, input.name),
});

export const createInk = defineMutation({
  id: 'create-ink',
  label: 'Sketch',
  description: 'Adds a freehand pen or highlighter stroke (world mm points, optional pen pressure 0..1 per point) to the active annotation layer. Board only.',
  aliases: ['sketch', 'ink', 'freehand', 'markup'],
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({
    points: z.array(Point).min(1),
    pressure: z.array(z.number().min(0).max(1)).default([]),
    color: ColorSchema.default(DEFAULT_ANNOTATION.penColor),
    /** World millimetres. */
    width: z.number().positive(),
    highlighter: z.boolean().default(false),
    layerId: IdSchema.optional(),
  }),
  run: (ctx, input) => {
    const layerId = activeLayer(ctx, input.layerId);
    const points = input.points.map((point) => toLayer(ctx, layerId, point));
    // A dot: a line needs two points.
    if (points.length === 1) points.push([points[0]![0] + 0.01, points[0]![1]]);
    const pressure = input.pressure.length ? input.points.map((_, i) => input.pressure[Math.min(i, input.pressure.length - 1)]!) : [];
    if (pressure.length && pressure.length < points.length) pressure.push(pressure.at(-1)!);
    return createLine.run(ctx, {
      points,
      closed: false,
      rotation: 0,
      style: { fill: null, stroke: input.color, strokeWidth: input.width, opacity: input.highlighter ? 0.45 : 1 },
      name: input.highlighter ? 'Highlight' : 'Sketch',
      meta: { annotation: asJson({ kind: 'ink', pressure: pressure.map((value) => Math.round(value * 100) / 100), highlighter: input.highlighter }) },
      parentId: layerId,
      select: false,
    });
  },
});

export const createSticky = defineMutation({
  id: 'create-sticky',
  label: 'Sticky note',
  description: 'Adds a sticky note centred on x, y (world mm) to the active annotation layer. Board only.',
  aliases: ['sticky', 'sticky note', 'note', 'post-it'],
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    /** Side of the square note in world mm. */
    size: z.number().positive().default(2000),
    color: ColorSchema.optional(),
    text: z.string().default(''),
    layerId: IdSchema.optional(),
  }),
  run: (ctx, input) => {
    const layerId = activeLayer(ctx, input.layerId);
    const [x, y] = toLayer(ctx, layerId, [input.x, input.y]);
    const color = input.color ?? ctx.ui.annotation.stickyColor ?? STICKY_COLORS[0];
    return createRect.run(ctx, {
      x: x - input.size / 2,
      y: y - input.size / 2,
      width: input.size,
      height: input.size,
      radius: 0,
      rotation: 0,
      style: { fill: color, stroke: null, strokeWidth: 0, opacity: 1 },
      name: 'Sticky note',
      meta: { annotation: asJson({ kind: 'sticky', text: input.text, color }) },
      parentId: layerId,
      select: true,
    });
  },
});

export const setSticky = defineMutation({
  id: 'set-sticky',
  label: 'Edit sticky note',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ ids: z.array(IdSchema).optional(), color: ColorSchema.optional(), text: z.string().optional() }),
  run: (ctx, input) => {
    const ids = input.ids ?? ctx.ui.selection;
    let changed = 0;
    for (const id of ids) {
      const element = ctx.doc.elements[id];
      const sticky = stickyOf(element);
      if (!element || !sticky) continue;
      const next = { ...sticky, ...(input.color ? { color: input.color } : {}), ...(input.text !== undefined ? { text: input.text } : {}) };
      element.meta = { ...element.meta, annotation: asJson(next) };
      if (element.kind === 'rect' && input.color) element.style = { ...element.style, fill: input.color };
      changed++;
    }
    if (!changed) throw new CommandError('rejected', 'Select a sticky note');
  },
});

export const eraseAnnotations = defineMutation({
  id: 'erase-annotations',
  label: 'Erase',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ ids: z.array(IdSchema).min(1) }),
  run: (ctx, input) => {
    const removed: string[] = [];
    for (const id of input.ids) {
      const element = ctx.doc.elements[id];
      if (!element || !annotationOf(element) || element.locked) continue;
      removed.push(...removeSubtree(ctx.doc, id));
    }
    if (removed.length) setSelection(ctx, ctx.ui.selection.filter((id) => !removed.includes(id)));
    return removed;
  },
});

export const setAnnotationOptions = defineMutation({
  id: 'set-annotation-options',
  label: 'Annotation options',
  description: 'Changes the pen / highlighter colour and size (screen px), the sticky note colour, pressure sensitivity and the active annotation layer.',
  group: 'view',
  palette: false,
  history: 'none',
  input: z.object({
    penColor: ColorSchema.optional(),
    penSize: z.number().min(0.5).max(200).optional(),
    highlighterColor: ColorSchema.optional(),
    highlighterSize: z.number().min(1).max(400).optional(),
    stickyColor: ColorSchema.optional(),
    pressure: z.boolean().optional(),
    layerId: IdSchema.nullable().optional(),
  }),
  run: (ctx, input) => {
    const options = ctx.ui.annotation;
    for (const [key, value] of Object.entries(input)) if (value !== undefined) (options as unknown as Record<string, unknown>)[key] = value;
  },
});

function annotateTool(kind: string, label: string, shortcut: string | null, aliases: string[]) {
  return defineMutation({
    id: `tool-annotate-${kind}`,
    label,
    aliases: [...aliases, 'annotate'],
    group: 'select',
    ...(shortcut ? { shortcuts: [shortcut] } : {}),
    history: 'none',
    input: z.void(),
    run: (ctx) => {
      ctx.ui.tool = `annotate:${kind}`;
      ctx.ui.lastTool = `annotate:${kind}`;
      ctx.ui.placingAsset = null;
      ctx.ui.editingTextId = null;
      setSelection(ctx, []);
    },
  });
}

export const annotateTools = [
  annotateTool('pen', 'Sketch pen', 'Shift+B', ['sketch', 'draw', 'freehand', 'pencil', 'marker']),
  annotateTool('highlighter', 'Highlighter', null, ['highlight', 'marker']),
  annotateTool('eraser', 'Eraser', 'Shift+E', ['erase', 'rubber']),
  annotateTool('sticky', 'Sticky note', 'Shift+T', ['sticky', 'note', 'post-it']),
];

export const annotationCommands = [createAnnotationLayer, createInk, createSticky, setSticky, eraseAnnotations, setAnnotationOptions, ...annotateTools];

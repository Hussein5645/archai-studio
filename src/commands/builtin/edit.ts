import type { Draft } from 'immer';
import { z } from 'zod';
import { BOARD_VIEW_STYLES, ColorSchema, IdSchema, JsonValueSchema, LOD_LEVELS, UNITS, type Element } from '@/document';
import type { TextMeasurer } from '@/geometry';
import { CommandError, defineMutation } from '../contract';
import { requireTargets, textHeight } from '../helpers';
import { stickyOf } from '@/annotations/model';

const Meta = z.record(z.string(), JsonValueSchema);

/** Editable properties and their validation; each applies only to the kinds that have it. */
const PROPERTY_SCHEMAS = {
  name: z.string().max(200),
  visible: z.boolean(),
  locked: z.boolean(),
  meta: Meta.nullable(),
  fill: ColorSchema.nullable(),
  stroke: ColorSchema.nullable(),
  strokeWidth: z.number().min(0),
  opacity: z.number().min(0).max(1),
  radius: z.number().min(0),
  closed: z.boolean(),
  text: z.string(),
  fontSize: z.number().positive(),
  align: z.enum(['left', 'center', 'right']),
  color: ColorSchema,
} as const;

export type PropertyKey = keyof typeof PROPERTY_SCHEMAS;
export const PROPERTY_KEYS = Object.keys(PROPERTY_SCHEMAS) as PropertyKey[];

function refreshTextHeight(element: Draft<Element>, measurer: TextMeasurer): void {
  if (element.kind === 'text') element.height = textHeight(measurer, element.text, element.fontSize, element.width);
}

/** Applies a validated property; returns false when the element kind does not have it. */
export function applyProperty(element: Draft<Element>, key: PropertyKey, value: unknown, measurer: TextMeasurer): boolean {
  switch (key) {
    case 'name':
      element.name = value as string;
      return true;
    case 'visible':
      element.visible = value as boolean;
      return true;
    case 'locked':
      element.locked = value as boolean;
      return true;
    case 'meta':
      if (value === null) delete element.meta;
      else element.meta = value as Record<string, never>;
      return true;
    case 'fill':
    case 'stroke':
      if (element.kind !== 'rect' && element.kind !== 'line') return false;
      element.style[key] = value as string | null;
      return true;
    case 'strokeWidth':
      if (element.kind !== 'rect' && element.kind !== 'line') return false;
      element.style.strokeWidth = value as number;
      return true;
    case 'opacity':
      if (element.kind === 'rect' || element.kind === 'line') element.style.opacity = value as number;
      else if (element.kind === 'image') element.opacity = value as number;
      else return false;
      return true;
    case 'radius':
      if (element.kind !== 'rect') return false;
      element.radius = value as number;
      return true;
    case 'closed':
      if (element.kind !== 'line') return false;
      element.closed = value as boolean;
      return true;
    case 'text':
      if (element.kind !== 'text') return false;
      element.text = value as string;
      refreshTextHeight(element, measurer);
      return true;
    case 'fontSize':
      if (element.kind !== 'text') return false;
      element.fontSize = value as number;
      refreshTextHeight(element, measurer);
      return true;
    case 'align':
      if (element.kind !== 'text') return false;
      element.align = value as 'left' | 'center' | 'right';
      return true;
    case 'color':
      if (element.kind !== 'text') return false;
      element.color = value as string;
      return true;
  }
}

export const setProperty = defineMutation({
  id: 'set-property',
  label: 'Set property',
  description: `Sets one property on the selected elements. Keys: ${PROPERTY_KEYS.join(', ')}.`,
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({
    ids: z.array(IdSchema).optional(),
    key: z.enum(PROPERTY_KEYS as [PropertyKey, ...PropertyKey[]]),
    value: z.unknown(),
  }),
  run: (ctx, input) => {
    const parsed = PROPERTY_SCHEMAS[input.key].safeParse(input.value);
    if (!parsed.success) {
      throw new CommandError('invalid-input', `Invalid value for ${input.key}`, parsed.error.issues.map((i) => i.message));
    }
    // Visibility and lock changes are allowed on locked elements; everything else is not.
    const structural = input.key === 'visible' || input.key === 'locked';
    const targets = requireTargets(ctx, input.ids, { unlocked: !structural });
    let applied = 0;
    for (const element of targets) {
      if (applyProperty(element, input.key, parsed.data, ctx.measurer)) applied++;
    }
    if (applied === 0) throw new CommandError('rejected', `None of the selected elements has a "${input.key}" property`);
    return applied;
  },
});

export const setText = defineMutation({
  id: 'set-text',
  label: 'Edit text',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, text: z.string() }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    const sticky = stickyOf(element);
    if (element && sticky) {
      element.meta = { ...element.meta, annotation: { ...sticky, text: input.text } };
      return;
    }
    if (!element || element.kind !== 'text') throw new CommandError('rejected', 'Not a text element');
    element.text = input.text;
    refreshTextHeight(element, ctx.measurer);
  },
});

export const rename = defineMutation({
  id: 'rename',
  label: 'Rename',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, name: z.string().max(200) }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    if (!element) throw new CommandError('rejected', `Unknown element ${input.id}`);
    if (input.name.trim() === '') delete element.name;
    else element.name = input.name.trim();
  },
});

export const setWorkspace = defineMutation({
  id: 'set-workspace',
  label: 'Workspace settings',
  description: 'Changes display unit, precision, background, grid size, snapping, view style, level of detail or the board level (boardElevation, mm: the elevation new elements start at).',
  group: 'document',
  palette: false,
  history: 'record',
  input: z.object({
    unit: z.enum(UNITS).optional(),
    precision: z.int().min(0).max(4).optional(),
    background: ColorSchema.optional(),
    grid: z.object({ visible: z.boolean().optional(), size: z.number().positive().optional() }).optional(),
    snap: z.object({ enabled: z.boolean().optional() }).optional(),
    viewStyle: z.enum(BOARD_VIEW_STYLES).optional(),
    lod: z.enum(LOD_LEVELS).optional(),
    boardElevation: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
  }),
  run: (ctx, input) => {
    const ws = ctx.doc.workspace;
    if (input.viewStyle !== undefined) ws.viewStyle = input.viewStyle;
    if (input.lod !== undefined) ws.lod = input.lod;
    if (input.boardElevation !== undefined) ws.boardElevation = input.boardElevation;
    if (input.unit !== undefined) ws.unit = input.unit;
    if (input.precision !== undefined) ws.precision = input.precision;
    if (input.background !== undefined) ws.background = input.background;
    if (input.grid?.visible !== undefined) ws.grid.visible = input.grid.visible;
    if (input.grid?.size !== undefined) ws.grid.size = input.grid.size;
    if (input.snap?.enabled !== undefined) ws.snap.enabled = input.snap.enabled;
  },
});

export const renameDocument = defineMutation({
  id: 'rename-document',
  label: 'Rename document',
  group: 'document',
  palette: false,
  history: 'record',
  input: z.object({ name: z.string().max(200) }),
  run: (ctx, input) => {
    ctx.doc.meta.name = input.name.trim() || 'Untitled';
  },
});

export const editCommands = [setProperty, setText, rename, setWorkspace, renameDocument];

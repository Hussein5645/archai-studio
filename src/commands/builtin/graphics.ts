/**
 * Element graphics commands: the dialog, per-parameter overrides in the document, and presets
 * (local, plus portable JSON files). Overrides are document state (undoable); presets are kept
 * in platform storage so they survive across documents and can be shared as a file.
 */
import { z } from 'zod';
import { JsonValueSchema } from '@/document';
import { graphicTypeOfElement } from '@/assets/arch-meta';
import {
  BUILTIN_GRAPHICS_PRESETS,
  graphicParameter,
  graphicType,
  GRAPHICS_PRESETS_STORAGE_KEY,
  graphicsPresetFile,
  parseStoredPresets,
  presetSlug,
  pruneOverrides,
  readGraphicsPresetFile,
  sanitizeOverrides,
  validGraphicValue,
  type GraphicsOverrides,
  type GraphicsPreset,
} from '@/graphics';
import { CommandError, defineEffect, defineMutation, type EffectContext } from '../contract';

const View = z.enum(['board', 'section', '3d']);

export const openGraphics = defineMutation({
  id: 'open-graphics',
  label: 'Element graphics…',
  description: 'Opens the element graphics dialog: the default look of every element type per view and render style.',
  aliases: ['graphics', 'display settings', 'element styles', 'appearance'],
  group: 'view',
  history: 'none',
  shortcuts: ['Mod+Shift+E'],
  input: z.object({ type: z.string().min(1).optional(), elementId: z.string().min(1).optional() }).prefault({}),
  run: (ctx, input) => {
    const element = input.elementId ? ctx.doc.elements[input.elementId] : undefined;
    const elementType = graphicTypeOfElement(element) ?? (element && (element.kind === 'rect' || element.kind === 'line' || element.kind === 'text' || element.kind === 'image') ? element.kind : null);
    ctx.ui.graphicsDialog = {
      open: true,
      type: elementType ?? (input.type && graphicType(input.type) ? input.type : ctx.ui.graphicsDialog.type),
      elementId: elementType && element ? element.id : null,
    };
  },
});

export const closeGraphics = defineMutation({
  id: 'close-graphics',
  label: 'Close element graphics',
  group: 'view',
  palette: false,
  history: 'none',
  input: z.object({}).prefault({}),
  run: (ctx) => {
    ctx.ui.graphicsDialog = { ...ctx.ui.graphicsDialog, open: false };
  },
});

export const setGraphic = defineMutation({
  id: 'set-graphic',
  label: 'Set element graphic',
  description: 'Overrides one graphic parameter of an element type for the Hidden line view style. `value: null` with `reset: true` removes the override.',
  group: 'document',
  palette: false,
  history: 'record',
  input: z.object({
    type: z.string().min(1),
    view: View,
    style: z.literal('hidden-line').default('hidden-line'),
    id: z.string().min(1),
    value: JsonValueSchema.optional(),
    reset: z.boolean().default(false),
  }),
  run: (ctx, input) => {
    const parameter = graphicParameter(input.type, input.id);
    if (!parameter) throw new CommandError('invalid-input', `Unknown graphic parameter ${input.type}.${input.id}`);
    if (parameter.locked) throw new CommandError('rejected', `${parameter.label} is locked: ${parameter.locked}`);
    if (!parameter.views.includes(input.view)) throw new CommandError('invalid-input', `${parameter.label} does not apply to the ${input.view} view`);
    if (parameter.styles && !parameter.styles.includes('hidden-line')) throw new CommandError('invalid-input', `${parameter.label} does not apply to Hidden line`);
    const graphics = ctx.doc.workspace.graphics as GraphicsOverrides;
    if (input.reset) {
      delete graphics[input.type]?.[input.view]?.[input.style]?.[input.id];
      pruneOverrides(graphics);
      return;
    }
    if (!validGraphicValue(parameter, input.value)) throw new CommandError('invalid-input', `Invalid value for ${parameter.label}`);
    (((graphics[input.type] ??= {})[input.view] ??= {})[input.style] ??= {})[input.id] = input.value;
  },
});

export const setElementGraphic = defineMutation({
  id: 'set-element-graphic',
  label: 'Override element graphic',
  description: 'Overrides one element in Hidden line, or resets it to the type default.',
  group: 'document',
  palette: false,
  history: 'record',
  input: z.object({ id: z.string().min(1), parameter: z.string().min(1), value: JsonValueSchema.optional(), reset: z.boolean().default(false) }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    if (!element) throw new CommandError('rejected', `Element not found: ${input.id}`);
    const type = graphicTypeOfElement(element) ?? (element.kind === 'rect' || element.kind === 'line' || element.kind === 'text' || element.kind === 'image' ? element.kind : null);
    if (!type) throw new CommandError('rejected', 'This element has no Hidden line graphics');
    const parameter = graphicParameter(type, input.parameter);
    if (!parameter || !parameter.views.includes('board') || (parameter.styles && !parameter.styles.includes('hidden-line'))) throw new CommandError('invalid-input', `Unknown Hidden line parameter ${type}.${input.parameter}`);
    if (parameter.locked) throw new CommandError('rejected', `${parameter.label} is locked`);
    const meta = { ...(element.meta ?? {}) };
    const rootValue = meta['graphics'];
    const root = rootValue && typeof rootValue === 'object' && !Array.isArray(rootValue) ? { ...rootValue } : {};
    const hiddenValue = root['hiddenLine'];
    const hidden = hiddenValue && typeof hiddenValue === 'object' && !Array.isArray(hiddenValue) ? { ...hiddenValue } : {};
    if (input.reset) delete hidden[input.parameter];
    else {
      if (!validGraphicValue(parameter, input.value)) throw new CommandError('invalid-input', `Invalid value for ${parameter.label}`);
      hidden[input.parameter] = input.value;
    }
    if (Object.keys(hidden).length > 0) root['hiddenLine'] = hidden;
    else delete root['hiddenLine'];
    if (Object.keys(root).length > 0) meta['graphics'] = root;
    else delete meta['graphics'];
    element.meta = Object.keys(meta).length > 0 ? meta : undefined;
  },
});

export const resetElementGraphics = defineMutation({
  id: 'reset-element-graphics',
  label: 'Use default element graphics',
  description: 'Removes every individual Hidden line override from one element.',
  group: 'document',
  palette: false,
  history: 'record',
  input: z.object({ id: z.string().min(1) }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    if (!element?.meta) return;
    const meta = { ...element.meta };
    delete meta['graphics'];
    element.meta = Object.keys(meta).length > 0 ? meta : undefined;
  },
});

export const resetGraphics = defineMutation({
  id: 'reset-graphics',
  label: 'Reset element graphics',
  description: 'Removes the graphics overrides of one element type, or of the whole document.',
  group: 'document',
  history: 'record',
  input: z.object({ type: z.string().min(1).optional() }).prefault({}),
  run: (ctx, input) => {
    if (input.type) delete (ctx.doc.workspace.graphics as GraphicsOverrides)[input.type];
    else ctx.doc.workspace.graphics = {};
  },
});

export const applyGraphics = defineMutation({
  id: 'apply-graphics',
  label: 'Apply graphics',
  description: 'Replaces the document graphics overrides with the given set (used by presets).',
  group: 'document',
  palette: false,
  history: 'record',
  input: z.object({ graphics: z.record(z.string(), JsonValueSchema) }),
  run: (ctx, input) => {
    ctx.doc.workspace.graphics = sanitizeOverrides(input.graphics);
  },
});

// ---- presets --------------------------------------------------------------------------------

export async function userGraphicsPresets(ctx: EffectContext): Promise<GraphicsPreset[]> {
  return parseStoredPresets(await ctx.platform.storage.get(GRAPHICS_PRESETS_STORAGE_KEY));
}

async function writeUserPresets(ctx: EffectContext, presets: GraphicsPreset[]): Promise<void> {
  if (presets.length === 0) await ctx.platform.storage.delete(GRAPHICS_PRESETS_STORAGE_KEY);
  else await ctx.platform.storage.set(GRAPHICS_PRESETS_STORAGE_KEY, graphicsPresetFile(presets));
}

export const saveGraphicsPreset = defineEffect({
  id: 'save-graphics-preset',
  label: 'Save graphics preset',
  description: "Saves the document's graphics overrides as a named preset on this machine (replacing one with the same name).",
  aliases: ['save graphics'],
  group: 'document',
  palette: false,
  input: z.object({ name: z.string().trim().min(1).max(120) }),
  run: async (ctx, input) => {
    const id = presetSlug(input.name);
    if (BUILTIN_GRAPHICS_PRESETS.some((preset) => preset.id === id)) throw new CommandError('rejected', `"${input.name}" is a built-in preset; choose another name`);
    const preset: GraphicsPreset = { id, name: input.name, graphics: sanitizeOverrides(ctx.read().doc.workspace.graphics) };
    const presets = (await userGraphicsPresets(ctx)).filter((item) => item.id !== id);
    presets.push(preset);
    await writeUserPresets(ctx, presets);
    return id;
  },
});

export const deleteGraphicsPreset = defineEffect({
  id: 'delete-graphics-preset',
  label: 'Delete graphics preset',
  group: 'document',
  palette: false,
  input: z.object({ presetId: z.string().min(1) }),
  run: async (ctx, input) => {
    const presets = (await userGraphicsPresets(ctx)).filter((item) => item.id !== input.presetId);
    await writeUserPresets(ctx, presets);
    return presets.length;
  },
});

export const applyGraphicsPreset = defineEffect({
  id: 'apply-graphics-preset',
  label: 'Apply graphics preset',
  description: 'Replaces the document graphics with a built-in or saved preset.',
  aliases: ['graphics preset'],
  group: 'document',
  palette: false,
  input: z.object({ presetId: z.string().min(1) }),
  run: async (ctx, input) => {
    const preset = BUILTIN_GRAPHICS_PRESETS.find((item) => item.id === input.presetId) ?? (await userGraphicsPresets(ctx)).find((item) => item.id === input.presetId);
    if (!preset) throw new CommandError('invalid-input', `No graphics preset "${input.presetId}"`);
    ctx.dispatchSync('apply-graphics', { graphics: preset.graphics });
    return preset.id;
  },
});

function downloadText(text: string, fileName: string): void {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const exportGraphicsPresets = defineEffect({
  id: 'export-graphics-presets',
  label: 'Export graphics presets',
  description: 'Downloads one saved preset, or all of them, as a portable graphics presets file. Without a preset id the current document graphics are exported under `name`.',
  aliases: ['export graphics', 'share graphics'],
  group: 'document',
  input: z.object({ presetId: z.string().min(1).optional(), name: z.string().trim().min(1).max(120).optional(), all: z.boolean().default(false) }).prefault({}),
  run: async (ctx, input) => {
    const user = await userGraphicsPresets(ctx);
    let presets: GraphicsPreset[];
    let fileName: string;
    if (input.all) {
      presets = user;
      fileName = 'graphics-presets.json';
      if (presets.length === 0) throw new CommandError('rejected', 'There are no saved graphics presets to export');
    } else if (input.presetId) {
      const preset = user.find((item) => item.id === input.presetId) ?? BUILTIN_GRAPHICS_PRESETS.find((item) => item.id === input.presetId);
      if (!preset) throw new CommandError('invalid-input', `No graphics preset "${input.presetId}"`);
      presets = [preset];
      fileName = `${preset.id}.graphics.json`;
    } else {
      const name = input.name ?? ctx.read().doc.meta.name ?? 'Graphics';
      presets = [{ id: presetSlug(name), name, graphics: sanitizeOverrides(ctx.read().doc.workspace.graphics) }];
      fileName = `${presetSlug(name)}.graphics.json`;
    }
    downloadText(graphicsPresetFile(presets), fileName);
    return presets.length;
  },
});

export const importGraphicsPresets = defineEffect({
  id: 'import-graphics-presets',
  label: 'Import graphics presets',
  description: 'Adds the presets from a graphics presets file to the saved presets (replacing ones with the same id).',
  aliases: ['import graphics'],
  group: 'document',
  palette: false,
  input: z.object({ text: z.string().min(1) }),
  run: async (ctx, input) => {
    let incoming: GraphicsPreset[];
    try {
      incoming = readGraphicsPresetFile(input.text);
    } catch (error) {
      throw new CommandError('invalid-input', error instanceof Error ? error.message : 'Unreadable presets file');
    }
    if (incoming.length === 0) throw new CommandError('rejected', 'The file holds no presets');
    const ids = new Set(incoming.map((preset) => preset.id));
    const presets = (await userGraphicsPresets(ctx)).filter((preset) => !ids.has(preset.id));
    presets.push(...incoming);
    await writeUserPresets(ctx, presets);
    return incoming.map((preset) => preset.id);
  },
});

export const graphicsCommands = [openGraphics, closeGraphics, setGraphic, setElementGraphic, resetElementGraphics, resetGraphics, applyGraphics, saveGraphicsPreset, deleteGraphicsPreset, applyGraphicsPreset, exportGraphicsPresets, importGraphicsPresets];

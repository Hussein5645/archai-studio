/**
 * Graphics presets: a named set of overrides. Built-in ones live here; the user's are kept in
 * platform storage (`graphics-presets`) and travel as a portable JSON file:
 * `{ archaiGraphics: 1, presets: [{ id, name, graphics }] }` (a single preset without the
 * `presets` array is accepted too).
 */
import { z } from 'zod';
import { JsonValueSchema, type JsonValue } from '@/document/schema';
import { GRAPHIC_TYPES, graphicParameter, graphicType, type GraphicView, type GraphicsOverrides } from './schema';
import { ALL_STYLES, validGraphicValue } from './resolve';

export interface GraphicsPreset {
  id: string;
  name: string;
  graphics: GraphicsOverrides;
  builtin?: boolean;
}

export const GRAPHICS_PRESETS_STORAGE_KEY = 'graphics-presets';

const OverridesSchema = z.record(z.string(), z.record(z.string(), z.record(z.string(), z.record(z.string(), JsonValueSchema))));
const PresetSchema = z.object({ id: z.string().min(1).max(120).optional(), name: z.string().trim().min(1).max(120), graphics: OverridesSchema });
const FileSchema = z.union([z.object({ archaiGraphics: z.literal(1), presets: z.array(PresetSchema) }), z.object({ archaiGraphics: z.literal(1) }).and(PresetSchema)]);

export function presetSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'preset';
}

/**
 * Keeps only known types, views, parameters and valid values (locked parameters and unknown
 * keys are dropped), so a preset from another version cannot put junk in a document.
 */
export function sanitizeOverrides(input: unknown): GraphicsOverrides {
  const parsed = OverridesSchema.safeParse(input);
  const result: GraphicsOverrides = {};
  if (!parsed.success) return result;
  for (const [typeId, byView] of Object.entries(parsed.data)) {
    const type = graphicType(typeId);
    if (!type) continue;
    for (const [view, byStyle] of Object.entries(byView)) {
      if (view !== 'board' && view !== 'section' && view !== '3d') continue;
      for (const [style, values] of Object.entries(byStyle)) {
        // `*` is the legacy representation of the same global graphics settings.
        // New presets keep them explicitly scoped to Hidden line.
        if (style !== ALL_STYLES && style !== 'hidden-line') continue;
        for (const [id, value] of Object.entries(values)) {
          const parameter = graphicParameter(typeId, id);
          if (!parameter || parameter.locked || !parameter.views.includes(view as GraphicView) || !validGraphicValue(parameter, value)) continue;
          if (parameter.styles && !parameter.styles.includes('hidden-line')) continue;
          ((((result[typeId] ??= {})[view] ??= {})['hidden-line'] ??= {}) as Record<string, JsonValue>)[id] = value;
        }
      }
    }
  }
  return result;
}

/** Parses a presets file (one preset or many). Throws on anything that is not a presets file. */
export function readGraphicsPresetFile(text: string): GraphicsPreset[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('That file is not JSON');
  }
  const parsed = FileSchema.safeParse(json);
  if (!parsed.success) throw new Error('That file is not an ArchAI graphics presets file');
  const list = 'presets' in parsed.data ? parsed.data.presets : [parsed.data];
  return list.map((preset) => ({ id: preset.id ?? presetSlug(preset.name), name: preset.name, graphics: sanitizeOverrides(preset.graphics) }));
}

export function graphicsPresetFile(presets: readonly GraphicsPreset[]): string {
  return JSON.stringify({ archaiGraphics: 1, presets: presets.map(({ id, name, graphics }) => ({ id, name, graphics })) }, null, 2);
}

/** Parses the stored user presets (anything unreadable yields none). */
export function parseStoredPresets(text: string | null): GraphicsPreset[] {
  if (!text) return [];
  try {
    return readGraphicsPresetFile(text);
  } catch {
    return [];
  }
}

// ---- built-in presets -----------------------------------------------------------------------

/** Monochrome office look: black ink everywhere, white fills, hatched cuts. */
function inkPreset(): GraphicsOverrides {
  const graphics: GraphicsOverrides = {};
  const set = (type: string, view: GraphicView, id: string, value: JsonValue) => {
    (((graphics[type] ??= {})[view] ??= {})['hidden-line'] ??= {})[id] = value;
  };
  for (const type of GRAPHIC_TYPES) {
    for (const parameter of type.parameters) {
      if (parameter.locked || parameter.kind !== 'color') continue;
      const board = parameter.views.includes('board');
      const section = parameter.views.includes('section');
      const hiddenLine = !parameter.styles || parameter.styles.includes('hidden-line');
      if (board && hiddenLine && (parameter.id.includes('fill') || parameter.id === 'fill')) set(type.id, 'board', parameter.id, '#ffffff');
      else if (board && hiddenLine && parameter.id !== 'pattern.stroke') set(type.id, 'board', parameter.id, '#111111');
      if (section && parameter.id.startsWith('cut.') && !parameter.id.includes('hatch') && !parameter.id.includes('outline')) set(type.id, 'section', parameter.id, '#ffffff');
      if (section && parameter.id === 'cut.hatchColor') set(type.id, 'section', parameter.id, '#111111');
    }
    if (type.parameters.some((parameter) => parameter.id === 'cut.hatch')) set(type.id, 'section', 'cut.hatch', 'diagonal');
  }
  set('wall', 'board', 'layer.stroke', '#111111');
  set('wall', 'section', 'cut.coreHatch', 'diagonal');
  set('section', 'section', 'background', '#ffffff');
  return graphics;
}

export const BUILTIN_GRAPHICS_PRESETS: readonly GraphicsPreset[] = [
  { id: 'default', name: 'Default', graphics: {}, builtin: true },
  { id: 'ink', name: 'Ink', graphics: inkPreset(), builtin: true },
];

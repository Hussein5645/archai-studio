/**
 * System presets. Any system `.CAI` package carries named presets (parameter sets); the ones the
 * user saves from the configuration dialog live in one local package per tool
 * (`local-<type>-presets`), so importing a package brings all of its presets in and exporting
 * writes them back out as a package for the R2 `system/<tool>/` folder.
 */
import { strToU8 } from 'fflate';
import { z } from 'zod';
import { wallSectionSvg } from '@/assets/system-geometry';
import {
  createCaiPackage,
  extractCaiPackage,
  localPresetsId,
  parseSystemParameters,
  presetAssetId,
  SYSTEM_TYPES,
  type CaiMetadata,
  type SystemPreset,
  type SystemType,
} from '@/catalog';
import { JsonValueSchema } from '@/document';
import { CommandError, defineEffect, type EffectContext } from '../contract';

const Type = z.enum(SYSTEM_TYPES);

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'preset';
}

async function localPresets(ctx: EffectContext, type: SystemType): Promise<SystemPreset[]> {
  const bytes = ctx.catalog.localPackageBytes ? await ctx.catalog.localPackageBytes(localPresetsId(type)) : null;
  if (!bytes) return [];
  try {
    return (extractCaiPackage(bytes).metadata.system?.presets ?? []) as SystemPreset[];
  } catch {
    return [];
  }
}

function title(type: SystemType): string {
  return type.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function presetsPackage(type: SystemType, presets: SystemPreset[]): Uint8Array {
  const metadata: CaiMetadata = {
    caiVersion: 1,
    id: localPresetsId(type),
    name: `My ${title(type).toLowerCase()} presets`,
    kind: 'system',
    system: { type, parameters: {}, presets },
    size: { width: 0, height: 0 },
  };
  // A swatch keeps the package self-describing; walls draw their layers, other tools a label.
  const first = presets[0];
  const layers = first && Array.isArray(first['layers']) ? (first['layers'] as { name: string; role: string; thickness: number }[]) : null;
  const swatch = layers
    ? wallSectionSvg(layers)
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><rect width="300" height="200" fill="#eef0f3"/><text x="150" y="108" text-anchor="middle" font-size="16" font-family="sans-serif" fill="#3a3a3f">${title(type)} presets</text></svg>`;
  return createCaiPackage({ metadata, sectionView: { name: 'section.svg', bytes: strToU8(swatch) } });
}

async function writePresets(ctx: EffectContext, type: SystemType, presets: SystemPreset[]): Promise<void> {
  if (!ctx.catalog.addLocalPackage || !ctx.catalog.deleteLocalPackage) throw new CommandError('rejected', 'Catalog does not support local packages');
  if (presets.length === 0) {
    await ctx.catalog.deleteLocalPackage(localPresetsId(type));
    return;
  }
  await ctx.catalog.addLocalPackage(presetsPackage(type, presets));
}

export const saveSystemPreset = defineEffect({
  id: 'save-system-preset',
  label: 'Save preset',
  description: 'Saves the given parameters as a named local preset for a system tool (replacing one with the same name).',
  aliases: ['save wall preset', 'save door preset'],
  group: 'edit',
  palette: false,
  input: z.object({ type: Type, name: z.string().trim().min(1).max(120), parameters: z.record(z.string(), JsonValueSchema), instanceEditable: z.array(z.string()).default([]) }),
  run: async (ctx, input) => {
    const parameters = parseSystemParameters(input.type, input.parameters) as Record<string, unknown>;
    const preset: SystemPreset = { ...parameters, id: slug(input.name), name: input.name, instanceEditable: input.instanceEditable };
    const presets = (await localPresets(ctx, input.type)).filter((item) => item.id !== preset.id);
    presets.push(preset);
    await writePresets(ctx, input.type, presets);
    const assetId = presetAssetId(localPresetsId(input.type), preset.id);
    const instance = Object.values(ctx.getState().doc.elements).find((element) => {
      const arch = element.meta?.['arch'];
      return arch && typeof arch === 'object' && !Array.isArray(arch) && arch['type'] === input.type && arch['systemAssetId'] === assetId;
    });
    if (instance) {
      const result = ctx.dispatchSync('set-system-configuration', { id: instance.id, assetId, assetName: input.name, parameters, instanceEditable: input.instanceEditable, applyTo: 'type' });
      if (!result.ok) throw new CommandError(result.error.code, result.error.message);
    }
    return assetId;
  },
});

export const deleteSystemPreset = defineEffect({
  id: 'delete-system-preset',
  label: 'Delete preset',
  description: 'Removes a preset from the local presets of a system tool.',
  group: 'edit',
  palette: false,
  input: z.object({ type: Type, presetId: z.string().min(1) }),
  run: async (ctx, input) => {
    const presets = (await localPresets(ctx, input.type)).filter((item) => item.id !== input.presetId);
    await writePresets(ctx, input.type, presets);
    return presets.length;
  },
});

/** Portable preset file: `{ archaiPresets: 1, type, presets }` (a system .CAI is also accepted on import). */
const PresetFileSchema = z.object({ archaiPresets: z.literal(1), type: Type, presets: z.array(z.record(z.string(), JsonValueSchema)) });

function downloadJson(value: unknown, fileName: string): void {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const exportSystemPresets = defineEffect({
  id: 'export-system-presets',
  label: 'Export presets',
  description: 'Downloads the local presets of a system tool as a presets file that Import presets reads back.',
  aliases: ['export presets', 'export wall presets'],
  group: 'edit',
  input: z.object({ type: Type.default('wall'), fileName: z.string().optional() }).prefault({}),
  run: async (ctx, input) => {
    const presets = await localPresets(ctx, input.type);
    if (presets.length === 0) throw new CommandError('rejected', `There are no local ${title(input.type).toLowerCase()} presets to export`);
    downloadJson({ archaiPresets: 1, type: input.type, presets }, input.fileName ?? `${input.type}-presets.json`);
    return presets.length;
  },
});

/** Reads presets from a presets file or a system .CAI package; the tool must match `type`. */
export function readPresetFile(type: SystemType, bytes: Uint8Array): SystemPreset[] {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  let fileType: SystemType;
  let raw: Record<string, unknown>[];
  if (isZip) {
    const metadata = extractCaiPackage(bytes).metadata;
    if (metadata.kind !== 'system' || !metadata.system) throw new CommandError('invalid-input', 'That package is not a system type');
    fileType = metadata.system.type as SystemType;
    raw = (metadata.system.presets ?? []) as Record<string, unknown>[];
  } else {
    const parsed = PresetFileSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!parsed.success) throw new CommandError('invalid-input', 'That file is not an ArchAI presets file');
    fileType = parsed.data.type;
    raw = parsed.data.presets;
  }
  if (fileType !== type) throw new CommandError('invalid-input', `Those are ${title(fileType).toLowerCase()} presets, not ${title(type).toLowerCase()} presets`);
  return raw.map((entry) => {
    const { id, name, instanceEditable, ...parameters } = entry;
    const label = typeof name === 'string' && name.trim() ? name : 'Preset';
    return { ...(parseSystemParameters(type, parameters) as Record<string, unknown>), id: typeof id === 'string' && id ? id : slug(label), name: label, instanceEditable: Array.isArray(instanceEditable) ? instanceEditable.filter((key): key is string => typeof key === 'string') : [] } as SystemPreset;
  });
}

export const importSystemPresets = defineEffect({
  id: 'import-system-presets',
  label: 'Import presets',
  description: 'Adds the presets from a presets file (or a system .CAI) to the local presets of a tool, replacing ones with the same id.',
  aliases: ['import presets'],
  group: 'edit',
  palette: false,
  input: z.object({ type: Type, bytes: z.instanceof(Uint8Array) }),
  run: async (ctx, input) => {
    const incoming = readPresetFile(input.type, input.bytes);
    if (incoming.length === 0) throw new CommandError('rejected', 'The file holds no presets');
    const ids = new Set(incoming.map((preset) => preset.id));
    const presets = (await localPresets(ctx, input.type)).filter((preset) => !ids.has(preset.id));
    presets.push(...incoming);
    await writePresets(ctx, input.type, presets);
    return incoming.length;
  },
});

export const presetCommands = [saveSystemPreset, deleteSystemPreset, exportSystemPresets, importSystemPresets];

/**
 * Material commands (docs/materials.md): the document's material library (create from a preset
 * or from scratch, edit, duplicate, delete, textures, packs) and assignments to element slots and
 * painted surfaces (with zones). Every edit is one undo step.
 */
import { z } from 'zod';
import { archOf, archTypeOf } from '@/assets/arch-meta';
import { parseSystemParameters } from '@/catalog';
import { IdSchema, MaterialSchema, SurfacePaintSchema, ZoneSchema, type ArchaiDocument, type Element, type JsonValue, type Material, type SurfacePaint } from '@/document';
import { builtinDefault, DEFAULT_MATERIAL_IDS, isDefaultMaterialId, presetById, PRESETS } from '@/materials/builtin';
import { readMaterialPack, writeMaterialPack } from '@/materials/pack';
import { materialById, materialIdsUsedBy, slotsOf, surfacePaintOf, surfacesOf } from '@/materials/slots';
import { base64ToBytes } from '@/persistence/base64';
import type { GraphicsOverrides } from '@/graphics';
import { CommandError, defineEffect, defineMutation, type MutationContext } from '../contract';
import { snapshot } from '../helpers';
import { BlobInput, ensureBlob } from './create';

/** Material fields a caller may set (everything but the id). */
const MaterialPatch = MaterialSchema.omit({ id: true }).partial();

function newMaterialId(ctx: MutationContext): string {
  let id = ctx.ids.next('mat');
  while (ctx.doc.materials[id]) id = ctx.ids.next('mat');
  return id;
}

function requireMaterial(doc: ArchaiDocument, id: string): Material {
  const material = materialById(doc, id);
  if (!material) throw new CommandError('rejected', `Unknown material ${id}`);
  return material;
}

/** Validates a full record (defaults applied); a bad patch is reported as invalid input. */
function validated(input: unknown): Material {
  const parsed = MaterialSchema.safeParse(input);
  if (!parsed.success) throw new CommandError('invalid-input', parsed.error.issues[0]?.message ?? 'Invalid material', parsed.error.issues);
  return parsed.data;
}

export const createMaterial = defineMutation({
  id: 'create-material',
  label: 'New material',
  description: 'Adds a material to the document library: a copy of a built-in preset (see list-material-presets) or a new one from the given fields, optionally with texture maps (image bytes, stored once in the document). Returns its id.',
  aliases: ['material', 'texture', 'finish'],
  group: 'create',
  history: 'record',
  input: z
    .object({
      preset: z.string().optional(),
      material: MaterialPatch.optional(),
      textures: z.partialRecord(z.enum(['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']), BlobInput).optional(),
    })
    .prefault({}),
  run: (ctx, input) => {
    const id = newMaterialId(ctx);
    const preset = input.preset ? presetById(input.preset) : null;
    if (input.preset && !preset) throw new CommandError('rejected', `Unknown preset ${input.preset}`);
    const base = preset ?? { name: 'New material', color: '#c9ccd3' };
    const maps: Record<string, { blobId: string }> = {};
    for (const [channel, blob] of Object.entries(input.textures ?? {})) if (blob) maps[channel] = { blobId: ensureBlob(ctx.doc, blob) };
    const material = validated({ ...base, ...input.material, ...maps, id });
    ctx.doc.materials[id] = material;
    return id;
  },
});

export const updateMaterial = defineMutation({
  id: 'update-material',
  label: 'Edit material',
  description: 'Changes fields of a library material (a built-in default is copied into the library first). Pass `null` for a texture map to remove it.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({
    id: z.string().min(1).max(64),
    patch: MaterialPatch.extend({
      map: MaterialSchema.shape.map.nullable(),
      roughnessMap: MaterialSchema.shape.roughnessMap.nullable(),
      metalnessMap: MaterialSchema.shape.metalnessMap.nullable(),
      normalMap: MaterialSchema.shape.normalMap.nullable(),
      aoMap: MaterialSchema.shape.aoMap.nullable(),
    }).partial(),
  }),
  run: (ctx, input) => {
    const current = requireMaterial(ctx.doc, input.id);
    const next: Record<string, unknown> = { ...snapshot(current), ...input.patch, id: input.id };
    for (const [key, value] of Object.entries(input.patch)) if (value === null) delete next[key];
    ctx.doc.materials[input.id] = validated(next);
  },
});

export const duplicateMaterial = defineMutation({
  id: 'duplicate-material',
  label: 'Duplicate material',
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({ id: z.string().min(1).max(64) }),
  run: (ctx, input) => {
    const source = requireMaterial(ctx.doc, input.id);
    const id = newMaterialId(ctx);
    const { source: _origin, ...copy } = snapshot(source);
    ctx.doc.materials[id] = validated({ ...copy, id, name: `${source.name} copy`.slice(0, 80) });
    return id;
  },
});

/** Every element whose slots, layers or painted surfaces use a material. */
export function elementsUsingMaterial(doc: ArchaiDocument, id: string): Element[] {
  return Object.values(doc.elements).filter((element) => materialIdsUsedBy(element).has(id));
}

/** Replaces (or, with null, removes) every reference to a material on an element. */
function replaceReferences(element: Element, from: string, to: string | null): void {
  const meta = snapshot(element.meta ?? {}) as Record<string, JsonValue>;
  const own = meta['materials'];
  if (own && typeof own === 'object' && !Array.isArray(own)) {
    for (const [slot, value] of Object.entries(own)) {
      if (value !== from) continue;
      if (to) own[slot] = to;
      else delete own[slot];
    }
  }
  const surfaces = meta['surfaces'];
  if (surfaces && typeof surfaces === 'object' && !Array.isArray(surfaces)) {
    for (const [surface, list] of Object.entries(surfaces)) {
      if (!Array.isArray(list)) continue;
      const next = list.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry['material'] !== from) return [entry];
        return to ? [{ ...entry, material: to }] : [];
      });
      if (next.length) surfaces[surface] = next;
      else delete surfaces[surface];
    }
  }
  const arch = meta['arch'];
  const parameters = arch && typeof arch === 'object' && !Array.isArray(arch) ? arch['parameters'] : null;
  if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) {
    const typed = parameters['materials'];
    if (typed && typeof typed === 'object' && !Array.isArray(typed)) {
      for (const [slot, value] of Object.entries(typed)) {
        if (value !== from) continue;
        if (to) typed[slot] = to;
        else delete typed[slot];
      }
    }
    const layers = parameters['layers'];
    if (Array.isArray(layers)) {
      for (const layer of layers) {
        if (!layer || typeof layer !== 'object' || Array.isArray(layer) || layer['material'] !== from) continue;
        if (to) layer['material'] = to;
        else delete layer['material'];
      }
    }
  }
  element.meta = meta;
}

export const deleteMaterial = defineMutation({
  id: 'delete-material',
  label: 'Delete material',
  description: 'Removes a material from the library. Elements using it switch to `replaceWith`, or back to their defaults. A built-in default is reset instead.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: z.string().min(1).max(64), replaceWith: z.string().min(1).max(64).nullable().default(null) }),
  run: (ctx, input) => {
    if (!ctx.doc.materials[input.id]) throw new CommandError('rejected', isDefaultMaterialId(input.id) ? 'This default material is not edited' : `Unknown material ${input.id}`);
    delete ctx.doc.materials[input.id];
    // Defaults stay valid references: deleting one only resets it.
    if (isDefaultMaterialId(input.id)) return;
    if (input.replaceWith) requireMaterial(ctx.doc, input.replaceWith);
    for (const element of Object.values(ctx.doc.elements)) {
      if (materialIdsUsedBy(element).has(input.id)) replaceReferences(element, input.id, input.replaceWith);
    }
  },
});

export const setMaterialTexture = defineMutation({
  id: 'set-material-texture',
  label: 'Set material texture',
  description: 'Sets a texture map of a material from image bytes (stored once in the document), or removes it with `blob: null`.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: z.string().min(1).max(64), channel: z.enum(['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']), blob: BlobInput.nullable() }),
  run: (ctx, input) => {
    const current = requireMaterial(ctx.doc, input.id);
    const next: Record<string, unknown> = { ...snapshot(current) };
    if (input.blob) next[input.channel] = { blobId: ensureBlob(ctx.doc, input.blob) };
    else delete next[input.channel];
    ctx.doc.materials[input.id] = validated(next);
  },
});

function slotOrThrow(element: Element, slot: string): void {
  // Model materials are only known once the model is loaded: any name is accepted.
  if (slot.startsWith('asset:') && (element.kind === 'instance' || element.meta?.['mesh'])) return;
  if (!slotsOf(element).some((info) => info.key === slot)) throw new CommandError('rejected', `${element.name ?? element.kind} has no material slot "${slot}"`);
}

export const assignMaterial = defineMutation({
  id: 'assign-material',
  label: 'Assign material',
  description:
    'Puts a material on elements: on a `surface` (sideA / sideB / top / bottom / ends / reveals / sides; optional `zone` in face mm, added on top of earlier paint), or on a `slot` (wall `layer:<i>`, door `leaf`/`frame`, `glass`, stair `tread`...; `scope: "type"` stores it in the type parameters so presets carry it). `materialId: null` clears it.',
  aliases: ['paint', 'apply material'],
  group: 'edit',
  palette: false,
  history: 'record',
  input: z
    .object({
      ids: z.array(IdSchema).min(1),
      materialId: z.string().min(1).max(64).nullable(),
      slot: z.string().min(1).max(80).optional(),
      surface: z.string().min(1).max(20).optional(),
      zone: ZoneSchema.optional(),
      scope: z.enum(['instance', 'type']).default('instance'),
    })
    .refine((value) => Boolean(value.slot) !== Boolean(value.surface), 'Give either a slot or a surface'),
  run: (ctx, input) => {
    if (input.materialId) requireMaterial(ctx.doc, input.materialId);
    for (const id of input.ids) {
      const element = ctx.doc.elements[id];
      if (!element) throw new CommandError('rejected', `Unknown element ${id}`);
      if (element.locked) throw new CommandError('rejected', `${element.name ?? 'The element'} is locked`);
      const meta = snapshot(element.meta ?? {}) as Record<string, JsonValue>;
      if (input.surface) {
        if (!surfacesOf(element).includes(input.surface as never)) throw new CommandError('rejected', `${element.name ?? element.kind} has no surface "${input.surface}"`);
        const surfaces = { ...((meta['surfaces'] as Record<string, JsonValue> | undefined) ?? {}) };
        const current = (surfacePaintOf(element)[input.surface as keyof ReturnType<typeof surfacePaintOf>] ?? []) as SurfacePaint[];
        // A zone adds a layer of paint; a whole-surface paint replaces everything on it.
        const next = input.materialId === null ? [] : input.zone ? [...current, { material: input.materialId, zone: input.zone }] : [{ material: input.materialId }];
        if (next.length) surfaces[input.surface] = next as unknown as JsonValue;
        else delete surfaces[input.surface];
        meta['surfaces'] = surfaces;
        element.meta = meta;
        continue;
      }
      const slot = input.slot!;
      slotOrThrow(element, slot);
      if (input.scope === 'instance') {
        const own = { ...((meta['materials'] as Record<string, JsonValue> | undefined) ?? {}) };
        if (input.materialId) own[slot] = input.materialId;
        else delete own[slot];
        meta['materials'] = own;
        element.meta = meta;
        continue;
      }
      const type = archTypeOf(element);
      const arch = meta['arch'] as Record<string, JsonValue> | undefined;
      if (!type || !arch) throw new CommandError('rejected', 'Only system elements have a type');
      const parameters = { ...((arch['parameters'] as Record<string, JsonValue> | undefined) ?? {}) };
      const layer = slot.match(/^layer:(\d+)$/);
      if (type === 'wall' && layer) {
        const layers = parseSystemParameters('wall', archOf(element)?.['parameters']).layers.map((entry) => ({ ...entry }));
        const target = layers[Number(layer[1])];
        if (!target) throw new CommandError('rejected', `The wall has no layer ${layer[1]}`);
        if (input.materialId) target.material = input.materialId;
        else delete target.material;
        parameters['layers'] = layers as unknown as JsonValue;
      } else {
        const typed = { ...((parameters['materials'] as Record<string, JsonValue> | undefined) ?? {}) };
        if (input.materialId) typed[slot] = input.materialId;
        else delete typed[slot];
        parameters['materials'] = typed;
      }
      element.meta = { ...meta, arch: { ...arch, parameters } };
    }
  },
});

export const setSurfacePaint = defineMutation({
  id: 'set-surface-paint',
  label: 'Edit surface paint',
  description: 'Replaces the list of paints on one surface of an element (later entries on top; zones in face mm: u along the face, v up from its base).',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, surface: z.string().min(1).max(20), paints: z.array(SurfacePaintSchema) }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    if (!element) throw new CommandError('rejected', `Unknown element ${input.id}`);
    if (!surfacesOf(element).includes(input.surface as never)) throw new CommandError('rejected', `No surface "${input.surface}"`);
    for (const paint of input.paints) requireMaterial(ctx.doc, paint.material);
    const meta = snapshot(element.meta ?? {}) as Record<string, JsonValue>;
    const surfaces = { ...((meta['surfaces'] as Record<string, JsonValue> | undefined) ?? {}) };
    if (input.paints.length) surfaces[input.surface] = input.paints as unknown as JsonValue;
    else delete surfaces[input.surface];
    element.meta = { ...meta, surfaces };
  },
});

export const importMaterialPack = defineMutation({
  id: 'import-material-pack',
  label: 'Import materials',
  description: 'Adds the materials (and their textures) of a material pack `.cai`, given as base64. `source` records where a one-material pack came from (library:<id>, mine:<id>). Returns the new ids.',
  group: 'document',
  palette: false,
  history: 'record',
  input: z.object({ data: z.string().min(1), source: z.string().max(200).optional() }),
  run: (ctx, input) => {
    let pack;
    try {
      pack = readMaterialPack(base64ToBytes(input.data));
    } catch (error) {
      throw new CommandError('rejected', error instanceof Error ? error.message : 'Not a material pack');
    }
    const blobIds = new Map<string, string>();
    for (const blob of pack.blobs) blobIds.set(blob.id, ensureBlob(ctx.doc, blob));
    const added: string[] = [];
    for (const material of pack.materials) {
      const id = ctx.doc.materials[material.id] || isDefaultMaterialId(material.id) || material.id.startsWith('preset:') ? newMaterialId(ctx) : material.id;
      const remap = (ref: Material['map']) => (ref && 'blobId' in ref ? { blobId: blobIds.get(ref.blobId) ?? ref.blobId } : ref);
      ctx.doc.materials[id] = validated({ ...material, ...(input.source && pack.materials.length === 1 ? { source: input.source } : {}), id, map: remap(material.map), normalMap: remap(material.normalMap), roughnessMap: remap(material.roughnessMap), metalnessMap: remap(material.metalnessMap), aoMap: remap(material.aoMap) });
      added.push(id);
    }
    return added;
  },
});

export const exportMaterialPack = defineEffect({
  id: 'export-material-pack',
  label: 'Export materials…',
  description: 'Saves library materials (all, or `ids`) with their textures as a material pack `.cai`.',
  group: 'document',
  palette: false,
  input: z.object({ ids: z.array(z.string()).optional(), name: z.string().max(80).optional() }).prefault({}),
  run: async (ctx, input) => {
    const doc = ctx.getState().doc;
    const ids = input.ids ?? Object.keys(doc.materials);
    const materials = ids.flatMap((id) => {
      const material = materialById(doc, id);
      return material ? [material] : [];
    });
    if (materials.length === 0) throw new CommandError('rejected', 'There are no materials to export');
    const name = input.name?.trim() || `${doc.meta.name || 'Project'} materials`;
    const bytes = writeMaterialPack(doc, materials, name);
    const saved = await ctx.platform.files.saveBinary(bytes, `${name.replace(/[\\/:*?"<>|]+/g, '-')}.cai`, 'application/zip');
    if (!saved) throw new CommandError('cancelled', 'Export cancelled');
    return { count: materials.length, path: saved.path };
  },
});

export const listMaterialPresets = defineMutation({
  id: 'list-material-presets',
  label: 'Material presets',
  description: 'Lists the built-in material presets (ids for create-material) and the default material of each slot.',
  group: 'view',
  palette: false,
  history: 'none',
  input: z.void(),
  run: () => ({ presets: PRESETS.map((preset) => ({ id: preset.id, name: preset.name, category: preset.category })), defaults: DEFAULT_MATERIAL_IDS }),
});

export const paintElement = defineMutation({
  id: 'paint-element',
  label: 'Paint whole object',
  description: 'Puts one material on every part of elements: all their slots (wall layers, door leaf and frame..., plus the model materials named in `assetSlots` for assets and imported meshes) and clears painted surfaces.',
  aliases: ['material whole element', 'paint object'],
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ ids: z.array(IdSchema).min(1), materialId: z.string().min(1).max(64), assetSlots: z.array(z.string().min(1).max(80)).default([]) }),
  run: (ctx, input) => {
    requireMaterial(ctx.doc, input.materialId);
    let painted = 0;
    for (const id of input.ids) {
      const element = ctx.doc.elements[id];
      if (!element) throw new CommandError('rejected', `Unknown element ${id}`);
      if (element.locked) continue;
      const slots = slotsOf(element, input.assetSlots.map((slot) => slot.replace(/^asset:/, ''))).map((slot) => slot.key);
      if (slots.length === 0 && surfacesOf(element).length === 0) continue;
      const meta = snapshot(element.meta ?? {}) as Record<string, JsonValue>;
      const own = { ...((meta['materials'] as Record<string, JsonValue> | undefined) ?? {}) };
      for (const slot of slots) own[slot] = input.materialId;
      meta['materials'] = own;
      delete meta['surfaces'];
      element.meta = meta;
      painted += 1;
    }
    if (painted === 0) throw new CommandError('rejected', 'Nothing here takes materials');
    return painted;
  },
});

export const replaceMaterial = defineMutation({
  id: 'replace-material',
  label: 'Replace material everywhere',
  description: 'Swaps one material for another wherever it is used (slots, wall layers, types, painted surfaces). Replacing a built-in default (default:*) changes every part that shows it, including future ones. Returns how many elements changed.',
  aliases: ['swap material', 'replace all'],
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ from: z.string().min(1).max(64), to: z.string().min(1).max(64) }),
  run: (ctx, input) => {
    if (input.from === input.to) return 0;
    const target = requireMaterial(ctx.doc, input.to);
    requireMaterial(ctx.doc, input.from);
    let changed = 0;
    for (const element of Object.values(ctx.doc.elements)) {
      if (!materialIdsUsedBy(element).has(input.from)) continue;
      replaceReferences(element, input.from, input.to);
      changed += 1;
    }
    // Parts left on a default show the new material through the default itself.
    if (isDefaultMaterialId(input.from)) {
      const name = `${defaultMaterialOf(ctx.doc, input.from)?.name ?? 'Default'}: ${target.name}`.slice(0, 80);
      ctx.doc.materials[input.from] = validated({ ...snapshot(target), id: input.from, name });
    }
    return changed;
  },
});

/** The default material record of an id, as the document shows it (for the editor). */
export function defaultMaterialOf(doc: ArchaiDocument, id: string): Material | null {
  return builtinDefault(id, doc.workspace.graphics as GraphicsOverrides | undefined);
}

export const materialCommands = [createMaterial, updateMaterial, duplicateMaterial, deleteMaterial, setMaterialTexture, assignMaterial, paintElement, replaceMaterial, setSurfacePaint, importMaterialPack, exportMaterialPack, listMaterialPresets];

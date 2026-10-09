/**
 * 3D model import (docs/model-import.md): any common 3D file becomes a mesh element (see
 * src/view3d/meshes.ts) — a box on the board carrying the model as a binary glTF — that moves,
 * rotates, lifts, takes materials per model material and shows in every 3D view and VR tour.
 */
import { z } from 'zod';
import { IPC, type OpenFileResult, type OpenFilesInput } from '@shared/ipc';
import { getElectronBridge } from '@/platform/electron';
import { IdSchema, type JsonValue } from '@/document';
import { base64ToBytes, bytesToBase64 } from '@/persistence/base64';
import { CommandError, defineEffect, defineMutation } from '../contract';
import { setSelection, snapshot } from '../helpers';
import { createRect, ensureBlob } from './create';

const Unit = z.enum(['mm', 'cm', 'm', 'in', 'ft']);
const Up = z.enum(['y', 'z']);
const Size = z.tuple([z.number().min(0), z.number().min(0), z.number().min(0)]);

export const createMeshElement = defineMutation({
  id: 'create-mesh-element',
  label: 'Place 3D model',
  description: 'Places a converted model (binary glTF in mm, Y up, plan corner at its origin) centred on (x, y). Returns its id.',
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({
    name: z.string().trim().min(1).max(200),
    glb: z.string().min(1),
    x: z.number().finite(),
    y: z.number().finite(),
    size: Size,
    category: z.string().max(80).default('3D model'),
    unit: Unit.optional(),
    up: Up.optional(),
    format: z.string().max(40).optional(),
  }),
  run: (ctx, input) => {
    const blobId = ensureBlob(ctx.doc, { mime: 'model/gltf-binary', data: input.glb, width: 0, height: 0 });
    const [width, depth, height] = input.size;
    const id = createRect.run(ctx, {
      x: input.x - Math.max(1, width) / 2,
      y: input.y - Math.max(1, depth) / 2,
      width: Math.max(1, width),
      height: Math.max(1, depth),
      radius: 0,
      rotation: 0,
      style: { fill: null, stroke: '#9aa0aa', strokeWidth: 8, opacity: 1 },
      name: input.name,
      meta: { mesh: { blobId, category: input.category, height, ...(input.unit ? { unit: input.unit } : {}), ...(input.up ? { up: input.up } : {}), ...(input.format ? { format: input.format } : {}) } },
      parentId: null,
      select: false,
    });
    setSelection(ctx, [id]);
    return id;
  },
});

/** Replaces a mesh element's model and keeps its plan centre (after a units / up-axis change). */
export const replaceMeshModel = defineMutation({
  id: 'replace-mesh-model',
  label: 'Replace 3D model',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, glb: z.string().min(1), size: Size, unit: Unit, up: Up }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    const mesh = element?.meta?.['mesh'];
    if (!element || element.kind !== 'rect' || !mesh || typeof mesh !== 'object' || Array.isArray(mesh)) throw new CommandError('rejected', 'Not a 3D model');
    if (element.locked) throw new CommandError('rejected', 'The model is locked');
    const blobId = ensureBlob(ctx.doc, { mime: 'model/gltf-binary', data: input.glb, width: 0, height: 0 });
    const [width, depth, height] = input.size;
    const cx = element.x + element.width / 2;
    const cy = element.y + element.height / 2;
    element.width = Math.max(1, width);
    element.height = Math.max(1, depth);
    element.x = cx - element.width / 2;
    element.y = cy - element.height / 2;
    const meta = snapshot(element.meta ?? {}) as Record<string, JsonValue>;
    element.meta = { ...meta, mesh: { ...(meta['mesh'] as Record<string, JsonValue>), blobId, height, unit: input.unit, up: input.up } };
  },
});

const FileInput = z.object({ name: z.string().min(1).max(260), data: z.string() });

/**
 * Opens the system file picker for 3D files (several at once: a model and its companions). The
 * desktop app lists each format on its own; a browser can only show one combined type.
 */
async function pickModelFiles(accept: string, filters: OpenFilesInput['filters']): Promise<{ name: string; bytes: Uint8Array }[]> {
  const bridge = getElectronBridge();
  if (bridge) return bridge.invoke<OpenFileResult[]>(IPC.filesOpenFiles, { title: 'Import 3D model', filters });
  if (typeof document === 'undefined') return [];
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = accept;
    input.style.display = 'none';
    document.body.append(input);
    input.addEventListener('change', async () => {
      const files = [...(input.files ?? [])];
      input.remove();
      resolve(await Promise.all(files.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }))));
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve([]);
    });
    input.click();
  });
}

export const importModel = defineEffect({
  id: 'import-3d-model',
  label: 'Import 3D model…',
  description:
    'Imports a 3D file (GLB/glTF, FBX, OBJ with MTL and textures, STL, PLY, DAE, 3MF, 3DS, AMF, VRML, USD/USDZ, LWO, VTK, KMZ; Rhino: export OBJ, FBX or glTF) as a 3D model element. Pass `files` (base64) or pick them; units and up axis are detected unless given.',
  aliases: ['fbx', 'obj', 'glb', 'gltf', 'stl', 'collada', 'dae', '3ds', 'usdz', 'import model', 'mesh'],
  group: 'create',
  input: z
    .object({
      files: z.array(FileInput).optional(),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      unit: z.enum(['auto', 'mm', 'cm', 'm', 'in', 'ft']).default('auto'),
      up: z.enum(['auto', 'y', 'z']).default('auto'),
    })
    .prefault({}),
  run: async (ctx, input) => {
    const { convertModel, MODEL_ACCEPT, modelFileFilters, primaryModelFile } = await import('@/view3d/modelImport');
    const files = input.files ? input.files.map((file) => ({ name: file.name, bytes: base64ToBytes(file.data) })) : await pickModelFiles(MODEL_ACCEPT, modelFileFilters());
    if (files.length === 0) return null;
    const primary = primaryModelFile(files);
    if (!primary) throw new CommandError('rejected', `${files.map((file) => file.name).join(', ')}: not a supported 3D format`);
    let model;
    try {
      model = await convertModel(files, { unit: input.unit, up: input.up });
    } catch (error) {
      throw new CommandError('failed', `${primary.name}: ${error instanceof Error ? error.message : 'could not be read'}`);
    }
    const state = ctx.getState();
    const { viewport, canvasSize } = state.ui;
    const result = ctx.dispatchSync(createMeshElement, {
      name: primary.name.replace(/\.[^.]+$/, '') || '3D model',
      glb: bytesToBase64(model.glb),
      x: input.x ?? (canvasSize.width / 2 - viewport.x) / viewport.zoom,
      y: input.y ?? (canvasSize.height / 2 - viewport.y) / viewport.zoom,
      size: model.size,
      category: '3D model',
      unit: model.unit,
      up: model.up,
      format: model.format,
    });
    if (!result.ok) throw new CommandError(result.error.code, result.error.message, result.error.details);
    return { id: result.value, unit: model.unit, up: model.up, size: model.size, format: model.format, triangles: model.triangles };
  },
});

export const setModelUnits = defineEffect({
  id: 'set-model-units',
  label: 'Model units',
  description: 'Re-scales an imported 3D model to other source units and/or turns it to another up axis (Y or Z up).',
  group: 'edit',
  palette: false,
  input: z.object({ id: IdSchema, unit: Unit.optional(), up: Up.optional() }),
  run: async (ctx, input) => {
    const { rebakeModel } = await import('@/view3d/modelImport');
    const doc = ctx.getState().doc;
    const element = doc.elements[input.id];
    const mesh = element?.meta?.['mesh'] as Record<string, JsonValue> | undefined;
    const blob = typeof mesh?.['blobId'] === 'string' ? doc.blobs[mesh['blobId']] : undefined;
    if (!element || !mesh || !blob) throw new CommandError('rejected', 'Select an imported 3D model');
    const from = { unit: Unit.catch('mm').parse(mesh['unit']), up: Up.catch('y').parse(mesh['up']) };
    const to = { unit: input.unit ?? from.unit, up: input.up ?? from.up };
    if (to.unit === from.unit && to.up === from.up) return null;
    const model = await rebakeModel(base64ToBytes(blob.data), from, to);
    const result = ctx.dispatchSync(replaceMeshModel, { id: input.id, glb: bytesToBase64(model.glb), size: model.size, unit: to.unit, up: to.up });
    if (!result.ok) throw new CommandError(result.error.code, result.error.message, result.error.details);
    return { size: model.size };
  },
});

export const modelCommands = [createMeshElement, replaceMeshModel, importModel, setModelUnits];

import { RenderSettingsSchema } from '@/studio/settings';
import { ViewBakeSchema } from '@/studio/viewRender';
/**
 * 3D view portals and the full-screen 3D workspace. A portal is a plain rect with
 * `meta.view3d` (its camera); the board renders a live three.js viewport inside it.
 */
import { z } from 'zod';
import { hostedBy, systemTypeOf } from '@/assets/arch-meta';
import { IdSchema, type JsonValue } from '@/document';
import { CommandError, defineMutation } from '../contract';
import { markerLocalPoint, requireTargets, snapshot, syncCameraFromMarker } from '../helpers';
import { createRect } from './create';
import { rebuildSystemElement } from './system';
import { cameraNavigationLocked } from '@/document/viewCamera';

const Camera = z.object({
  position: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  target: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  zoom: z.number().positive().optional(),
  fov: z.number().positive().optional(),
  /** Where a section/plan cut was when this camera was saved, so a view follows its cut. */
  cut: z.tuple([z.number().finite(), z.number().finite()]).optional(),
});

export const createView3d = defineMutation({
  id: 'create-view3d',
  label: 'Add 3D view',
  description: 'Places a 3D view portal on the board; double-click it to open the full 3D workspace.',
  aliases: ['3d view', 'perspective', 'portal'],
  group: 'create',
  history: 'record',
  input: z
    .object({
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      width: z.number().positive().default(6000),
      height: z.number().positive().default(4000),
    })
    .prefault({}),
  run: (ctx, input) => {
    const { viewport, canvasSize } = ctx.ui;
    const x = input.x ?? (canvasSize.width / 2 - viewport.x) / viewport.zoom - input.width / 2;
    const y = input.y ?? (canvasSize.height / 2 - viewport.y) / viewport.zoom - input.height / 2;
    return createRect.run(ctx, {
      x,
      y,
      width: input.width,
      height: input.height,
      radius: 0,
      rotation: 0,
      style: { fill: '#f3f4f6', stroke: '#8a8f98', strokeWidth: 24, opacity: 1 },
      name: '3D view',
      meta: { view3d: { camera: null } },
      parentId: null,
      select: true,
    });
  },
});

export const setView3dCamera = defineMutation({
  id: 'set-view3d-camera',
  label: 'Set 3D view camera',
  group: 'view',
  palette: false,
  history: 'none',
  input: z.object({ id: IdSchema, camera: Camera }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    if (!element || !element.meta?.['view3d']) throw new CommandError('rejected', 'Not a 3D view');
    if (cameraNavigationLocked(ctx.doc, input.id)) return;
    const current = element.meta['view3d'];
    const view = current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, JsonValue>) : {};
    const saved = view['camera'];
    if (saved && typeof saved === 'object' && !Array.isArray(saved) &&
      JSON.stringify(saved['position']) === JSON.stringify(input.camera.position) &&
      JSON.stringify(saved['target']) === JSON.stringify(input.camera.target) &&
      saved['zoom'] === input.camera.zoom && saved['fov'] === input.camera.fov &&
      JSON.stringify(saved['cut']) === JSON.stringify(input.camera.cut)) return;
    element.meta = { ...snapshot(element.meta), view3d: { ...view, camera: input.camera as unknown as JsonValue } };

    const cameraId = typeof view['cameraId'] === 'string' ? view['cameraId'] : undefined;
    const marker = cameraId ? ctx.doc.elements[cameraId] : undefined;
    if (marker && marker.kind === 'line' && marker.points.length >= 2) {
      const [eyeX, eyeH, eyeY] = input.camera.position;
      const [tgtX, tgtH, tgtY] = input.camera.target;
      marker.points = [markerLocalPoint(ctx.doc.elements, marker, eyeX, eyeY), markerLocalPoint(ctx.doc.elements, marker, tgtX, tgtY)];
      const mMeta = (marker.meta?.['cameraMarker'] as Record<string, JsonValue> | undefined) ?? {};
      marker.meta = {
        ...snapshot(marker.meta ?? {}),
        cameraMarker: {
          ...mMeta,
          eyeHeight: eyeH,
          targetHeight: tgtH,
          ...(input.camera.fov ? { fov: input.camera.fov } : {}),
        },
      };
      // Duplicated views share the marker: orbiting in one moves the others too.
      syncCameraFromMarker(ctx.doc.elements, marker);
    }
  },
});

/** Level of detail of individual elements (assets), overriding the view they are seen in. */
export const setElementLod = defineMutation({
  id: 'set-element-lod',
  label: 'Element level of detail',
  description: 'Makes the selected assets always render at high or low detail, or follow the view again.',
  aliases: ['lod', 'level of detail'],
  group: 'view',
  palette: false,
  history: 'record',
  input: z.object({ ids: z.array(IdSchema).min(1), lod: z.enum(['high', 'low']).nullable() }),
  run: (ctx, input) => {
    const targets = requireTargets(ctx, input.ids, { unlocked: true });
    for (const element of targets) {
      const meta = { ...snapshot(element.meta ?? {}) } as Record<string, JsonValue>;
      if (input.lod === null) delete meta['lod'];
      else meta['lod'] = input.lod;
      element.meta = meta;
    }
    return targets.map((element) => element.id);
  },
});

/** Per-portal display settings, remembered with the document. */
export const setView3dSettings = defineMutation({
  id: 'set-view3d-settings',
  label: 'View settings',
  description: 'Sets the display style, level of detail and (for sections) depth of a 3D or section view portal.',
  group: 'view',
  palette: false,
  history: 'none',
  input: z.object({
    id: IdSchema,
    style: z.enum(['realistic', 'wireframe', 'shaded', 'consistent', 'hidden-line']).nullable().optional(),
    lod: z.enum(['high', 'low']).nullable().optional(),
    depth: z.number().min(0).optional(),
    renderer: z.enum(['default', 'unreal', 'baked']).optional(),
    renderSettings: RenderSettingsSchema.optional(),
    bake: ViewBakeSchema.optional(),
  }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    if (!element || !element.meta?.['view3d']) throw new CommandError('rejected', 'Not a 3D view');
    const current = element.meta['view3d'];
    const view = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, JsonValue>) } : {};
    if (input.renderer !== undefined) {
      if (input.renderer === 'baked' && !view['bake']) throw new CommandError('rejected', 'Bake this view first');
      if (input.renderer === 'baked' && (view['bake'] as Record<string, JsonValue>)?.['webError']) throw new CommandError('rejected', 'The browser bake is unavailable. The Unreal bake can still be exported as a folder.');
      view['renderer'] = input.renderer;
    }
    if (input.renderSettings) view['renderSettings'] = input.renderSettings as unknown as JsonValue;
    if (input.bake) view['bake'] = input.bake as unknown as JsonValue;
    if (input.style !== undefined) {
      if (input.style === null) delete view['style'];
      else view['style'] = input.style;
    }
    if (input.lod !== undefined) {
      if (input.lod === null) delete view['lod'];
      else view['lod'] = input.lod;
    }
    if (input.depth !== undefined) {
      if (input.depth <= 0) delete view['depth'];
      else view['depth'] = input.depth;
    }
    element.meta = { ...snapshot(element.meta), view3d: view };
  },
});

export const openView3d = defineMutation({
  id: 'open-view3d',
  label: 'Open 3D workspace',
  description: 'Opens the full-screen 3D workspace (from the selected 3D view, or a default camera).',
  aliases: ['3d workspace', 'enter 3d'],
  group: 'view',
  history: 'none',
  input: z.object({ id: IdSchema.optional() }).prefault({}),
  run: (ctx, input) => {
    const id = input.id ?? ctx.ui.selection.find((candidate) => ctx.doc.elements[candidate]?.meta?.['view3d']) ?? createView3d.run(ctx, { width: 6000, height: 4000 });
    if (!ctx.doc.elements[id]?.meta?.['view3d']) throw new CommandError('rejected', 'Not a 3D view');
    ctx.ui.view3d = { open: true, portalId: id };
    ctx.ui.editingTextId = null;
  },
});

export const toggleViewBoard = defineMutation({
  id: 'toggle-view-board',
  label: 'Edit board inside view',
  group: 'view',
  history: 'none',
  input: z.void(),
  when: (ctx) => ctx.ui.view3d.open,
  run: (ctx) => {
    ctx.ui.view3d.editingBoard = !ctx.ui.view3d.editingBoard;
    if (!ctx.ui.view3d.editingBoard) {
      ctx.ui.tool = 'select';
      ctx.ui.toolPrompt = null;
      ctx.ui.editingTextId = null;
    }
  },
});

export const closeView3d = defineMutation({
  id: 'close-view3d',
  label: 'Close 3D workspace',
  group: 'view',
  history: 'none',
  input: z.void(),
  when: (ctx) => ctx.ui.view3d.open,
  run: (ctx) => {
    ctx.ui.view3d = { open: false, portalId: null };
  },
});

/** Height and elevation for the 3D view: system parameters for system elements, `meta.solid` otherwise. */
export const setSolid = defineMutation({
  id: 'set-solid',
  label: 'Set height and elevation',
  description: 'Sets how tall an element is in 3D and how far above the ground it sits.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ ids: z.array(IdSchema).optional(), height: z.number().min(0).optional(), elevation: z.number().finite().optional() }),
  run: (ctx, input) => {
    const targets = requireTargets(ctx, input.ids, { unlocked: true });
    for (const element of targets) {
      const type = systemTypeOf(element);
      const meta = snapshot(element.meta ?? {});
      if (type) {
        const arch = meta['arch'] as Record<string, JsonValue>;
        const parameters = { ...((arch['parameters'] as Record<string, JsonValue> | undefined) ?? {}) };
        if (input.height !== undefined) parameters[type === 'stair' ? 'totalRise' : 'height'] = input.height;
        if (input.elevation !== undefined) parameters[type === 'window' ? 'sill' : type === 'door' ? 'threshold' : 'elevation'] = input.elevation;
        element.meta = { ...meta, arch: { ...arch, parameters } };
        rebuildSystemElement(ctx, element.id);
      } else {
        const current = (meta['solid'] as Record<string, JsonValue> | undefined) ?? {};
        element.meta = { ...meta, solid: { ...current, ...(input.height !== undefined ? { height: input.height } : {}), ...(input.elevation !== undefined ? { elevation: input.elevation } : {}) } };
      }
    }
    return targets.map((t) => t.id);
  },
});

export const setInstanceElevation = defineMutation({
  id: 'set-instance-elevation',
  label: 'Set instance elevation',
  description: 'Sets 3D elevation on selected instances without changing their shared type configuration.',
  group: 'transform',
  palette: false,
  history: 'record',
  input: z.object({ ids: z.array(IdSchema).optional(), elevation: z.number().finite() }),
  run: (ctx, input) => {
    const targets = requireTargets(ctx, input.ids, { unlocked: true });
    for (const element of targets) {
      const oldElevation = typeof element.meta?.['instanceElevation'] === 'number' ? element.meta['instanceElevation'] : undefined;
      const meta: Record<string, JsonValue> = { ...snapshot(element.meta ?? {}), instanceElevation: input.elevation };
      delete meta['levelConstraint'];
      element.meta = meta;
      if (oldElevation !== undefined) {
        const delta = input.elevation - oldElevation;
        if (Math.abs(delta) > 1e-6) {
          for (const hostedId of hostedBy(ctx.doc.elements, [element.id])) {
            const hosted = ctx.doc.elements[hostedId];
            if (!hosted || hosted.meta?.['levelConstraint']) continue;
            if (typeof hosted.meta?.['instanceElevation'] === 'number') {
              hosted.meta = { ...hosted.meta, instanceElevation: hosted.meta['instanceElevation'] + delta };
            }
          }
        }
      }
    }
    return targets.map((element) => element.id);
  },
});

export const view3dCommands = [toggleViewBoard, createView3d, setView3dCamera, openView3d, closeView3d, setSolid, setInstanceElevation, setView3dSettings, setElementLod];

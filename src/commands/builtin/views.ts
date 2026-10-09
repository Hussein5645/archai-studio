/**
 * Section views, view snapshots ("lock view") and papers.
 * - A section view is a portal like the 3D view, linked to an editable line element on the board;
 *   the portal shows the corresponding orthographic cut and follows line moves/endpoint edits.
 * - Locking a view rasterizes it (3D/section from the live renderer, the plan from the SVG) into
 *   an ordinary image element that stays on the board.
 * - A paper is a sheet on the board (`meta.paper`) that frames exports at its scale (see export.ts).
 */
import { z } from 'zod';
import { childrenOf, IdSchema, indexBefore, type ElementTable, type GroupElement, type JsonValue } from '@/document';
import { DEFAULT_PLAN_CUT_HEIGHT, viewRigKind, type ViewRigKind } from '@/layers/viewRig';
import { rectContainsRect, worldBounds } from '@/geometry';
import { canvasBytes, rasterizeBoard } from '@/export/raster';
import { mountedViews } from '@/view3d/SceneView';
import { CommandError, defineEffect, defineMutation, type EffectContext } from '../contract';
import { markerLocalPoint, portalsOfMarker, snapshot, topIndex } from '../helpers';
import { applyToPoint, worldMatrix } from '@/geometry';
import type { MutationContext } from '../contract';
import { createImage, createLine, createRect } from './create';

const Point = z.tuple([z.number().finite(), z.number().finite()]);

export const PAPER_SIZES: Record<string, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  A3: { width: 297, height: 420 },
  A2: { width: 420, height: 594 },
  A1: { width: 594, height: 841 },
  Letter: { width: 216, height: 279 },
};

export interface PaperMeta {
  size: string;
  orientation: 'portrait' | 'landscape';
  scale: number;
  title: string;
  /** Sheet number shown in the title block ("A-101"). */
  number: string;
}

export function paperOf(meta: Record<string, unknown> | undefined): PaperMeta | null {
  const value = meta?.['paper'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const paper = value as Record<string, unknown>;
  return {
    size: typeof paper['size'] === 'string' ? paper['size'] : 'custom',
    orientation: paper['orientation'] === 'portrait' ? 'portrait' : 'landscape',
    scale: typeof paper['scale'] === 'number' && paper['scale'] > 0 ? paper['scale'] : 50,
    title: typeof paper['title'] === 'string' ? paper['title'] : 'Paper',
    number: typeof paper['number'] === 'string' ? paper['number'] : '',
  };
}

/** Sheet dimensions in mm for a paper size/orientation. */
export function sheetSize(size: string, orientation: 'portrait' | 'landscape'): { width: number; height: number } | null {
  const sheet = PAPER_SIZES[size];
  if (!sheet) return null;
  return orientation === 'landscape' ? { width: sheet.height, height: sheet.width } : { width: sheet.width, height: sheet.height };
}

/**
 * The origin of a camera or section (see layers/viewRig.ts): a group at `origin` that will hold
 * the view and its marker, so moving it moves both while each can still move on its own.
 */
function createViewRig(ctx: MutationContext, kind: ViewRigKind, name: string, origin: { x: number; y: number }, parentId: string | null = null): string {
  const rig: GroupElement = {
    id: ctx.ids.next('el'),
    kind: 'group',
    parentId,
    index: topIndex(ctx.doc.elements as ElementTable, parentId),
    x: origin.x,
    y: origin.y,
    rotation: 0,
    visible: true,
    locked: false,
    name,
    meta: { viewRig: { kind } },
  };
  ctx.doc.elements[rig.id] = rig;
  return rig.id;
}

export const createSectionView = defineMutation({
  id: 'create-section-view',
  label: 'Add section view',
  description: 'Creates a section view portal from a cut line (a to b); the view looks to the right of the line.',
  aliases: ['section', 'cut'],
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({
    a: Point,
    b: Point,
    width: z.number().positive().default(6000),
    height: z.number().positive().default(3500),
    /** Clearance between the cut line and the view portal (mm). */
    gap: z.number().min(0).default(1500),
  }),
  run: (ctx, input) => {
    const [ax, ay] = input.a;
    const [bx, by] = input.b;
    const length = Math.hypot(bx - ax, by - ay);
    if (length < 10) throw new CommandError('invalid-input', 'A section needs a cut line');
    const angle = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
    // The portal sits behind the cut line (on the side the viewer stands) so it does not cover the cut.
    const nx = -(by - ay) / length;
    const ny = (bx - ax) / length;
    const x = (ax + bx) / 2 - input.width / 2 - nx * (input.height / 2 + input.gap);
    const y = (ay + by) / 2 - input.height / 2 - ny * (input.height / 2 + input.gap);
    const count = Object.values(ctx.doc.elements).filter((element) => element.meta?.['sectionLine']).length + 1;
    const name = `Section ${count}`;
    // Children are placed relative to the rig origin, the cut's midpoint.
    const origin = { x: (ax + bx) / 2, y: (ay + by) / 2 };
    const rigId = createViewRig(ctx, 'section', name, origin);
    const lineId = createLine.run(ctx, {
      points: [[ax - origin.x, ay - origin.y], [bx - origin.x, by - origin.y]],
      closed: false,
      rotation: 0,
      style: { fill: null, stroke: '#2563eb', strokeWidth: 24, opacity: 1 },
      name: `${name} line`,
      meta: { sectionLine: { direction: 1 } },
      parentId: rigId,
      select: false,
    });
    const portalId = createRect.run(ctx, {
      x: x - origin.x,
      y: y - origin.y,
      width: input.width,
      height: input.height,
      radius: 0,
      rotation: 0,
      style: { fill: '#f3f4f6', stroke: '#8a8f98', strokeWidth: 24, opacity: 1 },
      name: `${name} view`,
      meta: { view3d: { camera: null, sectionLineId: lineId, cut: { x: (ax + bx) / 2, y: (ay + by) / 2, angle, length } } },
      parentId: rigId,
      select: true,
    });
    const line = ctx.doc.elements[lineId]!;
    line.meta = { ...line.meta, sectionLine: { direction: 1, portalId } };
    return portalId;
  },
});

export const createLevelView = defineMutation({
  id: 'create-level-view',
  label: 'Add level plan view',
  description: "Creates a plan view of a level: a view portal and a plan region (what the plan shows) under an origin inside the level, cut at the level's elevation plus the cut height.",
  aliases: ['plan view', 'floor plan', 'level view'],
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, cutHeight: z.number().finite().positive().default(DEFAULT_PLAN_CUT_HEIGHT) }),
  run: (ctx, input) => {
    const level = ctx.doc.elements[input.id];
    if (!level || level.kind !== 'rect' || !level.meta?.['level']) throw new CommandError('rejected', 'Select a level');
    const { width, height } = level;
    const existing = childrenOf(ctx.doc.elements as ElementTable, level.id).filter((child) => viewRigKind(child) === 'plan').length;
    const name = `${level.name ?? 'Level'} plan${existing > 0 ? ` ${existing + 1}` : ''}`;
    // The origin sits at the level's centre (in the level's own frame), so the level carries it.
    const rigId = createViewRig(ctx, 'plan', name, { x: width / 2, y: height / 2 }, level.id);
    const regionId = createRect.run(ctx, {
      x: -width / 2,
      y: -height / 2,
      width,
      height,
      radius: 0,
      rotation: 0,
      style: { fill: null, stroke: '#0d9488', strokeWidth: 16, opacity: 1 },
      name: `${name} region`,
      meta: { planRegion: { levelId: level.id, cutHeight: input.cutHeight } },
      parentId: rigId,
      select: false,
    });
    // The view keeps the region's proportions, beside the level on the right.
    const scale = Math.min(1, 12_000 / Math.max(width, height));
    const portalId = createRect.run(ctx, {
      x: width / 2 + 1500,
      y: (-height * scale) / 2,
      width: width * scale,
      height: height * scale,
      radius: 0,
      rotation: 0,
      style: { fill: '#f3f4f6', stroke: '#8a8f98', strokeWidth: 24, opacity: 1 },
      name: `${name} view`,
      // Shows the level's floor below the cut, not the storeys beneath it.
      meta: { view3d: { camera: null, planRegionId: regionId, depth: input.cutHeight + 500 } },
      parentId: rigId,
      select: true,
    });
    const region = ctx.doc.elements[regionId]!;
    region.meta = { ...region.meta, planRegion: { levelId: level.id, cutHeight: input.cutHeight, portalId } };
    return portalId;
  },
});

export const setPlanCutHeight = defineMutation({
  id: 'set-plan-cut-height',
  label: 'Set plan cut height',
  group: 'view',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, cutHeight: z.number().finite().positive() }),
  run: (ctx, input) => {
    // Either the plan view or its region.
    const element = ctx.doc.elements[input.id];
    const view = element?.meta?.['view3d'] as { planRegionId?: string } | undefined;
    const region = view?.planRegionId ? ctx.doc.elements[view.planRegionId] : element;
    if (!region?.meta?.['planRegion']) throw new CommandError('rejected', 'Select a level plan view');
    region.meta = { ...snapshot(region.meta), planRegion: { ...(snapshot(region.meta['planRegion'] as object) as Record<string, JsonValue>), cutHeight: input.cutHeight } };
    return region.id;
  },
});

export const flipSectionView = defineMutation({
  id: 'flip-section-view',
  label: 'Flip section direction',
  description: 'Flips the viewing direction of a section while keeping its cut line in place.',
  group: 'view',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema }),
  run: (ctx, input) => {
    const portal = ctx.doc.elements[input.id];
    const view = portal?.meta?.['view3d'];
    const lineId = view && typeof view === 'object' && !Array.isArray(view) ? (view as Record<string, unknown>)['sectionLineId'] : null;
    const line = typeof lineId === 'string' ? ctx.doc.elements[lineId] : undefined;
    if (!portal || !line || line.kind !== 'line') throw new CommandError('rejected', 'Select a linked section view');
    const section = line.meta?.['sectionLine'];
    const current = section && typeof section === 'object' && !Array.isArray(section) && (section as Record<string, unknown>)['direction'] === -1 ? -1 : 1;
    line.meta = { ...snapshot(line.meta ?? {}), sectionLine: { ...((section as Record<string, JsonValue> | undefined) ?? {}), direction: current * -1 } };
    return portal.id;
  },
});

async function placeSnapshot(ctx: EffectContext, dataUrl: string, rect: { x: number; y: number; width: number; height: number }, name: string): Promise<string> {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Snapshot failed'));
    image.src = dataUrl;
  });
  const result = ctx.dispatchSync(createImage, {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    blob: { mime, data: base64, width: image.width, height: image.height },
    name,
  });
  if (!result.ok) throw new CommandError(result.error.code, result.error.message);
  return result.value as string;
}

export const lockView = defineEffect({
  id: 'lock-view',
  label: 'Lock view as image',
  description: 'Takes an image of a 3D or section view and places it on the board as a regular image; `resolution` is the long side in pixels.',
  aliases: ['snapshot view', 'capture view', 'plan lock'],
  group: 'create',
  input: z.object({ id: IdSchema.optional(), resolution: z.number().int().min(256).max(12_000).default(3200) }).prefault({}),
  run: async (ctx, input) => {
    const state = ctx.getState();
    const id = input.id ?? state.ui.selection.find((candidate) => state.doc.elements[candidate]?.meta?.['view3d']);
    const element = id ? state.doc.elements[id] : undefined;
    if (!id || !element || element.kind !== 'rect') throw new CommandError('rejected', 'Select a 3D or section view');
    const view = mountedViews.get(id);
    if (!view) throw new CommandError('rejected', 'That view is not on screen');
    const offset = Math.max(200, element.width * 0.05);
    // Rendered at the requested size (not the on-screen size), at the view's own proportions.
    const long = Math.max(element.width, element.height);
    const image = view.renderImage((input.resolution * element.width) / long, (input.resolution * element.height) / long);
    return placeSnapshot(ctx, image.toDataURL('image/png'), { x: element.x + offset, y: element.y + offset, width: element.width, height: element.height }, `${element.name ?? 'View'} (locked)`);
  },
});

export const lockPlanView = defineEffect({
  id: 'lock-plan-view',
  label: 'Lock plan view as image',
  description: 'Takes an image of the board as currently shown and places it as a regular image covering that region.',
  aliases: ['snapshot plan', 'capture board'],
  group: 'create',
  input: z.object({ pixelsPerScreenPixel: z.number().positive().max(8).default(3) }).prefault({}),
  run: async (ctx, input) => {
    const state = ctx.getState();
    const { viewport, canvasSize } = state.ui;
    const region = { x: -viewport.x / viewport.zoom, y: -viewport.y / viewport.zoom, width: canvasSize.width / viewport.zoom, height: canvasSize.height / viewport.zoom };
    const canvas = await rasterizeBoard(state.doc, region, { pixelsPerMm: viewport.zoom * input.pixelsPerScreenPixel, background: state.doc.workspace.background });
    const { dataUrl } = await canvasBytes(canvas, 'image/png');
    return placeSnapshot(ctx, dataUrl, region, 'Plan (locked)');
  },
});

export const createPaper = defineMutation({
  id: 'create-paper',
  label: 'Add paper',
  description: 'Places a paper sheet on the board (default A4 landscape at 1:50); export it as a PDF.',
  aliases: ['sheet', 'layout', 'title block'],
  group: 'create',
  history: 'record',
  input: z
    .object({
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      /** A drawn rectangle becomes a custom-size sheet at the given scale. */
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      size: z.string().default('A4'),
      orientation: z.enum(['portrait', 'landscape']).default('landscape'),
      scale: z.number().positive().default(50),
      title: z.string().max(120).optional(),
    })
    .prefault({}),
  run: (ctx, input) => {
    const custom = input.width !== undefined && input.height !== undefined;
    const sheet = custom ? { width: input.width! / input.scale, height: input.height! / input.scale } : sheetSize(input.size, input.orientation);
    if (!sheet) throw new CommandError('invalid-input', `Unknown paper size "${input.size}"; use ${Object.keys(PAPER_SIZES).join(', ')}`);
    const width = sheet.width * input.scale;
    const height = sheet.height * input.scale;
    const { viewport, canvasSize } = ctx.ui;
    const x = input.x ?? (canvasSize.width / 2 - viewport.x) / viewport.zoom - width / 2;
    const y = input.y ?? (canvasSize.height / 2 - viewport.y) / viewport.zoom - height / 2;
    const count = Object.values(ctx.doc.elements).filter((element) => element.meta?.['paper']).length + 1;
    const title = input.title ?? `Paper ${String(count).padStart(2, '0')}`;
    const first = childrenOf(ctx.doc.elements, null)[0];
    const id = createRect.run(ctx, {
      x,
      y,
      width,
      height,
      radius: 0,
      rotation: 0,
      style: { fill: '#ffffff', stroke: '#8a8f98', strokeWidth: 10, opacity: 1 },
      name: title,
      meta: { paper: { size: custom ? 'custom' : input.size, orientation: input.orientation, scale: input.scale, title, number: `A-${100 + count}` } as unknown as JsonValue },
      parentId: null,
      select: true,
    });
    // Sheets sit behind everything drawn on them.
    if (first) ctx.doc.elements[id]!.index = indexBefore(first.index);
    // A sheet is a spatial container: anything already fully inside it becomes its child
    // and keeps the same world-space position. Moving the sheet then moves its contents.
    const sheetRect = { x, y, width, height };
    for (const element of Object.values(ctx.doc.elements)) {
      if (element.id === id || element.parentId !== null || element.meta?.['paper']) continue;
      if (!rectContainsRect(sheetRect, worldBounds(ctx.doc.elements, element))) continue;
      element.parentId = id;
      element.x -= x;
      element.y -= y;
    }
    return id;
  },
});

export const setPaper = defineMutation({
  id: 'set-paper',
  label: 'Set paper size and scale',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, size: z.string().optional(), orientation: z.enum(['portrait', 'landscape']).optional(), scale: z.number().positive().optional(), title: z.string().max(120).optional(), number: z.string().max(24).optional() }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    const paper = paperOf(element?.meta);
    if (!element || element.kind !== 'rect' || !paper) throw new CommandError('rejected', 'Select a paper');
    const next: PaperMeta = { ...paper, ...(input.size ? { size: input.size } : {}), ...(input.orientation ? { orientation: input.orientation } : {}), ...(input.scale ? { scale: input.scale } : {}), ...(input.title !== undefined ? { title: input.title } : {}), ...(input.number !== undefined ? { number: input.number } : {}) };
    const sheet = sheetSize(next.size, next.orientation);
    if (sheet) {
      element.width = sheet.width * next.scale;
      element.height = sheet.height * next.scale;
    } else if (input.scale && paper.scale > 0) {
      element.width = (element.width / paper.scale) * next.scale;
      element.height = (element.height / paper.scale) * next.scale;
    }
    element.name = next.title;
    element.meta = { ...snapshot(element.meta ?? {}), paper: next as unknown as JsonValue };
    return element.id;
  },
});

export interface CameraMarkerMeta {
  portalId: string;
  eyeHeight: number;
  targetHeight: number;
  fov: number;
}

export const createCameraView = defineMutation({
  id: 'create-camera-view',
  label: 'Add camera view',
  description: 'Creates a perspective camera view portal linked to a camera marker on the board (a = eye, b = target).',
  aliases: ['camera', 'perspective view'],
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({
    a: Point,
    b: Point,
    eyeHeight: z.number().default(1600),
    targetHeight: z.number().default(1600),
    fov: z.number().min(10).max(140).default(60),
    width: z.number().positive().default(6000),
    height: z.number().positive().default(4000),
    /** Clearance between the camera eye and the view portal (mm). */
    gap: z.number().min(0).default(1500),
  }),
  run: (ctx, input) => {
    const [ax, ay] = input.a;
    const [bx, by] = input.b;
    const length = Math.hypot(bx - ax, by - ay);
    if (length < 10) throw new CommandError('invalid-input', 'Click eye and target points for the camera');
    const nx = -(by - ay) / length;
    const ny = (bx - ax) / length;
    const x = ax - input.width / 2 - nx * (input.height / 2 + input.gap);
    const y = ay - input.height / 2 - ny * (input.height / 2 + input.gap);
    const count = Object.values(ctx.doc.elements).filter((element) => element.meta?.['cameraMarker']).length + 1;
    const name = `Camera ${count}`;
    // Children are placed relative to the rig origin, the camera eye.
    const rigId = createViewRig(ctx, 'camera', name, { x: ax, y: ay });
    const lineId = createLine.run(ctx, {
      points: [[0, 0], [bx - ax, by - ay]],
      closed: false,
      rotation: 0,
      style: { fill: null, stroke: '#8b5cf6', strokeWidth: 16, opacity: 1 },
      name: `${name} marker`,
      meta: { cameraMarker: { eyeHeight: input.eyeHeight, targetHeight: input.targetHeight, fov: input.fov } },
      parentId: rigId,
      select: false,
    });
    const portalId = createRect.run(ctx, {
      x: x - ax,
      y: y - ay,
      width: input.width,
      height: input.height,
      radius: 0,
      rotation: 0,
      style: { fill: '#f3f4f6', stroke: '#8a8f98', strokeWidth: 24, opacity: 1 },
      name: `${name} view`,
      meta: {
        view3d: {
          cameraMode: true,
          cameraId: lineId,
          camera: {
            position: [ax, input.eyeHeight, ay],
            target: [bx, input.targetHeight, by],
            fov: input.fov,
            eyeHeight: input.eyeHeight,
            targetHeight: input.targetHeight,
          },
        },
      },
      parentId: rigId,
      select: true,
    });
    const line = ctx.doc.elements[lineId]!;
    line.meta = { ...line.meta, cameraMarker: { portalId, eyeHeight: input.eyeHeight, targetHeight: input.targetHeight, fov: input.fov } };
    return portalId;
  },
});

export const setCameraSettings = defineMutation({
  id: 'set-camera-settings',
  label: 'Update camera settings',
  group: 'view',
  palette: false,
  history: 'record',
  input: z.object({
    id: IdSchema,
    eyeHeight: z.number().optional(),
    targetHeight: z.number().optional(),
    fov: z.number().min(10).max(140).optional(),
    eyeX: z.number().optional(),
    eyeY: z.number().optional(),
    targetX: z.number().optional(),
    targetY: z.number().optional(),
  }),
  run: (ctx, input) => {
    let portalId = input.id;
    let markerId = input.id;
    const element = ctx.doc.elements[input.id];
    if (!element) throw new CommandError('rejected', 'Element not found');
    let portal = element.meta?.['view3d'] ? element : null;
    let marker = element.meta?.['cameraMarker'] ? element : null;
    if (portal) {
      const v = portal.meta?.['view3d'] as { cameraId?: string } | undefined;
      markerId = v?.cameraId ?? '';
      marker = ctx.doc.elements[markerId] ?? null;
    } else if (marker) {
      portal = portalsOfMarker(ctx.doc.elements, marker.id)[0] ?? null;
      portalId = portal?.id ?? '';
    }
    const currentMarkerMeta = (marker?.meta?.['cameraMarker'] as Record<string, JsonValue> | undefined) ?? {};
    const nextEyeHeight = input.eyeHeight ?? (typeof currentMarkerMeta['eyeHeight'] === 'number' ? currentMarkerMeta['eyeHeight'] : 1600);
    const nextTargetHeight = input.targetHeight ?? (typeof currentMarkerMeta['targetHeight'] === 'number' ? currentMarkerMeta['targetHeight'] : 1600);
    const nextFov = input.fov ?? (typeof currentMarkerMeta['fov'] === 'number' ? currentMarkerMeta['fov'] : 60);

    if (marker && marker.kind === 'line' && marker.points.length >= 2) {
      // Eye/target are world coordinates; the marker's points are in its own (rig-relative) frame.
      const m = worldMatrix(ctx.doc.elements as ElementTable, marker);
      const eye = applyToPoint(m, { x: marker.points[0]![0], y: marker.points[0]![1] });
      const aim = applyToPoint(m, { x: marker.points.at(-1)![0], y: marker.points.at(-1)![1] });
      marker.points = [
        markerLocalPoint(ctx.doc.elements, marker, input.eyeX ?? eye.x, input.eyeY ?? eye.y),
        markerLocalPoint(ctx.doc.elements, marker, input.targetX ?? aim.x, input.targetY ?? aim.y),
      ];
      marker.meta = {
        ...snapshot(marker.meta ?? {}),
        cameraMarker: {
          ...currentMarkerMeta,
          eyeHeight: nextEyeHeight,
          targetHeight: nextTargetHeight,
          fov: nextFov,
        },
      };
    }

    // Every portal that looks through the marker gets the same camera (duplicated views share one).
    const portals = marker ? portalsOfMarker(ctx.doc.elements, marker.id) : portal ? [portal] : [];
    for (const target of portals) {
      const v = (target.meta?.['view3d'] as Record<string, JsonValue> | undefined) ?? {};
      const cam = (v['camera'] as Record<string, JsonValue> | undefined) ?? {};
      const pos = Array.isArray(cam['position']) ? [...cam['position']] : [0, nextEyeHeight, 0];
      const tgt = Array.isArray(cam['target']) ? [...cam['target']] : [0, nextTargetHeight, 0];
      pos[1] = nextEyeHeight;
      tgt[1] = nextTargetHeight;
      if (input.eyeX !== undefined) pos[0] = input.eyeX;
      if (input.eyeY !== undefined) pos[2] = input.eyeY;
      if (input.targetX !== undefined) tgt[0] = input.targetX;
      if (input.targetY !== undefined) tgt[2] = input.targetY;

      target.meta = {
        ...snapshot(target.meta ?? {}),
        view3d: {
          ...v,
          cameraMode: true,
          camera: {
            ...cam,
            position: pos,
            target: tgt,
            fov: nextFov,
            eyeHeight: nextEyeHeight,
            targetHeight: nextTargetHeight,
          },
        },
      };
    }
    void portalId;
  },
});

export const paperViewCommands = [createSectionView, createLevelView, setPlanCutHeight, flipSectionView, createCameraView, setCameraSettings, lockView, lockPlanView, createPaper, setPaper];

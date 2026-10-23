import { documentInContext, viewContext } from '@/document/viewVisibility';
import { renderOf, viewBakeSignature } from '@/studio/viewRender';
import { loadPreparation } from '@/studio/preparationCache';
/**
 * VR tours (see docs/vr-tours.md): place stops (reference points with a facing, see
 * src/document/vrStop.ts) and publish the 3D model with its stops as a link a VR headset opens.
 */
import { z } from 'zod';
import { IdSchema, type JsonValue } from '@/document';
import { POINT_SIZE } from '@/document/point';
import { normaliseHeading, vrStopOf, VR_STOP_COLOUR } from '@/document/vrStop';
import { CommandError, defineEffect, defineMutation } from '../contract';
import { megabytes, startProgress } from '@/progress';
import { setSelection, snapshot } from '../helpers';
import { createRect } from './create';

export const createVrStop = defineMutation({
  id: 'create-vr-stop',
  label: 'VR stop',
  description: 'Places a VR tour stop centred on (x, y) in mm, standing on a floor at `elevation` mm and facing `heading` degrees (clockwise from +x).',
  aliases: ['vr', 'point of interest', 'poi', 'tour stop'],
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    elevation: z.number().finite().default(0),
    heading: z.number().finite().default(0),
    name: z.string().trim().min(1).max(200).optional(),
    select: z.boolean().default(true),
  }),
  run: (ctx, input) => {
    const count = Object.values(ctx.doc.elements).filter((element) => vrStopOf(element)).length;
    const id = createRect.run(ctx, {
      x: input.x - POINT_SIZE / 2,
      y: input.y - POINT_SIZE / 2,
      width: POINT_SIZE,
      height: POINT_SIZE,
      radius: POINT_SIZE / 2,
      rotation: 0,
      style: { fill: '#ffffff', stroke: VR_STOP_COLOUR, strokeWidth: 20, opacity: 1 },
      name: input.name ?? `Stop ${count + 1}`,
      meta: { point: {}, vrStop: { heading: normaliseHeading(input.heading) }, ...(input.elevation !== 0 ? { instanceElevation: input.elevation } : {}) },
      parentId: null,
      select: false,
    });
    if (input.select) setSelection(ctx, [id]);
    return id;
  },
});

export const setVrStopHeading = defineMutation({
  id: 'set-vr-stop-heading',
  label: 'VR stop facing',
  description: 'Sets the direction a visitor faces on arriving at a VR stop (degrees clockwise from +x).',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, heading: z.number().finite() }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    if (!element || !vrStopOf(element)) throw new CommandError('rejected', 'Not a VR stop');
    if (element.locked) throw new CommandError('rejected', 'The stop is locked');
    const meta = snapshot(element.meta ?? {}) as Record<string, JsonValue>;
    element.meta = { ...meta, vrStop: { ...(meta['vrStop'] as Record<string, JsonValue>), heading: normaliseHeading(input.heading) } };
  },
});

/** Where the last published tour of each document lives, so republishing keeps its link. */
const tourKey = (docId: string) => `vr-tour:${docId}`;

export const publishVrTour = defineEffect({
  id: 'publish-vr-tour',
  label: 'Export Raw VR Link',
  description: 'Uploads the 3D model and its VR stops and returns a link that opens the tour in a VR headset (Meta Quest Browser) or any browser. Republishing a document keeps its link.',
  aliases: ['vr', 'virtual reality', 'quest', 'headset', 'share 3d'],
  group: 'document',
  input: z.object({ newLink: z.boolean().default(false), portalId: IdSchema.optional(), baked: z.boolean().optional(),
    elementIds: z.array(IdSchema).max(200_000).optional(),
    interactive: z.object({ renderer: z.enum(['default','unreal','baked']), style: z.string().max(80), signature: z.string().max(256), lighting: z.enum(['realtime','baked']) }).optional(),
  }).prefault({}),
  run: async (ctx, input) => {
    // Loaded on demand: the exporter and three.js stay out of the command registry's import graph.
    const [{ vrStopsOf, vrTourJson }, { exportVrModel }, { uploadVrTour, vrShareConfig, VR_SIGN_IN_MESSAGE }] = await Promise.all([
      import('@/view3d/vrTour'),
      import('@/view3d/vrExport'),
      import('@/view3d/vrShare'),
    ]);
    const state = ctx.getState();
    const portalId = input.portalId ?? (state.ui.view3d.open ? state.ui.view3d.portalId : null);
    const doc = portalId ? documentInContext(state.doc, viewContext(portalId)) : state.doc;
    const render = renderOf(doc, portalId);
    const baked = input.interactive ? input.interactive.lighting === 'baked' : input.baked ?? render.renderer !== 'default';
    if (baked && (!render.bake || render.bake.signature !== viewBakeSignature(doc, render.settings)))
      throw new CommandError('rejected', 'Bake this view before exporting its VR link. Geometry or lighting changes require a new bake.');
    const linkKey = tourKey(doc.id) + (portalId ? ':' + portalId : '') + (baked ? ':baked' : '');
    const prepared = baked && render.bake && !input.interactive ? await loadPreparation(ctx.platform.storage, render.bake.cacheId, 'baked') : null;
    if (baked && !prepared && !input.interactive) throw new CommandError('rejected', 'Saved bake data is missing on this computer. Bake this view again.');
    const stops = vrStopsOf(doc);
    const config = vrShareConfig();
    if (!config) throw new CommandError('rejected', VR_SIGN_IN_MESSAGE);
    const previousId = input.newLink || input.elementIds ? null : await ctx.platform.storage.get(linkKey).catch(() => null);
    const task = startProgress('Publishing the VR link', 'Building the 3D model (high detail)', null);
    let model: ArrayBuffer;
    let published;
    try {
      await task.paint();
      if (input.interactive) {
        const { interactiveModel, interactiveSource } = await import('@/studio/interactiveExport');
        const source = interactiveSource(doc, portalId);
        if (source.style !== input.interactive.style) throw new Error('The view style changed. Reopen export settings.');
        model = (await interactiveModel(ctx.platform, ctx.catalog, doc, portalId, input.elementIds ?? null,
          { ...input.interactive, style: source.style, destination: 'link' })).model;
      } else model = prepared ? prepared.bytes : await exportVrModel(doc, ctx.catalog);
      task.update(`Uploading ${megabytes(model.byteLength)}`, 0.25);
      // The version query lets headsets cache the model yet pick up a republished one.
      const tour = vrTourJson(doc, stops, `model.glb?v=${Date.now().toString(36)}`);
      if (input.interactive) Object.assign(tour, { sourceRenderer: input.interactive.renderer, sourceStyle: input.interactive.style,
        sourceBakeStatus: render.bake?.signature === viewBakeSignature(doc, render.settings) ? 'current' : render.bake ? 'outdated' : 'none',
        exportLighting: input.interactive.lighting, selectedElements: input.elementIds ?? null });
      if (prepared || baked && input.interactive) { tour.lighting = 'baked'; tour.mode = 'baked'; tour.bake = 'vertex'; tour.bakeScale = prepared?.metadata.lightScale ?? render.bake?.lightScale ?? 1; tour.exposure = Math.pow(2, render.settings.exposure); tour.toneMapping = render.settings.toneMapping; }
      published = await uploadVrTour(config, { previousId, model, tour }, (fraction, loaded, total) =>
        task.update(`Uploading ${megabytes(loaded)} of ${megabytes(total)}`, 0.25 + fraction * 0.7),
      );
      task.done();
    } catch (error) {
      task.failed();
      throw new CommandError('failed', error instanceof Error ? error.message : 'Upload failed');
    }
    if (!input.elementIds) await ctx.platform.storage.set(linkKey, published.id).catch(() => undefined);
    return { ...published, stops: stops.length, bytes: model.byteLength };
  },
});

export const vrCommands = [createVrStop, setVrStopHeading, publishVrTour];

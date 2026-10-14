import { z } from 'zod';
import { CommandError, defineEffect, defineMutation } from '../contract';
import { getElectronBridge } from '@/platform/electron';
import { bytesToBase64, base64ToBytes } from '@/persistence/base64';
import { createMeshElement } from './models';
import { withProgress } from '@/progress';
import { vrStopsOf } from '@/view3d/vrTour';
import { createVrStop } from './vr';

export const openD5Import = defineEffect({
  id: 'import-d5-folder',
  label: 'Import D5 project folder…',
  description:
    'Choose a D5 project folder, import its supported scene, and prepare a baked VR link.',
  aliases: ['d5 render', 'd5 scene', 'd5 to vr'],
  group: 'document',
  input: z.void(),
  when: ({ ui }) => ui.screen === 'project',
  run: async (ctx) => {
    if (ctx.getState().ui.screen !== 'project')
      throw new CommandError('rejected', 'Open an ArchAI project before importing a D5 folder.');
    if (!getElectronBridge())
      throw new CommandError(
        'unavailable',
        'D5 folder import is available in the ArchAI desktop app.',
      );
    ctx.dispatchSync(setD5ImportOpen, { open: true });
  },
});

export const setD5ImportOpen = defineMutation({
  id: 'set-d5-import-open',
  label: 'D5 import dialog',
  group: 'shell',
  palette: false,
  history: 'none',
  input: z.object({ open: z.boolean() }),
  run: (ctx, input) => {
    ctx.ui.d5ImportOpen = input.open;
  },
});

/** Conversion may take time. Guard the destination both before and after it, before any edit. */
export const placeD5Scene = defineEffect({
  id: 'place-d5-scene',
  label: 'Place D5 scene',
  group: 'create',
  palette: false,
  input: z.object({
    documentId: z.string(),
    name: z.string().min(1).max(200),
    glb: z.string().min(1),
  }),
  run: async (ctx, input) => {
    if (ctx.getState().doc.id !== input.documentId)
      throw new CommandError(
        'rejected',
        'The project changed. Choose the D5 folder again in the intended project.',
      );
    const { convertModel } = await import('@/view3d/modelImport');
    const model = await withProgress('Importing D5 scene', async (task) => {
      task.update('Preparing geometry and materials', null);
      await task.paint();
      return convertModel([{ name: 'd5-scene.glb', bytes: base64ToBytes(input.glb) }]);
    });
    const state = ctx.getState();
    if (state.doc.id !== input.documentId)
      throw new CommandError(
        'rejected',
        'The project changed during import. No D5 objects were added.',
      );
    const { viewport, canvasSize } = state.ui;
    const x = (canvasSize.width / 2 - viewport.x) / viewport.zoom;
    const y = (canvasSize.height / 2 - viewport.y) / viewport.zoom;
    return ctx.transaction('Import D5 scene', () => {
      const placed = ctx.dispatchSync(createMeshElement, {
        name: input.name,
        glb: bytesToBase64(model.glb),
        size: model.size,
        x,
        y,
        category: 'D5 scene',
        unit: model.unit,
        up: model.up,
        format: 'D5',
      });
      if (!placed.ok) throw new CommandError(placed.error.code, placed.error.message);
      if (!vrStopsOf(state.doc).length) {
        const stop = ctx.dispatchSync(createVrStop, {
          x,
          y: y + model.size[1] / 2 + 1500,
          elevation: 0,
          heading: 270,
          name: 'D5 starting view',
          select: false,
        });
        if (!stop.ok) throw new CommandError(stop.error.code, stop.error.message);
      }
      return placed.value;
    });
  },
});

export const d5Commands = [openD5Import, setD5ImportOpen, placeD5Scene];

/**
 * ArchAI Render (src/studio): the desktop app's rendering studio, live-linked to the board.
 */
import { z } from 'zod';
import { canRender, openRenderStudio } from '@/studio/link';
import { CommandError, defineEffect } from '../contract';

export const openRender = defineEffect({
  id: 'open-render-studio',
  label: 'Prepare VR Scene',
  description: 'Opens VR preparation to bake the project scene and publish a baked VR link or a rendered 360 image link.',
  aliases: ['render', 'rendering', 'visualise', 'visualize', 'path tracing', 'd5', 'twinmotion', 'lumion'],
  group: 'document',
  input: z.object({ bake: z.boolean().default(false) }).prefault({}),
  run: async (ctx, input) => {
    if (!canRender(ctx.platform)) throw new CommandError('rejected', 'ArchAI Render runs in the ArchAI desktop app for Windows.');
    openRenderStudio(ctx.platform, undefined, undefined, input.bake);
  },
});

export const renderCommands = [openRender];

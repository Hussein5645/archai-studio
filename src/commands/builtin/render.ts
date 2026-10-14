/**
 * ArchAI Render (src/studio): the desktop app's rendering studio, live-linked to the board.
 */
import { z } from 'zod';
import { canRender, openRenderStudio } from '@/studio/link';
import { CommandError, defineEffect } from '../contract';

export const openRender = defineEffect({
  id: 'open-render-studio',
  label: 'Prepare Rendered VR Link',
  description: 'Opens VR preparation to bake the project scene and publish a baked VR link or a rendered 360 image link.',
  aliases: ['render', 'rendering', 'visualise', 'visualize', 'path tracing', 'd5', 'twinmotion', 'lumion'],
  group: 'document',
  input: z.void(),
  run: async (ctx) => {
    if (!canRender(ctx.platform)) throw new CommandError('rejected', 'ArchAI Render runs in the ArchAI desktop app for Windows.');
    openRenderStudio(ctx.platform);
  },
});

export const renderCommands = [openRender];

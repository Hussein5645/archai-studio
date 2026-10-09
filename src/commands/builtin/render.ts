/**
 * ArchAI Render (src/studio): the desktop app's rendering studio, live-linked to the board.
 */
import { z } from 'zod';
import { canRender, openRenderStudio } from '@/studio/link';
import { CommandError, defineEffect } from '../contract';

export const openRender = defineEffect({
  id: 'open-render-studio',
  label: 'Open ArchAI Render',
  description: 'Opens ArchAI Render, the rendering studio of the desktop app (real-time and path-traced images, sun and sky, entourage), live-linked to this document.',
  aliases: ['render', 'rendering', 'visualise', 'visualize', 'path tracing', 'd5', 'twinmotion', 'lumion'],
  group: 'document',
  input: z.void(),
  run: async (ctx) => {
    if (!canRender(ctx.platform)) throw new CommandError('rejected', 'ArchAI Render runs in the ArchAI desktop app for Windows.');
    openRenderStudio(ctx.platform);
  },
});

export const renderCommands = [openRender];

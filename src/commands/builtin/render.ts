import { parseSettings, settingsKey } from '@/studio/settings';
/**
 * ArchAI Render (src/studio): the desktop app's rendering studio, live-linked to the board.
 */
import { z } from 'zod';
import { canRender } from '@/studio/link';
import { CommandError, defineEffect } from '../contract';

export const openRender = defineEffect({
  id: 'open-render-studio',
  label: 'Render',
  description: 'Opens the integrated Unreal viewport to adjust lighting, render images and export interactive scenes.',
  aliases: ['render', 'rendering', 'visualise', 'visualize', 'path tracing', 'd5', 'twinmotion', 'lumion'],
  group: 'document',
  input: z.object({ bake: z.boolean().default(false) }).prefault({}),
  run: async (ctx) => {
    if (!canRender(ctx.platform)) throw new CommandError('rejected', 'ArchAI Render runs in the ArchAI desktop app for Windows.');
    const state = ctx.getState();
    const target = state.ui.view3d.portalId ?? state.ui.selection.find((id) => state.doc.elements[id]?.meta?.['view3d']) ?? Object.values(state.doc.elements).find((element) => element.meta?.['view3d'])?.id;
    const opened = await ctx.dispatch('open-view3d', target ? { id: target } : {});
    if (!opened.ok) throw new CommandError('failed', opened.error.message);
    const id = ctx.getState().ui.view3d.portalId;
    const meta = id ? ctx.getState().doc.elements[id]?.meta?.['view3d'] as { renderSettings?: unknown } : null;
    const legacy = !meta?.renderSettings ? await ctx.platform.storage.get(settingsKey(state.doc.id)) : null;
    await ctx.dispatch('set-view3d-settings', { id, renderer: 'unreal', ...(legacy ? { renderSettings: parseSettings(legacy) } : {}) });
  },
});

export const renderCommands = [openRender];

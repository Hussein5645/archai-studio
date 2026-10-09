import { z } from 'zod';
import { CommandError, defineEffect } from '../contract';

export const undo = defineEffect({
  id: 'undo',
  label: 'Undo',
  group: 'history',
  shortcuts: ['Mod+Z'],
  input: z.void(),
  when: (ctx) => ctx.canUndo && ctx.ui.editingTextId === null,
  run: async (ctx) => {
    if (!ctx.undo()) throw new CommandError('unavailable', 'Nothing to undo');
  },
});

export const redo = defineEffect({
  id: 'redo',
  label: 'Redo',
  group: 'history',
  shortcuts: ['Mod+Shift+Z', 'Mod+Y'],
  input: z.void(),
  when: (ctx) => ctx.canRedo && ctx.ui.editingTextId === null,
  run: async (ctx) => {
    if (!ctx.redo()) throw new CommandError('unavailable', 'Nothing to redo');
  },
});

export const historyCommands = [undo, redo];

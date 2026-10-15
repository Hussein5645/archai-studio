import { z } from 'zod';
import { IdSchema, isAncestor, isEffectivelyLocked, isEffectivelyVisible } from '@/document';
import { activeGroup, editableGroup, groupPath } from '@/selection/groupScope';
import { CommandError, defineMutation, type MutationContext } from '../contract';

export function leaveGroup(ctx: MutationContext, all = false): void {
  const current = activeGroup(ctx.doc.elements, ctx.ui);
  const path = groupPath(ctx.doc.elements, current);
  ctx.ui.groupEditId = all ? null : path.at(-2)?.id ?? null;
  ctx.ui.selection = current ? [all ? path[0]!.id : current] : [];
  ctx.ui.editingTextId = null;
  ctx.ui.tool = 'select';
}

export const enterGroup = defineMutation({
  id: 'enter-group', label: 'Edit group', group: 'select', history: 'none', palette: false,
  description: 'Enters a group to select and edit its contents. Nested groups can be entered one at a time.',
  input: z.object({ id: IdSchema }),
  run: (ctx, { id }) => {
    const element = ctx.doc.elements[id];
    if (!editableGroup(element)) throw new CommandError('rejected', 'Choose a group to edit');
    if (isEffectivelyLocked(ctx.doc.elements, id) || !isEffectivelyVisible(ctx.doc.elements, id)) throw new CommandError('rejected', 'Show and unpin the group before editing it');
    if (ctx.ui.sheet && !isAncestor(ctx.doc.elements, ctx.ui.sheet.paperId, id)) throw new CommandError('rejected', 'Choose a group on the open sheet');
    const current = activeGroup(ctx.doc.elements, ctx.ui);
    if (current && id !== current && !isAncestor(ctx.doc.elements, current, id) && !isAncestor(ctx.doc.elements, id, current)) throw new CommandError('rejected', 'Leave this group before entering another group');
    ctx.ui.groupEditId = id;
    ctx.ui.selection = [];
    ctx.ui.editingTextId = null;
    ctx.ui.tool = 'select';
    ctx.ui.panels.left = true;
    ctx.ui.panels.leftTab = 'layers';
  },
});

export const exitGroup = defineMutation({
  id: 'exit-group', label: 'Exit group', group: 'select', history: 'none',
  input: z.object({ all: z.boolean().default(false) }).prefault({}),
  when: (ctx) => Boolean(activeGroup(ctx.doc.elements, ctx.ui)),
  run: (ctx, input) => leaveGroup(ctx, input.all),
});

export const groupCommands = [enterGroup, exitGroup];

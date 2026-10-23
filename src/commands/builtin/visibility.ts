import { z } from 'zod';
import { IdSchema, type JsonValue } from '@/document';
import { defineMutation } from '../contract';
import { requireTargets, snapshot } from '../helpers';
import { viewContext } from '@/document/viewVisibility';

export const setContextVisibility = defineMutation({
  id: 'set-context-visibility',
  label: 'Layer visibility',
  group: 'view',
  palette: false,
  history: 'record',
  input: z.object({
    ids: z.array(IdSchema).min(1),
    visible: z.boolean(),
    everywhere: z.boolean().default(false),
  }),
  run: (ctx, input) => {
    const context =
      ctx.ui.view3d.open && !ctx.ui.view3d.editingBoard
        ? viewContext(ctx.ui.view3d.portalId)
        : 'board';
    for (const element of requireTargets(ctx, input.ids)) {
      const meta = snapshot(element.meta ?? {}) as Record<string, JsonValue>;
      if (input.everywhere) {
        element.visible = input.visible;
        delete meta['visibilityByContext'];
      } else {
        const prior = meta['visibilityByContext'];
        meta['visibilityByContext'] = {
          ...(prior && typeof prior === 'object' && !Array.isArray(prior) ? prior : {}),
          [context]: input.visible,
        };
      }
      element.meta = meta;
    }
  },
});

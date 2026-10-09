import { z } from 'zod';
import { IdSchema, type JsonValue, type RectElement } from '@/document';
import { defineMutation, CommandError } from '../contract';
import { setSelection, topIndex } from '../helpers';
import { hostedBy } from '@/assets/arch-meta';
import { instanceElevationOf } from '@/view3d/geometry';
import { createLevelView } from './views';

function levelElevation(element: { meta?: Record<string, JsonValue> }): number | null {
  const level = element.meta?.['level'];
  if (!level || typeof level !== 'object' || Array.isArray(level)) return null;
  const elevation = level['elevation'];
  return typeof elevation === 'number' && Number.isFinite(elevation) ? elevation : null;
}

function applyLinkedElevation(element: { meta?: Record<string, JsonValue> }, elevation: number, offset: number) {
  element.meta = { ...(element.meta ?? {}), instanceElevation: elevation + offset };
}

export const createLevel = defineMutation({
  id: 'create-level',
  label: 'Create level',
  description: 'Draws a rectangular level extent on the board and a dotted datum in 3D.',
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({
    x: z.number().finite(), y: z.number().finite(),
    width: z.number().finite().positive(), height: z.number().finite().positive(),
    elevation: z.number().finite().default(0),
    name: z.string().trim().min(1).max(120).default('Level'),
    /** Also create the level's plan view (the board's level tool does). */
    planView: z.boolean().default(false),
  }),
  run: (ctx, input) => {
    const id = ctx.ids.next('el');
    const level: RectElement = {
      id, kind: 'rect', parentId: null, index: topIndex(ctx.doc.elements, null),
      x: input.x, y: input.y, rotation: 0, visible: true, locked: false,
      width: input.width, height: input.height, radius: 0,
      style: { fill: '#dbeafe', stroke: '#2563eb', strokeWidth: 12, opacity: 0.24 },
      name: input.name,
      meta: { level: { elevation: input.elevation } },
    };
    ctx.doc.elements[id] = level;
    if (input.planView) createLevelView.run(ctx, { id, cutHeight: 1200 });
    setSelection(ctx, [id]);
    ctx.ui.tool = 'select';
    return id;
  },
});

export const setLevelElevation = defineMutation({
  id: 'set-level-elevation', label: 'Set level elevation', group: 'transform', palette: false, history: 'record',
  input: z.object({ id: IdSchema, elevation: z.number().finite() }),
  run: (ctx, input) => {
    const level = ctx.doc.elements[input.id];
    if (!level || levelElevation(level) === null) throw new CommandError('rejected', 'Select a level');
    level.meta = { ...(level.meta ?? {}), level: { elevation: input.elevation } };
    for (const element of Object.values(ctx.doc.elements)) {
      const constraint = element.meta?.['levelConstraint'];
      if (!constraint || typeof constraint !== 'object' || Array.isArray(constraint) || constraint['levelId'] !== input.id) continue;
      const offset = typeof constraint['offset'] === 'number' && Number.isFinite(constraint['offset']) ? constraint['offset'] : 0;
      const oldElevation = instanceElevationOf(element, ctx.doc.elements);
      applyLinkedElevation(element, input.elevation, offset);
      const delta = (input.elevation + offset) - oldElevation;
      if (Math.abs(delta) > 1e-6) {
        for (const hostedId of hostedBy(ctx.doc.elements, [element.id])) {
          const hosted = ctx.doc.elements[hostedId];
          if (!hosted || hosted.meta?.['levelConstraint']) continue;
          if (typeof hosted.meta?.['instanceElevation'] === 'number') {
            hosted.meta = { ...hosted.meta, instanceElevation: hosted.meta['instanceElevation'] + delta };
          }
        }
      }
    }
    return level.id;
  },
});

export const setElementLevelLink = defineMutation({
  id: 'set-element-level-link', label: 'Link elevation to level', group: 'transform', palette: false, history: 'record',
  input: z.object({ id: IdSchema, levelId: IdSchema.nullable(), offset: z.number().finite().default(0) }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    if (!element) throw new CommandError('rejected', 'The element is missing');
    if (input.levelId === null) {
      const meta = { ...(element.meta ?? {}) };
      delete meta['levelConstraint'];
      element.meta = meta;
      if (element.parentId && levelElevation(ctx.doc.elements[element.parentId] ?? {}) !== null) {
        element.parentId = null;
      }
      return element.id;
    }
    if (input.levelId === input.id) throw new CommandError('rejected', 'A level cannot reference itself');
    const level = ctx.doc.elements[input.levelId];
    const elevation = level ? levelElevation(level) : null;
    if (elevation === null) throw new CommandError('rejected', 'The selected level is missing');
    if (element.parentId && levelElevation(ctx.doc.elements[element.parentId] ?? {}) !== null && element.parentId !== input.levelId) {
      element.parentId = null;
    }
    const oldElevation = instanceElevationOf(element, ctx.doc.elements);
    element.meta = { ...(element.meta ?? {}), levelConstraint: { levelId: input.levelId, offset: input.offset } };
    applyLinkedElevation(element, elevation, input.offset);
    const delta = (elevation + input.offset) - oldElevation;
    if (Math.abs(delta) > 1e-6) {
      for (const hostedId of hostedBy(ctx.doc.elements, [element.id])) {
        const hosted = ctx.doc.elements[hostedId];
        if (!hosted || hosted.meta?.['levelConstraint']) continue;
        if (typeof hosted.meta?.['instanceElevation'] === 'number') {
          hosted.meta = { ...hosted.meta, instanceElevation: hosted.meta['instanceElevation'] + delta };
        }
      }
    }
    return element.id;
  },
});

export const levelCommands = [createLevel, setLevelElevation, setElementLevelLink];

/**
 * Reference point commands (see src/document/point.ts): place points, and move points (and noise
 * emitters) in plan and height together as the 3D gizmo does, so a point can mark a spot in
 * space or drive parametric graphs through its X / Y / elevation.
 */
import { z } from 'zod';
import { IdSchema, type JsonValue } from '@/document';
import { isPoint, POINT_SIZE } from '@/document/point';
import { noiseEmitterOf } from '@/analysis/model';
import { instanceElevationOf } from '@/view3d/geometry';
import { CommandError, defineMutation } from '../contract';
import { setSelection } from '../helpers';
import { createRect } from './create';
import { moveSelection } from './transform';
import { setInstanceElevation } from './view3d';

export const createPoint = defineMutation({
  id: 'create-point',
  label: 'Point',
  description: 'Places a reference point centred on (x, y) in mm, at an elevation in mm.',
  aliases: ['reference point', 'marker'],
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({ x: z.number().finite(), y: z.number().finite(), elevation: z.number().finite().default(0), name: z.string().trim().min(1).max(200).optional(), select: z.boolean().default(true) }),
  run: (ctx, input) => {
    const count = Object.values(ctx.doc.elements).filter((element) => isPoint(element)).length;
    const id = createRect.run(ctx, {
      x: input.x - POINT_SIZE / 2,
      y: input.y - POINT_SIZE / 2,
      width: POINT_SIZE,
      height: POINT_SIZE,
      radius: POINT_SIZE / 2,
      rotation: 0,
      style: { fill: '#ffffff', stroke: '#7c3aed', strokeWidth: 20, opacity: 1 },
      name: input.name ?? `Point ${count + 1}`,
      meta: { point: {}, ...(input.elevation !== 0 ? { instanceElevation: input.elevation } : {}) },
      parentId: null,
      select: false,
    });
    if (input.select) setSelection(ctx, [id]);
    return id;
  },
});

/** Moves elements in plan and in height (points and other elements by elevation, noise emitters by height). */
export const movePoints = defineMutation({
  id: 'move-points',
  label: 'Move points in 3D',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ ids: z.array(IdSchema).min(1), dx: z.number().finite(), dy: z.number().finite(), dz: z.number().finite() }),
  run: (ctx, input) => {
    for (const id of input.ids) {
      const element = ctx.doc.elements[id];
      if (!element || element.locked) throw new CommandError('rejected', 'Select unlocked elements');
      if (Math.abs(input.dz) > 1e-9 && element.meta?.['levelConstraint']) throw new CommandError('rejected', `${element.name ?? 'This element'} follows its level: change the level offset instead`);
    }
    moveSelection.run(ctx, { ids: input.ids, dx: input.dx, dy: input.dy });
    if (Math.abs(input.dz) < 1e-9) return;
    for (const id of input.ids) {
      const element = ctx.doc.elements[id]!;
      if (!noiseEmitterOf(element as never)) {
        setInstanceElevation.run(ctx, { ids: [id], elevation: instanceElevationOf(element, ctx.doc.elements) + input.dz });
      } else {
        const emitter = element.meta!['noiseEmitter'] as Record<string, JsonValue>;
        emitter['height'] = Math.max(0, Number(emitter['height'] ?? 1000) + input.dz);
      }
    }
  },
});

export const pointCommands = [createPoint, movePoints];

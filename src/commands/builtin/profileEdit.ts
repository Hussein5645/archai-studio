/**
 * Profile (boundary) drawing mode for floors, ceilings and levels — Revit's sketch mode on the
 * board. Choosing the Floor / Ceiling / Level tool enters the mode (../profileMode.ts); editing
 * an existing one seeds its outline as a sketch line. While the mode is on, every board line
 * tool draws the boundary; Finish joins what was drawn into one closed loop (arcs and curves
 * stay exact) and creates or reshapes the element; Cancel drops the sketch.
 */
import { z } from 'zod';
import type { Draft } from 'immer';
import { IdSchema, type Element, type ElementTable, type JsonValue, type LineElement, type RectElement } from '@/document';
import { applyToPoint, applyToVector, fromTRS, invert, worldMatrix } from '@/geometry';
import { archTypeOf } from '@/assets/arch-meta';
import { elementPath, elementSegments, localCurve, setElementPath } from '@/drafting/lines';
import { samplePath, type Path } from '@/drafting/paths';
import { profileLoops, profileShape, type ProfileShape } from '@/drafting/profile';
import { openingsJson, slabOpenings } from '@/assets/slabOpenings';
import type { ProfileKind } from '@/store';
import { CommandError, defineMutation, type MutationContext } from '../contract';
import { removeSubtree, setSelection } from '../helpers';
import { PROFILE_SKETCH_STYLE } from '../profileMode';
import { createSlabEnclosure } from './assets';
import { createLine } from './create';
import { createLevel } from './levels';

/** The profile kind of an existing element (a floor, a ceiling or a level), or null. */
export function profileKindOf(element: Element | undefined | null): ProfileKind | null {
  if (!element) return null;
  if (element.kind === 'rect' && element.meta?.['level']) return 'level';
  if (element.kind !== 'line') return null;
  const type = archTypeOf(element);
  return type === 'floor' || type === 'ceiling' ? type : null;
}

function record(value: unknown): Record<string, JsonValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, JsonValue>) : null;
}

/** A level's outline in world space: its drawn profile, else its rectangle. */
function levelPath(elements: ElementTable, level: RectElement): Path {
  const outline = record(record(level.meta?.['level'])?.['outline']);
  if (outline && Array.isArray(outline['points'])) {
    // Read through the line maths: a stand-in line with the level's frame and the outline.
    const stand = { ...level, kind: 'line', points: outline['points'], ...(outline['path'] ? { path: outline['path'] } : {}), closed: true } as unknown as LineElement;
    return elementPath(elements, stand);
  }
  return { segs: elementSegments(elements, level), closed: true };
}

/** A slab's openings in world space (read through a stand-in line in the slab's frame). */
function openingPaths(elements: ElementTable, slab: LineElement): Path[] {
  return slabOpenings(slab).map((opening) => elementPath(elements, { ...slab, points: opening.points, ...(opening.path ? { path: opening.path } : { path: undefined }), closed: true } as LineElement));
}

/** Writes the openings (in the slab's frame) and the net area onto a slab. */
function setSlabOpenings(elements: ElementTable, slab: Draft<LineElement>, shape: ProfileShape): void {
  const inverse = invert(worldMatrix(elements, slab as LineElement));
  const openings = shape.openings.map((path) => {
    const curve = localCurve(path, inverse);
    return { points: curve.points, ...(curve.path ? { path: curve.path } : {}) };
  });
  const arch: Record<string, JsonValue> = { ...(record(slab.meta?.['arch']) ?? {}), area: shape.area };
  if (openings.length) arch['openings'] = openingsJson(openings);
  else delete arch['openings'];
  slab.meta = { ...(slab.meta ?? {}), arch };
}

/** The world outline of an element whose profile can be edited. */
function outlineOf(elements: ElementTable, element: Element): Path | null {
  const kind = profileKindOf(element);
  if (kind === 'level') return levelPath(elements, element as RectElement);
  if (kind) return elementPath(elements, element as LineElement);
  return null;
}

/**
 * Gives a level a new outline: its rectangle becomes the outline's bounds (in its own frame, so a
 * rotated level stays rotated) without moving what the level holds; a non-rectangular outline is
 * kept in `meta.level.outline`.
 */
function applyLevelOutline(ctx: MutationContext, level: Draft<RectElement>, loop: Path): void {
  const elements = ctx.doc.elements as ElementTable;
  const toLocal = invert(worldMatrix(elements, level as RectElement));
  const local = samplePath(loop).map((point) => applyToPoint(toLocal, point));
  const minX = Math.min(...local.map((p) => p.x));
  const minY = Math.min(...local.map((p) => p.y));
  const width = Math.max(...local.map((p) => p.x)) - minX;
  const height = Math.max(...local.map((p) => p.y)) - minY;
  if (width < 1 || height < 1) throw new CommandError('rejected', 'The level boundary has no area');
  // Move the origin to the outline's corner; children keep their place on the board.
  const shift = applyToVector(fromTRS(0, 0, level.rotation), { x: minX, y: minY });
  level.x += shift.x;
  level.y += shift.y;
  for (const child of Object.values(ctx.doc.elements)) {
    if (child.parentId !== level.id) continue;
    child.x -= minX;
    child.y -= minY;
  }
  level.width = width;
  level.height = height;
  const curve = localCurve(loop, invert(worldMatrix(elements, level as RectElement)));
  const tolerance = 1e-3;
  const rectangular = !curve.path && curve.points.length === 4 && curve.points.every(([x, y]) => (Math.abs(x) < tolerance || Math.abs(x - width) < tolerance) && (Math.abs(y) < tolerance || Math.abs(y - height) < tolerance));
  const meta = { ...(record(level.meta?.['level']) ?? { elevation: 0 }) };
  if (rectangular) delete meta['outline'];
  else meta['outline'] = { points: curve.points, ...(curve.path ? { path: curve.path } : {}) } as unknown as JsonValue;
  level.meta = { ...(level.meta ?? {}), level: meta };
}

export const beginProfileEdit = defineMutation({
  id: 'begin-profile-edit',
  label: 'Edit boundary',
  description: 'Edits the boundary of a floor, ceiling or level in the profile drawing mode (its outline becomes a sketch line; Finish applies the change).',
  aliases: ['edit profile', 'edit sketch', 'edit boundary', 'sketch mode'],
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema }),
  run: (ctx, input) => {
    if (ctx.ui.profileEdit) throw new CommandError('rejected', 'Finish or cancel the boundary being drawn first');
    const elements = ctx.doc.elements as ElementTable;
    const target = elements[input.id];
    const kind = profileKindOf(target);
    const outline = target && outlineOf(elements, target);
    if (!target || !kind || !outline?.segs.length) throw new CommandError('rejected', 'Select a floor, ceiling or level');
    const startIds = Object.keys(elements);
    const seed = createLine.run(ctx, { points: [[0, 0], [1, 1]], closed: true, rotation: 0, parentId: null, style: PROFILE_SKETCH_STYLE, name: 'Boundary sketch', select: true, meta: { profileSketch: true } });
    setElementPath(ctx.doc.elements as ElementTable, ctx.doc.elements[seed] as Draft<LineElement>, outline);
    // Each opening of a slab comes back as its own sketch loop.
    if (kind !== 'level') {
      for (const path of openingPaths(elements, target as LineElement)) {
        const hole = createLine.run(ctx, { points: [[0, 0], [1, 1]], closed: true, rotation: 0, parentId: null, style: PROFILE_SKETCH_STYLE, name: 'Opening sketch', select: false, meta: { profileSketch: true } });
        setElementPath(ctx.doc.elements as ElementTable, ctx.doc.elements[hole] as Draft<LineElement>, path);
      }
    }
    ctx.ui.profileEdit = { kind, targetId: target.id, startIds };
    ctx.ui.tool = 'select';
    return seed;
  },
});

export const finishProfileEdit = defineMutation({
  id: 'finish-profile-edit',
  label: 'Finish boundary',
  description: 'Turns the closed loop drawn in the profile mode into the floor, ceiling or level (or reshapes the one being edited).',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.void(),
  run: (ctx) => {
    const edit = ctx.ui.profileEdit;
    if (!edit) throw new CommandError('rejected', 'No boundary is being drawn');
    const elements = ctx.doc.elements as ElementTable;
    const loops = profileLoops(elements, edit);
    const shape = profileShape(loops, edit.kind);
    if (typeof shape === 'string') throw new CommandError('rejected', shape);
    const loop = shape.outer;
    const target = edit.targetId ? ctx.doc.elements[edit.targetId] : undefined;
    let resultId: string;
    if (edit.kind === 'level') {
      if (target && profileKindOf(target) === 'level') resultId = target.id;
      else {
        const points = samplePath(loop);
        const x = Math.min(...points.map((p) => p.x));
        const y = Math.min(...points.map((p) => p.y));
        resultId = createLevel.run(ctx, { x, y, width: Math.max(...points.map((p) => p.x)) - x || 1, height: Math.max(...points.map((p) => p.y)) - y || 1, elevation: 0, name: 'Level', planView: true });
      }
      applyLevelOutline(ctx, ctx.doc.elements[resultId] as Draft<RectElement>, loop);
    } else if (target && profileKindOf(target) === edit.kind) {
      resultId = target.id;
      const slab = ctx.doc.elements[resultId] as Draft<LineElement>;
      setElementPath(elements, slab, loop);
      setSlabOpenings(elements, slab, shape);
    } else {
      const points = samplePath(loop).map((p): [number, number] => [p.x, p.y]);
      // The sampled ring repeats its first point at the end.
      if (points.length > 3 && Math.hypot(points[0]![0] - points.at(-1)![0], points[0]![1] - points.at(-1)![1]) < 1e-6) points.pop();
      resultId = createSlabEnclosure.run(ctx, { points, type: edit.kind });
      // Arcs and curves stay exact.
      const slab = ctx.doc.elements[resultId] as Draft<LineElement>;
      if (loop.segs.some((seg) => seg.kind !== 'line')) setElementPath(elements, slab, loop);
      setSlabOpenings(elements, slab, shape);
    }
    for (const member of loops.members) if (ctx.doc.elements[member.id]) removeSubtree(ctx.doc, member.id);
    ctx.ui.profileEdit = null;
    ctx.ui.tool = 'select';
    setSelection(ctx, [resultId]);
    return resultId;
  },
});

export const cancelProfileEdit = defineMutation({
  id: 'cancel-profile-edit',
  label: 'Cancel boundary',
  description: 'Leaves the profile drawing mode and removes what was drawn in it; the element keeps its boundary.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.void(),
  run: (ctx) => {
    const edit = ctx.ui.profileEdit;
    if (!edit) return null;
    const loops = profileLoops(ctx.doc.elements as ElementTable, edit);
    for (const member of loops.members) if (ctx.doc.elements[member.id]) removeSubtree(ctx.doc, member.id);
    ctx.ui.profileEdit = null;
    ctx.ui.tool = 'select';
    setSelection(ctx, edit.targetId && ctx.doc.elements[edit.targetId] ? [edit.targetId] : []);
    return edit.targetId;
  },
});

export const profileEditCommands = [beginProfileEdit, finishProfileEdit, cancelProfileEdit];

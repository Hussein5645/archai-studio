/**
 * Drafting and edit commands for the board (AutoCAD / Revit style): copy with a count, mirror,
 * scale about a point, rotate-copy, live arrays, offset, trim / extend / split / fillet / join /
 * explode of lines, align and distribute, match properties, and the drafting options. Each is
 * one undo step and takes world-space millimetres, so agents can use them as readily as the
 * interactive tools (src/interaction/drafting.ts) that drive them.
 */
import type { Draft } from 'immer';
import { z } from 'zod';
import { IdSchema, childrenOf, type Element, type ElementTable, type GroupElement, type JsonValue, type LineElement } from '@/document';
import { applyToPoint, boundsOfIds, sampleCurvePath, invert, localBounds, localMatrix, rectCenter, transformRect, unionRects, worldBounds, worldMatrix, type Rect, type Vec2 } from '@/geometry';
import { elementPath, elementSegments, reflection, rotationAbout, setElementPath, setWorldPolyline, transformElementWorld, worldPolyline, type Tuple } from '@/drafting/lines';
import { cornerPaths, cuts, extendPath, filletPath, joinPaths, locate, offsetPath, segEnd, segPoint, segReverse, segStart, splitPath, trimPath, type Path, type PSeg } from '@/drafting/paths';
import { circleFrom3 } from '@/drafting/shapes';
import { OBJECT_SNAP_KINDS } from '@/drafting/osnap';
import { CommandError, defineMutation, type MutationContext } from '../contract';
import { cloneSubtrees, removeSubtree, requireTargets, setSelection, syncCamerasAmong, topIndex } from '../helpers';
import { resizeSelection, rotateSelection } from './transform';

const Ids = z.array(IdSchema).optional();
const PointInput = z.object({ x: z.number().finite(), y: z.number().finite() });

// ---- options ---------------------------------------------------------------------------------

const OsnapPatch = z.object({
  objects: z.boolean().optional(),
  tracking: z.boolean().optional(),
  polar: z.number().min(0).max(90).optional(),
  kinds: z.object(Object.fromEntries(OBJECT_SNAP_KINDS.map((kind) => [kind, z.boolean().optional()])) as Record<(typeof OBJECT_SNAP_KINDS)[number], z.ZodOptional<z.ZodBoolean>>).partial().optional(),
});

export const setDrafting = defineMutation({
  id: 'set-drafting',
  label: 'Drafting options',
  description: 'Changes drafting-tool options (polygon sides, arc/circle mode, copies, array, offset, fillet, trim mode) and object snapping (snap kinds, tracking, polar angle).',
  group: 'view',
  palette: false,
  history: 'none',
  input: z.object({
    osnap: OsnapPatch.optional(),
    circleMode: z.enum(['center', '2p', '3p']).optional(),
    arcMode: z.enum(['three-point', 'center', 'tangent']).optional(),
    polygonSides: z.int().min(3).max(64).optional(),
    polygonCircumscribed: z.boolean().optional(),
    rectRadius: z.number().min(0).optional(),
    copies: z.int().min(1).max(500).optional(),
    keepOriginal: z.boolean().optional(),
    mirrorKeepOriginal: z.boolean().optional(),
    arrayKind: z.enum(['linear', 'polar']).optional(),
    arrayCount: z.int().min(2).max(500).optional(),
    arrayAngle: z.number().min(-360).max(360).optional(),
    offset: z.number().finite().optional(),
    trimMode: z.enum(['corner', 'segment']).optional(),
    filletMode: z.enum(['fillet', 'chamfer']).optional(),
    filletSize: z.number().min(0).optional(),
  }),
  run: (ctx, input) => {
    const { osnap, ...rest } = input;
    const drafting = ctx.ui.drafting;
    for (const [key, value] of Object.entries(rest)) if (value !== undefined) (drafting as unknown as Record<string, unknown>)[key] = value;
    if (osnap) {
      if (osnap.objects !== undefined) drafting.osnap.objects = osnap.objects;
      if (osnap.tracking !== undefined) drafting.osnap.tracking = osnap.tracking;
      if (osnap.polar !== undefined) drafting.osnap.polar = osnap.polar;
      for (const [kind, value] of Object.entries(osnap.kinds ?? {})) if (value !== undefined) drafting.osnap.kinds[kind as (typeof OBJECT_SNAP_KINDS)[number]] = value;
    }
  },
});

export const toggleObjectSnap = defineMutation({
  id: 'toggle-object-snap',
  label: 'Toggle object snaps',
  description: 'Turns snapping to endpoints, midpoints, intersections and other geometry on or off.',
  aliases: ['osnap'],
  group: 'view',
  shortcuts: ['F3'],
  history: 'none',
  input: z.void(),
  run: (ctx) => {
    ctx.ui.drafting.osnap.objects = !ctx.ui.drafting.osnap.objects;
    return ctx.ui.drafting.osnap.objects;
  },
});

// ---- helpers --------------------------------------------------------------------------------

function elementsOf(ctx: MutationContext): ElementTable {
  return ctx.doc.elements as ElementTable;
}

/** Deep copies of the targets placed like the originals (and selected by the caller). */
function copiesOf(ctx: MutationContext, ids: readonly string[]): Draft<Element>[] {
  const elements = elementsOf(ctx);
  const clones = cloneSubtrees(elements, ids, ctx.ids);
  for (const clone of clones.all) {
    if (clones.roots.includes(clone)) clone.index = topIndex(ctx.doc.elements as ElementTable, clone.parentId);
    ctx.doc.elements[clone.id] = clone;
  }
  return clones.roots.map((root) => ctx.doc.elements[root.id]!);
}

function moveWorld(ctx: MutationContext, element: Draft<Element>, dx: number, dy: number): void {
  transformElementWorld(ctx.doc.elements, element, [1, 0, 0, 1, dx, dy]);
}

// ---- copy / mirror / scale / rotate-copy -----------------------------------------------------

export const copySelection = defineMutation({
  id: 'copy-by-offset',
  label: 'Copy',
  description: 'Copies the selection by an offset (mm); `count` places that many copies at 1×, 2×, … the offset (a quick linear array).',
  aliases: ['copy move', 'duplicate by offset'],
  group: 'arrange',
  palette: false,
  history: 'record',
  input: z.object({ ids: Ids, dx: z.number().finite(), dy: z.number().finite(), count: z.int().min(1).max(500).default(1) }),
  when: (ctx) => ctx.hasSelection,
  run: (ctx, input) => {
    const targets = requireTargets(ctx, input.ids, { what: 'elements to copy' });
    const created: string[] = [];
    for (let k = 1; k <= input.count; k++) {
      for (const copy of copiesOf(ctx, targets.map((t) => t.id))) {
        moveWorld(ctx, copy, input.dx * k, input.dy * k);
        created.push(copy.id);
      }
    }
    syncCamerasAmong(ctx.doc.elements, created);
    setSelection(ctx, created);
    return created;
  },
});

export const mirrorSelection = defineMutation({
  id: 'mirror-selection',
  label: 'Mirror',
  description: 'Mirrors the selection across the line through `a` and `b` (world mm); keeps the originals when `keepOriginal` is true (Revit\'s default).',
  aliases: ['flip', 'reflect'],
  group: 'transform',
  palette: false,
  history: 'record',
  input: z.object({ ids: Ids, a: PointInput, b: PointInput, keepOriginal: z.boolean().default(true) }),
  when: (ctx) => ctx.hasSelection,
  run: (ctx, input) => {
    if (Math.hypot(input.b.x - input.a.x, input.b.y - input.a.y) < 1e-9) throw new CommandError('invalid-input', 'The mirror axis needs two different points');
    const targets = requireTargets(ctx, input.ids, { unlocked: !input.keepOriginal, what: 'elements to mirror' });
    const subjects = input.keepOriginal ? copiesOf(ctx, targets.map((t) => t.id)) : targets;
    const r = reflection(input.a, input.b);
    for (const element of subjects) transformElementWorld(ctx.doc.elements, element, r);
    const ids = subjects.map((s) => s.id);
    syncCamerasAmong(ctx.doc.elements, ids);
    setSelection(ctx, ids);
    return ids;
  },
});

export const scaleSelection = defineMutation({
  id: 'scale-selection',
  label: 'Scale',
  description: 'Scales the selection uniformly by `factor` about a base point (world mm).',
  group: 'transform',
  palette: false,
  history: 'record',
  input: z.object({ ids: Ids, base: PointInput, factor: z.number().positive() }),
  when: (ctx) => ctx.hasSelection,
  run: (ctx, input) => {
    const targets = requireTargets(ctx, input.ids, { unlocked: true, what: 'elements to scale' });
    const ids = targets.map((t) => t.id);
    const from = boundsOfIds(elementsOf(ctx), ids);
    if (!from) throw new CommandError('rejected', 'Nothing to scale');
    const f = input.factor;
    const to = { x: input.base.x + (from.x - input.base.x) * f, y: input.base.y + (from.y - input.base.y) * f, width: from.width * f, height: from.height * f };
    return resizeSelection.run(ctx, { ids, from, to });
  },
});

export const rotateCopySelection = defineMutation({
  id: 'rotate-copy-selection',
  label: 'Rotate copy',
  description: 'Adds rotated copies of the selection about a pivot (degrees clockwise), leaving the originals.',
  group: 'transform',
  palette: false,
  history: 'record',
  input: z.object({ ids: Ids, degrees: z.number().finite(), pivot: PointInput }),
  when: (ctx) => ctx.hasSelection,
  run: (ctx, input) => {
    const targets = requireTargets(ctx, input.ids, { what: 'elements to rotate' });
    const copies = copiesOf(ctx, targets.map((t) => t.id)).map((c) => c.id);
    rotateSelection.run(ctx, { ids: copies, degrees: input.degrees, pivot: input.pivot });
    setSelection(ctx, copies);
    return copies;
  },
});

// ---- live arrays -----------------------------------------------------------------------------

const ArraySpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('linear'), count: z.int().min(2).max(500), dx: z.number().finite(), dy: z.number().finite() }),
  z.object({ kind: z.literal('polar'), count: z.int().min(2).max(500), cx: z.number().finite(), cy: z.number().finite(), angle: z.number().min(-360).max(360).default(360) }),
]);
export type ArraySpec = z.infer<typeof ArraySpec>;

/** The array spec stored on an array group, if the element is one. */
export function arraySpecOf(element: Element | undefined): ArraySpec | null {
  const raw = element?.kind === 'group' ? element.meta?.['array'] : undefined;
  const parsed = raw ? ArraySpec.safeParse(raw) : null;
  return parsed?.success ? parsed.data : null;
}

/** Rebuilds the copies of an array group from its source members (those not marked as copies). */
function regenerateArray(ctx: MutationContext, group: Draft<GroupElement>, spec: ArraySpec): string[] {
  const elements = elementsOf(ctx);
  for (const child of childrenOf(elements, group.id)) if (child.meta?.['arrayCopy']) removeSubtree(ctx.doc, child.id);
  const sources = childrenOf(elementsOf(ctx), group.id).map((child) => child.id);
  const created: string[] = [];
  for (let k = 1; k < spec.count; k++) {
    for (const copy of copiesOf(ctx, sources)) {
      copy.meta = { ...(copy.meta ?? {}), arrayCopy: true };
      if (spec.kind === 'linear') moveWorld(ctx, copy, spec.dx * k, spec.dy * k);
      else {
        // A full turn spreads the copies evenly; a partial sweep puts the last one at its end.
        const step = Math.abs(spec.angle) >= 360 ? spec.angle / spec.count : spec.angle / (spec.count - 1);
        transformElementWorld(ctx.doc.elements, copy, rotationAbout({ x: spec.cx, y: spec.cy }, step * k));
      }
      created.push(copy.id);
    }
  }
  return created;
}

export const createArray = defineMutation({
  id: 'create-array',
  label: 'Array',
  description: 'Makes a live array of the selection: `linear` (count copies spaced dx, dy mm) or `polar` (count copies about cx, cy over `angle` degrees). The array is a group whose count and spacing stay editable (set-array).',
  aliases: ['repeat', 'pattern'],
  group: 'arrange',
  palette: false,
  history: 'record',
  input: z.object({ ids: Ids, spec: ArraySpec, name: z.string().max(200).optional() }),
  when: (ctx) => ctx.hasSelection,
  run: (ctx, input) => {
    const targets = requireTargets(ctx, input.ids, { unlocked: true, what: 'elements to array' });
    const parentId = targets[0]!.parentId;
    if (targets.some((t) => t.parentId !== parentId)) throw new CommandError('rejected', 'Array members must share the same parent');
    const elements = elementsOf(ctx);
    const frontIndex = targets.map((t) => t.index).sort().at(-1)!;
    const bounds = unionRects(targets.map((t) => transformRect(localMatrix(t as Element), localBounds(elements, t as Element)))) ?? { x: 0, y: 0, width: 0, height: 0 };
    const group: GroupElement = {
      id: ctx.ids.next('el'),
      kind: 'group',
      parentId,
      index: frontIndex,
      x: bounds.x,
      y: bounds.y,
      rotation: 0,
      visible: true,
      locked: false,
      name: input.name ?? `Array × ${input.spec.count}`,
      meta: { array: input.spec as unknown as JsonValue },
    };
    ctx.doc.elements[group.id] = group;
    for (const target of targets) {
      target.parentId = group.id;
      target.x -= bounds.x;
      target.y -= bounds.y;
    }
    regenerateArray(ctx, ctx.doc.elements[group.id] as Draft<GroupElement>, input.spec);
    setSelection(ctx, [group.id]);
    return group.id;
  },
});

export const setArray = defineMutation({
  id: 'set-array',
  label: 'Edit array',
  description: 'Changes a live array (count, spacing, centre, angle) and rebuilds its copies from the source members.',
  group: 'arrange',
  palette: false,
  history: 'record',
  input: z.object({
    id: IdSchema,
    count: z.int().min(2).max(500).optional(),
    dx: z.number().finite().optional(),
    dy: z.number().finite().optional(),
    cx: z.number().finite().optional(),
    cy: z.number().finite().optional(),
    angle: z.number().min(-360).max(360).optional(),
  }),
  run: (ctx, input) => {
    const group = ctx.doc.elements[input.id];
    const spec = arraySpecOf(group as Element | undefined);
    if (!group || group.kind !== 'group' || !spec) throw new CommandError('rejected', 'That is not an array');
    const { id: _id, ...patch } = input;
    const next = ArraySpec.parse({ ...spec, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) });
    group.meta = { ...(group.meta ?? {}), array: next as unknown as JsonValue };
    group.name = group.name?.startsWith('Array ×') ? `Array × ${next.count}` : group.name;
    regenerateArray(ctx, group as Draft<GroupElement>, next);
    return group.id;
  },
});

// ---- offset ----------------------------------------------------------------------------------

export const offsetElement = defineMutation({
  id: 'offset-element',
  label: 'Offset',
  description: 'Adds a parallel copy of any drawn line, polyline, arc, circle, curve or rectangle `distance` mm away, on the side of `toward` (a world point).',
  aliases: ['parallel copy'],
  group: 'arrange',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, distance: z.number().positive(), toward: PointInput }),
  run: (ctx, input) => {
    const elements = elementsOf(ctx);
    const element = elements[input.id];
    if (!element) throw new CommandError('rejected', 'Nothing to offset');
    if (element.kind !== 'rect' && element.kind !== 'line') throw new CommandError('rejected', 'Offset works on lines, curves and rectangles');
    const d = input.distance;
    if (element.kind === 'rect') {
      const [copy] = copiesOf(ctx, [element.id]);
      if (!copy || copy.kind !== 'rect') throw new CommandError('failed', 'Could not copy');
      // Grow when `toward` is outside, shrink when inside.
      const local = applyToPoint(invert(worldMatrix(elementsOf(ctx), copy as Element)), input.toward);
      const inside = local.x > 0 && local.y > 0 && local.x < copy.width && local.y < copy.height;
      const delta = inside ? -d : d;
      if (copy.width + 2 * delta <= 0 || copy.height + 2 * delta <= 0) throw new CommandError('rejected', 'The offset is larger than the rectangle');
      const m = worldMatrix(elementsOf(ctx), copy as Element);
      moveWorld(ctx, copy, m[0] * -delta + m[2] * -delta, m[1] * -delta + m[3] * -delta);
      copy.width += 2 * delta;
      copy.height += 2 * delta;
      copy.radius = Math.max(0, copy.radius + (copy.radius > 0 ? delta : 0));
      setSelection(ctx, [copy.id]);
      return copy.id;
    }
    const path = elementPath(elements, element as LineElement);
    // Left (+) or right (−) of the drawn direction: whichever lands nearer `toward`.
    const options = [d, -d].map((signed) => offsetPath(path, signed)).filter((p): p is Path => p !== null);
    if (!options.length) throw new CommandError('rejected', 'The offset is larger than the curve allows');
    const chosen = options.sort((p, q) => locate(p, input.toward).distance - locate(q, input.toward).distance)[0]!;
    const [copy] = copiesOf(ctx, [element.id]);
    if (!copy || copy.kind !== 'line') throw new CommandError('failed', 'Could not copy');
    setElementPath(elementsOf(ctx), copy as Draft<LineElement>, chosen);
    setSelection(ctx, [copy.id]);
    return copy.id;
  },
});

// ---- line topology: trim, extend, split, corner, fillet, join, explode (curves too) --------

/** A straight line / polyline (for the vertex and segment grips). */
function straightLine(ctx: MutationContext, id: string): { element: Draft<LineElement>; poly: { points: Tuple[]; closed: boolean } } {
  const element = ctx.doc.elements[id];
  if (!element || element.kind !== 'line') throw new CommandError('rejected', 'Pick a line');
  const poly = worldPolyline(elementsOf(ctx), element as LineElement);
  if (!poly) throw new CommandError('rejected', 'This works on straight lines and polylines');
  return { element: element as Draft<LineElement>, poly };
}

/** Any drawn line as a world path. */
function curve(ctx: MutationContext, id: string): { element: Draft<LineElement>; path: Path } {
  const element = ctx.doc.elements[id];
  if (!element || element.kind !== 'line') throw new CommandError('rejected', 'Pick a line or curve');
  return { element: element as Draft<LineElement>, path: elementPath(elementsOf(ctx), element as LineElement) };
}

/** Writes result paths back: the first into the element, the others as copies of it. */
function writePaths(ctx: MutationContext, element: Draft<LineElement>, paths: Path[]): string[] {
  if (!paths.length) {
    removeSubtree(ctx.doc, element.id);
    return [];
  }
  const ids: string[] = [];
  paths.forEach((path, index) => {
    if (!path.segs.length) return;
    const target = index === 0 ? element : (copiesOf(ctx, [element.id])[0] as Draft<LineElement>);
    setElementPath(elementsOf(ctx), target, path);
    ids.push(target.id);
  });
  return ids;
}

/** Cutting edges near an element: the segments of the other lines, curves and boxes beside it. */
function cuttersFor(ctx: MutationContext, id: string): PSeg[] {
  const elements = elementsOf(ctx);
  const target = elements[id];
  if (!target) return [];
  const area = worldBounds(elements, target);
  const segs: PSeg[] = [];
  for (const element of Object.values(elements)) {
    if (element.id === id || !element.visible || element.kind === 'group' || element.kind === 'text') continue;
    if (element.meta?.['paper']) continue;
    const b = worldBounds(elements, element);
    if (b.x > area.x + area.width || b.x + b.width < area.x || b.y > area.y + area.height || b.y + b.height < area.y) continue;
    segs.push(...elementSegments(elements, element));
  }
  return segs;
}

export const trimLine = defineMutation({
  id: 'trim-line',
  label: 'Trim',
  description: 'Deletes the piece of a line, arc, circle or curve between the nearest crossings of other lines on either side of `at` (the clicked point, world mm).',
  group: 'arrange',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, at: PointInput }),
  run: (ctx, input) => {
    const { element, path } = curve(ctx, input.id);
    const cutters = cuttersFor(ctx, element.id);
    const pieces = trimPath(path, input.at, cutters);
    if (pieces.length === 1 && pieces[0]!.segs.length === path.segs.length && !path.closed && cuts(path, cutters).length === 0) throw new CommandError('rejected', 'Nothing crosses this line there');
    const ids = writePaths(ctx, element, pieces);
    setSelection(ctx, ids);
    return ids;
  },
});

export const cornerLines = defineMutation({
  id: 'corner-lines',
  label: 'Trim/extend to corner',
  description: 'Trims or extends two lines or arcs to the corner where they meet; `atA` / `atB` (world mm) pick the sides to keep.',
  aliases: ['trim to corner', 'TR'],
  group: 'arrange',
  palette: false,
  history: 'record',
  input: z.object({ a: IdSchema, atA: PointInput, b: IdSchema, atB: PointInput }),
  run: (ctx, input) => {
    if (input.a === input.b) throw new CommandError('rejected', 'Pick two different lines');
    const a = curve(ctx, input.a);
    const b = curve(ctx, input.b);
    if (a.path.closed || b.path.closed) throw new CommandError('rejected', 'Corners need two open lines or arcs');
    const result = cornerPaths(a.path, input.atA, b.path, input.atB);
    if (!result) throw new CommandError('rejected', 'Those two never meet (or only a Bézier would need extending)');
    writePaths(ctx, a.element, [result[0]]);
    writePaths(ctx, b.element, [result[1]]);
    setSelection(ctx, [a.element.id, b.element.id]);
    return [a.element.id, b.element.id];
  },
});

export const extendLine = defineMutation({
  id: 'extend-line',
  label: 'Extend',
  description: 'Extends (or trims) the end of a line or arc nearest `at` along itself to where it meets the boundary element.',
  group: 'arrange',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, at: PointInput, boundaryId: IdSchema }),
  run: (ctx, input) => {
    const { element, path } = curve(ctx, input.id);
    const boundary = ctx.doc.elements[input.boundaryId];
    if (!boundary) throw new CommandError('rejected', 'Pick a boundary first');
    const extended = extendPath(path, input.at, elementSegments(elementsOf(ctx), boundary as Element));
    if (!extended) throw new CommandError('rejected', 'That end never meets the boundary');
    writePaths(ctx, element, [extended]);
    return element.id;
  },
});

export const splitLine = defineMutation({
  id: 'split-line',
  label: 'Split',
  description: 'Splits a line, arc, circle or curve in two at a point (world mm); a closed shape opens there.',
  group: 'arrange',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, at: PointInput }),
  run: (ctx, input) => {
    const { element, path } = curve(ctx, input.id);
    const ids = writePaths(ctx, element, splitPath(path, input.at));
    setSelection(ctx, ids);
    return ids;
  },
});

export const filletLines = defineMutation({
  id: 'fillet-lines',
  label: 'Fillet',
  description: 'Rounds (`fillet`, radius) or bevels (`chamfer`, distance) the corner of a line or curve nearest `at`; with `otherId`, first joins two lines or curves that meet there.',
  group: 'arrange',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, at: PointInput, size: z.number().positive(), mode: z.enum(['fillet', 'chamfer']).default('fillet'), otherId: IdSchema.optional() }),
  run: (ctx, input) => {
    const first = curve(ctx, input.id);
    let path = first.path;
    if (input.otherId) {
      const other = curve(ctx, input.otherId);
      const joined = joinPaths([path, other.path]);
      if (joined.length !== 1) throw new CommandError('rejected', 'The two do not meet at an end');
      path = joined[0]!;
      removeSubtree(ctx.doc, other.element.id);
    }
    const rounded = filletPath(path, input.at, input.size, input.mode);
    if (!rounded) throw new CommandError('rejected', 'That corner is too tight (or too straight) for this size');
    writePaths(ctx, first.element, [rounded]);
    setSelection(ctx, [first.element.id]);
    return first.element.id;
  },
});

export const joinLines = defineMutation({
  id: 'join-lines',
  label: 'Join',
  description: 'Joins lines, arcs and curves that meet end to end into one path (closed when the chain returns to its start).',
  group: 'arrange',
  palette: false,
  history: 'record',
  input: z.object({ ids: Ids }).prefault({}),
  run: (ctx, input) => {
    const targets = requireTargets(ctx, input.ids, { unlocked: true, what: 'lines to join' }).filter((t) => t.kind === 'line');
    if (targets.length < 2) throw new CommandError('rejected', 'Select at least two lines');
    const items = targets.map((t) => curve(ctx, t.id));
    const joined = joinPaths(items.map((item) => item.path));
    // Each joined chain goes into the first of its members that is still unused.
    const kept: string[] = [];
    const used = new Set<string>();
    for (const chain of joined) {
      const host = items.find((item) => !used.has(item.element.id) && chain.segs.some((seg) => item.path.segs.some((own) => JSON.stringify(own) === JSON.stringify(seg) || JSON.stringify(own) === JSON.stringify(segReverse(seg)))));
      const target = host ?? items.find((item) => !used.has(item.element.id))!;
      used.add(target.element.id);
      setElementPath(elementsOf(ctx), target.element, chain);
      kept.push(target.element.id);
    }
    for (const item of items) if (!used.has(item.element.id)) removeSubtree(ctx.doc, item.element.id);
    setSelection(ctx, kept);
    return kept;
  },
});

export const explodeSelection = defineMutation({
  id: 'explode-selection',
  label: 'Explode',
  description: 'Breaks polylines, curves and rectangles into separate lines and arcs, and groups and arrays into their members.',
  group: 'arrange',
  palette: false,
  history: 'record',
  input: z.object({ ids: Ids }).prefault({}),
  when: (ctx) => ctx.hasSelection,
  run: (ctx, input) => {
    const targets = requireTargets(ctx, input.ids, { unlocked: true, what: 'elements to explode' });
    const released: string[] = [];
    for (const target of targets) {
      const elements = elementsOf(ctx);
      if (target.kind === 'group') {
        const m = localMatrix(target as Element);
        for (const child of childrenOf(elements, target.id)) {
          const draft = ctx.doc.elements[child.id]!;
          const origin = applyToPoint(m, { x: child.x, y: child.y });
          draft.x = origin.x;
          draft.y = origin.y;
          draft.rotation += target.rotation;
          draft.parentId = target.parentId;
          if (draft.meta?.['arrayCopy']) {
            const { arrayCopy: _copy, ...rest } = draft.meta;
            draft.meta = rest;
          }
          released.push(child.id);
        }
        delete ctx.doc.elements[target.id];
        continue;
      }
      if (target.kind !== 'rect' && target.kind !== 'line') continue;
      const segs = target.kind === 'rect' ? elementSegments(elements, target as Element) : elementPath(elements, target as LineElement).segs;
      if (segs.length < 2) continue;
      const style = { ...target.style, fill: null };
      for (const seg of segs) {
        const line: LineElement = {
          id: ctx.ids.next('el'),
          parentId: target.parentId,
          index: topIndex(elementsOf(ctx), target.parentId),
          x: 0,
          y: 0,
          rotation: 0,
          visible: true,
          locked: false,
          kind: 'line',
          points: [[0, 0], [1, 0]],
          closed: false,
          style,
        };
        ctx.doc.elements[line.id] = line;
        setElementPath(elementsOf(ctx), ctx.doc.elements[line.id] as Draft<LineElement>, { segs: [seg], closed: false });
        released.push(line.id);
      }
      removeSubtree(ctx.doc, target.id);
    }
    setSelection(ctx, released);
    return released;
  },
});

// ---- align / distribute / match ----------------------------------------------------------------

export const alignSelection = defineMutation({
  id: 'align-selection',
  label: 'Align',
  description: 'Aligns the selected elements to the first one\'s edge or centre (left, center, right, top, middle, bottom), or to `to` (a world coordinate).',
  group: 'arrange',
  palette: false,
  history: 'record',
  input: z.object({ ids: Ids, edge: z.enum(['left', 'center', 'right', 'top', 'middle', 'bottom']), to: z.number().finite().optional() }),
  run: (ctx, input) => {
    const targets = requireTargets(ctx, input.ids, { unlocked: true, what: 'elements to align' });
    const elements = elementsOf(ctx);
    const boxes = targets.map((t) => worldBounds(elements, t as Element));
    const key = (b: Rect) => ({ left: b.x, center: b.x + b.width / 2, right: b.x + b.width, top: b.y, middle: b.y + b.height / 2, bottom: b.y + b.height })[input.edge];
    const reference = input.to ?? key(boxes[0]!);
    const horizontal = input.edge === 'left' || input.edge === 'center' || input.edge === 'right';
    targets.forEach((target, i) => {
      const delta = reference - key(boxes[i]!);
      if (Math.abs(delta) > 1e-9) moveWorld(ctx, target, horizontal ? delta : 0, horizontal ? 0 : delta);
    });
    syncCamerasAmong(ctx.doc.elements, targets.map((t) => t.id));
    return targets.map((t) => t.id);
  },
});

export const distributeSelection = defineMutation({
  id: 'distribute-selection',
  label: 'Distribute',
  description: 'Spaces three or more selected elements evenly between the outermost ones, along `horizontal` or `vertical`.',
  group: 'arrange',
  palette: false,
  history: 'record',
  input: z.object({ ids: Ids, axis: z.enum(['horizontal', 'vertical']) }),
  run: (ctx, input) => {
    const targets = requireTargets(ctx, input.ids, { unlocked: true, what: 'elements to distribute' });
    if (targets.length < 3) throw new CommandError('rejected', 'Select at least three elements');
    const elements = elementsOf(ctx);
    const horizontal = input.axis === 'horizontal';
    const items = targets.map((t) => ({ t, b: worldBounds(elements, t as Element) })).sort((p, q) => (horizontal ? p.b.x - q.b.x : p.b.y - q.b.y));
    const size = (b: Rect) => (horizontal ? b.width : b.height);
    const start = (b: Rect) => (horizontal ? b.x : b.y);
    const first = items[0]!.b;
    const last = items.at(-1)!.b;
    const span = start(last) + size(last) - start(first);
    const gap = (span - items.reduce((sum, item) => sum + size(item.b), 0)) / (items.length - 1);
    let cursor = start(first);
    for (const item of items) {
      const delta = cursor - start(item.b);
      if (Math.abs(delta) > 1e-9) moveWorld(ctx, item.t, horizontal ? delta : 0, horizontal ? 0 : delta);
      cursor += size(item.b) + gap;
    }
    return items.map((item) => item.t.id);
  },
});

export const matchProperties = defineMutation({
  id: 'match-properties',
  label: 'Match properties',
  description: 'Copies the look of `sourceId` (stroke, fill, line weight, opacity; text size, colour and alignment) onto the other elements.',
  aliases: ['format painter', 'MA'],
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ sourceId: IdSchema, ids: z.array(IdSchema).min(1) }),
  run: (ctx, input) => {
    const source = ctx.doc.elements[input.sourceId];
    if (!source) throw new CommandError('rejected', 'The source element no longer exists');
    const changed: string[] = [];
    for (const id of input.ids) {
      const target = ctx.doc.elements[id];
      if (!target || id === source.id) continue;
      if ((target.kind === 'line' || target.kind === 'rect') && (source.kind === 'line' || source.kind === 'rect')) {
        target.style = { ...source.style, fill: target.kind === 'line' && !target.closed ? null : source.style.fill };
        changed.push(id);
      } else if (target.kind === 'text' && source.kind === 'text') {
        target.fontSize = source.fontSize;
        target.color = source.color;
        target.align = source.align;
        changed.push(id);
      } else if (target.kind === 'image' && source.kind === 'image') {
        target.opacity = source.opacity;
        changed.push(id);
      }
    }
    return changed;
  },
});

// ---- grips on plain lines ---------------------------------------------------------------------

/** A plain drawn line (not a wall, railing, measure or marker): its vertices are free to edit. */
export function isPlainLine(element: Element | undefined): element is LineElement {
  return element?.kind === 'line' && !element.meta?.['arch'] && !element.meta?.['renderLight'] && !element.meta?.['measure'] && !element.meta?.['cameraMarker'] && !element.meta?.['sectionLine'] && !element.meta?.['diagram'];
}

/** Moves the ends of other plain lines lying on `from` to `to` (connected lines stay connected). */
function carryJoinedEnds(ctx: MutationContext, exclude: string, moves: { from: Vec2; to: Vec2 }[]): void {
  const elements = elementsOf(ctx);
  for (const element of Object.values(elements)) {
    if (element.id === exclude || !isPlainLine(element) || element.parentId !== elements[exclude]?.parentId) continue;
    const poly = worldPolyline(elements, element);
    if (!poly) continue;
    let changed = false;
    const last = poly.points.length - 1;
    const points = poly.points.map((p, i) => {
      if (i !== 0 && i !== last) return p;
      const move = moves.find((m) => Math.hypot(m.from.x - p[0], m.from.y - p[1]) < 0.5);
      if (!move) return p;
      changed = true;
      return [move.to.x, move.to.y] as Tuple;
    });
    if (changed) setWorldPolyline(elementsOf(ctx), ctx.doc.elements[element.id] as Draft<LineElement>, points, poly.closed);
  }
}

export const moveLineVertex = defineMutation({
  id: 'move-line-vertex',
  label: 'Move point',
  description: 'Moves one vertex of a drawn line or polyline to a world point (mm); ends of other lines connected there follow unless `followJoined` is false.',
  group: 'transform',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, index: z.int().min(0), x: z.number().finite(), y: z.number().finite(), followJoined: z.boolean().default(true) }),
  run: (ctx, input) => {
    const { element, poly } = straightLine(ctx, input.id);
    if (input.index >= poly.points.length) throw new CommandError('invalid-input', 'That point no longer exists');
    const old = poly.points[input.index]!;
    const points = poly.points.map((p, i) => (i === input.index ? ([input.x, input.y] as Tuple) : p));
    setWorldPolyline(elementsOf(ctx), element, points, poly.closed);
    const isEnd = input.index === 0 || input.index === poly.points.length - 1;
    if (input.followJoined && isEnd) carryJoinedEnds(ctx, element.id, [{ from: { x: old[0], y: old[1] }, to: { x: input.x, y: input.y } }]);
    return element.id;
  },
});

export const moveLineSegment = defineMutation({
  id: 'move-line-segment',
  label: 'Move segment',
  description: 'Moves one straight segment of a line or polyline by dx, dy (mm), stretching its neighbours; connected line ends follow.',
  group: 'transform',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, segment: z.int().min(0), dx: z.number().finite(), dy: z.number().finite() }),
  run: (ctx, input) => {
    const { element, poly } = straightLine(ctx, input.id);
    const n = poly.points.length;
    const count = poly.closed ? n : n - 1;
    if (input.segment >= count) throw new CommandError('invalid-input', 'That segment no longer exists');
    const a = input.segment;
    const b = (input.segment + 1) % n;
    const moves: { from: Vec2; to: Vec2 }[] = [];
    const points = poly.points.map((p, i) => {
      if (i !== a && i !== b) return p;
      const moved: Tuple = [p[0] + input.dx, p[1] + input.dy];
      if (i === 0 || i === n - 1) moves.push({ from: { x: p[0], y: p[1] }, to: { x: moved[0], y: moved[1] } });
      return moved;
    });
    setWorldPolyline(elementsOf(ctx), element, points, poly.closed);
    carryJoinedEnds(ctx, element.id, moves);
    return element.id;
  },
});

export const movePathNode = defineMutation({
  id: 'move-path-node',
  label: 'Move curve point',
  description: 'Moves node `index` of a drawn curve (0 = start, i = end of segment i) to a world point (mm). Bézier handles at the node move with it; an arc beside it is redrawn through its middle.',
  group: 'transform',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, index: z.int().min(0), x: z.number().finite(), y: z.number().finite() }),
  run: (ctx, input) => {
    const { element, path } = curve(ctx, input.id);
    const n = path.segs.length;
    const nodes = path.closed ? n : n + 1;
    if (input.index >= nodes) throw new CommandError('invalid-input', 'That point no longer exists');
    const target = { x: input.x, y: input.y };
    const before = input.index > 0 ? input.index - 1 : path.closed ? n - 1 : -1;
    const after = input.index < n ? input.index : -1;
    const old = after >= 0 ? segStart(path.segs[after]!) : segEnd(path.segs[before]!);
    const dx = target.x - old.x;
    const dy = target.y - old.y;
    const moveEnd = (seg: PSeg, atEnd: boolean): PSeg => {
      if (seg.kind === 'line') return atEnd ? { ...seg, b: target } : { ...seg, a: target };
      if (seg.kind === 'cubic') return atEnd ? { ...seg, p2: { x: seg.p2.x + dx, y: seg.p2.y + dy }, p3: target } : { ...seg, p0: target, p1: { x: seg.p1.x + dx, y: seg.p1.y + dy } };
      // Arc: through its (unchanged) middle and the moved end.
      const start = atEnd ? segStart(seg) : target;
      const end = atEnd ? target : segEnd(seg);
      const mid = segPoint(seg, 0.5);
      const circle = circleFrom3(start, mid, end);
      if (!circle) return { kind: 'line', a: start, b: end };
      const a0 = Math.atan2(start.y - circle.center.y, start.x - circle.center.x);
      const am = Math.atan2(mid.y - circle.center.y, mid.x - circle.center.x);
      const a1 = Math.atan2(end.y - circle.center.y, end.x - circle.center.x);
      const norm = (v: number) => ((v % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const ccw = norm(am - a0) <= norm(a1 - a0);
      const sweep = ccw ? norm(a1 - a0) : -norm(a0 - a1);
      return { kind: 'arc', c: circle.center, r: circle.radius, start: a0, sweep };
    };
    const segs = [...path.segs];
    if (before >= 0) segs[before] = moveEnd(segs[before]!, true);
    if (after >= 0) segs[after] = moveEnd(segs[after]!, false);
    setElementPath(elementsOf(ctx), element, { segs, closed: path.closed });
    return element.id;
  },
});

export const setLineRadius = defineMutation({
  id: 'set-line-radius',
  label: 'Set radius',
  description: 'Changes the radius of an arc or circle segment of a line (mm), keeping its centre and angles.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, segment: z.int().min(0).default(0), radius: z.number().positive() }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    const segment = element?.kind === 'line' ? element.path?.segments[input.segment] : undefined;
    if (!element || element.kind !== 'line' || !element.path || segment?.kind !== 'arc') throw new CommandError('rejected', 'Pick an arc or circle');
    segment.radius = input.radius;
    // The segment's start point sits on the arc: move it (or the path start) with the radius.
    const start: Tuple = [segment.center[0] + Math.cos(segment.startAngle) * input.radius, segment.center[1] + Math.sin(segment.startAngle) * input.radius];
    if (input.segment === 0) element.path.start = start;
    element.points = sampleCurvePath(element.path as NonNullable<LineElement['path']>, 32);
    return element.id;
  },
});

export const setLineLength = defineMutation({
  id: 'set-line-length',
  label: 'Set length',
  description: 'Sets the length (mm) of a straight segment of a line, keeping its first point and direction; the rest of the polyline follows.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, segment: z.int().min(0).default(0), length: z.number().positive(), angle: z.number().finite().optional() }),
  run: (ctx, input) => {
    const { element, poly } = straightLine(ctx, input.id);
    const n = poly.points.length;
    if (input.segment >= (poly.closed ? n : n - 1)) throw new CommandError('invalid-input', 'That segment no longer exists');
    const a = poly.points[input.segment]!;
    const bIndex = (input.segment + 1) % n;
    const b = poly.points[bIndex]!;
    // Angle: counter-clockwise on screen (y down), like typed angles.
    const angle = input.angle !== undefined ? (-input.angle * Math.PI) / 180 : Math.atan2(b[1] - a[1], b[0] - a[0]);
    const target: Tuple = [a[0] + Math.cos(angle) * input.length, a[1] + Math.sin(angle) * input.length];
    const dx = target[0] - b[0];
    const dy = target[1] - b[1];
    // Points after the segment move with its end (an open polyline keeps its shape beyond).
    const points = poly.points.map((p, i) => (i >= bIndex && !(poly.closed && i === 0) ? ([p[0] + dx, p[1] + dy] as Tuple) : p));
    setWorldPolyline(elementsOf(ctx), element, points, poly.closed);
    return element.id;
  },
});

// ---- selection helpers ---------------------------------------------------------------------------

/** The category an element is filtered and matched by: its architectural type, else its kind. */
export function elementCategory(element: Element): string {
  const arch = element.meta?.['arch'];
  const type = arch && typeof arch === 'object' && !Array.isArray(arch) ? (arch as Record<string, unknown>)['type'] : undefined;
  if (typeof type === 'string') return type;
  if (element.meta?.['diagram']) return 'diagram';
  if (element.kind === 'line') return element.closed ? 'shape' : 'line';
  return element.kind;
}

/** A finer key for "similar": same category and the same look / definition. */
function similarityKey(element: Element): string {
  const category = elementCategory(element);
  if (element.kind === 'instance') return `${category}|${element.definitionId}`;
  if (element.kind === 'line' || element.kind === 'rect') return `${category}|${element.style.stroke}|${element.style.strokeWidth}|${element.style.fill}`;
  if (element.kind === 'text') return `${category}|${element.fontSize}|${element.color}`;
  return category;
}

export const selectSimilar = defineMutation({
  id: 'select-similar',
  label: 'Select similar',
  description: 'Selects every element like the selected ones (same category and look, or same asset) at the same level of the board or sheet (Revit\'s Select All Instances).',
  aliases: ['select all instances', 'SA'],
  group: 'select',
  shortcuts: ['S A'],
  history: 'none',
  input: z.object({ ids: Ids }).prefault({}),
  when: (ctx) => ctx.hasSelection,
  run: (ctx, input) => {
    const targets = requireTargets(ctx, input.ids, { what: 'an element' });
    const keys = new Set(targets.map((t) => similarityKey(t as Element)));
    const parents = new Set(targets.map((t) => t.parentId));
    const ids = Object.values(elementsOf(ctx)).filter((e) => e.visible && parents.has(e.parentId) && keys.has(similarityKey(e))).map((e) => e.id);
    setSelection(ctx, ids);
    return ids;
  },
});

export const filterSelection = defineMutation({
  id: 'filter-selection',
  label: 'Filter selection',
  description: 'Keeps only the selected elements of the given categories (e.g. wall, door, line, rect, text, instance).',
  group: 'select',
  palette: false,
  history: 'none',
  input: z.object({ keep: z.array(z.string()).min(1) }),
  when: (ctx) => ctx.hasSelection,
  run: (ctx, input) => {
    const keep = new Set(input.keep);
    const ids = ctx.ui.selection.filter((id) => {
      const element = ctx.doc.elements[id];
      return element && keep.has(elementCategory(element as Element));
    });
    setSelection(ctx, ids);
    return ids;
  },
});

export const repeatLastTool = defineMutation({
  id: 'repeat-last-tool',
  label: 'Repeat last tool',
  description: 'Picks up the last drawing or edit tool again (Enter, like Revit).',
  group: 'select',
  shortcuts: ['Enter'],
  history: 'none',
  input: z.void(),
  when: (ctx) => {
    if (ctx.ui.tool !== 'select' || !ctx.ui.lastTool || ctx.ui.editingTextId !== null) return false;
    // Enter on a single text element edits it instead.
    const only = ctx.selection.length === 1 ? ctx.doc.elements[ctx.selection[0]!] : undefined;
    return only?.kind !== 'text';
  },
  run: (ctx) => {
    if (ctx.ui.lastTool) ctx.ui.tool = ctx.ui.lastTool;
  },
});

/** Points the pure selection bounds helpers need (re-exported for the tools). */
export function selectionCentre(elements: ElementTable, ids: readonly string[]): Vec2 | null {
  const bounds = boundsOfIds(elements, ids);
  return bounds ? rectCenter(bounds) : null;
}

export const draftingCommands = [
  setDrafting,
  toggleObjectSnap,
  copySelection,
  mirrorSelection,
  scaleSelection,
  rotateCopySelection,
  createArray,
  setArray,
  offsetElement,
  trimLine,
  cornerLines,
  extendLine,
  splitLine,
  filletLines,
  joinLines,
  explodeSelection,
  alignSelection,
  distributeSelection,
  matchProperties,
  moveLineVertex,
  moveLineSegment,
  movePathNode,
  setLineRadius,
  setLineLength,
  selectSimilar,
  filterSelection,
  repeatLastTool,
];

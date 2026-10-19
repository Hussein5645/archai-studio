import { current, type Draft } from 'immer';
import { moveNestedLayers } from '@/layers/movement';
import { z } from 'zod';
import { IdSchema, isAncestor, isEffectivelyLocked, type Element, type ElementTable, type JsonValue } from '@/document';
import {
  applyToPoint,
  applyToVector,
  boundsOfIds,
  boundsOfPoints,
  DEG_TO_RAD,
  invert,
  localBounds,
  parentWorldMatrix,
  rectCenter,
  rotate,
  sub,
  tupleToVec,
  type Rect,
  type Vec2,
} from '@/geometry';
import { archOf, archTypeOf, hostedBy, hostOf, resizeRuleFor } from '@/assets/arch-meta';
import { isWall, resolveWallOpening } from '@/interaction/wallSnap';
import { CommandError, defineMutation, type MutationContext } from '../contract';
import { requireTargets, scaleElementLocal, syncCamerasAmong, targetIds } from '../helpers';
import { assertInstanceSizable, resizeWindow, syncParametersFromSize } from './system';
import { joinWallBody, joinWallEnd, unjoinWallEnd } from './wallJoints';
import { locationOf, mapAnchorWorld, setMapAnchorWorld } from '@/analysis/model';

const RectInput = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().min(0),
  height: z.number().min(0),
});

const Ids = z.array(IdSchema).optional();

/** Moves an element by a world-space delta, respecting rotated ancestors. */
function translateElement(elements: ElementTable, element: Draft<Element>, delta: Vec2): void {
  const parentMatrix = parentWorldMatrix(elements, element as Element);
  const local = applyToVector(invert(parentMatrix), delta);
  element.x += local.x;
  element.y += local.y;
}

/** World-space position of the element's local origin. */
function originInWorld(elements: ElementTable, element: Element): Vec2 {
  return applyToPoint(parentWorldMatrix(elements, element), { x: element.x, y: element.y });
}

function setOriginInWorld(elements: ElementTable, element: Draft<Element>, world: Vec2): void {
  const local = applyToPoint(invert(parentWorldMatrix(elements, element as Element)), world);
  element.x = local.x;
  element.y = local.y;
}

/** Width/height of the element's content in local space (lines: the raw point bounds). */
function contentSize(elements: ElementTable, element: Element): { width: number; height: number } {
  if (element.kind === 'line') {
    const b = boundsOfPoints(element.points.map(tupleToVec));
    return { width: b.width, height: b.height };
  }
  const b = localBounds(elements, element);
  return { width: b.width, height: b.height };
}

function worldRotationOf(elements: ElementTable, element: Element): number {
  const m = parentWorldMatrix(elements, element);
  return Math.atan2(m[1], m[0]) / DEG_TO_RAD + element.rotation;
}

/** Fixed-size system elements (doors, stairs, walls, railings) only change through parameters. */
function fixedSizeReason(element: Element): string | null {
  if (resizeRuleFor(element) !== 'none') return null;
  const type = archTypeOf(element);
  if (type === 'door') return 'Doors keep the size defined by their configuration';
  if (type === 'stair') return 'Stairs are rebuilt from their parameters; edit them in Configure';
  return 'Walls and railings are edited through their endpoints and parameters';
}

/** Effective local scale factors for a world-space non-uniform scale of a rotated element. */
function projectedScale(worldRotation: number, sx: number, sy: number): { sx: number; sy: number } {
  const c = Math.cos(worldRotation * DEG_TO_RAD);
  const s = Math.sin(worldRotation * DEG_TO_RAD);
  return {
    sx: Math.hypot(sx * c, sy * s),
    sy: Math.hypot(sx * s, sy * c),
  };
}

function moveTargets(ctx: MutationContext, ids: string[] | undefined, dx: number, dy: number): string[] {
  const targets = requireTargets(ctx, ids, { unlocked: true });
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new CommandError('invalid-input', 'Delta must be finite');
  const attachedMeasure = targets.find((target) => target.parentId !== null && target.meta?.['measure']);
  if (attachedMeasure) {
    throw new CommandError('rejected', 'Attached measurements move with their parent layer');
  }
  const elements = ctx.doc.elements as ElementTable;
  const moved = new Set(targets.map((t) => t.id));
  for (const element of targets) translateElement(elements, element, { x: dx, y: dy });
  // Hosted elements (doors and windows on a wall, anything hosted from Layers) ride along.
  for (const id of hostedBy(elements, [...moved])) {
    const hosted = ctx.doc.elements[id];
    if (!hosted || moved.has(id) || hosted.locked) continue;
    const hostId = hostOf(hosted);
    if (hostId && locationOf(elements[hostId])) continue;
    // Skip when an ancestor group already moved.
    if (targets.some((target) => target.kind === 'group' && isAncestor(elements, target.id, id))) continue;
    translateElement(elements, hosted, { x: dx, y: dy });
    moved.add(id);
  }
  // For any moved opening element, refresh its meta.arch.opening to match its position on its host wall
  for (const id of moved) {
    const el = ctx.doc.elements[id];
    if (!el) continue;
    const type = archTypeOf(el);
    if (type !== 'door' && type !== 'window' && type !== 'facade-element') continue;
    const hostId = hostOf(el);
    if (!hostId || !ctx.doc.elements[hostId]) continue;
    const wall = ctx.doc.elements[hostId];
    if (!wall || !isWall(wall)) continue;
    const resolved = resolveWallOpening(wall, el, elements);
    const arch = archOf(el);
    if (arch) {
      if (resolved) {
        el.meta = { ...el.meta, arch: { ...arch, opening: resolved as unknown as JsonValue } };
      } else {
        const nextArch = { ...arch };
        delete nextArch['opening'];
        el.meta = { ...el.meta, arch: nextArch as unknown as JsonValue };
      }
    }
  }
  syncCamerasAmong(elements, moved);
  // Rebuild contacts after all selected walls move, without pulling an end toward a
  // merely nearby target (that would rotate an otherwise grid-aligned wall).
  const walls = [...moved].filter((id) => ['wall', 'curtain-wall'].includes(archTypeOf(elements[id]) ?? ''));
  for (const id of walls) for (const end of ['start', 'end', 'body'] as const) unjoinWallEnd(ctx, id, end);
  for (const id of walls) {
    joinWallEnd(ctx, id, 'start', 2);
    joinWallEnd(ctx, id, 'end', 2);
    joinWallBody(ctx, id);
  }
  return targets.map((t) => t.id);
}

export const moveSelection = defineMutation({
  id: 'move-selection',
  label: 'Move',
  description: 'Moves the selected elements by a world-space delta in millimetres.',
  group: 'transform',
  palette: false,
  history: 'record',
  input: z.object({ ids: Ids, dx: z.number().finite(), dy: z.number().finite() }),
  when: (ctx) => ctx.hasSelection,
  run: (ctx, input) => moveTargets(ctx, input.ids, input.dx, input.dy),
});

function nudge(id: string, label: string, shortcut: string, dx: number, dy: number, step: number) {
  return defineMutation({
    id,
    label,
    group: 'transform',
    palette: false,
    shortcuts: [shortcut],
    history: 'record',
    input: z.void(),
    when: (ctx) => ctx.hasSelection && ctx.ui.editingTextId === null,
    run: (ctx) => moveTargets(ctx, undefined, dx * step, dy * step),
  });
}

const NUDGE = 10;
const BIG_NUDGE = 100;
export const nudgeCommands = [
  nudge('nudge-left', 'Nudge left', 'ArrowLeft', -1, 0, NUDGE),
  nudge('nudge-right', 'Nudge right', 'ArrowRight', 1, 0, NUDGE),
  nudge('nudge-up', 'Nudge up', 'ArrowUp', 0, -1, NUDGE),
  nudge('nudge-down', 'Nudge down', 'ArrowDown', 0, 1, NUDGE),
  nudge('nudge-left-big', 'Nudge left (10×)', 'Shift+ArrowLeft', -1, 0, BIG_NUDGE),
  nudge('nudge-right-big', 'Nudge right (10×)', 'Shift+ArrowRight', 1, 0, BIG_NUDGE),
  nudge('nudge-up-big', 'Nudge up (10×)', 'Shift+ArrowUp', 0, -1, BIG_NUDGE),
  nudge('nudge-down-big', 'Nudge down (10×)', 'Shift+ArrowDown', 0, 1, BIG_NUDGE),
];

export const setTransform = defineMutation({
  id: 'set-transform',
  label: 'Set position and size',
  description: 'Sets position (parent space), size and rotation (about the centre) of one element.',
  group: 'transform',
  palette: false,
  history: 'record',
  input: z.object({
    id: IdSchema,
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    width: z.number().min(0).optional(),
    height: z.number().min(0).optional(),
    rotation: z.number().finite().optional(),
  }),
  run: (ctx, input) => {
    const before = current(ctx.doc.elements);
    const elements = ctx.doc.elements as ElementTable;
    const element = ctx.doc.elements[input.id];
    if (!element) throw new CommandError('rejected', `Unknown element ${input.id}`);
    if (isEffectivelyLocked(elements, input.id)) throw new CommandError('rejected', 'The element is locked');

    if (input.x !== undefined) element.x = input.x;
    if (input.y !== undefined) element.y = input.y;

    if (input.width !== undefined || input.height !== undefined) {
      const reason = fixedSizeReason(element as Element);
      if (reason) throw new CommandError('rejected', reason);
      if ('width' in element && 'height' in element) {
        assertInstanceSizable(element as Element, input.width !== undefined && Math.abs(input.width - element.width) > 1e-6, input.height !== undefined && Math.abs(input.height - element.height) > 1e-6);
      }
      if (resizeRuleFor(element as Element) === 'width') {
        if (input.height !== undefined && input.width === undefined) throw new CommandError('rejected', 'Windows follow the thickness of their wall');
        if (input.width !== undefined) resizeWindow.run(ctx, { id: element.id, width: input.width, anchor: 'centre' });
      } else if (element.kind === 'instance' && resizeRuleFor(element as Element) === 'uniform') {
        // Assets keep their proportions: whichever side was given drives the other.
        const factor = input.width !== undefined && element.width > 0 ? input.width / element.width : input.height !== undefined && element.height > 0 ? input.height / element.height : 1;
        element.width *= factor;
        element.height *= factor;
      } else if (element.kind === 'rect' || element.kind === 'image' || element.kind === 'instance' || element.kind === 'text') {
        if (input.width !== undefined) element.width = input.width;
        if (input.height !== undefined && element.kind !== 'text') element.height = input.height;
        if (element.kind === 'text') scaleElementLocal(ctx.doc, element, 1, 1, ctx.measurer);
        syncParametersFromSize(element);
      } else {
        const size = contentSize(elements, element as Element);
        const sx = input.width !== undefined && size.width > 0 ? input.width / size.width : 1;
        const sy = input.height !== undefined && size.height > 0 ? input.height / size.height : 1;
        scaleElementLocal(ctx.doc, element, sx, sy, ctx.measurer);
      }
    }

    if (input.rotation !== undefined && input.rotation !== element.rotation) {
      // Rotate about the centre: keep the centre's parent-space position fixed.
      const bounds = localBounds(elements, element as Element);
      const center = rectCenter(bounds);
      const before = rotate(center, element.rotation);
      const after = rotate(center, input.rotation);
      element.x += before.x - after.x;
      element.y += before.y - after.y;
      element.rotation = input.rotation;
    }
    moveNestedLayers(before, elements);
  },
});

export const resizeSelection = defineMutation({
  id: 'resize-selection',
  label: 'Resize',
  description: 'Scales the selection so that its world bounds move from `from` to `to`.',
  group: 'transform',
  palette: false,
  history: 'record',
  input: z.object({ ids: Ids, from: RectInput, to: RectInput }),
  when: (ctx) => ctx.hasSelection,
  run: (ctx, input) => {
    const targets = requireTargets(ctx, input.ids, { unlocked: true });
    for (const target of targets) {
      const reason = fixedSizeReason(target as Element);
      if (reason) throw new CommandError('rejected', reason);
      if (resizeRuleFor(target as Element) === 'width') throw new CommandError('rejected', 'Windows only resize along their wall; drag a jamb handle');
    }
    const elements = ctx.doc.elements as ElementTable;
    const sx = input.from.width > 0 ? input.to.width / input.from.width : 1;
    const sy = input.from.height > 0 ? input.to.height / input.from.height : 1;
    if (Math.abs(sx - sy) > 1e-6 && targets.some((target) => resizeRuleFor(target as Element) === 'uniform')) {
      throw new CommandError('rejected', 'Assets only scale uniformly; drag a corner handle');
    }
    for (const target of targets) {
      const local = projectedScale(worldRotationOf(elements, target as Element), sx, sy);
      assertInstanceSizable(target as Element, Math.abs(local.sx - 1) > 1e-6, Math.abs(local.sy - 1) > 1e-6);
    }
    for (const element of targets) {
      // A 1:1 map rect is a window onto the ground: resizing reveals more, never stretches it.
      const mapAnchor = mapAnchorWorld(elements, element as Element);
      const origin = originInWorld(elements, element as Element);
      setOriginInWorld(elements, element, {
        x: input.to.x + (origin.x - input.from.x) * sx,
        y: input.to.y + (origin.y - input.from.y) * sy,
      });
      const worldRotation = worldRotationOf(elements, element as Element);
      const local = projectedScale(worldRotation, sx, sy);
      scaleElementLocal(ctx.doc, element, local.sx, local.sy, ctx.measurer);
      syncParametersFromSize(element);
      if (mapAnchor) setMapAnchorWorld(elements, element as Element, mapAnchor);
    }
    return targets.map((t) => t.id);
  },
});

export const rotateSelection = defineMutation({
  id: 'rotate-selection',
  label: 'Rotate',
  description: 'Rotates the selection by `degrees` about a pivot (default: the selection centre).',
  group: 'transform',
  palette: false,
  history: 'record',
  input: z.object({
    ids: Ids,
    degrees: z.number().finite(),
    pivot: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
  }),
  when: (ctx) => ctx.hasSelection,
  run: (ctx, input) => {
    const targets = requireTargets(ctx, input.ids, { unlocked: true });
    const elements = ctx.doc.elements as ElementTable;
    const bounds: Rect | null = boundsOfIds(elements, targets.map((t) => t.id));
    const pivot = input.pivot ?? (bounds ? rectCenter(bounds) : { x: 0, y: 0 });
    for (const element of targets) {
      const origin = originInWorld(elements, element as Element);
      const rotated = rotate(sub(origin, pivot), input.degrees);
      setOriginInWorld(elements, element, { x: pivot.x + rotated.x, y: pivot.y + rotated.y });
      element.rotation += input.degrees;
    }
    syncCamerasAmong(elements, targets.map((t) => t.id));
    return targets.map((t) => t.id);
  },
});

function rotateBy(id: string, label: string, shortcut: string, degrees: number) {
  return defineMutation({
    id,
    label,
    group: 'transform',
    shortcuts: [shortcut],
    history: 'record',
    input: z.void(),
    when: (ctx) => ctx.hasSelection && ctx.ui.editingTextId === null,
    run: (ctx) => {
      const ids = targetIds(ctx, undefined);
      rotateSelection.run(ctx, { ids, degrees });
    },
  });
}

export const rotateCw = rotateBy('rotate-cw', 'Rotate 90° clockwise', 'Mod+R', 90);
export const rotateCcw = rotateBy('rotate-ccw', 'Rotate 90° counter-clockwise', 'Mod+Shift+R', -90);

export const transformCommands = [
  moveSelection,
  ...nudgeCommands,
  setTransform,
  resizeSelection,
  rotateSelection,
  rotateCw,
  rotateCcw,
];

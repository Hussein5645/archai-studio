import { z } from 'zod';
import {
  BlobSchema,
  childrenOf,
  DefinitionSchema,
  descendantsOf,
  ElementSchema,
  IdSchema,
  indexBetween,
  indexesBetween,
  isEffectivelyLocked,
  type ArchaiDocument,
  type Element,
  type ElementTable,
  type GroupElement,
} from '@/document';
import { applyToPoint, invert, localBounds, localMatrix, multiply, transformRect, unionRects, worldMatrix } from '@/geometry';
import { CommandError, defineMutation, type MutationContext } from '../contract';
import { cloneSubtrees, portalsOfMarker, removeSubtree, requireTargets, setSelection, snapshot, targetIds, topIndex } from '../helpers';
import { syncRailingWithStair } from './system';
import { isLevelLayerEligible } from '@/layers/hierarchy';

const Ids = z.array(IdSchema).optional();

export const reparentElement = defineMutation({
  id: 'reparent-element',
  label: 'Move element to layer container',
  description: 'Moves an element into another layer, or back to the board root, without changing its world position.',
  group: 'arrange',
  palette: false,
  history: 'record',
  input: z.object({
    id: IdSchema,
    parentId: IdSchema.nullable(),
    targetId: IdSchema.optional(),
    placement: z.enum(['front', 'behind']).default('front'),
  }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    if (!element || isEffectivelyLocked(ctx.doc.elements, input.id)) throw new CommandError('rejected', 'That element cannot be moved');
    if (input.parentId === element.id || (input.parentId && descendantsOf(ctx.doc.elements, element.id).some((child) => child.id === input.parentId))) {
      throw new CommandError('rejected', 'An element cannot be moved inside itself');
    }
    const parent = input.parentId ? ctx.doc.elements[input.parentId] : null;
    if (input.parentId && !parent) throw new CommandError('rejected', 'The parent layer no longer exists');
    const target = input.targetId ? ctx.doc.elements[input.targetId] : null;
    if (input.targetId && !target) throw new CommandError('rejected', 'The layer target no longer exists');
    if (target && (target.id === element.id || target.parentId !== input.parentId)) throw new CommandError('rejected', 'The layer target is not a sibling in that container');
    if (parent && parent.meta?.['level'] && isLevelLayerEligible(element)) {
      const levelMeta = parent.meta['level'] as { elevation?: number };
      const elevation = typeof levelMeta.elevation === 'number' && Number.isFinite(levelMeta.elevation) ? levelMeta.elevation : 0;
      const currentElevation = typeof element.meta?.['instanceElevation'] === 'number' ? element.meta['instanceElevation'] : elevation;
      const meta = snapshot(element.meta ?? {});
      meta['levelConstraint'] = { levelId: parent.id, offset: currentElevation - elevation };
      meta['instanceElevation'] = currentElevation;
      if (meta['host']) delete meta['host'];
      element.meta = meta;
      if (element.parentId) {
        const world = worldMatrix(ctx.doc.elements, element);
        element.x = world[4];
        element.y = world[5];
        element.rotation = (Math.atan2(world[1], world[0]) * 180) / Math.PI;
      }
      element.parentId = null;
      return element.id;
    }
    const world = worldMatrix(ctx.doc.elements, element);
    const parentWorld = parent ? worldMatrix(ctx.doc.elements, parent) : ([1, 0, 0, 1, 0, 0] as const);
    const local = multiply(invert(parentWorld), world);
    const siblings = [...childrenOf(ctx.doc.elements as ElementTable, input.parentId)].filter((sibling) => sibling.id !== element.id);
    let nextIndex = topIndex(ctx.doc.elements as ElementTable, input.parentId);
    if (target) {
      const at = siblings.findIndex((sibling) => sibling.id === target.id);
      if (at < 0) throw new CommandError('rejected', 'The layer target no longer exists');
      nextIndex = input.placement === 'front'
        ? indexBetween(target.index, siblings[at + 1]?.index ?? null)
        : indexBetween(siblings[at - 1]?.index ?? null, target.index);
    }
    element.parentId = input.parentId;
    element.index = nextIndex;
    element.x = local[4];
    element.y = local[5];
    element.rotation = (Math.atan2(local[1], local[0]) * 180) / Math.PI;
    if (element.meta?.['host']) {
      const meta = snapshot(element.meta);
      delete meta['host'];
      element.meta = meta;
    }
    if (input.parentId === null && element.meta?.['levelConstraint']) {
      const meta = snapshot(element.meta);
      delete meta['levelConstraint'];
      element.meta = meta;
    }
    if (parent && (parent.meta?.['arch'] as { type?: string } | undefined)?.type === 'stair' && (element.meta?.['arch'] as { type?: string } | undefined)?.type === 'railing') {
      syncRailingWithStair(ctx, element, parent);
    }
    return element.id;
  },
});

export const duplicateSelection = defineMutation({
  id: 'duplicate-selection',
  label: 'Duplicate',
  aliases: ['clone', 'copy in place'],
  group: 'arrange',
  shortcuts: ['Mod+D'],
  history: 'record',
  input: z.object({ ids: Ids, offset: z.object({ x: z.number(), y: z.number() }).default({ x: 200, y: 200 }) }).prefault({}),
  when: (ctx) => ctx.hasSelection,
  run: (ctx, input) => {
    const targets = requireTargets(ctx, input.ids, { unlocked: true });
    const elements = ctx.doc.elements as ElementTable;
    const clones = cloneSubtrees(elements, targets.map((t) => t.id), ctx.ids, { offset: input.offset });
    for (const clone of clones.all) {
      if (clones.roots.includes(clone)) clone.index = topIndex(ctx.doc.elements as ElementTable, clone.parentId);
      ctx.doc.elements[clone.id] = clone;
    }
    setSelection(ctx, clones.roots.map((r) => r.id));
    return clones.roots.map((r) => r.id);
  },
});

export const deleteSelection = defineMutation({
  id: 'delete-selection',
  label: 'Delete',
  aliases: ['remove'],
  group: 'arrange',
  shortcuts: ['Delete', 'Backspace'],
  history: 'record',
  input: z.object({ ids: Ids }).prefault({}),
  // While the graph editor is open, Delete/Backspace belongs to its selected
  // node. The graph origin commonly remains selected on the board, so allowing
  // the board delete command here would remove the entire component as well.
  // Inside a sheet view frame, Delete hides picked elements instead (see sheets/SheetUI).
  when: (ctx) => ctx.hasSelection && ctx.ui.editingTextId === null && !ctx.ui.parametricEditor.open && !ctx.ui.sheet?.viewEdit,
  run: (ctx, input) => {
    const targets = requireTargets(ctx, input.ids, { unlocked: true });
    const targetIdSet = new Set(targets.map((t) => t.id));

    // Dependent markers (section lines, camera markers) whose parent view is not also being deleted
    const dependentWithoutParent = targets.filter((target) => {
      if (!target.meta?.['sectionLine'] && !target.meta?.['cameraMarker']) return false;
      const portals = portalsOfMarker(ctx.doc.elements, target.id);
      return portals.some((portal) => !targetIdSet.has(portal.id));
    });

    if (dependentWithoutParent.length === targets.length) {
      throw new CommandError('rejected', 'Section lines and cameras cannot be deleted directly; delete their view portal instead');
    }

    const validTargets = targets.filter((t) => !dependentWithoutParent.includes(t));
    const deletedLevels = new Set(validTargets.filter((target) => Boolean(target.meta?.['level'])).map((target) => target.id));
    if (deletedLevels.size > 0) {
      for (const element of Object.values(ctx.doc.elements)) {
        if (element.parentId && deletedLevels.has(element.parentId)) {
          element.parentId = null;
        }
        const constraint = element.meta?.['levelConstraint'];
        if (!constraint || typeof constraint !== 'object' || Array.isArray(constraint) || typeof constraint['levelId'] !== 'string' || !deletedLevels.has(constraint['levelId'])) continue;
        const meta = { ...(element.meta ?? {}) };
        delete meta['levelConstraint'];
        element.meta = meta;
      }
    }
    const removed: string[] = [];
    for (const target of validTargets) {
      if (ctx.doc.elements[target.id]) {
        removed.push(...removeSubtree(ctx.doc, target.id));
      }
    }
    ctx.ui.selection = [];
    return removed;
  },
});

export const groupSelection = defineMutation({
  id: 'group-selection',
  label: 'Group',
  group: 'arrange',
  shortcuts: ['Mod+G'],
  history: 'record',
  input: z.object({ ids: Ids, name: z.string().max(200).optional() }).prefault({}),
  when: (ctx) => ctx.selection.length > 0,
  run: (ctx, input) => {
    const targets = requireTargets(ctx, input.ids, { unlocked: true, what: 'elements to group' });
    const parentId = targets[0]!.parentId;
    if (targets.some((t) => t.parentId !== parentId)) {
      throw new CommandError('rejected', 'Elements must share the same parent to be grouped');
    }
    const elements = ctx.doc.elements as ElementTable;
    // The group takes the z-position of the front-most member and its origin at the members' bounds.
    const frontIndex = targets.map((t) => t.index).sort().at(-1)!;
    const bounds = unionRects(
      targets.map((t) => transformRect(localMatrix(t as Element), localBounds(elements, t as Element))),
    ) ?? { x: 0, y: 0, width: 0, height: 0 };
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
      ...(input.name ? { name: input.name } : {}),
    };
    for (const target of targets) {
      target.parentId = group.id;
      target.x -= bounds.x;
      target.y -= bounds.y;
    }
    ctx.doc.elements[group.id] = group;
    setSelection(ctx, [group.id]);
    return group.id;
  },
});

export const ungroupSelection = defineMutation({
  id: 'ungroup-selection',
  label: 'Ungroup',
  group: 'arrange',
  shortcuts: ['Mod+Shift+G'],
  history: 'record',
  input: z.object({ ids: Ids }).prefault({}),
  when: (ctx) => ctx.selection.some((id) => ctx.doc.elements[id]?.kind === 'group'),
  run: (ctx, input) => {
    const targets = requireTargets(ctx, input.ids, { unlocked: true }).filter((t) => t.kind === 'group');
    if (targets.length === 0) throw new CommandError('rejected', 'Select a group to ungroup');
    const released: string[] = [];
    for (const group of targets) {
      const elements = ctx.doc.elements as ElementTable;
      const siblings = childrenOf(elements, group.parentId);
      const position = siblings.findIndex((s) => s.id === group.id);
      const before = siblings[position - 1]?.index ?? null;
      const after = siblings[position + 1]?.index ?? null;
      const children = childrenOf(elements, group.id);
      const indexes = indexesBetween(before, after, children.length);
      const m = localMatrix(group as Element);
      children.forEach((child, i) => {
        const draft = ctx.doc.elements[child.id]!;
        const origin = applyToPoint(m, { x: child.x, y: child.y });
        draft.x = origin.x;
        draft.y = origin.y;
        draft.rotation += group.rotation;
        draft.parentId = group.parentId;
        draft.index = indexes[i]!;
        released.push(child.id);
      });
      delete ctx.doc.elements[group.id];
    }
    setSelection(ctx, released);
    return released;
  },
});

const ReorderTarget = z.enum(['forward', 'backward', 'front', 'back']);

function reorder(ctx: MutationContext, ids: string[] | undefined, to: z.infer<typeof ReorderTarget>): string[] {
  const targets = requireTargets(ctx, ids, { unlocked: true });
  const selected = new Set(targets.map((t) => t.id));
  const byParent = new Map<string | null, string[]>();
  for (const t of targets) byParent.set(t.parentId, [...(byParent.get(t.parentId) ?? []), t.id]);

  for (const parentId of byParent.keys()) {
    const elements = ctx.doc.elements as ElementTable;
    const siblings = [...childrenOf(elements, parentId)];
    const chosen = siblings.filter((s) => selected.has(s.id));
    const others = siblings.filter((s) => !selected.has(s.id));
    if (chosen.length === 0 || others.length === 0) continue;

    if (to === 'front' || to === 'back') {
      const anchorBefore = to === 'front' ? others[others.length - 1]!.index : null;
      const anchorAfter = to === 'front' ? null : others[0]!.index;
      const indexes = indexesBetween(anchorBefore, anchorAfter, chosen.length);
      chosen.forEach((c, i) => {
        ctx.doc.elements[c.id]!.index = indexes[i]!;
      });
      continue;
    }

    // One step: move each chosen element past the nearest unselected neighbour.
    const order = to === 'forward' ? [...chosen].reverse() : chosen;
    for (const c of order) {
      const current = [...childrenOf(ctx.doc.elements as ElementTable, parentId)];
      const at = current.findIndex((s) => s.id === c.id);
      const step = to === 'forward' ? 1 : -1;
      let neighbour = at + step;
      while (neighbour >= 0 && neighbour < current.length && selected.has(current[neighbour]!.id)) neighbour += step;
      if (neighbour < 0 || neighbour >= current.length) continue;
      const beyond = neighbour + step;
      const a = to === 'forward' ? current[neighbour]!.index : (current[beyond]?.index ?? null);
      const b = to === 'forward' ? (current[beyond]?.index ?? null) : current[neighbour]!.index;
      ctx.doc.elements[c.id]!.index = indexesBetween(a, b, 1)[0]!;
    }
  }
  return targets.map((t) => t.id);
}

export const reorderSelection = defineMutation({
  id: 'reorder-selection',
  label: 'Reorder',
  description: 'Moves the selection forward/backward one step or to the front/back.',
  group: 'arrange',
  palette: false,
  history: 'record',
  input: z.object({ ids: Ids, to: ReorderTarget }),
  when: (ctx) => ctx.hasSelection,
  run: (ctx, input) => reorder(ctx, input.ids, input.to),
});

function reorderShortcut(id: string, label: string, shortcut: string, to: z.infer<typeof ReorderTarget>) {
  return defineMutation({
    id,
    label,
    group: 'arrange',
    shortcuts: [shortcut],
    history: 'record',
    input: z.void(),
    when: (ctx) => ctx.hasSelection,
    run: (ctx) => reorder(ctx, undefined, to),
  });
}

export const bringForward = reorderShortcut('bring-forward', 'Bring forward', 'Mod+BracketRight', 'forward');
export const sendBackward = reorderShortcut('send-backward', 'Send backward', 'Mod+BracketLeft', 'backward');
export const bringToFront = reorderShortcut('bring-to-front', 'Bring to front', 'Mod+Shift+BracketRight', 'front');
export const sendToBack = reorderShortcut('send-to-back', 'Send to back', 'Mod+Shift+BracketLeft', 'back');

function setFlag(ctx: MutationContext, ids: string[] | undefined, flag: 'locked' | 'visible', value: boolean): string[] {
  const targets = requireTargets(ctx, ids);
  for (const t of targets) t[flag] = value;
  return targets.map((t) => t.id);
}

export const lockSelection = defineMutation({
  id: 'lock-selection',
  label: 'Pin',
  aliases: ['lock'],
  group: 'arrange',
  history: 'record',
  input: z.object({ ids: Ids }).prefault({}),
  when: (ctx) => ctx.selection.some((id) => !ctx.doc.elements[id]?.locked),
  run: (ctx, input) => setFlag(ctx, input.ids, 'locked', true),
});

export const unlockSelection = defineMutation({
  id: 'unlock-selection',
  label: 'Unpin',
  aliases: ['unlock'],
  group: 'arrange',
  history: 'record',
  input: z.object({ ids: Ids }).prefault({}),
  when: (ctx) => ctx.selection.some((id) => ctx.doc.elements[id]?.locked),
  run: (ctx, input) => setFlag(ctx, input.ids, 'locked', false),
});

export const toggleLock = defineMutation({
  id: 'toggle-lock',
  label: 'Pin / unpin',
  aliases: ['lock', 'unlock'],
  group: 'arrange',
  palette: false,
  shortcuts: ['Mod+Shift+L'],
  history: 'record',
  input: z.void(),
  when: (ctx) => ctx.hasSelection,
  run: (ctx) => {
    const ids = targetIds(ctx, undefined);
    const anyUnlocked = ids.some((id) => !ctx.doc.elements[id]!.locked);
    return setFlag(ctx, ids, 'locked', anyUnlocked);
  },
});

export const hideSelection = defineMutation({
  id: 'hide-selection',
  label: 'Hide',
  group: 'arrange',
  history: 'record',
  input: z.object({ ids: Ids }).prefault({}),
  when: (ctx) => ctx.selection.some((id) => ctx.doc.elements[id]?.visible),
  run: (ctx, input) => setFlag(ctx, input.ids, 'visible', false),
});

export const showSelection = defineMutation({
  id: 'show-selection',
  label: 'Show',
  group: 'arrange',
  history: 'record',
  input: z.object({ ids: Ids }).prefault({}),
  when: (ctx) => ctx.selection.some((id) => ctx.doc.elements[id]?.visible === false),
  run: (ctx, input) => setFlag(ctx, input.ids, 'visible', true),
});

export const toggleVisibility = defineMutation({
  id: 'toggle-visibility',
  label: 'Show / hide',
  group: 'arrange',
  palette: false,
  shortcuts: ['Mod+Shift+H'],
  history: 'record',
  input: z.void(),
  when: (ctx) => ctx.hasSelection,
  run: (ctx) => {
    const ids = targetIds(ctx, undefined);
    const anyVisible = ids.some((id) => ctx.doc.elements[id]!.visible);
    return setFlag(ctx, ids, 'visible', !anyVisible);
  },
});

/** Payload format shared by copy/paste and by agents inserting ready-made subtrees. */
export const ElementsPayload = z.object({
  elements: z.array(ElementSchema).min(1),
  definitions: z.array(DefinitionSchema).default([]),
  blobs: z.array(BlobSchema).default([]),
});
export type ElementsPayload = z.infer<typeof ElementsPayload>;

export const insertElements = defineMutation({
  id: 'insert-elements',
  label: 'Insert elements',
  description: 'Inserts a subtree of elements (ids are re-generated) with any definitions/blobs they need.',
  group: 'arrange',
  palette: false,
  history: 'record',
  input: ElementsPayload.extend({
    offset: z.object({ x: z.number().finite(), y: z.number().finite() }).default({ x: 0, y: 0 }),
    select: z.boolean().default(true),
  }),
  run: (ctx, input) => {
    for (const blob of input.blobs) if (!ctx.doc.blobs[blob.id]) ctx.doc.blobs[blob.id] = snapshot(blob);
    for (const definition of input.definitions) {
      if (!ctx.doc.definitions[definition.id]) ctx.doc.definitions[definition.id] = snapshot(definition);
    }
    const incoming = new Map(input.elements.map((e) => [e.id, e] as const));
    const idMap = new Map<string, string>();
    for (const id of incoming.keys()) idMap.set(id, ctx.ids.next('el'));
    const roots: string[] = [];
    for (const original of input.elements) {
      const clone = snapshot(original);
      clone.id = idMap.get(original.id)!;
      const isRoot = original.parentId === null || !incoming.has(original.parentId);
      if (isRoot) {
        clone.parentId = ctx.ui.groupEditId ?? ctx.ui.sheet?.paperId ?? null;
        clone.index = topIndex(ctx.doc.elements as ElementTable, clone.parentId);
        clone.x += input.offset.x;
        clone.y += input.offset.y;
        if (clone.parentId) {
          const toLocal = invert(worldMatrix(ctx.doc.elements as ElementTable, ctx.doc.elements[clone.parentId]!));
          const local = applyToPoint(toLocal, clone);
          clone.x = local.x; clone.y = local.y;
          clone.rotation += Math.atan2(toLocal[1], toLocal[0]) * 180 / Math.PI;
        }
        roots.push(clone.id);
      } else {
        clone.parentId = idMap.get(original.parentId!)!;
      }
      if (clone.kind === 'instance' && !ctx.doc.definitions[clone.definitionId]) {
        throw new CommandError('rejected', `Missing definition ${clone.definitionId} for pasted instance`);
      }
      if (clone.kind === 'image' && !ctx.doc.blobs[clone.blobId]) {
        throw new CommandError('rejected', `Missing image data for pasted image`);
      }
      ctx.doc.elements[clone.id] = clone;
    }
    if (input.select) setSelection(ctx, roots);
    return roots;
  },
});

/** Everything needed to re-create the given elements elsewhere (used by copy and by agents). */
export function collectPayload(doc: ArchaiDocument, ids: readonly string[]): ElementsPayload {
  const elements: Element[] = [];
  for (const id of ids) {
    const element = doc.elements[id];
    if (!element || isEffectivelyLocked(doc.elements, id)) continue;
    elements.push(element, ...descendantsOf(doc.elements, id));
  }
  const definitionIds = new Set<string>();
  const blobIds = new Set<string>();
  const visitDefinition = (definitionId: string) => {
    if (definitionIds.has(definitionId)) return;
    const definition = doc.definitions[definitionId];
    if (!definition) return;
    definitionIds.add(definitionId);
    if (definition.kind === 'image') blobIds.add(definition.blobId);
    else {
      for (const e of Object.values(definition.elements)) {
        if (e.kind === 'instance') visitDefinition(e.definitionId);
        if (e.kind === 'image') blobIds.add(e.blobId);
      }
    }
  };
  for (const element of elements) {
    if (element.kind === 'instance') visitDefinition(element.definitionId);
    if (element.kind === 'image') blobIds.add(element.blobId);
  }
  return {
    elements: elements.map((e) => {
      const clone = structuredClone(e);
      if (ids.includes(e.id)) {
        const matrix = worldMatrix(doc.elements, e);
        clone.x = matrix[4]; clone.y = matrix[5];
        clone.rotation = Math.atan2(matrix[1], matrix[0]) * 180 / Math.PI;
        clone.parentId = null;
      }
      return clone;
    }),
    definitions: [...definitionIds].map((id) => structuredClone(doc.definitions[id]!)),
    blobs: [...blobIds].map((id) => structuredClone(doc.blobs[id]!)),
  };
}

export const arrangeCommands = [
  reparentElement,
  duplicateSelection,
  deleteSelection,
  groupSelection,
  ungroupSelection,
  reorderSelection,
  bringForward,
  sendBackward,
  bringToFront,
  sendToBack,
  lockSelection,
  unlockSelection,
  toggleLock,
  hideSelection,
  showSelection,
  toggleVisibility,
  insertElements,
];

/**
 * Shared draft-level operations used by the built-in commands. Everything here works on Immer
 * drafts and throws `CommandError` for user-facing rejections.
 */
import { current, isDraft, type Draft } from 'immer';
import {
  childrenOf,
  descendantsOf,
  indexAfter,
  indexBefore,
  isEffectivelyLocked,
  lastIndexAmong,
  type ArchaiDocument,
  type Element,
  type ElementTable,
  type IdSource,
  type JsonValue,
} from '@/document';
import { applyToPoint, invert, layoutText, worldMatrix, type TextMeasurer } from '@/geometry';
import { normalizeSelection } from '@/selection';
import { hostedBy, hostOf } from '@/assets/arch-meta';
import { openingsJson, slabOpenings } from '@/assets/slabOpenings';
import { CommandError, type MutationContext } from './contract';

export type DocDraft = Draft<ArchaiDocument>;

/** Plain (non-draft) snapshot of an element. */
export function snapshot<T extends object>(value: T): T {
  const plain = isDraft(value) ? (current(value as Draft<T>) as T) : value;
  return structuredClone(plain);
}

/** The ids a command acts on: explicit ids, else the current selection; missing ids dropped. */
export function targetIds(ctx: MutationContext, ids: readonly string[] | undefined): string[] {
  const source = ids ?? ctx.ui.selection;
  return source.filter((id) => id in ctx.doc.elements);
}

export interface TargetOptions {
  /** Reject when any target is locked (directly or through an ancestor). */
  unlocked?: boolean;
  /** Human label for the empty-selection error. */
  what?: string;
}

export function requireTargets(
  ctx: MutationContext,
  ids: readonly string[] | undefined,
  options: TargetOptions = {},
): Draft<Element>[] {
  const targets = targetIds(ctx, ids);
  if (targets.length === 0) throw new CommandError('rejected', `Select ${options.what ?? 'something'} first`);
  if (options.unlocked) {
    const locked = targets.filter((id) => isEffectivelyLocked(ctx.doc.elements as ElementTable, id));
    if (locked.length > 0) throw new CommandError('rejected', 'Some of the selected elements are locked');
  }
  return targets.map((id) => ctx.doc.elements[id]!);
}

/** Next fractional index that places a new sibling in front of everything under `parentId`. */
const appendBatches = new WeakMap<ElementTable, Map<string | null, string>>();

/** Scoped to append-only import work; never cache a mutable table between commands. */
export function withAppendIndices<T>(elements: ElementTable, run: () => T): T {
  if (appendBatches.has(elements)) return run();
  appendBatches.set(elements, new Map());
  try {
    return run();
  } finally {
    appendBatches.delete(elements);
  }
}

export function topIndex(elements: ElementTable, parentId: string | null): string {
  const batch = appendBatches.get(elements);
  const next = indexAfter(batch?.get(parentId) ?? lastIndexAmong(elements, parentId));
  batch?.set(parentId, next);
  return next;
}

/** Fractional index that places a new sibling behind everything under `parentId`. */
export function bottomIndex(elements: ElementTable, parentId: string | null): string {
  return indexBefore(childrenOf(elements, parentId)[0]?.index ?? null);
}

/**
 * Pushes a camera marker's plan position (eye → aim point) into the camera of its portal, so a
 * marker moved on the board changes what the perspective view shows. Heights and FOV stay.
 */
export function syncCameraFromMarker(elements: DocDraft['elements'], marker: Draft<Element> | Element): void {
  const meta = marker.meta?.['cameraMarker'];
  if (marker.kind !== 'line' || !meta || typeof meta !== 'object' || Array.isArray(meta) || marker.points.length < 2) return;
  const m = worldMatrix(elements as ElementTable, marker as Element);
  const eye = applyToPoint(m, { x: marker.points[0]![0], y: marker.points[0]![1] });
  const aim = applyToPoint(m, { x: marker.points.at(-1)![0], y: marker.points.at(-1)![1] });
  // Every portal looking through this marker (duplicated views share it) follows.
  for (const portal of portalsOfMarker(elements, marker.id)) {
    const view = portal.meta!['view3d'] as Record<string, JsonValue>;
    const camera = (view['camera'] as Record<string, JsonValue> | undefined) ?? {};
    const position = Array.isArray(camera['position']) ? camera['position'] : [0, 1600, 0];
    const target = Array.isArray(camera['target']) ? camera['target'] : [0, 1600, 0];
    const eyeHeight = typeof meta['eyeHeight'] === 'number' ? meta['eyeHeight'] : typeof position[1] === 'number' ? position[1] : 1600;
    const targetHeight = typeof meta['targetHeight'] === 'number' ? meta['targetHeight'] : typeof target[1] === 'number' ? target[1] : 1600;
    portal.meta = {
      ...snapshot(portal.meta ?? {}),
      view3d: {
        ...snapshot(view),
        cameraMode: true,
        camera: { ...snapshot(camera), position: [eye.x, eyeHeight, eye.y], target: [aim.x, targetHeight, aim.y] },
      },
    };
  }
}

/** The portals whose view uses a marker: `view3d.cameraId` (camera marker) or `view3d.sectionLineId` (section line). */
export function portalsOfMarker(elements: DocDraft['elements'], markerId: string): Draft<Element>[] {
  const result: Draft<Element>[] = [];
  for (const element of Object.values(elements)) {
    const view = element.meta?.['view3d'];
    if (!view || typeof view !== 'object' || Array.isArray(view)) continue;
    if (view['cameraId'] === markerId || view['sectionLineId'] === markerId || view['planRegionId'] === markerId) result.push(element);
  }
  return result;
}

/** Syncs every camera marker among (or hosted by) the given ids; cheap enough to run after any move. */
/**
 * A world point in a marker's own frame (its line points). Markers live inside camera/section
 * rigs, so plain `world - marker.x` would be off by the rig's position.
 */
export function markerLocalPoint(elements: DocDraft['elements'] | ElementTable, marker: Element | Draft<Element>, x: number, y: number): [number, number] {
  const local = applyToPoint(invert(worldMatrix(elements as ElementTable, marker as Element)), { x, y });
  return [local.x, local.y];
}

export function syncCamerasAmong(elements: DocDraft['elements'], ids: Iterable<string>): void {
  const table = elements as ElementTable;
  for (const id of ids) {
    const element = elements[id];
    if (!element) continue;
    syncCameraFromMarker(elements, element);
    // A moved rig (or any group) carries its camera markers along.
    for (const descendant of descendantsOf(table, id)) syncCameraFromMarker(elements, elements[descendant.id]!);
  }
}

export function setSelection(ctx: MutationContext, ids: readonly string[]): void {
  ctx.ui.selection = normalizeSelection(ctx.doc.elements as ElementTable, ids);
}

/** Removes an element and its descendants; returns the removed ids. */
export function removeSubtree(doc: DocDraft, id: string): string[] {
  const elements = doc.elements as ElementTable;
  const element = elements[id];
  const linkedIds: string[] = [];
  if (element?.meta?.['view3d']) {
    // The marker (section line / camera) goes with the last portal that uses it.
    const view = element.meta['view3d'] as { sectionLineId?: string; cameraId?: string; planRegionId?: string;
    };
    for (const markerId of [view.sectionLineId, view.cameraId, view.planRegionId]) {
      if (!markerId || !elements[markerId]) continue;
      const others = portalsOfMarker(doc.elements, markerId).filter((portal) => portal.id !== id);
      if (others.length === 0) linkedIds.push(markerId);
    }
  }

  const removed = [id, ...descendantsOf(elements, id).map((e) => e.id)];
  for (const linked of linkedIds) {
    if (!removed.includes(linked)) {
      removed.push(linked, ...descendantsOf(elements, linked).map((e) => e.id));
    }
  }

  // A rig left with nothing but its origin goes too.
  const rigHost = element?.parentId ? elements[element.parentId] : undefined;
  if (rigHost?.meta?.['viewRig'] && !removed.includes(rigHost.id)) {
    const remaining = childrenOf(elements, rigHost.id).filter((child) => !removed.includes(child.id));
    if (remaining.length === 0) removed.push(rigHost.id);
  }

  for (const removedId of removed) delete doc.elements[removedId];
  return removed;
}

export interface CloneResult {
  /** Cloned root elements (with new ids, same parent as the originals unless overridden). */
  roots: Element[];
  /** Every cloned element, roots first. */
  all: Element[];
  idMap: Map<string, string>;
}

/** Deep-clones subtrees with fresh ids, keeping the internal parent links consistent. */
export function cloneSubtrees(
  elements: ElementTable,
  rootIds: readonly string[],
  ids: IdSource,
  options: { parentId?: string | null; offset?: { x: number; y: number } } = {},
): CloneResult {
  const idMap = new Map<string, string>();
  const originals: Element[] = [];
  for (const rootId of rootIds) {
    const root = elements[rootId];
    if (!root) continue;
    originals.push(root, ...descendantsOf(elements, rootId));
  }
  const originalIds = new Set(originals.map((e) => e.id));
  const hosted = hostedBy(elements, [...originalIds]);
  for (const hId of hosted) {
    if (!originalIds.has(hId) && elements[hId]) {
      originals.push(elements[hId]!);
      originalIds.add(hId);
    }
  }

  for (const original of originals) idMap.set(original.id, ids.next('el'));

  const all: Element[] = [];
  const roots: Element[] = [];
  const rootSet = new Set(rootIds);
  for (const original of originals) {
    const clone = snapshot(original);
    clone.id = idMap.get(original.id)!;
    const isRoot = rootSet.has(original.id);
    if (isRoot) {
      if (options.parentId !== undefined) clone.parentId = options.parentId;
      if (options.offset) {
        clone.x += options.offset.x;
        clone.y += options.offset.y;
      }
      roots.push(clone);
    } else {
      clone.parentId = idMap.get(original.parentId!) ?? clone.parentId;
      if (options.offset && (!original.parentId || !idMap.has(original.parentId))) {
        const hostId = hostOf(original);
        if (hostId && idMap.has(hostId)) {
          clone.x += options.offset.x;
          clone.y += options.offset.y;
        }
      }
    }

    if (clone.meta) {
      const explicitHost = clone.meta['host'];
      if (typeof explicitHost === 'string' && idMap.has(explicitHost)) {
        clone.meta['host'] = idMap.get(explicitHost)!;
      }
      const arch = clone.meta['arch'];
      if (arch && typeof arch === 'object' && !Array.isArray(arch)) {
        const opening = arch['opening'];
        if (opening && typeof opening === 'object' && !Array.isArray(opening) && typeof opening['wallId'] === 'string') {
          if (idMap.has(opening['wallId'])) {
            arch['opening'] = { ...(opening as Record<string, unknown>), wallId: idMap.get(opening['wallId'])! } as unknown as JsonValue;
          }
        }
      }
      const view3d = clone.meta['view3d'];
      if (view3d && typeof view3d === 'object' && !Array.isArray(view3d)) {
        const view = view3d as Record<string, JsonValue>;
        for (const key of ['cameraId', 'sectionLineId', 'planRegionId']) {
          const linked = view[key];
          if (typeof linked === 'string' && idMap.has(linked)) clone.meta['view3d'] = { ...view, [key]: idMap.get(linked)! } as unknown as JsonValue;
        }
      }
      for (const key of ['cameraMarker', 'sectionLine', 'planRegion']) {
        const marker = clone.meta[key];
        if (marker && typeof marker === 'object' && !Array.isArray(marker) && typeof marker['portalId'] === 'string' && idMap.has(marker['portalId'])) {
          clone.meta[key] = { ...(marker as Record<string, JsonValue>), portalId: idMap.get(marker['portalId'])! };
        }
      }
      const levelConstraint = clone.meta['levelConstraint'];
      if (levelConstraint && typeof levelConstraint === 'object' && !Array.isArray(levelConstraint) && typeof levelConstraint['levelId'] === 'string') {
        if (idMap.has(levelConstraint['levelId'])) {
          clone.meta['levelConstraint'] = { ...(levelConstraint as Record<string, unknown>), levelId: idMap.get(levelConstraint['levelId'])! } as unknown as JsonValue;
        }
      }
    }

    all.push(clone);
  }
  return { roots, all, idMap };
}

export function textHeight(measurer: TextMeasurer, text: string, fontSize: number, width: number): number {
  return layoutText(text, fontSize, width, measurer).height;
}

/**
 * Scales an element in its own local frame. Rotated children of a non-uniformly scaled group
 * are approximated (their frame is scaled, not skewed), which is the usual editor behaviour.
 */
export function scaleElementLocal(
  doc: DocDraft,
  element: Draft<Element>,
  sx: number,
  sy: number,
  measurer: TextMeasurer,
): void {
  switch (element.kind) {
    case 'rect':
    case 'image':
    case 'instance':
      element.width = Math.max(0, element.width * sx);
      element.height = Math.max(0, element.height * sy);
      break;
    case 'text':
      element.width = Math.max(0, element.width * sx);
      element.height = textHeight(measurer, element.text, element.fontSize, element.width);
      break;
    case 'line': {
      element.points = element.points.map(([x, y]) => [x * sx, y * sy]);
      // A slab's openings scale with it (their exact curves become their sampled outline).
      const openings = slabOpenings(element as Element);
      const arch = element.meta?.['arch'];
      if (openings.length && arch && typeof arch === 'object' && !Array.isArray(arch)) {
        element.meta = { ...element.meta, arch: { ...arch, openings: openingsJson(openings.map((opening) => ({ points: opening.points.map(([x, y]) => [x * sx, y * sy] as [number, number]) }))) } };
      }
    }
      if (element.path) {
        element.path.start = [element.path.start[0] * sx, element.path.start[1] * sy];
        element.path.segments = element.path.segments.map((segment) => {
          if (segment.kind === 'line') return { ...segment, to: [segment.to[0] * sx, segment.to[1] * sy] };
          if (segment.kind === 'quadratic') return { ...segment, control: [segment.control[0] * sx, segment.control[1] * sy], to: [segment.to[0] * sx, segment.to[1] * sy] };
          if (segment.kind === 'bezier') return { ...segment, control1: [segment.control1[0] * sx, segment.control1[1] * sy], control2: [segment.control2[0] * sx, segment.control2[1] * sy], to: [segment.to[0] * sx, segment.to[1] * sy] };
          return {
            ...segment,
            center: [segment.center[0] * sx, segment.center[1] * sy],
            // An analytic circular arc stays exact under uniform scaling. Fixed-size walls do not
            // permit non-uniform resizing; the average is a defensive fallback for imported data.
            radius: (segment.radius * (Math.abs(sx) + Math.abs(sy))) / 2,
          };
        });
      }
      break;
    case 'group':
      for (const child of childrenOf(doc.elements as ElementTable, element.id)) {
        const draft = doc.elements[child.id]!;
        draft.x *= sx;
        draft.y *= sy;
        scaleElementLocal(doc, draft, sx, sy, measurer);
      }
      break;
  }
}

/** 64-bit FNV-1a (as two 32-bit lanes) — cheap, synchronous content hashing for blob ids. */
export function contentHash(data: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9747b28c;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    a ^= c;
    a = Math.imul(a, 0x01000193) >>> 0;
    b ^= c;
    b = Math.imul(b, 0x01000193) >>> 0;
    b = (b + (i & 0xff)) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

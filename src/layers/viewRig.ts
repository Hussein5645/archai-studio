/**
 * View rigs: a camera or section is an origin (a group, `meta.viewRig`) holding its view portal
 * and its board marker (camera eye → target line / section cut line) as children:
 *
 *   ⌖ Camera 1          the origin: moving it moves both, so the view follows
 *     ▭ Camera 1 view   moving the view alone leaves the camera where it is
 *     ⟋ Camera 1 marker moving the marker re-aims the camera
 *
 * The origin sits at the camera eye (or the section line's midpoint) and is grabbed on the board
 * through a screen-size handle drawn by the overlay.
 *
 * A level's plan is a rig too, nested in the level: a plan view and a region rect (the crop)
 * centred on the origin. The level gives the elevation, so moving the level carries its plans.
 */
import { type ArchaiDocument, type Element, type ElementTable, type GroupElement } from '@/document';
import { applyToPoint, localMatrix, worldMatrix, type Vec2 } from '@/geometry';

export type ViewRigKind = 'camera' | 'section' | 'plan';

export function viewRigKind(element: Element | undefined | null): ViewRigKind | null {
  const value = element?.kind === 'group' ? element.meta?.['viewRig'] : undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = (value as Record<string, unknown>)['kind'];
  return kind === 'camera' || kind === 'section' || kind === 'plan' ? kind : null;
}

/** The rig an element belongs to (its parent), if any. */
export function rigOf(elements: ElementTable, element: Element | undefined | null): Element | null {
  const parent = element?.parentId ? elements[element.parentId] : undefined;
  return parent && viewRigKind(parent) ? parent : null;
}

/** Origin handle radius in screen pixels (mouse / touch): drawn by the overlay, hit by the board. */
export const RIG_HANDLE_RADIUS = 8;
export const RIG_HANDLE_RADIUS_TOUCH = 12;

export interface RigHandle {
  id: string;
  kind: ViewRigKind;
  /** World position of the origin. */
  x: number;
  y: number;
}

const handleCache = new WeakMap<ElementTable, readonly RigHandle[]>();

/** Every visible rig's origin in world space (cached per element table: a stable array for React). */
export function rigHandles(elements: ElementTable): readonly RigHandle[] {
  let handles = handleCache.get(elements);
  if (!handles) {
    handles = Object.values(elements).flatMap((element) => {
      const kind = viewRigKind(element);
      if (!kind || !element.visible || !visibleChain(elements, element)) return [];
      const origin = applyToPoint(worldMatrix(elements, element), { x: 0, y: 0 });
      return [{ id: element.id, kind, x: origin.x, y: origin.y }];
    });
    handleCache.set(elements, handles);
  }
  return handles;
}

function visibleChain(elements: ElementTable, element: Element): boolean {
  for (let parent = element.parentId ? elements[element.parentId] : undefined; parent; parent = parent.parentId ? elements[parent.parentId] : undefined) {
    if (!parent.visible) return false;
  }
  return true;
}

/** The front-most rig whose handle is within `radius` screen pixels of `screen`. */
export function rigHandleAt(elements: ElementTable, viewport: { x: number; y: number; zoom: number }, screen: Vec2, radius: number): Element | null {
  let best: { id: string; distance: number } | null = null;
  for (const handle of rigHandles(elements)) {
    const distance = Math.hypot(handle.x * viewport.zoom + viewport.x - screen.x, handle.y * viewport.zoom + viewport.y - screen.y);
    if (distance <= radius && (!best || distance < best.distance)) best = { id: handle.id, distance };
  }
  return best ? (elements[best.id] ?? null) : null;
}

// ---- level plans ---------------------------------------------------------------------------

/** Cut height above the level used when a plan region does not say. */
export const DEFAULT_PLAN_CUT_HEIGHT = 1200;

/** A plan region's settings (`meta.planRegion`). */
export function planRegionOf(element: Element | undefined | null): { levelId: string | null; cutHeight: number } {
  const value = element?.meta?.['planRegion'];
  const meta = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const cutHeight = meta['cutHeight'];
  return {
    levelId: typeof meta['levelId'] === 'string' ? meta['levelId'] : null,
    cutHeight: typeof cutHeight === 'number' && Number.isFinite(cutHeight) ? cutHeight : DEFAULT_PLAN_CUT_HEIGHT,
  };
}

function elevationOf(element: Element | undefined): number | null {
  const level = element?.meta?.['level'];
  if (!level || typeof level !== 'object' || Array.isArray(level)) return null;
  const elevation = (level as Record<string, unknown>)['elevation'];
  return typeof elevation === 'number' && Number.isFinite(elevation) ? elevation : 0;
}

/** The level a plan region cuts: the level it is nested in, else the one it names. */
export function levelOfPlanRegion(elements: ElementTable, region: Element): { id: string; elevation: number } | null {
  for (let parent = region.parentId ? elements[region.parentId] : undefined; parent; parent = parent.parentId ? elements[parent.parentId] : undefined) {
    const elevation = elevationOf(parent);
    if (elevation !== null) return { id: parent.id, elevation };
  }
  const named = planRegionOf(region).levelId;
  const elevation = named ? elevationOf(elements[named]) : null;
  return named && elevation !== null ? { id: named, elevation } : null;
}

// ---- legacy documents --------------------------------------------------------------------------

function isMarker(element: Element): 'camera' | 'section' | null {
  if (element.kind !== 'line' || element.points.length < 2) return null;
  if (element.meta?.['cameraMarker']) return 'camera';
  if (element.meta?.['sectionLine']) return 'section';
  return null;
}

/** Where a marker's rig origin goes, in its parent's space: the camera eye, the cut's midpoint. */
export function rigOriginForMarker(marker: Element, kind: ViewRigKind): Vec2 {
  if (marker.kind !== 'line') return { x: marker.x, y: marker.y };
  const m = localMatrix(marker);
  const first = marker.points[0]!;
  const last = marker.points.at(-1)!;
  const a = applyToPoint(m, { x: first[0], y: first[1] });
  if (kind === 'camera') return a;
  const b = applyToPoint(m, { x: last[0], y: last[1] });
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Wraps flat camera/section pairs (from documents saved before rigs) into rigs: the marker and
 * the views looking through it move under a new origin at the camera eye / cut midpoint. World
 * positions are unchanged. Pairs whose view and marker have different parents are left alone.
 * Returns the same document when there is nothing to convert.
 */
export function wrapLegacyViewRigs(doc: ArchaiDocument): ArchaiDocument {
  const elements = doc.elements;
  let next: Record<string, Element> | null = null;
  for (const marker of Object.values(elements)) {
    const kind = isMarker(marker);
    if (!kind || rigOf(elements, marker)) continue;
    const views = Object.values(elements).filter((view) => {
      const settings = view.meta?.['view3d'] as { cameraId?: unknown; sectionLineId?: unknown } | undefined;
      return view.parentId === marker.parentId && (settings?.cameraId === marker.id || settings?.sectionLineId === marker.id);
    });
    if (views.length === 0) continue;
    next ??= { ...elements };
    const origin = rigOriginForMarker(marker, kind);
    const members = [marker, ...views];
    const rigName = views[0]!.name ?? (kind === 'camera' ? 'Camera' : 'Section');
    const rig: GroupElement = {
      id: uniqueId(next, `${marker.id}-rig`),
      kind: 'group',
      parentId: marker.parentId,
      // In front of both, where the front-most of them was.
      index: members.map((member) => member.index).sort().at(-1)!,
      x: origin.x,
      y: origin.y,
      rotation: 0,
      visible: true,
      locked: false,
      name: rigName,
      meta: { viewRig: { kind } },
    };
    next[rig.id] = rig;
    for (const member of members) {
      const moved: Element = { ...member, parentId: rig.id, x: member.x - origin.x, y: member.y - origin.y };
      // The view is now named after its role; the origin carries the camera/section name.
      if (member !== marker && member.name === rigName) moved.name = `${rigName} view`;
      next[member.id] = moved;
    }
  }
  return next ? { ...doc, elements: next } : doc;
}

function uniqueId(elements: Record<string, Element>, base: string): string {
  let id = base;
  for (let n = 2; elements[id]; n++) id = `${base}-${n}`;
  return id;
}

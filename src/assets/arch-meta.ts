/**
 * Readers for `meta.arch` — the only place an element's architectural meaning is stored — and
 * the editing rules that follow from it (which handles a system element exposes).
 */
import type { Element, JsonValue } from '@/document/schema';
import type { SystemAssetType } from '@/catalog';

export type ArchMeta = Record<string, JsonValue>;

export function archOf(element: Element | undefined | null): ArchMeta | null {
  const value = element?.meta?.['arch'];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as ArchMeta) : null;
}

export function archTypeOf(element: Element | undefined | null): string | null {
  const type = archOf(element)?.['type'];
  return typeof type === 'string' ? type : null;
}

export function isArchType(element: Element | undefined | null, ...types: string[]): boolean {
  const type = archTypeOf(element);
  return type !== null && types.includes(type);
}

/**
 * How a system element may be resized by hand:
 * - `none`: doors, stairs, walls and railings only change through their parameters/endpoints;
 * - `width`: windows scale along their host wall only;
 * - `uniform`: catalog assets keep their proportions (corner handles only);
 * - `all`: columns and everything else use the regular handles.
 */
export type ResizeRule = 'none' | 'width' | 'uniform' | 'all';

export function resizeRuleFor(element: Element | undefined | null): ResizeRule {
  if (element?.meta?.['parametricGraph']) return 'none';
  const type = archTypeOf(element);
  if (type === 'door' || type === 'stair' || type === 'wall' || type === 'curtain-wall' || type === 'railing') return 'none';
  if (type === 'window') return 'width';
  if (element?.kind === 'instance' && type !== 'column') return 'uniform';
  return 'all';
}

/** Rotation handle visibility: circular columns and non-rotatable system elements hide it. */
export function canRotateByHandle(element: Element | undefined | null): boolean {
  const arch = archOf(element);
  const type = arch?.['type'];
  if (type === 'door' || type === 'window' || type === 'stair' || type === 'wall' || type === 'curtain-wall' || type === 'railing') return false;
  if (type === 'column') {
    const parameters = arch?.['parameters'];
    const shape = parameters && typeof parameters === 'object' && !Array.isArray(parameters) ? parameters['shape'] : undefined;
    return shape !== 'circle';
  }
  return true;
}

/** An element's own level of detail (`meta.lod`), overriding the view's; null = follow the view. */
export function elementLod(element: Element | undefined | null): 'high' | 'low' | null {
  const lod = element?.meta?.['lod'];
  return lod === 'high' || lod === 'low' ? lod : null;
}

/** Whether either end of a wall is joined to a neighbour. */
export function wallEndsJoined(element: Element | undefined | null): boolean {
  const joints = archOf(element)?.['joints'];
  if (!joints || typeof joints !== 'object' || Array.isArray(joints)) return false;
  return ['start', 'end', 'body'].some((end) => {
    const joint = joints[end];
    return Boolean(joint && typeof joint === 'object' && !Array.isArray(joint) && joint['enabled'] === true);
  });
}

/** A camera marker: a two-point line (eye → aim point) linked to a camera view portal. */
export function isCameraMarker(element: Element | undefined | null): element is Element & { kind: 'line' } {
  const marker = element?.meta?.['cameraMarker'];
  return element?.kind === 'line' && !!marker && typeof marker === 'object' && !Array.isArray(marker);
}

/** Walls and railings are edited through their endpoints; a camera through its eye and aim point. */
export function hasEndpointHandles(element: Element | undefined | null): element is Element & { kind: 'line' } {
  return element?.kind === 'line' && (isArchType(element, 'wall', 'railing', 'room-divider', 'curtain-wall') || isCameraMarker(element) || isMeasure(element));
}

/** A measuring line (two points with a live distance label). */
export function isMeasure(element: Element | undefined | null): element is Element & { kind: 'line' } {
  const measure = element?.meta?.['measure'];
  return element?.kind === 'line' && !!measure && typeof measure === 'object' && !Array.isArray(measure);
}

export function systemTypeOf(element: Element | undefined | null): SystemAssetType | null {
  const type = archTypeOf(element);
  const known: string[] = ['wall', 'window', 'door', 'column', 'stair', 'railing', 'curtain-wall', 'facade-element', 'floor', 'ceiling'];
  return type && known.includes(type) ? (type as SystemAssetType) : null;
}

/**
 * Hosting: an element can ride on another one (`meta.host`), and doors/windows implicitly ride
 * on the wall that carries their opening. Hosted elements move with their host and are listed
 * under it in the Layers panel.
 */
export function hostOf(element: Element | undefined | null): string | null {
  const explicit = element?.meta?.['host'];
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const opening = archOf(element)?.['opening'];
  if (opening && typeof opening === 'object' && !Array.isArray(opening) && typeof opening['wallId'] === 'string') return opening['wallId'];
  return null;
}

/** Ids hosted (transitively) by any of `hostIds`, in no particular order. */
export function hostedBy(elements: Readonly<Record<string, Element>>, hostIds: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set(hostIds);
  let frontier = [...hostIds];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const element of Object.values(elements)) {
      const host = hostOf(element);
      if (host && frontier.includes(host) && !seen.has(element.id)) {
        seen.add(element.id);
        result.push(element.id);
        next.push(element.id);
      }
    }
    frontier = next;
  }
  return result;
}

/**
 * The element graphics type (see src/graphics) an element is drawn with, or null for plain
 * drawing primitives, which keep their own style.
 */
export function graphicTypeOfElement(element: Element | undefined | null): string | null {
  if (!element) return null;
  const type = archTypeOf(element);
  if (type === 'room-label') return 'room';
  if (type && ['wall', 'column', 'facade-element', 'door', 'window', 'stair', 'railing', 'curtain-wall', 'room-divider', 'room', 'floor', 'ceiling'].includes(type)) return type;
  if (isMeasure(element)) return 'measure';
  if (element.meta?.['sectionLine']) return 'section-marker';
  if (isCameraMarker(element)) return 'camera-marker';
  if (element.meta?.['level']) return 'level';
  if (element.meta?.['paper']) return 'paper';
  if (element.meta?.['view3d']) return null;
  if (element.kind === 'instance') return 'asset';
  return null;
}

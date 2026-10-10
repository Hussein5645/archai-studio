/**
 * Live Bridge facets (docs/live-bridge.md, 2.3): an element's data split into the parts
 * that can have different authorities: geometry, transform, material and metadata. Visibility,
 * lock and the element's place in the tree always stay ArchAI's.
 */
import type { BridgeFacet, Element, ElementTable, JsonValue } from '@/document';
import { BRIDGE_FACETS } from '@/document';

/** An element's children in order (see `childLookup`). */
export type ChildLookup = (id: string) => readonly Element[];

/** Children by parent, built once for a whole table (sorted by index). */
export function childLookup(elements: ElementTable): ChildLookup {
  const byParent = new Map<string, Element[]>();
  for (const element of Object.values(elements)) {
    if (!element.parentId) continue;
    const list = byParent.get(element.parentId);
    if (list) list.push(element);
    else byParent.set(element.parentId, [element]);
  }
  for (const list of byParent.values()) list.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
  return (id) => byParent.get(id) ?? [];
}

/** Never part of a facet: identity, tree and ArchAI-only display state. */
const OWN_KEYS = new Set(['id', 'parentId', 'index', 'visible', 'locked', 'meta']);
const TOP: Record<string, BridgeFacet> = { x: 'transform', y: 'transform', rotation: 'transform', name: 'metadata', style: 'material' };
const META: Record<string, BridgeFacet | null> = {
  arch: 'geometry',
  solid: 'geometry',
  mesh: 'geometry',
  instanceElevation: 'transform',
  levelConstraint: 'transform',
  materials: 'material',
  // The Live Bridge's old tag, replaced by the binding graph.
  liveLink: null,
};

export const topFacet = (key: string): BridgeFacet | null => (OWN_KEYS.has(key) ? null : (TOP[key] ?? 'geometry'));
export const metaFacet = (key: string): BridgeFacet | null => (key in META ? META[key]! : 'metadata');

type Facets = Record<BridgeFacet, Record<string, JsonValue>>;

/** The element's content without identity, for comparing an element with another one's. */
function content(children: ChildLookup, element: Element): JsonValue {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(element)) if (key !== 'id' && key !== 'parentId' && key !== 'index' && value !== undefined) out[key] = value as JsonValue;
  const kids = children(element.id);
  if (kids.length) out['children'] = kids.map((child) => content(children, child));
  return out;
}

/** The element's facets (children belong to its geometry). */
export function facetsOf(children: ChildLookup, element: Element): Facets {
  const facets: Facets = { geometry: {}, transform: {}, material: {}, metadata: {} };
  for (const [key, value] of Object.entries(element)) {
    const facet = topFacet(key);
    if (facet && value !== undefined) facets[facet][key] = value as JsonValue;
  }
  for (const [key, value] of Object.entries(element.meta ?? {})) {
    const facet = metaFacet(key);
    if (facet) facets[facet][`meta.${key}`] = value;
  }
  const kids = children(element.id);
  if (kids.length) facets.geometry['children'] = kids.map((child) => content(children, child));
  return facets;
}

/** Stable JSON (sorted keys). */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

/** 53-bit hash (cyrb53) of a string, as base 36. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export const hashValue = (value: unknown): string => hashText(stableJson(value));

export function facetHashes(children: ChildLookup, element: Element): Record<BridgeFacet, string> {
  const facets = facetsOf(children, element);
  return Object.fromEntries(BRIDGE_FACETS.map((facet) => [facet, hashValue(facets[facet])])) as Record<BridgeFacet, string>;
}

/**
 * `target` with the facets in `apply` taken from `source` (both whole elements); identity, tree
 * position and display state stay `target`'s. Children are handled by the caller.
 */
export function mergeFacets(target: Element, source: Element, apply: ReadonlySet<BridgeFacet>): Element {
  const next: Record<string, unknown> = { id: target.id, parentId: target.parentId, index: target.index, visible: target.visible, locked: target.locked };
  const keys = new Set([...Object.keys(target), ...Object.keys(source)]);
  for (const key of keys) {
    const facet = topFacet(key);
    if (!facet) continue;
    const from = (apply.has(facet) ? source : target) as unknown as Record<string, unknown>;
    if (from[key] !== undefined) next[key] = from[key];
  }
  const meta: Record<string, JsonValue> = {};
  const metaKeys = new Set([...Object.keys(target.meta ?? {}), ...Object.keys(source.meta ?? {})]);
  for (const key of metaKeys) {
    const facet = metaFacet(key);
    if (!facet) continue;
    const from = apply.has(facet) ? source.meta : target.meta;
    if (from && from[key] !== undefined) meta[key] = from[key];
  }
  if (Object.keys(meta).length) next['meta'] = meta;
  return next as unknown as Element;
}

/** One facet's value of an element (what a conflict keeps as "theirs"). */
export const facetValue = (children: ChildLookup, element: Element, facet: BridgeFacet): Record<string, JsonValue> => facetsOf(children, element)[facet];

/** `element` with one facet replaced by a value from `facetValue` (children excepted). */
export function withFacetValue(element: Element, facet: BridgeFacet, value: Record<string, JsonValue>): Element {
  const next: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(element)) if (key === 'meta' || topFacet(key) !== facet) next[key] = v;
  const meta: Record<string, JsonValue> = {};
  for (const [key, v] of Object.entries(element.meta ?? {})) if (metaFacet(key) !== facet) meta[key] = v;
  for (const [key, v] of Object.entries(value)) {
    if (key === 'children') continue;
    if (key.startsWith('meta.')) meta[key.slice(5)] = v;
    else next[key] = v;
  }
  next['meta'] = meta;
  if (Object.keys(meta).length === 0) delete next['meta'];
  return next as unknown as Element;
}

/**
 * Deep equality with a tolerance on numbers (half a millimetre by default): what an app sends
 * back after applying ArchAI's change differs from ArchAI's own values by rounding only.
 */
export function nearlyEqual(a: unknown, b: unknown, tolerance = 0.5): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tolerance;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => nearlyEqual(value, b[i], tolerance));
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => nearlyEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], tolerance));
}

/** Replaces every string equal to a key of `ids` with its value (references to rebuilt elements). */
export function rewriteIds<T>(value: T, ids: ReadonlyMap<string, string>): T {
  if (typeof value === 'string') return (ids.get(value) ?? value) as T;
  if (Array.isArray(value)) return value.map((item) => rewriteIds(item, ids)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteIds(v, ids)])) as T;
  return value;
}

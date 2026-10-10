/**
 * What a connected app receives from ArchAI (Live Bridge protocol 2, docs/live-bridge-proposal.md):
 *
 * - **nodes**: elements shared with it, each with a content hash (its facets and the elements it
 *   depends on or that depend on it, such as a wall and its doors), its source and colour, and
 *   the facets it may edit when it was offered an editable copy. Elements already sent with the
 *   same hash are left out (`present` still lists them), so a pull carries only what changed.
 * - **updates** for the app's own objects (bound to it): ArchAI's changes it should apply, only
 *   for facets it does not own: a move (plan translation and elevation; rotations stay in ArchAI)
 *   and a new name. Its copies of ArchAI elements whose geometry changed come again as nodes
 *   marked with `ref` (replace that object).
 */
import { invert, multiply, worldMatrix, type Mat } from '@/geometry';
import type { ArchaiDocument, BridgeFacet, Element, ElementTable, JsonValue } from '@/document';
import { instanceElevationOf } from '@/view3d/geometry';
import { ownerOf } from './engine';
import { childLookup, facetHashes, hashValue } from './facets';
import { liveLinkOf } from '@/live/sync';

export interface BridgeUpdate {
  /** The app's object (its own id) and exchange collection. */
  ref: string;
  kind: string;
  element: string;
  /** Changes with every new version of the update: an app applies each token once. */
  token: string;
  /** Plan translation (mm, ArchAI plan axes: x right, y down) and elevation change (mm). */
  move?: [number, number, number];
  name?: string;
}

export interface PullPlan {
  /** Elements to send as nodes, with their extras. */
  nodes: Map<string, Record<string, JsonValue>>;
  /** Every element the app should have (sent now or before). */
  present: string[];
  updates: BridgeUpdate[];
  /** Hashes of what the app has after this pull (for the next one). */
  sent: Map<string, string>;
}

const TOLERANCE = 0.5;

/** Elements referenced by an element's metadata (hosts, levels, walls of openings). */
function referencesOf(element: Element, elements: ElementTable): string[] {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value !== element.id && elements[value]) out.push(value);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(element.meta);
  return out;
}

/**
 * The pull for app `key`. `sent` is what it received before in this session (null: send
 * everything, e.g. after the app restarted).
 */
export function pullPlan(doc: ArchaiDocument, key: string, sent: ReadonlyMap<string, string> | null): PullPlan {
  const bridge = doc.bridge;
  const source = bridge?.sources[key];
  const plan: PullPlan = { nodes: new Map(), present: [], updates: [], sent: new Map() };
  if (source && (source.mode === 'paused' || source.receives === 'nothing')) return plan;
  const elements = doc.elements;
  const children = childLookup(elements);
  const own = new Map<string, Record<BridgeFacet, string>>();
  const hashOf = (id: string) => {
    let hashes = own.get(id);
    if (!hashes) own.set(id, (hashes = facetHashes(children, elements[id]!)));
    return hashes;
  };

  // Dependencies both ways: an element's node changes when what it references or what references it changes.
  const related = new Map<string, Set<string>>();
  for (const element of Object.values(elements)) {
    for (const target of referencesOf(element, elements)) {
      (related.get(element.id) ?? related.set(element.id, new Set()).get(element.id)!).add(target);
      (related.get(target) ?? related.set(target, new Set()).get(target)!).add(element.id);
    }
  }
  const nodeHash = (id: string) => hashValue([hashOf(id), [...(related.get(id) ?? [])].sort().map((other) => hashOf(other))]);

  /** Excluded with everything below them: the app's own elements and elements not shared. */
  const excluded = new Set<string>();
  for (const element of Object.values(elements)) {
    const binding = bridge?.elements[element.id];
    const ref = binding?.refs[key];
    if (liveLinkOf(element)?.key === key) {
      excluded.add(element.id);
      continue;
    }
    if (ref && binding) {
      excluded.add(element.id);
      const hashes = hashOf(element.id);
      const writable = (facet: BridgeFacet) => hashes[facet] !== ref.archai[facet] && ownerOf(bridge!, binding, facet) !== key;
      const update: BridgeUpdate = { ref: ref.id, kind: ref.kind, element: element.id, token: hashValue([hashes, ref.archai]) };
      if (writable('transform') && ref.placed) {
        const move = translationBetween(ref.placed, worldMatrix(elements, element), instanceElevationOf(element, elements));
        if (move) update.move = move;
      }
      if (writable('metadata') && element.name) update.name = element.name;
      if (update.move || update.name) plan.updates.push(update);
      // An editable copy whose geometry ArchAI changed: sent again to replace the app's object.
      if (ref.role === 'copy' && writable('geometry')) {
        excluded.delete(element.id);
        plan.nodes.set(element.id, { ref: ref.id, hash: nodeHash(element.id) });
      }
      continue;
    }
    if ((binding?.share ?? 'shared') !== 'shared') excluded.add(element.id);
  }
  const isExcluded = (element: Element): boolean => {
    for (let current: Element | undefined = element; current; current = current.parentId ? elements[current.parentId] : undefined) {
      if (excluded.has(current.id) && !plan.nodes.get(current.id)?.['ref']) return true;
    }
    return false;
  };

  for (const element of Object.values(elements)) {
    if (plan.nodes.has(element.id)) {
      plan.present.push(element.id);
      plan.sent.set(element.id, plan.nodes.get(element.id)!['hash'] as string);
      continue;
    }
    if (isExcluded(element)) continue;
    const hash = nodeHash(element.id);
    plan.present.push(element.id);
    plan.sent.set(element.id, hash);
    if (sent?.get(element.id) === hash) continue;
    const binding = bridge?.elements[element.id];
    const origin = binding ? Object.entries(binding.refs).find(([, ref]) => ref.role === 'origin')?.[0] : undefined;
    const extras: Record<string, JsonValue> = { hash };
    if (origin) {
      extras['source'] = origin;
      const color = bridge?.sources[origin]?.color;
      if (color) extras['color'] = color;
    }
    const offered = binding?.offers?.[key];
    if (offered?.length) extras['editable'] = offered;
    plan.nodes.set(element.id, extras);
  }
  return plan;
}

/** The plan translation and elevation change from where the app has an object to where ArchAI has it; null when nothing moved or it turned (rotations stay in ArchAI). */
export function translationBetween(placed: { m: number[]; z: number }, now: Mat, elevation: number): [number, number, number] | null {
  const before = placed.m as unknown as Mat;
  let inverse: Mat;
  try {
    inverse = invert(before);
  } catch {
    return null;
  }
  const delta = multiply(now, inverse);
  const turned = Math.abs(delta[0] - 1) > 1e-6 || Math.abs(delta[1]) > 1e-6 || Math.abs(delta[2]) > 1e-6 || Math.abs(delta[3] - 1) > 1e-6;
  const dz = elevation - placed.z;
  if (turned) return null;
  if (Math.abs(delta[4]) <= TOLERANCE && Math.abs(delta[5]) <= TOLERANCE && Math.abs(dz) <= TOLERANCE) return null;
  return [delta[4], delta[5], dz];
}


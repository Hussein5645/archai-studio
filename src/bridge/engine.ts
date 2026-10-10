/**
 * The Live Bridge sync engine (docs/live-bridge-proposal.md): applies one source model (a
 * plugin's exchange file) to the project through the binding graph instead of replacing it.
 *
 * - Items keep their ArchAI element across syncs (bound by the source's own id); unchanged items
 *   are skipped by the hash of their raw exchange item, changed ones are rebuilt aside and merged
 *   into the bound element facet by facet (geometry, transform, material, metadata).
 * - Authority is decided per facet: the owner's change wins, `shared` facets changed on both
 *   sides become conflicts, facets owned by ArchAI or another app are not changed.
 * - Deletions are only taken from complete snapshots or explicit ids, never from elements edited
 *   in ArchAI or bound to other apps (conflicts), and mass deletions wait for confirmation.
 * - Everything runs inside one mutation: one undo step, one document change.
 */
import { current, isDraft } from 'immer';
import type { MutationContext } from '@/commands/contract';
import { CommandError } from '@/commands/contract';
import { removeSubtree, snapshot } from '@/commands/helpers';
import { BRIDGE_FACETS, type BridgeBinding, type BridgeData, type BridgeFacet, type BridgeFidelity, type BridgeSource, type Element, type ElementTable, type JsonValue } from '@/document';
import type { RevitExchange } from '@/revit/exchange';
import { importRevitModel, type ExchangeCollection, type RevitImportReport } from '@/revit/importRevit';
import { worldMatrix } from '@/geometry';
import { instanceElevationOf } from '@/view3d/geometry';
import { childLookup, facetHashes, facetsOf, facetValue, hashValue, mergeFacets, nearlyEqual, rewriteIds } from './facets';

/** Source colours, in the order new sources get them. */
export const SOURCE_COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#e03131', '#5f3dc4', '#66a80f', '#c2255c'];
/** A complete snapshot deleting more than this many elements, and more than MASS_SHARE of the source's, waits for confirmation. */
export const MASS_DELETE = 20;
export const MASS_SHARE = 0.25;
const LOG_LIMIT = 200;
const UNSUPPORTED_LIMIT = 200;

export interface BridgeSyncInput {
  key: string;
  app: string;
  name: string;
  model: RevitExchange;
  /** Whether `model` is the whole source model (missing items were deleted there). */
  complete: boolean;
  /** Ids deleted in the source (any collection). */
  deleted: readonly string[];
  /** Protocol 2: the change's id; the same change twice is answered without applying it again. */
  changeId: string | null;
}

export interface BridgeSyncReport {
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  held: number;
  conflicts: number;
  rejected: number;
  unsupported: number;
  /** Elements of the old live link replaced on the first bridge sync. */
  migrated: number;
  /** Objects recognised as the app's editable copies of ArchAI elements (linked, not added). */
  linked: number;
  /** Elements built by kind (as the live link reported them). */
  built: Record<string, number>;
  skipped: RevitImportReport['skipped'];
  /** True when this change had been applied already. */
  repeated?: boolean;
}

const nowOf = (ctx: MutationContext) => Date.parse(ctx.now()) || Date.now();

export function ensureBridge(ctx: MutationContext): BridgeData {
  ctx.doc.bridge ??= { version: 1, sources: {}, elements: {}, conflicts: [], held: [], log: [] };
  return ctx.doc.bridge as BridgeData;
}

export function registerSource(ctx: MutationContext, key: string, app: string, name: string): BridgeSource {
  const bridge = ensureBridge(ctx);
  const existing = bridge.sources[key];
  if (existing) {
    if (app) existing.app = app;
    if (name) existing.name = name;
    return existing;
  }
  const used = new Set(Object.values(bridge.sources).map((source) => source.color));
  const color = SOURCE_COLORS.find((c) => !used.has(c)) ?? SOURCE_COLORS[Object.keys(bridge.sources).length % SOURCE_COLORS.length]!;
  bridge.sources[key] = { app, name, color, mode: 'two-way', receives: 'shared', authority: {}, linkedAt: nowOf(ctx), lastSync: null, lastChangeId: null, complete: true, unsupported: [] };
  return bridge.sources[key]!;
}

export function bridgeLog(ctx: MutationContext, source: string, text: string): void {
  const bridge = ensureBridge(ctx);
  bridge.log.push({ at: nowOf(ctx), source, text: text.slice(0, 500) });
  if (bridge.log.length > LOG_LIMIT) bridge.log.splice(0, bridge.log.length - LOG_LIMIT);
}

/**
 * Who decides `facet` of an element: its own override, else the authority of the source it came
 * from, else that source (`origin`). Returns a source key, `archai` or `shared`.
 */
export function ownerOf(bridge: BridgeData, binding: BridgeBinding, facet: BridgeFacet): string {
  const origin = Object.entries(binding.refs).find(([, ref]) => ref.role === 'origin')?.[0] ?? null;
  const owner = binding.owners?.[facet] ?? (origin ? bridge.sources[origin]?.authority[facet] : undefined) ?? 'origin';
  if (owner === 'origin') return origin ?? 'archai';
  return owner;
}

/** How faithful ArchAI's element is to an item of each collection. */
const FIDELITY: Record<ExchangeCollection, { fidelity: BridgeFidelity; lossy: boolean }> = {
  levels: { fidelity: 'converted', lossy: true },
  walls: { fidelity: 'converted', lossy: true },
  openings: { fidelity: 'converted', lossy: true },
  slabs: { fidelity: 'converted', lossy: true },
  columns: { fidelity: 'converted', lossy: true },
  railings: { fidelity: 'converted', lossy: true },
  rooms: { fidelity: 'converted', lossy: true },
  meshes: { fidelity: 'reference', lossy: false },
};

const COLLECTIONS: ExchangeCollection[] = ['levels', 'walls', 'openings', 'slabs', 'columns', 'railings', 'rooms', 'meshes'];

/**
 * A hash per item (`collection/id`), including what it depends on: its materials, its level and,
 * for openings, the host wall, so a change there rebuilds the item too.
 */
export function itemHashes(model: RevitExchange): Map<string, string> {
  const hashes = new Map<string, string>();
  const materials = new Map(model.materials.map((m) => [m.id, hashValue(m)]));
  const levels = new Map(model.levels.map((l) => [l.id, hashValue(l)]));
  const dep = (material?: string | null, level?: string | null) => [material ? (materials.get(material) ?? '') : '', level ? (levels.get(level) ?? '') : ''];
  for (const level of model.levels) hashes.set(`levels/${level.id}`, levels.get(level.id)!);
  const walls = new Map<string, string>();
  for (const wall of model.walls) {
    const hash = hashValue([wall, wall.layers.map((layer) => dep(layer.material)), dep(null, wall.level)]);
    walls.set(wall.id, hash);
    hashes.set(`walls/${wall.id}`, hash);
  }
  for (const opening of model.openings) hashes.set(`openings/${opening.id}`, hashValue([opening, walls.get(opening.wall) ?? '']));
  for (const slab of model.slabs) hashes.set(`slabs/${slab.id}`, hashValue([slab, dep(slab.material, slab.level)]));
  for (const column of model.columns) hashes.set(`columns/${column.id}`, hashValue([column, dep(column.material, column.level)]));
  for (const railing of model.railings) hashes.set(`railings/${railing.id}`, hashValue([railing, dep(null, railing.level)]));
  for (const room of model.rooms) hashes.set(`rooms/${room.id}`, hashValue([room, dep(null, room.level)]));
  for (const mesh of model.meshes) hashes.set(`meshes/${mesh.id}`, hashValue([mesh, dep(null, mesh.level)]));
  return hashes;
}

const materialSource = (key: string, material: { name: string; color: string }) => `live:${key}:${material.name}:${material.color}`.slice(0, 200);

function legacyTag(element: Element): string | null {
  const value = element.meta?.['liveLink'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return typeof value['key'] === 'string' ? value['key'] : null;
}

const plain = (elements: ElementTable): ElementTable => (isDraft(elements) ? current(elements) : elements);

/** Where an element is: its plan matrix and elevation (what the app has, for updates sent back to it). */
export function placedOf(elements: ElementTable, element: Element): { m: number[]; z: number } {
  return { m: [...worldMatrix(elements, element)], z: instanceElevationOf(element, elements) };
}

export function runBridgeSync(ctx: MutationContext, input: BridgeSyncInput): BridgeSyncReport {
  const bridge = ensureBridge(ctx);
  const known = bridge.sources[input.key];
  if (known && input.changeId && known.lastChangeId === input.changeId && known.lastAck) return { ...(snapshot(known.lastAck as object) as BridgeSyncReport), repeated: true };
  if (known && known.mode !== 'two-way') throw new CommandError('rejected', known.mode === 'paused' ? 'This link is paused in ArchAI' : 'This link only receives from ArchAI (read-only)');
  const source = registerSource(ctx, input.key, input.app, input.name);
  const key = input.key;
  const now = nowOf(ctx);
  const report: BridgeSyncReport = { created: 0, updated: 0, unchanged: 0, deleted: 0, held: 0, conflicts: 0, rejected: 0, unsupported: 0, migrated: 0, linked: 0, built: {}, skipped: [] };
  const notes: string[] = [];
  const selection = ctx.ui.selection;

  // The old live link's elements (no bindings) are replaced once by bound ones.
  const bound = new Map<string, string>();
  for (const [elementId, binding] of Object.entries(bridge.elements)) {
    const ref = binding.refs[key];
    if (ref) bound.set(`${ref.kind}/${ref.id}`, elementId);
  }
  if (bound.size === 0) {
    for (const element of Object.values(ctx.doc.elements)) {
      if (ctx.doc.elements[element.id] && legacyTag(element) === key) report.migrated += removeSubtree(ctx.doc, element.id).length;
    }
    if (report.migrated) notes.push(`replaced ${report.migrated} elements of the old live link`);
  }

  // Bound elements' facets before the sync: changes the sync itself makes to them (not ArchAI
  // edits) move their recorded state along.
  const before = new Map<string, Record<BridgeFacet, string>>();
  {
    const elementsBefore = plain(ctx.doc.elements);
    const childrenBefore = childLookup(elementsBefore);
    for (const elementId of bound.values()) {
      const element = elementsBefore[elementId];
      if (element) before.set(elementId, facetHashes(childrenBefore, element));
    }
  }
  const hashes = itemHashes(input.model);
  /** Items whose bound element is rebuilt aside: `collection/id` → bound element. */
  const changed = new Map<string, string>();
  /** The app's editable copies of ArchAI elements, seen for the first time: item → element. */
  const copyOf = new Map<string, string>(input.model.meshes.flatMap((mesh) => (mesh.archai ? [[`meshes/${mesh.id}`, mesh.archai] as const] : [])));
  const copies = new Map<string, string>();
  /** Objects an older plugin sent under another id: `meshes/<new id>` → `meshes/<old id>`. */
  const renamed = new Map<string, string>();
  const currentIds = new Set(input.model.meshes.map((mesh) => mesh.id));
  for (const mesh of input.model.meshes) if (mesh.was && mesh.was !== mesh.id && !currentIds.has(mesh.was)) renamed.set(`meshes/${mesh.id}`, `meshes/${mesh.was}`);
  const created: { item: string; collection: ExchangeCollection; id: string; element: string }[] = [];
  const existingMaterials = new Map(Object.values(ctx.doc.materials).flatMap((material) => (material.source ? [[material.source, material.id] as const] : [])));

  const imported = importRevitModel(ctx, input.model, {
    reuseMaterial: (material) => existingMaterials.get(materialSource(key, material)),
    materialSource: (material) => materialSource(key, material),
    existing: (collection, id) => {
      const item = `${collection}/${id}`;
      const previous = renamed.get(item);
      if (previous && !bound.has(item) && bound.has(previous)) {
        // Same object, new id: its link follows.
        const moved = bound.get(previous)!;
        bound.delete(previous);
        bound.set(item, moved);
        bridge.elements[moved]!.refs[key]!.id = id;
      }
      const elementId = bound.get(item);
      if (!elementId) {
        const original = copyOf.get(item);
        if (original && ctx.doc.elements[original] && !bridge.elements[original]?.refs[key]) copies.set(item, original);
        return undefined;
      }
      const binding = bridge.elements[elementId]!;
      if (binding.removed) return null;
      if (!ctx.doc.elements[elementId]) {
        binding.removed = now;
        notes.push(`kept ${id} deleted (deleted in ArchAI)`);
        return null;
      }
      if (binding.refs[key]!.item === hashes.get(item)) {
        report.unchanged += 1;
        return elementId;
      }
      changed.set(item, elementId);
      return undefined;
    },
    onCreated: (collection, id, element) => created.push({ item: `${collection}/${id}`, collection, id, element }),
  });
  report.built = imported.created;
  report.skipped = imported.skipped;

  // Rebuilt items' new elements stand in for their bound ones: references point at the bound ids.
  const rebuilt = new Map<string, string>();
  for (const entry of created) {
    const target = changed.get(entry.item);
    if (target) rebuilt.set(entry.element, target);
  }
  if (rebuilt.size) {
    const touched = new Set(created.map((entry) => entry.element));
    for (const element of Object.values(ctx.doc.elements)) {
      if (!touched.has(element.id) && !(element.parentId && touched.has(element.parentId))) continue;
      if (element.meta) element.meta = rewriteIds(snapshot(element.meta), rebuilt);
    }
  }

  let elements = plain(ctx.doc.elements);
  let children = childLookup(elements);
  type Merge = { entry: (typeof created)[number]; target: string; apply: Set<BridgeFacet>; edited: Set<BridgeFacet>; converged: Set<BridgeFacet>; kept: Set<BridgeFacet> };
  const merges: Merge[] = [];
  for (const entry of created) {
    const target = changed.get(entry.item);
    if (target) {
      merges.push({ entry, target, apply: new Set(), edited: new Set(), converged: new Set(), kept: new Set() });
      continue;
    }
    const original = copies.get(entry.item);
    const element = elements[entry.element]!;
    if (original) {
      // The app's copy of an ArchAI element: linked to it, the element itself stays as it is.
      const target = elements[original]!;
      const binding = (bridge.elements[original] ??= { state: facetHashes(children, target), refs: {} });
      binding.refs[key] = { id: entry.id, kind: entry.collection, role: 'copy', fidelity: 'converted', lossy: true, base: facetHashes(children, element), item: hashes.get(entry.item), archai: facetHashes(children, target), placed: placedOf(elements, element), at: now };
      if (ctx.doc.elements[entry.element]) removeSubtree(ctx.doc, entry.element);
      report.linked += 1;
      continue;
    }
    const hashesNow = facetHashes(children, element);
    const { fidelity, lossy } = FIDELITY[entry.collection];
    bridge.elements[entry.element] = { state: hashesNow, refs: { [key]: { id: entry.id, kind: entry.collection, role: 'origin', fidelity, lossy, base: hashesNow, item: hashes.get(entry.item), archai: hashesNow, placed: placedOf(elements, element), at: now } } };
    report.created += 1;
  }

  // Changed items: facet by facet into the bound element.
  let overwritten = 0;
  for (const merge of merges) {
    const { entry, target, apply } = merge;
    const binding = bridge.elements[target]!;
    const ref = binding.refs[key]!;
    const theirs = elements[entry.element]!;
    const mine = elements[target]!;
    const theirFacets = facetsOf(children, theirs);
    const myFacets = facetsOf(children, mine);
    const incoming = facetHashes(children, theirs);
    const present = facetHashes(children, mine);
    for (const facet of BRIDGE_FACETS) {
      const editedHere = present[facet] !== binding.state[facet];
      if (editedHere) merge.edited.add(facet);
      if (incoming[facet] === ref.base[facet]) continue;
      // The app now has what ArchAI has (it applied an update ArchAI sent): in sync, not a change.
      if (nearlyEqual(theirFacets[facet], myFacets[facet])) {
        merge.converged.add(facet);
        continue;
      }
      const owner = ownerOf(bridge, binding, facet);
      const offered = binding.offers?.[key]?.includes(facet) ?? false;
      if (facet === 'geometry' && theirs.kind !== mine.kind && ref.role !== 'origin') {
        report.rejected += 1;
        merge.kept.add(facet);
        continue;
      }
      if (owner === key) {
        apply.add(facet);
        if (editedHere) overwritten += 1;
      } else if (owner === 'shared' || offered) {
        if (editedHere) {
          merge.kept.add(facet);
          bridge.conflicts = bridge.conflicts.filter((c) => !(c.element === target && c.source === key && c.facet === facet));
          bridge.conflicts.push({ id: ctx.ids.next('hist'), element: target, source: key, facet, at: now, theirs: facetValue(children, theirs, facet) as JsonValue });
          report.conflicts += 1;
        } else apply.add(facet);
      } else {
        report.rejected += 1;
        merge.kept.add(facet);
      }
    }
    ref.placed = placedOf(elements, theirs);
    if (apply.size) {
      ctx.doc.elements[target] = mergeFacets(mine, theirs, apply);
      if (apply.has('geometry')) {
        for (const child of children(target)) if (ctx.doc.elements[child.id]) removeSubtree(ctx.doc, child.id);
        for (const child of children(entry.element)) ctx.doc.elements[child.id]!.parentId = target;
      }
      report.updated += 1;
    }
    if (ctx.doc.elements[entry.element]) removeSubtree(ctx.doc, entry.element);
    ref.base = incoming;
    ref.item = hashes.get(entry.item);
    ref.at = now;
  }
  // Recorded states: what the sync applied, and what it changed as a side effect; ArchAI's own
  // edits stay marked (their old state is kept) so a later change from a source still sees them.
  elements = plain(ctx.doc.elements);
  children = childLookup(elements);
  const mergedInto = new Map(merges.map((merge) => [merge.target, merge]));
  for (const [elementId, old] of before) {
    const element = elements[elementId];
    const binding = bridge.elements[elementId];
    if (!element || !binding) continue;
    const after = facetHashes(children, element);
    const merge = mergedInto.get(elementId);
    for (const facet of BRIDGE_FACETS) {
      if (merge) {
        if (merge.apply.has(facet) || merge.converged.has(facet) || !merge.edited.has(facet)) binding.state[facet] = after[facet];
        // What the app has: ArchAI's version unless ArchAI kept its own (sent back to it later).
        const ref = binding.refs[key];
        if (ref && !merge.kept.has(facet) && (merge.apply.has(facet) || merge.converged.has(facet) || !merge.edited.has(facet))) ref.archai[facet] = after[facet];
      } else if (old[facet] !== after[facet] && binding.state[facet] === old[facet]) binding.state[facet] = after[facet];
    }
  }
  if (overwritten) notes.push(`${overwritten} ArchAI edits replaced by ${input.app || 'the source'} (it owns them)`);
  if (report.rejected) notes.push(`${report.rejected} changes not applied (owned by ArchAI or another app)`);

  // Deletions: only from complete snapshots or explicit ids.
  const present = new Set(hashes.keys());
  const explicit = new Set(input.deleted);
  const candidates: string[] = [];
  for (const [item, elementId] of bound) {
    const ref = bridge.elements[elementId]?.refs[key];
    if (!ref) continue;
    if ((input.complete && !present.has(item)) || explicit.has(ref.id)) candidates.push(elementId);
  }
  const deletable: string[] = [];
  elements = plain(ctx.doc.elements);
  children = childLookup(elements);
  for (const elementId of candidates) {
    const binding = bridge.elements[elementId]!;
    const element = elements[elementId];
    if (!element) {
      unbind(bridge, elementId, key);
      continue;
    }
    const nowHashes = facetHashes(children, element);
    const editedHere = BRIDGE_FACETS.some((facet) => nowHashes[facet] !== binding.state[facet]);
    const elsewhere = Object.keys(binding.refs).some((other) => other !== key);
    if (editedHere || elsewhere) {
      if (!bridge.conflicts.some((c) => c.element === elementId && c.source === key && c.facet === 'delete')) {
        bridge.conflicts.push({ id: ctx.ids.next('hist'), element: elementId, source: key, facet: 'delete', at: now });
        report.conflicts += 1;
      }
      continue;
    }
    deletable.push(elementId);
  }
  if (bridge.held.some((held) => held.source === key)) bridge.held = bridge.held.filter((held) => held.source !== key);
  const sourceSize = [...bound.values()].length;
  if (deletable.length > MASS_DELETE && deletable.length > sourceSize * MASS_SHARE) {
    bridge.held.push({ id: ctx.ids.next('hist'), source: key, elements: deletable, at: now });
    report.held = deletable.length;
    notes.push(`${deletable.length} deletions held for confirmation`);
  } else {
    for (const elementId of deletable) {
      if (ctx.doc.elements[elementId]) removeSubtree(ctx.doc, elementId);
      unbind(bridge, elementId, key);
      report.deleted += 1;
    }
  }

  report.unsupported = imported.skipped.length;
  const unsupported = imported.skipped.slice(0, UNSUPPORTED_LIMIT).map((s) => ({ id: s.id.slice(0, 200), kind: s.kind.slice(0, 60), reason: s.reason.slice(0, 300) }));
  const sameUnsupported = JSON.stringify(unsupported) === JSON.stringify(source.unsupported);
  // Nothing changed (an app sending what ArchAI already has): no document change at all, so
  // the other apps are not made to pull for nothing.
  const changedNothing = Boolean(known) && merges.length === 0 && created.length === 0 && !report.deleted && !report.held && !report.conflicts && !report.migrated && notes.length === 0 && sameUnsupported && source.complete === input.complete;
  if (changedNothing) {
    ctx.ui.selection = selection.filter((id) => ctx.doc.elements[id]);
    return report;
  }
  if (!sameUnsupported) source.unsupported = unsupported;
  source.lastSync = now;
  source.complete = input.complete;
  source.lastChangeId = input.changeId;
  const { built: _built, skipped: _skipped, ...ack } = report;
  source.lastAck = { ...ack, built: {}, skipped: [] };
  if (report.conflicts) notes.push(`${report.conflicts} conflicts`);
  if (report.created || report.updated || report.deleted || report.unsupported || notes.length) bridgeLog(ctx, key, summary(report, notes));
  ctx.ui.selection = selection.filter((id) => ctx.doc.elements[id]);
  return report;
}

/** Drops one app's ref from an element's binding (and the binding when nothing is left). */
export function unbind(bridge: BridgeData, elementId: string, key: string): void {
  const binding = bridge.elements[elementId];
  if (!binding) return;
  delete binding.refs[key];
  if (Object.keys(binding.refs).length === 0 && !binding.share && !binding.owners) delete bridge.elements[elementId];
}

function summary(report: BridgeSyncReport, notes: string[]): string {
  const parts = [
    report.created && `${report.created} added`,
    report.updated && `${report.updated} changed`,
    report.deleted && `${report.deleted} deleted`,
    report.unsupported && `${report.unsupported} not supported`,
  ].filter(Boolean);
  return [parts.length ? parts.join(', ') : 'no changes', ...notes].join('; ');
}

export { COLLECTIONS };

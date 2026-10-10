/**
 * Live Bridge commands (docs/live-bridge-proposal.md). Each one is a normal ArchAI mutation: one
 * undo step, shared with co-editors of an online project like any other edit.
 */
import { z } from 'zod';
import { defineMutation, CommandError } from '@/commands/contract';
import { removeSubtree } from '@/commands/helpers';
import { BRIDGE_FACETS, BRIDGE_MODES, BRIDGE_SHARES, BridgeOwnerSchema, IdSchema, type BridgeData, type JsonValue } from '@/document';
import { RevitExchangeSchema } from '@/revit/exchange';
import { bridgeLog, ensureBridge, runBridgeSync, unbind } from './engine';
import { childLookup, facetHashes, withFacetValue } from './facets';
import { current, isDraft } from 'immer';

const SyncInput = z.object({
  key: z.string().min(1).max(300),
  app: z.string().max(60).default(''),
  name: z.string().max(200).default(''),
  model: z.unknown(),
  /** The model is the whole source model: items missing from it were deleted there. */
  complete: z.boolean().default(true),
  /** Ids deleted in the source. */
  deleted: z.array(z.string().max(200)).max(100_000).default([]),
  changeId: z.string().max(100).nullable().default(null),
});

function parseModel(model: unknown) {
  const parsed = RevitExchangeSchema.safeParse(model);
  if (!parsed.success) throw new CommandError('invalid-input', 'Not a valid ArchAI exchange model', parsed.error.issues.slice(0, 10).map((issue) => `${issue.path.join('.')}: ${issue.message}`));
  return parsed.data;
}

export const bridgeSync = defineMutation({
  id: 'bridge-sync',
  label: 'Live Bridge sync',
  description: "Applies a connected app's model (an exchange file, archaiRevit: 1) to the project through the Live Bridge binding graph: updates bound elements in place, adds new ones, deletes only from complete snapshots or explicit ids, and follows the authority rules. Returns a report.",
  group: 'document',
  palette: false,
  history: 'record',
  input: SyncInput,
  run: (ctx, input) => {
    const model = parseModel(input.model);
    return runBridgeSync(ctx, { key: input.key, app: input.app || model.app || '', name: input.name || model.name || '', model, complete: input.complete, deleted: input.deleted, changeId: input.changeId });
  },
});

/** The Live Bridge's command (plugins 0.4.x and older): a complete model each time. */
export const syncLiveLink = defineMutation({
  id: 'sync-live-link',
  label: 'Live Bridge sync',
  description: "Live Bridge (protocol 1): applies a plugin's whole model through the Live Bridge (see bridge-sync). Returns the import report.",
  group: 'document',
  palette: false,
  history: 'record',
  input: z.object({ key: z.string().min(1).max(300), app: z.string().max(60).default(''), model: z.unknown() }),
  run: (ctx, input) => {
    const model = parseModel(input.model);
    const report = runBridgeSync(ctx, { key: input.key, app: input.app || model.app || '', name: model.name || '', model, complete: true, deleted: [], changeId: null });
    return { ...report, created: report.built, removed: report.deleted + report.migrated };
  },
});

const bridgeOf = (doc: { bridge?: BridgeData }): BridgeData => {
  if (!doc.bridge) throw new CommandError('rejected', 'This project has no Live Bridge links');
  return doc.bridge;
};

export const bridgeResolve = defineMutation({
  id: 'bridge-resolve',
  label: 'Resolve Live Bridge conflict',
  description: "Resolves a Live Bridge conflict: `theirs` takes the app's version (for a deletion: deletes the element), `mine` keeps ArchAI's (for a deletion: keeps the element, no longer linked to that app).",
  group: 'document',
  palette: false,
  history: 'record',
  input: z.object({ conflict: z.string().min(1).max(64), take: z.enum(['theirs', 'mine']) }),
  run: (ctx, input) => {
    const bridge = bridgeOf(ctx.doc as { bridge?: BridgeData });
    const conflict = bridge.conflicts.find((c) => c.id === input.conflict);
    if (!conflict) throw new CommandError('rejected', 'That conflict is already resolved');
    bridge.conflicts = bridge.conflicts.filter((c) => c.id !== input.conflict);
    const element = ctx.doc.elements[conflict.element];
    const app = bridge.sources[conflict.source]?.app || 'the app';
    if (!element) {
      unbind(bridge, conflict.element, conflict.source);
      return { ok: true };
    }
    if (conflict.facet === 'delete') {
      if (input.take === 'theirs') {
        removeSubtree(ctx.doc, conflict.element);
        delete bridge.elements[conflict.element];
      } else unbind(bridge, conflict.element, conflict.source);
    } else if (input.take === 'theirs' && conflict.theirs && typeof conflict.theirs === 'object') {
      ctx.doc.elements[conflict.element] = withFacetValue(isDraft(element) ? current(element) : element, conflict.facet, conflict.theirs as Record<string, JsonValue>);
    }
    const binding = bridge.elements[conflict.element];
    const now = ctx.doc.elements[conflict.element];
    if (binding && now && conflict.facet !== 'delete') {
      const elements = isDraft(ctx.doc.elements) ? current(ctx.doc.elements) : ctx.doc.elements;
      binding.state[conflict.facet] = facetHashes(childLookup(elements), elements[conflict.element]!)[conflict.facet];
    }
    bridgeLog(ctx, conflict.source, `conflict on ${element.name ?? element.id} (${conflict.facet}): ${input.take === 'theirs' ? `took ${app}'s version` : "kept ArchAI's version"}`);
    return { ok: true };
  },
});

export const bridgeHeld = defineMutation({
  id: 'bridge-held',
  label: 'Confirm held deletions',
  description: 'Applies (apply: true) or discards (apply: false: the elements stay, unlinked from that app) deletions the Live Bridge held for confirmation.',
  group: 'document',
  palette: false,
  history: 'record',
  input: z.object({ id: z.string().min(1).max(64), apply: z.boolean() }),
  run: (ctx, input) => {
    const bridge = bridgeOf(ctx.doc as { bridge?: BridgeData });
    const held = bridge.held.find((h) => h.id === input.id);
    if (!held) throw new CommandError('rejected', 'Those deletions are no longer waiting');
    bridge.held = bridge.held.filter((h) => h.id !== input.id);
    let count = 0;
    for (const elementId of held.elements) {
      if (input.apply && ctx.doc.elements[elementId]) {
        removeSubtree(ctx.doc, elementId);
        count += 1;
      }
      unbind(bridge, elementId, held.source);
    }
    bridgeLog(ctx, held.source, input.apply ? `${count} held deletions applied` : `${held.elements.length} held deletions discarded (elements kept)`);
    return { deleted: count };
  },
});

export const bridgeSetSource = defineMutation({
  id: 'bridge-set-source',
  label: 'Live Bridge link settings',
  description: "Changes a connected app's link: mode (two-way, read-only: only receives, paused), what it receives (shared elements or nothing), and the default authority per facet (geometry, transform, material, metadata: origin, archai, shared or a source key) for the elements it created.",
  group: 'document',
  palette: false,
  history: 'record',
  input: z.object({
    key: z.string().min(1).max(300),
    mode: z.enum(BRIDGE_MODES).optional(),
    receives: z.enum(['shared', 'nothing']).optional(),
    authority: z.partialRecord(z.enum(BRIDGE_FACETS), BridgeOwnerSchema).optional(),
  }),
  run: (ctx, input) => {
    const source = bridgeOf(ctx.doc as { bridge?: BridgeData }).sources[input.key];
    if (!source) throw new CommandError('rejected', 'That app is not linked to this project');
    if (input.mode) source.mode = input.mode;
    if (input.receives) source.receives = input.receives;
    if (input.authority) source.authority = { ...source.authority, ...input.authority };
    return { ok: true };
  },
});

export const bridgeSetOwner = defineMutation({
  id: 'bridge-set-owner',
  label: 'Live Bridge authority',
  description: 'Sets who decides one facet (geometry, transform, material, metadata) of elements: origin, archai, shared or a source key; null returns to the source default.',
  group: 'document',
  palette: false,
  history: 'record',
  input: z.object({ ids: z.array(IdSchema).min(1), facet: z.enum(BRIDGE_FACETS), owner: BridgeOwnerSchema.nullable() }),
  run: (ctx, input) => {
    const bridge = ensureBridge(ctx);
    for (const id of input.ids) {
      if (!ctx.doc.elements[id]) continue;
      const binding = (bridge.elements[id] ??= { state: {}, refs: {} });
      const owners = { ...(binding.owners ?? {}) };
      if (input.owner === null) delete owners[input.facet];
      else owners[input.facet] = input.owner;
      if (Object.keys(owners).length) binding.owners = owners;
      else delete binding.owners;
    }
    return { ok: true };
  },
});

export const bridgeSetShare = defineMutation({
  id: 'bridge-set-share',
  label: 'Live Bridge sharing',
  description: 'Sets whether elements go to the other connected apps: shared (all), source-only (only the app they came from), archai-only (none).',
  group: 'document',
  palette: false,
  history: 'record',
  input: z.object({ ids: z.array(IdSchema).min(1), share: z.enum(BRIDGE_SHARES) }),
  run: (ctx, input) => {
    const bridge = ensureBridge(ctx);
    for (const id of input.ids) {
      if (!ctx.doc.elements[id]) continue;
      const binding = (bridge.elements[id] ??= { state: {}, refs: {} });
      binding.share = input.share;
    }
    return { ok: true };
  },
});

export const bridgeOffer = defineMutation({
  id: 'bridge-offer',
  label: 'Offer as editable copy',
  description: 'Offers elements to a connected app as editable copies, with the facets it may change (geometry, transform, material, metadata); an empty list makes them reference geometry again. The app creates them as its own objects and its edits come back to the same elements.',
  group: 'document',
  palette: false,
  history: 'record',
  input: z.object({ ids: z.array(IdSchema).min(1), key: z.string().min(1).max(300), facets: z.array(z.enum(BRIDGE_FACETS)) }),
  run: (ctx, input) => {
    const bridge = ensureBridge(ctx);
    if (!bridge.sources[input.key]) throw new CommandError('rejected', 'That app is not linked to this project');
    let count = 0;
    for (const id of input.ids) {
      if (!ctx.doc.elements[id]) continue;
      const binding = (bridge.elements[id] ??= { state: {}, refs: {} });
      const offers = { ...(binding.offers ?? {}) };
      if (input.facets.length) offers[input.key] = [...new Set(input.facets)];
      else delete offers[input.key];
      if (Object.keys(offers).length) binding.offers = offers;
      else delete binding.offers;
      count += 1;
    }
    bridgeLog(ctx, input.key, input.facets.length ? `${count} elements offered as editable copies (${input.facets.join(', ')})` : `${count} elements back to reference geometry`);
    return { offered: count };
  },
});

export const bridgeConvert = defineMutation({
  id: 'bridge-convert',
  label: 'Convert to ArchAI element',
  description: 'Turns elements that came from connected apps into native ArchAI elements: no longer updated by those apps (nor sent back to them), with where they came from kept as history.',
  group: 'document',
  palette: false,
  history: 'record',
  input: z.object({ ids: z.array(IdSchema).min(1) }),
  run: (ctx, input) => {
    const bridge = bridgeOf(ctx.doc as { bridge?: BridgeData });
    const at = Date.parse(ctx.now()) || Date.now();
    let count = 0;
    for (const id of input.ids) {
      const binding = bridge.elements[id];
      if (!binding || Object.keys(binding.refs).length === 0) continue;
      const history = [...(binding.history ?? [])];
      for (const [source, ref] of Object.entries(binding.refs)) history.push({ source, app: bridge.sources[source]?.app ?? '', id: ref.id, at });
      binding.history = history.slice(-20);
      binding.refs = {};
      delete binding.owners;
      bridge.conflicts = bridge.conflicts.filter((c) => c.element !== id);
      count += 1;
    }
    if (count) bridgeLog(ctx, 'archai', `${count} elements converted into ArchAI elements`);
    return { converted: count };
  },
});

export const bridgeForget = defineMutation({
  id: 'bridge-forget-source',
  label: 'Disconnect Live Bridge link',
  description: "Removes a connected app from the project. Its elements stay as ArchAI elements, no longer updated by it; the app's next sync links it again as new.",
  group: 'document',
  palette: false,
  history: 'record',
  input: z.object({ key: z.string().min(1).max(300) }),
  run: (ctx, input) => {
    const bridge = bridgeOf(ctx.doc as { bridge?: BridgeData });
    const source = bridge.sources[input.key];
    if (!source) throw new CommandError('rejected', 'That app is not linked to this project');
    const at = Date.parse(ctx.now()) || Date.now();
    for (const [elementId, binding] of Object.entries(bridge.elements)) {
      const ref = binding.refs[input.key];
      // Kept as history: the app still has its originals, so they are not sent back to it.
      if (ref) binding.history = [...(binding.history ?? []), { source: input.key, app: source.app, id: ref.id, at }].slice(-20);
      unbind(bridge, elementId, input.key);
    }
    bridge.conflicts = bridge.conflicts.filter((c) => c.source !== input.key);
    bridge.held = bridge.held.filter((h) => h.source !== input.key);
    delete bridge.sources[input.key];
    bridgeLog(ctx, input.key, `${source.app || 'App'} (${source.name}) disconnected; its elements stay in ArchAI`);
    return { ok: true };
  },
});

export const bridgeCommands = [bridgeSync, syncLiveLink, bridgeResolve, bridgeHeld, bridgeSetSource, bridgeSetOwner, bridgeSetShare, bridgeOffer, bridgeConvert, bridgeForget];

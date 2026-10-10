/**
 * Live Bridge data kept in the project (docs/live-bridge-proposal.md): the connected source
 * models, the binding graph between ArchAI elements and the objects in each app, property-level
 * authority, open conflicts, deletions waiting for confirmation and the sync log. Optional:
 * documents without a bridge load unchanged.
 */
import { z } from 'zod';

const JsonLike: z.ZodType<unknown> = z.unknown();
const Key = z.string().min(1).max(300);
const Hash = z.string().max(40);

export const BRIDGE_FACETS = ['geometry', 'transform', 'material', 'metadata'] as const;
export type BridgeFacet = (typeof BRIDGE_FACETS)[number];
const Facet = z.enum(BRIDGE_FACETS);
const FacetHashes = z.partialRecord(Facet, Hash);

/** `origin`: the app the element came from; `archai`: edits in ArchAI only; `shared`: nobody (concurrent changes conflict); else a source key. */
export const BridgeOwnerSchema = z.string().min(1).max(300);
export type BridgeOwner = 'origin' | 'archai' | 'shared' | (string & {});

export const BRIDGE_SHARES = ['shared', 'source-only', 'archai-only'] as const;
export type BridgeShare = (typeof BRIDGE_SHARES)[number];
export const BRIDGE_MODES = ['two-way', 'read-only', 'paused'] as const;
export type BridgeMode = (typeof BRIDGE_MODES)[number];
export const BRIDGE_FIDELITY = ['native', 'converted', 'reference', 'unsupported'] as const;
export type BridgeFidelity = (typeof BRIDGE_FIDELITY)[number];

export const BridgeSourceSchema = z.object({
  app: z.string().max(60),
  name: z.string().max(200),
  color: z.string().max(9),
  mode: z.enum(BRIDGE_MODES).default('two-way'),
  receives: z.enum(['shared', 'nothing']).default('shared'),
  authority: z.partialRecord(Facet, BridgeOwnerSchema).default({}),
  linkedAt: z.number(),
  lastSync: z.number().nullable().default(null),
  lastChangeId: z.string().max(100).nullable().default(null),
  /** The reply to the last change, sent again when the same change arrives twice. */
  lastAck: JsonLike.optional(),
  /** Protocol-2 plugins: whether the last push was a complete snapshot of the source model. */
  complete: z.boolean().default(true),
  unsupported: z.array(z.object({ id: z.string().max(200), kind: z.string().max(60), reason: z.string().max(300) })).default([]),
});
export type BridgeSource = z.infer<typeof BridgeSourceSchema>;

export const BridgeRefSchema = z.object({
  /** The object's id in that app. */
  id: z.string().min(1).max(200),
  /** Exchange collection it came in (walls, meshes, ...). */
  kind: z.string().max(40),
  role: z.enum(['origin', 'copy']),
  fidelity: z.enum(BRIDGE_FIDELITY),
  lossy: z.boolean().default(false),
  /** That app's facets as last received. */
  base: FacetHashes.default({}),
  /** Hash of its raw exchange item: unchanged items are skipped without rebuilding. */
  item: Hash.optional(),
  /** ArchAI's facets as that app last had them: what changed since is sent to it (where it is not the owner). */
  archai: FacetHashes.default({}),
  /** Where that app has it: plan matrix (a, b, c, d, e, f, mm) and elevation (mm). */
  placed: z.object({ m: z.array(z.number()).length(6), z: z.number() }).optional(),
  at: z.number(),
});
export type BridgeRef = z.infer<typeof BridgeRefSchema>;

export const BridgeBindingSchema = z.object({
  share: z.enum(BRIDGE_SHARES).optional(),
  owners: z.partialRecord(Facet, BridgeOwnerSchema).optional(),
  /** Apps offered this element as an editable copy, with the facets each may change. */
  offers: z.record(Key, z.array(Facet)).optional(),
  /** ArchAI's facets after the last sync: a different hash now means ArchAI changed it. */
  state: FacetHashes.default({}),
  /** Deleted in ArchAI (time): source syncs do not bring it back. */
  removed: z.number().optional(),
  refs: z.record(Key, BridgeRefSchema).default({}),
});
export type BridgeBinding = z.infer<typeof BridgeBindingSchema>;

export const BridgeConflictSchema = z.object({
  id: z.string().min(1).max(64),
  element: z.string().min(1).max(64),
  source: Key,
  facet: z.union([Facet, z.literal('delete')]),
  at: z.number(),
  /** The source's version of the facet (for "take theirs"). */
  theirs: JsonLike.optional(),
});
export type BridgeConflict = z.infer<typeof BridgeConflictSchema>;

export const BridgeHeldSchema = z.object({
  id: z.string().min(1).max(64),
  source: Key,
  elements: z.array(z.string().max(64)),
  at: z.number(),
});
export type BridgeHeld = z.infer<typeof BridgeHeldSchema>;

export const BridgeLogSchema = z.object({ at: z.number(), source: z.string().max(300), text: z.string().max(500) });
export type BridgeLogEntry = z.infer<typeof BridgeLogSchema>;

export const BridgeSchema = z.object({
  version: z.literal(1),
  sources: z.record(Key, BridgeSourceSchema).default({}),
  elements: z.record(z.string().max(64), BridgeBindingSchema).default({}),
  conflicts: z.array(BridgeConflictSchema).default([]),
  held: z.array(BridgeHeldSchema).default([]),
  log: z.array(BridgeLogSchema).default([]),
});
export type BridgeData = z.infer<typeof BridgeSchema>;

/**
 * Local working copies and the session record ("what was open, recent documents, where the
 * camera was"). Everything here is host storage, never part of the portable document file.
 */
import { z } from 'zod';

export const SESSION_KEY = 'session';
export const documentKey = (id: string): string => `doc:${id}`;
export const MAX_RECENT = 12;

export const RecentEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  updatedAt: z.string(),
  filePath: z.string().nullable(),
  /** Ships with the app (see persistence/example-project.ts): can't be removed from history, only reset. */
  builtin: z.boolean().optional(),
  /** An online project (src/cloud/projects.ts): this is the cached copy of server version `version`. */
  cloud: z
    .object({
      version: z.number().int().nonnegative(),
      role: z.enum(['owner', 'editor', 'viewer']),
      /** Edited on this device since the last upload (offline, or before the upload finished). */
      pending: z.boolean().optional(),
    })
    .optional(),
});
export type RecentEntry = z.infer<typeof RecentEntrySchema>;

export const SessionRecordSchema = z.object({
  version: z.literal(1),
  lastDocumentId: z.string().nullable(),
  recent: z.array(RecentEntrySchema),
  viewports: z.record(z.string(), z.object({ x: z.number(), y: z.number(), zoom: z.number() })),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const EMPTY_SESSION: SessionRecord = { version: 1, lastDocumentId: null, recent: [], viewports: {} };

export function parseSessionRecord(text: string | null): SessionRecord {
  if (!text) return EMPTY_SESSION;
  try {
    const parsed = SessionRecordSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : EMPTY_SESSION;
  } catch {
    return EMPTY_SESSION;
  }
}

export function touchRecent(record: SessionRecord, entry: RecentEntry): SessionRecord {
  const recent = [entry, ...record.recent.filter((r) => r.id !== entry.id)].slice(0, MAX_RECENT);
  return { ...record, lastDocumentId: entry.id, recent };
}

export function forgetRecent(record: SessionRecord, id: string): SessionRecord {
  const viewports = { ...record.viewports };
  delete viewports[id];
  return {
    ...record,
    recent: record.recent.filter((r) => r.id !== id),
    lastDocumentId: record.lastDocumentId === id ? null : record.lastDocumentId,
    viewports,
  };
}

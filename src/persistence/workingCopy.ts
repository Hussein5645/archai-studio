/**
 * The autosaved working copy of a document, split for speed: the document text without blob
 * bytes (`doc:<id>`, written on every edit) and each blob on its own (`blob:<id>:<blobId>`,
 * written once — blob ids are content hashes, so a stored blob never changes). Imported models
 * and images can be tens of megabytes; writing them with every edit froze the app.
 *
 * Files saved by the user (.AIR) stay one self-contained document (see ./serialize.ts).
 */
import type { ArchaiDocument } from '@/document';
import type { Platform } from '@/platform/types';
import { documentKey } from './session';

type Storage = Platform['storage'];

const blobPrefix = (docId: string): string => `blob:${docId}:`;
export const blobKey = (docId: string, blobId: string): string => `${blobPrefix(docId)}${blobId}`;

export class WorkingCopyStore {
  /** Blob ids already in storage, per document. */
  private readonly stored = new Map<string, Set<string>>();
  /** The blobs table last reconciled with storage, per document (skips the work while it is unchanged). */
  private readonly reconciled = new Map<string, ArchaiDocument['blobs']>();

  /** Saves run one at a time, so an older copy never lands after a newer one. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly storage: Storage) {}

  /** Writes new blobs, drops ones the document no longer has, then the document text. */
  save(doc: ArchaiDocument): Promise<void> {
    const run = this.queue.then(() => this.write(doc));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(doc: ArchaiDocument): Promise<void> {
    if (this.reconciled.get(doc.id) !== doc.blobs) {
      const stored = this.stored.get(doc.id) ?? new Set(await this.storedIds(doc.id));
      this.stored.set(doc.id, stored);
      for (const blob of Object.values(doc.blobs)) {
        if (stored.has(blob.id)) continue;
        await this.storage.set(blobKey(doc.id, blob.id), blob.data);
        stored.add(blob.id);
      }
      for (const id of [...stored]) {
        if (doc.blobs[id]) continue;
        await this.storage.delete(blobKey(doc.id, id));
        stored.delete(id);
      }
      this.reconciled.set(doc.id, doc.blobs);
    }
    await this.storage.set(documentKey(doc.id), workingCopyText(doc));
  }

  /**
   * The stored working copy as plain document data (blob bytes filled back in), ready for
   * parseDocumentData; null when there is none. Older copies with inline bytes load as they are.
   */
  async load(id: string): Promise<unknown> {
    const text = await this.storage.get(documentKey(id));
    if (!text) return null;
    const raw: unknown = JSON.parse(text);
    const blobs = (raw as { blobs?: Record<string, { data?: unknown }> } | null)?.blobs;
    const present = new Set<string>();
    if (blobs && typeof blobs === 'object') {
      await Promise.all(
        Object.entries(blobs).map(async ([blobId, blob]) => {
          if (!blob || typeof blob !== 'object') return;
          if (blob.data === '') {
            const data = await this.storage.get(blobKey(id, blobId));
            if (data === null) return;
            blob.data = data;
          }
          present.add(blobId);
        }),
      );
    }
    // Inline blobs of an older copy are not in storage yet: the next save writes them out.
    this.stored.set(id, new Set((await this.storedIds(id)).filter((blobId) => present.has(blobId))));
    this.reconciled.delete(id);
    return raw;
  }

  /** Removes a working copy and its blobs. */
  async delete(id: string): Promise<void> {
    await this.storage.delete(documentKey(id));
    for (const blobId of await this.storedIds(id)) await this.storage.delete(blobKey(id, blobId));
    this.stored.delete(id);
    this.reconciled.delete(id);
  }

  private async storedIds(docId: string): Promise<string[]> {
    const prefix = blobPrefix(docId);
    return (await this.storage.keys(prefix)).map((key) => key.slice(prefix.length));
  }
}

/** The document as JSON with every blob's bytes left out (they live under their own keys). */
export function workingCopyText(doc: ArchaiDocument): string {
  const blobs: Record<string, unknown> = {};
  for (const [id, blob] of Object.entries(doc.blobs)) blobs[id] = { ...blob, data: '' };
  return JSON.stringify({ ...doc, blobs });
}

import { describe, expect, it, vi } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { parseDocumentData, serializeDocument } from './serialize';
import { documentKey } from './session';
import { blobKey, WorkingCopyStore } from './workingCopy';

const BYTES = 'Z2xURgIAAAA='.repeat(1000);

function appWithModel() {
  const app = createTestApp();
  const id = run<string>(app, 'create-mesh-element', { name: 'Car', glb: BYTES, x: 0, y: 0, size: [4000, 2000, 1500] });
  return { app, id };
}

describe('working copy storage', () => {
  it('keeps blob bytes out of the document text, writes each blob once and reads them back', async () => {
    const { app, id } = appWithModel();
    const store = new WorkingCopyStore(app.platform.storage);
    const set = vi.spyOn(app.platform.storage, 'set');
    const doc = () => app.store.getState().doc;
    const blobId = Object.keys(doc().blobs)[0]!;
    await store.save(doc());
    const text = app.platform.storageMap.get(documentKey(doc().id))!;
    expect(text).not.toContain(BYTES);
    expect(app.platform.storageMap.get(blobKey(doc().id, blobId))).toBe(BYTES);

    set.mockClear();
    run(app, 'move-selection', { ids: [id], dx: 100, dy: 0 });
    await store.save(doc());
    expect(set.mock.calls.map(([key]) => key)).toEqual([documentKey(doc().id)]);

    const parsed = parseDocumentData(await new WorkingCopyStore(app.platform.storage).load(doc().id));
    expect(parsed.ok && parsed.document).toEqual(doc());
  });

  it('drops the blobs a document no longer has', async () => {
    const { app } = appWithModel();
    const store = new WorkingCopyStore(app.platform.storage);
    const doc = app.store.getState().doc;
    const key = blobKey(doc.id, Object.keys(doc.blobs)[0]!);
    await store.save(doc);
    expect(app.platform.storageMap.has(key)).toBe(true);
    await store.save({ ...doc, elements: {}, blobs: {} });
    expect(app.platform.storageMap.has(key)).toBe(false);
  });

  it('opens an older working copy with the bytes inline, and forgets a copy with its blobs', async () => {
    const { app } = appWithModel();
    const doc = app.store.getState().doc;
    app.platform.storageMap.set(documentKey(doc.id), serializeDocument(doc));
    const store = new WorkingCopyStore(app.platform.storage);
    const parsed = parseDocumentData(await store.load(doc.id));
    expect(parsed.ok && parsed.document).toEqual(doc);
    await store.save(doc);
    expect(app.platform.storageMap.get(blobKey(doc.id, Object.keys(doc.blobs)[0]!))).toBe(BYTES);
    await store.delete(doc.id);
    expect([...app.platform.storageMap.keys()].filter((key) => key.includes(doc.id))).toEqual([]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { parseDocumentData, serializeDocument } from './serialize';
import { documentKey } from './session';
import { backupKey, blobKey, WorkingCopyStore } from './workingCopy';

const BYTES = 'Z2xURgIAAAA='.repeat(1000);

function appWithModel() {
  const app = createTestApp();
  const id = run<string>(app, 'create-mesh-element', { name: 'Car', glb: BYTES, x: 0, y: 0, size: [4000, 2000, 1500] });
  return { app, id };
}

describe('working copy storage', () => {
  it('refuses a working copy whose stored geometry bytes are missing', async () => {
    const { app } = appWithModel();
    const store = new WorkingCopyStore(app.platform.storage);
    const doc = app.store.getState().doc;
    await store.save(doc);
    await app.platform.storage.delete(blobKey(doc.id, Object.keys(doc.blobs)[0]!));
    await expect(store.load(doc.id)).rejects.toThrow('Project data is missing');
  });
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
    expect(set.mock.calls.map(([key]) => key)).toEqual([backupKey(doc().id), documentKey(doc().id)]);

    const parsed = parseDocumentData(await new WorkingCopyStore(app.platform.storage).load(doc().id));
    expect(parsed.ok && parsed.document).toEqual(doc());
  });

  it('retains previous geometry for recovery, then collects it after the next save', async () => {
    const { app } = appWithModel();
    const store = new WorkingCopyStore(app.platform.storage);
    const doc = app.store.getState().doc;
    const key = blobKey(doc.id, Object.keys(doc.blobs)[0]!);
    await store.save(doc);
    expect(app.platform.storageMap.has(key)).toBe(true);
    await store.save({ ...doc, elements: {}, blobs: {} });
    expect(app.platform.storageMap.has(key)).toBe(true);
    await store.save({ ...doc, elements: {}, blobs: {} });
    expect(app.platform.storageMap.has(key)).toBe(false);
  });

  it('leaves the last committed model intact when writing a replacement fails', async () => {
    const { app } = appWithModel();
    const store = new WorkingCopyStore(app.platform.storage);
    const doc = app.store.getState().doc;
    await store.save(doc);
    const original = app.platform.storage.set;
    vi.spyOn(app.platform.storage, 'set').mockImplementation(async (key, value) => {
      if (key === documentKey(doc.id)) throw new Error('Disk full');
      await original(key, value);
    });
    await expect(store.save({ ...doc, elements: {}, blobs: {} })).rejects.toThrow('Disk full');
    expect(parseDocumentData(await new WorkingCopyStore(app.platform.storage).load(doc.id))).toMatchObject({ ok: true, document: doc });
  });

  it('recovers malformed or incomplete latest saves from the previous copy', async () => {
    const { app, id } = appWithModel();
    const store = new WorkingCopyStore(app.platform.storage);
    const doc = app.store.getState().doc;
    await store.save(doc);
    run(app, 'move-selection', { ids: [id], dx: 100, dy: 0 });
    await store.save(app.store.getState().doc);
    app.platform.storageMap.set(documentKey(doc.id), '{broken');
    const recovered = new WorkingCopyStore(app.platform.storage);
    expect(parseDocumentData(await recovered.load(doc.id))).toMatchObject({ ok: true, document: doc });
    // Saving after recovery must preserve the healthy backup and its geometry.
    await recovered.save({ ...doc, elements: {}, blobs: {} });
    app.platform.storageMap.set(documentKey(doc.id), '{}');
    expect(parseDocumentData(await new WorkingCopyStore(app.platform.storage).load(doc.id))).toMatchObject({ ok: true, document: doc });
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

  it('recovers the previous geometry when a newer saved model has missing bytes', async () => {
    const { app } = appWithModel();
    const store = new WorkingCopyStore(app.platform.storage);
    const previous = app.store.getState().doc;
    await store.save(previous);
    run(app, 'create-mesh-element', { name: 'New model', glb: 'AQIDBA==', x: 0, y: 0, size: [1000, 1000, 1000] });
    const next = app.store.getState().doc;
    await store.save(next);
    const newBlob = Object.keys(next.blobs).find(id => !previous.blobs[id])!;
    await app.platform.storage.delete(blobKey(next.id, newBlob));
    expect(parseDocumentData(await new WorkingCopyStore(app.platform.storage).load(next.id))).toMatchObject({ ok: true, document: previous });
  });
});

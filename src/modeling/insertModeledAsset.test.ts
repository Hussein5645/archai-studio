import { describe, expect, it, vi } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { createCaiPackage } from '@/catalog/builder';
import { PersistenceService } from '@/persistence/service';
import { insertModeledAsset } from './insertModeledAsset';
import type { InsertModeledAssetMsg } from './projectSync';

function setup() {
  const app = createTestApp();
  run(app, 'new-document', { name: 'Linked project' });
  const persistence = new PersistenceService(app.store, app.executor, app.platform);
  vi.spyOn(app.catalog, 'fetchImage').mockResolvedValue({ mime: 'image/png', bytes: new Uint8Array([1, 2, 3]), width: 1, height: 1 });
  const bytes = createCaiPackage({
    metadata: { caiVersion: 1, id: 'linked-chair', name: 'Chair', category: 'Furnish/Seating', kind: 'asset', size: { width: 500, height: 500 } },
    topView: { name: 'top.png', bytes: new Uint8Array([1, 2, 3]) },
    modelGlb: { name: 'model.glb', bytes: new Uint8Array([4, 5, 6]) },
  });
  const message: InsertModeledAssetMsg = { type: 'INSERT_MODELED_ASSET', projectId: app.store.getState().doc.id, assetId: 'linked-chair', name: 'Chair', caiBytes: bytes, position: { x: 100, y: 200, elevation: 900 } };
  return { app, services: { ...app, persistence }, message };
}

describe('modeled asset delivery', () => {
  it('serializes repeated sends and saves one placement with its elevation', async () => {
    const { app, services, message } = setup();
    await Promise.all([insertModeledAsset(services, message), insertModeledAsset(services, message)]);
    const instances = Object.values(app.store.getState().doc.elements).filter(e => e.kind === 'instance');
    expect(instances).toHaveLength(1);
    expect(instances[0]?.meta?.['solid']).toEqual({ elevation: 900 });
    const saved = await services.persistence.loadStored(message.projectId);
    expect(Object.values(saved!.elements).filter(e => e.kind === 'instance')).toHaveLength(1);
  });

  it('refuses failed package writes without placing a model or reporting success', async () => {
    const { app, services, message } = setup();
    vi.spyOn(app.catalog, 'addLocalPackage').mockRejectedValue(new Error('Disk full'));
    await expect(insertModeledAsset(services, message)).rejects.toThrow('Disk full');
    expect(Object.values(app.store.getState().doc.elements).filter(e => e.kind === 'instance')).toHaveLength(0);
  });

  it('does not turn a failed update into an extra placement', async () => {
    const { app, services, message } = setup();
    await insertModeledAsset(services, message);
    vi.spyOn(app.catalog, 'fetchImage').mockRejectedValueOnce(new Error('Image read failed'));
    await expect(insertModeledAsset(services, message)).rejects.toThrow('Image read failed');
    expect(Object.values(app.store.getState().doc.elements).filter(e => e.kind === 'instance')).toHaveLength(1);
  });

  it('updates an older package identity without creating another instance', async () => {
    const { app, services, message } = setup();
    await insertModeledAsset(services, message);
    const bytes = createCaiPackage({
      metadata: { caiVersion: 1, id: 'stable-workspace', name: 'Renamed chair', category: 'Personal/My Assets', kind: 'asset', size: { width: 600, height: 600 } },
      topView: { name: 'top.png', bytes: new Uint8Array([1, 2, 3]) },
      modelGlb: { name: 'model.glb', bytes: new Uint8Array([4, 5, 6]) },
    });
    await insertModeledAsset(services, { ...message, caiBytes: bytes, previousPackageKey: 'local:linked-chair.cai' });
    expect(Object.values(app.store.getState().doc.elements).filter(e => e.kind === 'instance')).toHaveLength(1);
  });

  it('does not apply an in-flight send to a different project', async () => {
    const { app, services, message } = setup();
    const original = app.catalog.addLocalPackage!.bind(app.catalog);
    vi.spyOn(app.catalog, 'addLocalPackage').mockImplementation(async bytes => {
      const asset = await original(bytes);
      run(app, 'new-document', { name: 'Other project' });
      return asset;
    });
    await expect(insertModeledAsset(services, message)).rejects.toThrow('Open the linked project');
    expect(Object.values(app.store.getState().doc.elements).filter(e => e.kind === 'instance')).toHaveLength(0);
  });
});

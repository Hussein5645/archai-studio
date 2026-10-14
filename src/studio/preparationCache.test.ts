import { describe, expect, it } from 'vitest';
import type { Platform } from '@/platform/types';
import { loadPreparation, savePreparation } from './preparationCache';

function memory() {
  const values = new Map<string, string>();
  const storage: Platform['storage'] = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
    keys: async (prefix) => [...values.keys()].filter((key) => key.startsWith(prefix)),
  };
  return { values, storage };
}
describe('saved VR preparation', () => {
  it('restores bytes across storage instances and keeps projects and output kinds separate', async () => {
    const { values, storage } = memory();
    const bytes = Uint8Array.from({ length: 900_000 }, (_, i) => i % 251).buffer;
    const metadata = {
      docId: 'project1',
      output: 'baked' as const,
      signature: 'scene:light',
      lightScale: 3,
    };
    await savePreparation(storage, metadata, bytes);
    const restored = await loadPreparation({ ...storage }, 'project1', 'baked');
    expect(restored?.bytes).toEqual(bytes);
    expect(restored?.metadata).toMatchObject(metadata);
    expect(await loadPreparation(storage, 'project2', 'baked')).toBeNull();
    expect(await loadPreparation(storage, 'project1', 'panorama')).toBeNull();
    const count = values.size;
    await savePreparation(storage, { ...metadata, signature: 'updated' }, bytes);
    expect(values.size).toBe(count);
  });
  it('preserves the previous completed bake if committing its replacement fails', async () => {
    const { storage } = memory();
    const metadata = { docId: 'project', output: 'baked' as const, signature: 'old' };
    await savePreparation(storage, metadata, new Uint8Array([1, 2, 3]).buffer);
    const failed = {
      ...storage,
      set: async (key: string, value: string) => {
        if (key === 'vr-prepared:project:baked') throw new Error('Disk full');
        await storage.set(key, value);
      },
    };
    await expect(
      savePreparation(failed, { ...metadata, signature: 'new' }, new Uint8Array([4]).buffer),
    ).rejects.toThrow('Disk full');
    expect((await loadPreparation(storage, 'project', 'baked'))?.metadata.signature).toBe('old');
    expect(new Uint8Array((await loadPreparation(storage, 'project', 'baked'))!.bytes)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(await storage.keys('vr-prepared:project:baked')).toHaveLength(2);
  });
  it('rejects a missing chunk rather than showing a partially saved model', async () => {
    const { storage } = memory();
    await savePreparation(
      storage,
      { docId: 'project', output: 'panorama', signature: 'scene' },
      new Uint8Array([1]).buffer,
    );
    const keys = await storage.keys('vr-prepared:project:panorama:');
    await storage.delete(keys[0]!);
    await expect(loadPreparation(storage, 'project', 'panorama')).rejects.toThrow('incomplete');
  });
});

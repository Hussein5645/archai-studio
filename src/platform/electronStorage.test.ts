import { expect, it } from 'vitest';
import { IPC, type ArchaiBridge } from '@shared/ipc';
import { electronStorage } from './electronStorage';

function fixture() {
  const disk = new Map<string, string>();
  let fail = false;
  const bridge = {
    invoke: async (channel: string, payload: { key: string; value: string; prefix: string }) => {
      if (channel === IPC.storageGet) return disk.get(payload.key) ?? null;
      if (channel === IPC.storageSet) {
        if (fail && payload.key.startsWith('__large_storage__')) throw new Error('disk full');
        disk.set(payload.key, payload.value);
      }
      if (channel === IPC.storageDelete) disk.delete(payload.key);
      if (channel === IPC.storageKeys)
        return [...disk.keys()].filter((key) => key.startsWith(payload.prefix));
    },
  } as unknown as ArchaiBridge;
  return {
    disk,
    storage: electronStorage(bridge, 4),
    fail: () => {
      fail = true;
    },
  };
}
it('round-trips large values through bounded chunks and removes old chunks on replacement and deletion', async () => {
  const { disk, storage } = fixture();
  const value = 'model🙂data0123456789';
  await storage.set('blob', value);
  expect(await storage.get('blob')).toBe(value);
  expect(await storage.keys('')).toEqual(['blob']);
  expect([...disk].filter(([key]) => key !== 'blob').every(([, value]) => value.length <= 4)).toBe(
    true,
  );
  await storage.set('blob', 'tiny');
  expect(await storage.get('blob')).toBe('tiny');
  expect(disk.size).toBe(1);
  await storage.set('blob', value);
  await storage.delete('blob');
  expect(disk.size).toBe(0);
});
it('keeps the previous value if a chunk write fails and detects missing chunks', async () => {
  const { disk, storage, fail } = fixture();
  await storage.set('blob', 'old');
  fail();
  await expect(storage.set('blob', 'new large model')).rejects.toThrow('disk full');
  expect(await storage.get('blob')).toBe('old');
  const other = fixture();
  await other.storage.set('blob', 'large model');
  other.disk.delete([...other.disk.keys()].find((key) => key !== 'blob')!);
  await expect(other.storage.get('blob')).rejects.toThrow('missing');
  expect(disk.size).toBe(1);
});
it('serializes concurrent replacements without leaving obsolete chunks', async () => {
  const { disk, storage } = fixture();
  await Promise.all([storage.set('blob', 'first model'), storage.set('blob', 'second model')]);
  expect(await storage.get('blob')).toBe('second model');
  expect(disk.size).toBe(4);
});

import { expect, it, vi } from 'vitest';
import { fakePlatform } from '@/test/harness';
import { createLocalCaiStore } from './local-store';

it('keeps the previous package when replacing its saved bytes fails', async () => {
  const platform = fakePlatform();
  const store = createLocalCaiStore(platform);
  const previous = new Uint8Array([1, 2, 3]);
  await store.savePackage('chair', previous);
  vi.spyOn(platform.storage, 'set').mockRejectedValue(new Error('Disk full'));
  await expect(store.savePackage('chair', new Uint8Array([4, 5, 6]))).rejects.toThrow('Disk full');
  expect(await store.getPackage('chair')).toEqual(previous);
  expect(await createLocalCaiStore(platform).getPackage('chair')).toEqual(previous);
});

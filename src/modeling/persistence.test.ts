import { afterEach, expect, it, vi } from 'vitest';
import { modelingStorage, snapshotOf } from './persistence';
import { modelingStore } from './store';

afterEach(() => vi.unstubAllGlobals());

function transactionFixture() {
  const tx = { objectStore: () => ({ put: () => ({ result: 'saved' }) }), error: null,
    oncomplete: () => {}, onabort: () => {}, onerror: () => {} };
  const close = vi.fn();
  vi.stubGlobal('indexedDB', { open: () => {
    const request = { result: { transaction: () => tx, close }, onsuccess: () => {} };
    queueMicrotask(() => request.onsuccess());
    return request;
  } });
  return { tx, close };
}

it('reports a model save only after the IndexedDB transaction commits', async () => {
  const { tx, close } = transactionFixture();
  const complete = vi.fn();
  const saving = modelingStorage.save(snapshotOf('model', modelingStore.getState())).then(complete);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(complete).not.toHaveBeenCalled();
  tx.oncomplete();
  await saving;
  expect(complete).toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
});

it('rejects a model save when its transaction aborts', async () => {
  const { tx, close } = transactionFixture();
  const saving = modelingStorage.save(snapshotOf('model', modelingStore.getState()));
  const rejected = expect(saving).rejects.toThrow('aborted');
  await new Promise(resolve => setTimeout(resolve, 0));
  tx.onabort();
  await rejected;
  expect(close).toHaveBeenCalled();
});

import { expect, it, vi } from 'vitest';
import type { ArchaiBridge } from '@shared/ipc';
import { electronStudio } from './electronStudio';

it('sends large model references and restores blob data before delivering a scene to the studio', async () => {
  const data = 'A'.repeat(9 * 1024 * 1024);
  const disk = new Map<string, string>();
  let receive: (value: unknown) => void = () => {};
  let sent: unknown;
  const bridge = {
    onStudio: (listener: (value: unknown) => void) => {
      receive = listener;
      return () => {};
    },
    invoke: async (_channel: string, value: unknown) => {
      sent = value;
    },
  } as unknown as ArchaiBridge;
  const studio = electronStudio(bridge, {
    get: async (key) => disk.get(key) ?? null,
    set: async (key, value) => {
      disk.set(key, value);
    },
    delete: async (key) => {
      disk.delete(key);
    },
    keys: async () => [...disk.keys()],
  })!;
  const listener = vi.fn();
  studio.subscribe(listener);
  const doc = { id: 'test', blobs: { model: { id: 'model', mime: 'model/gltf-binary', data } } };
  studio.send({ type: 'scene', doc });
  await vi.waitFor(() => expect(sent).toBeDefined());
  expect(sent).toEqual({
    type: 'scene',
    doc: { ...doc, blobs: { model: { ...doc.blobs.model, data: '' } } },
    nativeBlobKeys: { model: 'blob:test:model' },
  });
  expect(doc.blobs.model.data).toBe(data);
  receive(sent);
  await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
  expect(listener.mock.calls[0]![0].doc.blobs.model.data).toBe(data);
});

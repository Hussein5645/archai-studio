import { IPC, type ArchaiBridge } from '@shared/ipc';
import type { Platform } from './types';
type Message = { type: string } & Record<string, unknown>;

/** Relay scene metadata through IPC; large immutable blobs travel through chunked storage. */
export function electronStudio(
  bridge: ArchaiBridge,
  storage: Platform['storage'],
): Platform['studio'] {
  if (!bridge.onStudio) return null;
  let queue = Promise.resolve();
  return {
    send(message) {
      queue = queue
        .then(async () => {
          let outgoing = message;
          const doc = message['doc'] as
            { id: string; blobs?: Record<string, { data?: string }> } | undefined;
          if (message.type === 'scene' && doc?.blobs) {
            const blobs = { ...doc.blobs };
            const nativeBlobKeys: Record<string, string> = {};
            for (const [id, blob] of Object.entries(blobs)) {
              if (!blob.data || blob.data.length <= 8 * 1024 * 1024) continue;
              const key = `blob:${doc.id}:${id}`;
              await storage.set(key, blob.data);
              nativeBlobKeys[id] = key;
              blobs[id] = { ...blob, data: '' };
            }
            outgoing = { ...message, doc: { ...doc, blobs }, nativeBlobKeys };
          }
          await bridge.invoke(IPC.studioSend, outgoing);
        })
        .catch((error: unknown) =>
          console.error('Could not send the project to Render Studio', error),
        );
    },
    subscribe(listener) {
      let receiving = Promise.resolve();
      let active = true;
      const unsubscribe = bridge.onStudio!((value) => {
        if (!value || typeof value !== 'object' || typeof (value as Message).type !== 'string')
          return;
        receiving = receiving
          .then(async () => {
          const message = { ...value as Message };
            const refs = message['nativeBlobKeys'] as Record<string, string> | undefined;
            const doc = message['doc'] as
              { id: string; blobs: Record<string, { data?: string }> } | undefined;
            if (message.type === 'scene' && refs && doc) {
              const blobs = { ...doc.blobs };
              for (const [id, key] of Object.entries(refs)) {
                if (key !== `blob:${doc.id}:${id}` || !blobs[id])
                  throw new Error('Invalid Render Studio model reference');
                const data = await storage.get(key);
                if (data === null) throw new Error('Render Studio model data is missing');
                blobs[id] = { ...blobs[id], data };
              }
              message['doc'] = { ...doc, blobs };
            }
            if (active) listener(message);
          })
          .catch((error: unknown) =>
            console.error('Could not load the project in Render Studio', error),
          );
      });
      return () => {
        active = false;
        unsubscribe();
      };
    },
  };
}

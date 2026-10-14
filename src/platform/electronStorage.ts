import { IPC, type ArchaiBridge } from '@shared/ipc';
import type { Platform } from './types';

const MARKER = 'ARCHAI_CHUNKED_STORAGE_V1\n';
const PREFIX = '__large_storage__:';

/** Keep large embedded models out of a single Electron IPC message. */
export function electronStorage(
  bridge: ArchaiBridge,
  chunkSize = 8 * 1024 * 1024,
): Platform['storage'] {
  const pending = new Map<string, Promise<void>>();
  const serial = (key: string, run: () => Promise<void>) => {
    const job = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
    pending.set(key, job);
    const cleanup = () => {
      if (pending.get(key) === job) pending.delete(key);
    };
    void job.then(cleanup, cleanup);
    return job;
  };
  const read = (key: string) => bridge.invoke<string | null>(IPC.storageGet, { key });
  const write = (key: string, value: string) => bridge.invoke<void>(IPC.storageSet, { key, value });
  const remove = (key: string) => bridge.invoke<void>(IPC.storageDelete, { key });
  const manifest = (text: string | null): string[] | null => {
    if (!text?.startsWith(MARKER)) return null;
    const keys: unknown = JSON.parse(text.slice(MARKER.length));
    if (
      !Array.isArray(keys) ||
      !keys.every((key) => typeof key === 'string' && key.startsWith(PREFIX))
    )
      throw new Error('The large project storage record is invalid.');
    return keys as string[];
  };
  return {
    async get(key) {
      await pending.get(key)?.catch(() => undefined);
      const text = await read(key);
      const keys = manifest(text);
      if (!keys) return text;
      const parts: string[] = [];
      for (const chunk of keys) {
        const value = await read(chunk);
        if (value === null) throw new Error('A saved project data chunk is missing.');
        parts.push(value);
      }
      return parts.join('');
    },
    async set(key, value) {
      return serial(key, async () => {
        const old = manifest(await read(key));
        const created: string[] = [];
        try {
          if (value.length <= chunkSize) await write(key, value);
          else {
            const id = crypto.randomUUID();
            for (let offset = 0; offset < value.length; offset += chunkSize) {
              const chunk = `${PREFIX}${id}:${created.length}`;
              created.push(chunk);
              await write(chunk, value.slice(offset, offset + chunkSize));
            }
            // The logical record changes only after every chunk is safely written.
            await write(key, MARKER + JSON.stringify(created));
          }
        } catch (error) {
          for (const chunk of created) await remove(chunk).catch(() => undefined);
          throw error;
        }
        if (old) for (const chunk of old) await remove(chunk).catch(() => undefined);
      });
    },
    async delete(key) {
      return serial(key, async () => {
        const old = manifest(await read(key));
        await remove(key);
        if (old) for (const chunk of old) await remove(chunk).catch(() => undefined);
      });
    },
    async keys(prefix) {
      return (await bridge.invoke<string[]>(IPC.storageKeys, { prefix })).filter(
        (key) => !key.startsWith(PREFIX),
      );
    },
  };
}

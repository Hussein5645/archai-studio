import type { D5ConvertedScene, D5Progress } from '@shared/d5';
import type { D5FolderResult, D5ResourceResult } from '@shared/ipc';

/** Convert outside the app window; transfer binary buffers instead of copying model payloads. */
export function convertD5InWorker(
  folder: D5FolderResult,
  readFiles: (names: string[]) => Promise<D5ResourceResult[]>,
  progress: (value: D5Progress) => void,
  signal: AbortSignal,
): Promise<D5ConvertedScene> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./d5Convert.worker.ts', import.meta.url), {
      type: 'module',
    });
    const cleanup = () => {
      worker.terminate();
      signal.removeEventListener('abort', cancel);
    };
    const cancel = () => {
      cleanup();
      reject(new DOMException('Import cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = async (
      event: MessageEvent<{
        names?: string[];
        progress?: D5Progress;
        scene?: D5ConvertedScene;
        error?: string;
      }>,
    ) => {
      if (signal.aborted) return;
      if (event.data.names) {
        try {
          const files = await readFiles(event.data.names);
          if (!signal.aborted)
            worker.postMessage(
              { files },
              files.map((file) => file.bytes.buffer),
            );
        } catch (error) {
          if (!signal.aborted)
            worker.postMessage({ error: error instanceof Error ? error.message : String(error) });
        }
      } else if (event.data.progress) progress(event.data.progress);
      else if (event.data.scene) {
        cleanup();
        resolve(event.data.scene);
      } else if (event.data.error) {
        cleanup();
        reject(new Error(event.data.error));
      }
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message));
    };
    worker.postMessage(
      { folder },
      folder.files.map((file) => file.bytes.buffer),
    );
  });
}

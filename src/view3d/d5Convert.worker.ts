import { convertD5FolderAsync } from '@shared/d5';
import type { D5FolderResult, D5ResourceResult } from '@shared/ipc';

let supply: ((files: D5ResourceResult[]) => void) | null = null;
let fail: ((error: Error) => void) | null = null;
self.onmessage = async (
  event: MessageEvent<{ folder?: D5FolderResult; files?: D5ResourceResult[]; error?: string }>,
) => {
  if (event.data.files) {
    supply?.(event.data.files);
    return;
  }
  if (event.data.error) {
    fail?.(new Error(event.data.error));
    return;
  }
  if (!event.data.folder) return;
  try {
    const scene = await convertD5FolderAsync(
      event.data.folder,
      (names) =>
        new Promise((resolve, reject) => {
          supply = resolve;
          fail = reject;
          self.postMessage({ names });
        }),
      (progress) => self.postMessage({ progress }),
    );
    self.postMessage({ scene }, { transfer: [scene.glb.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    supply = null;
    fail = null;
  }
};

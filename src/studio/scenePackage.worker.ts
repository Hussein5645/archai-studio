import { zipSync } from 'fflate';

self.onmessage = (event: MessageEvent<Record<string, Uint8Array<ArrayBuffer>>>) => {
  try {
    const bytes = zipSync(event.data, { level: 1 });
    self.postMessage({ bytes }, { transfer: [bytes.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};

import { simplifyMesh, type SimplifyInput } from './simplifyMesh';

self.onmessage = async (event: MessageEvent<SimplifyInput>) => {
  try {
    const result = await simplifyMesh(event.data);
    self.postMessage(
      { result },
      {
        transfer: [
          result.positions.buffer,
          result.indices.buffer,
          ...result.attributes.map((a) => a.values.buffer),
        ],
      },
    );
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};

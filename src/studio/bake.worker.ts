import { traceBake, type BakeInput } from './bakeTrace';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<BakeInput>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
scope.onmessage = (event) => {
  try {
    const colors = traceBake(event.data, (progress) => scope.postMessage({ progress }));
    scope.postMessage({ colors }, [colors.buffer]);
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KernelRequest, KernelResponse } from './protocol';
import { KernelClient } from './client';
import { identityPlacement, type Body, type MeshData } from './types';

const body: Body = {
  id: 'body-1',
  name: 'Body 1',
  visible: true,
  lowLod: false,
  material: 'matte-grey',
  placement: identityPlacement(),
  features: [],
};

const mesh: MeshData = {
  positions: new Float32Array(),
  normals: new Float32Array(),
  indices: new Uint32Array(),
  faceIds: new Uint32Array(),
  runs: [],
  groups: [],
  triangles: 0,
  volume: 0,
  bounds: { min: [0, 0, 0], max: [0, 0, 0] },
};

class RecoveringWorker {
  static starts = 0;
  onmessage: ((event: MessageEvent<KernelResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly generation = RecoveringWorker.starts++;

  postMessage(request: KernelRequest): void {
    if (request.type !== 'evaluate') return;
    if (this.generation === 0) {
      this.onerror?.({ message: 'WASM trap', preventDefault: vi.fn(), filename: '', lineno: 0, colno: 0 } as unknown as ErrorEvent);
      return;
    }
    this.onmessage?.({ data: { type: 'result', requestId: request.requestId, bodyId: request.body.id, mesh, ms: 2 } } as MessageEvent<KernelResponse>);
  }

  terminate(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  RecoveringWorker.starts = 0;
});

describe('KernelClient recovery', () => {
  it('restarts the worker once and replays an evaluation after a crash', async () => {
    vi.stubGlobal('Worker', RecoveringWorker);
    const client = new KernelClient();

    await expect(client.evaluate(body, { sketches: {} })).resolves.toBe(mesh);
    expect(RecoveringWorker.starts).toBe(2);
    expect(client.stats.evaluations).toBe(1);
    client.dispose();
  });
});

/**
 * The solid kernel's Web Worker: loads the Manifold WASM once, then evaluates bodies as they
 * arrive and posts their meshes back with the buffers transferred. Requests are handled in
 * order; the client (./client.ts) keeps at most one request per body in flight, so a body
 * dragged around never queues up stale work here.
 */
import Module, { type ManifoldToplevel } from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { evaluateBody, FeatureError, KernelCache } from './evaluate';
import { meshOf, transferables } from './mesh';
import type { KernelRequest, KernelResponse } from './protocol';

const post = (message: KernelResponse, transfer: ArrayBuffer[] = []) => self.postMessage(message, { transfer });

const cache = new KernelCache();
let wasm: ManifoldToplevel | null = null;

const started = performance.now();
const ready = Module({ locateFile: () => wasmUrl })
  .then((toplevel) => {
    toplevel.setup();
    wasm = toplevel;
    post({ type: 'ready', initMs: performance.now() - started });
  })
  .catch((error: unknown) => {
    post({ type: 'failed', message: error instanceof Error ? error.message : 'The modeling kernel could not start' });
  });

self.onmessage = async (event: MessageEvent<KernelRequest>) => {
  await ready;
  const request = event.data;
  if (!wasm) return;
  if (request.type === 'drop') {
    cache.drop(request.bodyId);
    return;
  }
  const { body, requestId, context } = request;
  const t0 = performance.now();
  try {
    const mesh = meshOf(evaluateBody(wasm, body, cache, context));
    post({ type: 'result', requestId, bodyId: body.id, mesh, ms: performance.now() - t0 }, transferables(mesh));
  } catch (error) {
    const featureId = error instanceof FeatureError ? error.featureId : '';
    post({ type: 'error', requestId, bodyId: body.id, featureId, message: error instanceof Error ? error.message : String(error) });
  }
};

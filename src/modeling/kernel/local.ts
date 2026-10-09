/**
 * Last-resort kernel host for browsers that terminate module workers before Manifold starts.
 * Kept in its own dynamically imported chunk so supported browsers still load and run all
 * geometry off the UI thread.
 */
import Module, { type ManifoldToplevel } from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { evaluateBody, KernelCache } from './evaluate';
import { meshOf } from './mesh';
import type { Body, EvaluationContext, MeshData } from './types';

const cache = new KernelCache();
let runtime: Promise<ManifoldToplevel> | null = null;

function load(): Promise<ManifoldToplevel> {
  runtime ??= Module({ locateFile: () => wasmUrl }).then((toplevel) => {
    toplevel.setup();
    return toplevel;
  });
  return runtime;
}

export async function evaluateLocally(body: Body, context: EvaluationContext): Promise<MeshData> {
  return meshOf(evaluateBody(await load(), body, cache, context));
}

export function dropLocal(bodyId: string): void {
  cache.drop(bodyId);
}

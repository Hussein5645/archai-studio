/**
 * Runs the site concept's Manifold booleans off the main thread (and outside the page's CSP,
 * which forbids the runtime code generation Manifold's bindings need). See ./massing.ts.
 */
import Module, { type ManifoldToplevel } from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { insetProfile, massingPositions, type FormSolid, type Plan } from './massing';

const ready: Promise<ManifoldToplevel> = Module({ locateFile: () => wasmUrl }).then((toplevel) => {
  toplevel.setup();
  return toplevel;
});

type Request = { id: number; type: 'mesh'; forms: FormSolid[] } | { id: number; type: 'inset'; base: Plan; inset: number };

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    const toplevel = await ready;
    if (request.type === 'mesh') {
      const positions = massingPositions(toplevel, request.forms);
      self.postMessage({ id: request.id, positions }, { transfer: positions ? [positions.buffer] : [] });
    } else {
      self.postMessage({ id: request.id, profile: insetProfile(toplevel, request.base, request.inset) });
    }
  } catch (error) {
    self.postMessage({ id: request.id, error: error instanceof Error ? error.message : 'The geometry engine failed' });
  }
};

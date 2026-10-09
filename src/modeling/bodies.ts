/**
 * Keeps the scene's body meshes in step with the store's recipes: whenever a body's features
 * change (not its placement, which the scene applies directly), the body is sent to the kernel
 * worker and the returned mesh replaces the old one. A failed evaluation leaves the last good
 * mesh in place and records the error on the body (shown in Layers and the Inspector).
 */
import type { StoreApi } from 'zustand';
import { kernel, KernelError, type KernelClient } from './kernel/client';
import { featureDependencyIds, recipeSignature } from './kernel/evaluate';
import type { Body, EvaluationContext, Sketch } from './kernel/types';
import type { ModelingScene } from './scene';
import type { ModelingState } from './store';

/** The sketches and bodies an evaluation may read, keyed by id. */
export function evaluationContext(sketches: Sketch[], bodies: Body[] = []): EvaluationContext {
  return { sketches: Object.fromEntries(sketches.map((sketch) => [sketch.id, sketch])), bodies: Object.fromEntries(bodies.map((body) => [body.id, body])) };
}

interface SignatureCacheEntry {
  body: Body;
  signature: string;
  /** Sketches this body's features read directly (by id), snapshotted at signature time. */
  sketchDeps: Map<string, Sketch | undefined>;
  /** A boolean feature's tool body drags in that body's whole (recursive) recipe, which this
   * cache doesn't track transitively — such bodies always get a fresh signature. */
  hasBoolean: boolean;
}

export class BodyRuntime {
  private readonly keys = new Map<string, string>();
  /** Reconcile recomputes every body's signature on every store change (store updates always
   * give `bodies` a new array reference); recipeSignature JSON.stringifies the body's whole
   * feature chain to build it. This cache skips that for a body whose own reference, and the
   * sketches it reads, are unchanged since the last computation — the common case when editing
   * or dragging a different body/sketch. */
  private readonly signatureCache = new Map<string, SignatureCacheEntry>();
  private readonly inFlight = new Set<string>();
  /** The first bodies of an empty scene (a new asset, or one reopened) decide where the planes start. */
  private fitWhenDone = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly store: StoreApi<ModelingState>,
    private readonly scene: ModelingScene,
    private readonly client: KernelClient = kernel,
  ) {
    this.unsubscribe = store.subscribe((state, previous) => {
      if (state.bodies !== previous.bodies || state.sketches !== previous.sketches) this.reconcile(state.bodies);
    });
    this.reconcile(store.getState().bodies);
  }

  private reconcile(bodies: Body[]): void {
    const present = new Set(bodies.map((body) => body.id));
    if (bodies.length > 0 && this.keys.size === 0 && this.scene.bounds() === null) this.fitWhenDone = true;
    for (const id of [...this.keys.keys()]) {
      if (present.has(id)) continue;
      this.keys.delete(id);
      this.signatureCache.delete(id);
      this.scene.removeBody(id);
      this.client.drop(id);
    }
    const context = evaluationContext(this.store.getState().sketches, bodies);
    for (const body of bodies) {
      const key = this.recipeKeyFor(body, context);
      if (this.keys.get(body.id) === key) continue;
      this.keys.set(body.id, key);
      this.inFlight.add(body.id);
      void this.evaluate(body, key, context).finally(() => {
        this.inFlight.delete(body.id);
        if (!this.fitWhenDone || this.inFlight.size > 0) return;
        this.fitWhenDone = false;
        const bounds = this.scene.bounds();
        if (bounds) this.store.getState().fitPlanes([bounds.max.x, bounds.max.y, bounds.max.z]);
      });
    }
  }

  /** `recipeSignature`, reused as long as `body` and the sketches its features read are unchanged. */
  private recipeKeyFor(body: Body, context: EvaluationContext): string {
    const cached = this.signatureCache.get(body.id);
    if (cached && cached.body === body && !cached.hasBoolean && this.sketchDepsUnchanged(cached.sketchDeps, context)) {
      return cached.signature;
    }
    const sketchDeps = new Map<string, Sketch | undefined>();
    let hasBoolean = false;
    for (const feature of body.features) {
      const deps = featureDependencyIds(feature);
      if (deps.profile !== undefined) sketchDeps.set(deps.profile, context.sketches[deps.profile]);
      if (deps.driver !== undefined) sketchDeps.set(deps.driver, context.sketches[deps.driver]);
      if (deps.tool !== undefined) hasBoolean = true;
    }
    const signature = recipeSignature(body, context);
    this.signatureCache.set(body.id, { body, signature, sketchDeps, hasBoolean });
    return signature;
  }

  private sketchDepsUnchanged(deps: Map<string, Sketch | undefined>, context: EvaluationContext): boolean {
    for (const [id, ref] of deps) {
      if (context.sketches[id] !== ref) return false;
    }
    return true;
  }

  private async evaluate(body: Body, key: string, context: EvaluationContext): Promise<void> {
    try {
      const mesh = await this.client.evaluate(body, context);
      // Superseded, or the recipe moved on while this one was in flight.
      if (!mesh || this.keys.get(body.id) !== key) return;
      this.scene.setBodyMesh(body.id, mesh);
      this.store.getState().setBodyInfo(body.id, { triangles: mesh.triangles, volume: mesh.volume });
    } catch (error) {
      if (this.keys.get(body.id) !== key) return;
      const state = this.store.getState();
      const previous = state.bodyInfo[body.id];
      const featureId = error instanceof KernelError ? error.featureId : '';
      state.setBodyInfo(body.id, { triangles: previous?.triangles ?? 0, volume: previous?.volume ?? 0, error: { featureId, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  dispose(): void {
    this.unsubscribe();
  }
}

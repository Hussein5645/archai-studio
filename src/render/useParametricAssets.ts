/**
 * Keeps placed parametric copies (see src/catalog/parametric.ts) in step with their values: when
 * a copy's parameters change, its model is rebuilt in the kernel worker and its box is then
 * fitted to the new model (same drawing scale, model origin kept in place). The fit is derived
 * from the values, so undoing a value change brings the old box back by the same route.
 */
import { useEffect } from 'react';
import { useApp } from '@/app/context';
import { footprintOfBounds, instanceOverrides, parametricInstanceOf, recipeOf, sameFootprint, type Footprint } from '@/catalog/parametric';
import type { ArchaiDocument } from '@/document';
import { prepareParametric, rebuiltModel } from '@/view3d/parametricModels';

/** Copies whose box does not match their current model yet, with the footprint they need. */
export function pendingFits(doc: ArchaiDocument): { id: string; footprint: Footprint }[] {
  const fits: { id: string; footprint: Footprint }[] = [];
  for (const element of Object.values(doc.elements)) {
    if (element.kind !== 'instance') continue;
    const definition = doc.definitions[element.definitionId];
    const recipe = recipeOf(definition);
    if (!definition || !recipe) continue;
    const instance = parametricInstanceOf(element);
    const overrides = instanceOverrides(recipe, instance);
    let target: Footprint;
    if (Object.keys(overrides).length === 0) target = footprintOfBounds(recipe.bounds);
    else {
      const entry = rebuiltModel(definition.id, overrides);
      if (entry?.status !== 'ready') continue;
      target = entry.model.footprint;
    }
    const current = instance.footprint ?? footprintOfBounds(recipe.bounds);
    if (!sameFootprint(current, target)) fits.push({ id: element.id, footprint: target });
  }
  return fits;
}

export function useParametricAssets(): void {
  const { store, executor } = useApp();
  useEffect(() => {
    let disposed = false;
    let timer = 0;
    let running = false;
    let again = false;
    const check = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        const doc = store.getState().doc;
        if (!Object.values(doc.definitions).some((definition) => definition.meta?.['parametric'])) return;
        await prepareParametric(doc);
        if (disposed) return;
        for (const fit of pendingFits(store.getState().doc)) await executor.dispatch('fit-parametric-footprint', fit);
      } finally {
        running = false;
        if (again && !disposed) {
          again = false;
          schedule();
        }
      }
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void check(), 120);
    };
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.doc !== previous.doc) schedule();
    });
    schedule();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [store, executor]);
}

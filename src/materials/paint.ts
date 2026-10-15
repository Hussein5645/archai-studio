/**
 * Applying a material to what was clicked in a 3D view or ArchAI Render, in a paint scope. Kept
 * free of three.js (the board's Live Bridge with the studio uses it too).
 */
import type { AppServices } from '@/app/context';
import type { SurfaceTarget } from '@/view3d/SceneView';
import type { PaintScope } from './uiStore';

/** Where the model material slots of an element come from (the 3D view's meshes). */
export interface AssetSlotSource {
  assetSlotsOf(elementId: string): string[];
  elementIdsWithAssetSlot?(slot: string): string[];
}

/**
 * Paints a clicked or dropped target with a material, in a scope: its face (surface; parts without
 * surfaces such as a door leaf take the whole part), the part (slot), the whole object (every
 * slot), or everywhere the clicked material shows (copies of the same asset for model materials).
 */
export function paintTarget(app: Pick<AppServices, 'executor' | 'toasts' | 'store'>, target: SurfaceTarget, scope: PaintScope, materialId: string | null, view?: AssetSlotSource | null): void {
  if (!materialId) {
    app.toasts.push({ kind: 'info', message: 'Pick a material in the Materials panel first' });
    return;
  }
  const report = (result: { ok: true; value: unknown } | { ok: false; error: { message: string } }, done?: (value: unknown) => string | null) => {
    if (!result.ok) app.toasts.push({ kind: 'error', message: result.error.message });
    else if (done) {
      const message = done(result.value);
      if (message) app.toasts.push({ kind: 'success', message });
    }
  };
  if (scope === 'object') {
    void app.executor.dispatch('paint-element', { ids: [target.elementId], materialId, assetSlots: view?.assetSlotsOf(target.elementId) ?? [] }).then((result) => report(result));
    return;
  }
  if (scope === 'everywhere') {
    if (target.materialId) {
      if (target.materialId === materialId) return;
      void app.executor.dispatch('replace-material', { from: target.materialId, to: materialId }).then((result) =>
        report(result, (count) =>
          target.materialId!.startsWith('default:')
            ? 'Replaced everywhere: every part that showed that default now shows it (Ctrl+Z undoes)'
            : `Replaced the material everywhere (${String(count)} element${count === 1 ? '' : 's'})`,
        ),
      );
      return;
    }
    // A model's own material has no id: paint that part on every copy of the asset.
    const doc = app.store.getState().doc;
    const clicked = doc.elements[target.elementId];
    if (target.slot && clicked && view) {
      const candidates = view.elementIdsWithAssetSlot ? new Set(view.elementIdsWithAssetSlot(target.slot)) : null;
      const ids = Object.values(doc.elements).filter((element) => {
        if (element.locked || !(element.kind === 'instance' || element.meta?.['mesh'])) return false;
        if (candidates ? !candidates.has(element.id) : !view.assetSlotsOf(element.id).includes(target.slot!)) return false;
        const own = element.meta?.['materials'] as Record<string, unknown> | undefined;
        return !own?.[target.slot!] && !own?.['body'];
      }).map((element) => element.id);
      if (!ids.length) return;
      void app.executor.dispatch('assign-material', { ids, materialId, slot: target.slot }).then((result) => report(result, () => `Painted ${ids.length} cop${ids.length === 1 ? 'y' : 'ies'} of the asset`));
      return;
    }
  }
  const bySurface = scope === 'face' && target.surface;
  if (!bySurface && !target.slot) {
    app.toasts.push({ kind: 'info', message: 'This part does not take materials' });
    return;
  }
  void app.executor.dispatch('assign-material', { ids: [target.elementId], materialId, ...(bySurface ? { surface: target.surface } : { slot: target.slot }) }).then((result) => report(result));
}

import type { AppServices } from '@/app/context';
import type { InsertModeledAssetMsg } from './projectSync';

type Services = Pick<AppServices, 'store' | 'catalog' | 'executor' | 'persistence'>;
const pending = new WeakMap<Services['store'], Promise<unknown>>();

/** Serialize repeated sends so they update the first placement instead of racing it. */
export function insertModeledAsset(services: Services, message: InsertModeledAssetMsg): Promise<number> {
  const run = (pending.get(services.store) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const { store, catalog, executor, persistence } = services;
    const checkProject = () => {
      const state = store.getState();
      if (state.doc.id !== message.projectId || state.ui.screen !== 'project')
        throw new Error('Open the linked project before sending this model.');
    };
    checkProject();
    if (!catalog.addLocalPackage) throw new Error('Local CAI packages are unavailable.');
    const asset = await catalog.addLocalPackage(message.caiBytes);
    checkProject();
    const refreshed = await executor.dispatch('update-placed-catalog-asset', { asset, previousPackageKey: message.previousPackageKey });
    if (!refreshed.ok) throw new Error(refreshed.error.message);
    const updated = Number(refreshed.value);
    checkProject();
    if (updated === 0) {
      const placed = await executor.dispatch('place-catalog-asset', {
        asset, x: message.position.x, y: message.position.y, centered: true,
        instanceMeta: { solid: { elevation: message.position.elevation } },
      });
      if (!placed.ok) throw new Error(placed.error.message);
    }
    await persistence.saveNow();
    return updated;
  });
  pending.set(services.store, run);
  return run;
}

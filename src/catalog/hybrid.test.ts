import { describe, expect, it } from 'vitest';
import { createCaiPackage } from './builder';
import { HybridCaiCatalog } from './hybrid';
import { createLocalCaiStore } from './local-store';

describe('HybridCaiCatalog & LocalCaiStore', () => {
  it('loads local packages when remote catalog is not configured', async () => {
    const localStore = createLocalCaiStore();
    const catalog = new HybridCaiCatalog(null, localStore);

    const pkgBytes = createCaiPackage({
      metadata: {
        caiVersion: 1,
        id: 'sofa-leather-3seat',
        name: 'Leather 3-Seat Sofa',
        category: 'Furnish/Seating',
        kind: 'asset',
        size: { width: 2200, height: 950 },
      },
      topView: { name: 'sofa.png', bytes: Uint8Array.from([1, 2, 3]) },
      modelGlb: { name: 'sofa.glb', bytes: Uint8Array.from([4, 5, 6]) },
    });

    await catalog.addLocalPackage(pkgBytes);

    const root = await catalog.load();
    const furnish = root.folders.find((f) => f.path === 'Furnish');
    expect(furnish).toBeDefined();

    const seating = furnish?.folders.find((f) => f.path === 'Furnish/Seating');
    expect(seating).toBeDefined();
    expect(seating?.assets.length).toBe(1);
    expect(seating?.assets[0]?.name).toBe('Leather 3-Seat Sofa');
    expect(seating?.assets[0]?.isLocal).toBe(true);

    const image = await catalog.fetchImage(seating!.assets[0]!);
    expect([...image.bytes]).toEqual([1, 2, 3]);

    const exportedBytes = await catalog.exportPackageBytes(seating!.assets[0]!);
    expect(exportedBytes).toBeDefined();
    expect(exportedBytes?.length).toBe(pkgBytes.length);

    await catalog.deleteLocalPackage('sofa-leather-3seat');
    const rootAfter = await catalog.load();
    const seatingAfter = rootAfter.folders.find((f) => f.path === 'Furnish')?.folders.find((f) => f.path === 'Furnish/Seating');
    expect(seatingAfter?.assets.length ?? 0).toBe(0);
  });
});

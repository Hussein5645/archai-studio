import { describe, expect, it } from 'vitest';
import { createCaiPackage, extractCaiPackage } from './builder';

describe('Cai Builder and Extractor', () => {
  it('creates and extracts a valid .CAI package', () => {
    const topBytes = Uint8Array.from([137, 80, 78, 71, 1, 2, 3]);
    const glbBytes = Uint8Array.from([103, 108, 84, 70, 4, 5, 6]);

    const pkgBytes = createCaiPackage({
      metadata: {
        caiVersion: 1,
        id: 'office-desk-1600',
        name: 'Office Desk 1600',
        category: 'Furnish/Tables',
        kind: 'asset',
        size: { width: 1600, height: 800 },
        tags: ['office', 'desk'],
      },
      topView: { name: 'top.png', bytes: topBytes },
      modelGlb: { name: 'desk.glb', bytes: glbBytes },
    });

    expect(pkgBytes.length).toBeGreaterThan(0);

    const extracted = extractCaiPackage(pkgBytes);
    expect(extracted.metadata.id).toBe('office-desk-1600');
    expect(extracted.metadata.name).toBe('Office Desk 1600');
    expect(extracted.metadata.category).toBe('Furnish/Tables');
    expect(extracted.metadata.size).toEqual({ width: 1600, height: 800 });
    expect(extracted.mapping.views.top).toBe('views/top.png');
    expect(extracted.mapping.models.glb).toBe('models/model.glb');
    expect([...extracted.top.bytes]).toEqual([...topBytes]);
    expect([...extracted.models.glb!.bytes]).toEqual([...glbBytes]);
  });

  it('handles system assets (e.g. doors) and optional views/fbx models', () => {
    const topBytes = Uint8Array.from([1, 2, 3]);
    const frontBytes = Uint8Array.from([4, 5, 6]);
    const sideBytes = Uint8Array.from([10, 11, 12]);
    const fbxBytes = Uint8Array.from([7, 8, 9]);

    const pkgBytes = createCaiPackage({
      metadata: {
        caiVersion: 1,
        id: 'door-double-glass',
        name: 'Double Glass Door',
        category: 'Architecture/Openings/Doors',
        kind: 'system',
        system: { type: 'door', parameters: { operation: 'swing' } },
        size: { width: 1800, height: 150 },
      },
      topView: { name: 'plan.svg', bytes: topBytes },
      frontView: { name: 'elevation.png', bytes: frontBytes },
      sideView: { name: 'side.png', bytes: sideBytes },
      modelFbx: { name: 'door.fbx', bytes: fbxBytes },
    });

    const extracted = extractCaiPackage(pkgBytes);
    expect(extracted.metadata.kind).toBe('system');
    expect(extracted.metadata.system?.type).toBe('door');
    expect(extracted.mapping.views.top).toBe('views/top.svg');
    expect(extracted.mapping.views.front).toBe('views/front.png');
    expect(extracted.mapping.models.fbx).toBe('models/model.fbx');
    expect(extracted.top.mime).toBe('image/svg+xml');
    expect([...extracted.models.fbx!.bytes]).toEqual([...fbxBytes]);
  });

  it('packages levels of detail, styled views and cameras from the modeling workspace', () => {
    const png = Uint8Array.from([137, 80, 78, 71, 9]);
    const glb = Uint8Array.from([103, 108, 84, 70, 1]);
    const low = Uint8Array.from([103, 108, 84, 70, 2]);
    const bytes = createCaiPackage({
      metadata: {
        caiVersion: 1,
        id: 'lounge-chair',
        name: 'Lounge chair',
        category: 'Furnish/Seating',
        kind: 'asset',
        size: { width: 800, height: 900 },
        modelHeight: 750,
        lod: { low: true },
        cameras: [{ name: 'Camera 1', eye: [2000, 1200, 2000], aim: [0, 400, 0], fov: 60 }],
      },
      topView: { name: 'top.png', bytes: png },
      frontView: { name: 'front.png', bytes: png },
      sideView: { name: 'side.png', bytes: png },
      modelGlb: { name: 'model.glb', bytes: glb },
      modelGlbLow: { name: 'model-low.glb', bytes: low },
      previewView: { name: 'preview.png', bytes: png },
      styleViews: { 'hidden-line': { top: { name: 'top.png', bytes: png }, front: { name: 'front.png', bytes: png } } },
    });
    const extracted = extractCaiPackage(bytes);
    expect(extracted.mapping.models).toEqual({ glb: 'models/model.glb', glbLow: 'models/model-low.glb' });
    expect(extracted.mapping.styles).toEqual({ 'hidden-line': { top: 'views/hidden-line/top.png', front: 'views/hidden-line/front.png' } });
    expect(extracted.files['models/model-low.glb']).toEqual(low);
    expect(extracted.files['views/hidden-line/top.png']).toEqual(png);
    expect(extracted.metadata.lod).toEqual({ low: true });
    expect(extracted.metadata.modelHeight).toBe(750);
    expect(extracted.metadata.cameras?.[0]?.name).toBe('Camera 1');
    expect(extracted.mapping.views.preview).toBe('views/preview.png');
    expect(extracted.views.preview?.bytes).toEqual(png);
  });

  it('rejects creation if neither GLB nor FBX model is provided', () => {
    expect(() =>
      createCaiPackage({
        metadata: {
          caiVersion: 1,
          id: 'bad-asset',
          name: 'Bad Asset',
          category: 'Furnish',
          kind: 'asset',
          size: { width: 100, height: 100 },
        },
        topView: { name: 'top.png', bytes: Uint8Array.from([1, 2, 3]) },
      }),
    ).toThrow(/GLB or FBX/);
  });

  it('requires every orthographic view for a system package', () => {
    expect(() =>
      createCaiPackage({
        metadata: {
          caiVersion: 1,
          id: 'window-fixed',
          name: 'Fixed Window',
          category: 'Architecture/Openings/Windows',
          kind: 'system',
          system: { type: 'window', parameters: { mechanism: 'fixed' } },
          size: { width: 1200, height: 150 },
        },
        topView: { name: 'top.png', bytes: Uint8Array.from([1]) },
        frontView: { name: 'front.png', bytes: Uint8Array.from([2]) },
        modelGlb: { name: 'model.glb', bytes: Uint8Array.from([3]) },
      }),
    ).toThrow(/top, front, and side/);
  });

  it('rejects invalid or corrupted zip archives during extraction', () => {
    expect(() => extractCaiPackage(Uint8Array.from([0, 1, 2, 3]))).toThrow();
  });
});

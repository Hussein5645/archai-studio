import { expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { cameraNavigationLocked } from './viewCamera';

it('protects pinned perspective portals, markers and parent rigs from camera saves', () => {
  for (const target of ['portal', 'marker', 'rig']) {
    const app = createTestApp();
    const id = run<string>(app, 'create-camera-view', { a: [0, 0], b: [1000, 0] });
    const portal = app.store.getState().doc.elements[id]!;
    const marker = (portal.meta!['view3d'] as { cameraId: string }).cameraId;
    const locked = target === 'portal' ? id : target === 'marker' ? marker : portal.parentId!;
    run(app, 'select', { ids: [locked] });
    run(app, 'toggle-lock');
    const before = app.store.getState().doc;
    expect(cameraNavigationLocked(before, id)).toBe(true);
    run(app, 'set-view3d-camera', { id, camera: { position: [100, 500, 100], target: [0, 0, 0], fov: 90 } });
    expect(app.store.getState().doc).toBe(before);
    run(app, 'toggle-lock');
    expect(cameraNavigationLocked(app.store.getState().doc, id)).toBe(false);
    run(app, 'set-view3d-camera', { id, camera: { position: [100, 500, 100], target: [0, 0, 0], fov: 90 } });
    expect(app.store.getState().doc.elements[id]!.meta!['view3d']).toMatchObject({ camera: { fov: 90 } });
  }
});

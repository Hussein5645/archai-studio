import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { defaultSettings } from './settings';
import { renderOf, viewBakeSignature } from './viewRender';
import { documentInContext, viewContext } from '@/document/viewVisibility';

describe('saved view rendering', () => {
  it('remembers independent renderers and lights and rejects a nonexistent bake', () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-view3d'),
      b = run<string>(app, 'create-view3d');
    run(app, 'set-view3d-settings', {
      id: a,
      renderer: 'unreal',
      style: 'shaded',
      renderSettings: { ...defaultSettings(), exposure: 2 },
    });
    expect(renderOf(app.store.getState().doc, a)).toMatchObject({
      renderer: 'unreal',
      settings: { exposure: 2 },
    });
    expect(renderOf(app.store.getState().doc, b)).toMatchObject({
      renderer: 'default',
      settings: { exposure: 0 },
    });
    expect(app.executor.dispatchSync('set-view3d-settings', { id: b, renderer: 'baked' }).ok).toBe(
      false,
    );
  });
  it('invalidates on geometry, lighting and this view visibility, while ignoring cameras and other views', () => {
    const app = createTestApp();
    const id = run<string>(app, 'create-arch-element', { tool: 'column', x: 0, y: 0 });
    const view = run<string>(app, 'create-view3d'),
      other = run<string>(app, 'create-view3d');
    const settings = defaultSettings();
    const signature = () =>
      viewBakeSignature(documentInContext(app.store.getState().doc, viewContext(view)), settings);
    const original = signature();
    run(app, 'set-view3d-camera', {
      id: view,
      camera: { position: [100, 200, 300], target: [0, 0, 0] },
    });
    run(app, 'set-view3d-settings', {
      id: view,
      renderer: 'unreal',
      style: 'shaded',
      renderSettings: settings,
    });
    expect(signature()).toBe(original);
    run(app, 'open-view3d', { id: other });
    run(app, 'set-context-visibility', { ids: [id], visible: false });
    expect(signature()).toBe(original);
    run(app, 'open-view3d', { id: view });
    run(app, 'set-context-visibility', { ids: [id], visible: false });
    expect(signature()).not.toBe(original);
    expect(viewBakeSignature(app.store.getState().doc, { ...settings, sunIntensity: 7 })).not.toBe(
      signature(),
    );
  });
  it('requires a valid bake before publishing an Unreal view, before any upload or login', async () => {
    const app = createTestApp();
    const view = run<string>(app, 'create-view3d');
    run(app, 'set-view3d-settings', { id: view, renderer: 'unreal' });
    const result = await app.executor.dispatch('publish-vr-tour', { portalId: view });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'rejected', message: expect.stringContaining('Bake this view') },
    });
  });
});

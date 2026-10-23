import { expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { interactiveSource, validateInteractiveSource, type InteractiveOutput } from './interactiveExport';
import { defaultSettings } from './settings';

it('freezes renderer/style, rejects stale bake use and permits unbaked Unreal web links', () => {
  const app = createTestApp(), view = run<string>(app, 'create-view3d');
  run(app, 'set-view3d-settings', { id: view, renderer: 'unreal', style: 'realistic' });
  const doc = app.store.getState().doc, source = interactiveSource(doc, view);
  const output: InteractiveOutput = { renderer: 'unreal', style: 'realistic', destination: 'link', lighting: 'realtime', signature: source.signature };
  expect(() => validateInteractiveSource(doc, view, output)).not.toThrow();
  expect(() => validateInteractiveSource(doc, view, { ...output, lighting: 'baked' })).toThrow('current bake');
  run(app, 'set-view3d-settings', { id: view, style: 'wireframe' });
  expect(() => validateInteractiveSource(app.store.getState().doc, view, output)).toThrow('changed');
});

it('exposure and bloom changes preserve the underlying bake signature', () => {
  const app = createTestApp(), view = run<string>(app, 'create-view3d');
  const before = interactiveSource(app.store.getState().doc, view).signature;
  run(app, 'set-view3d-settings', { id: view, renderSettings: { ...defaultSettings(), exposure: 2, bloom: 0 } });
  expect(interactiveSource(app.store.getState().doc, view).signature).toBe(before);
});

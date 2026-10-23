import { expect, it, vi } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { interactiveSource } from './interactiveExport';
import { uploadVrTour } from '@/view3d/vrShare';
import type * as InteractiveExportModule from './interactiveExport';

vi.mock('@/view3d/vrShare', () => ({ vrShareConfig: () => ({ url: 'https://example.invalid', token: 'test-token' }), VR_SIGN_IN_MESSAGE: 'Sign in', uploadVrTour: vi.fn(async () => ({ id: 'test1', link: 'https://example.invalid/v/test1' })) }));
vi.mock('./interactiveExport', async original => ({ ...await original<typeof InteractiveExportModule>(), interactiveModel: vi.fn(async () => ({ model: new ArrayBuffer(24) })) }));

it('publishes an unbaked Unreal interactive web link and records source renderer/style and selection', async () => {
  const app = createTestApp(), column = run<string>(app, 'create-arch-element', { tool: 'column', x: 0, y: 0 });
  const view = run<string>(app, 'create-view3d');
  run(app, 'set-view3d-settings', { id: view, renderer: 'unreal', style: 'shaded' });
  const source = interactiveSource(app.store.getState().doc, view);
  const result = await app.executor.dispatch('publish-vr-tour', { portalId: view, elementIds: [column],
    interactive: { renderer: 'unreal', style: 'shaded', signature: source.signature, lighting: 'realtime' } });
  expect(result.ok).toBe(true);
  expect(vi.mocked(uploadVrTour).mock.calls[0]?.[1]).toMatchObject({ previousId: null,
    tour: { sourceRenderer: 'unreal', sourceStyle: 'shaded', exportLighting: 'realtime', sourceBakeStatus: 'none', selectedElements: [column] } });
});

import { describe, expect, it } from 'vitest';
import { instanceParameterKeys, sharedInstanceParameterDefinitions, systemDimensionParameters } from './system-assets';
import { createTestApp, run } from '@/test/harness';

describe('parameter ownership', () => {
  it('normalizes legacy exposure, drops unknown keys, and keeps instance-only fields', () => {
    expect(instanceParameterKeys('column', ['width', 'width', 'missing'])).toEqual(['width', 'elevation']);
    expect(instanceParameterKeys('window', undefined)).toEqual(['sill']);
    expect(sharedInstanceParameterDefinitions([
      { type: 'column', parameters: {}, instanceEditable: [] },
      { type: 'wall', parameters: {}, instanceEditable: [] },
    ]).map((item) => item.key)).toEqual(['elevation']);
    expect(systemDimensionParameters('column', { shape: 'circle' })).toEqual({ width: 'diameter', height: 'diameter' });
  });

  it('converts instance values back to a shared type without leaking stale overrides, with undo', async () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-arch-element', { tool: 'column', x: 0, y: 0 });
    const b = run<string>(app, 'create-arch-element', { tool: 'column', x: 1000, y: 0 });
    run(app, 'set-system-configuration', { id: a, assetId: null, parameters: { width: 500 }, instanceEditable: ['width'] });
    run(app, 'set-system-parameter', { id: b, key: 'width', value: 850 });
    run(app, 'set-system-parameter', { id: b, key: 'elevation', value: 200 });
    run(app, 'set-system-configuration', { id: a, assetId: null, parameters: { width: 650, elevation: 999 }, instanceEditable: [] });
    const read = (id: string) => app.store.getState().doc.elements[id]?.meta?.['arch'];
    expect(read(a)).toMatchObject({ parameters: { width: 650, elevation: 0 }, instanceEditable: ['elevation'] });
    expect(read(b)).toMatchObject({ parameters: { width: 650, elevation: 200 }, instanceOverrides: { elevation: 200 } });
    await app.executor.dispatch('undo');
    expect(read(b)).toMatchObject({ parameters: { width: 850, elevation: 200 }, instanceEditable: ['width', 'elevation'] });
  });
});

import { expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';

function fixture() {
  const app = createTestApp();
  const mesh = (name: string) => run<string>(app, 'create-mesh-element', { name, glb: 'Z2xURgIAAAA=', x: 0, y: 0, size: [100, 100, 100] });
  const a = mesh('A'), b = mesh('B'), outside = mesh('Outside');
  const inner = run<string>(app, 'group-selection', { ids: [b], name: 'Nested' });
  const outer = run<string>(app, 'group-selection', { ids: [a, inner], name: 'Models' });
  return { app, a, b, outside, inner, outer };
}

it('repairs every imported model in nested groups with a single undo and no outside changes', () => {
  const { app, a, b, outside, outer } = fixture();
  const mode = (id: string) => app.store.getState().doc.elements[id]!.meta?.['normalMode'];
  expect(run(app, 'auto-repair-group-normals', { ids: [outer, a] })).toEqual({ models: 2 });
  expect(mode(a)).toBe('auto'); expect(mode(b)).toBe('auto'); expect(mode(outside)).toBeUndefined();
  app.executor.undo(); expect(mode(a)).toBeUndefined(); expect(mode(b)).toBeUndefined();
  app.executor.redo(); expect(mode(a)).toBe('auto'); expect(mode(b)).toBe('auto');
});

it('rejects a locked nested group without partially changing any models', () => {
  const { app, a, b, inner, outer } = fixture();
  const state = app.store.getState();
  app.store.setState({ doc: { ...state.doc, elements: { ...state.doc.elements, [inner]: { ...state.doc.elements[inner]!, locked: true } } } });
  expect(() => run(app, 'auto-repair-group-normals', { ids: [outer] })).toThrow(/Unlock/);
  for (const id of [a, b]) expect(app.store.getState().doc.elements[id]!.meta?.['normalMode']).toBeUndefined();
});

it('uses the current selection and supports auto repair of a single imported model', () => {
  const { app, a } = fixture();
  run(app, 'select', { ids: [a] });
  expect(run(app, 'auto-repair-group-normals', {})).toEqual({ models: 1 });
  run(app, 'set-model-normals', { id: a, mode: 'source' });
  run(app, 'set-model-normals', { id: a, mode: 'auto' });
  expect(app.store.getState().doc.elements[a]!.meta?.['normalMode']).toBe('auto');
});

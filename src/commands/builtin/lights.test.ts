import { expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { renderLightsOf } from '@/document/renderLight';
import { documentInContext, viewContext } from '@/document/viewVisibility';

it('lights behave as normal saved elements: move, edit, hide per view, delete and undo', () => {
  const app = createTestApp();
  const id = run<string>(app, 'create-light', { x: 1000, y: 2000, kind: 'spot' });
  const lights = () => renderLightsOf(app.store.getState().doc);
  expect(lights()[0]).toMatchObject({ id, kind: 'spot', position: [1, 2.5, 2] });
  run(app, 'move-selection', { ids: [id], dx: 2000, dy: 1000 });
  expect(lights()[0]!.position).toEqual([3, 2.5, 3]);
  run(app, 'update-light', { id, patch: { intensity: 5000, position: [4, 5, 6] } });
  expect(lights()[0]).toMatchObject({ intensity: 5000, position: [4, 5, 6] });
  const view = run<string>(app, 'create-view3d');
  run(app, 'open-view3d', { id: view });
  run(app, 'set-context-visibility', { ids: [id], visible: false });
  expect(renderLightsOf(documentInContext(app.store.getState().doc, viewContext(view)))).toHaveLength(0);
  expect(lights()).toHaveLength(1);
  run(app, 'select', { ids: [id] });
  run(app, 'delete-selection', { ids: [id] });
  expect(lights()).toHaveLength(0);
  app.executor.undo();
  expect(lights()).toHaveLength(1);
});

it('spotlight endpoint and height edits aim the light; area size follows its rectangle', () => {
  const app = createTestApp();
  const id = run<string>(app, 'create-light', { x: 0, y: 0, elevation: 2000, kind: 'spot', target: [2000, 0], targetElevation: 0 });
  const light = () => renderLightsOf(app.store.getState().doc).find((item) => item.id === id)!;
  expect(app.store.getState().doc.elements[id]!.kind).toBe('line');
  expect(light().tilt).toBeCloseTo(-45);
  run(app, 'move-line-endpoint', { id, endpoint: 'end', x: 0, y: 2000 });
  expect(light().yaw).toBeCloseTo(90);
  run(app, 'update-light', { id, patch: { targetElevation: 2000 } });
  expect(light().tilt).toBeCloseTo(0);
  const area = run<string>(app, 'create-light', { x: 0, y: 0, kind: 'area' });
  run(app, 'update-light', { id: area, patch: { size: 3 } });
  expect(renderLightsOf(app.store.getState().doc).find((item) => item.id === area)!.size).toBe(3);
  for (const kind of ['point', 'area', 'spot'] as const) {
    run(app, 'update-light', { id, patch: { kind } });
    expect(light().kind).toBe(kind);
    expect(light().position).toEqual([0, 2, 0]);
  }
});

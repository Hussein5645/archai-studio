import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { liveLinkOf, withoutLink } from './sync';

const model = (walls: number) => ({
  archaiRevit: 1,
  app: 'Rhino',
  name: 'House.3dm',
  materials: [{ id: 'm1', name: 'Plaster', color: '#eeeeee' }],
  walls: Array.from({ length: walls }, (_, i) => ({ id: `w${i}`, points: [[0, i * 3000], [4000, i * 3000]], base: 0, height: 3000, layers: [{ name: 'Core', role: 'core', thickness: 200, material: 'm1' }] })),
  meshes: [{ id: 'chair', name: 'Chair', category: 'Furniture', origin: [100, 100, 0], size: [500, 500, 900], glb: 'AAAA' }],
});

describe('live link sync', () => {
  it("replaces a plugin's previous model and keeps everything else", () => {
    const app = createTestApp();
    const own = run<string>(app, 'create-rect', { x: 0, y: 0, width: 1000, height: 1000 });
    run(app, 'sync-live-link', { key: 'rhino:house', app: 'Rhino', model: model(2) });
    const linked = () => Object.values(app.store.getState().doc.elements).filter((e) => liveLinkOf(e)?.key === 'rhino:house');
    expect(linked().length).toBe(3);
    const report = run<{ removed: number }>(app, 'sync-live-link', { key: 'rhino:house', app: 'Rhino', model: model(1) });
    expect(report.removed).toBe(3);
    expect(linked().length).toBe(2);
    const doc = app.store.getState().doc;
    expect(doc.elements[own]).toBeDefined();
    // One material across syncs.
    expect(Object.values(doc.materials).filter((m) => m.name === 'Plaster').length).toBe(1);
    // Pulling back leaves the plugin's own model out.
    expect(Object.keys(withoutLink(doc, 'rhino:house').elements)).toEqual([own]);
    // Undo restores the previous sync in one step.
    app.executor.undo();
    expect(linked().length).toBe(3);
  });
});

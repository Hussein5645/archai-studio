import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { materialById } from '@/materials/slots';

describe('smart material assignment', () => {
  it('paints every part of an object and replaces a material everywhere', () => {
    const app = createTestApp();
    const wall = run<string>(app, 'create-arch-element', { tool: 'wall', points: [[0, 0], [4000, 0]] });
    const other = run<string>(app, 'create-arch-element', { tool: 'wall', points: [[0, 3000], [4000, 3000]] });
    const brick = run<string>(app, 'create-material', { preset: 'preset:brick-red' });
    const oak = run<string>(app, 'create-material', { preset: 'preset:oak' });
    run(app, 'assign-material', { ids: [wall], materialId: brick, surface: 'sideA' });
    expect(run(app, 'paint-element', { ids: [wall], materialId: oak })).toBe(1);
    const painted = app.store.getState().doc.elements[wall]!;
    const own = painted.meta?.['materials'] as Record<string, string>;
    expect(Object.values(own).length).toBeGreaterThan(0);
    expect(Object.values(own).every((id) => id === oak)).toBe(true);
    expect(painted.meta?.['surfaces']).toBeUndefined();

    run(app, 'assign-material', { ids: [other], materialId: oak, surface: 'sideB' });
    expect(run(app, 'replace-material', { from: oak, to: brick })).toBe(2);
    const doc = app.store.getState().doc;
    expect(Object.values(doc.elements[wall]!.meta?.['materials'] as Record<string, string>).every((id) => id === brick)).toBe(true);
    expect(JSON.stringify(doc.elements[other]!.meta?.['surfaces'])).toContain(brick);
  });

  it('replacing a default changes every part that shows it', () => {
    const app = createTestApp();
    const oak = run<string>(app, 'create-material', { preset: 'preset:oak' });
    run(app, 'replace-material', { from: 'default:wall-core', to: oak });
    const replaced = materialById(app.store.getState().doc, 'default:wall-core')!;
    expect(replaced.map).toEqual(materialById(app.store.getState().doc, oak)!.map);
    expect(replaced.name).toContain('Oak');
  });
});

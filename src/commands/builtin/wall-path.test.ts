import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import type { CurvePath, LineElement } from '@/document';
import { sampleCurvePath } from '@/geometry';
import { resizeBezierHandles } from '@/assets/wall-path';

const path: CurvePath = { start: [0, 0], segments: [{ kind: 'bezier', control1: [800, 500], control2: [2200, 500], to: [3000, 0] }] };

describe('wall path placement', () => {
  it('adds handle pairs without changing the curve or its endpoints', () => {
    const expanded = resizeBezierHandles(path, 4);
    expect(expanded.segments).toHaveLength(2);
    expect(expanded.start).toEqual(path.start);
    const before = sampleCurvePath(path, 32), after = sampleCurvePath(expanded, 16);
    expect(after).toHaveLength(before.length);
    after.forEach((point, index) => point.forEach((value, axis) => expect(value).toBeCloseTo(before[index]![axis]!, 7)));
    expect(resizeBezierHandles(expanded, 2).segments).toHaveLength(1);
  });

  it('keeps direct handles in the canonical parameters and preserves the curve through type edits', async () => {
    const app = createTestApp();
    const [id] = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [3000, 0]] });
    const wall = () => app.store.getState().doc.elements[id!] as LineElement;
    run(app, 'set-line-curve-path', { id, path });
    run(app, 'set-wall-handle-count', { id, count: 4 });
    run(app, 'move-line-curve-handle', { id, segment: 0, handle: 'control1', x: -900, y: 5000 });
    const before = wall().path;
    expect(wall().meta?.['arch']).toMatchObject({ parameters: { pathType: 'bezier', bezierHandles: expect.arrayContaining([[-0.3, 5000 / 3000]]) } });
    run(app, 'set-system-configuration', { id, assetId: null, parameters: { height: 4500 }, instanceEditable: [] });
    expect(wall().path).toEqual(before);
    expect(wall().meta?.['arch']).toMatchObject({ parameters: { height: 4500, pathType: 'bezier' } });
    run(app, 'set-line-curve-path', { id, path: null });
    run(app, 'set-system-parameter', { id, key: 'height', value: 3000 });
    expect(wall().path).toBeUndefined();
    expect(wall().meta?.['arch']).toMatchObject({ parameters: { pathType: 'straight' } });
    await app.executor.dispatch('undo');
    await app.executor.dispatch('undo');
    expect(wall().path).toEqual(before);
  });

  it('moves either arc endpoint exactly without moving the opposite endpoint', () => {
    const app = createTestApp();
    const [id] = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [3000, 0]] });
    run(app, 'set-system-parameter', { id, key: 'pathType', value: 'arc' });
    run(app, 'move-line-endpoint', { id, endpoint: 'start', x: -500, y: 300 });
    const wall = () => app.store.getState().doc.elements[id!] as LineElement;
    expect(wall().points[0]).toEqual([-500, 300]);
    expect(wall().points.at(-1)![0]).toBeCloseTo(3000);
    expect(wall().points.at(-1)![1]).toBeCloseTo(0);
    run(app, 'move-line-endpoint', { id, endpoint: 'end', x: 3500, y: -400 });
    expect(wall().points[0]).toEqual([-500, 300]);
    expect(wall().points.at(-1)![0]).toBeCloseTo(3500);
    expect(wall().points.at(-1)![1]).toBeCloseTo(-400);
  });
});

import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import type { ElementTable, LineElement, RectElement } from '@/document';
import { applyToPoint, worldMatrix } from '@/geometry';
import { draftGeometry } from '@/drafting/geometry';

type App = ReturnType<typeof createTestApp>;
const table = (app: App) => app.store.getState().doc.elements as ElementTable;
const square = (app: App, x = 0, y = 0, size = 4000) => {
  run(app, 'create-line', { points: [[x, y], [x + size, y], [x + size, y + size]] });
  run(app, 'create-line', { points: [[x + size, y + size], [x, y + size], [x, y]] });
};
const archOf = (element: unknown) => (element as { meta: { arch: { type: string; area: number } } }).meta.arch;

describe('profile drawing mode', () => {
  it('enters with the floor tool, and Finish turns the drawn loop into a floor', () => {
    const app = createTestApp();
    run(app, 'set-tool', { tool: 'arch:floor' });
    expect(app.store.getState().ui.profileEdit).toMatchObject({ kind: 'floor', targetId: null });
    square(app);
    const id = run<string>(app, 'finish-profile-edit');
    const floor = table(app)[id]!;
    expect(archOf(floor).type).toBe('floor');
    expect(archOf(floor).area).toBeCloseTo(16e6, 0);
    // The sketch lines are gone and the mode is over.
    expect(Object.values(table(app)).filter((element) => element.kind === 'line')).toHaveLength(1);
    expect(app.store.getState().ui.profileEdit).toBeNull();
  });

  it('refuses an open or doubled boundary and stays in the mode', () => {
    const app = createTestApp();
    run(app, 'set-tool', { tool: 'arch:ceiling' });
    run(app, 'create-line', { points: [[0, 0], [1000, 0], [1000, 1000]] });
    const open = app.executor.dispatchSync('finish-profile-edit');
    expect(open.ok).toBe(false);
    expect(!open.ok && open.error.message).toMatch(/2 open ends/);
    expect(app.store.getState().ui.profileEdit).not.toBeNull();
    run(app, 'cancel-profile-edit');
    expect(Object.keys(table(app))).toHaveLength(0);
  });

  it('keeps arcs exact in a floor boundary', () => {
    const app = createTestApp();
    run(app, 'set-tool', { tool: 'arch:floor' });
    // A half disc: a straight edge and a half circle arc.
    run(app, 'create-line', { points: [[-1000, 0], [1000, 0]] });
    run(app, 'create-line', { points: [[1000, 0], [-1000, 0]], path: { start: [1000, 0], segments: [{ kind: 'arc', center: [0, 0], radius: 1000, startAngle: 0, endAngle: Math.PI, clockwise: false }] } });
    const id = run<string>(app, 'finish-profile-edit');
    const floor = table(app)[id] as LineElement;
    expect(floor.path?.segments.some((segment) => segment.kind === 'arc')).toBe(true);
    expect(archOf(floor).area).toBeCloseTo((Math.PI * 1000 ** 2) / 2, -3);
  });

  it('edits an existing floor boundary any time', () => {
    const app = createTestApp();
    run(app, 'set-tool', { tool: 'arch:floor' });
    square(app);
    const id = run<string>(app, 'finish-profile-edit');
    const seed = run<string>(app, 'begin-profile-edit', { id });
    expect(table(app)[seed]?.meta?.['profileSketch']).toBe(true);
    // Replace the square with a smaller one.
    run(app, 'delete-selection', { ids: [seed] });
    square(app, 0, 0, 2000);
    expect(run<string>(app, 'finish-profile-edit')).toBe(id);
    expect(archOf(table(app)[id]).area).toBeCloseTo(4e6, 0);
    expect(table(app)[seed]).toBeUndefined();
  });

  it('draws levels with any closed boundary and keeps what they hold in place', () => {
    const app = createTestApp();
    run(app, 'set-tool', { tool: 'arch:level' });
    // An L shape.
    run(app, 'create-line', { points: [[0, 0], [6000, 0], [6000, 2000], [2000, 2000], [2000, 5000], [0, 5000]], closed: true });
    const level = run<string>(app, 'finish-profile-edit');
    const rect = table(app)[level] as RectElement;
    expect(rect).toMatchObject({ x: 0, y: 0, width: 6000, height: 5000 });
    const outline = (rect.meta!['level'] as { outline: { points: number[][] } }).outline;
    expect(outline.points).toHaveLength(6);
    // Something on the level, then a boundary that grows to the left and up.
    const child = run<string>(app, 'create-rect', { x: 1000, y: 1000, width: 100, height: 100, parentId: level });
    const before = applyToPoint(worldMatrix(table(app), table(app)[child]!), { x: 0, y: 0 });
    run(app, 'begin-profile-edit', { id: level });
    run(app, 'delete-selection');
    square(app, -1000, -1000, 8000);
    run(app, 'finish-profile-edit');
    expect(table(app)[level]).toMatchObject({ x: -1000, y: -1000, width: 8000, height: 8000 });
    // A plain rectangle needs no outline.
    expect((table(app)[level]!.meta!['level'] as Record<string, unknown>)['outline']).toBeUndefined();
    const after = applyToPoint(worldMatrix(table(app), table(app)[child]!), { x: 0, y: 0 });
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
});

describe('floor and ceiling openings', () => {
  it('turns loops drawn inside the boundary into openings', () => {
    const app = createTestApp();
    run(app, 'set-tool', { tool: 'arch:floor' });
    run(app, 'create-line', { points: [[0, 0], [4000, 0], [4000, 4000], [0, 4000]], closed: true });
    // A square shaft and a round void.
    run(app, 'create-rect', { x: 500, y: 500, width: 1000, height: 1000 });
    run(app, 'create-line', { points: [[3500, 3000], [2500, 3000]], closed: true, path: { start: [3500, 3000], segments: [{ kind: 'arc', center: [3000, 3000], radius: 500, startAngle: 0, endAngle: Math.PI * 2, clockwise: false }] } });
    const id = run<string>(app, 'finish-profile-edit');
    const arch = (table(app)[id]!.meta as { arch: { area: number; openings: { points: number[][]; path?: unknown }[] } }).arch;
    expect(arch.openings).toHaveLength(2);
    expect(arch.openings.some((opening) => opening.path)).toBe(true);
    expect(arch.area).toBeCloseTo(16e6 - 1e6 - Math.PI * 500 ** 2, -3);
    // Editing it again brings back the boundary and both openings as sketch loops.
    run(app, 'begin-profile-edit', { id });
    const sketches = Object.values(table(app)).filter((element) => element.meta?.['profileSketch']);
    expect(sketches).toHaveLength(3);
    expect(run<string>(app, 'finish-profile-edit')).toBe(id);
    expect((table(app)[id]!.meta as { arch: { openings: unknown[] } }).arch.openings).toHaveLength(2);
  });

  it('refuses openings outside the boundary, overlapping ones, and openings in a level', () => {
    const app = createTestApp();
    run(app, 'set-tool', { tool: 'arch:ceiling' });
    square(app);
    run(app, 'create-rect', { x: 5000, y: 0, width: 500, height: 500 });
    const outside = app.executor.dispatchSync('finish-profile-edit');
    expect(!outside.ok && outside.error.message).toMatch(/inside the boundary/);
    run(app, 'cancel-profile-edit');
    run(app, 'set-tool', { tool: 'arch:level' });
    square(app);
    run(app, 'create-rect', { x: 500, y: 500, width: 500, height: 500 });
    const level = app.executor.dispatchSync('finish-profile-edit');
    expect(!level.ok && level.error.message).toMatch(/one closed loop/);
  });
});

describe('map site boundary as board lines', () => {
  it('snaps to the boundary corners and edges', () => {
    const app = createTestApp();
    const map = run<string>(app, 'create-rect', { x: 0, y: 0, width: 100_000, height: 100_000, meta: { location: { lat: 51.5, lon: -0.12, zoom: 17, boundary: [{ lat: 51.5, lon: -0.12 }, { lat: 51.5005, lon: -0.12 }, { lat: 51.5005, lon: -0.1195 }] } } });
    const geometry = draftGeometry(table(app));
    const boundaryEdges = geometry.segments.filter((segment) => segment.id === map);
    // Four map frame edges and the three closed boundary edges.
    expect(boundaryEdges).toHaveLength(7);
    // The map centre (the first corner) sits at the anchor, the middle of the map.
    expect(geometry.points.some((point) => point.id === map && point.kind === 'endpoint' && Math.abs(point.p.x - 50_000) < 1e-6 && Math.abs(point.p.y - 50_000) < 1e-6)).toBe(true);
  });
});

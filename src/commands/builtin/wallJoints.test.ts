import { describe, expect, it } from 'vitest';
import type { ElementTable, LineElement } from '@/document';
import { wallBodyPath, wallOffsetLine, wallOutlinePath } from '@/render/wallBody';
import { createTestApp, run } from '@/test/harness';

function wall(app: ReturnType<typeof createTestApp>, id: string): LineElement {
  return app.store.getState().doc.elements[id] as LineElement;
}

function joints(element: LineElement): Record<string, { enabled: boolean; with: string[] }> {
  return (element.meta?.['arch'] as { joints: Record<string, { enabled: boolean; with: string[] }> }).joints;
}

describe('wall joints', () => {
  it('joins a branch to the middle of a wall and removes the outline across its mouth', () => {
    const app = createTestApp();
    const [host] = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [0, 5000]] });
    const [branch] = run<string[]>(app, 'create-wall-segments', { points: [[50, 2000], [3000, 2000]] });
    const elements = app.store.getState().doc.elements;
    expect(wall(app, branch!).points[0]![0] + wall(app, branch!).x).toBe(0);
    expect(joints(wall(app, branch!))['start']!.with).toContain(host);
    expect(joints(wall(app, host!))['body']!.with).toContain(branch);
    expect(wallOffsetLine(wall(app, branch!), elements, -100)[0]).toEqual({ x: 50, y: -100 });
    const outline = wallOutlinePath(wall(app, host!), elements);
    expect(outline).toContain('M 100 0 L 100 1900');
    expect(outline).toContain('M 100 2100 L 100 5000');
    expect(outline).toContain('M -100 0 L -100 5000');
    run(app, 'set-wall-joints', { id: host, enabled: false });
    expect(joints(wall(app, branch!))['start']!.enabled).toBe(false);
    expect(joints(wall(app, host!))['body']!.enabled).toBe(false);
  });

  it('recognizes T-junctions when the through-wall is drawn after the branch', () => {
    const app = createTestApp();
    const [branch] = run<string[]>(app, 'create-wall-segments', { points: [[0, 2000], [3000, 2000]] });
    const [host] = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [0, 5000]] });
    expect(joints(wall(app, branch!))['start']!.with).toContain(host);
    expect(joints(wall(app, host!))['body']!.with).toContain(branch);
  });

  it('nearly-closed runs close and nearby ends of separate walls meet', () => {
    const app = createTestApp();
    const ids = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [4000, 0], [4000, 3000], [0, 3000], [60, 40]] });
    expect(ids).toHaveLength(4);
    const last = wall(app, ids[3]!);
    expect(last.points.at(-1)).toEqual([0 - last.x, 0 - last.y]);
    expect(joints(last)['end']).toEqual({ enabled: true, with: [ids[0]] });
    expect(joints(wall(app, ids[0]!))['start']).toEqual({ enabled: true, with: [ids[3]] });

    // A second wall drawn to within the join tolerance of an existing end snaps onto it.
    const [extra] = run<string[]>(app, 'create-wall-segments', { points: [[4080, 3050], [7000, 3000]] });
    const added = wall(app, extra!);
    expect([added.points[0]![0] + added.x, added.points[0]![1] + added.y]).toEqual([4000, 3000]);
    expect(joints(added)['start']!.with).toEqual([ids[1], ids[2]]);
    expect(joints(wall(app, ids[2]!))['start']!.with).toContain(extra);
  });

  it('dragging an unjoined end next to another wall end joins them', () => {
    const app = createTestApp();
    const [a] = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [3000, 0]] });
    const [b] = run<string[]>(app, 'create-wall-segments', { points: [[5000, 500], [5000, 3000]] });
    run(app, 'move-line-endpoint', { id: a!, endpoint: 'end', x: 4950, y: 470 });
    const moved = wall(app, a!);
    expect([moved.points[1]![0] + moved.x, moved.points[1]![1] + moved.y]).toEqual([5000, 500]);
    expect(joints(moved)['end']).toEqual({ enabled: true, with: [b] });
    expect(joints(wall(app, b!))['start']).toEqual({ enabled: true, with: [a] });
  });

  it('the joint toggle separates and re-joins both ends', () => {
    const app = createTestApp();
    const [a, b] = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [4000, 0], [4000, 3000]] });
    run(app, 'set-wall-joints', { id: a!, enabled: false });
    expect(joints(wall(app, a!))['end']).toEqual({ enabled: false, with: [] });
    expect(joints(wall(app, b!))['start']).toEqual({ enabled: false, with: [] });
    run(app, 'set-wall-joints', { id: a!, enabled: true });
    expect(joints(wall(app, a!))['end']).toEqual({ enabled: true, with: [b] });
    expect(joints(wall(app, b!))['start']).toEqual({ enabled: true, with: [a] });
  });

  it('renders square mitred corners with no round caps', () => {
    const app = createTestApp();
    const [a, b] = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [4000, 0], [4000, 3000]], parameters: { layers: [{ name: 'Core', role: 'core', thickness: 200 }] } });
    const elements = app.store.getState().doc.elements as ElementTable;
    const first = wall(app, a!);
    // Outer face (left of the drawing direction, y up in plan is -y) reaches the outer corner; inner face the inner corner.
    const outer = wallOffsetLine(first, elements, -100);
    const inner = wallOffsetLine(first, elements, 100);
    expect(outer.at(-1)).toEqual({ x: 4100 - first.x, y: -100 - first.y });
    expect(inner.at(-1)).toEqual({ x: 3900 - first.x, y: 100 - first.y });
    // The free start is a plain butt end.
    expect(outer[0]).toEqual({ x: 0 - first.x, y: -100 - first.y });
    expect(wallBodyPath(first, elements)).toMatch(/^M .* Z$/);
    expect(wallBodyPath(wall(app, b!), elements)).not.toContain('A ');
    const outline = wallOutlinePath(first, elements);
    expect(outline).toContain('M 0 -100 L 4100 -100');
    expect(outline).toContain('M 0 100 L 3900 100');
    expect(outline).toContain('M 0 -100 L 0 100');
    expect(outline).not.toContain('M 4100 -100 L 3900 100');
  });
});

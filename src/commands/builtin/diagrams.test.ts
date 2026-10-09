import { describe, expect, it } from 'vitest';
import { diagramOf, exitPoint, routePoints, tagText, themeOf } from '@/diagrams/model';
import { createTestApp, run } from '@/test/harness';

function linePoints(app: ReturnType<typeof createTestApp>, id: string): [number, number][] {
  const element = app.store.getState().doc.elements[id]!;
  if (element.kind !== 'line') throw new Error('not a line');
  return element.points.map(([x, y]) => [x + element.x, y + element.y]);
}

describe('diagram model', () => {
  it('routes orthogonal connectors along the dominant axis and clips at box edges', () => {
    expect(routePoints({ x: 0, y: 0 }, { x: 1000, y: 200 }, 'orthogonal')).toEqual([
      { x: 0, y: 0 },
      { x: 500, y: 0 },
      { x: 500, y: 200 },
      { x: 1000, y: 200 },
    ]);
    expect(routePoints({ x: 0, y: 0 }, { x: 100, y: 1000 }, 'orthogonal')[1]).toEqual({ x: 0, y: 500 });
    expect(exitPoint({ x: 0, y: 0, width: 200, height: 100 }, { x: 100, y: 50 }, { x: 1000, y: 50 })).toEqual({ x: 200, y: 50 });
  });

  it('fills tag templates from the target live', () => {
    const app = createTestApp();
    const rect = run<string>(app, 'create-rect', { x: 0, y: 0, width: 4000, height: 3000, name: 'Kitchen' });
    const { elements } = app.store.getState().doc;
    expect(tagText('{name}\n{area}', elements, elements[rect])).toBe('Kitchen\n12.0 m²');
    expect(tagText('{name}', elements, undefined)).toBe('—');
  });
});

describe('diagram commands', () => {
  it('creates arrows, callouts, dimensions and zones with kind defaults', () => {
    const app = createTestApp();
    const arrow = run<string>(app, 'create-diagram', { kind: 'arrow', points: [[0, 0], [1000, 0], [1000, 800]] });
    expect(diagramOf(app.store.getState().doc.elements[arrow])).toMatchObject({ kind: 'arrow', head: 'arrow', tail: 'none' });
    expect(linePoints(app, arrow)).toHaveLength(3);
    const callout = run<string>(app, 'create-diagram', { kind: 'callout', points: [[0, 0], [500, 500], [900, 900]], patch: { text: 'Existing wall' } });
    // A callout is a leader: target and note anchor only.
    expect(linePoints(app, callout)).toEqual([[0, 0], [900, 900]]);
    expect(diagramOf(app.store.getState().doc.elements[callout])!.text).toBe('Existing wall');
    const dimension = run<string>(app, 'create-diagram', { kind: 'dimension', points: [[0, 0], [3600, 0], [7200, 0]] });
    expect(diagramOf(app.store.getState().doc.elements[dimension])).toMatchObject({ head: 'bar', tail: 'bar', offset: 8 });
    const zone = run<string>(app, 'create-diagram', { kind: 'zone', x: 0, y: 5000, width: 6000, height: 4000, patch: { text: 'Living' } });
    const element = app.store.getState().doc.elements[zone]!;
    expect(element).toMatchObject({ kind: 'rect', name: 'Living', width: 6000 });
    run(app, 'set-diagram', { ids: [zone], patch: { text: 'Dining', shape: 'ellipse' } });
    expect(app.store.getState().doc.elements[zone]).toMatchObject({ name: 'Dining' });
    expect(diagramOf(app.store.getState().doc.elements[zone])!.shape).toBe('ellipse');
    expect(app.executor.dispatchSync('set-diagram', { ids: [zone], patch: { color: 'red' } }).ok).toBe(false);
  });

  it('glues connectors to the elements under their ends and keeps them glued', async () => {
    const app = createTestApp();
    const a = run<string>(app, 'create-rect', { x: 0, y: 0, width: 1000, height: 1000, style: { fill: '#ffffff' } });
    const b = run<string>(app, 'create-rect', { x: 5000, y: 0, width: 1000, height: 1000, style: { fill: '#ffffff' } });
    const connector = run<string>(app, 'create-diagram', { kind: 'connector', points: [[500, 500], [5500, 500]] });
    expect(diagramOf(app.store.getState().doc.elements[connector])).toMatchObject({ from: a, to: b, route: 'orthogonal' });
    // Ends sit on the facing box edges.
    expect(linePoints(app, connector)).toEqual([[1000, 500], [5000, 500]]);
    run(app, 'select', { ids: [b] });
    run(app, 'set-transform', { id: b, x: 5000, y: 4000 });
    const [start, end] = linePoints(app, connector);
    expect(start![1]).toBeGreaterThan(500);
    // From b's centre (5500, 4500) towards a's, the ray leaves b through its left edge.
    expect(end![0]).toBeCloseTo(5000);
    expect(end![1]).toBeCloseTo(4100);
    run(app, 'select', { ids: [a] });
    run(app, 'delete-selection');
    expect(diagramOf(app.store.getState().doc.elements[connector])!.from).toBeNull();
    // Undo brings the glue back with the element.
    expect((await app.executor.dispatch('undo')).ok).toBe(true);
    expect(diagramOf(app.store.getState().doc.elements[connector])!.from).toBe(a);
  });

  it('tags the element under the click, sized for its text, on the open sheet', () => {
    const app = createTestApp();
    const room = run<string>(app, 'create-rect', { x: 0, y: 0, width: 4000, height: 3000, name: 'Kitchen', style: { fill: '#ffffff' } });
    const tag = run<string>(app, 'create-diagram', { kind: 'tag', x: 2000, y: 1500 });
    const element = app.store.getState().doc.elements[tag]!;
    expect(diagramOf(element)).toMatchObject({ target: room, text: '{name}' });
    expect(element.kind === 'rect' && element.x + element.width / 2).toBeCloseTo(2000);
    expect(app.executor.dispatchSync('create-diagram', { kind: 'tag', x: 90_000, y: 90_000 }).ok).toBe(false);
    const paper = run<string>(app, 'create-paper', { x: 50_000, y: 0, scale: 50 });
    run(app, 'open-sheet', { id: paper });
    const onSheet = run<string>(app, 'create-diagram', { kind: 'arrow', points: [[51_000, 1000], [52_000, 1000]] });
    expect(app.store.getState().doc.elements[onSheet]!.parentId).toBe(paper);
  });

  it('switches the document theme', () => {
    const app = createTestApp();
    expect(themeOf(app.store.getState().doc).label).toBe('Technical');
    run(app, 'set-diagram-theme', { theme: 'soft' });
    expect(app.store.getState().doc.workspace.diagramTheme).toBe('soft');
    expect(themeOf(app.store.getState().doc).label).toBe('Soft');
    run(app, 'tool-diagram-zone');
    expect(app.store.getState().ui.tool).toBe('diagram:zone');
    expect(app.executor.dispatchSync('set-tool', { tool: 'diagram:zone' }).ok).toBe(true);
  });
});

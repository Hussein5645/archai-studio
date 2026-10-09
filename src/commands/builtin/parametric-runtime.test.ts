import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { graphRuntimeOf, parametricGraphOf } from './parametric';

function fixture() {
  const app = createTestApp();
  const source = run<string>(app, 'create-rect', { x: 1000, y: 0, width: 500, height: 100 });
  const target = run<string>(app, 'create-rect', { x: 0, y: 0, width: 100, height: 100 });
  const id = run<string>(app, 'create-parametric-component', { x: 0, y: 0 });
  const graph = parametricGraphOf(app.store.getState().doc.elements[id]!.meta?.['parametricGraph'])!;
  graph.nodes.push({ id: 'source', kind: 'element', elementId: source, label: 'Source', x: 0, y: 0 }, { id: 'target', kind: 'element', elementId: target, label: 'Target', x: 300, y: 0 });
  graph.links.push({ id: 'width', fromNode: 'source', fromSocket: 'output:x', toNode: 'target', toSocket: 'input:width' });
  run(app, 'set-parametric-graph', { id, graph });
  run(app, 'close-parametric-editor');
  return { app, id, source, target, graph };
}

describe('live graphs', () => {
  it('moves nested and hosted layers when graph code moves their parent', async () => {
    const { app, id, source, target, graph } = fixture();
    const child = run<string>(app, 'create-rect', { x: 50, y: 70, width: 20, height: 20 });
    run(app, 'reparent-element', { id: child, parentId: target });
    const hosted = run<string>(app, 'create-rect', { x: 150, y: 170, width: 20, height: 20 });
    run(app, 'set-host', { id: hosted, hostId: target });
    const nested = run<string>(app, 'create-rect', { x: 160, y: 180, width: 10, height: 10 });
    run(app, 'set-host', { id: nested, hostId: hosted });
    graph.links[0]!.toSocket = 'input:x';
    run(app, 'set-parametric-graph', { id, graph });
    run(app, 'start-parametric-graph', { id });
    expect(app.store.getState().doc.elements[hosted]!.x).toBe(1150);
    expect(app.store.getState().doc.elements[nested]!.x).toBe(1160);
    run(app, 'set-transform', { id: source, x: 2000 });
    expect(app.store.getState().doc.elements[hosted]!.x).toBe(2150);
    expect(app.store.getState().doc.elements[nested]!.x).toBe(2160);
    expect(app.store.getState().doc.elements[child]!.x).toBe(50);
    await app.executor.dispatch('undo');
    expect(app.store.getState().doc.elements[hosted]!.x).toBe(1150);
    run(app, 'stop-parametric-graph', { id });
    run(app, 'move-selection', { ids: [target], dx: 100, dy: 200 });
    expect(app.store.getState().doc.elements[hosted]).toMatchObject({ x: 1250, y: 370 });
    expect(app.store.getState().doc.elements[nested]).toMatchObject({ x: 1260, y: 380 });
  });

  it('propagates between running graphs regardless of component creation order', () => {
    const { app, id, source, target } = fixture();
    const upstream = run<string>(app, 'create-parametric-component', { x: 0, y: 0 });
    const input = run<string>(app, 'create-rect', { x: 2400, y: 0, width: 100, height: 100 });
    const graph = parametricGraphOf(app.store.getState().doc.elements[upstream]!.meta?.['parametricGraph'])!;
    graph.nodes.push({ id: 'input', kind: 'element', elementId: input, label: 'Input', x: 0, y: 0 }, { id: 'output', kind: 'element', elementId: source, label: 'Output', x: 300, y: 0 });
    graph.links.push({ id: 'position', fromNode: 'input', fromSocket: 'output:x', toNode: 'output', toSocket: 'input:x' });
    run(app, 'set-parametric-graph', { id: upstream, graph });
    run(app, 'start-parametric-graph', { id });
    run(app, 'start-parametric-graph', { id: upstream });
    expect(app.store.getState().doc.elements[target]).toMatchObject({ width: 2400 });
    run(app, 'set-transform', { id: input, x: 3200 });
    expect(app.store.getState().doc.elements[source]).toMatchObject({ x: 3200 });
    expect(app.store.getState().doc.elements[target]).toMatchObject({ width: 3200 });
    expect(graphRuntimeOf(app.store.getState().doc.elements[id]).status).toBe('running');
  });

  it('updates with the editor closed, groups derived edits into undo, and stops', async () => {
    const { app, id, source, target } = fixture();
    run(app, 'start-parametric-graph', { id });
    expect(graphRuntimeOf(app.store.getState().doc.elements[id]).status).toBe('running');
    expect(app.store.getState().doc.elements[target]).toMatchObject({ width: 1000 });
    const history = app.store.getState().history.past.length;
    run(app, 'set-transform', { id: source, x: 1800 });
    expect(app.store.getState().doc.elements[target]).toMatchObject({ width: 1800 });
    expect(app.store.getState().history.past).toHaveLength(history + 1);
    await app.executor.dispatch('undo');
    expect(app.store.getState().doc.elements[source]).toMatchObject({ x: 1000 });
    expect(app.store.getState().doc.elements[target]).toMatchObject({ width: 1000 });
    await app.executor.dispatch('redo');
    expect(app.store.getState().doc.elements[target]).toMatchObject({ width: 1800 });
    run(app, 'stop-parametric-graph', { id });
    run(app, 'set-transform', { id: source, x: 2200 });
    expect(app.store.getState().doc.elements[target]).toMatchObject({ width: 1800 });
    run(app, 'start-parametric-graph', { id });
    expect(app.store.getState().doc.elements[target]).toMatchObject({ width: 2200 });
  });

  it('updates drag previews without committing a history entry', () => {
    const { app, id, source, target } = fixture();
    run(app, 'start-parametric-graph', { id });
    const before = app.store.getState();
    const preview = app.executor.preview('set-transform', { id: source, x: 2500 }, before.doc);
    expect(preview.elements[target]).toMatchObject({ width: 2500 });
    expect(app.store.getState()).toBe(before);
  });

  it('supports a wall location driving its own height', () => {
    const { app, id, graph } = fixture();
    const wall = run<string[]>(app, 'create-wall-segments', { points: [[0, 1000], [2000, 1000]] })[0]!;
    run(app, 'set-system-configuration', { id: wall, assetId: null, parameters: {}, instanceEditable: ['height'] });
    graph.nodes = [graph.nodes[0]!, { id: 'wall', kind: 'element', label: 'Wall', elementId: wall, x: 0, y: 0 }];
    graph.links = [{ id: 'self', fromNode: 'wall', fromSocket: 'output:y', toNode: 'wall', toSocket: 'input:parameter:height' }];
    run(app, 'set-parametric-graph', { id, graph });
    run(app, 'start-parametric-graph', { id });
    run(app, 'set-transform', { id: wall, y: 2300 });
    expect(graphRuntimeOf(app.store.getState().doc.elements[id]).status).toBe('running');
    expect(app.store.getState().doc.elements[wall]!.meta?.['arch']).toMatchObject({ parameters: { height: 2300 } });
  });

  it('retains user edits but rolls back failed graph results and stops with an error', () => {
    const { app, id, source, target } = fixture();
    run(app, 'start-parametric-graph', { id });
    run(app, 'set-transform', { id: source, x: -100 });
    expect(app.store.getState().doc.elements[source]).toMatchObject({ x: -100 });
    expect(app.store.getState().doc.elements[target]).toMatchObject({ width: 1000 });
    expect(graphRuntimeOf(app.store.getState().doc.elements[id]).status).toBe('error');
    run(app, 'set-transform', { id: source, x: 1500 });
    expect(app.store.getState().doc.elements[target]).toMatchObject({ width: 1000 });
    run(app, 'start-parametric-graph', { id });
    expect(app.store.getState().doc.elements[target]).toMatchObject({ width: 1500 });
  });

  it('discovers Layers descendants and hosted doors while the graph is closed', () => {
    const { app, id } = fixture();
    const marker = Object.values(app.store.getState().doc.elements).find((element) => element.parentId === id && element.meta?.['parametricMarker'])!;
    const wall = run<string[]>(app, 'create-wall-segments', { points: [[0, 0], [4000, 0]] })[0]!;
    run(app, 'reparent-element', { id: wall, parentId: marker.id });
    const door = run<string>(app, 'create-arch-element', { tool: 'door', x: 1500, y: 0 });
    run(app, 'set-host', { id: door, hostId: wall });
    const graph = parametricGraphOf(app.store.getState().doc.elements[id]!.meta?.['parametricGraph'])!;
    expect(graph.nodes.some((node) => node.elementId === wall)).toBe(true);
    expect(graph.nodes.some((node) => node.elementId === door)).toBe(true);
    expect(graph.nodes.some((node) => node.elementId === marker.id)).toBe(false);
    run(app, 'reparent-element', { id: wall, parentId: null });
    const next = parametricGraphOf(app.store.getState().doc.elements[id]!.meta?.['parametricGraph'])!;
    expect(next.nodes.some((node) => node.elementId === wall || node.elementId === door)).toBe(false);
  });
});

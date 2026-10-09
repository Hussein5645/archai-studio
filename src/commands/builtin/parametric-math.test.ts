import { describe, expect, it } from 'vitest';
import { createTestApp, run } from '@/test/harness';
import { graphValue, parametricGraphOf, type ParametricGraph } from './parametric';

function fixture() {
  const app = createTestApp();
  const source = run<string>(app, 'create-rect', { x: 0, y: 0, width: 500, height: 300 });
  const target = run<string>(app, 'create-rect', { x: 100, y: 0, width: 100, height: 100 });
  const id = run<string>(app, 'create-parametric-component', { x: 0, y: 0 });
  const graph = parametricGraphOf(app.store.getState().doc.elements[id]!.meta?.['parametricGraph'])!;
  graph.nodes.push(
    { id: 'source', kind: 'element', x: 0, y: 0, label: 'Source', elementId: source, inputValues: { width: 600 } },
    { id: 'target', kind: 'element', x: 0, y: 0, label: 'Target', elementId: target },
    { id: 'multiply', kind: 'math', x: 0, y: 0, label: 'Double width', operation: 'multiply', inputValues: { b: 2 } },
    { id: 'add', kind: 'math', x: 0, y: 0, label: 'Gap', operation: 'add', inputValues: { b: 50 } },
  );
  graph.executionOrder = ['source', 'target'];
  graph.links = [
    { id: '1', fromNode: 'source', fromSocket: 'output:width', toNode: 'multiply', toSocket: 'input:a' },
    { id: '2', fromNode: 'multiply', fromSocket: 'value', toNode: 'add', toSocket: 'input:a' },
    { id: '3', fromNode: 'add', fromSocket: 'value', toNode: 'target', toSocket: 'input:x' },
  ];
  return { app, id, graph, source, target };
}

describe('parametric calculations', () => {
  it('chains arithmetic using updated element outputs and supports undo', async () => {
    const { app, id, graph, target } = fixture();
    run(app, 'set-parametric-graph', { id, graph });
    run(app, 'run-parametric-graph', { id });
    expect(app.store.getState().doc.elements[target]!.x).toBe(1250);
    await app.executor.dispatch('undo');
    expect(app.store.getState().doc.elements[target]!.x).toBe(100);
  });

  it.each(['cycle', 'divide', 'order'] as const)('rejects %s without partially changing elements', (failure) => {
    const { app, id, graph, source, target } = fixture();
    if (failure === 'cycle') graph.links.push({ id: 'cycle', fromNode: 'add', fromSocket: 'value', toNode: 'multiply', toSocket: 'input:b' });
    if (failure === 'divide') Object.assign(graph.nodes.find((node) => node.id === 'multiply')!, { operation: 'divide', inputValues: { b: 0 } });
    if (failure === 'order') graph.executionOrder = ['target', 'source'];
    run(app, 'set-parametric-graph', { id, graph });
    expect(app.executor.dispatchSync('run-parametric-graph', { id }).ok).toBe(false);
    expect(app.store.getState().doc.elements[target]!.x).toBe(100);
    expect(app.store.getState().doc.elements[source]).toMatchObject({ width: 500 });
  });

  it('calculates against copies without modifying source instances', () => {
    const { app, id, graph, source, target } = fixture();
    graph.executionMode = 'copy';
    graph.copyOffset = { x: 1000, y: 1000 };
    run(app, 'set-parametric-graph', { id, graph });
    run(app, 'run-parametric-graph', { id });
    expect(app.store.getState().doc.elements[source]).toMatchObject({ width: 500 });
    expect(app.store.getState().doc.elements[target]!.x).toBe(100);
    const copies = app.store.getState().ui.selection.map((id) => app.store.getState().doc.elements[id]!);
    expect(copies).toEqual(expect.arrayContaining([expect.objectContaining({ x: 2250, y: 1000 })]));
  });

  it.each<[NonNullable<ParametricGraph['nodes'][number]['operation']>, number]>([['add', 11], ['subtract', 5], ['multiply', 24], ['divide', 8 / 3], ['min', 3], ['max', 8], ['power', 512]])('evaluates %s', (operation, expected) => {
    const { graph } = fixture();
    graph.links = [];
    const node = graph.nodes.find((node) => node.id === 'multiply')!;
    Object.assign(node, { operation, inputValues: { a: 8, b: 3 } });
    expect(graphValue(graph, node.id, 'value', () => null)?.value).toBe(expected);
  });
});

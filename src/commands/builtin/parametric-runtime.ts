import { applyPatches, current, produce, produceWithPatches } from 'immer';
import { z } from 'zod';
import type { ArchaiDocument, Element, ElementTable } from '@/document';
import { graphReferenceElements, graphReferenceLabel } from '@/graph/references';
import { defineMutation } from '../contract';
import { graphRuntimeOf, parametricGraphOf, runParametricGraph, type ParametricGraph } from './parametric';

function syncReferences(elements: ElementTable, component: Element) {
  const graph = parametricGraphOf(component.meta?.['parametricGraph']);
  if (!graph) return;
  const before = JSON.stringify(graph);
  const available = graphReferenceElements(elements, component.id);
  const ids = new Set(available.map((element) => element.id));
  const removed = graph.nodes.filter((node) => node.automatic && node.elementId && !ids.has(node.elementId)).map((node) => node.id);
  for (const id of removed) {
    if (!graph.executionLinks) continue;
    const incoming = graph.executionLinks.find((link) => link.toNode === id);
    const outgoing = graph.executionLinks.find((link) => link.fromNode === id);
    graph.executionLinks = graph.executionLinks.filter((link) => link.fromNode !== id && link.toNode !== id);
    if (incoming && outgoing) graph.executionLinks.push({ fromNode: incoming.fromNode, toNode: outgoing.toNode });
  }
  graph.nodes = graph.nodes.filter((node) => !removed.includes(node.id));
  graph.links = graph.links.filter((link) => !removed.includes(link.fromNode) && !removed.includes(link.toNode));
  graph.executionOrder = graph.executionOrder.filter((id) => !removed.includes(id));
  for (const element of available) {
    const existing = graph.nodes.find((node) => node.elementId === element.id);
    const label = graphReferenceLabel(elements, component.id, element);
    if (existing) { if (existing.automatic) existing.label = label; continue; }
    if (graph.excludedElementIds.includes(element.id)) continue;
    let id = `ref-${element.id}`;
    while (graph.nodes.some((node) => node.id === id)) id += '-ref';
    graph.nodes.push({ id, elementId: element.id, kind: 'element', automatic: true, label, x: 330, y: 150 + graph.nodes.filter((node) => node.elementId).length * 320 });
    graph.executionOrder.push(id);
    const finish = graph.nodes.find((node) => node.kind === 'output');
    const last = graph.executionLinks?.find((link) => link.toNode === finish?.id);
    if (last && finish) {
      last.toNode = id;
      graph.executionLinks!.push({ fromNode: id, toNode: finish.id });
    }
  }
  if (JSON.stringify(graph) !== before) component.meta = { ...component.meta, parametricGraph: graph };
}

function inputsKey(doc: ArchaiDocument, graph: ParametricGraph): string {
  return JSON.stringify({
    variables: graph.variables, links: graph.links, order: graph.executionOrder, executionLinks: graph.executionLinks, mode: graph.executionMode,
    nodes: graph.nodes.map(({ id, kind, elementId, variableId, operation, configuration, inputValues }) => ({ id, kind, elementId, variableId, operation, configuration, inputValues })),
    elements: graph.nodes.filter((node) => node.elementId).map((node) => {
      const element = doc.elements[node.elementId!];
      if (!element) return null;
      const meta = { ...element.meta };
      delete meta['parametricGraph']; delete meta['parametricRuntime']; delete meta['parametricLastRun'];
      return { ...element, meta };
    }),
  });
}

/** Executor hook: discovery and live results are part of the user's edit and its undo. */
export const syncParametricGraphs = defineMutation({
  id: 'sync-parametric-graphs', label: 'Refresh parametric graphs', group: 'edit', palette: false, history: 'none',
  input: z.object({ previous: z.custom<ArchaiDocument>() }),
  run: (ctx, { previous }) => {
    const componentIds = Object.values(ctx.doc.elements).filter((element) => element.meta?.['parametricGraph']).map((element) => element.id);
    if (!componentIds.length) return;
    const keys = new Map<string, string>();
    for (const id of componentIds) {
      const previousComponent = previous.elements[id];
      const previousGraph = parametricGraphOf(previousComponent?.meta?.['parametricGraph']);
      if (previous.id === ctx.doc.id && previousGraph && graphRuntimeOf(previousComponent).status === 'running') keys.set(id, inputsKey(previous, previousGraph));
      syncReferences(ctx.doc.elements, ctx.doc.elements[id]!);
    }
    for (let pass = 0; pass < Math.max(8, componentIds.length + 1); pass++) {
      let ran = false;
      for (const id of componentIds) {
        const component = ctx.doc.elements[id]!;
        if (graphRuntimeOf(component).status !== 'running') continue;
        const graph = parametricGraphOf(component.meta?.['parametricGraph'])!;
        const key = inputsKey(ctx.doc, graph);
        if (keys.get(id) === key) continue;
        ran = true;
        try {
          if (graph.executionMode !== 'update') throw new Error('Live running requires Update elements. Use Run once to copy results.');
          // A failed evaluation rolls back its entire result, while retaining the user's input edit.
          const [, patches] = produceWithPatches(current(ctx.doc), (doc) => {
            produce(current(ctx.ui), (ui) => { produce(current(ctx.session), (session) => { runParametricGraph.run({ ...ctx, doc, ui, session }, { id }); }); });
          });
          applyPatches(ctx.doc, patches);
          keys.set(id, inputsKey(ctx.doc, graph));
        } catch (error) {
          const target = ctx.doc.elements[id]!;
          target.meta = { ...target.meta, parametricRuntime: { status: 'error', message: error instanceof Error ? error.message : 'Graph evaluation failed' } };
        }
      }
      if (!ran) return;
    }
    for (const id of componentIds) {
      const component = ctx.doc.elements[id]!;
      const graph = parametricGraphOf(component.meta?.['parametricGraph'])!;
      if (graphRuntimeOf(component).status === 'running' && inputsKey(ctx.doc, graph) !== keys.get(id)) component.meta = { ...component.meta, parametricRuntime: { status: 'error', message: 'Running graphs form a feedback loop. Stop the other graph or change the connections, then start again.' } };
    }
  },
});

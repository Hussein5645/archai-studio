import { z } from 'zod';
import { IdSchema, JsonValueSchema, isAncestor, descendantsOf, type AssetDefinition, type Element, type ElementTable, type GroupElement, type RectElement } from '@/document';
import { defineMutation, CommandError } from '../contract';
import { cloneSubtrees, setSelection, topIndex, requireTargets, snapshot } from '../helpers';
import { reparentElement } from './arrange';
import { setProperty } from './edit';
import { moveLineEndpoint, setSystemParameter } from './system';
import { setTransform } from './transform';
import { setInstanceElevation } from './view3d';
import { setElementLevelLink, setLevelElevation } from './levels';
import { setSystemConfiguration } from './assets';
import { setCaiParameters } from './caiParameters';
import { isPoint } from '@/document/point';
import { instanceValues, parametricInstanceOf, recipeOf } from '@/catalog/parametric';
import { instanceElevationOf, levelElevationOf } from '@/view3d/geometry';
import { instanceParameterKeys, isSystemAssetType, SYSTEM_PARAMETER_DEFINITIONS } from '@/assets/system-assets';
import { applyToPoint, worldMatrix, invert, multiply } from '@/geometry';

export const ParametricVariableSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  type: z.enum(['float', 'int', 'boolean', 'text', 'dropdown', 'profile2d', 'layers', 'number', 'length', 'angle', 'count']),
  value: JsonValueSchema,
  instanceEditable: z.boolean().default(true),
});

export const ParametricNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['variable', 'math', 'element', 'cai-model', 'output', 'start']),
  operation: z.enum(['add', 'subtract', 'multiply', 'divide', 'min', 'max', 'power']).optional(),
  x: z.number().finite(),
  y: z.number().finite(),
  label: z.string().max(120),
  variableId: z.string().optional(),
  elementId: IdSchema.optional(),
  assetId: z.string().optional(),
  automatic: z.boolean().optional(),
  inputValues: z.record(z.string(), JsonValueSchema).optional(),
  /** Collapsed reference nodes show only their connected pins. */
  collapsed: z.boolean().optional(),
  configuration: z.object({ assetId: z.string().nullable(), assetName: z.string().optional(), parameters: z.record(z.string(), JsonValueSchema), instanceEditable: z.array(z.string()) }).optional(),
});

export const ParametricLinkSchema = z.object({
  id: z.string().min(1),
  fromNode: z.string().min(1),
  fromSocket: z.string().min(1),
  toNode: z.string().min(1),
  toSocket: z.string().min(1),
});

export const ParametricGraphSchema = z.object({
  version: z.literal(1),
  variables: z.array(ParametricVariableSchema),
  nodes: z.array(ParametricNodeSchema),
  links: z.array(ParametricLinkSchema),
  executionMode: z.enum(['update', 'copy']).default('update'),
  copyOffset: z.object({ x: z.number().finite(), y: z.number().finite() }).default({ x: 1000, y: 1000 }),
  executionOrder: z.array(z.string()).default([]),
  executionLinks: z.array(z.object({ fromNode: z.string(), toNode: z.string() })).optional(),
  startPosition: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
  excludedElementIds: z.array(IdSchema).default([]),
});

export type ParametricGraph = z.infer<typeof ParametricGraphSchema>;

export const GRAPH_START = '@start';

/** How far a reference point's centre is from its box corner (0 for other elements). */
export function pointCentreOffset(element: Element): number {
  return isPoint(element) && element.kind === 'rect' ? element.width / 2 : 0;
}
export function executionLinksOf(graph: ParametricGraph): { fromNode: string; toNode: string }[] {
  if (graph.executionLinks) return graph.executionLinks;
  const steps = [...new Set([...graph.executionOrder, ...graph.nodes.filter((node) => node.elementId).map((node) => node.id)])].filter((id) => graph.nodes.some((node) => node.id === id && node.elementId));
  const finish = graph.nodes.find((node) => node.kind === 'output');
  const chain = [GRAPH_START, ...steps, ...(finish ? [finish.id] : [])];
  return chain.slice(1).map((id, index) => ({ fromNode: chain[index]!, toNode: id }));
}

export function executionSteps(graph: ParametricGraph): string[] {
  const links = executionLinksOf(graph);
  const finish = graph.nodes.find((node) => node.kind === 'output');
  const steps = graph.nodes.filter((node) => node.elementId);
  const valid = new Set([GRAPH_START, ...steps.map((node) => node.id), ...(finish ? [finish.id] : [])]);
  const outgoing = new Map<string, string>();
  const incoming = new Set<string>();
  for (const link of links) {
    if (!valid.has(link.fromNode) || !valid.has(link.toNode) || link.toNode === GRAPH_START || link.fromNode === finish?.id) throw new CommandError('rejected', 'Execution pins can connect only Start, instance steps, and Finish.');
    if (outgoing.has(link.fromNode) || incoming.has(link.toNode)) throw new CommandError('rejected', 'Each execution pin accepts one wire.');
    outgoing.set(link.fromNode, link.toNode);
    incoming.add(link.toNode);
  }
  const result: string[] = [];
  const visited = new Set<string>([GRAPH_START]);
  let current = GRAPH_START;
  while (current !== finish?.id) {
    const next = outgoing.get(current);
    if (!next) throw new CommandError('rejected', 'Execution is incomplete. Wire Start through the instance steps to Finish.');
    if (visited.has(next)) throw new CommandError('rejected', 'Execution wires cannot form a cycle.');
    visited.add(next);
    if (next !== finish?.id) result.push(next);
    current = next;
  }
  const disconnected = steps.find((node) => !visited.has(node.id));
  if (disconnected) throw new CommandError('rejected', `Connect ${disconnected.label} to the execution chain, or remove its reference node.`);
  return result;
}

/** Resolve calculations against current values, including outputs updated earlier in this run. */
export function graphValue(graph: ParametricGraph, nodeId: string, socket: string, readElement: (nodeId: string, socket: string) => ParametricGraph['variables'][number] | null, visiting = new Set<string>()): ParametricGraph['variables'][number] | null {
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node) throw new CommandError('rejected', 'A connected source node is missing');
  if (node.kind === 'variable') return graph.variables.find((item) => item.id === node.variableId) ?? null;
  if (node.kind !== 'math') return readElement(nodeId, socket);
  if (visiting.has(nodeId)) throw new CommandError('rejected', `Calculation cycle at ${node.label}`);
  const next = new Set(visiting).add(nodeId);
  const input = (key: string) => {
    const link = graph.links.find((item) => item.toNode === nodeId && item.toSocket === `input:${key}`);
    const value = link ? graphValue(graph, link.fromNode, link.fromSocket, readElement, next)?.value : node.inputValues?.[key] ?? 0;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new CommandError('invalid-input', `${node.label}: ${key.toUpperCase()} must be a finite number`);
    return value;
  };
  const a = input('a');
  const b = input('b');
  if (node.operation === 'divide' && b === 0) throw new CommandError('invalid-input', `${node.label}: cannot divide by zero`);
  const value = node.operation === 'subtract' ? a - b : node.operation === 'multiply' ? a * b : node.operation === 'divide' ? a / b : node.operation === 'min' ? Math.min(a, b) : node.operation === 'max' ? Math.max(a, b) : node.operation === 'power' ? a ** b : a + b;
  if (!Number.isFinite(value)) throw new CommandError('invalid-input', `${node.label}: result must be a finite number`);
  return { id: node.id, name: node.label, type: 'float', value, instanceEditable: false };
}

export function parametricGraphOf(value: unknown): ParametricGraph | null {
  const parsed = ParametricGraphSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function graphRuntimeOf(element: Element | undefined): { status: 'running' | 'stopped' | 'error'; message?: string } {
  const value = element?.meta?.['parametricRuntime'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'stopped' };
  return { status: value['status'] === 'running' ? 'running' : value['status'] === 'error' ? 'error' : 'stopped', ...(typeof value['message'] === 'string' ? { message: value['message'] } : {}) };
}

const graphControlInput = z.object({ id: IdSchema });
export const startParametricGraph = defineMutation({
  id: 'start-parametric-graph', label: 'Start live graph', group: 'edit', palette: false, history: 'record', input: graphControlInput,
  run: (ctx, { id }) => {
    const component = ctx.doc.elements[id];
    const graph = parametricGraphOf(component?.meta?.['parametricGraph']);
    if (!component || !graph) throw new CommandError('rejected', 'Choose a parametric component.');
    if (graph.executionMode === 'copy') throw new CommandError('rejected', 'Choose Update elements for live running. Copy result is available with Run once.');
    component.meta = { ...component.meta, parametricRuntime: { status: 'running' } };
  },
});
export const stopParametricGraph = defineMutation({
  id: 'stop-parametric-graph', label: 'Stop live graph', group: 'edit', palette: false, history: 'record', input: graphControlInput,
  run: (ctx, { id }) => {
    const component = ctx.doc.elements[id];
    if (!component?.meta?.['parametricGraph']) throw new CommandError('rejected', 'Choose a parametric component.');
    component.meta = { ...component.meta, parametricRuntime: { status: 'stopped' } };
  },
});

export const createParametricComponent = defineMutation({
  id: 'create-parametric-component',
  label: 'Parametric component',
  description: 'Places a parametric component origin and opens its node graph.',
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(100).optional(), height: z.number().finite().min(100).optional(), openEditor: z.boolean().default(true), name: z.string().trim().min(1).max(120).default('Parametric component') }).refine((value) => (value.width === undefined) === (value.height === undefined), 'Provide both width and height for a graph rectangle'),
  run: (ctx, input) => {
    const id = ctx.ids.next('el');
    const markerId = ctx.ids.next('el');
    const outputId = `node-${ctx.ids.next('el')}`;
    const graph: ParametricGraph = {
      version: 1,
      variables: [],
      nodes: [{ id: outputId, kind: 'output', x: 850, y: 150, label: 'Geometry output' }],
      links: [],
      executionMode: 'update',
      copyOffset: { x: 1000, y: 1000 },
      executionOrder: [],
      excludedElementIds: [],
    };
    const group: GroupElement = {
      id, kind: 'group', parentId: null, index: topIndex(ctx.doc.elements as ElementTable, null),
      x: input.x, y: input.y, rotation: 0, visible: true, locked: false, name: input.name,
      meta: { parametricGraph: graph, parametricComponent: true },
    };
    const marker: RectElement = {
      id: markerId, kind: 'rect', parentId: id, index: 'a0', x: input.width === undefined ? -600 : 0, y: input.height === undefined ? -350 : 0, rotation: 0,
      visible: true, locked: false, width: input.width ?? 1200, height: input.height ?? 700, radius: 25,
      style: { fill: '#eef4ff', stroke: '#2563eb', strokeWidth: 28, opacity: 0.78 },
      name: 'Graph origin', meta: { parametricMarker: true },
    };
    ctx.doc.elements[id] = group;
    ctx.doc.elements[markerId] = marker;
    if (input.openEditor) ctx.ui.parametricEditor = { open: true, elementId: id };
    ctx.ui.tool = 'select';
    setSelection(ctx, [input.openEditor ? id : markerId]);
    return id;
  },
});

export const createParametricFolder = defineMutation({
  id: 'create-parametric-folder', label: 'Create parametric component from selection', group: 'arrange', history: 'record',
  description: 'Puts selected elements in a parametric folder, preserving their board positions, and opens its graph.',
  input: z.object({ ids: z.array(IdSchema).optional(), name: z.string().trim().min(1).max(120).default('Parametric component') }).default({ name: 'Parametric component' }),
  run: (ctx, input) => {
    const targets = requireTargets(ctx, input.ids);
    if (!targets.length) throw new CommandError('rejected', 'Select elements to put in a parametric component.');
    const roots = targets.filter((element) => !targets.some((other) => other.id !== element.id && isAncestor(ctx.doc.elements, other.id, element.id)));
    const first = worldMatrix(ctx.doc.elements, roots[0]!);
    const id = createParametricComponent.run(ctx, { x: first[4] - 600, y: first[5], name: input.name, openEditor: true });
    for (const element of roots) reparentElement.run(ctx, { id: element.id, parentId: id, placement: 'front' });
    const component = ctx.doc.elements[id]!;
    const graph = parametricGraphOf(component.meta?.['parametricGraph'])!;
    const references = descendantsOf(ctx.doc.elements, id).filter((element) => !element.meta?.['parametricMarker']).map((element, index) => ({ id: `node-${ctx.ids.next('el')}`, kind: 'element' as const, elementId: element.id, label: element.name || element.kind, x: 330, y: 150 + index * 320, automatic: true }));
    component.meta = { ...component.meta, parametricGraph: { ...graph, nodes: [...graph.nodes, ...references], executionOrder: references.map((node) => node.id) } };
    setSelection(ctx, [id]);
    return id;
  },
});

export const setParametricGraph = defineMutation({
  id: 'set-parametric-graph',
  label: 'Update parametric graph',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, graph: ParametricGraphSchema }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    if (!element || element.kind !== 'group' || !parametricGraphOf(element.meta?.['parametricGraph'])) throw new CommandError('rejected', 'Select a parametric component');
    element.meta = { ...(element.meta ?? {}), parametricGraph: input.graph };
    return element.id;
  },
});

export const openParametricEditor = defineMutation({
  id: 'open-parametric-editor', label: 'Edit parametric component', group: 'edit', palette: false, history: 'none',
  input: z.object({ id: IdSchema }),
  run: (ctx, input) => {
    const element = ctx.doc.elements[input.id];
    if (!element || !parametricGraphOf(element.meta?.['parametricGraph'])) throw new CommandError('rejected', 'Select a parametric component');
    ctx.ui.parametricEditor = { open: true, elementId: input.id };
    const graph = parametricGraphOf(element.meta?.['parametricGraph'])!;
    for (const node of graph.nodes) {
      if (node.elementId && ctx.doc.elements[node.elementId]) markParametricReference.run(ctx, { componentId: input.id, elementId: node.elementId });
    }
  },
});

export const closeParametricEditor = defineMutation({
  id: 'close-parametric-editor', label: 'Close parametric editor', group: 'edit', palette: false, history: 'none', input: z.void(),
  run: (ctx) => { ctx.ui.parametricEditor = { open: false, elementId: null }; },
});

export const markParametricReference = defineMutation({
  id: 'mark-parametric-reference',
  label: 'Use in parametric graph',
  description: 'Links an element without replacing its type preset.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ componentId: IdSchema, elementId: IdSchema }),
  run: (ctx, input) => {
    const component = ctx.doc.elements[input.componentId];
    const element = ctx.doc.elements[input.elementId];
    if (!component || !parametricGraphOf(component.meta?.['parametricGraph'])) throw new CommandError('rejected', 'Select a parametric component');
    if (!element) throw new CommandError('rejected', 'The referenced element is missing');
    const arch = element.meta?.['arch'];
    if (arch && typeof arch === 'object' && !Array.isArray(arch)) {
      const next = { ...arch };
      delete next['graphPreset'];
      if (next['systemAssetName'] === 'Graph') delete next['systemAssetName'];
      element.meta = { ...(element.meta ?? {}), arch: next };
    }
    return element.id;
  },
});

function variableFitsParameter(variable: ParametricGraph['variables'][number], target: ElementTable[string], key: string): boolean {
  const arch = target.meta?.['arch'];
  if (!arch || typeof arch !== 'object' || Array.isArray(arch) || !isSystemAssetType(arch['type'])) return false;
  const exposed = instanceParameterKeys(arch['type'], arch['instanceEditable']);
  if (!exposed.includes(key)) return false;
  const definition = SYSTEM_PARAMETER_DEFINITIONS[arch['type']].find((item) => item.key === key);
  if (!definition) return false;
  if (definition.kind === 'number') return ['float', 'int', 'number', 'length', 'angle', 'count'].includes(variable.type) && typeof variable.value === 'number';
  if (definition.kind === 'boolean') return variable.type === 'boolean' && typeof variable.value === 'boolean';
  if (definition.kind === 'select') return variable.type === 'dropdown' && typeof variable.value === 'string' && Boolean(definition.options?.some((option) => option.value === variable.value));
  if (definition.kind === 'profile') return variable.type === 'profile2d' && Array.isArray(variable.value);
  if (definition.kind === 'layers') return variable.type === 'layers' && Array.isArray(variable.value);
  return false;
}

function elementOutput(element: ElementTable[string], socket: string, definitions: Readonly<Record<string, AssetDefinition>> = {}): { name: string; type: ParametricGraph['variables'][number]['type']; value: z.infer<typeof JsonValueSchema>; instanceEditable: boolean; id: string } | null {
  if (!socket.startsWith('output:')) return null;
  const key = socket.slice('output:'.length);
  let value: z.infer<typeof JsonValueSchema> | undefined;
  let type: ParametricGraph['variables'][number]['type'] = 'float';
  if (key.startsWith('parameter:')) {
    const parameterKey = key.slice('parameter:'.length);
    const arch = element.meta?.['arch'];
    if (!arch || typeof arch !== 'object' || Array.isArray(arch) || !isSystemAssetType(arch['type'])) return null;
    const definition = SYSTEM_PARAMETER_DEFINITIONS[arch['type']].find((item) => item.key === parameterKey);
    const parameters = arch['parameters'];
    value = parameters && typeof parameters === 'object' && !Array.isArray(parameters) ? parameters[parameterKey] : definition?.defaultValue;
    type = definition?.kind === 'boolean' ? 'boolean' : definition?.kind === 'select' ? 'dropdown' : definition?.kind === 'profile' ? 'profile2d' : definition?.kind === 'layers' ? 'layers' : 'float';
  } else if (key.startsWith('cai:')) {
    // A parameter of a placed parametric .CAI copy (see src/catalog/parametric.ts).
    const recipe = element.kind === 'instance' ? recipeOf(definitions[element.definitionId]) : null;
    if (!recipe) return null;
    value = instanceValues(recipe, parametricInstanceOf(element))[key.slice('cai:'.length)];
  } else if (key === 'name') { value = element.name ?? ''; type = 'text'; }
  else if (key === 'visible') { value = element.visible; type = 'boolean'; }
  // A reference point's location is its centre (as the Inspector shows it).
  else if (key === 'x' || key === 'y') value = element[key] + pointCentreOffset(element);
  else if (key === 'rotation') value = element.rotation;
  else if (key === 'width' && 'width' in element) value = element.width;
  else if (key === 'height' && 'height' in element) value = element.height;
  else if (key === 'elevation') value = levelElevationOf(element) ?? instanceElevationOf(element);
  else if (key === 'levelId' || key === 'levelOffset') {
    const constraint = element.meta?.['levelConstraint'];
    const link = constraint && typeof constraint === 'object' && !Array.isArray(constraint) ? constraint : {};
    value = key === 'levelId' ? link['levelId'] ?? '' : link['offset'] ?? 0;
    type = key === 'levelId' ? 'dropdown' : 'float';
  }
  else if ((key === 'startPoint' || key === 'endPoint') && element.kind === 'line') { value = key === 'startPoint' ? element.points[0]! : element.points.at(-1)!; type = 'profile2d'; }
  if (value === undefined) return null;
  return { id: `output-${element.id}-${key}`, name: `${element.name ?? 'Element'} ${key}`, type, value, instanceEditable: false };
}

export const runParametricGraph = defineMutation({
  id: 'run-parametric-graph',
  label: 'Run parametric graph',
  description: 'Evaluates variable-to-parameter links and applies them to referenced instances.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema }),
  run: (ctx, input) => {
    const component = ctx.doc.elements[input.id];
    const graph = parametricGraphOf(component?.meta?.['parametricGraph']);
    if (!component || !graph) throw new CommandError('rejected', 'Select a parametric component');
    const executionOrder = executionSteps(graph);
    const targetByNode = new Map<string, Element>();
    const copyRoots: string[] = [];
    for (const node of graph.nodes) {
      const element = node.elementId ? ctx.doc.elements[node.elementId] : null;
      if (element) targetByNode.set(node.id, element as Element);
    }
    if (graph.executionMode === 'copy') {
      const referencedIds = [...new Set([...targetByNode.values()].map((element) => element.id))];
      const roots = referencedIds.filter((id) => !referencedIds.some((other) => other !== id && isAncestor(ctx.doc.elements as ElementTable, other, id)));
      const clones = cloneSubtrees(ctx.doc.elements as ElementTable, roots, ctx.ids);
      copyRoots.push(...clones.roots.map((root) => root.id));
      const remap = (value: z.infer<typeof JsonValueSchema>): z.infer<typeof JsonValueSchema> => {
        if (typeof value === 'string') return clones.idMap.get(value) ?? value;
        if (Array.isArray(value)) return value.map(remap);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]));
        return value;
      };
      for (const clone of clones.all) {
        if (clone.meta) clone.meta = remap(clone.meta) as Record<string, z.infer<typeof JsonValueSchema>>;
        if (clones.roots.includes(clone)) clone.index = topIndex(ctx.doc.elements as ElementTable, clone.parentId);
        ctx.doc.elements[clone.id] = clone;
      }
      for (const node of graph.nodes) {
        const cloneId = node.elementId ? clones.idMap.get(node.elementId) : null;
        if (cloneId && ctx.doc.elements[cloneId]) targetByNode.set(node.id, ctx.doc.elements[cloneId] as Element);
      }
      setSelection(ctx, clones.roots.map((root) => root.id));
    }
    let applied = 0;
    const manualSources = new Map<string, ParametricGraph['variables'][number]>();
    const manualLinks: ParametricGraph['links'] = [];
    for (const node of graph.nodes) {
      const element = node.elementId ? ctx.doc.elements[node.elementId] : null;
      if (!element) continue;
      for (const [key, value] of Object.entries(node.inputValues ?? {})) {
        if (graph.links.some((link) => link.toNode === node.id && link.toSocket === `input:${key}`)) continue;
        const output = elementOutput(element as Element, `output:${key}`, ctx.doc.definitions);
        if (!output) continue;
        const sourceId = `manual:${node.id}:${key}`;
        manualSources.set(sourceId, { ...output, value });
        manualLinks.push({ id: sourceId, fromNode: sourceId, fromSocket: 'value', toNode: node.id, toSocket: `input:${key}` });
      }
    }
    for (const step of executionOrder) {
      const targetNode = graph.nodes.find((node) => node.id === step)!;
      const stepTarget = targetByNode.get(step);
      if (!stepTarget) throw new CommandError('rejected', `${targetNode.label}: the referenced instance is missing.`);
      if (targetNode.configuration) {
        setSystemConfiguration.run(ctx, { id: stepTarget.id, ...targetNode.configuration, applyTo: 'instance' });
        applied++;
      }
      const stepInput = snapshot(stepTarget);
      for (const link of [...manualLinks, ...graph.links].filter((link) => link.toNode === step && link.toSocket.startsWith('input:'))) {
      const variable = manualSources.get(link.fromNode) ?? graphValue(graph, link.fromNode, link.fromSocket, (sourceId, socket) => {
        if (sourceId === targetNode.id) {
          const inputSocket = socket.replace(/^output:/, 'input:');
          if (graph.links.some((item) => item.toNode === sourceId && item.toSocket === inputSocket)) throw new CommandError('rejected', 'A self-reference must read an instance parameter that is not driven by a data wire.');
          return elementOutput(stepInput, socket, ctx.doc.definitions);
        }
        if (executionOrder.indexOf(sourceId) >= executionOrder.indexOf(targetNode.id)) throw new CommandError('rejected', 'An element output must feed a later execution step, including through calculations.');
        const source = targetByNode.get(sourceId);
        return source ? elementOutput(source, socket, ctx.doc.definitions) : null;
      });
      const target = targetNode ? targetByNode.get(targetNode.id) : null;
      if (!targetNode || !variable || !target || !link.toSocket.startsWith('input:')) continue;
      if ((variable.type === 'int' || variable.type === 'count') && (typeof variable.value !== 'number' || !Number.isInteger(variable.value))) throw new CommandError('invalid-input', `${variable.name} must be a whole number`);
      const key = link.toSocket.slice('input:'.length);
      if (key.startsWith('parameter:')) {
        const parameterKey = key.slice('parameter:'.length);
        if (target.meta?.['levelConstraint'] && ['elevation', 'threshold', 'sill'].includes(parameterKey)) throw new CommandError('rejected', 'Elevation is level-controlled. Edit the level offset or choose Free elevation.');
        if (!variableFitsParameter(variable, target, parameterKey)) throw new CommandError('invalid-input', `${variable.name} does not match the exposed ${parameterKey} input type`);
        setSystemParameter.run(ctx, { id: target.id, key: parameterKey, value: variable.value });
      } else if (key.startsWith('cai:')) {
        if (!['float', 'int', 'number', 'length', 'angle', 'count', 'boolean'].includes(variable.type) || (typeof variable.value !== 'number' && typeof variable.value !== 'boolean')) throw new CommandError('invalid-input', `${variable.name} must be numeric for ${key.slice(4)}`);
        setCaiParameters.run(ctx, { ids: [target.id], values: { [key.slice('cai:'.length)]: Number(variable.value) }, reset: false });
      } else if (key === 'name') {
        if (variable.type !== 'text' || typeof variable.value !== 'string') throw new CommandError('invalid-input', `${variable.name} must be text for ${key}`);
        setProperty.run(ctx, { ids: [target.id], key: 'name', value: variable.value });
      } else if (key === 'elevation') {
        if (!['float', 'int', 'number', 'length'].includes(variable.type) || typeof variable.value !== 'number') throw new CommandError('invalid-input', `${variable.name} must be numeric for ${key}`);
        if (target.meta?.['levelConstraint']) throw new CommandError('rejected', 'Elevation is level-controlled. Edit the level offset or choose Free elevation.');
        if (target.meta?.['level']) setLevelElevation.run(ctx, { id: target.id, elevation: variable.value });
        else setInstanceElevation.run(ctx, { ids: [target.id], elevation: variable.value });
      } else if (key === 'levelId' || key === 'levelOffset') {
        const raw = target.meta?.['levelConstraint'];
        const constraint = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        if (key === 'levelId' && (variable.type !== 'dropdown' || typeof variable.value !== 'string')) throw new CommandError('invalid-input', 'Choose a level or Free');
        if (key === 'levelOffset' && typeof variable.value !== 'number') throw new CommandError('invalid-input', 'Level offset must be numeric');
        const levelId = key === 'levelId' ? String(variable.value) || null : typeof constraint['levelId'] === 'string' ? constraint['levelId'] : null;
        if (key === 'levelOffset' && !levelId) throw new CommandError('rejected', 'Select a level before setting its offset');
        setElementLevelLink.run(ctx, { id: target.id, levelId, offset: key === 'levelOffset' ? Number(variable.value) : Number(constraint['offset'] ?? 0) });
      } else if (key === 'startPoint' || key === 'endPoint') {
        if (variable.type !== 'profile2d' || !Array.isArray(variable.value)) throw new CommandError('invalid-input', `${variable.name} must be a 2D point/profile for ${key}`);
        const raw = Array.isArray(variable.value[0]) ? variable.value[0] : variable.value;
        const x = Number(raw[0]);
        const y = Number(raw[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new CommandError('invalid-input', `${variable.name} needs a valid [x, y] point`);
        const world = applyToPoint(worldMatrix(ctx.doc.elements as ElementTable, target), { x, y });
        moveLineEndpoint.run(ctx, { id: target.id, endpoint: key === 'startPoint' ? 'start' : 'end', x: world.x, y: world.y, followJoined: graph.executionMode !== 'copy' });
      } else if (key === 'visible') {
        if (variable.type !== 'boolean' || typeof variable.value !== 'boolean') throw new CommandError('invalid-input', `${variable.name} must be boolean for ${key}`);
        setProperty.run(ctx, { ids: [target.id], key: 'visible', value: Boolean(variable.value) });
      } else if (key === 'x' || key === 'y' || key === 'rotation' || key === 'width' || key === 'height') {
        const arch = target.meta?.['arch'];
        if ((key === 'width' || key === 'height') && arch && typeof arch === 'object' && !Array.isArray(arch) && isSystemAssetType(arch['type'])) {
          const canonicalKey = key === 'width' ? 'width' : 'depth';
          if (SYSTEM_PARAMETER_DEFINITIONS[arch['type']].some((definition) => definition.key === canonicalKey)) throw new CommandError('rejected', `Reconnect this legacy dimension link to the exposed ${canonicalKey} system parameter`);
        }
        if (!['float', 'int', 'number', 'length', 'angle', 'count'].includes(variable.type) || typeof variable.value !== 'number') throw new CommandError('invalid-input', `${variable.name} must be numeric for ${key}`);
        const value = Number(variable.value);
        if (!Number.isFinite(value)) throw new CommandError('invalid-input', `${variable.name} must be numeric for ${key}`);
        if ((key === 'width' || key === 'height') && value <= 0) throw new CommandError('invalid-input', `${targetNode.label} ${key === 'height' ? 'length' : key} would be ${Math.round(value)} (from ${variable.name}); it must be greater than zero. Add a Calculation (e.g. max) or use a parameter socket.`);
        setTransform.run(ctx, { id: target.id, [key]: key === 'x' || key === 'y' ? value - pointCentreOffset(target) : value });
      } else continue;
      applied++;
      }
    }
    for (const id of copyRoots) {
      const copy = ctx.doc.elements[id]!;
      const world = worldMatrix(ctx.doc.elements, copy);
      const parent = component.parentId ? ctx.doc.elements[component.parentId] : null;
      const parentWorld = parent ? worldMatrix(ctx.doc.elements, parent) : [1, 0, 0, 1, 0, 0] as const;
      const local = multiply(invert(parentWorld), world);
      copy.parentId = component.parentId;
      copy.x = local[4] + graph.copyOffset.x;
      copy.y = local[5] + graph.copyOffset.y;
      copy.rotation = Math.atan2(local[1], local[0]) * 180 / Math.PI;
      copy.index = topIndex(ctx.doc.elements, copy.parentId);
    }
    if (applied === 0 && copyRoots.length === 0) throw new CommandError('rejected', 'Set a node input or connect a variable output before running');
    component.meta = { ...(component.meta ?? {}), parametricLastRun: { at: ctx.now(), applied } };
    return applied;
  },
});

export const parametricCommands = [createParametricComponent, createParametricFolder, setParametricGraph, openParametricEditor, closeParametricEditor, markParametricReference, runParametricGraph, startParametricGraph, stopParametricGraph];

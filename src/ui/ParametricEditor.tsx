import { Box, ChevronDown, ChevronRight, Folder, Hand, Link2, MousePointer2, Plus, Variable, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useApp, useAppState, useDispatch } from '@/app/context';
import { executionLinksOf, executionSteps, GRAPH_START, pointCentreOffset, graphRuntimeOf, graphValue, parametricGraphOf, type ParametricGraph } from '@/commands/builtin/parametric';
import { type AssetDefinition, type Element, type JsonValue } from '@/document';
import { isPoint } from '@/document/point';
import { derivedParameters, editableParameters, instanceValues, parametricInstanceOf, recipeOf } from '@/catalog/parametric';
import { instanceParameterKeys, mandatoryInstanceParameterKeys, systemDimensionParameters, isSystemAssetType, resolveSystemParameters, SYSTEM_PARAMETER_DEFINITIONS } from '@/assets/system-assets';
import type { CatalogAsset, SystemAssetType } from '@/catalog';
import { instanceElevationOf, levelElevationOf } from '@/view3d/geometry';
import { graphReferenceElements, graphReferenceLabel } from '@/graph/references';
import { GraphRunControls } from './GraphRunControls';
import styles from './ParametricEditor.module.css';

const uid = (prefix: string) => `${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;

function elementName(element: Element): string {
  return element.name?.trim() || `${element.kind} ${element.id.slice(-5)}`;
}

const nestedElementName = graphReferenceLabel;

type SocketType = 'float' | 'int' | 'boolean' | 'text' | 'dropdown' | 'profile2d' | 'layers' | 'unsupported';
type ReferenceParameter = { key: string; label: string; value: JsonValue; socketType: SocketType; graphEditable: boolean; exposed: boolean; options?: readonly { value: string; label: string }[] };

function referenceParameters(element: Element, levels: Element[] = [], definitions: Readonly<Record<string, AssetDefinition>> = {}): ReferenceParameter[] {
  const rawConstraint = element.meta?.['levelConstraint'];
  const constraint = rawConstraint && typeof rawConstraint === 'object' && !Array.isArray(rawConstraint) ? rawConstraint : {};
  const values: ReferenceParameter[] = [
    { key: 'name', label: 'Name', value: element.name ?? '', socketType: 'text', graphEditable: true, exposed: true },
    { key: 'x', label: 'Location X', value: element.x + pointCentreOffset(element), socketType: 'float', graphEditable: true, exposed: true },
    { key: 'y', label: 'Location Y', value: element.y + pointCentreOffset(element), socketType: 'float', graphEditable: true, exposed: true },
    { key: 'rotation', label: 'Rotation', value: element.rotation, socketType: 'float', graphEditable: true, exposed: true },
    { key: 'elevation', label: constraint['levelId'] ? 'Elevation · Level controlled' : 'Elevation', value: levelElevationOf(element) ?? instanceElevationOf(element), socketType: 'float', graphEditable: !constraint['levelId'], exposed: true },
    { key: 'visible', label: 'Visible', value: element.visible, socketType: 'boolean', graphEditable: true, exposed: true },
  ];
  if (!element.meta?.['level']) values.push(
    { key: 'levelId', label: 'Elevation reference', value: constraint['levelId'] ?? '', socketType: 'dropdown', graphEditable: true, exposed: true, options: [{ value: '', label: 'Free' }, ...levels.filter((item) => item.meta?.['level']).map((item) => ({ value: item.id, label: elementName(item) }))] },
    { key: 'levelOffset', label: 'Level offset', value: constraint['offset'] ?? 0, socketType: 'float', graphEditable: true, exposed: true },
  );
  // A reference point has no meaningful 2D size: only its location and elevation.
  if ('width' in element && !isPoint(element)) values.push({ key: 'width', label: 'Width · 2D', value: element.width, socketType: 'float', graphEditable: true, exposed: true });
  if ('height' in element && !isPoint(element)) values.push({ key: 'height', label: 'Length · 2D', value: element.height, socketType: 'float', graphEditable: true, exposed: true });
  if (element.kind === 'line') {
    values.push({ key: 'startPoint', label: 'Start point', value: element.points[0] ?? [0, 0], socketType: 'profile2d', graphEditable: true, exposed: true });
    values.push({ key: 'endPoint', label: 'End point', value: element.points.at(-1) ?? [0, 0], socketType: 'profile2d', graphEditable: true, exposed: true });
  }
  // Parameters of a placed parametric .CAI copy: editable ones are inputs, derived ones outputs only.
  const recipe = element.kind === 'instance' ? recipeOf(definitions[element.definitionId]) : null;
  if (recipe) {
    const current = instanceValues(recipe, parametricInstanceOf(element));
    // unshift reverses: walk backwards so the sockets keep the modeling page's order.
    for (const parameter of [...editableParameters(recipe), ...derivedParameters(recipe)].reverse()) {
      const editable = parameter.expression === undefined;
      values.unshift({ key: `cai:${parameter.name}`, label: `${parameter.name}${editable ? '' : ' · result'}`, value: current[parameter.name] ?? parameter.value, socketType: 'float', graphEditable: editable, exposed: true });
    }
  }
  const arch = element.meta?.['arch'];
  if (arch && typeof arch === 'object' && !Array.isArray(arch) && isSystemAssetType(arch['type'])) {
    const parameters = resolveSystemParameters(arch['type'], arch['parameters']);
    const dimensions = systemDimensionParameters(arch['type'], parameters);
    // Width/depth already have canonical system parameter sockets. The generic
    // board bounding box must not provide a second input that bypasses exposure.
    for (let index = values.length - 1; index >= 0; index--) {
      if (values[index]!.key === 'width' && dimensions.width || values[index]!.key === 'height' && dimensions.height) values.splice(index, 1);
    }
    const exposed = new Set(instanceParameterKeys(arch['type'], arch['instanceEditable']));
    for (const definition of SYSTEM_PARAMETER_DEFINITIONS[arch['type']]) {
      if (definition.visibleWhen && !definition.visibleWhen(parameters)) continue;
      if (definition.key === 'elevation') continue;
      if (definition.key === 'threshold' || definition.key === 'sill') {
        const duplicate = values.findIndex((item) => item.key === 'elevation');
        if (duplicate >= 0) values.splice(duplicate, 1);
      }
      const socketType: SocketType = definition.kind === 'number' ? 'float' : definition.kind === 'boolean' ? 'boolean' : definition.kind === 'select' ? 'dropdown' : definition.kind === 'profile' ? 'profile2d' : definition.kind === 'layers' ? 'layers' : 'unsupported';
      values.unshift({
        key: `parameter:${definition.key}`,
        label: definition.label,
        value: parameters[definition.key] ?? definition.defaultValue,
        socketType,
        graphEditable: exposed.has(definition.key) && socketType !== 'unsupported' && !(constraint['levelId'] && ['threshold', 'sill'].includes(definition.key)),
        exposed: exposed.has(definition.key),
        ...(definition.options ? { options: definition.options } : {}),
      });
    }
  }
  return values;
}

function variableFitsSocket(type: ParametricGraph['variables'][number]['type'], socketType: SocketType): boolean {
  if (socketType === 'float') return ['float', 'int', 'number', 'length', 'angle', 'count'].includes(type);
  if (socketType === 'int') return ['int', 'count'].includes(type);
  return type === socketType;
}

function defaultVariableValue(type: ParametricGraph['variables'][number]['type']): JsonValue {
  if (type === 'boolean') return false;
  if (type === 'text' || type === 'dropdown') return '';
  if (type === 'profile2d' || type === 'layers') return [];
  return 0;
}

const referenceSocketY = (nodeY: number, parameterIndex: number, element?: Element | null) => {
  const arch = element?.meta?.['arch'];
  const hasPreset = Boolean(arch && typeof arch === 'object' && !Array.isArray(arch) && isSystemAssetType(arch['type']));
  return nodeY + 92 + (hasPreset ? 28 : 0) + Math.max(0, parameterIndex) * 28;
};

function parameterText(value: JsonValue): string {
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function executionWithout(graph: ParametricGraph, removed: string[]) {
  if (!graph.executionLinks) return undefined;
  let links = [...graph.executionLinks];
  for (const id of removed) {
    const before = links.find((link) => link.toNode === id);
    const after = links.find((link) => link.fromNode === id);
    links = links.filter((link) => link.fromNode !== id && link.toNode !== id);
    if (before && after && before.fromNode !== after.toNode) links.push({ fromNode: before.fromNode, toNode: after.toNode });
  }
  return links;
}

export function ParametricEditor() {
  const request = useAppState((state) => state.ui.parametricEditor);
  return request.open && request.elementId ? <Editor key={request.elementId} elementId={request.elementId} /> : null;
}

function Editor({ elementId }: { elementId: string }) {
  const { catalog } = useApp();
  const dispatch = useDispatch();
  const doc = useAppState((state) => state.doc);
  const selection = useAppState((state) => state.ui.selection);
  const component = doc.elements[elementId];
  const graph = parametricGraphOf(component?.meta?.['parametricGraph']);
  const graphElements = { ...doc.elements };
  for (const node of graph?.nodes ?? []) {
    const element = node.elementId ? graphElements[node.elementId] : null;
    const arch = element?.meta?.['arch'];
    if (!element || !arch || typeof arch !== 'object' || Array.isArray(arch)) continue;
    const editable = isSystemAssetType(arch['type']) ? instanceParameterKeys(arch['type'], node.configuration?.instanceEditable ?? arch['instanceEditable']) : [];
    const parameterInputs = Object.fromEntries(Object.entries(node.inputValues ?? {}).filter(([key]) => key.startsWith('parameter:') && editable.includes(key.slice(10))).map(([key, value]) => [key.slice(10), value]));
    const base = node.configuration?.parameters ?? (arch['parameters'] && typeof arch['parameters'] === 'object' && !Array.isArray(arch['parameters']) ? arch['parameters'] : {});
    const preserved: Record<string, JsonValue> = {};
    if (node.configuration && isSystemAssetType(arch['type'])) {
      const overrides = arch['instanceOverrides'];
      if ((arch['systemAssetId'] ?? null) === node.configuration.assetId && overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
        for (const key of editable) if (overrides[key] !== undefined) preserved[key] = overrides[key];
      }
      const current = resolveSystemParameters(arch['type'], arch['parameters']);
      for (const key of mandatoryInstanceParameterKeys(arch['type'])) preserved[key] = current[key] as JsonValue;
    }
    graphElements[element.id] = { ...element, meta: { ...element.meta, arch: { ...arch, parameters: { ...base, ...preserved, ...parameterInputs }, ...(node.configuration ? { systemAssetId: node.configuration.assetId, instanceEditable: node.configuration.instanceEditable } : {}) } } };
  }
  const dialogRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null);
  const spaceDown = useRef(false);
  const nodeDragRef = useRef<{ pointerId: number; nodeId: string; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const connectionOriginRef = useRef<{ x: number; y: number } | null>(null);
  const suppressSocketClickRef = useRef(false);
  const [viewport, setViewport] = useState({ x: 0, y: 0 });
  const [handTool, setHandTool] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; graphX: number; graphY: number } | null>(null);
  const [nodeSearch, setNodeSearch] = useState('');
  const [elementChoice, setElementChoice] = useState('');
  const [caiChoice, setCaiChoice] = useState('');
  const [nodePreview, setNodePreview] = useState<Record<string, { x: number; y: number }>>({});
  const [pendingSource, setPendingSource] = useState<string | null>(null);
  const [pendingSocket, setPendingSocket] = useState('value');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState('');
  const [zoom, setZoom] = useState(1);
  const [socketPositions, setSocketPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [presetsByType, setPresetsByType] = useState<Partial<Record<SystemAssetType, CatalogAsset[]>>>({});
  const [connectionDrag, setConnectionDrag] = useState<{
    pointerId: number;
    sourceNode?: string;
    sourceSocket?: string;
    targetNode?: string;
    targetSocket?: string;
    x: number;
    y: number;
  } | null>(null);

  const availableElements = useMemo(() => graphReferenceElements(doc.elements, elementId), [doc.elements, elementId]);
  const caiElements = useMemo(() => availableElements.filter((item) => item.kind === 'instance' && Boolean(doc.definitions[item.definitionId]?.catalog)), [availableElements, doc.definitions]);
  const referencedSystemTypes = useMemo(() => [...new Set(availableElements.flatMap((element) => {
    const arch = element.meta?.['arch'];
    const type = arch && typeof arch === 'object' && !Array.isArray(arch) ? arch['type'] : null;
    return isSystemAssetType(type) ? [type] : [];
  }))], [availableElements]);

  const close = useCallback(() => void dispatch('close-parametric-editor'), [dispatch]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = canvas.getBoundingClientRect();
        const next: Record<string, { x: number; y: number }> = {};
        canvas.querySelectorAll<HTMLElement>('[data-node-output], [data-node-input]').forEach((socket) => {
          const rect = socket.getBoundingClientRect();
          const clipping = socket.closest<HTMLElement>('[data-reference-fields]')?.getBoundingClientRect();
          const y = clipping ? Math.max(clipping.top, Math.min(clipping.bottom, rect.top + rect.height / 2)) : rect.top + rect.height / 2;
          const key = socket.dataset.nodeOutput ? `${socket.dataset.nodeOutput}:${socket.dataset.outputSocket}` : `${socket.dataset.nodeId}:input:${socket.dataset.socket}`;
          next[key] = { x: (rect.left + rect.width / 2 - bounds.left - viewport.x) / zoom, y: (y - bounds.top - viewport.y) / zoom };
        });
        setSocketPositions(next);
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    canvas.querySelectorAll('article').forEach((node) => observer.observe(node));
    canvas.addEventListener('scroll', measure, true);
    measure();
    return () => { observer.disconnect(); canvas.removeEventListener('scroll', measure, true); cancelAnimationFrame(frame); };
  }, [graph, nodePreview, zoom, viewport]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      // Nodes show all their pins (no inner scrolling): the wheel always navigates the graph.
      event.preventDefault();
      event.stopPropagation();
      if (event.ctrlKey || event.metaKey) {
        const bounds = canvas.getBoundingClientRect();
        const x = event.clientX - bounds.left; const y = event.clientY - bounds.top;
        const next = Math.max(0.15, Math.min(3, zoom * Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025))));
        setViewport({ x: x - (x - viewport.x) * next / zoom, y: y - (y - viewport.y) * next / zoom });
        setZoom(next);
      } else {
        const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
        const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
        setViewport((at) => ({ x: at.x - dx, y: at.y - dy }));
      }
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => canvas.removeEventListener('wheel', wheel);
  }, [zoom, viewport]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])].filter((item) => item.getClientRects().length > 0);
        const first = items[0]; const last = items.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first?.focus(); }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (contextMenu) setContextMenu(null);
        else if (connectionDrag || pendingSource) { setConnectionDrag(null); setPendingSource(null); }
        else close();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === 's') return;
      event.stopImmediatePropagation();
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(key)) { event.preventDefault(); void dispatch(key === 'y' || event.shiftKey ? 'redo' : 'undo'); return; }
      if (!event.ctrlKey && !event.metaKey && (key === 'h' || key === 'v')) { event.preventDefault(); setHandTool(key === 'h'); return; }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void dispatch('run-parametric-graph', { id: elementId }).then((result) => setRunStatus(result.ok ? `Applied ${String(result.value)} connections` : result.error.message)); return; }
      if (event.code === 'Space') { spaceDown.current = true; event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (graph && selectedNodeId && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        const node = graph.nodes.find((node) => node.id === selectedNodeId);
        const at = selectedNodeId === GRAPH_START ? graph.startPosition ?? { x: 40, y: 20 } : node;
        if (!at) return;
        const amount = event.shiftKey ? 10 : 1;
        const position = { x: at.x + (event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0), y: at.y + (event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0) };
        void dispatch('set-parametric-graph', { id: elementId, graph: { ...graph, ...(selectedNodeId === GRAPH_START ? { startPosition: position } : {}), nodes: graph.nodes.map((item) => item.id === selectedNodeId ? { ...item, ...position } : item) } });
        return;
      }
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      event.preventDefault(); event.stopImmediatePropagation();
      const node = graph?.nodes.find((item) => item.id === selectedNodeId);
      if (!graph || !node || node.kind === 'output') return;
      void dispatch('set-parametric-graph', {
        id: elementId,
        graph: {
          ...graph,
          nodes: graph.nodes.filter((item) => item.id !== node.id),
          links: graph.links.filter((link) => link.fromNode !== node.id && link.toNode !== node.id),
          variables: node.variableId ? graph.variables.filter((item) => item.id !== node.variableId) : graph.variables,
          excludedElementIds: node.elementId ? [...new Set([...graph.excludedElementIds, node.elementId])] : graph.excludedElementIds,
          executionOrder: graph.executionOrder.filter((id) => id !== node.id),
          executionLinks: executionWithout(graph, [node.id]),
        },
      });
      setSelectedNodeId(null);
    };
    const release = (event: KeyboardEvent) => { if (event.code === 'Space') { spaceDown.current = false; event.stopImmediatePropagation(); } };
    const blur = () => { spaceDown.current = false; panRef.current = null; };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', release, true);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', release, true); window.removeEventListener('blur', blur); };
  }, [close, dispatch, elementId, graph, selectedNodeId, contextMenu, connectionDrag, pendingSource]);

  useEffect(() => {
    let active = true;
    for (const type of referencedSystemTypes) {
      if (presetsByType[type] || !catalog.loadSystemTypes) continue;
      void catalog.loadSystemTypes(type).then((assets) => active && setPresetsByType((current) => ({ ...current, [type]: assets }))).catch(() => {});
    }
    return () => { active = false; };
  }, [catalog, presetsByType, referencedSystemTypes]);

  if (!component || !graph) return null;
  const displayNodes: ParametricGraph['nodes'] = [{ id: GRAPH_START, kind: 'start', label: 'Start', x: graph.startPosition?.x ?? 40, y: graph.startPosition?.y ?? 20 }, ...graph.nodes];
  const execLinks = executionLinksOf(graph);
  let steps: string[] = [];
  let executionError = '';
  try { steps = executionSteps(graph); } catch (error) { executionError = error instanceof Error ? error.message : 'Invalid execution chain'; }
  const save = (next: ParametricGraph) => {
    setRunStatus(graphRuntimeOf(component).status === 'running' ? 'Graph updated · live updates active' : 'Graph changed · Run to update instances');
    void dispatch('set-parametric-graph', { id: elementId, graph: next });
  };
  const previewValue = (nodeId: string, socket: string): JsonValue => graphValue(graph, nodeId, socket, (id, outputSocket) => {
    const source = graph.nodes.find((item) => item.id === id);
    const element = source?.elementId ? doc.elements[source.elementId] : null;
    const parameter = element ? referenceParameters(element, [], doc.definitions).find((item) => `output:${item.key}` === outputSocket) : null;
    return parameter ? { id, name: parameter.label, type: 'float', value: parameter.value, instanceEditable: false } : null;
  })?.value ?? null;
  const editReferenceParameter = (element: Element, parameter: { key: string; value: JsonValue }, text: string) => {
    let value: JsonValue = text;
    if (typeof parameter.value === 'number') {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) return;
      value = parsed;
    } else if (typeof parameter.value === 'boolean') value = text === 'true';
    else if (parameter.value !== null && typeof parameter.value === 'object') {
      try { value = JSON.parse(text) as JsonValue; } catch { return; }
    }
    save({ ...graph, nodes: graph.nodes.map((node) => node.elementId === element.id ? { ...node, inputValues: { ...node.inputValues, [parameter.key]: value } } : node) });
  };
  const addNode = (node: ParametricGraph['nodes'][number]) => {
    save({ ...graph, nodes: [...graph.nodes, node], executionOrder: node.elementId ? [...graph.executionOrder, node.id] : graph.executionOrder, excludedElementIds: graph.excludedElementIds.filter((id) => id !== node.elementId) });
  };
  const addVariable = (at?: { x: number; y: number }) => {
    const variableId = uid('var');
    const nodeId = uid('node');
    const index = graph.variables.length;
    save({
      ...graph,
      variables: [...graph.variables, { id: variableId, name: `Float ${index + 1}`, type: 'float', value: 0, instanceEditable: true }],
      nodes: [...graph.nodes, { id: nodeId, kind: 'variable', x: at?.x ?? 40, y: at?.y ?? 150 + index * 230, label: `Float ${index + 1}`, variableId }],
      links: graph.links,
    });
  };
  const addCalculation = (at?: { x: number; y: number }) => addNode({ id: uid('math'), kind: 'math', label: 'Calculation', operation: 'add', x: at?.x ?? 300, y: at?.y ?? 150 + graph.nodes.filter((node) => node.kind === 'math').length * 210, inputValues: { a: 0, b: 0 } });
  const chooseOutput = (nodeId: string, socket: string) => {
    if (suppressSocketClickRef.current) { suppressSocketClickRef.current = false; return; }
    setPendingSource(pendingSource === nodeId && pendingSocket === socket ? null : nodeId);
    setPendingSocket(socket);
  };
  const removeNode = (nodeId: string) => {
    const node = graph.nodes.find((item) => item.id === nodeId);
    save({
      ...graph,
      nodes: graph.nodes.filter((item) => item.id !== nodeId),
      links: graph.links.filter((link) => link.fromNode !== nodeId && link.toNode !== nodeId),
      variables: node?.variableId ? graph.variables.filter((item) => item.id !== node.variableId) : graph.variables,
      excludedElementIds: node?.elementId ? [...new Set([...graph.excludedElementIds, node.elementId])] : graph.excludedElementIds,
      executionOrder: graph.executionOrder.filter((id) => id !== nodeId),
      executionLinks: executionWithout(graph, [nodeId]),
    });
    setSelectedNodeId((current) => current === nodeId ? null : current);
  };
  const connectNodes = (sourceNode: string, nodeId: string, socket: string, sourceSocket = 'value') => {
    if (sourceSocket === 'exec' || socket === 'exec') {
      setPendingSource(null);
      if (sourceSocket !== 'exec' || socket !== 'exec') { setRunStatus('Execution pins connect only to execution pins.'); return; }
      if (sourceNode === nodeId) { setRunStatus('Execution wires cannot connect a step to itself.'); return; }
      const next = [...execLinks.filter((link) => link.fromNode !== sourceNode && link.toNode !== nodeId), { fromNode: sourceNode, toNode: nodeId }];
      const visit = new Set<string>(); let current: string | undefined = nodeId;
      while (current && !visit.has(current)) { if (current === sourceNode) { setRunStatus('Execution wires cannot form a cycle.'); return; } visit.add(current); current = next.find((link) => link.fromNode === current)?.toNode; }
      save({ ...graph, executionLinks: next });
      return;
    }
    const source = graph.nodes.find((node) => node.id === sourceNode && node.kind === 'variable');
    const anySource = graph.nodes.find((node) => node.id === sourceNode);
    const variable = source?.variableId ? graph.variables.find((item) => item.id === source.variableId) : null;
    const sourceElement = anySource?.elementId ? graphElements[anySource.elementId] : null;
    const sourceParameter = sourceElement && sourceSocket.startsWith('output:') ? referenceParameters(sourceElement, [], doc.definitions).find((item) => `output:${item.key}` === sourceSocket) : null;
    const sourceType = variable?.type ?? (anySource?.kind === 'math' ? 'float' : sourceParameter?.socketType);
    const sourceName = variable?.name ?? sourceParameter?.label ?? 'Output';
    const targetNode = graph.nodes.find((node) => node.id === nodeId);
    const target = targetNode?.elementId ? graphElements[targetNode.elementId] : null;
    const parameter = targetNode?.kind === 'math' && ['a', 'b'].includes(socket) ? { graphEditable: true, socketType: 'float' as const, label: socket.toUpperCase() } : target ? referenceParameters(target, [], doc.definitions).find((item) => item.key === socket) : null;
    const reaches = (id: string, seen = new Set<string>()): boolean => graph.nodes.find((node) => node.id === id)?.kind === 'math' && (id === sourceNode || (!seen.has(id) && (seen.add(id), graph.links.some((link) => link.fromNode === id && reaches(link.toNode, seen)))));
    if (reaches(nodeId)) { setPendingSource(null); setRunStatus('This connection would create a cycle. Connect to a later node.'); return; }
    if (!anySource || !sourceType || sourceType === 'unsupported' || !parameter?.graphEditable) return;
    if (!variableFitsSocket(sourceType, parameter.socketType)) {
      setPendingSource(null);
      setRunStatus(`${sourceName} (${sourceType}) cannot connect to ${parameter.label} (${parameter.socketType})`);
      return;
    }
    save({
      ...graph,
      links: [...graph.links.filter((link) => !(link.toNode === nodeId && link.toSocket === `input:${socket}`)), { id: uid('link'), fromNode: anySource.id, fromSocket: sourceSocket, toNode: nodeId, toSocket: `input:${socket}` }],
    });
    setRunStatus(`Connected ${sourceName} to ${parameter.label}`);
    setPendingSource(null);
  };

  const dropdownOptions = (nodeId: string) => {
    const links = graph.links.filter((link) => link.fromNode === nodeId && link.toSocket.startsWith('input:'));
    for (const link of links) {
      const targetNode = graph.nodes.find((item) => item.id === link.toNode);
      const target = targetNode?.elementId ? graphElements[targetNode.elementId] : null;
      const parameter = target ? referenceParameters(target, Object.values(doc.elements), doc.definitions).find((item) => `input:${item.key}` === link.toSocket) : null;
      if (parameter?.socketType === 'dropdown' && parameter.options) return parameter.options;
    }
    return [];
  };
  const connectInput = (nodeId: string, socket: string) => {
    if (socket === 'exec') {
      if (pendingSource) connectNodes(pendingSource, nodeId, socket, pendingSocket);
      else save({ ...graph, executionLinks: execLinks.filter((link) => link.toNode !== nodeId) });
      return;
    }
    const existing = graph.links.find((link) => link.toNode === nodeId && link.toSocket === `input:${socket}`);
    if (!pendingSource) {
      if (existing) save({ ...graph, links: graph.links.filter((link) => link.id !== existing.id) });
      return;
    }
    connectNodes(pendingSource, nodeId, socket, pendingSocket);
  };
  const canvasPoint = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const bounds = canvas?.getBoundingClientRect();
    return { x: (clientX - (bounds?.left ?? 0) - viewport.x) / zoom, y: (clientY - (bounds?.top ?? 0) - viewport.y) / zoom };
  };
  const startConnection = (event: ReactPointerEvent<HTMLButtonElement>, data: { sourceNode: string; sourceSocket?: string } | { targetNode: string; targetSocket: string }) => {
    const point = canvasPoint(event.clientX, event.clientY);
    connectionOriginRef.current = { x: event.clientX, y: event.clientY };
    suppressSocketClickRef.current = false;
    setConnectionDrag({ pointerId: event.pointerId, ...data, ...point });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };
  const moveConnection = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!connectionDrag || connectionDrag.pointerId !== event.pointerId) return;
    const origin = connectionOriginRef.current;
    if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 3) suppressSocketClickRef.current = true;
    setConnectionDrag({ ...connectionDrag, ...canvasPoint(event.clientX, event.clientY) });
  };
  const stopConnection = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = connectionDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!suppressSocketClickRef.current) { setConnectionDrag(null); connectionOriginRef.current = null; return; }
    const beneath = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    if (drag.sourceNode) {
      const input = beneath?.closest<HTMLElement>('[data-node-input]');
      if (input?.dataset.nodeId && input.dataset.socket) connectNodes(drag.sourceNode, input.dataset.nodeId, input.dataset.socket, drag.sourceSocket);
    } else if (drag.targetNode && drag.targetSocket) {
      const outputSocket = beneath?.closest<HTMLElement>('[data-node-output]');
      if (outputSocket?.dataset.nodeOutput) connectNodes(outputSocket.dataset.nodeOutput, drag.targetNode, drag.targetSocket, outputSocket.dataset.outputSocket);
    }
    connectionOriginRef.current = null;
    setConnectionDrag(null);
  };
  const cancelConnection = () => {
    connectionOriginRef.current = null;
    setConnectionDrag(null);
  };

  const nodePosition = (node: ParametricGraph['nodes'][number]) => nodePreview[node.id] ?? node;
  const startNodeDrag = (node: ParametricGraph['nodes'][number], event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || handTool || spaceDown.current || (event.target as HTMLElement).closest('button,input,label')) return;
    setSelectedNodeId(node.id);
    dialogRef.current?.focus({ preventScroll: true });
    nodeDragRef.current = { pointerId: event.pointerId, nodeId: node.id, startX: event.clientX, startY: event.clientY, originX: node.x, originY: node.y };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
  };
  const moveNode = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setNodePreview((current) => ({ ...current, [drag.nodeId]: { x: drag.originX + (event.clientX - drag.startX) / zoom, y: drag.originY + (event.clientY - drag.startY) / zoom } }));
  };
  const stopNodeDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const position = { x: drag.originX + (event.clientX - drag.startX) / zoom, y: drag.originY + (event.clientY - drag.startY) / zoom };
    nodeDragRef.current = null;
    if (position.x !== drag.originX || position.y !== drag.originY) save({ ...graph, ...(drag.nodeId === GRAPH_START ? { startPosition: position } : {}), nodes: graph.nodes.map((node) => node.id === drag.nodeId ? { ...node, ...position } : node) });
    setNodePreview((current) => { const next = { ...current }; delete next[drag.nodeId]; return next; });
  };

  const graphMinX = Math.min(0, ...displayNodes.map((node) => nodePosition(node).x - 30));
  const graphMinY = Math.min(0, ...displayNodes.map((node) => nodePosition(node).y - 30));
  const graphWidth = Math.max(600, ...displayNodes.map((node) => nodePosition(node).x + 260));
  const graphHeight = Math.max(400, ...displayNodes.map((node) => nodePosition(node).y + (node.elementId ? 310 : 240)));

  return (
    <div className={styles.layer}>
      <section ref={dialogRef} className={styles.dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Parametric component editor" data-testid="parametric-editor" onPointerDownCapture={(event) => { if (!(event.target as HTMLElement).closest('[role="menu"]')) setContextMenu(null); }}>
        <header className={styles.header}>
          <h2><Folder size={15} /> {component.name ?? 'Parametric component'} / Graph</h2>
          <span>Parametric design · {graph.nodes.filter((node) => node.elementId).length} referenced instances</span>
          <GraphRunControls componentId={elementId} showRunOnce={false} />
          <button type="button" onClick={close} aria-label="Close"><X size={16} /></button>
        </header>
        <div className={styles.body}>
          <aside className={styles.library}>
            <div className={styles.zoomControls}>
              <button type="button" aria-label="Zoom out graph" onClick={() => setZoom((value) => Math.max(0.25, value - 0.1))}>−</button>
              <button type="button" aria-label="Reset graph zoom" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
              <button type="button" aria-label="Zoom in graph" onClick={() => setZoom((value) => Math.min(2, value + 0.1))}>+</button>
              <button type="button" onClick={() => { const canvas = canvasRef.current; if (canvas) { const next = Math.max(0.15, Math.min(1, (canvas.clientWidth - 20) / (graphWidth - graphMinX), (canvas.clientHeight - 20) / (graphHeight - graphMinY))); setZoom(next); setViewport({ x: 10 - graphMinX * next, y: 10 - graphMinY * next }); } }}>Fit</button>
            </div>
            <div className={styles.zoomControls}><button type="button" aria-label="Select graph nodes" aria-pressed={!handTool} onClick={() => setHandTool(false)}><MousePointer2 size={14} /> Select</button><button type="button" aria-label="Pan graph" aria-pressed={handTool} onClick={() => setHandTool(true)}><Hand size={14} /> Pan</button></div>
            <p>Right-click to add nodes. Middle-drag or hold Space to pan. Ctrl/⌘ + wheel zooms at the pointer.</p>
            <h3>Inputs</h3>
            <button type="button" onClick={() => addVariable()}><Plus size={14} /> Variable</button>
            <button type="button" onClick={() => addCalculation()}><Plus size={14} /> Calculation</button>
            <p>Connect numbers to A and B, then connect the result to an instance parameter. Calculations can feed other calculations.</p>
            <button type="button" onClick={() => {
              const rows = [160, 160, 160, 160];
              const columns = ['variable', 'math', 'element', 'output'].filter((kind) => graph.nodes.some((node) => (node.kind === 'cai-model' ? 'element' : node.kind) === kind));
              save({ ...graph, startPosition: { x: 40, y: 20 }, nodes: graph.nodes.map((node) => {
                const column = columns.indexOf(node.kind === 'cai-model' ? 'element' : node.kind);
                const y = rows[column]!;
                rows[column] = y + (node.elementId ? 300 : node.kind === 'output' ? 120 : 230);
                return { ...node, x: 40 + column * 290, y };
              }) });
            }}>Arrange nodes</button>
            <h3>Board reference</h3>
            <select value={elementChoice} onChange={(event) => setElementChoice(event.target.value)}>
              <option value="">Choose an element…</option>
              {availableElements.filter((element) => !graph.nodes.some((node) => node.elementId === element.id)).map((element) => <option key={element.id} value={element.id}>{nestedElementName(doc.elements, elementId, element)}</option>)}
            </select>
            <button type="button" disabled={!elementChoice} onClick={() => {
              const element = doc.elements[elementChoice];
              if (!element) return;
              void dispatch('mark-parametric-reference', { componentId: elementId, elementId: element.id });
              addNode({ id: uid('node'), kind: 'element', x: 270, y: 50 + graph.nodes.length * 28, label: nestedElementName(doc.elements, elementId, element), elementId: element.id });
              setElementChoice('');
            }}><Link2 size={14} /> Link element</button>
            {availableElements.length === 0 && <p>Nest layers under this Parametric Component in Layers to make them available as references.</p>}
            <h3>CAI model</h3>
            <select value={caiChoice} onChange={(event) => setCaiChoice(event.target.value)}>
              <option value="">Choose a placed CAI…</option>
              {caiElements.map((element) => <option key={element.id} value={element.id}>{elementName(element)}</option>)}
            </select>
            <button type="button" disabled={!caiChoice} onClick={() => {
              const element = doc.elements[caiChoice];
              if (!element || element.kind !== 'instance') return;
              const definition = doc.definitions[element.definitionId];
              void dispatch('mark-parametric-reference', { componentId: elementId, elementId: element.id });
              addNode({ id: uid('node'), kind: 'cai-model', x: 270, y: 80 + graph.nodes.length * 28, label: nestedElementName(doc.elements, elementId, element), elementId: element.id, assetId: definition?.catalog?.path });
              setCaiChoice('');
            }}><Box size={14} /> Add CAI source</button>
            <p>References use stable document IDs. Moving or editing the source keeps this graph linked.</p>
            <h3>Execution</h3>
            <p>Diamond pins set execution order. Round pins carry data. Connect Start → every instance → Finish.</p>
            {executionError && <p role="alert">{executionError}</p>}
            {steps.map((id, index) => <div key={id} className={styles.libraryField}>{index + 1}. {graph.nodes.find((node) => node.id === id)?.label}</div>)}
            <button type="button" onClick={() => save({ ...graph, executionLinks: undefined })}>Auto-wire execution</button>
            <label className={styles.libraryField}><span>Result</span><select value={graph.executionMode} onChange={(event) => save({ ...graph, executionMode: event.target.value as 'update' | 'copy' })}><option value="update">Update elements</option><option value="copy">Copy result</option></select></label>
            {graph.executionMode === 'copy' && <div className={styles.offsetFields}><label><span>Offset X</span><input type="number" defaultValue={graph.copyOffset.x} onBlur={(event) => save({ ...graph, copyOffset: { ...graph.copyOffset, x: Number(event.target.value) || 0 } })} /></label><label><span>Offset Y</span><input type="number" defaultValue={graph.copyOffset.y} onBlur={(event) => save({ ...graph, copyOffset: { ...graph.copyOffset, y: Number(event.target.value) || 0 } })} /></label></div>}
          </aside>
          <div ref={canvasRef} className={styles.canvas} data-testid="graph-canvas" data-hand={handTool || undefined} style={{ backgroundPosition: `${viewport.x}px ${viewport.y}px`, backgroundSize: `${20 * zoom}px ${20 * zoom}px` }}
            onContextMenu={(event) => { event.preventDefault(); const at = canvasPoint(event.clientX, event.clientY); setNodeSearch(''); setContextMenu({ x: Math.min(event.clientX, window.innerWidth - 270), y: Math.min(event.clientY, window.innerHeight - 320), graphX: at.x, graphY: at.y }); }}
            onPointerDownCapture={(event) => {
              setContextMenu(null);
              if (event.button !== 1 && !(event.button === 0 && (handTool || spaceDown.current))) return;
              event.preventDefault(); event.stopPropagation();
              panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: viewport.x, originY: viewport.y };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => { const pan = panRef.current; if (pan?.pointerId === event.pointerId) setViewport({ x: pan.originX + event.clientX - pan.x, y: pan.originY + event.clientY - pan.y }); }}
            onPointerUp={() => { panRef.current = null; }} onPointerCancel={() => { panRef.current = null; }}
            onPointerDown={(event) => { if (!(event.target as HTMLElement).closest('article')) { setSelectedNodeId(null); setPendingSource(null); } }}>
            <div className={styles.graphSurface} style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${zoom})`, width: graphWidth, height: graphHeight }}>
            <svg className={styles.wires} aria-hidden="true" data-testid="graph-wires">
              {graph.links.map((link) => {
                const from = graph.nodes.find((node) => node.id === link.fromNode);
                const to = graph.nodes.find((node) => node.id === link.toNode);
                if (!from || !to) return null;
                const fromAt = nodePosition(from);
                const toAt = nodePosition(to);
                const targetElement = to.elementId ? graphElements[to.elementId] : null;
                const parameterIndex = targetElement && link.toSocket.startsWith('input:') ? referenceParameters(targetElement, [], doc.definitions).findIndex((parameter) => `input:${parameter.key}` === link.toSocket) : -1;
                const targetY = parameterIndex >= 0 ? referenceSocketY(toAt.y, parameterIndex, targetElement) : toAt.y + 37;
                const sourceVariable = from.variableId ? graph.variables.find((item) => item.id === from.variableId) : null;
                const sourceElement = from.elementId ? graphElements[from.elementId] : null;
                const sourceParameterIndex = sourceElement && link.fromSocket.startsWith('output:') ? referenceParameters(sourceElement, [], doc.definitions).findIndex((parameter) => `output:${parameter.key}` === link.fromSocket) : -1;
                const sourceParameter = sourceParameterIndex >= 0 && sourceElement ? referenceParameters(sourceElement, [], doc.definitions)[sourceParameterIndex] : null;
                const sourceY = sourceParameterIndex >= 0 ? referenceSocketY(fromAt.y, sourceParameterIndex, sourceElement) : fromAt.y + 37;
                const start = socketPositions[`${from.id}:${link.fromSocket}`] ?? { x: fromAt.x + 220, y: sourceY };
                const end = socketPositions[`${to.id}:${link.toSocket}`] ?? { x: toAt.x, y: targetY };
                const d = `M ${start.x} ${start.y} C ${start.x + 50} ${start.y}, ${end.x - 50} ${end.y}, ${end.x} ${end.y}`;
                return <g key={link.id}><path data-socket-type={sourceVariable?.type ?? sourceParameter?.socketType} d={d} /><path className={styles.wireHit} d={d} onDoubleClick={() => save({ ...graph, links: graph.links.filter((item) => item.id !== link.id) })}><title>Double-click to disconnect data wire</title></path></g>;
              })}
              {execLinks.map((link) => {
                const from = displayNodes.find((node) => node.id === link.fromNode);
                const to = displayNodes.find((node) => node.id === link.toNode);
                if (!from || !to) return null;
                const start = socketPositions[`${from.id}:exec`] ?? { x: from.x + 220, y: from.y + 46 };
                const end = socketPositions[`${to.id}:input:exec`] ?? { x: to.x, y: to.y + 46 };
                const d = `M ${start.x} ${start.y} C ${start.x + 65} ${start.y}, ${end.x - 65} ${end.y}, ${end.x} ${end.y}`;
                return <g key={`exec-${from.id}`}><path data-execution-wire className={styles.executionWire} d={d} /><path className={styles.wireHit} d={d} onDoubleClick={() => save({ ...graph, executionLinks: execLinks.filter((item) => item !== link) })}><title>Double-click to disconnect execution wire</title></path></g>;
              })}
              {connectionDrag && (() => {
                if (connectionDrag.sourceNode) {
                  const source = displayNodes.find((node) => node.id === connectionDrag.sourceNode);
                  if (!source) return null;
                  const at = nodePosition(source);
                  const sourceVariable = source.variableId ? graph.variables.find((item) => item.id === source.variableId) : null;
                  const sourceElement = source.elementId ? graphElements[source.elementId] : null;
                  const sourceIndex = sourceElement && connectionDrag.sourceSocket?.startsWith('output:') ? referenceParameters(sourceElement, [], doc.definitions).findIndex((parameter) => `output:${parameter.key}` === connectionDrag.sourceSocket) : -1;
                  const sourceParameter = sourceIndex >= 0 && sourceElement ? referenceParameters(sourceElement, [], doc.definitions)[sourceIndex] : null;
                  const sourceY = sourceIndex >= 0 ? referenceSocketY(at.y, sourceIndex, sourceElement) : at.y + 37;
                  const start = socketPositions[`${source.id}:${connectionDrag.sourceSocket ?? 'value'}`] ?? { x: at.x + 220, y: sourceY };
                  return <path className={styles.previewWire} data-socket-type={sourceVariable?.type ?? sourceParameter?.socketType} d={`M ${start.x} ${start.y} C ${start.x + 50} ${start.y}, ${connectionDrag.x - 50} ${connectionDrag.y}, ${connectionDrag.x} ${connectionDrag.y}`} />;
                }
                const target = displayNodes.find((node) => node.id === connectionDrag.targetNode);
                const element = target?.elementId ? graphElements[target.elementId] : null;
                if (!target || !connectionDrag.targetSocket) return null;
                const at = nodePosition(target);
                const parameters = element ? referenceParameters(element, [], doc.definitions) : [];
                const index = parameters.findIndex((parameter) => parameter.key === connectionDrag.targetSocket);
                const targetY = referenceSocketY(at.y, index, element);
                const end = socketPositions[`${target.id}:input:${connectionDrag.targetSocket}`] ?? { x: at.x, y: targetY };
                return <path className={styles.previewWire} data-socket-type={parameters[index]?.socketType} d={`M ${connectionDrag.x} ${connectionDrag.y} C ${connectionDrag.x + 50} ${connectionDrag.y}, ${end.x - 50} ${end.y}, ${end.x} ${end.y}`} />;
              })()}
            </svg>
            {displayNodes.map((node) => {
              const variable = node.variableId ? graph.variables.find((item) => item.id === node.variableId) : null;
              const linked = node.elementId ? graphElements[node.elementId] : null;
              const at = nodePosition(node);
              const choices = variable?.type === 'dropdown' ? dropdownOptions(node.id) : [];
              const linkedArch = linked?.meta?.['arch'];
              const linkedTypeValue = linkedArch && typeof linkedArch === 'object' && !Array.isArray(linkedArch) ? linkedArch['type'] : null;
              const linkedType = isSystemAssetType(linkedTypeValue) ? linkedTypeValue : null;
              const linkedAssetId = linkedArch && typeof linkedArch === 'object' && !Array.isArray(linkedArch) && typeof linkedArch['systemAssetId'] === 'string' ? linkedArch['systemAssetId'] : '';
              return (
                <article key={node.id} className={styles.node} data-kind={node.kind} data-element-id={node.elementId} data-selected={selectedNodeId === node.id || !!node.elementId && selection.includes(node.elementId) || undefined} style={{ left: at.x, top: at.y }} onPointerDown={() => setSelectedNodeId(node.id)}>
                  <header onPointerDown={(event) => startNodeDrag(node, event)} onPointerMove={moveNode} onPointerUp={stopNodeDrag} onPointerCancel={stopNodeDrag}>{node.kind === 'variable' ? <Variable size={13} /> : node.kind === 'output' ? <Box size={13} /> : <Link2 size={13} />}<strong>{node.kind === 'output' ? 'Finish' : node.label}</strong>{node.elementId && <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => save({ ...graph, nodes: graph.nodes.map((item) => item.id === node.id ? { ...item, collapsed: !item.collapsed } : item) })} aria-label={node.collapsed ? 'Show all pins' : 'Show connected pins only'} aria-expanded={!node.collapsed} title={node.collapsed ? 'Show all pins' : 'Collapse: show connected pins only'}>{node.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</button>}{node.kind !== 'output' && node.kind !== 'start' && <button type="button" onClick={() => removeNode(node.id)} aria-label="Remove node"><X size={12} /></button>}</header>
                  {(node.elementId || node.kind === 'start' || node.kind === 'output') && <div className={styles.executionRow}>
                    {node.kind !== 'start' ? <button type="button" className={styles.executionPin} aria-label={`${node.label} execution input`} data-node-input data-node-id={node.id} data-socket="exec" data-connected={execLinks.some((link) => link.toNode === node.id) || undefined} onPointerDown={(event) => startConnection(event, { targetNode: node.id, targetSocket: 'exec' })} onPointerMove={moveConnection} onPointerUp={stopConnection} onPointerCancel={cancelConnection} onClick={() => { if (suppressSocketClickRef.current) { suppressSocketClickRef.current = false; return; } connectInput(node.id, 'exec'); }} /> : <span />}
                    <span>{node.kind === 'start' ? 'Run starts here' : node.kind === 'output' ? 'Execution complete' : steps.includes(node.id) ? `Step ${steps.indexOf(node.id) + 1}` : 'Connect execution'}</span>
                    {node.kind !== 'output' ? <button type="button" className={styles.executionPin} aria-label={`${node.label} execution output`} data-node-output={node.id} data-output-socket="exec" data-active={pendingSource === node.id && pendingSocket === 'exec' || undefined} data-connected={execLinks.some((link) => link.fromNode === node.id) || undefined} onPointerDown={(event) => startConnection(event, { sourceNode: node.id, sourceSocket: 'exec' })} onPointerMove={moveConnection} onPointerUp={stopConnection} onPointerCancel={cancelConnection} onClick={() => chooseOutput(node.id, 'exec')} /> : <span />}
                  </div>}
                  {variable ? (
                    <div className={styles.nodeFields}>
                      <input defaultValue={variable.name} onBlur={(event) => save({ ...graph, variables: graph.variables.map((item) => item.id === variable.id ? { ...item, name: event.target.value || item.name } : item), nodes: graph.nodes.map((item) => item.id === node.id ? { ...item, label: event.target.value || item.label } : item) })} />
                      <select value={variable.type} aria-label={`${variable.name} type`} onChange={(event) => {
                        const type = event.target.value as ParametricGraph['variables'][number]['type'];
                        save({
                          ...graph,
                          variables: graph.variables.map((item) => item.id === variable.id ? { ...item, type, value: defaultVariableValue(type) } : item),
                          links: graph.links.filter((link) => link.fromNode !== node.id),
                        });
                      }}>
                        <option value="float">Float</option><option value="int">Integer</option><option value="boolean">Boolean</option><option value="text">Text</option><option value="dropdown">Drop-down</option><option value="profile2d">Profile 2D</option><option value="layers">Layers configuration</option>
                      </select>
                      {variable.type === 'boolean' ? (
                        <label className={styles.booleanValue}><input type="checkbox" checked={Boolean(variable.value)} onChange={(event) => save({ ...graph, variables: graph.variables.map((item) => item.id === variable.id ? { ...item, value: event.target.checked } : item) })} /> {Boolean(variable.value) ? 'True' : 'False'}</label>
                      ) : variable.type === 'dropdown' ? (
                        <select value={String(variable.value)} disabled={choices.length === 0} onChange={(event) => save({ ...graph, variables: graph.variables.map((item) => item.id === variable.id ? { ...item, value: event.target.value } : item) })} title={choices.length === 0 ? 'Connect this variable to a drop-down input to load its items' : 'Items come from the connected input'}>
                          {choices.length === 0 ? <option value="">Connect to a drop-down input</option> : <><option value="">Choose…</option>{choices.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</>}
                        </select>
                      ) : variable.type === 'profile2d' || variable.type === 'layers' ? (
                        <textarea key={JSON.stringify(variable.value)} defaultValue={JSON.stringify(variable.value, null, 2)} aria-label={`${variable.name} JSON value`} onBlur={(event) => { try { const value = JSON.parse(event.target.value) as JsonValue; save({ ...graph, variables: graph.variables.map((item) => item.id === variable.id ? { ...item, value } : item) }); } catch { setRunStatus(`${variable.name} contains invalid JSON`); } }} />
                      ) : variable.type === 'text' ? (
                        <input key={String(variable.value)} type="text" defaultValue={String(variable.value)} onBlur={(event) => save({ ...graph, variables: graph.variables.map((item) => item.id === variable.id ? { ...item, value: event.target.value } : item) })} />
                      ) : (
                        <input key={String(variable.value)} type="number" defaultValue={Number(variable.value)} onBlur={(event) => save({ ...graph, variables: graph.variables.map((item) => item.id === variable.id ? { ...item, value: Number(event.target.value) } : item) })} />
                      )}
                      <label><input type="checkbox" defaultChecked={variable.instanceEditable} onChange={(event) => save({ ...graph, variables: graph.variables.map((item) => item.id === variable.id ? { ...item, instanceEditable: event.target.checked } : item) })} /> Instance</label>
                    </div>
                  ) : node.kind === 'math' ? (
                    <div className={styles.nodeFields}>
                      <select aria-label="Calculation operation" value={node.operation ?? 'add'} onChange={(event) => save({ ...graph, nodes: graph.nodes.map((item) => item.id === node.id ? { ...item, operation: event.target.value as typeof node.operation } : item) })}>
                        <option value="add">Add · A + B</option><option value="subtract">Subtract · A − B</option><option value="multiply">Multiply · A × B</option><option value="divide">Divide · A / B</option><option value="min">Minimum</option><option value="max">Maximum</option><option value="power">Power · A ^ B</option>
                      </select>
                      {['a', 'b'].map((key) => {
                        const connection = graph.links.find((link) => link.toNode === node.id && link.toSocket === `input:${key}`);
                        let inputValue = node.inputValues?.[key] ?? 0;
                        if (connection) { try { inputValue = previewValue(connection.fromNode, connection.fromSocket) ?? 'Unavailable'; } catch { inputValue = 'Invalid'; } }
                        return <label key={key}>
                          <button type="button" className={styles.parameterSocket} data-node-input data-node-id={node.id} data-socket={key} data-connected={Boolean(connection) || undefined} aria-label={`Calculation input ${key.toUpperCase()}`} onPointerDown={(event) => startConnection(event, { targetNode: node.id, targetSocket: key })} onPointerMove={moveConnection} onPointerUp={stopConnection} onPointerCancel={cancelConnection} onClick={() => { if (suppressSocketClickRef.current) { suppressSocketClickRef.current = false; return; } connectInput(node.id, key); }} />
                          {key.toUpperCase()} <input type={connection ? 'text' : 'number'} aria-label={`Calculation ${key.toUpperCase()}`} key={String(inputValue)} defaultValue={String(inputValue)} disabled={Boolean(connection)} onBlur={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) save({ ...graph, nodes: graph.nodes.map((item) => item.id === node.id ? { ...item, inputValues: { ...item.inputValues, [key]: value } } : item) }); }} />
                          {connection && <span title={graph.nodes.find((item) => item.id === connection.fromNode)?.label}>Linked</span>}
                        </label>;
                      })}
                      <output aria-label="Calculation result">{(() => { try {
                        return `Result: ${String(previewValue(node.id, 'value') ?? '—')}`;
                      } catch (error) { return error instanceof Error ? error.message : 'Invalid calculation'; } })()}</output>
                    </div>
                  ) : node.kind === 'start' ? <p>Follow the diamond pins to set the order of instance updates.</p> : node.kind === 'output' ? <p>Run applies connected inputs to referenced instances. Use Copy result to generate a separate result.</p> : linked ? (
                    <div className={styles.referenceFields} data-reference-fields data-collapsed={node.collapsed || undefined}>
                      {linkedType && <label className={styles.presetField}><span className={styles.noSocket} /><span>Preset</span><select value={linkedAssetId} onChange={(event) => {
                        const asset = presetsByType[linkedType]?.find((item) => item.id === event.target.value) ?? null;
                        const parameters = linkedArch && typeof linkedArch === 'object' && !Array.isArray(linkedArch) ? linkedArch['parameters'] : {};
                        const resolved = resolveSystemParameters(linkedType, asset?.systemParameters ?? parameters);
                        save({ ...graph, nodes: graph.nodes.map((item) => item.id === node.id ? { ...item, inputValues: {}, configuration: { assetId: asset?.id ?? null, ...(asset ? { assetName: asset.name } : {}), parameters: resolved as Record<string, JsonValue>, instanceEditable: asset?.instanceEditable ?? [] } } : item) });
                      }}><option value="">Default {linkedType.replace(/-/g, ' ')}</option>{(presetsByType[linkedType] ?? []).map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>}
                      {!node.collapsed && <div className={styles.fieldLegend}><strong>Instance inputs · parameter outputs</strong><span>Gray fields are controlled by the type preset.</span></div>}
                      {node.collapsed && !graph.links.some((link) => link.toNode === node.id || link.fromNode === node.id) && <p className={styles.collapsedNote}>No connected pins · expand to connect</p>}
                      {referenceParameters(linked, Object.values(doc.elements), doc.definitions).filter((item) => !node.collapsed || graph.links.some((link) => (link.toNode === node.id && link.toSocket === `input:${item.key}`) || (link.fromNode === node.id && link.fromSocket === `output:${item.key}`))).map((currentParameter) => {
                        const parameter = { ...currentParameter, value: currentParameter.graphEditable ? node.inputValues?.[currentParameter.key] ?? currentParameter.value : currentParameter.value };
                        const connection = graph.links.find((link) => link.toNode === node.id && link.toSocket === `input:${parameter.key}`);
                        const source = connection ? graph.nodes.find((item) => item.id === connection.fromNode) : null;
                        const sourceVariable = source?.variableId ? graph.variables.find((item) => item.id === source.variableId) : null;
                        const pendingVariableNode = pendingSource ? graph.nodes.find((item) => item.id === pendingSource) : null;
                        const pendingVariable = pendingVariableNode?.variableId ? graph.variables.find((item) => item.id === pendingVariableNode.variableId) : null;
                        const compatible = !pendingVariable || variableFitsSocket(pendingVariable.type, parameter.socketType);
                        if (sourceVariable) parameter.value = sourceVariable.value;
                        else if (connection) { try { parameter.value = previewValue(connection.fromNode, connection.fromSocket) ?? parameter.value; } catch { /* Run reports invalid upstream calculations. */ } }
                        return <label key={parameter.key} data-parameter={parameter.key} data-ownership={parameter.exposed ? 'instance' : 'type'} className={parameter.graphEditable ? styles.graphField : parameter.exposed ? styles.unsupportedField : styles.inspectorField} title={parameter.graphEditable ? `Graph input · ${parameter.socketType}` : parameter.exposed ? 'Exposed parameter · this value type cannot be linked yet' : 'Type parameter · change ownership in the type panel'}>
                          {parameter.graphEditable ? <button type="button" className={styles.parameterSocket} data-socket-type={parameter.socketType} data-node-input data-node-id={node.id} data-socket={parameter.key} data-connected={Boolean(connection) || undefined} data-pending={Boolean(pendingSource) && compatible || undefined} data-incompatible={Boolean(pendingSource) && !compatible || undefined} onPointerDown={(event) => startConnection(event, { targetNode: node.id, targetSocket: parameter.key })} onPointerMove={moveConnection} onPointerUp={stopConnection} onPointerCancel={cancelConnection} onClick={() => { if (suppressSocketClickRef.current) { suppressSocketClickRef.current = false; return; } connectInput(node.id, parameter.key); }} title={connection ? `Connected from ${source?.label ?? 'variable'} (${sourceVariable?.type ?? 'unknown'}) · click to disconnect` : `${parameter.socketType} graph input`} /> : <span className={styles.noSocket} />}
                          <span className={styles.parameterName} title={parameter.label}>{parameter.label}<small className={styles.ownership}>{connection ? 'Linked' : parameter.graphEditable ? 'Instance' : parameter.exposed ? 'Controlled' : 'Type'}</small></span>
                          {parameter.graphEditable && parameter.socketType === 'dropdown' ? <select disabled={Boolean(connection)} value={String(parameter.value)} onChange={(event) => editReferenceParameter(linked, parameter, event.target.value)}>{parameter.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
                            : parameter.graphEditable && parameter.socketType === 'boolean' ? <select disabled={Boolean(connection)} value={String(parameter.value)} onChange={(event) => editReferenceParameter(linked, parameter, event.target.value)}><option value="true">True</option><option value="false">False</option></select>
                            : <input key={parameterText(parameter.value)} defaultValue={parameterText(parameter.value)} disabled={!parameter.graphEditable || Boolean(connection)} readOnly={!parameter.graphEditable || Boolean(connection)} onBlur={(event) => parameter.graphEditable && !connection && editReferenceParameter(linked, parameter, event.target.value)} title={connection ? 'Controlled by a connected output' : parameter.graphEditable ? 'Instance input · applied on Run' : 'Type-controlled parameter · read-only output'} />}
                          {parameter.socketType !== 'unsupported' ? <button type="button" className={styles.parameterOutput} data-socket-type={parameter.socketType} data-node-output={node.id} data-output-socket={`output:${parameter.key}`} onPointerDown={(event) => startConnection(event, { sourceNode: node.id, sourceSocket: `output:${parameter.key}` })} onPointerMove={moveConnection} onPointerUp={stopConnection} onPointerCancel={cancelConnection} onClick={() => chooseOutput(node.id, `output:${parameter.key}`)} title={`${parameter.label} ${parameter.socketType} output`} /> : <span />}
                        </label>;
                      })}
                    </div>
                  ) : <p className={styles.broken}>Missing reference · relink required</p>}
                  {(node.kind === 'variable' || node.kind === 'math') && <button type="button" className={styles.variableOutput} data-socket-type={variable?.type ?? 'float'} data-node-output={node.id} data-output-socket="value" data-active={pendingSource === node.id || undefined} onPointerDown={(event) => startConnection(event, { sourceNode: node.id, sourceSocket: 'value' })} onPointerMove={moveConnection} onPointerUp={stopConnection} onPointerCancel={cancelConnection} onClick={() => chooseOutput(node.id, 'value')} title={`Drag ${variable?.type ?? 'calculation'} output to a matching input`} />}
                </article>
              );
            })}
            </div>
          </div>
        </div>
        <footer className={styles.footer}><span role="status">{pendingSource ? pendingSocket === 'exec' ? 'Choose an execution input…' : 'Choose a matching parameter input…' : runStatus || `${graph.variables.length} variables · ${graph.nodes.length} nodes · ${graph.links.length} data links`}</span><button type="button" className={styles.runButton} onClick={() => { setRunStatus('Running…'); void dispatch('run-parametric-graph', { id: elementId }).then((result) => setRunStatus(result.ok ? `Applied ${String(result.value)} connection${result.value === 1 ? '' : 's'}` : result.error.message)); }}>Run</button><button type="button" onClick={close}>Back to board</button></footer>
        {contextMenu && <div className={styles.contextMenu} role="menu" aria-label="Add graph node" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <input autoFocus aria-label="Search graph nodes" placeholder="Search nodes…" value={nodeSearch} onChange={(event) => setNodeSearch(event.target.value)} />
          {[{ label: 'Variable', add: () => addVariable({ x: contextMenu.graphX, y: contextMenu.graphY }) }, { label: 'Calculation', add: () => addCalculation({ x: contextMenu.graphX, y: contextMenu.graphY }) }, ...availableElements.filter((element) => !graph.nodes.some((node) => node.elementId === element.id)).map((element) => ({ label: `Reference · ${elementName(element)}`, add: () => addNode({ id: uid('node'), kind: 'element', label: nestedElementName(doc.elements, elementId, element), elementId: element.id, x: contextMenu.graphX, y: contextMenu.graphY }) }))].filter((item) => item.label.toLowerCase().includes(nodeSearch.toLowerCase())).map((item) => <button key={item.label} type="button" role="menuitem" onClick={() => { item.add(); setContextMenu(null); }}>{item.label}</button>)}
          <small>Nodes are placed where you right-clicked.</small>
        </div>}
      </section>
    </div>
  );
}

/**
 * System-tool commands: everything that re-derives geometry from `meta.arch.parameters`.
 * Placement (`create-arch-element`, `create-wall-segments`) lives in ./assets.ts and calls
 * into the helpers here so a wall, door, window, column, stair or railing always looks the way
 * its parameters say — whether it was just placed, reconfigured, resized or re-hosted.
 */
import type { Draft } from 'immer';
import { z } from 'zod';
import { archOf, hostedBy, isArchType, systemTypeOf } from '@/assets/arch-meta';
import {
  columnParametersFromRect,
  columnRect,
  doorMountOffset,
  doorTemplate,
  railingStyle,
  reflowStairFlights,
  stairChildren,
  stairRailingPath,
  windowMountOffset,
  windowTemplate,
  type ArchTemplate,
  type StairFlight,
} from '@/assets/system-geometry';
import { boardSizeAxes, instanceParameterKeys, resolveSystemParameters, SYSTEM_PARAMETER_DEFINITIONS, type SystemParameterValue } from '@/assets/system-assets';
import { parseSystemParameters, wallThickness, type SystemAssetType } from '@/catalog';
import { CurvePathSchema, IdSchema, JsonValueSchema, childrenOf, type Element, type ElementTable, type JsonValue, type LineElement, type TemplateDefinition } from '@/document';
import { indexesBetween } from '@/document/order';
import { angleOf, applyToPoint, distance, invert, pointAtLine, rotate, sampleCurvePath, sub, worldMatrix, type Vec2 } from '@/geometry';
import { openingOf } from '@/interaction/wallSnap';
import { movePathEndpoint, resizeBezierHandles, wallPathParameters } from '@/assets/wall-path';
import { joinWallEnd, unjoinWallEnd, withoutWallJoint } from './wallJoints';
import { CommandError, defineMutation, type MutationContext } from '../contract';
import { removeSubtree, requireTargets, setSelection, snapshot, syncCameraFromMarker, topIndex } from '../helpers';

const Parameters = z.record(z.string(), JsonValueSchema);

export const StairFlightSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run'), x: z.number().finite(), y: z.number().finite(), angle: z.number().finite(), treads: z.int().positive() }),
  z.object({ kind: z.literal('landing'), x: z.number().finite(), y: z.number().finite(), angle: z.number().finite(), width: z.number().positive().optional(), depth: z.number().positive().optional(), offset: z.number().finite().optional() }),
]);

// ---- meta helpers --------------------------------------------------------------------------

function archDraft(element: Draft<Element>): Record<string, JsonValue> {
  const meta = snapshot(element.meta ?? {});
  const arch = archOf(element as Element);
  const next: Record<string, JsonValue> = arch ? snapshot(arch) : {};
  element.meta = { ...meta, arch: next };
  return next;
}

/** Wall thickness of an element (from its layers, then legacy `thickness`, then the stroke). */
export function wallThicknessOf(element: Element | undefined): number | null {
  if (!element || element.kind !== 'line' || !isArchType(element, 'wall')) return null;
  const arch = archOf(element);
  const parameters = arch?.['parameters'];
  if (parameters && typeof parameters === 'object' && !Array.isArray(parameters) && Array.isArray(parameters['layers'])) {
    return wallThickness(parseSystemParameters('wall', parameters).layers);
  }
  const thickness = arch?.['thickness'];
  return typeof thickness === 'number' && thickness > 0 ? thickness : element.style.strokeWidth;
}

// ---- template definitions ------------------------------------------------------------------

function parameterSignature(parameters: Record<string, unknown>, keys: string[]): string {
  return keys.map((key) => `${key}=${JSON.stringify(parameters[key])}`).join('&');
}

/** Finds or creates the built-in template definition for one parameter set. */
export function ensureTemplateDefinition(
  ctx: MutationContext,
  builtinId: string,
  name: string,
  category: string,
  template: ArchTemplate,
  meta: Record<string, JsonValue>,
): TemplateDefinition {
  const existing = Object.values(ctx.doc.definitions).find((d): d is TemplateDefinition => d.kind === 'template' && d.builtinId === builtinId);
  if (existing) return existing;
  const id = ctx.ids.next('def');
  const definition: TemplateDefinition = {
    id,
    kind: 'template',
    name,
    category,
    width: template.width,
    height: template.height,
    origin: 'builtin',
    builtinId,
    elements: Object.fromEntries(template.elements.map((e) => [e.id, structuredClone(e)])),
    meta: snapshot(meta),
  };
  ctx.doc.definitions[id] = definition;
  return definition;
}

export function doorDefinition(ctx: MutationContext, parameters: ReturnType<typeof parseSystemParameters<'door'>>): { definition: TemplateDefinition; template: ArchTemplate } {
  const template = doorTemplate(parameters);
  const signature = parameterSignature(parameters, ['operation', 'width', 'handing', 'openingSide']);
  const definition = ensureTemplateDefinition(ctx, `arch:door?${signature}`, 'Door', 'Openings', template, { arch: { type: 'door', width: parameters.width } });
  return { definition, template };
}

export function windowDefinition(ctx: MutationContext, parameters: ReturnType<typeof parseSystemParameters<'window'>>, depth: number): { definition: TemplateDefinition; template: ArchTemplate } {
  const template = windowTemplate(parameters, depth);
  const signature = `${parameterSignature(parameters, ['mechanism', 'width', 'openingDirection'])}&depth=${Math.round(depth)}`;
  const definition = ensureTemplateDefinition(ctx, `arch:window?${signature}`, 'Window', 'Openings', template, { arch: { type: 'window', width: parameters.width } });
  return { definition, template };
}

/** Thickness of the wall an opening belongs to; 150 for unhosted windows. */
export function hostDepth(ctx: MutationContext, element: Element): number {
  const opening = openingOf(element);
  const wall = opening ? ctx.doc.elements[opening.wallId] : undefined;
  return wallThicknessOf(wall as Element | undefined) ?? 150;
}

// ---- rebuilds ------------------------------------------------------------------------------

function mountPoint(element: Element & { kind: 'instance' }, mountOffset: number): Vec2 {
  const offset = rotate({ x: element.width / 2, y: mountOffset }, element.rotation);
  return { x: element.x + offset.x, y: element.y + offset.y };
}

function rebuildMounted(ctx: MutationContext, element: Draft<Element>, type: 'door' | 'window'): void {
  if (element.kind !== 'instance') return;
  const arch = archDraft(element);
  const currentOffset = typeof arch['wallMountOffset'] === 'number' ? arch['wallMountOffset'] : 0;
  const anchor = mountPoint(element as Element & { kind: 'instance' }, currentOffset);
  const usingImage = typeof arch['systemAssetId'] === 'string' && ctx.doc.definitions[element.definitionId]?.kind === 'image';

  let width: number;
  let height: number;
  let mountOffset: number;
  if (type === 'door') {
    const parameters = parseSystemParameters('door', arch['parameters']);
    arch['parameters'] = parameters as unknown as JsonValue;
    if (usingImage) {
      const definition = ctx.doc.definitions[element.definitionId]!;
      width = parameters.width;
      height = definition.width > 0 ? (definition.height / definition.width) * width : width;
      mountOffset = parameters.openingSide === 'outside' ? height : 0;
    } else {
      const { definition, template } = doorDefinition(ctx, parameters);
      element.definitionId = definition.id;
      width = template.width;
      height = template.height;
      mountOffset = doorMountOffset(parameters, template);
    }
  } else {
    const parameters = parseSystemParameters('window', arch['parameters']);
    arch['parameters'] = parameters as unknown as JsonValue;
    const depth = hostDepth(ctx, element as Element);
    if (usingImage) {
      width = parameters.width;
      height = Math.max(depth, 20);
      mountOffset = height / 2;
    } else {
      const { definition, template } = windowDefinition(ctx, parameters, depth);
      element.definitionId = definition.id;
      width = template.width;
      height = template.height;
      mountOffset = windowMountOffset(depth);
    }
  }

  element.width = width;
  element.height = height;
  arch['width'] = width;
  arch['wallMountOffset'] = mountOffset;
  const offset = rotate({ x: width / 2, y: mountOffset }, element.rotation);
  element.x = anchor.x - offset.x;
  element.y = anchor.y - offset.y;
  const opening = arch['opening'];
  if (opening && typeof opening === 'object' && !Array.isArray(opening) && typeof opening['start'] === 'number' && typeof opening['end'] === 'number') {
    const middle = (opening['start'] + opening['end']) / 2;
    arch['opening'] = { ...opening, start: Math.max(0, middle - width / 2), end: Math.max(0, middle - width / 2) + width };
  }
}

function rebuildColumn(element: Draft<Element>): void {
  if (element.kind !== 'rect') return;
  const arch = archDraft(element);
  const parameters = parseSystemParameters('column', arch['parameters']);
  arch['parameters'] = parameters as unknown as JsonValue;
  const spec = columnRect(parameters);
  const centre = rotate({ x: element.width / 2, y: element.height / 2 }, element.rotation);
  const cx = element.x + centre.x;
  const cy = element.y + centre.y;
  element.width = spec.width;
  element.height = spec.height;
  element.radius = spec.radius;
  element.style = { ...element.style, fill: spec.style.fill };
  const next = rotate({ x: spec.width / 2, y: spec.height / 2 }, element.rotation);
  element.x = cx - next.x;
  element.y = cy - next.y;
}

export function stairFlightsOf(element: Element | undefined): StairFlight[] {
  const flights = archOf(element)?.['flights'];
  const parsed = z.array(StairFlightSchema).safeParse(flights);
  return parsed.success ? parsed.data : [];
}

function rebuildStair(ctx: MutationContext, element: Draft<Element>): void {
  if (element.kind !== 'group') return;
  const arch = archDraft(element);
  const parameters = parseSystemParameters('stair', arch['parameters']);
  arch['parameters'] = parameters as unknown as JsonValue;
  const flights = reflowStairFlights(parameters, stairFlightsOf(element as Element));
  arch['flights'] = flights as unknown as JsonValue;
  // Generated plan primitives are disposable; user-hosted items such as railings survive.
  for (const child of childrenOf(ctx.doc.elements as ElementTable, element.id)) {
    if (typeof child.meta?.['role'] === 'string') removeSubtree(ctx.doc, child.id);
  }
  const children = stairChildren(parameters, flights);
  const indexes = indexesBetween(null, null, children.length);
  children.forEach((child, i) => {
    const id = ctx.ids.next('el');
    ctx.doc.elements[id] = { ...child.element, id, parentId: element.id, index: indexes[i]! } as Element;
  });
  for (const child of childrenOf(ctx.doc.elements as ElementTable, element.id)) {
    if (isArchType(child as Element, 'railing')) syncRailingWithStair(ctx, child, element);
  }
}

/** Makes a nested railing follow its stair's current width, tread length and flight path. */
export function syncRailingWithStair(_ctx: MutationContext, railing: Draft<Element>, stair: Draft<Element>): void {
  if (railing.kind !== 'line' || stair.kind !== 'group' || !isArchType(railing as Element, 'railing') || !isArchType(stair as Element, 'stair')) return;
  const stairParameters = parseSystemParameters('stair', archOf(stair as Element)?.['parameters']);
  const side = railing.meta?.['stairSide'] === 'left' ? 'left' : 'right';
  const points = stairRailingPath(stairParameters, stairFlightsOf(stair as Element), side);
  if (points.length < 2) return;
  railing.parentId = stair.id;
  railing.x = 0;
  railing.y = 0;
  railing.rotation = 0;
  railing.points = points;
  const meta = snapshot(railing.meta ?? {});
  meta['stairAttached'] = true;
  meta['stairSide'] = side;
  railing.meta = meta;
  rebuildRailing(railing);
}

function createAttachedStairRailing(ctx: MutationContext, stairId: string, side: 'left' | 'right'): string {
  const stair = ctx.doc.elements[stairId];
  if (!stair || stair.kind !== 'group' || !isArchType(stair as Element, 'stair')) throw new CommandError('rejected', 'Select a stair');
  const parameters = placementParameters(ctx, 'railing');
  const chosen = ctx.ui.systemAssets['railing'];
  const id = ctx.ids.next('el');
  ctx.doc.elements[id] = {
    id,
    kind: 'line',
    parentId: stairId,
    index: topIndex(ctx.doc.elements as ElementTable, stairId),
    x: 0,
    y: 0,
    rotation: 0,
    visible: true,
    locked: false,
    name: `${side === 'left' ? 'Left' : 'Right'} stair railing`,
    points: [[0, 0], [1, 0]],
    closed: false,
    style: railingStyle(parseSystemParameters('railing', parameters).thickness),
    meta: {
      stairAttached: true,
      stairSide: side,
      arch: {
        type: 'railing',
        parameters: parameters as unknown as JsonValue,
        ...(chosen ? { systemAssetId: chosen.id, systemAssetName: chosen.name, instanceEditable: chosen.instanceEditable ?? [] } : {}),
      },
    },
  };
  syncRailingWithStair(ctx, ctx.doc.elements[id]!, stair);
  return id;
}

function rebuildWall(ctx: MutationContext, element: Draft<Element>): void {
  if (element.kind !== 'line') return;
  const arch = archDraft(element);
  const parameters = parseSystemParameters('wall', arch['parameters']);
  arch['parameters'] = parameters as unknown as JsonValue;
  const thickness = wallThickness(parameters.layers);
  arch['thickness'] = thickness;
  element.style = { ...element.style, strokeWidth: thickness };
  const rawStart = element.path?.start ?? element.points[0]!;
  const rawEnd = element.points.at(-1)!;
  const start: [number, number] = [rawStart[0], rawStart[1]];
  const end: [number, number] = [rawEnd[0], rawEnd[1]];
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.max(1, Math.hypot(dx, dy));
  const nx = -dy / length;
  const ny = dx / length;
  if (arch['pathParametersDirty'] || !element.path && parameters.pathType !== 'straight') {
  if (parameters.pathType === 'straight') {
    delete element.path;
    element.points = [start, end];
  } else if (parameters.pathType === 'arc') {
    const bulge = Math.abs(parameters.arcBulge) < 0.001 ? 0.001 : parameters.arcBulge;
    const center: [number, number] = [(start[0] + end[0]) / 2 + nx * length * bulge, (start[1] + end[1]) / 2 + ny * length * bulge];
    element.path = {
      start,
      segments: [{ kind: 'arc', center, radius: Math.hypot(start[0] - center[0], start[1] - center[1]), startAngle: Math.atan2(start[1] - center[1], start[0] - center[0]), endAngle: Math.atan2(end[1] - center[1], end[0] - center[0]), clockwise: bulge < 0 }],
    };
    element.points = sampleCurvePath(snapshot(element.path), 32);
  } else {
    const handles = parameters.bezierHandles;
    const point = (x: number, y: number): [number, number] => [start[0] + dx * x + nx * length * y, start[1] + dy * x + ny * length * y];
    const count = handles.length / 2;
    element.path = {
      start,
      segments: Array.from({ length: count }, (_, index) => {
        const first = handles[index * 2]!;
        const second = handles[index * 2 + 1]!;
        const next = handles[index * 2 + 2];
        return { kind: 'bezier' as const, control1: point(first[0], first[1]), control2: point(second[0], second[1]), to: next ? point((second[0] + next[0]) / 2, (second[1] + next[1]) / 2) : end };
      }),
    };
    element.points = sampleCurvePath(snapshot(element.path), 32);
  }
  delete arch['pathParametersDirty'];
  }
  // Windows take their depth from the wall that hosts them.
  for (const other of Object.values(ctx.doc.elements)) {
    if (isArchType(other as Element, 'window') && openingOf(other as Element)?.wallId === element.id) rebuildMounted(ctx, other, 'window');
  }
}

function rebuildRailing(element: Draft<Element>): void {
  if (element.kind !== 'line') return;
  const arch = archDraft(element);
  const parameters = parseSystemParameters('railing', arch['parameters']);
  arch['parameters'] = parameters as unknown as JsonValue;
  element.style = { ...element.style, strokeWidth: railingStyle(parameters.thickness).strokeWidth };
}

function rebuildFacadeElement(ctx: MutationContext, element: Draft<Element>): void {
  if (element.kind !== 'instance') return;
  const arch = archDraft(element);
  const parameters = parseSystemParameters('facade-element', arch['parameters']);
  arch['parameters'] = parameters as unknown as JsonValue;
  const oldWidth = element.width;
  const oldDepth = element.height;
  const centre = rotate({ x: oldWidth / 2, y: oldDepth / 2 }, element.rotation);
  const centreWorld = { x: element.x + centre.x, y: element.y + centre.y };
  element.width = parameters.width;
  element.height = parameters.depth;
  arch['width'] = parameters.width;

  const opening = openingOf(element as Element);
  const wall = opening ? ctx.doc.elements[opening.wallId] : null;
  if (wall?.kind === 'line' && opening && opening.segment < wall.points.length - 1) {
    const thickness = wallThicknessOf(wall as Element) ?? wall.style.strokeWidth;
    const oldMount = typeof arch['wallMountOffset'] === 'number' ? arch['wallMountOffset'] : oldDepth / 2;
    // A negative offset means the facade grows away from the wall's right-hand face. On the
    // opposite face its far edge touches the wall, so the offset follows the new depth.
    arch['wallMountOffset'] = oldMount < 0 ? -thickness / 2 : parameters.depth + thickness / 2;
    const middle = (opening.start + opening.end) / 2;
    seatOnSegment(ctx.doc.elements as ElementTable, element, wall as LineElement, opening.segment, middle);
  } else {
    const next = rotate({ x: parameters.width / 2, y: parameters.depth / 2 }, element.rotation);
    element.x = centreWorld.x - next.x;
    element.y = centreWorld.y - next.y;
  }
}

/** Re-derives an element's geometry from its parameters. No-op for non-system elements. */
export function rebuildSystemElement(ctx: MutationContext, id: string): void {
  const element = ctx.doc.elements[id];
  if (!element) return;
  switch (systemTypeOf(element as Element)) {
    case 'wall':
      rebuildWall(ctx, element);
      return;
    case 'railing':
      rebuildRailing(element);
      return;
    case 'facade-element':
      rebuildFacadeElement(ctx, element);
      return;
    case 'column':
      rebuildColumn(element);
      return;
    case 'door':
      rebuildMounted(ctx, element, 'door');
      return;
    case 'window':
      rebuildMounted(ctx, element, 'window');
      return;
    case 'stair':
      rebuildStair(ctx, element);
      return;
    case 'floor':
    case 'ceiling': {
      const arch = archDraft(element);
      const parameters = systemTypeOf(element as Element) === 'floor'
        ? parseSystemParameters('floor', arch['parameters'])
        : parseSystemParameters('ceiling', arch['parameters']);
      arch['parameters'] = parameters as unknown as JsonValue;
      const meta = snapshot(element.meta ?? {});
      element.meta = { ...meta, arch, solid: { height: parameters.thickness, elevation: parameters.elevation } };
      return;
    }
    default:
      return;
  }
}

/** After a hand resize of a column (or a window preview) the parameters follow the new size. */
export function syncParametersFromSize(element: Draft<Element>): void {
  const type = systemTypeOf(element as Element);
  if (type === 'column' && element.kind === 'rect') {
    const arch = archDraft(element);
    const parameters = columnParametersFromRect(parseSystemParameters('column', arch['parameters']), element.width, element.height);
    arch['parameters'] = parameters as unknown as JsonValue;
    rebuildColumn(element);
  }
}

/**
 * Rejects a hand resize (board handle, temporary dimension, resize command) that would change a
 * size the element's type owns: only instance parameters may be edited per element.
 */
export function assertInstanceSizable(element: Element, widthChanges: boolean, heightChanges: boolean): void {
  const arch = archOf(element);
  const axes = boardSizeAxes(arch?.['type'], arch as { parameters?: unknown; instanceEditable?: unknown } | null);
  if (!axes) return;
  if ((widthChanges && !axes.width) || (heightChanges && !axes.height)) {
    throw new CommandError('rejected', 'This size is a type parameter; change it in the type, or make it an instance parameter');
  }
}

// ---- commands ------------------------------------------------------------------------------

function requireSystem(ctx: MutationContext, id: string): { element: Draft<Element>; type: SystemAssetType } {
  const [element] = requireTargets(ctx, [id], { unlocked: true });
  const type = systemTypeOf(element as Element);
  if (!element || !type) throw new CommandError('rejected', 'Select a system architecture element');
  return { element, type };
}

export const setSystemParameter = defineMutation({
  id: 'set-system-parameter',
  label: 'Set system parameter',
  description: 'Sets one parameter of a system element and rebuilds its geometry.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, key: z.string().min(1), value: JsonValueSchema }),
  run: (ctx, input) => {
    const { element, type } = requireSystem(ctx, input.id);
    const arch = archDraft(element);
    const current = arch['parameters'];
    const merged = { ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}), [input.key]: input.value };
    arch['parameters'] = resolveSystemParameters(type, merged) as unknown as JsonValue;
    if (type === 'wall' && ['pathType', 'arcBulge', 'bezierHandles'].includes(input.key)) arch['pathParametersDirty'] = true;
    const overrides = arch['instanceOverrides'];
    arch['instanceOverrides'] = {
      ...(overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {}),
      [input.key]: input.value,
    };
    rebuildSystemElement(ctx, element.id);
    return element.id;
  },
});

export const setSystemParameters = defineMutation({
  id: 'set-system-parameters',
  label: 'Set system parameters',
  description: 'Replaces the parameters of a system element in one step and rebuilds its geometry.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, parameters: Parameters }),
  run: (ctx, input) => {
    const { element, type } = requireSystem(ctx, input.id);
    const arch = archDraft(element);
    arch['parameters'] = resolveSystemParameters(type, input.parameters) as unknown as JsonValue;
    rebuildSystemElement(ctx, element.id);
    return element.id;
  },
});

export const resizeWindow = defineMutation({
  id: 'resize-window',
  label: 'Resize window',
  description: 'Changes a window width along its host wall, keeping the chosen jamb fixed.',
  group: 'transform',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, width: z.number().min(200), anchor: z.enum(['start', 'end', 'centre']).default('centre') }),
  run: (ctx, input) => {
    const { element, type } = requireSystem(ctx, input.id);
    if (type !== 'window' || element.kind !== 'instance') throw new CommandError('rejected', 'Select a window');
    assertInstanceSizable(element as Element, Math.abs(input.width - element.width) > 1e-6, false);
    const before = element.width;
    const initial = archDraft(element);
    const parameters = parseSystemParameters('window', initial['parameters']);
    initial['parameters'] = { ...parameters, width: input.width } as unknown as JsonValue;
    rebuildMounted(ctx, element, 'window');
    // rebuildMounted keeps the centre; shift so the requested jamb stays put.
    const arch = archDraft(element);
    const delta = (input.width - before) / 2;
    if (input.anchor !== 'centre') {
      const shift = rotate({ x: input.anchor === 'start' ? delta : -delta, y: 0 }, element.rotation);
      element.x += shift.x;
      element.y += shift.y;
      const opening = arch['opening'];
      if (opening && typeof opening === 'object' && !Array.isArray(opening) && typeof opening['start'] === 'number' && typeof opening['end'] === 'number') {
        const move = input.anchor === 'start' ? delta : -delta;
        arch['opening'] = { ...opening, start: Math.max(0, opening['start'] + move), end: Math.max(0, opening['start'] + move) + input.width };
      }
    }
    return element.id;
  },
});

/** Re-seats a door/window on a wall segment at `along` millimetres from the segment start. */
function seatOnSegment(elements: ElementTable, mounted: Draft<Element>, wall: LineElement, segment: number, along: number): void {
  if (mounted.kind !== 'instance') return;
  const arch = archDraft(mounted);
  const width = mounted.width;
  const mountOffset = typeof arch['wallMountOffset'] === 'number' ? arch['wallMountOffset'] : 0;
  const matrix = worldMatrix(elements, wall);
  if (wall.path) {
    const centreLocation = pointAtLine(wall, along);
    if (!centreLocation || centreLocation.totalLength < width) return;
    const centre = Math.max(width / 2, Math.min(centreLocation.totalLength - width / 2, along));
    const located = pointAtLine(wall, centre);
    if (!located) return;
    const localStart = {
      x: located.point.x - located.tangent.x * width / 2,
      y: located.point.y - located.tangent.y * width / 2,
    };
    const start = applyToPoint(matrix, localStart);
    const worldCentre = applyToPoint(matrix, located.point);
    const rotation = angleOf(sub(worldCentre, start));
    const normal = rotate({ x: 1, y: 0 }, rotation + 90);
    mounted.x = start.x - normal.x * mountOffset;
    mounted.y = start.y - normal.y * mountOffset;
    mounted.rotation = rotation;
    arch['opening'] = { wallId: wall.id, segment: 0, start: centre - width / 2, end: centre + width / 2, curveAlong: centre };
    return;
  }
  const a = { x: wall.points[segment]![0], y: wall.points[segment]![1] };
  const b = { x: wall.points[segment + 1]![0], y: wall.points[segment + 1]![1] };
  const ab = sub(b, a);
  const length = Math.hypot(ab.x, ab.y);
  if (length <= 0) return;
  const unit = { x: ab.x / length, y: ab.y / length };
  const centre = Math.max(width / 2, Math.min(length - width / 2, along));
  const start = applyToPoint(matrix, { x: a.x + unit.x * (centre - width / 2), y: a.y + unit.y * (centre - width / 2) });
  const ahead = applyToPoint(matrix, { x: a.x + unit.x * centre, y: a.y + unit.y * centre });
  const rotation = angleOf(sub(ahead, start));
  const normal = rotate({ x: 1, y: 0 }, rotation + 90);
  mounted.x = start.x - normal.x * mountOffset;
  mounted.y = start.y - normal.y * mountOffset;
  mounted.rotation = rotation;
  arch['opening'] = { wallId: wall.id, segment, start: centre - width / 2, end: centre + width / 2 };
}

function jointPartners(element: Element, endpoint: 'start' | 'end'): string[] {
  const joints = archOf(element)?.['joints'];
  const joint = joints && typeof joints === 'object' && !Array.isArray(joints) ? joints[endpoint] : null;
  if (!joint || typeof joint !== 'object' || Array.isArray(joint) || joint['enabled'] !== true) return [];
  return Array.isArray(joint['with']) ? joint['with'].filter((id): id is string => typeof id === 'string') : [];
}

export const moveLineEndpoint = defineMutation({
  id: 'move-line-endpoint',
  label: 'Move endpoint',
  description: 'Moves one end of a wall or railing to a world point; joined walls and hosted openings follow.',
  group: 'transform',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, endpoint: z.union([z.enum(['start', 'end']), z.string().regex(/^point:\d+$/)]), x: z.number().finite(), y: z.number().finite(), followJoined: z.boolean().default(true) }),
  run: (ctx, input) => {
    const [element] = requireTargets(ctx, [input.id], { unlocked: true });
    if (!element || element.kind !== 'line') throw new CommandError('rejected', 'Select a wall or railing');
    const elements = ctx.doc.elements as ElementTable;
    if (input.endpoint === 'start' || input.endpoint === 'end') {
      const through = jointPartners(element as Element, input.endpoint).some((id) => {
        const joints = archOf(elements[id])?.['joints'] as { body?: { with?: string[] } } | undefined;
        return joints?.body?.with?.includes(element.id);
      });
      if (through) unjoinWallEnd(ctx, element.id, input.endpoint);
    }
    const pointIndex = input.endpoint.startsWith('point:') ? Number(input.endpoint.slice(6)) : null;
    const index = pointIndex ?? (input.endpoint === 'start' ? 0 : element.points.length - 1);
    if (!Number.isInteger(index) || index < 0 || index >= element.points.length) throw new CommandError('invalid-input', 'That railing point no longer exists');
    const endpoint = index === 0 ? 'start' : index === element.points.length - 1 ? 'end' : null;
    const matrix = worldMatrix(elements, element as Element);
    const before = applyToPoint(matrix, { x: element.points[index]![0], y: element.points[index]![1] });
    const target = { x: input.x, y: input.y };
    const local = applyToPoint(invert(matrix), target);
    if (element.path && (input.endpoint === 'start' || input.endpoint === 'end')) {
      element.path = movePathEndpoint(snapshot(element.path), input.endpoint, [local.x, local.y]);
      element.points = sampleCurvePath(snapshot(element.path), 32);
      joinWallEnd(ctx, element.id, input.endpoint as 'start' | 'end');
      syncWallPathParameters(element);
    const wall = snapshot(element) as LineElement;
      for (const mounted of Object.values(ctx.doc.elements)) {
        const opening = openingOf(mounted as Element);
        if (!opening || opening.wallId !== element.id || mounted.kind !== 'instance') continue;
        seatOnSegment(elements, mounted, wall, opening.segment, opening.curveAlong ?? (opening.start + opening.end) / 2);
      }
      return element.id;
    }
    element.points[index] = [local.x, local.y];
    syncWallPathParameters(element);

    if (endpoint && input.followJoined && isArchType(element as Element, 'wall', 'curtain-wall')) {
      const joints = archOf(element as Element)?.['joints'];
      const joint = joints && typeof joints === 'object' && !Array.isArray(joints) ? joints[endpoint] : null;
      const withIds = joint && typeof joint === 'object' && !Array.isArray(joint) && Array.isArray(joint['with']) ? joint['with'] : [];
      for (const otherId of withIds) {
        if (typeof otherId !== 'string' || otherId === element.id) continue;
        const other = ctx.doc.elements[otherId];
        if (!other || other.kind !== 'line' || other.locked) continue;
        const otherMatrix = worldMatrix(elements, other as Element);
        for (const candidate of [0, other.points.length - 1]) {
          const point = applyToPoint(otherMatrix, { x: other.points[candidate]![0], y: other.points[candidate]![1] });
          if (distance(point, before) <= 5) {
            const otherLocal = applyToPoint(invert(otherMatrix), target);
            other.points[candidate] = [otherLocal.x, otherLocal.y];
          }
        }
      }
    }
    // Dropped near another wall's end (and not dragging partners along): meet it and join.
    if (endpoint && isArchType(element as Element, 'wall', 'curtain-wall')) {
      const joinedNow = jointPartners(element as Element, endpoint);
      if (!input.followJoined || joinedNow.length === 0) {
        if (!input.followJoined) element.meta = withoutWallJoint(element.meta as Record<string, JsonValue> | undefined, endpoint);
        joinWallEnd(ctx, element.id, endpoint);
      }
    }

    // Hosted doors/windows keep their place along the wall, re-seated on the moved segment.
    const segment = index === 0 ? 0 : Math.max(0, index - 1);
    for (const mounted of Object.values(ctx.doc.elements)) {
      const opening = openingOf(mounted as Element);
      if (!opening || opening.wallId !== element.id || opening.segment !== segment || mounted.kind !== 'instance') continue;
      const wall = element as Draft<LineElement>;
      const a = { x: wall.points[segment]![0], y: wall.points[segment]![1] };
      const b = { x: wall.points[segment + 1]![0], y: wall.points[segment + 1]![1] };
      const ab = sub(b, a);
      const length = Math.hypot(ab.x, ab.y);
      if (length <= 0) continue;
      const arch = archOf(mounted as Element);
      const mountOffset = arch && typeof arch['wallMountOffset'] === 'number' ? arch['wallMountOffset'] : 0;
      const centreWorld = mountPoint(mounted as Element & { kind: 'instance' }, mountOffset);
      const centreLocal = applyToPoint(invert(matrix), centreWorld);
      const along = ((centreLocal.x - a.x) * ab.x + (centreLocal.y - a.y) * ab.y) / length;
      seatOnSegment(elements, mounted, snapshot(wall) as LineElement, segment, along);
    }
    syncCameraFromMarker(elements, element as Element);
    return element.id;
  },
});

export const createStair = defineMutation({
  id: 'create-stair',
  label: 'Create stair',
  description: 'Creates a stair group from runs and landings drawn step by step.',
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({
    /** World coordinates; the group origin becomes the first flight start. */
    flights: z.array(StairFlightSchema).min(1),
    parameters: Parameters.optional(),
    parentId: IdSchema.nullable().default(null),
    meta: z.record(z.string(), JsonValueSchema).optional(),
  }),
  run: (ctx, input) => {
    const parameters = resolveSystemParameters('stair', input.parameters ?? {});
    const origin = { x: input.flights[0]!.x, y: input.flights[0]!.y };
    const flights = input.flights.map((flight) => ({ ...flight, x: flight.x - origin.x, y: flight.y - origin.y }));
    const id = ctx.ids.next('el');
    ctx.doc.elements[id] = {
      id,
      kind: 'group',
      parentId: input.parentId,
      index: topIndex(ctx.doc.elements as ElementTable, input.parentId),
      x: origin.x,
      y: origin.y,
      rotation: 0,
      visible: true,
      locked: false,
      name: 'Stairs',
      meta: { ...(input.meta ?? {}), arch: { ...(archOf({ meta: input.meta } as Element) ?? {}), type: 'stair', parameters: parameters as unknown as JsonValue, flights: flights as unknown as JsonValue } },
    };
    rebuildStair(ctx, ctx.doc.elements[id]!);
    createAttachedStairRailing(ctx, id, 'right');
    setSelection(ctx, [id]);
    return id;
  },
});

export const addStairRailing = defineMutation({
  id: 'add-stair-railing',
  label: 'Add stair railing',
  description: 'Adds another independently configurable railing to the selected side of a stair.',
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({ stairId: IdSchema, side: z.enum(['left', 'right']).default('right') }),
  run: (ctx, input) => {
    const id = createAttachedStairRailing(ctx, input.stairId, input.side);
    setSelection(ctx, [id]);
    return id;
  },
});

export const setSystemParameterBatch = defineMutation({
  id: 'set-system-parameter-batch',
  label: 'Set shared instance parameter',
  description: 'Sets one parameter exposed by every selected system instance as a single undoable edit.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ ids: z.array(IdSchema).min(2), key: z.string().min(1), value: JsonValueSchema }),
  run: (ctx, input) => {
    const ids = [...new Set(input.ids)];
    for (const id of ids) {
      const { element, type } = requireSystem(ctx, id);
      const arch = archDraft(element);
      const editable = instanceParameterKeys(type, arch['instanceEditable']);
      const definition = SYSTEM_PARAMETER_DEFINITIONS[type].find((item) => item.key === input.key);
      if (!definition || !editable.includes(input.key)) throw new CommandError('rejected', `${input.key} is not a shared instance parameter`);
    }
    for (const id of ids) setSystemParameter.run(ctx, { id, key: input.key, value: input.value });
    return ids;
  },
});

export const setStairRailingSide = defineMutation({
  id: 'set-stair-railing-side',
  label: 'Set stair railing side',
  description: 'Moves an attached stair railing to the left or right edge.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, side: z.enum(['left', 'right']) }),
  run: (ctx, input) => {
    const railing = ctx.doc.elements[input.id];
    const stair = railing?.parentId ? ctx.doc.elements[railing.parentId] : null;
    if (!railing || !stair || !isArchType(railing as Element, 'railing') || !isArchType(stair as Element, 'stair')) throw new CommandError('rejected', 'Select a railing attached to a stair');
    const meta = snapshot(railing.meta ?? {});
    meta['stairSide'] = input.side;
    railing.meta = meta;
    railing.name = `${input.side === 'left' ? 'Left' : 'Right'} stair railing`;
    syncRailingWithStair(ctx, railing, stair);
    return railing.id;
  },
});

function facadeAndWall(ctx: MutationContext, id: string): { facade: Draft<Element> & { kind: 'instance' }; wall: Draft<Element> & { kind: 'line' }; opening: NonNullable<ReturnType<typeof openingOf>> } {
  const element = ctx.doc.elements[id];
  if (!element || element.kind !== 'instance' || !isArchType(element as Element, 'facade-element')) throw new CommandError('rejected', 'Select a facade element hosted on a wall');
  const opening = openingOf(element as Element);
  const wall = opening ? ctx.doc.elements[opening.wallId] : null;
  if (!opening || !wall || wall.kind !== 'line' || opening.segment >= wall.points.length - 1) throw new CommandError('rejected', 'This facade element is not hosted on a wall');
  return { facade: element as Draft<Element> & { kind: 'instance' }, wall: wall as Draft<Element> & { kind: 'line' }, opening };
}

/** Replaces the editable source path and immediately re-seats everything hosted on it. */
function syncWallPathParameters(element: Draft<Element>): void {
  if (element.kind !== 'line' || !isArchType(element as Element, 'wall')) return;
  const arch = archDraft(element);
  const geometry = wallPathParameters(snapshot(element) as LineElement);
  arch['parameters'] = { ...resolveSystemParameters('wall', arch['parameters']), ...geometry } as JsonValue;
  const overrides = arch['instanceOverrides'];
  arch['instanceOverrides'] = { ...(overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {}), ...geometry } as JsonValue;
  delete arch['pathParametersDirty'];
}

export const setLineCurvePath = defineMutation({
  id: 'set-line-curve-path',
  label: 'Edit wall curve',
  description: 'Updates an analytic wall arc/Bézier path without flattening it and regenerates all hosted elements.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, path: CurvePathSchema.nullable() }),
  run: (ctx, input) => {
    const [element] = requireTargets(ctx, [input.id], { unlocked: true });
    if (!element || element.kind !== 'line' || !isArchType(element as Element, 'wall', 'curtain-wall')) {
      throw new CommandError('rejected', 'Select a wall or curtain wall');
    }
    if (input.path) {
      element.path = snapshot(input.path);
      element.points = sampleCurvePath(input.path, 32);
    } else {
      if (element.path) {
        const sampled = sampleCurvePath(snapshot(element.path), 32);
        element.points = [sampled[0]!, sampled.at(-1)!];
      }
      delete element.path;
    }
    syncWallPathParameters(element);
    const wall = snapshot(element) as LineElement;
    for (const mounted of Object.values(ctx.doc.elements)) {
      const opening = openingOf(mounted as Element);
      if (!opening || opening.wallId !== element.id || mounted.kind !== 'instance') continue;
      seatOnSegment(ctx.doc.elements as ElementTable, mounted, wall, opening.segment, opening.curveAlong ?? (opening.start + opening.end) / 2);
    }
    return element.id;
  },
});

export const moveLineCurveHandle = defineMutation({
  id: 'move-line-curve-handle',
  label: 'Move curve handle',
  description: 'Moves an analytic arc centre or Bézier control point and updates every hosted element.',
  group: 'transform',
  palette: false,
  history: 'record',
  input: z.object({
    id: IdSchema,
    segment: z.number().int().nonnegative(),
    handle: z.enum(['control', 'control1', 'control2', 'center']),
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  run: (ctx, input) => {
    const [element] = requireTargets(ctx, [input.id], { unlocked: true });
    if (!element || element.kind !== 'line' || !element.path) throw new CommandError('rejected', 'Select a curved wall');
    const segment = element.path.segments[input.segment];
    if (!segment) throw new CommandError('invalid-input', 'That curve segment no longer exists');
    const local = applyToPoint(invert(worldMatrix(ctx.doc.elements as ElementTable, element as Element)), { x: input.x, y: input.y });
    const point: [number, number] = [local.x, local.y];
    if (segment.kind === 'quadratic' && input.handle === 'control') segment.control = point;
    else if (segment.kind === 'bezier' && input.handle === 'control1') segment.control1 = point;
    else if (segment.kind === 'bezier' && input.handle === 'control2') segment.control2 = point;
    else if (segment.kind === 'arc' && input.handle === 'center') segment.center = point;
    else throw new CommandError('invalid-input', 'That handle does not belong to this curve segment');
    element.points = sampleCurvePath(snapshot(element.path), 32);
    syncWallPathParameters(element);
    const wall = snapshot(element) as LineElement;
    for (const mounted of Object.values(ctx.doc.elements)) {
      const opening = openingOf(mounted as Element);
      if (!opening || opening.wallId !== element.id || mounted.kind !== 'instance') continue;
      seatOnSegment(ctx.doc.elements as ElementTable, mounted, wall, opening.segment, opening.curveAlong ?? (opening.start + opening.end) / 2);
    }
    return element.id;
  },
});

export const flipFacadeSide = defineMutation({
  id: 'flip-facade-side',
  label: 'Flip facade side',
  description: 'Moves a hosted facade element to the opposite face of its wall.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema }),
  run: (ctx, input) => {
    const { facade, wall, opening } = facadeAndWall(ctx, input.id);
    const arch = archDraft(facade);
    const thickness = wallThicknessOf(wall as Element) ?? wall.style.strokeWidth;
    const current = typeof arch['wallMountOffset'] === 'number' ? arch['wallMountOffset'] : facade.height / 2;
    arch['wallMountOffset'] = current < 0 ? facade.height + thickness / 2 : -thickness / 2;
    seatOnSegment(ctx.doc.elements as ElementTable, facade, wall as LineElement, opening.segment, (opening.start + opening.end) / 2);
    return facade.id;
  },
});

export const arrayFacadeAlongWall = defineMutation({
  id: 'array-facade-along-wall',
  label: 'Array facade along wall',
  description: 'Evenly repeats a facade element across its hosted wall segment.',
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema }),
  run: (ctx, input) => {
    const selected = ctx.doc.elements[input.id];
    const selectedMeta = selected?.meta ?? {};
    const sourceId = typeof selectedMeta['facadeArraySource'] === 'string' && ctx.doc.elements[selectedMeta['facadeArraySource']]
      ? selectedMeta['facadeArraySource']
      : input.id;
    const { facade, wall, opening } = facadeAndWall(ctx, sourceId);
    for (const candidate of Object.values(ctx.doc.elements)) {
      if (candidate.id !== facade.id && candidate.meta?.['facadeArraySource'] === facade.id) removeSubtree(ctx.doc, candidate.id);
    }
    const a = wall.points[opening.segment]!;
    const b = wall.points[opening.segment + 1]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const count = Math.max(1, Math.floor(length / facade.width));
    const margin = (length - count * facade.width) / 2;
    const ids: string[] = [facade.id];
    const rootMeta = snapshot(facade.meta ?? {});
    rootMeta['facadeArrayRoot'] = true;
    delete rootMeta['facadeArraySource'];
    facade.meta = rootMeta;
    for (let index = 0; index < count; index++) {
      const along = margin + facade.width * (index + 0.5);
      let item = facade;
      if (index > 0) {
        const id = ctx.ids.next('el');
        const meta = snapshot(facade.meta ?? {});
        meta['facadeArraySource'] = facade.id;
        delete meta['facadeArrayRoot'];
        item = { ...snapshot(facade), id, index: topIndex(ctx.doc.elements as ElementTable, facade.parentId), name: facade.name ? `${facade.name} ${index + 1}` : `Facade element ${index + 1}`, meta } as typeof facade;
        ctx.doc.elements[id] = item;
        ids.push(id);
      }
      seatOnSegment(ctx.doc.elements as ElementTable, item, wall as LineElement, opening.segment, along);
    }
    setSelection(ctx, ids);
    return ids;
  },
});

/** Choose the system parameters for a placement: the tool's chosen type first, then defaults. */
export function placementParameters(ctx: MutationContext, type: SystemAssetType, overrides?: unknown): Record<string, SystemParameterValue> {
  const chosen = ctx.ui.systemAssets[type];
  const base = chosen?.systemParameters ?? {};
  const extra = overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? (overrides as Record<string, unknown>) : {};
  return resolveSystemParameters(type, { ...base, ...extra });
}

export const setHost = defineMutation({
  id: 'set-host',
  label: 'Host element',
  description: 'Hosts an element on another one so it moves with it and is listed under it in Layers; null unhosts.',
  group: 'arrange',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, hostId: IdSchema.nullable() }),
  run: (ctx, input) => {
    const [element] = requireTargets(ctx, [input.id], { unlocked: true });
    if (!element) throw new CommandError('rejected', 'Select an element to host');
    const elements = ctx.doc.elements as ElementTable;
    if (input.hostId !== null) {
      if (input.hostId === element.id) throw new CommandError('rejected', 'An element cannot host itself');
      if (!ctx.doc.elements[input.hostId]) throw new CommandError('rejected', `Unknown host ${input.hostId}`);
      if (hostedBy(elements, [element.id]).includes(input.hostId)) throw new CommandError('rejected', 'That would host an element on something it already hosts');
    }
    const meta = snapshot(element.meta ?? {});
    if (input.hostId === null) delete meta['host'];
    else meta['host'] = input.hostId;
    element.meta = meta;
    return element.id;
  },
});

export const setWallHandleCount = defineMutation({
  id: 'set-wall-handle-count', label: 'Set Bézier handle count', group: 'edit', palette: false, history: 'record',
  input: z.object({ id: IdSchema, count: z.number().int().min(2).max(64).refine((count) => count % 2 === 0, 'Use two handles per Bézier segment') }),
  run: (ctx, input) => {
    const [element] = requireTargets(ctx, [input.id], { unlocked: true });
    if (!element || element.kind !== 'line' || !element.path || !element.path.segments.every((segment) => segment.kind === 'bezier' || segment.kind === 'quadratic')) throw new CommandError('rejected', 'Select a Bézier wall');
    return setLineCurvePath.run(ctx, { id: element.id, path: resizeBezierHandles(snapshot(element.path), input.count) });
  },
});

export const systemCommands = [setWallHandleCount, setHost, setSystemParameter, setSystemParameterBatch, setSystemParameters, resizeWindow, moveLineEndpoint, setLineCurvePath, moveLineCurveHandle, createStair, addStairRailing, setStairRailingSide, flipFacadeSide, arrayFacadeAlongWall];

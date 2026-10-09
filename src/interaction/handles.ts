/**
 * Selection frame + handle geometry, in screen space, shared by the overlay (drawing) and the
 * interaction controller (hit-testing handles).
 */
import { archOf, canRotateByHandle, hasEndpointHandles, isArchType, resizeRuleFor } from '@/assets/arch-meta';
import { boardSizeAxes } from '@/assets/system-assets';
import type { ArchaiDocument, Element } from '@/document';
import { isPlainLine } from '@/commands/builtin/drafting';
import {
  applyToPoint,
  boundsOfIds,
  orientedCorners,
  linePoints,
  rectCorners,
  worldMatrix,
  worldToScreen,
  type Rect,
  type Vec2,
  type ViewportLike,
} from '@/geometry';

export type HandleId = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'rotate' | 'start' | 'end' | `point:${number}` | `curve:${number}:${'control' | 'control1' | 'control2' | 'center'}` | `vertex:${number}` | `seg:${number}` | `radius:${number}` | `node:${number}`;
export type CursorKind = 'ew' | 'ns' | 'nwse' | 'nesw' | 'rotate' | 'move' | 'text' | null;

export interface Handle {
  id: HandleId;
  /** screen position */
  x: number;
  y: number;
  hx: -1 | 0 | 1;
  hy: -1 | 0 | 1;
  cursor: CursorKind;
  /** Endpoint handles of walls/railings; world position of the endpoint. */
  world?: Vec2;
  /** Bézier control handles: the node they belong to (screen), drawn as a tie line. */
  tie?: Vec2;
}

export interface SelectionFrame {
  kind: 'single' | 'multi';
  /** World-space axis-aligned bounds of the selection. */
  bounds: Rect;
  /** Screen-space corners: top-left, top-right, bottom-right, bottom-left (oriented for single). */
  corners: [Vec2, Vec2, Vec2, Vec2];
  /** World rotation of the frame (0 for multi-selections). */
  rotation: number;
  element: Element | null;
  handles: Handle[];
}

export const ROTATE_HANDLE_OFFSET = 26;
export const HANDLE_RADIUS = 7;

const HANDLE_SPECS: { id: HandleId; hx: -1 | 0 | 1; hy: -1 | 0 | 1 }[] = [
  { id: 'nw', hx: -1, hy: -1 },
  { id: 'n', hx: 0, hy: -1 },
  { id: 'ne', hx: 1, hy: -1 },
  { id: 'e', hx: 1, hy: 0 },
  { id: 'se', hx: 1, hy: 1 },
  { id: 's', hx: 0, hy: 1 },
  { id: 'sw', hx: -1, hy: 1 },
  { id: 'w', hx: -1, hy: 0 },
];

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Resize cursor for an outward direction (screen space, y-down). */
export function cursorForDirection(dx: number, dy: number): CursorKind {
  const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 180;
  if (angle < 22.5 || angle >= 157.5) return 'ew';
  if (angle < 67.5) return 'nwse';
  if (angle < 112.5) return 'ns';
  return 'nesw';
}

/**
 * Handles for one element, following its editing rule: walls and railings expose their two
 * endpoints only, windows the two jambs along the wall, doors and stairs nothing, circular
 * columns no rotation.
 */
/**
 * Grips of a plain drawn line: every vertex (`vertex:i`) and every straight segment's middle
 * (`seg:i`) of a polyline; arcs and circles get a radius grip (`radius:i`) and open curves
 * their two ends. Null for lines that are not plain (walls, markers) or curves without grips.
 */
function plainLineHandles(doc: ArchaiDocument, element: Extract<Element, { kind: 'line' }>, viewport: ViewportLike): Handle[] | null {
  if (!isPlainLine(element)) return null;
  const m = worldMatrix(doc.elements, element);
  const at = (p: readonly [number, number]) => {
    const world = applyToPoint(m, { x: p[0], y: p[1] });
    const screen = worldToScreen(viewport, world);
    return { world, x: screen.x, y: screen.y };
  };
  const segments = element.path?.segments;
  if (!segments || segments.every((segment) => segment.kind === 'line')) {
    const local = element.path ? [element.path.start, ...segments!.map((segment) => (segment as { to: [number, number] }).to)] : element.points;
    const points = local.map(at);
    const handles: Handle[] = points.map((p, i) => ({ id: `vertex:${i}` as const, hx: 0, hy: 0, x: p.x, y: p.y, cursor: 'move', world: p.world }));
    const count = element.closed ? points.length : points.length - 1;
    for (let i = 0; i < count; i++) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      const world = { x: (a.world.x + b.world.x) / 2, y: (a.world.y + b.world.y) / 2 };
      handles.push({ id: `seg:${i}` as const, hx: 0, hy: 0, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, cursor: 'move', world });
    }
    return handles;
  }
  const handles: Handle[] = [];
  // Nodes of the path: its start and the end of every segment (a closed path's last = its start).
  const nodes: [number, number][] = [element.path!.start];
  for (const segment of segments) {
    if (segment.kind === 'arc') nodes.push([segment.center[0] + Math.cos(segment.endAngle) * segment.radius, segment.center[1] + Math.sin(segment.endAngle) * segment.radius]);
    else nodes.push(segment.to);
  }
  const first = nodes[0]!;
  const last = nodes.at(-1)!;
  if (element.closed && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6) nodes.pop();
  const fullCircle = segments.length === 1 && segments[0]!.kind === 'arc' && element.closed;
  if (!fullCircle) {
    nodes.forEach((node, i) => {
      const p = at(node);
      handles.push({ id: `node:${i}` as const, hx: 0, hy: 0, x: p.x, y: p.y, cursor: 'move', world: p.world });
    });
  }
  segments.forEach((segment, i) => {
    if (segment.kind === 'bezier' || segment.kind === 'quadratic') {
      const from = at(nodes[i] ?? first);
      const to = at(segment.to);
      const controls: ['control1' | 'control2' | 'control', [number, number], typeof from][] = segment.kind === 'bezier'
        ? [['control1', segment.control1, from], ['control2', segment.control2, to]]
        : [['control', segment.control, from]];
      for (const [kind, point, tie] of controls) {
        const p = at(point);
        handles.push({ id: `curve:${i}:${kind}` as const, hx: 0, hy: 0, x: p.x, y: p.y, cursor: 'move', world: p.world, tie: { x: tie.x, y: tie.y } });
      }
    }
  });
  segments.forEach((segment, i) => {
    if (segment.kind !== 'arc') return;
    let sweep = segment.endAngle - segment.startAngle;
    if (segment.clockwise && sweep > 0) sweep -= Math.PI * 2;
    if (!segment.clockwise && sweep < 0) sweep += Math.PI * 2;
    const mid = segment.startAngle + sweep / 2;
    const p = at([segment.center[0] + Math.cos(mid) * segment.radius, segment.center[1] + Math.sin(mid) * segment.radius]);
    handles.push({ id: `radius:${i}` as const, hx: 0, hy: 0, x: p.x, y: p.y, cursor: 'move', world: p.world });
  });
  if (!element.closed) {
    const pts = linePoints(element);
    const start = at(pts[0]!);
    const end = at(pts.at(-1)!);
    handles.push({ id: 'start', hx: -1, hy: 0, x: start.x, y: start.y, cursor: 'move', world: start.world }, { id: 'end', hx: 1, hy: 0, x: end.x, y: end.y, cursor: 'move', world: end.world });
  }
  return handles.length ? handles : null;
}

function handlesFor(doc: ArchaiDocument, element: Element, corners: [Vec2, Vec2, Vec2, Vec2], viewport: ViewportLike): Handle[] {
  if (element.kind === 'line') {
    const plain = plainLineHandles(doc, element, viewport);
    if (plain) return plain;
  }
  if (hasEndpointHandles(element)) {
    const m = worldMatrix(doc.elements, element);
    if (isArchType(element, 'railing')) {
      return element.points.map((point, index) => {
        const world = applyToPoint(m, { x: point[0], y: point[1] });
        const screen = worldToScreen(viewport, world);
        return { id: `point:${index}` as const, hx: 0, hy: 0, x: screen.x, y: screen.y, cursor: 'move', world };
      });
    }
    const pathPoints = linePoints(element);
    const first = pathPoints[0]!;
    const last = pathPoints.at(-1)!;
    const startWorld = applyToPoint(m, { x: first[0], y: first[1] });
    const endWorld = applyToPoint(m, { x: last[0], y: last[1] });
    const start = worldToScreen(viewport, startWorld);
    const end = worldToScreen(viewport, endWorld);
    const handles: Handle[] = [
      { id: 'start', hx: -1, hy: 0, x: start.x, y: start.y, cursor: 'move', world: startWorld },
      { id: 'end', hx: 1, hy: 0, x: end.x, y: end.y, cursor: 'move', world: endWorld },
    ];
    element.path?.segments.forEach((segment, segmentIndex) => {
      const add = (kind: 'control' | 'control1' | 'control2' | 'center', point: readonly [number, number]) => {
        const world = applyToPoint(m, { x: point[0], y: point[1] });
        const screen = worldToScreen(viewport, world);
        handles.push({ id: `curve:${segmentIndex}:${kind}`, hx: 0, hy: 0, x: screen.x, y: screen.y, cursor: 'move', world });
      };
      if (segment.kind === 'quadratic') add('control', segment.control);
      else if (segment.kind === 'bezier') {
        add('control1', segment.control1);
        add('control2', segment.control2);
      } else if (segment.kind === 'arc') add('center', segment.center);
    });
    return handles;
  }
  const rule = resizeRuleFor(element);
  if (rule === 'none') return [];
  const all = buildHandles(corners);
  // A camera/section rig moves and rotates as one; resizing would scale its marker.
  if (element.meta?.['viewRig']) return all.filter((handle) => handle.id === 'rotate');
  const rotatable = canRotateByHandle(element);
  // Sizes driven by a type parameter only change through the type, never on the board.
  const axes = systemAxes(element);
  return all.filter((handle) => {
    if (handle.id === 'rotate') return rotatable;
    if (axes && ((handle.hx !== 0 && !axes.width) || (handle.hy !== 0 && !axes.height))) return false;
    if (rule === 'width') return handle.id === 'e' || handle.id === 'w';
    if (rule === 'uniform') return handle.hx !== 0 && handle.hy !== 0;
    return true;
  });
}

function buildHandles(corners: [Vec2, Vec2, Vec2, Vec2]): Handle[] {
  const [tl, tr, br, bl] = corners;
  const center = lerp(tl, br, 0.5);
  const at = (hx: number, hy: number): Vec2 => {
    const top = lerp(tl, tr, (hx + 1) / 2);
    const bottom = lerp(bl, br, (hx + 1) / 2);
    return lerp(top, bottom, (hy + 1) / 2);
  };
  const handles: Handle[] = HANDLE_SPECS.map((spec) => {
    const p = at(spec.hx, spec.hy);
    return { ...spec, x: p.x, y: p.y, cursor: cursorForDirection(p.x - center.x, p.y - center.y) };
  });
  const topMid = at(0, -1);
  const length = Math.hypot(topMid.x - center.x, topMid.y - center.y) || 1;
  const up = { x: (topMid.x - center.x) / length, y: (topMid.y - center.y) / length };
  handles.push({
    id: 'rotate',
    hx: 0,
    hy: -1,
    x: topMid.x + up.x * ROTATE_HANDLE_OFFSET,
    y: topMid.y + up.y * ROTATE_HANDLE_OFFSET,
    cursor: 'rotate',
  });
  return handles;
}

export function computeSelectionFrame(doc: ArchaiDocument, selection: readonly string[], viewport: ViewportLike): SelectionFrame | null {
  const ids = selection.filter((id) => doc.elements[id]);
  if (ids.length === 0) return null;
  const bounds = boundsOfIds(doc.elements, ids);
  if (!bounds) return null;

  if (ids.length === 1) {
    const element = doc.elements[ids[0]!]!;
    if (element.kind !== 'group') {
      const world = orientedCorners(doc.elements, element);
      const corners = world.map((c) => worldToScreen(viewport, c)) as [Vec2, Vec2, Vec2, Vec2];
      const m = worldMatrix(doc.elements, element);
      const rotation = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
      return { kind: 'single', bounds, corners, rotation, element, handles: handlesFor(doc, element, corners, viewport) };
    }
  }
  const corners = rectCorners(bounds).map((c) => worldToScreen(viewport, c)) as [Vec2, Vec2, Vec2, Vec2];
  return {
    kind: ids.length === 1 ? 'single' : 'multi',
    bounds,
    corners,
    rotation: 0,
    element: ids.length === 1 ? doc.elements[ids[0]!]! : null,
    handles: ids.length === 1 ? handlesFor(doc, doc.elements[ids[0]!]!, corners, viewport) : multiHandles(doc, ids, corners),
  };
}

/** Board-sizable axes of a system element (null for anything else). */
export function systemAxes(element: Element | undefined | null): { width: boolean; height: boolean } | null {
  const arch = archOf(element);
  return boardSizeAxes(arch?.['type'], arch as { parameters?: unknown; instanceEditable?: unknown } | null);
}

/** A multi-selection only scales when none of its system elements has a type-driven size. */
function multiHandles(doc: ArchaiDocument, ids: readonly string[], corners: [Vec2, Vec2, Vec2, Vec2]): Handle[] {
  const all = buildHandles(corners);
  const locked = ids.some((id) => {
    const axes = systemAxes(doc.elements[id]);
    return axes !== null && (!axes.width || !axes.height);
  });
  return locked ? all.filter((handle) => handle.id === 'rotate') : all;
}

export function hitHandle(frame: SelectionFrame | null, screen: Vec2, radius = HANDLE_RADIUS): Handle | null {
  if (!frame) return null;
  for (const handle of frame.handles) {
    if (Math.abs(handle.x - screen.x) <= radius && Math.abs(handle.y - screen.y) <= radius) return handle;
  }
  return null;
}

/** Whether the handles are worth showing (tiny selections would be covered by them). */
export function framePixelSize(frame: SelectionFrame): { width: number; height: number } {
  const [tl, tr, , bl] = frame.corners;
  return { width: Math.hypot(tr.x - tl.x, tr.y - tl.y), height: Math.hypot(bl.x - tl.x, bl.y - tl.y) };
}

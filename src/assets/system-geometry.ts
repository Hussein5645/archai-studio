/**
 * Geometry derived from system parameters. Every system element is still made of plain
 * primitives; these builders are the single place that turns `meta.arch.parameters` into
 * template geometry (doors, windows), rect dimensions (columns), stroke widths (walls,
 * railings) or a stair's treads, so the dialog, placement and rebuild commands agree.
 */
import { indexesBetween } from '@/document/order';
import type { Element, LineElement, RectElement, Style, TextElement } from '@/document/schema';
import {
  parseSystemParameters,
  wallThickness,
  type ColumnParameters,
  type DoorParameters,
  type StairParameters,
  type WallParameters,
  type WindowParameters,
} from '@/catalog/system-schemas';

export interface ArchTemplate {
  width: number;
  height: number;
  elements: Element[];
}

export const INK = '#3a3a3f';
export const LIGHT_INK = '#6b6b72';
const RAIL_INK = '#6b6b72';

/** Small builder for template geometry with sequential local ids and indexes. */
export function templateBuilder() {
  const elements: Element[] = [];
  let n = 0;
  const nextId = () => `tpl_${++n}`;
  const base = () => ({ id: nextId(), parentId: null, index: 'a0', rotation: 0, visible: true, locked: false });
  const api = {
    line(points: [number, number][], strokeWidth: number, stroke = INK, closed = false): LineElement {
      const minX = Math.min(...points.map((p) => p[0]));
      const minY = Math.min(...points.map((p) => p[1]));
      const element: LineElement = {
        ...base(),
        kind: 'line',
        x: minX,
        y: minY,
        points: points.map(([x, y]) => [x - minX, y - minY]),
        closed,
        style: { fill: null, stroke, strokeWidth, opacity: 1 },
      };
      elements.push(element);
      return element;
    },
    rect(x: number, y: number, width: number, height: number, style: Partial<Style> = {}, radius = 0): RectElement {
      const element: RectElement = {
        ...base(),
        kind: 'rect',
        x,
        y,
        width,
        height,
        radius,
        style: { fill: '#ffffff', stroke: INK, strokeWidth: 20, opacity: 1, ...style },
      };
      elements.push(element);
      return element;
    },
    text(x: number, y: number, width: number, text: string, fontSize: number): TextElement {
      const element: TextElement = {
        ...base(),
        kind: 'text',
        x,
        y,
        width,
        height: fontSize * 1.3,
        text,
        fontSize,
        align: 'center',
        color: LIGHT_INK,
      };
      elements.push(element);
      return element;
    },
    done(width: number, height: number): ArchTemplate {
      const indexes = indexesBetween(null, null, elements.length);
      elements.forEach((e, i) => {
        e.index = indexes[i]!;
      });
      return { width, height, elements };
    },
  };
  return api;
}

export function arc(cx: number, cy: number, radius: number, fromDeg: number, toDeg: number, segments = 16): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const a = ((fromDeg + ((toDeg - fromDeg) * i) / segments) * Math.PI) / 180;
    points.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  return points;
}

// ---- walls & railings ----------------------------------------------------------------------

export function wallStyle(parameters: WallParameters): Style {
  return { fill: null, stroke: INK, strokeWidth: wallThickness(parameters.layers), opacity: 1 };
}

export function railingStyle(thickness: number): Style {
  return { fill: null, stroke: RAIL_INK, strokeWidth: thickness, opacity: 1 };
}

/**
 * Offsets a drawn path so it becomes the wall's centre line: the location line is what the
 * user traced. "Inside" is the right-hand side of the drawing direction (y grows downwards, so
 * the right-hand normal of (dx, dy) is (-dy, dx)).
 */
export function centreLineFromLocationLine(points: readonly [number, number][], locationLine: WallParameters['locationLine'], thickness: number): [number, number][] {
  if (locationLine === 'centre' || points.length < 2) return points.map(([x, y]) => [x, y]);
  // Inside line traced → centre lies to the left (−normal); outside line traced → centre lies to the right.
  const sign = locationLine === 'inside' ? -1 : 1;
  const offset = (thickness / 2) * sign;
  const normals: [number, number][] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i]!;
    const [bx, by] = points[i + 1]!;
    const length = Math.hypot(bx - ax, by - ay) || 1;
    normals.push([-(by - ay) / length, (bx - ax) / length]);
  }
  return points.map(([x, y], i) => {
    const before = normals[i - 1];
    const after = normals[i];
    if (!before || !after) {
      const n = (before ?? after)!;
      return [x + n[0] * offset, y + n[1] * offset];
    }
    // Mitre: average the normals and scale so the offset distance from both segments stays constant.
    const mx = before[0] + after[0];
    const my = before[1] + after[1];
    const mLength = Math.hypot(mx, my);
    if (mLength < 1e-6) return [x + after[0] * offset, y + after[1] * offset];
    const cos = (mx * after[0] + my * after[1]) / mLength;
    const scale = Math.min(4, 1 / Math.max(cos, 0.25));
    return [x + (mx / mLength) * offset * scale, y + (my / mLength) * offset * scale];
  });
}

// ---- doors ---------------------------------------------------------------------------------

/**
 * Plan symbol for a door. The template box is `width × width` (the swing radius). The wall's
 * centre line coincides with the template's top edge when the door opens "inside" and with the
 * bottom edge when it opens "outside"; `doorMountOffset` reports which.
 */
export function doorTemplate(parameters: DoorParameters): ArchTemplate {
  const w = parameters.width;
  const b = templateBuilder();
  const outside = parameters.openingSide === 'outside';
  const right = parameters.handing === 'right';
  const away = outside ? -1 : 1; // direction the leaf swings, along y
  switch (parameters.operation) {
    case 'double-swing': {
      const half = w / 2;
      const wallY = outside ? half : 0;
      b.line([[0, wallY], [0, wallY + away * half]], 40);
      b.line(arc(0, wallY, half, 0, away * 90), 8, LIGHT_INK);
      b.line([[w, wallY], [w, wallY + away * half]], 40);
      b.line(arc(w, wallY, half, 180, 180 - away * 90), 8, LIGHT_INK);
      return b.done(w, half);
    }
    case 'sliding': {
      const depth = Math.min(w * 0.18, 160);
      const wallY = outside ? depth : 0;
      const leafY = wallY + away * depth;
      b.line([[0, wallY], [w, wallY]], 10, LIGHT_INK);
      const leaf = right ? [[w / 2, leafY], [w, leafY]] : [[0, leafY], [w / 2, leafY]];
      b.line(leaf as [number, number][], 40);
      const pocket = right ? [[0, leafY], [w / 2, leafY]] : [[w / 2, leafY], [w, leafY]];
      b.line(pocket as [number, number][], 12, LIGHT_INK);
      return b.done(w, depth);
    }
    case 'folding': {
      const panels = 4;
      const step = w / panels;
      const depth = step * 0.9;
      const wallY = outside ? depth : 0;
      const points: [number, number][] = [];
      for (let i = 0; i <= panels; i++) points.push([i * step, wallY + (i % 2 === 1 ? away * depth : 0)]);
      b.line(points, 40);
      return b.done(w, depth);
    }
    case 'revolving': {
      const r = w / 2;
      b.line(arc(r, r, r, 0, 360, 32), 12, LIGHT_INK, true);
      b.line([[r, 0], [r, w]], 30);
      b.line([[0, r], [w, r]], 30);
      return b.done(w, w);
    }
    default: {
      const wallY = outside ? w : 0;
      const hingeX = right ? w : 0;
      b.line([[hingeX, wallY], [hingeX, wallY + away * w]], 40);
      const from = right ? 180 : 0;
      const to = right ? 180 - away * 90 : away * 90;
      b.line(arc(hingeX, wallY, w, from, to), 8, LIGHT_INK);
      return b.done(w, w);
    }
  }
}

/** Local y of the wall centre line inside a door template. */
export function doorMountOffset(parameters: DoorParameters, template: ArchTemplate): number {
  return parameters.openingSide === 'outside' ? template.height : 0;
}

// ---- windows -------------------------------------------------------------------------------

/** Plan symbol for a window: a frame the thickness of the host wall with a glazing line. */
export function windowTemplate(parameters: WindowParameters, depth: number): ArchTemplate {
  const w = parameters.width;
  const d = Math.max(depth, 20);
  const b = templateBuilder();
  b.rect(0, 0, w, d, { strokeWidth: 16 });
  if (parameters.mechanism === 'sliding') {
    b.line([[0, d * 0.38], [w * 0.55, d * 0.38]], 10);
    b.line([[w * 0.45, d * 0.62], [w, d * 0.62]], 10);
  } else {
    b.line([[0, d / 2], [w, d / 2]], 10);
  }
  if (parameters.openingDirection !== 'none' && parameters.mechanism !== 'fixed' && parameters.mechanism !== 'sliding') {
    // Opening indicator: a shallow chevron on the side the sash swings to.
    const sign = parameters.openingDirection === 'outward' ? -1 : 1;
    const reach = Math.min(w * 0.3, 350);
    b.line([[0, sign > 0 ? d : 0], [w / 2, (sign > 0 ? d : 0) + sign * reach], [w, sign > 0 ? d : 0]], 6, LIGHT_INK);
    return b.done(w, d + reach);
  }
  return b.done(w, d);
}

/** Local y of the wall centre line inside a window template. */
export function windowMountOffset(depth: number): number {
  return Math.max(depth, 20) / 2;
}

// ---- columns -------------------------------------------------------------------------------

export const COLUMN_FILLS: Record<ColumnParameters['material'], string> = {
  concrete: '#e4e5e8',
  steel: '#c9ccd3',
  timber: '#e8d9c2',
};

export function columnRect(parameters: ColumnParameters): { width: number; height: number; radius: number; style: Style } {
  const circle = parameters.shape === 'circle';
  const width = circle ? parameters.diameter : parameters.width;
  const height = circle ? parameters.diameter : parameters.depth;
  return {
    width,
    height,
    radius: circle ? width / 2 : 0,
    style: { fill: COLUMN_FILLS[parameters.material], stroke: INK, strokeWidth: 24, opacity: 1 },
  };
}

/** Parameters after a column rect was resized by hand. */
export function columnParametersFromRect(parameters: ColumnParameters, width: number, height: number): ColumnParameters {
  if (parameters.shape === 'circle') {
    const diameter = Math.max(width, height);
    return { ...parameters, diameter };
  }
  return { ...parameters, width, depth: height };
}

// ---- stairs --------------------------------------------------------------------------------

export type StairFlight =
  | { kind: 'run'; x: number; y: number; angle: number; treads: number }
  /**
   * A landing spans `depth` (default landingDepth) along its angle and `width` (default stair
   * width) across it; `offset` shifts it sideways (a U-turn landing is twice as wide and
   * offset so both runs land on it).
   */
  | { kind: 'landing'; x: number; y: number; angle: number; width?: number; depth?: number; offset?: number };

export function stairRiserCount(parameters: StairParameters): number {
  return Math.max(1, Math.ceil(parameters.totalRise / parameters.riserHeight));
}

export function flightLength(flight: StairFlight, parameters: StairParameters): number {
  return flight.kind === 'run' ? flight.treads * parameters.treadDepth : (flight.depth ?? parameters.landingDepth);
}

/** World end point of a flight (its start plus its length along its angle). */
export function flightEnd(flight: StairFlight, parameters: StairParameters): { x: number; y: number } {
  const length = flightLength(flight, parameters);
  const r = (flight.angle * Math.PI) / 180;
  return { x: flight.x + Math.cos(r) * length, y: flight.y + Math.sin(r) * length };
}

export function stairTreadsPlaced(flights: readonly StairFlight[]): number {
  return flights.reduce((sum, flight) => sum + (flight.kind === 'run' ? flight.treads : 0), 0);
}

/** Plan path for a railing attached to either edge of a stair. */
export function stairRailingPath(parameters: StairParameters, flights: readonly StairFlight[], sideName: 'left' | 'right' = 'right'): [number, number][] {
  const points: [number, number][] = [];
  const add = (point: [number, number]) => {
    const previous = points.at(-1);
    if (!previous || Math.hypot(point[0] - previous[0], point[1] - previous[1]) > 0.5) points.push(point);
  };
  for (const flight of flights) {
    const r = (flight.angle * Math.PI) / 180;
    const length = flightLength(flight, parameters);
    const across = flight.kind === 'landing' ? (flight.width ?? parameters.width) : parameters.width;
    const offset = flight.kind === 'landing' ? (flight.offset ?? 0) : 0;
    const side = -parameters.width / 2 + offset + (sideName === 'right' ? across : 0);
    const start: [number, number] = [flight.x - Math.sin(r) * side, flight.y + Math.cos(r) * side];
    const end: [number, number] = [start[0] + Math.cos(r) * length, start[1] + Math.sin(r) * length];
    add(start);
    add(end);
  }
  return points;
}

/**
 * Reconnects a stair after width, tread length or landing depth changes. Flight angles and
 * tread counts are user-authored; their start points and landing turn geometry are derived.
 */
export function reflowStairFlights(parameters: StairParameters, source: readonly StairFlight[]): StairFlight[] {
  if (source.length === 0) return [];
  const flights = source.map((flight) => ({ ...flight })) as StairFlight[];
  for (let index = 1; index < flights.length; index++) {
    const previous = flights[index - 1]!;
    let current = flights[index]!;
    if (previous.kind === 'run') {
      const end = flightEnd(previous, parameters);
      current = { ...current, x: end.x, y: end.y };
      flights[index] = current;
      continue;
    }
    if (current.kind === 'run') {
      const transition = runAfterLanding(previous, current.angle, parameters);
      flights[index - 1] = transition.landing;
      flights[index] = { ...current, x: transition.start.x, y: transition.start.y, angle: transition.angle };
    } else {
      const end = flightEnd(previous, parameters);
      flights[index] = { ...current, x: end.x, y: end.y };
    }
  }
  return flights;
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

export interface StairChild {
  element: DistributiveOmit<Element, 'id' | 'parentId' | 'index'>;
}

/**
 * Child primitives for a stair group, in world coordinates (the group sits at the origin).
 * Each flight's children are rotated by the flight angle about the flight start; the run's
 * width is centred on the drawn centre line.
 */
export function stairChildren(parameters: StairParameters, flights: readonly StairFlight[]): StairChild[] {
  const w = parameters.width;
  const children: StairChild[] = [];
  const base = (x: number, y: number, angle: number) => ({ x, y, rotation: angle, visible: true, locked: false });
  // Every child carries its role so the board can draw it with the stair type's graphics.
  const line = (flight: StairFlight, points: [number, number][], strokeWidth: number, stroke = INK, role: 'riser' | 'nosing' | 'direction' = 'direction') => {
    const minX = Math.min(...points.map((p) => p[0]));
    const minY = Math.min(...points.map((p) => p[1]));
    const r = (flight.angle * Math.PI) / 180;
    // The element origin is the flight start rotated: local (minX, minY) placed along the flight frame.
    const ox = flight.x + Math.cos(r) * minX - Math.sin(r) * minY;
    const oy = flight.y + Math.sin(r) * minX + Math.cos(r) * minY;
    children.push({
      element: {
        ...base(ox, oy, flight.angle),
        kind: 'line',
        points: points.map(([x, y]) => [x - minX, y - minY]),
        closed: false,
        style: { fill: null, stroke, strokeWidth, opacity: 1 },
        meta: { role },
      },
    });
  };
  const rect = (flight: StairFlight, length: number, fill: string, role: 'run' | 'landing') => {
    const r = (flight.angle * Math.PI) / 180;
    const across = flight.kind === 'landing' ? (flight.width ?? w) : w;
    const offset = flight.kind === 'landing' ? (flight.offset ?? 0) : 0;
    // Local origin sits at across = -w/2 + offset (the rect's top edge in the flight frame).
    const top = -w / 2 + offset;
    const ox = flight.x - Math.sin(r) * top;
    const oy = flight.y + Math.cos(r) * top;
    children.push({
      element: {
        ...base(ox, oy, flight.angle),
        kind: 'rect',
        width: length,
        height: across,
        radius: 0,
        style: { fill, stroke: INK, strokeWidth: 16, opacity: 1 },
        meta: { role },
      },
    });
  };

  const totalTreads = stairTreadsPlaced(flights);
  let placed = 0;
  flights.forEach((flight, index) => {
    const length = flightLength(flight, parameters);
    if (flight.kind === 'landing') {
      rect(flight, length, '#f3f4f6', 'landing');
      return;
    }
    rect(flight, length, '#ffffff', 'run');
    for (let i = 1; i < flight.treads; i++) {
      const x = i * parameters.treadDepth;
      line(flight, [[x, -w / 2], [x, w / 2]], 8, LIGHT_INK, 'riser');
      if (parameters.nosing > 0) line(flight, [[x - parameters.nosing, -w / 2], [x - parameters.nosing, w / 2]], 4, LIGHT_INK, 'nosing');
    }
    if (parameters.treadStyle === 'closed-riser') {
      // Closed risers read as a second, heavier line at each riser.
      for (let i = 1; i < flight.treads; i++) line(flight, [[i * parameters.treadDepth + 12, -w / 2], [i * parameters.treadDepth + 12, w / 2]], 8, LIGHT_INK, 'riser');
    }
    // Direction of travel: a centre line along every run, arrow head on the last run.
    const first = index === flights.findIndex((f) => f.kind === 'run');
    const last = placed + flight.treads >= totalTreads;
    const startX = first ? Math.min(length, parameters.treadDepth / 2) : 0;
    line(flight, [[startX, 0], [length, 0]], 12);
    if (last) {
      const head = Math.min(120, w / 4);
      line(flight, [[length - head, -head / 2], [length, 0], [length - head, head / 2]], 12);
    }
    if (first) {
      const r = (flight.angle * Math.PI) / 180;
      const fontSize = Math.min(140, w / 5);
      const labelW = fontSize * 2;
      // "UP" sits beside the first tread, outside the run.
      const fy = -(w / 2 + 40 + fontSize * 1.3);
      const fx = -(labelW / 2 - parameters.treadDepth / 2);
      const lx = flight.x + Math.cos(r) * fx - Math.sin(r) * fy;
      const ly = flight.y + Math.sin(r) * fx + Math.cos(r) * fy;
      children.push({
        element: { ...base(lx, ly, flight.angle), kind: 'text', width: labelW, height: fontSize * 1.3, text: 'UP', fontSize, align: 'center', color: LIGHT_INK, meta: { role: 'label' } },
      });
    }
    placed += flight.treads;
  });
  return children;
}

/**
 * Where the run after a landing starts, from the direction the user is heading:
 * straight on → the far edge; a 90° turn → the landing's side edge at its middle; back (U-turn)
 * → beside the previous run, on a landing widened to carry both runs.
 */
export function runAfterLanding(landing: Extract<StairFlight, { kind: 'landing' }>, headingDeg: number, parameters: StairParameters): { start: { x: number; y: number }; angle: number; landing: Extract<StairFlight, { kind: 'landing' }> } {
  const w = parameters.width;
  const depth = parameters.landingDepth;
  let delta = ((headingDeg - landing.angle) % 360 + 540) % 360 - 180; // -180..180
  const r = (landing.angle * Math.PI) / 180;
  const along = { x: Math.cos(r), y: Math.sin(r) };
  const perp = { x: -Math.sin(r), y: Math.cos(r) }; // +perp = right-hand side
  const at = (a: number, p: number) => ({ x: landing.x + along.x * a + perp.x * p, y: landing.y + along.y * a + perp.y * p });
  if (Math.abs(delta) < 45) {
    return { start: at(depth, 0), angle: landing.angle, landing: { ...landing, width: w, depth, offset: 0 } };
  }
  if (Math.abs(delta) > 135) {
    // U-turn: the landing doubles in width on the turn side; the run comes back beside the first one.
    const sign = delta > 0 ? 1 : -1;
    delta = 180 * sign;
    return { start: at(0, sign * w), angle: landing.angle + delta, landing: { ...landing, width: 2 * w, depth, offset: sign > 0 ? 0 : -w } };
  }
  const sign = delta > 0 ? 1 : -1;
  const turnDepth = Math.max(depth, w);
  const turnStart = { x: landing.x + along.x * (turnDepth / 2) + perp.x * sign * (w / 2), y: landing.y + along.y * (turnDepth / 2) + perp.y * sign * (w / 2) };
  return { start: turnStart, angle: landing.angle + 90 * sign, landing: { ...landing, width: w, depth: turnDepth, offset: 0 } };
}

/** Stair children as a static element table (ids `stair_n`) for previews. */
export function stairPreviewTable(parameters: StairParameters, flights: readonly StairFlight[]): Record<string, Element> {
  const children = stairChildren(parameters, flights);
  const indexes = indexesBetween(null, null, children.length);
  return Object.fromEntries(children.map((child, i) => {
    const id = `stair_${i + 1}`;
    return [id, { ...child.element, id, parentId: null, index: indexes[i]! } as Element];
  }));
}

/** Straight default stair used by the placement preview and by `create-arch-element`. */
export function defaultStairFlights(parameters: StairParameters, x: number, y: number, angle = 90): StairFlight[] {
  return [{ kind: 'run', x, y, angle, treads: stairRiserCount(parameters) }];
}

// ---- shared ---------------------------------------------------------------------------------

export function systemParametersOf<T extends 'wall' | 'window' | 'door' | 'column' | 'stair' | 'railing'>(type: T, arch: Record<string, unknown> | undefined) {
  return parseSystemParameters(type, arch?.['parameters']);
}

/** Cross-section swatch for a layered wall as an SVG document (outside at the top). */
export function wallSectionSvg(layers: readonly { name: string; role: string; thickness: number }[]): string {
  const total = layers.reduce((sum, layer) => sum + layer.thickness, 0) || 1;
  let y = 0;
  const bands = layers
    .map((layer) => {
      const h = (layer.thickness / total) * 200;
      const core = layer.role === 'core';
      const band = `<rect x="0" y="${y.toFixed(1)}" width="300" height="${h.toFixed(1)}" fill="${core ? '#6b6b72' : '#d9dbe0'}" stroke="#3a3a3f" stroke-width="2"/><text x="8" y="${(y + h / 2 + 4).toFixed(1)}" font-size="12" font-family="sans-serif" fill="${core ? '#fff' : '#3a3a3f'}">${layer.name.replace(/[<>&]/g, '')} ${layer.thickness}</text>`;
      y += h;
      return band;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" width="300" height="200">${bands}</svg>`;
}

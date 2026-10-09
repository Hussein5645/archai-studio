import type { ElementTable, LineElement } from '@/document';
import { wallOpeningsFor } from '@/interaction/wallSnap';
import { archOf, archTypeOf } from '@/assets/arch-meta';
import { instanceElevationOf } from '@/view3d/geometry';
import { parseSystemParameters } from '@/catalog';

const point = (x: number, y: number): string => `${+x.toFixed(4)} ${+y.toFixed(4)}`;

/**
 * SVG path for a wall with every attached door/window interval removed. `offset` shifts the
 * path perpendicular to each segment (positive = the wall's inside, its right-hand side), which
 * draws the boundaries between wall layers.
 */
export function wallPathData(wall: LineElement, elements: ElementTable, offset = 0): string {
  const bySegment = new Map<number, { start: number; end: number }[]>();
  const wallParams = parseSystemParameters('wall', archOf(wall)?.['parameters']);
  const wallWorldBottom = instanceElevationOf(wall, elements);
  const wallWorldTop = wallWorldBottom + wallParams.height;

  const openings = wallOpeningsFor(wall, elements);
  for (const { element, opening } of openings) {
    const type = archTypeOf(element);
    let height = 0;
    if (type === 'door') {
      height = parseSystemParameters('door', archOf(element)?.['parameters']).height;
    } else if (type === 'window') {
      height = parseSystemParameters('window', archOf(element)?.['parameters']).height;
    }
    const openingWorldBottom = instanceElevationOf(element, elements);
    const openingWorldTop = openingWorldBottom + height;
    if (openingWorldTop <= wallWorldBottom || openingWorldBottom >= wallWorldTop) {
      continue;
    }

    const intervals = bySegment.get(opening.segment) ?? [];
    intervals.push({ start: opening.start, end: opening.end });
    bySegment.set(opening.segment, intervals);
  }

  const parts: string[] = [];
  let continuesFromPrevious = false;
  for (let segment = 0; segment < wall.points.length - 1; segment++) {
    const [ax, ay] = wall.points[segment]!;
    const [bx, by] = wall.points[segment + 1]!;
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    if (length <= 0) continue;
    const ox = (-dy / length) * offset;
    const oy = (dx / length) * offset;
    const intervals = (bySegment.get(segment) ?? [])
      .map(({ start, end }) => ({ start: Math.max(0, Math.min(length, start)), end: Math.max(0, Math.min(length, end)) }))
      .filter(({ start, end }) => end > start)
      .sort((a, b) => a.start - b.start);
    const appendVisible = (start: number, end: number) => {
      const startPoint = point(ax + ox + (dx * start) / length, ay + oy + (dy * start) / length);
      const endPoint = point(ax + ox + (dx * end) / length, ay + oy + (dy * end) / length);
      if (continuesFromPrevious && start === 0) parts.push(`L ${endPoint}`);
      else parts.push(`M ${startPoint} L ${endPoint}`);
      continuesFromPrevious = end === length;
    };
    let cursor = 0;
    for (const interval of intervals) {
      if (interval.start > cursor) appendVisible(cursor, interval.start);
      continuesFromPrevious = false;
      cursor = Math.max(cursor, interval.end);
    }
    if (cursor < length) appendVisible(cursor, length);
    else continuesFromPrevious = false;
  }
  return parts.join(' ');
}

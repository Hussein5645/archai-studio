import type { ArchaiDocument, Element } from './index';
import { RenderLightSchema, type RenderLight } from '@shared/renderLights';
import { applyToPoint, worldMatrix } from '@/geometry';
import { instanceElevationOf } from '@/view3d/geometry';
import { isEffectivelyVisible } from './index';

export function renderLightOf(doc: ArchaiDocument, element: Element): RenderLight | null {
  const data = element.meta?.['renderLight'];
  if (!data || typeof data !== 'object' || Array.isArray(data) || (element.kind !== 'rect' && element.kind !== 'line')) return null;
  const matrix = worldMatrix(doc.elements, element);
  const point = applyToPoint(matrix, element.kind === 'line' ? { x: element.points[0]![0], y: element.points[0]![1] } : { x: element.width / 2, y: element.height / 2 });
  let yaw = ((Number(data['yaw'] ?? 0) + Math.atan2(matrix[1], matrix[0]) * 180 / Math.PI + 540) % 360) - 180;
  let tilt = Number(data['tilt'] ?? -90);
  if (element.kind === 'line' && data['kind'] === 'spot') {
    const last = element.points.at(-1)!;
    const aim = applyToPoint(matrix, { x: last[0], y: last[1] });
    yaw = Math.atan2(aim.y - point.y, aim.x - point.x) * 180 / Math.PI;
    tilt = Math.atan2(Number(data['targetElevation'] ?? 0) - instanceElevationOf(element, doc.elements), Math.hypot(aim.x - point.x, aim.y - point.y)) * 180 / Math.PI;
  }
  const size = element.kind === 'rect' && data['kind'] === 'area' ? Math.max(0.01, Math.min(100, element.width * Math.hypot(matrix[0], matrix[1]) / 1000)) : data['size'];
  const height = element.kind === 'rect' && data['kind'] === 'area' ? Math.max(0.01, Math.min(100, element.height * Math.hypot(matrix[2], matrix[3]) / 1000)) : data['height'];
  const result = RenderLightSchema.safeParse({ ...data, id: element.id, name: element.name || 'Light', yaw, tilt, size, height,
    position: [point.x / 1000, instanceElevationOf(element, doc.elements) / 1000, point.y / 1000] });
  return result.success ? result.data : null;
}
export function renderLightsOf(doc: ArchaiDocument): RenderLight[] {
  return Object.values(doc.elements).filter((e) => isEffectivelyVisible(doc.elements, e.id))
    .map((e) => renderLightOf(doc, e)).filter((light): light is RenderLight => light !== null).slice(0, 64);
}

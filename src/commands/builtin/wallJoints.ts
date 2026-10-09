/**
 * Wall joints: which wall ends meet. Ends that land close to another wall's end are snapped
 * onto it and both walls record the joint, so the renderer mitres the corner and moving one
 * end drags the other along.
 */
import { movePathEndpoint } from '@/assets/wall-path';
import { snapshot } from '../helpers';
import { isArchType } from '@/assets/arch-meta';
import type { Element, ElementTable, JsonValue } from '@/document';
import { applyToPoint, boundaryEndpoints, distance, invert, linePoints, sampleCurvePath, projectOnLine, worldMatrix, type Vec2 } from '@/geometry';
import { z } from 'zod';
import { IdSchema } from '@/document';
import { CommandError, defineMutation, type MutationContext } from '../contract';

/** Ends within this many millimetres are considered meant to meet. */
export const WALL_JOIN_TOLERANCE = 120;

export function withWallJoint(meta: Record<string, JsonValue> | undefined, endpoint: 'start' | 'end' | 'body', joinedIds: string[]): Record<string, JsonValue> {
  const root = meta && typeof meta === 'object' && !Array.isArray(meta) ? { ...meta } : {};
  const archValue = root['arch'];
  const arch: Record<string, JsonValue> = archValue && typeof archValue === 'object' && !Array.isArray(archValue) ? { ...archValue } : { type: 'wall' };
  const jointsValue = arch['joints'];
  const joints = jointsValue && typeof jointsValue === 'object' && !Array.isArray(jointsValue) ? { ...jointsValue } : {};
  const existing = joints[endpoint];
  const current = existing && typeof existing === 'object' && !Array.isArray(existing) && Array.isArray(existing['with']) ? existing['with'].filter((id): id is string => typeof id === 'string') : [];
  joints[endpoint] = { enabled: true, with: [...new Set([...current, ...joinedIds])] };
  arch['joints'] = joints;
  root['arch'] = arch;
  return root as Record<string, JsonValue>;
}

export function withoutWallJoint(meta: Record<string, JsonValue> | undefined, endpoint: 'start' | 'end' | 'body'): Record<string, JsonValue> {
  const root = meta && typeof meta === 'object' && !Array.isArray(meta) ? { ...meta } : {};
  const archValue = root['arch'];
  if (!archValue || typeof archValue !== 'object' || Array.isArray(archValue)) return root as Record<string, JsonValue>;
  const arch = { ...archValue };
  const jointsValue = arch['joints'];
  const joints = jointsValue && typeof jointsValue === 'object' && !Array.isArray(jointsValue) ? { ...jointsValue } : {};
  joints[endpoint] = { enabled: false, with: [] };
  arch['joints'] = joints;
  root['arch'] = arch;
  return root as Record<string, JsonValue>;
}

/** Removes the joint at one end from this wall and from every partner's record of it. */
export function unjoinWallEnd(ctx: MutationContext, wallId: string, endpoint: 'start' | 'end' | 'body'): void {
  const wall = ctx.doc.elements[wallId];
  if (!wall) return;
  const joints = (wall.meta?.['arch'] as { joints?: Record<string, { with?: unknown }> } | undefined)?.joints;
  const partners = Array.isArray(joints?.[endpoint]?.with) ? (joints![endpoint]!.with as unknown[]).filter((id): id is string => typeof id === 'string') : [];
  wall.meta = withoutWallJoint(wall.meta as Record<string, JsonValue> | undefined, endpoint);
  for (const partnerId of partners) {
    const partner = ctx.doc.elements[partnerId];
    if (!partner) continue;
    const partnerJoints = (partner.meta?.['arch'] as { joints?: Record<string, { with?: unknown }> } | undefined)?.joints ?? {};
    for (const end of ['start', 'end', 'body'] as const) {
      const list = Array.isArray(partnerJoints[end]?.with) ? (partnerJoints[end]!.with as unknown[]).filter((id): id is string => typeof id === 'string') : [];
      if (!list.includes(wallId)) continue;
      const remaining = list.filter((id) => id !== wallId && ctx.doc.elements[id]);
      partner.meta = remaining.length > 0 ? withWallJoint(withoutWallJoint(partner.meta as Record<string, JsonValue> | undefined, end), end, remaining) : withoutWallJoint(partner.meta as Record<string, JsonValue> | undefined, end);
    }
  }
}

export const setWallJoints = defineMutation({
  id: 'set-wall-joints',
  label: 'Wall joints',
  description: 'Joins both ends of a wall with the wall ends they touch (square corners), or separates them.',
  aliases: ['join walls', 'unjoin walls', 'wall corners'],
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, enabled: z.boolean() }),
  run: (ctx, input) => {
    const wall = ctx.doc.elements[input.id];
    if (!wall || wall.kind !== 'line' || !isArchType(wall as Element, 'wall', 'curtain-wall', 'room-divider')) throw new CommandError('rejected', 'Select a wall');
    for (const end of ['start', 'end'] as const) {
      if (input.enabled) joinWallEnd(ctx, input.id, end);
      else unjoinWallEnd(ctx, input.id, end);
    }
    if (!input.enabled) unjoinWallEnd(ctx, input.id, 'body');
    else joinWallBody(ctx, input.id);
    return input.id;
  },
});

/**
 * Snaps one end of `wallId` onto any other wall end within `tolerance` and records the joint on
 * both walls. Returns the ids it joined to (already-joined partners are kept).
 */
export function joinWallEnd(ctx: MutationContext, wallId: string, endpoint: 'start' | 'end', tolerance = WALL_JOIN_TOLERANCE): string[] {
  const elements = ctx.doc.elements as ElementTable;
  const wall = ctx.doc.elements[wallId];
  if (!wall || wall.kind !== 'line' || wall.points.length < 2 || !isArchType(wall as Element, 'wall', 'curtain-wall', 'room-divider')) return [];
  const pathPoints = linePoints(wall);
  const index = endpoint === 'start' ? 0 : pathPoints.length - 1;
  const matrix = worldMatrix(elements, wall as Element);
  const point = applyToPoint(matrix, { x: pathPoints[index]![0], y: pathPoints[index]![1] });
  const candidates = boundaryEndpoints(ctx.doc as unknown as Parameters<typeof boundaryEndpoints>[0]).filter((candidate) => candidate.elementId !== wallId && distance(candidate.point, point) <= tolerance);
  if (candidates.length === 0) {
    let nearest: { id: string; point: Vec2; gap: number } | null = null;
    for (const other of Object.values(elements)) {
      if (other.id === wallId || !other.visible || other.kind !== 'line' || !isArchType(other, 'wall', 'curtain-wall', 'room-divider')) continue;
      const otherMatrix = worldMatrix(elements, other);
      const projected = projectOnLine(other, applyToPoint(invert(otherMatrix), point));
      if (!projected || projected.along <= 2 || projected.totalLength - projected.along <= 2) continue;
      const meet = applyToPoint(otherMatrix, projected.point);
      const gap = distance(point, meet);
      if (gap > tolerance || nearest && gap >= nearest.gap) continue;
      // Parallel overlapping runs are not T-junctions.
      const inside = applyToPoint(matrix, { x: pathPoints[endpoint === 'start' ? 1 : pathPoints.length - 2]![0], y: pathPoints[endpoint === 'start' ? 1 : pathPoints.length - 2]![1] });
      const ahead = applyToPoint(otherMatrix, { x: projected.point.x + projected.tangent.x, y: projected.point.y + projected.tangent.y });
      const cross = (inside.x - point.x) * (ahead.y - meet.y) - (inside.y - point.y) * (ahead.x - meet.x);
      if (Math.abs(cross) < 0.001) continue;
      nearest = { id: other.id, point: meet, gap };
    }
    if (!nearest) return [];
    const local = applyToPoint(invert(matrix), nearest.point);
    if (wall.path) {
      wall.path = movePathEndpoint(snapshot(wall.path), endpoint, [local.x, local.y]);
      wall.points = sampleCurvePath(wall.path, 32);
    } else wall.points[index] = [local.x, local.y];
    wall.meta = withWallJoint(wall.meta, endpoint, [nearest.id]);
    const other = ctx.doc.elements[nearest.id]!;
    other.meta = withWallJoint(other.meta, 'body', [wallId]);
    return [nearest.id];
  }
  // Meet exactly where the nearest existing end is, so the corner closes.
  const nearest = candidates.reduce((best, candidate) => (distance(candidate.point, point) < distance(best.point, point) ? candidate : best));
  const meet: Vec2 = nearest.point;
  const local = applyToPoint(invert(matrix), meet);
  if (wall.path) {
    wall.path = movePathEndpoint(snapshot(wall.path), endpoint, [local.x, local.y]);
    wall.points = sampleCurvePath(wall.path, 32);
  } else wall.points[index] = [local.x, local.y];
  const partners = candidates.filter((candidate) => distance(candidate.point, meet) <= 2);
  wall.meta = withWallJoint(wall.meta, endpoint, partners.map((partner) => partner.elementId));
  for (const partner of partners) {
    const other = ctx.doc.elements[partner.elementId];
    if (other) other.meta = withWallJoint(other.meta, partner.endpoint, [wallId]);
  }
  return partners.map((partner) => partner.elementId);
}

/** Also recognise an existing branch when the through-wall is drawn last. */
export function joinWallBody(ctx: MutationContext, wallId: string): void {
  const elements = ctx.doc.elements as ElementTable;
  const wall = elements[wallId];
  if (!wall || wall.kind !== 'line') return;
  const inverse = invert(worldMatrix(elements, wall));
  for (const candidate of boundaryEndpoints(ctx.doc as unknown as Parameters<typeof boundaryEndpoints>[0])) {
    if (candidate.elementId === wallId) continue;
    const projected = projectOnLine(wall, applyToPoint(inverse, candidate.point));
    if (projected && projected.distance <= 2 && projected.along > 2 && projected.totalLength - projected.along > 2) joinWallEnd(ctx, candidate.elementId, candidate.endpoint, 2);
  }
}

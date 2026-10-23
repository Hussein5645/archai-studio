import { z } from 'zod';
import { IdSchema, type Element, type JsonValue } from '@/document';
import { RenderLightSchema, RenderLightsSchema } from '@shared/renderLights';
import { renderLightOf } from '@/document/renderLight';
import { applyToPoint, invert, worldMatrix } from '@/geometry';
import { defineMutation, CommandError } from '../contract';
import { requireTargets, snapshot } from '../helpers';
import { createPoint } from './points';
import { createLine, createRect } from './create';
import { setInstanceElevation } from './view3d';

export const createLight = defineMutation({
  id: 'create-light', label: 'Add light', group: 'create', history: 'record', palette: false,
  input: z.object({ x: z.number().finite(), y: z.number().finite(), elevation: z.number().finite().default(2500),
    kind: z.enum(['point', 'spot', 'area']).default('point'), name: z.string().min(1).max(80).optional(),
    target: z.tuple([z.number().finite(), z.number().finite()]).optional(), targetElevation: z.number().finite().default(0),
    properties: RenderLightSchema.omit({ id: true, position: true, name: true, kind: true }).partial().optional() }),
  run: (ctx, input) => {
    if (Object.values(ctx.doc.elements).filter((e) => e.meta?.['renderLight']).length >= 64) throw new CommandError('rejected', 'A project supports up to 64 lights');
    const name = input.name ?? `${input.kind === 'point' ? 'Point' : input.kind === 'spot' ? 'Spot' : 'Area'} light`;
    const id = input.kind === 'spot'
      ? createLine.run(ctx, { points: [[input.x, input.y], input.target ?? [input.x + 1000, input.y]], closed: false, rotation: 0, parentId: null, select: true, name, meta: { instanceElevation: input.elevation }, style: { stroke: '#d99b12', strokeWidth: 12 } })
      : input.kind === 'area'
        ? createRect.run(ctx, { x: input.x - 500, y: input.y - 500, width: 1000, height: 1000, radius: 0, rotation: 0, parentId: null, select: true, name, meta: { instanceElevation: input.elevation }, style: { fill: '#fff0d0', stroke: '#d99b12', strokeWidth: 12 } })
        : createPoint.run(ctx, { x: input.x, y: input.y, elevation: input.elevation, name, select: true });
    const element = ctx.doc.elements[id]!;
    const light = RenderLightSchema.parse({ ...input.properties, id, name, kind: input.kind, position: [0, 0, 0] });
    element.meta = { ...snapshot(element.meta ?? {}), renderLight: { kind: light.kind, enabled: light.enabled, color: light.color, intensity: light.intensity, yaw: light.yaw, tilt: light.tilt, radius: light.radius, size: light.size, targetElevation: input.targetElevation } };
    if (element.kind === 'rect') element.style.stroke = '#d99b12';
    return id;
  },
});
export const updateLight = defineMutation({
  id: 'update-light', label: 'Edit light', group: 'edit', history: 'record', palette: false,
  input: z.object({ id: IdSchema, patch: RenderLightSchema.omit({ id: true }).partial().extend({ targetElevation: z.number().finite().optional() }) }),
  run: (ctx, { id, patch }) => {
    const [element] = requireTargets(ctx, [id], { unlocked: true });
    const current = renderLightOf(ctx.doc as never, element! as never);
    if (!current || (element!.kind !== 'rect' && element!.kind !== 'line')) throw new CommandError('rejected', 'Select a light');
    if (patch.position) {
      const parent = element!.parentId ? ctx.doc.elements[element!.parentId] : null;
      const inverse = parent ? invert(worldMatrix(ctx.doc.elements as never, parent as never)) : [1, 0, 0, 1, 0, 0] as const;
      const a = applyToPoint(inverse, { x: current.position[0] * 1000, y: current.position[2] * 1000 });
      const b = applyToPoint(inverse, { x: patch.position[0] * 1000, y: patch.position[2] * 1000 });
      element!.x += b.x - a.x; element!.y += b.y - a.y;
      setInstanceElevation.run(ctx, { ids: [id], elevation: patch.position[1] * 1000 });
    }
    if (patch.name) element!.name = patch.name;
    if (patch.size !== undefined && element!.kind === 'rect' && current.kind === 'area') {
      element!.x += (element!.width - patch.size * 1000) / 2;
      element!.y += (element!.height - patch.size * 1000) / 2;
      element!.width = element!.height = patch.size * 1000;
    }
    const { position: _position, name: _name, ...properties } = patch;
    const previous = element!.meta!['renderLight'] as Record<string, JsonValue>;
    if (properties.yaw !== undefined) properties.yaw = properties.yaw - current.yaw + Number(previous['yaw'] ?? 0);
    element!.meta = { ...snapshot(element!.meta!), renderLight: { ...previous, ...properties } };
    if (patch.kind && patch.kind !== current.kind) {
      const source = element!.kind === 'line' ? element!.points[0]! : [element!.width / 2, element!.height / 2];
      const meta = snapshot(element!.meta!);
      delete meta['point'];
      const size = patch.kind === 'area' ? (patch.size ?? current.size) * 1000 : 300;
      const replacement = patch.kind === 'spot'
        ? { ...snapshot(element!), kind: 'line', points: [source, [source[0]! + 1000, source[1]!]], closed: false, meta }
        : { ...snapshot(element!), kind: 'rect', x: element!.x + source[0]! - size / 2, y: element!.y + source[1]! - size / 2, width: size, height: size, radius: patch.kind === 'point' ? size / 2 : 0, meta: { ...meta, ...(patch.kind === 'point' ? { point: {} } : {}) } };
      ctx.doc.elements[id] = replacement as Element;
      // A changed bounding box changes the rotation centre. Keep the source at its world point.
      const next = renderLightOf(ctx.doc as never, ctx.doc.elements[id]! as never)!;
      const parent = element!.parentId ? ctx.doc.elements[element!.parentId] : null;
      const inverse = parent ? invert(worldMatrix(ctx.doc.elements as never, parent as never)) : [1, 0, 0, 1, 0, 0] as const;
      const a = applyToPoint(inverse, { x: next.position[0] * 1000, y: next.position[2] * 1000 });
      const b = applyToPoint(inverse, { x: (patch.position ?? current.position)[0] * 1000, y: (patch.position ?? current.position)[2] * 1000 });
      ctx.doc.elements[id]!.x += b.x - a.x; ctx.doc.elements[id]!.y += b.y - a.y;
    }
  },
});

export const migrateRenderLights = defineMutation({
  id: 'migrate-render-lights', label: 'Convert saved lights to Board elements', group: 'edit', history: 'none', palette: false,
  input: z.object({ portalId: IdSchema, lights: RenderLightsSchema }),
  run: (ctx, { portalId, lights }) => {
    for (const light of lights) {
      const source = portalId + ':' + light.id;
      if (Object.values(ctx.doc.elements).some((e) => e.meta?.['legacyRenderLight'] === source)) continue;
      const radians = light.yaw * Math.PI / 180;
      const reach = Math.max(10, Math.abs(light.position[1] * 1000 / Math.tan(light.tilt * Math.PI / 180)));
      const id = createLight.run(ctx, { x: light.position[0] * 1000, y: light.position[2] * 1000, elevation: light.position[1] * 1000, kind: light.kind, name: light.name, properties: light, targetElevation: 0, target: [light.position[0] * 1000 + Math.cos(radians) * reach, light.position[2] * 1000 + Math.sin(radians) * reach] });
      ctx.doc.elements[id]!.meta!['legacyRenderLight'] = source;
    }
    const view = ctx.doc.elements[portalId]?.meta?.['view3d'];
    if (view && typeof view === 'object' && !Array.isArray(view)) {
      const settings = view['renderSettings'];
      if (settings && typeof settings === 'object' && !Array.isArray(settings)) settings['lights'] = [];
    }
  },
});

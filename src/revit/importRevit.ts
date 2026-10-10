/**
 * Builds a Revit exchange file (./exchange.ts) into the current document with ArchAI's own
 * commands, so the result behaves exactly like elements drawn in the app: walls with their
 * compound layers and materials, hosted doors and windows cutting them, floors and ceilings with
 * openings, columns, railings, levels with elements linked to them, named rooms, and everything
 * else as movable mesh elements (see src/view3d/meshes.ts) carrying their Revit materials.
 */
import { z } from 'zod';
import { parseSystemParameters } from '@/catalog';
import { doorMountOffset, doorTemplate, windowMountOffset } from '@/assets/system-geometry';
import type { JsonValue } from '@/document';
import { defineMutation, CommandError, type MutationContext } from '@/commands/contract';
import { createArchElement, createRoomEnclosure, createSlabEnclosure } from '@/commands/builtin/assets';
import { createRect, ensureBlob } from '@/commands/builtin/create';
import { createLevel, setElementLevelLink } from '@/commands/builtin/levels';
import { createMaterial } from '@/commands/builtin/materials';
import { snapshot } from '@/commands/helpers';
import { RevitExchangeSchema, type RevitExchange } from './exchange';

export interface RevitImportReport {
  created: Record<string, number>;
  skipped: { id: string; kind: string; reason: string }[];
}

type Plan = [number, number];

function bounds(points: readonly Plan[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

/** Where `distance` along a polyline falls: its segment and the distance along that segment. */
function alongPolyline(points: readonly Plan[], distance: number): { segment: number; local: number; length: number } {
  let travelled = 0;
  for (let segment = 0; segment < points.length - 1; segment++) {
    const [ax, ay] = points[segment]!;
    const [bx, by] = points[segment + 1]!;
    const length = Math.hypot(bx - ax, by - ay);
    if (distance <= travelled + length || segment === points.length - 2) return { segment, local: distance - travelled, length };
    travelled += length;
  }
  return { segment: 0, local: distance, length: 0 };
}

function meta(ctx: MutationContext, id: string, patch: Record<string, JsonValue>): void {
  const element = ctx.doc.elements[id];
  if (element) element.meta = { ...snapshot(element.meta ?? {}), ...patch };
}

function rename(ctx: MutationContext, id: string, name: string): void {
  const element = ctx.doc.elements[id];
  if (element && name.trim()) element.name = name.trim().slice(0, 200);
}

export interface RevitImportOptions {
  /** A material already in the document to use for an exchange material (Live Bridge re-syncs). */
  reuseMaterial?: (material: RevitExchange['materials'][number]) => string | undefined;
  /** Recorded on materials this import creates (`Material.source`). */
  materialSource?: (material: RevitExchange['materials'][number]) => string;
  /**
   * Live Bridge (src/bridge/engine.ts): an element already built for this item. A string reuses
   * that element (the item is not rebuilt; hosted openings and level links still find it), null
   * skips the item, undefined builds it.
   */
  existing?: (collection: ExchangeCollection, id: string) => string | null | undefined;
  /** Called with the element each item was built into. */
  onCreated?: (collection: ExchangeCollection, id: string, elementId: string) => void;
}

/** The exchange file's element collections (materials aside). */
export type ExchangeCollection = 'levels' | 'walls' | 'openings' | 'slabs' | 'columns' | 'railings' | 'rooms' | 'meshes';

export function importRevitModel(ctx: MutationContext, model: RevitExchange, options: RevitImportOptions = {}): RevitImportReport {
  const report: RevitImportReport = { created: {}, skipped: [] };
  const count = (kind: string) => (report.created[kind] = (report.created[kind] ?? 0) + 1);
  const attempt = (kind: string, id: string, build: () => void) => {
    try {
      build();
    } catch (error) {
      report.skipped.push({ id, kind, reason: error instanceof Error ? error.message : String(error) });
    }
  };

  // Materials: one library entry per Revit material.
  const materials = new Map<string, string>();
  for (const material of model.materials) {
    attempt('material', material.id, () => {
      const reused = options.reuseMaterial?.(material);
      if (reused) {
        materials.set(material.id, reused);
        return;
      }
      const category = material.opacity < 0.95 ? 'glass' : material.metalness > 0.5 ? 'metal' : 'other';
      const id = createMaterial.run(ctx, { material: { name: material.name, color: material.color, opacity: material.opacity, roughness: material.roughness, metalness: material.metalness, category, ...(options.materialSource ? { source: options.materialSource(material) } : {}) } });
      materials.set(material.id, id);
      count('material');
    });
  }
  const materialOf = (id: string | undefined) => (id ? materials.get(id) : undefined);
  /** Builds an item unless the bridge already has an element for it; returns that element (or none). */
  const item = (collection: ExchangeCollection, id: string, build: () => string): string | null => {
    const reused = options.existing?.(collection, id);
    if (reused !== undefined) return reused;
    const built = build();
    options.onCreated?.(collection, id, built);
    return built;
  };

  // Levels: a rectangle around the whole model, like a level drawn on the board.
  const plan: Plan[] = [
    ...model.walls.flatMap((wall) => wall.points),
    ...model.slabs.flatMap((slab) => slab.outline),
    ...model.columns.map((column) => [column.x, column.y] as Plan),
    ...model.meshes.flatMap((mesh) => [[mesh.origin[0], mesh.origin[1]] as Plan, [mesh.origin[0] + mesh.size[0], mesh.origin[1] + mesh.size[1]] as Plan]),
  ];
  const extent = plan.length ? bounds(plan) : { minX: 0, minY: 0, maxX: 10_000, maxY: 10_000 };
  const margin = 2000;
  const levels = new Map<string, { id: string; elevation: number }>();
  for (const level of [...model.levels].sort((a, b) => a.elevation - b.elevation)) {
    attempt('level', level.id, () => {
      let built = false;
      const id = item('levels', level.id, () => {
        built = true;
        return createLevel.run(ctx, { x: extent.minX - margin, y: extent.minY - margin, width: extent.maxX - extent.minX + 2 * margin, height: extent.maxY - extent.minY + 2 * margin, elevation: level.elevation, name: level.name, planView: false });
      });
      if (id) levels.set(level.id, { id, elevation: level.elevation });
      if (built) count('level');
    });
  }
  /** Links an element's elevation to its level (offset = absolute - level), or sets it absolutely. */
  const place = (id: string, level: string | undefined, absolute: number) => {
    const target = level ? levels.get(level) : undefined;
    if (target) setElementLevelLink.run(ctx, { id, levelId: target.id, offset: absolute - target.elevation });
    else meta(ctx, id, { instanceElevation: absolute });
  };

  // Walls (and curtain walls).
  const walls = new Map<string, { id: string; points: Plan[]; base: number; thickness: number }>();
  for (const wall of model.walls) {
    attempt('wall', wall.id, () => {
      const thickness = wall.layers.reduce((sum, layer) => sum + layer.thickness, 0);
      const layers = wall.layers.map((layer) => ({ name: layer.name, role: layer.role, thickness: layer.thickness, ...(materialOf(layer.material) ? { material: materialOf(layer.material)! } : {}) }));
      let built = false;
      const id = item('walls', wall.id, () => {
        built = true;
        const id = wall.curtain
          ? createArchElement.run(ctx, { tool: 'curtain-wall', points: wall.points, rotation: 0, parentId: null, meta: { arch: { parameters: { panelSpacing: wall.height } } } })
          : createArchElement.run(ctx, { tool: 'wall', points: wall.points, rotation: 0, parentId: null, meta: { arch: { parameters: { layers, height: wall.height, elevation: 0, locationLine: 'centre' } } } });
        rename(ctx, id, wall.name);
        place(id, wall.level, wall.base);
        return id;
      });
      if (id) walls.set(wall.id, { id, points: wall.points, base: wall.base, thickness });
      if (built) count(wall.curtain ? 'curtain wall' : 'wall');
    });
  }

  // Doors and windows, hosted on their wall at their place along it.
  for (const opening of model.openings) {
    attempt(opening.kind, opening.id, () => {
      const wall = walls.get(opening.wall);
      if (!wall) throw new Error('Its host wall was not imported');
      const width = Math.abs(opening.end - opening.start);
      if (width < 50) throw new Error('Too narrow');
      const { segment, local } = alongPolyline(wall.points, Math.min(opening.start, opening.end));
      const [ax, ay] = wall.points[segment]!;
      const [bx, by] = wall.points[segment + 1]!;
      const length = Math.hypot(bx - ax, by - ay) || 1;
      const unit = { x: (bx - ax) / length, y: (by - ay) / length };
      const rotation = (Math.atan2(unit.y, unit.x) * 180) / Math.PI;
      const normal = { x: -unit.y, y: unit.x };
      const start = { x: ax + unit.x * local, y: ay + unit.y * local };
      const above = opening.bottom - wall.base;
      let parameters: Record<string, JsonValue>;
      let mount: number;
      if (opening.kind === 'door') {
        parameters = { width, height: opening.height, threshold: Math.max(0, above), handing: opening.handing, openingSide: opening.side };
        mount = doorMountOffset(parseSystemParameters('door', parameters), doorTemplate(parseSystemParameters('door', parameters)));
      } else {
        parameters = { width, height: opening.height, sill: Math.max(0, above) };
        mount = windowMountOffset(wall.thickness);
      }
      if (options.existing?.('openings', opening.id) !== undefined) return;
      const id = createArchElement.run(ctx, {
        tool: opening.kind,
        x: start.x - normal.x * mount,
        y: start.y - normal.y * mount,
        rotation,
        parentId: null,
        meta: { arch: { type: opening.kind, parameters, opening: { wallId: wall.id, segment, start: local, end: local + width } } },
      });
      if (opening.name) rename(ctx, id, opening.name);
      options.onCreated?.('openings', opening.id, id);
      count(opening.kind);
    });
  }

  // Floors and ceilings, with their openings.
  for (const slab of model.slabs) {
    attempt(slab.kind, slab.id, () => {
      if (options.existing?.('slabs', slab.id) !== undefined) return;
      const id = createSlabEnclosure.run(ctx, { points: slab.outline, type: slab.kind, ...(slab.name ? { name: slab.name } : {}) });
      const element = ctx.doc.elements[id]!;
      const arch = snapshot((element.meta?.['arch'] as Record<string, JsonValue> | undefined) ?? {});
      const parameters = { ...((arch['parameters'] as Record<string, JsonValue> | undefined) ?? {}), thickness: slab.thickness, elevation: 0 };
      // Openings are stored in the slab's own frame; its line has no transform, so world = local.
      const openings = slab.holes.map((points) => ({ points }));
      meta(ctx, id, { arch: { ...arch, parameters, ...(openings.length ? { openings: openings as unknown as JsonValue } : {}) }, solid: { height: slab.thickness, elevation: 0 } });
      place(id, slab.level, slab.bottom);
      const material = materialOf(slab.material);
      if (material) meta(ctx, id, { materials: { body: material } });
      options.onCreated?.('slabs', slab.id, id);
      count(slab.kind);
    });
  }

  for (const column of model.columns) {
    attempt('column', column.id, () => {
      if (options.existing?.('columns', column.id) !== undefined) return;
      const parameters: Record<string, JsonValue> = column.round
        ? { shape: 'circle', diameter: column.width, width: column.width, depth: column.width, height: column.height, elevation: 0 }
        : { shape: 'rectangle', width: column.width, depth: column.depth, height: column.height, elevation: 0 };
      const id = createArchElement.run(ctx, { tool: 'column', x: column.x, y: column.y, rotation: column.rotation, parentId: null, meta: { arch: { parameters } } });
      rename(ctx, id, column.name);
      place(id, column.level, column.base);
      const material = materialOf(column.material);
      if (material) meta(ctx, id, { materials: { body: material } });
      options.onCreated?.('columns', column.id, id);
      count('column');
    });
  }

  for (const railing of model.railings) {
    attempt('railing', railing.id, () => {
      if (options.existing?.('railings', railing.id) !== undefined) return;
      const id = createArchElement.run(ctx, { tool: 'railing', points: railing.points, rotation: 0, parentId: null, meta: { arch: { parameters: { height: railing.height, elevation: 0 } } } });
      rename(ctx, id, railing.name);
      place(id, railing.level, railing.base);
      options.onCreated?.('railings', railing.id, id);
      count('railing');
    });
  }

  for (const room of model.rooms) {
    attempt('room', room.id, () => {
      if (options.existing?.('rooms', room.id) !== undefined) return;
      const name = [room.number, room.name].filter(Boolean).join(' ') || 'Room';
      const id = createRoomEnclosure.run(ctx, { points: room.outline, name });
      const level = room.level ? levels.get(room.level) : undefined;
      if (level) setElementLevelLink.run(ctx, { id, levelId: level.id, offset: 0 });
      options.onCreated?.('rooms', room.id, id);
      count('room');
    });
  }

  // Everything else: one mesh element per Revit element, its plan box on the board.
  for (const mesh of model.meshes) {
    attempt('mesh', mesh.id, () => {
      if (options.existing?.('meshes', mesh.id) !== undefined) return;
      const blobId = ensureBlob(ctx.doc, { mime: 'model/gltf-binary', data: mesh.glb, width: 0, height: 0 });
      const id = createRect.run(ctx, {
        x: mesh.origin[0],
        y: mesh.origin[1],
        width: Math.max(1, mesh.size[0]),
        height: Math.max(1, mesh.size[1]),
        radius: 0,
        rotation: 0,
        style: { fill: null, stroke: '#9aa0aa', strokeWidth: 8, opacity: 1 },
        name: mesh.name || mesh.category || 'Revit element',
        meta: { mesh: { blobId, category: mesh.category, height: mesh.size[2] } },
        parentId: null,
        select: false,
      });
      place(id, mesh.level, mesh.origin[2]);
      options.onCreated?.('meshes', mesh.id, id);
      count(mesh.category ? mesh.category.toLowerCase() : 'mesh');
    });
  }
  ctx.ui.selection = [];
  return report;
}

export const importRevitExchange = defineMutation({
  id: 'import-revit-model',
  label: 'Import Revit model',
  description: 'Builds a Revit exchange file (written by the ArchAI Revit add-in, Send to ArchAI) into the current document as native ArchAI elements. Returns a report of what was created and skipped.',
  group: 'document',
  palette: false,
  history: 'record',
  input: z.object({ model: z.unknown() }),
  run: (ctx, input) => {
    const parsed = RevitExchangeSchema.safeParse(input.model);
    if (!parsed.success) throw new CommandError('invalid-input', 'Not a valid Revit export', parsed.error.issues.slice(0, 10).map((issue) => `${issue.path.join('.')}: ${issue.message}`));
    return importRevitModel(ctx, parsed.data);
  },
});

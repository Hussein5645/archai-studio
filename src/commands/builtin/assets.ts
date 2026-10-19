import { z } from 'zod';
import { naturalSize, parseRecipe, recipeJson, type ParametricRecipe } from '@/catalog/parametric';
import { archOf, systemTypeOf } from '@/assets/arch-meta';
import { ARCH_TOOLS, facadeElement, getArchTool } from '@/assets/arch-tools';
import { instanceParameterKeys, isSystemAssetType, mandatoryInstanceParameterKeys, resolveSystemParameters } from '@/assets/system-assets';
import { centreLineFromLocationLine, columnRect, defaultStairFlights, doorMountOffset, railingStyle, windowMountOffset } from '@/assets/system-geometry';
import { SYSTEM_TYPES, parseSystemParameters, wallThickness } from '@/catalog';
import { CurvePathSchema, IdSchema, JsonValueSchema, type Element, type ElementTable, type GroupElement, type InstanceElement, type JsonValue, type TemplateDefinition } from '@/document';
import { applyToPoint, distance, invert, worldMatrix, enclosureArea, localBounds, localMatrix, polygonCentroid, rotate, sampleCurvePath, transformRect, unionRects } from '@/geometry';
import { bytesToBase64 } from '@/persistence/base64';
import { megabytes, withProgress } from '@/progress';
import { storedLibraryUrl } from '@/cloud/library';
import type { ToolId } from '@/store';
import { joinWallBody, joinWallEnd, WALL_JOIN_TOLERANCE, withWallJoint } from './wallJoints';
import { CommandError, defineEffect, defineMutation } from '../contract';
import { enterProfileModeForTool } from '../profileMode';
import { bottomIndex, cloneSubtrees, removeSubtree, requireTargets, scaleElementLocal, setSelection, snapshot } from '../helpers';
import { createAssetInstance, createImage, createImageDefinition, createLine, createRect, createText, definitionName, ensureBlob } from './create';
import { showAssets } from './shell';
import { createStair, doorDefinition, ensureTemplateDefinition, hostDepth, placementParameters, rebuildSystemElement, systemCommands, windowDefinition } from './system';

const Meta = z.record(z.string(), JsonValueSchema);

export const createAssetDefinition = defineMutation({
  id: 'create-asset-definition',
  label: 'Make asset from selection',
  description: 'Turns the selection into a reusable asset and replaces it with an instance.',
  aliases: ['create component', 'make reusable', 'save as asset'],
  group: 'create',
  shortcuts: ['Mod+Alt+K'],
  history: 'record',
  input: z
    .object({
      ids: z.array(IdSchema).optional(),
      name: z.string().max(200).optional(),
      category: z.string().max(200).optional(),
      /** Replace the originals with one instance (default) or leave them in place. */
      replace: z.boolean().default(true),
    })
    .prefault({}),
  when: (ctx) => ctx.hasSelection,
  run: (ctx, input) => {
    const targets = requireTargets(ctx, input.ids, { unlocked: true, what: 'elements to turn into an asset' });
    const parentId = targets[0]!.parentId;
    if (targets.some((t) => t.parentId !== parentId)) {
      throw new CommandError('rejected', 'Elements must share the same parent to become one asset');
    }
    const elements = ctx.doc.elements as ElementTable;
    const bounds = unionRects(targets.map((t) => transformRect(localMatrix(t), localBounds(elements, t)))) ?? {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    };
    const clones = cloneSubtrees(elements, targets.map((t) => t.id), ctx.ids, {
      parentId: null,
      offset: { x: -bounds.x, y: -bounds.y },
    });
    const definitionId = ctx.ids.next('def');
    const definition: TemplateDefinition = {
      id: definitionId,
      kind: 'template',
      name: definitionName(ctx.doc, input.name ?? targets[0]!.name ?? 'Asset'),
      width: bounds.width,
      height: bounds.height,
      origin: 'user',
      elements: Object.fromEntries(clones.all.map((e) => [e.id, e])),
      ...(input.category ? { category: input.category } : {}),
    };
    ctx.doc.definitions[definitionId] = definition;

    let instanceId: string | null = null;
    if (input.replace) {
      const frontIndex = targets.map((t) => t.index).sort().at(-1)!;
      for (const target of targets) removeSubtree(ctx.doc, target.id);
      const instance: InstanceElement = {
        id: ctx.ids.next('el'),
        kind: 'instance',
        parentId,
        index: frontIndex,
        x: bounds.x,
        y: bounds.y,
        rotation: 0,
        visible: true,
        locked: false,
        definitionId,
        width: bounds.width,
        height: bounds.height,
        name: definition.name,
      };
      ctx.doc.elements[instance.id] = instance;
      instanceId = instance.id;
      setSelection(ctx, [instance.id]);
    }
    return { definitionId, instanceId };
  },
});

export const detachInstance = defineMutation({
  id: 'detach-instance',
  label: 'Detach from asset',
  description: 'Replaces an instance with editable copies of its asset content.',
  aliases: ['ungroup instance', 'break link'],
  group: 'arrange',
  history: 'record',
  input: z.object({ ids: z.array(IdSchema).optional() }).prefault({}),
  when: (ctx) => ctx.selection.some((id) => ctx.doc.elements[id]?.kind === 'instance'),
  run: (ctx, input) => {
    const targets = requireTargets(ctx, input.ids, { unlocked: true }).filter((t) => t.kind === 'instance');
    if (targets.length === 0) throw new CommandError('rejected', 'Select an asset instance to detach');
    const produced: string[] = [];
    for (const instance of targets) {
      const definition = ctx.doc.definitions[instance.definitionId];
      if (!definition) continue;
      const sx = definition.width > 0 ? instance.width / definition.width : 1;
      const sy = definition.height > 0 ? instance.height / definition.height : 1;
      if (definition.kind === 'image') {
        ctx.doc.elements[instance.id] = {
          id: instance.id,
          kind: 'image',
          parentId: instance.parentId,
          index: instance.index,
          x: instance.x,
          y: instance.y,
          rotation: instance.rotation,
          visible: instance.visible,
          locked: false,
          width: instance.width,
          height: instance.height,
          blobId: definition.blobId,
          opacity: 1,
          ...(instance.name ? { name: instance.name } : {}),
          ...(instance.meta ? { meta: snapshot(instance.meta) } : {}),
        };
        produced.push(instance.id);
        continue;
      }
      const group: GroupElement = {
        id: instance.id,
        kind: 'group',
        parentId: instance.parentId,
        index: instance.index,
        x: instance.x,
        y: instance.y,
        rotation: instance.rotation,
        visible: instance.visible,
        locked: false,
        name: instance.name ?? definition.name,
        ...(instance.meta ? { meta: snapshot(instance.meta) } : {}),
      };
      const roots = Object.values(definition.elements)
        .filter((e) => e.parentId === null)
        .map((e) => e.id);
      const clones = cloneSubtrees(definition.elements, roots, ctx.ids, { parentId: group.id });
      ctx.doc.elements[group.id] = group;
      for (const clone of clones.all) ctx.doc.elements[clone.id] = clone;
      for (const root of clones.roots) {
        const draft = ctx.doc.elements[root.id]!;
        draft.x *= sx;
        draft.y *= sy;
        scaleElementLocal(ctx.doc, draft, sx, sy, ctx.measurer);
      }
      produced.push(group.id);
    }
    setSelection(ctx, produced);
    return produced;
  },
});

export const createArchElement = defineMutation({
  id: 'create-arch-element',
  label: 'Create architecture element',
  description: `Creates a built-in architecture element. Tools: ${ARCH_TOOLS.map((t) => t.id).join(', ')}.`,
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({
    tool: z.string(),
    /** Placement for 'place' tools (top-left of the template). */
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    rotation: z.number().finite().default(0),
    /** World-space points for polyline tools. */
    points: z.array(z.tuple([z.number().finite(), z.number().finite()])).optional(),
    parentId: IdSchema.nullable().default(null),
    meta: Meta.optional(),
  }),
  run: (ctx, input) => {
    const tool = getArchTool(input.tool);
    if (!tool) throw new CommandError('invalid-input', `Unknown architecture tool "${input.tool}"`);
    const baseArch = tool.meta['arch'];
    const inputArch = input.meta?.['arch'];
    const inputArchObject = inputArch && typeof inputArch === 'object' && !Array.isArray(inputArch) ? inputArch : {};
    const parameters = tool.systemType ? placementParameters(ctx, tool.systemType, inputArchObject['parameters']) : null;
    const chosen = tool.systemType ? ctx.ui.systemAssets[tool.systemType] : undefined;
    const meta: Record<string, JsonValue> = {
      ...tool.meta,
      ...input.meta,
      ...(baseArch && typeof baseArch === 'object' && !Array.isArray(baseArch)
        ? {
            arch: {
              ...baseArch,
              ...(parameters ? { parameters: parameters as unknown as JsonValue } : {}),
              ...(chosen ? { systemAssetId: chosen.id, systemAssetName: chosen.name } : {}),
              ...inputArchObject,
            },
          }
        : {}),
    };
    const arch = meta['arch'] as Record<string, JsonValue>;
    if (tool.systemType) arch['instanceEditable'] = [...new Set([...(chosen?.instanceEditable ?? []), ...mandatoryInstanceParameterKeys(tool.systemType)])];

    if (tool.mode.kind === 'polyline') {
      if (!input.points || input.points.length < 2) throw new CommandError('invalid-input', `${tool.label} needs at least two points`);
      let style = tool.mode.style;
      let points = input.points;
      if (tool.systemType === 'railing' && parameters) style = railingStyle(parseSystemParameters('railing', parameters).thickness);
      if (tool.systemType === 'wall' && parameters) {
        const wall = parseSystemParameters('wall', parameters);
        const thickness = wallThickness(wall.layers);
        style = { ...style, strokeWidth: thickness };
        arch['thickness'] = thickness;
        points = centreLineFromLocationLine(points, wall.locationLine, thickness);
      }
      return createLine.run(ctx, {
        points,
        closed: tool.mode.closed ?? false,
        style,
        rotation: 0,
        name: tool.label,
        meta,
        parentId: input.parentId,
        select: true,
      });
    }
    if (tool.mode.kind === 'enclosure') {
      throw new CommandError('invalid-input', 'Rooms must be created from a detected enclosure');
    }
    if (tool.mode.kind === 'level') {
      throw new CommandError('invalid-input', 'Levels are created by dragging their rectangular extent');
    }
    if (input.x === undefined || input.y === undefined) {
      throw new CommandError('invalid-input', `${tool.label} needs a position`);
    }

    if (tool.mode.kind === 'rect') {
      // Columns: a rect centred on the click, sized by its parameters.
      const spec = columnRect(parseSystemParameters('column', parameters));
      const id = createRect.run(ctx, {
        x: input.x - spec.width / 2,
        y: input.y - spec.height / 2,
        width: spec.width,
        height: spec.height,
        radius: spec.radius,
        rotation: input.rotation,
        style: spec.style,
        name: tool.label,
        meta,
        parentId: input.parentId,
        select: true,
      });
      return id;
    }

    if (tool.mode.kind === 'stair') {
      const stair = parseSystemParameters('stair', parameters);
      return createStair.run(ctx, {
        flights: defaultStairFlights(stair, input.x, input.y, input.rotation + 90),
        parameters: parameters as Record<string, JsonValue>,
        parentId: input.parentId,
        meta,
      });
    }

    // Doors and windows: a template definition per parameter set (identical doors share one).
    let definition: TemplateDefinition;
    if (tool.systemType === 'door') {
      const door = parseSystemParameters('door', parameters);
      const built = doorDefinition(ctx, door);
      definition = built.definition;
      arch['width'] = built.template.width;
      arch['wallMountOffset'] = doorMountOffset(door, built.template);
    } else if (tool.systemType === 'window') {
      const window = parseSystemParameters('window', parameters);
      const depth = hostDepth(ctx, { meta } as never);
      const built = windowDefinition(ctx, window, depth);
      definition = built.definition;
      arch['width'] = built.template.width;
      arch['wallMountOffset'] = windowMountOffset(depth);
    } else if (tool.systemType === 'facade-element') {
      const facade = parseSystemParameters('facade-element', parameters);
      const template = facadeElement(facade.width, facade.depth);
      definition = ensureTemplateDefinition(ctx, `arch:${tool.id}:${facade.width}x${facade.depth}`, tool.label, tool.categories[0]!, template, tool.meta);
    } else {
      const template = tool.mode.template();
      definition = ensureTemplateDefinition(ctx, `arch:${tool.id}`, tool.label, tool.categories[0]!, template, tool.meta);
    }
    return createAssetInstance.run(ctx, {
      definitionId: definition.id,
      x: input.x,
      y: input.y,
      rotation: input.rotation,
      name: tool.label,
      meta,
      parentId: input.parentId,
      select: true,
    });
  },
});

const WorldPoint = z.tuple([z.number().finite(), z.number().finite()]);

/** Creates one wall-like element per segment so corners and endpoint joints remain explicit. */
export const createWallSegments = defineMutation({
  id: 'create-wall-segments',
  label: 'Create wall segments',
  description: 'Creates endpoint-snapped wall segments with explicit join metadata.',
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({
    /** The traced location line (centre, inside or outside face, per the wall parameters). */
    points: z.array(WorldPoint).min(2),
    type: z.enum(['wall', 'curtain-wall']).default('wall'),
    parameters: Meta.optional(),
    parentId: IdSchema.nullable().default(null),
  }),
  run: (ctx, input) => {
    const curtainWall = input.type === 'curtain-wall';
    const parameters = placementParameters(ctx, input.type, input.parameters);
    const wall = curtainWall ? null : parseSystemParameters('wall', parameters);
    const thickness = wall ? wallThickness(wall.layers) : 100;
    const chosen = ctx.ui.systemAssets[input.type];
    const points = wall ? centreLineFromLocationLine(input.points, wall.locationLine, thickness) : input.points;
    const name = curtainWall ? 'Curtain wall' : 'Wall';
    const created: string[] = [];
    for (let index = 0; index < points.length - 1; index++) {
      const a = points[index]!;
      const b = points[index + 1]!;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.5) continue;
      const id = createLine.run(ctx, {
        points: [a, b],
        closed: false,
        rotation: 0,
        style: { fill: null, stroke: curtainWall ? '#587099' : '#3a3a3f', strokeWidth: thickness, opacity: 1 },
        name,
        parentId: input.parentId,
        select: false,
        meta: {
          arch: {
            type: input.type,
            thickness,
            parameters: parameters as unknown as JsonValue,
            instanceEditable: [...new Set([...(chosen?.instanceEditable ?? []), ...mandatoryInstanceParameterKeys(input.type)])],
            ...(chosen ? { systemAssetId: chosen.id, systemAssetName: chosen.name } : {}),
            joints: { start: { enabled: false, with: [] }, end: { enabled: false, with: [] } },
          },
        },
      });
      created.push(id);
    }
    if (created.length === 0) throw new CommandError('invalid-input', `${name} needs at least one non-zero segment`);

    for (let index = 0; index < created.length - 1; index++) {
      const current = ctx.doc.elements[created[index]!]!;
      const next = ctx.doc.elements[created[index + 1]!]!;
      current.meta = withWallJoint(current.meta, 'end', [next.id]);
      next.meta = withWallJoint(next.meta, 'start', [current.id]);
    }

    // Auto-join: a run that nearly closes on itself closes; ends near existing walls meet them.
    const first = ctx.doc.elements[created[0]!]!;
    const last = ctx.doc.elements[created.at(-1)!]!;
    const firstPoint = { x: points[0]![0], y: points[0]![1] };
    const lastTuple = points.at(-1)!;
    const lastPoint = { x: lastTuple[0], y: lastTuple[1] };
    if (created.length > 1 && distance(firstPoint, lastPoint) <= WALL_JOIN_TOLERANCE && last.kind === 'line') {
      const local = applyToPoint(invert(worldMatrix(ctx.doc.elements as ElementTable, last as unknown as Element)), firstPoint);
      last.points[last.points.length - 1] = [local.x, local.y];
      first.meta = withWallJoint(first.meta, 'start', [last.id]);
      last.meta = withWallJoint(last.meta, 'end', [first.id]);
    }
    joinWallEnd(ctx, created[0]!, 'start');
    joinWallEnd(ctx, created.at(-1)!, 'end');
    for (const id of created) joinWallBody(ctx, id);
    setSelection(ctx, created);
    return created;
  },
});

export const createRoomEnclosure = defineMutation({
  id: 'create-room-enclosure',
  label: 'Create room',
  description: 'Creates a room face and area label from a closed wall or divider boundary.',
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({ points: z.array(WorldPoint).min(3), name: z.string().trim().min(1).max(120).default('Room'), seed: WorldPoint.optional() }),
  run: (ctx, input) => {
    const points = input.points.map(([x, y]) => ({ x, y }));
    const area = enclosureArea(points);
    if (area < 1) throw new CommandError('invalid-input', 'Room boundary has no area');
    const centre = polygonCentroid(points);
    const roomId = createLine.run(ctx, {
      points: input.points,
      closed: true,
      rotation: 0,
      parentId: null,
      style: { fill: '#eef3fb', stroke: '#8aa4cb', strokeWidth: 12, opacity: 0.55 },
      name: input.name,
      select: false,
      meta: { arch: { type: 'room', area, seed: input.seed ?? [centre.x, centre.y] } },
    });
    ctx.doc.elements[roomId]!.index = bottomIndex(ctx.doc.elements as ElementTable, null);
    const labelWidth = Math.max(1200, Math.min(2600, Math.sqrt(area) * 0.7));
    createText.run(ctx, {
      x: centre.x - labelWidth / 2,
      y: centre.y - 190,
      width: labelWidth,
      text: `${input.name}\n${(area / 1_000_000).toFixed(2)} m²`,
      fontSize: 180,
      align: 'center',
      color: '#3a3a3f',
      name: `${input.name} label`,
      select: false,
      rotation: 0,
      parentId: null,
      meta: { arch: { type: 'room-label', roomId } },
    });
    setSelection(ctx, [roomId]);
    return roomId;
  },
});

export const setWallMountedTransform = defineMutation({
  id: 'set-wall-mounted-transform',
  label: 'Move wall-mounted element',
  description: 'Moves a door or window and updates the opening associated with its wall.',
  group: 'transform',
  palette: false,
  history: 'record',
  input: z.object({
    id: IdSchema,
    x: z.number().finite(),
    y: z.number().finite(),
    rotation: z.number().finite(),
    opening: z
      .object({
        wallId: IdSchema,
        segment: z.number().int().nonnegative(),
        start: z.number().finite().nonnegative(),
        end: z.number().finite().positive(),
        curveAlong: z.number().finite().nonnegative().optional(),
      })
      .nullable(),
  }),
  run: (ctx, input) => {
    const [element] = requireTargets(ctx, [input.id], { unlocked: true });
    const meta = snapshot(element!.meta ?? {});
    const currentArch = meta['arch'];
    if (!currentArch || typeof currentArch !== 'object' || Array.isArray(currentArch)) {
      throw new CommandError('rejected', 'The element is not wall-mounted');
    }
    const arch = { ...currentArch };
    if (input.opening) arch['opening'] = input.opening;
    else delete arch['opening'];
    element!.x = input.x;
    element!.y = input.y;
    element!.rotation = input.rotation;
    element!.meta = { ...meta, arch };
    return element!.id;
  },
});

export const archToolCommands = ARCH_TOOLS.map((tool) =>
  defineMutation({
    id: `tool-arch-${tool.id}`,
    label: `${tool.label} tool`,
    description: tool.description,
    aliases: ['architecture', 'build', ...tool.categories.map((c) => c.toLowerCase())],
    group: 'create',
    shortcuts: tool.shortcut ? [tool.shortcut] : undefined,
    history: 'none',
    input: z.void(),
    run: (ctx) => {
      ctx.ui.tool = `arch:${tool.id}` as ToolId;
      ctx.ui.editingTextId = null;
      enterProfileModeForTool(ctx, ctx.ui.tool);
    },
  }),
);

export const CatalogAssetInput = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  kind: z.enum(['asset', 'system']).default('asset'),
  systemType: z.enum(SYSTEM_TYPES).optional(),
  systemParameters: z.record(z.string(), JsonValueSchema).optional(),
  instanceEditable: z.array(z.string()).optional(),
  image: z.object({ url: z.string(), path: z.string().optional(), mime: z.string().optional() }),
  views: z
    .object({
      top: z.object({ url: z.string(), path: z.string(), mime: z.string() }).optional(),
      front: z.object({ url: z.string(), path: z.string(), mime: z.string() }).optional(),
      side: z.object({ url: z.string(), path: z.string(), mime: z.string() }).optional(),
      section: z.object({ url: z.string(), path: z.string(), mime: z.string() }).optional(),
    })
    .optional(),
  model: z
    .object({ path: z.string(), format: z.enum(['glb', 'fbx']), url: z.string().optional() })
    .optional(),
  models: z
    .object({
      glb: z.object({ path: z.string(), format: z.literal('glb'), url: z.string().optional() }).optional(),
      fbx: z.object({ path: z.string(), format: z.literal('fbx'), url: z.string().optional() }).optional(),
      glbLow: z.object({ path: z.string(), format: z.literal('glb'), url: z.string().optional() }).optional(),
    })
    .optional(),
  package: z.object({ key: z.string(), url: z.string(), version: z.literal(1) }).optional(),
  styleViews: z.record(z.string(), z.object({ top: z.string().optional(), front: z.string().optional(), side: z.string().optional() })).optional(),
  size: z.object({ width: z.number().nonnegative(), height: z.number().nonnegative() }),
  tags: z.array(z.string()).optional(),
  isLocal: z.boolean().optional(),
  /** Parametric recipe (validated by parseRecipe when stored). */
  parametric: z.custom<ParametricRecipe>((value) => parseRecipe(value) !== null).optional(),
});

export const beginCatalogPlacement = defineMutation({
  id: 'begin-catalog-placement',
  label: 'Place asset with preview',
  description: 'Attaches a regular catalog asset to the pointer until the user clicks the board.',
  group: 'create',
  palette: false,
  history: 'none',
  input: z.object({ asset: CatalogAssetInput }),
  run: (ctx, input) => {
    if (input.asset.kind !== 'asset') throw new CommandError('invalid-input', 'System assets are configured from their architecture tool');
    ctx.ui.placingAsset = input.asset;
    ctx.ui.tool = 'catalog';
    ctx.ui.editingTextId = null;
    return input.asset.id;
  },
});

const SystemOpening = z.object({
  wallId: IdSchema,
  segment: z.number().int().nonnegative(),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
  curveAlong: z.number().finite().nonnegative().optional(),
});

/** Creates one true analytic wall. Its source arc/Bézier remains editable; meshing only samples it. */
export const createCurvedWall = defineMutation({
  id: 'create-curved-wall',
  label: 'Create curved wall',
  description: 'Creates a wall or curtain wall from an editable analytic arc or Bézier path.',
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({
    path: CurvePathSchema,
    type: z.enum(['wall', 'curtain-wall']).default('wall'),
    parameters: Meta.optional(),
    parentId: IdSchema.nullable().default(null),
  }),
  run: (ctx, input) => {
    const curtainWall = input.type === 'curtain-wall';
    const parameters = placementParameters(ctx, input.type, input.parameters);
    const wall = curtainWall ? null : parseSystemParameters('wall', parameters);
    const thickness = wall ? wallThickness(wall.layers) : 100;
    const chosen = ctx.ui.systemAssets[input.type];
    const points = sampleCurvePath(input.path, 32);
    const id = createLine.run(ctx, {
      points,
      path: input.path,
      closed: false,
      rotation: 0,
      style: { fill: null, stroke: curtainWall ? '#587099' : '#3a3a3f', strokeWidth: thickness, opacity: 1 },
      name: curtainWall ? 'Curtain wall' : 'Wall',
      parentId: input.parentId,
      select: true,
      meta: {
        arch: {
          type: input.type,
          thickness,
          parameters: parameters as unknown as JsonValue,
          instanceEditable: [...new Set([...(chosen?.instanceEditable ?? []), ...mandatoryInstanceParameterKeys(input.type)])],
          ...(chosen ? { systemAssetId: chosen.id, systemAssetName: chosen.name } : {}),
          joints: { start: { enabled: false, with: [] }, end: { enabled: false, with: [] } },
        },
      },
    });
    joinWallEnd(ctx, id, 'start');
    joinWallEnd(ctx, id, 'end');
    joinWallBody(ctx, id);
    return id;
  },
});

export const setSystemConfiguration = defineMutation({
  id: 'set-system-configuration',
  label: 'Set system configuration',
  description: 'Changes the selected architectural element between its default and a catalog system configuration.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({
    id: IdSchema,
    assetId: z.string().nullable(),
    assetName: z.string().optional(),
    definitionId: IdSchema.optional(),
    parameters: Meta,
    instanceEditable: z.array(z.string()).default([]),
    applyTo: z.enum(['type', 'instance']).default('type'),
    opening: SystemOpening.optional(),
  }),
  run: (ctx, input) => {
    const [element] = requireTargets(ctx, [input.id], { unlocked: true });
    const meta = snapshot(element!.meta ?? {});
    const value = meta['arch'];
    if (!value || typeof value !== 'object' || Array.isArray(value) || !isSystemAssetType(value['type'])) {
      throw new CommandError('rejected', 'Select a system architecture element');
    }
    const type = value['type'];
    const instanceEditable = instanceParameterKeys(type, input.instanceEditable);
    const sourceAssetId = typeof value['systemAssetId'] === 'string' ? value['systemAssetId'] : null;
    const globalParameters = resolveSystemParameters(type, input.parameters) as Record<string, JsonValue>;
    const targetIds = input.applyTo === 'instance'
      ? [element!.id]
      : Object.values(ctx.doc.elements)
          .filter((candidate) => {
            if (systemTypeOf(candidate as Element) !== type) return false;
            const candidateArch = candidate.meta?.['arch'];
            const candidateAssetId = candidateArch && typeof candidateArch === 'object' && !Array.isArray(candidateArch) && typeof candidateArch['systemAssetId'] === 'string'
              ? candidateArch['systemAssetId']
              : null;
            return candidateAssetId === sourceAssetId;
          })
          .map((candidate) => candidate.id);
    for (const targetId of targetIds) {
      const target = ctx.doc.elements[targetId]!;
      const targetMeta = snapshot(target.meta ?? {});
      const targetValue = targetMeta['arch'];
      if (!targetValue || typeof targetValue !== 'object' || Array.isArray(targetValue)) continue;
      const storedOverrides = targetValue['instanceOverrides'];
      const targetAssetId = typeof targetValue['systemAssetId'] === 'string' ? targetValue['systemAssetId'] : null;
      // Moving an individual element to another preset starts from that preset's remembered
      // values. Editing the preset it already uses keeps explicit board-level overrides.
      const keepOverrides = targetAssetId === input.assetId;
      const overrides = keepOverrides && storedOverrides && typeof storedOverrides === 'object' && !Array.isArray(storedOverrides)
        ? Object.fromEntries(Object.entries(storedOverrides).filter(([key]) => instanceEditable.includes(key)))
        : {};
      // Shared configuration must never overwrite fields owned by each instance,
      // including values that have not yet acquired an explicit override record.
      const existingParameters = resolveSystemParameters(type, targetValue['parameters']);
      for (const key of instanceEditable) {
        if ((input.applyTo === 'type' || mandatoryInstanceParameterKeys(type).includes(key)) && existingParameters[key] !== undefined) overrides[key] = existingParameters[key]!;
      }
      const arch: Record<string, JsonValue> = {
        ...targetValue,
        parameters: resolveSystemParameters(type, { ...globalParameters, ...overrides }) as unknown as JsonValue,
        instanceEditable,
        instanceOverrides: overrides,
      };
      delete arch['graphPreset'];
      if (type === 'wall') {
        const nextParameters = resolveSystemParameters(type, arch['parameters']);
        if (['pathType', 'arcBulge', 'bezierHandles'].some((key) => JSON.stringify(existingParameters[key]) !== JSON.stringify(nextParameters[key]))) arch['pathParametersDirty'] = true;
      }
      if (input.assetId) {
        arch['systemAssetId'] = input.assetId;
        if (input.assetName) arch['systemAssetName'] = input.assetName;
        if (target.kind === 'instance' && input.definitionId) {
          if (typeof arch['defaultDefinitionId'] !== 'string') arch['defaultDefinitionId'] = target.definitionId;
          target.definitionId = input.definitionId;
        }
      } else {
        delete arch['systemAssetId'];
        delete arch['systemAssetName'];
        if (target.kind === 'instance' && typeof arch['defaultDefinitionId'] === 'string' && ctx.doc.definitions[arch['defaultDefinitionId']]) {
          target.definitionId = arch['defaultDefinitionId'];
        }
      }
      if (input.opening && target.id === element!.id) arch['opening'] = input.opening;
      target.meta = { ...targetMeta, arch };
    }
    for (const targetId of targetIds) rebuildSystemElement(ctx, targetId);
    return targetIds;
  },
});

export const applySystemAsset = defineEffect({
  id: 'apply-system-asset',
  label: 'Apply system asset',
  description: 'Loads and applies a system package to an existing architectural element.',
  group: 'edit',
  palette: false,
  input: z.object({ id: IdSchema, asset: CatalogAssetInput.nullable(), parameters: Meta.optional(), instanceEditable: z.array(z.string()).optional(), applyTo: z.enum(['type', 'instance']).default('type') }),
  run: async (ctx, input) => {
    const state = ctx.getState();
    const target = state.doc.elements[input.id];
    const arch = target?.meta?.['arch'];
    const type = arch && typeof arch === 'object' && !Array.isArray(arch) ? arch['type'] : undefined;
    if (!target || !isSystemAssetType(type)) throw new CommandError('rejected', 'Select a system architecture element');
    if (input.asset && (input.asset.kind !== 'system' || input.asset.systemType !== type)) {
      throw new CommandError('invalid-input', `Expected a ${type} system asset`);
    }
    const parameters = resolveSystemParameters(type, { ...(input.asset?.systemParameters ?? {}), ...(input.parameters ?? {}) });
    const swapsSymbol = Boolean(input.asset && target.kind === 'instance' && input.asset.views?.top && input.asset.size.width > 0 && input.asset.size.height > 0);
    if (!input.asset || !swapsSymbol) {
      const result = ctx.dispatchSync(setSystemConfiguration, { id: input.id, assetId: input.asset?.id ?? null, assetName: input.asset?.name, parameters, instanceEditable: input.instanceEditable ?? input.asset?.instanceEditable ?? [], applyTo: input.applyTo });
      if (!result.ok) throw new CommandError(result.error.code, result.error.message);
      return result.value;
    }
    const image = await ctx.catalog.fetchImage(input.asset);
    return ctx.transaction(`Apply ${input.asset.name}`, () => {
      const definition = ctx.dispatchSync(createImageDefinition, {
        name: input.asset!.name,
        blob: { mime: image.mime, data: bytesToBase64(image.bytes), width: image.width, height: image.height },
        width: input.asset!.size.width,
        height: input.asset!.size.height,
        category: input.asset!.path.split('/').slice(0, -1).join('/'),
        catalog: {
          source: ctx.catalog.source,
          path: input.asset!.path,
          imageUrl: input.asset!.image.url,
          package: input.asset!.package,
          systemType: input.asset!.systemType,
        },
      });
      if (!definition.ok) throw new CommandError(definition.error.code, definition.error.message);
      const updated = ctx.dispatchSync(setSystemConfiguration, {
        id: input.id,
        assetId: input.asset!.id,
        assetName: input.asset!.name,
        definitionId: definition.value,
        parameters,
        instanceEditable: input.instanceEditable ?? input.asset?.instanceEditable ?? [],
        applyTo: input.applyTo,
      });
      if (!updated.ok) throw new CommandError(updated.error.code, updated.error.message);
      return updated.value;
    });
  },
});

export const setUniformAssetScale = defineMutation({
  id: 'set-uniform-asset-scale',
  label: 'Set uniform asset scale',
  description: 'Scales an asset instance uniformly while keeping its centre fixed.',
  group: 'transform',
  palette: false,
  history: 'record',
  input: z.object({ id: IdSchema, percent: z.number().positive() }),
  run: (ctx, input) => {
    const [target] = requireTargets(ctx, [input.id], { unlocked: true });
    if (!target || target.kind !== 'instance') throw new CommandError('rejected', 'Select an asset instance');
    const targetType = archOf(target)?.['type'];
    if (targetType === 'door' || targetType === 'window') {
      throw new CommandError('rejected', 'Doors and windows keep the size defined by their configuration');
    }
    const definition = ctx.doc.definitions[target.definitionId];
    if (!definition) throw new CommandError('rejected', 'The asset definition is missing');
    const natural = naturalSize(definition, target);
    const width = natural.width * (input.percent / 100);
    const height = natural.height * (input.percent / 100);
    const meta = snapshot(target.meta ?? {});
    const archValue = meta['arch'];
    const arch = archValue && typeof archValue === 'object' && !Array.isArray(archValue) ? { ...archValue } : null;
    const oldMount = arch && typeof arch['wallMountOffset'] === 'number' ? arch['wallMountOffset'] : target.height / 2;
    const newMount = target.height > 0 ? (oldMount / target.height) * height : height / 2;
    const oldCentreOffset = rotate({ x: target.width / 2, y: oldMount }, target.rotation);
    const centre = { x: target.x + oldCentreOffset.x, y: target.y + oldCentreOffset.y };
    const newCentreOffset = rotate({ x: width / 2, y: newMount }, target.rotation);
    target.x = centre.x - newCentreOffset.x;
    target.y = centre.y - newCentreOffset.y;
    target.width = width;
    target.height = height;
    if (arch) {
      arch['width'] = width;
      arch['wallMountOffset'] = newMount;
      const openingValue = arch['opening'];
      if (openingValue && typeof openingValue === 'object' && !Array.isArray(openingValue)) {
        const start = openingValue['start'];
        const end = openingValue['end'];
        if (typeof start === 'number' && typeof end === 'number') {
          const middle = (start + end) / 2;
          arch['opening'] = { ...openingValue, start: middle - width / 2, end: middle + width / 2 };
        }
      }
      target.meta = { ...meta, arch };
    }
    return target.id;
  },
});

export const selectSystemAsset = defineMutation({
  id: 'select-system-asset',
  label: 'Choose system type for a tool',
  description: 'Chooses the system type (an R2 or local package) the built-in architecture tool places next.',
  group: 'create',
  palette: false,
  history: 'none',
  input: z.object({
    systemType: z.enum(SYSTEM_TYPES),
    asset: CatalogAssetInput.nullable().default(null),
  }),
  run: (ctx, input) => {
    if (input.asset && (input.asset.kind !== 'system' || input.asset.systemType !== input.systemType)) {
      throw new CommandError('invalid-input', `Expected a ${input.systemType} system asset`);
    }
    if (input.asset) ctx.ui.systemAssets[input.systemType] = input.asset;
    else delete ctx.ui.systemAssets[input.systemType];
    ctx.ui.tool = `arch:${input.systemType}` as ToolId;
    ctx.ui.editingTextId = null;
    enterProfileModeForTool(ctx, ctx.ui.tool);
    return input.asset?.id ?? null;
  },
});

export const placeCatalogAsset = defineEffect({
  id: 'place-catalog-asset',
  label: 'Place catalog asset',
  description: 'Fetches a catalog asset image and places it as an instance (one undo step).',
  group: 'create',
  palette: false,
  input: z.object({
    asset: CatalogAssetInput,
    x: z.number().finite(),
    y: z.number().finite(),
    rotation: z.number().finite().default(0),
    /** Place the asset centred on (x, y) rather than by its top-left corner. */
    centered: z.boolean().default(false),
    /** Extra semantics for system placements such as `{ arch: { type: 'door' } }`. */
    instanceMeta: Meta.optional(),
  }),
  run: async (ctx, input) => {
    const { asset } = input;
    const projectId = ctx.getState().doc.id;
    const existing = Object.values(ctx.getState().doc.definitions).find(
      (d) => d.kind === 'image' && d.catalog?.path === asset.path && d.catalog?.source === ctx.catalog.source,
    );
    let blob: { mime: string; data: string; width: number; height: number } | undefined;
    if (!existing) {
      const image = await ctx.catalog.fetchImage(asset);
      blob = { mime: image.mime, data: bytesToBase64(image.bytes), width: image.width, height: image.height };
    }
    const x = input.centered ? input.x - asset.size.width / 2 : input.x;
    const y = input.centered ? input.y - asset.size.height / 2 : input.y;
    if (ctx.getState().doc.id !== projectId) throw new CommandError('rejected', 'The project changed while loading the asset.');
    return ctx.transaction(`Place ${asset.name}`, () => {
      const definitionResult = ctx.dispatchSync(createImageDefinition, {
        name: asset.name,
        blob,
        width: asset.size.width,
        height: asset.size.height,
        category: asset.path.split('/').slice(0, -1).join('/') || undefined,
        tags: asset.tags,
        catalog: {
          source: ctx.catalog.source,
          path: asset.path,
          imageUrl: storedLibraryUrl(asset.image.url),
          modelUrl: storedLibraryUrl(asset.model?.url),
          package: asset.package ? { ...asset.package, url: storedLibraryUrl(asset.package.url) } : undefined,
          topViewPath: asset.image.path,
          modelPaths: asset.models ? { glb: asset.models.glb?.path, fbx: asset.models.fbx?.path, glbLow: asset.models.glbLow?.path } : undefined,
          styleViews: asset.styleViews,
          systemType: asset.systemType,
        },
        meta: asset.systemType || asset.parametric ? { ...(asset.systemType ? { system: { type: asset.systemType } } : {}), ...(asset.parametric ? { parametric: recipeJson(asset.parametric) } : {}) } : undefined,
      });
      if (!definitionResult.ok) throw new CommandError(definitionResult.error.code, definitionResult.error.message);
      const instanceResult = ctx.dispatchSync(createAssetInstance, {
        definitionId: definitionResult.value,
        x,
        y,
        rotation: input.rotation,
        meta: {
          catalog: {
            path: asset.path,
            package: asset.package?.key ?? null,
            model: asset.model?.path ?? asset.model?.url ?? null,
          },
          ...input.instanceMeta,
        },
      });
      if (!instanceResult.ok) throw new CommandError(instanceResult.error.code, instanceResult.error.message);
      return { definitionId: definitionResult.value, instanceId: instanceResult.value };
    });
  },
});

export const createSlabEnclosure = defineMutation({
  id: 'create-slab-enclosure',
  label: 'Create floor or ceiling',
  description: 'Creates a floor or ceiling slab from a closed wall or divider boundary.',
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({
    points: z.array(WorldPoint).min(3),
    type: z.enum(['floor', 'ceiling']),
    name: z.string().trim().min(1).max(120).optional(),
  }),
  run: (ctx, input) => {
    const points = input.points.map(([x, y]) => ({ x, y }));
    const area = enclosureArea(points);
    if (area < 1) throw new CommandError('invalid-input', 'Slab boundary has no area');
    const floor = input.type === 'floor';
    const parameters = placementParameters(ctx, input.type);
    const chosen = ctx.ui.systemAssets[input.type];
    const thickness = typeof parameters['thickness'] === 'number' ? parameters['thickness'] : floor ? 200 : 100;
    const elevation = typeof parameters['elevation'] === 'number' ? parameters['elevation'] : floor ? 0 : 2700;
    const id = createLine.run(ctx, {
      points: input.points,
      closed: true,
      rotation: 0,
      parentId: null,
      style: floor
        ? { fill: '#d9dde3', stroke: '#737983', strokeWidth: 12, opacity: 0.72 }
        : { fill: '#eef0f4', stroke: '#8a9099', strokeWidth: 12, opacity: 0.58 },
      name: input.name ?? (floor ? 'Floor' : 'Ceiling'),
      select: true,
      meta: {
        arch: {
          type: input.type,
          area,
          parameters: parameters as unknown as JsonValue,
          instanceEditable: [...new Set([...(chosen?.instanceEditable ?? []), ...mandatoryInstanceParameterKeys(input.type)])],
          ...(chosen ? { systemAssetId: chosen.id, systemAssetName: chosen.name } : {}),
        },
        solid: { height: thickness, elevation },
      },
    });
    ctx.doc.elements[id]!.index = bottomIndex(ctx.doc.elements as ElementTable, null);
    return id;
  },
});

const replacePlacedCatalogAsset = defineMutation({
  id: 'replace-placed-catalog-asset',
  label: 'Replace placed catalog asset definitions',
  description: 'Internal mutation used when a linked model is packaged again.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({
    asset: CatalogAssetInput,
    source: z.string().optional(),
    previousPackageKey: z.string().optional(),
    blob: z.object({ mime: z.string(), data: z.string(), width: z.number().positive(), height: z.number().positive() }),
  }),
  run: (ctx, input) => {
    const { asset } = input;
    const existing = Object.values(ctx.doc.definitions).filter(
      (definition) => definition.kind === 'image' && (definition.catalog?.path === asset.path || (asset.package?.key && definition.catalog?.package?.key === asset.package.key) || (input.previousPackageKey && definition.catalog?.package?.key === input.previousPackageKey)) && definition.catalog?.source === input.source,
    );
    if (existing.length === 0) return 0;
    const currentIds = new Set(existing.map((definition) => definition.id));
    const blobId = ensureBlob(ctx.doc, input.blob);
    const id = ctx.ids.next('def');
    const previous = existing[0]!;
    ctx.doc.definitions[id] = {
      id,
      kind: 'image',
      name: asset.name,
      width: asset.size.width,
      height: asset.size.height,
      origin: 'catalog',
      blobId,
      ...(previous.category ? { category: previous.category } : {}),
      ...(previous.tags ? { tags: snapshot(previous.tags) } : {}),
      ...(previous.meta || asset.parametric ? { meta: { ...(previous.meta ? snapshot(previous.meta) : {}), ...(asset.parametric ? { parametric: recipeJson(asset.parametric) } : {}) } } : {}),
      catalog: {
        source: input.source,
        path: asset.path,
        imageUrl: storedLibraryUrl(asset.image.url),
        modelUrl: storedLibraryUrl(asset.model?.url),
        package: asset.package ? { ...asset.package, url: storedLibraryUrl(asset.package.url) } : undefined,
        topViewPath: asset.image.path,
        modelPaths: asset.models ? { glb: asset.models.glb?.path, fbx: asset.models.fbx?.path, glbLow: asset.models.glbLow?.path } : undefined,
        styleViews: asset.styleViews,
        systemType: asset.systemType,
      },
    };
    let updated = 0;
    for (const element of Object.values(ctx.doc.elements)) {
      if (element.kind !== 'instance' || !currentIds.has(element.definitionId)) continue;
      element.definitionId = id;
      updated++;
    }
    return updated;
  },
});

/** Replaces a placed local package definition and redirects every one of its instances. */
export const updatePlacedCatalogAsset = defineEffect({
  id: 'update-placed-catalog-asset',
  label: 'Update placed catalog asset',
  description: 'Updates every placed instance of a local .CAI package without adding another instance.',
  group: 'edit',
  palette: false,
  input: z.object({ asset: CatalogAssetInput, previousPackageKey: z.string().optional() }),
  run: async (ctx, input) => {
    const { asset } = input;
    const projectId = ctx.getState().doc.id;
    const existing = Object.values(ctx.getState().doc.definitions).filter(
      (definition) => definition.kind === 'image' && (definition.catalog?.path === asset.path || (asset.package?.key && definition.catalog?.package?.key === asset.package.key) || (input.previousPackageKey && definition.catalog?.package?.key === input.previousPackageKey)) && definition.catalog?.source === ctx.catalog.source,
    );
    if (existing.length === 0) return 0;
    const image = await ctx.catalog.fetchImage(asset);
    if (ctx.getState().doc.id !== projectId) throw new CommandError('rejected', 'The project changed while loading the asset.');
    return ctx.transaction(`Update ${asset.name}`, () => {
      const result = ctx.dispatchSync(replacePlacedCatalogAsset, {
        asset,
        source: ctx.catalog.source,
        previousPackageKey: input.previousPackageKey,
        blob: { mime: image.mime, data: bytesToBase64(image.bytes), width: image.width, height: image.height },
      });
      if (!result.ok) throw new CommandError(result.error.code, result.error.message);
      return result.value;
    });
  },
});

export const importImage = defineEffect({
  id: 'import-image',
  label: 'Import image…',
  description: 'Picks an image file and places it on the board.',
  aliases: ['add picture', 'place image', 'underlay'],
  group: 'create',
  input: z.object({ x: z.number().finite().optional(), y: z.number().finite().optional() }).prefault({}),
  run: async (ctx, input) => {
    const file = await ctx.platform.files.openImage();
    if (!file) return null;
    const size = await imageSize(file.bytes, file.mime);
    const state = ctx.getState();
    const { viewport, canvasSize } = state.ui;
    const x = input.x ?? (canvasSize.width / 2 - viewport.x) / viewport.zoom;
    const y = input.y ?? (canvasSize.height / 2 - viewport.y) / viewport.zoom;
    const result = ctx.dispatchSync(createImage, {
      x,
      y,
      blob: { mime: file.mime, data: bytesToBase64(file.bytes), width: size.width, height: size.height },
      name: file.name,
    });
    if (!result.ok) throw new CommandError(result.error.code, result.error.message, result.error.details);
    return result.value;
  },
});

async function imageSize(bytes: Uint8Array, mime: string): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap !== 'function') return { width: 0, height: 0 };
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { width: 0, height: 0 };
  }
}

function pickCaiFile(): Promise<{ name: string; bytes: Uint8Array } | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.cai,application/zip,application/x-zip-compressed';
    input.style.display = 'none';
    document.body.append(input);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) {
        resolve(null);
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      resolve({ name: file.name, bytes });
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    input.click();
  });
}

/** New .CAI assets are modeled (or assembled from a GLB) in the modeling workspace. */
export const openModeling = defineEffect({
  id: 'open-modeling',
  label: 'Create .CAI asset…',
  description: 'Asks for a name, then opens the modeling workspace in a new window where the asset is modeled and packaged as .CAI.',
  aliases: ['new cai package', 'create cai', 'make cai', 'package asset', 'modeling', 'open-create-cai-dialog'],
  group: 'create',
  shortcuts: ['Mod+Alt+C'],
  input: z.object({ name: z.string().trim().min(1).max(200).optional() }).prefault({}),
  run: async (ctx, input) => {
    if (!input.name) {
      // Without a name the UI shows the name prompt, which dispatches again with one.
      ctx.dispatchSync(promptAssetName, { open: true });
      return null;
    }
    const assetId = `asset-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    ctx.dispatchSync(promptAssetName, { open: false });
    const state = ctx.getState();
    const projectId = state.ui.screen === 'project' ? state.doc.id : undefined;
    ctx.platform.window.openModeling({ assetId, name: input.name, projectId });
    return assetId;
  },
});

export const promptAssetName = defineMutation({
  id: 'prompt-asset-name',
  label: 'Ask for a new asset name',
  palette: false,
  group: 'create',
  history: 'none',
  input: z.object({ open: z.boolean() }),
  run: (ctx, input) => {
    ctx.ui.assetNamePrompt = input.open;
  },
});

export const importCaiPackage = defineEffect({
  id: 'import-cai-package',
  label: 'Import .CAI package…',
  description: 'Uploads and loads a .cai package file into your asset library.',
  aliases: ['upload cai', 'load cai', 'add cai asset', 'import cai'],
  group: 'create',
  input: z.object({ bytes: z.instanceof(Uint8Array).optional(), name: z.string().optional() }).prefault({}),
  run: async (ctx, input) => {
    const fileBytes = input.bytes ?? (await pickCaiFile())?.bytes;
    if (!fileBytes) return null;
    if (!ctx.catalog.addLocalPackage) {
      throw new CommandError('rejected', 'Catalog does not support local packages');
    }
    const add = ctx.catalog.addLocalPackage.bind(ctx.catalog);
    const asset = await withProgress(`Importing ${input.name ?? '.CAI package'}`, async (task) => {
      task.update(`Unpacking ${megabytes(fileBytes.byteLength)}`, null);
      await task.paint();
      return add(fileBytes);
    });
    ctx.dispatchSync(showAssets, undefined);
    return asset;
  },
});

export const assetCommands = [
  importImage,
  createAssetDefinition,
  detachInstance,
  createArchElement,
  createWallSegments,
  createCurvedWall,
  createRoomEnclosure,
  createSlabEnclosure,
  setWallMountedTransform,
  beginCatalogPlacement,
  setSystemConfiguration,
  applySystemAsset,
  ...systemCommands,
  setUniformAssetScale,
  selectSystemAsset,
  ...archToolCommands,
  placeCatalogAsset,
  updatePlacedCatalogAsset,
  openModeling,
  promptAssetName,
  importCaiPackage,
];

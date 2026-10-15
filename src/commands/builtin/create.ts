import { z } from 'zod';
import { newElementGraphics, newElementStyle } from '@/graphics';
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_LINE_STYLE,
  DEFAULT_RECT_STYLE,
  DEFAULT_TEXT_COLOR,
  IdSchema,
  JsonValueSchema,
  CurvePathSchema,
  StyleSchema,
  type ArchaiDocument,
  type BlobRecord,
  type Element,
  type ElementTable,
  type ImageElement,
  type InstanceElement,
  type LineElement,
  type CurvePath,
  type RectElement,
  type TextElement,
} from '@/document';
import { applyToPoint, invert, sampleCurvePath, worldMatrix } from '@/geometry';
import { CommandError, defineMutation, type MutationContext } from '../contract';
import { contentHash, setSelection, textHeight, topIndex, type DocDraft } from '../helpers';

const Meta = z.record(z.string(), JsonValueSchema);
const Point = z.tuple([z.number().finite(), z.number().finite()]);

const CommonCreate = {
  rotation: z.number().finite().default(0),
  name: z.string().max(200).optional(),
  meta: Meta.optional(),
  /** Parent group; null for the board root. */
  parentId: IdSchema.nullable().default(null),
  /** Select the new element afterwards. */
  select: z.boolean().default(true),
};

function base(doc: DocDraft, id: string, parentId: string | null) {
  if (parentId !== null) {
    const parent = doc.elements[parentId];
    if (!parent) throw new CommandError('rejected', `Unknown parent ${parentId}`);
  }
  return { id, parentId, index: topIndex(doc.elements as ElementTable, parentId), visible: true, locked: false };
}

/**
 * Adds a new element. In sheet mode, board-root elements go onto the open sheet instead (same
 * place on screen, now in the paper's frame), so drawing on a sheet draws on the paper.
 */
function add(ctx: MutationContext, element: Element): void {
  const paperId = ctx.ui.groupEditId ?? ctx.ui.sheet?.paperId;
  const paper = paperId ? ctx.doc.elements[paperId] : undefined;
  if (paper && element.parentId === null && !element.meta?.['paper']) {
    const toLocal = invert(worldMatrix(ctx.doc.elements as ElementTable, paper));
    const local = applyToPoint(toLocal, { x: element.x, y: element.y });
    element.parentId = paper.id;
    element.index = topIndex(ctx.doc.elements as ElementTable, paper.id);
    element.x = local.x;
    element.y = local.y;
    element.rotation -= Math.atan2(toLocal[1], toLocal[0]) * -180 / Math.PI;
  }
  ctx.doc.elements[element.id] = element;
}

export const createRect = defineMutation({
  id: 'create-rect',
  label: 'Rectangle',
  description: 'Creates a rectangle at a position (millimetres).',
  aliases: ['box', 'square'],
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().min(0).default(1000),
    height: z.number().min(0).default(1000),
    radius: z.number().min(0).default(0),
    style: StyleSchema.partial().optional(),
    ...CommonCreate,
  }),
  run: (ctx, input) => {
    const element: RectElement = {
      ...base(ctx.doc, ctx.ids.next('el'), input.parentId),
      kind: 'rect',
      x: input.x,
      y: input.y,
      rotation: input.rotation,
      width: input.width,
      height: input.height,
      radius: input.radius,
      style: { ...DEFAULT_RECT_STYLE, ...newElementStyle(ctx.doc.workspace.graphics, 'rect'), ...input.style },
      ...(input.name ? { name: input.name } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
    };
    add(ctx, element);
    if (input.select) setSelection(ctx, [element.id]);
    return element.id;
  },
});

export const createLine = defineMutation({
  id: 'create-line',
  label: 'Line',
  description: 'Creates a line or polyline from world-space points (millimetres).',
  aliases: ['polyline', 'path'],
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({
    points: z.array(Point).min(2),
    /** Optional editable analytic source. `points` is only its cached tessellation. */
    path: CurvePathSchema.optional(),
    closed: z.boolean().default(false),
    style: StyleSchema.partial().optional(),
    ...CommonCreate,
  }),
  run: (ctx, input) => {
    // The element origin sits at the min corner so local points are non-negative.
    const sourcePoints = input.path ? sampleCurvePath(input.path, 32) : input.points;
    const minX = Math.min(...sourcePoints.map((p) => p[0]));
    const minY = Math.min(...sourcePoints.map((p) => p[1]));
    const localPoint = (point: readonly [number, number]): [number, number] => [point[0] - minX, point[1] - minY];
    const localPath: CurvePath | undefined = input.path ? {
      start: localPoint(input.path.start),
      segments: input.path.segments.map((segment) => {
        if (segment.kind === 'line') return { ...segment, to: localPoint(segment.to) };
        if (segment.kind === 'quadratic') return { ...segment, control: localPoint(segment.control), to: localPoint(segment.to) };
        if (segment.kind === 'bezier') return { ...segment, control1: localPoint(segment.control1), control2: localPoint(segment.control2), to: localPoint(segment.to) };
        return { ...segment, center: localPoint(segment.center) };
      }),
    } : undefined;
    const element: LineElement = {
      ...base(ctx.doc, ctx.ids.next('el'), input.parentId),
      kind: 'line',
      x: minX,
      y: minY,
      rotation: input.rotation,
      points: sourcePoints.map(localPoint),
      ...(localPath ? { path: localPath } : {}),
      closed: input.closed,
      style: { ...DEFAULT_LINE_STYLE, ...newElementStyle(ctx.doc.workspace.graphics, 'line'), ...input.style },
      ...(input.name ? { name: input.name } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
    };
    add(ctx, element);
    if (input.select) setSelection(ctx, [element.id]);
    return element.id;
  },
});

export const createText = defineMutation({
  id: 'create-text',
  label: 'Text',
  description: 'Creates a text box; its height follows the wrapped text.',
  aliases: ['label', 'annotation'],
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    text: z.string().default('Text'),
    width: z.number().min(0).default(2000),
    fontSize: z.number().positive().optional(),
    align: z.enum(['left', 'center', 'right']).default('left'),
    color: z.string().optional(),
    ...CommonCreate,
  }),
  run: (ctx, input) => {
    const defaults = newElementGraphics(ctx.doc.workspace.graphics, 'text');
    const fontSize = input.fontSize ?? (typeof defaults['fontSize'] === 'number' ? defaults['fontSize'] : DEFAULT_FONT_SIZE);
    const color = input.color ?? (typeof defaults['color'] === 'string' ? defaults['color'] : DEFAULT_TEXT_COLOR);
    const element: TextElement = {
      ...base(ctx.doc, ctx.ids.next('el'), input.parentId),
      kind: 'text',
      x: input.x,
      y: input.y,
      rotation: input.rotation,
      width: input.width,
      height: textHeight(ctx.measurer, input.text, fontSize, input.width),
      text: input.text,
      fontSize,
      align: input.align,
      color,
      ...(input.name ? { name: input.name } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
    };
    add(ctx, element);
    if (input.select) setSelection(ctx, [element.id]);
    return element.id;
  },
});

export const BlobInput = z.object({
  mime: z.string().max(100),
  /** base64 */
  data: z.string().min(1),
  width: z.number().min(0),
  height: z.number().min(0),
});

/** Adds the blob (content-addressed) if it is not already in the document; returns its id. */
export function ensureBlob(doc: DocDraft, blob: z.infer<typeof BlobInput>): string {
  const id = `blob_${contentHash(blob.data)}`;
  if (!doc.blobs[id]) {
    const record: BlobRecord = { id, mime: blob.mime, data: blob.data, width: blob.width, height: blob.height };
    doc.blobs[id] = record;
  }
  return id;
}

export const createImage = defineMutation({
  id: 'create-image',
  label: 'Image',
  description: 'Places an image; pass either an existing blobId or the image bytes.',
  aliases: ['picture', 'photo', 'plan underlay'],
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    blobId: IdSchema.optional(),
    blob: BlobInput.optional(),
    /** Defaults to the image pixel size interpreted as millimetres, capped to 10 m wide. */
    width: z.number().min(0).optional(),
    height: z.number().min(0).optional(),
    opacity: z.number().min(0).max(1).optional(),
    ...CommonCreate,
  }),
  run: (ctx, input) => {
    let blobId = input.blobId;
    if (!blobId) {
      if (!input.blob) throw new CommandError('invalid-input', 'create-image needs a blobId or blob');
      blobId = ensureBlob(ctx.doc, input.blob);
    }
    const blob = ctx.doc.blobs[blobId];
    if (!blob) throw new CommandError('rejected', `Unknown blob ${blobId}`);
    const naturalWidth = blob.width || 1000;
    const naturalHeight = blob.height || 1000;
    let width = input.width;
    let height = input.height;
    if (width === undefined && height === undefined) {
      const scale = Math.min(1, 10_000 / naturalWidth);
      width = naturalWidth * scale;
      height = naturalHeight * scale;
    } else if (width === undefined) {
      width = (height! / naturalHeight) * naturalWidth;
    } else if (height === undefined) {
      height = (width / naturalWidth) * naturalHeight;
    }
    const element: ImageElement = {
      ...base(ctx.doc, ctx.ids.next('el'), input.parentId),
      kind: 'image',
      x: input.x,
      y: input.y,
      rotation: input.rotation,
      width,
      height: height!,
      blobId,
      opacity: input.opacity ?? (typeof newElementGraphics(ctx.doc.workspace.graphics, 'image')['opacity'] === 'number' ? (newElementGraphics(ctx.doc.workspace.graphics, 'image')['opacity'] as number) : 1),
      ...(input.name ? { name: input.name } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
    };
    add(ctx, element);
    if (input.select) setSelection(ctx, [element.id]);
    return element.id;
  },
});

export const createAssetInstance = defineMutation({
  id: 'create-asset-instance',
  label: 'Place asset',
  description: 'Places an instance of an asset definition at a position.',
  aliases: ['instance', 'insert asset'],
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({
    definitionId: IdSchema,
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().min(0).optional(),
    height: z.number().min(0).optional(),
    ...CommonCreate,
  }),
  run: (ctx, input) => {
    const definition = ctx.doc.definitions[input.definitionId];
    if (!definition) throw new CommandError('rejected', `Unknown asset definition ${input.definitionId}`);
    const element: InstanceElement = {
      ...base(ctx.doc, ctx.ids.next('el'), input.parentId),
      kind: 'instance',
      x: input.x,
      y: input.y,
      rotation: input.rotation,
      width: input.width ?? definition.width,
      height: input.height ?? definition.height,
      definitionId: definition.id,
      name: input.name ?? definition.name,
      ...(input.meta ? { meta: input.meta } : {}),
    };
    add(ctx, element);
    if (input.select) setSelection(ctx, [element.id]);
    return element.id;
  },
});

export const createImageDefinition = defineMutation({
  id: 'create-image-definition',
  label: 'Add image asset',
  description: 'Registers a raster symbol (e.g. a catalog 2D image) as a reusable asset definition.',
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({
    name: z.string().max(200),
    blobId: IdSchema.optional(),
    blob: BlobInput.optional(),
    /** Real-world footprint in millimetres. */
    width: z.number().positive(),
    height: z.number().positive(),
    category: z.string().max(200).optional(),
    tags: z.array(z.string().max(64)).optional(),
    catalog: z
      .object({
        source: z.string().max(500).optional(),
        path: z.string().max(500),
        imageUrl: z.string().max(2000).optional(),
        modelUrl: z.string().max(2000).optional(),
        package: z
          .object({
            key: z.string().max(1000),
            url: z.string().max(2000),
            version: z.literal(1),
          })
          .optional(),
        topViewPath: z.string().max(1000).optional(),
        modelPaths: z
          .object({
            glb: z.string().max(1000).optional(),
            fbx: z.string().max(1000).optional(),
            glbLow: z.string().max(1000).optional(),
          })
          .optional(),
        styleViews: z
          .record(z.string().max(40), z.object({ top: z.string().max(1000).optional(), front: z.string().max(1000).optional(), side: z.string().max(1000).optional() }))
          .optional(),
        systemType: z.enum(['wall', 'window', 'door', 'column', 'stair', 'railing', 'curtain-wall', 'facade-element', 'floor', 'ceiling']).optional(),
      })
      .optional(),
    meta: Meta.optional(),
  }),
  run: (ctx, input) => {
    // The same catalog asset placed twice reuses one definition.
    if (input.catalog) {
      const path = input.catalog.path;
      const existing = Object.values(ctx.doc.definitions).find(
        (d) => d.kind === 'image' && d.catalog?.path === path && d.catalog?.source === input.catalog?.source,
      );
      if (existing) return existing.id;
    }
    let blobId = input.blobId;
    if (!blobId) {
      if (!input.blob) throw new CommandError('invalid-input', 'create-image-definition needs a blobId or blob');
      blobId = ensureBlob(ctx.doc, input.blob);
    }
    if (!ctx.doc.blobs[blobId]) throw new CommandError('rejected', `Unknown blob ${blobId}`);
    const id = ctx.ids.next('def');
    ctx.doc.definitions[id] = {
      id,
      kind: 'image',
      name: input.name,
      width: input.width,
      height: input.height,
      origin: input.catalog ? 'catalog' : 'user',
      blobId,
      ...(input.category ? { category: input.category } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.catalog ? { catalog: input.catalog } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
    };
    return id;
  },
});

export function definitionName(doc: ArchaiDocument, base: string): string {
  const names = new Set(Object.values(doc.definitions).map((d) => d.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

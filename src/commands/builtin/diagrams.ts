/**
 * Diagram elements (see src/diagrams/model.ts): arrows, connectors glued to elements, callouts,
 * chained dimension strings, adjacency links, zones/bubbles and live tags, plus the document's
 * diagram theme. Everything is an ordinary line or rect with `meta.diagram`.
 */
import { z } from 'zod';
import { IdSchema, type ArchaiDocument, type Element, type ElementTable } from '@/document';
import { hitTest, worldBounds, type Vec2 } from '@/geometry';
import { selectableTarget } from '@/selection';
import { ARROW_HEADS, asJson, DIAGRAM_KINDS, DIAGRAM_LINE_KINDS, DIAGRAM_THEMES, diagramDefaults, diagramOf, printScaleOf, ROUTES, tagText, themeOf, ZONE_SHAPES, type DiagramKind, type DiagramMeta } from '@/diagrams/model';
import { CommandError, defineMutation, type MutationContext } from '../contract';
import { setSelection, snapshot } from '../helpers';
import { createLine, createRect } from './create';

const Point = z.tuple([z.number().finite(), z.number().finite()]);
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a #rrggbb colour');

export const DiagramPatch = z.object({
  color: Hex.nullable().optional(),
  fill: Hex.nullable().optional(),
  weight: z.number().positive().max(5).nullable().optional(),
  dashed: z.boolean().optional(),
  head: z.enum(ARROW_HEADS).optional(),
  tail: z.enum(ARROW_HEADS).optional(),
  route: z.enum(ROUTES).optional(),
  from: IdSchema.nullable().optional(),
  to: IdSchema.nullable().optional(),
  text: z.string().max(400).optional(),
  shape: z.enum(ZONE_SHAPES).optional(),
  showArea: z.boolean().optional(),
  target: IdSchema.nullable().optional(),
  offset: z.number().min(-100).max(100).optional(),
});
type DiagramPatchT = z.infer<typeof DiagramPatch>;

function merge(meta: DiagramMeta, patch: DiagramPatchT): DiagramMeta {
  const next = { ...meta } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) next[key] = value;
  return next as unknown as DiagramMeta;
}

/** The element a diagram end at `point` glues to: not other diagram lines, not sheets. */
function glueAt(ctx: MutationContext, point: Vec2): string | null {
  const doc = ctx.doc as ArchaiDocument;
  // Eight screen pixels around the point, like clicking.
  const tolerance = 8 / Math.max(1e-6, ctx.ui.viewport.zoom);
  const hit = hitTest(doc, point, {
    tolerance,
    includeLocked: true,
    scopeId: ctx.ui.sheet?.paperId,
    accept: (element) => !(element.kind === 'line' && diagramOf(element)) && !element.meta?.['paper'],
  });
  if (!hit) return null;
  const target = selectableTarget(doc.elements as ElementTable, hit, false, ctx.ui.sheet?.paperId ?? null);
  return target.meta?.['paper'] ? null : target.id;
}

/** A tag box sized for its text, in board millimetres at the element's print scale. */
function tagSize(text: string, scale: number, theme: ReturnType<typeof themeOf>): { width: number; height: number } {
  const lines = text.split('\n');
  const longest = Math.max(4, ...lines.map((line) => line.length));
  return { width: (longest * theme.text * 0.62 + 4) * scale, height: (lines.length * theme.text * 1.35 + 2.4) * scale };
}

export const createDiagram = defineMutation({
  id: 'create-diagram',
  label: 'Add diagram element',
  description:
    'Adds a diagram element. Lines (`points`, world mm): arrow, connector (ends glue to the elements under them unless from/to are given), callout (leader to a note), dimension (chained string), adjacency. Boxes: zone (x, y, width, height) and tag (a live label of `target` or of the element at x, y). `patch` sets colour, weight (printed mm), heads, route, text and more.',
  aliases: ['arrow', 'connector', 'callout', 'leader', 'dimension', 'zone', 'bubble', 'tag', 'annotation', 'diagram'],
  group: 'create',
  palette: false,
  history: 'record',
  input: z.object({
    kind: z.enum(DIAGRAM_KINDS),
    points: z.array(Point).min(2).optional(),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    patch: DiagramPatch.default({}),
  }),
  run: (ctx, input) => {
    const kind: DiagramKind = input.kind;
    let meta = merge(diagramDefaults(kind), input.patch);
    const theme = themeOf(ctx.doc as ArchaiDocument);
    if ((DIAGRAM_LINE_KINDS as readonly string[]).includes(kind)) {
      if (!input.points) throw new CommandError('invalid-input', `A ${kind} needs points`);
      const points = kind === 'dimension' ? input.points : kind === 'arrow' ? input.points : [input.points[0]!, input.points.at(-1)!];
      if ((kind === 'connector' || kind === 'adjacency') && input.patch.from === undefined && input.patch.to === undefined) {
        meta = { ...meta, from: glueAt(ctx, { x: points[0]![0], y: points[0]![1] }), to: glueAt(ctx, { x: points.at(-1)![0], y: points.at(-1)![1] }) };
        if (meta.from && meta.from === meta.to) meta = { ...meta, to: null };
      }
      return createLine.run(ctx, {
        points,
        closed: false,
        rotation: 0,
        style: { fill: null, stroke: theme.ink, strokeWidth: 12, opacity: 1 },
        name: kind[0]!.toUpperCase() + kind.slice(1),
        meta: { diagram: asJson(meta) },
        parentId: null,
        select: true,
      });
    }
    if (kind === 'zone') {
      if (input.x === undefined || input.y === undefined) throw new CommandError('invalid-input', 'A zone needs x, y (and width, height)');
      return createRect.run(ctx, {
        x: input.x,
        y: input.y,
        width: input.width ?? 4000,
        height: input.height ?? 3000,
        radius: 0,
        rotation: 0,
        // Filled so the whole zone is clickable; zones draw themselves.
        style: { fill: '#ffffff', stroke: null, strokeWidth: 0, opacity: 1 },
        name: meta.text || 'Zone',
        meta: { diagram: asJson(meta) },
        parentId: null,
        select: true,
      });
    }
    // Tag: of the given target, or of whatever is under (x, y).
    const doc = ctx.doc as ArchaiDocument;
    const at = input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : null;
    const target = meta.target ?? (at ? glueAt(ctx, at) : null);
    const targetElement: Element | undefined = target ? doc.elements[target] : undefined;
    if (!targetElement) throw new CommandError('rejected', 'Click an element to tag');
    if (input.patch.text === undefined && targetElement.meta?.['arch'] && (targetElement.meta['arch'] as { type?: string }).type === 'room') meta = { ...meta, text: '{name}\n{area}' };
    meta = { ...meta, target: targetElement.id };
    const box = worldBounds(doc.elements as ElementTable, targetElement);
    const centre = at ?? { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    // Sized at the scale it will print at (the open sheet's, else the board's).
    const scale = ctx.ui.sheet ? printScaleOf(doc.elements as ElementTable, doc.elements[ctx.ui.sheet.paperId]!) : printScaleOf(doc.elements as ElementTable, targetElement);
    const size = tagSize(tagText(meta.text, doc.elements as ElementTable, targetElement), scale, theme);
    return createRect.run(ctx, {
      x: centre.x - size.width / 2,
      y: centre.y - size.height / 2,
      ...size,
      radius: 0,
      rotation: 0,
      style: { fill: '#ffffff', stroke: null, strokeWidth: 0, opacity: 1 },
      name: `Tag: ${targetElement.name ?? 'element'}`,
      meta: { diagram: asJson(meta) },
      parentId: null,
      select: true,
    });
  },
});

export const setDiagram = defineMutation({
  id: 'set-diagram',
  label: 'Set diagram element',
  description: 'Changes diagram elements: colour, fill, weight (printed mm), dashed, heads, route, glue (from/to), text or tag template ({name} {area} {level} {type}), zone shape and area, dimension offset.',
  group: 'edit',
  palette: false,
  history: 'record',
  input: z.object({ ids: z.array(IdSchema).optional(), patch: DiagramPatch }),
  run: (ctx, input) => {
    const ids = input.ids ?? ctx.ui.selection;
    const targets = ids.flatMap((id) => {
      const element = ctx.doc.elements[id];
      const meta = diagramOf(element);
      return element && meta ? [{ element, meta }] : [];
    });
    if (targets.length === 0) throw new CommandError('rejected', 'Select a diagram element');
    for (const { element, meta } of targets) {
      const next = merge(meta, input.patch);
      element.meta = { ...snapshot(element.meta ?? {}), diagram: asJson(next) };
      if (next.kind === 'zone' && input.patch.text !== undefined) element.name = next.text || 'Zone';
    }
    return targets.map(({ element }) => element.id);
  },
});

export const setDiagramTheme = defineMutation({
  id: 'set-diagram-theme',
  label: 'Diagram theme',
  description: 'Sets the look of every diagram element in the document: technical, soft, mono or bold.',
  aliases: ['diagram style', 'presentation style', 'diagram theme'],
  group: 'view',
  history: 'record',
  input: z.object({ theme: z.enum(DIAGRAM_THEMES).default('technical') }).prefault({}),
  run: (ctx, input) => {
    ctx.doc.workspace.diagramTheme = input.theme;
    return input.theme;
  },
});

function toolFor(kind: DiagramKind, label: string, aliases: string[]) {
  return defineMutation({
    id: `tool-diagram-${kind}`,
    label,
    aliases: [...aliases, 'diagram'],
    group: 'select',
    history: 'none',
    input: z.void(),
    run: (ctx) => {
      ctx.ui.tool = `diagram:${kind}`;
      ctx.ui.placingAsset = null;
      setSelection(ctx, []);
    },
  });
}

export const diagramTools = [
  toolFor('arrow', 'Arrow tool', ['arrow', 'pointer']),
  toolFor('connector', 'Connector tool', ['connector', 'link', 'flow']),
  toolFor('callout', 'Callout tool', ['callout', 'leader', 'note']),
  toolFor('dimension', 'Dimension string tool', ['dimension', 'dimensions', 'chain dimension']),
  toolFor('zone', 'Zone tool', ['zone', 'bubble', 'area', 'program']),
  toolFor('tag', 'Tag tool', ['tag', 'room tag', 'label']),
  toolFor('adjacency', 'Adjacency tool', ['adjacency', 'relationship', 'bubble diagram']),
];

export const diagramCommands = [createDiagram, setDiagram, setDiagramTheme, ...diagramTools];

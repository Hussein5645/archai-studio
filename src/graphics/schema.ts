/**
 * Element graphics: the Hidden line look of every element type, per view (board / section / 3D).
 * This registry declares which graphic parameters each
 * type has and their built-in defaults; `doc.workspace.graphics` stores the overrides (see
 * ./resolve.ts). In Hidden line these values are authoritative for the type. A selected element
 * may store `meta.graphics.hiddenLine` values that take precedence without changing other styles.
 *
 * Locked parameters carry meaning (the section marker's arrows, a door's swing) and cannot be
 * overridden; they are listed so the dialog can show them greyed out.
 */
import type { JsonValue } from '@/document/schema';

export type GraphicView = 'board' | 'section' | '3d';
export const GRAPHIC_VIEWS: readonly GraphicView[] = ['board', 'section', '3d'];

/** Render styles understood by board graphic defaults. Overrides are scoped to Hidden line. */
export const BOARD_STYLES = ['realistic', 'hidden-line', 'shaded', 'wireframe', 'consistent'] as const;
export type BoardStyle = (typeof BOARD_STYLES)[number];

export type HatchPattern = 'none' | 'diagonal' | 'cross' | 'dots';
export const HATCH_PATTERNS: readonly { value: HatchPattern; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'diagonal', label: 'Diagonal' },
  { value: 'cross', label: 'Cross' },
  { value: 'dots', label: 'Dots' },
];

export interface TextColorMapping {
  text: string;
  color: string;
}

export type GraphicValue = string | number | boolean | null | TextColorMapping[];

export type GraphicKind =
  /** Hex colour; `allowNone` permits "no fill". */
  | 'color'
  /** A line weight in millimetres (board) or screen pixels (section outlines). */
  | 'width'
  /** 0..1, shown as a percentage. */
  | 'opacity'
  | 'toggle'
  | 'hatch'
  /** A plain number with a unit (spacing, angle, font size, scale). */
  | 'number'
  | 'choice'
  /** Exact text values mapped to colours (used by room names). */
  | 'text-color-map';

export interface GraphicParameter {
  /** Stable key inside its type, e.g. `cut.fill`. */
  id: string;
  label: string;
  /** Section heading in the dialog. */
  group: string;
  kind: GraphicKind;
  views: readonly GraphicView[];
  /** Board render styles the parameter exists for; undefined = all styles. */
  styles?: readonly BoardStyle[];
  /** Built-in default, possibly depending on the render style. */
  default: GraphicValue | ((style: string) => GraphicValue);
  /** Locked parameters are shown but never overridable. */
  locked?: string;
  allowNone?: boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: 'mm' | 'px' | '%' | 'deg';
  options?: readonly { value: string; label: string }[];
}

export type GraphicCategory = 'Structure' | 'Openings' | 'Circulation' | 'Envelope' | 'Spaces' | 'Drawing' | 'Assets' | 'Annotation' | 'Views';
export const GRAPHIC_CATEGORIES: readonly GraphicCategory[] = ['Structure', 'Openings', 'Circulation', 'Envelope', 'Spaces', 'Drawing', 'Assets', 'Annotation', 'Views'];

export interface GraphicType {
  id: string;
  label: string;
  category: GraphicCategory;
  description?: string;
  parameters: readonly GraphicParameter[];
}

/** `{ [type]: { [view]: { [style | '*']: { [parameter]: value } } } }` — what the document stores. */
export type GraphicsOverrides = Record<string, Record<string, Record<string, Record<string, JsonValue>>>>;

// ---- shared parameter builders --------------------------------------------------------------

const INK = '#3a3a3f';
const LIGHT_INK = '#6b6b72';
const HIDDEN_INK = '#1f1f24';

const color = (id: string, label: string, group: string, views: readonly GraphicView[], value: GraphicParameter['default'], extra: Partial<GraphicParameter> = {}): GraphicParameter => ({
  id,
  label,
  group,
  kind: 'color',
  views,
  default: value,
  ...extra,
});
const width = (id: string, label: string, group: string, views: readonly GraphicView[], value: GraphicParameter['default'], extra: Partial<GraphicParameter> = {}): GraphicParameter => ({
  id,
  label,
  group,
  kind: 'width',
  views,
  default: value,
  min: 0,
  unit: 'mm',
  ...extra,
});
const toggle = (id: string, label: string, group: string, views: readonly GraphicView[], value: boolean, extra: Partial<GraphicParameter> = {}): GraphicParameter => ({
  id,
  label,
  group,
  kind: 'toggle',
  views,
  default: value,
  ...extra,
});
const number = (id: string, label: string, group: string, views: readonly GraphicView[], value: number, extra: Partial<GraphicParameter> = {}): GraphicParameter => ({
  id,
  label,
  group,
  kind: 'number',
  views,
  default: value,
  ...extra,
});
const opacity = (id: string, label: string, group: string, views: readonly GraphicView[], value: number): GraphicParameter => ({
  id,
  label,
  group,
  kind: 'opacity',
  views,
  default: value,
  min: 0,
  max: 1,
});

/** The cut-surface block every solid type shows on the Section tab. */
function cutSurface(fill: string, hatch: HatchPattern = 'none', hatchColor = INK): GraphicParameter[] {
  return [
    color('cut.fill', 'Cut fill', 'Cut surface', ['section'], fill),
    { id: 'cut.hatch', label: 'Hatch', group: 'Cut surface', kind: 'hatch', views: ['section'], default: hatch, options: HATCH_PATTERNS },
    color('cut.hatchColor', 'Hatch colour', 'Cut surface', ['section'], hatchColor),
    number('cut.hatchSpacing', 'Hatch spacing', 'Cut surface', ['section'], 120, { min: 10, max: 2000, step: 10, unit: 'mm' }),
    number('cut.hatchAngle', 'Hatch angle', 'Cut surface', ['section'], 45, { min: 0, max: 180, step: 15, unit: 'deg' }),
  ];
}

// ---- the registry ---------------------------------------------------------------------------

export const GRAPHIC_TYPES: readonly GraphicType[] = [
  {
    id: 'wall',
    label: 'Wall',
    category: 'Structure',
    parameters: [
      color('body.fill', 'Wall fill colour', 'Fills', ['board'], (style) => (style === 'hidden-line' ? '#ffffff' : style === 'shaded' ? '#8e9099' : INK)),
      opacity('body.opacity', 'Wall fill opacity', 'Fills', ['board'], 1),
      color('outline.stroke', 'Outline', 'Lines', ['board'], HIDDEN_INK, { styles: ['hidden-line'], locked: 'Hidden line always draws walls as white bodies with a black outline.' }),
      width('outline.width', 'Outline weight', 'Lines', ['board'], 6, { styles: ['hidden-line'] }),
      toggle('layer.visible', 'Layer lines', 'Lines', ['board'], true),
      color('layer.stroke', 'Layer line colour', 'Lines', ['board'], (style) => (style === 'hidden-line' ? HIDDEN_INK : '#ffffff')),
      width('layer.width', 'Layer line weight', 'Lines', ['board'], 4),
      toggle('plan.useCut', 'Use section cut graphics in plan', 'Fills', ['board'], false),
      color('cut.coreFill', 'Core cut fill', 'Cut surface', ['section'], '#9a9ca3'),
      { id: 'cut.coreHatch', label: 'Core hatch', group: 'Cut surface', kind: 'hatch', views: ['section'], default: 'diagonal', options: HATCH_PATTERNS },
      color('cut.finishFill', 'Finish cut fill', 'Cut surface', ['section'], '#e6e7ea'),
      color('cut.hatchColor', 'Hatch colour', 'Cut surface', ['section'], INK),
      number('cut.hatchSpacing', 'Hatch spacing', 'Cut surface', ['section'], 120, { min: 10, max: 2000, step: 10, unit: 'mm' }),
      number('cut.hatchAngle', 'Hatch angle', 'Cut surface', ['section'], 45, { min: 0, max: 180, step: 15, unit: 'deg' }),
      toggle('openings.cut', 'Openings are cut out', 'Fills', ['board', 'section', '3d'], true, { locked: 'Doors and windows always cut their wall.' }),
      color('material.core', 'Core material', 'Materials', ['3d'], '#8d8f96'),
      color('material.finish', 'Finish material', 'Materials', ['3d'], '#e6e7ea'),
    ],
  },
  {
    id: 'column',
    label: 'Column',
    category: 'Structure',
    parameters: [
      color('fill.concrete', 'Concrete fill', 'Fills', ['board'], (style) => (style === 'hidden-line' ? '#ffffff' : '#e4e5e8')),
      color('fill.steel', 'Steel fill', 'Fills', ['board'], (style) => (style === 'hidden-line' ? '#ffffff' : '#c9ccd3')),
      color('fill.timber', 'Timber fill', 'Fills', ['board'], (style) => (style === 'hidden-line' ? '#ffffff' : '#e8d9c2')),
      color('outline.stroke', 'Outline', 'Lines', ['board'], (style) => (style === 'hidden-line' ? HIDDEN_INK : INK)),
      width('outline.width', 'Outline weight', 'Lines', ['board'], 24),
      ...cutSurface('#c9ccd3', 'cross'),
      color('material.concrete', 'Concrete', 'Materials', ['3d'], '#b9bcc4'),
      color('material.steel', 'Steel', 'Materials', ['3d'], '#8b95a5'),
      color('material.timber', 'Timber', 'Materials', ['3d'], '#d2b48c'),
    ],
  },
  {
    id: 'facade-element',
    label: 'Facade element',
    category: 'Structure',
    parameters: [
      color('fill', 'Fill', 'Fills', ['board'], '#eef3fb', { allowNone: true }),
      color('ink', 'Lines', 'Lines', ['board'], '#587099'),
      number('lineScale', 'Line weight', 'Lines', ['board'], 100, { min: 10, max: 400, step: 10, unit: '%' }),
      ...cutSurface('#d3dbe8'),
      color('material', 'Material', 'Materials', ['3d'], '#c9ccd3'),
    ],
  },
  {
    id: 'door',
    label: 'Door',
    category: 'Openings',
    parameters: [
      color('ink', 'Leaf and frame', 'Lines', ['board'], (style) => (style === 'hidden-line' ? HIDDEN_INK : INK)),
      color('light', 'Swing', 'Lines', ['board'], (style) => (style === 'hidden-line' ? HIDDEN_INK : LIGHT_INK)),
      number('lineScale', 'Line weight', 'Lines', ['board'], 100, { min: 10, max: 400, step: 10, unit: '%' }),
      toggle('swing.visible', 'Swing arc', 'Symbol', ['board'], true, { locked: 'The swing shows which way a door opens.' }),
      ...cutSurface('#b98a5a'),
      color('material.leaf', 'Leaf', 'Materials', ['3d'], '#b98a5a'),
      color('material.frame', 'Frame', 'Materials', ['3d'], '#4b4d54'),
    ],
  },
  {
    id: 'window',
    label: 'Window',
    category: 'Openings',
    parameters: [
      color('fill', 'Frame fill', 'Fills', ['board'], '#ffffff', { allowNone: true }),
      color('ink', 'Frame and pane', 'Lines', ['board'], (style) => (style === 'hidden-line' ? HIDDEN_INK : INK)),
      color('light', 'Opening indicator', 'Lines', ['board'], (style) => (style === 'hidden-line' ? HIDDEN_INK : LIGHT_INK)),
      number('lineScale', 'Line weight', 'Lines', ['board'], 100, { min: 10, max: 400, step: 10, unit: '%' }),
      toggle('pane.visible', 'Glazing line', 'Symbol', ['board'], true, { locked: 'The glazing line tells a window from an opening.' }),
      color('cut.fill', 'Frame cut fill', 'Cut surface', ['section'], '#4b4d54'),
      color('cut.glass', 'Glass', 'Cut surface', ['section'], '#9cc5e8'),
      color('material.frame', 'Frame', 'Materials', ['3d'], '#4b4d54'),
      color('material.glass', 'Glass', 'Materials', ['3d'], '#9cc5e8'),
      opacity('material.glassOpacity', 'Glass opacity', 'Materials', ['3d'], 0.45),
    ],
  },
  {
    id: 'stair',
    label: 'Stair',
    category: 'Circulation',
    parameters: [
      color('tread.fill', 'Tread fill', 'Fills', ['board'], '#ffffff'),
      color('landing.fill', 'Landing fill', 'Fills', ['board'], (style) => (style === 'hidden-line' ? '#ffffff' : '#f3f4f6')),
      color('outline.stroke', 'Outline', 'Lines', ['board'], (style) => (style === 'hidden-line' ? HIDDEN_INK : INK)),
      width('outline.width', 'Outline weight', 'Lines', ['board'], 16),
      color('riser.stroke', 'Riser lines', 'Lines', ['board'], (style) => (style === 'hidden-line' ? HIDDEN_INK : LIGHT_INK)),
      width('riser.width', 'Riser line weight', 'Lines', ['board'], 8),
      toggle('riser.visible', 'Riser lines', 'Symbol', ['board'], true, { locked: 'Risers are what make a stair readable in plan.' }),
      toggle('nosing.visible', 'Nosing lines', 'Lines', ['board'], true),
      color('nosing.stroke', 'Nosing line colour', 'Lines', ['board'], (style) => (style === 'hidden-line' ? HIDDEN_INK : LIGHT_INK)),
      color('direction.stroke', 'Direction line', 'Symbol', ['board'], (style) => (style === 'hidden-line' ? HIDDEN_INK : INK)),
      width('direction.width', 'Direction line weight', 'Symbol', ['board'], 12),
      toggle('direction.visible', 'Direction arrow', 'Symbol', ['board'], true, { locked: 'The arrow shows the direction of travel.' }),
      toggle('label.visible', 'UP label', 'Symbol', ['board'], true),
      color('label.color', 'UP label colour', 'Symbol', ['board'], (style) => (style === 'hidden-line' ? HIDDEN_INK : LIGHT_INK)),
      ...cutSurface('#cfd2d8', 'diagonal'),
      color('material.tread', 'Tread', 'Materials', ['section', '3d'], '#d9dbe0'),
      color('material.riser', 'Riser', 'Materials', ['section', '3d'], '#c4c7ce'),
      color('material.landing', 'Landing', 'Materials', ['section', '3d'], '#cfd2d8'),
      toggle('stringer.visible', 'Stringers', 'Materials', ['section', '3d'], false),
      color('material.stringer', 'Stringer', 'Materials', ['section', '3d'], '#8d8f96'),
    ],
  },
  {
    id: 'railing',
    label: 'Railing',
    category: 'Circulation',
    parameters: [
      color('stroke', 'Rail', 'Lines', ['board'], (style) => (style === 'hidden-line' ? HIDDEN_INK : LIGHT_INK)),
      width('width', 'Line weight', 'Lines', ['board'], 12),
      color('pattern.stroke', 'Pattern marks', 'Lines', ['board'], '#ffffff'),
      width('pattern.width', 'Pattern weight', 'Lines', ['board'], 6),
      ...cutSurface('#5a5c63'),
      color('material.rail', 'Rail and posts', 'Materials', ['3d'], '#5a5c63'),
      color('material.panel', 'Glass panel', 'Materials', ['3d'], '#9cc5e8'),
    ],
  },
  {
    id: 'curtain-wall',
    label: 'Curtain wall',
    category: 'Envelope',
    parameters: [
      color('stroke', 'Line', 'Lines', ['board'], (style) => (style === 'hidden-line' ? HIDDEN_INK : '#587099')),
      width('width', 'Line weight', 'Lines', ['board'], 12),
      ...cutSurface('#9cc5e8'),
      color('material', 'Material', 'Materials', ['3d'], '#9cc5e8'),
    ],
  },
  {
    id: 'room-divider',
    label: 'Room divider',
    category: 'Envelope',
    parameters: [color('stroke', 'Line', 'Lines', ['board'], (style) => (style === 'hidden-line' ? HIDDEN_INK : '#8a8f98')), width('width', 'Line weight', 'Lines', ['board'], 8)],
  },
  {
    id: 'room',
    label: 'Room',
    category: 'Spaces',
    parameters: [
      color('fill', 'Default colour', 'Fills', ['board'], (style) => (style === 'hidden-line' ? '#ffffff' : '#eef3fb'), { allowNone: true }),
      { id: 'name.colors', label: 'Room name colours', group: 'Fills', kind: 'text-color-map', views: ['board'], default: [] },
      opacity('fill.opacity', 'Fill opacity', 'Fills', ['board'], 0.55),
      color('outline.stroke', 'Outline', 'Lines', ['board'], (style) => (style === 'hidden-line' ? HIDDEN_INK : '#8aa4cb'), { allowNone: true }),
      width('outline.width', 'Outline weight', 'Lines', ['board'], 12),
      color('label.color', 'Label colour', 'Symbol', ['board'], INK),
      color('material.floor', 'Floor', 'Materials', ['3d'], '#eef3fb'),
    ],
  },
  {
    id: 'floor',
    label: 'Floor',
    category: 'Spaces',
    parameters: [
      color('fill', 'Floor fill colour', 'Fills', ['board'], (style) => (style === 'hidden-line' ? '#ffffff' : '#d9dde3'), { allowNone: true }),
      opacity('fill.opacity', 'Floor fill opacity', 'Fills', ['board'], 0.72),
      color('outline.stroke', 'Outline colour', 'Lines', ['board'], (style) => (style === 'hidden-line' ? HIDDEN_INK : '#737983'), { allowNone: true }),
      width('outline.width', 'Outline weight', 'Lines', ['board'], 12),
      ...cutSurface('#bfc3ca', 'diagonal'),
      color('material', '3D material colour', 'Materials', ['3d'], '#bfc3ca'),
    ],
  },
  {
    id: 'ceiling',
    label: 'Ceiling',
    category: 'Spaces',
    parameters: [
      color('fill', 'Ceiling fill colour', 'Fills', ['board'], (style) => (style === 'hidden-line' ? '#ffffff' : '#eef0f4'), { allowNone: true }),
      opacity('fill.opacity', 'Ceiling fill opacity', 'Fills', ['board'], 0.58),
      color('outline.stroke', 'Outline colour', 'Lines', ['board'], (style) => (style === 'hidden-line' ? HIDDEN_INK : '#8a9099'), { allowNone: true }),
      width('outline.width', 'Outline weight', 'Lines', ['board'], 12),
      ...cutSurface('#dedfe3', 'cross'),
      color('material', '3D material colour', 'Materials', ['3d'], '#dedfe3'),
    ],
  },
  {
    id: 'rect',
    label: 'Rectangle',
    category: 'Drawing',
    description: 'Defaults for new rectangles; each rectangle keeps its own style in the Inspector.',
    parameters: [
      color('fill', 'Fill', 'New elements', ['board'], '#ffffff', { allowNone: true }),
      color('stroke', 'Stroke', 'New elements', ['board'], INK, { allowNone: true }),
      width('strokeWidth', 'Stroke width', 'New elements', ['board'], 12),
      opacity('opacity', 'Opacity', 'New elements', ['board'], 1),
      ...cutSurface('#c9ccd3'),
      color('material', 'Extrusion', 'Materials', ['3d'], '#c9ccd3'),
      color('material.flat', 'Flat (no height)', 'Materials', ['3d'], '#9a9ca3'),
    ],
  },
  {
    id: 'line',
    label: 'Line',
    category: 'Drawing',
    description: 'Defaults for new lines and polylines; each line keeps its own style in the Inspector.',
    parameters: [
      color('fill', 'Fill', 'New elements', ['board'], null, { allowNone: true }),
      color('stroke', 'Stroke', 'New elements', ['board'], INK, { allowNone: true }),
      width('strokeWidth', 'Stroke width', 'New elements', ['board'], 12),
      opacity('opacity', 'Opacity', 'New elements', ['board'], 1),
      ...cutSurface('#c9ccd3'),
      color('material', 'Extrusion', 'Materials', ['3d'], '#c9ccd3'),
    ],
  },
  {
    id: 'text',
    label: 'Text',
    category: 'Drawing',
    description: 'Defaults for new text; each text keeps its own colour and size in the Inspector.',
    parameters: [color('color', 'Colour', 'New elements', ['board'], '#2a2a2e'), number('fontSize', 'Font size', 'New elements', ['board'], 200, { min: 10, max: 5000, step: 10, unit: 'mm' })],
  },
  {
    id: 'image',
    label: 'Image',
    category: 'Drawing',
    parameters: [opacity('opacity', 'Opacity', 'New elements', ['board'], 1), color('missing.fill', 'Missing image', 'Fills', ['board'], '#eeeeee')],
  },
  {
    id: 'asset',
    label: 'Catalog asset',
    category: 'Assets',
    parameters: [
      color('missing.stroke', 'Missing definition', 'Lines', ['board'], '#d64545'),
      color('material.fallback', 'Fallback box', 'Materials', ['3d'], '#c9ccd3'),
      ...cutSurface('#c9ccd3'),
    ],
  },
  {
    id: 'measure',
    label: 'Measure',
    category: 'Annotation',
    parameters: [
      color('stroke', 'Colour', 'Lines', ['board'], '#2563eb'),
      width('tick.width', 'Tick weight', 'Lines', ['board'], 12),
      number('label.size', 'Label size', 'Symbol', ['board'], 150, { min: 40, max: 1000, step: 10, unit: 'mm' }),
    ],
  },
  {
    id: 'section-marker',
    label: 'Section marker',
    category: 'Annotation',
    parameters: [
      color('stroke', 'Colour', 'Lines', ['board'], '#2563eb'),
      width('width', 'Line weight', 'Lines', ['board'], 14),
      number('label.size', 'Label size', 'Symbol', ['board'], 130, { min: 40, max: 1000, step: 10, unit: 'mm' }),
      {
        id: 'symbol.arrowShape',
        label: 'Arrow shape',
        group: 'Symbol',
        kind: 'choice',
        views: ['board'],
        default: 'filled',
        options: [
          { value: 'filled', label: 'Filled triangle' },
          { value: 'outline', label: 'Outline triangle' },
          { value: 'chevron', label: 'Chevron' },
          { value: 'dot', label: 'Dot' },
        ],
      },
      toggle('symbol.arrows', 'Direction arrows and bubbles', 'Symbol', ['board'], true, { locked: 'The arrows and lettered bubbles are the section symbol.' }),
    ],
  },
  {
    id: 'camera-marker',
    label: 'Camera marker',
    category: 'Annotation',
    parameters: [
      color('stroke', 'Colour', 'Lines', ['board'], '#8b5cf6'),
      opacity('fov.opacity', 'Field of view shading', 'Fills', ['board'], 0.07),
      number('label.size', 'Label size', 'Symbol', ['board'], 140, { min: 40, max: 1000, step: 10, unit: 'mm' }),
    ],
  },
  {
    id: 'level',
    label: 'Level',
    category: 'Views',
    parameters: [
      color('fill', 'Fill', 'Fills', ['board'], '#dbeafe'),
      opacity('opacity', 'Opacity', 'Fills', ['board'], 0.24),
      color('stroke', 'Outline', 'Lines', ['board'], '#2563eb'),
      width('width', 'Line weight', 'Lines', ['board'], 12),
    ],
  },
  {
    id: 'paper',
    label: 'Paper',
    category: 'Views',
    parameters: [
      color('fill', 'Sheet', 'Fills', ['board'], '#ffffff'),
      color('border.stroke', 'Border', 'Lines', ['board'], '#8a8f98'),
      color('title.color', 'Title', 'Symbol', ['board'], LIGHT_INK),
      opacity('shadow.opacity', 'Shadow', 'Fills', ['board'], 0.08),
    ],
  },
  {
    id: 'section',
    label: 'Section view',
    category: 'Views',
    description: 'The section itself: background, lines beyond the cut and the cut outline shared by every type.',
    parameters: [
      color('background', 'Background', 'Scene', ['section'], '#fafafa'),
      toggle('beyond.visible', 'Edges beyond the cut', 'Beyond the cut', ['section'], true),
      color('beyond.stroke', 'Edge colour', 'Beyond the cut', ['section'], '#34363a'),
      opacity('beyond.opacity', 'Edge opacity', 'Beyond the cut', ['section'], 0.78),
      toggle('cut.outline.visible', 'Cut outline', 'Cut outline', ['section'], true, { locked: 'The cut outline separates what is cut from what lies beyond.' }),
      color('cut.outline.stroke', 'Cut outline colour', 'Cut outline', ['section'], HIDDEN_INK),
      { id: 'cut.outline.width', label: 'Cut outline weight', group: 'Cut outline', kind: 'width', views: ['section'], default: 2, min: 0.5, max: 12, step: 0.5, unit: 'px' },
      toggle('caps.visible', 'Cut surfaces', 'Cut surface', ['section'], true),
      ...cutSurface('#d9dbe0'),
    ],
  },
  {
    id: 'scene',
    label: '3D scene',
    category: 'Views',
    parameters: [
      color('background', 'Background', 'Scene', ['3d'], '#f3f4f6'),
      toggle('grid.visible', 'Ground grid', 'Scene', ['3d'], true),
      color('grid.color', 'Grid colour', 'Scene', ['3d'], '#c8cbd2'),
    ],
  },
];

export function graphicType(id: string): GraphicType | undefined {
  return GRAPHIC_TYPES.find((type) => type.id === id);
}

export function graphicParameter(typeId: string, parameterId: string): GraphicParameter | undefined {
  return graphicType(typeId)?.parameters.find((parameter) => parameter.id === parameterId);
}

/** Types listed under a category, in registry order. */
export function graphicTypesByCategory(): { category: GraphicCategory; types: GraphicType[] }[] {
  return GRAPHIC_CATEGORIES.map((category) => ({ category, types: GRAPHIC_TYPES.filter((type) => type.category === category) })).filter((entry) => entry.types.length > 0);
}

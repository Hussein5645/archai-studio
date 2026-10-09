/**
 * Built-in architecture tools (the toolbar's "Build" menu). They stay deliberately lightweight:
 * every tool emits plain primitives tagged with metadata — a wall is a thick polyline with
 * `meta.arch = { type: 'wall', thickness }`, a door is a template of lines — so the document
 * model needs no architectural element kinds.
 */
import type { JsonValue, Style } from '@/document/schema';
import type { SystemAssetType } from '@/catalog';
import { parseSystemParameters } from '@/catalog/system-schemas';
import { columnRect, doorTemplate, INK, templateBuilder, windowTemplate, type ArchTemplate } from './system-geometry';

export type { ArchTemplate };

export type ArchCategory = 'Openings' | 'Structure' | 'Circulation' | 'Envelope' | 'Spaces';

export interface ArchTool {
  /** Stable id; the tool id in the UI is `arch:<id>`. */
  id: string;
  label: string;
  description: string;
  /** Categories the tool is listed under (a tool may appear in more than one). */
  categories: ArchCategory[];
  shortcut?: string;
  /** Architectural type used by the selected-element system configuration panel. */
  systemType?: SystemAssetType;
  meta: Record<string, JsonValue>;
  mode:
    | { kind: 'polyline'; style: Style; closed?: boolean }
    | { kind: 'enclosure' }
    | { kind: 'place'; template: () => ArchTemplate }
    /** A parameter-sized rectangle (columns). */
    | { kind: 'rect' }
    /** Step-by-step stair drawing. */
    | { kind: 'stair' }
    /** Rectangular 2D extent with an elevation datum rendered in 3D. */
    | { kind: 'level' };
}

export const ARCH_CATEGORIES: ArchCategory[] = ['Structure', 'Openings', 'Circulation', 'Envelope', 'Spaces'];

export const facadeElement = (width = 1200, depth = 200): ArchTemplate => {
  const b = templateBuilder();
  b.rect(0, 0, width, depth, { fill: '#eef3fb', stroke: '#587099', strokeWidth: 18 });
  return b.done(width, depth);
};

const polyline = (strokeWidth: number, stroke = INK, closed = false, fill: string | null = null): ArchTool['mode'] => ({
  kind: 'polyline',
  style: { fill, stroke, strokeWidth, opacity: 1 },
  ...(closed ? { closed: true } : {}),
});

const DEFAULT_COLUMN = columnRect(parseSystemParameters('column', {}));

export const ARCH_TOOLS: readonly ArchTool[] = [
  {
    id: 'wall',
    label: 'Wall',
    description: 'Click to place wall corners (snaps to wall ends and faces); double-click or Enter to finish.',
    categories: ['Structure'],
    shortcut: 'W',
    systemType: 'wall',
    meta: { arch: { type: 'wall', thickness: 200 } },
    mode: polyline(200),
  },
  {
    id: 'door',
    label: 'Door',
    description: 'Places a 900 mm single door, aligned to a nearby wall with an opening.',
    categories: ['Openings'],
    shortcut: 'D',
    systemType: 'door',
    meta: { arch: { type: 'door', width: 900 } },
    mode: { kind: 'place', template: () => doorTemplate(parseSystemParameters('door', {})) },
  },
  {
    id: 'window',
    label: 'Window',
    description: 'Places a 1200 mm window, aligned to a nearby wall with an opening.',
    categories: ['Openings'],
    systemType: 'window',
    meta: { arch: { type: 'window', width: 1200 } },
    mode: { kind: 'place', template: () => windowTemplate(parseSystemParameters('window', {}), 150) },
  },
  {
    id: 'stairs',
    label: 'Stairs',
    description: 'Click the start, move to grow the run tread by tread, click to end; L adds a landing, Enter finishes early.',
    categories: ['Circulation'],
    systemType: 'stair',
    meta: { arch: { type: 'stair' } },
    mode: { kind: 'stair' },
  },
  {
    id: 'column',
    label: 'Column',
    description: `Places a ${DEFAULT_COLUMN.width} mm structural column centred on the click.`,
    categories: ['Structure'],
    systemType: 'column',
    meta: { arch: { type: 'column' } },
    mode: { kind: 'rect' },
  },
  {
    id: 'railing',
    label: 'Railing',
    description: 'Click to trace a railing path; double-click or Enter to finish.',
    categories: ['Circulation'],
    systemType: 'railing',
    meta: { arch: { type: 'railing' } },
    mode: polyline(80, '#6b6b72'),
  },
  {
    id: 'curtain-wall',
    label: 'Curtain wall',
    description: 'Click to trace a curtain-wall path; double-click or Enter to finish.',
    categories: ['Envelope'],
    systemType: 'curtain-wall',
    meta: { arch: { type: 'curtain-wall' } },
    mode: polyline(100, '#587099'),
  },
  {
    id: 'facade-element',
    label: 'Facade element',
    description: 'Places a facade element.',
    categories: ['Envelope'],
    systemType: 'facade-element',
    meta: { arch: { type: 'facade-element' } },
    mode: { kind: 'place', template: () => facadeElement() },
  },
  {
    id: 'level',
    label: 'Level',
    description: 'Drag a rectangle to define the level extent, then set its elevation in the Inspector.',
    categories: ['Spaces'],
    shortcut: 'Shift+L',
    meta: { level: { elevation: 0 } },
    mode: { kind: 'level' },
  },
  {
    id: 'room',
    label: 'Room',
    description: 'Click inside a closed wall or room-divider boundary to create a labelled room.',
    categories: ['Spaces'],
    meta: { arch: { type: 'room' } },
    mode: { kind: 'enclosure' },
  },
  {
    id: 'floor',
    label: 'Floor',
    description: 'Click inside a closed boundary, or draw a closed polygon and double-click or press Enter to finish.',
    categories: ['Spaces'],
    systemType: 'floor',
    meta: { arch: { type: 'floor', parameters: { thickness: 200, elevation: 0, material: 'concrete' } }, solid: { height: 200, elevation: 0 } },
    mode: { kind: 'enclosure' },
  },
  {
    id: 'ceiling',
    label: 'Ceiling',
    description: 'Click inside a closed boundary, or draw a closed polygon and double-click or press Enter to finish.',
    categories: ['Spaces'],
    systemType: 'ceiling',
    meta: { arch: { type: 'ceiling', parameters: { thickness: 100, elevation: 2700, material: 'generic' } }, solid: { height: 100, elevation: 2700 } },
    mode: { kind: 'enclosure' },
  },
  {
    id: 'room-divider',
    label: 'Room divider',
    description: 'Click to trace a lightweight room boundary; double-click or Enter to finish.',
    categories: ['Spaces'],
    meta: { arch: { type: 'room-divider' } },
    mode: polyline(24, '#8a8f98'),
  },
];

export function getArchTool(id: string): ArchTool | undefined {
  return ARCH_TOOLS.find((t) => t.id === id);
}

export function archToolsByCategory(): { category: ArchCategory; tools: ArchTool[] }[] {
  return ARCH_CATEGORIES.map((category) => ({
    category,
    tools: ARCH_TOOLS.filter((t) => t.categories.includes(category)),
  }));
}

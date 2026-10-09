/**
 * Diagram recipes: one click turns a view frame into a presentation diagram by setting its
 * per-element overrides, image adjustments and render style. Everything a recipe sets stays
 * editable afterwards (it is ordinary frame styling).
 */
import { archTypeOf } from '@/assets/arch-meta';
import type { ArchaiDocument, Element } from '@/document';
import { NEUTRAL_ADJUSTMENTS, type FrameStyling, type SheetViewMeta, type ViewOverride } from './model';

export const DIAGRAM_RECIPES = ['massing', 'zoning', 'circulation', 'structure', 'exploded', 'clear'] as const;
export type DiagramRecipe = (typeof DIAGRAM_RECIPES)[number];

export const RECIPE_LABELS: Record<DiagramRecipe, { label: string; description: string }> = {
  massing: { label: 'Massing', description: 'White model, grey lines, soft shading' },
  zoning: { label: 'Zoning', description: 'Rooms coloured by name and labelled, walls dark' },
  circulation: { label: 'Circulation', description: 'Stairs, doors and railings pop out, the rest fades' },
  structure: { label: 'Structure', description: 'Walls and columns in blue, the rest fades' },
  exploded: { label: 'Exploded axon', description: 'Levels lifted apart (3D views)' },
  clear: { label: 'Clear styling', description: 'Back to the view as drawn' },
};

/** Soft, print-friendly program colours (distinct in greyscale too). */
export const ZONE_PALETTE = ['#fde68a', '#bfdbfe', '#bbf7d0', '#fecaca', '#ddd6fe', '#fed7aa', '#a5f3fc', '#fbcfe8', '#d9f99d', '#e5e7eb'];

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The colour a room gets in zoning diagrams: same name, same colour, on every sheet. */
export function zoneColor(name: string): string {
  return ZONE_PALETTE[hash(name.trim().toLowerCase()) % ZONE_PALETTE.length]!;
}

function levelLifts(doc: ArchaiDocument): Map<string, number> {
  const levels = Object.values(doc.elements)
    .filter((element) => element.meta?.['level'])
    .map((element) => ({ id: element.id, elevation: Number((element.meta!['level'] as { elevation?: number }).elevation ?? 0) }))
    .sort((a, b) => a.elevation - b.elevation);
  // Each level rises by one storey height more than the last (at least 4 m), so gaps open up.
  const lifts = new Map<string, number>();
  levels.forEach((level, index) => {
    const next = levels[index + 1];
    const storey = next ? Math.max(3000, next.elevation - level.elevation) : 3000;
    lifts.set(level.id, index * Math.max(4000, storey * 1.4));
  });
  return lifts;
}

function levelOf(element: Element): string | null {
  const constraint = element.meta?.['levelConstraint'];
  return constraint && typeof constraint === 'object' && !Array.isArray(constraint) && typeof (constraint as { levelId?: unknown }).levelId === 'string' ? (constraint as { levelId: string }).levelId : null;
}

/**
 * The styling a recipe gives a frame. `ids` are the elements the frame shows (for 3D frames,
 * every element). Throws a message for recipes that do not apply to the frame.
 */
export function recipeStyling(recipe: DiagramRecipe, doc: ArchaiDocument, view: SheetViewMeta, ids: readonly string[]): FrameStyling {
  const is3d = view.source === 'view';
  const overrides: Record<string, ViewOverride> = {};
  const adjustments = { ...NEUTRAL_ADJUSTMENTS };
  let style: FrameStyling['style'] = null;
  const each = (fn: (element: Element, type: string | null) => ViewOverride | null) => {
    for (const id of ids) {
      const element = doc.elements[id];
      if (!element) continue;
      const o = fn(element, archTypeOf(element));
      if (o) overrides[id] = o;
    }
  };
  switch (recipe) {
    case 'clear':
      return { overrides: {}, adjustments, style: null };
    case 'massing':
      style = 'shaded';
      adjustments.background = '#ffffff';
      each((_, type) => (type === 'room' ? { fill: '#f8fafc' } : type ? { fill: '#ffffff', stroke: '#6b7280' } : null));
      break;
    case 'zoning':
      style = 'consistent';
      each((element, type) => {
        if (type === 'room') return { fill: zoneColor(element.name ?? 'Room'), ...(element.name ? { label: element.name } : {}) };
        if (type === 'wall' || type === 'column' || type === 'curtain-wall') return { fill: '#374151', stroke: '#374151' };
        return { visibility: 'ghost' };
      });
      break;
    case 'circulation':
      style = 'consistent';
      adjustments.fadeOthers = true;
      each((_, type) => (type === 'stair' || type === 'railing' || type === 'door' ? { fill: '#fb923c', stroke: '#c2410c', emphasis: 'outline', accent: '#c2410c' } : null));
      break;
    case 'structure':
      style = 'shaded';
      adjustments.fadeOthers = true;
      each((_, type) => (type === 'wall' || type === 'column' ? { fill: '#3b82f6', stroke: '#1e3a8a' } : null));
      break;
    case 'exploded': {
      if (!is3d) throw new Error('Exploded axonometrics need a 3D view frame');
      style = 'shaded';
      adjustments.background = '#ffffff';
      const lifts = levelLifts(doc);
      each((element) => {
        const level = levelOf(element);
        const lift = level ? (lifts.get(level) ?? 0) : 0;
        return lift ? { lift } : null;
      });
      break;
    }
  }
  return { overrides, adjustments, style: is3d ? style : null };
}

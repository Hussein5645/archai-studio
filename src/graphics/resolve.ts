/**
 * Resolves a graphic parameter: for Hidden line, the document override (including legacy
 * all-style overrides), then the registry default. Resolvers are cached per
 * overrides object so renderers can call them freely.
 */
import type { Element, JsonValue } from '@/document/schema';
import { graphicParameter, graphicType, type GraphicParameter, type GraphicValue, type GraphicView, type GraphicsOverrides, type HatchPattern, type TextColorMapping } from './schema';

export const ALL_STYLES = '*';

export interface GraphicsResolver {
  get(type: string, view: GraphicView, style: string, id: string): GraphicValue;
  color(type: string, view: GraphicView, style: string, id: string): string | null;
  number(type: string, view: GraphicView, style: string, id: string): number;
  bool(type: string, view: GraphicView, style: string, id: string): boolean;
  hatch(type: string, view: GraphicView, style: string, id: string): HatchPattern;
  colorMap(type: string, view: GraphicView, style: string, id: string): readonly TextColorMapping[];
  /** Whether the document overrides this parameter for the style (or for all styles). */
  overridden(type: string, view: GraphicView, style: string, id: string): boolean;
  readonly overrides: GraphicsOverrides;
}

export interface ElementGraphicsResolver {
  get(id: string): GraphicValue;
  color(id: string): string | null;
  number(id: string): number;
  bool(id: string): boolean;
  hatch(id: string): HatchPattern;
  colorMap(id: string): readonly TextColorMapping[];
  overridden(id: string): boolean;
}

const EMPTY: GraphicsOverrides = {};
const cache = new WeakMap<GraphicsOverrides, GraphicsResolver>();

function readOverride(overrides: GraphicsOverrides, type: string, view: GraphicView, style: string, id: string): JsonValue | undefined {
  // Element graphics are a Hidden line presentation override. Older documents stored the
  // same values under `*`; keep those settings working, but never leak them into other styles.
  if (style !== 'hidden-line') return undefined;
  const byView = overrides[type]?.[view];
  if (!byView) return undefined;
  const specific = byView['hidden-line']?.[id];
  if (specific !== undefined) return specific;
  return byView[ALL_STYLES]?.[id];
}

function defaultOf(parameter: GraphicParameter, style: string): GraphicValue {
  return typeof parameter.default === 'function' ? parameter.default(style) : parameter.default;
}

/** Whether `value` is acceptable for the parameter (colours are hex, numbers finite and in range). */
export function validGraphicValue(parameter: GraphicParameter, value: unknown): value is GraphicValue {
  switch (parameter.kind) {
    case 'color':
      if (value === null) return Boolean(parameter.allowNone);
      return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value);
    case 'toggle':
      return typeof value === 'boolean';
    case 'hatch':
    case 'choice':
      return typeof value === 'string' && (parameter.options?.some((option) => option.value === value) ?? true);
    case 'text-color-map':
      return (
        Array.isArray(value) &&
        value.length <= 100 &&
        value.every(
          (entry) =>
            entry !== null &&
            typeof entry === 'object' &&
            !Array.isArray(entry) &&
            typeof entry['text'] === 'string' &&
            entry['text'].length <= 200 &&
            typeof entry['color'] === 'string' &&
            /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(entry['color']),
        )
      );
    case 'width':
    case 'number':
    case 'opacity': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      if (parameter.min !== undefined && value < parameter.min) return false;
      if (parameter.max !== undefined && value > parameter.max) return false;
      return true;
    }
  }
}

export function graphicsResolver(overrides: GraphicsOverrides | undefined): GraphicsResolver {
  const source = overrides ?? EMPTY;
  const cached = cache.get(source);
  if (cached) return cached;
  const memo = new Map<string, GraphicValue>();
  const get = (type: string, view: GraphicView, style: string, id: string): GraphicValue => {
    const key = `${type}|${view}|${style}|${id}`;
    const hit = memo.get(key);
    if (hit !== undefined || memo.has(key)) return hit ?? null;
    const parameter = graphicParameter(type, id);
    let value: GraphicValue = null;
    if (parameter) {
      const supportsStyle = !parameter.styles || parameter.styles.includes(style as never);
      const override = parameter.locked || !supportsStyle ? undefined : readOverride(source, type, view, style, id);
      value = override !== undefined && validGraphicValue(parameter, override) ? override : defaultOf(parameter, style);
    }
    memo.set(key, value);
    return value;
  };
  const resolver: GraphicsResolver = {
    overrides: source,
    get,
    color: (type, view, style, id) => {
      const value = get(type, view, style, id);
      return typeof value === 'string' ? value : null;
    },
    number: (type, view, style, id) => {
      const value = get(type, view, style, id);
      return typeof value === 'number' ? value : 0;
    },
    bool: (type, view, style, id) => get(type, view, style, id) === true,
    hatch: (type, view, style, id) => {
      const value = get(type, view, style, id);
      return value === 'diagonal' || value === 'cross' || value === 'dots' ? value : 'none';
    },
    colorMap: (type, view, style, id) => {
      const value = get(type, view, style, id);
      return Array.isArray(value) ? value : [];
    },
    overridden: (type, view, style, id) => readOverride(source, type, view, style, id) !== undefined,
  };
  cache.set(source, resolver);
  return resolver;
}

/** Flat Hidden-line overrides stored on one element. Invalid or stale values are ignored. */
export function elementGraphicOverrides(element: Element | undefined | null): Record<string, JsonValue> {
  const graphics = element?.meta?.['graphics'];
  if (!graphics || typeof graphics !== 'object' || Array.isArray(graphics)) return {};
  const hidden = graphics['hiddenLine'];
  return hidden && typeof hidden === 'object' && !Array.isArray(hidden) ? (hidden as Record<string, JsonValue>) : {};
}

/** Individual element → type setting → built-in default, scoped strictly to Hidden line. */
export function graphicsForElement(resolver: GraphicsResolver, element: Element, type: string, view: GraphicView, style: string): ElementGraphicsResolver {
  const own = style === 'hidden-line' ? elementGraphicOverrides(element) : {};
  const get = (id: string): GraphicValue => {
    const parameter = graphicParameter(type, id);
    const value = own[id];
    return parameter && !parameter.locked && value !== undefined && validGraphicValue(parameter, value) ? value : resolver.get(type, view, style, id);
  };
  return {
    get,
    color: (id) => {
      const value = get(id);
      return typeof value === 'string' ? value : null;
    },
    number: (id) => {
      const value = get(id);
      return typeof value === 'number' ? value : 0;
    },
    bool: (id) => get(id) === true,
    hatch: (id) => {
      const value = get(id);
      return value === 'diagonal' || value === 'cross' || value === 'dots' ? value : 'none';
    },
    colorMap: (id) => {
      const value = get(id);
      return Array.isArray(value) ? value : [];
    },
    overridden: (id) => own[id] !== undefined,
  };
}

export function resolveGraphic(overrides: GraphicsOverrides | undefined, type: string, view: GraphicView, style: string, id: string): GraphicValue {
  return graphicsResolver(overrides).get(type, view, style, id);
}

/** Whether the document overrides anything for a type (any view or style). */
export function typeHasOverrides(overrides: GraphicsOverrides | undefined, type: string): boolean {
  const byView = overrides?.[type];
  if (!byView) return false;
  return Object.values(byView).some((byStyle) => Object.values(byStyle).some((values) => Object.keys(values).length > 0));
}

/** Drops empty style/view/type records so the stored overrides stay minimal. */
export function pruneOverrides(overrides: GraphicsOverrides): void {
  for (const [type, byView] of Object.entries(overrides)) {
    for (const [view, byStyle] of Object.entries(byView)) {
      for (const [style, values] of Object.entries(byStyle)) if (Object.keys(values).length === 0) delete byStyle[style];
      if (Object.keys(byStyle).length === 0) delete byView[view];
    }
    if (Object.keys(byView).length === 0) delete overrides[type];
  }
}

/**
 * Base defaults for a new drawing element (rect / line / text / image). Hidden-line document
 * overrides are intentionally applied at render time instead, so they affect old and new items.
 */
export function newElementGraphics(overrides: GraphicsOverrides | undefined, type: 'rect' | 'line' | 'text' | 'image'): Record<string, GraphicValue> {
  void overrides;
  const result: Record<string, GraphicValue> = {};
  for (const parameter of graphicType(type)?.parameters ?? []) {
    if (parameter.group !== 'New elements') continue;
    // Hidden-line overrides are applied at render time to every existing and new element;
    // they must not be baked into an element and then appear in the other view styles.
    result[parameter.id] = defaultOf(parameter, 'realistic');
  }
  return result;
}

/** Style for a new rect/line from the type's defaults (typed for the document's `Style`). */
export function newElementStyle(overrides: GraphicsOverrides | undefined, type: 'rect' | 'line'): { fill?: string | null; stroke?: string | null; strokeWidth?: number; opacity?: number } {
  const values = newElementGraphics(overrides, type);
  const style: { fill?: string | null; stroke?: string | null; strokeWidth?: number; opacity?: number } = {};
  if (typeof values['fill'] === 'string' || values['fill'] === null) style.fill = values['fill'];
  if (typeof values['stroke'] === 'string' || values['stroke'] === null) style.stroke = values['stroke'];
  if (typeof values['strokeWidth'] === 'number') style.strokeWidth = values['strokeWidth'];
  if (typeof values['opacity'] === 'number') style.opacity = values['opacity'];
  return style;
}

import type { ArchaiDocument, Element } from './index';

export const viewContext = (id: string | null) => `view:${id ?? 'workspace'}`;
export function visibleInContext(element: Element, context: string): boolean {
  const overrides = element.meta?.['visibilityByContext'];
  const value =
    overrides && typeof overrides === 'object' && !Array.isArray(overrides)
      ? overrides[context]
      : undefined;
  return typeof value === 'boolean' ? value : element.visible;
}

const cache = new WeakMap<ArchaiDocument, Map<string, ArchaiDocument>>();
/** A stable display-only projection. The source and other views are never mutated. */
export function documentInContext(doc: ArchaiDocument, context: string): ArchaiDocument {
  let contexts = cache.get(doc);
  if (!contexts) {
    contexts = new Map();
    cache.set(doc, contexts);
  }
  const saved = contexts.get(context);
  if (saved) return saved;
  let changed = false;
  const elements = Object.fromEntries(
    Object.entries(doc.elements).map(([id, element]) => {
      const visible = visibleInContext(element, context);
      if (visible === element.visible) return [id, element];
      changed = true;
      return [id, { ...element, visible }];
    }),
  );
  const result = changed ? { ...doc, elements } : doc;
  contexts.set(context, result);
  return result;
}

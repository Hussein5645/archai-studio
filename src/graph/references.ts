import type { Element, ElementTable } from '@/document';
import { layerChildrenOf, layerParentOf } from '@/layers/hierarchy';

/** Follow the hierarchy visible in Layers, including hosted elements and origin children. */
export function graphReferenceElements(elements: ElementTable, componentId: string): Element[] {
  const result: Element[] = [];
  const seen = new Set<string>([componentId]);
  const visit = (parent: string) => {
    for (const id of layerChildrenOf(elements, parent)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const element = elements[id]!;
      const arch = elements[parent]?.meta?.['arch'] as { type?: string } | undefined;
      if (arch?.type === 'stair' && typeof element.meta?.['role'] === 'string') continue;
      if (!element.meta?.['parametricMarker']) result.push(element);
      visit(id);
    }
  };
  visit(componentId);
  return result;
}

export function graphReferenceLabel(elements: ElementTable, componentId: string, element: Element): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let current: Element | undefined = element;
  while (current && current.id !== componentId && !seen.has(current.id)) {
    seen.add(current.id);
    if (!current.meta?.['parametricMarker']) names.unshift(current.name?.trim() || current.kind);
    const parent = layerParentOf(elements, current.id);
    current = parent ? elements[parent] : undefined;
  }
  return names.join(' / ');
}

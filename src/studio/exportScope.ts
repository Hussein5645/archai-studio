import type { ArchaiDocument } from '@/document';
/** Include selected subtrees and their containers; retain full document context for wall openings. */
export function exportScope(doc: ArchaiDocument, selected: readonly string[]): (id: string) => boolean {
  const selectedSet = new Set(selected);
  const containers = new Set<string>();
  for (const id of selected) {
    let parent = doc.elements[id]?.parentId;
    while (parent) { if (containers.has(parent)) break; containers.add(parent); parent = doc.elements[parent]?.parentId; }
  }
  return (id) => {
    if (containers.has(id)) return true;
    let current: string | null | undefined = id;
    while (current) { if (selectedSet.has(current)) return true; current = doc.elements[current]?.parentId; }
    return false;
  };
}

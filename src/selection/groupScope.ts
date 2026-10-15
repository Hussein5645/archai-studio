import { ancestorsOf, isAncestor, isEffectivelyLocked, isEffectivelyVisible, type Element, type ElementTable } from '@/document';
import type { UiState } from '@/store';

export function editableGroup(element: Element | undefined): boolean {
  return element?.kind === 'group' && !element.meta?.['parametricGraph'] && !element.meta?.['viewRig'] && !element.meta?.['annotationLayer'];
}

export function activeGroup(elements: ElementTable, ui: Pick<UiState, 'groupEditId'>): string | null {
  const id = ui.groupEditId;
  return id && editableGroup(elements[id]) ? id : null;
}

export function selectionScope(ui: Pick<UiState, 'groupEditId' | 'sheet'>): string | null {
  return ui.groupEditId ?? ui.sheet?.paperId ?? null;
}

export function inGroup(elements: ElementTable, groupId: string | null, id: string): boolean {
  return !groupId || (id !== groupId && isAncestor(elements, groupId, id));
}

export function groupPath(elements: ElementTable, id: string | null): Element[] {
  if (!id || !elements[id]) return [];
  return [...ancestorsOf(elements, id)].reverse().filter(editableGroup).concat(elements[id]!);
}

/** Keep transient isolation valid after delete, undo/redo, remote edits, and document switches. */
export function reconcileGroupScope(ui: UiState, elements: ElementTable): UiState {
  const id = activeGroup(elements, ui);
  const valid = id && !isEffectivelyLocked(elements, id) && isEffectivelyVisible(elements, id) && (!ui.sheet || isAncestor(elements, ui.sheet.paperId, id)) ? id : null;
  const selection = valid ? ui.selection.filter((item) => inGroup(elements, valid, item)) : ui.selection;
  return valid !== ui.groupEditId || selection.length !== ui.selection.length ? { ...ui, groupEditId: valid, selection } : ui;
}

/**
 * Which map is having its site boundary edited on the board. Transient UI, so it stays out of the
 * document and the store; the map node and the Inspector share it.
 */
import { useSyncExternalStore } from 'react';

let editingId: string | null = null;
const listeners = new Set<() => void>();

export function setBoundaryEditing(id: string | null): void {
  if (editingId === id) return;
  editingId = id;
  for (const listener of listeners) listener();
}

export function boundaryEditingId(): string | null {
  return editingId;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useBoundaryEditing(): string | null {
  return useSyncExternalStore(subscribe, boundaryEditingId, boundaryEditingId);
}

// ---- site concept editor ---------------------------------------------------------------------

let conceptId: string | null = null;
const conceptListeners = new Set<() => void>();

/** Opens (map id) or closes (null) the full-screen site concept editor. */
export function setConceptEditor(id: string | null): void {
  if (conceptId === id) return;
  conceptId = id;
  for (const listener of conceptListeners) listener();
}

function subscribeConcept(listener: () => void) {
  conceptListeners.add(listener);
  return () => { conceptListeners.delete(listener); };
}

export function useConceptEditor(): string | null {
  return useSyncExternalStore(subscribeConcept, () => conceptId, () => conceptId);
}

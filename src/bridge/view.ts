/**
 * Live Bridge display preferences on this device: whether the board tints each connected app's
 * elements with its colour. Kept in localStorage (a convenience, not project data).
 */
import { useSyncExternalStore } from 'react';

const KEY = 'archai:bridge:colours';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

let showColours = read();

export const bridgeView = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  showColours: () => showColours,
  setShowColours(value: boolean): void {
    showColours = value;
    try {
      localStorage.setItem(KEY, value ? '1' : '0');
    } catch {
      // private window: for this session only
    }
    for (const listener of listeners) listener();
  },
};

export function useBridgeColours(): boolean {
  return useSyncExternalStore(bridgeView.subscribe, bridgeView.showColours, bridgeView.showColours);
}

/** Facet names as people say them. */
export const FACET_LABELS = { geometry: 'Shape', transform: 'Position', material: 'Material', metadata: 'Name and data' } as const;

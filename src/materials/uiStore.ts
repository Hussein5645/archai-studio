/**
 * View state of the material tools, shared by the Materials panel, the material editor, the
 * Inspector and the 3D paint tool: the material in hand (what painting applies), the material
 * open in the editor and whether the 3D paint tool is on. Not part of the document or undo.
 */
import { useSyncExternalStore } from 'react';

export interface MaterialUiState {
  /** Material in hand for painting, drag and drop and the Inspector's quick assign. */
  active: string | null;
  /** Material open in the editor dialog. */
  editing: string | null;
  /** The 3D paint tool is on. */
  painting: boolean;
  /** What a paint click changes: a face, the part, the whole object, or that material everywhere. */
  scope: PaintScope;
  /** The 3D pick tool is on: a click picks the material under the cursor and opens its quick panel. */
  picking: boolean;
  /** The material whose quick panel (MaterialAdjust) is open, and what it was picked from. */
  adjusting: { materialId: string; target: PickedTarget | null } | null;
}

/** A clicked surface (the 3D view's SurfaceTarget, kept free of three.js here). */
export interface PickedTarget {
  elementId: string;
  slot: string | null;
  surface: string | null;
  materialId: string | null;
}

export type PaintScope = 'face' | 'part' | 'object' | 'everywhere';

let state: MaterialUiState = { active: null, editing: null, painting: false, scope: 'face', picking: false, adjusting: null };
const listeners = new Set<() => void>();

export const materialUi = {
  get: (): MaterialUiState => state,
  set(patch: Partial<MaterialUiState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useMaterialUi(): MaterialUiState {
  return useSyncExternalStore(materialUi.subscribe, materialUi.get, materialUi.get);
}

/** Drag-and-drop data type of a material swatch (its id). */
export const MATERIAL_DRAG_TYPE = 'application/x-archai-material';
/** Drag-and-drop data type of a library / My materials entry not in the project yet (JSON { kind, id }). */
export const LIBRARY_DRAG_TYPE = 'application/x-archai-library-material';

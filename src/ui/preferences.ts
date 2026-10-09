/**
 * App preferences of this device (not of the document): UI scale, mouse wheel behaviour and pen
 * palm rejection. Kept in localStorage and readable outside React (the board's wheel handler
 * and palm rejection read them on every event). Language and touch mode keep their own
 * providers (./i18n, ./touch); the Settings dialog shows all of them together.
 *
 * UI scale zooms the app's chrome (bars, panels, menus, dialogs) with CSS `zoom` through the
 * `--ui-scale` custom property; the board itself stays 1:1 so its pointer maths is untouched.
 */
import { useSyncExternalStore } from 'react';

export interface Preferences {
  /** 0.8 .. 1.5 */
  uiScale: number;
  /** Plain mouse wheel: pan (trackpads) or zoom (CAD mice). Ctrl / Cmd + wheel does the other. */
  wheel: 'pan' | 'zoom';
  /** After the pen touches the screen, fingers only pan and zoom for a few seconds. */
  palmRejection: boolean;
}

export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 1.5;
export const UI_SCALE_PRESETS = [0.9, 1, 1.1, 1.25, 1.5] as const;

export const DEFAULT_PREFERENCES: Preferences = { uiScale: 1, wheel: 'pan', palmRejection: true };

const STORAGE_KEY = 'archai.preferences';

function clampScale(value: number): number {
  return Number.isFinite(value) ? Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Math.round(value * 100) / 100)) : 1;
}

function read(): Preferences {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Preferences>;
    return {
      uiScale: clampScale(typeof raw.uiScale === 'number' ? raw.uiScale : 1),
      wheel: raw.wheel === 'zoom' ? 'zoom' : 'pan',
      palmRejection: raw.palmRejection !== false,
    };
  } catch {
    // Storage can be unavailable (private mode) or hold junk: defaults.
    return { ...DEFAULT_PREFERENCES };
  }
}

let current: Preferences = typeof window === 'undefined' ? { ...DEFAULT_PREFERENCES } : read();
const listeners = new Set<() => void>();

function apply(preferences: Preferences): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty('--ui-scale', String(preferences.uiScale));
}
apply(current);

export const preferences = {
  get: (): Preferences => current,
  set(patch: Partial<Preferences>): void {
    const next = { ...current, ...patch };
    next.uiScale = clampScale(next.uiScale);
    current = next;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    } catch {
      // Not persisted this session; the change still applies.
    }
    apply(current);
    for (const listener of listeners) listener();
  },
  reset(): void {
    this.set({ ...DEFAULT_PREFERENCES });
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function usePreferences(): Preferences {
  return useSyncExternalStore(preferences.subscribe, preferences.get, preferences.get);
}

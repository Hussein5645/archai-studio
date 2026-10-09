/**
 * On-screen stand-ins for held modifier keys, for touch screens without a keyboard. The board
 * and the modeling workspace read them alongside the real keys, so a toggle behaves exactly like
 * holding Shift (straight lines / axis lock), Alt (no snapping) or Ctrl/Shift for selection.
 *
 * Each toggle is off, on for the next action (`once`, then it switches itself off), or locked
 * on until tapped again. Ephemeral input state, like a held key: never stored or undoable.
 */
import { preferences } from '@/ui/preferences';
import { useSyncExternalStore } from 'react';

export type ModifierState = 'off' | 'once' | 'locked';

export interface TouchModifiers {
  /** Straight lines / 15° steps / proportional resize: what holding Shift does. */
  straight: ModifierState;
  /** Place freely, ignoring grid and snaps: what holding Alt does. */
  snapOff: ModifierState;
  /** Taps add to (or remove from) the selection instead of replacing it. */
  additive: ModifierState;
  /** One-finger drags on empty space draw a selection box instead of panning. */
  selectArea: ModifierState;
}

export type ModifierName = keyof TouchModifiers;

const OFF: TouchModifiers = { straight: 'off', snapOff: 'off', additive: 'off', selectArea: 'off' };

let current: TouchModifiers = OFF;
const listeners = new Set<() => void>();

function set(next: TouchModifiers): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export const touchModifiers = {
  get: (): TouchModifiers => current,

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** A tap: off → on for one action; on (either way) → off. */
  toggle(name: ModifierName): void {
    set({ ...current, [name]: current[name] === 'off' ? 'once' : 'off' });
  },

  /** A long-press: stays on until tapped again. */
  lock(name: ModifierName): void {
    set({ ...current, [name]: 'locked' });
  },

  /** Ends the action the `once` toggles applied to. */
  consumeOnce(): void {
    if (!Object.values(current).includes('once')) return;
    const next = { ...current };
    for (const name of Object.keys(next) as ModifierName[]) if (next[name] === 'once') next[name] = 'off';
    set(next);
  },

  reset(): void {
    set(OFF);
  },
};

export const isOn = (state: ModifierState): boolean => state !== 'off';

/** Real keys combined with the on-screen toggles. */
export interface EffectiveModifiers {
  shift: boolean;
  alt: boolean;
  /** Add to / toggle the selection (Shift, Ctrl or Cmd, or the Add toggle). */
  additive: boolean;
}

export function effectiveModifiers(event: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): EffectiveModifiers {
  const toggles = current;
  return {
    shift: event.shiftKey || isOn(toggles.straight),
    alt: event.altKey || isOn(toggles.snapOff),
    additive: event.shiftKey || event.ctrlKey || event.metaKey || isOn(toggles.additive),
  };
}

export function useTouchModifiers(): TouchModifiers {
  return useSyncExternalStore(touchModifiers.subscribe, touchModifiers.get, touchModifiers.get);
}

// ---- stylus palm rejection -----------------------------------------------------------------

const PEN_GRACE_MS = 4000;
let lastPenAt = -Infinity;

/**
 * Tracks the pointer type: after a pen touched the screen, fingers only navigate (pan/zoom)
 * for a few seconds, so a palm resting on the screen while drawing cannot draw or select.
 * Returns true when this pointer should only navigate.
 */
export function fingerOnlyNavigates(event: { pointerType: string; timeStamp: number }): boolean {
  if (event.pointerType === 'pen') {
    lastPenAt = event.timeStamp;
    return false;
  }
  if (!preferences.get().palmRejection) return false;
  return event.pointerType === 'touch' && event.timeStamp - lastPenAt < PEN_GRACE_MS;
}

/**
 * Palm rejection for one drawing surface. While a pen is on the screen, touches are ignored
 * entirely (down, moves and up), so a resting palm can neither draw, finish nor cancel the pen's
 * gesture; shortly after the pen lifts, fingers only navigate.
 */
export class PalmRejection {
  private readonly pens = new Set<number>();
  private readonly ignored = new Set<number>();

  /** On pointerdown: 'ignore' (a palm under the pen), 'navigate' (a finger right after the pen) or null. */
  down(event: { pointerId: number; pointerType: string; timeStamp: number }): 'ignore' | 'navigate' | null {
    if (event.pointerType === 'pen') this.pens.add(event.pointerId);
    const navigateOnly = fingerOnlyNavigates(event);
    if (navigateOnly && this.pens.size > 0) {
      this.ignored.add(event.pointerId);
      return 'ignore';
    }
    return navigateOnly ? 'navigate' : null;
  }

  /** On pointermove: whether this pointer is being ignored. */
  ignores(event: { pointerId: number }): boolean {
    return this.ignored.has(event.pointerId);
  }

  /** On pointerup/cancel: whether it was ignored; forgets the pointer either way. */
  up(event: { pointerId: number }): boolean {
    this.pens.delete(event.pointerId);
    return this.ignored.delete(event.pointerId);
  }
}

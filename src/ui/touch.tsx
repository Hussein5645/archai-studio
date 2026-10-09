import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type TouchModeSetting = 'auto' | 'on' | 'off';

interface TouchModeContextValue {
  touchMode: TouchModeSetting;
  setTouchMode: (mode: TouchModeSetting) => void;
  /** The effective mode: the setting, or for `auto` whichever input was used last. */
  isTouch: boolean;
}

const TouchModeContext = createContext<TouchModeContextValue | null>(null);
const STORAGE_KEY = 'archai.touchMode';

/**
 * Whether touch is the primary way of pointing at this device: the primary pointer is coarse
 * (tablets, kiosks), or the device has a touch screen and no mouse/trackpad at all. A touch
 * laptop with a mouse starts in mouse mode; `auto` then follows the first finger that touches.
 */
function prefersTouch(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  if (window.matchMedia('(pointer: coarse)').matches) return true;
  const hasTouchScreen = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  return hasTouchScreen && !window.matchMedia('(any-pointer: fine)').matches;
}

function readSetting(): TouchModeSetting {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'on' || saved === 'off') return saved;
  } catch {
    // Storage can be unavailable (private mode); fall through to the default.
  }
  return 'auto';
}

export function TouchModeProvider({ children }: { children: ReactNode }) {
  const [touchMode, setTouchModeState] = useState<TouchModeSetting>(readSetting);
  // What `auto` resolves to: starts from the device's primary pointer, then follows the input
  // actually in use, so a touch laptop switches when a finger or a mouse is used.
  const [lastInputTouch, setLastInputTouch] = useState(prefersTouch);

  useEffect(() => {
    if (touchMode !== 'auto') return;
    const onPointer = (e: PointerEvent) => {
      if (e.pointerType === 'touch') setLastInputTouch(true);
      else if (e.pointerType === 'mouse') setLastInputTouch(false);
      // Pens keep whatever mode is active: they are precise, but often used on touch tablets.
    };
    // `pointerdown` catches taps; `pointermove` catches a mouse being picked up again without
    // a click (touch screens do not emit hover moves).
    window.addEventListener('pointerdown', onPointer, { passive: true, capture: true });
    window.addEventListener('pointermove', onPointer, { passive: true, capture: true });
    return () => {
      window.removeEventListener('pointerdown', onPointer, { capture: true });
      window.removeEventListener('pointermove', onPointer, { capture: true });
    };
  }, [touchMode]);

  const isTouch = touchMode === 'on' ? true : touchMode === 'off' ? false : lastInputTouch;

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, touchMode);
    } catch {
      // Ignore: the setting simply will not persist.
    }
  }, [touchMode]);

  useEffect(() => {
    document.documentElement.setAttribute('data-touch', isTouch ? 'true' : 'false');
    document.body?.classList.toggle('touch-mode', isTouch);
  }, [isTouch]);

  const value = useMemo<TouchModeContextValue>(
    () => ({ touchMode, setTouchMode: setTouchModeState, isTouch }),
    [touchMode, isTouch],
  );

  return <TouchModeContext.Provider value={value}>{children}</TouchModeContext.Provider>;
}

export function useTouchMode(): TouchModeContextValue {
  const value = useContext(TouchModeContext);
  if (!value) {
    return { touchMode: 'auto', setTouchMode: () => {}, isTouch: prefersTouch() };
  }
  return value;
}


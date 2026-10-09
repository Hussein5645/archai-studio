import { afterEach, describe, expect, it } from 'vitest';
import { effectiveModifiers, PalmRejection, touchModifiers } from './touchModifiers';

const keys = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };

describe('touch modifier toggles', () => {
  afterEach(() => touchModifiers.reset());

  it('stand in for held keys: once for the next action, locked until tapped off', () => {
    expect(effectiveModifiers(keys)).toEqual({ shift: false, alt: false, additive: false });
    touchModifiers.toggle('straight');
    touchModifiers.lock('snapOff');
    expect(effectiveModifiers(keys)).toEqual({ shift: true, alt: true, additive: false });
    touchModifiers.consumeOnce();
    // The one-shot toggle is spent; the locked one stays.
    expect(effectiveModifiers(keys)).toEqual({ shift: false, alt: true, additive: false });
    touchModifiers.toggle('snapOff');
    expect(touchModifiers.get().snapOff).toBe('off');
  });

  it('keep selection-adding separate from Shift-as-straight', () => {
    touchModifiers.toggle('additive');
    expect(effectiveModifiers(keys)).toEqual({ shift: false, alt: false, additive: true });
    // Real keys still count.
    touchModifiers.reset();
    expect(effectiveModifiers({ ...keys, ctrlKey: true }).additive).toBe(true);
  });
});

describe('palm rejection', () => {
  const pen = (pointerId: number, timeStamp: number) => ({ pointerId, pointerType: 'pen', timeStamp });
  const finger = (pointerId: number, timeStamp: number) => ({ pointerId, pointerType: 'touch', timeStamp });

  it('ignores a palm while the pen is down, then lets fingers only navigate for a moment', () => {
    const palm = new PalmRejection();
    expect(palm.down(finger(1, 1000))).toBeNull(); // no pen yet: fingers work normally
    palm.up(finger(1, 1000));
    expect(palm.down(pen(2, 2000))).toBeNull();
    expect(palm.down(finger(3, 2100))).toBe('ignore');
    expect(palm.ignores({ pointerId: 3 })).toBe(true);
    expect(palm.up({ pointerId: 3 })).toBe(true);
    palm.up({ pointerId: 2 }); // pen lifted
    expect(palm.down(finger(4, 3000))).toBe('navigate');
    palm.up({ pointerId: 4 });
    expect(palm.down(finger(5, 60_000))).toBeNull(); // long after the pen: normal again
  });
});

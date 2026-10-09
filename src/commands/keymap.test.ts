import { describe, expect, it } from 'vitest';
import { formatShortcut, matchesEvent, parseShortcut, toAccelerator, type KeyEventLike } from './keymap';

const event = (overrides: Partial<KeyEventLike>): KeyEventLike => ({
  key: '',
  code: '',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...overrides,
});

describe('keymap', () => {
  it('parses modifiers and named keys', () => {
    expect(parseShortcut('Mod+Shift+Z')).toMatchObject({ mod: true, shift: true, key: 'z' });
    expect(parseShortcut('Mod+BracketRight').key).toBe(']');
    expect(parseShortcut('Delete').key).toBe('delete');
    expect(() => parseShortcut('Mod+')).toThrow();
  });

  it('matches events per platform', () => {
    const shortcut = parseShortcut('Mod+Z');
    expect(matchesEvent(shortcut, event({ key: 'z', code: 'KeyZ', ctrlKey: true }), false)).toBe(true);
    expect(matchesEvent(shortcut, event({ key: 'z', code: 'KeyZ', metaKey: true }), false)).toBe(false);
    expect(matchesEvent(shortcut, event({ key: 'z', code: 'KeyZ', metaKey: true }), true)).toBe(true);
    expect(matchesEvent(shortcut, event({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }), false)).toBe(false);
  });

  it('matches shifted symbol keys by physical code', () => {
    expect(matchesEvent(parseShortcut('Shift+1'), event({ key: '!', code: 'Digit1', shiftKey: true }), false)).toBe(true);
    expect(matchesEvent(parseShortcut('Mod+Shift+BracketRight'), event({ key: '}', code: 'BracketRight', ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(matchesEvent(parseShortcut('Escape'), event({ key: 'Escape', code: 'Escape' }), false)).toBe(true);
  });

  it('formats for display and for Electron accelerators', () => {
    expect(formatShortcut('Mod+Shift+Z', false)).toBe('Ctrl+Shift+Z');
    expect(formatShortcut('Mod+Shift+Z', true)).toBe('⇧⌘Z');
    expect(formatShortcut('ArrowUp', false)).toBe('↑');
    expect(toAccelerator('Mod+Shift+BracketRight')).toBe('CmdOrCtrl+Shift+]');
    expect(toAccelerator('Delete')).toBe('Delete');
  });
});

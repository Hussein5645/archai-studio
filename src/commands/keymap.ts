/**
 * Shortcut syntax: modifiers and one key joined by `+`, e.g. `Mod+Shift+Z`, `Delete`, `R`, or
 * a two-letter sequence typed one after the other (Revit / AutoCAD style), e.g. `M V`.
 * `Mod` is Ctrl on Windows/Linux and Cmd on macOS. Punctuation uses names (`BracketLeft`,
 * `Quote`, `Equal`, `Minus`, `Plus`, `Backslash`, `Comma`, `Period`, `Slash`, `Backquote`).
 */
import type { AnyCommand } from './contract';

export interface ParsedShortcut {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

const NAMED_KEYS: Record<string, string> = {
  backslash: '\\',
  quote: "'",
  plus: '+',
  minus: '-',
  equal: '=',
  bracketleft: '[',
  bracketright: ']',
  comma: ',',
  period: '.',
  slash: '/',
  backquote: '`',
  space: ' ',
  esc: 'escape',
};

const CODE_KEYS: Record<string, string> = {
  Backslash: '\\',
  Quote: "'",
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  Space: ' ',
};

/** `M V`-style sequences: two plain keys separated by a space. */
export function isSequence(shortcut: string): boolean {
  return /^[A-Za-z0-9] [A-Za-z0-9]$/.test(shortcut);
}

export function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = shortcut.split('+').filter((p) => p.length > 0);
  const parsed: ParsedShortcut = { mod: false, ctrl: false, alt: false, shift: false, meta: false, key: '' };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'mod') parsed.mod = true;
    else if (lower === 'ctrl' || lower === 'control') parsed.ctrl = true;
    else if (lower === 'alt' || lower === 'option') parsed.alt = true;
    else if (lower === 'shift') parsed.shift = true;
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command') parsed.meta = true;
    else parsed.key = NAMED_KEYS[lower] ?? lower;
  }
  if (parsed.key === '') throw new Error(`Shortcut has no key: ${shortcut}`);
  return parsed;
}

export interface KeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** The logical key of an event, resilient to Shift changing `key` (Shift+1 → "!"). */
export function keyFromEvent(event: KeyEventLike): string {
  const { code } = event;
  if (code.startsWith('Key') && code.length === 4) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  if (code in CODE_KEYS) return CODE_KEYS[code]!;
  const key = event.key;
  if (key === '+' ) return '+';
  return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
}

export function matchesEvent(shortcut: ParsedShortcut, event: KeyEventLike, isMac: boolean): boolean {
  const wantCtrl = shortcut.ctrl || (shortcut.mod && !isMac);
  const wantMeta = shortcut.meta || (shortcut.mod && isMac);
  if (event.ctrlKey !== wantCtrl || event.metaKey !== wantMeta) return false;
  if (event.altKey !== shortcut.alt || event.shiftKey !== shortcut.shift) return false;
  const key = keyFromEvent(event);
  if (key === shortcut.key) return true;
  // `Mod+Plus` is typed as Shift+Equal on most layouts; accept the `+` produced key too.
  return shortcut.key === '+' && event.key === '+';
}

export function formatShortcut(shortcut: string, isMac: boolean): string {
  if (isSequence(shortcut)) return shortcut.toUpperCase().replace(' ', '');
  const parsed = parseShortcut(shortcut);
  const keyLabel = displayKey(parsed.key);
  if (isMac) {
    const parts = [
      parsed.ctrl ? '⌃' : '',
      parsed.alt ? '⌥' : '',
      parsed.shift ? '⇧' : '',
      parsed.mod || parsed.meta ? '⌘' : '',
      keyLabel,
    ];
    return parts.join('');
  }
  const parts: string[] = [];
  if (parsed.mod || parsed.ctrl) parts.push('Ctrl');
  if (parsed.alt) parts.push('Alt');
  if (parsed.shift) parts.push('Shift');
  if (parsed.meta) parts.push('Win');
  parts.push(keyLabel);
  return parts.join('+');
}

function displayKey(key: string): string {
  switch (key) {
    case 'escape':
      return 'Esc';
    case 'arrowup':
      return '↑';
    case 'arrowdown':
      return '↓';
    case 'arrowleft':
      return '←';
    case 'arrowright':
      return '→';
    case 'delete':
      return 'Del';
    case 'backspace':
      return '⌫';
    case 'enter':
      return 'Enter';
    case ' ':
      return 'Space';
    default:
      return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
  }
}

/** Electron accelerator string for the application menu (display only). */
export function toAccelerator(shortcut: string): string {
  // Menus cannot show sequences as accelerators; the label shows them instead.
  if (isSequence(shortcut)) return '';
  const parsed = parseShortcut(shortcut);
  const parts: string[] = [];
  if (parsed.mod) parts.push('CmdOrCtrl');
  if (parsed.ctrl) parts.push('Ctrl');
  if (parsed.alt) parts.push('Alt');
  if (parsed.shift) parts.push('Shift');
  if (parsed.meta) parts.push('Cmd');
  const key = parsed.key;
  const named: Record<string, string> = {
    escape: 'Esc',
    arrowup: 'Up',
    arrowdown: 'Down',
    arrowleft: 'Left',
    arrowright: 'Right',
    delete: 'Delete',
    backspace: 'Backspace',
    enter: 'Return',
    ' ': 'Space',
    '+': 'Plus',
    '-': '-',
    '=': '=',
  };
  parts.push(named[key] ?? key.toUpperCase());
  return parts.join('+');
}

export interface KeymapEntry {
  shortcut: ParsedShortcut;
  command: AnyCommand;
}

export function buildKeymap(commands: readonly AnyCommand[]): KeymapEntry[] {
  const entries: KeymapEntry[] = [];
  for (const command of commands) {
    for (const shortcut of command.shortcuts ?? []) if (!isSequence(shortcut)) entries.push({ shortcut: parseShortcut(shortcut), command });
  }
  return entries;
}

/** Two-letter sequences (`mv` → commands), for keys typed without modifiers. */
export function buildSequences(commands: readonly AnyCommand[]): Map<string, AnyCommand[]> {
  const sequences = new Map<string, AnyCommand[]>();
  for (const command of commands) {
    for (const shortcut of command.shortcuts ?? []) {
      if (!isSequence(shortcut)) continue;
      const key = shortcut.toLowerCase().replace(' ', '');
      sequences.set(key, [...(sequences.get(key) ?? []), command]);
    }
  }
  return sequences;
}

/** All commands bound to the event's key combination, in registration order. */
export function commandsForEvent(keymap: readonly KeymapEntry[], event: KeyEventLike, isMac: boolean): AnyCommand[] {
  return keymap.filter((entry) => matchesEvent(entry.shortcut, event, isMac)).map((entry) => entry.command);
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

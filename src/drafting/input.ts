/**
 * Values typed while drawing or editing (the "dynamic input" box that follows the cursor):
 *
 * - `3000`        a length along the current direction (or a count / factor / angle, per tool);
 * - `3000<30`     a length at an angle (degrees, counter-clockwise on screen, 0 = right);
 * - `@300,-150`   a relative offset (x right, y up, as architects read a plan);
 * - `300,-150`    also relative (the common case while drafting);
 * - `#1200,800`   an absolute board point;
 * - `1200x800`    a width and height (rectangles, sizes).
 *
 * Lengths accept unit suffixes (`1.2m`, `350mm`, `4'`) and default to the workspace unit.
 */
import { parseLength, type Vec2 } from '@/geometry';
import type { Unit } from '@/document';

export type TypedValue =
  | { kind: 'length'; length: number }
  | { kind: 'polar'; length: number; angle: number }
  | { kind: 'relative'; dx: number; dy: number }
  | { kind: 'absolute'; x: number; y: number }
  | { kind: 'size'; width: number; height: number };

export function parseTyped(text: string, unit: Unit): TypedValue | null {
  const input = text.trim();
  if (!input) return null;
  const polar = /^@?([^<]+)<\s*(-?\d*\.?\d+)\s*°?$/.exec(input);
  if (polar) {
    const length = parseLength(polar[1]!, unit);
    const angle = Number(polar[2]);
    return length !== null && Number.isFinite(angle) ? { kind: 'polar', length, angle } : null;
  }
  const size = /^([^x×*]+)\s*[x×*]\s*([^x×*]+)$/i.exec(input);
  if (size && !input.includes(',')) {
    const width = parseLength(size[1]!, unit);
    const height = parseLength(size[2]!, unit);
    return width !== null && height !== null ? { kind: 'size', width: Math.abs(width), height: Math.abs(height) } : null;
  }
  const pair = /^([@#]?)([^,]+),([^,]+)$/.exec(input);
  if (pair) {
    const a = parseLength(pair[2]!, unit);
    const b = parseLength(pair[3]!, unit);
    if (a === null || b === null) return null;
    // Board y grows downwards; typed y is "up" like a drawing.
    return pair[1] === '#' ? { kind: 'absolute', x: a, y: -b } : { kind: 'relative', dx: a, dy: -b };
  }
  const length = parseLength(input, unit);
  return length !== null ? { kind: 'length', length } : null;
}

/** A plain number (counts, angles, factors) or null. */
export function parseNumber(text: string): number | null {
  const value = Number(text.trim().replace(/°$/, ''));
  return text.trim() && Number.isFinite(value) ? value : null;
}

/**
 * Whether a key belongs to a typed value: it must start with a digit, sign, `.`, `@` or `#`
 * (so tool shortcut letters still work), and may then continue with units and separators.
 */
export function isTypedCharacter(key: string, buffer: string): boolean {
  if (key.length !== 1) return false;
  if (!buffer) return /^[0-9.\-@#]$/.test(key);
  return /^[0-9.,<@#x×*\-+'"a-z°]$/i.test(key);
}

/**
 * The point a typed value gives from `from`, with `toward` (the cursor) giving the direction
 * for a bare length. Null when the value does not describe a point.
 */
export function typedPoint(value: TypedValue, from: Vec2, toward: Vec2): Vec2 | null {
  switch (value.kind) {
    case 'length': {
      const dx = toward.x - from.x;
      const dy = toward.y - from.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) return { x: from.x + value.length, y: from.y };
      return { x: from.x + (dx / len) * value.length, y: from.y + (dy / len) * value.length };
    }
    case 'polar': {
      const a = (value.angle * Math.PI) / 180;
      return { x: from.x + Math.cos(a) * value.length, y: from.y - Math.sin(a) * value.length };
    }
    case 'relative':
      return { x: from.x + value.dx, y: from.y + value.dy };
    case 'absolute':
      return { x: value.x, y: value.y };
    case 'size':
      // Width along +x, height along the side the cursor is on.
      return { x: from.x + value.width * Math.sign(toward.x - from.x || 1), y: from.y + value.height * Math.sign(toward.y - from.y || 1) };
  }
}

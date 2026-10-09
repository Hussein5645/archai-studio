/**
 * 2D affine matrices in SVG order: [a b c d e f] with x' = a·x + c·y + e, y' = b·x + d·y + f.
 */
import { boundsOfPoints, rectCorners, type Rect } from './rect';
import { DEG_TO_RAD, type Vec2 } from './vec';

export type Mat = readonly [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export const translation = (tx: number, ty: number): Mat => [1, 0, 0, 1, tx, ty];
export const scaling = (sx: number, sy: number): Mat => [sx, 0, 0, sy, 0, 0];
export function rotation(degrees: number): Mat {
  const r = degrees * DEG_TO_RAD;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}

/** `multiply(m, n)` applies `n` first, then `m` (like nested SVG transforms). */
export function multiply(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function compose(...mats: Mat[]): Mat {
  return mats.reduce(multiply, IDENTITY);
}

/** translate(x, y) · rotate(deg) · scale(sx, sy): the element-local → parent transform. */
export function fromTRS(x: number, y: number, degrees: number, sx = 1, sy = 1): Mat {
  let m = multiply(translation(x, y), rotation(degrees));
  if (sx !== 1 || sy !== 1) m = multiply(m, scaling(sx, sy));
  return m;
}

export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2];
  if (det === 0) throw new Error('Matrix is not invertible');
  const inv = 1 / det;
  return [
    m[3] * inv,
    -m[1] * inv,
    -m[2] * inv,
    m[0] * inv,
    (m[2] * m[5] - m[3] * m[4]) * inv,
    (m[1] * m[4] - m[0] * m[5]) * inv,
  ];
}

export function applyToPoint(m: Mat, p: Vec2): Vec2 {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** Transforms a direction (ignores translation). */
export function applyToVector(m: Mat, v: Vec2): Vec2 {
  return { x: m[0] * v.x + m[2] * v.y, y: m[1] * v.x + m[3] * v.y };
}

/** Axis-aligned bounds of a rectangle after transformation. */
export function transformRect(m: Mat, r: Rect): Rect {
  return boundsOfPoints(rectCorners(r).map((c) => applyToPoint(m, c)));
}

export function toSvgTransform(m: Mat): string {
  return `matrix(${m.map((n) => +n.toFixed(6)).join(' ')})`;
}

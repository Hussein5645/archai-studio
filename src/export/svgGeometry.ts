/**
 * Pure SVG geometry for vector exports (DXF): 2D affine transforms, SVG transform lists and path
 * data flattened into polylines. No DOM, so it is unit-tested under Node.
 */

/** Affine matrix [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (SVG order). */
export type Affine = readonly [number, number, number, number, number, number];

export const IDENTITY_AFFINE: Affine = [1, 0, 0, 1, 0, 0];

/** `m` then `n` applied after it: the matrix of n ∘ m. */
export function compose(n: Affine, m: Affine): Affine {
  return [
    n[0] * m[0] + n[2] * m[1],
    n[1] * m[0] + n[3] * m[1],
    n[0] * m[2] + n[2] * m[3],
    n[1] * m[2] + n[3] * m[3],
    n[0] * m[4] + n[2] * m[5] + n[4],
    n[1] * m[4] + n[3] * m[5] + n[5],
  ];
}

export function apply(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Uniform scale of a matrix (geometric mean of its axis scales). */
export function scaleOf(m: Affine): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

/** Rotation of the matrix's x axis, degrees counter-clockwise in its own frame. */
export function rotationOf(m: Affine): number {
  return (Math.atan2(m[1], m[0]) * 180) / Math.PI;
}

const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

/** Parses an SVG transform attribute (matrix, translate, scale, rotate, skewX, skewY). */
export function parseTransform(value: string | null | undefined): Affine {
  if (!value) return IDENTITY_AFFINE;
  let m: Affine = IDENTITY_AFFINE;
  for (const match of value.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const args = (match[2]!.match(NUMBER) ?? []).map(Number);
    let t: Affine = IDENTITY_AFFINE;
    switch (match[1]) {
      case 'matrix':
        if (args.length === 6) t = args as unknown as Affine;
        break;
      case 'translate':
        t = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
        break;
      case 'scale':
        t = [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0];
        break;
      case 'rotate': {
        const r = ((args[0] ?? 0) * Math.PI) / 180;
        const cos = Math.cos(r);
        const sin = Math.sin(r);
        const [cx, cy] = [args[1] ?? 0, args[2] ?? 0];
        t = compose([1, 0, 0, 1, cx, cy], compose([cos, sin, -sin, cos, 0, 0], [1, 0, 0, 1, -cx, -cy]));
        break;
      }
      case 'skewX':
        t = [1, 0, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        t = [1, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    // Transform lists apply right to left: the later item acts first.
    m = compose(m, t);
  }
  return m;
}

export interface Subpath {
  points: [number, number][];
  closed: boolean;
}

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function quad(p0: number, p1: number, p2: number, t: number): number {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}

/** Endpoint-parameterised SVG arc to points (excluding the start point). */
function arcPoints(x1: number, y1: number, rxIn: number, ryIn: number, phiDeg: number, large: boolean, sweep: boolean, x2: number, y2: number): [number, number][] {
  if (rxIn === 0 || ryIn === 0 || (x1 === x2 && y1 === y2)) return [[x2, y2]];
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const steps = Math.max(4, Math.ceil(Math.abs(delta) / (Math.PI / 18)));
  const out: [number, number][] = [];
  for (let i = 1; i <= steps; i++) {
    const t = theta1 + (delta * i) / steps;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    out.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
  out[out.length - 1] = [x2, y2];
  return out;
}

const CURVE_STEPS = 12;

/** Flattens SVG path data into polylines (curves and arcs sampled), in the path's own units. */
export function flattenPath(d: string): Subpath[] {
  const tokens = d.match(/[a-df-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  const paths: Subpath[] = [];
  let current: Subpath | null = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let lastControl: [number, number] | null = null;
  let lastQuad: [number, number] | null = null;
  let command = '';
  let i = 0;
  const num = () => Number(tokens[i++]);
  const push = (px: number, py: number) => {
    if (!current) {
      current = { points: [[x, y]], closed: false };
      paths.push(current);
    }
    current.points.push([px, py]);
  };
  while (i < tokens.length) {
    if (/^[a-z]$/i.test(tokens[i]!)) command = tokens[i++]!;
    else if (command === '') break;
    const relative = command === command.toLowerCase();
    const ox = relative ? x : 0;
    const oy = relative ? y : 0;
    const upper = command.toUpperCase();
    if (upper !== 'C' && upper !== 'S') lastControl = null;
    if (upper !== 'Q' && upper !== 'T') lastQuad = null;
    switch (upper) {
      case 'M': {
        x = ox + num();
        y = oy + num();
        startX = x;
        startY = y;
        current = { points: [[x, y]], closed: false };
        paths.push(current);
        // Further pairs after a moveto are linetos.
        command = relative ? 'l' : 'L';
        break;
      }
      case 'L':
        x = ox + num();
        y = oy + num();
        push(x, y);
        break;
      case 'H':
        x = ox + num();
        push(x, y);
        break;
      case 'V':
        y = oy + num();
        push(x, y);
        break;
      case 'C': {
        const [x1, y1, x2, y2, ex, ey] = [ox + num(), oy + num(), ox + num(), oy + num(), ox + num(), oy + num()];
        for (let s = 1; s <= CURVE_STEPS; s++) push(cubic(x, x1, x2, ex, s / CURVE_STEPS), cubic(y, y1, y2, ey, s / CURVE_STEPS));
        lastControl = [x2, y2];
        x = ex;
        y = ey;
        break;
      }
      case 'S': {
        const previous: [number, number] | null = lastControl;
        const x1: number = previous ? 2 * x - previous[0] : x;
        const y1: number = previous ? 2 * y - previous[1] : y;
        const [x2, y2, ex, ey] = [ox + num(), oy + num(), ox + num(), oy + num()];
        for (let s = 1; s <= CURVE_STEPS; s++) push(cubic(x, x1, x2, ex, s / CURVE_STEPS), cubic(y, y1, y2, ey, s / CURVE_STEPS));
        lastControl = [x2, y2];
        x = ex;
        y = ey;
        break;
      }
      case 'Q': {
        const [x1, y1, ex, ey] = [ox + num(), oy + num(), ox + num(), oy + num()];
        for (let s = 1; s <= CURVE_STEPS; s++) push(quad(x, x1, ex, s / CURVE_STEPS), quad(y, y1, ey, s / CURVE_STEPS));
        lastQuad = [x1, y1];
        x = ex;
        y = ey;
        break;
      }
      case 'T': {
        const previous: [number, number] | null = lastQuad;
        const x1: number = previous ? 2 * x - previous[0] : x;
        const y1: number = previous ? 2 * y - previous[1] : y;
        const [ex, ey] = [ox + num(), oy + num()];
        for (let s = 1; s <= CURVE_STEPS; s++) push(quad(x, x1, ex, s / CURVE_STEPS), quad(y, y1, ey, s / CURVE_STEPS));
        lastQuad = [x1, y1];
        x = ex;
        y = ey;
        break;
      }
      case 'A': {
        const [rx, ry, phi, large, sweep] = [num(), num(), num(), num(), num()];
        const [ex, ey] = [ox + num(), oy + num()];
        for (const [px, py] of arcPoints(x, y, rx, ry, phi, large !== 0, sweep !== 0, ex, ey)) push(px, py);
        x = ex;
        y = ey;
        break;
      }
      case 'Z':
        if (current) (current as Subpath).closed = true;
        x = startX;
        y = startY;
        current = null;
        break;
      default:
        i++;
    }
  }
  return paths.filter((path) => path.points.length >= 2);
}

/** Points of an ellipse (or circle), `segments` around, starting at angle 0. */
export function ellipsePoints(cx: number, cy: number, rx: number, ry: number, segments = 48): [number, number][] {
  return Array.from({ length: segments }, (_, k) => {
    const t = (k / segments) * Math.PI * 2;
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)] as [number, number];
  });
}

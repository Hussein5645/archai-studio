/**
 * Hatch patterns for cut surfaces: an SVG `<pattern>` for the board and a repeating canvas
 * tile for three.js cap materials. Both draw one period of the pattern on a `fill` background.
 */
import type { HatchPattern } from './schema';

export interface HatchSpec {
  pattern: HatchPattern;
  fill: string;
  color: string;
  /** Period in millimetres. */
  spacing: number;
  /** Degrees. */
  angle: number;
}

/** Attributes for an SVG `<pattern>` in user space (millimetres), plus the child shapes to draw. */
export function svgHatch(spec: HatchSpec): { width: number; height: number; transform: string | undefined; shapes: { tag: 'line' | 'circle'; attrs: Record<string, string | number> }[] } {
  const s = Math.max(4, spec.spacing);
  const line = Math.max(1.5, s * 0.06);
  const shapes: { tag: 'line' | 'circle'; attrs: Record<string, string | number> }[] = [];
  if (spec.pattern === 'diagonal' || spec.pattern === 'cross') {
    shapes.push({ tag: 'line', attrs: { x1: 0, y1: s / 2, x2: s, y2: s / 2, stroke: spec.color, strokeWidth: line } });
    if (spec.pattern === 'cross') shapes.push({ tag: 'line', attrs: { x1: s / 2, y1: 0, x2: s / 2, y2: s, stroke: spec.color, strokeWidth: line } });
  } else if (spec.pattern === 'dots') {
    shapes.push({ tag: 'circle', attrs: { cx: s / 2, cy: s / 2, r: Math.max(1.5, s * 0.08), fill: spec.color } });
  }
  return { width: s, height: s, transform: spec.angle ? `rotate(${spec.angle})` : undefined, shapes };
}

/** Draws one period on a canvas (`size` px square); the caller tiles it. */
export function drawHatchTile(canvas: HTMLCanvasElement, spec: HatchSpec, size = 64): void {
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = spec.fill;
  ctx.fillRect(0, 0, size, size);
  if (spec.pattern === 'none') return;
  ctx.strokeStyle = spec.color;
  ctx.fillStyle = spec.color;
  ctx.lineWidth = Math.max(1.5, size * 0.06);
  if (spec.pattern === 'diagonal' || spec.pattern === 'cross') {
    ctx.beginPath();
    ctx.moveTo(0, size / 2);
    ctx.lineTo(size, size / 2);
    if (spec.pattern === 'cross') {
      ctx.moveTo(size / 2, 0);
      ctx.lineTo(size / 2, size);
    }
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, Math.max(1.5, size * 0.08), 0, Math.PI * 2);
    ctx.fill();
  }
}

export function hatchKey(spec: HatchSpec): string {
  return `${spec.pattern}|${spec.fill}|${spec.color}|${spec.spacing}|${spec.angle}`;
}

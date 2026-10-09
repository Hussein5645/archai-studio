/**
 * How diagram elements draw (see src/diagrams/model.ts). Everything is sized in printed
 * millimetres × the element's print scale, coloured by the document's diagram theme unless the
 * element sets its own, and drawn in the element's local frame (ElementNode applies the world
 * transform). Glued connectors compute their ends live, so they follow a drag before the
 * post-edit sync stores them.
 */
import type { ReactNode } from 'react';
import type { ArchaiDocument, Element, ElementTable } from '@/document';
import { applyToPoint, invert, worldMatrix, type Vec2 } from '@/geometry';
import { FONT_FAMILY } from '@/geometry/text';
import { formatLength } from '@/geometry/units';
import { connectorEnds, diagramOf, printScaleOf, routePoints, tagText, themeOf, zoneFill, type ArrowHead, type DiagramMeta, type ThemeSpec } from '@/diagrams/model';
import { minStroke } from './shapes';

interface Ctx {
  meta: DiagramMeta;
  theme: ThemeSpec;
  /** Board millimetres per printed millimetre. */
  s: number;
  ink: string;
  pen: number;
}

function Head({ at, from, kind, ctx }: { at: Vec2; from: Vec2; kind: ArrowHead; ctx: Ctx }) {
  if (kind === 'none') return null;
  const length = Math.hypot(at.x - from.x, at.y - from.y) || 1;
  const u = { x: (at.x - from.x) / length, y: (at.y - from.y) / length };
  const n = { x: -u.y, y: u.x };
  const size = Math.max(2.4 * ctx.s, ctx.pen * 5);
  if (kind === 'dot') return <circle cx={at.x} cy={at.y} r={size * 0.3} fill={ctx.ink} />;
  if (kind === 'bar') {
    // The architectural 45° tick.
    const d = { x: (u.x + n.x) * size * 0.35, y: (u.y + n.y) * size * 0.35 };
    return <line x1={at.x - d.x} y1={at.y - d.y} x2={at.x + d.x} y2={at.y + d.y} stroke={ctx.ink} strokeWidth={ctx.pen * 1.8} strokeLinecap="round" />;
  }
  const back = { x: at.x - u.x * size, y: at.y - u.y * size };
  const left = { x: back.x + n.x * size * 0.38, y: back.y + n.y * size * 0.38 };
  const right = { x: back.x - n.x * size * 0.38, y: back.y - n.y * size * 0.38 };
  if (kind === 'open') return <polyline points={`${left.x},${left.y} ${at.x},${at.y} ${right.x},${right.y}`} fill="none" stroke={ctx.ink} strokeWidth={ctx.pen} strokeLinejoin="round" strokeLinecap="round" />;
  return <polygon points={`${at.x},${at.y} ${left.x},${left.y} ${right.x},${right.y}`} fill={ctx.ink} />;
}

/** Pulls an end back under a filled arrow head, so the line does not poke through its tip. */
function trim(points: Vec2[], head: ArrowHead, tail: ArrowHead, ctx: Ctx): Vec2[] {
  const size = Math.max(2.4 * ctx.s, ctx.pen * 5) * 0.8;
  const pull = (p: Vec2, q: Vec2) => {
    const l = Math.hypot(p.x - q.x, p.y - q.y);
    return l > size * 1.5 ? { x: p.x + ((q.x - p.x) / l) * size, y: p.y + ((q.y - p.y) / l) * size } : p;
  };
  const out = [...points];
  if (head === 'arrow' && out.length >= 2) out[out.length - 1] = pull(out.at(-1)!, out.at(-2)!);
  if (tail === 'arrow' && out.length >= 2) out[0] = pull(out[0]!, out[1]!);
  return out;
}

function Label({ at, text, ctx, anchor = 'middle', size = 1, halo = true }: { at: Vec2; text: string; ctx: Ctx; anchor?: 'start' | 'middle' | 'end'; size?: number; halo?: boolean }) {
  if (!text) return null;
  const lines = text.split('\n');
  const fontSize = ctx.theme.text * ctx.s * size;
  const lineHeight = fontSize * 1.3;
  const top = at.y - ((lines.length - 1) * lineHeight) / 2;
  return (
    <text x={at.x} y={top} fontSize={fontSize} fontFamily={FONT_FAMILY} fontWeight={ctx.theme.fontWeight} fill={ctx.ink} textAnchor={anchor} dominantBaseline="central" {...(halo ? { stroke: '#ffffff', strokeWidth: fontSize * 0.28, paintOrder: 'stroke', strokeLinejoin: 'round' as const } : {})}>
      {lines.map((line, index) => (
        <tspan key={index} x={at.x} dy={index === 0 ? 0 : lineHeight}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

function polylinePath(points: Vec2[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
}

function curvedPath(a: Vec2, b: Vec2): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const c1 = horizontal ? { x: a.x + dx * 0.5, y: a.y } : { x: a.x, y: a.y + dy * 0.5 };
  const c2 = horizontal ? { x: b.x - dx * 0.5, y: b.y } : { x: b.x, y: b.y - dy * 0.5 };
  return `M${a.x} ${a.y} C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`;
}

function Dimension({ points, ctx, unit, precision }: { points: Vec2[]; ctx: Ctx; unit: ArchaiDocument['workspace']['unit']; precision: number }) {
  const offset = ctx.meta.offset * ctx.s;
  const gap = 1.2 * ctx.s;
  const parts: ReactNode[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const p = points[i]!;
    const q = points[i + 1]!;
    const length = Math.hypot(q.x - p.x, q.y - p.y);
    if (length < 1) continue;
    const u = { x: (q.x - p.x) / length, y: (q.y - p.y) / length };
    const n = { x: -u.y, y: u.x };
    const side = Math.sign(offset) || 1;
    const at = (point: Vec2, d: number) => ({ x: point.x + n.x * d, y: point.y + n.y * d });
    const a = at(p, offset);
    const b = at(q, offset);
    let angle = (Math.atan2(u.y, u.x) * 180) / Math.PI;
    if (angle > 90 || angle <= -90) angle += 180;
    const mid = at({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, offset + side * 1.6 * ctx.s);
    parts.push(
      <g key={i}>
        {[p, q].map((point, k) => {
          const start = at(point, side * gap);
          const end = at(point, offset + side * 1.5 * ctx.s);
          return <line key={k} x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke={ctx.ink} strokeWidth={ctx.pen * 0.7} />;
        })}
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={ctx.ink} strokeWidth={ctx.pen} />
        <Head at={a} from={b} kind={ctx.meta.tail} ctx={ctx} />
        <Head at={b} from={a} kind={ctx.meta.head} ctx={ctx} />
        <text x={mid.x} y={mid.y} transform={`rotate(${angle} ${mid.x} ${mid.y})`} fontSize={ctx.theme.text * ctx.s * 0.9} fontFamily={FONT_FAMILY} fontWeight={ctx.theme.fontWeight} fill={ctx.ink} textAnchor="middle" dominantBaseline="central">
          {formatLength(length, unit, unit === 'mm' ? 0 : precision, false)}
        </text>
      </g>,
    );
  }
  return <g>{parts}</g>;
}

function lineShape(element: Element & { kind: 'line' }, ctx: Ctx, elements: ElementTable | undefined, workspace: ArchaiDocument['workspace'] | undefined): ReactNode {
  const { meta } = ctx;
  let points: Vec2[] = element.points.map(([x, y]) => ({ x, y }));
  if ((meta.kind === 'connector' || meta.kind === 'adjacency') && elements && (meta.from || meta.to) && points.length >= 2) {
    const m = worldMatrix(elements, element);
    const inverse = invert(m);
    const stored: [Vec2, Vec2] = [applyToPoint(m, points[0]!), applyToPoint(m, points.at(-1)!)];
    points = connectorEnds(elements, meta, stored).map((p) => applyToPoint(inverse, p));
  }
  const dash = meta.dashed ? `${3 * ctx.s} ${2 * ctx.s}` : undefined;
  const stroke = { stroke: ctx.ink, strokeWidth: ctx.pen, strokeDasharray: dash, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, style: minStroke(ctx.pen, 1) };
  switch (meta.kind) {
    case 'dimension':
      return <Dimension points={points} ctx={ctx} unit={workspace?.unit ?? 'm'} precision={workspace?.precision ?? 2} />;
    case 'callout': {
      const [target, anchor] = [points[0]!, points.at(-1)!];
      const dir = anchor.x >= target.x ? 1 : -1;
      const landing = { x: anchor.x + dir * 3 * ctx.s, y: anchor.y };
      return (
        <g>
          <path d={polylinePath([target, anchor, landing])} {...stroke} />
          <Head at={target} from={anchor} kind={meta.tail} ctx={ctx} />
          <Label at={{ x: landing.x + dir * 1.2 * ctx.s, y: anchor.y }} text={meta.text} ctx={ctx} anchor={dir > 0 ? 'start' : 'end'} />
        </g>
      );
    }
    case 'connector':
    case 'adjacency': {
      const [a, b] = [points[0]!, points.at(-1)!];
      const route = meta.kind === 'adjacency' ? (meta.route === 'curved' ? 'curved' : 'straight') : meta.route;
      const path = route === 'curved' ? curvedPath(a, b) : polylinePath(trim(routePoints(a, b, route), meta.head, meta.tail, ctx));
      const drawn = route === 'curved' ? [a, b] : routePoints(a, b, route);
      // Heads follow the path's last direction (a curve leaves along its dominant axis).
      const beforeEnd = route === 'curved' ? (Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? { x: a.x, y: b.y } : { x: b.x, y: a.y }) : drawn.at(-2)!;
      const afterStart = route === 'curved' ? (Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? { x: b.x, y: a.y } : { x: a.x, y: b.y }) : drawn[1]!;
      const mid = drawn.length === 4 ? { x: (drawn[1]!.x + drawn[2]!.x) / 2, y: (drawn[1]!.y + drawn[2]!.y) / 2 } : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      return (
        <g>
          <path d={path} {...stroke} />
          <Head at={b} from={beforeEnd} kind={meta.head} ctx={ctx} />
          <Head at={a} from={afterStart} kind={meta.tail} ctx={ctx} />
          <Label at={mid} text={meta.text} ctx={ctx} size={0.85} />
        </g>
      );
    }
    default: {
      const drawn = trim(points, meta.head, meta.tail, ctx);
      return (
        <g>
          <path d={polylinePath(drawn)} {...stroke} />
          <Head at={points.at(-1)!} from={points.at(-2)!} kind={meta.head} ctx={ctx} />
          <Head at={points[0]!} from={points[1]!} kind={meta.tail} ctx={ctx} />
          {meta.text && <Label at={{ x: (points[0]!.x + points.at(-1)!.x) / 2, y: (points[0]!.y + points.at(-1)!.y) / 2 }} text={meta.text} ctx={ctx} size={0.85} />}
        </g>
      );
    }
  }
}

function zoneArea(element: Element & { kind: 'rect' }, meta: DiagramMeta, radius: number): number {
  const { width: w, height: h } = element;
  if (meta.shape === 'ellipse') return (Math.PI / 4) * w * h;
  return w * h - (4 - Math.PI) * radius * radius;
}

function boxShape(element: Element & { kind: 'rect' }, ctx: Ctx, elements: ElementTable | undefined): ReactNode {
  const { meta, theme } = ctx;
  const { width: w, height: h } = element;
  const dash = meta.dashed ? `${3 * ctx.s} ${2 * ctx.s}` : undefined;
  if (meta.kind === 'zone') {
    const fill = zoneFill(meta, theme);
    const radius = meta.shape === 'rounded' ? Math.min(Math.min(w, h) * 0.2, Math.max(theme.corner * ctx.s, Math.min(w, h) * 0.08)) : 0;
    const area = meta.showArea ? `${(zoneArea(element, meta, radius) / 1_000_000).toFixed(1)} m²` : '';
    const outline = { fill, fillOpacity: theme.zoneOpacity, stroke: meta.color ?? ctx.ink, strokeOpacity: meta.color ? 1 : 0.55, strokeWidth: ctx.pen, strokeDasharray: dash, style: minStroke(ctx.pen, 1) };
    return (
      <g>
        {meta.shape === 'ellipse' ? <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} {...outline} /> : <rect width={w} height={h} rx={radius} {...outline} />}
        <Label at={{ x: w / 2, y: h / 2 }} text={[meta.text, area].filter(Boolean).join('\n')} ctx={ctx} halo={false} />
      </g>
    );
  }
  // Tag: a label box reading its target live, with a leader when moved off it.
  const target = meta.target && elements ? elements[meta.target] : undefined;
  const text = elements ? tagText(meta.text, elements, target) : meta.text;
  let leader: ReactNode = null;
  if (target && elements) {
    const box = (() => {
      const m = worldMatrix(elements, target);
      const inverse = invert(worldMatrix(elements, element));
      const centre = target.kind === 'rect' ? { x: target.width / 2, y: target.height / 2 } : { x: 0, y: 0 };
      return applyToPoint(inverse, applyToPoint(m, centre));
    })();
    const inside = box.x > -w * 0.5 && box.x < w * 1.5 && box.y > -h * 0.5 && box.y < h * 1.5;
    if (!inside) {
      const from = { x: Math.max(0, Math.min(w, box.x)), y: Math.max(0, Math.min(h, box.y)) };
      leader = (
        <g>
          <line x1={from.x} y1={from.y} x2={box.x} y2={box.y} stroke={ctx.ink} strokeWidth={ctx.pen * 0.8} />
          <circle cx={box.x} cy={box.y} r={0.7 * ctx.s} fill={ctx.ink} />
        </g>
      );
    }
  }
  const radius = theme.corner > 0 ? Math.min(h / 2, theme.corner * ctx.s * 1.5) : 0;
  return (
    <g>
      {leader}
      <rect width={w} height={h} rx={radius} fill={meta.fill ?? '#ffffff'} stroke={meta.color ?? ctx.ink} strokeWidth={ctx.pen} strokeDasharray={dash} style={minStroke(ctx.pen, 1)} />
      <Label at={{ x: w / 2, y: h / 2 }} text={text} ctx={ctx} halo={false} />
    </g>
  );
}

/** The diagram renderer for an element, if it is one. */
export function diagramShape(element: Element, elements: ElementTable | undefined, workspace: ArchaiDocument['workspace'] | undefined): ReactNode | undefined {
  const meta = diagramOf(element);
  if (!meta || (element.kind !== 'line' && element.kind !== 'rect')) return undefined;
  const theme = themeOf(workspace ? { workspace } : undefined);
  const s = printScaleOf(elements, element);
  const ctx: Ctx = { meta, theme, s, ink: meta.color ?? (meta.kind === 'arrow' || meta.kind === 'connector' ? theme.accent : theme.ink), pen: (meta.weight ?? theme.pen) * s };
  return element.kind === 'line' ? lineShape(element, ctx, elements, workspace) : boxShape(element, ctx, elements);
}

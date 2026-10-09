/**
 * Revit-style temporary dimensions on the selection: the length of each straight segment of a
 * selected line, or a rectangle's width and height, drawn beside it. Clicking one opens a small
 * field; typing a value (in the workspace unit, with optional unit suffix) and Enter resizes the
 * element through a command (one undo step).
 */
import { useState } from 'react';
import { useDispatch } from '@/app/context';
import type { ArchaiDocument, Element, Unit } from '@/document';
import { applyToPoint, formatLength, parseLength, worldMatrix, worldToScreen, type Vec2 } from '@/geometry';
import { isPlainLine } from '@/commands/builtin/drafting';
import { systemAxes } from '@/interaction/handles';

interface Dimension {
  key: string;
  /** Screen position of the label's centre. */
  at: Vec2;
  value: number;
  apply: (mm: number) => [string, unknown];
}

function dimensionsOf(doc: ArchaiDocument, element: Element, viewport: { x: number; y: number; zoom: number }): Dimension[] {
  const m = worldMatrix(doc.elements, element);
  const screen = (p: Vec2) => worldToScreen(viewport, applyToPoint(m, p));
  if (element.kind === 'rect') {
    const tl = screen({ x: 0, y: 0 });
    const tr = screen({ x: element.width, y: 0 });
    const br = screen({ x: element.width, y: element.height });
    const outward = (a: Vec2, b: Vec2, d: number): Vec2 => {
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { x: (a.x + b.x) / 2 + ((b.y - a.y) / len) * -d, y: (a.y + b.y) / 2 + ((a.x - b.x) / len) * -d };
    };
    // A size driven by a type parameter changes through the type only, never typed on the board.
    const axes = systemAxes(element);
    const dims: Dimension[] = [];
    if (!axes || axes.width) dims.push({ key: 'w', at: outward(tl, tr, 16), value: element.width, apply: (width) => ['set-transform', { id: element.id, width }] });
    if (!axes || axes.height) dims.push({ key: 'h', at: outward(tr, br, 16), value: element.height, apply: (height) => ['set-transform', { id: element.id, height }] });
    return dims;
  }
  if (!isPlainLine(element) || element.path?.segments.some((segment) => segment.kind !== 'line')) return [];
  const local = element.path ? [element.path.start, ...element.path.segments.map((segment) => (segment as { to: [number, number] }).to)] : element.points;
  const count = element.closed ? local.length : local.length - 1;
  if (count > 12) return [];
  const out: Dimension[] = [];
  for (let i = 0; i < count; i++) {
    const a = local[i]!;
    const b = local[(i + 1) % local.length]!;
    const wa = applyToPoint(m, { x: a[0], y: a[1] });
    const wb = applyToPoint(m, { x: b[0], y: b[1] });
    const length = Math.hypot(wb.x - wa.x, wb.y - wa.y);
    if (length < 1e-6) continue;
    const sa = worldToScreen(viewport, wa);
    const sb = worldToScreen(viewport, wb);
    const len = Math.hypot(sb.x - sa.x, sb.y - sa.y);
    if (len < 40) continue;
    const at = { x: (sa.x + sb.x) / 2 + ((sb.y - sa.y) / len) * 14, y: (sa.y + sb.y) / 2 + ((sa.x - sb.x) / len) * 14 };
    out.push({ key: `s${i}`, at, value: length, apply: (mm) => ['set-line-length', { id: element.id, segment: i, length: mm }] });
  }
  return out;
}

export function TempDimensions({ doc, element, viewport, unit, precision }: { doc: ArchaiDocument; element: Element; viewport: { x: number; y: number; zoom: number }; unit: Unit; precision: number }) {
  const dispatch = useDispatch();
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(null);
  const dims = dimensionsOf(doc, element, viewport);
  return (
    <g data-testid="temp-dimensions">
      {dims.map((dim) => {
        const text = formatLength(dim.value, unit, precision, false);
        if (editing?.key === dim.key) {
          const commit = () => {
            const mm = parseLength(editing.text, unit);
            setEditing(null);
            if (mm !== null && mm > 0 && Math.abs(mm - dim.value) > 1e-6) {
              const [command, input] = dim.apply(mm);
              void dispatch(command, input);
            }
          };
          return (
            <foreignObject key={dim.key} x={dim.at.x - 45} y={dim.at.y - 12} width={90} height={24} style={{ pointerEvents: 'auto' }}>
              <input
                autoFocus
                value={editing.text}
                aria-label="Dimension"
                data-testid="temp-dimension-input"
                style={{ width: '100%', height: '100%', boxSizing: 'border-box', font: '12px var(--font-sans, sans-serif)', textAlign: 'center', border: '1px solid var(--accent)', borderRadius: 4 }}
                onChange={(event) => setEditing({ key: dim.key, text: event.target.value })}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') commit();
                  if (event.key === 'Escape') setEditing(null);
                }}
                onBlur={() => setEditing(null)}
                onPointerDown={(event) => event.stopPropagation()}
              />
            </foreignObject>
          );
        }
        const width = text.length * 6.4 + 12;
        return (
          <g
            key={dim.key}
            style={{ pointerEvents: 'auto', cursor: 'text' }}
            data-testid={`temp-dimension-${dim.key}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setEditing({ key: dim.key, text });
            }}
          >
            <title>Click to type a new length</title>
            <rect x={dim.at.x - width / 2} y={dim.at.y - 9} width={width} height={18} rx={4} fill="rgba(255,255,255,.92)" stroke="rgba(37,99,235,.35)" />
            <text x={dim.at.x} y={dim.at.y + 4} fontSize={11} textAnchor="middle" fill="var(--accent-line)">
              {text}
            </text>
          </g>
        );
      })}
    </g>
  );
}

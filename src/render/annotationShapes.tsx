/** Board annotations (src/annotations): pressure ink strokes and sticky notes. */
import type { ReactNode } from 'react';
import type { Element } from '@/document';
import { FONT_FAMILY, linePoints } from '@/geometry';
import { annotationOf, inkOutline, inkWidths, stickyFontSize, wrapStickyText } from '@/annotations/model';

/** The annotation's drawing, or undefined when the element is not an annotation. */
export function annotationShape(element: Element): ReactNode | undefined {
  const meta = annotationOf(element);
  if (!meta) return undefined;
  if (meta.kind === 'ink' && element.kind === 'line') {
    const points = linePoints(element).map(([x, y]) => ({ x, y }));
    const color = element.style.stroke ?? '#1f2024';
    const opacity = element.style.opacity;
    if (meta.highlighter) {
      // Highlighters are flat and see-through; overlapping parts of one stroke do not darken.
      return (
        <polyline
          points={points.map((p) => `${p.x},${p.y}`).join(' ')}
          fill="none"
          stroke={color}
          strokeWidth={element.style.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={opacity}
          style={{ mixBlendMode: 'multiply' }}
          data-annotation="ink"
        />
      );
    }
    return <path d={inkOutline(points, inkWidths(points.length, element.style.strokeWidth, meta.pressure))} fill={color} opacity={opacity} data-annotation="ink" />;
  }
  if (meta.kind === 'sticky' && element.kind === 'rect') {
    const { width, height } = element;
    const fontSize = stickyFontSize(meta.text, width, height);
    const lines = meta.text ? wrapStickyText(meta.text, fontSize, width * 0.84) : [];
    const lineHeight = fontSize * 1.25;
    const top = height / 2 - (lines.length * lineHeight) / 2 + fontSize * 0.9;
    return (
      <g data-annotation="sticky">
        <rect x={width * 0.015} y={width * 0.03} width={width} height={height} fill="#000" opacity={0.12} rx={width * 0.01} />
        <rect width={width} height={height} fill={meta.color} rx={width * 0.01} />
        <rect width={width} height={height * 0.07} fill="#000" opacity={0.04} />
        {lines.length > 0 && (
          <text x={width / 2} fontSize={fontSize} fontFamily={FONT_FAMILY} fill="#1f2024" textAnchor="middle" fontWeight={500}>
            {lines.map((line, index) => (
              <tspan key={index} x={width / 2} y={top + index * lineHeight}>
                {line || ' '}
              </tspan>
            ))}
          </text>
        )}
      </g>
    );
  }
  return undefined;
}

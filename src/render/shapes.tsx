/**
 * Pure SVG renderers for leaf elements. They know nothing about the store, so the same code
 * draws document elements and the contents of asset templates.
 */
import type { CSSProperties, ReactNode } from 'react';
import { slabOpenings } from '@/assets/slabOpenings';
import type { ArchaiDocument, AssetDefinition, BlobRecord, Element, ElementTable, LineElement } from '@/document';
import { childrenOf } from '@/document';
import { linePoints, worldMatrix } from '@/geometry';
import { FONT_FAMILY, formatLength, layoutText, LINE_HEIGHT, canvasMeasurer } from '@/geometry';
import { dataUrl } from '@/persistence/base64';
import { archOf, archTypeOf, graphicTypeOfElement, isArchType } from '@/assets/arch-meta';
import { graphicsForElement, graphicsResolver, svgHatch, type GraphicsResolver } from '@/graphics';
import { LIGHT_INK } from '@/assets/system-geometry';
import { parseSystemParameters } from '@/catalog';
import { isWall } from '@/interaction/wallSnap';
import { topViewStore, useModelTopView, usePackageStyleView, useParametricTopView } from './lodViews';
import { useAppOptional } from '@/app/context';
import { isPoint, POINT_SIZE } from '@/document/point';
import { wallBodyPath, wallLayerPath, wallOutlinePath } from './wallBody';
import { GraphOrigin } from './GraphOrigin';
import { sheetItemShape } from './sheetShapes';
import { diagramShape } from './diagramShapes';
import { annotationShape } from './annotationShapes';
import { paperAncestor } from '@/sheets/model';

// ---- zoom-aware minimums ------------------------------------------------------------------------
// The board sets `--px` (millimetres per screen pixel) on its container, so these follow zoom
// through CSS alone, without re-rendering elements. Where `--px` is unset (exports, thumbnails)
// they fall back to the true size, and exports strip them (see src/export/raster.ts).

/** A stroke never thinner than `px` screen pixels. */
export function minStroke(width: number, px = 1): CSSProperties {
  return { strokeWidth: `max(${width}px, calc(var(--px, 0) * ${px}px))` };
}

/** Scales a symbol up about (x, y) so its `size` mm never draws smaller than `px` screen pixels. */
export function MinScale({ x, y, size, px, children }: { x: number; y: number; size: number; px: number; children: ReactNode }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <g data-min-scale="" style={{ transform: `scale(max(1, calc(var(--px, 0) * ${px / size})))` }}>
        <g transform={`translate(${-x} ${-y})`}>{children}</g>
      </g>
    </g>
  );
}


/** Perpendicular offsets of the boundaries between a wall's layers (outside → inside). */
function wallLayerOffsets(element: Element): number[] {
  const arch = archOf(element);
  const parameters = arch?.['parameters'];
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || !Array.isArray(parameters['layers'])) return [];
  const layers = parseSystemParameters('wall', parameters).layers;
  const total = layers.reduce((sum, layer) => sum + layer.thickness, 0);
  const offsets: number[] = [];
  let cumulative = 0;
  for (let index = 0; index < layers.length - 1; index++) {
    cumulative += layers[index]!.thickness;
    offsets.push(-total / 2 + cumulative);
  }
  return offsets;
}

/** Plan ticks/lines that distinguish railing patterns. */
function RailingPattern({ element, context }: { element: LineElement; context: RenderContext }) {
  const arch = archOf(element);
  const parameters = parseSystemParameters('railing', arch?.['parameters']);
  const { g, style: viewStyle } = boardGraphics(context);
  const graphics = graphicsForElement(g, element, 'railing', 'board', viewStyle);
  const stroke = graphics.color('pattern.stroke') ?? '#ffffff';
  const patternWidth = graphics.number('pattern.width') || 6;
  if (parameters.pattern === 'solid') return null;
  const items: ReactNode[] = [];
  for (let index = 0; index < element.points.length - 1; index++) {
    const [ax, ay] = element.points[index]!;
    const [bx, by] = element.points[index + 1]!;
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    if (length <= 0) continue;
    if (parameters.pattern === 'baluster') {
      if (parameters.balusterSpacing <= 0) continue;
      const count = Math.floor(length / parameters.balusterSpacing);
      for (let i = 1; i < count; i++) {
        const t = (i * parameters.balusterSpacing) / length;
        const x = ax + dx * t;
        const y = ay + dy * t;
        const nx = (-dy / length) * (element.style.strokeWidth * 0.35);
        const ny = (dx / length) * (element.style.strokeWidth * 0.35);
        items.push(<line key={`${index}-${i}`} x1={x - nx} y1={y - ny} x2={x + nx} y2={y + ny} stroke={stroke} strokeWidth={Math.max(6, element.style.strokeWidth * 0.12)} />);
      }
    } else {
      items.push(
        <line
          key={index}
          x1={ax}
          y1={ay}
          x2={bx}
          y2={by}
          stroke={stroke}
          strokeWidth={patternWidth}
          strokeDasharray={parameters.pattern === 'cable' ? `${element.style.strokeWidth} ${element.style.strokeWidth * 0.6}` : undefined}
        />,
      );
    }
  }
  return <g opacity={0.9}>{items}</g>;
}

export interface RenderContext {
  definitions: ArchaiDocument['definitions'];
  blobs: ArchaiDocument['blobs'];
  elements?: ArchaiDocument['elements'];
  workspace?: ArchaiDocument['workspace'];
  /** Applied to template elements before drawing (door/window symbols follow the type's graphics). */
  restyle?: (element: Element) => Element;
}

/** The document's element graphics and the board render style they are resolved for. */
export function boardGraphics(context: RenderContext): { g: GraphicsResolver; style: string } {
  return { g: graphicsResolver(context.workspace?.graphics), style: context.workspace?.viewStyle ?? 'realistic' };
}

/**
 * Restyles the primitives of a door / window / facade symbol: heavy (INK) lines follow the
 * type's `ink`, light (LIGHT_INK) lines its `light`, rect fills its `fill`, weights its `lineScale`.
 */
function symbolRestyle(type: string, owner: Element, g: GraphicsResolver, style: string): (element: Element) => Element {
  const graphics = graphicsForElement(g, owner, type, 'board', style);
  const ink = graphics.color('ink');
  const light = graphics.color('light') ?? ink;
  const fill = graphics.get('fill');
  const scale = (graphics.number('lineScale') || 100) / 100;
  return (element) => {
    if (element.kind !== 'rect' && element.kind !== 'line') return element;
    const stroke = element.style.stroke === LIGHT_INK ? light : element.style.stroke ? ink ?? element.style.stroke : null;
    const nextFill = element.kind === 'rect' && typeof fill === 'string' ? fill : element.style.fill;
    return { ...element, style: { ...element.style, stroke, fill: nextFill, strokeWidth: element.style.strokeWidth * scale } };
  };
}

type StairRole = 'run' | 'landing' | 'riser' | 'nosing' | 'direction' | 'label';

/** Role of a stair group's child (`meta.role`, or inferred from how older stairs were generated). */
function stairChildRole(element: Element): StairRole | null {
  const role = element.meta?.['role'];
  if (role === 'run' || role === 'landing' || role === 'riser' || role === 'nosing' || role === 'direction' || role === 'label') return role;
  if (element.kind === 'rect') return element.style.fill === '#f3f4f6' ? 'landing' : 'run';
  if (element.kind === 'text') return 'label';
  if (element.kind === 'line') {
    if (element.style.stroke === LIGHT_INK) return element.style.strokeWidth <= 4 ? 'nosing' : 'riser';
    return 'direction';
  }
  return null;
}

/** A camera/section marker inside a rig is labelled with the rig ("Camera 1"), not "Camera 1 marker". */
function rigName(element: Element, context: RenderContext): string | undefined {
  const parent = element.parentId ? context.elements?.[element.parentId] : undefined;
  return parent?.meta?.['viewRig'] ? parent.name : undefined;
}

/** Stair children draw with the stair type's graphics rather than the style they were generated with. */
function stairRestyle(element: Element, context: RenderContext): Element {
  const parent = element.parentId && context.elements ? context.elements[element.parentId] : undefined;
  if (!parent || !isArchType(parent, 'stair')) return element;
  const role = stairChildRole(element);
  if (!role) return element;
  const { g, style } = boardGraphics(context);
  const graphics = graphicsForElement(g, parent, 'stair', 'board', style);
  const get = (id: string) => graphics.get(id);
  const color = (id: string) => graphics.color(id);
  if (element.kind === 'rect') {
    return { ...element, style: { ...element.style, fill: color(role === 'landing' ? 'landing.fill' : 'tread.fill'), stroke: color('outline.stroke'), strokeWidth: graphics.number('outline.width') } };
  }
  if (element.kind === 'text') {
    return get('label.visible') === false ? { ...element, visible: false } : { ...element, color: color('label.color') ?? element.color };
  }
  if (element.kind === 'line') {
    if (role === 'nosing') return get('nosing.visible') === false ? { ...element, visible: false } : { ...element, style: { ...element.style, stroke: color('nosing.stroke') } };
    if (role === 'riser') return { ...element, style: { ...element.style, stroke: color('riser.stroke'), strokeWidth: graphics.number('riser.width') } };
    return { ...element, style: { ...element.style, stroke: color('direction.stroke'), strokeWidth: graphics.number('direction.width') } };
  }
  return element;
}

const dataUrlCache = new WeakMap<BlobRecord, string>();

export function blobUrl(blob: BlobRecord): string {
  let url = dataUrlCache.get(blob);
  if (!url) {
    url = dataUrl(blob.mime, blob.data);
    dataUrlCache.set(blob, url);
  }
  return url;
}

export function elementTransform(element: Element): string {
  const parts = [`translate(${element.x} ${element.y})`];
  if (element.rotation !== 0) parts.push(`rotate(${element.rotation})`);
  return parts.join(' ');
}

export function Shape({ element: source, context }: { element: Element; context: RenderContext }): ReactNode {
  const parentStyled = Boolean(context.restyle || (source.parentId && context.elements && isArchType(context.elements[source.parentId], 'stair')));
  const element = context.elements && source.parentId ? stairRestyle(source, context) : source;
  if (!element.visible) return null;
  const { g, style: viewStyle } = boardGraphics(context);
  const typeId = graphicTypeOfElement(element) ?? (element.kind === 'rect' || element.kind === 'line' || element.kind === 'text' || element.kind === 'image' ? element.kind : null);
  const eg = typeId ? graphicsForElement(g, element, typeId, 'board', viewStyle) : null;
  switch (element.kind) {
    case 'rect': {
      // View frames, title blocks, scale bars and north arrows draw themselves (see sheetShapes).
      const sheetItem = sheetItemShape(element, context.elements);
      if (sheetItem !== undefined) return sheetItem;
      const sticky = annotationShape(element);
      if (sticky !== undefined) return sticky;
      const diagram = diagramShape(element, context.elements, context.workspace);
      if (diagram !== undefined) return diagram;
      const paper = element.meta?.['paper'];
      if (paper && typeof paper === 'object' && !Array.isArray(paper)) {
        // A paper sheet: white page with a caption above its top-left corner (scale-independent size).
        const title = typeof paper['title'] === 'string' ? paper['title'] : (element.name ?? 'Paper');
        const scale = typeof paper['scale'] === 'number' ? paper['scale'] : 50;
        const size = typeof paper['size'] === 'string' ? paper['size'] : 'custom';
        const fontSize = Math.max(120, element.width * 0.022);
        const paperFill = eg?.color('fill') ?? '#fff';
        const paperBorder = eg?.color('border.stroke') ?? '#8a8f98';
        const paperTitle = eg?.color('title.color') ?? '#6b6b72';
        return (
          <g>
            <rect x={element.width * 0.006} y={element.width * 0.006} width={element.width} height={element.height} fill="#000" opacity={eg?.number('shadow.opacity') ?? 0} />
            <rect width={element.width} height={element.height} fill={paperFill} stroke={paperBorder} strokeWidth={element.style.strokeWidth} opacity={element.style.opacity} />
            <text x={0} y={-fontSize * 0.5} fontSize={fontSize} fontFamily={FONT_FAMILY} fontWeight={600} fill={paperTitle}>
              {title}
              <tspan fill="#9a9ca3" fontWeight={400}>{`  ${size === 'custom' ? '' : size + ' '}1:${scale}`}</tspan>
            </text>
          </g>
        );
      }
      if (element.meta?.['parametricMarker']) {
        return <GraphOrigin element={element} component={element.parentId ? context.elements?.[element.parentId] : undefined} />;
      }
      if (isPoint(element)) {
        const elevation = typeof element.meta?.['instanceElevation'] === 'number' ? element.meta['instanceElevation'] : 0;
        // A reference point: ring and crosshair at a fixed screen size, its height beside it.
        const r = Math.min(element.width, element.height) / 2 || POINT_SIZE / 2;
        const cx = element.width / 2;
        const cy = element.height / 2;
        const colour = element.style.stroke ?? '#7c3aed';
        const labelSize = r * 0.7;
        return (
          <g>
            <MinScale x={cx} y={cy} size={r * 2} px={16}>
              <circle cx={cx} cy={cy} r={r * 0.62} fill="#ffffff" fillOpacity={0.9} stroke={colour} strokeWidth={r * 0.16} />
              <path d={`M ${cx - r} ${cy} H ${cx - r * 0.3} M ${cx + r * 0.3} ${cy} H ${cx + r} M ${cx} ${cy - r} V ${cy - r * 0.3} M ${cx} ${cy + r * 0.3} V ${cy + r}`} stroke={colour} strokeWidth={r * 0.14} strokeLinecap="round" />
              <circle cx={cx} cy={cy} r={r * 0.16} fill={colour} />
            </MinScale>
            {elevation !== 0 && (
              <MinScale x={cx} y={cy} size={labelSize} px={10}>
                <text x={cx + r * 1.15} y={cy - r * 0.55} fontSize={labelSize} fontWeight={600} fontFamily={FONT_FAMILY} fill={colour} stroke="#ffffff" strokeWidth={labelSize * 0.22} paintOrder="stroke">
                  {`${elevation > 0 ? '+' : ''}${Math.round(elevation)}`}
                </text>
              </MinScale>
            )}
          </g>
        );
      }
      const noiseEmitter = element.meta?.['noiseEmitter'];
      if (noiseEmitter && typeof noiseEmitter === 'object' && !Array.isArray(noiseEmitter)) {
        // Plan symbol like the camera marker: a speaker in a ring with sound waves and its level,
        // kept at a readable screen size when zoomed out.
        const r = Math.min(element.width, element.height) / 2 || 450;
        const cx = element.width / 2;
        const cy = element.height / 2;
        const level = typeof noiseEmitter['level'] === 'number' ? noiseEmitter['level'] : 80;
        const red = '#dc2626';
        const labelSize = r * 0.5;
        return (
          <g>
            <MinScale x={cx} y={cy} size={r * 2} px={26}>
              <circle cx={cx} cy={cy} r={r} fill="#ffffff" fillOpacity={0.92} stroke={red} strokeWidth={r * 0.1} />
              <rect x={cx - r * 0.5} y={cy - r * 0.17} width={r * 0.2} height={r * 0.34} fill={red} />
              <polygon points={`${cx - r * 0.3},${cy - r * 0.17} ${cx + r * 0.02},${cy - r * 0.42} ${cx + r * 0.02},${cy + r * 0.42} ${cx - r * 0.3},${cy + r * 0.17}`} fill={red} />
              <path d={`M ${cx + r * 0.2} ${cy - r * 0.22} A ${r * 0.3} ${r * 0.3} 0 0 1 ${cx + r * 0.2} ${cy + r * 0.22}`} fill="none" stroke={red} strokeWidth={r * 0.08} strokeLinecap="round" />
              <path d={`M ${cx + r * 0.36} ${cy - r * 0.4} A ${r * 0.52} ${r * 0.52} 0 0 1 ${cx + r * 0.36} ${cy + r * 0.4}`} fill="none" stroke={red} strokeWidth={r * 0.08} strokeLinecap="round" />
            </MinScale>
            {/* The level keeps its own readable size (it scales more than the ring, so it stays clear below it). */}
            <MinScale x={cx} y={cy} size={labelSize} px={11}>
              <text x={cx} y={cy + r + labelSize * 1.1} textAnchor="middle" fontSize={labelSize} fontWeight={600} fontFamily={FONT_FAMILY} fill="#b91c1c" stroke="#ffffff" strokeWidth={labelSize * 0.22} paintOrder="stroke">
                {level} dB
              </text>
            </MinScale>
          </g>
        );
      }
      if (element.meta?.['level']) {
        const hiddenLine = viewStyle === 'hidden-line';
        // A level drawn with a free boundary (profile mode) shows that outline in its frame.
        const outline = levelOutlinePoints(element.meta['level']);
        if (outline) {
          return (
            <polygon
              points={outline.map((p) => p.join(',')).join(' ')}
              fill={(hiddenLine ? eg?.color('fill') : element.style.fill) ?? 'none'}
              stroke={(hiddenLine ? eg?.color('stroke') : element.style.stroke) ?? 'none'}
              strokeWidth={hiddenLine ? (eg?.number('width') ?? element.style.strokeWidth) : element.style.strokeWidth}
              opacity={hiddenLine ? (eg?.number('opacity') ?? element.style.opacity) : element.style.opacity}
            />
          );
        }
        return (
          <rect
            width={element.width}
            height={element.height}
            rx={element.radius || undefined}
            fill={(hiddenLine ? eg?.color('fill') : element.style.fill) ?? 'none'}
            stroke={(hiddenLine ? eg?.color('stroke') : element.style.stroke) ?? 'none'}
            strokeWidth={hiddenLine ? (eg?.number('width') ?? element.style.strokeWidth) : element.style.strokeWidth}
            opacity={hiddenLine ? (eg?.number('opacity') ?? element.style.opacity) : element.style.opacity}
          />
        );
      }
      if (isArchType(element, 'column')) {
        const parameters = parseSystemParameters('column', archOf(element)?.['parameters']);
        const material = parameters.material;
        if (parameters.shape === 'custom') {
          const points = parameters.profile.map(([x, y]) => `${x * element.width},${y * element.height}`).join(' ');
          return (
            <polygon
              points={points}
              fill={eg?.color(`fill.${material}`) ?? 'none'}
              stroke={eg?.color('outline.stroke') ?? 'none'}
              strokeWidth={eg?.number('outline.width') ?? 0}
              opacity={element.style.opacity}
            />
          );
        }
        return (
          <rect
            width={element.width}
            height={element.height}
            rx={element.radius || undefined}
            fill={eg?.color(`fill.${material}`) ?? 'none'}
            stroke={eg?.color('outline.stroke') ?? 'none'}
            strokeWidth={eg?.number('outline.width') ?? 0}
            opacity={element.style.opacity}
          />
        );
      }
      const hiddenLine = viewStyle === 'hidden-line' && !parentStyled && typeId === 'rect';
      const fill = hiddenLine ? eg?.color('fill') : element.style.fill;
      const stroke = hiddenLine ? eg?.color('stroke') : element.style.stroke;
      const strokeWidth = hiddenLine ? (eg?.number('strokeWidth') ?? element.style.strokeWidth) : element.style.strokeWidth;
      const opacity = hiddenLine ? (eg?.number('opacity') ?? element.style.opacity) : element.style.opacity;
      return (
        <rect
          width={element.width}
          height={element.height}
          rx={element.radius || undefined}
          fill={fill ?? 'none'}
          stroke={stroke ?? 'none'}
          strokeWidth={strokeWidth}
          style={stroke ? minStroke(strokeWidth) : undefined}
          opacity={opacity}
          vectorEffect={undefined}
        />
      );
    }
    case 'line': {
      // Arrows, connectors, callouts, dimensions and adjacency links draw themselves.
      const diagramLine = diagramShape(element, context.elements, context.workspace);
      if (diagramLine !== undefined) return diagramLine;
      const ink = annotationShape(element);
      if (ink !== undefined) return ink;
      const points = linePoints(element).map((p) => p.join(',')).join(' ');
      const hiddenLine = viewStyle === 'hidden-line' && !parentStyled && typeId === 'line';
      const slab = isArchType(element, 'floor', 'ceiling');
      const lineWidthMm = slab ? (eg?.number('outline.width') ?? element.style.strokeWidth) : hiddenLine ? (eg?.number('strokeWidth') ?? element.style.strokeWidth) : element.style.strokeWidth;
      const common = {
        style: minStroke(lineWidthMm),
        fill: element.closed
          ? ((slab ? eg?.color('fill') : hiddenLine ? eg?.color('fill') : element.style.fill) ?? 'none')
          : 'none',
        stroke: (slab ? eg?.color('outline.stroke') : hiddenLine ? eg?.color('stroke') : element.style.stroke) ?? 'none',
        strokeWidth: lineWidthMm,
        strokeLinejoin: 'miter' as const,
        strokeLinecap: 'butt' as const,
        opacity: slab ? (eg?.number('fill.opacity') ?? element.style.opacity) : hiddenLine ? (eg?.number('opacity') ?? element.style.opacity) : element.style.opacity,
      };
      const measure = element.meta?.['measure'];
      if (!element.closed && measure && typeof measure === 'object' && !Array.isArray(measure) && typeof measure['distance'] === 'number') {
        const first = element.points[0]!;
        const last = element.points.at(-1)!;
        const dx = last[0] - first[0];
        const dy = last[1] - first[1];
        const length = Math.hypot(dx, dy) || 1;
        const nx = (-dy / length) * 90;
        const ny = (dx / length) * 90;
        const midX = (first[0] + last[0]) / 2;
        const midY = (first[1] + last[1]) / 2;
        // The label always reflects the line as it is now (moved, stretched or scaled), not the
        // distance recorded when it was drawn.
        const worldScale = context.elements ? matrixScale(worldMatrix(context.elements, element)) : 1;
        const measured = Math.hypot(dx, dy) * worldScale;
        const label = context.workspace ? formatLength(measured, context.workspace.unit, context.workspace.precision) : `${Math.round(measured)} mm`;
        const measureStroke = eg?.color('stroke') ?? '#2563eb';
        const tickWidth = eg?.number('tick.width') ?? 12;
        const labelSize = eg?.number('label.size') ?? 150;
        return (
          <g>
            <polyline points={points} {...common} style={minStroke(common.strokeWidth, 1.5)} stroke={measureStroke} />
            {/* End ticks and the label keep a readable screen size when zoomed out. */}
            <MinScale x={first[0]} y={first[1]} size={90} px={7}>
              <line x1={first[0] - nx} y1={first[1] - ny} x2={first[0] + nx} y2={first[1] + ny} stroke={measureStroke} strokeWidth={tickWidth} />
            </MinScale>
            <MinScale x={last[0]} y={last[1]} size={90} px={7}>
              <line x1={last[0] - nx} y1={last[1] - ny} x2={last[0] + nx} y2={last[1] + ny} stroke={measureStroke} strokeWidth={tickWidth} />
            </MinScale>
            <MinScale x={midX} y={midY} size={labelSize} px={12}>
              <text x={midX} y={midY - 110} textAnchor="middle" fontSize={labelSize} fontFamily={FONT_FAMILY} fill={measureStroke} stroke="#ffffff" strokeWidth={labelSize * 0.21} paintOrder="stroke">
                {label}
              </text>
            </MinScale>
          </g>
        );
      }
      const sectionLine = element.meta?.['sectionLine'];
      if (!element.closed && sectionLine && typeof sectionLine === 'object' && !Array.isArray(sectionLine) && element.points.length >= 2) {
        // Section marker: the cut line with end ticks, view-direction arrows and the section's name.
        const a = element.points[0]!;
        const b = element.points.at(-1)!;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const length = Math.hypot(dx, dy) || 1;
        const along = { x: dx / length, y: dy / length };
        const direction = sectionLine['direction'] === -1 ? -1 : 1;
        const normal = { x: -along.y * direction, y: along.x * direction };
        const portalId = typeof sectionLine['portalId'] === 'string' ? sectionLine['portalId'] : null;
        const portal = portalId && context.elements ? context.elements[portalId] : undefined;
        const label = rigName(element, context) ?? portal?.name ?? element.name ?? 'Section';
        const colour = eg?.color('stroke') ?? '#2563eb';
        const lineWidth = eg?.number('width') ?? 14;
        const labelSize = eg?.number('label.size') ?? 130;
        const arrowShape = eg?.get('symbol.arrowShape') ?? 'filled';
        const tick = 260;
        const arrow = (p: [number, number], key: number) => {
          const base = { x: p[0] + normal.x * 120, y: p[1] + normal.y * 120 };
          const tip = { x: p[0] + normal.x * 460, y: p[1] + normal.y * 460 };
          const left = { x: base.x + along.x * 140, y: base.y + along.y * 140 };
          const right = { x: base.x - along.x * 140, y: base.y - along.y * 140 };
          const path = `M ${tip.x} ${tip.y} L ${left.x} ${left.y} L ${right.x} ${right.y} Z`;
          if (arrowShape === 'outline') return <path key={key} data-section-arrow="outline" d={path} fill="#ffffff" stroke={colour} strokeWidth={Math.max(8, lineWidth)} strokeLinejoin="round" />;
          if (arrowShape === 'chevron') return <path key={key} data-section-arrow="chevron" d={`M ${left.x} ${left.y} L ${tip.x} ${tip.y} L ${right.x} ${right.y}`} fill="none" stroke={colour} strokeWidth={Math.max(18, lineWidth * 1.4)} strokeLinecap="round" strokeLinejoin="round" />;
          if (arrowShape === 'dot') return <circle key={key} data-section-arrow="dot" cx={tip.x} cy={tip.y} r={105} fill={colour} />;
          return <path key={key} data-section-arrow="filled" d={path} fill={colour} />;
        };
        const bubble = (p: [number, number], sign: number) => ({ x: p[0] + along.x * sign * 320, y: p[1] + along.y * sign * 320 });
        const bubbleA = bubble(a, -1);
        const bubbleB = bubble(b, 1);
        return (
          <g>
            <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={colour} strokeWidth={lineWidth} style={minStroke(lineWidth, 1.5)} strokeDasharray="220 110" strokeLinecap="butt" />
            {/* Each end symbol (tick, arrow, bubble) keeps a readable screen size. */}
            {([[a, bubbleA], [b, bubbleB]] as const).map(([end, point], index) => (
              <MinScale key={index} x={end[0]} y={end[1]} size={640} px={34}>
                <line x1={end[0] - normal.x * tick} y1={end[1] - normal.y * tick} x2={end[0] + normal.x * tick} y2={end[1] + normal.y * tick} stroke={colour} strokeWidth={18} />
                {arrow(end, index)}
                <circle cx={point.x} cy={point.y} r={210} fill="#ffffff" stroke={colour} strokeWidth={16} />
                <text x={point.x} y={point.y + 65} textAnchor="middle" fontSize={190} fontWeight={600} fontFamily={FONT_FAMILY} fill={colour}>
                  {label.trim().charAt(0).toUpperCase() || 'S'}
                </text>
              </MinScale>
            ))}
            <MinScale x={(a[0] + b[0]) / 2} y={(a[1] + b[1]) / 2} size={labelSize} px={12}>
              <text x={(a[0] + b[0]) / 2 + normal.x * 230} y={(a[1] + b[1]) / 2 + normal.y * 230 + 50} textAnchor="middle" fontSize={labelSize} fontFamily={FONT_FAMILY} fill={colour} stroke="#ffffff" strokeWidth={labelSize * 0.21} paintOrder="stroke">
                {label}
              </text>
            </MinScale>
          </g>
        );
      }
      const cameraMarker = element.meta?.['cameraMarker'];
      if (!element.closed && cameraMarker && typeof cameraMarker === 'object' && !Array.isArray(cameraMarker)) {
        // Plan symbol: a camera body at the eye, a dashed sight line to the aim point (crosshair),
        // and the field of view as a fan whose radius follows the aim distance.
        const eye = element.points[0]!;
        const aim = element.points.at(-1)!;
        const dx = aim[0] - eye[0];
        const dy = aim[1] - eye[1];
        const dist = Math.hypot(dx, dy) || 1;
        const angle = Math.atan2(dy, dx);
        const fov = typeof cameraMarker['fov'] === 'number' ? cameraMarker['fov'] : 60;
        const half = ((fov / 2) * Math.PI) / 180;
        const reach = Math.max(1200, dist);
        const stroke = eg?.color('stroke') ?? element.style.stroke ?? '#8b5cf6';
        const fovOpacity = eg?.number('fov.opacity') ?? 0.12;
        const cameraLabel = eg?.number('label.size') ?? 130;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        // Local frame at the eye: u along the sight line, v to its left.
        const at = (u: number, v: number): [number, number] => [eye[0] + cos * u - sin * v, eye[1] + sin * u + cos * v];
        const fanL = at(Math.cos(half) * reach, -Math.sin(half) * reach);
        const fanR = at(Math.cos(half) * reach, Math.sin(half) * reach);
        const arcRadius = Math.min(reach * 0.35, 900);
        const arcL = at(Math.cos(half) * arcRadius, -Math.sin(half) * arcRadius);
        const arcR = at(Math.cos(half) * arcRadius, Math.sin(half) * arcRadius);
        // Camera body (plan): a box behind the eye with a lens barrel pointing along the sight line.
        const bodyW = 260;
        const bodyD = 200;
        const body = [at(-bodyD, -bodyW / 2), at(0, -bodyW / 2), at(0, bodyW / 2), at(-bodyD, bodyW / 2)];
        const lens = [at(0, -80), at(110, -120), at(110, 120), at(0, 80)];
        const points = (list: [number, number][]) => list.map(([x, y]) => `${x},${y}`).join(' ');
        const aimR = 90;
        return (
          <g>
            <path d={`M ${eye[0]} ${eye[1]} L ${fanL[0]} ${fanL[1]} A ${reach} ${reach} 0 ${fov > 180 ? 1 : 0} 1 ${fanR[0]} ${fanR[1]} Z`} fill={stroke} fillOpacity={fovOpacity} stroke="none" />
            <line x1={eye[0]} y1={eye[1]} x2={fanL[0]} y2={fanL[1]} stroke={stroke} strokeWidth={6} style={minStroke(6)} strokeDasharray="40 24" opacity={0.7} />
            <line x1={eye[0]} y1={eye[1]} x2={fanR[0]} y2={fanR[1]} stroke={stroke} strokeWidth={6} style={minStroke(6)} strokeDasharray="40 24" opacity={0.7} />
            <path d={`M ${arcL[0]} ${arcL[1]} A ${arcRadius} ${arcRadius} 0 0 1 ${arcR[0]} ${arcR[1]}`} fill="none" stroke={stroke} strokeWidth={8} style={minStroke(8)} />
            <line x1={eye[0]} y1={eye[1]} x2={aim[0]} y2={aim[1]} stroke={stroke} strokeWidth={8} style={minStroke(8)} strokeDasharray="60 40" />
            {/* The camera body, crosshair and labels keep a readable screen size. */}
            <MinScale x={eye[0]} y={eye[1]} size={560} px={30}>
              <polygon points={points(body)} fill="#ffffff" stroke={stroke} strokeWidth={14} strokeLinejoin="round" />
              <polygon points={points(lens)} fill={stroke} stroke={stroke} strokeWidth={10} strokeLinejoin="round" />
              <circle cx={eye[0]} cy={eye[1]} r={34} fill={stroke} />
              <text x={eye[0]} y={eye[1] - 260} textAnchor="middle" fontSize={cameraLabel} fontFamily={FONT_FAMILY} fill={stroke} stroke="#ffffff" strokeWidth={cameraLabel * 0.21} paintOrder="stroke">
                {rigName(element, context) ?? (element.name || 'Camera')} · {Math.round(fov)}°
              </text>
            </MinScale>
            <MinScale x={aim[0]} y={aim[1]} size={aimR * 3} px={18}>
              <circle cx={aim[0]} cy={aim[1]} r={aimR} fill="#ffffff" fillOpacity={0.85} stroke={stroke} strokeWidth={12} />
              <line x1={aim[0] - aimR * 1.5} y1={aim[1]} x2={aim[0] + aimR * 1.5} y2={aim[1]} stroke={stroke} strokeWidth={10} />
              <line x1={aim[0]} y1={aim[1] - aimR * 1.5} x2={aim[0]} y2={aim[1] + aimR * 1.5} stroke={stroke} strokeWidth={10} />
              <circle cx={aim[0]} cy={aim[1]} r={18} fill={stroke} />
              <text x={aim[0]} y={aim[1] - aimR * 1.5 - 50} textAnchor="middle" fontSize={cameraLabel * 0.8} fontFamily={FONT_FAMILY} fill={stroke} stroke="#ffffff" strokeWidth={cameraLabel * 0.19} paintOrder="stroke">
                aim
              </text>
            </MinScale>
          </g>
        );
      }
      if (!element.closed && context.elements && isWall(element)) {
        // Walls are filled bodies with mitred, square corners; the layer boundaries are clipped
        // to the body so they stop at openings and run into the joints.
        const table = context.elements;
        const body = wallBodyPath(element, table);
        const outline = wallOutlinePath(element, table);
        const layerOffsets = wallLayerOffsets(element);
        const clipId = `wall-clip-${element.id}`;
        // Display style: hidden line draws walls as outlined white bodies, shaded as flat grey;
        // the wall type's graphics (per style) decide the colours and weights.
        const wall = (id: string) => eg?.get(id);
        const useCut = wall('plan.useCut') === true;
        const hatchId = `wall-hatch-${element.id}`;
        const hatch = useCut
          ? svgHatch({
              pattern: g.hatch('wall', 'section', viewStyle, 'cut.coreHatch'),
              fill: g.color('wall', 'section', viewStyle, 'cut.coreFill') ?? '#9a9ca3',
              color: g.color('wall', 'section', viewStyle, 'cut.hatchColor') ?? '#3a3a3f',
              spacing: g.number('wall', 'section', viewStyle, 'cut.hatchSpacing'),
              angle: g.number('wall', 'section', viewStyle, 'cut.hatchAngle'),
            })
          : null;
        const coreFill = g.color('wall', 'section', viewStyle, 'cut.coreFill') ?? '#9a9ca3';
        const wallFill = hatch ? (hatch.shapes.length > 0 ? `url(#${hatchId})` : coreFill) : (eg?.color('body.fill') ?? '#3a3a3f');
        const wallFillOpacity = Math.min(1, Math.max(0, eg?.number('body.opacity') ?? 1)) * element.style.opacity;
        const wallOutline = viewStyle === 'hidden-line' || useCut ? (eg?.color('outline.stroke') ?? '#1f1f24') : null;
        const outlineWidth = eg?.number('outline.width') || 6;
        const layerLine = eg?.color('layer.stroke') ?? '#ffffff';
        const layerWidth = eg?.number('layer.width') ?? 4;
        const layersVisible = wall('layer.visible') !== false;
        // A one-layer wall has no internal material boundary. In Hidden line, use its
        // centre line as the visible layer line so the layer colour/weight controls
        // still have an observable, useful result.
        const visibleLayerOffsets = layersVisible
          ? layerOffsets.length > 0
            ? layerOffsets
            : viewStyle === 'hidden-line'
              ? [0]
              : []
          : [];
        return (
          <g>
            {hatch && hatch.shapes.length > 0 && (
              <pattern id={hatchId} patternUnits="userSpaceOnUse" width={hatch.width} height={hatch.height} patternTransform={hatch.transform}>
                <rect width={hatch.width} height={hatch.height} fill={coreFill} />
                {hatch.shapes.map((shape, index) => (shape.tag === 'line' ? <line key={index} {...shape.attrs} /> : <circle key={index} {...shape.attrs} />))}
              </pattern>
            )}
            {visibleLayerOffsets.length > 0 && (
              <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
                <path d={body} fillRule="evenodd" clipRule="evenodd" />
              </clipPath>
            )}
            <path d={body} fill={wallFill} fillRule="evenodd" opacity={wallFillOpacity} />
            {wallOutline && <path d={outline} fill="none" stroke={wallOutline} strokeWidth={outlineWidth} style={minStroke(outlineWidth)} strokeLinecap="square" strokeLinejoin="miter" opacity={element.style.opacity} />}
            {visibleLayerOffsets.map((offset) => (
              <path
                key={offset}
                d={wallLayerPath(element, table, offset)}
                clipPath={`url(#${clipId})`}
                fill="none"
                stroke={layerLine}
                strokeWidth={layerWidth}
                strokeLinecap="square"
                strokeLinejoin="miter"
                opacity={(viewStyle === 'hidden-line' ? 1 : 0.75) * element.style.opacity}
              />
            ))}
          </g>
        );
      }
      if (!element.closed && isArchType(element, 'railing')) {
        return (
          <g>
            <polyline points={points} {...common} style={minStroke(eg?.number('width') || common.strokeWidth)} stroke={eg?.color('stroke') ?? common.stroke} strokeWidth={eg?.number('width') || common.strokeWidth} />
            <RailingPattern element={element} context={context} />
          </g>
        );
      }
      if (!element.closed && isArchType(element, 'curtain-wall', 'room-divider')) {
        return <polyline points={points} {...common} style={minStroke(eg?.number('width') || common.strokeWidth)} stroke={eg?.color('stroke') ?? common.stroke} strokeWidth={eg?.number('width') || common.strokeWidth} />;
      }
      if (element.closed && isArchType(element, 'room')) {
        const roomName = element.name?.trim().toLocaleLowerCase();
        const mappedFill = roomName
          ? eg?.colorMap('name.colors').find((entry) => entry.text.trim().toLocaleLowerCase() === roomName)?.color
          : undefined;
        return (
          <polygon
            points={points}
            {...common}
            fill={mappedFill ?? eg?.color('fill') ?? 'none'}
            fillOpacity={eg?.number('fill.opacity') ?? 0.55}
            stroke={eg?.color('outline.stroke') ?? 'none'}
            strokeWidth={eg?.number('outline.width') ?? 12}
            opacity={1}
          />
        );
      }
      // A floor / ceiling with openings: its boundary and each opening as one even-odd path.
      const openings = slab && element.closed ? slabOpenings(element) : [];
      if (openings.length) {
        const ring = (ringPoints: readonly (readonly [number, number])[]) => `M${ringPoints.map((p) => p.join(',')).join('L')}Z`;
        return <path d={[linePoints(element), ...openings.map((opening) => opening.points)].map(ring).join('')} fillRule="evenodd" {...common} />;
      }
      return element.closed ? <polygon points={points} {...common} /> : <polyline points={points} {...common} />;
    }
    case 'text': {
      const hiddenLine = viewStyle === 'hidden-line' && !parentStyled && typeId === 'text';
      const fontSize = hiddenLine ? (eg?.number('fontSize') ?? element.fontSize) : element.fontSize;
      const layout = layoutText(element.text, fontSize, element.width, canvasMeasurer);
      const anchor = element.align === 'center' ? 'middle' : element.align === 'right' ? 'end' : 'start';
      const x = element.align === 'center' ? element.width / 2 : element.align === 'right' ? element.width : 0;
      const lineHeight = fontSize * LINE_HEIGHT;
      const textColor = isArchType(element, 'room-label')
        ? (eg?.color('label.color') ?? element.color)
        : hiddenLine
          ? (eg?.color('color') ?? element.color)
          : element.color;
      return (
        <text fill={textColor} fontSize={fontSize} fontFamily={FONT_FAMILY} textAnchor={anchor}>
          {layout.lines.map((line, i) => (
            <tspan key={i} x={x} y={i * lineHeight + fontSize * 0.95}>
              {line === '' ? ' ' : line}
            </tspan>
          ))}
        </text>
      );
    }
    case 'image': {
      const blob = context.blobs[element.blobId];
      if (!blob) return <rect width={element.width} height={element.height} fill={eg?.color('missing.fill') ?? '#eee'} stroke="#ccc" />;
      return (
        <image
          href={blobUrl(blob)}
          width={element.width}
          height={element.height}
          opacity={viewStyle === 'hidden-line' ? (eg?.number('opacity') ?? element.opacity) : element.opacity}
          preserveAspectRatio="none"
          // Images on a sheet are presentation content: the board display style leaves them in colour.
          data-styled={context.elements && paperAncestor(context.elements, element) ? 'true' : undefined}
        />
      );
    }
    case 'instance':
      return <InstanceContent element={element} context={context} />;
    case 'group':
      return null;
  }
}

function InstanceContent({ element, context }: { element: Element & { kind: 'instance' }; context: RenderContext }) {
  const definition: AssetDefinition | undefined = context.definitions[element.definitionId];
  const { g, style } = boardGraphics(context);
  const graphics = graphicsForElement(g, element, archTypeOf(element) ?? 'asset', 'board', style);
  if (isArchType(element, 'facade-element')) {
    const parameters = parseSystemParameters('facade-element', archOf(element)?.['parameters']);
    const points = parameters.profile.map(([x, y]) => `${x * element.width},${y * element.height}`).join(' ');
    return <polygon points={points} fill={graphics.color('fill') ?? '#eef3fb'} stroke={graphics.color('ink') ?? '#587099'} strokeWidth={12} />;
  }
  if (!definition) return <rect width={element.width} height={element.height} fill="none" stroke={graphics.color('missing.stroke') ?? '#d64545'} strokeDasharray="40 20" />;
  const sx = definition.width > 0 ? element.width / definition.width : 1;
  const sy = definition.height > 0 ? element.height / definition.height : 1;
  const scale = sx !== 1 || sy !== 1 ? `scale(${sx} ${sy})` : undefined;
  if (definition.kind === 'image') return <CatalogImage element={element} definition={definition} context={context} />;
  // System symbols (door, window, facade element) follow their type's graphics.
  const symbolType = archTypeOf(element);
  const restyle = symbolType === 'door' || symbolType === 'window' || symbolType === 'facade-element' ? symbolRestyle(symbolType, element, g, style) : undefined;
  return (
    <g transform={scale}>
      <TemplateTree table={definition.elements} parentId={null} context={restyle ? { ...context, restyle } : context} />
    </g>
  );
}

/**
 * A catalog asset's plan symbol: a top view rendered from the asset's 3D model in the board's
 * display style, at any level of detail (the LOD only changes 3D views). The package image is used
 * only when the package has no model or it cannot be loaded, and for static (export) rendering.
 * Excluded from static template rendering.
 */
function CatalogImage({ element, definition, context }: { element: Element & { kind: 'instance' }; definition: Extract<AssetDefinition, { kind: 'image' }>; context: RenderContext }) {
  const app = useAppOptional();
  const style = context.workspace?.viewStyle ?? 'realistic';
  const hasModel = Boolean(definition.catalog?.modelPaths?.glb || definition.catalog?.modelPaths?.fbx || definition.catalog?.modelUrl);
  const live = app !== null;
  const rendered = useModelTopView(app?.doc ?? null, app?.catalog ?? null, hasModel ? definition.id : null, style, hasModel && live);
  const modelFailed = hasModel && live && topViewStore.failed(definition.id);
  const useImage = !hasModel || !live || modelFailed;
  // No model: the package's own styled rendering when it ships one, otherwise the plain image (CSS-filtered).
  const styled = usePackageStyleView(app?.catalog ?? null, definition, style, useImage && live);
  // A parametric copy with its own values shows its rebuilt model.
  const parametric = useParametricTopView(app?.doc ?? null, app?.catalog ?? null, element, definition, style);
  const blob = context.blobs[definition.blobId];
  const href = parametric ?? rendered ?? (useImage ? (styled ?? (blob ? blobUrl(blob) : null)) : null);
  // While the model loads, a light outline holds the place (never the package image).
  if (!href) return useImage ? null : <rect width={element.width} height={element.height} fill="none" stroke="#c3c8d2" strokeWidth={6} strokeDasharray="30 20" data-loading-model="true" />;
  return <image href={href} width={element.width} height={element.height} preserveAspectRatio="none" data-styled={parametric || rendered || styled ? 'true' : undefined} />;
}

/** Uniform scale factor carried by a matrix (1 for pure rotation/translation). */
function matrixScale(m: readonly number[]): number {
  return Math.hypot(m[0]!, m[1]!) || 1;
}

/** Renders a static element table (an asset template) recursively. */
export function TemplateTree({ table, parentId, context }: { table: ElementTable; parentId: string | null; context: RenderContext }) {
  return (
    <>
      {childrenOf(table, parentId)
        .filter((e) => e.visible)
        .map((e) => (
          <g key={e.id} transform={elementTransform(e)}>
            {e.kind === 'group' ? <TemplateTree table={table} parentId={e.id} context={context} /> : <Shape element={context.restyle ? context.restyle(e) : e} context={context} />}
          </g>
        ))}
    </>
  );
}

/** The drawn outline of a level (`meta.level.outline`, level-local points), or null for a plain rectangle. */
function levelOutlinePoints(level: unknown): [number, number][] | null {
  if (!level || typeof level !== 'object' || Array.isArray(level)) return null;
  const outline = (level as Record<string, unknown>)['outline'];
  if (!outline || typeof outline !== 'object' || Array.isArray(outline)) return null;
  const points = (outline as Record<string, unknown>)['points'];
  return Array.isArray(points) && points.length >= 3 ? (points as [number, number][]) : null;
}

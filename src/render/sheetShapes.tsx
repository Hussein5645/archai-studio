/**
 * How sheet items draw (see src/sheets/model.ts). A plan/board view frame redraws the real board
 * elements inside a nested SVG whose viewBox is the crop, so the drawing stays live and vector on
 * screen and in every export; a 3D view frame shows a live render of its source view. Title
 * blocks, scale bars and north arrows read the paper and frames they belong to on every render.
 * Sizes are designed in paper millimetres and multiplied by the paper's scale (board mm).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useAppOptional, useAppState, useAppStateShallow } from '@/app/context';
import type { Element, ElementTable } from '@/document';
import { FONT_FAMILY } from '@/geometry/text';
import { boardDoc } from '@/store';
import { mountedViews } from '@/view3d/SceneView';
import { DEFAULT_ACCENT, effectiveOverride, frameContentIds, GHOST, isNeutral, niceLength, type FrameStyling, northArrowOf, paperAncestor, paperScaleOf, scaleBarOf, sheetViewOf, titleBlockOf, type SheetViewMeta } from '@/sheets/model';
import { renderFrame3d } from '@/sheets/frameRender';
import { chartShape } from './chartShapes';
import { worldBounds } from '@/geometry';
import { ElementNode } from './ElementNode';
import { minStroke } from './shapes';

const INK = '#1f2024';
const MUTED = '#6b6d75';
const FRAME_GUIDE = '#2f6fed';

interface SheetItemProps {
  element: Element & { kind: 'rect' };
  elements: ElementTable | undefined;
}

function paperInfo(elements: ElementTable | undefined, element: Element) {
  const paper = elements ? paperAncestor(elements, element) : null;
  const meta = (paper?.meta?.['paper'] ?? {}) as Record<string, unknown>;
  return {
    paper,
    scale: paperScaleOf(paper),
    title: typeof meta['title'] === 'string' ? meta['title'] : (paper?.name ?? 'Sheet'),
    number: typeof meta['number'] === 'string' ? meta['number'] : '',
  };
}

/** Drawn on screen only; exports drop it (see export/compose.ts). */
function ScreenGuide({ width, height, s }: { width: number; height: number; s: number }) {
  return <rect data-screen-only="" width={width} height={height} fill="none" stroke={FRAME_GUIDE} strokeOpacity={0.5} strokeWidth={0.2 * s} strokeDasharray={`${2 * s} ${1.5 * s}`} style={minStroke(0.2 * s, 1)} />;
}

// ---- view frame ----------------------------------------------------------------------------

const SHAPES = ':is(path,rect,polygon,circle,ellipse,line,polyline,text)';
const FILLED = `${SHAPES}:not([fill="none"]):not([style*="fill: none"])`;
const STROKED = `${SHAPES}[stroke]:not([stroke="none"])`;

function cssColor(value: string): string {
  // Only plain colours reach CSS (overrides are validated as #hex by the commands).
  return /^#[0-9a-f]{3,8}$/i.test(value) ? value : 'currentColor';
}

/**
 * Scoped CSS for a frame's overrides: colours and weights beat the elements' own attributes and
 * inline styles, only inside this frame. `u` is crop units per printed millimetre.
 */
function overrideCss(frameId: string, view: SheetViewMeta, ids: readonly string[], u: number): string {
  const rules: string[] = [];
  for (const id of ids) {
    const o = effectiveOverride(view, id);
    if (!o) continue;
    const scope = `[data-vf="${frameId}"] [data-vo="${id}"]`;
    if (o.visibility === 'ghost') {
      rules.push(`${scope} ${FILLED}{fill:${GHOST.fill}!important}`, `${scope} ${STROKED}{stroke:${GHOST.stroke}!important}`, `${scope} image{opacity:0.25}`);
      continue;
    }
    if (o.fill) rules.push(`${scope} ${FILLED}{fill:${cssColor(o.fill)}!important}`);
    if (o.stroke) rules.push(`${scope} ${STROKED}{stroke:${cssColor(o.stroke)}!important}`);
    if (o.weight) rules.push(`${scope} ${STROKED}{stroke-width:${o.weight * u}px!important}`);
    if (o.emphasis === 'outline') rules.push(`${scope} ${STROKED}{stroke:${cssColor(o.accent ?? DEFAULT_ACCENT)}!important;stroke-width:${0.7 * u}px!important}`);
  }
  return rules.join('\n');
}

function filterId(frameId: string, kind: 'glow' | 'shadow', accent: string): string {
  return `vf-${frameId}-${kind}-${accent.replace('#', '')}`;
}

/** SVG filters for the glow/shadow emphases used in a frame (sizes in printed millimetres). */
function EmphasisFilters({ frameId, view, ids, u }: { frameId: string; view: SheetViewMeta; ids: readonly string[]; u: number }) {
  const wanted = new Map<string, { kind: 'glow' | 'shadow'; accent: string }>();
  for (const id of ids) {
    const o = view.overrides[id];
    if (o?.emphasis !== 'glow' && o?.emphasis !== 'shadow') continue;
    const accent = cssColor(o.accent ?? (o.emphasis === 'shadow' ? '#000000' : DEFAULT_ACCENT));
    wanted.set(filterId(frameId, o.emphasis, accent), { kind: o.emphasis, accent });
  }
  if (wanted.size === 0) return null;
  return (
    <defs>
      {[...wanted].map(([id, { kind, accent }]) =>
        kind === 'glow' ? (
          <filter key={id} id={id} x="-20%" y="-20%" width="140%" height="140%" filterUnits="objectBoundingBox">
            <feMorphology in="SourceAlpha" operator="dilate" radius={0.6 * u} result="spread" />
            <feGaussianBlur in="spread" stdDeviation={1.2 * u} result="blur" />
            <feFlood floodColor={accent} floodOpacity={0.85} />
            <feComposite in2="blur" operator="in" result="glow" />
            <feMerge>
              <feMergeNode in="glow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        ) : (
          <filter key={id} id={id} x="-20%" y="-20%" width="150%" height="150%" filterUnits="objectBoundingBox">
            <feDropShadow dx={0.8 * u} dy={1.2 * u} stdDeviation={1 * u} floodColor={accent} floodOpacity={0.35} />
          </filter>
        ),
      )}
    </defs>
  );
}

function VectorFrameContent({ frameId, view, u, picked }: { frameId: string; view: SheetViewMeta; u: number; picked: readonly string[] }) {
  const ids = useAppStateShallow((s) => frameContentIds(boardDoc(s).elements, view));
  const elements = useAppState((s) => boardDoc(s).elements);
  const css = overrideCss(frameId, view, ids, u);
  const { crop, adjustments } = view;
  const labels = ids.flatMap((id) => {
    const label = view.overrides[id]?.label;
    const element = elements[id];
    if (!label || !element) return [];
    const box = worldBounds(elements, element);
    return [{ id, label, x: box.x + box.width / 2, y: box.y + box.height / 2 }];
  });
  const pickedBoxes = picked.flatMap((id) => (elements[id] ? [{ id, box: worldBounds(elements, elements[id]!) }] : []));
  return (
    <g data-vf={frameId}>
      <EmphasisFilters frameId={frameId} view={view} ids={ids} u={u} />
      {css && <style>{css}</style>}
      {adjustments.background && <rect x={crop.x} y={crop.y} width={crop.width} height={crop.height} fill={adjustments.background} />}
      <g style={adjustments.brightness !== 1 || adjustments.contrast !== 1 || adjustments.saturation !== 1 ? { filter: `brightness(${adjustments.brightness}) contrast(${adjustments.contrast}) saturate(${adjustments.saturation})` } : undefined}>
        {ids.map((id) => {
          const o = effectiveOverride(view, id);
          if (o?.visibility === 'hidden') return null;
          const emphasis = view.overrides[id]?.emphasis;
          const filter = emphasis === 'glow' || emphasis === 'shadow' ? `url(#${filterId(frameId, emphasis, cssColor(view.overrides[id]!.accent ?? (emphasis === 'shadow' ? '#000000' : DEFAULT_ACCENT)))})` : undefined;
          const opacity = o?.visibility === 'ghost' ? GHOST.opacity : o?.opacity;
          return (
            <g key={id} data-vo={id} opacity={opacity} filter={filter}>
              <ElementNode id={id} />
            </g>
          );
        })}
      </g>
      {adjustments.tint && adjustments.tintAmount > 0 && <rect x={crop.x} y={crop.y} width={crop.width} height={crop.height} fill={adjustments.tint} opacity={adjustments.tintAmount} style={{ mixBlendMode: 'multiply' }} />}
      {adjustments.grain > 0 && (
        <>
          <filter id={`vf-${frameId}-grain`} x="0" y="0" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency={4 / u} numOctaves={2} seed={7} />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect x={crop.x} y={crop.y} width={crop.width} height={crop.height} filter={`url(#vf-${frameId}-grain)`} opacity={adjustments.grain * 0.35} style={{ mixBlendMode: 'overlay' }} />
        </>
      )}
      {labels.map((item) => (
        <text key={`label-${item.id}`} x={item.x} y={item.y} fontSize={2.8 * u} fontFamily={FONT_FAMILY} fontWeight={600} fill={INK} textAnchor="middle" dominantBaseline="central" stroke="#ffffff" strokeWidth={0.8 * u} paintOrder="stroke" strokeLinejoin="round">
          {item.label}
        </text>
      ))}
      {pickedBoxes.map(({ id, box }) => (
        <rect key={`pick-${id}`} data-screen-only="" x={box.x} y={box.y} width={box.width} height={box.height} fill={FRAME_GUIDE} fillOpacity={0.08} stroke={FRAME_GUIDE} strokeWidth={0.3 * u} style={minStroke(0.3 * u, 1.5)} />
      ))}
    </g>
  );
}

/** Power-of-two steps of the on-screen size, so zooming does not re-render the view constantly. */
function renderSize(width: number, height: number, zoom: number): { width: number; height: number } {
  const screen = Math.max(width, height) * zoom * Math.min(2, window.devicePixelRatio || 1);
  const long = Math.min(4096, Math.max(256, 2 ** Math.ceil(Math.log2(Math.max(1, screen)))));
  const k = long / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

function LiveViewImage({ frameId, view, sourceId, width, height, picked }: { frameId: string; view: SheetViewMeta; sourceId: string; width: number; height: number; picked: readonly string[] }) {
  const elements = useAppState((s) => boardDoc(s).elements);
  const zoom = useAppState((s) => s.ui.viewport.zoom);
  const size = renderSize(width, height, zoom);
  const [image, setImage] = useState<{ key: string; url: string } | null>(null);
  const key = `${sourceId}|${size.width}x${size.height}`;
  // The frame's styling as a stable dependency (`view` is rebuilt on every render).
  const styling = JSON.stringify({ overrides: view.overrides, adjustments: view.adjustments, style: view.style });
  useEffect(() => {
    // After the source view has caught up with the edit (it rebuilds on the next frame).
    const timer = setTimeout(() => {
      const view = JSON.parse(styling) as FrameStyling;
      const source = mountedViews.get(sourceId);
      if (!source) return;
      try {
        setImage({ key, url: renderFrame3d(source, view, size.width, size.height, Object.keys(elements), picked).toDataURL('image/png') });
      } catch {
        // A lost WebGL context: keep the previous image.
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [elements, key, sourceId, size.width, size.height, styling, picked]);
  if (!image) {
    return (
      <g>
        <rect width={width} height={height} fill="#f3f4f6" />
        <text x={width / 2} y={height / 2} fontSize={Math.min(width, height) * 0.05} fontFamily={FONT_FAMILY} fill={MUTED} textAnchor="middle" dominantBaseline="middle">
          Rendering view…
        </text>
      </g>
    );
  }
  // data-styled: a finished render, exempt from the board display style's image filters.
  return <image href={image.url} width={width} height={height} preserveAspectRatio="none" data-styled="true" data-sheet-view-source={sourceId} data-sheet-view-frame={frameId} />;
}

function ViewTitle({ view, width, height, s }: { view: SheetViewMeta; width: number; height: number; s: number }) {
  const r = 3.2 * s;
  const y = height + 5 * s + r;
  const titleSize = 3.5 * s;
  const lineEnd = Math.max(Math.min(width, 120 * s), 60 * s);
  return (
    <g data-sheet-view-title="">
      <circle cx={r} cy={y} r={r} fill="none" stroke={INK} strokeWidth={0.35 * s} />
      <text x={r} y={y} fontSize={2.8 * s} fontFamily={FONT_FAMILY} fontWeight={600} fill={INK} textAnchor="middle" dominantBaseline="central">
        {view.number}
      </text>
      <text x={2 * r + 3 * s} y={y - 0.8 * s} fontSize={titleSize} fontFamily={FONT_FAMILY} fontWeight={600} fill={INK} letterSpacing={0.02 * titleSize}>
        {view.title.toUpperCase()}
      </text>
      <line x1={2 * r + 3 * s} y1={y + 0.9 * s} x2={lineEnd} y2={y + 0.9 * s} stroke={INK} strokeWidth={0.5 * s} />
      <text x={2 * r + 3 * s} y={y + 4.2 * s} fontSize={2.5 * s} fontFamily={FONT_FAMILY} fill={MUTED}>
        {`Scale 1:${view.scale}`}
      </text>
    </g>
  );
}

const NO_PICKS: readonly string[] = [];

function FrameContent({ element, view, scale }: { element: Element & { kind: 'rect' }; view: SheetViewMeta; scale: number }) {
  const editing = useAppState((s) => (s.ui.sheet?.viewEdit?.frameId === element.id ? s.ui.sheet.viewEdit : null));
  const picked = editing?.picked ?? NO_PICKS;
  const { width, height } = element;
  if (view.source === 'view' && view.sourceId) return <LiveViewImage frameId={element.id} view={view} sourceId={view.sourceId} width={width} height={height} picked={picked} />;
  // Crop units per printed millimetre: board mm per paper mm, over the frame's magnification.
  const u = scale / (width / view.crop.width);
  return (
    <svg x={0} y={0} width={width} height={height} viewBox={`${view.crop.x} ${view.crop.y} ${view.crop.width} ${view.crop.height}`} preserveAspectRatio="none" overflow="hidden">
      <VectorFrameContent frameId={element.id} view={view} u={u} picked={picked} />
    </svg>
  );
}

function FrameGuide({ element, s }: { element: Element & { kind: 'rect' }; s: number }) {
  const editing = useAppState((st) => st.ui.sheet?.viewEdit?.frameId === element.id);
  if (!editing) return <ScreenGuide width={element.width} height={element.height} s={s} />;
  return <rect data-screen-only="" width={element.width} height={element.height} fill="none" stroke={FRAME_GUIDE} strokeWidth={0.5 * s} style={minStroke(0.5 * s, 2)} />;
}

export function SheetViewShape({ element, elements }: SheetItemProps): ReactNode {
  const app = useAppOptional();
  const view = sheetViewOf(element)!;
  const { scale } = paperInfo(elements, element);
  const { width, height } = element;
  // Effects svg2pdf cannot draw (filters, blend modes): the PDF exporter bakes this frame to an image.
  const needsBake = !isNeutral(view.adjustments) || Object.values(view.overrides).some((o) => o.emphasis === 'glow' || o.emphasis === 'shadow');
  return (
    <g data-bake-pdf={needsBake && view.source !== 'view' ? '' : undefined}>
      {app ? <FrameContent element={element} view={view} scale={scale} /> : null}
      {app ? <FrameGuide element={element} s={scale} /> : <ScreenGuide width={width} height={height} s={scale} />}
      {view.showTitle && <ViewTitle view={view} width={width} height={height} s={scale} />}
    </g>
  );
}

// ---- title block --------------------------------------------------------------------------

export function TitleBlockShape({ element, elements }: SheetItemProps): ReactNode {
  const block = titleBlockOf(element)!;
  const info = paperInfo(elements, element);
  const { width: W, height: H } = element;
  // Designed for 180 × 32 mm; text follows the block's height, cells its width.
  const u = H / 32;
  const line = 0.25 * u;
  const topH = H * 0.62;
  const col1 = W * 0.34;
  const col2 = W * 0.76;
  const cells: [string, string][] = [
    ['Drawn', block.drawnBy || '—'],
    ['Checked', block.checkedBy || '—'],
    ['Date', block.date || '—'],
    ['Scale', `1:${info.scale}`],
    ['Rev', block.revision || '—'],
  ];
  const cellW = col2 / cells.length;
  const label = (x: number, y: number, text: string) => (
    <text x={x} y={y} fontSize={2 * u} fontFamily={FONT_FAMILY} fill={MUTED} letterSpacing={0.1 * u}>
      {text.toUpperCase()}
    </text>
  );
  const value = (x: number, y: number, text: string, size: number, weight = 500) => (
    <text x={x} y={y} fontSize={size} fontFamily={FONT_FAMILY} fontWeight={weight} fill={INK}>
      {text}
    </text>
  );
  const pad = 2.5 * u;
  return (
    <g>
      <rect width={W} height={H} fill="#ffffff" stroke={INK} strokeWidth={0.5 * u} />
      <line x1={col1} y1={0} x2={col1} y2={topH} stroke={INK} strokeWidth={line} />
      <line x1={col2} y1={0} x2={col2} y2={H} stroke={INK} strokeWidth={line} />
      <line x1={0} y1={topH} x2={col2} y2={topH} stroke={INK} strokeWidth={line} />
      {cells.slice(1).map((_, i) => (
        <line key={i} x1={cellW * (i + 1)} y1={topH} x2={cellW * (i + 1)} y2={H} stroke={INK} strokeWidth={line} />
      ))}
      {label(pad, pad + 2 * u, 'Project')}
      {value(pad, pad + 8 * u, block.project || '—', 4.2 * u, 600)}
      {block.client && value(pad, pad + 13.5 * u, block.client, 2.8 * u, 400)}
      {label(col1 + pad, pad + 2 * u, 'Drawing')}
      {value(col1 + pad, pad + 8 * u, info.title, 4.2 * u, 600)}
      {cells.map(([name, text], i) => (
        <g key={name}>
          {label(cellW * i + pad, topH + pad + 2 * u, name)}
          {value(cellW * i + pad, topH + pad + 7.5 * u, text, 3 * u)}
        </g>
      ))}
      {label(col2 + pad, pad + 2 * u, 'Sheet')}
      <text x={(col2 + W) / 2} y={H * 0.62} fontSize={9 * u} fontFamily={FONT_FAMILY} fontWeight={700} fill={INK} textAnchor="middle">
        {info.number || '—'}
      </text>
    </g>
  );
}

// ---- scale bar ------------------------------------------------------------------------------

export function ScaleBarShape({ element, elements }: SheetItemProps): ReactNode {
  const meta = scaleBarOf(element)!;
  const info = paperInfo(elements, element);
  const frame = meta.frameId && elements ? sheetViewOf(elements[meta.frameId]) : null;
  const drawingScale = frame?.scale ?? info.scale;
  const s = info.scale;
  const { width: W, height: H } = element;
  // Metres the bar can show at the drawing scale, rounded down to 1/2/5 × 10ⁿ.
  const available = ((W / s) * drawingScale) / 1000;
  const total = niceLength(available * 0.85);
  const segments = String(total)[0] === '5' ? 5 : 4;
  const length = ((total * 1000) / drawingScale) * s;
  const barH = Math.min(H * 0.28, 2 * s);
  const top = H * 0.2;
  const unit = (m: number) => (total >= 1000 ? `${m / 1000}` : total < 1 ? `${Math.round(m * 1000)}` : `${+m.toFixed(2)}`);
  const suffix = total >= 1000 ? 'km' : total < 1 ? 'mm' : 'm';
  return (
    <g>
      {Array.from({ length: segments }, (_, i) => (
        <rect key={i} x={(length / segments) * i} y={top} width={length / segments} height={barH} fill={i % 2 === 0 ? INK : '#ffffff'} stroke={INK} strokeWidth={0.25 * s} />
      ))}
      {Array.from({ length: segments + 1 }, (_, i) => (
        <text key={i} x={(length / segments) * i} y={top + barH + 3.6 * s} fontSize={2.4 * s} fontFamily={FONT_FAMILY} fill={INK} textAnchor={i === 0 ? 'start' : i === segments ? 'end' : 'middle'}>
          {i === segments ? `${unit((total / segments) * i)} ${suffix}` : unit((total / segments) * i)}
        </text>
      ))}
      <text x={length + 3 * s} y={top + barH} fontSize={2.4 * s} fontFamily={FONT_FAMILY} fill={MUTED}>
        {`1:${drawingScale}`}
      </text>
    </g>
  );
}

// ---- north arrow ----------------------------------------------------------------------------

export function NorthArrowShape({ element, elements }: SheetItemProps): ReactNode {
  const { rotation } = northArrowOf(element)!;
  const { scale: s } = paperInfo(elements, element);
  const size = Math.min(element.width, element.height);
  const c = size / 2;
  const r = size * 0.36;
  return (
    <g transform={`translate(${element.width / 2 - c} ${element.height / 2 - c})`}>
      <circle cx={c} cy={c} r={r} fill="none" stroke={INK} strokeWidth={0.3 * s} />
      <g transform={`rotate(${rotation} ${c} ${c})`}>
        <polygon points={`${c},${c - r * 1.08} ${c + r * 0.34},${c + r * 0.62} ${c},${c + r * 0.32}`} fill={INK} />
        <polygon points={`${c},${c - r * 1.08} ${c - r * 0.34},${c + r * 0.62} ${c},${c + r * 0.32}`} fill="#ffffff" stroke={INK} strokeWidth={0.25 * s} />
        <text x={c} y={c - r * 1.2} fontSize={size * 0.2} fontFamily={FONT_FAMILY} fontWeight={700} fill={INK} textAnchor="middle">
          N
        </text>
      </g>
    </g>
  );
}

/** The sheet item renderer for an element, if it is one. */
export function sheetItemShape(element: Element, elements: ElementTable | undefined): ReactNode | undefined {
  if (element.kind !== 'rect') return undefined;
  if (sheetViewOf(element)) return <SheetViewShape element={element} elements={elements} />;
  if (titleBlockOf(element)) return <TitleBlockShape element={element} elements={elements} />;
  if (scaleBarOf(element)) return <ScaleBarShape element={element} elements={elements} />;
  if (northArrowOf(element)) return <NorthArrowShape element={element} elements={elements} />;
  const chart = chartShape(element, elements);
  if (chart !== undefined) return chart;
  return undefined;
}

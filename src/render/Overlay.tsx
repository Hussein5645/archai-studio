import { memo } from 'react';
import { FlipHorizontal2, FlipVertical2 } from 'lucide-react';
import { useApp, useAppState, useDispatch, useElementsWithAncestors } from '@/app/context';
import { boardDoc } from '@/store';
import { RIG_HANDLE_RADIUS, RIG_HANDLE_RADIUS_TOUCH, rigHandles } from '@/layers/viewRig';
import { archTypeOf } from '@/assets/arch-meta';
import { parseSystemParameters } from '@/catalog';
import { orientedCorners, worldToScreen, type Vec2 } from '@/geometry';
import { isEffectivelyLocked, SCHEMA_VERSION, type ArchaiDocument } from '@/document';
import { computeSelectionFrame, framePixelSize, ROTATE_HANDLE_OFFSET } from '@/interaction/handles';
import type { OverlayState } from '@/interaction/useInteractions';
import { useTouchMode } from '@/ui/touch';
import { TemplateTree } from './shapes';
import { TempDimensions } from './TempDimensions';
import { paperScaleOf } from '@/sheets/model';
import { worldBounds } from '@/geometry';
import styles from './Workboard.module.css';
import { profileLoops } from '@/drafting/profile';
import { samplePath } from '@/drafting/paths';
import type { ElementTable } from '@/document';
import { inkOutline, inkWidths } from '@/annotations/model';

const ACCENT = 'var(--accent-line)';
/** Sheet mode hides camera/section origins (a stable empty list for the selector). */
const NO_RIGS: ReturnType<typeof rigHandles> = [];

function polygonPoints(points: readonly Vec2[]): string {
  return points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

const SNAP_GUIDE = '#0d9488';

/** Marker colour per snap kind: points green / cyan / orange, inferred lines teal, grid grey. */
function snapColour(kind: string | undefined): string {
  switch (kind) {
    case 'endpoint':
      return '#16a34a';
    case 'midpoint':
      return '#0891b2';
    case 'center':
    case 'quadrant':
      return '#2563eb';
    case 'intersection':
      return '#ea580c';
    case 'perpendicular':
    case 'tangent':
      return '#c026d3';
    case 'tracking':
    case 'polar':
    case 'extension':
      return SNAP_GUIDE;
    case 'grid':
      return '#6b7280';
    default:
      return ACCENT;
  }
}

/** AutoCAD-style snap glyphs: square end, triangle middle, circle centre, X intersection, … */
function SnapMarker({ kind, x, y }: { kind: string; x: number; y: number }) {
  const colour = snapColour(kind);
  const s = 5.5;
  const common = { fill: 'none', stroke: colour, strokeWidth: 1.75 } as const;
  switch (kind) {
    case 'endpoint':
      return <rect x={x - s} y={y - s} width={s * 2} height={s * 2} {...common} />;
    case 'midpoint':
      return <polygon points={`${x},${y - s - 1} ${x + s + 1},${y + s} ${x - s - 1},${y + s}`} {...common} />;
    case 'center':
      return <circle cx={x} cy={y} r={s} {...common} />;
    case 'quadrant':
      return <polygon points={`${x},${y - s - 1} ${x + s + 1},${y} ${x},${y + s + 1} ${x - s - 1},${y}`} {...common} />;
    case 'intersection':
      return <path d={`M ${x - s} ${y - s} L ${x + s} ${y + s} M ${x + s} ${y - s} L ${x - s} ${y + s}`} {...common} />;
    case 'perpendicular':
      return <path d={`M ${x - s} ${y - s} V ${y + s} H ${x + s} M ${x - s} ${y} H ${x} V ${y + s}`} {...common} />;
    case 'tangent':
      return (
        <g>
          <circle cx={x} cy={y} r={s - 1} {...common} />
          <line x1={x - s - 2} y1={y - s + 1} x2={x + s + 2} y2={y - s + 1} stroke={colour} strokeWidth={1.75} />
        </g>
      );
    case 'nearest':
      return <path d={`M ${x - s} ${y - s} H ${x + s} L ${x - s} ${y + s} H ${x + s} Z`} {...common} />;
    case 'grid':
      return <path d={`M ${x - s} ${y} H ${x + s} M ${x} ${y - s} V ${y + s}`} stroke={colour} strokeWidth={1.25} />;
    default:
      return <path d={`M ${x - s} ${y} H ${x + s} M ${x} ${y - s} V ${y + s}`} stroke={colour} strokeWidth={1.5} />;
  }
}

/** Drafting / modify tool previews and the cursor prompt (instruction, typed value, measurement). */
function DraftingLayer({ draft, viewport }: { draft: NonNullable<OverlayState['drafting']>; viewport: { x: number; y: number; zoom: number } }) {
  const screen = (p: Vec2) => worldToScreen(viewport, p);
  const prompt = draft.prompt;
  const at = prompt ? screen(prompt.at) : null;
  const lines = prompt ? [prompt.typed ? `› ${prompt.typed}` : null, prompt.measure, prompt.text].filter((line): line is string => Boolean(line)) : [];
  const width = Math.max(90, ...lines.map((line) => line.length * 6.3 + 16));
  return (
    <g data-testid="drafting-overlay">
      {draft.paths.map((path, i) =>
        path.closed ? (
          <polygon key={i} points={polygonPoints(path.points.map(screen))} fill="var(--accent-soft)" stroke={ACCENT} strokeWidth={1.25} opacity={0.9} />
        ) : (
          <polyline key={i} points={polygonPoints(path.points.map(screen))} fill="none" stroke={ACCENT} strokeWidth={1.5} />
        ),
      )}
      {draft.rubber && (() => {
        const a = screen(draft.rubber.a);
        const b = screen(draft.rubber.b);
        return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={ACCENT} strokeWidth={1} strokeDasharray="6 4" />;
      })()}
      {draft.picks.map((p, i) => {
        const s = screen(p);
        return <circle key={i} cx={s.x} cy={s.y} r={3.5} fill="#fff" stroke={ACCENT} strokeWidth={1.25} />;
      })}
      {at && lines.length > 0 && (
        <g transform={`translate(${at.x + 18} ${at.y + 16})`} data-testid="drafting-prompt">
          <rect width={width} height={lines.length * 16 + 8} rx={6} fill="rgba(255,255,255,.94)" stroke="rgba(37,99,235,.28)" />
          {lines.map((line, i) => (
            <text key={i} x={8} y={17 + i * 16} fontSize={11} fontWeight={i === 0 && prompt?.typed ? 700 : 500} fill={i === lines.length - 1 ? '#5f6470' : ACCENT}>
              {line}
            </text>
          ))}
        </g>
      )}
    </g>
  );
}

/** Screen-space selection UI, marquee, hover outline and drawing previews. */
/**
 * The profile drawing mode: the boundary's curves in magenta (closed loops filled lightly) and a
 * red ring on every open end, so a gap in the loop is easy to find.
 */
function ProfileLayer({ viewport }: { viewport: { x: number; y: number; zoom: number } }) {
  const edit = useAppState((s) => s.ui.profileEdit);
  const elements = useAppState((s) => (s.ui.profileEdit ? boardDoc(s).elements : null));
  if (!edit || !elements) return null;
  const loops = profileLoops(elements as ElementTable, edit);
  const screen = (path: Parameters<typeof samplePath>[0]) => samplePath(path).map((p) => `${p.x * viewport.zoom + viewport.x},${p.y * viewport.zoom + viewport.y}`).join(' ');
  return (
    <g pointerEvents="none" data-testid="profile-layer">
      {loops.closed.map((path, i) => <polygon key={`c${i}`} points={screen(path)} fill="#d946ef1f" stroke="#d946ef" strokeWidth={3} strokeLinejoin="round" />)}
      {loops.open.map((path, i) => <polyline key={`o${i}`} points={screen(path)} fill="none" stroke="#d946ef" strokeWidth={3} strokeLinejoin="round" />)}
      {loops.openEnds.map((p, i) => <circle key={`e${i}`} cx={p.x * viewport.zoom + viewport.x} cy={p.y * viewport.zoom + viewport.y} r={7} fill="#ffffff" stroke="#dc2626" strokeWidth={2.5} />)}
    </g>
  );
}

export const Overlay = memo(function Overlay({ state }: { state: OverlayState }) {
  const { store } = useApp();
  const dispatch = useDispatch();
  const { isTouch } = useTouchMode();
  // Only the selected/hovered elements (and their ancestors, for worldMatrix) plus the doc's
  // other slices, which Immer already keeps reference-stable across unrelated edits — not the
  // whole `doc.elements` table, which gets a new reference on every edit anywhere.
  const docId = useAppState((s) => boardDoc(s).id);
  const meta = useAppState((s) => boardDoc(s).meta);
  const definitions = useAppState((s) => boardDoc(s).definitions);
  const blobs = useAppState((s) => boardDoc(s).blobs);
  const workspace = useAppState((s) => boardDoc(s).workspace);
  const selection = useAppState((s) => s.ui.selection);
  const elements = useElementsWithAncestors([state.hoverId, ...(state.cycle?.ids ?? []), ...selection]);
  const doc: ArchaiDocument = { schemaVersion: SCHEMA_VERSION, id: docId, meta, workspace, elements, definitions, blobs, materials: {} };
  const viewport = useAppState((s) => s.ui.viewport);
  // Cached per element table, so this re-renders only when the document changes.
  const rigs = useAppState((s) => (s.ui.sheet || s.ui.groupEditId ? NO_RIGS : rigHandles(boardDoc(s).elements)));
  const editingTextId = useAppState((s) => s.ui.editingTextId);
  // Sheet mode: the open paper, for its margin and centre guides.
  const sheetPaper = useAppState((s) => (s.ui.sheet ? boardDoc(s).elements[s.ui.sheet.paperId] : undefined));
  const sheetPaperParents = useElementsWithAncestors([sheetPaper?.id ?? null]);
  const frame = editingTextId ? null : computeSelectionFrame(doc, selection, viewport);
  void store;

  const handleSize = isTouch ? 11 : 8;
  const endpointRadius = isTouch ? 6.5 : 5;
  const rotateRadius = isTouch ? 6 : 4.5;

  const hoverElement = state.hoverId && !selection.includes(state.hoverId) ? doc.elements[state.hoverId] : undefined;
  const hoverCorners = hoverElement ? orientedCorners(doc.elements, hoverElement).map((c) => worldToScreen(viewport, c)) : null;

  const isGrip = (id: string) => id === 'start' || id === 'end' || id.startsWith('point:') || id.startsWith('curve:') || id.startsWith('vertex:') || id.startsWith('seg:') || id.startsWith('radius:') || id.startsWith('node:');
  const endpointFrame = frame?.handles.some((handle) => isGrip(handle.id)) ?? false;
  const showHandles = frame && !state.dragging && frame.handles.length > 0 && !selection.some((id) => isEffectivelyLocked(doc.elements, id)) && (() => {
    const size = framePixelSize(frame);
    return endpointFrame || size.width > 12 || size.height > 12;
  })();
  const selectedDoor = selection.length === 1 && archTypeOf(doc.elements[selection[0]!]) === 'door' ? doc.elements[selection[0]!] : null;
  const doorParameters = selectedDoor ? parseSystemParameters('door', (selectedDoor.meta?.['arch'] as { parameters?: unknown } | undefined)?.parameters) : null;
  const doorControls = frame && selectedDoor && doorParameters && !state.dragging && !isEffectivelyLocked(doc.elements, selectedDoor.id)
    ? {
        id: selectedDoor.id,
        handing: doorParameters.handing,
        openingSide: doorParameters.openingSide,
        x: Math.max(4, Math.min(...frame.corners.map((corner) => corner.x))),
        y: Math.max(4, Math.min(...frame.corners.map((corner) => corner.y)) - 32),
      }
    : null;

  return (
    <svg className={styles.overlay} aria-hidden="true">
      {sheetPaper && (() => {
        const box = worldBounds(sheetPaperParents, sheetPaper);
        const margin = 10 * paperScaleOf(sheetPaper);
        const a = worldToScreen(viewport, { x: box.x + margin, y: box.y + margin });
        const b = worldToScreen(viewport, { x: box.x + box.width - margin, y: box.y + box.height - margin });
        const c = worldToScreen(viewport, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
        const tl = worldToScreen(viewport, { x: box.x, y: box.y });
        const br = worldToScreen(viewport, { x: box.x + box.width, y: box.y + box.height });
        return (
          <g data-testid="sheet-guides" opacity={0.45}>
            <rect x={a.x} y={a.y} width={b.x - a.x} height={b.y - a.y} fill="none" stroke="#0d9488" strokeWidth={1} strokeDasharray="6 5" />
            <line x1={c.x} y1={tl.y} x2={c.x} y2={br.y} stroke="#0d9488" strokeWidth={0.75} strokeDasharray="2 6" />
            <line x1={tl.x} y1={c.y} x2={br.x} y2={c.y} stroke="#0d9488" strokeWidth={0.75} strokeDasharray="2 6" />
          </g>
        );
      })()}
      {hoverCorners && <polygon points={polygonPoints(hoverCorners)} fill="none" stroke={ACCENT} strokeWidth={1} opacity={0.6} />}

      {state.cycle && (
        <g data-testid="tab-cycle">
          {state.cycle.ids.map((id) => {
            const element = doc.elements[id];
            if (!element) return null;
            const corners = orientedCorners(doc.elements, element).map((c) => worldToScreen(viewport, c));
            return <polygon key={id} points={polygonPoints(corners)} fill="var(--accent-soft, rgba(37, 99, 235, 0.08))" stroke={ACCENT} strokeWidth={2} strokeDasharray="5 3" />;
          })}
          <g transform={`translate(${state.cycle.at.x + 16} ${state.cycle.at.y + 18})`}>
            <rect width={state.cycle.label.length * 6.6 + 44} height={22} rx={6} fill="rgba(255,255,255,.96)" stroke="rgba(37,99,235,.35)" />
            <text x={8} y={15} fontSize={11.5} fill="#1f2024">
              <tspan fontWeight={600} fill={ACCENT}>Tab</tspan>
              <tspan>{`  ${state.cycle.label}`}</tspan>
            </text>
          </g>
        </g>
      )}

      {rigs.map((rig) => {
        // Camera/section origin: drag it to move the view and its marker together.
        const at = worldToScreen(viewport, rig);
        const r = isTouch ? RIG_HANDLE_RADIUS_TOUCH : RIG_HANDLE_RADIUS;
        const colour = rig.kind === 'camera' ? '#8b5cf6' : rig.kind === 'plan' ? '#0d9488' : '#2563eb';
        const selected = selection.includes(rig.id);
        return (
          <g key={rig.id} data-rig-handle={rig.id}>
            <circle cx={at.x} cy={at.y} r={r} fill={selected ? colour : '#ffffff'} stroke={colour} strokeWidth={2} />
            <path d={`M ${at.x - r * 0.55} ${at.y} H ${at.x + r * 0.55} M ${at.x} ${at.y - r * 0.55} V ${at.y + r * 0.55}`} stroke={selected ? '#ffffff' : colour} strokeWidth={1.5} />
          </g>
        );
      })}

      {frame && (
        <g>
          {frame.kind === 'multi' &&
            selection.map((id) => {
              const element = doc.elements[id];
              if (!element) return null;
              const corners = orientedCorners(doc.elements, element).map((c) => worldToScreen(viewport, c));
              return <polygon key={id} points={polygonPoints(corners)} fill="none" stroke={ACCENT} strokeWidth={1} opacity={0.5} />;
            })}
          <polygon points={polygonPoints(frame.corners)} fill="none" stroke={ACCENT} strokeWidth={1} opacity={endpointFrame ? 0.5 : 1} />
          {showHandles &&
            frame.handles.filter((handle) => handle.tie).map((handle) => (
              <line key={`tie-${handle.id}`} x1={handle.tie!.x} y1={handle.tie!.y} x2={handle.x} y2={handle.y} stroke={ACCENT} strokeWidth={1} opacity={0.7} />
            ))}
          {showHandles &&
            frame.handles.map((handle) =>
              handle.id.startsWith('seg:') ? (
                <rect key={handle.id} x={handle.x - endpointRadius + 1} y={handle.y - endpointRadius + 1} width={(endpointRadius - 1) * 2} height={(endpointRadius - 1) * 2} fill="var(--accent-soft)" stroke={ACCENT} strokeWidth={1.25} data-testid={`grip-${handle.id}`} />
              ) : isGrip(handle.id) ? (
                <circle key={handle.id} cx={handle.x} cy={handle.y} r={endpointRadius} fill={handle.id.startsWith('curve:') || handle.id.startsWith('radius:') ? 'var(--accent-soft)' : '#fff'} stroke={ACCENT} strokeWidth={1.5} data-testid={`endpoint-${handle.id}`} />
              ) : handle.id === 'rotate' ? (() => {
                // Stem to the top edge's midpoint: the n grip may be hidden (type-owned sizes).
                const topMid = { x: (frame.corners[0].x + frame.corners[1].x) / 2, y: (frame.corners[0].y + frame.corners[1].y) / 2 };
                return (
                  <g key={handle.id}>
                    <line
                      x1={handle.x - ((handle.x - topMid.x) * (ROTATE_HANDLE_OFFSET - 6)) / ROTATE_HANDLE_OFFSET}
                      y1={handle.y - ((handle.y - topMid.y) * (ROTATE_HANDLE_OFFSET - 6)) / ROTATE_HANDLE_OFFSET}
                      x2={topMid.x}
                      y2={topMid.y}
                      stroke={ACCENT}
                      strokeWidth={1}
                    />
                    <circle cx={handle.x} cy={handle.y} r={rotateRadius} fill="#fff" stroke={ACCENT} strokeWidth={1.25} />
                  </g>
                );
              })() : (
                <rect
                  key={handle.id}
                  data-testid={`resize-${handle.id}`}
                  x={handle.x - handleSize / 2}
                  y={handle.y - handleSize / 2}
                  width={handleSize}
                  height={handleSize}
                  rx={1.5}
                  fill="#fff"
                  stroke={ACCENT}
                  strokeWidth={1.25}
                  transform={frame.rotation ? `rotate(${frame.rotation} ${handle.x} ${handle.y})` : undefined}
                />
              ),
            )}
          {doorControls && (
            <g className={styles.doorFlipControls} transform={`translate(${doorControls.x} ${doorControls.y})`}>
              <g
                data-testid="flip-door-handing"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  void dispatch('set-system-parameter', { id: doorControls.id, key: 'handing', value: doorControls.handing === 'left' ? 'right' : 'left' });
                }}
              >
                <title>Flip door left/right</title>
                <rect width={26} height={26} rx={5} />
                <FlipHorizontal2 x={5} y={5} width={16} height={16} />
              </g>
              <g
                transform="translate(30 0)"
                data-testid="flip-door-opening-side"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  void dispatch('set-system-parameter', { id: doorControls.id, key: 'openingSide', value: doorControls.openingSide === 'inside' ? 'outside' : 'inside' });
                }}
              >
                <title>Flip door inside/outside</title>
                <rect width={26} height={26} rx={5} />
                <FlipVertical2 x={5} y={5} width={16} height={16} />
              </g>
            </g>
          )}
        </g>
      )}

      {frame?.kind === 'single' && frame.element && !state.dragging && !state.drafting && !isEffectivelyLocked(doc.elements, frame.element.id) && (
        <TempDimensions doc={doc} element={frame.element} viewport={viewport} unit={workspace.unit} precision={workspace.precision} />
      )}

      {state.marquee && (
        <rect
          x={state.marquee.x}
          y={state.marquee.y}
          width={state.marquee.width}
          height={state.marquee.height}
          fill={state.marqueeWindow === false ? 'rgba(22, 163, 74, 0.1)' : 'var(--accent-soft)'}
          stroke={state.marqueeWindow === false ? '#16a34a' : ACCENT}
          strokeDasharray={state.marqueeWindow === false ? '6 4' : undefined}
          strokeWidth={1}
          data-testid="marquee"
          data-mode={state.marqueeWindow === false ? 'crossing' : 'window'}
        />
      )}

      {state.draft?.kind === 'rect' && (
        <rect
          x={state.draft.rect.x * viewport.zoom + viewport.x}
          y={state.draft.rect.y * viewport.zoom + viewport.y}
          width={state.draft.rect.width * viewport.zoom}
          height={state.draft.rect.height * viewport.zoom}
          rx={state.draft.radius ? state.draft.radius * viewport.zoom : undefined}
          fill="var(--accent-soft)"
          stroke={ACCENT}
          strokeWidth={1}
        />
      )}

      {state.draft?.kind === 'stair' && (
        <g>
          <g transform={`matrix(${viewport.zoom} 0 0 ${viewport.zoom} ${viewport.x} ${viewport.y})`} opacity={0.72}>
            <TemplateTree table={state.draft.table} parentId={null} context={{ definitions: doc.definitions, blobs: doc.blobs, elements: doc.elements, workspace: doc.workspace }} />
          </g>
          {(() => {
            const at = worldToScreen(viewport, state.draft.anchor);
            const origin = worldToScreen(viewport, state.draft.origin);
            return (
              <g data-testid="stair-caption">
                <circle cx={origin.x} cy={origin.y} r={5} fill="#fff" stroke={ACCENT} strokeWidth={2} />
                <circle cx={at.x} cy={at.y} r={4} fill={ACCENT} stroke="#fff" strokeWidth={2} />
                <g transform={`translate(${at.x + 14} ${at.y - 72})`}>
                  <rect width={420} height={62} rx={7} fill="rgba(255,255,255,.94)" stroke="rgba(37,99,235,.28)" />
                  <text x={10} y={19} fontSize={12} fontWeight={600} fill={ACCENT}>{state.draft.status}</text>
                  <text x={10} y={37} fontSize={11} fill="#5f6470">{state.draft.hint}</text>
                  <text x={10} y={53} fontSize={10} fill="#858a95">Ctrl+Z / Ctrl+Shift+Z step history · Enter/right-click finish · Esc cancel</text>
                </g>
              </g>
            );
          })()}
        </g>
      )}

      {state.snap && (() => {
        const at = worldToScreen(viewport, state.snap.point);
        return (
          <g data-testid="snap-label" data-snap-kind={state.snap.kind}>
            {state.snap.guides?.map((guide, i) => {
              const a = worldToScreen(viewport, guide.a);
              const b = worldToScreen(viewport, guide.b);
              return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={SNAP_GUIDE} strokeWidth={1} strokeDasharray="4 4" />;
            })}
            <SnapMarker kind={state.snap.kind ?? ''} x={at.x} y={at.y} />
            <text x={at.x + 10} y={at.y - 9} fontSize={11} fill={snapColour(state.snap.kind)} stroke="#fff" strokeWidth={3} paintOrder="stroke">
              {state.snap.text}
            </text>
          </g>
        );
      })()}

      <ProfileLayer viewport={viewport} />
      {state.drafting && <DraftingLayer draft={state.drafting} viewport={viewport} />}

      {state.draft?.kind === 'ink' && (() => {
        const points = state.draft.points.map((p) => worldToScreen(viewport, p));
        const width = state.draft.width * viewport.zoom;
        return state.draft.highlighter ? (
          <polyline points={polygonPoints(points)} fill="none" stroke={state.draft.color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" opacity={0.45} style={{ mixBlendMode: 'multiply' }} data-testid="ink-draft" />
        ) : (
          <path d={inkOutline(points, inkWidths(points.length, width, state.draft.pressure))} fill={state.draft.color} data-testid="ink-draft" />
        );
      })()}

      {state.draft?.kind === 'polyline' && (
        <g>
          <polyline
            points={polygonPoints([...state.draft.points, ...(state.draft.cursor ? [state.draft.cursor] : [])].map((p) => worldToScreen(viewport, p)))}
            fill="none"
            stroke={state.draft.style.stroke ?? '#3a3a3f'}
            strokeWidth={Math.max(1, state.draft.style.strokeWidth * viewport.zoom)}
            strokeLinejoin="miter"
            opacity={0.6}
          />
          {state.draft.points.map((p, i) => {
            const s = worldToScreen(viewport, p);
            return <circle key={i} cx={s.x} cy={s.y} r={3.5} fill="#fff" stroke={ACCENT} strokeWidth={1.25} />;
          })}
        </g>
      )}

      {state.draft?.kind === 'enclosure' && (
        <polygon
          points={polygonPoints(state.draft.points.map((point) => worldToScreen(viewport, point)))}
          fill="rgba(47, 111, 237, 0.14)"
          stroke={ACCENT}
          strokeWidth={1.5}
          strokeDasharray="7 5"
        />
      )}

      {state.draft?.kind === 'placement' && (
        <g transform={`matrix(${viewport.zoom} 0 0 ${viewport.zoom} ${viewport.x} ${viewport.y})`} opacity={0.62}>
          <g transform={`translate(${state.draft.x} ${state.draft.y}) rotate(${state.draft.rotation})`}>
            {state.draft.imageUrl && (
              <image href={state.draft.imageUrl} width={state.draft.width} height={state.draft.height} preserveAspectRatio="none" />
            )}
            {state.draft.template && (
              <TemplateTree
                table={Object.fromEntries(state.draft.template.elements.map((element) => [element.id, element]))}
                parentId={null}
                context={{ definitions: doc.definitions, blobs: doc.blobs, elements: doc.elements, workspace: doc.workspace }}
              />
            )}
            <rect
              width={state.draft.width}
              height={state.draft.height}
              fill="none"
              stroke={ACCENT}
              strokeWidth={1.5 / viewport.zoom}
              strokeDasharray={`${8 / viewport.zoom} ${5 / viewport.zoom}`}
            />
          </g>
        </g>
      )}
    </svg>
  );
});

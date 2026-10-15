import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { useApp, useAppState, useDispatch } from '@/app/context';
import { formatShortcut, IS_MAC } from '@/commands';
import { gridStepForZoom } from '@/interaction/snap';
import { useInteractions } from '@/interaction/useInteractions';
import type { Vec2 } from '@/geometry';
import type { ElementTable } from '@/document';
import { boardRuns } from './boardRuns';
import { boardDoc } from '@/store';
import { ElementNode } from './ElementNode';
import { PeersOverlay } from './PeersOverlay';
import { BridgeOverlay } from './BridgeOverlay';
import { Overlay } from './Overlay';
import { ToolPrompt } from '@/ui/ToolPrompt';
import { ProfileEditBar } from '@/ui/ProfileEditBar';
import { TextEditor } from './TextEditor';
import { View3DPortal } from '@/view3d/View3DPortal';
import { AiPortal } from './AiPortal';
import { AnalysisNode } from '@/analysis/AnalysisNode';
import { BoardMapOverlay, MapOverlays } from '@/analysis/MapView';
import { TouchActionBar } from '@/ui/TouchActionBar';
import { useTouchMode } from '@/ui/touch';
import { useParametricAssets } from './useParametricAssets';
import styles from './Workboard.module.css';

function gridStyle(visible: boolean, gridSize: number, viewport: { x: number; y: number; zoom: number }): CSSProperties {
  if (!visible) return {};
  const step = gridStepForZoom(gridSize, viewport.zoom);
  const px = step * viewport.zoom;
  const major = px * 5;
  const line = 'rgba(30, 30, 40, 0.07)';
  const strong = 'rgba(30, 30, 40, 0.12)';
  return {
    backgroundImage: [
      `linear-gradient(to right, ${strong} 1px, transparent 1px)`,
      `linear-gradient(to bottom, ${strong} 1px, transparent 1px)`,
      `linear-gradient(to right, ${line} 1px, transparent 1px)`,
      `linear-gradient(to bottom, ${line} 1px, transparent 1px)`,
    ].join(', '),
    backgroundSize: `${major}px ${major}px, ${major}px ${major}px, ${px}px ${px}px, ${px}px ${px}px`,
    backgroundPosition: `${viewport.x}px ${viewport.y}px`,
  };
}

export function Workboard({ onContextMenu }: { onContextMenu: (position: Vec2) => void }) {
  const { store } = useApp();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewport = useAppState((s) => s.ui.viewport);
  const tool = useAppState((s) => s.ui.tool);
  const grid = useAppState((s) => boardDoc(s).workspace.grid);
  const background = useAppState((s) => boardDoc(s).workspace.background);
  const viewStyle = useAppState((s) => boardDoc(s).workspace.viewStyle);
  const elements = useAppState((s) => boardDoc(s).elements);
  const view3dOpen = useAppState((s) => s.ui.view3d.open);
  const sheetId = useAppState((s) => s.ui.sheet?.paperId ?? null);
  const groupId = useAppState((s) => s.ui.groupEditId);
  const isEmpty = useAppState((s) => Object.keys(boardDoc(s).elements).length === 0);
  const { overlay, handlers, drawingActions } = useInteractions(containerRef, { onContextMenu });
  const { isTouch } = useTouchMode();
  const hasSelection = useAppState((s) => s.ui.selection.length > 0);
  const dispatch = useDispatch();
  // Parametric .CAI copies: rebuild with their values and fit their boxes (see useParametricAssets).
  useParametricAssets();

  // Keep the canvas size in UI state for zoom-to-fit and friends.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const update = () => {
      const { width, height } = node.getBoundingClientRect();
      const state = store.getState();
      if (state.ui.canvasSize.width !== width || state.ui.canvasSize.height !== height) {
        store.setState({ ui: { ...state.ui, canvasSize: { width, height } } });
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [store]);

  // --px (mm per screen pixel) lets strokes, measurements and markers keep a minimum on-screen size (see minStroke).
  // Sheet mode: a neutral desk around the sheet, no grid.
  const style = useMemo(
    () => (sheetId ? { background: 'var(--sheet-desk, #d9dbe0)', '--px': String(1 / viewport.zoom) } : { background, ...gridStyle(grid.visible, grid.size, viewport), '--px': String(1 / viewport.zoom) }) as CSSProperties,
    [background, grid, viewport, sheetId],
  );
  const transform = `matrix(${viewport.zoom} 0 0 ${viewport.zoom} ${viewport.x} ${viewport.y})`;

  return (
    <div
      ref={containerRef}
      className={styles.board}
      style={style}
      tabIndex={0}
      role="application"
      aria-label="Workboard"
      data-testid="workboard"
      data-tool={tool}
      data-sheet-mode={sheetId ? 'true' : undefined}
      data-group-edit={groupId ?? undefined}
      data-panning={overlay.panning || undefined}
      data-cursor={overlay.cursor ?? undefined}
      {...handlers}
    >
      <BoardLayers elements={elements} transform={transform} viewStyle={viewStyle} hidePortals={view3dOpen} sheetId={sheetId} />
      <Overlay state={overlay} />
      <BridgeOverlay />
      <PeersOverlay />
      <ToolPrompt onDone={drawingActions.doneSelecting} />
      <ProfileEditBar />
      {/* The full-screen 3D workspace covers the board: its own bar (and close button) wins. */}
      {isTouch && !view3dOpen && (
        <TouchActionBar
          drawing={overlay.drawing !== null}
          onDone={drawingActions.finish}
          onUndoPoint={drawingActions.undoPoint}
          onCancel={drawingActions.cancel}
          hasSelection={hasSelection}
          onDuplicate={() => void dispatch('duplicate-selection')}
          onDelete={() => void dispatch('delete-selection')}
          modifiers={['straight', 'snapOff', 'additive', 'selectArea']}
        />
      )}
      <TextEditor />
      {isEmpty && tool === 'select' && !sheetId && (
        <div className={styles.empty}>
          <div className={styles.emptyCard}>
            <strong>Empty board</strong>
            Press <kbd className="u-kbd">R</kbd> for a rectangle, <kbd className="u-kbd">W</kbd> for a wall, or{' '}
            <kbd className="u-kbd">{formatShortcut('Mod+K', IS_MAC)}</kbd> for every command.
          </div>
        </div>
      )}
    </div>
  );
}

/** SVG runs and live view portals share one DOM order, so Layers is the actual board z-order. */
function BoardLayers({ elements, transform, viewStyle, hidePortals, sheetId }: { elements: ElementTable; transform: string; viewStyle: string; hidePortals: boolean; sheetId: string | null }) {
  // Paint order only depends on `elements`, not viewport/tool — memoise it so panning and
  // zooming (which re-render Workboard every pointermove) don't recompute it every frame.
  const runs = useMemo(() => boardRuns(elements, sheetId), [elements, sheetId]);
  return (
    <div className={styles.world} data-testid="world" data-view-style={viewStyle} data-sheet={sheetId ?? undefined}>
      {runs.map((run, index) =>
        run.kind === 'portal' ? (
          hidePortals ? null : run.hidden ? (
            <div key={`hidden-${run.id}`} className={styles.hiddenPortal} aria-hidden="true">
              <View3DPortal id={run.id} />
            </div>
          ) : (
            <View3DPortal key={run.id} id={run.id} />
          )
        ) : run.kind === 'aiPortal' ? (
          hidePortals ? null : <AiPortal key={run.id} id={run.id} />
        ) : run.kind === 'analysis' ? (
          <AnalysisNode key={`analysis-${run.ids[0]}`} id={run.ids[0]!} />
        ) : run.kind === 'mapOverlay' ? (
          <BoardMapOverlay key={`map-overlay-${run.id}`} id={run.id} />
        ) : (
          <svg key={`paint-${index}`} className={styles.paintLayer} data-run={index}>
            <g transform={transform}>
              {run.ids.map((id) => <ElementNode key={id} id={id} />)}
            </g>
          </svg>
        ),
      )}
      <MapOverlays />
    </div>
  );
}

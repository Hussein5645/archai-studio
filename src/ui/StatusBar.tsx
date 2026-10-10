import { ChevronDown, ChevronUp, Crosshair, Grid3x3, Magnet, Palette } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { formatLength } from '@/geometry';
import { levelElevationOf } from '@/view3d/geometry';
import { useAppState, useDispatch } from '@/app/context';
import { formatShortcut, IS_MAC } from '@/commands';
import { OBJECT_SNAP_KINDS, SNAP_CAPTIONS } from '@/drafting/osnap';
import { IconButton, Menu, type MenuContent } from './primitives';
import styles from './Toolbar.module.css';

/** Bottom-right chip: element graphics, grid and snapping toggles, zoom level (with a menu). */
export function StatusBar() {
  const dispatch = useDispatch();
  const zoom = useAppState((s) => s.ui.viewport.zoom);
  const grid = useAppState((s) => s.doc.workspace.grid.visible);
  const snap = useAppState((s) => s.doc.workspace.snap.enabled);
  const hasElements = useAppState((s) => Object.keys(s.doc.elements).length > 0);
  const hasSelection = useAppState((s) => s.ui.selection.length > 0);
  const osnap = useAppState((s) => s.ui.drafting.osnap);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [snapMenu, setSnapMenu] = useState<{ x: number; y: number } | null>(null);
  const zoomRef = useRef<HTMLButtonElement>(null);
  const boardElevation = useAppState((s) => s.doc.workspace.boardElevation ?? 0);
  const unit = useAppState((s) => s.doc.workspace.unit);
  const precision = useAppState((s) => s.doc.workspace.precision);
  const elements = useAppState((s) => s.doc.elements);
  const levels = useMemo(() => Object.values(elements).flatMap((element) => {
    const elevation = levelElevationOf(element);
    return elevation === null ? [] : [{ id: element.id, name: element.name ?? 'Level', elevation }];
  }).sort((a, b) => b.elevation - a.elevation), [elements]);
  const [levelMenu, setLevelMenu] = useState<{ x: number; y: number } | null>(null);
  const levelRef = useRef<HTMLButtonElement>(null);
  const signed = (mm: number) => `${mm > 0 ? '+' : ''}${formatLength(mm, unit, precision)}`;
  const tick = (on: boolean, label: string) => `${on ? '✓ ' : '    '}${label}`;
  const levelEntries: MenuContent = [
    { title: 'Board level (new elements start here)' },
    ...levels.map((level) => ({ id: `level-${level.id}`, label: tick(Math.abs(level.elevation - boardElevation) < 0.5, `${level.name} · ${signed(level.elevation)}`), onSelect: () => void dispatch('set-workspace', { boardElevation: level.elevation }) })),
    ...(levels.some((level) => Math.abs(level.elevation) < 0.5) ? [] : [{ id: 'level-ground', label: tick(Math.abs(boardElevation) < 0.5, `Ground · ${signed(0)}`), onSelect: () => void dispatch('set-workspace', { boardElevation: 0 }) }]),
    { separator: true },
    { id: 'level-up', label: 'Up one level', shortcut: formatShortcut('Alt+PageUp', IS_MAC), onSelect: () => void dispatch('board-level-up') },
    { id: 'level-down', label: 'Down one level', shortcut: formatShortcut('Alt+PageDown', IS_MAC), onSelect: () => void dispatch('board-level-down') },
  ];
  const snapRef = useRef<HTMLButtonElement>(null);

  const snapEntries: MenuContent = [
    { title: 'Object snaps' },
    { id: 'osnap', label: tick(osnap.objects, 'Snap to geometry'), shortcut: 'F3', onSelect: () => void dispatch('toggle-object-snap') },
    ...OBJECT_SNAP_KINDS.map((kind) => ({ id: `osnap-${kind}`, label: tick(osnap.kinds[kind], SNAP_CAPTIONS[kind]), disabled: !osnap.objects, onSelect: () => void dispatch('set-drafting', { osnap: { kinds: { [kind]: !osnap.kinds[kind] } } }) })),
    { separator: true },
    { title: 'Tracking' },
    { id: 'tracking', label: tick(osnap.tracking, 'Alignment lines'), onSelect: () => void dispatch('set-drafting', { osnap: { tracking: !osnap.tracking } }) },
    ...[0, 15, 30, 45, 90].map((angle) => ({ id: `polar-${angle}`, label: tick(osnap.polar === angle, angle ? `Polar ${angle}°` : 'Polar off'), onSelect: () => void dispatch('set-drafting', { osnap: { polar: angle } }) })),
  ];

  const entries: MenuContent = [
    { id: 'zoom-in', label: 'Zoom in', shortcut: formatShortcut('Mod+Equal', IS_MAC), onSelect: () => void dispatch('zoom-in') },
    { id: 'zoom-out', label: 'Zoom out', shortcut: formatShortcut('Mod+Minus', IS_MAC), onSelect: () => void dispatch('zoom-out') },
    { id: 'zoom-reset', label: '1 m = 100 px', shortcut: formatShortcut('Mod+0', IS_MAC), onSelect: () => void dispatch('zoom-reset') },
    { separator: true },
    { id: 'zoom-to-fit', label: 'Zoom to fit', shortcut: formatShortcut('Shift+1', IS_MAC), disabled: !hasElements, onSelect: () => void dispatch('zoom-to-fit') },
    { id: 'zoom-to-selection', label: 'Zoom to selection', shortcut: formatShortcut('Shift+2', IS_MAC), disabled: !hasSelection, onSelect: () => void dispatch('zoom-to-selection') },
  ];

  return (
    <div className={styles.status} role="group" data-ui-scale aria-label="View">
      <IconButton label={`Element graphics (${formatShortcut('Mod+Shift+E', IS_MAC)})`} onClick={() => void dispatch('open-graphics')} data-testid="open-graphics">
        <Palette size={16} />
      </IconButton>
      <IconButton label={`Grid (${formatShortcut('Mod+Quote', IS_MAC)})`} active={false} onClick={() => void dispatch('toggle-grid')} data-testid="toggle-grid">
        <Grid3x3 size={16} style={{ color: grid ? 'var(--accent)' : undefined }} />
      </IconButton>
      <IconButton label={`Snap to grid (${formatShortcut('Mod+Shift+Quote', IS_MAC)})`} onClick={() => void dispatch('toggle-snap')} data-testid="toggle-snap">
        <Magnet size={16} style={{ color: snap ? 'var(--accent)' : undefined }} />
      </IconButton>
      <button
        ref={snapRef}
        type="button"
        className={styles.statusButton}
        aria-haspopup="menu"
        aria-label="Object snaps"
        title="Object snaps, tracking and polar angles (F3 toggles)"
        onClick={() => {
          const rect = snapRef.current?.getBoundingClientRect();
          if (rect) setSnapMenu({ x: rect.right - 220, y: rect.top - 8 });
        }}
        data-testid="object-snaps"
      >
        <Crosshair size={15} style={{ color: osnap.objects ? 'var(--accent)' : undefined, verticalAlign: '-3px' }} />
      </button>
      {snapMenu && <Menu position={snapMenu} placement="above" entries={snapEntries} onClose={() => setSnapMenu(null)} ariaLabel="Object snaps" />}
      <span className={styles.boardLevel} data-raised={boardElevation !== 0 || undefined}>
        <IconButton label={`Board level down (${formatShortcut('Alt+PageDown', IS_MAC)})`} onClick={() => void dispatch('board-level-down')} data-testid="board-level-down">
          <ChevronDown size={14} />
        </IconButton>
        <button
          ref={levelRef}
          type="button"
          className={styles.statusButton}
          aria-haspopup="menu"
          aria-label="Board level"
          title="Board level: the elevation new elements start at in 3D"
          onClick={() => {
            const rect = levelRef.current?.getBoundingClientRect();
            if (rect) setLevelMenu({ x: rect.left - 60, y: rect.top - 8 });
          }}
          data-testid="board-level"
        >
          {signed(boardElevation)}
        </button>
        <IconButton label={`Board level up (${formatShortcut('Alt+PageUp', IS_MAC)})`} onClick={() => void dispatch('board-level-up')} data-testid="board-level-up">
          <ChevronUp size={14} />
        </IconButton>
      </span>
      {levelMenu && <Menu position={levelMenu} placement="above" entries={levelEntries} onClose={() => setLevelMenu(null)} ariaLabel="Board level" />}
      <button
        ref={zoomRef}
        type="button"
        className={styles.statusButton}
        aria-haspopup="menu"
        aria-label="Zoom"
        onClick={() => {
          const rect = zoomRef.current?.getBoundingClientRect();
          if (rect) setMenu({ x: rect.right - 200, y: rect.top - 8 });
        }}
        data-testid="zoom-level"
      >
        {formatZoom(zoom)}
      </button>
      {menu && <Menu position={menu} placement="above" entries={entries} onClose={() => setMenu(null)} ariaLabel="Zoom" />}
    </div>
  );
}

/** Shows the drawing scale: at zoom 0.1 one metre is 100 px, i.e. "1:10" on a 96 dpi screen. */
function formatZoom(zoom: number): string {
  const percent = zoom * 1000; // 1 m = 100 px is the "100 %" reference
  if (percent >= 10) return `${Math.round(percent)} %`;
  if (percent >= 0.1) return `${percent.toFixed(1)} %`;
  return `${percent.toFixed(2)} %`;
}

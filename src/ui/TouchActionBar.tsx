/**
 * Touch screens have no keyboard: this floating bar carries what keys do on a desktop. Drawing
 * actions (Done = Enter, Undo point = Backspace, Cancel = Esc) appear while drawing, selection
 * actions while something is selected, and the modifier toggles stand in for held keys (see
 * interaction/touchModifiers.ts). Shared by the board and the modeling workspace.
 */
import { BoxSelect, Check, Copy, Lock, Magnet, Repeat2, Ruler, SquarePlus, Trash2, Undo2, X, type LucideIcon } from 'lucide-react';
import { useRef } from 'react';
import { touchModifiers, useTouchModifiers, type ModifierName } from '@/interaction/touchModifiers';
import { useI18n } from './i18n';
import styles from './TouchActionBar.module.css';

const MODIFIERS: Record<ModifierName, { label: string; icon: LucideIcon; title: string }> = {
  straight: { label: 'Straight', icon: Ruler, title: 'Straight lines and 15° steps (Shift)' },
  snapOff: { label: 'Snap off', icon: Magnet, title: 'Place freely, ignoring grid and snaps (Alt)' },
  additive: { label: 'Add', icon: SquarePlus, title: 'Taps add to the selection (Shift/Ctrl)' },
  selectArea: { label: 'Select area', icon: BoxSelect, title: 'Drag on empty space to select an area' },
};

const LONG_PRESS_MS = 450;

/** The bar floats over the board/viewport: its touches must not reach their gesture handlers. */
const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

export interface TouchActionBarProps {
  /** A multi-step drawing is in progress: show Done / Undo point / Cancel. */
  drawing: boolean;
  onDone?: () => void;
  onUndoPoint?: () => void;
  onCancel: () => void;
  /** Something is selected: show Duplicate / Delete. */
  hasSelection: boolean;
  onDuplicate?: () => void;
  onDelete?: () => void;
  /** Repeats the last tool or action (a double right-click with a mouse). */
  onRepeat?: () => void;
  /** Which modifier toggles this workspace uses. */
  modifiers: ModifierName[];
  /** Where it floats over its container (default top centre). */
  placement?: 'top' | 'bottom';
}

export function TouchActionBar({ drawing, onDone, onUndoPoint, onCancel, hasSelection, onDuplicate, onDelete, onRepeat, modifiers, placement = 'top' }: TouchActionBarProps) {
  const { t } = useI18n();
  return (
    <div className={styles.bar} role="toolbar" aria-label={t('Touch actions')} data-testid="touch-action-bar" data-placement={placement} onPointerDown={stop} onPointerMove={stop} onPointerUp={stop} onDoubleClick={stop}>
      {drawing && (
        <>
          {onDone && <Action icon={Check} label={t('Done')} primary onClick={onDone} testId="touch-done" />}
          {onUndoPoint && <Action icon={Undo2} label={t('Undo point')} onClick={onUndoPoint} testId="touch-undo-point" />}
          <Action icon={X} label={t('Cancel')} onClick={onCancel} testId="touch-cancel" />
          <span className={styles.divider} />
        </>
      )}
      {!drawing && hasSelection && (
        <>
          {onDuplicate && <Action icon={Copy} label={t('Duplicate')} onClick={onDuplicate} testId="touch-duplicate" />}
          {onDelete && <Action icon={Trash2} label={t('Delete')} danger onClick={onDelete} testId="touch-delete" />}
          <span className={styles.divider} />
        </>
      )}
      {!drawing && onRepeat && (
        <>
          <Action icon={Repeat2} label={t('Repeat')} onClick={onRepeat} testId="touch-repeat" />
          <span className={styles.divider} />
        </>
      )}
      {modifiers.map((name) => (
        <ModifierToggle key={name} name={name} />
      ))}
    </div>
  );
}

function Action({ icon: Icon, label, onClick, primary, danger, testId }: { icon: LucideIcon; label: string; onClick: () => void; primary?: boolean; danger?: boolean; testId: string }) {
  return (
    <button type="button" className={styles.action} data-primary={primary || undefined} data-danger={danger || undefined} onClick={onClick} data-testid={testId}>
      <Icon size={18} />
      <span>{label}</span>
    </button>
  );
}

/** Tap: on for the next action. Long-press: stays on (lock). Tap again: off. */
function ModifierToggle({ name }: { name: ModifierName }) {
  const { t } = useI18n();
  const state = useTouchModifiers()[name];
  const { label, icon: Icon, title } = MODIFIERS[name];
  const timer = useRef<number | null>(null);
  const locked = useRef(false);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  return (
    <button
      type="button"
      className={styles.toggle}
      data-state={state}
      aria-pressed={state !== 'off'}
      title={t(title)}
      data-testid={`touch-mod-${name}`}
      onPointerDown={() => {
        locked.current = false;
        clear();
        timer.current = window.setTimeout(() => {
          timer.current = null;
          locked.current = true;
          touchModifiers.lock(name);
          if (navigator.vibrate) navigator.vibrate(30);
        }, LONG_PRESS_MS);
      }}
      onPointerUp={clear}
      onPointerLeave={clear}
      onClick={() => {
        // The long-press already locked it; the click that ends that press must not undo it.
        if (locked.current) {
          locked.current = false;
          return;
        }
        touchModifiers.toggle(name);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Icon size={16} />
      <span>{t(label)}</span>
      {state === 'locked' && <Lock size={11} className={styles.lock} aria-label={t('Locked on')} />}
    </button>
  );
}

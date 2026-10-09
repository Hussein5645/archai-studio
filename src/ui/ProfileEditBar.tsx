/**
 * The profile (boundary) drawing mode's bar at the bottom of the board: what is being drawn, the
 * tools to draw it with (the board's own line tools, plus picking walls or dragging a rectangle),
 * whether the loop is closed yet, and Finish / Cancel (Revit's sketch mode ribbon, condensed).
 */
import { Check, Circle, Hexagon, MousePointer2, PenLine, PenTool, RectangleHorizontal, Scissors, Spline, SquareDashedMousePointer, X } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useApp, useAppState, useDispatch } from '@/app/context';
import { profileLoops, profileShape } from '@/drafting/profile';
import type { ElementTable } from '@/document';
import type { ToolId } from '@/store';
import { useI18n } from './i18n';
import styles from './ProfileEditBar.module.css';

const TITLES = { floor: 'Floor boundary', ceiling: 'Ceiling boundary', level: 'Level boundary' } as const;

export function ProfileEditBar() {
  const { t } = useI18n();
  const { toasts } = useApp();
  const dispatch = useDispatch();
  const edit = useAppState((s) => s.ui.profileEdit);
  const elements = useAppState((s) => s.doc.elements);
  const tool = useAppState((s) => s.ui.tool);
  const loops = useMemo(() => (edit ? profileLoops(elements as ElementTable, edit) : null), [edit, elements]);
  if (!edit || !loops) return null;
  const shape = profileShape(loops, edit.kind);
  const problem = typeof shape === 'string' ? shape : null;
  const area = typeof shape === 'string' ? 0 : shape.area / 1e6;
  const openings = typeof shape === 'string' ? 0 : shape.openings.length;
  const pick: { tool: ToolId; label: string; icon: ReactNode } = edit.kind === 'level'
    ? { tool: 'arch:level', label: 'Rectangle extent', icon: <SquareDashedMousePointer size={15} /> }
    : { tool: `arch:${edit.kind}` as ToolId, label: 'Pick walls (click inside a closed boundary)', icon: <SquareDashedMousePointer size={15} /> };
  const tools: { tool: ToolId; label: string; icon: ReactNode }[] = [
    { tool: 'select', label: 'Select and edit curves (grips)', icon: <MousePointer2 size={15} /> },
    pick,
    { tool: 'line', label: 'Line', icon: <PenLine size={15} /> },
    { tool: 'rect', label: 'Rectangle', icon: <RectangleHorizontal size={15} /> },
    { tool: 'draw:arc', label: 'Arc', icon: <Spline size={15} /> },
    { tool: 'draw:circle', label: 'Circle', icon: <Circle size={15} /> },
    { tool: 'draw:polygon', label: 'Polygon', icon: <Hexagon size={15} /> },
    { tool: 'draw:pen', label: 'Pen curve', icon: <PenTool size={15} /> },
    { tool: 'modify:trim', label: 'Trim / extend to corner', icon: <Scissors size={15} /> },
  ];
  const finish = async () => {
    const result = await dispatch('finish-profile-edit');
    if (!result.ok) toasts.push({ kind: 'error', message: result.error.message });
  };
  return (
    <div className={styles.bar} role="toolbar" aria-label={t(TITLES[edit.kind])} data-testid="profile-edit-bar" onPointerDown={(event) => event.stopPropagation()}>
      <span className={styles.mode}>{t(edit.targetId ? `Edit ${TITLES[edit.kind].toLowerCase()}` : TITLES[edit.kind])}</span>
      <span className={styles.tools}>
        {tools.map((item) => (
          <button key={item.tool} type="button" className={styles.tool} data-active={tool === item.tool || undefined} title={t(item.label)} aria-label={t(item.label)} onClick={() => void dispatch('set-tool', { tool: item.tool })}>
            {item.icon}
          </button>
        ))}
      </span>
      <span className={styles.status} data-ok={!problem || undefined} data-testid="profile-status">
        {problem ? t(problem) : `${t('Closed loop')}${openings ? ` + ${openings} ${t(openings === 1 ? 'opening' : 'openings')}` : ''} · ${area.toLocaleString(undefined, { maximumFractionDigits: 2 })} m²`}
      </span>
      <button type="button" className={styles.finish} disabled={Boolean(problem)} onClick={() => void finish()} data-testid="profile-finish" title={t('Finish: apply the boundary')}>
        <Check size={14} /> {t('Finish')}
      </button>
      <button type="button" className={styles.cancel} onClick={() => void dispatch('cancel-profile-edit')} data-testid="profile-cancel" title={t('Cancel: discard what was drawn')}>
        <X size={14} />
      </button>
    </div>
  );
}

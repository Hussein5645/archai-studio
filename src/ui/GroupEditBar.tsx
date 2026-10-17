import { ChevronRight, FolderOpen, LogOut } from 'lucide-react';
import { useAppState, useDispatch } from '@/app/context';
import { activeGroup, groupPath } from '@/selection/groupScope';
import styles from './GroupEditBar.module.css';

/** Persistent navigation through nested groups; no document changes are made by navigation. */
export function GroupEditBar() {
  const dispatch = useDispatch();
  const elements = useAppState((s) => s.doc.elements);
  const groupId = useAppState((s) => activeGroup(s.doc.elements, s.ui));
  const sheet = useAppState((s) => Boolean(s.ui.sheet));
  const view3d = useAppState((s) => s.ui.view3d.open);
  if (!groupId) return null;
  const path = groupPath(elements, groupId);
  return <nav className={styles.bar} aria-label="Group editing" data-testid="group-edit-bar" data-in-3d={view3d || undefined} onPointerDown={(e) => e.stopPropagation()}>
    <FolderOpen size={16} aria-hidden="true" /><strong>Editing group</strong>
    <div className={styles.path}>
      <button type="button" onClick={() => void dispatch('exit-group', { all: true })}>{sheet ? 'Sheet' : 'Board'}</button>
      {path.map((group) => <span className={styles.crumb} key={group.id}>
        <ChevronRight size={12} aria-hidden="true" />
        <button type="button" aria-current={group.id === groupId ? 'location' : undefined} onClick={() => void dispatch('enter-group', { id: group.id })}>{group.name || 'Group'}</button>
      </span>)}
    </div>
    <button type="button" className={styles.exit} onClick={() => void dispatch('exit-group')} title="Exit one group level (Esc)" data-testid="exit-group"><LogOut size={14} />Exit group <kbd>Esc</kbd></button>
  </nav>;
}

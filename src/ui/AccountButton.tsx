/**
 * Top bar / Home: "Sign in" when signed out, the account menu when signed in. In a project the
 * menu also puts a local project online or saves a copy of an online one on this device, and
 * `CloudSyncState` shows whether the open online project is uploaded.
 */
import { Cloud, CloudOff, KeyRound, CloudUpload, Download, LogIn, LogOut, RefreshCw, TriangleAlert, Eye } from 'lucide-react';
import { useRef, useState } from 'react';
import { useAccount, useApp, useAppState, useCloudSync } from '@/app/context';
import { openAccountDialog } from './account-dialog';
import { useI18n } from './i18n';
import { Menu, type MenuContent } from './primitives';
import styles from './AccountDialog.module.css';

export function AccountButton({ inProject = false }: { inProject?: boolean }) {
  const { t } = useI18n();
  const { account, cloud, persistence, toasts, store } = useApp();
  const state = useAccount();
  const docId = useAppState((s) => s.doc.id);
  const ref = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  if (state.status === 'signed-out') {
    return (
      <div className={styles.account}>
        <button type="button" className={styles.signIn} onClick={() => openAccountDialog()} data-testid="account-sign-in">
          <LogIn size={14} aria-hidden="true" />
          {t('Sign in')}
        </button>
      </div>
    );
  }

  const isOnline = Boolean(persistence.entry(docId)?.cloud);
  const run = async (task: () => Promise<unknown>, done?: string) => {
    try {
      await task();
      if (done) toasts.push({ kind: 'success', message: t(done) });
    } catch (error) {
      toasts.push({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const entries: MenuContent = [{ title: `${state.user.name} · ${state.user.email}` }];
  if (inProject && !isOnline) {
    entries.push({
      id: 'put-online',
      label: t('Put this project online'),
      icon: <CloudUpload size={14} />,
      onSelect: () => void run(() => cloud.putOnline(store.getState().doc.id), 'The project is now online, with its links and data'),
    });
  }
  if (inProject && isOnline) {
    entries.push({
      id: 'save-copy',
      label: t('Save a copy on this device'),
      icon: <Download size={14} />,
      onSelect: () => void run(() => cloud.saveCopyOnDevice(store.getState().doc.id), 'A copy was saved on this device (see Home)'),
    });
  }
  entries.push({ separator: true }, { id: 'change-password', label: t('Change password'), icon: <KeyRound size={14} />, onSelect: () => openAccountDialog('password') });
  entries.push({ id: 'sign-out', label: t('Sign out'), icon: <LogOut size={14} />, onSelect: () => void run(() => account.signOut(), 'Signed out: your projects on this device are still here') });

  return (
    <div className={styles.account}>
      <button
        ref={ref}
        type="button"
        className={styles.avatar}
        aria-haspopup="menu"
        onClick={() => {
          const rect = ref.current?.getBoundingClientRect();
          if (rect) setMenu({ x: rect.right - 240, y: rect.bottom + 4 });
        }}
        data-testid="account-menu"
      >
        <span className={styles.initial}>{(state.user.name || state.user.email).slice(0, 1)}</span>
        {state.user.name}
      </button>
      {menu && <Menu position={menu} entries={entries} onClose={() => setMenu(null)} ariaLabel={t('Account')} />}
    </div>
  );
}

/** "Online · saved" and friends, next to the document name; nothing for local projects. */
export function CloudSyncState() {
  const { t } = useI18n();
  const status = useCloudSync();
  if (!status) return null;
  const view = {
    saved: { icon: <Cloud size={13} />, text: 'Online · saved', warn: false },
    saving: { icon: <RefreshCw size={13} />, text: 'Saving online...', warn: false },
    offline: { icon: <CloudOff size={13} />, text: 'Offline · edits kept on this device', warn: true },
    connecting: { icon: <RefreshCw size={13} />, text: 'Connecting...', warn: false },
    error: { icon: <TriangleAlert size={13} />, text: 'Not saved online', warn: true },
    'read-only': { icon: <Eye size={13} />, text: 'View only', warn: false },
  }[status];
  return (
    <span className={`${styles.sync} ${view.warn ? styles.syncWarn : ''}`} data-testid="cloud-sync" data-status={status}>
      {view.icon}
      {t(view.text)}
    </span>
  );
}

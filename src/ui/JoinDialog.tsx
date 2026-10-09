/**
 * Join an online project from an invite link: pasted on Home, or opened as archai://invite/<token>
 * (desktop) or ?invite=<token> (web). Shows what the link is for, then joins and opens it.
 */
import { LogIn, Link2, X } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useAccount, useApp } from '@/app/context';
import { inviteToken } from '@/cloud/projects';
import { openAccountDialog } from './account-dialog';
import { useI18n } from './i18n';
import styles from './AccountDialog.module.css';

let open: { text: string } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** Opens the dialog, filled with a link or token when one is given. */
export function openJoinDialog(text = ''): void {
  open = { text };
  emit();
}

function closeJoinDialog(): void {
  open = null;
  emit();
}

export function JoinDialog() {
  const state = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
  );
  return state ? <Join key={state.text} initial={state.text} /> : null;
}

function Join({ initial }: { initial: string }) {
  const { t } = useI18n();
  const { cloud } = useApp();
  const account = useAccount();
  const [text, setText] = useState(initial);
  const [lookup, setLookup] = useState<{ token: string; info?: { project: string; owner: string; role: string; expired: boolean }; error?: string } | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const token = inviteToken(text);
  // What the link is for, once looked up (only for the link now in the field).
  const info = lookup && lookup.token === token ? (lookup.info ?? null) : null;
  const error = joinError ?? (lookup && lookup.token === token ? (lookup.error ?? null) : null);
  const setError = setJoinError;

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    cloud.inviteInfo(token).then(
      (next) => !cancelled && setLookup({ token, info: next }),
      (caught: unknown) => !cancelled && setLookup({ token, error: caught instanceof Error ? caught.message : String(caught) }),
    );
    return () => {
      cancelled = true;
    };
  }, [cloud, token]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeJoinDialog();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const join = async () => {
    if (!token) return;
    if (account.status !== 'signed-in') {
      openAccountDialog('sign-in', 'Sign in to join this project.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await cloud.acceptInvite(token);
      closeJoinDialog();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className={styles.backdrop} data-ui-scale onPointerDown={(event) => event.target === event.currentTarget && closeJoinDialog()}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-label={t('Join a project')} data-testid="join-dialog">
        <header className={styles.header}>
          <h2 className={styles.title}>
            <Link2 size={16} aria-hidden="true" />
            {t('Join a project')}
          </h2>
          <button type="button" className={styles.close} aria-label={t('Close')} onClick={closeJoinDialog}>
            <X size={16} />
          </button>
        </header>
        <form
          className={styles.body}
          onSubmit={(event) => {
            event.preventDefault();
            void join();
          }}
        >
          <label className={styles.field}>
            <span>{t('Invite link')}</span>
            <input type="text" value={text} onChange={(e) => { setText(e.target.value); setJoinError(null); }} placeholder="https://…/invite/…" autoFocus data-testid="join-link" />
          </label>
          {info && (
            <p className={styles.lead} data-testid="join-info">
              {info.expired ? t('This invite link has expired: ask for a new one.') : `${info.owner} ${t('invited you to')} “${info.project}” ${info.role === 'viewer' ? t('to view it') : t('to edit it with them')}.`}
            </p>
          )}
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <button type="submit" className={styles.submit} disabled={!token || busy || Boolean(info?.expired)} data-testid="join-submit">
            {account.status !== 'signed-in' ? (
              <>
                <LogIn size={14} /> {t('Sign in to join')}
              </>
            ) : busy ? (
              t('Joining...')
            ) : (
              t('Join and open')
            )}
          </button>
        </form>
      </section>
    </div>,
    document.body,
  );
}

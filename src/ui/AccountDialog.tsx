/**
 * Sign in to ArchAI, or change your password (docs/accounts-and-cloud.md). An account is optional:
 * it adds online projects, editing together, the libraries and VR links; everything local works
 * without one. Accounts are by invitation for now: people email ACCOUNT_CONTACT and the owner
 * creates the account (workers/archai-cloud/admin.mjs). Development builds can still create
 * accounts on a local worker.
 */
import { CloudCog, Mail, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '@/app/context';
import { ACCOUNT_CONTACT, OPEN_SIGNUP } from '@/cloud/account';
import { closeAccountDialog, useAccountDialog, type AccountDialogMode } from './account-dialog';
import { useI18n } from './i18n';
import styles from './AccountDialog.module.css';

const REQUEST_LINK = `mailto:${ACCOUNT_CONTACT}?subject=${encodeURIComponent('ArchAI account request')}&body=${encodeURIComponent('Hello,\n\nI would like an ArchAI account.\n\nName:\nEmail for the account:\nWhat I will use ArchAI for:\n')}`;

export function AccountDialog() {
  const open = useAccountDialog();
  return open ? <AccountForm key={open.mode} initialMode={open.mode} reason={open.reason} /> : null;
}

function AccountForm({ initialMode, reason }: { initialMode: AccountDialogMode; reason: string | null }) {
  const { t } = useI18n();
  const { account, toasts } = useApp();
  const [mode, setMode] = useState<AccountDialogMode>(initialMode === 'sign-up' && !OPEN_SIGNUP ? 'sign-in' : initialMode);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [current, setCurrent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeAccountDialog();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'password') {
        await account.changePassword(current, password);
        closeAccountDialog();
        toasts.push({ kind: 'success', message: t('Your password was changed') });
        return;
      }
      const user = mode === 'sign-up' ? await account.signUp(email, name, password) : await account.signIn(email, password);
      closeAccountDialog();
      toasts.push({ kind: 'success', message: `${t('Signed in as')} ${user.name}` });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const signUp = mode === 'sign-up';
  const changing = mode === 'password';
  const title = changing ? t('Change your password') : signUp ? t('Create your ArchAI account') : t('Sign in to ArchAI');
  return createPortal(
    <div className={styles.backdrop} data-ui-scale onPointerDown={(event) => event.target === event.currentTarget && closeAccountDialog()}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-label={title} data-testid="account-dialog">
        <header className={styles.header}>
          <h2 className={styles.title}>
            <CloudCog size={16} aria-hidden="true" />
            {title}
          </h2>
          <button type="button" className={styles.close} aria-label={t('Close')} onClick={closeAccountDialog}>
            <X size={16} />
          </button>
        </header>
        <form className={styles.body} onSubmit={(event) => void submit(event)}>
          {!changing && (
            <p className={styles.lead}>
              {reason ? t(reason) : t('An account puts your projects online to edit them together, opens the asset and material libraries, and publishes VR links. ArchAI works on this device without one.')}
            </p>
          )}
          {changing ? (
            <label className={styles.field}>
              <span>{t('Current password')}</span>
              <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus data-testid="account-current" />
            </label>
          ) : (
            <label className={styles.field}>
              <span>{t('Email')}</span>
              <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus data-testid="account-email" />
            </label>
          )}
          {signUp && (
            <label className={styles.field}>
              <span>{t('Name')}</span>
              <input type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Shown to people you share projects with')} data-testid="account-name" />
            </label>
          )}
          <label className={styles.field}>
            <span>{changing ? t('New password') : t('Password')}</span>
            <input
              type="password"
              autoComplete={signUp || changing ? 'new-password' : 'current-password'}
              required
              minLength={signUp || changing ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="account-password"
            />
            {(signUp || changing) && <small>{t('At least 8 characters.')}</small>}
          </label>
          {error && (
            <p className={styles.error} role="alert" data-testid="account-error">
              {error}
            </p>
          )}
          <button type="submit" className={styles.submit} disabled={busy} data-testid="account-submit">
            {busy ? t('Please wait...') : changing ? t('Change password') : signUp ? t('Create account') : t('Sign in')}
          </button>
          {!changing && !OPEN_SIGNUP && (
            <p className={styles.switch} data-testid="account-request">
              {t('No account yet? Accounts are by invitation for now.')}{' '}
              <a href={REQUEST_LINK} target="_blank" rel="noopener noreferrer">
                <Mail size={12} aria-hidden="true" /> {t('Ask for one')}: {ACCOUNT_CONTACT}
              </a>
            </p>
          )}
          {!changing && OPEN_SIGNUP && (
            <p className={styles.switch}>
              {signUp ? t('Already have an account?') : t('Development build: accounts can be created on a local worker.')}{' '}
              <button type="button" onClick={() => { setMode(signUp ? 'sign-in' : 'sign-up'); setError(null); }} data-testid="account-switch">
                {signUp ? t('Sign in') : t('Create an account')}
              </button>
            </p>
          )}
        </form>
      </section>
    </div>,
    document.body,
  );
}

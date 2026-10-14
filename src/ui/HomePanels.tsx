/**
 * Home screen tabs beyond projects:
 * - VR Links: the signed-in account's published VR tours (open, copy the link, delete).
 * - Settings: about this copy of ArchAI (version, platform, account, links) and the app settings
 *   (the same ones as the Settings dialog).
 */
import { BookOpen, Bug, Check, Copy, ExternalLink, FileCode2, Glasses, Globe, Info, KeyRound, LogIn, LogOut, Mail, RefreshCw, RotateCcw, Scale, Settings, Trash2, UserRound } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useAccount, useApp } from '@/app/context';
import { ACCOUNT_CONTACT, CLOUD_URL } from '@/cloud/account';
import { deleteVrTour, listVrTours, type VrTour } from '@/cloud/vrTours';
import { openAccountDialog } from './account-dialog';
import { useI18n } from './i18n';
import { preferences } from './preferences';
import { IconButton, TextButton } from './primitives';
import { SettingsSections } from './SettingsDialog';
import styles from './HomePanels.module.css';

const REPO_URL = 'https://github.com/Hussein5645/archai-studio';
const WEB_URL = 'https://archai-studio-six.vercel.app';

const sizeText = (bytes: number | null) => (bytes === null ? '' : bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

// ---- VR Links ----

export function VrLinksPanel() {
  const { t } = useI18n();
  const { platform, toasts } = useApp();
  const account = useAccount();
  const signedIn = account.status === 'signed-in';
  const [tours, setTours] = useState<VrTour[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const userId = signedIn ? account.user.id : null;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    listVrTours().then(
      (next) => {
        if (cancelled) return;
        setTours(next);
        setError(null);
      },
      (caught: unknown) => !cancelled && setError(caught instanceof Error ? caught.message : String(caught)),
    );
    return () => {
      cancelled = true;
    };
  }, [userId, reload]);

  const copy = useCallback(
    async (tour: VrTour) => {
      try {
        await platform.clipboard.writeText(tour.link);
        setCopied(tour.id);
        setTimeout(() => setCopied((id) => (id === tour.id ? null : id)), 1500);
      } catch {
        toasts.push({ kind: 'error', message: t('Could not copy the link') });
      }
    },
    [platform, toasts, t],
  );

  const remove = async (tour: VrTour) => {
    if (!window.confirm(t(`Delete the VR tour "${tour.name}"? Its link stops working for everyone who has it.`))) return;
    setBusy(tour.id);
    try {
      await deleteVrTour(tour.id);
      setTours((list) => list?.filter((item) => item.id !== tour.id) ?? null);
      toasts.push({ kind: 'info', message: t('VR tour deleted') });
    } catch (caught) {
      toasts.push({ kind: 'error', message: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setBusy(null);
    }
  };

  if (!signedIn) {
    return (
      <div className={styles.empty} data-testid="vr-links-signed-out">
        <Glasses size={24} aria-hidden="true" />
        <p>{t('Sign in to see and manage the VR links you published.')}</p>
        <TextButton primary type="button" onClick={() => openAccountDialog('sign-in', 'Sign in to see and manage your VR links.')}>
          <LogIn size={15} /> {t('Sign in')}
        </TextButton>
      </div>
    );
  }

  return (
    <div className={styles.panel} data-testid="vr-links">
      <div className={styles.toolbar}>
        <p className={styles.hint}>
          {t('Raw VR, baked VR and 360 links published from the VR menu or a plugin. Open a link in the Meta Quest Browser and press Enter VR.')}
        </p>
        <IconButton label={t('Refresh')} onClick={() => setReload((n) => n + 1)}>
          <RefreshCw size={14} />
        </IconButton>
      </div>
      {error && <p className={styles.error}>{error}</p>}
      {!tours && !error && <p className={styles.hint}>{t('Loading your VR links...')}</p>}
      {tours && tours.length === 0 && (
        <div className={styles.empty}>
          <Glasses size={24} aria-hidden="true" />
          <p>{t('No VR links yet. Open the VR menu in a 3D view to export a raw link or prepare a rendered link.')}</p>
        </div>
      )}
      {tours && tours.length > 0 && (
        <ul className={styles.list}>
          {tours.map((tour) => (
            <li key={tour.id} className={styles.row} data-testid={`vr-tour-${tour.id}`}>
              <span className={styles.icon}>
                <Glasses size={18} aria-hidden="true" />
              </span>
              <span className={styles.main}>
                <strong>{tour.name}</strong>
                <small>
                  {t('Updated')} {new Date(tour.updatedAt).toLocaleDateString()}
                  {` · ${t(tour.mode === 'panorama' ? '360 image' : tour.mode === 'baked' ? 'Baked VR' : 'Raw VR')}`}
                  {tour.stops !== null ? ` · ${tour.stops} ${tour.stops === 1 ? t('stop') : t('stops')}` : ''}
                  {tour.modelBytes ? ` · ${sizeText(tour.modelBytes)}` : ''}
                  {!tour.available ? ` · ${t('upload not finished')}` : ''}
                </small>
                <a className={styles.link} href={tour.link} target="_blank" rel="noopener noreferrer">
                  {tour.link.replace(/^https?:\/\//, '')}
                </a>
              </span>
              <span className={styles.actions}>
                <IconButton label={copied === tour.id ? t('Copied') : t('Copy link')} onClick={() => void copy(tour)}>
                  {copied === tour.id ? <Check size={14} /> : <Copy size={14} />}
                </IconButton>
                <a className={styles.iconLink} href={tour.link} target="_blank" rel="noopener noreferrer" aria-label={t('Open the tour')} title={t('Open the tour')}>
                  <ExternalLink size={14} />
                </a>
                <IconButton label={t('Delete tour')} disabled={busy === tour.id} onClick={() => void remove(tour)}>
                  <Trash2 size={14} />
                </IconButton>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Settings ----

const PLATFORM_NAMES = { web: 'Web browser', electron: 'Windows desktop app', native: 'Android / Meta Quest app' } as const;

export function SettingsPanel() {
  const { t } = useI18n();
  const { platform, account, toasts } = useApp();
  const state = useAccount();
  const [cloud, setCloud] = useState<'checking' | 'online' | 'offline'>('checking');

  useEffect(() => {
    let cancelled = false;
    fetch(`${CLOUD_URL}/`, { cache: 'no-store' }).then(
      (response) => !cancelled && setCloud(response.ok ? 'online' : 'offline'),
      () => !cancelled && setCloud('offline'),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const link = (href: string, icon: React.ReactNode, label: string) => (
    <a className={styles.linkRow} href={href} target="_blank" rel="noopener noreferrer">
      {icon}
      <span>{t(label)}</span>
      <ExternalLink size={12} aria-hidden="true" />
    </a>
  );

  return (
    <div className={styles.settings} data-testid="home-settings">
      <section className={styles.card}>
        <h2>
          <Info size={15} aria-hidden="true" /> {t('About')}
        </h2>
        <dl className={styles.facts}>
          <dt>{t('Version')}</dt>
          <dd data-testid="app-version">ArchAI {__APP_VERSION__}</dd>
          <dt>{t('Running as')}</dt>
          <dd>{t(PLATFORM_NAMES[platform.kind])}</dd>
          <dt>{t('ArchAI cloud')}</dt>
          <dd>
            <span className={`${styles.dot} ${cloud === 'online' ? styles.dotOn : cloud === 'offline' ? styles.dotOff : ''}`} />
            {cloud === 'online' ? t('Reachable') : cloud === 'offline' ? t('Not reachable (offline?)') : t('Checking...')}
          </dd>
          <dt>{t('License')}</dt>
          <dd>{t('Source-available (PolyForm Strict 1.0.0): free for non-commercial use')}</dd>
        </dl>
        <div className={styles.links}>
          {platform.kind !== 'web' && link(WEB_URL, <Globe size={14} />, 'ArchAI in the browser')}
          {link(`${WEB_URL}/download.html`, <BookOpen size={14} />, 'Downloads and plugins')}
          {link(REPO_URL, <FileCode2 size={14} />, 'Source code on GitHub')}
          {link(`${REPO_URL}/issues/new/choose`, <Bug size={14} />, 'Report a problem or suggest a feature')}
          {link(`${REPO_URL}/blob/main/LICENSE`, <Scale size={14} />, 'License')}
          {link(`mailto:${ACCOUNT_CONTACT}`, <Mail size={14} />, `Contact: ${ACCOUNT_CONTACT}`)}
        </div>
      </section>

      <section className={styles.card}>
        <h2>
          <UserRound size={15} aria-hidden="true" /> {t('Account')}
        </h2>
        {state.status === 'signed-in' ? (
          <>
            <dl className={styles.facts}>
              <dt>{t('Name')}</dt>
              <dd>{state.user.name}</dd>
              <dt>{t('Email')}</dt>
              <dd>{state.user.email}</dd>
            </dl>
            <div className={styles.buttons}>
              <TextButton type="button" onClick={() => openAccountDialog('password')}>
                <KeyRound size={14} /> {t('Change password')}
              </TextButton>
              <TextButton
                type="button"
                onClick={() =>
                  void account.signOut().then(() => toasts.push({ kind: 'info', message: t('Signed out: your projects on this device are still here') }))
                }
              >
                <LogOut size={14} /> {t('Sign out')}
              </TextButton>
            </div>
          </>
        ) : (
          <>
            <p className={styles.hint}>
              {t('ArchAI works on this device without an account. An account adds online projects you edit together, the libraries and VR links. Accounts are by invitation for now:')}{' '}
              <a href={`mailto:${ACCOUNT_CONTACT}?subject=${encodeURIComponent('ArchAI account request')}`} target="_blank" rel="noopener noreferrer">
                {ACCOUNT_CONTACT}
              </a>
            </p>
            <div className={styles.buttons}>
              <TextButton primary type="button" onClick={() => openAccountDialog()}>
                <LogIn size={14} /> {t('Sign in')}
              </TextButton>
            </div>
          </>
        )}
      </section>

      <section className={`${styles.card} ${styles.wide}`}>
        <h2>
          <Settings size={15} aria-hidden="true" /> {t('Settings')}
        </h2>
        <p className={styles.hint}>{t('Settings of this device. They apply at once; inside a project they are also under the menu (Ctrl + ,).')}</p>
        <SettingsSections />
        <div className={styles.buttons}>
          <TextButton type="button" onClick={() => preferences.reset()}>
            <RotateCcw size={14} /> {t('Reset to defaults')}
          </TextButton>
        </div>
      </section>
    </div>
  );
}

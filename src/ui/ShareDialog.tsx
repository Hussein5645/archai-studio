/**
 * Share an online project (docs/accounts-and-cloud.md, "Invites and roles"): the people with
 * access and their roles, adding someone who has an account, and invite links. Owners manage;
 * everyone else sees who is on the project and can leave it.
 */
import { Check, Copy, Link2, LogOut, Trash2, UserPlus, Users, X } from 'lucide-react';
import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useAccount, useApp } from '@/app/context';
import type { MemberList } from '@/cloud/projects';
import { useI18n } from './i18n';
import styles from './ShareDialog.module.css';

// ---- opening it from anywhere ----

let openId: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function openShareDialog(projectId: string): void {
  openId = projectId;
  emit();
}

function closeShareDialog(): void {
  openId = null;
  emit();
}

export function ShareDialog() {
  const id = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => openId,
  );
  return id ? <Share key={id} projectId={id} /> : null;
}

const DAYS: { label: string; days: number | null }[] = [
  { label: 'Never expires', days: null },
  { label: 'Expires in 7 days', days: 7 },
  { label: 'Expires in 30 days', days: 30 },
];

function Share({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const { cloud, platform, toasts, persistence } = useApp();
  const me = useAccount();
  const [list, setList] = useState<MemberList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [linkRole, setLinkRole] = useState<'editor' | 'viewer'>('editor');
  const [linkDays, setLinkDays] = useState<number | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = persistence.entry(projectId)?.name ?? cloud.list().projects.find((p) => p.id === projectId)?.name ?? '';

  const run = useCallback(async (task: () => Promise<MemberList | void>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await task();
      if (next) setList(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    cloud.members(projectId).then(
      (next) => !cancelled && setList(next),
      (caught: unknown) => !cancelled && setError(caught instanceof Error ? caught.message : String(caught)),
    );
    return () => {
      cancelled = true;
    };
  }, [cloud, projectId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeShareDialog();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const owner = list?.role === 'owner';
  const myId = me.status === 'signed-in' ? me.user.id : null;

  const add = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const next = await cloud.addMember(projectId, email, role);
      setEmail('');
      return next;
    });
  };

  const makeLink = () =>
    void run(async () => {
      const invite = await cloud.createInvite(projectId, linkRole, linkDays);
      setLink(invite.link);
      setCopied(false);
      return cloud.members(projectId);
    });

  const copy = async (text: string) => {
    try {
      await platform.clipboard.writeText(text);
      setCopied(true);
    } catch {
      toasts.push({ kind: 'error', message: t('Could not copy the link') });
    }
  };

  const leave = () => {
    if (!window.confirm(t(`Leave “${name}”? You lose access until someone invites you again.`))) return;
    void run(async () => {
      await cloud.leave(projectId);
      closeShareDialog();
      toasts.push({ kind: 'info', message: t('You left the project') });
    });
  };

  return createPortal(
    <div className={styles.backdrop} data-ui-scale onPointerDown={(event) => event.target === event.currentTarget && closeShareDialog()}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-label={t('Share')} data-testid="share-dialog">
        <header className={styles.header}>
          <h2 className={styles.title}>
            <Users size={16} aria-hidden="true" />
            {t('Share')} “{name || t('Untitled Project')}”
          </h2>
          <button type="button" className={styles.close} aria-label={t('Close')} onClick={closeShareDialog}>
            <X size={16} />
          </button>
        </header>
        <div className={styles.body}>
          {error && (
            <p className={styles.error} role="alert" data-testid="share-error">
              {error}
            </p>
          )}

          {owner && (
            <form className={styles.section} onSubmit={add}>
              <h3>{t('Add people')}</h3>
              <p className={styles.hint}>{t('Someone with an ArchAI account gets the project in their Online Projects right away.')}</p>
              <div className={styles.row}>
                <input type="email" required placeholder={t('Email address')} value={email} onChange={(e) => setEmail(e.target.value)} aria-label={t('Email address')} data-testid="share-email" />
                <select value={role} onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')} aria-label={t('Role')} data-testid="share-role">
                  <option value="editor">{t('Can edit')}</option>
                  <option value="viewer">{t('Can view')}</option>
                </select>
                <button type="submit" className={styles.primary} disabled={busy} data-testid="share-add">
                  <UserPlus size={14} /> {t('Add')}
                </button>
              </div>
            </form>
          )}

          {owner && (
            <section className={styles.section}>
              <h3>{t('Invite link')}</h3>
              <p className={styles.hint}>{t('Anyone who opens the link and signs in joins the project. Send it however you like.')}</p>
              <div className={styles.row}>
                <select value={linkRole} onChange={(e) => setLinkRole(e.target.value as 'editor' | 'viewer')} aria-label={t('Role for the link')} data-testid="share-link-role">
                  <option value="editor">{t('Can edit')}</option>
                  <option value="viewer">{t('Can view')}</option>
                </select>
                <select value={String(linkDays)} onChange={(e) => setLinkDays(e.target.value === 'null' ? null : Number(e.target.value))} aria-label={t('Expiry')}>
                  {DAYS.map((option) => (
                    <option key={String(option.days)} value={String(option.days)}>
                      {t(option.label)}
                    </option>
                  ))}
                </select>
                <button type="button" className={styles.primary} disabled={busy} onClick={makeLink} data-testid="share-create-link">
                  <Link2 size={14} /> {t('Create link')}
                </button>
              </div>
              {link && (
                <div className={styles.link}>
                  <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label={t('Invite link')} data-testid="share-link" />
                  <button type="button" onClick={() => void copy(link)} data-testid="share-copy">
                    {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? t('Copied') : t('Copy')}
                  </button>
                </div>
              )}
              {list && list.invites.length > 0 && (
                <ul className={styles.list} data-testid="share-invites">
                  {list.invites.map((invite) => (
                    <li key={invite.token}>
                      <span className={styles.who}>
                        <strong>{invite.role === 'editor' ? t('Edit link') : t('View link')}</strong>
                        <small>
                          {t('Made')} {new Date(invite.createdAt).toLocaleDateString()} · {invite.uses} {invite.uses === 1 ? t('use') : t('uses')}
                          {invite.expiresAt ? ` · ${t('expires')} ${new Date(invite.expiresAt).toLocaleDateString()}` : ''}
                        </small>
                      </span>
                      <button type="button" className={styles.icon} aria-label={t('Withdraw link')} title={t('Withdraw link')} onClick={() => void run(() => cloud.deleteInvite(projectId, invite.token))}>
                        <Trash2 size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section className={styles.section}>
            <h3>{t('People with access')}</h3>
            {!list && !error && <p className={styles.hint}>{t('Loading...')}</p>}
            {list && (
              <ul className={styles.list} data-testid="share-members">
                {list.members.map((member) => (
                  <li key={member.userId}>
                    <span className={styles.avatar}>{(member.name || member.email).slice(0, 1)}</span>
                    <span className={styles.who}>
                      <strong>
                        {member.name}
                        {member.userId === myId ? ` (${t('you')})` : ''}
                      </strong>
                      <small>{member.email}</small>
                    </span>
                    {member.role === 'owner' || !owner ? (
                      <span className={styles.role}>{member.role === 'owner' ? t('Owner') : member.role === 'editor' ? t('Can edit') : t('Can view')}</span>
                    ) : (
                      <>
                        <select value={member.role} aria-label={t('Role')} onChange={(e) => void run(() => cloud.setRole(projectId, member.userId, e.target.value as 'editor' | 'viewer'))}>
                          <option value="editor">{t('Can edit')}</option>
                          <option value="viewer">{t('Can view')}</option>
                        </select>
                        <button type="button" className={styles.icon} aria-label={t('Remove')} title={t('Remove')} onClick={() => window.confirm(t(`Remove ${member.name} from this project?`)) && void run(() => cloud.removeMember(projectId, member.userId))}>
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {list && !owner && (
              <button type="button" className={styles.secondary} onClick={leave} data-testid="share-leave">
                <LogOut size={14} /> {t('Leave this project')}
              </button>
            )}
          </section>
        </div>
      </section>
    </div>,
    document.body,
  );
}

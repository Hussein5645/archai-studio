/** Top bar: who else is on this online project, and Share (puts a local project online first). */
import { Users } from 'lucide-react';
import { useAccount, useApp, useAppState, useLiveState } from '@/app/context';
import { openAccountDialog } from './account-dialog';
import { useI18n } from './i18n';
import { openShareDialog } from './ShareDialog';
import styles from './ShareDialog.module.css';

export function PeersBar() {
  const { t } = useI18n();
  const { cloud, persistence, toasts } = useApp();
  const account = useAccount();
  const live = useLiveState();
  const docId = useAppState((s) => s.doc.id);

  const share = async () => {
    if (account.status !== 'signed-in') {
      openAccountDialog('sign-in', 'Sign in to share projects and edit them together.');
      return;
    }
    if (persistence.entry(docId)?.cloud) {
      openShareDialog(docId);
      return;
    }
    if (!window.confirm(t('Sharing puts a copy of this project online, and you continue in the online copy. Put it online now?'))) return;
    try {
      const id = await cloud.putOnline(docId);
      openShareDialog(id);
    } catch (error) {
      toasts.push({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  // One avatar per person (a second window of the same person counts once).
  const people = new Map<string, { name: string; colour: string }>();
  for (const peer of live?.peers ?? []) if (peer.userId !== live?.you?.userId) people.set(peer.userId, { name: peer.name, colour: peer.colour });

  return (
    <div className={styles.peers} data-testid="peers-bar">
      {[...people.entries()].slice(0, 5).map(([userId, person]) => (
        <span key={userId} className={styles.peer} style={{ background: person.colour }} title={`${person.name} ${t('is here')}`} data-testid="peer-avatar">
          {person.name.slice(0, 1)}
        </span>
      ))}
      {people.size > 5 && <span className={styles.peer} style={{ background: 'var(--text-muted)' }}>+{people.size - 5}</span>}
      <button type="button" className={styles.share} onClick={() => void share()} data-testid="share-button">
        <Users size={14} aria-hidden="true" />
        {t('Share')}
      </button>
    </div>
  );
}

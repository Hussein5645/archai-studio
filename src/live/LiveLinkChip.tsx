/**
 * Top bar chip of the live link: which modelling apps are syncing with this project right now
 * (src/live/board.ts). Hidden until a plugin connects.
 */
import { Cable } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { isLive, useLiveConnections } from './board';
import styles from './LiveLinkChip.module.css';

function ago(time: number | null, now: number): string {
  if (!time) return 'not synced yet';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  return `${Math.round(seconds / 60)} min ago`;
}

export function LiveLinkChip() {
  const connections = useLiveConnections();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [open]);
  const live = connections.filter((c) => isLive(c, now));
  if (live.length === 0) return null;
  const apps = [...new Set(live.map((c) => c.app || 'App'))];
  return (
    <div className={styles.anchor} ref={anchor}>
      <button type="button" className={styles.chip} onClick={() => setOpen((o) => !o)} title="Live link: modelling apps syncing with this project" data-testid="live-link-chip">
        <span className={styles.dot} />
        <Cable size={14} />
        {apps.join(', ')}
      </button>
      {open && (
        <div className={styles.panel} role="dialog" aria-label="Live link">
          <h4>Live link</h4>
          <p>These apps send their model to this project as you edit, and receive ArchAI's model back. Turn it off in the app's ArchAI plugin.</p>
          {live.map((c) => (
            <div key={c.key} className={styles.row}>
              <strong>{c.app || 'App'}</strong>
              <span>{c.name || 'Model'}</span>
              <small>
                {c.objects} objects · {ago(c.lastSync, now)}
              </small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

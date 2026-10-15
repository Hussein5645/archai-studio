import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { clearLog, logEntries, subscribeLog } from '@/diagnostics';
import styles from './LiveLog.module.css';

export function LiveLog() {
  const [open, setOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const entries = useSyncExternalStore(subscribeLog, logEntries);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open && !paused) end.current?.scrollIntoView({ block: 'nearest' }); }, [entries, open, paused]);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [open]);
  return <>
    <button className={styles.launch} type="button" onClick={() => setOpen(true)} data-testid="open-live-log">Log</button>
    {open && createPortal(<div className={styles.backdrop} onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <section className={styles.window} role="dialog" aria-modal="true" aria-label="Live log" data-testid="live-log">
        <header><strong>Live log</strong><button type="button" onClick={() => setPaused(!paused)}>{paused ? 'Follow latest' : 'Pause scrolling'}</button>
          <button type="button" onClick={() => {
            const url = URL.createObjectURL(new Blob([entries.map((e) => `${e.time} ${e.level.toUpperCase()} ${e.message}`).join('\n')], { type: 'text/plain' }));
            const a = document.createElement('a'); a.href = url; a.download = 'ArchAI-log.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}>Save log</button>
          <button type="button" onClick={clearLog}>Clear</button><button autoFocus type="button" aria-label="Close live log" onClick={() => setOpen(false)}>Close</button></header>
        <div className={styles.entries} role="log" aria-live="off">{entries.length ? entries.map((e) => <div key={e.id} data-level={e.level}><time>{e.time.slice(11, 19)}</time> {e.level.toUpperCase()} {e.message}</div>) : <p>No events yet. Tasks and errors appear here as they happen.</p>}<div ref={end} /></div>
        <footer>Current session · latest 500 entries · times in UTC</footer>
      </section></div>, document.body)}
  </>;
}

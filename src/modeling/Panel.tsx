import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import styles from './Modeling.module.css';

export function Panel({ title, action, children, defaultOpen = true, storageKey = title.toLowerCase().replace(/\s+/g, '-') }: { title: string; action?: ReactNode; children: ReactNode; defaultOpen?: boolean; storageKey?: string }) {
  const [open, setOpen] = useState(() => {
    try {
      const saved = window.localStorage.getItem(`archai:modeling:panel:${storageKey}`);
      return saved === null ? defaultOpen : saved === 'open';
    } catch {
      return defaultOpen;
    }
  });
  const toggle = () => setOpen((value) => {
    const next = !value;
    try {
      window.localStorage.setItem(`archai:modeling:panel:${storageKey}`, next ? 'open' : 'closed');
    } catch {
      // Storage can be disabled; panel state still works for this session.
    }
    return next;
  });
  return (
    <section className={styles.panel} data-open={open || undefined}>
      <header className={styles.panelHeader}>
        <button type="button" className={styles.panelToggle} onClick={toggle} aria-expanded={open}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <h2 className={styles.panelTitle}>{title}</h2>
        </button>
        {open && action}
      </header>
      {open && <div className={styles.panelBody}>{children}</div>}
    </section>
  );
}

import { useSyncExternalStore } from 'react';
import { useApp } from '@/app/context';
import styles from './Toasts.module.css';

export function Toasts() {
  const { toasts } = useApp();
  const items = useSyncExternalStore(toasts.subscribe, toasts.getSnapshot);
  if (items.length === 0) return null;
  return (
    <div className={styles.host} role="status" data-ui-scale aria-live="polite">
      {items.map((toast) => (
        <div key={toast.id} className={styles.toast} data-kind={toast.kind} data-testid="toast">
          <span>{toast.message}</span>
          <button type="button" className={styles.dismiss} onClick={() => toasts.dismiss(toast.id)} aria-label="Dismiss">
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}

import { useSyncExternalStore } from 'react';
import styles from '@/ui/AccountDialog.module.css';
import own from './LiveBridgePanel.module.css';

type Choice = { replace: string } | { create: true } | null;
interface Request {
  app: string;
  name: string;
  sources: { key: string; name: string }[];
  resolve(choice: Choice): void;
}
let current: Request | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function chooseSourceLink(app: string, name: string, sources: Request['sources']): Promise<Choice> {
  return new Promise((resolve) => {
    current = { app, name, sources, resolve: (choice) => { current = null; emit(); resolve(choice); } };
    emit();
  });
}

export function SourceLinkPicker() {
  const request = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => current,
  );
  if (!request) return null;
  return (
    <div className={styles.backdrop} role="presentation">
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Existing app link" data-testid="bridge-source-picker">
        <div className={styles.header}><h2 className={styles.title}>Another {request.app} model is linked</h2></div>
        <div className={own.picker}>
          <p>Linking {request.name || 'this model'}: replace an existing model and its geometry, or create a new link to keep both models.</p>
          <ul>{request.sources.map((source) => (
            <li key={source.key}><button type="button" onClick={() => request.resolve({ replace: source.key })}>
              Replace {source.name || 'existing model'}
            </button></li>
          ))}</ul>
          <div className={own.actions}>
            <button type="button" onClick={() => request.resolve({ create: true })}>Create new link</button>
            <button type="button" onClick={() => request.resolve(null)}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

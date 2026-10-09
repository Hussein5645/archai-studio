import { PenTool, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAppState, useDispatch } from '@/app/context';
import styles from './AssetNamePrompt.module.css';
import { useI18n } from './i18n';
import { TextButton } from './primitives';

/** Asks for the new asset's name, then opens the modeling workspace with it. */
export function AssetNamePrompt() {
  const open = useAppState((s) => s.ui.assetNamePrompt);
  // Remount on every open so the name starts empty.
  return open ? <Prompt /> : null;
}

function Prompt() {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const close = () => void dispatch('prompt-asset-name', { open: false });
  const submit = () => {
    if (name.trim()) void dispatch('open-modeling', { name: name.trim() });
  };
  return (
    <div className={styles.backdrop} data-ui-scale onClick={(event) => event.target === event.currentTarget && close()}>
      <form
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="asset-name-title"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <header className={styles.header}>
          <h2 id="asset-name-title" className={styles.title}>
            {t('New .CAI asset')}
          </h2>
          <button type="button" className={styles.close} onClick={close} aria-label={t('Close')}>
            <X size={16} />
          </button>
        </header>
        <p className={styles.hint}>{t('The asset opens in the modeling workspace, where it is modeled, autosaved locally and packaged as .CAI.')}</p>
        <label className={styles.label}>
          <span>{t('Name')}</span>
          <input ref={inputRef} className={styles.input} value={name} placeholder={t('e.g. Lounge chair')} onChange={(event) => setName(event.target.value)} data-testid="asset-name-input" />
        </label>
        <footer className={styles.footer}>
          <TextButton type="button" onClick={close}>
            Cancel
          </TextButton>
          <TextButton primary type="submit" disabled={!name.trim()} data-testid="asset-name-submit">
            <PenTool size={13} /> {t('Start modeling')}
          </TextButton>
        </footer>
      </form>
    </div>
  );
}

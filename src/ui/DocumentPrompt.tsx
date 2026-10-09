import { FilePlus2, FolderOpen, Save, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAppState, useDispatch } from '@/app/context';
import { documentNeedsSaveCopy } from '@/commands/builtin/document';
import styles from './AssetNamePrompt.module.css';
import { useI18n } from './i18n';
import { TextButton } from './primitives';

/**
 * "New file" asks for the new file's name; both "new" and "open" first offer to save a copy of
 * the current document when replacing it would lose work.
 */
export function DocumentPrompt() {
  const kind = useAppState((s) => s.ui.documentPrompt);
  // Remount on every open so the name field starts empty.
  return kind ? <Prompt key={kind} kind={kind} /> : null;
}

function Prompt({ kind }: { kind: 'new' | 'open' }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const currentName = useAppState((s) => s.doc.meta.name);
  const needsSave = useAppState(documentNeedsSaveCopy);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const isNew = kind === 'new';
  const canProceed = !busy && (!isNew || name.trim().length > 0);
  const close = () => void dispatch('set-document-prompt', { kind: null });
  const proceed = () => {
    if (isNew) void dispatch('new-document', { name: name.trim() });
    else void dispatch('open-document');
  };
  const saveCopyThenProceed = async () => {
    setBusy(true);
    try {
      const result = await dispatch('save-document-as');
      // A cancelled save dialog keeps the prompt open so nothing is lost by accident.
      if (result.ok && result.value) proceed();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.backdrop} data-ui-scale onClick={(event) => event.target === event.currentTarget && close()}>
      <form
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="document-prompt-title"
        data-testid={`document-prompt-${kind}`}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canProceed) return;
          if (needsSave) void saveCopyThenProceed();
          else proceed();
        }}
      >
        <header className={styles.header}>
          <h2 id="document-prompt-title" className={styles.title}>
            {t(isNew ? 'New file' : 'Open file')}
          </h2>
          <button type="button" className={styles.close} onClick={close} aria-label={t('Close')}>
            <X size={16} />
          </button>
        </header>
        {isNew && (
          <label className={styles.label}>
            <span>{t('Name')}</span>
            <input ref={inputRef} className={styles.input} value={name} placeholder={t('e.g. Ground floor plan')} onChange={(event) => setName(event.target.value)} data-testid="document-name-input" />
          </label>
        )}
        {needsSave && (
          <p className={styles.hint}>
            {t('Save a copy of the current file first?')} <strong>{currentName || t('Untitled')}</strong>{' '}
            {t(isNew ? 'has work that is not saved to a .AIR file. It will be replaced by the new file.' : 'has work that is not saved to a .AIR file. It will be replaced by the opened file.')}
          </p>
        )}
        <footer className={styles.footer}>
          <TextButton type="button" onClick={close} disabled={busy}>
            Cancel
          </TextButton>
          {needsSave ? (
            <>
              <TextButton type="button" onClick={proceed} disabled={!canProceed} data-testid="document-prompt-discard">
                {t("Don't save")}
              </TextButton>
              <TextButton primary type="submit" disabled={!canProceed} data-testid="document-prompt-save">
                <Save size={13} /> {t(isNew ? 'Save copy & create' : 'Save copy & open')}
              </TextButton>
            </>
          ) : (
            <TextButton primary type="submit" disabled={!canProceed} data-testid="document-prompt-submit">
              {isNew ? <FilePlus2 size={13} /> : <FolderOpen size={13} />} {t(isNew ? 'Create' : 'Open')}
            </TextButton>
          )}
        </footer>
      </form>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Loader2, X } from 'lucide-react';
import { useApp, useAppState } from '@/app/context';
import { getElectronBridge } from '@/platform/electron';
import { IPC, type D5FolderResult } from '@shared/ipc';
import { convertD5Folder, type D5ConvertedScene } from '@shared/d5';
import { bytesToBase64 } from '@/persistence/base64';
import { withProgress } from '@/progress';
import { useI18n } from './i18n';
import { TextButton } from './primitives';
import styles from './D5ImportDialog.module.css';

export function D5ImportDialog() {
  const open = useAppState((s) => s.ui.d5ImportOpen);
  const documentId = useAppState((s) => s.doc.id);
  return open ? <Dialog key={documentId} documentId={documentId} /> : null;
}

function Dialog({ documentId }: { documentId: string }) {
  const { t } = useI18n();
  const { executor, store, toasts } = useApp();
  const [scene, setScene] = useState<D5ConvertedScene | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    if (!busy) void executor.dispatch('set-d5-import-open', { open: false });
  };
  useEffect(() => {
    active.current = true;
    closeRef.current?.focus();
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) void executor.dispatch('set-d5-import-open', { open: false });
      }
    };
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, [busy, executor]);

  const choose = async () => {
    const bridge = getElectronBridge();
    if (!bridge || busy) return;
    setBusy(true);
    setError('');
    try {
      const folder = await bridge.invoke<D5FolderResult | null>(IPC.filesOpenD5Folder);
      if (!folder || !active.current) return;
      const converted = await withProgress('Reading D5 project', async (task) => {
        task.update('Converting scene geometry and materials', null);
        await task.paint();
        return convertD5Folder(folder);
      });
      if (active.current) setScene(converted);
    } catch (caught) {
      if (active.current) {
        setScene(null);
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const place = async (prepare: boolean) => {
    if (!scene || busy || store.getState().doc.id !== documentId) return;
    setBusy(true);
    setError('');
    try {
      const result = await executor.dispatch('place-d5-scene', {
        documentId,
        name: scene.report.name.slice(0, 200),
        glb: bytesToBase64(scene.glb),
      });
      if (!result.ok) throw new Error(result.error.message);
      toasts.push({
        kind: 'success',
        message: t(
          `Imported ${scene.report.actors} D5 object${scene.report.actors === 1 ? '' : 's'}`,
        ),
      });
      await executor.dispatch('set-d5-import-open', { open: false });
      if (prepare && store.getState().doc.id === documentId) {
        const opened = await executor.dispatch('open-render-studio', { bake: true });
        if (!opened.ok) toasts.push({ kind: 'error', message: opened.error.message });
      }
    } catch (caught) {
      if (active.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (active.current) setBusy(false);
    }
  };
  return (
    <div
      className={styles.backdrop}
      data-ui-scale
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="d5-title"
        aria-busy={busy}
        data-testid="d5-import-dialog"
      >
        <header className={styles.header}>
          <h2 id="d5-title">{t('D5 scene to VR')}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            disabled={busy}
            aria-label={t('Close')}
          >
            <X size={18} />
          </button>
        </header>
        <div className={styles.body}>
          <p>
            {t(
              'Choose your saved D5 project folder. ArchAI converts the supported objects and materials, then opens VR preparation to bake and publish a walkable scene.',
            )}
          </p>
          <TextButton onClick={() => void choose()} disabled={busy}>
            <FolderOpen size={16} /> {t(scene ? 'Choose another D5 folder' : 'Choose D5 folder')}
          </TextButton>
          {busy && (
            <p role="status">
              <Loader2 size={16} className={styles.spinner} /> {t('Preparing your D5 scene…')}
            </p>
          )}
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          {scene && (
            <>
              <strong>{scene.report.name}</strong>
              <p>
                {scene.report.actors.toLocaleString()} {t('objects')} ·{' '}
                {scene.report.triangles.toLocaleString()} {t('triangles')} ·{' '}
                {scene.report.textures.toLocaleString()} {t('textures')}
              </p>
              {scene.report.omitted.length > 0 && (
                <div className={styles.notice} data-testid="d5-omissions">
                  <strong>{t('Partial scene — these parts need attention')}</strong>
                  <ul>
                    {scene.report.omitted.map((message) => (
                      <li key={message}>{t(message)}</li>
                    ))}
                  </ul>
                </div>
              )}
              {scene.report.review.map((message) => (
                <p key={message} className={styles.note}>
                  {t(message)}
                </p>
              ))}
              {scene.report.triangles > 1_000_000 && (
                <p className={styles.notice}>
                  {t(
                    'This scene exceeds the bake limit of one million triangles. Reduce it before baking.',
                  )}
                </p>
              )}
              <p className={styles.note}>
                {t(
                  'ArchAI adds a starting view beside the scene if this project has no VR stops. Review or move it in the 3D view before sharing.',
                )}
              </p>
              <p className={styles.note}>
                {t(
                  'Import and bake opens VR preparation and starts baking automatically. Review the result, then Publish VR link with your ArchAI account.',
                )}
              </p>
            </>
          )}
        </div>
        <footer className={styles.footer}>
          <TextButton disabled={busy} onClick={close}>
            Cancel
          </TextButton>
          {scene && (
            <TextButton disabled={busy} onClick={() => void place(false)}>
              Import scene
            </TextButton>
          )}
          <TextButton
            primary
            disabled={busy || !scene || scene.report.triangles > 1_000_000}
            onClick={() => void place(true)}
          >
            {scene?.report.omitted.length
              ? 'Import partial scene and bake VR'
              : 'Import and bake VR'}
          </TextButton>
        </footer>
      </section>
    </div>
  );
}

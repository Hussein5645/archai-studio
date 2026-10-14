import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Loader2, X } from 'lucide-react';
import { useApp, useAppState } from '@/app/context';
import { getElectronBridge } from '@/platform/electron';
import { IPC, type D5FolderResult, type D5ResourceResult } from '@shared/ipc';
import { type D5ConvertedScene, type D5Progress } from '@shared/d5';
import { convertD5InWorker } from '@/view3d/d5Convert';
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
  const [progress, setProgress] = useState<D5Progress | null>(null);
  const controller = useRef<AbortController | null>(null);
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
      controller.current?.abort();
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
    setProgress(null);
    const abort = new AbortController();
    controller.current = abort;
    let sessionId: string | undefined;
    try {
      const folder = await bridge.invoke<D5FolderResult | null>(IPC.filesOpenD5Folder);
      sessionId = folder?.sessionId;
      abort.signal.throwIfAborted();
      if (!folder || !active.current) return;
      if (!sessionId) throw new Error('Restart ArchAI to use the updated D5 folder importer.');
      const converted = await withProgress('Reading D5 project', async (task) => {
        return convertD5InWorker(
          folder,
          (names) =>
            bridge.invoke<D5ResourceResult[]>(IPC.filesReadD5Resources, { sessionId, names }),
          (value) => {
            if (active.current) setProgress(value);
            task.update(value.message, value.total ? value.completed / value.total : null);
          },
          abort.signal,
        );
      });
      if (active.current) setScene(converted);
    } catch (caught) {
      if (active.current) {
        setScene(null);
        setError(
          (caught instanceof Error ? caught.message : String(caught)).replace(
            /^Error invoking remote method '[^']+': (?:Error: )?/,
            '',
          ),
        );
      }
    } finally {
      if (sessionId)
        await bridge.invoke(IPC.filesCloseD5Folder, { sessionId }).catch(() => undefined);
      if (controller.current === abort) controller.current = null;
      if (active.current) setBusy(false);
    }
  };
  const place = async (prepare: boolean) => {
    if (!scene || busy || store.getState().doc.id !== documentId) return;
    setBusy(true);
    setError('');
    setProgress(null);
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
              <Loader2 size={16} className={styles.spinner} />{' '}
              {t(progress?.message ?? 'Preparing your D5 scene…')}
            </p>
          )}
          {busy && progress && (
            <progress
              aria-label={t('D5 import progress')}
              max={Math.max(1, progress.total)}
              value={progress.completed}
              style={{ width: '100%' }}
            />
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
                    'ArchAI will prepare a lighter scene for VR. The detailed imported model stays available in High detail mode. Review the reduced scene before sharing.',
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
            disabled={busy || !scene}
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

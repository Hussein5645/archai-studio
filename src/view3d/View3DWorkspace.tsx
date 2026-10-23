import { UnrealAccess } from '@/studio/UnrealAccess';
import { UnrealViewport } from '@/studio/RenderWorkspace';
import { renderOf } from '@/studio/viewRender';
import { ViewOutputDialog, viewActionEvent, encodeImage, type ImageOutput, type ViewAction } from '@/studio/ViewOutput';
import { exportInteractiveFolder, type InteractiveOutput } from '@/studio/interactiveExport';
import { documentInContext, viewContext } from '@/document/viewVisibility';
import { useViewPreview } from './viewPreview';
import { Brush, MapPin, Pipette, X } from 'lucide-react';
import { SceneMaterialTools } from '@/ui/SceneMaterialTools';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useApp, useAppState, useDispatch } from '@/app/context';
import styles from './View3D.module.css';
import { paintTarget, sectionOf, useSceneView } from './useSceneView';
import { materialById } from '@/materials/slots';
import { LIBRARY_DRAG_TYPE, MATERIAL_DRAG_TYPE, materialUi, useMaterialUi } from '@/materials/uiStore';
import { droppedMaterial } from '@/materials/library';
import { Swatch } from '@/ui/MaterialsLibrary';
import { useI18n } from '@/ui/i18n';
import { cameraNavigationLocked } from '@/document/viewCamera';
import type { SceneLoading } from './useSceneView';

/** Full-screen 3D workspace: same scene, same selection, same commands as the board. */
export function View3DWorkspace() {
  const dispatch = useDispatch();
  const open = useAppState((s) => s.ui.view3d.open);
  const portalId = useAppState((s) => s.ui.view3d.portalId);
  if (!open) return null;
  return <Workspace portalId={portalId} onClose={() => void dispatch('close-view3d')} />;
}

type VrState = { kind: 'busy' } | { kind: 'done'; link: string; stops: number; megabytes: number } | { kind: 'error'; message: string };

function Workspace({ portalId, onClose }: { portalId: string | null; onClose: () => void }) {
  const { t } = useI18n();
  const { executor, platform, toasts, store, catalog } = useApp();
  const containerRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    const main = toolbar?.closest('main');
    if (!toolbar || !main) return;
    const update = () => main.style.setProperty('--scene-toolbar-offset', `${Math.ceil(toolbar.getBoundingClientRect().bottom - main.getBoundingClientRect().top + 12)}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(toolbar);
    return () => { observer.disconnect(); main.style.removeProperty('--scene-toolbar-offset'); };
  }, []);
  const [loading, setLoading] = useState<SceneLoading>({ detail: 'Preparing 3D view' });
  const renderer = useAppState((s) => renderOf(s.doc, portalId).renderer);
  const view = useSceneView(containerRef, portalId, undefined, setLoading, renderer === 'default');
  const doc = useAppState((s) => s.doc);
  const preview = useViewPreview(doc.id, portalId);
  const editingBoard = useAppState((s) => Boolean(s.ui.view3d.editingBoard));
  const portal = portalId ? doc.elements[portalId] : null;
  const pinned = cameraNavigationLocked(doc, portalId);
  const cut = sectionOf(doc, portalId);
  const isSection = Boolean(cut);
  const isCamera = Boolean((portal?.meta?.['view3d'] as { cameraMode?: boolean } | undefined)?.cameraMode);
  const [placing, setPlacing] = useState(false);
  const [outputMode, setOutputMode] = useState<'render' | 'interactive' | null>(null);
  const [exportDestination, setExportDestination] = useState<'folder' | 'link'>('folder');
  const [outputBusy, setOutputBusy] = useState(false);
  const [outputError, setOutputError] = useState('');
  const [outputResult, setOutputResult] = useState('');
  const [vr, setVr] = useState<VrState | null>(null);
  const { active, painting, scope, picking, adjusting } = useMaterialUi();
  const activeMaterial = active ? materialById(doc, active) : null;
  const dispatch = useDispatch();
  // The desktop app's studio window (in the browser only for development).


  useEffect(() => {
    view.current?.setPainting(painting && !isSection);
  }, [painting, isSection, view]);
  useEffect(() => {
    view.current?.setPaintScope(scope);
  }, [scope, view]);
  useEffect(() => {
    view.current?.setPicking(picking && !isSection);
  }, [picking, isSection, view]);
  // Leaving the workspace puts the brush and the pipette down.
  useEffect(
    () => () => {
      // Only when the workspace really closed (not a remount): a brush taken from the panel stays on.
      if (!store.getState().ui.view3d.open) materialUi.set({ painting: false, picking: false, adjusting: null });
    },
    [store],
  );

  const togglePaint = () => {
    if (!painting && !activeMaterial) {
      void dispatch('show-materials');
      toasts.push({ kind: 'info', message: t('Pick a material in the Materials panel, then paint') });
    }
    setPlacing(false);
    materialUi.set({ painting: !painting, picking: false });
  };
  const togglePick = () => {
    setPlacing(false);
    materialUi.set({ picking: !picking, painting: false });
  };

  useEffect(() => {
    view.current?.setPlacingStop(placing);
  }, [placing, view]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName));
      if ((event.key === 'b' || event.key === 'B') && !event.ctrlKey && !event.metaKey && !event.altKey && !typing && !isSection) {
        event.preventDefault();
        togglePaint();
        return;
      }
      if ((event.key === 'i' || event.key === 'I') && !event.ctrlKey && !event.metaKey && !event.altKey && !typing && !isSection) {
        event.preventDefault();
        togglePick();
        return;
      }
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      // Escape closes the material panel / puts down the brush or pipette / leaves stop placement / the link panel before it leaves the workspace.
      if (adjusting) materialUi.set({ adjusting: null });
      else if (painting || picking) materialUi.set({ painting: false, picking: false });
      else if (placing) setPlacing(false);
      else if (store.getState().ui.tool !== 'select') void dispatch('set-tool', { tool: 'select' });
      else if (editingBoard) void dispatch('toggle-view-board');
      else if (vr && vr.kind !== 'busy') setVr(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const copy = async (link: string) => {
    try {
      await platform.clipboard.writeText(link);
      toasts.push({ kind: 'success', message: t('Link copied') });
    } catch {
      toasts.push({ kind: 'error', message: t('Could not copy the link') });
    }
  };

  const outputHandlers = useRef<(action: ViewAction) => void>(() => {});
  useEffect(() => { outputHandlers.current = (action) => {
    if (action === 'render' || action === 'interactive') { setOutputError(''); setExportDestination('folder'); setOutputMode(action); }
    else if (action === 'vr') { setOutputError(''); setExportDestination('link'); setOutputMode('interactive'); }
  }; });
  useEffect(() => {
    if (renderer !== 'default') return;
    const handler = (event: Event) => { const detail = (event as CustomEvent<{ portalId: string; action: ViewAction }>).detail; if (detail.portalId === portalId) outputHandlers.current(detail.action); };
    window.addEventListener(viewActionEvent, handler);
    return () => window.removeEventListener(viewActionEvent, handler);
  }, [renderer, portalId]);
  const renderImage = async (options: ImageOutput) => {
    setOutputBusy(true); setOutputError('');
    try {
      if (!view.current) throw new Error('Wait for the 3D view to finish loading');
      const scale = options.quality === 'high' ? Math.min(2, 8192 / Math.max(options.width, options.height)) : 1;
      const rendered = view.current.renderImage(Math.round(options.width * scale), Math.round(options.height * scale), { grid: false });
      const canvas = document.createElement('canvas'); canvas.width = options.width; canvas.height = options.height;
      const context = canvas.getContext('2d')!; context.imageSmoothingQuality = 'high'; context.drawImage(rendered, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Could not render image')), 'image/png'));
      const bytes = await encodeImage(new Uint8Array(await blob.arrayBuffer()), options.format);
      await platform.files.saveBinary(bytes, 'Archai render.' + (options.format === 'png' ? 'png' : 'jpg'), 'image/' + options.format);
    } catch (reason) { setOutputError(String(reason)); } finally { setOutputBusy(false); }
  };
  const exportInteractive = async (ids: string[] | null, output: InteractiveOutput) => {
    setOutputBusy(true); setOutputError(''); setOutputResult('');
    try {
      const scene = portalId ? documentInContext(store.getState().doc, viewContext(portalId)) : store.getState().doc;
      if (output.destination === 'link') {
        const result = await executor.dispatch('publish-vr-tour', { portalId: portalId ?? undefined, elementIds: ids ?? undefined, interactive: output });
        if (!result.ok) throw new Error(result.error.message);
        setOutputResult((result.value as {link:string}).link);
      } else {
        const saved = await exportInteractiveFolder(platform, catalog, scene, portalId, ids, output, view.current?.getCamera());
        if (saved) setOutputResult('Interactive scene saved: ' + saved);
      }
    } catch (reason) { setOutputError(String(reason)); } finally { setOutputBusy(false); }
  };
  if (renderer !== 'default' && portalId) return <UnrealAccess onClose={onClose}><UnrealViewport key={portalId} portalId={portalId} onClose={onClose} /></UnrealAccess>;
  return (
    <div className={styles.workspace} data-editing-board={editingBoard || undefined} data-testid="view3d-workspace" aria-busy={loading !== null}>
      <div
        ref={containerRef}
        className={styles.workspaceCanvas}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(MATERIAL_DRAG_TYPE) && !event.dataTransfer.types.includes(LIBRARY_DRAG_TYPE)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          view.current?.showPaintHover(event.clientX, event.clientY, view.current.scopeFor(event));
        }}
        onDrop={(event) => {
          const materialId = event.dataTransfer.getData(MATERIAL_DRAG_TYPE);
          const fromLibrary = event.dataTransfer.getData(LIBRARY_DRAG_TYPE);
          if (!materialId && !fromLibrary) return;
          event.preventDefault();
          const target = view.current?.targetAt(event.clientX, event.clientY);
          if (!target) {
            toasts.push({ kind: 'info', message: t('Drop the material onto a surface') });
            return;
          }
          const scope = view.current!.scopeFor(event);
          // Dropping a material paints there and keeps the brush on for the next clicks.
          const paint = (id: string) => {
            materialUi.set({ active: id, painting: true, picking: false });
            paintTarget({ executor, toasts, store }, target, scope, id, view.current);
          };
          if (materialId) paint(materialId);
          else void droppedMaterial(fromLibrary, (id, input) => executor.dispatch(id, input), store.getState().doc, platform).then(paint, (error: unknown) => toasts.push({ kind: 'error', message: error instanceof Error ? error.message : String(error) }));
        }}
      />
      {loading && !loading.updating && preview && <img src={preview} alt="Saved view preview" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} />}
      {loading && <div className={loading.updating ? styles.sceneUpdating : styles.sceneLoading} data-testid={loading.updating ? "view3d-updating" : "view3d-loading"} role="status">
        <strong>{t(loading.error ? 'Could not update 3D view' : loading.updating ? 'Updating model' : 'Opening 3D view')}</strong>
        <span>{t(loading.detail)}</span>
        {preview && !loading.updating && <img src={preview} alt="Previous view" style={{ maxWidth: '70%', maxHeight: '60%' }} />}
        {loading.error && <button type="button" onClick={onClose}>{t('Close')}</button>}
      </div>}
      {!isSection && (!loading || loading.updating) && <SceneMaterialTools view={view.current} onTogglePaint={togglePaint} />}
      {outputMode && <ViewOutputDialog key={outputMode+exportDestination} initialDestination={exportDestination} portalId={portalId} result={outputResult} mode={outputMode} busy={outputBusy} error={outputError} onClose={() => setOutputMode(null)} onImage={renderImage} onInteractive={exportInteractive} />}
      <div ref={toolbarRef} className={styles.workspaceBar} data-testid="view3d-toolbar">
        <strong>{t(cut?.plan ? 'Plan (Level)' : isSection ? 'Section' : isCamera ? 'Camera (Perspective)' : '3D (Orthographic)')}</strong>
        <button type="button" data-active={editingBoard} onClick={() => void dispatch('toggle-view-board')}>{t(editingBoard ? 'Hide board editor' : 'Edit board')}</button>
        {pinned && <span className={styles.hint}>{t('Camera pinned')}</span>}
        <button type="button" disabled={pinned || (loading !== null && !loading.updating)} onClick={() => view.current?.frameAll()}>{t('Frame all')}</button>
        {!isSection && (!loading || loading.updating) && (
          <>
            <button type="button" data-active={placing} onClick={() => { materialUi.set({ painting: false }); setPlacing((on) => !on); }} title={t('Click floors to place VR tour stops; each faces the way you are looking (Esc to stop)')}>
              <MapPin size={13} />
              {t('VR stop')}
            </button>

          </>
        )}
        {!isSection && (!loading || loading.updating) && (
          <>
            <button type="button" data-active={painting} onClick={togglePaint} title={t('Paint (B): click to apply the material in hand (Face / Part / Object / Replace all in the bar below), Shift+click the part, Ctrl+click the whole object, Alt+click to pick a material. Or drag a swatch from Materials.')}>
              {activeMaterial ? <Swatch material={activeMaterial} size="small" /> : <Brush size={13} />}
              {t('Paint')}
            </button>
            <button type="button" data-active={picking} onClick={togglePick} title={t('Pick material (I): click the model to pick its material and adjust its scale, rotation, colour…')} data-testid="pick-material-top">
              <Pipette size={13} />
              {t('Pick')}
            </button>
          </>
        )}
        {placing && <span className={styles.hint}>{t('Click a floor to add a stop')}</span>}
        <button type="button" onClick={onClose} aria-label={t('Close 3D workspace')} title={t('Close (Esc)')}>
          <X size={15} />
        </button>
      </div>
      {vr && (
        <div className={styles.vrPanel} role="status">
          {vr.kind === 'busy' && <p>{t('Exporting the model and uploading the tour…')}</p>}
          {vr.kind === 'error' && (
            <>
              <p className={styles.vrError}>{vr.message}</p>
              <div className={styles.vrActions}>
                <button type="button" onClick={() => setVr(null)}>{t('Close')}</button>
              </div>
            </>
          )}
          {vr.kind === 'done' && (
            <>
              <input className={styles.vrLink} readOnly value={vr.link} onFocus={(event) => event.currentTarget.select()} aria-label={t('VR link')} />
              <p>
                {t('Open this link in the Meta Quest Browser and press Enter VR.')} {vr.stops} {t(vr.stops === 1 ? 'stop' : 'stops')} · {vr.megabytes.toFixed(1)} MB.{' '}
                {t('Publishing again updates this same link.')}
              </p>
              <div className={styles.vrActions}>
                <button type="button" onClick={() => void copy(vr.link)}>{t('Copy link')}</button>
                <button type="button" onClick={() => window.open(vr.link, '_blank', 'noopener')}>{t('Open')}</button>
                <button type="button" onClick={() => setVr(null)}>{t('Close')}</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

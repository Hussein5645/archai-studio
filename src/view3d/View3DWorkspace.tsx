import { Brush, Glasses, MapPin, Pipette, Sparkles, X } from 'lucide-react';
import { SceneMaterialTools } from '@/ui/SceneMaterialTools';
import { useEffect, useRef, useState } from 'react';
import { useApp, useAppState, useDispatch } from '@/app/context';
import styles from './View3D.module.css';
import { paintTarget, sectionOf, useSceneView } from './useSceneView';
import { materialById } from '@/materials/slots';
import { LIBRARY_DRAG_TYPE, MATERIAL_DRAG_TYPE, materialUi, useMaterialUi } from '@/materials/uiStore';
import { droppedMaterial } from '@/materials/library';
import { Swatch } from '@/ui/MaterialsLibrary';
import { useI18n } from '@/ui/i18n';
import { canRender, openRenderStudio } from '@/studio/link';
import { openAccountDialog } from '@/ui/account-dialog';
import { VR_SIGN_IN_MESSAGE } from './vrShare';

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
  const { executor, platform, toasts, store } = useApp();
  const containerRef = useRef<HTMLDivElement>(null);
  const view = useSceneView(containerRef, portalId);
  const doc = useAppState((s) => s.doc);
  const portal = portalId ? doc.elements[portalId] : null;
  const cut = sectionOf(doc, portalId);
  const isSection = Boolean(cut);
  const isCamera = Boolean((portal?.meta?.['view3d'] as { cameraMode?: boolean } | undefined)?.cameraMode);
  const [placing, setPlacing] = useState(false);
  const [vr, setVr] = useState<VrState | null>(null);
  const { active, painting, scope, picking, adjusting } = useMaterialUi();
  const activeMaterial = active ? materialById(doc, active) : null;
  const dispatch = useDispatch();
  // The desktop app's studio window (in the browser only for development).
  const renderAvailable = canRender(platform) && (platform.kind === 'electron' || import.meta.env.DEV);

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
      else if (vr && vr.kind !== 'busy') setVr(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const publish = async () => {
    setPlacing(false);
    setVr({ kind: 'busy' });
    const result = await executor.dispatch('publish-vr-tour', {});
    if (result.ok) {
      const value = result.value as { link: string; stops: number; bytes: number };
      setVr({ kind: 'done', link: value.link, stops: value.stops, megabytes: value.bytes / 1_048_576 });
    } else {
      setVr({ kind: 'error', message: result.error.message });
      if (result.error.message === VR_SIGN_IN_MESSAGE) openAccountDialog('sign-in', VR_SIGN_IN_MESSAGE);
    }
  };

  const copy = async (link: string) => {
    try {
      await platform.clipboard.writeText(link);
      toasts.push({ kind: 'success', message: t('Link copied') });
    } catch {
      toasts.push({ kind: 'error', message: t('Could not copy the link') });
    }
  };

  return (
    <div className={styles.workspace} data-testid="view3d-workspace">
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
      {!isSection && <SceneMaterialTools view={view.current} onTogglePaint={togglePaint} />}
      <div className={styles.workspaceBar}>
        <strong>{t(cut?.plan ? 'Plan (Level)' : isSection ? 'Section' : isCamera ? 'Camera (Perspective)' : '3D (Orthographic)')}</strong>
        <button type="button" onClick={() => view.current?.frameAll()}>{t('Frame all')}</button>
        {!isSection && (
          <>
            <button type="button" data-active={placing} onClick={() => { materialUi.set({ painting: false }); setPlacing((on) => !on); }} title={t('Click floors to place VR tour stops; each faces the way you are looking (Esc to stop)')}>
              <MapPin size={13} />
              {t('VR stop')}
            </button>
            <button type="button" onClick={() => void publish()} disabled={vr?.kind === 'busy'} title={t('Upload the model with its stops and get a link for a VR headset')}>
              <Glasses size={13} />
              {t('VR link')}
            </button>
          </>
        )}
        {!isSection && renderAvailable && (
          <button type="button" onClick={() => openRenderStudio(platform, view.current?.getCamera(), portal?.name)} title={t('Open this view in ArchAI Render (path tracing, sun and sky, entourage)')} data-testid="open-render-studio">
            <Sparkles size={13} />
            {t('Render')}
          </button>
        )}
        {!isSection && (
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

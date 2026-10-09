import { Camera, FlipHorizontal2, Maximize2 } from 'lucide-react';
import { memo, useCallback, useRef } from 'react';
import { useAppState, useAppStateShallow, useDispatch } from '@/app/context';
import { boardDoc } from '@/store';
import { isEffectivelyVisible } from '@/document';
import { worldMatrix } from '@/geometry';
import styles from './View3D.module.css';
import { sectionOf, useSceneView } from './useSceneView';
import { useI18n } from '@/ui/i18n';

/** One live 3D viewport sitting inside a portal rect on the board. */
export const View3DPortal = memo(function View3DPortal({ id }: { id: string }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const element = useAppState((s) => boardDoc(s).elements[id]);
  const viewport = useAppState((s) => s.ui.viewport);
  // Positioned like any board element: it follows a drag live.
  const doc = useAppState((s) => boardDoc(s));
  const selected = useAppState((s) => s.ui.selection.includes(id));
  const containerRef = useRef<HTMLDivElement>(null);
  const open = useCallback(() => void dispatch('open-view3d', { id }), [dispatch, id]);
  useSceneView(containerRef, id, open);
  if (!element || element.kind !== 'rect' || !element.visible) return null;
  const matrix = worldMatrix(doc.elements, element);
  const left = matrix[4] * viewport.zoom + viewport.x;
  const top = matrix[5] * viewport.zoom + viewport.y;
  const width = element.width * viewport.zoom;
  const height = element.height * viewport.zoom;
  const rotation = (Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI;
  const cut = sectionOf(doc, id);
  const isSection = Boolean(cut) && !cut?.plan;
  const tiny = width < 80 || height < 60;
  if (!isEffectivelyVisible(doc.elements, id)) return null;
  return (
    <div
      className={styles.portal}
      style={{ left, top, width, height, transform: rotation ? `rotate(${rotation}deg)` : undefined, transformOrigin: '0 0' }}
      data-selected={selected || undefined}
      data-testid={`view3d-portal-${id}`}
    >
      {/* The title strip belongs to the board: it selects, moves and double-clicks like any rect. */}
      <div className={styles.portalBar}>
        <span>{t(element.name ?? '3D view')}</span>
        <span className={styles.portalButtons}>
          {isSection && (
            <button type="button" className={styles.portalOpen} aria-label={t('Flip section direction')} title={t('Flip section direction')} onPointerDown={(e) => e.stopPropagation()} onClick={() => void dispatch('flip-section-view', { id })}>
              <FlipHorizontal2 size={12} />
            </button>
          )}
          <button type="button" className={styles.portalOpen} aria-label={t('Lock view as image')} title={t('Lock view as image')} onPointerDown={(e) => e.stopPropagation()} onClick={() => void dispatch('lock-view', { id })}>
            <Camera size={12} />
          </button>
          <button type="button" className={styles.portalOpen} aria-label={t('Open 3D workspace')} title={t('Open full screen')} onPointerDown={(e) => e.stopPropagation()} onClick={open}>
            <Maximize2 size={12} />
          </button>
        </span>
      </div>
      <div ref={containerRef} className={styles.portalCanvas} data-tiny={tiny || undefined} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()} />
    </div>
  );
});

/** Every 3D/section view portal on the board, positioned in screen space over the SVG. */
export function View3DPortals() {
  const ids = useAppStateShallow((s) => Object.values(s.doc.elements).filter((e) => e.kind === 'rect' && e.meta?.['view3d']).map((e) => e.id));
  const workspaceOpen = useAppState((s) => s.ui.view3d.open);
  if (ids.length === 0 || workspaceOpen) return null;
  return (
    <>
      {ids.map((id) => (
        <View3DPortal key={id} id={id} />
      ))}
    </>
  );
}

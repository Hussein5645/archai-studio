/**
 * The material tools of the 3D workspace, where the model is: a bar at the bottom while painting
 * or picking (material in hand, Face / Part / Object / Replace all, Pick, Adjust) and the quick
 * material panel (MaterialAdjust) for the picked material, with a live preview while dragging.
 */
import { Brush, Pipette, SlidersHorizontal, X } from 'lucide-react';
import { useReducer, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useApp, useAppState, useDispatch } from '@/app/context';
import type { ArchaiDocument } from '@/document';
import { elementsUsingMaterial } from '@/commands/builtin/materials';
import { paintTarget, type AssetSlotSource } from '@/materials/paint';
import { materialById } from '@/materials/slots';
import { swatchUrl } from '@/materials/swatch';
import { materialUi, useMaterialUi, type PaintScope } from '@/materials/uiStore';
import { MaterialAdjust, type MaterialPatch } from './MaterialAdjust';
import styles from './SceneMaterialTools.module.css';
import { useI18n } from './i18n';

const SCOPES: { value: PaintScope; label: string; title: string }[] = [
  { value: 'face', label: 'Face', title: 'Paint one face (a wall side, a slab top…)' },
  { value: 'part', label: 'Part', title: 'Paint the whole part (a wall layer, a door leaf, one model material) · Shift+click' },
  { value: 'object', label: 'Object', title: 'Paint every part of the clicked object · Ctrl+click' },
  { value: 'everywhere', label: 'Replace all', title: 'Replace the clicked material everywhere it is used' },
];

export function SceneMaterialTools({ view, onTogglePaint }: { view: AssetSlotSource | null; onTogglePaint: () => void }) {
  const { t } = useI18n();
  const app = useApp();
  const dispatch = useDispatch();
  const doc = useAppState((s) => s.doc);
  const ui = useMaterialUi();
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const base = useRef<ArchaiDocument | null>(null);
  const pending = useRef<MaterialPatch>({});

  const active = ui.active ? materialById(doc, ui.active) : null;
  const adjusting = ui.adjusting ? materialById(doc, ui.adjusting.materialId) : null;
  const swatch = (id: string | null) => {
    const material = id ? materialById(doc, id) : null;
    return material ? swatchUrl(material, doc, redraw) : null;
  };

  const patch = (id: string, change: MaterialPatch, commit: boolean) => {
    pending.current = { ...pending.current, ...change };
    if (!commit) {
      base.current ??= app.store.getState().doc;
      try {
        app.store.setState({ preview: app.executor.preview('update-material', { id, patch: pending.current }, base.current) });
      } catch {
        // an invalid intermediate value keeps the last preview
      }
      return;
    }
    const all = pending.current;
    pending.current = {};
    base.current = null;
    void dispatch('update-material', { id, patch: all }).then((result) => {
      if (result.ok) return;
      app.store.setState({ preview: null });
      app.toasts.push({ kind: 'error', message: result.error.message });
    });
  };

  const makeUnique = async () => {
    const picked = ui.adjusting;
    if (!picked?.target || !adjusting) return;
    const copy = await dispatch('duplicate-material', { id: adjusting.id });
    if (!copy.ok) return;
    const id = copy.value as string;
    await dispatch('update-material', { id, patch: { name: `${adjusting.name} (own)`.slice(0, 80) } });
    paintTarget(app, picked.target, picked.target.surface ? 'face' : 'part', id, view);
    materialUi.set({ active: id, adjusting: { materialId: id, target: picked.target } });
  };

  const context = (() => {
    const target = ui.adjusting?.target;
    if (!target) return undefined;
    const element = doc.elements[target.elementId];
    const where = target.surface ?? target.slot?.replace(/^asset:/, '') ?? '';
    return [element?.name ?? element?.kind, where].filter(Boolean).join(' · ');
  })();

  // Above the board's floating panels (the 3D workspace is layered below them).
  return createPortal(
    <>
      {(ui.painting || ui.picking) && (
        <div className={styles.bar} role="toolbar" aria-label={t('Material tools')} data-testid="scene-material-bar">
          <button type="button" className={styles.hand} onClick={() => void dispatch('show-materials')} title={t('The material in hand: click to choose another in the Materials panel')}>
            <span className={styles.swatch} style={active ? { backgroundImage: swatch(active.id) ? `url(${swatch(active.id)})` : undefined, backgroundColor: active.color } : undefined} />
            <span>{active ? active.name : t('Pick a material')}</span>
          </button>
          <span className={styles.divider} />
          <button type="button" data-active={ui.painting || undefined} onClick={onTogglePaint} title={t('Paint (B)')}>
            <Brush size={14} /> {t('Paint')}
          </button>
          {ui.painting && (
            <span className={styles.scopes} role="radiogroup" aria-label={t('Paint')}>
              {SCOPES.map((item) => (
                <button key={item.value} type="button" role="radio" aria-checked={ui.scope === item.value} data-active={ui.scope === item.value || undefined} onClick={() => materialUi.set({ scope: item.value })} title={t(item.title)} data-testid={`paint-scope-${item.value}`}>
                  {t(item.label)}
                </button>
              ))}
            </span>
          )}
          <span className={styles.divider} />
          <button type="button" data-active={ui.picking || undefined} onClick={() => materialUi.set({ picking: !ui.picking, painting: false })} title={t('Pick a material from the model to adjust it (I) · Alt+click while painting')} data-testid="pick-material">
            <Pipette size={14} /> {t('Pick')}
          </button>
          <button type="button" data-active={Boolean(ui.adjusting) || undefined} disabled={!active} onClick={() => active && materialUi.set({ adjusting: ui.adjusting ? null : { materialId: active.id, target: null } })} title={t('Adjust the material in hand: scale, rotation, colour…')}>
            <SlidersHorizontal size={14} /> {t('Adjust')}
          </button>
          <button type="button" className={styles.close} onClick={() => materialUi.set({ painting: false, picking: false })} aria-label={t('Stop')} title={t('Stop (Esc)')}>
            <X size={14} />
          </button>
        </div>
      )}
      {adjusting && ui.adjusting && (
        <div className={styles.adjust}>
          <MaterialAdjust
            material={adjusting}
            swatch={swatch(adjusting.id)}
            users={elementsUsingMaterial(doc, adjusting.id).length}
            context={context}
            onPatch={(change, commit) => patch(adjusting.id, change, commit)}
            onMakeUnique={ui.adjusting.target ? () => void makeUnique() : undefined}
            onMore={() => materialUi.set({ editing: adjusting.id })}
            onClose={() => materialUi.set({ adjusting: null })}
          />
        </div>
      )}
    </>,
    document.body,
  );
}

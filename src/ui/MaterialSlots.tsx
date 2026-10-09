/**
 * Inspector section "Materials" for one selected element: a picker per slot (with where its
 * material comes from: element, type or default), and the painted surfaces with their zones.
 */
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useAppState, useDispatch } from '@/app/context';
import type { Element, Material, SurfacePaint } from '@/document';
import { DEFAULT_MATERIAL_IDS } from '@/materials/builtin';
import { instanceMaterialsOf, materialById, slotsOf, SURFACE_LABELS, surfacePaintOf, surfacesOf, typeMaterialsOf, ZONED_SURFACES, type SurfaceKey } from '@/materials/slots';
import { materialUi, useMaterialUi } from '@/materials/uiStore';
import { modelStore } from '@/view3d/assets';
import { assetMaterialNames } from '@/view3d/geometry';
import { meshOf, meshStore } from '@/view3d/meshes';
import { Menu, NumberField, type MenuContent } from './primitives';
import { Swatch } from './MaterialsLibrary';
import styles from './MaterialSlots.module.css';
import { useI18n } from './i18n';

type Pick = { x: number; y: number; onPick: (id: string) => void; extra?: MenuContent };

function pickerEntries(materials: Material[], defaults: Material[], onPick: (id: string) => void): MenuContent {
  const entries: MenuContent = [];
  if (materials.length) entries.push({ title: 'Project' }, ...materials.map((material) => ({ id: material.id, label: material.name, icon: <Swatch material={material} size="small" />, onSelect: () => onPick(material.id) })));
  entries.push({ title: 'Defaults' }, ...defaults.map((material) => ({ id: material.id, label: material.name, icon: <Swatch material={material} size="small" />, onSelect: () => onPick(material.id) })));
  return entries;
}

export function MaterialSlots({ element }: { element: Element }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const doc = useAppState((s) => s.doc);
  const unit = useAppState((s) => s.doc.workspace.unit);
  const { active } = useMaterialUi();
  const [pick, setPick] = useState<Pick | null>(null);
  const mesh = meshOf(element);
  const assetSlots = element.kind === 'instance' ? assetMaterialNames(modelStore.models.get(element.definitionId)) : mesh ? assetMaterialNames(meshStore.models.get(mesh.blobId)) : [];
  const slots = slotsOf(element, assetSlots);
  const surfaces = surfacesOf(element);
  if (slots.length === 0 && surfaces.length === 0) return null;
  const own = instanceMaterialsOf(element);
  const typed = typeMaterialsOf(element);
  const paints = surfacePaintOf(element);
  const library = Object.values(doc.materials).filter((material) => !DEFAULT_MATERIAL_IDS.includes(material.id));
  const defaults = DEFAULT_MATERIAL_IDS.map((id) => materialById(doc, id)).filter((material): material is Material => material !== null);
  const inHand = active ? materialById(doc, active) : null;
  const open = (event: React.MouseEvent, onPick: (id: string) => void, extra: MenuContent = []) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setPick({ x: rect.left, y: rect.bottom + 4, onPick, extra });
  };
  const assign = (input: Record<string, unknown>) => void dispatch('assign-material', { ids: [element.id], ...input });
  const setPaints = (surface: SurfaceKey, next: SurfacePaint[]) => void dispatch('set-surface-paint', { id: element.id, surface, paints: next });

  return (
    <div className={styles.section} data-testid="material-slots">
      {slots.map((slot) => {
        const id = own[slot.key] ?? typed[slot.key] ?? slot.fallback;
        const material = id ? materialById(doc, id) : null;
        const origin = own[slot.key] ? 'Element' : typed[slot.key] ? 'Type' : 'Default';
        return (
          <div key={slot.key} className={styles.row}>
            <span className={styles.label} title={slot.label}>{slot.label}</span>
            <button
              type="button"
              className={styles.picker}
              onClick={(event) =>
                open(event, (materialId) => assign({ slot: slot.key, materialId }), [
                  ...(inHand ? [{ id: 'in-hand', label: `${t('In hand')}: ${inHand.name}`, icon: <Swatch material={inHand} size="small" />, onSelect: () => assign({ slot: slot.key, materialId: inHand.id }) }, { separator: true } as const] : []),
                  ...(material && archTyped(element) ? [{ id: 'type', label: t('Use for the type (presets keep it)'), onSelect: () => assign({ slot: slot.key, materialId: material.id, scope: 'type' }) }] : []),
                  ...(own[slot.key] ? [{ id: 'reset', label: t('Reset to type / default'), onSelect: () => assign({ slot: slot.key, materialId: null }) }] : []),
                  ...(typed[slot.key] && !own[slot.key] ? [{ id: 'reset-type', label: t('Clear type material'), onSelect: () => assign({ slot: slot.key, materialId: null, scope: 'type' }) }] : []),
                  { separator: true } as const,
                ])
              }
              aria-label={`${t('Material of')} ${slot.label}`}
            >
              {material ? <Swatch material={material} size="small" /> : <span className={styles.none} />}
              <span className={styles.name}>{material?.name ?? t('Model material')}</span>
              <span className={styles.origin} data-origin={origin}>{t(origin)}</span>
            </button>
            {material && (
              <button type="button" className={styles.icon} title={t('Edit material')} onClick={() => materialUi.set({ editing: material.id })}>
                ✎
              </button>
            )}
          </div>
        );
      })}
      {surfaces.length > 0 && <div className={styles.subhead}>{t('Painted surfaces')}</div>}
      {surfaces.map((surface) => {
        const list = paints[surface] ?? [];
        const zoned = ZONED_SURFACES.includes(surface);
        return (
          <div key={surface} className={styles.surface}>
            <div className={styles.row}>
              <span className={styles.label}>{t(SURFACE_LABELS[surface])}</span>
              <button type="button" className={styles.picker} onClick={(event) => open(event, (materialId) => assign({ surface, materialId }), inHand ? [{ id: 'in-hand', label: `${t('In hand')}: ${inHand.name}`, icon: <Swatch material={inHand} size="small" />, onSelect: () => assign({ surface, materialId: inHand.id }) }, { separator: true }] : [])} aria-label={`${t('Paint')} ${t(SURFACE_LABELS[surface])}`}>
                {list.length ? <Swatch material={materialById(doc, list.at(-1)!.material) ?? defaults[0]!} size="small" /> : <span className={styles.none} />}
                <span className={styles.name}>{list.length ? `${list.length} ${t(list.length === 1 ? 'paint' : 'paints')}` : t('Not painted')}</span>
              </button>
              {zoned && (
                <button type="button" className={styles.icon} title={t('Add a zone (e.g. tiles up to 1200 mm)')} onClick={(event) => open(event, (materialId) => setPaints(surface, [...list, { material: materialId, zone: { v: [0, 1200] } }]))}>
                  <Plus size={12} />
                </button>
              )}
              {list.length > 0 && (
                <button type="button" className={styles.icon} title={t('Clear the surface')} onClick={() => setPaints(surface, [])}>
                  <X size={12} />
                </button>
              )}
            </div>
            {list.map((paint, index) => {
              const material = materialById(doc, paint.material);
              const update = (next: SurfacePaint) => setPaints(surface, list.map((entry, i) => (i === index ? next : entry)));
              return (
                <div key={index} className={styles.paint}>
                  {material && <Swatch material={material} size="small" />}
                  <span className={styles.name}>{material?.name ?? paint.material}</span>
                  {paint.zone ? (
                    <span className={styles.zone}>
                      <span title={t('From height')}>↥</span>
                      <NumberField value={paint.zone.v?.[0] ?? 0} unit={unit} onCommit={(from) => update({ ...paint, zone: { ...paint.zone, v: [from, paint.zone?.v?.[1] ?? 1200] } })} ariaLabel="Zone from height" />
                      <NumberField value={paint.zone.v?.[1] ?? 1200} unit={unit} onCommit={(to) => update({ ...paint, zone: { ...paint.zone, v: [paint.zone?.v?.[0] ?? 0, to] } })} ariaLabel="Zone to height" />
                      <span title={t('Along the wall (empty: all of it)')}>↔</span>
                      <NumberField value={paint.zone.u?.[0] ?? 0} unit={unit} onCommit={(from) => update({ ...paint, zone: { ...paint.zone, u: [from, paint.zone?.u?.[1] ?? from + 1000] } })} ariaLabel="Zone from along" />
                      <NumberField value={paint.zone.u?.[1] ?? 1_000_000} unit={unit} onCommit={(to) => update({ ...paint, zone: { ...paint.zone, u: [paint.zone?.u?.[0] ?? 0, to] } })} ariaLabel="Zone to along" />
                    </span>
                  ) : (
                    <span className={styles.whole}>{t('Whole surface')}</span>
                  )}
                  <button type="button" className={styles.icon} title={t('Remove')} onClick={() => setPaints(surface, list.filter((_, i) => i !== index))}>
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        );
      })}
      {pick && <Menu position={{ x: pick.x, y: pick.y }} entries={[...(pick.extra ?? []), ...pickerEntries(library, defaults, pick.onPick)]} onClose={() => setPick(null)} ariaLabel="Materials" />}
    </div>
  );
}

function archTyped(element: Element): boolean {
  const arch = element.meta?.['arch'];
  return Boolean(arch && typeof arch === 'object' && !Array.isArray(arch) && typeof arch['type'] === 'string');
}

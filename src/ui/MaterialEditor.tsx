/**
 * The material editor (docs/materials.md §5): a live preview and every property of one library
 * material: colour and finish, texture (procedural pattern or image maps), real-world mapping,
 * glass, emission and the cut hatch used in sections. Each change is one undoable edit.
 */
import { Copy, Shuffle, Trash2, Upload, X } from 'lucide-react';
import { useState } from 'react';
import { useApp, useAppState, useDispatch } from '@/app/context';
import { MATERIAL_CATEGORIES, MATERIAL_HATCHES, PATTERN_KINDS, PatternSchema, type Material, type MaterialPattern } from '@/document';
import { isDefaultMaterialId } from '@/materials/builtin';
import { materialById } from '@/materials/slots';
import { materialUi, useMaterialUi } from '@/materials/uiStore';
import { elementsUsingMaterial } from '@/commands/builtin/materials';
import { bytesToBase64 } from '@/persistence/base64';
import { ColorField, Field, FieldRow, NumberField, Segmented, SelectField, TextField } from './primitives';
import { MaterialPreview, type PreviewShape } from './MaterialPreview';
import styles from './MaterialEditor.module.css';
import { useI18n } from './i18n';

type Channel = 'map' | 'normalMap' | 'roughnessMap' | 'metalnessMap' | 'aoMap';

const LAYOUTS: Record<MaterialPattern['kind'], MaterialPattern['layout'][]> = {
  brick: ['stretcher', 'stack', 'flemish', 'herringbone'],
  tiles: ['grid', 'offset', 'hexagon'],
  planks: ['random', 'offset'],
  stone: ['random'],
  stripes: ['grid'],
};

const PATTERN_DEFAULTS: Record<MaterialPattern['kind'], Partial<MaterialPattern>> = {
  brick: { unitWidth: 215, unitHeight: 65, joint: 10, layout: 'stretcher' },
  tiles: { unitWidth: 300, unitHeight: 300, joint: 3, layout: 'grid' },
  planks: { unitWidth: 1800, unitHeight: 180, joint: 2, layout: 'random' },
  stone: { unitWidth: 500, unitHeight: 500, joint: 12, layout: 'random' },
  stripes: { unitWidth: 120, unitHeight: 1000, joint: 12, layout: 'grid' },
};

async function readImage(file: { name: string; mime: string; bytes: Uint8Array }) {
  let width = 0;
  let height = 0;
  try {
    const bitmap = await createImageBitmap(new Blob([file.bytes as BlobPart], { type: file.mime }));
    width = bitmap.width;
    height = bitmap.height;
    bitmap.close();
  } catch {
    // keep 0 × 0: the texture still loads
  }
  return { mime: file.mime, data: bytesToBase64(file.bytes), width, height };
}

export function MaterialEditor() {
  const { editing } = useMaterialUi();
  const doc = useAppState((s) => s.doc);
  const material = editing ? materialById(doc, editing) : null;
  if (!editing || !material) return null;
  return <Editor material={material} />;
}

function Editor({ material }: { material: Material }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const { platform } = useApp();
  const doc = useAppState((s) => s.doc);
  const unit = useAppState((s) => s.doc.workspace.unit);
  const [shape, setShape] = useState<PreviewShape>('sphere');
  const close = () => materialUi.set({ editing: null });
  const patch = (fields: Record<string, unknown>) => void dispatch('update-material', { id: material.id, patch: fields });
  const isDefault = isDefaultMaterialId(material.id);
  const users = elementsUsingMaterial(doc, material.id).length;

  const pattern = material.map && 'pattern' in material.map ? material.map.pattern : null;
  const source: 'none' | 'pattern' | 'image' = pattern ? 'pattern' : material.map ? 'image' : 'none';
  const setPattern = (fields: Partial<MaterialPattern>) => {
    const parsed = PatternSchema.safeParse({ ...(pattern ?? {}), ...fields });
    if (parsed.success) patch({ map: { pattern: parsed.data } });
  };
  const upload = async (channel: Channel) => {
    const file = await platform.files.openImage();
    if (!file) return;
    await dispatch('set-material-texture', { id: material.id, channel, blob: await readImage(file) });
  };
  const imageRow = (channel: Channel, label: string) => {
    const ref = material[channel];
    const hasImage = Boolean(ref && 'blobId' in ref);
    return (
      <div className={styles.mapRow} key={channel}>
        <span>{t(label)}</span>
        <button type="button" onClick={() => void upload(channel)}>
          <Upload size={12} /> {t(hasImage ? 'Replace' : 'Upload')}
        </button>
        {ref && (
          <button type="button" aria-label={t(`Remove ${label}`)} onClick={() => patch({ [channel]: null })}>
            <X size={12} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className={styles.backdrop} data-ui-scale onPointerDown={(event) => event.target === event.currentTarget && close()}>
      <section className={styles.dialog} role="dialog" aria-label={t('Material')} data-testid="material-editor" onKeyDown={(event) => event.key === 'Escape' && close()}>
        <header className={styles.header}>
          <TextField value={material.name} onCommit={(name) => name.trim() && patch({ name })} ariaLabel="Material name" />
          {isDefault && <span className={styles.badge}>{t('Default')}</span>}
          <button type="button" className={styles.close} onClick={close} aria-label={t('Close')}>
            <X size={16} />
          </button>
        </header>
        <div className={styles.body}>
          <div className={styles.previewColumn}>
            <div className={styles.preview}>
              <MaterialPreview material={material} doc={doc} shape={shape} />
            </div>
            <Segmented value={shape} onChange={setShape} options={[{ value: 'sphere', label: 'Sphere' }, { value: 'cube', label: 'Cube' }, { value: 'wall', label: 'Wall' }]} ariaLabel="Preview shape" />
            <p className={styles.note}>{t(users ? `Used by ${users} element(s).` : 'Not used yet.')} {t('Drag the preview to turn it.')}</p>
          </div>
          <div className={styles.fields}>
            <h4>{t('Base')}</h4>
            <FieldRow>
              <Field label="Colour"><ColorField value={material.color} onCommit={(color) => color && patch({ color: color.slice(0, 7) })} ariaLabel="Colour" /></Field>
              <Field label="Category"><SelectField value={material.category} options={MATERIAL_CATEGORIES.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))} onChange={(category) => patch({ category })} ariaLabel="Category" /></Field>
            </FieldRow>
            <FieldRow>
              <Field label="Roughness"><NumberField value={material.roughness} precision={2} min={0} max={1} step={0.05} onCommit={(roughness) => patch({ roughness })} ariaLabel="Roughness" /></Field>
              <Field label="Metalness"><NumberField value={material.metalness} precision={2} min={0} max={1} step={0.05} onCommit={(metalness) => patch({ metalness })} ariaLabel="Metalness" /></Field>
            </FieldRow>
            <FieldRow>
              <Field label="Opacity"><NumberField value={material.opacity} precision={2} min={0} max={1} step={0.05} onCommit={(opacity) => patch({ opacity })} ariaLabel="Opacity" /></Field>
              <Field label="Clearcoat"><NumberField value={material.clearcoat} precision={2} min={0} max={1} step={0.05} onCommit={(clearcoat) => patch({ clearcoat })} ariaLabel="Clearcoat" /></Field>
            </FieldRow>

            <h4>{t('Texture')}</h4>
            <Segmented
              value={source}
              onChange={(next) => {
                if (next === 'none') patch({ map: null, normalMap: null, roughnessMap: null });
                else if (next === 'pattern') setPattern({ kind: 'brick', ...PATTERN_DEFAULTS.brick });
                else void upload('map');
              }}
              options={[{ value: 'none', label: 'Plain' }, { value: 'pattern', label: 'Pattern' }, { value: 'image', label: 'Image' }]}
              ariaLabel="Texture source"
            />
            {pattern && (
              <>
                <FieldRow>
                  <Field label="Pattern"><SelectField value={pattern.kind} options={PATTERN_KINDS.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))} onChange={(kind) => setPattern({ kind, ...PATTERN_DEFAULTS[kind] })} ariaLabel="Pattern" /></Field>
                  <Field label="Layout"><SelectField value={LAYOUTS[pattern.kind].includes(pattern.layout) ? pattern.layout : LAYOUTS[pattern.kind][0]!} options={LAYOUTS[pattern.kind].map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))} onChange={(layout) => setPattern({ layout })} ariaLabel="Layout" /></Field>
                </FieldRow>
                <FieldRow>
                  <Field label="Unit length"><NumberField value={pattern.unitWidth} unit={unit} min={1} onCommit={(unitWidth) => setPattern({ unitWidth })} ariaLabel="Unit length" /></Field>
                  <Field label="Unit height"><NumberField value={pattern.unitHeight} unit={unit} min={1} onCommit={(unitHeight) => setPattern({ unitHeight })} ariaLabel="Unit height" /></Field>
                </FieldRow>
                <FieldRow>
                  <Field label="Joint"><NumberField value={pattern.joint} unit={unit} min={0} onCommit={(joint) => setPattern({ joint })} ariaLabel="Joint" /></Field>
                  <Field label="Joint colour"><ColorField value={pattern.jointColor} onCommit={(jointColor) => jointColor && setPattern({ jointColor: jointColor.slice(0, 7) })} ariaLabel="Joint colour" /></Field>
                </FieldRow>
                <FieldRow>
                  <Field label="Variation"><NumberField value={pattern.variation} precision={2} min={0} max={1} step={0.05} onCommit={(variation) => setPattern({ variation })} ariaLabel="Variation" /></Field>
                  <Field label="Accent"><ColorField value={pattern.accent} onCommit={(accent) => accent && setPattern({ accent: accent.slice(0, 7) })} ariaLabel="Accent colour" /></Field>
                </FieldRow>
                <FieldRow>
                  <Field label="Relief"><NumberField value={pattern.relief} precision={2} min={0} max={1} step={0.05} onCommit={(relief) => setPattern({ relief })} ariaLabel="Relief" /></Field>
                  <Field label="Variant">
                    <button type="button" className={styles.inline} onClick={() => setPattern({ seed: (pattern.seed * 7919 + 13) % 1_000_000 })}>
                      <Shuffle size={12} /> {t('Shuffle')}
                    </button>
                  </Field>
                </FieldRow>
              </>
            )}
            {source !== 'pattern' && (
              <div className={styles.maps}>
                {imageRow('map', 'Colour image')}
                {imageRow('normalMap', 'Normal map')}
                {imageRow('roughnessMap', 'Roughness map')}
                {imageRow('metalnessMap', 'Metalness map')}
                {imageRow('aoMap', 'Ambient occlusion')}
              </div>
            )}
            {source !== 'none' && (
              <FieldRow>
                <Field label="Normal strength"><NumberField value={material.normalStrength} precision={2} min={0} max={4} step={0.1} onCommit={(normalStrength) => patch({ normalStrength })} ariaLabel="Normal strength" /></Field>
                <Field label="Rotation"><NumberField value={material.rotation} suffix="°" precision={0} onCommit={(rotation) => patch({ rotation })} ariaLabel="Texture rotation" /></Field>
              </FieldRow>
            )}
            {source === 'image' && (
              <FieldRow>
                <Field label="Tile width"><NumberField value={material.tileWidth} unit={unit} min={1} onCommit={(tileWidth) => patch({ tileWidth })} ariaLabel="Tile width" /></Field>
                <Field label="Tile height"><NumberField value={material.tileHeight} unit={unit} min={1} onCommit={(tileHeight) => patch({ tileHeight })} ariaLabel="Tile height" /></Field>
              </FieldRow>
            )}
            {source !== 'none' && (
              <FieldRow>
                <Field label="Offset along"><NumberField value={material.offsetX} unit={unit} onCommit={(offsetX) => patch({ offsetX })} ariaLabel="Texture offset along" /></Field>
                <Field label="Offset up"><NumberField value={material.offsetY} unit={unit} onCommit={(offsetY) => patch({ offsetY })} ariaLabel="Texture offset up" /></Field>
              </FieldRow>
            )}

            <h4>{t('Glass and light')}</h4>
            <FieldRow>
              <Field label="Transmission"><NumberField value={material.transmission} precision={2} min={0} max={1} step={0.05} onCommit={(transmission) => patch({ transmission })} ariaLabel="Transmission" /></Field>
              <Field label="Refraction (IOR)"><NumberField value={material.ior} precision={2} min={1} max={2.5} step={0.05} onCommit={(ior) => patch({ ior })} ariaLabel="Index of refraction" /></Field>
            </FieldRow>
            <FieldRow>
              <Field label="Glow colour"><ColorField value={material.emissive} onCommit={(emissive) => emissive && patch({ emissive: emissive.slice(0, 7) })} ariaLabel="Glow colour" /></Field>
              <Field label="Glow strength"><NumberField value={material.emissiveIntensity} precision={1} min={0} max={20} step={0.5} onCommit={(emissiveIntensity) => patch({ emissiveIntensity })} ariaLabel="Glow strength" /></Field>
            </FieldRow>

            <h4>{t('Cut (sections and plans)')}</h4>
            <FieldRow>
              <Field label="Hatch"><SelectField value={material.cutHatch ?? 'type'} options={[{ value: 'type', label: 'By element type' }, ...MATERIAL_HATCHES.map((value) => ({ value, label: value === 'none' ? 'Solid fill' : value[0]!.toUpperCase() + value.slice(1) }))]} onChange={(value) => patch({ cutHatch: value === 'type' ? null : value })} ariaLabel="Cut hatch" /></Field>
              <Field label="Fill"><ColorField value={material.cutColor} onCommit={(cutColor) => cutColor && patch({ cutColor: cutColor.slice(0, 7) })} ariaLabel="Cut fill" /></Field>
            </FieldRow>
            {material.cutHatch && material.cutHatch !== 'none' && (
              <FieldRow>
                <Field label="Hatch colour"><ColorField value={material.cutHatchColor} onCommit={(cutHatchColor) => cutHatchColor && patch({ cutHatchColor: cutHatchColor.slice(0, 7) })} ariaLabel="Hatch colour" /></Field>
                <Field label="Spacing"><NumberField value={material.cutHatchSpacing} unit={unit} min={1} onCommit={(cutHatchSpacing) => patch({ cutHatchSpacing })} ariaLabel="Hatch spacing" /></Field>
              </FieldRow>
            )}
          </div>
        </div>
        <footer className={styles.footer}>
          <button type="button" onClick={() => void dispatch('duplicate-material', { id: material.id }).then((result) => result.ok && materialUi.set({ editing: result.value as string, active: result.value as string }))}>
            <Copy size={13} /> {t('Duplicate')}
          </button>
          {isDefault ? (
            doc.materials[material.id] && <button type="button" onClick={() => void dispatch('delete-material', { id: material.id })}>{t('Reset to default')}</button>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (users > 0 && !window.confirm(t(`${material.name} is used by ${users} element(s). Delete it and return them to their defaults?`))) return;
                void dispatch('delete-material', { id: material.id }).then((result) => result.ok && materialUi.set({ editing: null, active: null }));
              }}
            >
              <Trash2 size={13} /> {t('Delete')}
            </button>
          )}
          <button type="button" className={styles.done} onClick={close}>{t('Done')}</button>
        </footer>
      </section>
    </div>
  );
}

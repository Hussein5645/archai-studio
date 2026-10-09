/**
 * Inspector sections for sheet items: view frames (title, number, scale, source), title blocks,
 * scale bars and north arrows.
 */
import { useAppState, useDispatch } from '@/app/context';
import type { Element } from '@/document';
import { boardDoc } from '@/store';
import { Divider, Field, FieldRow, NumberField, SelectField, TextButton, TextField, ToggleRow } from '@/ui/primitives';
import styles from '@/ui/Inspector.module.css';
import { useI18n } from '@/ui/i18n';
import { ViewStyling } from './ViewStyling';
import { DRAWING_SCALES, northArrowOf, scaleBarOf, sheetSources, sheetViewOf, titleBlockOf } from './model';

const SCALE_OPTIONS = DRAWING_SCALES.map((scale) => ({ value: String(scale), label: `1:${scale}` }));

export function SheetItemInspector({ element }: { element: Element }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const doc = useAppState((s) => boardDoc(s));
  const view = sheetViewOf(element);
  const block = titleBlockOf(element);
  const bar = scaleBarOf(element);
  const north = northArrowOf(element);
  if (view) {
    const source = view.sourceId ? sheetSources(doc).find((candidate) => candidate.id === view.sourceId) : null;
    const scaleOptions = DRAWING_SCALES.includes(view.scale) ? SCALE_OPTIONS : [...SCALE_OPTIONS, { value: String(view.scale), label: `1:${view.scale}` }];
    return (
      <>
        <Divider />
        <div className={styles.section} data-testid="sheet-view-section">
          <h3 className="u-section-title">{t('View on sheet')}</h3>
          <FieldRow>
            <Field label="No.">
              <TextField value={view.number} onCommit={(number) => void dispatch('set-sheet-view', { id: element.id, number })} ariaLabel="View number" />
            </Field>
            <Field label="Scale">
              <SelectField value={String(view.scale)} options={scaleOptions} onChange={(scale) => void dispatch('set-sheet-view', { id: element.id, scale: Number(scale) })} ariaLabel="View scale" />
            </Field>
          </FieldRow>
          <FieldRow single>
            <Field label="Title">
              <TextField value={view.title} onCommit={(title) => void dispatch('set-sheet-view', { id: element.id, title })} ariaLabel="View title" />
            </Field>
          </FieldRow>
          <ToggleRow label="Show title" value={view.showTitle} onChange={(showTitle) => void dispatch('set-sheet-view', { id: element.id, showTitle })} />
          <p className={styles.hint}>
            {source ? `${t('Shows')} ${source.name}` : view.source === 'board' ? t('Shows a board area') : t('The source view was deleted')}
            {view.source !== 'view' ? ` · ${t('vector')}` : ` · ${t('rendered at export resolution')}`}
          </p>
          {source && (
            <div className={styles.actions}>
              <TextButton onClick={() => void dispatch('set-sheet-view', { id: element.id, crop: source.crop })}>{t('Reset crop to source')}</TextButton>
            </div>
          )}
        </div>
        <ViewStyling frame={element} view={view} />
      </>
    );
  }
  if (block) {
    const field = (key: keyof typeof block, label: string) => (
      <Field label={label}>
        <TextField value={block[key]} onCommit={(value) => void dispatch('set-title-block', { id: element.id, [key]: value })} ariaLabel={label} />
      </Field>
    );
    return (
      <>
        <Divider />
        <div className={styles.section} data-testid="title-block-section">
          <h3 className="u-section-title">{t('Title block')}</h3>
          <FieldRow single>{field('project', 'Project')}</FieldRow>
          <FieldRow single>{field('client', 'Client')}</FieldRow>
          <FieldRow>
            {field('drawnBy', 'Drawn')}
            {field('checkedBy', 'Checked')}
          </FieldRow>
          <FieldRow>
            {field('date', 'Date')}
            {field('revision', 'Rev')}
          </FieldRow>
          <p className={styles.hint}>{t("Sheet title, number and scale come from the sheet itself.")}</p>
        </div>
      </>
    );
  }
  if (bar) {
    const frames = Object.values(doc.elements).filter((candidate) => candidate.parentId === element.parentId && sheetViewOf(candidate));
    return (
      <>
        <Divider />
        <div className={styles.section} data-testid="scale-bar-section">
          <h3 className="u-section-title">{t('Scale bar')}</h3>
          <FieldRow single>
            <Field label="Follows">
              <SelectField
                value={bar.frameId ?? ''}
                options={[{ value: '', label: 'Sheet scale' }, ...frames.map((frame) => ({ value: frame.id, label: `${sheetViewOf(frame)!.title} (1:${sheetViewOf(frame)!.scale})` }))]}
                onChange={(frameId) => void dispatch('set-scale-bar', { id: element.id, frameId: frameId || null })}
                ariaLabel="Scale bar view"
              />
            </Field>
          </FieldRow>
        </div>
      </>
    );
  }
  if (north) {
    return (
      <>
        <Divider />
        <div className={styles.section} data-testid="north-arrow-section">
          <h3 className="u-section-title">{t('North arrow')}</h3>
          <FieldRow single>
            <Field label="North °">
              <NumberField value={north.rotation} precision={0} onCommit={(rotation) => void dispatch('set-north-arrow', { id: element.id, rotation })} ariaLabel="North rotation" />
            </Field>
          </FieldRow>
        </div>
      </>
    );
  }
  return null;
}

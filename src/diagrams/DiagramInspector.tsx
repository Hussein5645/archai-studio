/** Inspector section for diagram elements, plus the document's diagram theme. */
import { Unlink2 } from 'lucide-react';
import { useAppState, useDispatch } from '@/app/context';
import type { Element } from '@/document';
import { boardDoc } from '@/store';
import { ColorField, Divider, Field, FieldRow, NumberField, Segmented, SelectField, TextButton, ToggleRow } from '@/ui/primitives';
import inspectorStyles from '@/ui/Inspector.module.css';
import { useI18n } from '@/ui/i18n';
import { ARROW_HEADS, DIAGRAM_THEMES, diagramOf, ROUTES, THEMES, type DiagramMeta } from './model';
import styles from './DiagramInspector.module.css';

const HEAD_LABELS: Record<(typeof ARROW_HEADS)[number], string> = { none: 'None', arrow: 'Arrow', open: 'Open', dot: 'Dot', bar: 'Tick' };
const KIND_LABELS: Record<DiagramMeta['kind'], string> = { arrow: 'Arrow', connector: 'Connector', callout: 'Callout', dimension: 'Dimension', adjacency: 'Adjacency', zone: 'Zone', tag: 'Tag' };

export function DiagramInspector({ element }: { element: Element }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const elements = useAppState((s) => boardDoc(s).elements);
  const theme = useAppState((s) => boardDoc(s).workspace.diagramTheme);
  const meta = diagramOf(element);
  if (!meta) return null;
  const patch = (value: Record<string, unknown>) => void dispatch('set-diagram', { ids: [element.id], patch: value });
  const isLine = meta.kind === 'arrow' || meta.kind === 'connector' || meta.kind === 'callout' || meta.kind === 'dimension' || meta.kind === 'adjacency';
  const glued = (id: string | null) => (id && elements[id] ? (elements[id]!.name ?? t('element')) : null);
  const textLabel = meta.kind === 'tag' ? 'Template' : meta.kind === 'callout' ? 'Note' : 'Label';
  return (
    <>
      <Divider />
      <div className={inspectorStyles.section} data-testid="diagram-section">
        <h3 className="u-section-title">{t(KIND_LABELS[meta.kind])}</h3>
        {meta.kind !== 'dimension' && (
          <label className={styles.textRow}>
            <span>{t(textLabel)}</span>
            <textarea
              key={`${element.id}:${meta.text}`}
              defaultValue={meta.text}
              rows={Math.min(4, Math.max(1, meta.text.split('\n').length))}
              onBlur={(event) => event.currentTarget.value !== meta.text && patch({ text: event.currentTarget.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.blur();
                event.stopPropagation();
              }}
              aria-label={t(textLabel)}
              placeholder={meta.kind === 'tag' ? '{name}  {area}  {level}  {type}' : ''}
            />
          </label>
        )}
        {meta.kind === 'tag' && <p className={inspectorStyles.hint}>{t('Placeholders read the tagged element live: {name}, {area}, {level}, {type}.')}</p>}
        <FieldRow>
          <Field label={isLine ? 'Line' : 'Outline'}>
            <ColorField value={meta.color} allowNone onCommit={(color) => patch({ color })} ariaLabel="Diagram colour" />
          </Field>
          {!isLine ? (
            <Field label="Fill">
              <ColorField value={meta.fill} allowNone onCommit={(fill) => patch({ fill })} ariaLabel="Diagram fill" />
            </Field>
          ) : (
            <Field label="Weight">
              <NumberField value={meta.weight ?? THEMES[theme].pen} precision={2} min={0.05} step={0.05} suffix="mm" onCommit={(weight) => patch({ weight })} ariaLabel="Pen weight" />
            </Field>
          )}
        </FieldRow>
        <ToggleRow label="Dashed" value={meta.dashed} onChange={(dashed) => patch({ dashed })} />
        {(meta.kind === 'arrow' || meta.kind === 'connector') && (
          <FieldRow>
            <Field label="End">
              <SelectField value={meta.head} options={ARROW_HEADS.map((head) => ({ value: head, label: HEAD_LABELS[head] }))} onChange={(head) => patch({ head })} ariaLabel="Arrow head" />
            </Field>
            <Field label="Start">
              <SelectField value={meta.tail} options={ARROW_HEADS.map((head) => ({ value: head, label: HEAD_LABELS[head] }))} onChange={(tail) => patch({ tail })} ariaLabel="Arrow tail" />
            </Field>
          </FieldRow>
        )}
        {(meta.kind === 'connector' || meta.kind === 'adjacency') && (
          <>
            <div className={styles.pad}>
              <Segmented value={meta.route} options={ROUTES.filter((route) => meta.kind === 'connector' || route !== 'orthogonal').map((route) => ({ value: route, label: route[0]!.toUpperCase() + route.slice(1) }))} onChange={(route) => patch({ route })} ariaLabel="Route" />
            </div>
            <p className={inspectorStyles.hint}>
              {glued(meta.from) || glued(meta.to) ? `${t('Glued')}: ${glued(meta.from) ?? '—'} → ${glued(meta.to) ?? '—'}` : t('Not glued: draw it from one element to another to glue it.')}
            </p>
            {(meta.from || meta.to) && (
              <div className={inspectorStyles.actions}>
                <TextButton onClick={() => patch({ from: null, to: null })}>
                  <Unlink2 size={13} /> {t('Unglue')}
                </TextButton>
              </div>
            )}
          </>
        )}
        {meta.kind === 'zone' && (
          <>
            <div className={styles.pad}>
              <Segmented value={meta.shape} options={[{ value: 'rounded', label: 'Rounded' }, { value: 'ellipse', label: 'Bubble' }, { value: 'rect', label: 'Box' }]} onChange={(shape) => patch({ shape })} ariaLabel="Zone shape" />
            </div>
            <ToggleRow label="Show area" value={meta.showArea} onChange={(showArea) => patch({ showArea })} />
          </>
        )}
        {meta.kind === 'dimension' && (
          <FieldRow>
            <Field label="Offset">
              <NumberField value={meta.offset} precision={1} step={1} suffix="mm" onCommit={(offset) => patch({ offset })} ariaLabel="Dimension offset" />
            </Field>
            <Field label="Weight">
              <NumberField value={meta.weight ?? THEMES[theme].pen} precision={2} min={0.05} step={0.05} suffix="mm" onCommit={(weight) => patch({ weight })} ariaLabel="Pen weight" />
            </Field>
          </FieldRow>
        )}
      </div>
      <Divider />
      <div className={inspectorStyles.section}>
        <h3 className="u-section-title">{t('Diagram theme')}</h3>
        <FieldRow single>
          <SelectField value={theme} options={DIAGRAM_THEMES.map((id) => ({ value: id, label: THEMES[id].label }))} onChange={(value) => void dispatch('set-diagram-theme', { theme: value })} ariaLabel="Diagram theme" />
        </FieldRow>
        <p className={inspectorStyles.hint}>{t('Colours, pens and text of every diagram element; weights are printed millimetres at the sheet’s scale.')}</p>
      </div>
    </>
  );
}

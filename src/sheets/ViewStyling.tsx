/**
 * Inspector UI for styling a view frame: diagram recipes, whole-view image adjustments and render
 * style, and (inside the view) the picked elements' per-view styles. Every control dispatches a
 * command (see commands/builtin/sheetViews.ts).
 */
import {
  Eye,
  EyeOff,
  Ghost,
  ImageDown,
  MousePointerClick,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { useAppState, useDispatch } from '@/app/context';
import type { Element } from '@/document';
import {
  ColorField,
  Divider,
  Field,
  FieldRow,
  NumberField,
  Segmented,
  SelectField,
  TextButton,
  TextField,
  ToggleRow,
} from '@/ui/primitives';
import inspectorStyles from '@/ui/Inspector.module.css';
import { useI18n } from '@/ui/i18n';
import { FRAME_STYLES, type SheetViewMeta, type ViewOverride } from './model';
import { DIAGRAM_RECIPES, RECIPE_LABELS } from './recipes';
import styles from './ViewStyling.module.css';

function Slider({
  label,
  value,
  min,
  max,
  step,
  onCommit,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (value: number) => void;
  format: (value: number) => string;
}) {
  const { t } = useI18n();
  return (
    <label className={styles.slider}>
      <span>{t(label)}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        defaultValue={value}
        key={value}
        onPointerUp={(event) => onCommit(Number(event.currentTarget.value))}
        onKeyUp={(event) => onCommit(Number(event.currentTarget.value))}
        aria-label={t(label)}
      />
      <output>{format(value)}</output>
    </label>
  );
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

function PickedStyling({
  frame,
  view,
  picked,
}: {
  frame: Element;
  view: SheetViewMeta;
  picked: string[];
}) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const first: ViewOverride = view.overrides[picked[0]!] ?? {};
  const patch = (value: Partial<Record<keyof ViewOverride, unknown>>) =>
    void dispatch('set-view-override', { id: frame.id, elementIds: picked, patch: value });
  const is3d = view.source === 'view';
  return (
    <div className={inspectorStyles.section} data-testid="view-picked-section">
      <div className={styles.pickedHeader}>
        <h3 className="u-section-title">{t(`${picked.length} picked`)}</h3>
        <TextButton onClick={() => void dispatch('select-similar-in-view')}>
          <MousePointerClick size={13} /> {t('Similar')}
        </TextButton>
      </div>
      <div className={styles.pad}>
        <Segmented
          value={first.visibility ?? 'show'}
          options={[
            { value: 'show', label: <Eye size={14} />, title: 'Show' },
            { value: 'ghost', label: <Ghost size={14} />, title: 'Ghost (faint grey)' },
            { value: 'hidden', label: <EyeOff size={14} />, title: 'Hide in this view' },
          ]}
          onChange={(visibility) =>
            patch({ visibility: visibility === 'show' ? null : visibility })
          }
          ariaLabel="Visibility in view"
        />
      </div>
      <FieldRow>
        <Field label="Fill">
          <ColorField
            value={first.fill ?? null}
            allowNone
            onCommit={(fill) => patch({ fill })}
            ariaLabel="Fill in view"
          />
        </Field>
        {!is3d && (
          <Field label="Line">
            <ColorField
              value={first.stroke ?? null}
              allowNone
              onCommit={(stroke) => patch({ stroke })}
              ariaLabel="Line colour in view"
            />
          </Field>
        )}
      </FieldRow>
      <FieldRow>
        {!is3d && (
          <Field label="Weight">
            <NumberField
              value={first.weight ?? 0}
              precision={2}
              min={0}
              step={0.05}
              suffix="mm"
              onCommit={(weight) => patch({ weight: weight > 0 ? weight : null })}
              ariaLabel="Line weight in view"
            />
          </Field>
        )}
        <Field label="Opacity">
          <NumberField
            value={Math.round((first.opacity ?? 1) * 100)}
            precision={0}
            min={0}
            max={100}
            suffix="%"
            onCommit={(value) => patch({ opacity: value >= 100 ? null : value / 100 })}
            ariaLabel="Opacity in view"
          />
        </Field>
      </FieldRow>
      <Field label="Emphasis">
        <Segmented
          value={first.emphasis ?? 'none'}
          options={[
            { value: 'none', label: 'None' },
            { value: 'outline', label: 'Outline' },
            { value: 'glow', label: 'Glow' },
            { value: 'shadow', label: 'Shadow' },
          ]}
          onChange={(emphasis) => patch({ emphasis: emphasis === 'none' ? null : emphasis })}
          ariaLabel="Emphasis"
        />
      </Field>
      {first.emphasis && (
        <FieldRow single>
          <Field label="Accent">
            <ColorField
              value={first.accent ?? null}
              allowNone
              onCommit={(accent) => patch({ accent })}
              ariaLabel="Emphasis colour"
            />
          </Field>
        </FieldRow>
      )}
      <FieldRow>
        <Field label="Label">
          <TextField
            value={first.label ?? ''}
            onCommit={(label) => patch({ label: label || null })}
            ariaLabel="Label in view"
          />
        </Field>
        {is3d && (
          <Field label="Lift">
            <NumberField
              value={first.lift ?? 0}
              precision={0}
              step={500}
              suffix="mm"
              onCommit={(lift) => patch({ lift: lift || null })}
              ariaLabel="Lift in view"
            />
          </Field>
        )}
      </FieldRow>
      <div className={inspectorStyles.actions}>
        <TextButton
          onClick={() => void dispatch('clear-view-override', { id: frame.id, elementIds: picked })}
        >
          <RotateCcw size={13} /> {t('Reset picked')}
        </TextButton>
      </div>
    </div>
  );
}

export function ViewStyling({ frame, view }: { frame: Element; view: SheetViewMeta }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const editing = useAppState((s) =>
    s.ui.sheet?.viewEdit?.frameId === frame.id ? s.ui.sheet.viewEdit : null,
  );
  const sheetOpen = useAppState((s) => s.ui.sheet !== null);
  const a = view.adjustments;
  const adjust = (patch: Record<string, unknown>) =>
    void dispatch('set-view-adjustments', { id: frame.id, patch });
  const styled = Object.keys(view.overrides).length;
  return (
    <>
      <Divider />
      <div className={inspectorStyles.section} data-testid="view-styling-section">
        <h3 className="u-section-title">{t('Diagram')}</h3>
        {sheetOpen && !editing && (
          <div className={inspectorStyles.actions}>
            <TextButton primary onClick={() => void dispatch('enter-sheet-view', { id: frame.id })}>
              <MousePointerClick size={13} /> {t('Style elements…')}
            </TextButton>
          </div>
        )}
        {editing && (
          <div className={styles.editing}>
            <span>
              {editing.picked.length === 0
                ? t('Click elements in the view to pick them · Shift adds · Esc when done')
                : t('Styling the picked elements below')}
            </span>
            <TextButton onClick={() => void dispatch('exit-sheet-view')}>{t('Done')}</TextButton>
          </div>
        )}
        <div className={styles.recipes}>
          {DIAGRAM_RECIPES.filter((recipe) => recipe !== 'exploded' || view.source === 'view').map(
            (recipe) => (
              <button
                key={recipe}
                type="button"
                className={styles.recipe}
                data-recipe={recipe}
                title={t(RECIPE_LABELS[recipe].description)}
                onClick={() => void dispatch('apply-diagram-recipe', { id: frame.id, recipe })}
              >
                {recipe === 'clear' ? <RotateCcw size={13} /> : <Sparkles size={13} />}
                {t(RECIPE_LABELS[recipe].label)}
              </button>
            ),
          )}
        </div>
        {styled > 0 && (
          <p className={inspectorStyles.hint}>
            {t(`${styled} element${styled === 1 ? '' : 's'} styled in this view`)}
          </p>
        )}
      </div>
      {editing && editing.picked.length > 0 && (
        <>
          <Divider />
          <PickedStyling frame={frame} view={view} picked={editing.picked} />
        </>
      )}
      <Divider />
      <div className={inspectorStyles.section} data-testid="view-adjust-section">
        <h3 className="u-section-title">{t('Image')}</h3>
        {view.source === 'view' && (
          <FieldRow single>
            <Field label="Render">
              <SelectField
                value={view.style ?? 'source'}
                options={[
                  { value: 'source', label: 'As source view' },
                  ...FRAME_STYLES.map((style) => ({
                    value: style,
                    label: style.replace('-', ' ').replace(/^\w/, (c) => c.toUpperCase()),
                  })),
                ]}
                onChange={(style) =>
                  void dispatch('set-view-render-style', {
                    id: frame.id,
                    style: style === 'source' ? null : style,
                  })
                }
                ariaLabel="Render style"
              />
            </Field>
          </FieldRow>
        )}
        <Slider
          label="Brightness"
          value={a.brightness}
          min={0.4}
          max={1.6}
          step={0.05}
          format={percent}
          onCommit={(brightness) => adjust({ brightness })}
        />
        <Slider
          label="Contrast"
          value={a.contrast}
          min={0.4}
          max={1.6}
          step={0.05}
          format={percent}
          onCommit={(contrast) => adjust({ contrast })}
        />
        <Slider
          label="Saturation"
          value={a.saturation}
          min={0}
          max={2}
          step={0.05}
          format={percent}
          onCommit={(saturation) => adjust({ saturation })}
        />
        <Slider
          label="Grain"
          value={a.grain}
          min={0}
          max={1}
          step={0.05}
          format={percent}
          onCommit={(grain) => adjust({ grain })}
        />
        <FieldRow>
          <Field label="Tint">
            <ColorField
              value={a.tint}
              allowNone
              onCommit={(tint) => adjust({ tint })}
              ariaLabel="Tint colour"
            />
          </Field>
          <Field label="Background">
            <ColorField
              value={a.background}
              allowNone
              onCommit={(background) => adjust({ background })}
              ariaLabel="View background"
            />
          </Field>
        </FieldRow>
        {a.tint && (
          <Slider
            label="Tint amount"
            value={a.tintAmount}
            min={0}
            max={1}
            step={0.05}
            format={percent}
            onCommit={(tintAmount) => adjust({ tintAmount })}
          />
        )}
        <ToggleRow
          label="Fade everything not styled"
          value={a.fadeOthers}
          onChange={(fadeOthers) => adjust({ fadeOthers })}
        />
        <div className={inspectorStyles.actions}>
          <TextButton
            onClick={() =>
              adjust({
                brightness: 1,
                contrast: 1,
                saturation: 1,
                tint: null,
                tintAmount: 0.35,
                background: null,
                grain: 0,
                fadeOthers: false,
              })
            }
          >
            <RotateCcw size={13} /> {t('Reset image')}
          </TextButton>
          <TextButton
            onClick={() => void dispatch('flatten-sheet-view', { id: frame.id })}
            title={t('Replace the view with a plain image of it (300 dpi)')}
          >
            <ImageDown size={13} /> {t('Flatten')}
          </TextButton>
        </div>
      </div>
    </>
  );
}

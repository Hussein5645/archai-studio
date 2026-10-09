/**
 * The options bar of the board annotation tools (see src/annotations): quick tool switch, pen and
 * highlighter colour and size, pressure, sticky note colour and the annotation layer new marks go
 * into. With sticky notes selected it recolours them. Everything goes through commands.
 */
import { Eraser, Highlighter, Layers, PenLine, Plus, StickyNote } from 'lucide-react';
import { useMemo } from 'react';
import { useAppState, useDispatch } from '@/app/context';
import { annotationLayers, HIGHLIGHTER_COLORS, PEN_COLORS, PEN_SIZES, STICKY_COLORS, stickyOf } from '@/annotations/model';
import type { AnnotationOptions } from '@/store';
import { IconButton } from './primitives';
import styles from './Toolbar.module.css';
import { useI18n } from './i18n';

const HIGHLIGHTER_SIZES = [12, 24, 40] as const;

export const ANNOTATE_TOOLS = [
  { tool: 'annotate:pen', command: 'tool-annotate-pen', label: 'Sketch pen', shortcut: 'Shift+B', icon: (s: number) => <PenLine size={s} /> },
  { tool: 'annotate:highlighter', command: 'tool-annotate-highlighter', label: 'Highlighter', shortcut: undefined, icon: (s: number) => <Highlighter size={s} /> },
  { tool: 'annotate:eraser', command: 'tool-annotate-eraser', label: 'Eraser', shortcut: 'Shift+E', icon: (s: number) => <Eraser size={s} /> },
  { tool: 'annotate:sticky', command: 'tool-annotate-sticky', label: 'Sticky note', shortcut: 'Shift+T', icon: (s: number) => <StickyNote size={s} /> },
] as const;

function Swatches({ colors, value, onPick, label }: { colors: readonly string[]; value: string | null; onPick: (color: string) => void; label: string }) {
  const { t } = useI18n();
  return (
    <div className={styles.swatches} role="radiogroup" aria-label={t(label)}>
      {colors.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={color}
          title={color}
          className={styles.swatch}
          data-active={value === color || undefined}
          style={{ background: color }}
          onClick={() => onPick(color)}
        />
      ))}
    </div>
  );
}

function Sizes({ sizes, value, color, onPick }: { sizes: readonly number[]; value: number; color: string; onPick: (size: number) => void }) {
  const { t } = useI18n();
  return (
    <div className={styles.swatches} role="radiogroup" aria-label={t('Size')}>
      {sizes.map((size) => (
        <button key={size} type="button" role="radio" aria-checked={value === size} aria-label={`${size}px`} title={`${size}px`} className={styles.sizeDot} data-active={value === size || undefined} onClick={() => onPick(size)}>
          <span style={{ width: Math.min(18, Math.max(3, size * 0.75)), height: Math.min(18, Math.max(3, size * 0.75)), background: color }} />
        </button>
      ))}
    </div>
  );
}

export function AnnotationBar() {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const tool = useAppState((s) => s.ui.tool);
  const options = useAppState((s) => s.ui.annotation);
  const elements = useAppState((s) => s.doc.elements);
  const selection = useAppState((s) => s.ui.selection);
  const layers = useMemo(() => annotationLayers(elements), [elements]);
  const selectedStickies = useMemo(() => selection.filter((id) => stickyOf(elements[id])), [elements, selection]);
  const set = (patch: Partial<AnnotationOptions>) => void dispatch('set-annotation-options', patch);

  const annotating = tool.startsWith('annotate:');
  // One note at a time: a multi-selection shows the arrange bar in this spot (DraftingBar).
  const recolouring = tool === 'select' && selection.length === 1 && selectedStickies.length === 1;
  if (!annotating && !recolouring) return null;

  if (recolouring) {
    const current = stickyOf(elements[selectedStickies[0]!])?.color ?? null;
    return (
      <div className={styles.optionsBar} role="toolbar" data-ui-scale aria-label={t('Sticky note')} data-testid="annotation-bar">
        <StickyNote size={16} aria-hidden />
        <Swatches colors={STICKY_COLORS} value={current} label="Note colour" onPick={(color) => void dispatch('set-sticky', { ids: selectedStickies, color })} />
      </div>
    );
  }

  const activeLayer = layers.find((layer) => layer.id === options.layerId) ?? layers.at(-1);
  return (
    <div className={styles.optionsBar} role="toolbar" data-ui-scale aria-label={t('Annotate')} data-testid="annotation-bar">
      <div className={styles.swatches}>
        {ANNOTATE_TOOLS.map((entry) => (
          <IconButton key={entry.tool} label={entry.shortcut ? `${t(entry.label)} (${entry.shortcut})` : t(entry.label)} active={tool === entry.tool} onClick={() => void dispatch(entry.command)} data-testid={`annotate-${entry.tool.slice(9)}`}>
            {entry.icon(16)}
          </IconButton>
        ))}
      </div>
      {tool === 'annotate:pen' && (
        <>
          <Swatches colors={PEN_COLORS} value={options.penColor} label="Pen colour" onPick={(penColor) => set({ penColor })} />
          <Sizes sizes={PEN_SIZES} value={options.penSize} color={options.penColor === '#ffffff' ? '#9a9ca3' : options.penColor} onPick={(penSize) => set({ penSize })} />
          <label className={styles.optionCheck} title={t('Stroke width follows the pen pressure')}>
            <input type="checkbox" checked={options.pressure} onChange={(event) => set({ pressure: event.target.checked })} /> {t('Pressure')}
          </label>
        </>
      )}
      {tool === 'annotate:highlighter' && (
        <>
          <Swatches colors={HIGHLIGHTER_COLORS} value={options.highlighterColor} label="Highlighter colour" onPick={(highlighterColor) => set({ highlighterColor })} />
          <Sizes sizes={HIGHLIGHTER_SIZES} value={options.highlighterSize} color={options.highlighterColor} onPick={(highlighterSize) => set({ highlighterSize })} />
        </>
      )}
      {tool === 'annotate:sticky' && <Swatches colors={STICKY_COLORS} value={options.stickyColor} label="Note colour" onPick={(stickyColor) => set({ stickyColor })} />}
      <label className={styles.optionValue} title={t('Annotation layers show on the board only: never on sheets, exports or 3D views')}>
        <Layers size={14} aria-hidden />
        <select
          value={activeLayer?.id ?? ''}
          onChange={(event) => set({ layerId: event.target.value || null })}
          aria-label={t('Annotation layer')}
          data-testid="annotation-layer"
        >
          {layers.length === 0 && <option value="">{t('New layer on first stroke')}</option>}
          {[...layers].reverse().map((layer) => (
            <option key={layer.id} value={layer.id}>
              {(layer.name ?? 'Annotations') + (layer.visible ? '' : ` (${t('hidden')})`) + (layer.locked ? ` (${t('locked')})` : '')}
            </option>
          ))}
        </select>
      </label>
      <IconButton label="New annotation layer" onClick={() => void dispatch('create-annotation-layer')} data-testid="annotation-new-layer">
        <Plus size={16} />
      </IconButton>
    </div>
  );
}

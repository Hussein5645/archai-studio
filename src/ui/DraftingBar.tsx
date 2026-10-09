/**
 * The options bar above the toolbar for drafting and modify tools (Revit's Options Bar): the
 * active tool's modes and values (circle / arc mode, polygon sides, copies, keep original,
 * array count, offset distance, fillet size, trim mode), plus quick arrange actions (align,
 * distribute, join, explode) for a multi-selection. Everything goes through commands.
 */
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  Merge,
  Ungroup,
} from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useAppState, useDispatch } from '@/app/context';
import { arraySpecOf, elementCategory } from '@/commands/builtin/drafting';
import type { Element } from '@/document';
import type { DraftingOptions } from '@/store';
import { IconButton, NumberField, Segmented } from './primitives';
import styles from './Toolbar.module.css';
import { useI18n } from './i18n';

const TOOL_LABELS: Record<string, string> = {
  rect: 'Rectangle',
  'draw:circle': 'Circle',
  'draw:arc': 'Arc',
  'draw:polygon': 'Polygon',
  'draw:ellipse': 'Ellipse',
  'draw:pen': 'Curve (pen)',
  'modify:move': 'Move',
  'modify:copy': 'Copy',
  'modify:rotate': 'Rotate',
  'modify:mirror': 'Mirror',
  'modify:scale': 'Scale',
  'modify:array': 'Array',
  'modify:offset': 'Offset',
  'modify:trim': 'Trim / extend',
  'modify:extend': 'Extend',
  'modify:split': 'Split',
  'modify:fillet': 'Fillet',
  'modify:match': 'Match properties',
};

function Check({ label, value, onChange, testId }: { label: string; value: boolean; onChange: (value: boolean) => void; testId?: string }) {
  const { t } = useI18n();
  return (
    <label className={styles.optionCheck}>
      <input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} data-testid={testId} /> {t(label)}
    </label>
  );
}

function Value({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <label className={styles.optionValue}>
      <span>{t(label)}</span>
      {children}
    </label>
  );
}

export function DraftingBar() {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const tool = useAppState((s) => s.ui.tool);
  const options = useAppState((s) => s.ui.drafting);
  const unit = useAppState((s) => s.doc.workspace.unit);
  const selection = useAppState((s) => s.ui.selection);
  // Select the stored element (a stable reference) and parse outside the selector.
  const selectedElement = useAppState((s) => (s.ui.selection.length === 1 ? s.doc.elements[s.ui.selection[0]!] : undefined));
  const selectedArray = useMemo(() => arraySpecOf(selectedElement), [selectedElement]);
  const set = (patch: Partial<Omit<DraftingOptions, 'osnap'>>) => void dispatch('set-drafting', patch);
  const label = TOOL_LABELS[tool];

  const controls: ReactNode[] = [];
  switch (tool) {
    case 'rect':
      controls.push(<Value key="r" label="Corner radius"><NumberField value={options.rectRadius} unit={unit} precision={0} min={0} onCommit={(rectRadius) => set({ rectRadius })} ariaLabel="Corner radius" /></Value>);
      break;
    case 'draw:circle':
      controls.push(<Segmented key="m" value={options.circleMode} onChange={(circleMode) => set({ circleMode })} ariaLabel="Circle mode" options={[{ value: 'center', label: 'Centre, radius' }, { value: '2p', label: '2 points' }, { value: '3p', label: '3 points' }]} />);
      break;
    case 'draw:arc':
      controls.push(<Segmented key="m" value={options.arcMode} onChange={(arcMode) => set({ arcMode })} ariaLabel="Arc mode" options={[{ value: 'three-point', label: '3 points' }, { value: 'center', label: 'Centre-ends' }, { value: 'tangent', label: 'Tangent' }]} />);
      break;
    case 'draw:polygon':
      controls.push(
        <Value key="s" label="Sides"><NumberField value={options.polygonSides} precision={0} min={3} max={64} onCommit={(polygonSides) => set({ polygonSides: Math.round(polygonSides) })} ariaLabel="Polygon sides" /></Value>,
        <Segmented key="m" value={options.polygonCircumscribed ? 'out' : 'in'} onChange={(value) => set({ polygonCircumscribed: value === 'out' })} ariaLabel="Polygon fit" options={[{ value: 'in', label: 'Inscribed' }, { value: 'out', label: 'Circumscribed' }]} />,
      );
      break;
    case 'modify:copy':
      controls.push(<Value key="c" label="Copies"><NumberField value={options.copies} precision={0} min={1} max={500} onCommit={(copies) => set({ copies: Math.round(copies) })} ariaLabel="Copies" /></Value>);
      break;
    case 'modify:rotate':
    case 'modify:scale':
      if (tool === 'modify:rotate') controls.push(<Check key="k" label="Keep original (copy)" value={options.keepOriginal} onChange={(keepOriginal) => set({ keepOriginal })} />);
      break;
    case 'modify:mirror':
      controls.push(<Check key="k" label="Keep original (copy)" value={options.mirrorKeepOriginal} onChange={(mirrorKeepOriginal) => set({ mirrorKeepOriginal })} testId="mirror-keep" />);
      break;
    case 'modify:array':
      controls.push(
        <Segmented key="k" value={options.arrayKind} onChange={(arrayKind) => set({ arrayKind })} ariaLabel="Array kind" options={[{ value: 'linear', label: 'Linear' }, { value: 'polar', label: 'Polar' }]} />,
        <Value key="n" label="Items"><NumberField value={options.arrayCount} precision={0} min={2} max={500} onCommit={(arrayCount) => set({ arrayCount: Math.round(arrayCount) })} ariaLabel="Array items" /></Value>,
      );
      if (options.arrayKind === 'polar') controls.push(<Value key="a" label="Angle °"><NumberField value={options.arrayAngle} precision={0} min={-360} max={360} onCommit={(arrayAngle) => set({ arrayAngle })} ariaLabel="Array angle" /></Value>);
      break;
    case 'modify:offset':
      controls.push(<Value key="d" label="Distance"><NumberField value={options.offset} unit={unit} precision={0} min={1} onCommit={(offset) => set({ offset })} ariaLabel="Offset distance" /></Value>);
      break;
    case 'modify:trim':
      controls.push(<Segmented key="m" value={options.trimMode} onChange={(trimMode) => set({ trimMode })} ariaLabel="Trim mode" options={[{ value: 'corner', label: 'To corner' }, { value: 'segment', label: 'Delete piece' }]} />);
      break;
    case 'modify:fillet':
      controls.push(
        <Segmented key="m" value={options.filletMode} onChange={(filletMode) => set({ filletMode })} ariaLabel="Corner mode" options={[{ value: 'fillet', label: 'Fillet' }, { value: 'chamfer', label: 'Chamfer' }]} />,
        <Value key="s" label={options.filletMode === 'fillet' ? 'Radius' : 'Distance'}><NumberField value={options.filletSize} unit={unit} precision={0} min={1} onCommit={(filletSize) => set({ filletSize })} ariaLabel="Fillet size" /></Value>,
      );
      break;
  }

  // A selected live array: edit its count and spacing in place.
  const arrayControls: ReactNode[] = [];
  if (tool === 'select' && selectedArray) {
    const id = selection[0]!;
    arrayControls.push(<Value key="n" label="Items"><NumberField value={selectedArray.count} precision={0} min={2} max={500} onCommit={(count) => void dispatch('set-array', { id, count: Math.round(count) })} ariaLabel="Array items" /></Value>);
    if (selectedArray.kind === 'linear') {
      arrayControls.push(
        <Value key="dx" label="Spacing X"><NumberField value={selectedArray.dx} unit={unit} precision={0} onCommit={(dx) => void dispatch('set-array', { id, dx })} ariaLabel="Array spacing X" /></Value>,
        <Value key="dy" label="Y"><NumberField value={-selectedArray.dy} unit={unit} precision={0} onCommit={(dy) => void dispatch('set-array', { id, dy: -dy })} ariaLabel="Array spacing Y" /></Value>,
      );
    } else arrayControls.push(<Value key="a" label="Angle °"><NumberField value={selectedArray.angle} precision={0} min={-360} max={360} onCommit={(angle) => void dispatch('set-array', { id, angle })} ariaLabel="Array angle" /></Value>);
  }

  const multi = tool === 'select' && selection.length > 1;
  const elements = useAppState((s) => (s.ui.tool === 'select' && s.ui.selection.length > 1 ? s.doc.elements : null));
  const categories = useMemo(() => {
    if (!multi) return [];
    const counts = new Map<string, number>();
    for (const id of selection) {
      const element = elements?.[id] as Element | undefined;
      if (element) counts.set(elementCategory(element), (counts.get(elementCategory(element)) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [elements, multi, selection]);
  if (!label && !multi && !arrayControls.length) return null;
  return (
    <div className={styles.optionsBar} role="toolbar" data-ui-scale aria-label={t('Tool options')} data-testid="drafting-bar">
      {label && <strong className={styles.optionsTitle}>{t(label)}</strong>}
      {controls}
      {arrayControls.length > 0 && (
        <>
          <strong className={styles.optionsTitle}>{t('Array')}</strong>
          {arrayControls}
          <button type="button" className={styles.optionButton} onClick={() => void dispatch('explode-selection')}>{t('Explode array')}</button>
        </>
      )}
      {multi && (
        <>
          <strong className={styles.optionsTitle}>{t('Selection')}</strong>
          {categories.length > 1 && (
            <select
              className={styles.optionButton}
              aria-label={t('Filter selection')}
              value=""
              onChange={(event) => event.target.value && void dispatch('filter-selection', { keep: [event.target.value] })}
              data-testid="selection-filter"
            >
              <option value="">{t('Filter…')}</option>
              {categories.map(([category, count]) => (
                <option key={category} value={category}>
                  {category} ({count})
                </option>
              ))}
            </select>
          )}
          <button type="button" className={styles.optionButton} onClick={() => void dispatch('select-similar')} title={t('Select everything like this (SA)')}>{t('Similar')}</button>
          <IconButton label={t('Align left')} onClick={() => void dispatch('align-selection', { edge: 'left' })}><AlignStartVertical size={16} /></IconButton>
          <IconButton label={t('Align centres')} onClick={() => void dispatch('align-selection', { edge: 'center' })}><AlignCenterVertical size={16} /></IconButton>
          <IconButton label={t('Align right')} onClick={() => void dispatch('align-selection', { edge: 'right' })}><AlignEndVertical size={16} /></IconButton>
          <IconButton label={t('Align top')} onClick={() => void dispatch('align-selection', { edge: 'top' })}><AlignStartHorizontal size={16} /></IconButton>
          <IconButton label={t('Align middles')} onClick={() => void dispatch('align-selection', { edge: 'middle' })}><AlignCenterHorizontal size={16} /></IconButton>
          <IconButton label={t('Align bottom')} onClick={() => void dispatch('align-selection', { edge: 'bottom' })}><AlignEndHorizontal size={16} /></IconButton>
          {selection.length > 2 && (
            <>
              <IconButton label={t('Distribute horizontally')} onClick={() => void dispatch('distribute-selection', { axis: 'horizontal' })}><AlignHorizontalDistributeCenter size={16} /></IconButton>
              <IconButton label={t('Distribute vertically')} onClick={() => void dispatch('distribute-selection', { axis: 'vertical' })}><AlignVerticalDistributeCenter size={16} /></IconButton>
            </>
          )}
          <IconButton label={t('Join lines')} onClick={() => void dispatch('join-lines')}><Merge size={16} /></IconButton>
          <IconButton label={t('Explode')} onClick={() => void dispatch('explode-selection')}><Ungroup size={16} /></IconButton>
        </>
      )}
    </div>
  );
}

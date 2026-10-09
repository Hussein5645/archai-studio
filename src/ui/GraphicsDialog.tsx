import { Download, GripHorizontal, Lock, Plus, RotateCcw, Save, Trash2, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useApp, useAppState, useDispatch } from '@/app/context';
import { getArchTool } from '@/assets/arch-tools';
import { graphicTypeOfElement } from '@/assets/arch-meta';
import { columnRect, doorTemplate, INK, stairChildren, windowTemplate } from '@/assets/system-geometry';
import { parseSystemParameters } from '@/catalog';
import type { ArchaiDocument, AssetDefinition, Element, ElementTable } from '@/document';
import { childrenOf } from '@/document';
import { boundsOfIds } from '@/geometry';
import {
  ALL_STYLES,
  BUILTIN_GRAPHICS_PRESETS,
  elementGraphicOverrides,
  GRAPHICS_PRESETS_STORAGE_KEY,
  graphicType,
  graphicTypesByCategory,
  graphicsForElement,
  graphicsResolver,
  parseStoredPresets,
  typeHasOverrides,
  type GraphicParameter,
  type GraphicValue,
  type GraphicView,
  type GraphicsOverrides,
  type GraphicsPreset,
  type TextColorMapping,
} from '@/graphics';
import { elementTransform, Shape } from '@/render/shapes';
import styles from './GraphicsDialog.module.css';
import { useI18n } from './i18n';
import { ColorField, IconButton, NumberField, SelectField, TextButton } from './primitives';

const VIEW_LABELS: Record<GraphicView, string> = { board: 'Board', section: 'Section', '3d': '3D' };
const STYLE_LABELS: Record<string, string> = { 'hidden-line': 'Hidden line' };

/**
 * Element graphics: the Hidden line look of every element type per view, with
 * presets that can be saved locally and shared as a JSON file. Opened from the status chip,
 * the palette, or an element's "Display settings" button (which focuses its type).
 */
export function GraphicsDialog() {
  const request = useAppState((s) => s.ui.graphicsDialog);
  // Remount when another type is requested (an element's "Display settings"), so it gets focus.
  return request.open ? <Dialog key={`${request.type ?? ''}:${request.elementId ?? ''}`} /> : null;
}

function Dialog() {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const requestedType = useAppState((s) => s.ui.graphicsDialog.type);
  const elementId = useAppState((s) => s.ui.graphicsDialog.elementId);
  const doc = useAppState((s) => s.doc);
  const element = elementId ? doc.elements[elementId] : undefined;
  const elementType = graphicTypeOfElement(element) ?? (element && (element.kind === 'rect' || element.kind === 'line' || element.kind === 'text' || element.kind === 'image') ? element.kind : null);
  const elementMode = Boolean(element && elementType);
  const graphics = useAppState((s) => s.doc.workspace.graphics) as GraphicsOverrides;
  const workspace = useAppState((s) => s.doc.workspace);
  const [typeId, setTypeId] = useState(requestedType && graphicType(requestedType) ? requestedType : 'wall');
  const type = graphicType(typeId) ?? graphicType('wall')!;
  const views = useMemo(() => elementMode ? ['board'] as GraphicView[] : (['board', 'section', '3d'] as GraphicView[]).filter((entry) => type.parameters.some((parameter) => parameter.views.includes(entry) && !(entry === '3d' && parameter.group === 'Materials'))), [elementMode, type]);
  const [view, setView] = useState<GraphicView>(views[0] ?? 'board');
  const dialogRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const [position, setPosition] = useState(() => ({
    x: typeof window === 'undefined' ? 24 : Math.max(16, window.innerWidth - Math.min(860, window.innerWidth - 32) - 24),
    y: 56,
  }));
  const activeView = views.includes(view) ? view : (views[0] ?? 'board');
  const styleKey = 'hidden-line';
  const close = useCallback(() => void dispatch('close-graphics'), [dispatch]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest?.('button, input, select, textarea, label')) return;
    const bounds = dialogRef.current?.getBoundingClientRect();
    if (!bounds) return;
    dragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = dialogRef.current?.getBoundingClientRect();
    const width = bounds?.width ?? 860;
    const height = bounds?.height ?? 640;
    setPosition({
      x: Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX - drag.offsetX)),
      y: Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY - drag.offsetY)),
    });
  };
  const stopDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  // 3D material colours live in the Materials panel now (they are the default materials).
  const parameters = type.parameters.filter((parameter) => parameter.views.includes(activeView) && (!parameter.styles || parameter.styles.includes('hidden-line')) && !(activeView === '3d' && parameter.group === 'Materials'));
  const groups = [...new Set(parameters.map((parameter) => parameter.group))];

  return (
    <div className={styles.backdrop}>
      <section ref={dialogRef} className={styles.dialog} data-element={elementMode || undefined} style={{ left: position.x, top: position.y }} role="dialog" aria-label={t('Element graphics')} data-testid="graphics-dialog">
        <header className={styles.header} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag}>
          <h2><GripHorizontal size={15} aria-hidden="true" /> {t(elementMode ? 'This element graphics' : 'Element graphics')}</h2>
          {!elementMode && <PresetBar />}
          <button type="button" onClick={close} aria-label={t('Close')}>
            <X size={16} />
          </button>
        </header>
        <div className={styles.body} data-element={elementMode || undefined}>
          {!elementMode && <nav className={styles.types} aria-label={t('Element types')}>
            {graphicTypesByCategory().map(({ category, types }) => (
              <div key={category} className={styles.category}>
                <span>{t(category)}</span>
                {types.map((entry) => (
                  <button key={entry.id} type="button" data-active={entry.id === type.id || undefined} onClick={() => setTypeId(entry.id)} data-testid={`graphics-type-${entry.id}`}>
                    {t(entry.label)}
                    {typeHasOverrides(graphics, entry.id) && <i title={t('Has overrides in this document')} />}
                  </button>
                ))}
              </div>
            ))}
          </nav>}
          <div className={styles.main}>
            <div className={styles.typeHeader}>
              <div>
                <h3>{t(type.label)}</h3>
                {elementMode ? <p>{element?.name || t('Selected element')} · {t('Overrides only this element in Hidden line')}</p> : type.description && <p>{t(type.description)}</p>}
              </div>
              <div className={styles.tabs} role="tablist">
                {views.map((entry) => (
                  <button key={entry} type="button" role="tab" aria-selected={entry === activeView} data-active={entry === activeView || undefined} onClick={() => setView(entry)} data-testid={`graphics-view-${entry}`}>
                    {t(VIEW_LABELS[entry])}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.styleChips} aria-label={t('Render style')}>
              <button type="button" data-active>{t('Hidden line')}{workspace.viewStyle === 'hidden-line' && activeView === 'board' && <small>{t('current')}</small>}</button>
            </div>
            {!elementMode && <Preview typeId={type.id} view={activeView} style="hidden-line" />}
            <div className={styles.parameters}>
              {groups.map((group) => (
                <section key={group} className={styles.group}>
                  <h4>{t(group)}</h4>
                  {parameters
                    .filter((parameter) => parameter.group === group)
                    .map((parameter) => (
                      <ParameterRow
                        key={parameter.id}
                        typeId={type.id}
                        view={activeView}
                        styleKey={styleKey}
                        parameter={parameter}
                        graphics={graphics}
                        displayStyle="hidden-line"
                        element={elementMode ? element : undefined}
                      />
                    ))}
                </section>
              ))}
              {parameters.length === 0 && <p className={styles.empty}>{t('Nothing to set for this view.')}</p>}
            </div>
          </div>
        </div>
        <footer className={styles.footer}>
          {elementMode && element ? (
            <TextButton type="button" onClick={() => void dispatch('reset-element-graphics', { id: element.id })} disabled={Object.keys(elementGraphicOverrides(element)).length === 0} data-testid="graphics-reset-element">
              <RotateCcw size={13} /> {t('Use type defaults')}
            </TextButton>
          ) : (
            <>
              <TextButton type="button" onClick={() => void dispatch('reset-graphics', { type: type.id })} disabled={!typeHasOverrides(graphics, type.id)} data-testid="graphics-reset-type">
                <RotateCcw size={13} /> {t('Reset')} {t(type.label)}
              </TextButton>
              <TextButton type="button" onClick={() => void dispatch('reset-graphics')} disabled={Object.keys(graphics).length === 0} data-testid="graphics-reset-all">
                {t('Reset all')}
              </TextButton>
            </>
          )}
          <span className={styles.spacer} />
          <TextButton primary type="button" onClick={close}>
            {t('Close')}
          </TextButton>
        </footer>
      </section>
    </div>
  );
}

// ---- one parameter --------------------------------------------------------------------------

function ParameterRow({
  typeId,
  view,
  styleKey,
  parameter,
  graphics,
  displayStyle,
  element,
}: {
  typeId: string;
  view: GraphicView;
  styleKey: string;
  parameter: GraphicParameter;
  graphics: GraphicsOverrides;
  displayStyle: string;
  element?: Element;
}) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const elementStored = element ? elementGraphicOverrides(element)[parameter.id] : undefined;
  const stored = element ? elementStored : graphics[typeId]?.[view]?.[styleKey]?.[parameter.id];
  const inherited = styleKey !== ALL_STYLES ? graphics[typeId]?.[view]?.[ALL_STYLES]?.[parameter.id] : undefined;
  const typeValue = graphicsResolver(graphics).get(typeId, view, displayStyle, parameter.id);
  const value = (stored !== undefined ? stored : element ? graphicsForElement(graphicsResolver(graphics), element, typeId, view, displayStyle).get(parameter.id) : inherited !== undefined ? inherited : typeValue) as GraphicValue;
  const overriddenHere = stored !== undefined;
  const set = (next: GraphicValue) => element
    ? void dispatch('set-element-graphic', { id: element.id, parameter: parameter.id, value: next })
    : void dispatch('set-graphic', { type: typeId, view, style: styleKey, id: parameter.id, value: next });
  const reset = () => element
    ? void dispatch('set-element-graphic', { id: element.id, parameter: parameter.id, reset: true })
    : void dispatch('set-graphic', { type: typeId, view, style: styleKey, id: parameter.id, reset: true });
  const locked = Boolean(parameter.locked);
  const unit = parameter.unit === 'mm' ? undefined : parameter.unit;

  let control: ReactNode;
  if (locked) {
    control = <span className={styles.lockedValue}>{formatValue(parameter, value, t)}</span>;
  } else if (parameter.kind === 'color') {
    control = <ColorField value={typeof value === 'string' ? value : null} allowNone={parameter.allowNone} onCommit={(next) => (next !== null || parameter.allowNone) && set(next)} ariaLabel={parameter.label} />;
  } else if (parameter.kind === 'toggle') {
    control = <button type="button" role="switch" aria-checked={value === true} aria-label={t(parameter.label)} className={styles.toggle} data-on={value === true} onClick={() => set(value !== true)} />;
  } else if (parameter.kind === 'hatch' || parameter.kind === 'choice') {
    control = <SelectField value={typeof value === 'string' ? value : ''} options={(parameter.options ?? []).map((option) => ({ value: option.value, label: option.label }))} onChange={(next) => set(next)} ariaLabel={parameter.label} />;
  } else if (parameter.kind === 'text-color-map') {
    control = <TextColorMapField key={JSON.stringify(value)} value={Array.isArray(value) ? value : []} onCommit={set} />;
  } else if (parameter.kind === 'opacity') {
    control = <NumberField value={(typeof value === 'number' ? value : 1) * 100} suffix="%" precision={0} step={5} min={0} max={100} onCommit={(next) => set(Math.min(1, Math.max(0, next / 100)))} ariaLabel={parameter.label} />;
  } else {
    control = (
      <NumberField
        value={typeof value === 'number' ? value : 0}
        suffix={unit === 'deg' ? '°' : unit === '%' ? '%' : unit === 'px' ? 'px' : 'mm'}
        precision={parameter.unit === 'px' ? 1 : 0}
        step={parameter.step}
        min={parameter.min}
        max={parameter.max}
        onCommit={(next) => set(next)}
        ariaLabel={parameter.label}
      />
    );
  }

  return (
    <div className={styles.row} data-wide={parameter.kind === 'text-color-map' || undefined} data-overridden={overriddenHere || undefined} data-locked={locked || undefined} data-testid={`graphic-${parameter.id}`}>
      <span className={styles.rowLabel} title={locked ? t(parameter.locked!) : inherited !== undefined && !overriddenHere ? t('Set for all styles') : undefined}>
        {locked && <Lock size={11} />}
        {t(parameter.label)}
        {!overriddenHere && inherited !== undefined && <em>{t('all styles')}</em>}
      </span>
      <span className={styles.rowControl}>{control}</span>
      <span className={styles.rowActions}>
        {overriddenHere && !locked && (
          <IconButton label={t('Reset to default')} className={styles.smallButton} onClick={reset} data-testid={`graphic-reset-${parameter.id}`}>
            <RotateCcw size={12} />
          </IconButton>
        )}
      </span>
    </div>
  );
}

function TextColorMapField({ value, onCommit }: { value: readonly TextColorMapping[]; onCommit: (value: TextColorMapping[]) => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<TextColorMapping[]>(() => value.map((entry) => ({ ...entry })));

  const updateText = (index: number, text: string) => setDraft((current) => current.map((entry, entryIndex) => (entryIndex === index ? { ...entry, text } : entry)));
  const commitText = () => onCommit(draft);
  const updateColor = (index: number, color: string) => {
    const next = draft.map((entry, entryIndex) => (entryIndex === index ? { ...entry, color } : entry));
    setDraft(next);
    onCommit(next);
  };
  const remove = (index: number) => {
    const next = draft.filter((_, entryIndex) => entryIndex !== index);
    setDraft(next);
    onCommit(next);
  };
  const add = () => {
    const next = [...draft, { text: '', color: '#f6b6b6' }];
    setDraft(next);
    onCommit(next);
  };

  return (
    <div className={styles.colorMap}>
      {draft.map((entry, index) => (
        <div className={styles.colorMapEntry} key={index}>
          <input
            value={entry.text}
            aria-label={`${t('Room name')} ${index + 1}`}
            placeholder={t('Room name')}
            maxLength={200}
            onChange={(event) => updateText(index, event.target.value)}
            onBlur={commitText}
            onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
          />
          <ColorField value={entry.color} onCommit={(color) => color && updateColor(index, color)} ariaLabel={`${t('Room colour')} ${index + 1}`} />
          <IconButton label={t('Remove mapping')} className={styles.smallButton} onClick={() => remove(index)}>
            <Trash2 size={12} />
          </IconButton>
        </div>
      ))}
      <TextButton type="button" onClick={add}>
        <Plus size={13} /> {t('Add room name')}
      </TextButton>
    </div>
  );
}

function formatValue(parameter: GraphicParameter, value: GraphicValue, t: (s: string) => string): string {
  if (Array.isArray(value)) return `${value.length} ${t(value.length === 1 ? 'mapping' : 'mappings')}`;
  if (value === null) return t('None');
  if (typeof value === 'boolean') return t(value ? 'Always' : 'Never');
  if (typeof value === 'number') return `${value}${parameter.unit === 'deg' ? '°' : parameter.unit === '%' ? '%' : parameter.unit === 'px' ? ' px' : ' mm'}`;
  return value;
}

// ---- presets --------------------------------------------------------------------------------

function PresetBar() {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const { platform, toasts } = useApp();
  const graphics = useAppState((s) => s.doc.workspace.graphics) as GraphicsOverrides;
  const [user, setUser] = useState<GraphicsPreset[]>([]);
  const [selected, setSelected] = useState('default');
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => parseStoredPresets(await platform.storage.get(GRAPHICS_PRESETS_STORAGE_KEY)), [platform]);
  const refresh = useCallback(async () => setUser(await load()), [load]);
  useEffect(() => {
    let active = true;
    void load().then((presets) => {
      if (active) setUser(presets);
    });
    return () => {
      active = false;
    };
  }, [load]);
  const all = [...BUILTIN_GRAPHICS_PRESETS, ...user];
  const current = all.find((preset) => preset.id === selected);

  const apply = async (id: string) => {
    setSelected(id);
    const result = await dispatch('apply-graphics-preset', { presetId: id });
    if (result.ok) toasts.push({ kind: 'info', message: `${t('Applied graphics preset')} ${all.find((preset) => preset.id === id)?.name ?? id}` });
  };
  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const result = await dispatch('save-graphics-preset', { name: trimmed });
    if (result.ok) {
      setNaming(false);
      setName('');
      await refresh();
      setSelected(String(result.value));
      toasts.push({ kind: 'success', message: `${t('Saved graphics preset')} ${trimmed}` });
    }
  };
  const remove = async () => {
    if (!current || current.builtin) return;
    const result = await dispatch('delete-graphics-preset', { presetId: current.id });
    if (result.ok) {
      await refresh();
      setSelected('default');
    }
  };
  const exportCurrent = () => {
    if (current && !current.builtin) void dispatch('export-graphics-presets', { presetId: current.id });
    else void dispatch('export-graphics-presets', { name: current?.name ?? 'Graphics' });
  };
  const importFile = async (file: File) => {
    const text = await file.text();
    const result = await dispatch('import-graphics-presets', { text });
    if (result.ok) {
      await refresh();
      const ids = result.value as string[];
      toasts.push({ kind: 'success', message: `${t('Imported')} ${ids.length} ${t(ids.length === 1 ? 'graphics preset' : 'graphics presets')}` });
      if (ids[0]) void apply(ids[0]);
    }
  };

  return (
    <div className={styles.presets} data-testid="graphics-presets">
      <label>
        <span>{t('Preset')}</span>
        <select value={selected} aria-label={t('Graphics preset')} onChange={(event) => void apply(event.target.value)} data-testid="graphics-preset-select">
          <optgroup label={t('Built-in')}>
            {BUILTIN_GRAPHICS_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {t(preset.name)}
              </option>
            ))}
          </optgroup>
          {user.length > 0 && (
            <optgroup label={t('My presets')}>
              {user.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      {naming ? (
        <form
          className={styles.nameForm}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <input autoFocus value={name} placeholder={t('Preset name')} aria-label={t('Preset name')} onChange={(event) => setName(event.target.value)} data-testid="graphics-preset-name" />
          <TextButton primary type="submit" disabled={!name.trim()} data-testid="graphics-preset-save">
            {t('Save')}
          </TextButton>
          <TextButton type="button" onClick={() => setNaming(false)}>
            {t('Cancel')}
          </TextButton>
        </form>
      ) : (
        <>
          <IconButton label={t('Save as preset')} onClick={() => setNaming(true)} disabled={Object.keys(graphics).length === 0} data-testid="graphics-preset-save-as">
            <Save size={14} />
          </IconButton>
          <IconButton label={t('Delete preset')} onClick={() => void remove()} disabled={!current || Boolean(current.builtin)} data-testid="graphics-preset-delete">
            <Trash2 size={14} />
          </IconButton>
          <IconButton label={t('Import presets from a file')} onClick={() => fileRef.current?.click()} data-testid="graphics-preset-import">
            <Upload size={14} />
          </IconButton>
          <IconButton label={t('Export as a shareable file')} onClick={exportCurrent} data-testid="graphics-preset-export">
            <Download size={14} />
          </IconButton>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importFile(file);
            }}
          />
        </>
      )}
    </div>
  );
}

// ---- preview --------------------------------------------------------------------------------

interface Sample {
  elements: ElementTable;
  definitions: ArchaiDocument['definitions'];
}

let sampleIds = 0;
function nextId(): string {
  return `sample_${++sampleIds}`;
}

/** A small, representative element table for the type, drawn with the board renderer. */
function sampleFor(typeId: string): Sample | null {
  const elements: Record<string, Element> = {};
  const definitions: ArchaiDocument['definitions'] = {};
  const base = (kind: Element['kind']) => ({ id: nextId(), parentId: null as string | null, index: 'a0', x: 0, y: 0, rotation: 0, visible: true, locked: false, kind });
  const line = (points: [number, number][], strokeWidth: number, meta?: Element['meta'], closed = false, fill: string | null = null, stroke: string | null = INK): Element => ({
    ...base('line'),
    kind: 'line',
    points,
    closed,
    style: { fill, stroke, strokeWidth, opacity: 1 },
    ...(meta ? { meta } : {}),
  });
  const add = (element: Element) => {
    elements[element.id] = element;
    return element;
  };
  const instance = (template: { width: number; height: number; elements: Element[] }, meta: Element['meta'], name: string) => {
    const definition: AssetDefinition = { id: nextId(), name, kind: 'template', width: template.width, height: template.height, origin: 'builtin', elements: Object.fromEntries(template.elements.map((e) => [e.id, e])) };
    definitions[definition.id] = definition;
    return add({ ...base('instance'), kind: 'instance', definitionId: definition.id, width: template.width, height: template.height, meta });
  };
  switch (typeId) {
    case 'wall': {
      const parameters = parseSystemParameters('wall', { layers: [{ name: 'Render', role: 'finish', thickness: 20 }, { name: 'Block', role: 'core', thickness: 200 }, { name: 'Plaster', role: 'finish', thickness: 15 }] });
      const thickness = parameters.layers.reduce((sum, layer) => sum + layer.thickness, 0);
      add(line([[0, 0], [3200, 0], [3200, 1800]], thickness, { arch: { type: 'wall', thickness, parameters: parameters as never } }));
      return { elements, definitions };
    }
    case 'column': {
      const parameters = parseSystemParameters('column', {});
      const rect = columnRect(parameters);
      add({ ...base('rect'), kind: 'rect', width: rect.width, height: rect.height, radius: rect.radius, style: rect.style, meta: { arch: { type: 'column', parameters: parameters as never } } });
      const round = parseSystemParameters('column', { shape: 'circle', material: 'steel' });
      const circle = columnRect(round);
      add({ ...base('rect'), kind: 'rect', x: rect.width + 300, width: circle.width, height: circle.height, radius: circle.radius, style: circle.style, meta: { arch: { type: 'column', parameters: round as never } } });
      return { elements, definitions };
    }
    case 'door': {
      const parameters = parseSystemParameters('door', {});
      instance(doorTemplate(parameters), { arch: { type: 'door', parameters: parameters as never } }, 'Door');
      return { elements, definitions };
    }
    case 'window': {
      const parameters = parseSystemParameters('window', {});
      instance(windowTemplate(parameters, 200), { arch: { type: 'window', parameters: parameters as never } }, 'Window');
      return { elements, definitions };
    }
    case 'facade-element': {
      const tool = getArchTool('facade-element');
      if (!tool || tool.mode.kind !== 'place') return null;
      instance(tool.mode.template(), { arch: { type: 'facade-element' } }, 'Facade element');
      return { elements, definitions };
    }
    case 'stair': {
      const parameters = parseSystemParameters('stair', {});
      const group: Element = { ...base('group'), kind: 'group', meta: { arch: { type: 'stair', parameters: parameters as never } } };
      add(group);
      const children = stairChildren(parameters, [
        { kind: 'run', x: 0, y: 0, angle: 0, treads: 5 },
        { kind: 'landing', x: 5 * parameters.treadDepth, y: 0, angle: 0 },
      ]);
      children.forEach((child, index) => add({ ...child.element, id: nextId(), parentId: group.id, index: `a${index}` } as Element));
      return { elements, definitions };
    }
    case 'railing': {
      const parameters = parseSystemParameters('railing', {});
      add(line([[0, 0], [3000, 0]], parameters.thickness, { arch: { type: 'railing', parameters: parameters as never } }, false, null, '#6b6b72'));
      return { elements, definitions };
    }
    case 'curtain-wall':
      add(line([[0, 0], [3000, 0]], 100, { arch: { type: 'curtain-wall' } }, false, null, '#587099'));
      return { elements, definitions };
    case 'room-divider':
      add(line([[0, 0], [3000, 0]], 24, { arch: { type: 'room-divider' } }, false, null, '#8a8f98'));
      return { elements, definitions };
    case 'room': {
      const room = add(line([[0, 0], [3000, 0], [3000, 2200], [0, 2200]], 12, { arch: { type: 'room', area: 6_600_000 } }, true, '#eef3fb', '#8aa4cb'));
      add({ ...base('text'), kind: 'text', x: 500, y: 900, width: 2000, height: 500, text: 'Room\n6.60 m²', fontSize: 180, align: 'center', color: INK, meta: { arch: { type: 'room-label', roomId: room.id } } });
      return { elements, definitions };
    }
    case 'rect':
      add({ ...base('rect'), kind: 'rect', width: 2400, height: 1400, radius: 0, style: { fill: '#ffffff', stroke: INK, strokeWidth: 12, opacity: 1 } });
      return { elements, definitions };
    case 'line':
      add(line([[0, 800], [900, 0], [1800, 800], [2700, 0]], 12));
      return { elements, definitions };
    case 'text':
      add({ ...base('text'), kind: 'text', width: 2600, height: 300, text: 'Ground floor plan', fontSize: 200, align: 'left', color: '#2a2a2e' });
      return { elements, definitions };
    case 'image':
      add({ ...base('image'), kind: 'image', width: 2000, height: 1200, blobId: 'missing', opacity: 1 });
      return { elements, definitions };
    case 'asset':
      add({ ...base('instance'), kind: 'instance', definitionId: 'missing', width: 1600, height: 1000 });
      return { elements, definitions };
    case 'measure':
      add(line([[0, 0], [2800, 0]], 8, { measure: { distance: 2800 } }, false, null, '#2563eb'));
      return { elements, definitions };
    case 'section-marker':
      add(line([[0, 0], [3200, 0]], 14, { sectionLine: { direction: 1 } }, false, null, '#2563eb'));
      return { elements, definitions };
    case 'camera-marker':
      add(line([[0, 1200], [2600, 0]], 8, { cameraMarker: { fov: 60 } }, false, null, '#8b5cf6'));
      return { elements, definitions };
    case 'level':
      add({ ...base('rect'), kind: 'rect', width: 3000, height: 1800, radius: 0, style: { fill: '#dbeafe', stroke: '#2563eb', strokeWidth: 12, opacity: 0.24 }, name: 'Level 2', meta: { level: { elevation: 3000 } } });
      return { elements, definitions };
    case 'paper':
      add({ ...base('rect'), kind: 'rect', width: 2970, height: 2100, radius: 0, style: { fill: '#ffffff', stroke: '#8a8f98', strokeWidth: 8, opacity: 1 }, meta: { paper: { size: 'A4', orientation: 'landscape', scale: 50, title: 'Sheet 1' } } });
      return { elements, definitions };
    default:
      return null;
  }
}

function Preview({ typeId, view, style }: { typeId: string; view: GraphicView; style: string }) {
  const { t } = useI18n();
  const workspace = useAppState((s) => s.doc.workspace);
  const sample = useMemo(() => sampleFor(typeId), [typeId]);
  if (view !== 'board' || !sample) {
    return (
      <div className={styles.previewNote}>
        {view === 'board' ? t('No preview for this type.') : view === 'section' ? t('Section changes show live in open section views.') : t('3D changes show live in open 3D views.')}
      </div>
    );
  }
  const ids = Object.keys(sample.elements);
  const bounds = boundsOfIds(sample.elements, ids);
  if (!bounds) return null;
  const pad = 500;
  const context = { definitions: sample.definitions, blobs: {}, elements: sample.elements, workspace: { ...workspace, viewStyle: style as typeof workspace.viewStyle } };
  const render = (parentId: string | null): ReactNode =>
    childrenOf(sample.elements, parentId).map((element) => (
      <g key={element.id} transform={elementTransform(element)}>
        {element.kind !== 'group' && <Shape element={element} context={context} />}
        {render(element.id)}
      </g>
    ));
  return (
    <div className={styles.preview} style={{ background: workspace.background }} data-testid="graphics-preview">
      <svg viewBox={`${bounds.x - pad} ${bounds.y - pad} ${bounds.width + pad * 2} ${bounds.height + pad * 2}`} preserveAspectRatio="xMidYMid meet">
        {render(null)}
      </svg>
      <span>{t(STYLE_LABELS[style] ?? style)}</span>
    </div>
  );
}

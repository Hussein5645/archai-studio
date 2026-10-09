/**
 * Sheet mode chrome: the top bar (back to board, sheet title/number/size, export), the left panel
 * (views to place and the sheet's own layers) and the sheet toolbar. The board itself is the
 * same Workboard, filtered to the open paper (see render/boardRuns.ts).
 */
import { ArrowLeft, Box, Camera, Circle, Compass, Download, FileText, Hand, Image as ImageIcon, LayoutPanelLeft, Maximize, MousePointer2, Move, PenTool, Ruler, Scissors, Slash, Spline, Square, Stamp, Type } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useApp, useAppState, useDispatch } from '@/app/context';
import { paperOf } from '@/commands/builtin/views';
import { boardDoc } from '@/store';
import { elementLabel, LayersTree } from '@/ui/LayersTree';
import { IconButton } from '@/ui/primitives';
import { TextField } from '@/ui/primitives';
import toolbarStyles from '@/ui/Toolbar.module.css';
import { useI18n } from '@/ui/i18n';
import { sheetSources, sheetViewOf, type SheetSource } from './model';
import styles from './Sheet.module.css';
import { DIAGRAM_TOOLS } from '@/diagrams/tools';
import { analysisOf } from '@/analysis/model';
import { readSheetTemplates, type SheetTemplate } from '@/commands/builtin/sheetLayout';
import { DraftingBar } from '@/ui/DraftingBar';

/** Drag data of a view dragged from the list onto the sheet. */
export const SHEET_SOURCE_MIME = 'application/x-archai-sheet-source';

const ICON = 18;

function useOpenSheet() {
  const paperId = useAppState((s) => s.ui.sheet?.paperId ?? null);
  const paper = useAppState((s) => (paperId ? boardDoc(s).elements[paperId] : undefined));
  return { paperId, paper, meta: paper ? paperOf(paper.meta) : null };
}

/** Top bar: where you are, and the way back. Also handles Esc and a deleted sheet. */
export function SheetBar() {
  const { t } = useI18n();
  const { store } = useApp();
  const dispatch = useDispatch();
  const { paperId, paper, meta } = useOpenSheet();
  // A string (not an object) so the selector result is stable between store reads.
  const viewTitle = useAppState((s) => {
    const frameId = s.ui.sheet?.viewEdit?.frameId;
    const frame = frameId ? boardDoc(s).elements[frameId] : undefined;
    return frame ? (sheetViewOf(frame)?.title ?? 'View') : null;
  });

  // The sheet was deleted (or undone away): back to the board.
  useEffect(() => {
    if (paperId && !paper) void dispatch('close-sheet');
  }, [paperId, paper, dispatch]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const { ui } = store.getState();
      const viewEdit = ui.sheet?.viewEdit;
      if (viewEdit) {
        // Inside a view the keys act on the picked elements, never on the frame or the sheet.
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.key !== 'Escape') {
          if (viewEdit.picked.length > 0) void dispatch('set-view-override', { patch: { visibility: 'hidden' } });
        } else if (viewEdit.picked.length > 0) void dispatch('pick-in-view', { ids: [], mode: 'replace' });
        else void dispatch('exit-sheet-view');
        return;
      }
      if (event.key !== 'Escape') return;
      // Esc first clears the selection / tool, as on the board; a second Esc leaves the sheet.
      // Read in the capture phase, before the board's own Esc handling changes the state.
      if (ui.selection.length === 0 && ui.tool === 'select' && !ui.editingTextId && !ui.exportDialog.open) void dispatch('close-sheet');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dispatch, store]);

  if (!paper || !meta || paper.kind !== 'rect') return null;
  const width = Math.round(paper.width / meta.scale);
  const height = Math.round(paper.height / meta.scale);
  return (
    <div className={styles.bar} data-testid="sheet-bar" data-ui-scale onPointerDown={(event) => event.stopPropagation()}>
      <button type="button" className={styles.back} onClick={() => void dispatch('close-sheet')} title={t('Back to board (Esc)')}>
        <ArrowLeft size={15} /> {t('Board')}
      </button>
      <span className={styles.divider} />
      <FileText size={15} className={styles.icon} />
      <span className={styles.number}>
        <TextField value={meta.number} onCommit={(number) => void dispatch('set-paper', { id: paper.id, number })} ariaLabel="Sheet number" />
      </span>
      <span className={styles.title}>
        <TextField value={meta.title} onCommit={(title) => void dispatch('set-paper', { id: paper.id, title })} ariaLabel="Sheet title" />
      </span>
      {viewTitle !== null ? (
        <span className={styles.crumb}>
          › {viewTitle}
          <button type="button" onClick={() => void dispatch('exit-sheet-view')}>
            {t('Done')}
          </button>
        </span>
      ) : (
        <span className={styles.chip}>
          {meta.size !== 'custom' ? `${meta.size} ${meta.orientation} · ` : ''}
          {width} × {height} mm · 1:{meta.scale}
        </span>
      )}
      <span className={styles.divider} />
      <IconButton label={t('Fit sheet')} onClick={() => void dispatch('fit-sheet')}>
        <Maximize size={15} />
      </IconButton>
      <button type="button" className={styles.export} onClick={() => void dispatch('open-export-dialog', { id: paper.id })}>
        <Download size={15} /> {t('Export')}
      </button>
    </div>
  );
}

const SOURCE_ICON: Record<SheetSource['kind'], ReactNode> = {
  plan: <LayoutPanelLeft size={15} />,
  section: <Scissors size={15} />,
  camera: <Camera size={15} />,
  '3d': <Box size={15} />,
};

const SOURCE_KIND: Record<SheetSource['kind'], string> = { plan: 'Plan · vector', section: 'Section', camera: 'Camera', '3d': '3D view' };

/** Inside a view frame: the elements styled in it (click to pick), grouped by look. */
function ViewElementsList({ frameId, picked }: { frameId: string; picked: string[] }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const doc = useAppState((s) => boardDoc(s));
  const view = sheetViewOf(doc.elements[frameId]);
  if (!view) return null;
  const styled = Object.entries(view.overrides).filter(([id]) => doc.elements[id]);
  return (
    <>
      <h3 className="u-section-title">{t('Styled in this view')}</h3>
      {styled.length === 0 ? (
        <p className={styles.empty}>{t('Click elements in the view to pick them, then style them in the Inspector, or apply a diagram style.')}</p>
      ) : (
        <ul className={styles.sources}>
          {styled.map(([id, look]) => (
            <li key={id}>
              <button type="button" className={styles.source} data-active={picked.includes(id) || undefined} onClick={(event) => void dispatch('pick-in-view', { ids: [id], mode: event.shiftKey ? 'toggle' : 'replace' })}>
                <span className={styles.swatch} style={{ background: look.visibility === 'ghost' ? '#e5e7eb' : (look.fill ?? look.stroke ?? '#ffffff'), opacity: look.visibility === 'hidden' ? 0.3 : 1 }} />
                <span className={styles.sourceText}>
                  <strong>{elementLabel(doc.elements[id]!, doc)}</strong>
                  <small>{[look.visibility, look.emphasis, look.label && `"${look.label}"`, look.lift && `lift ${look.lift} mm`].filter(Boolean).join(' · ') || t('Restyled')}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Left panel in sheet mode: views to place, then the sheet's own layers. */
export function SheetPanel() {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const { paperId } = useOpenSheet();
  const elements = useAppState((s) => boardDoc(s).elements);
  const doc = useAppState((s) => boardDoc(s));
  const sources = useMemo(() => sheetSources(doc), [doc]);
  const viewEdit = useAppState((s) => s.ui.sheet?.viewEdit ?? null);
  // Which sources this sheet already shows.
  const origins = useMemo(
    () =>
      Object.values(elements).flatMap((element) => {
        const meta = analysisOf(element);
        return meta ? [{ id: element.id, name: element.name ?? 'Analysis', kind: meta.kind }] : [];
      }),
    [elements],
  );
  const placed = useMemo(() => {
    const ids = new Set<string>();
    for (const element of Object.values(elements)) {
      if (element.parentId !== paperId) continue;
      const view = element.meta?.['sheetView'] as { sourceId?: string } | undefined;
      if (view?.sourceId) ids.add(view.sourceId);
    }
    return ids;
  }, [elements, paperId]);
  if (!paperId) return null;
  return (
    <aside className={`${styles.panel} u-panel`} aria-label={t('Sheet')} data-ui-scale data-testid="sheet-panel">
      <section className={styles.panelSection}>
        <h3 className="u-section-title">{t('Views')}</h3>
        {sources.length === 0 ? (
          <p className={styles.empty}>{t('No views yet. Add levels, sections or cameras on the board, or place a board area from the toolbar.')}</p>
        ) : (
          <ul className={styles.sources}>
            {sources.map((source) => (
              <li key={source.id}>
                <button
                  type="button"
                  className={styles.source}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(SHEET_SOURCE_MIME, source.id);
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => void dispatch('add-sheet-view', { paperId, sourceId: source.id })}
                  title={t('Click to place in the middle, or drag onto the sheet')}
                  data-testid={`sheet-source-${source.id}`}
                >
                  <span className={styles.sourceIcon}>{SOURCE_ICON[source.kind]}</span>
                  <span className={styles.sourceText}>
                    <strong>{source.name}</strong>
                    <small>{t(SOURCE_KIND[source.kind])}</small>
                  </span>
                  {placed.has(source.id) && <span className={styles.placed}>{t('On sheet')}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {!viewEdit && <SheetLayoutSection paperId={paperId} />}
      {origins.length > 0 && !viewEdit && (
        <section className={styles.panelSection}>
          <h3 className="u-section-title">{t('Analysis')}</h3>
          <ul className={styles.sources}>
            {origins.map((origin) => (
              <li key={origin.id} className={styles.analysisRow}>
                <span className={styles.sourceText}>
                  <strong>{origin.name}</strong>
                  <small>{t(origin.kind === 'sun' ? 'Sun' : origin.kind === 'wind' ? 'Wind' : 'Noise')}</small>
                </span>
                {origin.kind === 'sun' && (
                  <button type="button" className={styles.chip} onClick={() => void dispatch('add-analysis-chart', { paperId, originId: origin.id, chart: 'sun-path' })}>
                    {t('Sun path')}
                  </button>
                )}
                {origin.kind === 'wind' && (
                  <button type="button" className={styles.chip} onClick={() => void dispatch('add-analysis-chart', { paperId, originId: origin.id, chart: 'wind-rose' })}>
                    {t('Rose')}
                  </button>
                )}
                <button type="button" className={styles.chip} onClick={() => void dispatch('add-analysis-chart', { paperId, originId: origin.id, chart: 'legend' })}>
                  {t('Legend')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className={`${styles.panelSection} ${styles.layers}`}>
        {viewEdit ? (
          <ViewElementsList frameId={viewEdit.frameId} picked={viewEdit.picked} />
        ) : (
          <>
            <h3 className="u-section-title">{t('On this sheet')}</h3>
            <LayersTree rootId={paperId} />
          </>
        )}
      </section>
    </aside>
  );
}

/** Arrange the views, and save / reuse sheet templates. */
function SheetLayoutSection({ paperId }: { paperId: string }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const { platform, executor } = useApp();
  const [templates, setTemplates] = useState<SheetTemplate[]>([]);
  const [name, setName] = useState('');
  const reload = useCallback(() => void readSheetTemplates(platform.storage).then(setTemplates), [platform]);
  useEffect(reload, [reload]);
  const paperWidth = useAppState((s) => (boardDoc(s).elements[paperId] as { width?: number } | undefined)?.width ?? 0);
  const paperX = useAppState((s) => boardDoc(s).elements[paperId]?.x ?? 0);
  const paperY = useAppState((s) => boardDoc(s).elements[paperId]?.y ?? 0);
  return (
    <section className={styles.panelSection}>
      <h3 className="u-section-title">{t('Layout')}</h3>
      <div className={styles.layoutRow}>
        <button type="button" className={styles.chipButton} onClick={() => void dispatch('arrange-sheet-views', { paperId, layout: 'grid' })} data-testid="arrange-grid">{t('Grid')}</button>
        <button type="button" className={styles.chipButton} onClick={() => void dispatch('arrange-sheet-views', { paperId, layout: 'row' })}>{t('Row')}</button>
        <button type="button" className={styles.chipButton} onClick={() => void dispatch('arrange-sheet-views', { paperId, layout: 'column' })}>{t('Column')}</button>
      </div>
      <h3 className="u-section-title">{t('Templates')}</h3>
      <div className={styles.layoutRow}>
        <TextField value={name} onCommit={setName} placeholder={t('Template name')} ariaLabel="Template name" />
        <button
          type="button"
          className={styles.chipButton}
          disabled={!name.trim()}
          onClick={() => void executor.dispatch('save-sheet-template', { paperId, name: name.trim() }).then(() => { setName(''); reload(); })}
          data-testid="save-sheet-template"
        >
          {t('Save')}
        </button>
      </div>
      {templates.length > 0 && (
        <ul className={styles.sources}>
          {templates.map((template) => (
            <li key={template.name} className={styles.analysisRow}>
              <span className={styles.sourceText}><strong>{template.name}</strong></span>
              <button type="button" className={styles.chip} title={t('New sheet from this template, beside this one')} onClick={() => void executor.dispatch('new-sheet-from-template', { name: template.name, x: paperX + paperWidth * 1.1, y: paperY })}>
                {t('New sheet')}
              </button>
              <button type="button" className={styles.chip} title={t('Delete template')} onClick={() => void executor.dispatch('delete-sheet-template', { name: template.name }).then(reload)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface SheetTool {
  label: string;
  shortcut?: string;
  icon: ReactNode;
  active?: boolean;
  run: () => void;
}

/** Bottom toolbar in sheet mode: drawing tools plus the sheet items. */
export function SheetToolbar() {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const tool = useAppState((s) => s.ui.tool);
  const paperId = useAppState((s) => s.ui.sheet?.paperId);
  const groups: SheetTool[][] = [
    [
      { label: 'Select', shortcut: 'V', icon: <MousePointer2 size={ICON} />, active: tool === 'select', run: () => void dispatch('tool-select') },
      { label: 'Hand', shortcut: 'H', icon: <Hand size={ICON} />, active: tool === 'hand', run: () => void dispatch('tool-hand') },
    ],
    [
      { label: 'Text', shortcut: 'T', icon: <Type size={ICON} />, active: tool === 'text', run: () => void dispatch('tool-text') },
      { label: 'Rectangle', shortcut: 'R', icon: <Square size={ICON} />, active: tool === 'rect', run: () => void dispatch('tool-rect') },
      { label: 'Line', shortcut: 'L', icon: <Slash size={ICON} />, active: tool === 'line', run: () => void dispatch('tool-line') },
      { label: 'Circle', shortcut: 'C', icon: <Circle size={ICON} />, active: tool === 'draw:circle', run: () => void dispatch('tool-circle') },
      { label: 'Arc', shortcut: 'A', icon: <Spline size={ICON} />, active: tool === 'draw:arc', run: () => void dispatch('tool-arc') },
      { label: 'Curve (pen)', shortcut: 'B', icon: <PenTool size={ICON} />, active: tool === 'draw:pen', run: () => void dispatch('tool-pen') },
      { label: 'Move by points', shortcut: 'MV', icon: <Move size={ICON} />, active: tool === 'modify:move', run: () => void dispatch('tool-move') },
      { label: 'Image', shortcut: 'I', icon: <ImageIcon size={ICON} />, active: tool === 'image', run: () => void dispatch('tool-image') },
    ],
    DIAGRAM_TOOLS.map((entry) => ({ label: entry.label, icon: entry.icon(ICON), active: tool === entry.tool, run: () => void dispatch(entry.command) })),
    [
      { label: 'Title block', icon: <Stamp size={ICON} />, run: () => void dispatch('add-title-block', { paperId }) },
      { label: 'Scale bar', icon: <Ruler size={ICON} />, run: () => void dispatch('add-scale-bar', { paperId }) },
      { label: 'North arrow', icon: <Compass size={ICON} />, run: () => void dispatch('add-north-arrow', { paperId }) },
    ],
  ];
  return (
    <div className={toolbarStyles.toolbarContainer} data-ui-scale>
      <DraftingBar />
      <div className={toolbarStyles.toolbar} role="toolbar" aria-label={t('Sheet tools')} data-testid="sheet-toolbar">
        {groups.map((group, index) => (
          <div key={index} className={toolbarStyles.group}>
            {index > 0 && <div className={toolbarStyles.separator} />}
            {group.map((item) => (
              <IconButton key={item.label} size="large" label={`${t(item.label)}${item.shortcut ? ` (${item.shortcut})` : ''}`} active={item.active} onClick={item.run}>
                {item.icon}
              </IconButton>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

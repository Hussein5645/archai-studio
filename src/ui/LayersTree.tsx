import { AppWindow, SquareDashed, Box, Camera, ChevronDown, Crosshair, ChevronRight, Eye, EyeOff, Folder, FolderCog, Image as ImageIcon, Layers, Pin, PinOff, Scissors, Slash, Square, Type, Workflow } from 'lucide-react';
import { createContext, memo, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp, useAppState, useAppStateShallow, useDispatch } from '@/app/context';
import { type ArchaiDocument, type Element } from '@/document';
import { layerChildrenOf } from '@/layers/hierarchy';
import { graphRuntimeOf } from '@/commands/builtin/parametric';
import { locationOf } from '@/analysis/model';
import { siteArea } from '@/analysis/mapGeometry';
import styles from './LeftPanel.module.css';
import { useI18n } from './i18n';

const LAYER_DRAG_TYPE = 'application/x-archai-layer';

interface TreeContextValue {
  onRowSelect: (id: string, e: React.MouseEvent) => void;
}
const TreeContext = createContext<TreeContextValue>({ onRowSelect: () => {} });

export function elementLabel(element: Element, doc: ArchaiDocument): string {
  if (element.name) return element.name;
  if (element.meta?.['cameraMarker']) {
    return 'Camera';
  }
  if (element.meta?.['sectionLine']) {
    const sectionType = (element.meta['sectionLine'] as { sectionType?: string }).sectionType;
    return sectionType === 'plan' ? 'Plan Cut Line' : 'Section Line';
  }
  if (element.meta?.['view3d']) {
    const v3d = element.meta['view3d'] as { cameraMode?: boolean; cameraId?: string; cut?: unknown; sectionLineId?: unknown };
    if (v3d.cameraMode || v3d.cameraId) return 'Camera View';
    if (v3d.cut || v3d.sectionLineId) return 'Section View';
    if ((v3d as { planRegionId?: unknown }).planRegionId) return 'Plan View';
    return '3D View';
  }
  if (element.meta?.['paper']) {
    return 'Paper Sheet';
  }
  const arch = element.meta?.['arch'];
  if (arch && typeof arch === 'object' && !Array.isArray(arch) && typeof arch['type'] === 'string') {
    return arch['type'].replace(/-/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
  }
  switch (element.kind) {
    case 'rect':
      return 'Rectangle';
    case 'line':
      return element.points.length > 2 ? 'Polyline' : 'Line';
    case 'text':
      return element.text.trim().split('\n')[0]?.slice(0, 32) || 'Text';
    case 'image':
      return 'Image';
    case 'group':
      return 'Group';
    case 'instance':
      return doc.definitions[element.definitionId]?.name ?? 'Asset';
  }
}

function KindIcon({ element }: { element: Element }): ReactNode {
  const size = 14;
  if (element.meta?.['parametricGraph']) return <FolderCog size={size} />;
  if (element.meta?.['parametricMarker']) return <Workflow size={size} />;
  // A camera/section: the origin, the view it shows, and the marker it looks from.
  if (element.meta?.['viewRig']) return <Crosshair size={size} />;
  if (element.meta?.['view3d']) return <AppWindow size={size} />;
  if (element.meta?.['cameraMarker']) return <Camera size={size} />;
  if (element.meta?.['sectionLine']) return <Scissors size={size} />;
  if (element.meta?.['planRegion']) return <SquareDashed size={size} />;
  if (element.meta?.['paper']) {
    return <Square size={size} />;
  }
  if (element.meta?.['level']) {
    return <Layers size={size} />;
  }
  switch (element.kind) {
    case 'rect':
      return <Square size={size} />;
    case 'line':
      return <Slash size={size} />;
    case 'text':
      return <Type size={size} />;
    case 'image':
      return <ImageIcon size={size} />;
    case 'group':
      return <Folder size={size} />;
    case 'instance':
      return <Box size={size} />;
  }
}

const LayerRow = memo(function LayerRow({ id, depth, parentId }: { id: string; depth: number; parentId?: string | null }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const { onRowSelect } = useContext(TreeContext);
  const element = useAppState((s) => s.doc.elements[id]);
  const graphComponent = useAppState((s) => { const item = s.doc.elements[id]; return item?.meta?.['parametricGraph'] ? item : item?.meta?.['parametricMarker'] && item.parentId ? s.doc.elements[item.parentId] : undefined; });
  const label = useAppState((s) => (s.doc.elements[id] ? elementLabel(s.doc.elements[id]!, s.doc) : ''));
  const selected = useAppState((s) => s.ui.selection.includes(id));
  const childIds = useAppStateShallow((s) => {
    const current = s.doc.elements[id];
    const isStair = (current?.meta?.['arch'] as { type?: string } | undefined)?.type === 'stair';
    const children = layerChildrenOf(s.doc.elements, id);
    // Hide generated tread/riser drawing primitives, but expose attached railings and any
    // other user-owned layers nested beneath the parametric stair.
    return (isStair ? children.filter((childId) => typeof s.doc.elements[childId]?.meta?.['role'] !== 'string') : children).reverse();
  });
  const [open, setOpen] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [dropPosition, setDropPosition] = useState<'above' | 'inside' | 'below' | null>(null);
  if (!element) return null;
  // Stairs are one parametric element: their tread primitives are not listed.
  // Every layer may own nested layers. Groups and papers are explicit containers, but
  // ordinary drawing/architectural elements are also useful hosts for annotations and
  // related geometry (for example, a measurement attached to a wall).
  const isContainer = true;
  const expandable = isContainer || childIds.length > 0;

  return (
    <>
      <div
        className={styles.row}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={expandable ? open : undefined}
        tabIndex={0}
        draggable
        data-layer-id={id}
        title={element.meta?.['parametricGraph'] ? 'Parametric component folder · drag elements inside' : element.meta?.['parametricMarker'] ? 'Graph origin · double-click to open graph' : undefined}
        data-selected={selected || undefined}
        data-graph={!!graphComponent || undefined}
        data-hidden={!element.visible || undefined}
        data-flagged={!element.visible || element.locked || undefined}
        data-drop-position={dropPosition ?? undefined}
        style={{ paddingLeft: 4 + depth * 14 }}
        onDragStart={(e) => {
          e.dataTransfer.setData(LAYER_DRAG_TYPE, id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(LAYER_DRAG_TYPE)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          const bounds = e.currentTarget.getBoundingClientRect();
          const ratio = (e.clientY - bounds.top) / bounds.height;
          const next = isContainer && ratio >= 0.28 && ratio <= 0.72 ? 'inside' : ratio < 0.5 ? 'above' : 'below';
          if (dropPosition !== next) setDropPosition(next);
        }}
        onDragLeave={() => setDropPosition(null)}
        onDrop={(e) => {
          const dragged = e.dataTransfer.getData(LAYER_DRAG_TYPE);
          const position = dropPosition;
          setDropPosition(null);
          if (!dragged) return;
          e.preventDefault();
          e.stopPropagation();
          if (dragged === id) return;
          if (position === 'inside' && isContainer) void dispatch('reparent-element', { id: dragged, parentId: id });
          else void dispatch('reparent-element', { id: dragged, parentId: parentId ?? element.parentId, targetId: id, placement: position === 'below' ? 'behind' : 'front' });
        }}
        onClick={(e) => onRowSelect(id, e)}
        onDoubleClick={() => {
          if (element.meta?.['parametricMarker'] && element.parentId) { void dispatch('open-parametric-editor', { id: element.parentId }); return; }
          setDraft(element.name ?? '');
          setRenaming(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void dispatch('select', { ids: [id] });
          if (e.key === 'F2') {
            setDraft(element.name ?? '');
            setRenaming(true);
          }
        }}
        data-testid={`layer-${id}`}
      >
        {expandable ? (
          <button
            type="button"
            className={styles.chevron}
            aria-label={t(open ? 'Collapse' : 'Expand')}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(!open);
            }}
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className={styles.chevronSpacer} />
        )}
        <span className={styles.kindIcon}>
          <KindIcon element={element} />
        </span>
        {renaming ? (
          <input
            className={styles.rename}
            value={draft}
            autoFocus
            aria-label={t('Layer name')}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={() => {
              setRenaming(false);
              void dispatch('rename', { id, name: draft });
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <span className={styles.label}>{t(label)}</span>
        )}
        <span className={styles.actions}>
          {graphComponent?.meta?.['parametricGraph'] && <button type="button" className={styles.miniButton} aria-label={graphRuntimeOf(graphComponent).status === 'running' ? 'Stop graph' : 'Start graph'} title={graphRuntimeOf(graphComponent).message ?? (graphRuntimeOf(graphComponent).status === 'running' ? 'Running · click to stop' : 'Start live graph')} onClick={(event) => { event.stopPropagation(); void dispatch(graphRuntimeOf(graphComponent).status === 'running' ? 'stop-parametric-graph' : 'start-parametric-graph', { id: graphComponent.id }); }}>{graphRuntimeOf(graphComponent).status === 'running' ? '■' : '▶'}</button>}
          <button
            type="button"
            className={styles.miniButton}
            data-on={!element.visible || undefined}
            aria-label={t(element.visible ? 'Hide' : 'Show')}
            title={t(element.visible ? 'Hide' : 'Show')}
            onClick={(e) => {
              e.stopPropagation();
              void dispatch('set-property', { ids: [id], key: 'visible', value: !element.visible });
            }}
          >
            {element.visible ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
          <button
            type="button"
            className={styles.miniButton}
            data-on={element.locked || undefined}
            aria-label={t(element.locked ? 'Unpin' : 'Pin')}
            title={t(element.locked ? 'Unpin' : 'Pin')}
            onClick={(e) => {
              e.stopPropagation();
              void dispatch('set-property', { ids: [id], key: 'locked', value: !element.locked });
            }}
          >
            {element.locked ? <Pin size={13} /> : <PinOff size={13} />}
          </button>
        </span>
      </div>
      {open && childIds.map((childId) => <LayerRow key={childId} id={childId} depth={depth + 1} parentId={id} />)}
      {open && !!locationOf(element)?.boundary?.length && <button type="button" className={styles.row} style={{ paddingInlineStart: (depth + 1) * 16 + 24 }} onClick={(event) => onRowSelect(id, event)} title="Visual reference only; excluded from analysis">
        <SquareDashed size={14} /><span className={styles.label}>Site boundary · {siteArea(locationOf(element)!.boundary!).toLocaleString(undefined, { maximumFractionDigits: 1 })} m²</span>
      </button>}
    </>
  );
});

function LayerChildren({ parentId, depth }: { parentId: string | null; depth: number }) {
  // Front-most first, matching both the board paint order and designers' layer-list convention.
  const ids = useAppStateShallow((s) => layerChildrenOf(s.doc.elements, parentId).reverse());
  return (
    <>
      {ids.map((id) => (
        <LayerRow key={id} id={id} depth={depth} parentId={parentId} />
      ))}
    </>
  );
}

/** `rootId` shows one element's layers only (sheet mode: the open paper). */
export function LayersTree({ rootId = null }: { rootId?: string | null } = {}) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const { store } = useApp();
  const treeRef = useRef<HTMLDivElement>(null);
  const lastAnchorIdRef = useRef<string | null>(null);
  const [draggingLayer, setDraggingLayer] = useState(false);
  const [rootDropping, setRootDropping] = useState(false);

  const handleRowSelect = useCallback(
    (id: string, e: React.MouseEvent) => {
      if (e.shiftKey && treeRef.current) {
        const rowElements = Array.from(treeRef.current.querySelectorAll<HTMLElement>('[data-layer-id]'));
        const allIds = rowElements.map((el) => el.getAttribute('data-layer-id')!).filter(Boolean);
        const anchorId = lastAnchorIdRef.current ?? store.getState().ui.selection[0] ?? id;
        const anchorIdx = allIds.indexOf(anchorId);
        const currentIdx = allIds.indexOf(id);
        if (anchorIdx !== -1 && currentIdx !== -1) {
          const start = Math.min(anchorIdx, currentIdx);
          const end = Math.max(anchorIdx, currentIdx);
          const rangeIds = allIds.slice(start, end + 1);
          void dispatch('select', { ids: rangeIds, mode: 'replace' });
          return;
        }
      }
      lastAnchorIdRef.current = id;
      const isToggle = e.metaKey || e.ctrlKey;
      void dispatch('select', { ids: [id], mode: isToggle ? 'toggle' : 'replace' });
    },
    [dispatch, store],
  );

  // Every row reads this context: a new object per render would re-render the whole tree (hundreds
  // of memoised rows) on each document edit.
  const treeContext = useMemo(() => ({ onRowSelect: handleRowSelect }), [handleRowSelect]);

  const isEmpty = useAppState((s) => Object.keys(s.doc.elements).length === 0);
  if (isEmpty) return <div className={styles.empty}>{t('Nothing on the board yet.')}</div>;

  return (
    <TreeContext.Provider value={treeContext}>
      <div
        ref={treeRef}
        role="tree"
        aria-label={t('Layers')}
        className={styles.tree}
        onDragStart={() => setDraggingLayer(true)}
        onDragEnd={() => {
          setDraggingLayer(false);
          setRootDropping(false);
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(LAYER_DRAG_TYPE)) e.preventDefault();
        }}
        onDrop={(e) => {
          // Dropping on the empty part of the tree lifts an element out of its parent/host.
          const dragged = e.dataTransfer.getData(LAYER_DRAG_TYPE);
          if (!dragged) return;
          e.preventDefault();
          void dispatch('reparent-element', { id: dragged, parentId: rootId });
        }}
      >
        <LayerChildren parentId={rootId} depth={0} />
        <div
          className={styles.rootDrop}
          data-active={draggingLayer || undefined}
          data-dropping={rootDropping || undefined}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(LAYER_DRAG_TYPE)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            setRootDropping(true);
          }}
          onDragLeave={() => setRootDropping(false)}
          onDrop={(e) => {
            const dragged = e.dataTransfer.getData(LAYER_DRAG_TYPE);
            setRootDropping(false);
            setDraggingLayer(false);
            if (!dragged) return;
            e.preventDefault();
            e.stopPropagation();
            void dispatch('reparent-element', { id: dragged, parentId: rootId });
          }}
          data-testid="layers-root-drop"
        >
          {t(rootId ? 'Move to sheet' : 'Move to board root')}
        </div>
      </div>
    </TreeContext.Provider>
  );
}

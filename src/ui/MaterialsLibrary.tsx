/**
 * The Materials tab of the left panel, organised like the Assets tab:
 * - **Project**: the document's materials (plus the built-in defaults every slot starts with);
 * - **Library**: ArchAI's default materials on R2 (src/materials/library.ts), added on click;
 * - **My materials**: the user's own materials on this device (uploaded images / packs, or saved
 *   from a project), reusable in every project.
 * New materials come from presets, images, the internet or blank; the material "in hand" is what
 * the 3D paint tool and drag-and-drop apply.
 */
import { Brush, ChevronRight, Copy, Folder, Globe, Loader2, MoreHorizontal, MousePointer2, Pencil, Plus, Replace, Save, SlidersHorizontal, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type DragEvent, type ReactNode } from 'react';
import lp from './LeftPanel.module.css';
import { useAccount, useApp, useAppState, useDispatch } from '@/app/context';
import { LibrarySignIn } from './LibrarySignIn';
import type { Material } from '@/document';
import { DEFAULT_MATERIAL_IDS, isDefaultMaterialId, PRESETS } from '@/materials/builtin';
import { materialById } from '@/materials/slots';
import { swatchUrl } from '@/materials/swatch';
import { MATERIAL_DRAG_TYPE, LIBRARY_DRAG_TYPE, materialUi, useMaterialUi } from '@/materials/uiStore';
import { deleteMyMaterial, importPackToMyMaterials, libraryMaterialToProject, listMyMaterials, loadMaterialLibrary, myMaterialToProject, onMyMaterialsChange, projectCopy, saveToMyMaterials, searchLibrary, type LibraryMaterial, type MaterialLibrary, type MyMaterial } from '@/materials/library';
import { elementsUsingMaterial } from '@/commands/builtin/materials';
import { bytesToBase64 } from '@/persistence/base64';
import { Menu, type MenuContent } from './primitives';
import styles from './MaterialsLibrary.module.css';
import { OnlineMaterials } from './OnlineMaterials';
import { useI18n } from './i18n';

const CATEGORY_LABELS: Record<Material['category'], string> = {
  masonry: 'Masonry', concrete: 'Concrete', wood: 'Wood', metal: 'Metal', glass: 'Glass', stone: 'Stone', tile: 'Tile', finish: 'Finishes', fabric: 'Fabric', other: 'Other',
};

/** Reads an image file's pixel size (needed for the blob record). */
async function imageSize(bytes: Uint8Array, mime: string): Promise<{ width: number; height: number }> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { width: 0, height: 0 };
  }
}

export function Swatch({ material, size = 'normal' }: { material: Material; size?: 'normal' | 'small' | 'card' }) {
  const blobs = useAppState((s) => s.doc.blobs);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const url = swatchUrl(material, { blobs }, redraw);
  return <span className={styles.swatch} data-size={size} style={url ? { backgroundImage: `url(${url})` } : { background: material.color }} aria-hidden />;
}

export function MaterialsLibrary() {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const { platform, toasts } = useApp();
  const doc = useAppState((s) => s.doc);
  const ui = useMaterialUi();
  const view3dOpen = useAppState((s) => s.ui.view3d.open);
  /** Takes the brush: painting happens in the 3D workspace, opened if needed. */
  const startPainting = (id: string) => {
    materialUi.set({ active: id, painting: true });
    if (!view3dOpen) void dispatch('open-view3d', {});
  };
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuContent } | null>(null);
  const packInput = useRef<HTMLInputElement>(null);
  const mineInput = useRef<HTMLInputElement>(null);
  const [online, setOnline] = useState(false);
  const [tab, setTab] = useState<'project' | 'library' | 'mine'>('project');
  const [library, setLibrary] = useState<MaterialLibrary | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [group, setGroup] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, true>>({});
  const [mine, setMine] = useState<MyMaterial[] | null>(null);
  const store = useApp().store;

  const accountState = useAccount();
  const userId = accountState.status === 'signed-in' ? accountState.user.id : null;
  // Loaded up front: the source tabs show their counts. Signing in or out reloads it.
  useEffect(() => {
    setLibrary(null);
    setLibraryError(null);
    if (!userId) return;
    loadMaterialLibrary().then(setLibrary, (error: unknown) => setLibraryError(error instanceof Error ? error.message : String(error)));
  }, [userId]);
  const refreshMine = useCallback(() => void listMyMaterials(platform).then(setMine), [platform]);
  useEffect(() => refreshMine(), [refreshMine]);
  useEffect(() => onMyMaterialsChange(refreshMine), [refreshMine]);

  /** Adds a library / My materials entry (once) and takes it in hand. */
  const take = async (key: string, add: () => Promise<string>, name: string) => {
    if (busy[key]) return;
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      const id = await add();
      materialUi.set({ active: id });
      toasts.push({ kind: 'success', message: `${name} ${t('is in hand: paint it in 3D or assign it in the Inspector')}` });
    } catch (error) {
      toasts.push({ kind: 'error', message: `${name}: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[key];
        return next;
      });
    }
  };
  const fromLibrary = (entry: LibraryMaterial) => take(`library:${entry.id}`, () => libraryMaterialToProject(dispatch, store.getState().doc, entry), entry.name);
  const fromMine = (entry: MyMaterial) => take(`mine:${entry.id}`, () => myMaterialToProject(dispatch, store.getState().doc, platform, entry), entry.name);
  const saveMine = async (materials: Material[]) => {
    try {
      const saved = await saveToMyMaterials(platform, store.getState().doc, materials);
      toasts.push({ kind: 'success', message: t(`Saved ${saved.length} material(s) to My materials`) });
    } catch (error) {
      toasts.push({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };
  /** My materials upload: packs (.cai) or images (one material each). */
  const uploadMine = async (files: FileList) => {
    const made: Material[] = [];
    const blobs: Record<string, { id: string; mime: string; data: string; width: number; height: number }> = {};
    let count = 0;
    for (const file of Array.from(files)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        if (/\.(cai|zip)$/i.test(file.name)) {
          count += (await importPackToMyMaterials(platform, bytes)).length;
          continue;
        }
        const mime = file.type || 'image/jpeg';
        const size = await imageSize(bytes, mime);
        const blobId = `img${Date.now().toString(36)}${made.length}`;
        blobs[blobId] = { id: blobId, mime, data: bytesToBase64(bytes), width: size.width, height: size.height };
        made.push({ ...PRESETS.find((p) => p.id === 'preset:plaster')!, id: blobId, name: file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Image material', category: 'other', color: '#ffffff', roughness: 0.8, map: { blobId }, tileWidth: 1000, tileHeight: size.width > 0 ? Math.round((1000 * size.height) / size.width) : 1000 });
      } catch (error) {
        toasts.push({ kind: 'error', message: `${file.name}: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    if (made.length) count += (await saveToMyMaterials(platform, { blobs }, made)).length;
    if (count) toasts.push({ kind: 'success', message: t(`Added ${count} material(s) to My materials`) });
  };

  const own = useMemo(() => Object.values(doc.materials).filter((material) => !DEFAULT_MATERIAL_IDS.includes(material.id)), [doc.materials]);
  const defaults = useMemo(() => DEFAULT_MATERIAL_IDS.map((id) => materialById(doc, id)).filter((material): material is Material => material !== null), [doc]);
  const match = (material: Material) => !query.trim() || material.name.toLowerCase().includes(query.trim().toLowerCase()) || material.category.includes(query.trim().toLowerCase());

  const pick = (id: string) => materialUi.set({ active: ui.active === id ? null : id });
  const edit = (id: string) => materialUi.set({ editing: id, active: id });

  const create = async (input: Record<string, unknown>) => {
    const result = await dispatch('create-material', input);
    if (result.ok) materialUi.set({ active: result.value as string });
    return result.ok ? (result.value as string) : null;
  };

  const fromImage = async () => {
    const file = await platform.files.openImage();
    if (!file) return;
    const size = await imageSize(file.bytes, file.mime);
    const name = file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Image material';
    const id = await create({ material: { name, color: '#ffffff', tileWidth: 1000, tileHeight: size.width > 0 ? Math.round((1000 * size.height) / size.width) : 1000 } });
    if (!id) return;
    await dispatch('set-material-texture', { id, channel: 'map', blob: { mime: file.mime, data: bytesToBase64(file.bytes), width: size.width, height: size.height } });
    edit(id);
  };

  const newMenu = (x: number, y: number) => {
    const byCategory = new Map<string, Material[]>();
    for (const preset of PRESETS) byCategory.set(preset.category, [...(byCategory.get(preset.category) ?? []), preset]);
    const entries: MenuContent = [
      { id: 'blank', label: 'Blank material', onSelect: () => void create({}).then((id) => id && edit(id)) },
      { id: 'online', label: 'From the internet…', icon: <Globe size={13} />, onSelect: () => setOnline(true) },
      { id: 'image', label: 'From image…', onSelect: () => void fromImage() },
      { id: 'pack', label: 'Import material pack (.cai)…', onSelect: () => packInput.current?.click() },
      { id: 'export', label: 'Export project materials…', disabled: own.length === 0, onSelect: () => void dispatch('export-material-pack', { ids: own.map((material) => material.id) }) },
      { separator: true },
    ];
    for (const [category, presets] of byCategory) {
      entries.push({ title: CATEGORY_LABELS[category as Material['category']] });
      for (const preset of presets) entries.push({ id: preset.id, label: preset.name, onSelect: () => void create({ preset: preset.id }) });
    }
    setMenu({ x, y, entries });
  };

  const remove = async (material: Material) => {
    const users = elementsUsingMaterial(doc, material.id).length;
    if (users > 0 && !window.confirm(t(`${material.name} is used by ${users} element(s). Delete it and return them to their defaults?`))) return;
    const result = await dispatch('delete-material', { id: material.id });
    if (result.ok) {
      if (ui.active === material.id) materialUi.set({ active: null });
      toasts.push({ kind: 'info', message: t(`Deleted ${material.name} (Ctrl+Z to undo)`) });
    }
  };

  const itemMenu = (material: Material, x: number, y: number, isDefault: boolean) => {
    const inHand = ui.active && ui.active !== material.id ? materialById(doc, ui.active) : null;
    const selection = store.getState().ui.selection;
    const users = elementsUsingMaterial(doc, material.id);
    const entries: MenuContent = [
      { id: 'edit', label: 'Edit…', icon: <Pencil size={13} />, onSelect: () => edit(material.id) },
      { id: 'paint', label: 'Paint with it', icon: <Brush size={13} />, onSelect: () => startPainting(material.id) },
      {
        id: 'apply-selection',
        label: selection.length ? `Apply to selected (${selection.length}, every part)` : 'Apply to selected objects',
        disabled: selection.length === 0,
        onSelect: () => void dispatch('paint-element', { ids: selection, materialId: material.id }).then((result) => !result.ok && toasts.push({ kind: 'error', message: result.error.message })),
      },
      {
        id: 'replace',
        label: inHand ? `Replace everywhere with ${inHand.name}` : 'Replace everywhere… (take another material in hand first)',
        icon: <Replace size={13} />,
        disabled: !inHand,
        onSelect: () => inHand && void dispatch('replace-material', { from: material.id, to: inHand.id }).then((result) => result.ok && toasts.push({ kind: 'success', message: t(`Replaced ${material.name} with ${inHand.name} (${String(result.value)} element(s))`) })),
      },
      { id: 'select-users', label: `Select objects using it (${users.length})`, icon: <MousePointer2 size={13} />, disabled: users.length === 0, onSelect: () => void dispatch('select', { ids: users.map((element) => element.id), mode: 'replace' }) },
      { separator: true },
      { id: 'duplicate', label: 'Duplicate', icon: <Copy size={13} />, onSelect: () => void dispatch('duplicate-material', { id: material.id }).then((result) => result.ok && materialUi.set({ active: result.value as string })) },
      { id: 'save-mine', label: 'Save to My materials', icon: <Save size={13} />, onSelect: () => void saveMine([material]) },
    ];
    if (isDefault) {
      if (doc.materials[material.id]) entries.push({ id: 'reset', label: 'Reset to default', onSelect: () => void dispatch('delete-material', { id: material.id }) });
    } else entries.push({ separator: true }, { id: 'delete', label: 'Delete', icon: <Trash2 size={13} />, onSelect: () => void remove(material) });
    setMenu({ x, y, entries });
  };

  const searching = query.trim().length > 0;
  const libraryAll = library?.materials ?? [];
  const libraryShown = library ? searchLibrary(libraryAll, query, searching ? null : group) : [];
  const mineShown = (mine ?? []).filter((entry) => !searching || entry.name.toLowerCase().includes(query.trim().toLowerCase()) || entry.category.includes(query.trim().toLowerCase()));
  const showDefaults = group === 'defaults';
  const projectShown = searching ? [...own, ...defaults].filter(match) : showDefaults ? defaults : own;
  const metres = (mm: number) => (mm >= 1000 ? `${+(mm / 1000).toFixed(2)} m` : `${Math.round(mm)} mm`);
  const sizeOf = (material: Material) => (material.map ? `${metres(material.tileWidth)} × ${metres(material.tileHeight)}` : CATEGORY_LABELS[material.category]);
  const counts = { project: own.length, library: libraryAll.length, mine: mine?.length ?? 0 };

  /** A card like the Assets tab's: image, name, size; hover actions; drag onto a surface in 3D. */
  const card = (key: string, name: string, meta: string, image: ReactNode, options: { active?: boolean; added?: boolean; onClick: () => void; onDoubleClick?: () => void; onMenu?: (x: number, y: number) => void; drag: (event: DragEvent) => void; actions?: ReactNode; testId: string }) => (
    <div
      key={key}
      className={lp.assetCard}
      data-active={options.active || undefined}
      draggable
      title={`${name}\n${t('Click: take in hand · Double-click: edit · Drag onto a surface in 3D')}`}
      onDragStart={options.drag}
      onClick={options.onClick}
      onDoubleClick={options.onDoubleClick}
      onContextMenu={(event) => {
        if (!options.onMenu) return;
        event.preventDefault();
        options.onMenu(event.clientX, event.clientY);
      }}
      data-testid={options.testId}
    >
      {options.added && <span className={lp.localBadge}>{t('In project')}</span>}
      {options.actions && <div className={lp.cardActions} onClick={(event) => event.stopPropagation()}>{options.actions}</div>}
      <span className={styles.cardImage}>
        {image}
        {busy[key] && <Loader2 size={18} className={styles.spin} />}
      </span>
      <span className={lp.assetName}>{name}</span>
      <span className={lp.assetMeta}>{meta}</span>
    </div>
  );
  const action = (title: string, icon: ReactNode, onClick: () => void, danger = false) => (
    <button type="button" className={`${lp.cardActionBtn}${danger ? ` ${lp.cardActionBtnDanger}` : ''}`} title={t(title)} onClick={onClick}>
      {icon}
    </button>
  );

  const projectCard = (material: Material, isDefault = false) =>
    card(material.id, material.name, isDefault ? `${t('Default')} · ${sizeOf(material)}` : sizeOf(material), <Swatch material={material} size="card" />, {
      active: ui.active === material.id,
      onClick: () => pick(material.id),
      onDoubleClick: () => edit(material.id),
      onMenu: (x, y) => itemMenu(material, x, y, isDefault),
      drag: (event) => {
        event.dataTransfer.setData(MATERIAL_DRAG_TYPE, material.id);
        event.dataTransfer.effectAllowed = 'copy';
        materialUi.set({ active: material.id });
      },
      actions: (
        <>
          {action('Paint with it in 3D', <Brush size={12} />, () => startPainting(material.id))}
          {action('Edit', <Pencil size={12} />, () => edit(material.id))}
          {action('More…', <MoreHorizontal size={12} />, () => {
            const rect = document.querySelector(`[data-testid="material-${material.id}"]`)?.getBoundingClientRect();
            itemMenu(material, rect ? rect.right : 200, rect ? rect.top + 24 : 200, isDefault);
          })}
        </>
      ),
      testId: `material-${material.id}`,
    });

  const header = (
    <>
      <div className={lp.libraryHeaderRow}>
        <h3 className="u-section-title" style={{ margin: 0 }}>
          {t('Materials')}
        </h3>
        <div className={lp.libraryActions}>
          <button type="button" className={`${lp.actionBtn} ${lp.actionBtnPrimary}`} onClick={(event) => newMenu(event.currentTarget.getBoundingClientRect().left, event.currentTarget.getBoundingClientRect().bottom + 4)} title={t('New material: blank, from an image, from the internet or a preset')} data-testid="create-material-btn">
            <Plus size={12} />
            {t('Create')}
          </button>
          <button type="button" className={lp.actionBtn} onClick={() => mineInput.current?.click()} title={t('Upload images or material packs (.cai) to your Local materials')} data-testid="upload-my-materials">
            <Upload size={12} />
            {t('Upload')}
          </button>
        </div>
      </div>
      <div className={lp.sourceNav} role="tablist" aria-label={t('Material source')}>
        {(
          [
            ['project', 'Project'],
            ['library', 'Online'],
            ['mine', 'Local'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={lp.sourceTab}
            data-active={tab === value || undefined}
            onClick={() => {
              setTab(value);
              setGroup(null);
            }}
            data-testid={`materials-tab-${value}`}
          >
            <span>{t(label)}</span>
            <span className={lp.sourceBadge}>{counts[value]}</span>
          </button>
        ))}
      </div>
      <input className={styles.search} placeholder={t(tab === 'library' ? 'Search: brick, oak, marble…' : 'Search materials')} value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t('Search materials')} />
      {ui.active && materialById(doc, ui.active) && (
        <div className={styles.inHand}>
          <Swatch material={materialById(doc, ui.active)!} size="small" />
          <span title={t('The material in hand')}>{materialById(doc, ui.active)!.name}</span>
          <button type="button" data-active={ui.painting || undefined} onClick={() => (ui.painting ? materialUi.set({ painting: false }) : startPainting(ui.active!))} title={t('Paint surfaces in the 3D view (B)')}>
            <Brush size={13} /> {t('Paint')}
          </button>
          <button type="button" onClick={() => materialUi.set({ adjusting: { materialId: ui.active!, target: null } })} title={t('Scale, rotation, colour… (in the 3D view, or pick from the model with Pick)')} data-testid="adjust-in-hand">
            <SlidersHorizontal size={13} />
          </button>
        </div>
      )}
    </>
  );

  const crumbs = (root: string, current: string | null) => (
    <nav className={lp.crumbs} aria-label={t('Material folders')}>
      <button type="button" className={current ? lp.crumb : lp.crumbCurrent} onClick={() => setGroup(null)}>
        {t(root)}
      </button>
      {current && (
        <>
          <ChevronRight size={12} />
          <span className={lp.crumbCurrent}>{t(current)}</span>
        </>
      )}
    </nav>
  );
  const folder = (key: string, label: string, count: number) => (
    <button key={key} type="button" className={lp.folder} onClick={() => setGroup(key)} data-testid={`material-folder-${key}`}>
      <Folder size={14} className="u-muted" />
      <span className="u-truncate">{t(label)}</span>
      <span className={lp.folderCount}>{count}</span>
    </button>
  );

  return (
    <div className={styles.library} data-testid="materials-library">
      {header}
      <input
        ref={packInput}
        type="file"
        accept=".cai,.zip"
        hidden
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          const result = await dispatch('import-material-pack', { data: bytesToBase64(new Uint8Array(await file.arrayBuffer())) });
          if (result.ok) toasts.push({ kind: 'success', message: t(`Imported ${(result.value as string[]).length} material(s)`) });
        }}
      />
      <input
        ref={mineInput}
        type="file"
        accept=".cai,.zip,image/png,image/jpeg,image/webp"
        multiple
        hidden
        onChange={(event) => {
          const files = event.target.files;
          const input = event.target;
          if (files?.length) {
            setTab('mine');
            void uploadMine(files).finally(() => (input.value = ''));
          }
        }}
      />

      {tab === 'project' && (
        <>
          {!searching && crumbs('Project', showDefaults ? 'Defaults' : null)}
          {!searching && !showDefaults && folder('defaults', 'Defaults', defaults.length)}
          {projectShown.length > 0 ? (
            <div className={lp.grid}>{projectShown.map((material) => projectCard(material, isDefaultMaterialId(material.id)))}</div>
          ) : (
            <div className={lp.empty}>
              {t(searching ? 'No match' : 'No materials in this project yet.')}
              {!searching && (
                <div style={{ marginTop: 8 }}>
                  <button type="button" className={`${lp.actionBtn} ${lp.actionBtnPrimary}`} onClick={() => setTab('library')}>
                    <Globe size={12} /> {t('Browse online materials')}
                  </button>
                </div>
              )}
            </div>
          )}
          {showDefaults && <p className={styles.hint}>{t('What each part shows until it gets a material. Edit one to change it everywhere.')}</p>}
        </>
      )}

      {tab === 'library' && (
        <>
          {!userId && <LibrarySignIn className={lp.notice} what="material" />}
          {userId && libraryError && <div className={lp.notice}>{t('The material library could not be reached')} ({libraryError}).</div>}
          {userId && !library && !libraryError && <div className={lp.notice}>{t('Loading the library…')}</div>}
          {library && !searching && crumbs('Online', group)}
          {library && !searching && !group && library.groups.map((name) => folder(name, name, libraryAll.filter((m) => m.group === name).length))}
          {library && (searching || group) && (
            <div className={lp.grid}>
              {libraryShown.map((entry) => {
                const added = projectCopy(doc, `library:${entry.id}`);
                return card(`library:${entry.id}`, entry.name, `${entry.group} · ${metres(entry.size[0])}`, <img src={entry.thumb} alt="" loading="lazy" draggable={false} />, {
                  active: Boolean(added && ui.active === added.id),
                  added: Boolean(added),
                  onClick: () => (added ? pick(added.id) : void fromLibrary(entry)),
                  onDoubleClick: added ? () => edit(added.id) : undefined,
                  drag: (event) => {
                    if (added) event.dataTransfer.setData(MATERIAL_DRAG_TYPE, added.id);
                    else event.dataTransfer.setData(LIBRARY_DRAG_TYPE, JSON.stringify({ kind: 'library', id: entry.id }));
                    event.dataTransfer.effectAllowed = 'copy';
                  },
                  testId: `material-source-library:${entry.id}`,
                });
              })}
            </div>
          )}
          {library && searching && libraryShown.length === 0 && <div className={lp.empty}>{t('No match')}</div>}
          <p className={styles.hint}>
            {t('Scanned materials from Poly Haven (CC0).')}{' '}
            <button type="button" className={styles.link} onClick={() => setOnline(true)}>
              {t('Search all 700 online')}
            </button>
          </p>
        </>
      )}

      {tab === 'mine' && (
        <>
          {mine && mineShown.length > 0 ? (
            <div className={lp.grid}>
              {mineShown.map((entry) => {
                const added = projectCopy(doc, `mine:${entry.id}`);
                return card(`mine:${entry.id}`, entry.name, CATEGORY_LABELS[entry.category], entry.thumb ? <img src={entry.thumb} alt="" draggable={false} /> : <span />, {
                  active: Boolean(added && ui.active === added.id),
                  added: Boolean(added),
                  onClick: () => (added ? pick(added.id) : void fromMine(entry)),
                  drag: (event) => {
                    if (added) event.dataTransfer.setData(MATERIAL_DRAG_TYPE, added.id);
                    else event.dataTransfer.setData(LIBRARY_DRAG_TYPE, JSON.stringify({ kind: 'mine', id: entry.id }));
                    event.dataTransfer.effectAllowed = 'copy';
                  },
                  actions: action('Remove from Local', <Trash2 size={12} />, () => void deleteMyMaterial(platform, entry.id), true),
                  testId: `material-source-mine:${entry.id}`,
                });
              })}
            </div>
          ) : (
            <div className={lp.empty}>
              {t(mine?.length ? 'No match' : 'Your own materials, on this device, for every project. Upload images or packs, or right-click a project material → Save to Local.')}
              <div style={{ marginTop: 8, display: 'flex', gap: 6, justifyContent: 'center' }}>
                <button type="button" className={`${lp.actionBtn} ${lp.actionBtnPrimary}`} onClick={() => mineInput.current?.click()}>
                  <Upload size={12} /> {t('Upload')}
                </button>
                <button type="button" className={lp.actionBtn} disabled={own.length === 0} onClick={() => void saveMine(own)}>
                  <Save size={12} /> {t('Save project materials')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {online && <OnlineMaterials onClose={() => setOnline(false)} />}
      {menu && <Menu position={{ x: menu.x, y: menu.y }} entries={menu.entries} onClose={() => setMenu(null)} ariaLabel="Material" />}
    </div>
  );
}

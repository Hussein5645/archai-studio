import { Boxes, Check, ChevronDown, ExternalLink, FilePlus2, FolderOpen, Home, Languages, LayoutTemplate, PanelLeft, PanelRight, Plus, Redo2, Save, Search, Settings, Smartphone, Trash2, Undo2 } from 'lucide-react';
import { SettingsDialog } from './SettingsDialog';
import { AccountButton, CloudSyncState } from './AccountButton';
import { PeersBar } from './PeersBar';
import { LiveBridgeChip } from '@/bridge/LiveBridgePanel';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useApp, useAppState, useAvailable, useDispatch } from '@/app/context';
import { formatShortcut, IS_MAC } from '@/commands';
import { modelingStorage, type SavedAsset } from '@/modeling/persistence';
import { getProjectSyncChannel, type ProjectSyncMessage } from '@/modeling/projectSync';
import { IconButton } from './primitives';
import { useI18n } from './i18n';
import { useTouchMode } from './touch';
import styles from './TopBar.module.css';
import { BRAND_MARK } from './brand';

const ICON = 16;

interface LinkedModelItem {
  id: string;
  name: string;
  savedAt: string;
  isLiveOnly: boolean;
  bodiesCount: number;
  shapesCount: number;
  category?: string;
}

function LinkedModelsMenu() {
  const { t } = useI18n();
  const { platform, toasts } = useApp();
  const dispatch = useDispatch();
  const docId = useAppState((s) => s.doc.id);
  const [open, setOpen] = useState(false);
  const [savedAssets, setSavedAssets] = useState<SavedAsset[]>([]);
  const [activeSessions, setActiveSessions] = useState<Map<string, string>>(new Map());
  const menuRef = useRef<HTMLDivElement>(null);

  const refreshSaved = useCallback(async () => {
    try {
      const all = await modelingStorage.list();
      setSavedAssets(all.filter((item) => item.project?.id === docId));
    } catch {
      setSavedAssets([]);
    }
  }, [docId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshSaved(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshSaved]);

  // Sync active sessions and auto-refresh on project sync channel events
  useEffect(() => {
    const channel = getProjectSyncChannel();
    if (!channel) return;

    channel.postMessage({ type: 'REQUEST_MODELING_SESSIONS', projectId: docId });

    const onMessage = (event: MessageEvent) => {
      const msg = event.data as ProjectSyncMessage;
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'MODELING_SESSION_ANNOUNCE' && msg.projectId === docId) {
        setActiveSessions((prev) => {
          const next = new Map(prev);
          next.set(msg.assetId, msg.name);
          return next;
        });
        void refreshSaved();
      } else if (msg.type === 'MODELING_SESSION_CLOSED' && msg.projectId === docId) {
        setActiveSessions((prev) => {
          if (!prev.has(msg.assetId)) return prev;
          const next = new Map(prev);
          next.delete(msg.assetId);
          return next;
        });
      } else if (msg.type === 'PROJECT_DOC_UPDATE' && msg.projectId === docId) {
        void refreshSaved();
      }
    };

    channel.addEventListener('message', onMessage);
    return () => {
      channel.removeEventListener('message', onMessage);
      channel.close();
    };
  }, [docId, refreshSaved]);

  // Close menu on pointerdown outside
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void refreshSaved(), 0);
    const channel = getProjectSyncChannel();
    channel?.postMessage({ type: 'REQUEST_MODELING_SESSIONS', projectId: docId });

    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', close, true);
    return () => { window.clearTimeout(timer); channel?.close(); window.removeEventListener('pointerdown', close, true); };
  }, [open, docId, refreshSaved]);

  // Merge savedAssets and activeSessions
  const mergedItems: LinkedModelItem[] = useMemo(() => {
    const map = new Map<string, LinkedModelItem>();

    for (const item of savedAssets) {
      map.set(item.id, {
        id: item.id,
        name: item.metadata.name || 'Untitled Model',
        savedAt: item.savedAt,
        isLiveOnly: false,
        bodiesCount: item.bodies?.length ?? 0,
        shapesCount: item.sketches?.reduce((acc, s) => acc + s.shapes.length, 0) ?? 0,
        category: item.metadata.category,
      });
    }

    for (const [assetId, sessionName] of activeSessions.entries()) {
      const existing = map.get(assetId);
      if (existing) {
        existing.name = sessionName || existing.name;
      } else {
        map.set(assetId, {
          id: assetId,
          name: sessionName || 'Untitled Model',
          savedAt: new Date().toISOString(),
          isLiveOnly: true,
          bodiesCount: 0,
          shapesCount: 0,
        });
      }
    }

    return Array.from(map.values()).sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
  }, [savedAssets, activeSessions]);

  const handleOpenModel = (item: LinkedModelItem) => {
    setOpen(false);
    platform.window.openModeling({ assetId: item.id, name: item.name, projectId: docId });
  };

  const handleDeleteModel = async (e: React.MouseEvent, item: LinkedModelItem) => {
    e.stopPropagation();
    if (!window.confirm(t(`Permanently delete 3D model "${item.name}"? This cannot be undone.`))) return;
    await modelingStorage.delete(item.id);
    const channel = getProjectSyncChannel();
    channel?.postMessage({
      type: 'MODELING_SESSION_TERMINATE',
      projectId: docId,
      assetId: item.id,
    });
    toasts.push({ kind: 'info', message: t(`Deleted 3D model "${item.name}"`) });
    setActiveSessions((prev) => {
      if (!prev.has(item.id)) return prev;
      const next = new Map(prev);
      next.delete(item.id);
      return next;
    });
    void refreshSaved();
  };

  const handleCreateModel = () => {
    setOpen(false);
    void dispatch('open-modeling');
  };

  const totalCount = mergedItems.length;
  const hasActive = activeSessions.size > 0;

  return (
    <div className={styles.modelsMenuAnchor} ref={menuRef}>
      <button
        type="button"
        className={styles.modelsTopBarBtn}
        data-active={open || undefined}
        aria-expanded={open}
        aria-label={t('Linked 3D Models')}
        title={t('Linked 3D Models')}
        onClick={() => setOpen((prev) => !prev)}
        data-testid="topbar-linked-models-btn"
      >
        <Boxes size={ICON} />
        {hasActive && <span className={styles.liveIndicator} title={t('Open in tab')} />}
        {totalCount > 0 && <span className={styles.modelsCountBadge}>{totalCount}</span>}
      </button>

      {open && (
        <div className={styles.modelsDropdown} role="dialog" aria-label={t('Linked 3D Models')} data-testid="linked-models-dropdown">
          <div className={styles.modelsHeader}>
            <div className={styles.modelsHeaderTitle}>
              <Boxes size={14} className={styles.modelsHeaderIcon} />
              <span>{t('Linked 3D Models')}</span>
              <span className={styles.modelsHeaderBadge}>{totalCount}</span>
            </div>
            <button
              type="button"
              className={styles.modelsNewBtn}
              onClick={handleCreateModel}
              title={t('Model New 3D Element')}
              data-testid="linked-models-create-btn"
            >
              <Plus size={13} />
              <span>{t('New Model')}</span>
            </button>
          </div>

          <div className={styles.modelsList}>
            {mergedItems.length === 0 ? (
              <div className={styles.modelsEmpty}>
                <Boxes size={28} className={styles.emptyIcon} />
                <div className={styles.emptyTitle}>{t('No modeling files linked to this project yet')}</div>
                <button type="button" className={styles.emptyCreateBtn} onClick={handleCreateModel}>
                  <Plus size={13} />
                  <span>{t('Model New 3D Element')}</span>
                </button>
              </div>
            ) : (
              mergedItems.map((item) => {
                const isActive = activeSessions.has(item.id);
                return (
                  <div
                    key={item.id}
                    className={styles.modelRow}
                    onClick={() => handleOpenModel(item)}
                    title={t('Open in 3D Modeling')}
                    data-testid={`linked-model-row-${item.id}`}
                  >
                    <div className={styles.modelRowIcon}>
                      <Boxes size={16} />
                    </div>
                    <div className={styles.modelRowInfo}>
                      <div className={styles.modelRowName}>
                        <span>{item.name}</span>
                        {isActive && (
                          <span className={styles.liveBadge}>
                            <span className={styles.liveDot} />
                            {t('Open in tab')}
                          </span>
                        )}
                        <span className={styles.draftPill}>{t('Draft')}</span>
                      </div>
                      <div className={styles.modelRowMeta}>
                        {item.bodiesCount} {item.bodiesCount === 1 ? 'solid' : 'solids'} · {item.shapesCount} {item.shapesCount === 1 ? 'shape' : 'shapes'}
                        {item.category ? ` · ${item.category}` : ''}
                      </div>
                    </div>
                    <div className={styles.modelRowActions}>
                      <button
                        type="button"
                        className={styles.modelRowActionBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenModel(item);
                        }}
                        title={t('Open in 3D Modeling')}
                      >
                        <ExternalLink size={13} />
                        <span>{t('Open')}</span>
                      </button>
                      <button
                        type="button"
                        className={`${styles.modelRowActionBtn} ${styles.modelRowDangerBtn}`}
                        onClick={(e) => void handleDeleteModel(e, item)}
                        title={t('Delete modeling file')}
                        data-testid={`delete-model-${item.id}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CommandIconButton({ command, label, children }: { command: string; label: string; children: React.ReactNode }) {
  const dispatch = useDispatch();
  const available = useAvailable(command);
  return (
    <IconButton label={label} disabled={!available} onClick={() => void dispatch(command)} data-testid={`topbar-${command}`}>
      {children}
    </IconButton>
  );
}

export function TopBar() {
  const { platform, persistence, toasts } = useApp();
  const saveStatus = useSyncExternalStore((listener) => persistence.subscribe(listener), persistence.getSaveStatus, persistence.getSaveStatus);
  const { locale, setLocale, t } = useI18n();
  const { touchMode, setTouchMode, isTouch } = useTouchMode();
  const dispatch = useDispatch();
  const name = useAppState((s) => s.doc.meta.name);
  const dirty = useAppState((s) => s.session.dirty);
  const filePath = useAppState((s) => s.session.filePath);
  const leftOpen = useAppState((s) => s.ui.panels.left);
  const inspectorOpen = useAppState((s) => s.ui.panels.inspector);
  const [draft, setDraft] = useState(name);
  const [syncedName, setSyncedName] = useState(name);
  const [appMenuOpen, setAppMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!appMenuOpen) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setAppMenuOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [appMenuOpen]);
  // Ctrl / Cmd + , opens Settings, as in most desktop apps.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== ',' || !(IS_MAC ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      setSettingsOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (name !== syncedName) {
    // Adjust local state during render when the document name changes underneath us.
    setSyncedName(name);
    setDraft(name);
  }

  const shortcut = (s: string) => formatShortcut(s, IS_MAC);
  const needsSave = saveStatus === 'unsaved' || saveStatus === 'error' || Boolean(filePath && dirty);
  const stateText = t(saveStatus === 'saving' ? 'Saving…' : saveStatus === 'error' ? 'Save failed — retry' : needsSave ? 'Unsaved changes' : 'Saved');
  const saveProject = async () => {
    try {
      if (filePath) {
        const result = await dispatch('save-document');
        if (!result.ok || !result.value) return;
      }
      await persistence.saveNow();
    } catch (error) { toasts.push({ kind: 'error', message: error instanceof Error ? error.message : String(error) }); }
  };

  return (
    <header className={styles.topbar} data-ui-scale>
      <div className={styles.appMenuAnchor} ref={menuRef}>
        <button type="button" className={styles.mark} aria-label={t('ArchAI menu')} title={t('ArchAI menu')} aria-expanded={appMenuOpen} onClick={() => setAppMenuOpen((open) => !open)} data-testid="app-menu">
          <img className={styles.markLogo} src={BRAND_MARK} alt="ArchAI" draggable={false} />
          <ChevronDown size={10} />
        </button>
        <span className={styles.version} data-testid="app-version">v{__APP_VERSION__}</span>
        {appMenuOpen && (
          <div className={styles.appMenu} role="menu">
            {platform.kind === 'electron' && <>
              <button type="button" role="menuitem" onClick={() => { setAppMenuOpen(false); void dispatch('import-d5-folder'); }} data-testid="menu-import-d5">
                <span className={styles.menuItemIcon}><FolderOpen size={14} />{t('Import D5 project folder…')}</span>
              </button>
              <div className={styles.menuDivider} />
            </>}
            <div className={styles.menuTitle}><Languages size={14} />{t('Language')}</div>
            <button type="button" role="menuitemradio" aria-checked={locale === 'en'} onClick={() => { setLocale('en'); setAppMenuOpen(false); }}>
              <span>English</span>{locale === 'en' && <Check size={14} />}
            </button>
            <button type="button" role="menuitemradio" aria-checked={locale === 'ar'} onClick={() => { setLocale('ar'); setAppMenuOpen(false); }}>
              <span>العربية</span>{locale === 'ar' && <Check size={14} />}
            </button>
            <div className={styles.menuDivider} />
            <div className={styles.menuTitle}><Smartphone size={14} />{t('Touch Screen Mode')}</div>
            <button type="button" role="menuitemradio" aria-checked={touchMode === 'auto'} onClick={() => { setTouchMode('auto'); setAppMenuOpen(false); }}>
              <span>{t('Auto')}{touchMode === 'auto' && <small className={styles.menuNote}>{t(isTouch ? 'touch' : 'mouse')}</small>}</span>{touchMode === 'auto' && <Check size={14} />}
            </button>
            <button type="button" role="menuitemradio" aria-checked={touchMode === 'on'} onClick={() => { setTouchMode('on'); setAppMenuOpen(false); }}>
              <span>{t('On')}</span>{touchMode === 'on' && <Check size={14} />}
            </button>
            <button type="button" role="menuitemradio" aria-checked={touchMode === 'off'} onClick={() => { setTouchMode('off'); setAppMenuOpen(false); }}>
              <span>{t('Off')}</span>{touchMode === 'off' && <Check size={14} />}
            </button>
            <div className={styles.menuDivider} />
            <button type="button" role="menuitem" onClick={() => { setSettingsOpen(true); setAppMenuOpen(false); }} data-testid="open-settings">
              <span className={styles.menuItemIcon}><Settings size={14} />{t('Settings')}</span><kbd className="u-kbd">{shortcut('Mod+,')}</kbd>
            </button>
          </div>
        )}
        {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      </div>
      <IconButton label={t('Go to Home Screen')} onClick={() => void dispatch('go-home')} data-testid="topbar-go-home">
        <Home size={ICON} />
      </IconButton>
      <input
        className={styles.name}
        value={draft}
        aria-label={t('Document name')}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== name && void dispatch('rename-document', { name: draft })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(name);
            (e.target as HTMLInputElement).blur();
          }
        }}
        data-testid="document-name"
      />
      <button type="button" className={styles.state} data-testid="save-state" data-unsaved={needsSave || undefined} disabled={saveStatus === 'saving'} onClick={() => void saveProject()} title={t('Save project')}>
        {stateText}
      </button>
      <CloudSyncState />
      <div className={styles.spacer} />
      <div className={styles.group}>
        <CommandIconButton command="undo" label={`${t('Undo')} (${shortcut('Mod+Z')})`}>
          <Undo2 size={ICON} />
        </CommandIconButton>
        <CommandIconButton command="redo" label={`${t('Redo')} (${shortcut('Mod+Shift+Z')})`}>
          <Redo2 size={ICON} />
        </CommandIconButton>
      </div>
      <div className={styles.divider} />
      <button type="button" className={styles.palette} onClick={() => void dispatch('open-command-palette')} data-testid="open-palette">
        <Search size={14} />
        <span>{t('Commands')}</span>
        <kbd className="u-kbd">{shortcut('Mod+K')}</kbd>
      </button>
      <div className={styles.divider} />
      <LiveBridgeChip />
      <LinkedModelsMenu />
      <div className={styles.divider} />
      <div className={styles.group}>
        <CommandIconButton command="prompt-new-document" label={`${t('New')} (${shortcut('Mod+N')})`}>
          <FilePlus2 size={ICON} />
        </CommandIconButton>
        <CommandIconButton command="prompt-open-document" label={`${t('Open')} (${shortcut('Mod+O')})`}>
          <FolderOpen size={ICON} />
        </CommandIconButton>
        <CommandIconButton command="save-document" label={`${t('Save')} (${shortcut('Mod+S')})`}>
          <Save size={ICON} />
        </CommandIconButton>
        <IconButton label={t('Save as Template')} onClick={() => void dispatch('set-template-save-prompt', { open: true })} data-testid="topbar-save-template">
          <LayoutTemplate size={ICON} />
        </IconButton>
      </div>
      <div className={styles.divider} />
      <div className={styles.group}>
        <IconButton label={t('Toggle layers & assets panel')} active={false} onClick={() => void dispatch('toggle-left-panel')}>
          <PanelLeft size={ICON} style={{ color: leftOpen ? 'var(--text)' : undefined }} />
        </IconButton>
        <IconButton label={t('Toggle inspector')} onClick={() => void dispatch('toggle-inspector')}>
          <PanelRight size={ICON} style={{ color: inspectorOpen ? 'var(--text)' : undefined }} />
        </IconButton>
      </div>
      <div className={styles.divider} />
      <PeersBar />
      <AccountButton inProject />
    </header>
  );
}

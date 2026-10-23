import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { projectLoading } from '@/persistence/projectLoading';
import { ProjectLoadingScreen } from '@/ui/ProjectLoadingScreen';
import { Workboard } from '@/render/Workboard';
import { CommandPalette } from '@/ui/CommandPalette';
import { ContextMenu } from '@/ui/ContextMenu';
import { AssetNamePrompt } from '@/ui/AssetNamePrompt';
import { DocumentPrompt } from '@/ui/DocumentPrompt';
import { ExportDialog } from '@/ui/ExportDialog';
import { D5ImportDialog } from '@/ui/D5ImportDialog';
import { SheetBar, SheetPanel, SheetToolbar } from '@/sheets/SheetUI';
import { GraphicsDialog } from '@/ui/GraphicsDialog';
import { ParametricEditor } from '@/ui/ParametricEditor';
import { HomeScreen } from '@/ui/HomeScreen';
import { AccountDialog } from '@/ui/AccountDialog';
import { ShareDialog } from '@/ui/ShareDialog';
import { JoinDialog } from '@/ui/JoinDialog';
import { ProgressCenter } from '@/ui/ProgressCenter';
import { LiveLog } from '@/ui/LiveLog';
import { GroupEditBar } from '@/ui/GroupEditBar';
import { installDiagnostics } from '@/diagnostics';
import { ProjectPicker } from '@/bridge/ProjectPicker';
import { Inspector } from '@/ui/Inspector';
import { LeftPanel } from '@/ui/LeftPanel';
import { SaveTemplateModal } from '@/ui/TemplateModal';
import { StatusBar } from '@/ui/StatusBar';
import { Toasts } from '@/ui/Toasts';
import { Toolbar } from '@/ui/Toolbar';
import { TopBar } from '@/ui/TopBar';
import { View3DWorkspace } from '@/view3d/View3DWorkspace';
import { MaterialEditor } from '@/ui/MaterialEditor';
import { useI18n } from '@/ui/i18n';
import styles from './App.module.css';
import { useApp, useAppState, useDispatch } from './context';
import { useGlobalShortcuts } from './keyboard';
import { buildAppMenu } from './menu';
import { useAppRouter } from './router';
import { getProjectSyncChannel, type ProjectSyncMessage } from '@/modeling/projectSync';
import { insertModeledAsset } from '@/modeling/insertModeledAsset';
import { getElectronBridge } from '@/platform/electron';

export function App() {
  installDiagnostics();
  const { t } = useI18n();
  const services = useApp();
  const { platform, registry, persistence, catalog, toasts, store } = services;
  const dispatch = useDispatch();
  const screen = useAppState((s) => s.ui.screen);
  const loading = useSyncExternalStore(projectLoading.subscribe, projectLoading.getSnapshot, projectLoading.getSnapshot);
  const sheetOpen = useAppState((s) => s.ui.sheet !== null);
  const editingViewBoard = useAppState((s) => Boolean(s.ui.view3d.open && s.ui.view3d.editingBoard));
  const view3dOpen = useAppState((s) => s.ui.view3d.open);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  useGlobalShortcuts();
  useAppRouter();

  // Sync project updates with any connected 3D modeling tabs and handle insertion of modeled assets
  useEffect(() => {
    if (screen !== 'project') return;
    const channel = getProjectSyncChannel();
    if (!channel) return;
    let subscribedProject: string | null = null;
    const modelingSessions = new Set<string>();
    let active = true;
    let scheduled = false;

    const publish = () => {
      if (scheduled || !active || subscribedProject !== store.getState().doc.id) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        const doc = store.getState().doc;
        if (active && subscribedProject === doc.id) channel.postMessage({ type: 'PROJECT_DOC_UPDATE', projectId: doc.id, doc });
      });
    };
    const stop = store.subscribe((state, previous) => { if (state.doc !== previous.doc) publish(); });

    const onMessage = async (event: MessageEvent) => {
      const msg = event.data as ProjectSyncMessage;
      if (!msg || typeof msg !== 'object') return;
      const doc = store.getState().doc;

      if (msg.type === 'MODELING_SESSION_ANNOUNCE' && msg.projectId === doc.id) {
        modelingSessions.add(msg.assetId);
      } else if (msg.type === 'MODELING_SESSION_CLOSED' && msg.projectId === subscribedProject) {
        modelingSessions.delete(msg.assetId);
        if (modelingSessions.size === 0) subscribedProject = null;
      }
      if (msg.type === 'REQUEST_PROJECT_DOC' && msg.projectId === doc.id) {
        subscribedProject = doc.id;
        publish();
      } else if (msg.type === 'INSERT_MODELED_ASSET' && msg.projectId === doc.id) {
        try {
          const updated = await insertModeledAsset(services, msg);
          channel.postMessage({
            type: 'ASSET_INSERTED_ACK',
            projectId: doc.id,
            assetId: msg.assetId,
            requestId: msg.requestId,
            success: true,
          });
          toasts.push({
            kind: 'success',
            message: updated > 0 ? t(`Updated ${updated} instance${updated === 1 ? '' : 's'} of "${msg.name}"`) : t(`Added "${msg.name}" from 3D modeler to project`),
          });
        } catch (err) {
          console.error('Failed to insert modeled asset into project', err);
          channel.postMessage({
            type: 'ASSET_INSERTED_ACK',
            projectId: doc.id,
            assetId: msg.assetId,
            requestId: msg.requestId,
            success: false,
            message: err instanceof Error ? err.message : 'Failed to insert asset',
          });
        }
      }
    };

    channel.addEventListener('message', onMessage);
    return () => {
      active = false;
      stop();
      channel.removeEventListener('message', onMessage);
      channel.close();
    };
  }, [screen, services, store, catalog, toasts, t]);

  useEffect(() => {
    if (!platform.menu) return;
    platform.menu.set(buildAppMenu(registry));
    return platform.menu.onCommand((commandId) => { if (!projectLoading.getSnapshot()) void dispatch(commandId); });
  }, [platform, registry, dispatch]);

  useEffect(() => {
    const stopClose = getElectronBridge()?.onBeforeClose?.(async () => {
      await persistence.flush();
      if (persistence.getSaveStatus() === 'error') throw new Error('Could not save the project.');
    });
    const flush = () => void persistence.flush();
    // Also when the tab is hidden or closed on mobile (beforeunload is not reliable there).
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      stopClose?.();
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [persistence]);

  const openContextMenu = useCallback((position: { x: number; y: number }) => setContextMenu(position), []);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  if (screen === 'home') {
    return (
      <><div className={styles.app} inert={loading !== null} aria-busy={loading !== null}>
        <HomeScreen />
        <AccountDialog />
        <ShareDialog />
        <JoinDialog />
        <ProjectPicker />
        <ProgressCenter />
        <LiveLog />
        <Toasts />
      </div><ProjectLoadingScreen /></>
    );
  }

  return (
    <><div className={styles.app} inert={loading !== null} aria-busy={loading !== null}>
      <TopBar />
      <main className={styles.main} data-view-board={editingViewBoard || undefined}>
        <Workboard onContextMenu={openContextMenu} />
        <View3DWorkspace />
        {sheetOpen ? <SheetPanel /> : <LeftPanel />}
        <Inspector />
        {sheetOpen ? <SheetToolbar /> : <Toolbar />}
        {sheetOpen && <SheetBar />}
        {!view3dOpen && <StatusBar />}
        <GroupEditBar />
        {contextMenu && <ContextMenu position={contextMenu} onClose={closeContextMenu} />}
      </main>
      <CommandPalette />
      <AssetNamePrompt />
      <DocumentPrompt />
      <SaveTemplateModal />
      <GraphicsDialog />
      <ExportDialog />
      <D5ImportDialog />
      <MaterialEditor />
      <ParametricEditor />
      <AccountDialog />
      <ShareDialog />
      <JoinDialog />
      <ProjectPicker />
      <ProgressCenter />
      <LiveLog />
      <Toasts />
      <div className={styles.narrowGuard} role="alert">
        <strong>{t('Window too narrow')}</strong>
        <span>{t('Drag the window wider to keep working.')}</span>
      </div>
    </div><ProjectLoadingScreen /></>
  );
}

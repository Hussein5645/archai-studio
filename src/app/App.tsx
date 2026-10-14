import { useCallback, useEffect, useState } from 'react';
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

export function App() {
  const { t } = useI18n();
  const { platform, registry, persistence, catalog, toasts } = useApp();
  const dispatch = useDispatch();
  const screen = useAppState((s) => s.ui.screen);
  const doc = useAppState((s) => s.doc);
  const sheetOpen = useAppState((s) => s.ui.sheet !== null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  useGlobalShortcuts();
  useAppRouter();

  // Sync project updates with any connected 3D modeling tabs and handle insertion of modeled assets
  useEffect(() => {
    if (screen !== 'project') return;
    const channel = getProjectSyncChannel();
    if (!channel) return;

    channel.postMessage({
      type: 'PROJECT_DOC_UPDATE',
      projectId: doc.id,
      doc,
    });

    const onMessage = async (event: MessageEvent) => {
      const msg = event.data as ProjectSyncMessage;
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'REQUEST_PROJECT_DOC' && msg.projectId === doc.id) {
        channel.postMessage({
          type: 'PROJECT_DOC_UPDATE',
          projectId: doc.id,
          doc,
        });
      } else if (msg.type === 'INSERT_MODELED_ASSET' && msg.projectId === doc.id) {
        try {
          if (catalog.addLocalPackage) {
            const asset = await catalog.addLocalPackage(msg.caiBytes);
            const refreshed = await dispatch('update-placed-catalog-asset', { asset });
            const updated = refreshed.ok ? Number(refreshed.value) : 0;
            if (updated === 0) {
              await dispatch('place-catalog-asset', {
                asset,
                x: msg.position.x,
                y: msg.position.y,
                centered: true,
              });
            }
            channel.postMessage({
              type: 'ASSET_INSERTED_ACK',
              projectId: doc.id,
              assetId: msg.assetId,
              success: true,
            });
            toasts.push({
              kind: 'success',
              message: updated > 0 ? t(`Updated ${updated} instance${updated === 1 ? '' : 's'} of "${msg.name}"`) : t(`Added "${msg.name}" from 3D modeler to project`),
            });
          }
        } catch (err) {
          console.error('Failed to insert modeled asset into project', err);
          channel.postMessage({
            type: 'ASSET_INSERTED_ACK',
            projectId: doc.id,
            assetId: msg.assetId,
            success: false,
            message: err instanceof Error ? err.message : 'Failed to insert asset',
          });
        }
      }
    };

    channel.addEventListener('message', onMessage);
    return () => {
      channel.removeEventListener('message', onMessage);
      channel.close();
    };
  }, [screen, doc, catalog, dispatch, toasts, t]);

  useEffect(() => {
    if (!platform.menu) return;
    platform.menu.set(buildAppMenu(registry));
    return platform.menu.onCommand((commandId) => void dispatch(commandId));
  }, [platform, registry, dispatch]);

  useEffect(() => {
    const flush = () => void persistence.flush();
    // Also when the tab is hidden or closed on mobile (beforeunload is not reliable there).
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [persistence]);

  const openContextMenu = useCallback((position: { x: number; y: number }) => setContextMenu(position), []);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  if (screen === 'home') {
    return (
      <div className={styles.app}>
        <HomeScreen />
        <AccountDialog />
        <ShareDialog />
        <JoinDialog />
        <ProjectPicker />
        <ProgressCenter />
        <Toasts />
      </div>
    );
  }

  return (
    <div className={styles.app}>
      <TopBar />
      <main className={styles.main}>
        <Workboard onContextMenu={openContextMenu} />
        <View3DWorkspace />
        {sheetOpen ? <SheetPanel /> : <LeftPanel />}
        <Inspector />
        {sheetOpen ? <SheetToolbar /> : <Toolbar />}
        {sheetOpen && <SheetBar />}
        <StatusBar />
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
      <Toasts />
      <div className={styles.narrowGuard} role="alert">
        <strong>{t('Window too narrow')}</strong>
        <span>{t('Drag the window wider to keep working.')}</span>
      </div>
    </div>
  );
}

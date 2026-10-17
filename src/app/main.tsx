import { StrictMode } from 'react';
import { LiveLog } from '@/ui/LiveLog';
import { installDiagnostics } from '@/diagnostics';
import { createRoot } from 'react-dom/client';
import { CaiCatalog, createLocalCaiStore, HybridCaiCatalog } from '@/catalog';
import { account as currentAccount, initAccount, type AccountState } from '@/cloud/account';
import { libraryRoot } from '@/cloud/library';
import { CloudProjects, inviteToken } from '@/cloud/projects';
import { openJoinDialog } from '@/ui/JoinDialog';
import { setHostProgressReporter } from '@/progress';
import { builtinCommands, CommandExecutor, CommandRegistry, newDocument, setScreen } from '@/commands';
import { randomIds } from '@/document';
import { canvasMeasurer } from '@/geometry';
import { PersistenceService } from '@/persistence/service';
import { documentKey } from '@/persistence/session';
import { createPlatform } from '@/platform';
import { createAppStore } from '@/store';
import '@/ui/global.css';
import { createToastStore } from '@/ui/toast-store';
import { I18nProvider } from '@/ui/i18n';
import { TouchModeProvider } from '@/ui/touch';
import { VrDeviceProvider } from '@/ui/vrDevice';
import { startBoardLink } from '@/studio/link';
import { startLiveLink } from '@/live/board';
import { startBridgeGuard } from '@/bridge/guard';
import { App } from './App';
import { AppProvider, type AppServices } from './context';
import { findMatchingDocumentId, getCurrentRoute, parseRoute } from './router';

declare global {
  interface Window {
    /** Inspectable entry point (same command system the UI uses); also used by end-to-end tests. */
    __archai?: AppServices;
  }
}

/**
 * `/modeling?asset=…` (or `#/modeling?asset=…` when served from file://, as in the desktop app)
 * is the stand-alone modeling workspace.
 */
function isModelingRoute(): boolean {
  return parseRoute(getCurrentRoute()).isModeling;
}

async function bootModeling(): Promise<void> {
  const { ModelingApp } = await import('@/modeling/ModelingApp');
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nProvider>
        <TouchModeProvider>
          <VrDeviceProvider>
            <ModelingApp />
          </VrDeviceProvider>
        </TouchModeProvider>
      </I18nProvider>
    </StrictMode>,
  );
}

/**
 * The asset catalog: the cloud library (signed in only, docs/accounts-and-cloud.md) plus the
 * packages imported on this device. Signing in or out swaps the cloud part.
 */
function createCatalog(platform: ReturnType<typeof createPlatform>): HybridCaiCatalog {
  const account = initAccount(platform);
  const source = 'cloudflare-r2:archai-assets';
  const remote = () => {
    const root = libraryRoot();
    return root ? new CaiCatalog(root, source) : null;
  };
  const catalog = new HybridCaiCatalog(remote(), createLocalCaiStore(platform), source);
  const userOf = (state: AccountState) => (state.status === 'signed-in' ? state.user.id : null);
  let user = userOf(account.state());
  account.subscribe((state) => {
    if (userOf(state) === user) return;
    user = userOf(state);
    catalog.setRemote(remote());
  });
  return catalog;
}

/** `/render` (`#/render` from file://) is ArchAI Render, the studio window live-linked to the board. */
function isRenderRoute(): boolean {
  return getCurrentRoute().replace(/^\/+|\/+$/g, '').toLowerCase() === 'render';
}

async function bootRender(): Promise<void> {
  installDiagnostics();
  const platform = createPlatform();
  const { RenderStudio } = await import('@/studio/RenderStudio');
  document.title = 'ArchAI Render';
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <RenderStudio platform={platform} catalog={createCatalog(platform)} />
      <LiveLog />
    </StrictMode>,
  );
}

async function boot(): Promise<void> {
  if (isModelingRoute()) return bootModeling();
  if (isRenderRoute()) return bootRender();
  const platform = createPlatform();
  const catalog = createCatalog(platform);
  const store = createAppStore();
  const registry = new CommandRegistry().register(...builtinCommands);
  const executor = new CommandExecutor(registry, store, {
    ids: randomIds,
    now: () => new Date().toISOString(),
    measurer: canvasMeasurer,
    platform,
    catalog,
    devChecks: import.meta.env.DEV,
  });
  const toasts = createToastStore();
  startBoardLink(platform, store, { executor, toasts });
  const persistence = new PersistenceService(store, executor, platform);
  // An app's geometry is edited in that app: changes made here are put back (docs/live-bridge.md).
  startBridgeGuard(executor, store, (app) => toasts.push({ kind: 'info', message: `${app} decides this element, so your change was put back. Convert it to an ArchAI element (Inspector, Live Bridge) to edit it here.` }));
  const route = parseRoute(getCurrentRoute());

  if (route.isHome) {
    try {
      await persistence.restoreSession();
    } catch (error) {
      console.error('Could not restore session record', error);
    }
    if (store.getState().ui.screen !== 'home') {
      executor.dispatchSync(setScreen, { screen: 'home' });
    }
  } else if (route.isBoard) {
    try {
      const sessionRecord = await persistence.restoreSession();
      const matchedId = findMatchingDocumentId(sessionRecord.recent, route);
      if (matchedId) {
        // A stored project that cannot be opened: back to Home, never a blank copy that would
        // autosave as a second project.
        const opened = await persistence.openStored(matchedId);
        if (!opened) executor.dispatchSync(setScreen, { screen: 'home' });
      } else if (route.extractedDocId) {
        const raw = await platform.storage.get(documentKey(route.extractedDocId));
        if (raw) {
          await persistence.openStored(route.extractedDocId);
        } else {
          const docName = route.slug
            ? route.slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
            : 'Untitled';
          // Keep the link's id: reloading a project before its first autosave must not fork it.
          executor.dispatchSync(newDocument, { name: docName, id: route.extractedDocId });
        }
      } else {
        const docName = route.slug
          ? route.slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
          : 'Untitled';
        executor.dispatchSync(newDocument, { name: docName });
      }
    } catch (error) {
      console.error('Could not load board from route', error);
    }
  } else {
    try {
      await persistence.restore();
    } catch (error) {
      console.error('Could not restore the previous session', error);
    }
  }
  persistence.start();
  const account = currentAccount();
  const cloud = new CloudProjects(account, persistence, store, executor, toasts);
  cloud.start();
  const openBridgeLink = startLiveLink(platform, store, executor, catalog, toasts, persistence, {
    load: (id) => cloud.loadForBridge(id),
    save: (doc) => cloud.saveForBridge(doc),
    open: (id) => persistence.entry(id)?.cloud || cloud.list().projects.some((project) => project.id === id) ? cloud.open(id) : persistence.openStored(id),
  });
  // A board link to an online project (reload, or a link opened on another device) gets the latest version.
  const openId = store.getState().doc.id;
  if (store.getState().ui.screen !== 'home' && persistence.entry(openId)?.cloud) void account.restore().then(() => cloud.open(openId));

  // Long tasks also show on the desktop taskbar button.
  const setHostProgress = platform.window.setProgress;
  if (setHostProgress) setHostProgressReporter((fraction, active) => setHostProgress(!active ? null : fraction === null ? 'indeterminate' : fraction));

  // Desktop links open either bridge linking or an invite. Web invites use ?invite=<token>.
  const showLink = (text: string) => {
    openBridgeLink?.(text);
    if (inviteToken(text)) openJoinDialog(text);
  };
  platform.links?.subscribe(showLink);
  const webInvite = new URLSearchParams(location.search).get('invite');
  if (webInvite) {
    showLink(webInvite);
    const url = new URL(location.href);
    url.searchParams.delete('invite');
    history.replaceState(history.state, '', url.toString());
  }

  const services: AppServices = { store, executor, registry, platform, catalog, persistence, toasts, account, cloud };
  window.__archai = services;

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppProvider services={services}>
        <I18nProvider>
          <TouchModeProvider>
            <VrDeviceProvider>
              <App />
            </VrDeviceProvider>
          </TouchModeProvider>
        </I18nProvider>
      </AppProvider>
    </StrictMode>,
  );
}

// Load independently of project startup, and only where the analytics endpoints exist.
if (import.meta.env.PROD && __VERCEL_ANALYTICS_ENABLED__) {
  void import('@vercel/analytics').then(({ inject }) => inject({
    mode: 'production',
    beforeSend: (event) => {
      const url = new URL(event.url);
      // Invitations and asset links can contain private tokens in query parameters.
      url.search = '';
      url.hash = '';
      return { ...event, url: url.toString() };
    },
  })).catch((error: unknown) => console.warn('Web Analytics could not load', error));
}

void boot();

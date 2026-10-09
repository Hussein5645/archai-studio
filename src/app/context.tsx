import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { AssetCatalog } from '@/catalog/types';
import type { AccountService, AccountState } from '@/cloud/account';
import type { CloudListState, CloudProjects, CloudSyncStatus } from '@/cloud/projects';
import type { LiveState } from '@/cloud/live';
import { ancestorsOf, type ArchaiDocument, type Element, type ElementTable } from '@/document';
import type { CommandExecutor, CommandRegistry, CommandResult } from '@/commands';
import type { PersistenceService } from '@/persistence/service';
import type { Platform } from '@/platform/types';
import { boardDoc, type AppState, type AppStore } from '@/store';
import type { ToastStore } from '@/ui/toast-store';

export interface AppServices {
  store: AppStore;
  executor: CommandExecutor;
  registry: CommandRegistry;
  platform: Platform;
  catalog: AssetCatalog;
  persistence: PersistenceService;
  toasts: ToastStore;
  account: AccountService;
  cloud: CloudProjects;
}

const AppContext = createContext<AppServices | null>(null);

export function AppProvider({ services, children }: { services: AppServices; children: ReactNode }) {
  return <AppContext.Provider value={services}>{children}</AppContext.Provider>;
}

export function useApp(): AppServices {
  const services = useContext(AppContext);
  if (!services) throw new Error('useApp must be used inside <AppProvider>');
  return services;
}

const noSubscribe = () => () => {};

/** Document and catalog when rendered inside the app (null in static previews / templates). */
export function useAppOptional(): { doc: ArchaiDocument; catalog: AssetCatalog } | null {
  const services = useContext(AppContext);
  const doc = useSyncExternalStore(
    services ? services.store.subscribe : noSubscribe,
    () => services?.store.getState().doc ?? null,
    () => services?.store.getState().doc ?? null,
  );
  return services && doc ? { doc, catalog: services.catalog } : null;
}

/** Subscribes to a slice of the app state. */
export function useAppState<T>(selector: (state: AppState) => T): T {
  const { store } = useApp();
  return useStore(store, selector);
}

/** Like `useAppState` but compares the result shallowly (for objects/arrays built in the selector). */
export function useAppStateShallow<T>(selector: (state: AppState) => T): T {
  const { store } = useApp();
  return useStore(store, useShallow(selector));
}

/**
 * The given elements plus their ancestor chains (everything worldMatrix/bounds needs) as the
 * board draws them (a gesture preview included; see `boardDoc`), re-
 * rendering only when one of them actually changes — not on every edit anywhere else in a
 * possibly large document. `s.doc.elements` always gets a new reference on any edit, so
 * subscribing to it directly (as ElementNode-adjacent components like Overlay and AiPortal used
 * to) re-renders on every edit in the document, not just ones touching what they show.
 */
export function useElementsWithAncestors(ids: readonly (string | null | undefined)[]): ElementTable {
  const list = useAppStateShallow((s) => {
    const seen = new Set<string>();
    const out: Element[] = [];
    for (const id of ids) {
      if (!id || seen.has(id)) continue;
      const elements = boardDoc(s).elements;
      const element = elements[id];
      if (!element) continue;
      seen.add(id);
      out.push(element);
      for (const ancestor of ancestorsOf(elements, id)) {
        if (seen.has(ancestor.id)) continue;
        seen.add(ancestor.id);
        out.push(ancestor);
      }
    }
    return out;
  });
  return useMemo(() => {
    const table: Record<string, Element> = {};
    for (const element of list) table[element.id] = element;
    return table;
  }, [list]);
}

export type DispatchFn = (commandId: string, input?: unknown) => Promise<CommandResult>;

/** Dispatches a command and surfaces failures as toasts. */
export function useDispatch(): DispatchFn {
  const { executor, toasts } = useApp();
  return useCallback(
    async (commandId: string, input?: unknown) => {
      const result = await executor.dispatch(commandId, input);
      if (!result.ok && result.error.code !== 'unavailable' && result.error.code !== 'cancelled') {
        toasts.push({ kind: 'error', message: result.error.message });
      }
      return result;
    },
    [executor, toasts],
  );
}

/** Availability of a command, re-evaluated whenever state changes. */
export function useAvailable(commandId: string): boolean {
  const { executor } = useApp();
  return useAppState((state) => executor.isAvailable(commandId, state));
}

export function useRecentDocuments() {
  const { persistence } = useApp();
  return useSyncExternalStore(
    (listener) => persistence.subscribe(listener),
    () => persistence.recent(),
  );
}

/** The ArchAI account (signed in or out), re-rendering on changes. */
export function useAccount(): AccountState {
  const { account } = useApp();
  return useSyncExternalStore(
    (listener) => account.subscribe(listener),
    () => account.state(),
  );
}

/** The online projects of the signed-in user. */
export function useCloudProjects(): CloudListState {
  const { cloud } = useApp();
  return useSyncExternalStore(
    (listener) => cloud.subscribe(listener),
    () => cloud.list(),
  );
}

/** Upload status of the open document when it is an online project, else null. */
export function useCloudSync(): CloudSyncStatus | null {
  const { cloud } = useApp();
  const docId = useAppState((state) => state.doc.id);
  const sync = useSyncExternalStore(
    (listener) => cloud.subscribe(listener),
    () => cloud.sync(),
  );
  return sync && sync.id === docId ? sync.status : null;
}

/** The open online project's board: who is there, connection state; null for local projects. */
export function useLiveState(): LiveState | null {
  const { cloud } = useApp();
  useAppState((state) => state.doc.id);
  return useSyncExternalStore(
    (listener) => cloud.subscribe(listener),
    () => cloud.liveState(),
  );
}

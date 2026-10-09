import { createStore, type StoreApi } from 'zustand/vanilla';
import { createEmptyDocument, randomIds, type ArchaiDocument, type IdSource } from '@/document';
import { createInitialUi, type AppState, type UiState } from './state';

export type AppStore = StoreApi<AppState>;

export interface CreateStoreOptions {
  doc?: ArchaiDocument;
  ui?: Partial<UiState>;
  ids?: IdSource;
  now?: () => string;
}

export function createAppStore(options: CreateStoreOptions = {}): AppStore {
  const ids = options.ids ?? randomIds;
  const now = options.now ?? (() => new Date().toISOString());
  const doc = options.doc ?? createEmptyDocument({ ids, now });
  return createStore<AppState>()(() => ({
    doc,
    preview: null,
    ui:{ ...createInitialUi(), ...options.ui },
    history: { past: [], future: [] },
    session: { filePath: null, dirty: false, savedAt: null },
  }));
}

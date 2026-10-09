import type { RecentEntry } from '@/persistence/session';
import { useApp, useAppState, useDispatch } from './context';
import { useEffect } from 'react';

export function isFileProtocol(): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'file:';
}

/** The route part of a path: query and fragment dropped (the desktop app keeps both in the hash). */
export function normalizePath(path: string): string {
  let p = path.split(/[?#]/)[0]!.replace(/\/index\.html$/, '');
  if (!p.startsWith('/')) p = `/${p}`;
  return p === '' ? '/' : p;
}

export function getCurrentRoute(): string {
  if (typeof window === 'undefined') return '/';
  if (isFileProtocol()) {
    const hash = window.location.hash.replace(/^#/, '');
    return hash ? (hash.startsWith('/') ? hash : `/${hash}`) : '/';
  }
  return window.location.pathname || '/';
}

export function navigateTo(path: string, replace = false): void {
  if (typeof window === 'undefined') return;
  const target = isFileProtocol() ? `#${path}` : path;
  const current = getCurrentRoute();

  if (current === path) return;

  if (replace) {
    window.history.replaceState(null, '', target);
  } else {
    window.history.pushState(null, '', target);
  }
}

/**
 * Creates a clean, URL-safe slug from a project name.
 * Preserves Unicode letters and digits so non-English titles (e.g. Arabic, French) remain legible.
 */
export function slugifyProjectName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return slug || 'untitled';
}

/**
 * Formats a board ID containing the project name and the document id.
 * e.g. "hussein-doc_a1b2c3d4e5f6"
 */
export function formatBoardId(name: string, docId: string): string {
  const slug = slugifyProjectName(name);
  return `${slug}-${docId}`;
}

export interface ParsedRoute {
  isHome: boolean;
  isModeling: boolean;
  isBoard: boolean;
  rawPath: string;
  boardId: string | null;
  extractedDocId: string | null;
  slug: string | null;
}

export function parseRoute(path: string): ParsedRoute {
  const normalized = normalizePath(path);
  if (normalized === '/' || normalized === '') {
    return {
      isHome: true,
      isModeling: false,
      isBoard: false,
      rawPath: normalized,
      boardId: null,
      extractedDocId: null,
      slug: null,
    };
  }

  const clean = normalized.replace(/^\/+/, '').replace(/\/+$/, '');
  if (clean.toLowerCase() === 'modeling') {
    return {
      isHome: false,
      isModeling: true,
      isBoard: false,
      rawPath: normalized,
      boardId: null,
      extractedDocId: null,
      slug: null,
    };
  }

  const boardId = decodeURIComponent(clean);
  // Matches e.g. "hussein-doc_a1b2c3d4e5f6" or standalone "doc_a1b2c3d4e5f6"
  const docMatch = boardId.match(/(?:^|[-_])(doc_[a-z0-9_]+)$/i);
  const extractedDocId: string | null = docMatch?.[1] ?? null;

  let slug: string | null = null;
  if (extractedDocId) {
    const withoutDocId = boardId.slice(0, boardId.length - extractedDocId.length).replace(/[-_]+$/, '');
    slug = withoutDocId || null;
  } else {
    slug = boardId;
  }

  return {
    isHome: false,
    isModeling: false,
    isBoard: true,
    rawPath: normalized,
    boardId,
    extractedDocId,
    slug,
  };
}

export function findMatchingDocumentId(
  recent: RecentEntry[],
  parsed: ParsedRoute,
): string | null {
  if (!parsed.isBoard || !parsed.boardId) return null;

  // 1. If explicit docId was extracted, match recent with that id
  if (parsed.extractedDocId) {
    const match = recent.find((r) => r.id === parsed.extractedDocId);
    if (match) return match.id;
  }

  // 2. Exact match on recent id
  const byId = recent.find((r) => r.id === parsed.boardId);
  if (byId) return byId.id;

  // 3. Exact match on formatted board id (e.g. name-doc_xxx)
  const byBoardId = recent.find((r) => formatBoardId(r.name, r.id) === parsed.boardId);
  if (byBoardId) return byBoardId.id;

  // 4. Match on slugified name or raw name
  if (parsed.slug) {
    const bySlug = recent.find(
      (r) =>
        slugifyProjectName(r.name) === parsed.slug ||
        r.name.toLowerCase() === parsed.slug!.toLowerCase(),
    );
    if (bySlug) return bySlug.id;
  }

  return null;
}

/**
 * Hook that keeps the browser address bar and window title synchronized with
 * the active screen, project name, and board ID.
 */
export function useAppRouter(): void {
  const { platform, persistence, store } = useApp();
  const dispatch = useDispatch();
  const screen = useAppState((s) => s.ui.screen);
  const name = useAppState((s) => s.doc.meta.name);
  const docId = useAppState((s) => s.doc.id);
  const dirty = useAppState((s) => s.session.dirty);

  // Sync window title and address bar URL
  useEffect(() => {
    if (screen === 'home') {
      platform.window.setTitle('ArchAI');
      const current = getCurrentRoute();
      if (current !== '/' && current !== '') {
        navigateTo('/', false);
      }
    } else if (screen === 'project') {
      platform.window.setTitle(`${name}${dirty ? ' •' : ''} — ArchAI`);
      const targetBoardId = formatBoardId(name, docId);
      const expectedPath = `/${targetBoardId}`;
      const current = getCurrentRoute();
      if (current !== expectedPath) {
        const parsedCurrent = parseRoute(current);
        const isSameDoc =
          parsedCurrent.isBoard &&
          (parsedCurrent.extractedDocId === docId || parsedCurrent.boardId === targetBoardId);
        navigateTo(expectedPath, isSameDoc);
      }
    }
  }, [screen, name, docId, dirty, platform]);

  // Handle browser Back and Forward button navigation
  useEffect(() => {
    const onPopState = async () => {
      const route = parseRoute(getCurrentRoute());
      if (route.isHome) {
        if (store.getState().ui.screen !== 'home') {
          void dispatch('go-home');
        }
      } else if (route.isBoard) {
        const currentDocId = store.getState().doc.id;
        const currentScreen = store.getState().ui.screen;
        const matchedId = findMatchingDocumentId(persistence.recent(), route) ?? route.extractedDocId;
        if (matchedId && matchedId !== currentDocId) {
          await persistence.openStored(matchedId);
        } else if (currentScreen !== 'project') {
          void dispatch('set-screen', { screen: 'project' });
        }
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [persistence, store, dispatch]);
}

/**
 * The asset, material and render libraries need an account: the archai-cloud Worker serves the
 * `archai-assets` bucket at `<cloud>/lib/<library token>/<key>`. The token is signed per user and
 * renewed on every start, so URLs held in memory carry it, while URLs kept in documents use the
 * placeholder `-` (`storedLibraryUrl`) and get the current token when fetched (`libraryUrl`).
 */
import { account, CLOUD_URL } from './account';

/** Where the libraries were public before accounts; documents saved then still point here. */
const LEGACY_ROOTS = ['https://pub-b5992926befd442a815cdfd81f89d74c.r2.dev/'];
const LIB_PREFIX = `${CLOUD_URL}/lib/`;

function currentToken(): string | null {
  try {
    const state = account().state();
    return state.status === 'signed-in' ? state.libraryToken : null;
  } catch {
    return null;
  }
}

/** The library root with a trailing slash, or null signed out. */
export function libraryRoot(): string | null {
  const token = currentToken();
  return token ? `${LIB_PREFIX}${encodeURIComponent(token)}/` : null;
}

/** The bucket key of a library URL (any token, or a legacy public URL), else null. */
function libraryKey(url: string): string | null {
  for (const root of LEGACY_ROOTS) if (url.startsWith(root)) return url.slice(root.length);
  if (!url.startsWith(LIB_PREFIX)) return null;
  const rest = url.slice(LIB_PREFIX.length);
  const slash = rest.indexOf('/');
  return slash < 0 ? null : rest.slice(slash + 1);
}

/** A library URL made fetchable with this user's token; other URLs pass through unchanged. */
export function libraryUrl(url: string): string;
export function libraryUrl(url: string | undefined): string | undefined;
export function libraryUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const key = libraryKey(url);
  const root = libraryRoot();
  return key !== null && root ? `${root}${key}` : url;
}

/** The form kept in documents and files: no token (`/lib/-/<key>`). */
export function storedLibraryUrl(url: string): string;
export function storedLibraryUrl(url: string | undefined): string | undefined;
export function storedLibraryUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const key = libraryKey(url);
  return key !== null ? `${LIB_PREFIX}-/${key}` : url;
}

export const LIBRARY_SIGN_IN_MESSAGE = 'Sign in to ArchAI to use the libraries';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { account, CLOUD_URL, resetAccountForTests } from './account';
import { libraryRoot, libraryUrl, storedLibraryUrl } from './library';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    storage: {
      get: async (key: string) => data.get(key) ?? null,
      set: async (key: string, value: string) => void data.set(key, value),
      delete: async (key: string) => void data.delete(key),
      keys: async (prefix: string) => [...data.keys()].filter((key) => key.startsWith(prefix)),
    },
  };
}

const session = { token: 'tok', user: { id: 'u_1', email: 'a@b.c', name: 'Ana' }, libraryToken: 'u_1.9999999999.sig' };

describe('account and library links', () => {
  let mem: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    mem = memoryStorage();
    resetAccountForTests({ storage: mem.storage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetAccountForTests(null);
  });

  it('is signed out without a saved session, and libraries have no root', async () => {
    await account().restore();
    expect(account().state().status).toBe('signed-out');
    expect(libraryRoot()).toBeNull();
    expect(libraryUrl('https://pub-b5992926befd442a815cdfd81f89d74c.r2.dev/materials/a.cai')).toBe('https://pub-b5992926befd442a815cdfd81f89d74c.r2.dev/materials/a.cai');
  });

  it('signs in, saves the session, and rewrites library URLs with the current token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(session), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await account().signIn('a@b.c', 'password1');
    expect(fetchMock).toHaveBeenCalledWith(`${CLOUD_URL}/auth/login`, expect.objectContaining({ method: 'POST' }));
    expect(account().state()).toMatchObject({ status: 'signed-in', user: { name: 'Ana' } });
    expect(JSON.parse(mem.data.get('account')!)).toMatchObject({ token: 'tok' });

    const root = libraryRoot();
    expect(root).toBe(`${CLOUD_URL}/lib/${encodeURIComponent(session.libraryToken)}/`);
    // Legacy public URLs and URLs stored without a token both get the current token.
    expect(libraryUrl('https://pub-b5992926befd442a815cdfd81f89d74c.r2.dev/Arch/chair.cai')).toBe(`${root}Arch/chair.cai`);
    expect(libraryUrl(`${CLOUD_URL}/lib/-/Arch/chair.cai`)).toBe(`${root}Arch/chair.cai`);
    expect(libraryUrl(`${CLOUD_URL}/lib/old.token.x/Arch/chair.cai`)).toBe(`${root}Arch/chair.cai`);
    expect(libraryUrl('https://example.com/x.png')).toBe('https://example.com/x.png');
    // Documents keep the placeholder, never the token.
    expect(storedLibraryUrl(`${root}Arch/chair.cai`)).toBe(`${CLOUD_URL}/lib/-/Arch/chair.cai`);
  });

  it('reports server errors and signs out on 401', async () => {
    mem.data.set('account', JSON.stringify(session));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Your session has ended: sign in again' }), { status: 401 })));
    await account().restore();
    await expect(account().request('/projects')).rejects.toThrow('Your session has ended');
    expect(account().state().status).toBe('signed-out');
    expect(mem.data.has('account')).toBe(false);
  });

  it('keeps the saved session when the cloud cannot be reached', async () => {
    mem.data.set('account', JSON.stringify(session));
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await account().restore();
    await account().refresh();
    expect(account().state().status).toBe('signed-in');
    await expect(account().request('/projects')).rejects.toMatchObject({ status: 0 });
    expect(account().state().status).toBe('signed-in');
  });
});

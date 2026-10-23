/**
 * The ArchAI account (docs/accounts-and-cloud.md). Optional: signed out, everything local works
 * as before; signed in, the app reaches the cloud (online projects, libraries, VR links).
 *
 * The session lives in host storage (`account`), so the board, the Render window and (through
 * the Live Bridge) the plugins share one sign-in. `request()` calls the archai-cloud Worker.
 */
import { z } from 'zod';
import type { Platform } from '@/platform/types';

/** The deployed archai-cloud Worker; VITE_CLOUD_URL overrides it. */
export const CLOUD_URL = (String(import.meta.env['VITE_CLOUD_URL'] ?? '').trim() || 'https://archai-cloud.mklkoklpp.workers.dev').replace(/\/+$/, '');

const ACCOUNT_KEY = 'account';

/**
 * Accounts are by invitation for now: who to email for one (VITE_ACCOUNT_CONTACT overrides). The
 * owner creates accounts with workers/archai-cloud/admin.mjs.
 */
export const ACCOUNT_CONTACT = String(import.meta.env['VITE_ACCOUNT_CONTACT'] ?? '').trim() || 'mklkoklpp@gmail.com';

/** Development builds may create accounts on a local worker (wrangler dev with ALLOW_SIGNUP). */
export const OPEN_SIGNUP = Boolean(import.meta.env.DEV);

const UserSchema = z.object({ id: z.string(), email: z.string(), name: z.string() });
export type CloudUser = z.infer<typeof UserSchema>;

const StoredSchema = z.object({ token: z.string(), user: UserSchema, libraryToken: z.string() });
type Stored = z.infer<typeof StoredSchema>;

export type AccountState = { status: 'signed-out' } | { status: 'signed-in'; user: CloudUser; libraryToken: string };

const SIGNED_OUT: AccountState = { status: 'signed-out' };

export class CloudError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type Listener = (state: AccountState) => void;

export class AccountService {
  private stored: Stored | null = null;
  private current: AccountState = SIGNED_OUT;
  private readonly listeners = new Set<Listener>();
  private restored: Promise<void> | null = null;

  constructor(private readonly platform: Pick<Platform, 'storage'>) {}

  /** Loads the saved session, then checks it with the server (offline keeps the saved one). */
  restore(): Promise<void> {
    this.restored ??= (async () => {
      try {
        const parsed = StoredSchema.safeParse(JSON.parse((await this.platform.storage.get(ACCOUNT_KEY)) ?? 'null'));
        if (parsed.success) this.set(parsed.data);
      } catch {
        // no saved session
      }
      if (this.stored) void this.refresh();
    })();
    return this.restored;
  }

  state(): AccountState {
    return this.current;
  }

  /** Session token for the plugins (Live Bridge) and the VR share service; null signed out. */
  token(): string | null {
    return this.stored?.token ?? null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async signIn(email: string, password: string): Promise<CloudUser> {
    return this.start('/auth/login', { email, password });
  }

  async signUp(email: string, name: string, password: string): Promise<CloudUser> {
    return this.start('/auth/signup', { email, name, password });
  }

  async changePassword(current: string, password: string): Promise<void> {
    await this.request('/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current, password }) });
  }

  async signOut(): Promise<void> {
    const token = this.stored?.token;
    await this.save(null);
    if (token) await fetch(`${CLOUD_URL}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
  }

  /** Renews the library token and the user's details; a rejected session signs out. */
  async refresh(): Promise<void> {
    try {
      const me = z.object({ user: UserSchema, libraryToken: z.string() }).parse(await this.json('/me'));
      if (this.stored) await this.save({ ...this.stored, user: me.user, libraryToken: me.libraryToken });
    } catch (error) {
      if (!(error instanceof CloudError && error.status === 401)) console.warn('ArchAI account: could not reach the cloud', error);
    }
  }

  /** A signed-in call to the archai-cloud Worker; a 401 signs out on this device. */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = this.stored?.token;
    if (!token) throw new CloudError(401, 'Sign in to use ArchAI online');
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    let response: Response;
    try {
      response = await fetch(`${CLOUD_URL}${path}`, { ...init, headers });
    } catch {
      throw new CloudError(0, 'Could not reach ArchAI online: check the internet connection');
    }
    if (response.ok) return response;
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status === 401) await this.save(null);
    throw new CloudError(response.status, typeof body['error'] === 'string' ? body['error'] : `ArchAI online: ${response.status}`, body);
  }

  async json<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    return (await (await this.request(path, init)).json()) as T;
  }

  private async start(path: string, body: Record<string, string>): Promise<CloudUser> {
    let response: Response;
    try {
      response = await fetch(`${CLOUD_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new CloudError(0, 'Could not reach ArchAI online: check the internet connection');
    }
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new CloudError(response.status, typeof data['error'] === 'string' ? data['error'] : `ArchAI online: ${response.status}`, data);
    const stored = StoredSchema.parse(data);
    await this.save(stored);
    return stored.user;
  }

  private async save(stored: Stored | null): Promise<void> {
    if (stored) await this.platform.storage.set(ACCOUNT_KEY, JSON.stringify(stored));
    else await this.platform.storage.delete(ACCOUNT_KEY);
    // Native feature checks read host storage: publish the UI state after it is durable.
    this.set(stored);
  }

  private set(stored: Stored | null): void {
    this.stored = stored;
    this.current = stored ? { status: 'signed-in', user: stored.user, libraryToken: stored.libraryToken } : SIGNED_OUT;
    for (const listener of this.listeners) listener(this.current);
  }
}

let shared: AccountService | null = null;

/** The account of this window (created once at boot by `initAccount`). */
export function account(): AccountService {
  if (!shared) throw new Error('initAccount() must run at boot');
  return shared;
}

export function initAccount(platform: Pick<Platform, 'storage'>): AccountService {
  shared ??= new AccountService(platform);
  void shared.restore();
  return shared;
}

/** For tests: a fresh account over the given storage. */
export function resetAccountForTests(platform: Pick<Platform, 'storage'> | null): void {
  shared = platform ? new AccountService(platform) : null;
}

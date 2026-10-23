import { ACCOUNT_CLOUD_URL } from '../shared/runtimeDownload.js';

/** Validate the stored bearer with our server; renderer-supplied user objects confer no access. */
export class FeatureAccount {
  private checked: { token: string; until: number } | null = null;
  constructor(private readonly stored: () => Promise<string | null>, private readonly cloud = ACCOUNT_CLOUD_URL,
    private readonly request: typeof fetch = (...args) => fetch(...args)) {}
  clear() { this.checked = null; }
  async require(): Promise<string> {
    let token = '';
    try { token = JSON.parse(await this.stored() ?? 'null')?.token ?? ''; } catch { /* invalid saved session */ }
    if (typeof token !== 'string' || !token) throw new Error('Sign in to use Unreal rendering and VR exports.');
    if (this.checked?.token === token && this.checked.until > Date.now()) return token;
    const response = await this.request(`${this.cloud}/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw new Error(response.status === 401 ? 'Your session has ended. Sign in again.' : 'Could not verify your Archai account. Try again when online.');
    const me = await response.json() as { user?: { id?: string } };
    if (!me.user?.id) throw new Error('Could not verify your Archai account.');
    this.checked = { token, until: Date.now() + 60_000 };
    return token;
  }
}

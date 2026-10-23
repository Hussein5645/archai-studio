import { expect, it, vi } from 'vitest';
vi.mock('../workers/archai-cloud/src/board.js', () => ({ Board: class {} }));
// @ts-expect-error Cloudflare's JavaScript module is tested with isolated bindings.
import worker from '../workers/archai-cloud/src/index.js';

it('keeps both runtime metadata and binary private behind a valid server session', async () => {
  const tokenHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('valid-test-session'))).toString('base64url');
  const get = vi.fn(async () => ({ body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('fixture')); controller.close(); } }), size: 7 }));
  const env = { RUNTIMES: { get }, DB: { prepare: () => ({ bind: (hash: string) => ({ first: async () => hash === tokenHash ? { id: 'test', name: 'Fixture', email: 'fixture@example.invalid', expires_at: '2099-01-01T00:00:00.000Z' } : null }) }) } };
  for (const file of ['manifest', 'package']) {
    const url = `https://example.invalid/runtime/0.3.0.12/${file}`;
    expect((await worker.fetch(new Request(url), env)).status).toBe(401);
    expect((await worker.fetch(new Request(url, { headers: { Authorization: 'Bearer forged-client-token' } }), env)).status).toBe(401);
    expect(get).not.toHaveBeenCalled();
    const response = await worker.fetch(new Request(url, { headers: { Authorization: 'Bearer valid-test-session' } }), env);
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Authorization'); expect(await response.text()).toBe('fixture');
    get.mockClear();
  }
});

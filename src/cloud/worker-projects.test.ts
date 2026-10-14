import { expect, it, vi } from 'vitest';
vi.mock('../../workers/archai-cloud/src/board.js', () => ({ Board: class {} }));
// @ts-expect-error Cloudflare worker is plain JavaScript, tested through its HTTP boundary.
import worker from '../../workers/archai-cloud/src/index.js';

function setup(existing: { owner_id: string; version: number } | null = null) {
  const writes: { sql: string; values: unknown[] }[] = [];
  const boardFetch = vi.fn(async (_request: Request) => Response.json({ version: 7, role: 'owner' }));
  const env = {
    DB: {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({
        sql, values,
        first: async () => sql.includes('JOIN users') ? { id: 'owner', name: 'Test', email: 'test@example.com', expires_at: '2999-01-01' }
          : sql.includes('SELECT owner_id') ? existing : { role: 'owner' },
      }) }),
      batch: async (queries: { sql: string; values: unknown[] }[]) => { writes.push(...queries); },
    },
    BOARD: { idFromName: (id: string) => id, get: () => ({ fetch: boardFetch }) },
  };
  const reserve = (id?: string) => worker.fetch(new Request('https://cloud.test/projects', {
    method: 'POST', headers: { Authorization: 'Bearer test-only-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name: 'Moved project' }),
  }), env);
  return { env, writes, reserve, boardFetch };
}

it('reserves the local identity and handles conversion retries without a duplicate reservation', async () => {
  const created = setup();
  const response = await created.reserve('doc_123456abcdef');
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ id: 'doc_123456abcdef', version: 0 });
  expect(created.writes).toHaveLength(2);
  expect(created.writes[0]!.values.slice(0, 2)).toEqual(['doc_123456abcdef', 'owner']);
  const retry = setup({ owner_id: 'owner', version: 2 });
  expect(await (await retry.reserve('doc_123456abcdef')).json()).toMatchObject({ id: 'doc_123456abcdef', version: 2 });
  expect(retry.writes).toHaveLength(0);
});

it('rejects another owner’s identity and invalid paths, while legacy reservations still work', async () => {
  expect((await setup({ owner_id: 'another', version: 3 }).reserve('doc_123456abcdef')).status).toBe(409);
  expect((await setup().reserve('../private')).status).toBe(400);
  const response = await setup().reserve();
  expect(response.status).toBe(201);
  expect((await response.json()).id).toMatch(/^p_[a-z0-9]{20}$/);
});

it('checks the current board version without downloading the model', async () => {
  const { env, boardFetch } = setup();
  const response = await worker.fetch(new Request('https://cloud.test/projects/doc_123456abcdef/version', { headers: { Authorization: 'Bearer test-only-token' } }), env);
  expect(await response.json()).toEqual({ version: 7, role: 'owner' });
  const request = boardFetch.mock.calls[0]![0];
  expect(new URL(request.url).pathname).toBe('/version');
  expect(request.headers.get('X-Project-Id')).toBe('doc_123456abcdef');
});

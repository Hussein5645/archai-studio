import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from './index.js';

function service() {
  const files = new Map([['tours/abcd/created', 'created']]);
  const env = { UPLOAD_KEY: 'test', VIEWER_URL: 'https://viewer.example/', BUCKET: {
    async head(key) { return files.has(key) ? { size: String(files.get(key)).length } : null; },
    async put(key, value) { files.set(key, typeof value === 'string' ? value : 'asset'); },
    async get(key) { const text = files.get(key); return text === undefined ? null : { body: text, httpEtag: 'test', json: async () => JSON.parse(text) }; },
  } };
  const request = (file, method = 'PUT', body = 'asset') => worker.fetch(new Request(`https://share.example/tours/abcd/${file}`, { method, ...(method === 'PUT' ? { body, headers: { 'X-Upload-Key': 'test', 'Content-Length': String(body.length) } } : {}) }), env);
  return { files, request, env };
}
test('new assets and manifests commit separately, preserving the previous published revision on failure', async () => {
  const { files, request } = service();
  files.set('tours/abcd/model.glb', 'old asset');
  const old = JSON.stringify({ format: 'archai-vr', model: 'model.glb?v=old', spaces: [] });
  files.set('tours/abcd/tour.json', old);
  const file = `model-${'a'.repeat(32)}.glb`;
  const next = JSON.stringify({ format: 'archai-vr', model: file, spaces: [] });
  assert.equal((await request('tour.json', 'PUT', next)).status, 400);
  assert.equal(files.get('tours/abcd/tour.json'), old);
  assert.equal((await request(file)).status, 200);
  assert.equal(files.get('tours/abcd/tour.json'), old);
  assert.equal((await request('tour.json', 'PUT', next)).status, 200);
  assert.equal(files.get('tours/abcd/tour.json'), next);
  assert.equal(files.get('tours/abcd/model.glb'), 'old asset');
});

test('account metadata failure does not replace the published manifest', async () => {
  const { files, request, env } = service();
  const old = JSON.stringify({ format: 'archai-vr', model: 'model.glb', spaces: [] });
  files.set('tours/abcd/tour.json', old);
  const file = `model-${'c'.repeat(32)}.glb`;
  files.set(`tours/abcd/${file}`, 'ready asset');
  env.DB = { prepare(sql) { return { bind() { return this; }, async first() { return sql.includes('FROM sessions') ? { user_id: 'user', expires_at: '2099-01-01T00:00:00.000Z' } : null; }, async run() { throw new Error('metadata unavailable'); } }; } };
  // Use an account session rather than the legacy upload key.
  const body = JSON.stringify({ format: 'archai-vr', model: file, spaces: [] });
  await assert.rejects(worker.fetch(new Request('https://share.example/tours/abcd/tour.json', { method: 'PUT', body, headers: { Authorization: 'Bearer test', 'Content-Length': String(body.length) } }), env), /metadata unavailable/);
  assert.equal(files.get('tours/abcd/tour.json'), old);
  assert.equal((await request(file, 'GET')).status, 200);
});
test('panorama links require a completed image and serve it with the correct type', async () => {
  const { request } = service();
  const file = `panorama-${'b'.repeat(32)}.png`;
  const tour = JSON.stringify({ format: 'archai-vr', mode: 'panorama', panorama: file, model: '', spaces: [] });
  assert.equal((await request('tour.json', 'PUT', tour)).status, 400);
  assert.equal((await request(file)).status, 200);
  assert.equal((await request('tour.json', 'PUT', tour)).status, 200);
  const image = await request(file, 'GET');
  assert.equal(image.headers.get('Content-Type'), 'image/png');
  assert.equal((await request('toString')).status, 404);
  assert.equal((await request('model-unsafe.glb')).status, 404);
});

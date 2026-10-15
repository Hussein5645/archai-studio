import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from './index.js';

test('multipart upload authenticates parts, validates receipts, and completes only after all parts', async () => {
  const { env, files } = service();
  const file = `model-${'d'.repeat(32)}.glb`;
  let completed = false, aborted = false;
  const received = [];
  env.BUCKET.createMultipartUpload = async () => ({ uploadId: 'session' });
  env.BUCKET.resumeMultipartUpload = (key, id) => {
    assert.equal(key, `tours/abcd/${file}`); assert.equal(id, 'session');
    return {
      async uploadPart(number) { received.push(number); return { partNumber: number, etag: `etag-${number}` }; },
      async complete(parts) { assert.deepEqual(parts, [{ partNumber: 1, etag: 'etag-1' }]); completed = true; files.set(key, 'assembled'); },
      async abort() { aborted = true; },
    };
  };
  const call = (query, method, body, auth = true, extra = {}) => worker.fetch(new Request(`https://share.example/tours/abcd/${file}?${query}`, { method, ...(body ? { body } : {}), headers: { ...(auth ? { 'X-Upload-Key': 'test' } : {}), ...(body ? { 'Content-Length': String(body.length) } : {}), ...extra } }), env);
  assert.equal((await call('multipart=start', 'POST', null, false)).status, 401);
  assert.equal((await (await call('multipart=start', 'POST')).json()).uploadId, 'session');
  assert.equal((await call('uploadId=session&partNumber=65', 'PUT', 'data')).status, 400);
  assert.equal((await call('uploadId=session&partNumber=1', 'PUT', 'data', true, { 'Content-Length': String(9 * 1024 * 1024) })).status, 400);
  assert.equal((await call('uploadId=session&partNumber=1', 'PUT', 'data')).status, 200);
  assert.deepEqual(received, [1]); assert.equal(completed, false);
  assert.equal((await call('uploadId=session', 'POST', JSON.stringify({ parts: [{ partNumber: 2, etag: 'wrong' }] }))).status, 400);
  assert.equal(completed, false);
  assert.equal((await call('uploadId=session', 'POST', JSON.stringify({ parts: [{ partNumber: 1, etag: 'etag-1' }] }))).status, 200);
  assert.equal(completed, true);
  assert.equal((await call('uploadId=session', 'DELETE')).status, 200); assert.equal(aborted, true);
});

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

test('three version slots preserve the original, enforce ownership, and replace a chosen slot', async () => {
  const { files, env } = service();
  const tour = JSON.stringify({ format: 'archai-vr', model: 'model.glb?v=one', lighting: 'live', spaces: [] });
  files.set('tours/abcd/tour.json', tour);
  let owner = 'owner';
  env.DB = { prepare(sql) { return { bind() { return this; }, async first() { return sql.includes('FROM sessions') ? { user_id: 'owner', expires_at: '2099-01-01T00:00:00Z' } : { user_id: owner }; } }; } };
  const pose = { position: [0, 0.8, -1.5], quaternion: [0, 0, 0, 1], scale: [0.01, 0.01, 0.01] };
  const snapshot = { model: 'model.glb?v=one', table: pose, elements: [{ id: 'wall', ...pose }] };
  const save = (slot, body = snapshot, signedIn = true) => worker.fetch(new Request(`https://share.example/tours/abcd/versions/${slot}`, { method: 'PUT', body: JSON.stringify(body), headers: signedIn ? { Authorization: 'Bearer test' } : {} }), env);
  assert.equal((await save(1, snapshot, false)).status, 401);
  owner = 'other'; assert.equal((await save(1)).status, 403); owner = 'owner';
  for (const slot of [1, 2, 3]) assert.equal((await save(slot)).status, 200);
  assert.equal((await save(4)).status, 400);
  const changed = { ...snapshot, elements: [] };
  assert.equal((await save(2, changed)).status, 200);
  const response = await worker.fetch(new Request('https://share.example/tours/abcd/versions'), env);
  const data = await response.json();
  assert.equal(data.versions.length, 3);
  assert.equal(data.versions[0].snapshot.elements.length, 1);
  assert.equal(data.versions[1].snapshot.elements.length, 0);
  assert.equal(files.get('tours/abcd/tour.json'), tour);
  assert.equal((await save(1, { ...snapshot, model: 'stale.glb' })).status, 400);
  assert.equal((await save(1, { ...snapshot, table: { ...pose, scale: [0, 0, 0] } })).status, 400);
  files.set('tours/abcd/tour.json', JSON.stringify({ model: snapshot.model, lighting: 'baked' }));
  assert.equal((await save(1)).status, 400);
  assert.equal((await save(1, changed)).status, 200);
});
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

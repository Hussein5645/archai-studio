/**
 * ArchAI VR share service (Cloudflare Worker over the R2 bucket `archai-vr`).
 *
 *   POST /tours                  reserve a tour id, or confirm `{ id }` to republish it (upload key)
 *   PUT  /tours/<id>/model.glb   upload the model (upload key)
 *   PUT  /tours/<id>/tour.json   upload the tour file (upload key)
 *   GET  /tours/<id>/<file>      read them (public, CORS *), what the viewer loads
 *   GET  /v/<id>                 short link: redirects to the VR viewer with ?tour=
 *   GET  /tours                  the signed-in account's tours (VR Links on the Home screen)
 *   DELETE /tours/<id>           deletes one of the account's tours (its link stops working)
 *
 * Writes need an ArchAI account session as `Authorization: Bearer <token>` (the app, and the
 * plugins through the app's live link), checked against the `archai` D1 database of
 * workers/archai-cloud; tours are recorded under the account in `vr_tours`. While the
 * `UPLOAD_KEY` secret is set, `X-Upload-Key` is still accepted (plugins before 0.4): delete
 * the secret to require accounts everywhere.
 * See docs/vr-tours.md in the ArchAI repo.
 */

const FILES = { 'model.glb': 'model/gltf-binary', 'tour.json': 'application/json' };
const assetType = (file) => (Object.hasOwn(FILES, file) ? FILES[file] : null) || (/^model-[a-f0-9]{32}\.glb$/.test(file) ? 'model/gltf-binary' : /^panorama-[a-f0-9]{32}\.png$/.test(file) ? 'image/png' : null);
const MAX_MODEL_BYTES = 95 * 1024 * 1024;
const MAX_TOUR_BYTES = 512 * 1024;
// No 0/o, 1/l/i: ids are typed by hand on a headset keyboard.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ID = /^[a-z0-9]{4,16}$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Upload-Key',
  'Access-Control-Max-Age': '86400',
};

const reply = (body, status = 200, headers = {}) => new Response(body, { status, headers: { ...CORS, ...headers } });
const json = (value, status = 200) => reply(JSON.stringify(value), status, { 'Content-Type': 'application/json' });
const created = (id) => `tours/${id}/created`;

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

async function sessionUser(request, env) {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !env.DB) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hash = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, '');
  const row = await env.DB.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').bind(hash).first();
  return row && row.expires_at > new Date().toISOString() ? row.user_id : null;
}

/** Who may write: `{ userId }` for an account session, `{ userId: null }` for the upload key, else null. */
async function authorised(request, env) {
  const userId = await sessionUser(request, env);
  if (userId) return { userId };
  const key = request.headers.get('X-Upload-Key') ?? '';
  return Boolean(env.UPLOAD_KEY) && key.length === env.UPLOAD_KEY.length && key === env.UPLOAD_KEY ? { userId: null } : null;
}

/** An account may only republish its own tours (or ones published with the old upload key). */
async function ownedByOther(env, id, userId) {
  if (!userId || !env.DB) return false;
  const row = await env.DB.prepare('SELECT user_id FROM vr_tours WHERE id = ?').bind(id).first();
  return Boolean(row && row.user_id !== userId);
}

async function reserve(request, env, auth) {
  const body = await request.json().catch(() => ({}));
  if (typeof body?.id === 'string' && ID.test(body.id) && (await env.BUCKET.head(created(body.id))) && !(await ownedByOther(env, body.id, auth.userId))) return json({ id: body.id });
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newId();
    if (await env.BUCKET.head(created(id))) continue;
    await env.BUCKET.put(created(id), new Date().toISOString());
    return json({ id }, 201);
  }
  return json({ error: 'Could not reserve a tour id' }, 503);
}

async function upload(request, env, id, file, auth) {
  if (!(await env.BUCKET.head(created(id)))) return json({ error: 'Unknown tour' }, 404);
  if (await ownedByOther(env, id, auth.userId)) return json({ error: 'This tour belongs to another account' }, 403);
  const length = Number(request.headers.get('Content-Length') ?? NaN);
  if (file === 'tour.json') {
    const text = await request.text();
    if (text.length > MAX_TOUR_BYTES) return json({ error: 'Tour file too large' }, 413);
    let tour;
    try {
      tour = JSON.parse(text);
    } catch {
      return json({ error: 'Tour file is not JSON' }, 400);
    }
    if (tour?.format !== 'archai-vr' || !Array.isArray(tour.spaces)) return json({ error: 'Not an ArchAI VR tour' }, 400);
    const asset = tour.mode === 'panorama' ? tour.panorama : typeof tour.model === 'string' ? tour.model.split('?')[0] : null;
    const expectedType = tour.mode === 'panorama' ? 'image/png' : 'model/gltf-binary';
    if (!asset || assetType(asset) !== expectedType || !(await env.BUCKET.head(`tours/${id}/${asset}`))) return json({ error: 'Upload the prepared asset before publishing its tour' }, 400);
    if (auth.userId && env.DB) {
      const at = new Date().toISOString();
      const name = typeof tour.name === 'string' ? tour.name.slice(0, 200) : null;
      await env.DB.prepare('INSERT INTO vr_tours (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at')
        .bind(id, auth.userId, name, at, at)
        .run();
    }
    // This is the commit: metadata failures above must not replace the old scene.
    await env.BUCKET.put(`tours/${id}/tour.json`, text, { httpMetadata: { contentType: FILES[file] } });
    return json({ ok: true });
  }
  if (!Number.isFinite(length)) return json({ error: 'Content-Length required' }, 411);
  if (length > MAX_MODEL_BYTES) return json({ error: `Model too large (${Math.round(length / 1048576)} MB, limit 95 MB)` }, 413);
  await env.BUCKET.put(`tours/${id}/${file}`, request.body, { httpMetadata: { contentType: assetType(file) } });
  return json({ ok: true });
}

async function multipart(request, env, id, file, auth, url) {
  if (file === 'tour.json') return json({ error: 'Manifest cannot be multipart' }, 400);
  if (!(await env.BUCKET.head(created(id)))) return json({ error: 'Unknown tour' }, 404);
  if (await ownedByOther(env, id, auth.userId)) return json({ error: 'This tour belongs to another account' }, 403);
  const key = `tours/${id}/${file}`;
  try {
    if (request.method === 'POST' && url.searchParams.get('multipart') === 'start') {
      const upload = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: assetType(file) } });
      return json({ uploadId: upload.uploadId });
    }
    const uploadId = url.searchParams.get('uploadId');
    if (!uploadId || uploadId.length > 1024) return json({ error: 'Invalid upload id' }, 400);
    const upload = env.BUCKET.resumeMultipartUpload(key, uploadId);
    if (request.method === 'DELETE') { await upload.abort(); return json({ ok: true }); }
    if (request.method === 'PUT') {
      const number = Number(url.searchParams.get('partNumber'));
      const length = Number(request.headers.get('Content-Length'));
      if (!Number.isInteger(number) || number < 1 || number > 64 || !length || length > 8 * 1024 * 1024) return json({ error: 'Invalid upload part (maximum 8 MB, 64 parts)' }, 400);
      return json(await upload.uploadPart(number, request.body));
    }
    if (request.method === 'POST') {
      if (Number(request.headers.get('Content-Length')) > MAX_TOUR_BYTES) return json({ error: 'Part receipts too large' }, 413);
      const { parts } = await request.json();
      if (!Array.isArray(parts) || !parts.length || parts.length > 64 || parts.some((p, i) => p.partNumber !== i + 1 || typeof p.etag !== 'string' || !p.etag || p.etag.length > 200)) return json({ error: 'Invalid part receipts' }, 400);
      await upload.complete(parts);
      return json({ ok: true });
    }
    return reply('Method not allowed', 405);
  } catch {
    return json({ error: 'Upload part failed or expired. Please retry publishing.' }, 503);
  }
}

/** The account's tours, newest first, with the model size and number of stops. */
async function listTours(request, env, userId) {
  const { results } = await env.DB.prepare('SELECT id, name, created_at, updated_at FROM vr_tours WHERE user_id = ? ORDER BY updated_at DESC').bind(userId).all();
  const origin = new URL(request.url).origin;
  const tours = await Promise.all(
    results.map(async (row) => {
      const tour = await env.BUCKET.get(`tours/${row.id}/tour.json`);
      let stops = null;
      let model = null;
      let mode = 'raw';
      try {
        const data = tour ? await tour.json() : null;
        stops = data?.spaces?.length ?? null;
        mode = data?.mode ?? (data?.lighting === 'baked' ? 'baked' : 'raw');
        const asset = mode === 'panorama' ? data?.panorama : data?.model?.split('?')[0];
        if (asset && assetType(asset)) model = await env.BUCKET.head(`tours/${row.id}/${asset}`);
      } catch {
        stops = null;
      }
      return { id: row.id, name: row.name ?? 'VR tour', createdAt: row.created_at, updatedAt: row.updated_at, link: `${origin}/v/${row.id}`, modelBytes: model?.size ?? null, mode, stops, available: Boolean(tour) };
    }),
  );
  return json({ tours });
}

async function deleteTour(env, id, userId) {
  const row = await env.DB.prepare('SELECT user_id FROM vr_tours WHERE id = ?').bind(id).first();
  if (!row || row.user_id !== userId) return json({ error: 'This tour does not exist or is not yours' }, 404);
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix: `tours/${id}/`, ...(cursor ? { cursor } : {}) });
    if (page.objects.length) await env.BUCKET.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await env.DB.prepare('DELETE FROM vr_tours WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

async function read(request, env, id, file) {
  const object = await env.BUCKET.get(`tours/${id}/${file}`, { onlyIf: request.headers });
  if (!object) return reply('Not found', 404);
  const headers = {
    'Content-Type': assetType(file),
    ETag: object.httpEtag,
    // The tour file always revalidates (republishing replaces it); the model URL carries a version.
    'Cache-Control': file === 'tour.json' ? 'no-cache' : 'public, max-age=86400',
  };
  if (!('body' in object)) return reply(null, 304, headers);
  return reply(request.method === 'HEAD' ? null : object.body, 200, headers);
}

// Three fixed slots avoid read/modify/write races and never overwrite tour.json.
async function versions(request, env, id, slot) {
  const original = await env.BUCKET.get(`tours/${id}/tour.json`);
  if (!original) return json({ error: 'Unknown tour' }, 404);
  if (request.method === 'GET' && slot === undefined) {
    const versions = await Promise.all([1, 2, 3].map(async (slot) => {
      const object = await env.BUCKET.get(`tours/${id}/versions/${slot}.json`);
      return { slot, snapshot: object ? await object.json() : null };
    }));
    return json({ versions }, 200, { 'Cache-Control': 'no-store' });
  }
  if (request.method !== 'PUT' || !/^[123]$/.test(slot ?? '')) return json({ error: 'Choose version slot 1, 2 or 3' }, 400);
  const userId = await sessionUser(request, env);
  if (!userId) return json({ error: 'Sign in to save a VR version' }, 401);
  const owner = await env.DB.prepare('SELECT user_id FROM vr_tours WHERE id = ?').bind(id).first();
  if (!owner || owner.user_id !== userId) return json({ error: 'Only the tour owner can save versions' }, 403);
  const text = await request.text();
  if (text.length > MAX_TOUR_BYTES) return json({ error: 'Version too large' }, 413);
  let snapshot;
  try { snapshot = JSON.parse(text); } catch { return json({ error: 'Invalid version' }, 400); }
  const tour = await original.json();
  const vector = (v, n) => Array.isArray(v) && v.length === n && v.every((x) => Number.isFinite(x) && Math.abs(x) <= 1e9);
  const transform = (v) => v && vector(v.position, 3) && vector(v.quaternion, 4) && Math.abs(Math.hypot(...v.quaternion) - 1) < 0.01 && vector(v.scale, 3) && v.scale.every((x) => x > 0 && x <= 1e6);
  if (snapshot?.model !== tour.model || !transform(snapshot.table) || !Array.isArray(snapshot.elements) || snapshot.elements.length > 10000 || snapshot.elements.some((e) => typeof e.id !== 'string' || e.id.length > 200 || !transform(e)) || (tour.lighting === 'baked' && snapshot.elements.length)) return json({ error: 'Invalid version or scene has been republished; reload the original scene' }, 400);
  const saved = { model: tour.model, table: snapshot.table, elements: snapshot.elements, savedAt: new Date().toISOString() };
  await env.BUCKET.put(`tours/${id}/versions/${slot}.json`, JSON.stringify(saved), { httpMetadata: { contentType: 'application/json' } });
  return json({ slot: Number(slot), snapshot: saved });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (request.method === 'OPTIONS') return reply(null, 204);

    if (parts[0] === 'v' && parts.length === 2 && request.method === 'GET') {
      const id = parts[1].toLowerCase();
      if (!ID.test(id) || !(await env.BUCKET.head(`tours/${id}/tour.json`))) return reply('This VR tour does not exist (or was not uploaded completely).', 404, { 'Content-Type': 'text/plain; charset=utf-8' });
      const viewer = new URL(env.VIEWER_URL);
      viewer.searchParams.set('tour', `${url.origin}/tours/${id}/tour.json`);
      return Response.redirect(viewer.toString(), 302);
    }

    if (parts[0] === 'tours') {
      if (parts.length === 1 && request.method === 'POST') {
        const auth = await authorised(request, env);
        return auth ? reserve(request, env, auth) : json({ error: 'Sign in to ArchAI to publish VR tours' }, 401);
      }
      if (parts.length === 1 && request.method === 'GET') {
        const userId = await sessionUser(request, env);
        return userId ? listTours(request, env, userId) : json({ error: 'Sign in to ArchAI to see your VR links' }, 401);
      }
      if (parts.length === 2 && request.method === 'DELETE' && ID.test(parts[1])) {
        const userId = await sessionUser(request, env);
        return userId ? deleteTour(env, parts[1], userId) : json({ error: 'Sign in to ArchAI to manage your VR links' }, 401);
      }
      const [, id, file] = parts;
      if (ID.test(id ?? '') && file === 'versions' && (parts.length === 3 || parts.length === 4)) return versions(request, env, id, parts[3]);
      if (parts.length !== 3 || !ID.test(id ?? '') || !assetType(file ?? '')) return reply('Not found', 404);
      if (url.searchParams.has('multipart') || url.searchParams.has('uploadId')) {
        const auth = await authorised(request, env);
        return auth ? multipart(request, env, id, file, auth, url) : json({ error: 'Sign in to ArchAI to publish VR tours' }, 401);
      }
      if (request.method === 'GET' || request.method === 'HEAD') return read(request, env, id, file);
      if (request.method === 'PUT') {
        const auth = await authorised(request, env);
        return auth ? upload(request, env, id, file, auth) : json({ error: 'Sign in to ArchAI to publish VR tours' }, 401);
      }
      return reply('Method not allowed', 405);
    }

    if (url.pathname === '/') return reply('ArchAI VR share service', 200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return reply('Not found', 404);
  },
};

/**
 * ArchAI VR share service (Cloudflare Worker over the R2 bucket `archai-vr`).
 *
 *   POST /tours                  reserve a tour id, or confirm `{ id }` to republish it (upload key)
 *   PUT  /tours/<id>/model.glb   upload the model (upload key)
 *   PUT  /tours/<id>/tour.json   upload the tour file (upload key)
 *   GET  /tours/<id>/<file>      read them (public, CORS *), what the viewer loads
 *   GET  /v/<id>                 short link: redirects to the SJP-VR viewer with ?tour=
 *
 * Writes need an ArchAI account session as `Authorization: Bearer <token>` (the app, and the
 * plugins through the app's live link), checked against the `archai` D1 database of
 * workers/archai-cloud; tours are recorded under the account in `vr_tours`. While the
 * `UPLOAD_KEY` secret is set, `X-Upload-Key` is still accepted (plugins before 0.4): delete
 * the secret to require accounts everywhere.
 * See docs/vr-tours.md in the ArchAI repo.
 */

const FILES = { 'model.glb': 'model/gltf-binary', 'tour.json': 'application/json' };
const MAX_MODEL_BYTES = 95 * 1024 * 1024;
const MAX_TOUR_BYTES = 512 * 1024;
// No 0/o, 1/l/i: ids are typed by hand on a headset keyboard.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ID = /^[a-z0-9]{4,16}$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, OPTIONS',
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
    await env.BUCKET.put(`tours/${id}/tour.json`, text, { httpMetadata: { contentType: FILES[file] } });
    if (auth.userId && env.DB) {
      const at = new Date().toISOString();
      const name = typeof tour.name === 'string' ? tour.name.slice(0, 200) : null;
      await env.DB.prepare('INSERT INTO vr_tours (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at')
        .bind(id, auth.userId, name, at, at)
        .run();
    }
    return json({ ok: true });
  }
  if (!Number.isFinite(length)) return json({ error: 'Content-Length required' }, 411);
  if (length > MAX_MODEL_BYTES) return json({ error: `Model too large (${Math.round(length / 1048576)} MB, limit 95 MB)` }, 413);
  await env.BUCKET.put(`tours/${id}/${file}`, request.body, { httpMetadata: { contentType: FILES[file] } });
  return json({ ok: true });
}

async function read(request, env, id, file) {
  const object = await env.BUCKET.get(`tours/${id}/${file}`, { onlyIf: request.headers });
  if (!object) return reply('Not found', 404);
  const headers = {
    'Content-Type': FILES[file],
    ETag: object.httpEtag,
    // The tour file always revalidates (republishing replaces it); the model URL carries a version.
    'Cache-Control': file === 'tour.json' ? 'no-cache' : 'public, max-age=86400',
  };
  if (!('body' in object)) return reply(null, 304, headers);
  return reply(request.method === 'HEAD' ? null : object.body, 200, headers);
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
      const [, id, file] = parts;
      if (parts.length !== 3 || !ID.test(id ?? '') || !(file in FILES)) return reply('Not found', 404);
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

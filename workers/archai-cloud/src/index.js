/**
 * ArchAI cloud (Cloudflare Worker): accounts, online projects and the asset/material libraries.
 * See docs/accounts-and-cloud.md in the ArchAI repo.
 *
 *   POST   /auth/signup          { email, name, password }: only when ALLOW_SIGNUP is set (local
 *                                development); accounts are made by the owner with admin.mjs
 *   POST   /auth/password        { current, password } changes your password
 *   POST   /auth/login           { email, password }       -> { token, user, libraryToken }
 *   POST   /auth/logout          ends this session
 *   GET    /me                   -> { user, libraryToken }
 *
 *   GET    /projects             the projects you can open
 *   POST   /projects             { name } -> { id }   reserves a project; upload it with PUT
 *   GET    /projects/<id>        the document (JSON); X-Version, X-Role headers
 *   PUT    /projects/<id>        saves the document; X-Base-Version must match (409 otherwise)
 *   DELETE /projects/<id>        owner only
 *   GET    /projects/<id>/live   WebSocket to the project's board (src/board.js); the token comes as
 *                                the `auth.<token>` subprotocol
 *   GET    /projects/<id>/ops?since=V, POST /projects/<id>/ops   edits too large for the socket
 *   GET/POST /projects/<id>/members, PATCH/DELETE /projects/<id>/members/<userId>   (owner)
 *   POST   /projects/<id>/invites { role, days? } -> { token, link }; DELETE .../invites/<token>
 *   GET    /invites/<token>      what an invite is for; POST /invites/<token>/accept joins
 *   GET    /invite/<token>       the page an invite link opens (Open in ArchAI)
 *
 *   GET    /lib/<libraryToken>/<key>   a file of the `archai-assets` bucket (signed-in users)
 *
 * Everything except /lib and / needs `Authorization: Bearer <token>`. Tokens are random and only
 * their SHA-256 is stored. Library tokens are HMACs (LIBRARY_SECRET) so they also work in <img>.
 */

const SESSION_DAYS = 90;
const LIBRARY_TOKEN_DAYS = 30;
const MAX_PROJECT_BYTES = 90 * 1024 * 1024;
const PBKDF2_ITERATIONS = 100000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROJECT_ID = /^p_[a-z0-9]{20}$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Base-Version',
  'Access-Control-Expose-Headers': 'X-Version, X-Role, ETag, Content-Length',
  'Access-Control-Max-Age': '86400',
};

const reply = (body, status = 200, headers = {}) => new Response(body, { status, headers: { ...CORS, ...headers } });
const json = (value, status = 200, headers = {}) => reply(JSON.stringify(value), status, { 'Content-Type': 'application/json', ...headers });
const fail = (status, error) => json({ error }, status);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- encoding and crypto -----------------------------------------------------------------------

const encoder = new TextEncoder();

function b64url(bytes) {
  let text = '';
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text) {
  const plain = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(plain, (c) => c.charCodeAt(0));
}

function randomId(bytes) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => alphabet[b % alphabet.length]).join('');
}

async function sha256(text) {
  return b64url(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

async function hashPassword(password, saltB64) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64url(saltB64), iterations: PBKDF2_ITERATIONS }, key, 256);
  return b64url(bits);
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, encoder.encode(text)));
}

async function libraryToken(env, userId) {
  const expires = Math.floor(Date.now() / 1000) + LIBRARY_TOKEN_DAYS * 86400;
  const body = `${userId}.${expires}`;
  return `${body}.${await hmac(env.LIBRARY_SECRET, body)}`;
}

async function libraryTokenValid(env, token) {
  const parts = token.split('.');
  if (parts.length !== 3 || !env.LIBRARY_SECRET) return false;
  const [userId, expires, signature] = parts;
  if (!(Number(expires) * 1000 > Date.now())) return false;
  return sameText(signature, await hmac(env.LIBRARY_SECRET, `${userId}.${expires}`));
}

// ---- sessions ----------------------------------------------------------------------------------

const now = () => new Date().toISOString();
const daysFromNow = (days) => new Date(Date.now() + days * 86400000).toISOString();
const publicUser = (row) => ({ id: row.id, email: row.email, name: row.name });

async function startSession(env, user, request) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const device = (request.headers.get('User-Agent') ?? '').slice(0, 200);
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, device) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256(token), user.id, now(), daysFromNow(SESSION_DAYS), device)
    .run();
  return { token, user: publicUser(user), libraryToken: await libraryToken(env, user.id) };
}

/** The signed-in user, or a 401. Sessions slide: in use within 30 days of expiry, they renew. */
async function requireUser(request, env, fromProtocol = '') {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : fromProtocol;
  if (!token) throw new HttpError(401, 'Sign in required');
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    'SELECT users.id, users.email, users.name, sessions.expires_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?',
  )
    .bind(tokenHash)
    .first();
  if (!row || row.expires_at < now()) throw new HttpError(401, 'Your session has ended: sign in again');
  if (row.expires_at < daysFromNow(SESSION_DAYS - 30)) {
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(daysFromNow(SESSION_DAYS), tokenHash).run();
  }
  return { user: publicUser(row), tokenHash };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Expected a JSON body');
  }
}

/** Who to ask for an account (shown when sign-up is closed); the CONTACT_EMAIL var. */
const contact = (env) => env.CONTACT_EMAIL || 'the ArchAI team';

async function signup(request, env) {
  // Accounts are by invitation: the owner creates them (admin.mjs). Open only in local development.
  if (!env.ALLOW_SIGNUP) throw new HttpError(403, `ArchAI accounts are by invitation for now: email ${contact(env)} to get one`);
  const body = await readJson(request);
  const email = String(body?.email ?? '').trim().toLowerCase();
  const name = String(body?.name ?? '').trim().slice(0, 80) || email.split('@')[0];
  const password = String(body?.password ?? '');
  if (!EMAIL.test(email) || email.length > 200) throw new HttpError(400, 'Enter a valid email address');
  if (password.length < 8) throw new HttpError(400, 'The password needs at least 8 characters');
  if (password.length > 200) throw new HttpError(400, 'The password is too long');
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) throw new HttpError(409, 'An account with this email already exists: sign in instead');
  const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const user = { id: `u_${randomId(20)}`, email, name };
  await env.DB.prepare('INSERT INTO users (id, email, name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(user.id, email, name, await hashPassword(password, salt), salt, now())
    .run();
  return json(await startSession(env, user, request), 201);
}

async function changePassword(request, env) {
  const { user } = await requireUser(request, env);
  const body = await readJson(request);
  const current = String(body?.current ?? '');
  const password = String(body?.password ?? '');
  if (password.length < 8) throw new HttpError(400, 'The new password needs at least 8 characters');
  if (password.length > 200) throw new HttpError(400, 'The new password is too long');
  const row = await env.DB.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?').bind(user.id).first();
  if (!row || !sameText(await hashPassword(current, row.password_salt), row.password_hash)) throw new HttpError(403, 'The current password is not right');
  const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').bind(await hashPassword(password, salt), salt, user.id).run();
  return json({ ok: true });
}

async function login(request, env) {
  const body = await readJson(request);
  const email = String(body?.email ?? '').trim().toLowerCase();
  const password = String(body?.password ?? '');
  const row = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  // Hash even for unknown emails, so timing does not tell which accounts exist.
  const hash = await hashPassword(password, row?.password_salt ?? 'AAAAAAAAAAAAAAAAAAAAAA');
  if (!row || !sameText(hash, row.password_hash)) throw new HttpError(401, `Wrong email or password. No account yet? Email ${contact(env)}`);
  return json(await startSession(env, row, request));
}

// ---- projects ----------------------------------------------------------------------------------

async function roleOf(env, projectId, userId) {
  const row = await env.DB.prepare('SELECT role FROM members WHERE project_id = ? AND user_id = ?').bind(projectId, userId).first();
  return row?.role ?? null;
}

async function requireRole(env, projectId, user, roles = ['owner', 'editor', 'viewer']) {
  const role = await roleOf(env, projectId, user.id);
  if (!role) throw new HttpError(404, 'This project does not exist or was not shared with you');
  if (!roles.includes(role)) throw new HttpError(403, role === 'viewer' ? 'You can view this project but not edit it' : 'Only the owner can do that');
  return role;
}

/** The project's live board (src/board.js); every read and write of the document goes through it. */
function board(env, projectId, user, role, path, init = {}) {
  const stub = env.BOARD.get(env.BOARD.idFromName(projectId));
  const headers = new Headers(init.headers);
  headers.set('X-Project-Id', projectId);
  if (user) {
    headers.set('X-User-Id', user.id);
    headers.set('X-User-Name', user.name);
  }
  if (role) headers.set('X-Role', role);
  return stub.fetch(new Request(`https://board${path}`, { ...init, headers }));
}

/** A board response, with the CORS headers the app needs. */
async function relay(response, extra = {}) {
  if (response.status === 101) return response;
  const headers = { ...Object.fromEntries(response.headers), ...extra };
  return reply(response.body, response.status, headers);
}

async function listProjects(env, user) {
  const { results } = await env.DB.prepare(
    `SELECT projects.id, projects.name, projects.version, projects.bytes, projects.created_at, projects.updated_at,
            members.role, owners.name AS owner_name,
            (SELECT COUNT(*) FROM members AS others WHERE others.project_id = projects.id) AS member_count
       FROM members
       JOIN projects ON projects.id = members.project_id
       JOIN users AS owners ON owners.id = projects.owner_id
      WHERE members.user_id = ?
      ORDER BY projects.updated_at DESC`,
  )
    .bind(user.id)
    .all();
  return json({
    projects: results.map((row) => ({
      id: row.id,
      name: row.name,
      version: row.version,
      bytes: row.bytes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      role: row.role,
      owner: row.owner_name,
      members: row.member_count,
    })),
  });
}

async function createProject(request, env, user) {
  const body = await readJson(request);
  const name = String(body?.name ?? '').trim().slice(0, 200) || 'Untitled Project';
  const id = `p_${randomId(20)}`;
  const at = now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO projects (id, owner_id, name, version, bytes, created_at, updated_at, updated_by) VALUES (?, ?, ?, 0, 0, ?, ?, ?)').bind(id, user.id, name, at, at, user.id),
    env.DB.prepare("INSERT INTO members (project_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)").bind(id, user.id, at),
  ]);
  return json({ id, version: 0 }, 201);
}

async function readProject(request, env, user, id) {
  const role = await requireRole(env, id, user);
  return relay(await board(env, id, user, role, '/doc'), { 'Cache-Control': 'no-store', 'X-Role': role });
}

async function saveProject(request, env, user, id) {
  const role = await requireRole(env, id, user, ['owner', 'editor']);
  const base = Number(request.headers.get('X-Base-Version'));
  if (!Number.isInteger(base) || base < 0) throw new HttpError(400, 'X-Base-Version header required');
  const text = await request.text();
  if (text.length > MAX_PROJECT_BYTES) throw new HttpError(413, 'The project is too large to put online (limit 90 MB)');
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'The project is not valid JSON');
  }
  if (!doc || typeof doc !== 'object' || doc.id !== id) throw new HttpError(400, 'The document id does not match this project');
  return relay(await board(env, id, user, role, '/save', { method: 'PUT', body: text, headers: { 'X-Base-Version': String(base) } }));
}

async function deleteProject(env, user, id) {
  await requireRole(env, id, user, ['owner']);
  await board(env, id, user, 'owner', '/delete', { method: 'POST' });
  await env.DB.batch([
    env.DB.prepare('DELETE FROM invites WHERE project_id = ?').bind(id),
    env.DB.prepare('DELETE FROM members WHERE project_id = ?').bind(id),
    env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id),
  ]);
  await env.PROJECTS.delete(`projects/${id}.json`);
  return json({ ok: true });
}

// ---- members and invites -----------------------------------------------------------------------

const ROLES = ['editor', 'viewer'];

async function members(env, user, id) {
  const role = await requireRole(env, id, user);
  const { results } = await env.DB.prepare(
    `SELECT users.id, users.name, users.email, members.role, members.added_at
       FROM members JOIN users ON users.id = members.user_id
      WHERE members.project_id = ?
      ORDER BY CASE members.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, users.name`,
  )
    .bind(id)
    .all();
  const out = { role, members: results.map((row) => ({ userId: row.id, name: row.name, email: row.email, role: row.role, addedAt: row.added_at })), invites: [] };
  if (role === 'owner') {
    const invites = await env.DB.prepare('SELECT token, role, created_at, expires_at, uses FROM invites WHERE project_id = ? ORDER BY created_at DESC').bind(id).all();
    out.invites = invites.results.map((row) => ({ token: row.token, role: row.role, createdAt: row.created_at, expiresAt: row.expires_at, uses: row.uses }));
  }
  return json(out);
}

/** Owner adds someone who already has an account. */
async function addMember(request, env, user, id) {
  await requireRole(env, id, user, ['owner']);
  const body = await readJson(request);
  const email = String(body?.email ?? '').trim().toLowerCase();
  const role = ROLES.includes(body?.role) ? body.role : 'editor';
  const target = await env.DB.prepare('SELECT id, name FROM users WHERE email = ?').bind(email).first();
  if (!target) throw new HttpError(404, 'Nobody has an ArchAI account with that email yet: send them an invite link instead');
  const existing = await roleOf(env, id, target.id);
  if (existing === 'owner') throw new HttpError(400, 'That is the owner');
  await env.DB.prepare('INSERT INTO members (project_id, user_id, role, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role').bind(id, target.id, role, now()).run();
  if (existing) await board(env, id, null, null, '/member', { method: 'POST', body: JSON.stringify({ userId: target.id, role }) });
  return members(env, user, id);
}

async function setMember(request, env, user, id, memberId) {
  await requireRole(env, id, user, ['owner']);
  const body = await readJson(request);
  const role = ROLES.includes(body?.role) ? body.role : null;
  if (!role) throw new HttpError(400, 'Role must be editor or viewer');
  const existing = await roleOf(env, id, memberId);
  if (!existing) throw new HttpError(404, 'Not a member of this project');
  if (existing === 'owner') throw new HttpError(400, 'The owner stays the owner');
  await env.DB.prepare('UPDATE members SET role = ? WHERE project_id = ? AND user_id = ?').bind(role, id, memberId).run();
  await board(env, id, null, null, '/member', { method: 'POST', body: JSON.stringify({ userId: memberId, role }) });
  return members(env, user, id);
}

/** The owner removes someone, or a member leaves. */
async function removeMember(env, user, id, memberId) {
  const role = await requireRole(env, id, user);
  if (memberId !== user.id && role !== 'owner') throw new HttpError(403, 'Only the owner can remove people');
  const existing = await roleOf(env, id, memberId);
  if (!existing) throw new HttpError(404, 'Not a member of this project');
  if (existing === 'owner') throw new HttpError(400, 'The owner cannot leave their own project: delete it instead');
  await env.DB.prepare('DELETE FROM members WHERE project_id = ? AND user_id = ?').bind(id, memberId).run();
  await board(env, id, null, null, '/member', { method: 'POST', body: JSON.stringify({ userId: memberId, role: null }) });
  return memberId === user.id ? json({ ok: true }) : members(env, user, id);
}

async function createInvite(request, env, user, id, origin) {
  await requireRole(env, id, user, ['owner']);
  const body = await readJson(request);
  const role = ROLES.includes(body?.role) ? body.role : 'editor';
  const days = Number(body?.days);
  const expires = Number.isFinite(days) && days > 0 ? daysFromNow(Math.min(days, 365)) : null;
  const token = randomId(24);
  await env.DB.prepare('INSERT INTO invites (token, project_id, role, created_by, created_at, expires_at, uses) VALUES (?, ?, ?, ?, ?, ?, 0)').bind(token, id, role, user.id, now(), expires).run();
  return json({ token, role, expiresAt: expires, link: `${origin}/invite/${token}` }, 201);
}

async function deleteInvite(env, user, id, token) {
  await requireRole(env, id, user, ['owner']);
  await env.DB.prepare('DELETE FROM invites WHERE token = ? AND project_id = ?').bind(token, id).run();
  return members(env, user, id);
}

async function inviteInfo(env, token) {
  const row = await env.DB.prepare(
    `SELECT invites.role, invites.expires_at, invites.project_id, projects.name AS project, users.name AS owner
       FROM invites JOIN projects ON projects.id = invites.project_id JOIN users ON users.id = projects.owner_id
      WHERE invites.token = ?`,
  )
    .bind(token)
    .first();
  if (!row) return null;
  return { projectId: row.project_id, project: row.project, owner: row.owner, role: row.role, expired: Boolean(row.expires_at && row.expires_at < now()) };
}

async function acceptInvite(env, user, token) {
  const info = await inviteInfo(env, token);
  if (!info) throw new HttpError(404, 'This invite link is not valid (it may have been withdrawn)');
  if (info.expired) throw new HttpError(410, 'This invite link has expired: ask for a new one');
  const existing = await roleOf(env, info.projectId, user.id);
  const rank = { viewer: 0, editor: 1, owner: 2 };
  if (!existing || rank[info.role] > rank[existing]) {
    await env.DB.prepare('INSERT INTO members (project_id, user_id, role, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role')
      .bind(info.projectId, user.id, info.role, now())
      .run();
    if (existing) await board(env, info.projectId, null, null, '/member', { method: 'POST', body: JSON.stringify({ userId: user.id, role: info.role }) });
  }
  await env.DB.prepare('UPDATE invites SET uses = uses + 1 WHERE token = ?').bind(token).run();
  return json({ projectId: info.projectId, project: info.project, role: existing && rank[existing] >= rank[info.role] ? existing : info.role });
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** What an invite link opens in a browser: open it in ArchAI. */
async function invitePage(env, token) {
  const info = await inviteInfo(env, token);
  const web = env.WEB_APP_URL ? `${env.WEB_APP_URL.replace(/\/+$/, '')}/?invite=${encodeURIComponent(token)}` : null;
  const body = !info
    ? '<h1>This invite link is not valid</h1><p>It may have been withdrawn. Ask the project owner for a new one.</p>'
    : info.expired
      ? '<h1>This invite link has expired</h1><p>Ask the project owner for a new one.</p>'
      : `<h1>${escapeHtml(info.owner)} invited you to “${escapeHtml(info.project)}”</h1>
         <p>You will join as <b>${info.role === 'viewer' ? 'a viewer' : 'an editor'}</b>. You need an ArchAI account to open it: accounts are by invitation for now, email <a href="mailto:${escapeHtml(contact(env))}">${escapeHtml(contact(env))}</a> for one.</p>
         <p><a class="button" href="archai://invite/${encodeURIComponent(token)}">Open in ArchAI</a>${web ? ` <a class="button secondary" href="${escapeHtml(web)}">Open in the browser</a>` : ''}</p>
         <p class="small">Or in ArchAI: Home → <b>Join with a link</b>, and paste this page's address.</p>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ArchAI invite</title>
<style>:root{color-scheme:light dark;--bg:#f6f6f7;--card:#fff;--text:#18181b;--muted:#52525b;--accent:#2563eb}@media (prefers-color-scheme:dark){:root{--bg:#111113;--card:#1c1c1f;--text:#f4f4f5;--muted:#a1a1aa}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}
main{max-width:480px;background:var(--card);border-radius:14px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 10px}p{color:var(--muted)}
.button{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:600;margin:4px 6px 4px 0}.secondary{background:transparent;color:var(--accent);border:1px solid var(--accent)}.small{font-size:13px}</style></head>
<body><main><p class="small">ArchAI</p>${body}</main></body></html>`;
  return reply(html, info ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
}

// ---- live connection ---------------------------------------------------------------------------

/** WebSocket to a project's board; the session token comes as the `auth.<token>` subprotocol. */
async function live(request, env, id) {
  const protocols = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map((p) => p.trim());
  const token = protocols.find((p) => p.startsWith('auth.'))?.slice(5) ?? '';
  const { user } = await requireUser(request, env, token);
  const role = await requireRole(env, id, user);
  return board(env, id, user, role, '/live', { headers: { Upgrade: 'websocket' } });
}

async function ops(request, env, user, id) {
  const url = new URL(request.url);
  if (request.method === 'GET') {
    const role = await requireRole(env, id, user);
    return relay(await board(env, id, user, role, `/ops?since=${encodeURIComponent(url.searchParams.get('since') ?? '')}`));
  }
  const role = await requireRole(env, id, user, ['owner', 'editor']);
  return relay(await board(env, id, user, role, '/ops', { method: 'POST', body: await request.text() }));
}

// ---- libraries ---------------------------------------------------------------------------------

async function libraryFile(request, env, token, key) {
  if (!(await libraryTokenValid(env, token))) return fail(401, 'Sign in to ArchAI to use the libraries');
  if (!key || key.includes('..')) return reply('Not found', 404);
  const object = await env.ASSETS.get(key, { onlyIf: request.headers });
  if (!object) return reply('Not found', 404);
  const headers = {
    'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
    ETag: object.httpEtag,
    // Index files change when the library grows; packages and images do not.
    'Cache-Control': key.endsWith('.json') ? 'no-cache' : 'private, max-age=86400',
  };
  if (!('body' in object)) return reply(null, 304, headers);
  return reply(request.method === 'HEAD' ? null : object.body, 200, headers);
}

// ---- routing -----------------------------------------------------------------------------------

async function route(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const method = request.method;

  if (parts[0] === 'lib' && parts.length >= 3 && (method === 'GET' || method === 'HEAD')) {
    const key = parts.slice(2).map((part) => decodeURIComponent(part)).join('/');
    return libraryFile(request, env, parts[1], key);
  }
  if (parts.length === 0) return reply('ArchAI cloud', 200, { 'Content-Type': 'text/plain; charset=utf-8' });
  if (parts[0] === 'invite' && parts.length === 2 && method === 'GET') return invitePage(env, parts[1]);

  if (parts[0] === 'auth' && parts.length === 2 && method === 'POST') {
    if (parts[1] === 'signup') return signup(request, env);
    if (parts[1] === 'password') return changePassword(request, env);
    if (parts[1] === 'login') return login(request, env);
    if (parts[1] === 'logout') {
      const { tokenHash } = await requireUser(request, env);
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
      return json({ ok: true });
    }
  }

  if (parts[0] === 'me' && parts.length === 1 && method === 'GET') {
    const { user } = await requireUser(request, env);
    return json({ user, libraryToken: await libraryToken(env, user.id) });
  }

  if (parts[0] === 'invites' && parts.length >= 2) {
    const token = parts[1];
    if (parts.length === 2 && method === 'GET') {
      const info = await inviteInfo(env, token);
      if (!info) throw new HttpError(404, 'This invite link is not valid (it may have been withdrawn)');
      return json({ project: info.project, owner: info.owner, role: info.role, expired: info.expired });
    }
    if (parts.length === 3 && parts[2] === 'accept' && method === 'POST') {
      const { user } = await requireUser(request, env);
      return acceptInvite(env, user, token);
    }
  }

  if (parts[0] === 'projects') {
    if (parts.length === 3 && parts[2] === 'live' && PROJECT_ID.test(parts[1])) return live(request, env, parts[1]);
    const { user } = await requireUser(request, env);
    if (parts.length === 1) {
      if (method === 'GET') return listProjects(env, user);
      if (method === 'POST') return createProject(request, env, user);
    }
    const id = parts[1];
    if (!PROJECT_ID.test(id ?? '')) return reply('Not found', 404);
    if (parts.length === 2) {
      if (method === 'GET' || method === 'HEAD') return readProject(request, env, user, id);
      if (method === 'PUT') return saveProject(request, env, user, id);
      if (method === 'DELETE') return deleteProject(env, user, id);
    }
    if (parts[2] === 'ops' && parts.length === 3) return ops(request, env, user, id);
    if (parts[2] === 'members') {
      if (parts.length === 3 && method === 'GET') return members(env, user, id);
      if (parts.length === 3 && method === 'POST') return addMember(request, env, user, id);
      if (parts.length === 4 && method === 'PATCH') return setMember(request, env, user, id, parts[3]);
      if (parts.length === 4 && method === 'DELETE') return removeMember(env, user, id, parts[3]);
    }
    if (parts[2] === 'invites') {
      if (parts.length === 3 && method === 'POST') return createInvite(request, env, user, id, url.origin);
      if (parts.length === 4 && method === 'DELETE') return deleteInvite(env, user, id, parts[3]);
    }
  }
  return reply('Not found', 404);
}

export { Board } from './board.js';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return reply(null, 204);
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) return fail(error.status, error.message);
      console.error(error);
      return fail(500, 'Something went wrong on the ArchAI server');
    }
  },
};

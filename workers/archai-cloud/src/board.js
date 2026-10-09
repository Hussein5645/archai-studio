/**
 * Board: the live copy of one online project (a Durable Object per project, named by its id).
 * See docs/accounts-and-cloud.md, "Editing together".
 *
 * It is the only writer of the project while it lives: every read and save of the document goes
 * through it. Edits arrive as batches of immer patches (what the app's command executor produces),
 * are applied in arrival order and numbered (`version`), then forwarded to everyone else on the
 * board. Each batch is written to this object's storage before it is acknowledged, and the whole
 * document goes to R2 (`projects/<id>.json`) every FLUSH_MS of activity, when the last person
 * leaves, and at once for very large batches; loading replays the stored batches after the R2
 * copy, so nothing acknowledged is lost when the object is evicted.
 *
 * WebSockets use the hibernation API (an idle board costs nothing); each socket's attachment holds
 * who it is (`sid`, user, name, colour, role) and their presence (cursor, selection).
 *
 *   client -> board  { t: 'hello', since }                 after connecting: what it already has
 *                    { t: 'ops', clientId, seq, patches }   a local edit (editors and owners)
 *                    { t: 'presence', cursor, selection }   cursor in board mm, selected ids
 *   board -> client  { t: 'welcome', you, peers, version }
 *                    { t: 'ops', version, sid, patches }    someone's edit (also replayed after hello)
 *                    { t: 'fetch', version }                an edit too large for a message: GET /ops
 *                    { t: 'synced', version }               hello answered, nothing missing
 *                    { t: 'stale', version }                too far behind: reload the document
 *                    { t: 'reset', version }                the document was replaced: reload it
 *                    { t: 'ack', seq, version } / { t: 'reject', seq, reason }
 *                    { t: 'peer', peer } / { t: 'leave', sid } / { t: 'presence', sid, cursor, selection }
 *                    { t: 'role', role } / { t: 'removed' } / { t: 'deleted' }
 */
import { DurableObject } from 'cloudflare:workers';
import { applyPatches, enablePatches } from 'immer';

enablePatches();

const FLUSH_MS = 20000;
/** Batches larger than this are not kept in object storage (2 MB value limit): R2 at once. */
const STORE_LIMIT = 1_500_000;
/** Larger edits are announced (`fetch`) instead of sent over the socket. */
const MESSAGE_LIMIT = 512 * 1024;
const LOG_COUNT = 2000;
const LOG_BYTES = 48 * 1024 * 1024;
const COLOURS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5'];

const pad = (version) => String(version).padStart(12, '0');
const opKey = (version) => `op:${pad(version)}`;
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function colourOf(userId) {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return COLOURS[Math.abs(hash) % COLOURS.length];
}

class Rejected extends Error {}

/** Whether `patch` applies to `doc`: its parent exists, and what it replaces or removes too. */
function applicable(doc, patch) {
  const path = patch.path;
  if (!Array.isArray(path) || path.length === 0) return false;
  let node = doc;
  for (let i = 0; i < path.length - 1; i++) {
    if (node === null || typeof node !== 'object') return false;
    node = node[path[i]];
  }
  if (node === null || typeof node !== 'object') return false;
  const key = path[path.length - 1];
  if (patch.op === 'add') return Array.isArray(node) ? typeof key === 'number' && key <= node.length : true;
  if (patch.op === 'replace' || patch.op === 'remove') {
    if (Array.isArray(node)) return key === 'length' || (typeof key === 'number' && key < node.length);
    return Object.prototype.hasOwnProperty.call(node, key);
  }
  return false;
}

/**
 * Applies a batch, or throws Rejected when it no longer fits the document (someone deleted what
 * it edits) or would leave a broken reference (an element under a deleted parent, an instance of
 * a deleted definition).
 */
function applyBatch(doc, patches) {
  if (!Array.isArray(patches) || patches.length === 0) throw new Rejected('Empty edit');
  let next = doc;
  const touched = { elements: new Set(), definitions: new Set() };
  for (const patch of patches) {
    if (!patch || typeof patch !== 'object' || !applicable(next, patch)) throw new Rejected('The edit no longer fits the document');
    if (patch.path[0] === 'id' || patch.path[0] === 'schemaVersion') throw new Rejected('The document id cannot change');
    next = applyPatches(next, [patch]);
    const [table, id] = patch.path;
    if ((table === 'elements' || table === 'definitions') && typeof id === 'string') touched[table].add(id);
  }
  const elements = next.elements ?? {};
  const definitions = next.definitions ?? {};
  const removedElements = [...touched.elements].filter((id) => !elements[id]);
  const removedDefinitions = [...touched.definitions].filter((id) => !definitions[id]);
  for (const id of touched.elements) {
    const element = elements[id];
    if (!element) continue;
    if (element.parentId && !elements[element.parentId]) throw new Rejected('The group it belongs to was deleted');
    if (element.definitionId && !definitions[element.definitionId]) throw new Rejected('What it shows was deleted');
  }
  if (removedElements.length || removedDefinitions.length) {
    const goneElements = new Set(removedElements);
    const goneDefinitions = new Set(removedDefinitions);
    for (const element of Object.values(elements)) {
      if (element.parentId && goneElements.has(element.parentId)) throw new Rejected('Someone added to what this deletes');
      if (element.definitionId && goneDefinitions.has(element.definitionId)) throw new Rejected('Someone placed what this deletes');
    }
  }
  return next;
}

export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.doc = null;
    this.version = 0;
    this.flushed = 0;
    /** Recent batches: { version, sid, clientId, seq, patches, size } (in memory only). */
    this.log = [];
    this.logBytes = 0;
    this.projectId = null;
    this.loading = null;
  }

  // ---- loading and saving ------------------------------------------------------------------

  async ensureLoaded() {
    if (this.doc) return;
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    await this.loading;
  }

  async load() {
    this.projectId ??= await this.ctx.storage.get('projectId');
    if (!this.projectId) throw new Error('Board without a project');
    const object = await this.env.PROJECTS.get(`projects/${this.projectId}.json`);
    if (!object) throw Object.assign(new Error('This project has not been uploaded yet'), { status: 404 });
    let doc = JSON.parse(await object.text());
    let flushed = await this.ctx.storage.get('flushed');
    if (flushed === undefined) {
      const row = await this.env.DB.prepare('SELECT version FROM projects WHERE id = ?').bind(this.projectId).first();
      flushed = row?.version ?? 0;
    }
    let version = flushed;
    const log = [];
    const stored = await this.ctx.storage.list({ prefix: 'op:' });
    for (const [, entry] of stored) {
      if (entry.version <= flushed) continue;
      try {
        doc = applyBatch(doc, entry.patches);
      } catch {
        continue; // applied once already, so this cannot happen; never block loading on it
      }
      version = entry.version;
      log.push({ ...entry, size: JSON.stringify(entry.patches).length });
    }
    this.doc = doc;
    this.version = version;
    this.flushed = flushed;
    this.log = log;
    this.logBytes = log.reduce((sum, entry) => sum + entry.size, 0);
  }

  async flush() {
    if (!this.doc || this.version === this.flushed) return;
    const version = this.version;
    const text = JSON.stringify(this.doc);
    await this.env.PROJECTS.put(`projects/${this.projectId}.json`, text, { httpMetadata: { contentType: 'application/json' } });
    const name = String(this.doc.meta?.name ?? '').slice(0, 200) || 'Untitled Project';
    await this.env.DB.prepare('UPDATE projects SET version = ?, name = ?, bytes = ?, updated_at = ? WHERE id = ?').bind(version, name, text.length, new Date().toISOString(), this.projectId).run();
    this.flushed = version;
    await this.ctx.storage.put('flushed', version);
    // The R2 copy now has them.
    const keys = [...(await this.ctx.storage.list({ prefix: 'op:', end: opKey(version + 1) })).keys()];
    for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128));
  }

  async alarm() {
    await this.ensureLoaded().catch(() => undefined);
    await this.flush();
  }

  scheduleFlush() {
    void this.ctx.storage.getAlarm().then((at) => {
      if (at === null) return this.ctx.storage.setAlarm(Date.now() + FLUSH_MS);
    });
  }

  // ---- edits -------------------------------------------------------------------------------

  /** Applies one client batch; returns its version (again for a batch sent twice). */
  async apply(sid, clientId, seq, patches) {
    await this.ensureLoaded();
    const seen = this.log.find((entry) => entry.clientId === clientId && entry.seq === seq);
    if (seen) return seen.version;
    this.doc = applyBatch(this.doc, patches);
    this.version += 1;
    const version = this.version;
    const size = JSON.stringify(patches).length;
    const entry = { version, sid, clientId, seq, patches };
    this.log.push({ ...entry, size });
    this.logBytes += size;
    while (this.log.length > LOG_COUNT || this.logBytes > LOG_BYTES) this.logBytes -= this.log.shift().size;
    if (size > STORE_LIMIT) await this.flush();
    else {
      await this.ctx.storage.put(opKey(version), entry);
      this.scheduleFlush();
    }
    const message = size > MESSAGE_LIMIT ? JSON.stringify({ t: 'fetch', version }) : JSON.stringify({ t: 'ops', version, sid, patches });
    this.broadcast(message, sid);
    return version;
  }

  // ---- sockets -----------------------------------------------------------------------------

  sockets() {
    return this.ctx.getWebSockets();
  }

  peers() {
    return this.sockets()
      .map((ws) => ws.deserializeAttachment())
      .filter(Boolean)
      .map(({ sid, userId, name, colour, role, cursor, selection }) => ({ sid, userId, name, colour, role, cursor: cursor ?? null, selection: selection ?? [] }));
  }

  broadcast(message, exceptSid = null) {
    for (const ws of this.sockets()) {
      const att = ws.deserializeAttachment();
      if (att && att.sid === exceptSid) continue;
      try {
        ws.send(message);
      } catch {
        // closing
      }
    }
  }

  async webSocketMessage(ws, raw) {
    const att = ws.deserializeAttachment();
    if (!att) return;
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    const send = (value) => ws.send(JSON.stringify(value));
    if (message.t === 'hello') {
      try {
        await this.ensureLoaded();
      } catch (error) {
        send({ t: 'deleted', reason: error.message });
        ws.close(4404, 'gone');
        return;
      }
      const since = Number(message.since);
      if (since === this.version) return send({ t: 'synced', version: this.version });
      const oldest = this.log.length ? this.log[0].version : this.version + 1;
      if (!Number.isInteger(since) || since > this.version || since < oldest - 1) return send({ t: 'stale', version: this.version });
      for (const entry of this.log) {
        if (entry.version <= since) continue;
        send(entry.size > MESSAGE_LIMIT ? { t: 'fetch', version: entry.version } : { t: 'ops', version: entry.version, sid: entry.sid, patches: entry.patches });
      }
      return send({ t: 'synced', version: this.version });
    }
    if (message.t === 'ops') {
      const seq = Number(message.seq);
      if (att.role === 'viewer') return send({ t: 'reject', seq, reason: 'You can view this project but not edit it' });
      try {
        const version = await this.apply(att.sid, String(message.clientId ?? ''), seq, message.patches);
        send({ t: 'ack', seq, version });
      } catch (error) {
        send({ t: 'reject', seq, reason: error instanceof Rejected ? error.message : 'The edit could not be applied' });
      }
      return;
    }
    if (message.t === 'presence') {
      const cursor = message.cursor && Number.isFinite(message.cursor.x) && Number.isFinite(message.cursor.y) ? { x: message.cursor.x, y: message.cursor.y } : null;
      const selection = Array.isArray(message.selection) ? message.selection.filter((id) => typeof id === 'string').slice(0, 200) : [];
      ws.serializeAttachment({ ...att, cursor, selection });
      this.broadcast(JSON.stringify({ t: 'presence', sid: att.sid, cursor, selection }), att.sid);
    }
  }

  async webSocketClose(ws) {
    await this.left(ws);
  }

  async webSocketError(ws) {
    await this.left(ws);
  }

  async left(ws) {
    const att = ws.deserializeAttachment();
    if (att) this.broadcast(JSON.stringify({ t: 'leave', sid: att.sid }), att.sid);
    const others = this.sockets().filter((other) => other !== ws);
    if (others.length === 0) {
      await this.ensureLoaded().catch(() => undefined);
      await this.flush();
    }
  }

  // ---- requests from the Worker ------------------------------------------------------------

  async fetch(request) {
    const url = new URL(request.url);
    const projectId = request.headers.get('X-Project-Id');
    if (projectId && projectId !== this.projectId) {
      this.projectId = projectId;
      await this.ctx.storage.put('projectId', projectId);
    }
    const user = { id: request.headers.get('X-User-Id') ?? '', name: request.headers.get('X-User-Name') ?? '', role: request.headers.get('X-Role') ?? 'viewer' };
    try {
      switch (url.pathname) {
        case '/live':
          return this.connect(request, user);
        case '/doc': {
          await this.ensureLoaded();
          return new Response(JSON.stringify(this.doc), { headers: { 'Content-Type': 'application/json', 'X-Version': String(this.version) } });
        }
        case '/save':
          return this.save(request);
        case '/ops':
          if (request.method === 'GET') return this.since(Number(url.searchParams.get('since')));
          return this.postOps(request, user);
        case '/member':
          return this.member(await request.json());
        case '/delete':
          for (const ws of this.sockets()) {
            try {
              ws.send(JSON.stringify({ t: 'deleted' }));
              ws.close(4404, 'deleted');
            } catch {
              // gone
            }
          }
          await this.ctx.storage.deleteAll();
          this.doc = null;
          return json({ ok: true });
        default:
          return json({ error: 'Not found' }, 404);
      }
    } catch (error) {
      return json({ error: error.message ?? 'Board error' }, error.status ?? 500);
    }
  }

  connect(request, user) {
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'Expected a WebSocket' }, 426);
    const { 0: client, 1: server } = new WebSocketPair();
    const sid = crypto.randomUUID().slice(0, 8);
    const you = { sid, userId: user.id, name: user.name, colour: colourOf(user.id), role: user.role };
    this.ctx.acceptWebSocket(server, [user.id]);
    server.serializeAttachment({ ...you, cursor: null, selection: [] });
    server.send(JSON.stringify({ t: 'welcome', you, peers: this.peers().filter((peer) => peer.sid !== sid), version: this.doc ? this.version : null }));
    this.broadcast(JSON.stringify({ t: 'peer', peer: { ...you, cursor: null, selection: [] } }), sid);
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'archai' } });
  }

  /** A whole document (Put online, offline edits uploaded later): replaces the live copy. */
  async save(request) {
    const base = Number(request.headers.get('X-Base-Version'));
    const text = await request.text();
    const doc = JSON.parse(text);
    let current = 0;
    try {
      await this.ensureLoaded();
      current = this.version;
    } catch (error) {
      if (error.status !== 404) throw error; // a new project: nothing uploaded yet
    }
    if (base !== current) return json({ error: 'This project was changed somewhere else since you opened it', version: current }, 409);
    this.doc = doc;
    this.version = current + 1;
    this.log = [];
    this.logBytes = 0;
    await this.flush();
    this.broadcast(JSON.stringify({ t: 'reset', version: this.version }));
    return json({ version: this.version });
  }

  async since(since) {
    await this.ensureLoaded();
    const oldest = this.log.length ? this.log[0].version : this.version + 1;
    if (!Number.isInteger(since) || since < oldest - 1 || since > this.version) return json({ stale: true, version: this.version });
    return json({ version: this.version, batches: this.log.filter((entry) => entry.version > since).map(({ version, sid, patches }) => ({ version, sid, patches })) });
  }

  /** A batch too large for a socket message, sent over HTTP. */
  async postOps(request, user) {
    if (user.role === 'viewer') return json({ error: 'You can view this project but not edit it' }, 403);
    const body = await request.json();
    try {
      const version = await this.apply(String(body.sid ?? ''), String(body.clientId ?? ''), Number(body.seq), body.patches);
      return json({ version });
    } catch (error) {
      if (error instanceof Rejected) return json({ error: error.message }, 409);
      throw error;
    }
  }

  /** A member's role changed (`role`) or they were removed (`role: null`). */
  member({ userId, role }) {
    for (const ws of this.ctx.getWebSockets(userId)) {
      const att = ws.deserializeAttachment();
      if (!role) {
        try {
          ws.send(JSON.stringify({ t: 'removed' }));
          ws.close(4403, 'removed');
        } catch {
          // gone
        }
        continue;
      }
      ws.serializeAttachment({ ...att, role });
      ws.send(JSON.stringify({ t: 'role', role }));
      this.broadcast(JSON.stringify({ t: 'peer', peer: { ...att, role } }), att.sid);
    }
    return json({ ok: true });
  }
}

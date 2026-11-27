#!/usr/bin/env node
/**
 * PaperBridge zero-dependency multi-device sync server (Node 18+).
 *
 * Local-first LWW + tombstone synchronization for:
 *   docs, collections, notes, glossary, chats, translations,
 *   E2E-encrypted settings (API keys never stored in plaintext),
 *   and SHA-256 content-addressed PDF blobs (with per-user ownership check).
 *
 * Env:
 *   HOST=127.0.0.1        listen host
 *   PORT=8788             listen port
 *   SYNC_DATA_DIR=./sync-data
 *   ALLOW_REGISTER=1      set 0 to disable new signups
 *   INVITE_CODE=          optional signup invite code
 *   MAX_PDF_MB=150        max single PDF size
 *   MAX_SYNC_MB=64        max JSON merge payload size
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_TOKENS_PER_USER = 16;

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHex) {
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function atomicWriteJson(file, data) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

function readJsonOr(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function emptyRevs() {
  return {
    docs: {},
    collections: {},
    notes: {},
    inks: {},
    glossary: {},
    chats: {},
    translations: {},
    deleted: { docs: {}, collections: {}, notes: {}, inks: {}, glossary: {}, chats: {} },
    settings: 0,
  };
}

function emptyState() {
  return {
    revision: 0,
    updatedAt: 0,
    docs: {},
    collections: {},
    notes: {},
    inks: {},
    glossary: {},
    chats: {},
    translations: {},
    settings: null,
    deleted: { docs: {}, collections: {}, notes: {}, inks: {}, glossary: {}, chats: {} },
    revsInitRev: 0,
    revs: emptyRevs(),
  };
}

function ensureRevs(st) {
  if (st.revs && typeof st.revsInitRev === 'number') {
    st.revs = {
      ...emptyRevs(),
      ...st.revs,
      deleted: { ...emptyRevs().deleted, ...(st.revs.deleted ?? {}) },
    };
    return st;
  }
  const initRev = Number(st.revision ?? 0);
  const revs = emptyRevs();
  for (const t of ['docs', 'collections', 'notes', 'inks', 'glossary', 'chats', 'translations']) {
    for (const id of Object.keys(st[t] ?? {})) revs[t][id] = initRev;
  }
  for (const t of ['docs', 'collections', 'notes', 'inks', 'glossary', 'chats']) {
    for (const id of Object.keys(st.deleted?.[t] ?? {})) revs.deleted[t][id] = initRev;
  }
  revs.settings = st.settings ? initRev : 0;
  st.revs = revs;
  st.revsInitRev = initRev;
  return st;
}

function sameJson(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function mergeTable(serverMap, clientMap, serverDel, clientDel, tsOf, serverRevs, serverDelRevs, nextRev) {
  const deleted = { ...(serverDel ?? {}) };
  const delRevs = { ...(serverDelRevs ?? {}) };
  const merged = { ...(serverMap ?? {}) };
  const itemRevs = { ...(serverRevs ?? {}) };
  let changed = false;

  for (const [id, ts] of Object.entries(clientDel ?? {})) {
    const n = Number(ts) || 0;
    if (n > (deleted[id] ?? 0)) {
      deleted[id] = n;
      delRevs[id] = nextRev;
      changed = true;
      const cur = merged[id];
      if (cur && n > tsOf(cur)) {
        delete merged[id];
        delete itemRevs[id];
      }
    }
  }

  for (const [id, b] of Object.entries(clientMap ?? {})) {
    if (!b) continue;
    const a = merged[id];
    const bTs = tsOf(b);
    const delTs = deleted[id] ?? 0;
    if (delTs > bTs) {
      if (a && delTs > tsOf(a)) {
        delete merged[id];
        delete itemRevs[id];
        changed = true;
      }
      continue;
    }
    if (!a) {
      merged[id] = b;
      itemRevs[id] = nextRev;
      changed = true;
    } else if (bTs >= tsOf(a) && !sameJson(a, b)) {
      merged[id] = b;
      itemRevs[id] = nextRev;
      changed = true;
    }
  }
  return { merged, deleted, itemRevs, delRevs, changed };
}

function mergeStates(rawServerState, payload) {
  const hadRevs = !!(rawServerState.revs && typeof rawServerState.revsInitRev === 'number');
  const serverState = ensureRevs(rawServerState);
  const nextRev = (serverState.revision ?? 0) + 1;
  const revs = serverState.revs;

  const docs = mergeTable(serverState.docs, payload.docs, serverState.deleted?.docs, payload.deleted?.docs, (d) => Number(d.updatedAt ?? d.addedAt ?? 0), revs.docs, revs.deleted.docs, nextRev);
  const collections = mergeTable(serverState.collections, payload.collections, serverState.deleted?.collections, payload.deleted?.collections, (c) => Number(c.updatedAt ?? c.createdAt ?? 0), revs.collections, revs.deleted.collections, nextRev);
  const notes = mergeTable(serverState.notes, payload.notes, serverState.deleted?.notes, payload.deleted?.notes, (n) => Number(n.createdAt ?? 0), revs.notes, revs.deleted.notes, nextRev);
  const inks = mergeTable(serverState.inks, payload.inks, serverState.deleted?.inks, payload.deleted?.inks, (s) => Number(s.createdAt ?? 0), revs.inks, revs.deleted.inks, nextRev);
  const glossary = mergeTable(serverState.glossary, payload.glossary, serverState.deleted?.glossary, payload.deleted?.glossary, (g) => Number(g.createdAt ?? 0), revs.glossary, revs.deleted.glossary, nextRev);
  const chats = mergeTable(serverState.chats, payload.chats, serverState.deleted?.chats, payload.deleted?.chats, (c) => Number(c.updatedAt ?? 0), revs.chats, revs.deleted.chats, nextRev);

  let changed = !hadRevs || docs.changed || collections.changed || notes.changed || inks.changed || glossary.changed || chats.changed;

  // Translations: additive LWW by key
  const translations = { ...(serverState.translations ?? {}) };
  const transRevs = { ...(revs.translations ?? {}) };
  for (const [k, v] of Object.entries(payload.translations ?? {})) {
    const prev = translations[k];
    if (!prev || (Number(v?.createdAt ?? 0) >= Number(prev?.createdAt ?? 0) && !sameJson(prev, v))) {
      translations[k] = v;
      transRevs[k] = nextRev;
      changed = true;
    }
  }

  // E2E-encrypted settings blob: newer updatedAt wins
  let settings = serverState.settings ?? null;
  let settingsRev = Number(revs.settings ?? 0);
  if (payload.settings && typeof payload.settings.encrypted === 'string') {
    const incomingTs = Number(payload.settings.updatedAt ?? 0);
    if (!settings || (incomingTs >= Number(settings.updatedAt ?? 0) && (incomingTs > Number(settings.updatedAt ?? 0) || payload.settings.encrypted !== settings.encrypted))) {
      settings = { updatedAt: incomingTs, encrypted: payload.settings.encrypted };
      settingsRev = nextRev;
      changed = true;
    }
  }

  if (!changed) {
    return { state: serverState, changed: false };
  }

  const next = emptyState();
  next.docs = docs.merged;
  next.collections = collections.merged;
  next.notes = notes.merged;
  next.inks = inks.merged;
  next.glossary = glossary.merged;
  next.chats = chats.merged;
  next.translations = translations;
  next.settings = settings;
  next.deleted = {
    docs: docs.deleted,
    collections: collections.deleted,
    notes: notes.deleted,
    inks: inks.deleted,
    glossary: glossary.deleted,
    chats: chats.deleted,
  };
  next.revsInitRev = serverState.revsInitRev;
  next.revs = {
    docs: docs.itemRevs,
    collections: collections.itemRevs,
    notes: notes.itemRevs,
    inks: inks.itemRevs,
    glossary: glossary.itemRevs,
    chats: chats.itemRevs,
    translations: transRevs,
    deleted: {
      docs: docs.delRevs,
      collections: collections.delRevs,
      notes: notes.delRevs,
      inks: inks.delRevs,
      glossary: glossary.delRevs,
      chats: chats.delRevs,
    },
    settings: settingsRev,
  };
  next.revision = nextRev;
  next.updatedAt = Date.now();
  return { state: next, changed: true };
}

function publicState(st) {
  return {
    revision: st.revision,
    updatedAt: st.updatedAt,
    docs: st.docs,
    collections: st.collections,
    notes: st.notes,
    inks: st.inks ?? {},
    glossary: st.glossary,
    chats: st.chats,
    translations: st.translations,
    settings: st.settings,
    deleted: st.deleted,
  };
}

function sliceSince(st, baseRevision) {
  const revs = st.revs ?? emptyRevs();
  const slice = {
    revision: st.revision,
    updatedAt: st.updatedAt,
    docs: {},
    collections: {},
    notes: {},
    inks: {},
    glossary: {},
    chats: {},
    translations: {},
    settings: (revs.settings ?? 0) > baseRevision ? st.settings : null,
    deleted: { docs: {}, collections: {}, notes: {}, inks: {}, glossary: {}, chats: {} },
  };
  for (const t of ['docs', 'collections', 'notes', 'inks', 'glossary', 'chats', 'translations']) {
    const map = st[t] ?? {};
    const rmap = revs[t] ?? {};
    for (const [id, r] of Object.entries(rmap)) {
      if (r > baseRevision && map[id] !== undefined) slice[t][id] = map[id];
    }
  }
  for (const t of ['docs', 'collections', 'notes', 'inks', 'glossary', 'chats']) {
    const dmap = st.deleted?.[t] ?? {};
    const rmap = revs.deleted?.[t] ?? {};
    for (const [id, r] of Object.entries(rmap)) {
      if (r > baseRevision && dmap[id] !== undefined) slice.deleted[t][id] = dmap[id];
    }
  }
  return slice;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Content-Encoding, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function sendJson(res, status, body, req = null) {
  const raw = Buffer.from(JSON.stringify(body));
  const acceptsGzip = !!req && /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''));
  const useGzip = acceptsGzip && raw.length > 1024;
  const buf = useGzip ? gzipSync(raw, { level: 6 }) : raw;
  res.writeHead(status, {
    ...corsHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(buf.length),
    'Cache-Control': 'no-store',
    ...(useGzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
  });
  res.end(buf);
}

async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error('Payload too large');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  let buf = Buffer.concat(chunks);
  if (!buf.length) return {};
  if (String(req.headers['content-encoding'] ?? '').toLowerCase() === 'gzip') {
    try {
      buf = gunzipSync(buf, { maxOutputLength: maxBytes });
    } catch {
      const err = new Error('Invalid gzip payload');
      err.status = 400;
      throw err;
    }
  }
  const text = buf.toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('Invalid JSON');
    err.status = 400;
    throw err;
  }
}

/**
 * Garbage-collect unreferenced PDF blobs (and stale aborted .tmp uploads) from dataDir/blobs.
 * Scans every user's state file first; if any user state fails to read/parse, aborts safely
 * without deleting anything. Keeps a grace window (default 10 min) so freshly uploaded blobs
 * not yet committed to a user's state are never removed.
 */
export function gcOrphanBlobs(dataDir, opts = {}) {
  const usersDir = join(dataDir, 'users');
  const blobsDir = join(dataDir, 'blobs');
  const graceMs = Math.max(0, Number(opts.graceMs ?? 600_000));
  const now = opts.now ?? Date.now();
  if (!existsSync(blobsDir)) return { removed: 0, freedBytes: 0, referenced: 0, aborted: false };

  const referenced = new Set();
  if (existsSync(usersDir)) {
    for (const name of readdirSync(usersDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const st = JSON.parse(readFileSync(join(usersDir, name), 'utf8'));
        for (const doc of Object.values(st?.docs ?? {})) {
          if (doc && typeof doc.hash === 'string' && HASH_RE.test(doc.hash)) {
            referenced.add(doc.hash);
          }
        }
      } catch {
        // Safety first: never delete blobs if any user state cannot be read cleanly
        return { removed: 0, freedBytes: 0, referenced: referenced.size, aborted: true };
      }
    }
  }

  let removed = 0;
  let freedBytes = 0;
  const tmpGraceMs = Math.max(graceMs, 60_000);
  for (const name of readdirSync(blobsDir)) {
    const full = join(blobsDir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;

    if (name.endsWith('.tmp')) {
      if (now - st.mtimeMs >= tmpGraceMs) {
        try {
          unlinkSync(full);
          removed++;
          freedBytes += st.size;
        } catch {
          /* ignore race */
        }
      }
      continue;
    }

    if (!HASH_RE.test(name)) continue;
    if (referenced.has(name)) continue;
    if (now - st.mtimeMs < graceMs) continue;

    try {
      unlinkSync(full);
      removed++;
      freedBytes += st.size;
    } catch {
      /* ignore race */
    }
  }
  return { removed, freedBytes, referenced: referenced.size, aborted: false };
}

export function createSyncServer(opts = {}) {
  const env = opts.env ?? process.env;
  const dataDir = resolve(opts.dataDir ?? env.SYNC_DATA_DIR ?? './sync-data');
  const usersFile = join(dataDir, 'users.json');
  const usersDir = join(dataDir, 'users');
  const blobsDir = join(dataDir, 'blobs');
  const allowRegister = env.ALLOW_REGISTER !== '0';
  const inviteCode = (env.INVITE_CODE ?? '').trim();
  const sharedProxyToken = (env.PROXY_TOKEN ?? '').trim();
  const maxPdfBytes = Math.max(1, Number(env.MAX_PDF_MB) || 150) * 1024 * 1024;
  const maxSyncBytes = Math.max(1, Number(env.MAX_SYNC_MB) || 64) * 1024 * 1024;
  const gcGraceMs = env.BLOB_GC_GRACE_MS !== undefined ? Math.max(0, Number(env.BLOB_GC_GRACE_MS)) : 600_000;
  const gcDelayMs = env.BLOB_GC_DELAY_MS !== undefined ? Math.max(0, Number(env.BLOB_GC_DELAY_MS)) : 2_000;
  const proxyHint = sharedProxyToken ? { proxy: { token: sharedProxyToken } } : {};

  mkdirSync(usersDir, { recursive: true });
  mkdirSync(blobsDir, { recursive: true });

  let gcTimer = null;
  const runGcNow = () => {
    const r = gcOrphanBlobs(dataDir, { graceMs: gcGraceMs });
    if (r.removed > 0) {
      console.log(`[sync-gc] removed ${r.removed} orphan file(s), freed ${(r.freedBytes / 1048576).toFixed(2)} MB`);
    }
    return r;
  };
  const scheduleGc = () => {
    if (gcTimer) return;
    gcTimer = setTimeout(() => {
      gcTimer = null;
      runGcNow();
    }, gcDelayMs);
    gcTimer.unref?.();
  };
  const startupGc = setTimeout(runGcNow, 15_000);
  startupGc.unref?.();
  const periodicGc = setInterval(runGcNow, 3_600_000);
  periodicGc.unref?.();

  // Per-user async queue to serialize state merges cleanly
  const locks = new Map();
  const withUserLock = (username, fn) => {
    const prev = locks.get(username) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(username, next.finally(() => { if (locks.get(username) === next) locks.delete(username); }));
    return next;
  };

  const loadUsers = () => readJsonOr(usersFile, {});
  const saveUsers = (u) => atomicWriteJson(usersFile, u);
  const userStateFile = (u) => join(usersDir, `${u}.json`);
  const loadState = (u) => readJsonOr(userStateFile(u), emptyState());
  const saveState = (u, st) => atomicWriteJson(userStateFile(u), st);
  const blobPath = (hash) => join(blobsDir, hash);

  function authenticate(req) {
    const auth = req.headers.authorization ?? '';
    const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(auth.trim());
    if (!m) return null;
    const tokenHash = sha256(m[1]);
    const users = loadUsers();
    for (const user of Object.values(users)) {
      const hit = user.tokens?.find((t) => t.tokenHash === tokenHash);
      if (hit) return { username: user.username, tokenHash };
    }
    return null;
  }

  function issueToken(users, user, device) {
    const raw = randomBytes(32).toString('hex');
    const now = Date.now();
    user.tokens = [...(user.tokens ?? []), { tokenHash: sha256(raw), device: String(device ?? '').slice(0, 64), createdAt: now, lastSeen: now }].slice(-MAX_TOKENS_PER_USER);
    saveUsers(users);
    return raw;
  }

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    try {
      // GET /api/health
      if (req.method === 'GET' && path === '/api/health') {
        return sendJson(res, 200, { ok: true, allowRegister, inviteRequired: !!inviteCode });
      }

      // POST /api/auth/register
      if (req.method === 'POST' && path === '/api/auth/register') {
        if (!allowRegister) return sendJson(res, 403, { error: '当前服务器已关闭新用户注册' });
        const body = await readJsonBody(req, 16 * 1024);
        const username = String(body.username ?? '').trim().toLowerCase();
        const password = String(body.password ?? '');
        if (!USERNAME_RE.test(username)) {
          return sendJson(res, 400, { error: '用户名需为 3–32 位小写字母、数字或 ._-' });
        }
        if (password.length < 6 || password.length > 128) {
          return sendJson(res, 400, { error: '密码长度需在 6–128 位之间' });
        }
        if (inviteCode && String(body.inviteCode ?? '').trim() !== inviteCode) {
          return sendJson(res, 403, { error: '邀请码不正确' });
        }
        const users = loadUsers();
        if (users[username]) return sendJson(res, 409, { error: '该用户名已被注册' });
        const { salt, hash } = hashPassword(password);
        users[username] = { username, salt, hash, createdAt: Date.now(), tokens: [] };
        const token = issueToken(users, users[username], body.device);
        return sendJson(res, 201, { username, token, ...proxyHint });
      }

      // POST /api/auth/login
      if (req.method === 'POST' && path === '/api/auth/login') {
        const body = await readJsonBody(req, 16 * 1024);
        const username = String(body.username ?? '').trim().toLowerCase();
        const password = String(body.password ?? '');
        const users = loadUsers();
        const user = users[username];
        if (!user || !verifyPassword(password, user.salt, user.hash)) {
          return sendJson(res, 401, { error: '用户名或密码错误' });
        }
        const token = issueToken(users, user, body.device);
        return sendJson(res, 200, { username, token, ...proxyHint });
      }

      // Authenticated endpoints below
      const session = authenticate(req);
      if (!session) return sendJson(res, 401, { error: '未登录或登录已失效，请重新登录' });

      // POST /api/auth/logout
      if (req.method === 'POST' && path === '/api/auth/logout') {
        const users = loadUsers();
        const user = users[session.username];
        if (user) {
          user.tokens = (user.tokens ?? []).filter((t) => t.tokenHash !== session.tokenHash);
          saveUsers(users);
        }
        return sendJson(res, 200, { ok: true });
      }

      // GET /api/auth/me
      if (req.method === 'GET' && path === '/api/auth/me') {
        const st = loadState(session.username);
        return sendJson(res, 200, {
          username: session.username,
          revision: st.revision,
          updatedAt: st.updatedAt,
          stats: {
            docs: Object.keys(st.docs).length,
            notes: Object.keys(st.notes).length,
            translations: Object.keys(st.translations).length,
          },
        });
      }

      // GET /api/connector/collections — lightweight folder list for browser extension
      if (req.method === 'GET' && path === '/api/connector/collections') {
        const st = loadState(session.username);
        const collections = Object.values(st.collections ?? {}).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        return sendJson(res, 200, { username: session.username, collections });
      }

      // POST /api/connector/save — save a paper (metadata + optional base64 PDF) directly from browser extension
      if (req.method === 'POST' && path === '/api/connector/save') {
        const body = await readJsonBody(req, maxSyncBytes);
        const rawMeta = body?.meta && typeof body.meta === 'object' ? body.meta : {};
        const title = String(rawMeta.title ?? '').trim() || '未命名文献';
        const tags = [...new Set((Array.isArray(body?.tags) ? body.tags : []).map((t) => String(t).trim()).filter(Boolean))];
        const collectionId = typeof body?.collectionId === 'string' && body.collectionId.trim() ? body.collectionId.trim() : null;
        const pdfBase64 = typeof body?.pdfBase64 === 'string' && body.pdfBase64.length > 0 ? body.pdfBase64 : null;

        let pdfInfo = null;
        if (pdfBase64) {
          const buf = Buffer.from(pdfBase64, 'base64');
          if (buf.length > maxPdfBytes) return sendJson(res, 413, { error: 'PDF 文件超过单文件上限' });
          if (buf.subarray(0, 5).toString('ascii') === '%PDF-') {
            const hash = createHash('sha256').update(buf).digest('hex');
            const targetFile = blobPath(hash);
            if (!existsSync(targetFile)) {
              const tmp = `${targetFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
              writeFileSync(tmp, buf);
              renameSync(tmp, targetFile);
            }
            const safeName = String(body?.pdfFileName ?? '').trim() || `${title.slice(0, 60).replace(/[\\/:*?"<>|]/g, '_')}.pdf`;
            pdfInfo = { hash, size: buf.length, fileName: safeName };
          }
        }

        const normTitle = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '');
        const incomingDoi = typeof rawMeta.doi === 'string' ? rawMeta.doi.trim().toLowerCase() : '';
        const incomingArxiv = typeof rawMeta.arxivId === 'string' ? rawMeta.arxivId.trim().toLowerCase().replace(/v\d+$/, '') : '';
        const incomingTitleNorm = title.length > 8 ? normTitle(title) : '';

        const saved = await withUserLock(session.username, () => {
          const st = ensureRevs(loadState(session.username));
          const now = Date.now();
          // Find existing active duplicate
          const existing = Object.values(st.docs ?? {}).find((d) => {
            if (!d || d.deletedAt) return false;
            if (pdfInfo && d.hash && d.hash === pdfInfo.hash) return true;
            if (incomingDoi && d.meta?.doi?.toLowerCase() === incomingDoi) return true;
            if (incomingArxiv && d.meta?.arxivId?.toLowerCase().replace(/v\d+$/, '') === incomingArxiv) return true;
            if (incomingTitleNorm && normTitle(d.meta?.title || d.title) === incomingTitleNorm) return true;
            return false;
          });

          const cleanMeta = {
            title,
            authors: Array.isArray(rawMeta.authors) ? rawMeta.authors : [],
            type: rawMeta.type || 'article',
            ...(rawMeta.year ? { year: Number(rawMeta.year) || undefined } : {}),
            ...(rawMeta.venue ? { venue: String(rawMeta.venue) } : {}),
            ...(rawMeta.volume ? { volume: String(rawMeta.volume) } : {}),
            ...(rawMeta.issue ? { issue: String(rawMeta.issue) } : {}),
            ...(rawMeta.pages ? { pages: String(rawMeta.pages) } : {}),
            ...(rawMeta.publisher ? { publisher: String(rawMeta.publisher) } : {}),
            ...(rawMeta.doi ? { doi: String(rawMeta.doi) } : {}),
            ...(rawMeta.arxivId ? { arxivId: String(rawMeta.arxivId) } : {}),
            ...(rawMeta.url ? { url: String(rawMeta.url) } : {}),
            ...(rawMeta.abstract ? { abstract: String(rawMeta.abstract) } : {}),
            ...(rawMeta.language ? { language: String(rawMeta.language) } : {}),
          };

          let doc;
          let duplicate = false;
          if (existing) {
            duplicate = true;
            const mergedMeta = {
              ...existing.meta,
              ...cleanMeta,
              authors: existing.meta?.authors?.length ? existing.meta.authors : cleanMeta.authors,
            };
            doc = {
              ...existing,
              title: mergedMeta.title || existing.title,
              meta: mergedMeta,
              tags: [...new Set([...(existing.tags ?? []), ...tags])],
              collectionIds: collectionId && !(existing.collectionIds ?? []).includes(collectionId)
                ? [...(existing.collectionIds ?? []), collectionId]
                : (existing.collectionIds ?? []),
              ...(pdfInfo && !existing.hasPdf ? { hasPdf: true, hash: pdfInfo.hash, size: pdfInfo.size, fileName: pdfInfo.fileName } : {}),
              updatedAt: now,
            };
          } else {
            const id = `${now.toString(36)}-${randomBytes(8).toString('hex')}`;
            doc = {
              id,
              title,
              fileName: pdfInfo?.fileName ?? '',
              size: pdfInfo?.size ?? 0,
              pageCount: 0,
              addedAt: now,
              lastOpenedAt: 0,
              lastPage: 0,
              hash: pdfInfo?.hash ?? '',
              meta: cleanMeta,
              metaSource: 'manual',
              tags,
              collectionIds: collectionId ? [collectionId] : [],
              starred: false,
              status: 'unread',
              hasPdf: !!pdfInfo,
              updatedAt: now,
            };
          }

          st.docs[doc.id] = doc;
          st.revision = (st.revision ?? 0) + 1;
          st.revs.docs[doc.id] = st.revision;
          st.updatedAt = now;
          saveState(session.username, st);
          return { ok: true, docId: doc.id, title: doc.title, duplicate, hasPdf: doc.hasPdf, revision: st.revision };
        });
        return sendJson(res, 200, saved, req);
      }

      // POST /api/sync/merge
      if (req.method === 'POST' && path === '/api/sync/merge') {
        const payload = await readJsonBody(req, maxSyncBytes);
        const baseRev = Number(payload.baseRevision ?? 0) || 0;
        const result = await withUserLock(session.username, () => {
          const cur = loadState(session.username);
          const prevDocCount = Object.keys(cur.docs ?? {}).length;
          const hadRevs = !!(cur.revs && typeof cur.revsInitRev === 'number');
          const { state: merged, changed } = mergeStates(cur, payload);
          if (changed) {
            saveState(session.username, merged);
            if (Object.keys(merged.docs ?? {}).length < prevDocCount || Object.keys(payload?.deleted?.docs ?? {}).length > 0) {
              scheduleGc();
            }
          }
          const neededHashes = new Set();
          for (const d of Object.values(merged.docs)) {
            if (d?.hasPdf && typeof d.hash === 'string' && HASH_RE.test(d.hash) && !existsSync(blobPath(d.hash))) {
              neededHashes.add(d.hash);
            }
          }
          const canDelta = hadRevs && baseRev > 0 && baseRev <= merged.revision && baseRev >= (merged.revsInitRev ?? 0);
          if (canDelta && baseRev === merged.revision) {
            return { mode: 'unchanged', revision: merged.revision, updatedAt: merged.updatedAt, missingBlobs: [...neededHashes], ...proxyHint };
          }
          if (canDelta) {
            return {
              mode: 'delta',
              revision: merged.revision,
              updatedAt: merged.updatedAt,
              state: sliceSince(merged, baseRev),
              missingBlobs: [...neededHashes],
              ...proxyHint,
            };
          }
          return {
            mode: 'full',
            revision: merged.revision,
            updatedAt: merged.updatedAt,
            state: publicState(merged),
            missingBlobs: [...neededHashes],
            ...proxyHint,
          };
        });
        return sendJson(res, 200, result, req);
      }

      // Blob endpoints: /api/blobs/:sha256
      const blobMatch = /^\/api\/blobs\/([0-9a-f]{64})$/.exec(path);
      if (blobMatch) {
        const hash = blobMatch[1];
        const file = blobPath(hash);

        if (req.method === 'HEAD') {
          res.writeHead(existsSync(file) ? 200 : 404, corsHeaders());
          res.end();
          return;
        }

        if (req.method === 'PUT') {
          const declared = Number(req.headers['content-length'] ?? 0);
          if (declared > maxPdfBytes) return sendJson(res, 413, { error: 'PDF 文件超过单文件上限' });
          if (existsSync(file)) {
            // Drain stream cleanly
            req.resume();
            return sendJson(res, 200, { ok: true, existed: true });
          }
          const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
          const ws = createWriteStream(tmp);
          const hasher = createHash('sha256');
          let size = 0;
          let headBytes = Buffer.alloc(0);
          try {
            for await (const chunk of req) {
              size += chunk.length;
              if (size > maxPdfBytes) {
                const err = new Error('PDF 文件超过单文件上限');
                err.status = 413;
                throw err;
              }
              if (headBytes.length < 5) headBytes = Buffer.concat([headBytes, chunk]).subarray(0, 5);
              hasher.update(chunk);
              if (!ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
            }
            await new Promise((resolveDone, rejectDone) => {
              ws.on('error', rejectDone);
              ws.end(resolveDone);
            });
            if (headBytes.toString('ascii') !== '%PDF-') {
              unlinkSync(tmp);
              return sendJson(res, 400, { error: '上传文件不是有效的 PDF' });
            }
            const actual = hasher.digest('hex');
            if (actual !== hash) {
              unlinkSync(tmp);
              return sendJson(res, 400, { error: 'PDF 校验哈希不匹配' });
            }
            renameSync(tmp, file);
            return sendJson(res, 201, { ok: true, size });
          } catch (e) {
            ws.destroy();
            if (existsSync(tmp)) unlinkSync(tmp);
            throw e;
          }
        }

        if (req.method === 'GET') {
          // Enforce per-user ownership: user must have a doc referencing this hash
          const st = loadState(session.username);
          const owns = Object.values(st.docs).some((d) => d?.hash === hash);
          if (!owns) return sendJson(res, 403, { error: '无权访问该文件' });
          if (!existsSync(file)) return sendJson(res, 404, { error: '文件尚未上传到云端' });
          const stat = statSync(file);
          res.writeHead(200, {
            ...corsHeaders(),
            'Content-Type': 'application/pdf',
            'Content-Length': String(stat.size),
            'Cache-Control': 'private, max-age=31536000, immutable',
          });
          createReadStream(file).pipe(res);
          return;
        }
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (e) {
      const status = e?.status ?? 500;
      if (!res.headersSent) sendJson(res, status, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  server.on('close', () => {
    if (gcTimer) clearTimeout(gcTimer);
    clearTimeout(startupGc);
    clearInterval(periodicGc);
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT) || 8788;
  const server = createSyncServer();
  server.listen(port, host, () => {
    console.log(`PaperBridge sync server listening on http://${host}:${port} (data: ${resolve(process.env.SYNC_DATA_DIR ?? './sync-data')})`);
  });
}

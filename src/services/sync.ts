import { db, type ChatRecord, type Collection, type DocRecord, type GlossaryEntry, type InkStroke, type NoteRecord, type TranslationRecord } from '../db/db';
import { desktop } from '../lib/desktop';
import { hasWebCryptoSubtle } from '../lib/sha256';
import { useSettings, type Settings } from '../store/settings';
import { emptyDirty, emptyTombstones, useSync, type DirtyMap, type SyncTable, type TombstoneMap, type TombstoneTable } from '../store/sync';

const SYNCED_SETTING_KEYS = [
  'providers',
  'translateProviderId',
  'chatProviderId',
  'sourceLang',
  'targetLang',
  'selectionAction',
  'theme',
  'pdfTheme',
  'concurrency',
  'batchSize',
  'prompts',
  'readerFontSize',
  'autoTerms',
  'tagColors',
] as const;

type SyncedSettings = Pick<Settings, (typeof SYNCED_SETTING_KEYS)[number]>;

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Derive a deterministic 256-bit AES key from account username + password for E2E settings encryption. */
export async function deriveKeyB64(username: string, password: string): Promise<string> {
  if (!hasWebCryptoSubtle()) return '';
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(`paperbridge-sync-v1:${username.trim().toLowerCase()}`), iterations: 100_000, hash: 'SHA-256' },
    baseKey,
    256,
  );
  return toB64(new Uint8Array(bits));
}

export async function encryptPayload(data: unknown, keyB64: string): Promise<string> {
  if (!hasWebCryptoSubtle() || !keyB64) return '';
  const key = await crypto.subtle.importKey('raw', fromB64(keyB64), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const pt = new TextEncoder().encode(JSON.stringify(data));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt));
  return `v1:${toB64(iv)}:${toB64(ct)}`;
}

export async function decryptPayload<T>(packed: string, keyB64: string): Promise<T | null> {
  if (!hasWebCryptoSubtle() || !keyB64) return null;
  try {
    const [ver, ivB64, ctB64] = packed.split(':');
    if (ver !== 'v1' || !ivB64 || !ctB64) return null;
    const key = await crypto.subtle.importKey('raw', fromB64(keyB64), 'AES-GCM', false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(ivB64) }, key, fromB64(ctB64));
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  } catch {
    return null;
  }
}

function normalizeServerUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '').replace(/\/api$/i, '');
}

function deviceLabel(): string {
  const d = desktop();
  if (d) {
    if (d.platform === 'android') {
      const isTablet = typeof window !== 'undefined' && Math.min(window.screen?.width || window.innerWidth, window.screen?.height || window.innerHeight) >= 600;
      return `${isTablet ? 'Android Tablet' : 'Android Phone'} (APK ${d.version})`;
    }
    return `Desktop (${d.platform} ${d.version})`;
  }
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent || '';
    const isIpad = /iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isStandalone =
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true);
    if (isIpad) return isStandalone ? 'iPadOS (App)' : 'iPadOS (Safari)';
    if (/iPhone|iPod/i.test(ua)) return isStandalone ? 'iOS (App)' : 'iOS (Safari)';
    if (/Android/i.test(ua)) {
      const kind = /Mobile/i.test(ua) ? 'Android Phone' : 'Android Tablet';
      return isStandalone ? `${kind} (App)` : `${kind} (Browser)`;
    }
    return `Web (${navigator.platform || 'Browser'})`;
  }
  return 'PaperBridge';
}

async function maybeGzipJson(jsonText: string): Promise<{ body: BodyInit; gzipped: boolean }> {
  if (jsonText.length < 8192 || typeof CompressionStream !== 'function') {
    return { body: jsonText, gzipped: false };
  }
  try {
    const stream = new Blob([jsonText]).stream().pipeThrough(new CompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    if (buf.byteLength < jsonText.length) {
      return { body: buf, gzipped: true };
    }
  } catch {
    /* fallback to plain JSON */
  }
  return { body: jsonText, gzipped: false };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      throw new Error('网络请求超时，请检查网络连接后重试');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function apiJson<T>(serverUrl: string, path: string, init: RequestInit = {}, token?: string, timeoutMs = 25_000): Promise<T> {
  const base = normalizeServerUrl(serverUrl);
  if (!base) throw new Error('请先填写同步服务器地址');
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let body = init.body;
  if (typeof body === 'string') {
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const compressed = await maybeGzipJson(body);
    body = compressed.body;
    if (compressed.gzipped) headers.set('Content-Encoding', 'gzip');
  } else if (body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetchWithTimeout(`${base}${path}`, { ...init, body, headers }, timeoutMs);
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* non-json error */
  }
  if (!res.ok) {
    const msg = typeof json.error === 'string' ? json.error : `服务器返回 HTTP ${res.status}`;
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return json as T;
}

export async function checkSyncServer(serverUrl: string): Promise<{ ok: boolean; allowRegister: boolean; inviteRequired: boolean }> {
  return apiJson(serverUrl, '/api/health', { method: 'GET' });
}

function applyProxyHint(serverBase: string, proxy?: { token?: string }) {
  if (desktop() || !proxy?.token) return;
  const cur = useSettings.getState();
  if (cur.proxyUrl !== serverBase || cur.proxyToken !== proxy.token) {
    cur.set({ proxyUrl: serverBase, proxyToken: proxy.token });
  }
}

export async function registerAccount(serverUrl: string, username: string, password: string, inviteCode?: string) {
  const base = normalizeServerUrl(serverUrl);
  const res = await apiJson<{ username: string; token: string; proxy?: { token?: string } }>(base, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: username.trim().toLowerCase(), password, inviteCode: inviteCode?.trim() || undefined, device: deviceLabel() }),
  });
  applyProxyHint(base, res.proxy);
  const encKeyB64 = await deriveKeyB64(res.username, password);
  useSync.getState().set({ serverUrl: base, username: res.username, token: res.token, encKeyB64, lastError: '' });
  await syncNow();
  return res;
}

export async function loginAccount(serverUrl: string, username: string, password: string) {
  const base = normalizeServerUrl(serverUrl);
  const res = await apiJson<{ username: string; token: string; proxy?: { token?: string } }>(base, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: username.trim().toLowerCase(), password, device: deviceLabel() }),
  });
  applyProxyHint(base, res.proxy);
  const encKeyB64 = await deriveKeyB64(res.username, password);
  useSync.getState().set({ serverUrl: base, username: res.username, token: res.token, encKeyB64, lastError: '' });
  await syncNow();
  return res;
}

export async function logoutAccount() {
  const { serverUrl, token } = useSync.getState();
  if (serverUrl && token) {
    void apiJson(serverUrl, '/api/auth/logout', { method: 'POST' }, token).catch(() => {});
  }
  useSync.getState().clearAuth();
}

interface RemoteState {
  revision: number;
  updatedAt: number;
  docs: Record<string, DocRecord>;
  collections: Record<string, Collection>;
  notes: Record<string, NoteRecord>;
  inks?: Record<string, InkStroke>;
  glossary: Record<string, GlossaryEntry>;
  chats: Record<string, ChatRecord>;
  translations: Record<string, TranslationRecord>;
  settings: { updatedAt: number; encrypted: string } | null;
  deleted: TombstoneMap;
}

interface MergeResponse {
  mode?: 'unchanged' | 'delta' | 'full';
  revision: number;
  updatedAt: number;
  state?: RemoteState;
  missingBlobs: string[];
  proxy?: { token?: string };
}

function indexBy<T>(arr: T[], keyOf: (x: T) => string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const x of arr) out[keyOf(x)] = x;
  return out;
}

function cloneDirty(d: DirtyMap): DirtyMap {
  return {
    docs: [...(d.docs ?? [])],
    collections: [...(d.collections ?? [])],
    notes: [...(d.notes ?? [])],
    inks: [...(d.inks ?? [])],
    glossary: [...(d.glossary ?? [])],
    chats: [...(d.chats ?? [])],
    translations: [...(d.translations ?? [])],
  };
}

function cloneTombstones(t: TombstoneMap): TombstoneMap {
  return {
    docs: { ...(t.docs ?? {}) },
    collections: { ...(t.collections ?? {}) },
    notes: { ...(t.notes ?? {}) },
    inks: { ...(t.inks ?? {}) },
    glossary: { ...(t.glossary ?? {}) },
    chats: { ...(t.chats ?? {}) },
  };
}

async function loadDeltaRecords<T>(ids: string[], loader: (keys: string[]) => Promise<(T | undefined)[]>): Promise<T[]> {
  if (!ids.length) return [];
  const rows = await loader(ids);
  return rows.filter((r): r is T => r !== undefined);
}

function pickSyncedSettings(s: Settings): SyncedSettings {
  return {
    providers: s.providers,
    translateProviderId: s.translateProviderId,
    chatProviderId: s.chatProviderId,
    sourceLang: s.sourceLang,
    targetLang: s.targetLang,
    selectionAction: s.selectionAction,
    theme: s.theme,
    pdfTheme: s.pdfTheme ?? 'auto',
    concurrency: s.concurrency,
    batchSize: s.batchSize,
    prompts: s.prompts,
    readerFontSize: s.readerFontSize,
    autoTerms: s.autoTerms,
    tagColors: s.tagColors ?? {},
  };
}

let inFlight: Promise<boolean> | null = null;
let rerunQueued = false;
let suppressHooks = false;
let blobInFlight: Promise<void> | null = null;
const pendingMissingUploads = new Set<string>();
const inflightDownloads = new Map<string, Promise<boolean>>();

/** Download a single PDF blob on-demand (e.g. when user opens a synced paper before background blob sync reaches it). */
export async function ensurePdfBlobDownloaded(docId: string): Promise<boolean> {
  const existing = await db.blobs.get(docId);
  if (existing) return true;
  const doc = await db.docs.get(docId);
  const st = useSync.getState();
  if (!doc?.hasPdf || !doc.hash || !st.serverUrl || !st.token) return false;
  const inflight = inflightDownloads.get(docId);
  if (inflight) return inflight;

  const task = (async () => {
    try {
      const dlRes = await fetchWithTimeout(
        `${normalizeServerUrl(st.serverUrl)}/api/blobs/${doc.hash}`,
        { headers: { Authorization: `Bearer ${st.token}` } },
        120_000,
      );
      if (!dlRes.ok) return false;
      const buf = await dlRes.arrayBuffer();
      suppressHooks = true;
      try {
        await db.blobs.put({ id: doc.id, blob: new Blob([buf], { type: 'application/pdf' }) });
      } finally {
        suppressHooks = false;
      }
      return true;
    } catch (e) {
      console.warn('on-demand PDF download failed', docId, e);
      return false;
    } finally {
      inflightDownloads.delete(docId);
    }
  })();
  inflightDownloads.set(docId, task);
  return task;
}

/** Upload/download missing PDF blobs in the background so large files never block fast metadata/ink sync. */
function syncBlobsInBackground(missingUploads: string[]) {
  for (const h of missingUploads) pendingMissingUploads.add(h);
  if (blobInFlight) return;
  const st0 = useSync.getState();
  if (!st0.serverUrl || !st0.token) return;

  blobInFlight = (async () => {
    try {
      const serverBase = normalizeServerUrl(useSync.getState().serverUrl);
      const token = useSync.getState().token;
      if (!serverBase || !token) return;

      const localDocs = await db.docs.toArray();
      const docByHash = new Map<string, DocRecord>();
      for (const d of localDocs) if (d.hasPdf && d.hash) docByHash.set(d.hash, d);

      // 1. Upload missing blobs to server
      const uploads = [...pendingMissingUploads];
      pendingMissingUploads.clear();
      for (let i = 0; i < uploads.length; i++) {
        if (!useSync.getState().token) return;
        const h = uploads[i];
        const d = docByHash.get(h);
        if (!d) continue;
        const b = await db.blobs.get(d.id);
        if (!b) continue;
        useSync.getState().set({ blobProgress: `后台上传 PDF (${i + 1}/${uploads.length})…` });
        try {
          const upRes = await fetchWithTimeout(
            `${serverBase}/api/blobs/${h}`,
            { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf' }, body: b.blob },
            120_000,
          );
          if (!upRes.ok) console.warn('blob upload failed', h, upRes.status);
        } catch (e) {
          console.warn('blob upload error', h, e);
        }
      }

      // 2. Download missing local PDFs
      const missingLocal: DocRecord[] = [];
      for (const d of localDocs) {
        if (!d.hasPdf || !d.hash || d.deletedAt) continue;
        const exists = await db.blobs.get(d.id);
        if (!exists) missingLocal.push(d);
      }
      for (let i = 0; i < missingLocal.length; i++) {
        if (!useSync.getState().token) return;
        const d = missingLocal[i];
        useSync.getState().set({ blobProgress: `后台下载 PDF (${i + 1}/${missingLocal.length})…` });
        await ensurePdfBlobDownloaded(d.id);
      }
    } finally {
      useSync.getState().set({ blobProgress: '' });
      blobInFlight = null;
      if (pendingMissingUploads.size > 0 && useSync.getState().token) {
        syncBlobsInBackground([]);
      }
    }
  })();
}

export async function syncNow(opts?: { full?: boolean }): Promise<boolean> {
  const st = useSync.getState();
  if (!st.serverUrl || !st.token) return false;
  if (inFlight) {
    rerunQueued = true;
    return inFlight;
  }

  inFlight = (async () => {
    const sync = useSync.getState();
    const useDelta = !opts?.full && sync.lastRevision > 0;
    const dirtySnap = cloneDirty(sync.dirty);
    const delSnap = cloneTombstones(useDelta ? sync.dirtyTombstones : sync.tombstones);
    const settingsDirtySnap = sync.dirtySettings;

    sync.set({ status: 'syncing', progress: useDelta ? '增量同步…' : '同步数据…', lastError: '' });
    try {
      const [docs, collections, notes, inks, glossary, chats, translations] = useDelta
        ? await Promise.all([
            loadDeltaRecords(dirtySnap.docs, (k) => db.docs.bulkGet(k)),
            loadDeltaRecords(dirtySnap.collections, (k) => db.collections.bulkGet(k)),
            loadDeltaRecords(dirtySnap.notes, (k) => db.notes.bulkGet(k)),
            loadDeltaRecords(dirtySnap.inks, (k) => db.inks.bulkGet(k)),
            loadDeltaRecords(dirtySnap.glossary, (k) => db.glossary.bulkGet(k)),
            loadDeltaRecords(dirtySnap.chats, (k) => db.chats.bulkGet(k)),
            loadDeltaRecords(dirtySnap.translations, (k) => db.translations.bulkGet(k)),
          ])
        : await Promise.all([
            db.docs.toArray(),
            db.collections.toArray(),
            db.notes.toArray(),
            db.inks.toArray(),
            db.glossary.toArray(),
            db.chats.toArray(),
            db.translations.toArray(),
          ]);

      let settingsPayload: { updatedAt: number; encrypted: string } | undefined;
      if (sync.syncSettings && sync.encKeyB64 && (!useDelta || settingsDirtySnap)) {
        const curSettings = useSettings.getState();
        const updatedAt = sync.settingsUpdatedAt || (curSettings.providers.length > 0 ? 1 : 0);
        if (updatedAt > 0) {
          settingsPayload = {
            updatedAt,
            encrypted: await encryptPayload(pickSyncedSettings(curSettings), sync.encKeyB64),
          };
        }
      }

      const res = await apiJson<MergeResponse>(
        sync.serverUrl,
        '/api/sync/merge',
        {
          method: 'POST',
          body: JSON.stringify({
            ...(useDelta ? { baseRevision: sync.lastRevision, delta: true } : {}),
            docs: indexBy(docs, (d) => d.id),
            collections: indexBy(collections, (c) => c.id),
            notes: indexBy(notes, (n) => n.id),
            inks: indexBy(inks, (s) => s.id),
            glossary: indexBy(glossary, (g) => g.id),
            chats: indexBy(chats, (c) => c.id),
            translations: indexBy(translations, (t) => t.key),
            settings: settingsPayload,
            deleted: delSnap,
          }),
        },
        sync.token,
        useDelta ? 20_000 : 45_000,
      );

      // Clear only the dirty keys we actually sent (preserving edits made while in-flight)
      useSync.getState().clearDirty(dirtySnap, delSnap, !!settingsPayload);
      applyProxyHint(normalizeServerUrl(sync.serverUrl), res.proxy);

      const remote = res.state;
      if (res.mode !== 'unchanged' && remote) {
        // Apply merged records back into local IndexedDB without triggering local change hooks
        suppressHooks = true;
        try {
          const del = { ...emptyTombstones(), ...(remote.deleted ?? {}) };
          const rDocs = Object.values(remote.docs ?? {});
          const rCols = Object.values(remote.collections ?? {});
          const rNotes = Object.values(remote.notes ?? {});
          const rInks = Object.values(remote.inks ?? {});
          const rGlos = Object.values(remote.glossary ?? {});
          const rChats = Object.values(remote.chats ?? {});
          const rTrans = Object.values(remote.translations ?? {});
          const hasDeletes =
            Object.keys(del.docs).length > 0 ||
            Object.keys(del.collections).length > 0 ||
            Object.keys(del.notes).length > 0 ||
            Object.keys(del.inks).length > 0 ||
            Object.keys(del.glossary).length > 0 ||
            Object.keys(del.chats).length > 0;
          const hasPuts = rDocs.length + rCols.length + rNotes.length + rInks.length + rGlos.length + rChats.length + rTrans.length > 0;

          if (hasDeletes || hasPuts) {
            await db.transaction('rw', [db.docs, db.blobs, db.collections, db.notes, db.inks, db.glossary, db.chats, db.translations], async () => {
              for (const id of Object.keys(del.docs ?? {})) {
                if (!remote.docs?.[id]) {
                  await db.docs.delete(id);
                  await db.blobs.delete(id);
                }
              }
              for (const id of Object.keys(del.collections ?? {})) if (!remote.collections?.[id]) await db.collections.delete(id);
              for (const id of Object.keys(del.notes ?? {})) if (!remote.notes?.[id]) await db.notes.delete(id);
              for (const id of Object.keys(del.inks ?? {})) if (!remote.inks?.[id]) await db.inks.delete(id);
              for (const id of Object.keys(del.glossary ?? {})) if (!remote.glossary?.[id]) await db.glossary.delete(id);
              for (const id of Object.keys(del.chats ?? {})) if (!remote.chats?.[id]) await db.chats.delete(id);

              if (rDocs.length) await db.docs.bulkPut(rDocs);
              if (rCols.length) await db.collections.bulkPut(rCols);
              if (rNotes.length) await db.notes.bulkPut(rNotes);
              if (rInks.length) await db.inks.bulkPut(rInks);
              if (rGlos.length) await db.glossary.bulkPut(rGlos);
              if (rChats.length) await db.chats.bulkPut(rChats);
              if (rTrans.length) await db.translations.bulkPut(rTrans);
            });
          }

          // Apply E2E-decrypted remote settings if newer
          if (sync.syncSettings && sync.encKeyB64 && remote.settings?.encrypted) {
            const localTs = useSync.getState().settingsUpdatedAt;
            if (remote.settings.updatedAt > localTs) {
              const dec = await decryptPayload<Partial<SyncedSettings>>(remote.settings.encrypted, sync.encKeyB64);
              if (dec && Array.isArray(dec.providers)) {
                useSettings.getState().set(dec);
                useSync.getState().set({ settingsUpdatedAt: remote.settings.updatedAt });
              }
            }
          }
        } finally {
          suppressHooks = false;
        }
      }

      const nextTombstones =
        res.mode === 'full' && remote?.deleted
          ? { ...emptyTombstones(), ...remote.deleted }
          : useSync.getState().tombstones;

      useSync.getState().set({
        status: 'ok',
        progress: '',
        lastError: '',
        lastSyncAt: Date.now(),
        lastRevision: res.revision,
        tombstones: nextTombstones,
      });

      // Kick off PDF blob uploads/downloads asynchronously so the UI finishes syncing immediately!
      syncBlobsInBackground(res.missingBlobs ?? []);
      return true;
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 401) {
        useSync.getState().set({ status: 'error', progress: '', lastError: '登录已失效，请重新登录' });
      } else {
        useSync.getState().set({ status: 'error', progress: '', lastError: err.message || '同步失败' });
      }
      return false;
    } finally {
      inFlight = null;
      if (rerunQueued) {
        rerunQueued = false;
        setTimeout(() => void syncNow(), 350);
      }
    }
  })();

  return inFlight;
}

let autoInit = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleAutoSync(delayMs = 2000) {
  const s = useSync.getState();
  if (!s.token || !s.autoSync) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void syncNow();
  }, delayMs);
}

/** Attach Dexie & settings hooks once at app startup so local changes & deletions auto-sync incrementally. */
export function initAutoSync() {
  if (autoInit) return;
  autoInit = true;

  const tables: TombstoneTable[] = ['docs', 'collections', 'notes', 'inks', 'glossary', 'chats'];
  for (const name of tables) {
    const tbl = db[name];
    tbl.hook('deleting', (primKey) => {
      if (suppressHooks) return;
      useSync.getState().recordDelete(name, String(primKey));
      scheduleAutoSync(1800);
    });
    tbl.hook('creating', (primKey, obj) => {
      if (suppressHooks) return;
      const id = String(primKey ?? (obj as { id?: string })?.id ?? '');
      if (id) useSync.getState().markDirty(name, id);
      scheduleAutoSync(2000);
    });
    tbl.hook('updating', (_mods, primKey) => {
      if (suppressHooks) return;
      useSync.getState().markDirty(name, String(primKey));
      scheduleAutoSync(2500);
    });
  }
  db.translations.hook('creating', (primKey, obj) => {
    if (suppressHooks) return;
    const key = String(primKey ?? (obj as { key?: string })?.key ?? '');
    if (key) useSync.getState().markDirty('translations', key);
    scheduleAutoSync(5000);
  });
  db.translations.hook('updating', (_mods, primKey) => {
    if (suppressHooks) return;
    useSync.getState().markDirty('translations', String(primKey));
    scheduleAutoSync(5000);
  });

  // Track local settings edits for E2E settings sync
  useSettings.subscribe((cur, prev) => {
    if (suppressHooks) return;
    const changed = SYNCED_SETTING_KEYS.some((k) => JSON.stringify(cur[k]) !== JSON.stringify(prev[k]));
    if (changed) {
      useSync.getState().set({ settingsUpdatedAt: Date.now(), dirtySettings: true });
      scheduleAutoSync(2500);
    }
  });

  // Initial sync shortly after load + fast lightweight polling + online/visibility resume
  setTimeout(() => {
    const s = useSync.getState();
    if (s.token && s.autoSync) void syncNow();
  }, 1000);

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      const s = useSync.getState();
      if (s.token && s.autoSync) void syncNow();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        const s = useSync.getState();
        if (s.token && s.autoSync && Date.now() - s.lastSyncAt > 3000) void syncNow();
      } else if (document.visibilityState === 'hidden') {
        // Flush pending local changes right before iPadOS Safari suspends the tab
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
          const s = useSync.getState();
          if (s.token && s.autoSync) void syncNow();
        }
      }
    });
    window.addEventListener('pagehide', () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
        const s = useSync.getState();
        if (s.token && s.autoSync) void syncNow();
      }
    });
    // Lightweight delta check every 25s while visible (~120 bytes when unchanged)
    setInterval(() => {
      const s = useSync.getState();
      if (document.visibilityState === 'visible' && s.token && s.autoSync) void syncNow();
    }, 25_000);
  }
}

export type { DirtyMap, SyncTable };
export { emptyDirty };

import { db, type ChatRecord, type Collection, type DocRecord, type GlossaryEntry, type NoteRecord, type TranslationRecord } from '../db/db';
import { desktop } from '../lib/desktop';
import { useSettings, type Settings } from '../store/settings';
import { emptyTombstones, useSync, type TombstoneMap, type TombstoneTable } from '../store/sync';

const SYNCED_SETTING_KEYS = [
  'providers',
  'translateProviderId',
  'chatProviderId',
  'sourceLang',
  'targetLang',
  'selectionAction',
  'theme',
  'concurrency',
  'batchSize',
  'prompts',
  'readerFontSize',
  'autoTerms',
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
  const key = await crypto.subtle.importKey('raw', fromB64(keyB64), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const pt = new TextEncoder().encode(JSON.stringify(data));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt));
  return `v1:${toB64(iv)}:${toB64(ct)}`;
}

export async function decryptPayload<T>(packed: string, keyB64: string): Promise<T | null> {
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
  if (d) return `Desktop (${d.platform} ${d.version})`;
  if (typeof navigator !== 'undefined') return `Web (${navigator.platform || 'Browser'})`;
  return 'PaperBridge';
}

async function apiJson<T>(serverUrl: string, path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const base = normalizeServerUrl(serverUrl);
  if (!base) throw new Error('请先填写同步服务器地址');
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(`${base}${path}`, { ...init, headers });
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
  glossary: Record<string, GlossaryEntry>;
  chats: Record<string, ChatRecord>;
  translations: Record<string, TranslationRecord>;
  settings: { updatedAt: number; encrypted: string } | null;
  deleted: TombstoneMap;
}

interface MergeResponse {
  revision: number;
  updatedAt: number;
  state: RemoteState;
  missingBlobs: string[];
  proxy?: { token?: string };
}

function indexBy<T>(arr: T[], keyOf: (x: T) => string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const x of arr) out[keyOf(x)] = x;
  return out;
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
    concurrency: s.concurrency,
    batchSize: s.batchSize,
    prompts: s.prompts,
    readerFontSize: s.readerFontSize,
    autoTerms: s.autoTerms,
  };
}

let inFlight: Promise<boolean> | null = null;
let rerunQueued = false;
let suppressHooks = false;

export async function syncNow(): Promise<boolean> {
  const st = useSync.getState();
  if (!st.serverUrl || !st.token) return false;
  if (inFlight) {
    rerunQueued = true;
    return inFlight;
  }

  inFlight = (async () => {
    const sync = useSync.getState();
    sync.set({ status: 'syncing', progress: '合并数据…', lastError: '' });
    try {
      const [docs, collections, notes, glossary, chats, translations] = await Promise.all([
        db.docs.toArray(),
        db.collections.toArray(),
        db.notes.toArray(),
        db.glossary.toArray(),
        db.chats.toArray(),
        db.translations.toArray(),
      ]);

      let settingsPayload: { updatedAt: number; encrypted: string } | undefined;
      if (sync.syncSettings && sync.encKeyB64) {
        const curSettings = useSettings.getState();
        // Only upload local settings if user has configured something or previously modified them
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
            docs: indexBy(docs, (d) => d.id),
            collections: indexBy(collections, (c) => c.id),
            notes: indexBy(notes, (n) => n.id),
            glossary: indexBy(glossary, (g) => g.id),
            chats: indexBy(chats, (c) => c.id),
            translations: indexBy(translations, (t) => t.key),
            settings: settingsPayload,
            deleted: sync.tombstones,
          }),
        },
        sync.token,
      );

      // Apply merged records back into local IndexedDB without triggering local change hooks
      applyProxyHint(normalizeServerUrl(sync.serverUrl), res.proxy);
      suppressHooks = true;
      try {
        const remote = res.state;
        const del = remote.deleted ?? emptyTombstones();

        await db.transaction('rw', [db.docs, db.blobs, db.collections, db.notes, db.glossary, db.chats, db.translations], async () => {
          // Delete locally removed/tombstoned items
          for (const id of Object.keys(del.docs ?? {})) {
            if (!remote.docs[id]) {
              await db.docs.delete(id);
              await db.blobs.delete(id);
            }
          }
          for (const id of Object.keys(del.collections ?? {})) if (!remote.collections[id]) await db.collections.delete(id);
          for (const id of Object.keys(del.notes ?? {})) if (!remote.notes[id]) await db.notes.delete(id);
          for (const id of Object.keys(del.glossary ?? {})) if (!remote.glossary[id]) await db.glossary.delete(id);
          for (const id of Object.keys(del.chats ?? {})) if (!remote.chats[id]) await db.chats.delete(id);

          // Upsert merged records
          const rDocs = Object.values(remote.docs ?? {});
          const rCols = Object.values(remote.collections ?? {});
          const rNotes = Object.values(remote.notes ?? {});
          const rGlos = Object.values(remote.glossary ?? {});
          const rChats = Object.values(remote.chats ?? {});
          const rTrans = Object.values(remote.translations ?? {});

          if (rDocs.length) await db.docs.bulkPut(rDocs);
          if (rCols.length) await db.collections.bulkPut(rCols);
          if (rNotes.length) await db.notes.bulkPut(rNotes);
          if (rGlos.length) await db.glossary.bulkPut(rGlos);
          if (rChats.length) await db.chats.bulkPut(rChats);
          if (rTrans.length) await db.translations.bulkPut(rTrans);
        });

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

      // Upload PDF blobs that the server is missing
      const localDocs = await db.docs.toArray();
      if (res.missingBlobs.length > 0) {
        const docByHash = new Map<string, DocRecord>();
        for (const d of localDocs) if (d.hasPdf && d.hash) docByHash.set(d.hash, d);
        for (let i = 0; i < res.missingBlobs.length; i++) {
          const h = res.missingBlobs[i];
          const d = docByHash.get(h);
          if (!d) continue;
          const b = await db.blobs.get(d.id);
          if (!b) continue;
          useSync.getState().set({ progress: `上传 PDF (${i + 1}/${res.missingBlobs.length})…` });
          const upRes = await fetch(`${normalizeServerUrl(sync.serverUrl)}/api/blobs/${h}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${sync.token}`, 'Content-Type': 'application/pdf' },
            body: b.blob,
          });
          if (!upRes.ok) {
            console.warn('blob upload failed', h, upRes.status);
          }
        }
      }

      // Download PDF blobs that exist remotely (referenced by merged docs) but are missing locally
      const missingLocal = [];
      for (const d of localDocs) {
        if (!d.hasPdf || !d.hash) continue;
        const exists = await db.blobs.get(d.id);
        if (!exists) missingLocal.push(d);
      }
      for (let i = 0; i < missingLocal.length; i++) {
        const d = missingLocal[i];
        useSync.getState().set({ progress: `下载 PDF (${i + 1}/${missingLocal.length})…` });
        const dlRes = await fetch(`${normalizeServerUrl(sync.serverUrl)}/api/blobs/${d.hash}`, {
          headers: { Authorization: `Bearer ${sync.token}` },
        });
        if (dlRes.ok) {
          const buf = await dlRes.arrayBuffer();
          suppressHooks = true;
          try {
            await db.blobs.put({ id: d.id, blob: new Blob([buf], { type: 'application/pdf' }) });
          } finally {
            suppressHooks = false;
          }
        }
      }

      useSync.getState().set({
        status: 'ok',
        progress: '',
        lastError: '',
        lastSyncAt: Date.now(),
        lastRevision: res.revision,
        tombstones: res.state.deleted ?? emptyTombstones(),
      });
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
        setTimeout(() => void syncNow(), 500);
      }
    }
  })();

  return inFlight;
}

let autoInit = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleAutoSync(delayMs = 5000) {
  const s = useSync.getState();
  if (!s.token || !s.autoSync) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void syncNow();
  }, delayMs);
}

/** Attach Dexie & settings hooks once at app startup so local changes & deletions auto-sync. */
export function initAutoSync() {
  if (autoInit) return;
  autoInit = true;

  const tables: TombstoneTable[] = ['docs', 'collections', 'notes', 'glossary', 'chats'];
  for (const name of tables) {
    const tbl = db[name];
    tbl.hook('deleting', (primKey) => {
      if (suppressHooks) return;
      useSync.getState().recordDelete(name, String(primKey));
      scheduleAutoSync(4000);
    });
    tbl.hook('creating', () => {
      if (suppressHooks) return;
      scheduleAutoSync(6000);
    });
    tbl.hook('updating', () => {
      if (suppressHooks) return;
      scheduleAutoSync(6000);
    });
  }
  db.translations.hook('creating', () => {
    if (suppressHooks) return;
    scheduleAutoSync(10_000);
  });

  // Track local settings edits for E2E settings sync
  useSettings.subscribe((cur, prev) => {
    if (suppressHooks) return;
    const changed = SYNCED_SETTING_KEYS.some((k) => JSON.stringify(cur[k]) !== JSON.stringify(prev[k]));
    if (changed) {
      useSync.getState().set({ settingsUpdatedAt: Date.now() });
      scheduleAutoSync(4000);
    }
  });

  // Initial sync shortly after load + periodic refresh + online/visibility resume
  setTimeout(() => {
    const s = useSync.getState();
    if (s.token && s.autoSync) void syncNow();
  }, 1500);

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      const s = useSync.getState();
      if (s.token && s.autoSync) void syncNow();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        const s = useSync.getState();
        if (s.token && s.autoSync && Date.now() - s.lastSyncAt > 30_000) void syncNow();
      }
    });
    setInterval(() => {
      const s = useSync.getState();
      if (document.visibilityState === 'visible' && s.token && s.autoSync) void syncNow();
    }, 120_000);
  }
}

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type TombstoneTable = 'docs' | 'collections' | 'notes' | 'inks' | 'glossary' | 'chats';
export type SyncTable = TombstoneTable | 'translations';

export type TombstoneMap = Record<TombstoneTable, Record<string, number>>;
export type DirtyMap = Record<SyncTable, string[]>;

export function emptyTombstones(): TombstoneMap {
  return { docs: {}, collections: {}, notes: {}, inks: {}, glossary: {}, chats: {} };
}

export function emptyDirty(): DirtyMap {
  return { docs: [], collections: [], notes: [], inks: [], glossary: [], chats: [], translations: [] };
}

export function defaultSyncServerUrl(): string {
  if (typeof location === 'undefined') return '';
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return '';
  const host = location.hostname;
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host.endsWith('.github.io') ||
    host === 'appassets.androidplatform.net'
  )
    return '';
  return location.origin;
}

export interface SyncStore {
  serverUrl: string;
  username: string;
  token: string;
  /** Locally cached PBKDF2-derived AES-256 key (base64) for E2E settings sync; cleared on logout. */
  encKeyB64: string;
  syncSettings: boolean;
  autoSync: boolean;
  settingsUpdatedAt: number;
  lastSyncAt: number;
  lastRevision: number;
  tombstones: TombstoneMap;
  /** Record IDs modified/created locally since the last successful delta sync. */
  dirty: DirtyMap;
  /** Newly recorded tombstones not yet acknowledged by the server. */
  dirtyTombstones: TombstoneMap;
  dirtySettings: boolean;

  // Ephemeral runtime state
  status: 'idle' | 'syncing' | 'ok' | 'error';
  progress: string;
  blobProgress: string;
  lastError: string;

  set: (patch: Partial<SyncStore>) => void;
  markDirty: (table: SyncTable, id: string) => void;
  clearDirty: (sent: DirtyMap, sentDeletes: TombstoneMap, sentSettings: boolean) => void;
  recordDelete: (table: TombstoneTable, id: string, at?: number) => void;
  clearAuth: () => void;
}

export const useSync = create<SyncStore>()(
  persist(
    (set) => ({
      serverUrl: defaultSyncServerUrl(),
      username: '',
      token: '',
      encKeyB64: '',
      syncSettings: true,
      autoSync: true,
      settingsUpdatedAt: 0,
      lastSyncAt: 0,
      lastRevision: 0,
      tombstones: emptyTombstones(),
      dirty: emptyDirty(),
      dirtyTombstones: emptyTombstones(),
      dirtySettings: false,

      status: 'idle',
      progress: '',
      blobProgress: '',
      lastError: '',

      set: (patch) => set(patch),
      markDirty: (table, id) =>
        set((s) => {
          const list = s.dirty[table];
          if (list.includes(id)) return s;
          return { dirty: { ...s.dirty, [table]: [...list, id] } };
        }),
      clearDirty: (sent, sentDeletes, sentSettings) =>
        set((s) => {
          const nextDirty = emptyDirty();
          for (const t of Object.keys(nextDirty) as SyncTable[]) {
            const done = new Set(sent[t] ?? []);
            nextDirty[t] = (s.dirty[t] ?? []).filter((id) => !done.has(id));
          }
          const nextDel = emptyTombstones();
          for (const t of Object.keys(nextDel) as TombstoneTable[]) {
            const cur = s.dirtyTombstones[t] ?? {};
            const ack = sentDeletes[t] ?? {};
            const rem: Record<string, number> = {};
            for (const [id, ts] of Object.entries(cur)) {
              if ((ack[id] ?? 0) < ts) rem[id] = ts;
            }
            nextDel[t] = rem;
          }
          return {
            dirty: nextDirty,
            dirtyTombstones: nextDel,
            dirtySettings: sentSettings ? false : s.dirtySettings,
          };
        }),
      recordDelete: (table, id, at = Date.now()) =>
        set((s) => ({
          tombstones: {
            ...s.tombstones,
            [table]: { ...s.tombstones[table], [id]: Math.max(s.tombstones[table][id] ?? 0, at) },
          },
          dirtyTombstones: {
            ...s.dirtyTombstones,
            [table]: { ...s.dirtyTombstones[table], [id]: Math.max(s.dirtyTombstones[table][id] ?? 0, at) },
          },
        })),
      clearAuth: () =>
        set({
          username: '',
          token: '',
          encKeyB64: '',
          lastSyncAt: 0,
          lastRevision: 0,
          dirty: emptyDirty(),
          dirtyTombstones: emptyTombstones(),
          dirtySettings: false,
          status: 'idle',
          progress: '',
          blobProgress: '',
          lastError: '',
        }),
    }),
    {
      name: 'paperbridge-sync-v1',
      partialize: (s) => ({
        serverUrl: s.serverUrl.includes('appassets.androidplatform.net') ? '' : s.serverUrl,
        username: s.username,
        token: s.token,
        encKeyB64: s.encKeyB64,
        syncSettings: s.syncSettings,
        autoSync: s.autoSync,
        settingsUpdatedAt: s.settingsUpdatedAt,
        lastSyncAt: s.lastSyncAt,
        lastRevision: s.lastRevision,
        tombstones: s.tombstones,
        dirty: s.dirty,
        dirtyTombstones: s.dirtyTombstones,
        dirtySettings: s.dirtySettings,
      }),
      onRehydrateStorage: () => (state) => {
        if (state?.serverUrl?.includes('appassets.androidplatform.net')) {
          state.set({ serverUrl: '' });
        }
      },
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SyncStore>;
        return {
          ...current,
          ...p,
          tombstones: { ...emptyTombstones(), ...(p.tombstones ?? {}) },
          dirty: { ...emptyDirty(), ...(p.dirty ?? {}) },
          dirtyTombstones: { ...emptyTombstones(), ...(p.dirtyTombstones ?? {}) },
        };
      },
    },
  ),
);

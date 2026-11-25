import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type TombstoneTable = 'docs' | 'collections' | 'notes' | 'glossary' | 'chats';

export type TombstoneMap = Record<TombstoneTable, Record<string, number>>;

export function emptyTombstones(): TombstoneMap {
  return { docs: {}, collections: {}, notes: {}, glossary: {}, chats: {} };
}

export function defaultSyncServerUrl(): string {
  if (typeof location === 'undefined') return '';
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return '';
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.github.io')) return '';
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

  // Ephemeral runtime state
  status: 'idle' | 'syncing' | 'ok' | 'error';
  progress: string;
  lastError: string;

  set: (patch: Partial<SyncStore>) => void;
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

      status: 'idle',
      progress: '',
      lastError: '',

      set: (patch) => set(patch),
      recordDelete: (table, id, at = Date.now()) =>
        set((s) => ({
          tombstones: {
            ...s.tombstones,
            [table]: { ...s.tombstones[table], [id]: Math.max(s.tombstones[table][id] ?? 0, at) },
          },
        })),
      clearAuth: () =>
        set({
          username: '',
          token: '',
          encKeyB64: '',
          lastSyncAt: 0,
          lastRevision: 0,
          status: 'idle',
          progress: '',
          lastError: '',
        }),
    }),
    {
      name: 'paperbridge-sync-v1',
      partialize: (s) => ({
        serverUrl: s.serverUrl,
        username: s.username,
        token: s.token,
        encKeyB64: s.encKeyB64,
        syncSettings: s.syncSettings,
        autoSync: s.autoSync,
        settingsUpdatedAt: s.settingsUpdatedAt,
        lastSyncAt: s.lastSyncAt,
        lastRevision: s.lastRevision,
        tombstones: s.tombstones,
      }),
    },
  ),
);

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PDFDocumentProxy, PDFLoadingTask } from '../pdf/loader';
import type { PageState, ParaState, SideTab, ViewMode } from './reader';

export interface OpenTab {
  docId: string;
  /** Cached display title (TabBar also overlays the live Dexie doc title when loaded). */
  title: string;
  /** Last remembered 0-based page index for this tab. */
  page?: number;
}

export type ActiveView =
  | { kind: 'library' }
  | { kind: 'notes' }
  | { kind: 'doc'; docId: string };

export interface ReaderSnapshot {
  currentPage: number;
  scale: number;
  viewMode: ViewMode;
  sideTab: SideTab;
  sideOpen: boolean;
  pageStates: Record<number, PageState>;
  paraStates: Record<string, ParaState>;
  transVersion: number;
}

// ---- Warm in-memory caches for instant tab switching (not persisted) ----

interface WarmPdf {
  task: PDFLoadingTask;
  pdf: PDFDocumentProxy;
  touchedAt: number;
}

const MAX_WARM_PDFS = 6;
const warmPdfs = new Map<string, WarmPdf>();
const snapshots = new Map<string, ReaderSnapshot>();
let evictFullTextHook: ((docId: string) => void) | null = null;

export function registerFullTextEvictor(fn: (docId: string) => void) {
  evictFullTextHook = fn;
}

export function getWarmPdf(docId: string): WarmPdf | undefined {
  const entry = warmPdfs.get(docId);
  if (entry) entry.touchedAt = Date.now();
  return entry;
}

export function setWarmPdf(docId: string, task: PDFLoadingTask, pdf: PDFDocumentProxy) {
  const prev = warmPdfs.get(docId);
  if (prev && prev.task !== task) void prev.task.destroy();
  warmPdfs.set(docId, { task, pdf, touchedAt: Date.now() });
  // Evict least-recently-used PDF beyond cap (never evicting the one just added)
  if (warmPdfs.size > MAX_WARM_PDFS) {
    const activeDoc = useTabs.getState().active;
    const activeId = activeDoc.kind === 'doc' ? activeDoc.docId : null;
    const victim = [...warmPdfs.entries()]
      .filter(([id]) => id !== docId && id !== activeId)
      .sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
    if (victim) {
      warmPdfs.delete(victim[0]);
      void victim[1].task.destroy();
      evictFullTextHook?.(victim[0]);
    }
  }
}

export function releaseWarmPdf(docId: string) {
  const entry = warmPdfs.get(docId);
  if (entry) {
    warmPdfs.delete(docId);
    void entry.task.destroy();
  }
  snapshots.delete(docId);
  evictFullTextHook?.(docId);
}

export function saveReaderSnapshot(docId: string, snap: ReaderSnapshot) {
  snapshots.set(docId, snap);
}

export function getReaderSnapshot(docId: string): ReaderSnapshot | undefined {
  return snapshots.get(docId);
}

// ---- Zustand store ----

interface TabsStore {
  tabs: OpenTab[];
  active: ActiveView;
  /** The most recently viewed doc tab (kept mounted while peeking at Library/Notes). */
  lastDocId: string | null;
  /** Optional one-shot 1-based page jump requested when opening a doc tab (e.g. from Notes). */
  pendingPage: { docId: string; page: number; nonce: number } | null;

  openDoc: (docId: string, opts?: { title?: string; page?: number; background?: boolean }) => void;
  activateLibrary: () => void;
  activateNotes: () => void;
  activateDoc: (docId: string, page?: number) => void;
  closeTab: (docId: string) => void;
  closeOthers: (docId: string) => void;
  closeAll: () => void;
  updateTab: (docId: string, patch: Partial<OpenTab>) => void;
  moveTab: (fromIndex: number, toIndex: number) => void;
  pruneMissing: (existingIds: Set<string>) => void;
  consumePendingPage: (docId: string) => number | undefined;
}

let jumpSeq = 0;

function syncHash(active: ActiveView, page?: number) {
  if (typeof window === 'undefined') return;
  const target =
    active.kind === 'library'
      ? '#/'
      : active.kind === 'notes'
        ? '#/notes'
        : `#/doc/${encodeURIComponent(active.docId)}${page && page > 0 ? `?page=${page}` : ''}`;
  if (location.hash !== target) {
    history.replaceState(null, '', target);
  }
}

export const useTabs = create<TabsStore>()(
  persist(
    (set, get) => ({
      tabs: [],
      active: { kind: 'library' },
      lastDocId: null,
      pendingPage: null,

      openDoc: (docId, opts = {}) => {
        const { title = '加载中…', page, background = false } = opts;
        set((s) => {
          const exists = s.tabs.some((t) => t.docId === docId);
          const tabs = exists
            ? s.tabs.map((t) => (t.docId === docId && title && title !== '加载中…' ? { ...t, title } : t))
            : [...s.tabs, { docId, title, page: page ? page - 1 : undefined }];
          if (background) {
            return { tabs };
          }
          const nextActive: ActiveView = { kind: 'doc', docId };
          syncHash(nextActive, page);
          return {
            tabs,
            active: nextActive,
            lastDocId: docId,
            pendingPage: page && page > 0 ? { docId, page, nonce: ++jumpSeq } : s.pendingPage,
          };
        });
      },

      activateLibrary: () => {
        const nextActive: ActiveView = { kind: 'library' };
        syncHash(nextActive);
        set({ active: nextActive });
      },

      activateNotes: () => {
        const nextActive: ActiveView = { kind: 'notes' };
        syncHash(nextActive);
        set({ active: nextActive });
      },

      activateDoc: (docId, page) => {
        get().openDoc(docId, { page });
      },

      closeTab: (docId) => {
        releaseWarmPdf(docId);
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.docId === docId);
          if (idx < 0) return s;
          const tabs = s.tabs.filter((t) => t.docId !== docId);
          let active = s.active;
          let lastDocId = s.lastDocId === docId ? null : s.lastDocId;
          if (s.active.kind === 'doc' && s.active.docId === docId) {
            const neighbor = tabs[idx] ?? tabs[idx - 1];
            if (neighbor) {
              active = { kind: 'doc', docId: neighbor.docId };
              lastDocId = neighbor.docId;
            } else {
              active = { kind: 'library' };
            }
            syncHash(active);
          } else if (!lastDocId && tabs.length) {
            lastDocId = tabs[tabs.length - 1].docId;
          }
          return {
            tabs,
            active,
            lastDocId,
            pendingPage: s.pendingPage?.docId === docId ? null : s.pendingPage,
          };
        });
      },

      closeOthers: (docId) => {
        const cur = get().tabs;
        for (const t of cur) {
          if (t.docId !== docId) releaseWarmPdf(t.docId);
        }
        set((s) => {
          const keep = s.tabs.filter((t) => t.docId === docId);
          const active: ActiveView = keep.length ? { kind: 'doc', docId } : { kind: 'library' };
          syncHash(active);
          return { tabs: keep, active, lastDocId: keep.length ? docId : null };
        });
      },

      closeAll: () => {
        for (const t of get().tabs) releaseWarmPdf(t.docId);
        const active: ActiveView = { kind: 'library' };
        syncHash(active);
        set({ tabs: [], active, lastDocId: null, pendingPage: null });
      },

      updateTab: (docId, patch) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.docId === docId ? { ...t, ...patch } : t)),
        })),

      moveTab: (fromIndex, toIndex) =>
        set((s) => {
          if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= s.tabs.length || toIndex >= s.tabs.length) {
            return s;
          }
          const tabs = [...s.tabs];
          const [item] = tabs.splice(fromIndex, 1);
          tabs.splice(toIndex, 0, item);
          return { tabs };
        }),

      pruneMissing: (existingIds) => {
        const missing = get().tabs.filter((t) => !existingIds.has(t.docId));
        for (const t of missing) get().closeTab(t.docId);
        const last = get().lastDocId;
        if (last && !existingIds.has(last)) {
          releaseWarmPdf(last);
          set({ lastDocId: null });
        }
      },

      consumePendingPage: (docId) => {
        const p = get().pendingPage;
        if (!p || p.docId !== docId) return undefined;
        set({ pendingPage: null });
        return p.page;
      },
    }),
    {
      name: 'paperbridge-tabs-v1',
      partialize: (s) => ({
        tabs: s.tabs,
        active: s.active,
        lastDocId: s.lastDocId,
      }),
    },
  ),
);

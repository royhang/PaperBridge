import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ReadStatus } from '../db/db';

export type ViewKind = 'all' | 'recent' | 'unfiled' | 'duplicates' | 'trash' | 'collection' | 'tag';
export type SortKey = 'lastOpened' | 'added' | 'title' | 'year' | 'author';
export type ListLayout = 'table' | 'list';
export type StatusFilter = 'all' | ReadStatus;

export interface LibraryView {
  kind: ViewKind;
  /** collection id or tag name */
  id?: string;
}

interface LibraryStore {
  view: LibraryView;
  sort: SortKey;
  sortDesc: boolean;
  layout: ListLayout;
  query: string;
  fullText: boolean;
  /** Stackable filters applied within any library/collection/tag view */
  statusFilter: StatusFilter;
  onlyStarred: boolean;
  onlyWithNotes: boolean;
  onlyNoPdf: boolean;
  /** Expanded/collapsed state for nested collection folders */
  expandedCols: Record<string, boolean>;
  selectedId: string | null;
  checked: string[];
  setView: (v: LibraryView) => void;
  setSort: (k: SortKey) => void;
  setLayout: (l: ListLayout) => void;
  setQuery: (q: string) => void;
  setFullText: (b: boolean) => void;
  setStatusFilter: (f: StatusFilter) => void;
  toggleOnlyStarred: () => void;
  toggleOnlyWithNotes: () => void;
  toggleOnlyNoPdf: () => void;
  clearFilters: () => void;
  setColExpanded: (id: string, open: boolean) => void;
  toggleColExpanded: (id: string) => void;
  select: (id: string | null) => void;
  toggleCheck: (id: string) => void;
  setChecked: (ids: string[]) => void;
}

const VALID_VIEWS = new Set<string>(['all', 'recent', 'unfiled', 'duplicates', 'trash', 'collection', 'tag']);

export const useLibrary = create<LibraryStore>()(
  persist(
    (set) => ({
      view: { kind: 'all' },
      sort: 'lastOpened',
      sortDesc: true,
      layout: 'table',
      query: '',
      fullText: false,
      statusFilter: 'all',
      onlyStarred: false,
      onlyWithNotes: false,
      onlyNoPdf: false,
      expandedCols: {},
      selectedId: null,
      checked: [],
      setView: (view) => set({ view, checked: [], selectedId: null }),
      setSort: (k) => set((s) => (s.sort === k ? { sortDesc: !s.sortDesc } : { sort: k, sortDesc: k !== 'title' && k !== 'author' })),
      setLayout: (layout) => set({ layout }),
      setQuery: (query) => set({ query }),
      setFullText: (fullText) => set({ fullText }),
      setStatusFilter: (statusFilter) => set({ statusFilter }),
      toggleOnlyStarred: () => set((s) => ({ onlyStarred: !s.onlyStarred })),
      toggleOnlyWithNotes: () => set((s) => ({ onlyWithNotes: !s.onlyWithNotes })),
      toggleOnlyNoPdf: () => set((s) => ({ onlyNoPdf: !s.onlyNoPdf })),
      clearFilters: () => set({ statusFilter: 'all', onlyStarred: false, onlyWithNotes: false, onlyNoPdf: false }),
      setColExpanded: (id, open) => set((s) => ({ expandedCols: { ...s.expandedCols, [id]: open } })),
      toggleColExpanded: (id) => set((s) => ({ expandedCols: { ...s.expandedCols, [id]: s.expandedCols[id] === false } })),
      select: (selectedId) => set({ selectedId }),
      toggleCheck: (id) => set((s) => ({ checked: s.checked.includes(id) ? s.checked.filter((x) => x !== id) : [...s.checked, id] })),
      setChecked: (checked) => set({ checked }),
    }),
    {
      name: 'paperbridge-library-view',
      partialize: (s) => ({
        view: s.view,
        sort: s.sort,
        sortDesc: s.sortDesc,
        layout: s.layout,
        expandedCols: s.expandedCols,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<LibraryStore> & { view?: { kind?: string; id?: string } };
        const rawKind: string | undefined = p.view?.kind;
        if (rawKind && !VALID_VIEWS.has(rawKind)) {
          // Gracefully migrate legacy v0.3 views (starred/unread/reading/done/nopdf) to stackable filters
          const migratedStatus: StatusFilter =
            rawKind === 'unread' || rawKind === 'reading' || rawKind === 'done' ? rawKind : 'all';
          return {
            ...current,
            ...p,
            view: { kind: 'all' as const },
            statusFilter: migratedStatus,
            onlyStarred: rawKind === 'starred',
            onlyNoPdf: rawKind === 'nopdf',
          };
        }
        return { ...current, ...p };
      },
    },
  ),
);

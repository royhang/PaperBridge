import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ViewKind = 'all' | 'starred' | 'unread' | 'reading' | 'done' | 'recent' | 'nopdf' | 'collection' | 'tag';
export type SortKey = 'lastOpened' | 'added' | 'title' | 'year' | 'author';

export interface LibraryView {
  kind: ViewKind;
  /** collection id or tag name */
  id?: string;
}

interface LibraryStore {
  view: LibraryView;
  sort: SortKey;
  sortDesc: boolean;
  query: string;
  fullText: boolean;
  selectedId: string | null;
  checked: string[];
  setView: (v: LibraryView) => void;
  setSort: (k: SortKey) => void;
  setQuery: (q: string) => void;
  setFullText: (b: boolean) => void;
  select: (id: string | null) => void;
  toggleCheck: (id: string) => void;
  setChecked: (ids: string[]) => void;
}

export const useLibrary = create<LibraryStore>()(
  persist(
    (set) => ({
      view: { kind: 'all' },
      sort: 'lastOpened',
      sortDesc: true,
      query: '',
      fullText: false,
      selectedId: null,
      checked: [],
      setView: (view) => set({ view, checked: [], selectedId: null }),
      setSort: (k) => set((s) => (s.sort === k ? { sortDesc: !s.sortDesc } : { sort: k, sortDesc: k !== 'title' && k !== 'author' })),
      setQuery: (query) => set({ query }),
      setFullText: (fullText) => set({ fullText }),
      select: (selectedId) => set({ selectedId }),
      toggleCheck: (id) => set((s) => ({ checked: s.checked.includes(id) ? s.checked.filter((x) => x !== id) : [...s.checked, id] })),
      setChecked: (checked) => set({ checked }),
    }),
    {
      name: 'paperbridge-library-view',
      // only remember the view + sort (per-viewer convenience)
      partialize: (s) => ({ view: s.view, sort: s.sort, sortDesc: s.sortDesc }),
    },
  ),
);

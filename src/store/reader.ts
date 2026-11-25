import { create } from 'zustand';
import type { PDFDocumentProxy } from '../pdf/loader';
import type { NRect } from '../db/db';
import type { ReaderSnapshot } from './tabs';

export type SideTab = 'translate' | 'parallel' | 'chat' | 'notes' | 'glossary';

export interface SelectionInfo {
  text: string;
  pageIndex: number;
  rects: NRect[];
  /** Selection spans pages — highlight would only cover one page, so it's disabled. */
  multiPage?: boolean;
  /** Viewport position for the floating toolbar. */
  anchor: { x: number; y: number };
}

/** A request for the side panel's translate tab. */
export interface TranslateJob {
  id: number;
  text: string;
  mode: 'translate' | 'explain';
  pageIndex?: number;
  rects?: NRect[];
}

export interface PinnedSelection {
  pageIndex: number;
  rects: NRect[];
}

export type ParaStatus = 'pending' | 'running' | 'done' | 'error';

/** How the reader shows the document: original only, original | translation, translation only. */
export type ViewMode = 'original' | 'dual' | 'translated';

/** Layout-preserving translated rendering of one page. */
export interface PageState {
  status: 'queued' | 'running' | 'done' | 'error' | 'skipped';
  /** one-page PDF with the translation typeset in place (status 'done') */
  bytes?: Uint8Array;
  msg?: string;
  /** paragraphs translated / total (while queued/running) */
  done?: number;
  total?: number;
}

export interface ParaState {
  status: ParaStatus;
  translation?: string;
  error?: string;
}

interface ReaderStore {
  docId: string | null;
  title: string;
  pdf: PDFDocumentProxy | null;
  scale: number;
  currentPage: number;
  sideTab: SideTab;
  sideOpen: boolean;
  selection: SelectionInfo | null;
  /** Temporary highlight kept on the PDF after triggering translate/explain/chat/glossary so the user can compare left & right. */
  pinnedSelection: PinnedSelection | null;
  job: TranslateJob | null;
  /** Paragraph id highlighted on the PDF (hover/click from the parallel panel). */
  focusParagraph: { id: string; pageIndex: number } | null;
  /** Requested scroll target; the viewer consumes it. */
  scrollTarget: { pageIndex: number; y?: number; nonce: number } | null;
  /** Full-text translation state per paragraph id. */
  paraStates: Record<string, ParaState>;
  fullTextRunning: boolean;
  /** Bumped whenever translation settings change, so views re-read the cache. */
  transVersion: number;
  resetTranslations: () => void;
  /** Per page translated PDF (rendered in the 双栏 / 译文 views). */
  pageStates: Record<number, PageState>;
  viewMode: ViewMode;
  /** Text handed from the selection toolbar to the glossary / chat panels. */
  handoff: { target: 'glossary' | 'chat'; text: string; nonce: number } | null;

  handoffTo: (target: 'glossary' | 'chat', text: string, pin?: PinnedSelection) => void;
  consumeHandoff: () => void;
  open: (docId: string, title: string, pdf: PDFDocumentProxy, page: number, snapshot?: ReaderSnapshot) => void;
  close: () => void;
  setScale: (s: number) => void;
  setCurrentPage: (p: number) => void;
  setSideTab: (t: SideTab) => void;
  toggleSide: () => void;
  setSelection: (s: SelectionInfo | null) => void;
  setPinnedSelection: (p: PinnedSelection | null) => void;
  startJob: (text: string, mode: TranslateJob['mode'], pageIndex?: number, rects?: NRect[]) => void;
  setFocusParagraph: (f: ReaderStore['focusParagraph']) => void;
  scrollTo: (pageIndex: number, y?: number) => void;
  setParaState: (id: string, s: ParaState) => void;
  setParaStates: (m: Record<string, ParaState>) => void;
  setFullTextRunning: (b: boolean) => void;
  setPageState: (page: number, s: PageState) => void;
  setViewMode: (m: ViewMode) => void;
}

let jobSeq = 0;
let scrollSeq = 0;

export const useReader = create<ReaderStore>()((set) => ({
  docId: null,
  title: '',
  pdf: null,
  scale: 1.3,
  currentPage: 0,
  sideTab: 'translate',
  sideOpen: true,
  selection: null,
  pinnedSelection: null,
  job: null,
  focusParagraph: null,
  scrollTarget: null,
  paraStates: {},
  fullTextRunning: false,
  transVersion: 0,
  resetTranslations: () => set((s) => ({ paraStates: {}, pageStates: {}, transVersion: s.transVersion + 1 })),
  pageStates: {},
  viewMode: 'original',
  handoff: null,

  handoffTo: (target, text, pin) =>
    set((s) => ({
      handoff: { target, text, nonce: ++jobSeq },
      sideTab: target,
      sideOpen: true,
      pinnedSelection: pin ?? s.pinnedSelection,
    })),
  consumeHandoff: () => set({ handoff: null }),
  open: (docId, title, pdf, page, snapshot) =>
    set((s) => {
      const keepTrans = snapshot && snapshot.transVersion === s.transVersion;
      return {
        docId,
        title,
        pdf,
        currentPage: page,
        scale: snapshot?.scale ?? s.scale,
        viewMode: snapshot?.viewMode ?? 'original',
        sideTab: snapshot?.sideTab ?? s.sideTab,
        sideOpen: snapshot?.sideOpen ?? s.sideOpen,
        selection: null,
        pinnedSelection: null,
        job: null,
        paraStates: keepTrans ? snapshot.paraStates : {},
        pageStates: keepTrans ? snapshot.pageStates : {},
        focusParagraph: null,
        fullTextRunning: false,
        scrollTarget: page > 0 ? { pageIndex: page, nonce: ++scrollSeq } : null,
      };
    }),
  close: () =>
    set({
      docId: null,
      pdf: null,
      title: '',
      selection: null,
      pinnedSelection: null,
      job: null,
      paraStates: {},
      pageStates: {},
      fullTextRunning: false,
    }),
  setScale: (scale) => set({ scale: Math.min(4, Math.max(0.5, Math.round(scale * 100) / 100)) }),
  setCurrentPage: (currentPage) => set({ currentPage }),
  setSideTab: (sideTab) => set({ sideTab, sideOpen: true }),
  toggleSide: () => set((s) => ({ sideOpen: !s.sideOpen })),
  setSelection: (selection) => set({ selection }),
  setPinnedSelection: (pinnedSelection) => set({ pinnedSelection }),
  startJob: (text, mode, pageIndex, rects) =>
    set((s) => ({
      job: { id: ++jobSeq, text, mode, pageIndex, rects },
      sideTab: 'translate',
      sideOpen: true,
      pinnedSelection: pageIndex !== undefined && rects?.length ? { pageIndex, rects } : s.pinnedSelection,
    })),
  setFocusParagraph: (focusParagraph) => set({ focusParagraph }),
  scrollTo: (pageIndex, y) => set({ scrollTarget: { pageIndex, y, nonce: ++scrollSeq } }),
  setParaState: (id, st) => set((s) => ({ paraStates: { ...s.paraStates, [id]: st } })),
  setParaStates: (m) => set((s) => ({ paraStates: { ...s.paraStates, ...m } })),
  setFullTextRunning: (fullTextRunning) => set({ fullTextRunning }),
  setPageState: (page, st) => set((s) => ({ pageStates: { ...s.pageStates, [page]: st } })),
  setViewMode: (viewMode) => set({ viewMode }),
}));

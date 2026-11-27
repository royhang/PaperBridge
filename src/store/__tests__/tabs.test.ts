import { beforeEach, describe, expect, it } from 'vitest';
import { getReaderSnapshot, saveReaderSnapshot, useTabs } from '../tabs';

describe('useTabs workspace tab store', () => {
  beforeEach(() => {
    useTabs.setState({ tabs: [], active: { kind: 'library' }, lastDocId: null, pendingPage: null });
  });

  it('opens multiple documents, deduplicates, and supports background open', () => {
    const st = useTabs.getState();
    st.openDoc('a', { title: 'Attention Is All You Need' });
    expect(useTabs.getState().tabs.map((t) => t.docId)).toEqual(['a']);
    expect(useTabs.getState().active).toEqual({ kind: 'doc', docId: 'a' });

    st.openDoc('b', { title: 'BERT', background: true });
    expect(useTabs.getState().tabs.map((t) => t.docId)).toEqual(['a', 'b']);
    expect(useTabs.getState().active).toEqual({ kind: 'doc', docId: 'a' });

    // re-opening existing tab activates it without duplicating
    st.openDoc('b', { title: 'BERT: Pre-training', page: 4 });
    expect(useTabs.getState().tabs).toHaveLength(2);
    expect(useTabs.getState().tabs[1].title).toBe('BERT: Pre-training');
    expect(useTabs.getState().active).toEqual({ kind: 'doc', docId: 'b' });
    expect(useTabs.getState().consumePendingPage('b')).toBe(4);
    expect(useTabs.getState().consumePendingPage('b')).toBeUndefined();
  });

  it('closes active tab by selecting neighbor or falling back to library', () => {
    const st = useTabs.getState();
    st.openDoc('a', { title: 'A' });
    st.openDoc('b', { title: 'B' });
    st.openDoc('c', { title: 'C' });
    st.activateDoc('b');

    st.closeTab('b');
    expect(useTabs.getState().tabs.map((t) => t.docId)).toEqual(['a', 'c']);
    expect(useTabs.getState().active).toEqual({ kind: 'doc', docId: 'c' });

    st.closeTab('c');
    expect(useTabs.getState().active).toEqual({ kind: 'doc', docId: 'a' });

    st.closeTab('a');
    expect(useTabs.getState().tabs).toEqual([]);
    expect(useTabs.getState().active).toEqual({ kind: 'library' });
  });

  it('keeps lastDocId when switching to library or notes, and supports reorder / closeOthers / pruneMissing', () => {
    const st = useTabs.getState();
    st.openDoc('a', { title: 'A' });
    st.openDoc('b', { title: 'B' });
    st.openDoc('c', { title: 'C' });

    st.activateLibrary();
    expect(useTabs.getState().active).toEqual({ kind: 'library' });
    expect(useTabs.getState().lastDocId).toBe('c');

    st.moveTab(2, 0);
    expect(useTabs.getState().tabs.map((t) => t.docId)).toEqual(['c', 'a', 'b']);

    saveReaderSnapshot('a', {
      currentPage: 3,
      scale: 1.5,
      viewMode: 'dual',
      sideTab: 'parallel',
      sideOpen: true,
      pageStates: {},
      paraStates: {},
      transVersion: 0,
    });
    expect(getReaderSnapshot('a')?.currentPage).toBe(3);

    st.closeOthers('b');
    expect(useTabs.getState().tabs.map((t) => t.docId)).toEqual(['b']);
    expect(getReaderSnapshot('a')).toBeUndefined();

    st.pruneMissing(new Set());
    expect(useTabs.getState().tabs).toEqual([]);
    expect(useTabs.getState().active).toEqual({ kind: 'library' });
    expect(useTabs.getState().lastDocId).toBeNull();
  });

  it('clears stale lastDocId even when tabs array is already empty', () => {
    useTabs.setState({ tabs: [], active: { kind: 'library' }, lastDocId: 'trashed-doc', pendingPage: null });
    useTabs.getState().pruneMissing(new Set(['alive-doc']));
    expect(useTabs.getState().lastDocId).toBeNull();
  });
});

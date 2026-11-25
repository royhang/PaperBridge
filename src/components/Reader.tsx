import { useEffect, useRef, useState } from 'react';
import { db, uid, type HighlightColor } from '../db/db';
import { openPdf, type PDFLoadingTask } from '../pdf/loader';
import { invalidateTranslations, runFullText, stopFullText } from '../services/fulltext';
import { useReader } from '../store/reader';
import { useSettings } from '../store/settings';
import { getReaderSnapshot, getWarmPdf, saveReaderSnapshot, setWarmPdf, useTabs } from '../store/tabs';
import { Icon } from './Icon';
import { PdfExportDialog } from './PdfExportDialog';
import { PdfView } from './PdfView';
import { SidePanel } from './SidePanel';

export function Reader({ docId, active = true }: { docId: string; active?: boolean }) {
  const [error, setError] = useState('');
  const pdf = useReader((s) => (s.docId === docId ? s.pdf : null));
  const title = useReader((s) => (s.docId === docId ? s.title : ''));
  const pendingPage = useTabs((s) => (s.pendingPage?.docId === docId ? s.pendingPage : null));

  // warm the CJK font cache while the user reads, so 全文翻译 can lay out pages right away
  useEffect(() => {
    const run = () => void import('../pdfout/fonts').then((m) => m.prefetchCjkFont());
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(run, { timeout: 8000 });
      return () => cancelIdleCallback(id);
    }
    const t = setTimeout(run, 3000);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let freshTask: PDFLoadingTask | null = null;
    (async () => {
      const doc = await db.docs.get(docId);
      if (!doc) throw new Error('文献不存在或已被删除');
      let loaded = getWarmPdf(docId)?.pdf;
      if (!loaded) {
        const blob = await db.blobs.get(docId);
        if (!blob) throw new Error('这个条目还没有 PDF。请回到「我的文库」，在右侧详情面板中「获取 PDF」或「附加 PDF」。');
        const bytes = await blob.blob.arrayBuffer();
        if (cancelled) return;
        freshTask = openPdf(bytes);
        loaded = await freshTask.promise;
        if (cancelled) {
          void freshTask.destroy();
          return;
        }
        setWarmPdf(docId, freshTask, loaded);
      }
      const snap = getReaderSnapshot(docId);
      const jump = useTabs.getState().consumePendingPage(docId);
      const start = jump ? jump - 1 : (snap?.currentPage ?? doc.lastPage);
      const clamped = Math.max(0, Math.min(start, loaded.numPages - 1));
      useReader.getState().open(docId, doc.title, loaded, clamped, snap);
      useTabs.getState().updateTab(docId, { title: doc.title, page: clamped });
      if (useTabs.getState().active.kind === 'doc') document.title = `${doc.title} · PaperBridge`;
      await db.docs.update(docId, { lastOpenedAt: Date.now(), ...(doc.status === 'unread' ? { status: 'reading' as const } : {}) });
    })().catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));

    return () => {
      cancelled = true;
      const st = useReader.getState();
      // Preserve reading & translated page state when switching to another tab (if this tab is still open)
      if (st.docId === docId && useTabs.getState().tabs.some((t) => t.docId === docId)) {
        saveReaderSnapshot(docId, {
          currentPage: st.currentPage,
          scale: st.scale,
          viewMode: st.viewMode,
          sideTab: st.sideTab,
          sideOpen: st.sideOpen,
          pageStates: st.pageStates,
          paraStates: st.paraStates,
          transVersion: st.transVersion,
        });
        useTabs.getState().updateTab(docId, { page: st.currentPage });
      }
      stopFullText();
      if (st.docId === docId) st.close();
      if (freshTask && !getWarmPdf(docId)) void freshTask.destroy();
    };
  }, [docId]);

  // Handle jump-to-page requests when this Reader is already mounted (e.g. clicking a note from Library/Notes)
  useEffect(() => {
    if (!pendingPage || !pdf) return;
    const p = useTabs.getState().consumePendingPage(docId);
    if (p && p > 0) {
      useReader.getState().scrollTo(Math.max(0, Math.min(p - 1, pdf.numPages - 1)));
    }
  }, [pendingPage, pdf, docId]);

  // Keep window title synced when switching back to this tab
  useEffect(() => {
    if (active && title) document.title = `${title} · PaperBridge`;
  }, [active, title]);

  // Translation-affecting settings changed → stop the run and re-read the cache.
  useEffect(
    () =>
      useSettings.subscribe((s, prev) => {
        const cfg = s.providers.find((p) => p.id === s.translateProviderId);
        const prevCfg = prev.providers.find((p) => p.id === prev.translateProviderId);
        if (
          s.translateProviderId !== prev.translateProviderId ||
          s.sourceLang !== prev.sourceLang ||
          s.targetLang !== prev.targetLang ||
          s.prompts.translateSystem !== prev.prompts.translateSystem ||
          JSON.stringify(cfg) !== JSON.stringify(prevCfg)
        )
          invalidateTranslations();
      }),
    [],
  );

  // persist reading position
  const currentPage = useReader((s) => s.currentPage);
  useEffect(() => {
    if (!pdf) return;
    const t = setTimeout(() => void db.docs.update(docId, { lastPage: currentPage }), 600);
    return () => clearTimeout(t);
  }, [currentPage, pdf, docId]);

  if (error)
    return (
      <div className="library">
        <div className="error-box">{error}</div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => useTabs.getState().activateLibrary()}>
            返回我的文库
          </button>
          <button className="btn ghost" onClick={() => useTabs.getState().closeTab(docId)}>
            关闭此标签页
          </button>
        </div>
      </div>
    );

  return (
    <div className="reader">
      <Toolbar active={active} />
      <div className="reader-body">
        {pdf ? <PdfView /> : <div className="viewer" style={{ display: 'grid', placeItems: 'center' }}><span className="spinner" /></div>}
        <SidePanel />
      </div>
      {active && <SelectionToolbar />}
    </div>
  );
}

function Toolbar({ active }: { active: boolean }) {
  const title = useReader((s) => s.title);
  const pdf = useReader((s) => s.pdf);
  const scale = useReader((s) => s.scale);
  const setScale = useReader((s) => s.setScale);
  const page = useReader((s) => s.currentPage);
  const scrollTo = useReader((s) => s.scrollTo);
  const sideOpen = useReader((s) => s.sideOpen);
  const toggleSide = useReader((s) => s.toggleSide);
  const viewMode = useReader((s) => s.viewMode);
  const setViewMode = useReader((s) => s.setViewMode);
  const pagesDone = useReader((s) => Object.values(s.pageStates).filter((p) => p.status === 'done' || p.status === 'skipped').length);
  const running = useReader((s) => s.fullTextRunning);
  const [pageInput, setPageInput] = useState('');
  const [exporting, setExporting] = useState(false);
  const n = pdf?.numPages ?? 0;

  const go = (p: number) => scrollTo(Math.max(0, Math.min(n - 1, p)));

  const fitWidth = async () => {
    if (!pdf) return;
    const viewer = document.querySelector<HTMLElement>('.reader .viewer');
    if (!viewer) return;
    const first = await pdf.getPage(page + 1);
    const vp = first.getViewport({ scale: 1 });
    const cols = viewMode === 'dual' ? 2 : 1;
    const avail = viewer.clientWidth - 36 - (cols - 1) * 14;
    if (avail > 100) setScale(avail / (cols * vp.width));
  };

  // keyboard shortcuts (only while this reader tab is visible)
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const st = useReader.getState();
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        st.setScale(st.scale * 1.1);
      } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        st.setScale(st.scale / 1.1);
      } else if (e.key === 'Escape') {
        st.setSelection(null);
        window.getSelection()?.removeAllRanges();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  return (
    <div className="toolbar">
      <button className="icon-btn" title="返回我的文库 (Alt+1)" onClick={() => useTabs.getState().activateLibrary()}>
        <Icon name="back" size={16} />
      </button>
      <div className="doc-title" title={title}>
        {title}
      </div>
      <div className="spacer" />
      <button className="icon-btn hide-sm" title="上一页" onClick={() => go(page - 1)}>
        <Icon name="up" size={16} />
      </button>
      <input
        className="page-input"
        value={pageInput || String(page + 1)}
        onFocus={(e) => {
          setPageInput(String(page + 1));
          e.target.select();
        }}
        onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
        onBlur={() => setPageInput('')}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            go(Number(pageInput) - 1);
            (e.target as HTMLInputElement).blur();
          }
        }}
        aria-label="页码"
      />
      <span className="muted" style={{ fontSize: 12.5 }}>/ {n}</span>
      <button className="icon-btn hide-sm" title="下一页" onClick={() => go(page + 1)}>
        <Icon name="down" size={16} />
      </button>
      <div className="sep" />
      <button className="icon-btn" title="缩小 (Ctrl -)" onClick={() => setScale(scale / 1.1)}>
        <Icon name="minus" size={16} />
      </button>
      <button className="btn ghost sm hide-sm" title="重置缩放 (130%)" onClick={() => setScale(1.3)} style={{ minWidth: 48 }}>
        {Math.round(scale * 100)}%
      </button>
      <button className="icon-btn" title="放大 (Ctrl +)" onClick={() => setScale(scale * 1.1)}>
        <Icon name="plus" size={16} />
      </button>
      <button className="icon-btn hide-sm" title="适应页面宽度" onClick={() => void fitWidth()}>
        <Icon name="fit" size={15} />
      </button>
      <div className="sep" />
      <button
        className={`btn sm${running ? '' : ' primary'}`}
        title="翻译全文：保留原排版生成译文页面（从当前页开始），并排显示在原文旁边"
        onClick={() => {
          if (running) return stopFullText();
          if (viewMode === 'original') setViewMode(window.innerWidth < 760 ? 'translated' : 'dual');
          void runFullText();
        }}
      >
        <Icon name={running ? 'stop' : 'translate'} size={14} />
        <span className="hide-sm">{running ? `停止 ${pagesDone}/${n} 页` : '全文翻译'}</span>
      </button>
      <div className="view-switch" role="group" aria-label="显示方式">
        {(
          [
            ['original', '原文', '只看原文'],
            ['dual', '双栏', '原文与译文左右对照（保留排版）'],
            ['translated', '译文', '只看译文（保留排版）'],
          ] as const
        ).map(([m, label, tip]) => (
          <button key={m} className={viewMode === m ? 'active' : ''} title={tip} onClick={() => setViewMode(m)}>
            {label}
          </button>
        ))}
      </div>
      <button className="icon-btn" title="导出译文 PDF（保留原排版）" disabled={!pdf} onClick={() => setExporting(true)}>
        <Icon name="download" size={16} />
      </button>
      {exporting && <PdfExportDialog onClose={() => setExporting(false)} />}
      <button className={`icon-btn${sideOpen ? ' active' : ''}`} title="右侧工具栏" onClick={toggleSide}>
        <Icon name="sidebar" size={16} />
      </button>
    </div>
  );
}

const COLORS: HighlightColor[] = ['yellow', 'green', 'blue', 'pink', 'purple'];

function SelectionToolbar() {
  const sel = useReader((s) => s.selection);
  const docId = useReader((s) => s.docId);
  const startJob = useReader((s) => s.startJob);
  const setSelection = useReader((s) => s.setSelection);
  const handoffTo = useReader((s) => s.handoffTo);
  const action = useSettings((s) => s.selectionAction);
  const ref = useRef<HTMLDivElement>(null);
  if (!sel || !docId || action === 'none') return null;

  const done = () => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  const highlight = async (color: HighlightColor) => {
    await db.notes.add({
      id: uid(),
      docId,
      pageIndex: sel.pageIndex,
      rects: sel.rects,
      quote: sel.text,
      color,
      comment: '',
      createdAt: Date.now(),
    });
    done();
  };

  const top = Math.max(88, sel.anchor.y);
  return (
    <div
      ref={ref}
      className="sel-toolbar"
      style={{ left: Math.min(Math.max(sel.anchor.x, 160), window.innerWidth - 160), top }}
      onMouseDown={(e) => e.preventDefault()}
      onMouseUp={(e) => e.stopPropagation()}
    >
      <button className="btn" onClick={() => (startJob(sel.text, 'translate', sel.pageIndex), done())}>
        <Icon name="translate" size={15} /> 翻译
      </button>
      <button className="btn" onClick={() => (startJob(sel.text, 'explain', sel.pageIndex), done())}>
        <Icon name="sparkle" size={15} /> 解释
      </button>
      <div className="sep" style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 4px' }} />
      {sel.multiPage ? (
        <span className="hint" style={{ padding: '0 4px' }} title="跨页选区无法高亮，请分页选择">
          跨页无法高亮
        </span>
      ) : (
        COLORS.map((c) => <button key={c} className={`swatch ${c}`} title="高亮" onClick={() => void highlight(c)} />)
      )}
      <div className="sep" style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 4px' }} />
      <button
        className="btn"
        title="加入术语表"
        onClick={() => {
          handoffTo('glossary', sel.text);
          done();
        }}
      >
        术语
      </button>
      <button
        className="btn"
        title="就此提问"
        onClick={() => {
          handoffTo('chat', sel.text);
          done();
        }}
      >
        提问
      </button>
      <button
        className="icon-btn"
        title="复制"
        onClick={() => {
          void navigator.clipboard.writeText(sel.text);
          done();
        }}
      >
        <Icon name="copy" size={15} />
      </button>
    </div>
  );
}

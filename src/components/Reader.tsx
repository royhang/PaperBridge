import { useEffect, useRef, useState } from 'react';
import { db, uid, type HighlightColor } from '../db/db';
import { inkStrokeLayer } from '../lib/ink';
import { openPdf, type PDFLoadingTask } from '../pdf/loader';
import { invalidateTranslations, runFullText, stopFullText } from '../services/fulltext';
import { ensurePdfBlobDownloaded } from '../services/sync';
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
      if (!doc || doc.deletedAt) {
        useTabs.getState().closeTab(docId);
        return;
      }
      let loaded = getWarmPdf(docId)?.pdf;
      if (!loaded) {
        let blob = await db.blobs.get(docId);
        if (!blob && doc.hasPdf && doc.hash) {
          await ensurePdfBlobDownloaded(docId);
          if (cancelled) return;
          blob = await db.blobs.get(docId);
        }
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

  // persist reading position (debounced so fast scrolling doesn't trigger extra syncs)
  const currentPage = useReader((s) => s.currentPage);
  useEffect(() => {
    if (!pdf) return;
    const t = setTimeout(() => void db.docs.update(docId, { lastPage: currentPage }), 2000);
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
      <InkToolbar docId={docId} />
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
  const inkTool = useReader((s) => s.inkTool);
  const setInkTool = useReader((s) => s.setInkTool);
  const focusMode = useReader((s) => s.focusMode);
  const toggleFocusMode = useReader((s) => s.toggleFocusMode);
  const pdfTheme = useSettings((s) => s.pdfTheme);
  const setSettings = useSettings((s) => s.set);
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
        if (st.focusMode) {
          st.setFocusMode(false);
          if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        }
        st.setSelection(null);
        st.setPinnedSelection(null);
        window.getSelection()?.removeAllRanges();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  return (
    <div className="toolbar">
      <button
        className="icon-btn"
        title="返回我的文库 (Alt+1)"
        onClick={() => {
          useReader.getState().setFocusMode(false);
          if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
          useTabs.getState().activateLibrary();
        }}
      >
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
      <button className="icon-btn hide-phone" title="缩小 (Ctrl -)" onClick={() => setScale(scale / 1.1)}>
        <Icon name="minus" size={16} />
      </button>
      <button className="btn ghost sm hide-sm" title="重置缩放 (130%)" onClick={() => setScale(1.3)} style={{ minWidth: 48 }}>
        {Math.round(scale * 100)}%
      </button>
      <button className="icon-btn hide-phone" title="放大 (Ctrl +)" onClick={() => setScale(scale * 1.1)}>
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
      <button
        className={`icon-btn${inkTool !== 'none' ? ' active' : ''}`}
        title="手写批注（支持 Apple Pencil / 三星 S-Pen / 华为 M-Pencil / 小米笔压感与防误触）"
        onClick={() => setInkTool(inkTool === 'none' ? 'pen' : 'none')}
      >
        <Icon name="edit" size={16} />
      </button>
      <button
        className={`icon-btn${pdfTheme !== 'original' ? ' active' : ''}`}
        title={
          pdfTheme === 'auto'
            ? 'PDF 纸色：自动护眼（深色模式暗夜纸张，点击切换为柔光暖纸）'
            : pdfTheme === 'dim'
              ? 'PDF 纸色：柔光暖纸（不反色保留照片原色，点击切换为深色反色）'
              : pdfTheme === 'dark'
                ? 'PDF 纸色：暗夜反色（点击切换为原始白底）'
                : 'PDF 纸色：原始白底（点击恢复自动护眼）'
        }
        onClick={() => {
          const order = ['auto', 'dim', 'dark', 'original'] as const;
          const next = order[(order.indexOf(pdfTheme) + 1) % order.length];
          setSettings({ pdfTheme: next });
        }}
      >
        <Icon name={pdfTheme === 'original' ? 'sun' : 'moon'} size={15} />
      </button>
      <button
        className={`icon-btn${focusMode ? ' active' : ''}`}
        title={focusMode ? '退出沉浸阅读 (Esc)' : '沉浸阅读（隐藏顶部标签栏并最大化视野）'}
        onClick={() => {
          const next = !focusMode;
          toggleFocusMode();
          if (next) {
            if (document.documentElement.requestFullscreen) {
              void document.documentElement.requestFullscreen().catch(() => {});
            }
          } else if (document.fullscreenElement) {
            void document.exitFullscreen().catch(() => {});
          }
        }}
      >
        <Icon name={focusMode ? 'minimize' : 'maximize'} size={15} />
      </button>
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

const PEN_COLORS = [
  { hex: '#e11d48', label: '红笔' },
  { hex: '#2563eb', label: '蓝笔' },
  { hex: '#111827', label: '黑笔' },
  { hex: '#16a34a', label: '绿笔' },
  { hex: '#9333ea', label: '紫笔' },
];

const HL_COLORS = [
  { hex: '#facc15', label: '黄荧光' },
  { hex: '#4ade80', label: '绿荧光' },
  { hex: '#60a5fa', label: '蓝荧光' },
  { hex: '#f472b6', label: '粉荧光' },
];

const PEN_WIDTHS = [
  { v: 1.5, label: '细' },
  { v: 2.2, label: '中' },
  { v: 3.6, label: '粗' },
];

function InkToolbar({ docId }: { docId: string }) {
  const inkTool = useReader((s) => s.inkTool);
  const setInkTool = useReader((s) => s.setInkTool);
  const penColor = useReader((s) => s.penColor);
  const setPenColor = useReader((s) => s.setPenColor);
  const hlColor = useReader((s) => s.hlColor);
  const setHlColor = useReader((s) => s.setHlColor);
  const penWidth = useReader((s) => s.penWidth);
  const setPenWidth = useReader((s) => s.setPenWidth);
  const pencilOnly = useReader((s) => s.pencilOnly);
  const setPencilOnly = useReader((s) => s.setPencilOnly);
  const currentPage = useReader((s) => s.currentPage);
  const viewMode = useReader((s) => s.viewMode);

  if (inkTool === 'none') return null;

  const pageInksForView = async () => {
    const rows = await db.inks.where('[docId+pageIndex]').equals([docId, currentPage]).sortBy('createdAt');
    if (viewMode === 'original') return rows.filter((r) => inkStrokeLayer(r) === 'original');
    if (viewMode === 'translated') return rows.filter((r) => inkStrokeLayer(r) === 'translated');
    return rows;
  };

  const undoLast = async () => {
    const rows = await pageInksForView();
    const last = rows[rows.length - 1];
    if (last) await db.inks.delete(last.id);
  };

  const clearPage = async () => {
    const rows = await pageInksForView();
    if (!rows.length) return;
    const scope = viewMode === 'original' ? '原文' : viewMode === 'translated' ? '译文' : '（原文与译文）';
    if (!confirm(`清空第 ${currentPage + 1} 页${scope}的全部 ${rows.length} 条手写笔迹？`)) return;
    await db.inks.bulkDelete(rows.map((r) => r.id));
  };

  const palette = inkTool === 'highlighter' ? HL_COLORS : PEN_COLORS;
  const activeColor = inkTool === 'highlighter' ? hlColor : penColor;
  const pickColor = inkTool === 'highlighter' ? setHlColor : setPenColor;

  return (
    <div className="ink-bar" role="toolbar" aria-label="手写批注工具栏">
      <div className="filter-group">
        <button className={`filter-pill${inkTool === 'pen' ? ' active' : ''}`} onClick={() => setInkTool('pen')}>
          <Icon name="edit" size={13} /> 钢笔
        </button>
        <button className={`filter-pill${inkTool === 'highlighter' ? ' active' : ''}`} onClick={() => setInkTool('highlighter')}>
          <Icon name="highlight" size={13} /> 荧光笔
        </button>
        <button className={`filter-pill${inkTool === 'eraser' ? ' active' : ''}`} onClick={() => setInkTool('eraser')}>
          <Icon name="eraser" size={13} /> 橡皮
        </button>
      </div>

      {inkTool !== 'eraser' && (
        <>
          <span className="filter-sep" />
          <div className="row" style={{ gap: 5 }}>
            {palette.map((c) => (
              <button
                key={c.hex}
                className={`ink-dot${activeColor === c.hex ? ' active' : ''}`}
                style={{ background: c.hex }}
                title={c.label}
                onClick={() => pickColor(c.hex)}
              />
            ))}
          </div>
        </>
      )}

      {inkTool === 'pen' && (
        <>
          <span className="filter-sep" />
          <div className="filter-group">
            {PEN_WIDTHS.map((w) => (
              <button key={w.v} className={`filter-pill${penWidth === w.v ? ' active' : ''}`} onClick={() => setPenWidth(w.v)}>
                {w.label}
              </button>
            ))}
          </div>
        </>
      )}

      <span className="filter-sep" />
      <button
        className={`filter-pill${pencilOnly ? ' active' : ''}`}
        title="开启后仅手写笔（Apple Pencil / S-Pen / M-Pencil / 小米笔）落笔书写，手掌和手指可自由翻页缩放（防误触）"
        onClick={() => setPencilOnly(!pencilOnly)}
      >
        {pencilOnly ? '✓ 仅手写笔（防误触）' : '手指/鼠标可写'}
      </button>

      <div className="spacer" />
      <button className="btn ghost sm" title="撤销当前页最后一笔" onClick={() => void undoLast()}>
        <Icon name="undo" size={13} /> 撤销
      </button>
      <button className="btn ghost sm" title="清空当前页手写笔迹" onClick={() => void clearPage()}>
        清空本页
      </button>
      <button className="icon-btn sm-ico" title="退出手写模式（恢复划词翻译）" onClick={() => setInkTool('none')}>
        <Icon name="close" size={14} />
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
      ...(sel.layer === 'translated' ? { layer: 'translated' as const } : {}),
      rects: sel.rects,
      quote: sel.text,
      color,
      comment: '',
      createdAt: Date.now(),
    });
    done();
  };

  // On touch (iPadOS / Android), place the toolbar BELOW the selection so it never collides with the native Copy/Search bar above.
  const isTouch = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
  const placeBelow = isTouch && sel.anchor.bottom !== undefined && sel.anchor.bottom < window.innerHeight - 96;
  const top = placeBelow ? sel.anchor.bottom! + 12 : Math.max(88, sel.anchor.y);
  const left = window.innerWidth < 460 ? window.innerWidth / 2 : Math.min(Math.max(sel.anchor.x, 168), window.innerWidth - 168);
  return (
    <div
      ref={ref}
      className={`sel-toolbar${placeBelow ? ' below' : ''}`}
      style={{ left, top }}
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => e.preventDefault()}
      onTouchStart={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
    >
      <button className="btn" onClick={() => (startJob(sel.text, 'translate', sel.pageIndex, sel.rects, sel.layer), done())}>
        <Icon name="translate" size={15} /> 翻译
      </button>
      <button className="btn" onClick={() => (startJob(sel.text, 'explain', sel.pageIndex, sel.rects, sel.layer), done())}>
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
          handoffTo('glossary', sel.text, { pageIndex: sel.pageIndex, rects: sel.rects, layer: sel.layer });
          done();
        }}
      >
        术语
      </button>
      <button
        className="btn"
        title="就此提问"
        onClick={() => {
          handoffTo('chat', sel.text, { pageIndex: sel.pageIndex, rects: sel.rects, layer: sel.layer });
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

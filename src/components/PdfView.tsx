import { useLiveQuery } from 'dexie-react-hooks';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { db, type NoteRecord, type NRect } from '../db/db';
import { openPdf, pdfjs, sharedWorker, type PDFDocumentProxy } from '../pdf/loader';
import { hydratePageFromCache, pageParagraphs, runFullText } from '../services/fulltext';
import type { Paragraph } from '../pdf/types';
import { useReader } from '../store/reader';
import { useSettings } from '../store/settings';
import { cleanSelectedText } from '../lib/text';

interface Size {
  w: number;
  h: number;
}

const PAGE_GAP = 14;


export function PdfView() {
  const pdf = useReader((s) => s.pdf)!;
  const docId = useReader((s) => s.docId)!;
  const scale = useReader((s) => s.scale);
  const setScale = useReader((s) => s.setScale);
  const setCurrentPage = useReader((s) => s.setCurrentPage);
  const setSelection = useReader((s) => s.setSelection);
  const scrollTarget = useReader((s) => s.scrollTarget);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  /** one row per page (original and/or translation) — used for scrolling and page tracking */
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const viewMode = useReader((s) => s.viewMode);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [sizesReady, setSizesReady] = useState(false);

  // Page sizes at scale 1 (needed up front for layout / scroll positions).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const first = await pdf.getPage(1);
      const vp = first.getViewport({ scale: 1 });
      const guess = Array.from({ length: pdf.numPages }, () => ({ w: vp.width, h: vp.height }));
      if (!cancelled) setSizes(guess);
      const all = await Promise.all(
        Array.from({ length: pdf.numPages }, async (_, i) => {
          const p = await pdf.getPage(i + 1);
          const v = p.getViewport({ scale: 1 });
          return { w: v.width, h: v.height };
        }),
      );
      if (!cancelled) {
        setSizes(all);
        setSizesReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf]);

  const notes = useLiveQuery(() => db.notes.where('docId').equals(docId).toArray(), [docId]);

  // ---- current page tracking
  const onScroll = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    const probe = c.scrollTop + c.clientHeight * 0.35;
    const refs = rowRefs.current;
    let lo = 0;
    let hi = refs.length - 1;
    // binary search on offsetTop (pages are laid out vertically in order)
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const el = refs[mid];
      if (el && el.offsetTop <= probe) lo = mid;
      else hi = mid - 1;
    }
    if (useReader.getState().currentPage !== lo) setCurrentPage(lo);
  }, [setCurrentPage]);

  // ---- keep the reading position stable when zooming
  const anchorRef = useRef<{ page: number; frac: number } | null>(null);
  // Capture the anchor synchronously when the scale changes (before React re-renders).
  useEffect(
    () =>
      useReader.subscribe((st, prev) => {
        if (st.scale === prev.scale) return;
        const c = containerRef.current;
        const el = rowRefs.current[st.currentPage];
        if (c && el) anchorRef.current = { page: st.currentPage, frac: (c.scrollTop - el.offsetTop) / el.offsetHeight };
      }),
    [],
  );
  useLayoutEffect(() => {
    const a = anchorRef.current;
    const c = containerRef.current;
    const el = a && rowRefs.current[a.page];
    if (a && c && el) c.scrollTop = el.offsetTop + a.frac * el.offsetHeight;
    anchorRef.current = null;
  }, [scale]);

  // ---- programmatic scroll
  useEffect(() => {
    if (!scrollTarget || !sizesReady) return;
    const c = containerRef.current;
    const el = rowRefs.current[scrollTarget.pageIndex];
    if (!c || !el) return;
    const y = scrollTarget.y !== undefined ? scrollTarget.y * scale - c.clientHeight * 0.25 : -PAGE_GAP;
    c.scrollTo({ top: el.offsetTop + Math.max(y, -PAGE_GAP), behavior: 'smooth' });
  }, [scrollTarget, sizesReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- fit the width when the view mode changes (two pages side by side need a smaller scale)
  const fitted = useRef('');
  useEffect(() => {
    const c = containerRef.current;
    const key = `${docId}:${viewMode}`;
    if (!c || !sizesReady || fitted.current === key) return;
    const first = !fitted.current.startsWith(`${docId}:`);
    fitted.current = key;
    if (first && viewMode === 'original') return; // keep the user's zoom on open
    const maxW = Math.max(...sizes.map((s) => s.w));
    const cols = viewMode === 'dual' ? 2 : 1;
    const fit = (c.clientWidth - 32 - (cols - 1) * PAGE_GAP - 16) / (cols * maxW);
    setScale(cols === 2 ? fit : Math.min(1.3, fit));
  }, [viewMode, sizesReady, sizes, docId, setScale]);

  // ---- ctrl + wheel zoom
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const s = useReader.getState().scale;
      setScale(s * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, [setScale]);

  // ---- text selection → floating toolbar
  const onMouseUp = useCallback(() => {
    // wait a tick so the selection is final (double/triple click)
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setSelection(null);
        return;
      }
      const text = cleanSelectedText(sel.toString());
      if (!text) {
        setSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const clientRects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
      // Assign rects to the page that contains their centre; keep the page with the most rects.
      const byPage = new Map<number, NRect[]>();
      for (const r of clientRects) {
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        pageRefs.current.forEach((el, i) => {
          if (!el) return;
          const b = el.getBoundingClientRect();
          if (cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom) {
            const arr = byPage.get(i) ?? [];
            arr.push({ x: (r.left - b.left) / b.width, y: (r.top - b.top) / b.height, w: r.width / b.width, h: r.height / b.height });
            byPage.set(i, arr);
          }
        });
      }
      if (!byPage.size) {
        setSelection(null);
        return;
      }
      const [pageIndex, rects] = [...byPage.entries()].sort((a, b) => b[1].length - a[1].length)[0];
      const box = range.getBoundingClientRect();
      setSelection({
        text,
        pageIndex,
        rects: mergeRects(rects),
        multiPage: byPage.size > 1,
        anchor: { x: box.left + box.width / 2, y: box.top },
      });
      if (useSettings.getState().selectionAction === 'auto-translate') {
        useReader.getState().startJob(text, 'translate', pageIndex);
      }
    }, 10);
  }, [setSelection]);

  return (
    <div
      className="viewer"
      ref={containerRef}
      onScroll={() => {
        onScroll();
        if (useReader.getState().selection) setSelection(null);
      }}
      onMouseDown={(e) => {
        (e.target as HTMLElement).closest('.textLayer')?.classList.add('selecting');
      }}
      onMouseUp={() => {
        containerRef.current?.querySelectorAll('.textLayer.selecting').forEach((el) => el.classList.remove('selecting'));
        onMouseUp();
      }}
    >
      <div className="pages">
        {sizes.map((sz, i) => (
          <div
            key={i}
            className="page-row"
            ref={(el) => {
              rowRefs.current[i] = el;
            }}
          >
            {viewMode !== 'translated' && (
              <PageView
                ref={(el) => {
                  pageRefs.current[i] = el;
                }}
                index={i}
                size={sz}
                scale={scale}
                pdf={pdf}
                docId={docId}
                container={containerRef}
                notes={notes?.filter((n) => n.pageIndex === i)}
              />
            )}
            {viewMode !== 'original' && <TransPageView index={i} size={sz} scale={scale} pdf={pdf} container={containerRef} />}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Merge rects on the same line that touch/overlap (text layer produces one per span). */
function mergeRects(rects: NRect[]): NRect[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: NRect[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - r.y) < last.h * 0.5 && r.x <= last.x + last.w + 0.01) {
      const x2 = Math.max(last.x + last.w, r.x + r.w);
      const y2 = Math.max(last.y + last.h, r.y + r.h);
      last.x = Math.min(last.x, r.x);
      last.y = Math.min(last.y, r.y);
      last.w = x2 - last.x;
      last.h = y2 - last.y;
    } else out.push({ ...r });
  }
  return out;
}

interface PageProps {
  index: number;
  size: Size;
  scale: number;
  pdf: PDFDocumentProxy;
  docId: string;
  container: React.RefObject<HTMLDivElement | null>;
  notes?: NoteRecord[];
  ref?: React.Ref<HTMLDivElement>;
}

const PageView = memo(function PageView({ index, size, scale, pdf, docId, container, notes, ref }: PageProps) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const canvasHolder = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);
  const w = Math.floor(size.w * scale);
  const h = Math.floor(size.h * scale);

  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), {
      root: container.current,
      rootMargin: '1200px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [container]);

  useEffect(() => {
    if (!visible) {
      const old = canvasHolder.current?.querySelector('canvas');
      if (old) old.width = old.height = 0; // release the backing store right away
      canvasHolder.current?.replaceChildren();
      textRef.current?.replaceChildren();
      setRendered(false);
      // let pdf.js drop operator lists / page-local objects for evicted pages
      pdf.getPage(index + 1).then((pg) => pg.cleanup()).catch(() => {});
      return;
    }
    let cancelled = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null;
    let textLayer: InstanceType<typeof pdfjs.TextLayer> | null = null;
    (async () => {
      const page = await pdf.getPage(index + 1);
      if (cancelled) return;
      const vp = page.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const canvas = document.createElement('canvas');
      canvas.className = 'page-canvas';
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      renderTask = page.render({
        canvas,
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      try {
        await renderTask.promise;
      } catch (e) {
        if ((e as Error)?.name === 'RenderingCancelledException') return;
        throw e;
      }
      if (cancelled) return;
      canvasHolder.current?.replaceChildren(canvas); // swap only when ready → no flash on zoom
      setRendered(true);

      const tl = textRef.current;
      if (!tl) return;
      const fresh = document.createElement('div');
      fresh.className = 'textLayer';
      textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: fresh, viewport: vp });
      await textLayer.render();
      if (cancelled) return;
      const end = document.createElement('div');
      end.className = 'endOfContent';
      fresh.append(end);
      // keep pdf.js' element (it carries data-main-rotation + sizing styles)
      tl.replaceChildren(fresh);
    })().catch((e) => !cancelled && console.error('render page', index, e));
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [visible, scale, pdf, index]);

  const setRefs = (el: HTMLDivElement | null) => {
    holderRef.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) (ref as React.RefObject<HTMLDivElement | null>).current = el;
  };

  return (
    <div
      ref={setRefs}
      className="page"
      data-page={index}
      style={
        {
          width: w,
          height: h,
          '--total-scale-factor': scale,
          '--scale-factor': scale,
          '--scale-round-x': '1px',
          '--scale-round-y': '1px',
        } as React.CSSProperties
      }
    >
      <div ref={canvasHolder} />
      {!rendered && <div className="page-loading">{index + 1}</div>}
      {notes && notes.length > 0 && (
        <div className="hl-layer">
          {notes.flatMap((n) =>
            n.rects.map((r, j) => (
              <div
                key={`${n.id}-${j}`}
                className={`hl ${n.color}`}
                style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
              />
            )),
          )}
        </div>
      )}
      <div ref={textRef} />
      {visible && <ParagraphLayer pdf={pdf} docId={docId} index={index} scale={scale} />}
    </div>
  );
});

/** Focus outline for the paragraph hovered in the panel. */
function ParagraphLayer({ pdf, docId, index, scale }: { pdf: PDFDocumentProxy; docId: string; index: number; scale: number }) {
  const focus = useReader((s) => (s.focusParagraph?.pageIndex === index ? s.focusParagraph.id : null));
  const [paras, setParas] = useState<Paragraph[] | null>(null);

  useEffect(() => {
    if (!focus || paras) return;
    let off = false;
    pageParagraphs(index).then(
      (p) => !off && setParas(p),
      (e) => console.error('paragraphs', index, e),
    );
    return () => {
      off = true;
    };
  }, [focus, paras, pdf, docId, index]);

  const focused = focus && paras ? paras.find((p) => p.id === focus) : undefined;
  if (!focused) return null;
  return (
    <div className="para-layer">
      <div
        className="para-box"
        style={{
          left: focused.bbox.x * scale - 3,
          top: focused.bbox.y * scale - 3,
          width: focused.bbox.w * scale + 6,
          height: focused.bbox.h * scale + 6,
        }}
      />
    </div>
  );
}

type PageProxy = Awaited<ReturnType<PDFDocumentProxy['getPage']>>;

/** Render a pdf.js page (canvas + selectable text layer) into the given holders. Returns a canceller. */
function drawPage(page: PageProxy, scale: number, canvasHolder: HTMLElement, textHolder: HTMLElement | null, onDone: () => void): () => void {
  let cancelled = false;
  const vp = page.getViewport({ scale });
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const canvas = document.createElement('canvas');
  canvas.className = 'page-canvas';
  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  const task = page.render({ canvas, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
  let textLayer: InstanceType<typeof pdfjs.TextLayer> | null = null;
  (async () => {
    try {
      await task.promise;
    } catch (e) {
      if ((e as Error)?.name === 'RenderingCancelledException') return;
      throw e;
    }
    if (cancelled) return;
    canvasHolder.replaceChildren(canvas);
    onDone();
    if (!textHolder) return;
    const fresh = document.createElement('div');
    fresh.className = 'textLayer';
    textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: fresh, viewport: vp });
    await textLayer.render();
    if (!cancelled) textHolder.replaceChildren(fresh);
  })().catch((e) => !cancelled && console.error('draw page', e));
  return () => {
    cancelled = true;
    task.cancel();
    textLayer?.cancel();
  };
}

/** The translated counterpart of a page (双栏 / 译文 views). */
const TransPageView = memo(function TransPageView({
  index,
  size,
  scale,
  pdf,
  container,
}: {
  index: number;
  size: Size;
  scale: number;
  pdf: PDFDocumentProxy;
  container: React.RefObject<HTMLDivElement | null>;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasHolder = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);
  const st = useReader((s) => s.pageStates[index]);
  const running = useReader((s) => s.fullTextRunning);
  const transVersion = useReader((s) => s.transVersion);
  const hydrated = useRef(-1);
  const w = Math.floor(size.w * scale);
  const h = Math.floor(size.h * scale);
  const showOriginal = st?.status === 'skipped';
  const bytes = st?.status === 'done' ? st.bytes : undefined;

  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { root: container.current, rootMargin: '1200px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [container]);

  // show cached translations without any API call
  useEffect(() => {
    if (!visible || st || hydrated.current === transVersion) return;
    hydrated.current = transVersion;
    void hydratePageFromCache(index).catch((e) => console.error('hydrate page', index, e));
  }, [visible, st, transVersion, index]);

  useEffect(() => {
    const holder = canvasHolder.current;
    if (!visible || !holder || (!bytes && !showOriginal)) {
      const old = holder?.querySelector('canvas');
      if (old) old.width = old.height = 0;
      holder?.replaceChildren();
      textRef.current?.replaceChildren();
      setRendered(false);
      return;
    }
    let cancel: (() => void) | null = null;
    let off = false;
    const task = bytes ? openPdf(bytes.slice(), sharedWorker()) : null;
    (async () => {
      const page = task ? await (await task.promise).getPage(1) : await pdf.getPage(index + 1);
      if (off) return;
      cancel = drawPage(page, scale, holder, textRef.current, () => !off && setRendered(true));
    })().catch((e) => !off && console.error('translated page', index, e));
    return () => {
      off = true;
      cancel?.();
      void task?.destroy();
    };
  }, [visible, bytes, showOriginal, scale, pdf, index]);

  let status: React.ReactNode = null;
  if (!st) status = running ? '排队中…' : '尚未翻译 · 点击上方「全文翻译」';
  else if (st.status === 'queued') status = `排队中 · 已译 ${st.done ?? 0}/${st.total ?? '?'} 段`;
  else if (st.status === 'running') status = st.msg ?? `翻译中 · ${st.done ?? 0}/${st.total ?? '?'} 段`;
  else if (st.status === 'error')
    status = (
      <>
        <span className="trans-error">{st.msg ?? '翻译失败'}</span>
        {!running && (
          <button className="btn sm" onClick={() => void runFullText({ from: index, to: index })}>
            重试本页
          </button>
        )}
      </>
    );

  return (
    <div
      ref={holderRef}
      className="page trans"
      data-trans-page={index}
      style={
        {
          width: w,
          height: h,
          '--total-scale-factor': scale,
          '--scale-factor': scale,
          '--scale-round-x': '1px',
          '--scale-round-y': '1px',
        } as React.CSSProperties
      }
    >
      <div ref={canvasHolder} />
      <div ref={textRef} />
      {(bytes || showOriginal) && !rendered && <div className="page-loading">{index + 1}</div>}
      {!bytes && !showOriginal && (
        <div className="trans-status">
          {(st?.status === 'running' || st?.status === 'queued' || (!st && running)) && <span className="spinner" />}
          {status}
        </div>
      )}
      {showOriginal && st?.msg && <div className="trans-badge">{st.msg}，显示原文</div>}
    </div>
  );
});

import { useEffect, useRef, useState } from 'react';
import { isTranslatable } from '../../pdf/paragraphs';
import type { Paragraph } from '../../pdf/types';
import { exportBilingual } from '../../services/export';
import { hydratePageFromCache, retryParagraph, runFullText, stopFullText } from '../../services/fulltext';
import { useReader } from '../../store/reader';
import { Icon } from '../Icon';
import { LangBar } from './TranslatePanel';

export function ParallelPanel() {
  const pdf = useReader((s) => s.pdf);
  const docId = useReader((s) => s.docId);
  const title = useReader((s) => s.title);
  const currentPage = useReader((s) => s.currentPage);
  const running = useReader((s) => s.fullTextRunning);
  const paraStates = useReader((s) => s.paraStates);
  const [follow, setFollow] = useState(true);
  const [exporting, setExporting] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const n = pdf?.numPages ?? 0;

  const states = Object.values(paraStates);
  const done = states.filter((s) => s.status === 'done').length;
  const errors = states.filter((s) => s.status === 'error').length;
  const total = states.length;

  // follow the PDF: scroll the list to the current page section
  useEffect(() => {
    if (!follow) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-page-section="${currentPage}"]`);
    const list = listRef.current;
    if (el && list) list.scrollTo({ top: el.offsetTop - list.offsetTop - 4 });
  }, [currentPage, follow]);

  if (!pdf || !docId) return null;

  return (
    <div className="panel-col">
      <LangBar />
      <div className="panel-head">
        <button
          className={`btn sm${running ? '' : ' primary'}`}
          onClick={() => (running ? stopFullText() : void runFullText())}
        >
          <Icon name={running ? 'stop' : 'play'} size={14} />
          {running ? '停止' : done && done < total ? '继续翻译' : '翻译全文'}
        </button>
        <button className="btn sm" disabled={running} onClick={() => void runFullText({ from: currentPage, to: currentPage })}>
          仅本页
        </button>
        {total > 0 && (
          <>
            <div className="progress" title={`${done}/${total}`}>
              <div style={{ width: `${(done / Math.max(1, total)) * 100}%` }} />
            </div>
            <span className="hint">
              {done}/{total}
              {errors ? ` · ${errors} 失败` : ''}
            </span>
          </>
        )}
        <div className="spacer" />
        <label className="row hint" style={{ cursor: 'pointer' }} title="随 PDF 滚动">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> 跟随
        </label>
        <select
          className="select"
          style={{ width: 'auto', minHeight: 26, padding: '0 4px', fontSize: 12 }}
          value=""
          disabled={exporting}
          onChange={async (e) => {
            const mode = e.target.value as 'bilingual' | 'translation';
            if (!mode) return;
            setExporting(true);
            try {
              const missing = await exportBilingual(pdf, docId, title, mode);
              if (missing) alert(`已导出。还有 ${missing} 段尚未翻译，导出中保留了原文。`);
            } finally {
              setExporting(false);
            }
          }}
          title="导出 Markdown"
        >
          <option value="">{exporting ? '导出中…' : '导出'}</option>
          <option value="bilingual">双语对照 .md</option>
          <option value="translation">仅译文 .md</option>
        </select>
      </div>
      <div className="panel" ref={listRef}>
        {Array.from({ length: n }, (_, i) => (
          <PageSection key={i} pageIndex={i} root={listRef} />
        ))}
      </div>
    </div>
  );
}

function PageSection({ pageIndex, root }: { pageIndex: number; root: React.RefObject<HTMLDivElement | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<{ v: number; paras: Paragraph[]; error?: string } | null>(null);
  const [visible, setVisible] = useState(false);
  const transVersion = useReader((s) => s.transVersion);
  const paras = loaded?.paras ?? null;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), {
      root: root.current,
      rootMargin: '600px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (!visible || loaded?.v === transVersion) return;
    let off = false;
    hydratePageFromCache(pageIndex).then(
      (p) => !off && setLoaded({ v: transVersion, paras: p }),
      (e) => !off && setLoaded({ v: transVersion, paras: [], error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      off = true;
    };
  }, [visible, loaded, pageIndex, transVersion]);

  return (
    <div ref={ref} data-page-section={pageIndex} style={{ minHeight: paras ? undefined : 120 }}>
      <div className="page-divider">第 {pageIndex + 1} 页</div>
      {paras === null && visible && <span className="spinner" />}
      {loaded?.error && <div className="error-box">本页文字解析失败：{loaded.error}</div>}
      {paras?.length === 0 && !loaded?.error && <div className="hint">（本页没有可翻译的文字，可能是扫描件或图片页）</div>}
      {paras?.filter(isTranslatable).map((p) => <ParaItem key={p.id} p={p} />)}
    </div>
  );
}

function ParaItem({ p }: { p: Paragraph }) {
  const st = useReader((s) => s.paraStates[p.id]);
  const focused = useReader((s) => s.focusParagraph?.id === p.id);
  const setFocus = useReader((s) => s.setFocusParagraph);
  const scrollTo = useReader((s) => s.scrollTo);
  return (
    <div
      className={`para-item${focused ? ' focus' : ''}${p.kind === 'heading' ? ' heading' : ''}`}
      onMouseEnter={() => setFocus({ id: p.id, pageIndex: p.pageIndex })}
      onMouseLeave={() => setFocus(null)}
      onClick={() => scrollTo(p.pageIndex, p.bbox.y)}
    >
      <div className="src">{p.text}</div>
      {st?.status === 'done' && <div className="dst">{st.translation}</div>}
      {(st?.status === 'running' || st?.status === 'pending') && (
        <div className="status">
          {st.status === 'running' ? <span className="spinner" /> : null}
          {st.status === 'running' ? '翻译中…' : '排队中'}
        </div>
      )}
      {st?.status === 'error' && (
        <div className="status" style={{ color: 'var(--danger)' }}>
          {st.error}
          <button
            className="btn sm"
            onClick={(e) => {
              e.stopPropagation();
              void retryParagraph(p);
            }}
          >
            重试
          </button>
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { db } from '../db/db';
import { useEscape } from '../lib/useEscape';
import type { PdfMode, PdfTranslateStats } from '../pdfout/translatePdf';
import { describeError } from '../services/translate';
import { download } from '../services/export';
import { useReader } from '../store/reader';
import { Icon } from './Icon';

type Range = 'all' | 'current' | 'custom';

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 80) || 'paper';

export function PdfExportDialog({ onClose }: { onClose: () => void }) {
  const docId = useReader((s) => s.docId)!;
  const title = useReader((s) => s.title);
  const numPages = useReader((s) => s.pdf?.numPages ?? 1);
  const current = useReader((s) => s.currentPage);
  const [mode, setMode] = useState<PdfMode>('mono');
  const [range, setRange] = useState<Range>('all');
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(numPages);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState('');
  const [frac, setFrac] = useState(0);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ url: string; blob: Blob; stats: PdfTranslateStats; mode: PdfMode } | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  useEscape(() => !running && onClose());
  useEffect(() => () => ctrl.current?.abort(), []);
  useEffect(() => () => void (result && URL.revokeObjectURL(result.url)), [result]);

  const run = async () => {
    const [a, b] = range === 'all' ? [0, numPages - 1] : range === 'current' ? [current, current] : [Math.min(from, to) - 1, Math.max(from, to) - 1];
    const c = new AbortController();
    ctrl.current = c;
    setRunning(true);
    setError('');
    setResult(null);
    setFrac(0);
    try {
      const blob = await db.blobs.get(docId);
      if (!blob) throw new Error('找不到 PDF 文件');
      const { buildTranslatedPdf } = await import('../pdfout/translatePdf');
      const { bytes, stats } = await buildTranslatedPdf({
        docId,
        title,
        bytes: await blob.blob.arrayBuffer(),
        mode,
        from: Math.max(0, a),
        to: Math.min(numPages - 1, b),
        signal: c.signal,
        onProgress: (m, f) => {
          setMsg(m);
          if (f !== undefined) setFrac(f);
        },
      });
      const out = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
      setResult({ url: URL.createObjectURL(out), blob: out, stats, mode });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(describeError(e));
      else setMsg('已停止');
    } finally {
      setRunning(false);
    }
  };

  const fileName = `${safeName(title)}-${result?.mode === 'mono' ? 'zh' : result?.mode}.pdf`;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="dialog" style={{ width: 'min(520px, 100%)' }} role="dialog" aria-label="导出译文 PDF">
        <div className="dialog-head">
          导出译文 PDF
          <div className="spacer" />
          <button className="icon-btn" onClick={onClose} title="关闭" disabled={running}>
            <Icon name="close" />
          </button>
        </div>
        <div className="settings-content">
          <p className="hint" style={{ marginTop: 0 }}>
            用译文替换原文，保留原有排版：图片、表格、公式和版式不变，正文段落换成译文（行内公式保留原字形）。与阅读器里的「全文翻译」共用译文缓存，已经翻过的页不再消耗 token。
          </p>
          <div className="field">
            <label>输出</label>
            <div className="row" style={{ flexWrap: 'wrap', gap: 16 }}>
              <label className="row" style={{ gap: 6 }}>
                <input type="radio" checked={mode === 'mono'} onChange={() => setMode('mono')} disabled={running} /> 仅译文
              </label>
              <label className="row" style={{ gap: 6 }}>
                <input type="radio" checked={mode === 'side'} onChange={() => setMode('side')} disabled={running} /> 左右对照（原文 | 译文 拼在同一页）
              </label>
              <label className="row" style={{ gap: 6 }}>
                <input type="radio" checked={mode === 'dual'} onChange={() => setMode('dual')} disabled={running} /> 双语交替（原文页、译文页交替）
              </label>
            </div>
          </div>
          <div className="field">
            <label>页面范围</label>
            <div className="row" style={{ flexWrap: 'wrap', gap: 16 }}>
              <label className="row" style={{ gap: 6 }}>
                <input type="radio" checked={range === 'all'} onChange={() => setRange('all')} disabled={running} /> 全部（{numPages} 页）
              </label>
              <label className="row" style={{ gap: 6 }}>
                <input type="radio" checked={range === 'current'} onChange={() => setRange('current')} disabled={running} /> 当前页（第 {current + 1} 页）
              </label>
              <label className="row" style={{ gap: 6 }}>
                <input type="radio" checked={range === 'custom'} onChange={() => setRange('custom')} disabled={running} />
                <input
                  className="input"
                  style={{ width: 64 }}
                  type="number"
                  min={1}
                  max={numPages}
                  value={from}
                  disabled={running}
                  onFocus={() => setRange('custom')}
                  onChange={(e) => setFrom(Math.max(1, Math.min(numPages, Number(e.target.value) || 1)))}
                  aria-label="起始页"
                />
                –
                <input
                  className="input"
                  style={{ width: 64 }}
                  type="number"
                  min={1}
                  max={numPages}
                  value={to}
                  disabled={running}
                  onFocus={() => setRange('custom')}
                  onChange={(e) => setTo(Math.max(1, Math.min(numPages, Number(e.target.value) || 1)))}
                  aria-label="结束页"
                />
              </label>
            </div>
            {mode === 'mono' && range !== 'all' && <div className="hint">范围外的页面保留原文。</div>}
          </div>

          <div className="row" style={{ marginTop: 4 }}>
            {running ? (
              <button className="btn" onClick={() => ctrl.current?.abort()}>
                <Icon name="stop" size={14} /> 停止
              </button>
            ) : (
              <button className="btn primary" onClick={() => void run()}>
                <Icon name="translate" size={14} /> {result ? '重新生成' : '开始生成'}
              </button>
            )}
            {(running || msg) && !result && (
              <>
                <div className="progress">
                  <div style={{ width: `${Math.round(frac * 100)}%` }} />
                </div>
                <span className="hint" style={{ whiteSpace: 'nowrap' }}>
                  {msg}
                </span>
              </>
            )}
          </div>

          {error && (
            <div className="error-box" style={{ marginTop: 12 }}>
              {error}
            </div>
          )}

          {result && (
            <div style={{ marginTop: 14 }}>
              <div className="hint" style={{ marginBottom: 8 }}>
                已生成：{result.stats.pages} 页、{result.stats.paragraphs} 段、{result.stats.formulas} 处行内公式，{(result.blob.size / 1048576).toFixed(1)} MB
                {result.stats.overflow > 0 && `；${result.stats.overflow} 段译文过长已缩小字号`}
                {result.stats.skippedPages.length > 0 && `；跳过旋转页 ${result.stats.skippedPages.map((p) => p + 1).join('、')}`}
              </div>
              <div className="row">
                <a className="btn" style={{ textDecoration: 'none' }} href={result.url} target="_blank" rel="noreferrer">
                  <Icon name="book" size={14} /> 预览
                </a>
                <button className="btn primary" onClick={() => download(fileName, result.blob)}>
                  <Icon name="download" size={14} /> 下载
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

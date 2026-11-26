import { useEffect, useRef, useState } from 'react';
import { importFromIdentifier, importReferencesText } from '../../library/service';
import { useEscape } from '../../lib/useEscape';
import { Icon } from '../Icon';

type Tab = 'pdf' | 'link' | 'bibtex';

interface Line {
  input: string;
  state: 'pending' | 'running' | 'ok' | 'dup' | 'error';
  text?: string;
  docId?: string;
}

export function ImportDialog({
  collectionId,
  onFiles,
  onClose,
  onImported,
}: {
  collectionId?: string;
  onFiles: (f: File[]) => void;
  onClose: () => void;
  onImported: (docId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('pdf');
  const [text, setText] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [running, setRunning] = useState(false);
  const [bibText, setBibText] = useState('');
  const [bibMsg, setBibMsg] = useState('');
  const ctrl = useRef<AbortController | null>(null);
  const pdfRef = useRef<HTMLInputElement>(null);
  const bibRef = useRef<HTMLInputElement>(null);

  useEscape(() => !running && onClose());
  useEffect(() => () => ctrl.current?.abort(), []);

  const runLinks = async () => {
    const inputs = text
      .split(/[\n\r]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!inputs.length) return;
    const c = new AbortController();
    ctrl.current = c;
    setRunning(true);
    const state: Line[] = inputs.map((input) => ({ input, state: 'pending' }));
    setLines([...state]);
    for (let i = 0; i < state.length && !c.signal.aborted; i++) {
      state[i] = { ...state[i], state: 'running' };
      setLines([...state]);
      try {
        const idx = i;
        const r = await importFromIdentifier(state[i].input, {
          collectionId,
          signal: c.signal,
          onProgress: (msg) => {
            state[idx] = { ...state[idx], text: msg };
            setLines([...state]);
          },
        });
        state[i] = { ...state[i], state: r.duplicate ? 'dup' : 'ok', text: r.duplicate ? `已在库中：${r.title}` : `${r.title}${r.note ? `（${r.note}）` : ''}`, docId: r.docId };
        if (!r.duplicate) onImported(r.docId);
      } catch (e) {
        if ((e as Error).name === 'AbortError') break;
        state[i] = { ...state[i], state: 'error', text: (e as Error).message };
      }
      setLines([...state]);
    }
    setRunning(false);
    setText(state.filter((l) => l.state === 'error' || l.state === 'pending').map((l) => l.input).join('\n'));
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="dialog" style={{ width: 'min(640px, 100%)' }} role="dialog" aria-label="导入文献">
        <div className="dialog-head">
          导入文献
          <div className="spacer" />
          <button className="icon-btn" onClick={onClose} title="关闭">
            <Icon name="close" />
          </button>
        </div>
        <nav className="tabs" style={{ padding: '6px 16px 0' }}>
          {(
            [
              ['pdf', 'PDF 文件'],
              ['link', 'DOI / arXiv / 链接'],
              ['bibtex', '知网 / BibTeX / RIS'],
            ] as [Tab, string][]
          ).map(([k, v]) => (
            <button key={k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>
              {v}
            </button>
          ))}
        </nav>
        <div className="settings-content" style={{ minHeight: 260 }}>
          {tab === 'pdf' && (
            <div
              className="dropzone"
              onClick={() => pdfRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                onFiles([...e.dataTransfer.files]);
                onClose();
              }}
            >
              <Icon name="upload" size={28} />
              <h2>拖入 PDF 或点击选择（可多选）</h2>
              <div className="hint">自动识别标题、作者、DOI / arXiv 编号，并在线补全元数据</div>
              <input
                ref={pdfRef}
                type="file"
                accept="application/pdf,.pdf"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) onFiles([...e.target.files]);
                  onClose();
                }}
              />
            </div>
          )}
          {tab === 'link' && (
            <>
              <textarea
                className="textarea"
                rows={5}
                autoFocus
                placeholder={'每行一个，例如：\n10.1145/3292500.3330701\nhttps://arxiv.org/abs/1706.03762\narXiv:1810.04805\nhttps://example.org/paper.pdf'}
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={running}
              />
              <div className="hint" style={{ margin: '6px 0 10px' }}>
                arXiv 会自动下载 PDF；DOI 会从 Crossref 获取题录，并尝试下载开放获取的 PDF，拿不到时只建题录条目。下载通过「跨域代理」进行。
              </div>
              <div className="row">
                {running ? (
                  <button className="btn" onClick={() => ctrl.current?.abort()}>
                    <Icon name="stop" size={14} /> 停止
                  </button>
                ) : (
                  <button className="btn primary" disabled={!text.trim()} onClick={() => void runLinks()}>
                    导入
                  </button>
                )}
              </div>
              <div style={{ marginTop: 12 }}>
                {lines.map((l, i) => (
                  <div key={i} className="import-line">
                    <span className={`dot ${l.state}`}>
                      {l.state === 'running' ? <span className="spinner" /> : { pending: '·', ok: '✓', dup: '=', error: '✕', running: '' }[l.state]}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div className="hint" style={{ wordBreak: 'break-all' }}>
                        {l.input}
                      </div>
                      {l.text && <div style={{ color: l.state === 'error' ? 'var(--danger)' : undefined }}>{l.text}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {tab === 'bibtex' && (
            <>
              <p className="hint" style={{ marginTop: 0, lineHeight: 1.55 }}>
                支持直接粘贴或导入 <b>知网（CNKI）</b> 导出的 GB/T 7714、NoteExpress（.net）、EndNote（.enw）、RefWorks、RIS（.ris）以及 BibTeX（.bib）。知网关键词会自动转为标签；后续拖入知网下载的「标题_作者.pdf」会自动按标题合并到对应题录。
              </p>
              <textarea
                className="textarea"
                rows={5}
                placeholder={'直接粘贴知网点“引用”复制的 GB/T 7714 / NoteExpress / EndNote / RefWorks / RIS / BibTeX 内容…\n例：[1] 徐凯翔, 王永贵. 变与不变：……[J]. 西北工业大学学报(社会科学版), 2026(06): 42-49.'}
                value={bibText}
                onChange={(e) => setBibText(e.target.value)}
                disabled={running}
              />
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  className="btn primary"
                  disabled={running || !bibText.trim()}
                  onClick={async () => {
                    setRunning(true);
                    setBibMsg('');
                    try {
                      const r = await importReferencesText(bibText, collectionId);
                      setBibMsg(`✓ 已导入 ${r.added} 条${r.skipped ? `，跳过 ${r.skipped} 条重复` : ''}。`);
                      setBibText('');
                      if (r.docIds[0]) onImported(r.docIds[0]);
                    } catch (err) {
                      setBibMsg(`导入失败：${(err as Error).message}`);
                    } finally {
                      setRunning(false);
                    }
                  }}
                >
                  粘贴导入
                </button>
                <button className="btn" onClick={() => bibRef.current?.click()} disabled={running}>
                  选择题录文件 (.bib / .ris / .enw / .net / .txt)
                </button>
              </div>
              <input
                ref={bibRef}
                type="file"
                accept=".bib,.bibtex,.ris,.enw,.net,.txt"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  setRunning(true);
                  setBibMsg('');
                  try {
                    const r = await importReferencesText(await f.text(), collectionId);
                    setBibMsg(`✓ 已导入 ${r.added} 条${r.skipped ? `，跳过 ${r.skipped} 条重复` : ''}。`);
                    if (r.docIds[0]) onImported(r.docIds[0]);
                  } catch (err) {
                    setBibMsg(`导入失败：${(err as Error).message}`);
                  } finally {
                    setRunning(false);
                  }
                }}
              />
              {bibMsg && (
                <p style={{ color: bibMsg.startsWith('✓') ? 'var(--success)' : 'var(--danger)', marginTop: 10 }}>{bibMsg}</p>
              )}
              <div className="hint" style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                想要像 Zotero 一样在知网 / arXiv / IEEE 网页点一下直接收藏？安装{' '}
                <a href="https://github.com/royhang/PaperBridge/releases/latest" target="_blank" rel="noreferrer">
                  PaperBridge Connector 浏览器扩展
                </a>
                即可一键保存到指定分类。
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { db, deleteDocument, type DocRecord, type ReadStatus } from '../../db/db';
import { formatCitation } from '../../library/citation';
import { authorsToText, STATUS_LABEL, textToAuthors } from '../../library/format';
import {
  addTags,
  addToCollection,
  attachPdfFile,
  enrichMetadata,
  fetchPdfForDoc,
  flattenCollectionTree,
  removeFromCollection,
  removeTag,
  restoreDocs,
  setStarred,
  setStatus,
  trashDocs,
  updateMeta,
} from '../../library/service';
import type { ItemType, PaperMeta } from '../../library/types';
import { openDocTab } from '../../lib/nav';
import { download } from '../../services/export';
import { LAYER_PANEL, useEscape } from '../../lib/useEscape';
import { TAG_COLOR_HEX, useSettings } from '../../store/settings';
import { useTabs } from '../../store/tabs';
import { Icon } from '../Icon';

const TYPE_LABEL: Record<ItemType, string> = {
  article: '期刊论文',
  conference: '会议论文',
  preprint: '预印本',
  book: '书籍',
  chapter: '书籍章节',
  thesis: '学位论文',
  report: '报告',
  other: '其他',
};

type CiteStyle = 'gbt7714' | 'apa' | 'bibtex';
type InspectorTab = 'info' | 'notes';

const DETAIL_WIDTH_KEY = 'paperbridge.detailWidth';
function loadDetailWidth() {
  try {
    const v = Number(localStorage.getItem(DETAIL_WIDTH_KEY));
    if (v >= 300 && v <= 560) return v;
  } catch {
    /* ignore */
  }
  return 376;
}

export function DocDetail({ doc, onClose }: { doc: DocRecord; onClose: () => void }) {
  const [draft, setDraft] = useState<PaperMeta>(doc.meta);
  const [authorsText, setAuthorsText] = useState(authorsToText(doc.meta.authors));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [style, setStyle] = useState<CiteStyle>('gbt7714');
  const [tagInput, setTagInput] = useState('');
  const [tab, setTab] = useState<InspectorTab>('info');
  const [width, setWidth] = useState(loadDetailWidth);
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ x: number; w: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const isOpenInTab = useTabs((s) => s.tabs.some((t) => t.docId === doc.id));
  const tagColors = useSettings((s) => s.tagColors ?? {});
  const collections = useLiveQuery(() => db.collections.orderBy('order').toArray(), []);
  const allTags = useLiveQuery(async () => [...new Set((await db.docs.toArray()).filter((d) => !d.deletedAt).flatMap((d) => d.tags))].sort(), []);
  const docNotes = useLiveQuery(() => db.notes.where('docId').equals(doc.id).sortBy('pageIndex'), [doc.id]);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const s = startRef.current;
      if (!s) return;
      setWidth(Math.max(300, Math.min(560, s.w + (s.x - e.clientX))));
    };
    const up = () => setDragging(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dragging]);

  useEffect(() => {
    if (dragging) return;
    try {
      localStorage.setItem(DETAIL_WIDTH_KEY, String(Math.round(width)));
    } catch {
      /* ignore */
    }
  }, [dragging, width]);

  // Reset the form when another doc is selected or the record changes underneath (e.g. enrichment).
  const [shownFor, setShownFor] = useState({ id: doc.id, updatedAt: doc.updatedAt });
  if (shownFor.id !== doc.id || (!dirty && shownFor.updatedAt !== doc.updatedAt)) {
    if (shownFor.id !== doc.id) setMsg('');
    setShownFor({ id: doc.id, updatedAt: doc.updatedAt });
    setDraft(doc.meta);
    setAuthorsText(authorsToText(doc.meta.authors));
    setDirty(false);
  }

  useEscape(() => {
    if (!(document.activeElement as HTMLElement | null)?.closest('input,textarea,select')) onClose();
  }, LAYER_PANEL);

  const patch = (p: Partial<PaperMeta>) => {
    setDraft((d) => ({ ...d, ...p }));
    setDirty(true);
  };

  const save = async () => {
    await updateMeta(doc.id, { ...draft, authors: textToAuthors(authorsText) });
    setDirty(false);
    setMsg('已保存');
  };

  const run = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(label);
    setMsg('');
    try {
      const r = await fn();
      if (r) setMsg(r);
    } catch (e) {
      setMsg(`${label}失败：${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  };

  const citation = formatCitation({ ...doc.meta }, style);
  const noteCount = docNotes?.length ?? 0;

  return (
    <aside className="lib-detail" style={{ width }}>
      <div
        className={`pane-resizer left${dragging ? ' dragging' : ''}`}
        onPointerDown={(e) => {
          startRef.current = { x: e.clientX, w: width };
          setDragging(true);
          e.preventDefault();
        }}
      />
      <div className="detail-head">
        <button
          className={`star${doc.starred ? ' on' : ''}`}
          title={doc.starred ? '取消星标' : '星标'}
          onClick={() => void setStarred([doc.id], !doc.starred)}
        >
          {doc.starred ? '★' : '☆'}
        </button>
        <select className="select sm" value={doc.status} onChange={(e) => void setStatus([doc.id], e.target.value as ReadStatus)}>
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <div className="spacer" />
        {!doc.deletedAt &&
          (doc.hasPdf ? (
            <button
              className="btn sm primary"
              onClick={(e) => openDocTab(doc.id, { title: doc.title, background: e.ctrlKey || e.metaKey })}
              title="在标签页打开阅读（Ctrl+点击在后台打开）"
            >
              <Icon name="book" size={13} /> {isOpenInTab ? '切换标签' : '阅读'}
            </button>
          ) : (
            <button
              className="btn sm primary"
              disabled={!!busy || (!doc.meta.doi && !doc.meta.arxivId && !doc.meta.url)}
              onClick={() =>
                void run('获取 PDF', async () =>
                  (await fetchPdfForDoc(doc.id, undefined, (m) => setBusy(`获取 PDF：${m}`)))
                    ? '已获取 PDF'
                    : '没有找到可直接下载的开放获取 PDF，请手动附加。',
                )
              }
            >
              获取 PDF
            </button>
          ))}
        <button className="icon-btn sm-ico" title="关闭 (Esc)" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </div>

      {/* Zotero 7 inspector sub-tabs */}
      <div className="inspector-tabs">
        <button className={tab === 'info' ? 'active' : ''} onClick={() => setTab('info')}>
          信息
        </button>
        <button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>
          笔记 {noteCount > 0 && <span className="badge">{noteCount}</span>}
        </button>
      </div>

      {tab === 'notes' ? (
        <div className="detail-body">
          {noteCount === 0 ? (
            <div className="empty" style={{ padding: '28px 8px' }}>
              <Icon name="highlight" size={24} />
              <p className="hint" style={{ marginTop: 8 }}>
                这篇文献还没有高亮或批注。打开阅读后选中文字即可记录。
              </p>
            </div>
          ) : (
            docNotes?.map((n) => (
              <div
                key={n.id}
                className={`note ${n.color}`}
                role="button"
                tabIndex={0}
                onClick={() => openDocTab(doc.id, { title: doc.title, page: n.pageIndex + 1 })}
                style={{ cursor: 'pointer' }}
                title="点击跳转到对应页"
              >
                <div className="row" style={{ marginBottom: 4 }}>
                  <span className="badge">p.{n.pageIndex + 1}</span>
                  <span className="hint">{new Date(n.createdAt).toLocaleDateString()}</span>
                </div>
                <div className="quote">{n.quote}</div>
                {n.translation && <div className="tr">{n.translation}</div>}
                {n.comment && <div style={{ marginTop: 6, fontSize: 12.5 }}>{n.comment}</div>}
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="detail-body">
          {(busy || msg) && (
            <div className={msg.includes('失败') ? 'error-box' : 'hint'} style={{ marginBottom: 10 }}>
              {busy && <span className="spinner" />} {busy ? `${busy}…` : msg}
            </div>
          )}

          <details className="inspector-sec" open>
            <summary>基本信息</summary>
            <div className="inspector-sec-body">
              <div className="field">
                <label>标题</label>
                <textarea className="textarea" rows={2} value={draft.title} onChange={(e) => patch({ title: e.target.value })} />
              </div>
              <div className="field">
                <label>作者（每位「姓, 名」，用分号分隔）</label>
                <textarea
                  className="textarea"
                  rows={2}
                  value={authorsText}
                  onChange={(e) => {
                    setAuthorsText(e.target.value);
                    setDirty(true);
                  }}
                />
              </div>
              <div className="grid3">
                <div className="field">
                  <label>类型</label>
                  <select className="select" value={draft.type} onChange={(e) => patch({ type: e.target.value as ItemType })}>
                    {Object.entries(TYPE_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>年份</label>
                  <input
                    className="input"
                    inputMode="numeric"
                    value={draft.year ?? ''}
                    onChange={(e) => patch({ year: Number(e.target.value.replace(/\D/g, '')) || undefined })}
                  />
                </div>
                <div className="field">
                  <label>页码</label>
                  <input className="input" value={draft.pages ?? ''} onChange={(e) => patch({ pages: e.target.value || undefined })} />
                </div>
              </div>
              <div className="field">
                <label>期刊 / 会议</label>
                <input className="input" value={draft.venue ?? ''} onChange={(e) => patch({ venue: e.target.value || undefined })} />
              </div>
              <div className="grid3">
                <div className="field">
                  <label>卷</label>
                  <input className="input" value={draft.volume ?? ''} onChange={(e) => patch({ volume: e.target.value || undefined })} />
                </div>
                <div className="field">
                  <label>期</label>
                  <input className="input" value={draft.issue ?? ''} onChange={(e) => patch({ issue: e.target.value || undefined })} />
                </div>
                <div className="field">
                  <label>出版社</label>
                  <input className="input" value={draft.publisher ?? ''} onChange={(e) => patch({ publisher: e.target.value || undefined })} />
                </div>
              </div>
              <div className="grid2">
                <div className="field">
                  <label>DOI</label>
                  <input className="input" value={draft.doi ?? ''} onChange={(e) => patch({ doi: e.target.value.trim() || undefined })} />
                </div>
                <div className="field">
                  <label>arXiv</label>
                  <input className="input" value={draft.arxivId ?? ''} onChange={(e) => patch({ arxivId: e.target.value.trim() || undefined })} />
                </div>
              </div>
              <div className="field">
                <label>网址</label>
                <input className="input" value={draft.url ?? ''} onChange={(e) => patch({ url: e.target.value.trim() || undefined })} />
              </div>
              <div className="row" style={{ marginTop: 4 }}>
                <button className="btn sm primary" disabled={!dirty} onClick={() => void save()}>
                  保存元数据
                </button>
                {dirty && (
                  <button className="btn sm ghost" onClick={() => setShownFor({ id: '', updatedAt: 0 })}>
                    放弃修改
                  </button>
                )}
                <div className="spacer" />
                <button
                  className="btn sm"
                  disabled={!!busy || (!doc.meta.doi && !doc.meta.arxivId)}
                  title="根据 DOI / arXiv 编号从 Crossref / arXiv 获取元数据（会覆盖当前内容）"
                  onClick={() => void run('在线补全', async () => ((await enrichMetadata(doc.id, { force: true })) ? '已从在线数据库更新' : '没有找到更多信息'))}
                >
                  <Icon name="refresh" size={12} /> 在线补全
                </button>
              </div>
            </div>
          </details>

          <details className="inspector-sec">
            <summary>摘要</summary>
            <div className="inspector-sec-body">
              <textarea
                className="textarea"
                rows={5}
                placeholder="暂无摘要…"
                value={draft.abstract ?? ''}
                onChange={(e) => patch({ abstract: e.target.value || undefined })}
              />
            </div>
          </details>

          <details className="inspector-sec" open>
            <summary>标签与分类</summary>
            <div className="inspector-sec-body">
              <div className="field">
                <label>标签</label>
                <div className="tag-chips">
                  {doc.tags.map((t) => (
                    <span key={t} className="tag-chip">
                      {tagColors[t] && <span className="tag-color-dot sm" style={{ background: TAG_COLOR_HEX[tagColors[t]] }} />}
                      {t}
                      <button onClick={() => void removeTag([doc.id], t)} title="移除">
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    className="tag-input"
                    list="all-tags"
                    placeholder="+ 标签"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ',') && tagInput.trim()) {
                        e.preventDefault();
                        void addTags([doc.id], [tagInput]);
                        setTagInput('');
                      }
                    }}
                  />
                  <datalist id="all-tags">
                    {allTags?.filter((t) => !doc.tags.includes(t)).map((t) => <option key={t} value={t} />)}
                  </datalist>
                </div>
              </div>

              {collections && collections.length > 0 && (
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>分类</label>
                  <div className="tag-chips">
                    {flattenCollectionTree(collections).map(({ col: c, depth }) => {
                      const on = doc.collectionIds.includes(c.id);
                      return (
                        <button
                          key={c.id}
                          className={`tag-chip clickable${on ? ' active' : ''}`}
                          onClick={() => void (on ? removeFromCollection([doc.id], c.id) : addToCollection([doc.id], c.id))}
                        >
                          {on ? '✓ ' : ''}
                          {depth > 0 ? `${'› '.repeat(depth)}` : ''}
                          {c.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </details>

          <details className="inspector-sec" open>
            <summary>引用</summary>
            <div className="inspector-sec-body">
              <div className="row" style={{ marginBottom: 4 }}>
                {(['gbt7714', 'apa', 'bibtex'] as CiteStyle[]).map((s) => (
                  <button key={s} className={`chip${style === s ? ' active' : ''}`} onClick={() => setStyle(s)}>
                    {s === 'gbt7714' ? 'GB/T 7714' : s === 'apa' ? 'APA' : 'BibTeX'}
                  </button>
                ))}
                <div className="spacer" />
                <button className="btn sm" onClick={() => (void navigator.clipboard.writeText(citation), setMsg('引用已复制'))}>
                  <Icon name="copy" size={12} /> 复制
                </button>
              </div>
              <pre className="citation">{citation}</pre>
            </div>
          </details>

          <details className="inspector-sec" open>
            <summary>附件与操作</summary>
            <div className="inspector-sec-body">
              <div className="detail-facts hint">
                {doc.hasPdf && (
                  <div>
                    PDF：{doc.fileName || '—'} · {doc.pageCount} 页 · {(doc.size / 1048576).toFixed(1)} MB
                  </div>
                )}
                <div>
                  笔记 {noteCount} 条 · 添加于 {new Date(doc.addedAt).toLocaleDateString()}
                  {doc.lastOpenedAt ? ` · 上次阅读 ${new Date(doc.lastOpenedAt).toLocaleDateString()}` : ''}
                </div>
                <div>元数据来源：{{ pdf: 'PDF 自动识别', crossref: 'Crossref', arxiv: 'arXiv', bibtex: 'BibTeX 导入', manual: '手动编辑' }[doc.metaSource]}</div>
              </div>

              <div className="row" style={{ flexWrap: 'wrap', marginTop: 10 }}>
                <button className="btn sm" onClick={() => fileRef.current?.click()}>
                  {doc.hasPdf ? '替换 PDF' : '附加 PDF'}
                </button>
                {doc.hasPdf && (
                  <button
                    className="btn sm"
                    onClick={async () => {
                      const b = await db.blobs.get(doc.id);
                      if (!b) return;
                      const url = URL.createObjectURL(b.blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = doc.fileName || `${doc.title}.pdf`;
                      a.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    }}
                  >
                    <Icon name="download" size={12} /> 下载 PDF
                  </button>
                )}
                <button className="btn sm" onClick={() => download(`${doc.title}.bib`, formatCitation(doc.meta, 'bibtex'), 'text/plain;charset=utf-8')}>
                  导出 .bib
                </button>
                <div className="spacer" />
                {doc.deletedAt ? (
                  <>
                    <button
                      className="btn sm primary"
                      onClick={() => {
                        void restoreDocs([doc.id]);
                        onClose();
                      }}
                    >
                      还原文献
                    </button>
                    <button
                      className="btn sm danger"
                      onClick={() => {
                        if (confirm(`永久删除《${doc.title}》及其笔记、翻译缓存？此操作不可撤销。`)) {
                          void deleteDocument(doc.id);
                          onClose();
                        }
                      }}
                    >
                      彻底删除
                    </button>
                  </>
                ) : (
                  <button
                    className="btn sm danger"
                    onClick={() => {
                      useTabs.getState().closeTab(doc.id);
                      void trashDocs([doc.id]);
                      onClose();
                    }}
                  >
                    移入回收站
                  </button>
                )}
              </div>
            </div>
          </details>

          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void run('附加 PDF', async () => (await attachPdfFile(doc.id, f), 'PDF 已附加'));
            }}
          />
        </div>
      )}
    </aside>
  );
}

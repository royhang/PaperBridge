import { useLiveQuery } from 'dexie-react-hooks';
import { useRef, useState } from 'react';
import { db, deleteDocument, type DocRecord, type ReadStatus } from '../../db/db';
import { formatCitation } from '../../library/citation';
import { authorsToText, STATUS_LABEL, textToAuthors } from '../../library/format';
import {
  addTags,
  addToCollection,
  attachPdfFile,
  enrichMetadata,
  fetchPdfForDoc,
  removeFromCollection,
  removeTag,
  setStarred,
  setStatus,
  updateMeta,
} from '../../library/service';
import type { ItemType, PaperMeta } from '../../library/types';
import { navigate } from '../../lib/nav';
import { download } from '../../services/export';
import { LAYER_PANEL, useEscape } from '../../lib/useEscape';
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

export function DocDetail({ doc, onClose }: { doc: DocRecord; onClose: () => void }) {
  const [draft, setDraft] = useState<PaperMeta>(doc.meta);
  const [authorsText, setAuthorsText] = useState(authorsToText(doc.meta.authors));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [style, setStyle] = useState<CiteStyle>('gbt7714');
  const [tagInput, setTagInput] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const collections = useLiveQuery(() => db.collections.orderBy('order').toArray(), []);
  const allTags = useLiveQuery(async () => [...new Set((await db.docs.toArray()).flatMap((d) => d.tags))].sort(), []);
  const noteCount = useLiveQuery(() => db.notes.where('docId').equals(doc.id).count(), [doc.id]);

  // Reset the form when another doc is selected or the record changes underneath (e.g. enrichment).
  const [shownFor, setShownFor] = useState({ id: doc.id, updatedAt: doc.updatedAt });
  if (shownFor.id !== doc.id || (!dirty && shownFor.updatedAt !== doc.updatedAt)) {
    if (shownFor.id !== doc.id) setMsg(''); // keep result messages when the same doc is updated
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

  return (
    <aside className="lib-detail">
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
        {doc.hasPdf ? (
          <button className="btn sm primary" onClick={() => navigate(`#/doc/${doc.id}`)}>
            <Icon name="book" size={14} /> 阅读
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
        )}
        <button className="icon-btn" title="关闭 (Esc)" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="detail-body">
        {(busy || msg) && (
          <div className={msg.includes('失败') ? 'error-box' : 'hint'} style={{ marginBottom: 10 }}>
            {busy && <span className="spinner" />} {busy ? `${busy}…` : msg}
          </div>
        )}

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
        <details className="field">
          <summary className="hint" style={{ cursor: 'pointer' }}>
            摘要
          </summary>
          <textarea className="textarea" rows={6} value={draft.abstract ?? ''} onChange={(e) => patch({ abstract: e.target.value || undefined })} />
        </details>
        <div className="row" style={{ marginBottom: 14 }}>
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
            <Icon name="refresh" size={13} /> 在线补全
          </button>
        </div>

        <div className="field">
          <label>标签</label>
          <div className="tag-chips">
            {doc.tags.map((t) => (
              <span key={t} className="tag-chip">
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
          <div className="field">
            <label>分组</label>
            <div className="tag-chips">
              {collections.map((c) => {
                const on = doc.collectionIds.includes(c.id);
                return (
                  <button
                    key={c.id}
                    className={`tag-chip clickable${on ? ' active' : ''}`}
                    onClick={() => void (on ? removeFromCollection([doc.id], c.id) : addToCollection([doc.id], c.id))}
                  >
                    {on ? '✓ ' : ''}
                    {c.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="field">
          <div className="row">
            <label style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>引用</label>
            <div className="spacer" />
            {(['gbt7714', 'apa', 'bibtex'] as CiteStyle[]).map((s) => (
              <button key={s} className={`chip${style === s ? ' active' : ''}`} onClick={() => setStyle(s)}>
                {s === 'gbt7714' ? 'GB/T 7714' : s === 'apa' ? 'APA' : 'BibTeX'}
              </button>
            ))}
          </div>
          <pre className="citation">{citation}</pre>
          <div className="row">
            <button className="btn sm" onClick={() => (void navigator.clipboard.writeText(citation), setMsg('引用已复制'))}>
              <Icon name="copy" size={13} /> 复制
            </button>
          </div>
        </div>

        <div className="detail-facts hint">
          {doc.hasPdf && (
            <div>
              PDF：{doc.fileName || '—'} · {doc.pageCount} 页 · {(doc.size / 1048576).toFixed(1)} MB
            </div>
          )}
          <div>
            笔记 {noteCount ?? 0} 条 · 添加于 {new Date(doc.addedAt).toLocaleDateString()}
            {doc.lastOpenedAt ? ` · 上次阅读 ${new Date(doc.lastOpenedAt).toLocaleDateString()}` : ''}
          </div>
          <div>元数据来源：{{ pdf: 'PDF 自动识别', crossref: 'Crossref', arxiv: 'arXiv', bibtex: 'BibTeX 导入', manual: '手动编辑' }[doc.metaSource]}</div>
        </div>

        <div className="row" style={{ flexWrap: 'wrap', marginTop: 12 }}>
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
              <Icon name="download" size={13} /> 下载 PDF
            </button>
          )}
          <button className="btn sm" onClick={() => download(`${doc.title}.bib`, formatCitation(doc.meta, 'bibtex'), 'text/plain;charset=utf-8')}>
            导出 .bib
          </button>
          <div className="spacer" />
          <button
            className="btn sm danger"
            onClick={() => {
              if (confirm(`删除《${doc.title}》及其笔记、翻译缓存？`)) {
                void deleteDocument(doc.id);
                onClose();
              }
            }}
          >
            删除
          </button>
        </div>
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
    </aside>
  );
}

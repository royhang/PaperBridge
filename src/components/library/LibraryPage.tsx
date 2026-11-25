import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { db, deleteDocument, type DocRecord, type ReadStatus } from '../../db/db';
import { formatCitation } from '../../library/citation';
import { toBibTeXLibrary } from '../../library/bibtex';
import { authorName, authorsShort, STATUS_LABEL } from '../../library/format';
import {
  addTags,
  addToCollection,
  createCollection,
  deleteCollection,
  importPdfFile,
  indexAll,
  removeFromCollection,
  renameTag,
  searchFullText,
  setStarred,
  setStatus,
  type TextHit,
} from '../../library/service';
import { openDocTab, openSettings } from '../../lib/nav';
import { download } from '../../services/export';
import { useLibrary, type LibraryView, type SortKey } from '../../store/library';
import { useSettings } from '../../store/settings';
import { useTabs } from '../../store/tabs';
import { Icon, type IconName } from '../Icon';
import { DocDetail } from './DocDetail';
import { ImportDialog } from './ImportDialog';

const DRAG_TYPE = 'application/x-paperbridge-docs';
const SIDE_WIDTH_KEY = 'paperbridge.libSideWidth';

function loadSideWidth() {
  try {
    const v = Number(localStorage.getItem(SIDE_WIDTH_KEY));
    if (v >= 170 && v <= 360) return v;
  } catch {
    /* ignore */
  }
  return 228;
}

function matchesView(d: DocRecord, v: LibraryView): boolean {
  switch (v.kind) {
    case 'starred':
      return d.starred;
    case 'unread':
    case 'reading':
    case 'done':
      return d.status === v.kind;
    case 'recent':
      return Date.now() - d.addedAt < 14 * 86400_000;
    case 'nopdf':
      return !d.hasPdf;
    case 'collection':
      return !!v.id && d.collectionIds.includes(v.id);
    case 'tag':
      return !!v.id && d.tags.includes(v.id);
    default:
      return true;
  }
}

function matchesQuery(d: DocRecord, q: string): boolean {
  if (!q) return true;
  const m = d.meta;
  const hay = [m.title, m.authors.map(authorName).join(' '), m.venue, m.year, m.doi, m.arxivId, m.abstract, d.tags.join(' '), d.fileName]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

const sorters: Record<SortKey, (a: DocRecord, b: DocRecord) => number> = {
  lastOpened: (a, b) => (a.lastOpenedAt || a.addedAt) - (b.lastOpenedAt || b.addedAt),
  added: (a, b) => a.addedAt - b.addedAt,
  title: (a, b) => a.title.localeCompare(b.title, 'zh'),
  year: (a, b) => (a.meta.year ?? 0) - (b.meta.year ?? 0),
  author: (a, b) => (a.meta.authors[0]?.family ?? '').localeCompare(b.meta.authors[0]?.family ?? '', 'zh'),
};

export function LibraryPage() {
  const docs = useLiveQuery(() => db.docs.toArray(), []);
  const lib = useLibrary();
  const openTabs = useTabs((s) => s.tabs);
  const [importOpen, setImportOpen] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const [busy, setBusy] = useState('');
  const [hits, setHits] = useState<Map<string, TextHit[]> | null>(null);
  const [indexing, setIndexing] = useState<string>('');
  const hasProvider = useSettings((s) => s.providers.length > 0);
  const openDocIds = useMemo(() => new Set(openTabs.map((t) => t.docId)), [openTabs]);

  // full-text search (debounced)
  const q = lib.query.trim();
  useEffect(() => {
    if (!lib.fullText || q.length < 2) return;
    let off = false;
    const t = setTimeout(() => void searchFullText(q).then((h) => !off && setHits(h)), 300);
    return () => {
      off = true;
      clearTimeout(t);
    };
  }, [q, lib.fullText, docs?.length]);

  const enableFullText = async (on: boolean) => {
    lib.setFullText(on);
    if (!on) return;
    setIndexing('准备索引…');
    await indexAll((d, t) => setIndexing(t ? `正在建立全文索引 ${d}/${t}` : ''));
    setIndexing('');
  };

  const activeHits = lib.fullText && q.length >= 2 ? hits : null;
  const shown = useMemo(() => {
    const hits = activeHits;
    if (!docs) return [];
    const list = docs.filter((d) => matchesView(d, lib.view) && (matchesQuery(d, q) || !!hits?.get(d.id)?.length));
    list.sort(sorters[lib.sort]);
    if (lib.sortDesc) list.reverse();
    return list;
  }, [docs, lib.view, q, activeHits, lib.sort, lib.sortDesc]);

  const selected = docs?.find((d) => d.id === lib.selectedId) ?? null;

  const importFiles = async (files: File[]) => {
    const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (!pdfs.length) return;
    const cid = lib.view.kind === 'collection' ? lib.view.id : undefined;
    let lastId = '';
    for (let i = 0; i < pdfs.length; i++) {
      setBusy(`导入 ${i + 1}/${pdfs.length}：${pdfs[i].name}`);
      try {
        lastId = (await importPdfFile(pdfs[i], cid)).docId;
      } catch (e) {
        alert(`导入 ${pdfs[i].name} 失败：${(e as Error).message}`);
      }
    }
    setBusy('');
    if (lastId) lib.select(lastId);
  };

  const allShownChecked = shown.length > 0 && shown.every((d) => lib.checked.includes(d.id));
  const sortArrow = (k: SortKey) => (lib.sort === k ? (lib.sortDesc ? ' ↓' : ' ↑') : '');

  return (
    <div className="lib">
      {!hasProvider && (
        <div className="setup-banner" style={{ margin: '8px 12px 0' }}>
          <Icon name="sparkle" size={16} />
          <div>
            <div style={{ fontWeight: 600, fontSize: 13 }}>先接入一个翻译 / 大模型 API</div>
            <div className="hint">OpenAI 兼容接口、Claude、Gemini、DeepL、百度、有道等。Key 只保存在本机。</div>
          </div>
          <div className="spacer" />
          <button className="btn sm primary" onClick={() => openSettings('providers')}>
            添加 API
          </button>
        </div>
      )}
      <div className="lib-body">
        <Sidebar docs={docs ?? []} />
        <main
          className={`lib-main${dropOver ? ' drop-over' : ''}`}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setDropOver(true);
            }
          }}
          onDragLeave={() => setDropOver(false)}
          onDrop={(e) => {
            setDropOver(false);
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            void importFiles([...e.dataTransfer.files]);
          }}
        >
          {/* Zotero-style compact action & search toolbar */}
          <div className="lib-toolbar">
            <button className="btn sm primary" onClick={() => setImportOpen(true)} title="导入 PDF / DOI / arXiv / BibTeX">
              <Icon name="plus" size={14} /> 导入
            </button>
            <MobileViewSelect docs={docs ?? []} />
            <div className="view-switch hide-sm" role="group" aria-label="列表样式">
              <button
                className={lib.layout === 'table' ? 'active' : ''}
                title="Zotero 表格视图"
                onClick={() => lib.setLayout('table')}
              >
                <Icon name="table" size={13} />
              </button>
              <button
                className={lib.layout === 'list' ? 'active' : ''}
                title="详细卡片视图"
                onClick={() => lib.setLayout('list')}
              >
                <Icon name="list" size={13} />
              </button>
            </div>
            <div className="spacer" />
            <div className="search">
              <Icon name="search" size={14} />
              <input
                className="input"
                placeholder={lib.fullText ? '搜索标题、作者、正文、译文、笔记…' : '搜索标题、作者、期刊、标签、DOI…'}
                value={lib.query}
                onChange={(e) => lib.setQuery(e.target.value)}
              />
            </div>
            <label className="check" style={{ margin: 0, fontSize: 12.5 }} title="同时搜索 PDF 正文、译文和笔记">
              <input type="checkbox" checked={lib.fullText} onChange={(e) => void enableFullText(e.target.checked)} />
              全文
            </label>
            <select
              className="select sm"
              value={lib.sort}
              onChange={(e) => lib.setSort(e.target.value as SortKey)}
              title="排序"
            >
              <option value="lastOpened">最近阅读</option>
              <option value="added">添加时间</option>
              <option value="title">标题</option>
              <option value="year">年份</option>
              <option value="author">第一作者</option>
            </select>
            <button className="icon-btn sm-ico" title={lib.sortDesc ? '降序' : '升序'} onClick={() => lib.setSort(lib.sort)}>
              <Icon name={lib.sortDesc ? 'down' : 'up'} size={15} />
            </button>
            <span className="hint hide-sm" style={{ whiteSpace: 'nowrap' }}>
              {shown.length} 篇
            </span>
          </div>

          {(busy || indexing) && (
            <div className="hint row" style={{ padding: '4px 12px 6px' }}>
              <span className="spinner" /> {busy || indexing}
            </div>
          )}
          {lib.checked.length > 0 && <BulkBar docs={docs ?? []} />}

          {/* Zotero multi-column header (in table mode) */}
          {lib.layout === 'table' && shown.length > 0 && (
            <div className="doc-thead hide-sm">
              <div className="col-chk">
                <input
                  type="checkbox"
                  checked={allShownChecked}
                  onChange={() => lib.setChecked(allShownChecked ? [] : shown.map((d) => d.id))}
                  aria-label="全选"
                />
              </div>
              <div className="col-star" />
              <div className="col-title sortable" onClick={() => lib.setSort('title')}>
                标题{sortArrow('title')}
              </div>
              <div className="col-author sortable" onClick={() => lib.setSort('author')}>
                作者{sortArrow('author')}
              </div>
              <div className="col-venue">期刊 / 会议</div>
              <div className="col-year sortable" onClick={() => lib.setSort('year')}>
                年份{sortArrow('year')}
              </div>
              <div className="col-status sortable" onClick={() => lib.setSort('lastOpened')}>
                状态{sortArrow('lastOpened')}
              </div>
            </div>
          )}

          <div className={`doc-list${lib.layout === 'table' ? ' mode-table' : ' mode-list'}`}>
            {docs && shown.length === 0 && (
              <div className="empty">
                {docs.length === 0 ? (
                  <>
                    <Icon name="upload" size={28} />
                    <p>把 PDF 拖到这里，或点击左上角「导入」。</p>
                    <p className="hint">也可以粘贴 DOI / arXiv 链接，或导入 Zotero 导出的 BibTeX。所有数据只保存在本机。</p>
                  </>
                ) : (
                  '没有符合条件的文献'
                )}
              </div>
            )}
            {shown.map((d, idx) => (
              <DocRow
                key={d.id}
                d={d}
                stripe={idx % 2 === 1}
                layout={lib.layout}
                isOpen={openDocIds.has(d.id)}
                hits={activeHits?.get(d.id)}
              />
            ))}
          </div>
        </main>
        {selected && <DocDetail doc={selected} onClose={() => lib.select(null)} />}
      </div>
      {importOpen && (
        <ImportDialog
          collectionId={lib.view.kind === 'collection' ? lib.view.id : undefined}
          onFiles={(f) => void importFiles(f)}
          onClose={() => setImportOpen(false)}
          onImported={(id) => lib.select(id)}
        />
      )}
    </div>
  );
}

function MobileViewSelect({ docs }: { docs: DocRecord[] }) {
  const view = useLibrary((s) => s.view);
  const setView = useLibrary((s) => s.setView);
  const collections = useLiveQuery(() => db.collections.orderBy('order').toArray(), []);
  const tags = [...new Set(docs.flatMap((d) => d.tags))].sort();
  const value = `${view.kind}:${view.id ?? ''}`;
  return (
    <select
      className="select sm show-sm"
      style={{ width: 'auto', maxWidth: 140 }}
      value={value}
      onChange={(e) => {
        const [kind, ...rest] = e.target.value.split(':');
        setView({ kind: kind as LibraryView['kind'], id: rest.join(':') || undefined });
      }}
    >
      <option value="all:">全部文献</option>
      <option value="recent:">最近添加</option>
      <option value="starred:">星标</option>
      <option value="unread:">未读</option>
      <option value="reading:">在读</option>
      <option value="done:">已读</option>
      <option value="nopdf:">无 PDF</option>
      {collections?.map((c) => (
        <option key={c.id} value={`collection:${c.id}`}>
          ▸ {c.name}
        </option>
      ))}
      {tags.map((t) => (
        <option key={t} value={`tag:${t}`}>
          # {t}
        </option>
      ))}
    </select>
  );
}

function DocRow({
  d,
  stripe,
  layout,
  isOpen,
  hits,
}: {
  d: DocRecord;
  stripe: boolean;
  layout: 'table' | 'list';
  isOpen: boolean;
  hits?: TextHit[];
}) {
  const selected = useLibrary((s) => s.selectedId === d.id);
  const checked = useLibrary((s) => s.checked.includes(d.id));
  const select = useLibrary((s) => s.select);
  const toggleCheck = useLibrary((s) => s.toggleCheck);
  const open = (background = false) => (d.hasPdf ? openDocTab(d.id, { title: d.title, background }) : select(d.id));

  const dragProps = {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      const ids = useLibrary.getState().checked.includes(d.id) ? useLibrary.getState().checked : [d.id];
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'copy';
    },
  };

  if (layout === 'table') {
    return (
      <div
        className={`doc-row table-row${selected ? ' selected' : ''}${stripe ? ' stripe' : ''}`}
        {...dragProps}
        onClick={() => select(d.id)}
        onDoubleClick={() => open(false)}
        onAuxClick={(e) => {
          if (e.button === 1 && d.hasPdf) {
            e.preventDefault();
            open(true);
          }
        }}
        onKeyDown={(e) => e.key === 'Enter' && open(e.ctrlKey || e.metaKey)}
        tabIndex={0}
        title="双击在标签页打开 · 中键在后台打开"
      >
        <div className="doc-tr">
          <div className="col-chk">
            <input
              type="checkbox"
              checked={checked}
              onClick={(e) => e.stopPropagation()}
              onChange={() => toggleCheck(d.id)}
              aria-label="选择"
            />
          </div>
          <div className="col-star">
            <button
              className={`star${d.starred ? ' on' : ''}`}
              title={d.starred ? '取消星标' : '星标'}
              onClick={(e) => {
                e.stopPropagation();
                void setStarred([d.id], !d.starred);
              }}
            >
              {d.starred ? '★' : '☆'}
            </button>
          </div>
          <div className="col-title">
            <span className={`doc-ico${d.hasPdf ? ' has-pdf' : ''}`} title={d.hasPdf ? '含 PDF 附件' : '无 PDF 附件'}>
              <Icon name={d.hasPdf ? 'filePdf' : 'nofile'} size={14} />
            </span>
            {isOpen && <span className="open-dot" title="已在顶部标签页打开" />}
            <span className="doc-title-text">{d.title}</span>
            {d.tags.length > 0 && (
              <span className="inline-tags hide-sm">
                {d.tags.slice(0, 2).map((t) => (
                  <span key={t} className="tag-chip mini">
                    {t}
                  </span>
                ))}
                {d.tags.length > 2 && <span className="hint">+{d.tags.length - 2}</span>}
              </span>
            )}
          </div>
          <div className="col-author hide-sm" title={authorsShort(d.meta.authors)}>
            {authorsShort(d.meta.authors) || '—'}
          </div>
          <div className="col-venue hide-sm" title={d.meta.venue ?? ''}>
            {d.meta.venue || '—'}
          </div>
          <div className="col-year hide-sm">{d.meta.year ?? '—'}</div>
          <div className="col-status">
            <span className={`status-pill ${d.status}`}>{STATUS_LABEL[d.status]}</span>
          </div>
        </div>
        {hits && hits.length > 0 && (
          <div className="row-hits">
            {hits.map((h, i) => (
              <div key={i} className="hit">
                <span className="badge">{h.source === 'original' ? `p.${h.page + 1}` : h.source === 'translation' ? '译文' : '笔记'}</span>{' '}
                {h.snippet.slice(0, h.at)}
                <mark>{h.snippet.slice(h.at, h.at + useLibrary.getState().query.trim().length)}</mark>
                {h.snippet.slice(h.at + useLibrary.getState().query.trim().length)}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`doc-row${selected ? ' selected' : ''}`}
      {...dragProps}
      onClick={() => select(d.id)}
      onDoubleClick={() => open(false)}
      onAuxClick={(e) => {
        if (e.button === 1 && d.hasPdf) {
          e.preventDefault();
          open(true);
        }
      }}
      onKeyDown={(e) => e.key === 'Enter' && open(e.ctrlKey || e.metaKey)}
      tabIndex={0}
    >
      <input
        type="checkbox"
        checked={checked}
        onClick={(e) => e.stopPropagation()}
        onChange={() => toggleCheck(d.id)}
        aria-label="选择"
      />
      <button
        className={`star${d.starred ? ' on' : ''}`}
        title={d.starred ? '取消星标' : '星标'}
        onClick={(e) => {
          e.stopPropagation();
          void setStarred([d.id], !d.starred);
        }}
      >
        {d.starred ? '★' : '☆'}
      </button>
      <div className="doc-main">
        <div className="doc-title">
          {isOpen && <span className="open-dot" title="已在顶部标签页打开" />}
          {d.title}
          {!d.hasPdf && <span className="badge">无 PDF</span>}
        </div>
        <div className="doc-sub">
          {[authorsShort(d.meta.authors), d.meta.venue, d.meta.year].filter(Boolean).join(' · ') || d.fileName}
        </div>
        {d.tags.length > 0 && (
          <div className="tag-chips">
            {d.tags.map((t) => (
              <span key={t} className="tag-chip">
                {t}
              </span>
            ))}
          </div>
        )}
        {hits?.map((h, i) => (
          <div key={i} className="hit">
            <span className="badge">{h.source === 'original' ? `p.${h.page + 1}` : h.source === 'translation' ? '译文' : '笔记'}</span>{' '}
            {h.snippet.slice(0, h.at)}
            <mark>{h.snippet.slice(h.at, h.at + useLibrary.getState().query.trim().length)}</mark>
            {h.snippet.slice(h.at + useLibrary.getState().query.trim().length)}
          </div>
        ))}
      </div>
      <span className={`status-pill ${d.status}`}>{STATUS_LABEL[d.status]}</span>
      <button className="btn sm hide-sm" onClick={(e) => (e.stopPropagation(), open(e.ctrlKey || e.metaKey))} disabled={!d.hasPdf}>
        {isOpen ? '切换' : '阅读'}
      </button>
    </div>
  );
}

function Sidebar({ docs }: { docs: DocRecord[] }) {
  const view = useLibrary((s) => s.view);
  const setView = useLibrary((s) => s.setView);
  const collections = useLiveQuery(() => db.collections.orderBy('order').toArray(), []);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [over, setOver] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState('');
  const [width, setWidth] = useState(loadSideWidth);
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const s = startRef.current;
      if (!s) return;
      setWidth(Math.max(170, Math.min(360, s.w + (e.clientX - s.x))));
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
      localStorage.setItem(SIDE_WIDTH_KEY, String(Math.round(width)));
    } catch {
      /* ignore */
    }
  }, [dragging, width]);

  const tags = useMemo(() => {
    const m = new Map<string, number>();
    docs.forEach((d) => d.tags.forEach((t) => m.set(t, (m.get(t) ?? 0) + 1)));
    const q = tagFilter.trim().toLowerCase();
    return [...m.entries()]
      .filter(([t]) => !q || t.toLowerCase().includes(q))
      .sort((a, b) => a[0].localeCompare(b[0], 'zh'));
  }, [docs, tagFilter]);

  const count = (v: LibraryView) => docs.filter((d) => matchesView(d, v)).length;
  const isActive = (v: LibraryView) => view.kind === v.kind && view.id === v.id;

  const smart: { v: LibraryView; label: string; icon: IconName }[] = [
    { v: { kind: 'all' }, label: '全部文献', icon: 'library' },
    { v: { kind: 'recent' }, label: '最近添加', icon: 'clock' },
    { v: { kind: 'starred' }, label: '星标', icon: 'star' },
    { v: { kind: 'unread' }, label: '未读', icon: 'circle' },
    { v: { kind: 'reading' }, label: '在读', icon: 'half' },
    { v: { kind: 'done' }, label: '已读', icon: 'done' },
    { v: { kind: 'nopdf' }, label: '无 PDF', icon: 'nofile' },
  ];

  const dropProps = (cid: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes(DRAG_TYPE)) {
        e.preventDefault();
        setOver(cid);
      }
    },
    onDragLeave: () => setOver(null),
    onDrop: (e: React.DragEvent) => {
      setOver(null);
      const raw = e.dataTransfer.getData(DRAG_TYPE);
      if (raw) {
        e.preventDefault();
        void addToCollection(JSON.parse(raw) as string[], cid);
      }
    },
  });

  return (
    <aside className="lib-side" style={{ width }}>
      <div className="lib-side-scroll">
        <div className="side-section" style={{ marginTop: 4 }}>
          <span>我的文库</span>
        </div>
        {smart.map((s) => (
          <button key={s.v.kind} className={`side-item${isActive(s.v) ? ' active' : ''}`} onClick={() => setView(s.v)}>
            <span className="side-ico">
              <Icon name={s.icon} size={14} />
            </span>
            <span className="side-name">{s.label}</span>
            <span className="count">{count(s.v)}</span>
          </button>
        ))}

        <div className="side-section">
          <span>分类</span>
          <button className="icon-btn" style={{ width: 22, height: 22 }} title="新建分类" onClick={() => setAdding(true)}>
            <Icon name="plus" size={13} />
          </button>
        </div>
        {adding && (
          <input
            className="input sm"
            style={{ width: 'calc(100% - 8px)', margin: '2px 4px 4px' }}
            autoFocus
            placeholder="分类名称，回车确认"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => (setAdding(false), setName(''))}
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && name.trim()) {
                const c = await createCollection(name);
                setAdding(false);
                setName('');
                setView({ kind: 'collection', id: c.id });
              } else if (e.key === 'Escape') setAdding(false);
            }}
          />
        )}
        {collections?.map((c) =>
          editing === c.id ? (
            <input
              key={c.id}
              className="input sm"
              style={{ width: 'calc(100% - 8px)', margin: '2px 4px' }}
              autoFocus
              defaultValue={c.name}
              onBlur={(e) => {
                if (e.target.value.trim()) void db.collections.update(c.id, { name: e.target.value.trim() });
                setEditing(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setEditing(null);
              }}
            />
          ) : (
            <div
              key={c.id}
              className={`side-item${isActive({ kind: 'collection', id: c.id }) ? ' active' : ''}${over === c.id ? ' drop' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => setView({ kind: 'collection', id: c.id })}
              onDoubleClick={() => setEditing(c.id)}
              {...dropProps(c.id)}
              title="双击重命名；把文献拖到这里加入分类"
            >
              <span className="side-ico">
                <Icon name="folder" size={14} />
              </span>
              <span className="side-name">{c.name}</span>
              <span className="count">{count({ kind: 'collection', id: c.id })}</span>
              <button
                className="side-del"
                title="删除分类（不删除文献）"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`删除分类「${c.name}」？其中的文献不会被删除。`)) {
                    void deleteCollection(c.id);
                    if (isActive({ kind: 'collection', id: c.id })) setView({ kind: 'all' });
                  }
                }}
              >
                ×
              </button>
            </div>
          ),
        )}
        {collections?.length === 0 && !adding && <div className="hint" style={{ padding: '2px 10px' }}>点 + 新建分类，拖动文献归类</div>}
      </div>

      {/* Zotero-style docked bottom Tag Selector */}
      <div className="tag-pane">
        <div className="tag-pane-head">
          <span className="row" style={{ gap: 5 }}>
            <Icon name="tag" size={12} /> 标签
          </span>
          {view.kind === 'tag' && (
            <button className="btn ghost sm" style={{ height: 20, padding: '0 4px' }} onClick={() => setView({ kind: 'all' })}>
              清除
            </button>
          )}
        </div>
        <div className="tag-pane-list">
          {tags.length === 0 ? (
            <span className="hint">{tagFilter ? '无匹配标签' : '暂无标签'}</span>
          ) : (
            tags.map(([t, n]) => (
              <button
                key={t}
                className={`tag-chip clickable${isActive({ kind: 'tag', id: t }) ? ' active' : ''}`}
                onClick={() => setView(isActive({ kind: 'tag', id: t }) ? { kind: 'all' } : { kind: 'tag', id: t })}
                onDoubleClick={() => {
                  const to = prompt(`重命名标签「${t}」为：`, t);
                  if (to && to !== t) void renameTag(t, to);
                }}
                title="点击筛选，双击重命名"
              >
                {t} <span className="count">{n}</span>
              </button>
            ))
          )}
        </div>
        <input
          className="tag-pane-filter"
          placeholder="筛选标签…"
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
        />
      </div>

      <div
        className={`pane-resizer right${dragging ? ' dragging' : ''}`}
        onPointerDown={(e) => {
          startRef.current = { x: e.clientX, w: width };
          setDragging(true);
          e.preventDefault();
        }}
      />
    </aside>
  );
}

function BulkBar({ docs }: { docs: DocRecord[] }) {
  const checked = useLibrary((s) => s.checked);
  const setChecked = useLibrary((s) => s.setChecked);
  const view = useLibrary((s) => s.view);
  const collections = useLiveQuery(() => db.collections.orderBy('order').toArray(), []);
  const [tagInput, setTagInput] = useState<string | null>(null);
  const tagRef = useRef<HTMLInputElement>(null);
  const items = docs.filter((d) => checked.includes(d.id));

  const exportCite = (style: string) => {
    if (style === 'bibtex') download('references.bib', toBibTeXLibrary(items.map((d) => ({ meta: d.meta }))), 'text/plain;charset=utf-8');
    else {
      const text = items.map((d, i) => (style === 'gbt7714' ? `[${i + 1}] ` : '') + formatCitation(d.meta, style as 'apa' | 'gbt7714')).join('\n');
      void navigator.clipboard.writeText(text);
      alert(`已复制 ${items.length} 条引用到剪贴板`);
    }
  };

  return (
    <div className="bulk-bar">
      <span>
        已选 <b>{checked.length}</b>
      </span>
      <button className="btn sm ghost" onClick={() => setChecked(checked.length === docs.length ? [] : docs.map((d) => d.id))}>
        {checked.length === docs.length ? '全不选' : '全选'}
      </button>
      <button
        className="btn sm"
        onClick={() => {
          const pdfs = items.filter((d) => d.hasPdf);
          pdfs.forEach((d, i) => openDocTab(d.id, { title: d.title, background: i < pdfs.length - 1 }));
        }}
        title="在顶部标签栏批量打开选中 PDF"
      >
        标签页打开
      </button>
      <select
        className="select sm"
        value=""
        onChange={(e) => {
          if (e.target.value) void addToCollection(checked, e.target.value);
        }}
      >
        <option value="">加入分类…</option>
        {collections?.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {view.kind === 'collection' && view.id && (
        <button className="btn sm" onClick={() => void removeFromCollection(checked, view.id!)}>
          移出分类
        </button>
      )}
      {tagInput === null ? (
        <button className="btn sm" onClick={() => (setTagInput(''), setTimeout(() => tagRef.current?.focus()))}>
          加标签
        </button>
      ) : (
        <input
          ref={tagRef}
          className="input sm"
          style={{ width: 140 }}
          placeholder="标签，回车确认"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onBlur={() => setTagInput(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && tagInput.trim()) {
              void addTags(checked, tagInput.split(/[,，]/));
              setTagInput(null);
            }
          }}
        />
      )}
      <select className="select sm" value="" onChange={(e) => e.target.value && void setStatus(checked, e.target.value as ReadStatus)}>
        <option value="">标记为…</option>
        <option value="unread">未读</option>
        <option value="reading">在读</option>
        <option value="done">已读</option>
      </select>
      <select className="select sm" value="" onChange={(e) => e.target.value && exportCite(e.target.value)}>
        <option value="">导出引用…</option>
        <option value="bibtex">BibTeX 文件 (.bib)</option>
        <option value="apa">复制 APA</option>
        <option value="gbt7714">复制 GB/T 7714</option>
      </select>
      <button
        className="btn sm danger"
        onClick={async () => {
          if (!confirm(`删除选中的 ${checked.length} 篇文献及其笔记、翻译缓存？此操作不可撤销。`)) return;
          for (const id of checked) await deleteDocument(id);
          setChecked([]);
        }}
      >
        删除
      </button>
      <div className="spacer" />
      <button className="icon-btn sm-ico" title="取消选择" onClick={() => setChecked([])}>
        <Icon name="close" size={15} />
      </button>
    </div>
  );
}

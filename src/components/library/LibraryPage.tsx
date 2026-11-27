import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { db, deleteDocument, type Collection, type DocRecord, type ReadStatus } from '../../db/db';
import { formatCitation } from '../../library/citation';
import { toBibTeXLibrary } from '../../library/bibtex';
import { scanDataTransfer, type FolderScanResult } from '../../library/folder';
import { authorName, authorsShort, STATUS_LABEL } from '../../library/format';
import {
  addTags,
  addToCollection,
  createCollection,
  deleteCollection,
  deleteCollectionAndDocs,
  emptyTrash,
  findDuplicateGroups,
  flattenCollectionTree,
  getDescendantCollectionIds,
  importFolderPdfs,
  importPdfFile,
  indexAll,
  moveCollection,
  removeFromCollection,
  renameCollection,
  renameTag,
  restoreDocs,
  searchFullText,
  setStarred,
  setStatus,
  trashDocs,
  type TextHit,
} from '../../library/service';
import { openDocTab, openSettings } from '../../lib/nav';
import { download } from '../../services/export';
import { useLibrary, type LibraryView, type SortKey, type StatusFilter } from '../../store/library';
import { TAG_COLOR_HEX, TAG_COLORS, useSettings } from '../../store/settings';
import { useTabs } from '../../store/tabs';
import { Icon, type IconName } from '../Icon';
import { DocDetail } from './DocDetail';
import { ImportDialog } from './ImportDialog';

const DRAG_TYPE = 'application/x-paperbridge-docs';
const COL_DRAG_TYPE = 'application/x-paperbridge-col';
const SIDE_WIDTH_KEY = 'paperbridge.libSideWidth';

function loadSideWidth() {
  try {
    const v = Number(localStorage.getItem(SIDE_WIDTH_KEY));
    if (v >= 170 && v <= 360) return v;
  } catch {
    /* ignore */
  }
  return 236;
}

function isRecentDoc(d: DocRecord): boolean {
  return Date.now() - Math.max(d.lastOpenedAt || 0, d.addedAt) < 14 * 86400_000;
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
  const collections = useLiveQuery(() => db.collections.orderBy('order').toArray(), []);
  const notes = useLiveQuery(() => db.notes.toArray(), []);
  const lib = useLibrary();
  const openTabs = useTabs((s) => s.tabs);
  const [importOpen, setImportOpen] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const [busy, setBusy] = useState('');
  const [hits, setHits] = useState<Map<string, TextHit[]> | null>(null);
  const [indexing, setIndexing] = useState<string>('');
  const [ctxMenu, setCtxMenu] = useState<{ doc: DocRecord; x: number; y: number } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hasProvider = useSettings((s) => s.providers.length > 0);
  const openDocIds = useMemo(() => new Set(openTabs.map((t) => t.docId)), [openTabs]);
  const docsWithNotes = useMemo(() => new Set((notes ?? []).map((n) => n.docId)), [notes]);

  const activeDocs = useMemo(() => (docs ?? []).filter((d) => !d.deletedAt), [docs]);
  const trashedDocs = useMemo(() => (docs ?? []).filter((d) => !!d.deletedAt), [docs]);
  const dupGroups = useMemo(() => findDuplicateGroups(activeDocs), [activeDocs]);
  const dupGroupIndex = useMemo(() => {
    const m = new Map<string, number>();
    dupGroups.forEach((g, idx) => g.forEach((d) => m.set(d.id, idx + 1)));
    return m;
  }, [dupGroups]);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setCtxMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

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

  const isTrash = lib.view.kind === 'trash';
  const activeHits = lib.fullText && q.length >= 2 ? hits : null;

  // Base set of docs in the currently selected sidebar view (before stackable filter strip)
  const viewBase = useMemo(() => {
    const v = lib.view;
    if (v.kind === 'trash') return trashedDocs;
    if (v.kind === 'recent') return activeDocs.filter(isRecentDoc);
    if (v.kind === 'unfiled') return activeDocs.filter((d) => d.collectionIds.length === 0);
    if (v.kind === 'duplicates') return activeDocs.filter((d) => dupGroupIndex.has(d.id));
    if (v.kind === 'collection' && v.id) {
      const ids = getDescendantCollectionIds(collections ?? [], v.id);
      return activeDocs.filter((d) => d.collectionIds.some((c) => ids.has(c)));
    }
    if (v.kind === 'tag' && v.id) return activeDocs.filter((d) => d.tags.includes(v.id!));
    return activeDocs;
  }, [activeDocs, trashedDocs, lib.view, collections, dupGroupIndex]);

  const hasFilters = !isTrash && (lib.statusFilter !== 'all' || lib.onlyStarred || lib.onlyWithNotes || lib.onlyNoPdf);

  const shown = useMemo(() => {
    let list = viewBase.filter((d) => {
      if (!isTrash) {
        if (lib.statusFilter !== 'all' && d.status !== lib.statusFilter) return false;
        if (lib.onlyStarred && !d.starred) return false;
        if (lib.onlyWithNotes && !docsWithNotes.has(d.id)) return false;
        if (lib.onlyNoPdf && d.hasPdf) return false;
      }
      return matchesQuery(d, q) || !!activeHits?.get(d.id)?.length;
    });
    if (lib.view.kind === 'duplicates') {
      list = [...list].sort((a, b) => (dupGroupIndex.get(a.id) ?? 0) - (dupGroupIndex.get(b.id) ?? 0) || a.addedAt - b.addedAt);
    } else {
      list = [...list].sort(sorters[lib.sort]);
      if (lib.sortDesc) list.reverse();
    }
    return list;
  }, [
    viewBase,
    isTrash,
    lib.statusFilter,
    lib.onlyStarred,
    lib.onlyWithNotes,
    lib.onlyNoPdf,
    docsWithNotes,
    q,
    activeHits,
    lib.view.kind,
    dupGroupIndex,
    lib.sort,
    lib.sortDesc,
  ]);

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

  const importFolderScan = async (scanPromise: Promise<FolderScanResult>, explicitParentId?: string | null) => {
    setBusy('正在扫描文件夹中的 PDF…');
    try {
      const scan = await scanPromise;
      if (!scan.items.length) {
        setBusy(scan.ignoredCount > 0 ? `未发现 PDF 文件（已忽略 ${scan.ignoredCount} 个非 PDF 文件）` : '');
        if (scan.ignoredCount > 0) setTimeout(() => setBusy((cur) => (cur.startsWith('未发现 PDF') ? '' : cur)), 3500);
        return;
      }
      // Folder drops/uploads default to top-level (sibling with existing folders) unless a target parent
      // was explicitly chosen (via ImportDialog dropdown or dropping directly onto a sidebar folder).
      // Loose PDF drops still go into the currently open collection.
      const parentId =
        explicitParentId !== undefined
          ? explicitParentId
          : scan.hasFolders
            ? null
            : lib.view.kind === 'collection'
              ? lib.view.id ?? null
              : null;
      const summary = await importFolderPdfs(scan.items, {
        parentCollectionId: parentId,
        ignoredCount: scan.ignoredCount,
        onProgress: setBusy,
      });
      for (const cid of summary.touchedCollectionIds) {
        lib.setColExpanded(cid, true);
      }
      if (summary.lastDocId) lib.select(summary.lastDocId);
      const parts = [
        `新增 ${summary.added} 篇 PDF`,
        summary.collectionsCreated > 0 ? `新建 ${summary.collectionsCreated} 个分类` : '',
        summary.duplicates > 0 ? `${summary.duplicates} 篇已在库中（已归入对应分类）` : '',
        summary.ignored > 0 ? `忽略 ${summary.ignored} 个非 PDF` : '',
        summary.failed > 0 ? `${summary.failed} 篇失败` : '',
      ].filter(Boolean);
      const doneText = `导入完成：${parts.join('，')}`;
      setBusy(doneText);
      setTimeout(() => setBusy((cur) => (cur === doneText ? '' : cur)), 5000);
    } catch (e) {
      setBusy('');
      alert(`导入文件夹失败：${(e as Error).message}`);
    }
  };

  const allShownChecked = shown.length > 0 && shown.every((d) => lib.checked.includes(d.id));
  const sortArrow = (k: SortKey) => (lib.sort === k ? (lib.sortDesc ? ' ↓' : ' ↑') : '');

  // Counts for stackable filter pills inside the current view
  const filterCounts = useMemo(() => {
    let unread = 0;
    let reading = 0;
    let done = 0;
    let starred = 0;
    let withNotes = 0;
    let noPdf = 0;
    for (const d of viewBase) {
      if (d.status === 'unread') unread++;
      else if (d.status === 'reading') reading++;
      else if (d.status === 'done') done++;
      if (d.starred) starred++;
      if (docsWithNotes.has(d.id)) withNotes++;
      if (!d.hasPdf) noPdf++;
    }
    return { unread, reading, done, starred, withNotes, noPdf };
  }, [viewBase, docsWithNotes]);

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
        {drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}
        <Sidebar
          activeDocs={activeDocs}
          trashedCount={trashedDocs.length}
          dupCount={dupGroupIndex.size}
          collections={collections ?? []}
          drawerOpen={drawerOpen}
          onCloseDrawer={() => setDrawerOpen(false)}
          onDropFolder={(scan, targetColId) => void importFolderScan(scan, targetColId)}
        />
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
            if (!e.dataTransfer.files.length && !e.dataTransfer.items?.length) return;
            e.preventDefault();
            void importFolderScan(scanDataTransfer(e.dataTransfer));
          }}
        >
          {/* Zotero-style compact action & search toolbar */}
          <div className="lib-toolbar">
            <button
              className="icon-btn sm-ico drawer-toggle-btn"
              title="打开分类与标签侧栏"
              onClick={() => setDrawerOpen((v) => !v)}
            >
              <Icon name="folder" size={15} />
            </button>
            <button className="btn sm primary" onClick={() => setImportOpen(true)} title="导入 PDF / DOI / arXiv / BibTeX / 知网">
              <Icon name="plus" size={14} /> 导入
            </button>
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

          {/* Stackable inline filter bar (works inside ANY collection / tag / view!) */}
          {!isTrash && (
            <div className="filter-strip">
              <div className="filter-group" role="group" aria-label="阅读状态筛选">
                {(
                  [
                    ['all', '全部', viewBase.length],
                    ['unread', '未读', filterCounts.unread],
                    ['reading', '在读', filterCounts.reading],
                    ['done', '已读', filterCounts.done],
                  ] as [StatusFilter, string, number][]
                ).map(([k, label, n]) => (
                  <button
                    key={k}
                    className={`filter-pill${lib.statusFilter === k ? ' active' : ''}`}
                    onClick={() => lib.setStatusFilter(k)}
                  >
                    {label}
                    {k !== 'all' && n > 0 && <span className="filter-n">{n}</span>}
                  </button>
                ))}
              </div>
              <span className="filter-sep" />
              <button
                className={`filter-pill${lib.onlyStarred ? ' active' : ''}`}
                onClick={lib.toggleOnlyStarred}
                title="仅显示星标文献"
              >
                ★ 星标{filterCounts.starred > 0 && <span className="filter-n">{filterCounts.starred}</span>}
              </button>
              <button
                className={`filter-pill${lib.onlyWithNotes ? ' active' : ''}`}
                onClick={lib.toggleOnlyWithNotes}
                title="仅显示有高亮或批注的文献"
              >
                有笔记{filterCounts.withNotes > 0 && <span className="filter-n">{filterCounts.withNotes}</span>}
              </button>
              {filterCounts.noPdf > 0 && (
                <button
                  className={`filter-pill${lib.onlyNoPdf ? ' active' : ''}`}
                  onClick={lib.toggleOnlyNoPdf}
                  title="仅显示缺少 PDF 附件的题录条目"
                >
                  无 PDF<span className="filter-n">{filterCounts.noPdf}</span>
                </button>
              )}
              <div className="spacer" />
              {hasFilters && (
                <button className="btn ghost sm" style={{ height: 22, fontSize: 11.5 }} onClick={lib.clearFilters}>
                  重置筛选
                </button>
              )}
            </div>
          )}

          {/* Trash banner */}
          {isTrash && (
            <div className="trash-banner">
              <Icon name="trash" size={14} />
              <span>
                回收站（{trashedDocs.length} 篇）— 这里的文献可随时还原，清空后才会永久删除 PDF、笔记和翻译缓存。
              </span>
              <div className="spacer" />
              {trashedDocs.length > 0 && (
                <>
                  <button className="btn sm" onClick={() => void restoreDocs(trashedDocs.map((d) => d.id))}>
                    全部还原
                  </button>
                  <button
                    className="btn sm danger"
                    onClick={async () => {
                      if (!confirm(`永久清空回收站中的 ${trashedDocs.length} 篇文献？此操作不可撤销。`)) return;
                      await emptyTrash();
                      lib.select(null);
                      lib.setChecked([]);
                    }}
                  >
                    清空回收站
                  </button>
                </>
              )}
            </div>
          )}

          {/* Duplicates info banner */}
          {lib.view.kind === 'duplicates' && dupGroups.length > 0 && (
            <div className="trash-banner info">
              <Icon name="copy" size={14} />
              <span>
                检测到 {dupGroups.length} 组疑似重复文献（按 DOI / arXiv / 标题匹配）。右键多余条目可移入回收站。
              </span>
            </div>
          )}

          {(busy || indexing) && (
            <div className="hint row" style={{ padding: '4px 12px 6px' }}>
              <span className="spinner" /> {busy || indexing}
            </div>
          )}
          {lib.checked.length > 0 && <BulkBar docs={shown} collections={collections ?? []} isTrash={isTrash} />}

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
                {activeDocs.length === 0 && !isTrash ? (
                  <>
                    <Icon name="upload" size={28} />
                    <p>把 PDF 或整个文献文件夹拖到这里，或点击左上角「导入」。</p>
                    <p className="hint">拖入文件夹会自动只导入其中的 PDF 并保留子文件夹嵌套分类；也支持 DOI / arXiv / 知网 BibTeX。</p>
                  </>
                ) : isTrash ? (
                  '回收站是空的'
                ) : lib.view.kind === 'duplicates' ? (
                  '太棒了，文库中没有发现重复文献'
                ) : lib.view.kind === 'unfiled' && !hasFilters && !q ? (
                  '所有文献都已归类整理完毕'
                ) : (
                  '没有符合当前筛选条件的文献'
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
                isTrash={isTrash}
                hasNotes={docsWithNotes.has(d.id)}
                dupGroup={lib.view.kind === 'duplicates' ? dupGroupIndex.get(d.id) : undefined}
                hits={activeHits?.get(d.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu({ doc: d, x: e.clientX, y: e.clientY });
                }}
                onOpenMenu={(x, y) => setCtxMenu({ doc: d, x, y })}
              />
            ))}
          </div>
        </main>
        {selected && <DocDetail doc={selected} onClose={() => lib.select(null)} />}
      </div>
      {ctxMenu && <DocContextMenu doc={ctxMenu.doc} x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)} />}
      {importOpen && (
        <ImportDialog
          collectionId={lib.view.kind === 'collection' ? lib.view.id : undefined}
          collections={collections ?? []}
          onFiles={(f) => void importFiles(f)}
          onFolderScan={(scan, parentId) => void importFolderScan(scan, parentId)}
          onClose={() => setImportOpen(false)}
          onImported={(id) => lib.select(id)}
        />
      )}
    </div>
  );
}

function DocRow({
  d,
  stripe,
  layout,
  isOpen,
  isTrash,
  hasNotes,
  dupGroup,
  hits,
  onContextMenu,
  onOpenMenu,
}: {
  d: DocRecord;
  stripe: boolean;
  layout: 'table' | 'list';
  isOpen: boolean;
  isTrash: boolean;
  hasNotes: boolean;
  dupGroup?: number;
  hits?: TextHit[];
  onContextMenu: (e: React.MouseEvent) => void;
  onOpenMenu: (x: number, y: number) => void;
}) {
  const selected = useLibrary((s) => s.selectedId === d.id);
  const checked = useLibrary((s) => s.checked.includes(d.id));
  const select = useLibrary((s) => s.select);
  const toggleCheck = useLibrary((s) => s.toggleCheck);
  const tagColors = useSettings((s) => s.tagColors ?? {});
  const open = (background = false) =>
    !isTrash && d.hasPdf ? openDocTab(d.id, { title: d.title, background }) : select(d.id);

  // Colored dots from Zotero-style colored tags on this doc
  const coloredTags = d.tags.filter((t) => !!tagColors[t]);

  const dragProps = isTrash
    ? {}
    : {
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
        onClick={(e) => open(e.ctrlKey || e.metaKey)}
        onContextMenu={onContextMenu}
        onAuxClick={(e) => {
          if (e.button === 1 && !isTrash && d.hasPdf) {
            e.preventDefault();
            open(true);
          }
        }}
        onKeyDown={(e) => e.key === 'Enter' && open(e.ctrlKey || e.metaKey)}
        tabIndex={0}
        title={isTrash ? '单击查看详情 · 右键还原或彻底删除' : '单击打开阅读 · 右键查看详情与更多操作 · 中键后台打开'}
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
            {isOpen && !isTrash && <span className="open-dot" title="已在顶部标签页打开" />}
            {coloredTags.map((t) => (
              <span
                key={t}
                className="tag-color-dot"
                style={{ background: TAG_COLOR_HEX[tagColors[t]] }}
                title={`彩色标签：${t}`}
              />
            ))}
            {dupGroup !== undefined && <span className="dup-badge">重复 #{dupGroup}</span>}
            <span className="doc-title-text">{d.title}</span>
            {hasNotes && (
              <span className="doc-note-ico hide-sm" title="含高亮或笔记">
                <Icon name="notes" size={12} />
              </span>
            )}
            {d.tags.length > 0 && (
              <span className="inline-tags hide-sm">
                {d.tags.slice(0, 2).map((t) => (
                  <span key={t} className="tag-chip mini">
                    {tagColors[t] && <span className="tag-color-dot sm" style={{ background: TAG_COLOR_HEX[tagColors[t]] }} />}
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
            <button
              type="button"
              className="icon-btn row-more-btn"
              title="查看详情与更多操作"
              aria-label="更多操作"
              onClick={(e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                onOpenMenu(r.right - 208, r.bottom + 4);
              }}
            >
              <Icon name="more" size={14} />
            </button>
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
      onClick={(e) => open(e.ctrlKey || e.metaKey)}
      onContextMenu={onContextMenu}
      onAuxClick={(e) => {
        if (e.button === 1 && !isTrash && d.hasPdf) {
          e.preventDefault();
          open(true);
        }
      }}
      onKeyDown={(e) => e.key === 'Enter' && open(e.ctrlKey || e.metaKey)}
      tabIndex={0}
      title={isTrash ? '单击查看详情 · 右键还原或彻底删除' : '单击打开阅读 · 右键查看详情与更多操作 · 中键后台打开'}
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
          {isOpen && !isTrash && <span className="open-dot" title="已在顶部标签页打开" />}
          {coloredTags.map((t) => (
            <span
              key={t}
              className="tag-color-dot"
              style={{ background: TAG_COLOR_HEX[tagColors[t]] }}
              title={`彩色标签：${t}`}
            />
          ))}
          {dupGroup !== undefined && <span className="dup-badge">重复 #{dupGroup}</span>}
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
                {tagColors[t] && <span className="tag-color-dot sm" style={{ background: TAG_COLOR_HEX[tagColors[t]] }} />}
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
      {isTrash ? (
        <button className="btn sm hide-sm" onClick={(e) => (e.stopPropagation(), void restoreDocs([d.id]))}>
          还原
        </button>
      ) : (
        <button className="btn sm hide-sm" onClick={(e) => (e.stopPropagation(), select(d.id))}>
          详情
        </button>
      )}
    </div>
  );
}

function DocContextMenu({ doc, x, y, onClose }: { doc: DocRecord; x: number; y: number; onClose: () => void }) {
  const select = useLibrary((s) => s.select);
  const isTrash = !!doc.deletedAt;
  const left = Math.max(8, Math.min(x, window.innerWidth - 220));
  const top = Math.max(8, Math.min(y, window.innerHeight - (isTrash ? 160 : 340)));

  const copyCite = (style: 'apa' | 'gbt7714') => {
    void navigator.clipboard.writeText(formatCitation(doc.meta, style));
    onClose();
  };

  if (isTrash) {
    return (
      <div className="ctx-menu" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
        <button
          className="ctx-item"
          onClick={() => {
            void restoreDocs([doc.id]);
            onClose();
          }}
        >
          还原到我的文库
        </button>
        <button
          className="ctx-item"
          onClick={() => {
            select(doc.id);
            onClose();
          }}
        >
          查看详情
        </button>
        <div className="ctx-sep" />
        <button
          className="ctx-item danger"
          onClick={async () => {
            onClose();
            if (!confirm(`永久删除「${doc.title}」及其笔记、翻译缓存？此操作不可撤销。`)) return;
            if (useLibrary.getState().selectedId === doc.id) select(null);
            await deleteDocument(doc.id);
          }}
        >
          彻底删除
        </button>
      </div>
    );
  }

  return (
    <div className="ctx-menu" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <button
        className="ctx-item"
        onClick={() => {
          select(doc.id);
          onClose();
        }}
      >
        查看详情 / 编辑题录
      </button>
      {doc.hasPdf && (
        <>
          <button
            className="ctx-item"
            onClick={() => {
              openDocTab(doc.id, { title: doc.title, background: false });
              onClose();
            }}
          >
            打开阅读
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              openDocTab(doc.id, { title: doc.title, background: true });
              onClose();
            }}
          >
            在后台标签页打开
          </button>
        </>
      )}
      <div className="ctx-sep" />
      <button
        className="ctx-item"
        onClick={() => {
          void setStarred([doc.id], !doc.starred);
          onClose();
        }}
      >
        {doc.starred ? '取消星标' : '添加星标'}
      </button>
      <div className="ctx-status-row">
        <span className="hint" style={{ fontSize: 11.5 }}>状态</span>
        {(['unread', 'reading', 'done'] as ReadStatus[]).map((st) => (
          <button
            key={st}
            className={`ctx-pill${doc.status === st ? ' active' : ''}`}
            onClick={() => {
              void setStatus([doc.id], st);
              onClose();
            }}
          >
            {STATUS_LABEL[st]}
          </button>
        ))}
      </div>
      <div className="ctx-sep" />
      <button className="ctx-item" onClick={() => copyCite('apa')}>
        复制引用（APA）
      </button>
      <button className="ctx-item" onClick={() => copyCite('gbt7714')}>
        复制引用（GB/T 7714）
      </button>
      <button
        className="ctx-item"
        onClick={() => {
          download(`${doc.title.slice(0, 40) || 'reference'}.bib`, toBibTeXLibrary([{ meta: doc.meta }]), 'text/plain;charset=utf-8');
          onClose();
        }}
      >
        导出 BibTeX (.bib)
      </button>
      <div className="ctx-sep" />
      <button
        className="ctx-item danger"
        onClick={async () => {
          onClose();
          useTabs.getState().closeTab(doc.id);
          if (useLibrary.getState().selectedId === doc.id) select(null);
          await trashDocs([doc.id]);
        }}
      >
        移入回收站
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- Zotero-style Sidebar

function Sidebar({
  activeDocs,
  trashedCount,
  dupCount,
  collections,
  drawerOpen,
  onCloseDrawer,
  onDropFolder,
}: {
  activeDocs: DocRecord[];
  trashedCount: number;
  dupCount: number;
  collections: Collection[];
  drawerOpen: boolean;
  onCloseDrawer: () => void;
  onDropFolder: (scan: Promise<FolderScanResult>, parentCollectionId: string | null) => void;
}) {
  const view = useLibrary((s) => s.view);
  const rawSetView = useLibrary((s) => s.setView);
  const setView = (v: LibraryView) => {
    rawSetView(v);
    onCloseDrawer();
  };
  const expandedCols = useLibrary((s) => s.expandedCols);
  const toggleColExpanded = useLibrary((s) => s.toggleColExpanded);
  const setColExpanded = useLibrary((s) => s.setColExpanded);
  const tagColors = useSettings((s) => s.tagColors ?? {});
  const setTagColor = useSettings((s) => s.setTagColor);

  const [addingParent, setAddingParent] = useState<string | null | undefined>(undefined); // undefined = closed, null = root, string = parentId
  const [newName, setNewName] = useState('');
  const [overTarget, setOverTarget] = useState<string | null>(null);
  const [editingCol, setEditingCol] = useState<string | null>(null);
  const [colMenu, setColMenu] = useState<{ col: Collection; x: number; y: number } | null>(null);
  const [tagMenu, setTagMenu] = useState<{ tag: string; x: number; y: number } | null>(null);
  const [colFilter, setColFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [tagsCollapsed, setTagsCollapsed] = useState(false);
  const [width, setWidth] = useState(loadSideWidth);
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => {
    if (!colMenu && !tagMenu) return;
    const close = () => {
      setColMenu(null);
      setTagMenu(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [colMenu, tagMenu]);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const s = startRef.current;
      if (!s) return;
      setWidth(Math.max(170, Math.min(440, s.w + (e.clientX - s.x))));
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

  // Build recursive tree rows respecting collapsed parent state & optional quick folder search
  const tree = useMemo(() => flattenCollectionTree(collections), [collections]);
  const visibleTree = useMemo(() => {
    const parentById = new Map(collections.map((c) => [c.id, c.parentId ?? null]));
    const fq = colFilter.trim().toLowerCase();
    if (fq) {
      // Keep every matching folder AND all of its ancestor folders so hierarchy context stays clear
      const keep = new Set<string>();
      for (const c of collections) {
        if (!c.name.toLowerCase().includes(fq)) continue;
        let cur: string | null = c.id;
        while (cur && !keep.has(cur)) {
          keep.add(cur);
          cur = parentById.get(cur) ?? null;
        }
      }
      return tree.filter((item) => keep.has(item.col.id));
    }
    const isHidden = (id: string) => {
      let cur = parentById.get(id) ?? null;
      const seen = new Set<string>([id]);
      while (cur && !seen.has(cur)) {
        if (expandedCols[cur] === false) return true;
        seen.add(cur);
        cur = parentById.get(cur) ?? null;
      }
      return false;
    };
    return tree.filter((item) => !isHidden(item.col.id));
  }, [tree, collections, expandedCols, colFilter]);

  const anyExpandable = useMemo(() => tree.some((t) => t.hasChildren), [tree]);
  const allCollapsed = useMemo(
    () => anyExpandable && tree.filter((t) => t.hasChildren).every((t) => expandedCols[t.col.id] === false),
    [tree, expandedCols, anyExpandable],
  );
  const toggleAllFolders = () => {
    const targetOpen = allCollapsed;
    for (const t of tree) {
      if (t.hasChildren) setColExpanded(t.col.id, targetOpen);
    }
  };

  // Recursive count for each collection
  const colCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of collections) {
      const ids = getDescendantCollectionIds(collections, c.id);
      let n = 0;
      for (const d of activeDocs) if (d.collectionIds.some((cid) => ids.has(cid))) n++;
      map.set(c.id, n);
    }
    return map;
  }, [collections, activeDocs]);

  const tags = useMemo(() => {
    const m = new Map<string, number>();
    activeDocs.forEach((d) => d.tags.forEach((t) => m.set(t, (m.get(t) ?? 0) + 1)));
    const q = tagFilter.trim().toLowerCase();
    return [...m.entries()]
      .filter(([t]) => !q || t.toLowerCase().includes(q))
      .sort((a, b) => {
        const ca = tagColors[a[0]] ? 0 : 1;
        const cb = tagColors[b[0]] ? 0 : 1;
        return ca - cb || a[0].localeCompare(b[0], 'zh');
      });
  }, [activeDocs, tagFilter, tagColors]);

  const recentCount = useMemo(() => activeDocs.filter(isRecentDoc).length, [activeDocs]);
  const unfiledCount = useMemo(() => activeDocs.filter((d) => d.collectionIds.length === 0).length, [activeDocs]);

  const isActive = (v: LibraryView) => view.kind === v.kind && view.id === v.id;

  const startNewCol = (parentId: string | null) => {
    if (parentId) setColExpanded(parentId, true);
    setAddingParent(parentId);
    setNewName('');
  };

  const commitNewCol = async () => {
    const name = newName.trim();
    const pid = addingParent ?? null;
    setAddingParent(undefined);
    setNewName('');
    if (!name) return;
    const c = await createCollection(name, pid);
    setView({ kind: 'collection', id: c.id });
  };

  const dropOnCol = (cid: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (
        e.dataTransfer.types.includes(DRAG_TYPE) ||
        e.dataTransfer.types.includes(COL_DRAG_TYPE) ||
        e.dataTransfer.types.includes('Files')
      ) {
        e.preventDefault();
        e.stopPropagation();
        setOverTarget(cid ?? '__root__');
      }
    },
    onDragLeave: () => setOverTarget(null),
    onDrop: (e: React.DragEvent) => {
      setOverTarget(null);
      const docRaw = e.dataTransfer.getData(DRAG_TYPE);
      if (docRaw && cid) {
        e.preventDefault();
        e.stopPropagation();
        void addToCollection(JSON.parse(docRaw) as string[], cid);
        return;
      }
      const colId = e.dataTransfer.getData(COL_DRAG_TYPE);
      if (colId && colId !== cid) {
        e.preventDefault();
        e.stopPropagation();
        void moveCollection(colId, cid);
        if (cid) setColExpanded(cid, true);
        return;
      }
      if (e.dataTransfer.files.length || e.dataTransfer.items?.length) {
        e.preventDefault();
        e.stopPropagation();
        onDropFolder(scanDataTransfer(e.dataTransfer), cid);
      }
    },
  });

  const systemViews: { v: LibraryView; label: string; icon: IconName; count: number; highlight?: boolean }[] = [
    { v: { kind: 'recent' }, label: '最近阅读', icon: 'clock', count: recentCount },
    { v: { kind: 'unfiled' }, label: '未分类条目', icon: 'inbox', count: unfiledCount },
    { v: { kind: 'duplicates' }, label: '重复条目', icon: 'copy', count: dupCount, highlight: dupCount > 0 },
    { v: { kind: 'trash' }, label: '回收站', icon: 'trash', count: trashedCount },
  ];

  const renderInlineNewInput = (depth: number) => (
    <input
      className="input sm"
      style={{ width: `calc(100% - ${12 + depth * 14}px)`, marginLeft: 8 + depth * 14, marginTop: 2, marginBottom: 4 }}
      autoFocus
      placeholder={depth === 0 ? '新分类名称，回车确认' : '子分类名称，回车确认'}
      value={newName}
      onChange={(e) => setNewName(e.target.value)}
      onBlur={() => {
        setAddingParent(undefined);
        setNewName('');
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commitNewCol();
        else if (e.key === 'Escape') {
          setAddingParent(undefined);
          setNewName('');
        }
      }}
    />
  );

  return (
    <aside className={`lib-side${drawerOpen ? ' drawer-open' : ''}`} style={{ width }}>
      <div className="drawer-head">
        <span>文库与分类</span>
        <button className="icon-btn sm-ico" onClick={onCloseDrawer} title="关闭侧栏">
          <Icon name="close" size={15} />
        </button>
      </div>
      {/* Pinned root header + quick folder filter */}
      <div className="side-top">
        <div
          className={`side-item root-item${isActive({ kind: 'all' }) ? ' active' : ''}${overTarget === '__root__' ? ' drop' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => setView({ kind: 'all' })}
          {...dropOnCol(null)}
          title="查看全部文献 · 将子分类或本地文件夹拖到此处可放到顶层"
        >
          <span className="side-ico">
            <Icon name="library" size={14} />
          </span>
          <span className="side-name" style={{ fontWeight: 600 }}>
            我的文库
          </span>
          <span className="count">{activeDocs.length}</span>
          {anyExpandable && (
            <button
              className="side-add"
              title={allCollapsed ? '展开全部子分类' : '折叠全部子分类'}
              onClick={(e) => {
                e.stopPropagation();
                toggleAllFolders();
              }}
            >
              <Icon name={allCollapsed ? 'next' : 'down'} size={12} />
            </button>
          )}
          <button
            className="side-add"
            title="新建顶层分类"
            onClick={(e) => {
              e.stopPropagation();
              startNewCol(null);
            }}
          >
            <Icon name="plus" size={13} />
          </button>
        </div>

        {collections.length >= 4 && (
          <div className="side-col-filter">
            <input
              className="input sm"
              placeholder={`筛选 ${collections.length} 个分类…`}
              value={colFilter}
              onChange={(e) => setColFilter(e.target.value)}
            />
            {colFilter && (
              <button className="side-col-clear" onClick={() => setColFilter('')} title="清空筛选">
                ×
              </button>
            )}
          </div>
        )}
      </div>

      {/* Independently scrollable collection tree */}
      <div className="lib-side-scroll">
        {addingParent === null && renderInlineNewInput(0)}

        {visibleTree.map(({ col: c, depth, hasChildren }) => {
          const isOpen = colFilter.trim() ? true : expandedCols[c.id] !== false;
          const indent = Math.min(depth, 5) * 12;
          const count = colCounts.get(c.id) ?? 0;
          return (
            <div key={c.id}>
              {editingCol === c.id ? (
                <input
                  className="input sm"
                  style={{ width: `calc(100% - ${16 + indent}px)`, marginLeft: 12 + indent, marginTop: 2, marginBottom: 2 }}
                  autoFocus
                  defaultValue={c.name}
                  onBlur={(e) => {
                    if (e.target.value.trim()) void renameCollection(c.id, e.target.value);
                    setEditingCol(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setEditingCol(null);
                  }}
                />
              ) : (
                <div
                  className={`side-item tree-item${isActive({ kind: 'collection', id: c.id }) ? ' active' : ''}${overTarget === c.id ? ' drop' : ''}`}
                  style={{ paddingLeft: 10 + indent }}
                  role="button"
                  tabIndex={0}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(COL_DRAG_TYPE, c.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onClick={() => setView({ kind: 'collection', id: c.id })}
                  onDoubleClick={() => setEditingCol(c.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setTagMenu(null);
                    setColMenu({ col: c, x: e.clientX, y: e.clientY });
                  }}
                  {...dropOnCol(c.id)}
                  title={`${c.name}（${count} 篇）\n单击查看 · 双击重命名 · 右键管理 · 拖入本地文件夹可作为子分类导入`}
                >
                  {hasChildren ? (
                    <button
                      type="button"
                      className="tree-caret"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleColExpanded(c.id);
                      }}
                      title={isOpen ? '折叠子分类' : '展开子分类'}
                    >
                      <Icon name={isOpen ? 'down' : 'next'} size={11} />
                    </button>
                  ) : (
                    <span className="tree-caret-pad" />
                  )}
                  <span className="side-ico">
                    <Icon name="folder" size={14} />
                  </span>
                  <span className="side-name">{c.name}</span>
                  <span className="count">{count}</span>
                  <button
                    className="side-add"
                    title="新建子分类"
                    onClick={(e) => {
                      e.stopPropagation();
                      startNewCol(c.id);
                    }}
                  >
                    <Icon name="plus" size={12} />
                  </button>
                  <button
                    className="side-more-touch"
                    title="分类操作"
                    onClick={(e) => {
                      e.stopPropagation();
                      const r = e.currentTarget.getBoundingClientRect();
                      setTagMenu(null);
                      setColMenu({ col: c, x: r.left, y: r.bottom + 4 });
                    }}
                  >
                    <Icon name="more" size={13} />
                  </button>
                </div>
              )}
              {addingParent === c.id && renderInlineNewInput(Math.min(depth + 1, 5))}
            </div>
          );
        })}

        {collections.length === 0 && addingParent === undefined && (
          <button className="side-empty-cta" onClick={() => startNewCol(null)}>
            + 新建课题分类（支持多级子目录）
          </button>
        )}
        {collections.length > 0 && visibleTree.length === 0 && colFilter.trim() && (
          <div className="hint" style={{ padding: '6px 12px', fontSize: 12 }}>
            无匹配分类
          </div>
        )}
      </div>

      {/* Pinned Zotero system views: always reachable even with 100+ folders */}
      <div className="side-sys">
        {systemViews.map((s) => (
          <button
            key={s.v.kind}
            className={`side-item${isActive(s.v) ? ' active' : ''}`}
            onClick={() => setView(s.v)}
          >
            <span className="side-ico">
              <Icon name={s.icon} size={14} />
            </span>
            <span className="side-name">{s.label}</span>
            <span className={`count${s.highlight ? ' warn' : ''}`}>{s.count}</span>
          </button>
        ))}
      </div>

      {/* Collapsible Zotero-style bottom Tag Selector */}
      <div className={`tag-pane${tagsCollapsed ? ' collapsed' : ''}`}>
        <div
          className="tag-pane-head"
          role="button"
          tabIndex={0}
          onClick={() => setTagsCollapsed((v) => !v)}
          title={tagsCollapsed ? '展开标签栏' : '折叠标签栏（给上方分类树腾出更多空间）'}
          style={{ cursor: 'pointer' }}
        >
          <span className="row" style={{ gap: 5 }}>
            <Icon name={tagsCollapsed ? 'next' : 'down'} size={11} />
            <Icon name="tag" size={12} /> 标签{tags.length > 0 ? ` (${tags.length})` : ''}
          </span>
          {view.kind === 'tag' && (
            <button
              className="btn ghost sm"
              style={{ height: 20, padding: '0 4px' }}
              onClick={(e) => {
                e.stopPropagation();
                setView({ kind: 'all' });
              }}
            >
              清除
            </button>
          )}
        </div>
        <div className="tag-pane-list">
          {tags.length === 0 ? (
            <span className="hint">{tagFilter ? '无匹配标签' : '暂无标签（右键可设颜色）'}</span>
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
                onContextMenu={(e) => {
                  e.preventDefault();
                  setColMenu(null);
                  setTagMenu({ tag: t, x: e.clientX, y: e.clientY });
                }}
                title="单击筛选 · 右键设置彩色标签或重命名"
              >
                {tagColors[t] && <span className="tag-color-dot sm" style={{ background: TAG_COLOR_HEX[tagColors[t]] }} />}
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

      {/* Collection right-click context menu */}
      {colMenu && (
        <div
          className="ctx-menu"
          style={{ left: Math.max(8, Math.min(colMenu.x, window.innerWidth - 236)), top: Math.max(8, Math.min(colMenu.y, window.innerHeight - 236)) }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            className="ctx-item"
            onClick={() => {
              startNewCol(colMenu.col.id);
              setColMenu(null);
            }}
          >
            新建子分类
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              setEditingCol(colMenu.col.id);
              setColMenu(null);
            }}
          >
            重命名
          </button>
          {colMenu.col.parentId && (
            <button
              className="ctx-item"
              onClick={() => {
                void moveCollection(colMenu.col.id, null);
                setColMenu(null);
              }}
            >
              移至顶层分类
            </button>
          )}
          <div className="ctx-sep" />
          <button
            className="ctx-item danger"
            onClick={() => {
              const target = colMenu.col;
              setColMenu(null);
              if (confirm(`删除分类「${target.name}」及其子分类？其中的文献不会被删除。`)) {
                const desc = getDescendantCollectionIds(collections, target.id);
                void deleteCollection(target.id);
                if (view.kind === 'collection' && view.id && desc.has(view.id)) setView({ kind: 'all' });
              }
            }}
          >
            删除分类（保留文献）
          </button>
          <button
            className="ctx-item danger"
            onClick={() => {
              const target = colMenu.col;
              const count = colCounts.get(target.id) ?? 0;
              setColMenu(null);
              const tip =
                count > 0
                  ? `删除分类「${target.name}」（含子分类）并将其中 ${count} 篇文献一并移入回收站？\n（可在回收站还原，或在回收站彻底清空以释放空间）`
                  : `删除分类「${target.name}」及其子分类？`;
              if (confirm(tip)) {
                const desc = getDescendantCollectionIds(collections, target.id);
                void deleteCollectionAndDocs(target.id);
                if (view.kind === 'collection' && view.id && desc.has(view.id)) setView({ kind: 'all' });
              }
            }}
          >
            删除分类与文献（移入回收站）
          </button>
        </div>
      )}

      {/* Tag color & rename right-click menu */}
      {tagMenu && (
        <div
          className="ctx-menu"
          style={{ left: Math.max(8, Math.min(tagMenu.x, window.innerWidth - 216)), top: Math.max(8, Math.min(tagMenu.y, window.innerHeight - 160)) }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="ctx-label">设置标签颜色「{tagMenu.tag}」</div>
          <div className="ctx-colors">
            {TAG_COLORS.map((c) => (
              <button
                key={c.id}
                className={`ctx-color-btn${tagColors[tagMenu.tag] === c.id ? ' active' : ''}`}
                style={{ background: c.hex }}
                title={c.label}
                onClick={() => {
                  setTagColor(tagMenu.tag, c.id);
                  setTagMenu(null);
                }}
              />
            ))}
            <button
              className="ctx-color-clear"
              title="清除颜色"
              onClick={() => {
                setTagColor(tagMenu.tag, null);
                setTagMenu(null);
              }}
            >
              ×
            </button>
          </div>
          <div className="ctx-sep" />
          <button
            className="ctx-item"
            onClick={() => {
              const t = tagMenu.tag;
              setTagMenu(null);
              const to = prompt(`重命名标签「${t}」为：`, t);
              if (to && to !== t) void renameTag(t, to);
            }}
          >
            重命名标签
          </button>
        </div>
      )}

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

function BulkBar({ docs, collections, isTrash }: { docs: DocRecord[]; collections: Collection[]; isTrash: boolean }) {
  const checked = useLibrary((s) => s.checked);
  const setChecked = useLibrary((s) => s.setChecked);
  const view = useLibrary((s) => s.view);
  const tree = useMemo(() => flattenCollectionTree(collections), [collections]);
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

  if (isTrash) {
    return (
      <div className="bulk-bar">
        <span>
          已选 <b>{checked.length}</b>
        </span>
        <button className="btn sm primary" onClick={() => (void restoreDocs(checked), setChecked([]))}>
          还原选中
        </button>
        <button
          className="btn sm danger"
          onClick={async () => {
            if (!confirm(`永久删除选中的 ${checked.length} 篇文献及其笔记、翻译缓存？此操作不可撤销。`)) return;
            for (const id of checked) await deleteDocument(id);
            setChecked([]);
          }}
        >
          彻底删除
        </button>
        <div className="spacer" />
        <button className="icon-btn sm-ico" title="取消选择" onClick={() => setChecked([])}>
          <Icon name="close" size={15} />
        </button>
      </div>
    );
  }

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
        {tree.map(({ col: c, depth }) => (
          <option key={c.id} value={c.id}>
            {'　'.repeat(depth)}
            {depth > 0 ? '└ ' : ''}
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
          for (const id of checked) useTabs.getState().closeTab(id);
          await trashDocs(checked);
          setChecked([]);
        }}
      >
        移入回收站
      </button>
      <div className="spacer" />
      <button className="icon-btn sm-ico" title="取消选择" onClick={() => setChecked([])}>
        <Icon name="close" size={15} />
      </button>
    </div>
  );
}

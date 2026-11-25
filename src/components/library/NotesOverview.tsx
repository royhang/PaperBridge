import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { db, type HighlightColor, type NoteRecord } from '../../db/db';
import { authorsShort } from '../../library/format';
import { navigate, openSettings } from '../../lib/nav';
import { download } from '../../services/export';
import { Icon } from '../Icon';

const COLORS: HighlightColor[] = ['yellow', 'green', 'blue', 'pink', 'purple'];

export function NotesOverview() {
  const notes = useLiveQuery(() => db.notes.toArray(), []);
  const docs = useLiveQuery(() => db.docs.toArray(), []);
  const [q, setQ] = useState('');
  const [color, setColor] = useState<HighlightColor | 'all'>('all');
  const [onlyCommented, setOnlyCommented] = useState(false);

  const docMap = useMemo(() => new Map((docs ?? []).map((d) => [d.id, d])), [docs]);
  const groups = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const filtered = (notes ?? []).filter(
      (n) =>
        (color === 'all' || n.color === color) &&
        (!onlyCommented || n.comment.trim()) &&
        (!ql || `${n.quote}\n${n.comment}\n${n.translation ?? ''}\n${docMap.get(n.docId)?.title ?? ''}`.toLowerCase().includes(ql)),
    );
    const m = new Map<string, NoteRecord[]>();
    for (const n of filtered) m.set(n.docId, [...(m.get(n.docId) ?? []), n]);
    return [...m.entries()]
      .map(([docId, list]) => ({
        docId,
        list: list.sort((a, b) => a.pageIndex - b.pageIndex || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0)),
        latest: Math.max(...list.map((n) => n.createdAt)),
      }))
      .sort((a, b) => b.latest - a.latest);
  }, [notes, color, onlyCommented, q, docMap]);

  const total = groups.reduce((n, g) => n + g.list.length, 0);

  const exportAll = () => {
    const out: string[] = ['# 笔记汇总', ''];
    for (const g of groups) {
      const d = docMap.get(g.docId);
      out.push(`## ${d?.title ?? '（已删除的文献）'}`, '');
      for (const n of g.list) {
        out.push(`> ${n.quote.replace(/\n/g, '\n> ')}`, `> — p.${n.pageIndex + 1}`, '');
        if (n.translation) out.push(`**译文**：${n.translation}`, '');
        if (n.comment) out.push(n.comment, '');
      }
    }
    download('笔记汇总.md', out.join('\n'));
  };

  return (
    <div className="lib">
      <header className="lib-header">
        <div className="brand">
          <div className="brand-mark">译</div>
          <span className="hide-sm">PaperBridge</span>
        </div>
        <nav className="lib-tabs">
          <button onClick={() => navigate('#/')}>文献</button>
          <button className="active">笔记</button>
        </nav>
        <div className="spacer" />
        <button className="btn" onClick={() => openSettings('providers')}>
          <Icon name="settings" size={16} /> <span className="hide-sm">设置</span>
        </button>
      </header>
      <div className="notes-page">
        <div className="lib-toolbar" style={{ padding: '12px 0' }}>
          <div className="search">
            <Icon name="search" size={15} />
            <input className="input" placeholder="搜索摘录、批注、译文、文献标题…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button className={`chip${color === 'all' ? ' active' : ''}`} onClick={() => setColor('all')}>
            全部
          </button>
          {COLORS.map((c) => (
            <button
              key={c}
              className={`swatch ${c}`}
              style={{ outline: color === c ? '2px solid var(--accent)' : undefined, outlineOffset: 1 }}
              onClick={() => setColor(color === c ? 'all' : c)}
              title={c}
            />
          ))}
          <label className="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={onlyCommented} onChange={(e) => setOnlyCommented(e.target.checked)} />
            只看有批注的
          </label>
          <div className="spacer" />
          <span className="hint">{total} 条</span>
          <button className="btn sm" disabled={!total} onClick={exportAll}>
            <Icon name="download" size={13} /> 导出 Markdown
          </button>
        </div>
        {notes && total === 0 && (
          <div className="empty">
            <Icon name="highlight" size={28} />
            <p>{notes.length ? '没有符合条件的笔记' : '还没有笔记。阅读时选中文字、点击颜色即可高亮并记笔记。'}</p>
          </div>
        )}
        {groups.map((g) => {
          const d = docMap.get(g.docId);
          return (
            <section key={g.docId} className="notes-group">
              <h3 onClick={() => d?.hasPdf && navigate(`#/doc/${g.docId}`)} style={{ cursor: d?.hasPdf ? 'pointer' : undefined }}>
                {d?.title ?? '（已删除的文献）'}
                {d && <span className="hint"> {[authorsShort(d.meta.authors), d.meta.year].filter(Boolean).join(' · ')}</span>}
              </h3>
              {g.list.map((n) => (
                <div
                  key={n.id}
                  className={`note ${n.color}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`#/doc/${n.docId}?page=${n.pageIndex + 1}`)}
                  style={{ cursor: 'pointer' }}
                >
                  <div className="row" style={{ marginBottom: 4 }}>
                    <span className="hint">p.{n.pageIndex + 1}</span>
                    <span className="hint">· {new Date(n.createdAt).toLocaleDateString()}</span>
                  </div>
                  <div className="quote">{n.quote}</div>
                  {n.translation && <div className="tr">{n.translation}</div>}
                  {n.comment && <div style={{ marginTop: 6, fontSize: 13 }}>{n.comment}</div>}
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

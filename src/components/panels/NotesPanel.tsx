import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db, type HighlightColor, type NoteRecord } from '../../db/db';
import { exportNotes } from '../../services/export';
import { describeError, translateText } from '../../services/translate';
import { useReader } from '../../store/reader';
import { Icon } from '../Icon';

const COLORS: HighlightColor[] = ['yellow', 'green', 'blue', 'pink', 'purple'];

export function NotesPanel() {
  const docId = useReader((s) => s.docId);
  const title = useReader((s) => s.title);
  const [filter, setFilter] = useState<HighlightColor | 'all'>('all');
  const notes = useLiveQuery(
    async () => {
      if (!docId) return [];
      const all = await db.notes.where('docId').equals(docId).toArray();
      return all.sort((a, b) => a.pageIndex - b.pageIndex || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0));
    },
    [docId],
  );
  if (!docId) return null;
  const shown = notes?.filter((n) => filter === 'all' || n.color === filter) ?? [];

  return (
    <div className="panel-col">
      <div className="panel-head">
        <button className={`chip${filter === 'all' ? ' active' : ''}`} onClick={() => setFilter('all')}>
          全部 {notes?.length ?? 0}
        </button>
        {COLORS.map((c) => (
          <button
            key={c}
            className={`swatch ${c}`}
            style={{ outline: filter === c ? '2px solid var(--accent)' : undefined, outlineOffset: 1 }}
            title={c}
            onClick={() => setFilter(filter === c ? 'all' : c)}
          />
        ))}
        <div className="spacer" />
        <button className="btn sm" disabled={!notes?.length} onClick={() => void exportNotes(docId, title)}>
          <Icon name="download" size={14} /> 导出
        </button>
      </div>
      <div className="panel">
        {shown.length === 0 && (
          <div className="empty">
            <Icon name="highlight" size={28} />
            <p>选中 PDF 中的文字，点击颜色即可高亮并记笔记。</p>
          </div>
        )}
        {shown.map((n) => (
          <NoteItem key={n.id} note={n} />
        ))}
      </div>
    </div>
  );
}

function NoteItem({ note }: { note: NoteRecord }) {
  const scrollTo = useReader((s) => s.scrollTo);
  const pdf = useReader((s) => s.pdf);
  const docId = useReader((s) => s.docId) ?? undefined;
  const [comment, setComment] = useState(note.comment);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const jump = async () => {
    if (!pdf) return;
    const st = useReader.getState();
    const layer = note.layer ?? 'original';
    if (layer === 'translated' && st.viewMode === 'original') st.setViewMode('dual');
    else if (layer === 'original' && st.viewMode === 'translated') st.setViewMode('dual');
    const page = await pdf.getPage(note.pageIndex + 1);
    const h = page.getViewport({ scale: 1 }).height;
    scrollTo(note.pageIndex, (note.rects[0]?.y ?? 0) * h);
  };

  return (
    <div className={`note ${note.color}`}>
      <div className="row" style={{ marginBottom: 4 }}>
        <span className="hint">
          p.{note.pageIndex + 1}
          {note.layer === 'translated' ? ' · 译文' : ''}
        </span>
        <div className="spacer" />
        {COLORS.map((c) => (
          <button
            key={c}
            className={`swatch ${c}`}
            style={{ width: 12, height: 12, opacity: c === note.color ? 1 : 0.4 }}
            onClick={() => void db.notes.update(note.id, { color: c })}
            title="改颜色"
          />
        ))}
        <button
          className="icon-btn"
          style={{ width: 26, height: 26 }}
          title="翻译这段"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr('');
            try {
              const t = await translateText(note.quote, { docId });
              await db.notes.update(note.id, { translation: t });
            } catch (e) {
              setErr(describeError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <span className="spinner" /> : <Icon name="translate" size={14} />}
        </button>
        <button
          className="icon-btn"
          style={{ width: 26, height: 26 }}
          title="删除"
          onClick={() => void db.notes.delete(note.id)}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
      <div className="quote" onClick={() => void jump()} title={note.layer === 'translated' ? '跳转到译文' : '跳转到原文'}>
        {note.quote}
      </div>
      {note.translation && <div className="tr">{note.translation}</div>}
      {err && <div className="error-box" style={{ marginTop: 6 }}>{err}</div>}
      <textarea
        className="textarea"
        placeholder="添加批注…"
        value={comment}
        rows={1}
        onChange={(e) => setComment(e.target.value)}
        onBlur={() => comment !== note.comment && void db.notes.update(note.id, { comment })}
      />
    </div>
  );
}

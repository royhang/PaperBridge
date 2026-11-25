import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { db, uid, type GlossaryEntry } from '../../db/db';
import { csvCell, parseGlossary } from '../../lib/csv';
import { download } from '../../services/export';
import { describeError, translateText } from '../../services/translate';
import { useReader } from '../../store/reader';
import { Icon } from '../Icon';

export function GlossaryPanel() {
  const docId = useReader((s) => s.docId);
  const handoff = useReader((s) => (s.handoff?.target === 'glossary' ? s.handoff : null));
  const consumeHandoff = useReader((s) => s.consumeHandoff);
  const entries = useLiveQuery(
    () => db.glossary.where('scope').anyOf(docId ? ['global', docId] : ['global']).sortBy('source'),
    [docId],
  );
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [scope, setScope] = useState<'global' | 'doc'>('global');
  const [query, setQuery] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [err, setErr] = useState('');
  const targetRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!handoff) return;
    setSource(handoff.text.slice(0, 120));
    setTarget('');
    consumeHandoff();
    setTimeout(() => targetRef.current?.focus(), 0);
  }, [handoff, consumeHandoff]);

  const add = async () => {
    if (!source.trim() || !target.trim()) return;
    const sc = scope === 'doc' && docId ? docId : 'global';
    const dup = await db.glossary.where('scope').equals(sc).filter((g) => g.source.toLowerCase() === source.trim().toLowerCase()).first();
    if (dup) await db.glossary.update(dup.id, { target: target.trim() });
    else await db.glossary.add({ id: uid(), source: source.trim(), target: target.trim(), scope: sc, createdAt: Date.now() });
    setSource('');
    setTarget('');
  };

  const suggest = async () => {
    if (!source.trim()) return;
    setSuggesting(true);
    setErr('');
    try {
      setTarget(await translateText(source.trim(), { docId: docId ?? undefined }));
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setSuggesting(false);
    }
  };

  const shown = (entries ?? []).filter(
    (e) => !query || e.source.toLowerCase().includes(query.toLowerCase()) || e.target.includes(query),
  );

  return (
    <div className="panel-col">
      <div className="panel" style={{ flex: 'none', borderBottom: '1px solid var(--border)' }}>
        <div className="hint" style={{ marginBottom: 8 }}>
          术语表会注入到大模型翻译提示词中，保证专业词汇译法一致（机器翻译 API 不支持）。
        </div>
        <div className="grid2">
          <div className="field">
            <label>原文术语</label>
            <input className="input" value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. attention head" />
          </div>
          <div className="field">
            <label>译名</label>
            <div className="row">
              <input
                ref={targetRef}
                className="input"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void add()}
                placeholder="注意力头"
              />
              <button className="icon-btn" title="用翻译服务建议译名" onClick={() => void suggest()} disabled={suggesting || !source}>
                {suggesting ? <span className="spinner" /> : <Icon name="sparkle" size={15} />}
              </button>
            </div>
          </div>
        </div>
        {err && <div className="error-box" style={{ marginBottom: 8 }}>{err}</div>}
        <div className="row">
          <select className="select" style={{ width: 'auto' }} value={scope} onChange={(e) => setScope(e.target.value as 'global' | 'doc')}>
            <option value="global">全局术语</option>
            <option value="doc">仅本文献</option>
          </select>
          <button className="btn primary" onClick={() => void add()} disabled={!source.trim() || !target.trim()}>
            添加
          </button>
          <div className="spacer" />
          <button className="btn sm" title="导入 CSV / TSV：原文,译名[,备注]" onClick={() => fileRef.current?.click()}>
            导入
          </button>
          <button
            className="btn sm"
            disabled={!entries?.length}
            onClick={() =>
              download(
                'glossary.csv',
                'source,target,note\n' +
                  (entries ?? []).map((e) => [e.source, e.target, e.note ?? ''].map(csvCell).join(',')).join('\n'),
                'text/csv;charset=utf-8',
              )
            }
          >
            导出
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.txt"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              const rows = parseGlossary(await f.text());
              const sc = scope === 'doc' && docId ? docId : 'global';
              await db.glossary.bulkAdd(rows.map((r) => ({ ...r, id: uid(), scope: sc, createdAt: Date.now() })));
              alert(`已导入 ${rows.length} 条术语`);
            }}
          />
        </div>
      </div>
      <div className="panel">
        <input className="input" placeholder="搜索术语…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ marginBottom: 8 }} />
        {shown.length === 0 ? (
          <div className="empty">暂无术语。可以在 PDF 中选中词语后点「术语」快速添加。</div>
        ) : (
          <table className="gl-table">
            <thead>
              <tr>
                <th>原文</th>
                <th>译名</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <GlossaryRow key={e.id} e={e} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function GlossaryRow({ e }: { e: GlossaryEntry }) {
  const [target, setTarget] = useState(e.target);
  return (
    <tr>
      <td>
        {e.source} {e.scope !== 'global' && <span className="badge">本文</span>}
      </td>
      <td>
        <input
          className="input"
          style={{ minHeight: 26, padding: '2px 6px' }}
          value={target}
          onChange={(ev) => setTarget(ev.target.value)}
          onBlur={() => target.trim() && target !== e.target && void db.glossary.update(e.id, { target: target.trim() })}
        />
      </td>
      <td style={{ width: 32 }}>
        <button className="icon-btn" style={{ width: 26, height: 26 }} title="删除" onClick={() => void db.glossary.delete(e.id)}>
          <Icon name="trash" size={14} />
        </button>
      </td>
    </tr>
  );
}

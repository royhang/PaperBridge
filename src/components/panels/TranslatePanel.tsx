import { useEffect, useRef, useState } from 'react';
import { describeError, fillTemplate, getChatLLM, getTranslator, langLabel, translateText } from '../../services/translate';
import { useReader, type TranslateJob } from '../../store/reader';
import { useSettings } from '../../store/settings';
import { openSettings } from '../../lib/nav';
import { LANGUAGES, type LangCode } from '../../providers/types';
import { Icon } from '../Icon';
import { Markdown } from '../Markdown';

interface Entry {
  job: TranslateJob;
  output: string;
  status: 'running' | 'done' | 'error';
  error?: string;
  provider?: string;
}

async function explain(text: string, signal: AbortSignal, onDelta: (s: string) => void) {
  const { cfg, provider } = getChatLLM();
  const s = useSettings.getState();
  const title = useReader.getState().title;
  let out = '';
  for await (const d of provider.chat({
    signal,
    temperature: cfg.temperature ?? 0.3,
    messages: [
      { role: 'system', content: fillTemplate(s.prompts.explainSystem, { to: langLabel(s.targetLang) }) },
      { role: 'user', content: `Paper: ${title}\n\nSelected passage:\n"""\n${text}\n"""` },
    ],
  })) {
    out += d;
    onDelta(out);
  }
  return out;
}

export function TranslatePanel() {
  const job = useReader((s) => s.job);
  const docId = useReader((s) => s.docId) ?? undefined;
  const title = useReader((s) => s.title);
  const [history, setHistory] = useState<Entry[]>([]);
  const [manual, setManual] = useState('');
  const ctrlRef = useRef<AbortController | null>(null);

  const run = (j: TranslateJob, bypassCache = false) => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    let providerName = '';
    try {
      providerName = j.mode === 'explain' ? getChatLLM().cfg.name : getTranslator().cfg.name;
    } catch {
      /* reported below */
    }
    const entry: Entry = { job: j, output: '', status: 'running', provider: providerName };
    setHistory((h) => [entry, ...h.filter((e) => e.job.id !== j.id)].slice(0, 30));
    const update = (patch: Partial<Entry>) =>
      setHistory((h) => h.map((e) => (e.job.id === j.id ? { ...e, ...patch } : e)));
    const onDelta = (output: string) => update({ output });
    const p =
      j.mode === 'explain'
        ? explain(j.text, ctrl.signal, onDelta)
        : translateText(j.text, { docId, docTitle: title, signal: ctrl.signal, onDelta, bypassCache });
    p.then(
      (output) => update({ output, status: 'done' }),
      (e) => update({ status: 'error', error: describeError(e) }),
    );
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void (job && run(job)), [job?.id]);
  useEffect(() => () => ctrlRef.current?.abort(), []);

  const [current, ...older] = history;

  return (
    <>
      <LangBar />
      <div className="panel">
        {!current && (
          <div className="empty">
            <Icon name="translate" size={28} />
            <p>在 PDF 中选中文字，点击「翻译」或「解释」。</p>
            <p className="hint">也可以在设置中开启「选中即翻译」。</p>
          </div>
        )}
        {current && <EntryView entry={current} onRetry={() => run({ ...current.job, id: Date.now() }, true)} />}
        {older.length > 0 && (
          <>
            <div className="page-divider">历史</div>
            {older.map((e) => (
              <div key={e.job.id} className="history-item">
                <EntryView entry={e} compact onRetry={() => run({ ...e.job, id: Date.now() }, true)} />
              </div>
            ))}
          </>
        )}
      </div>
      <div className="chat-input">
        <textarea
          className="textarea"
          placeholder="输入或粘贴要翻译的文字，Ctrl+Enter 翻译"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && manual.trim()) {
              useReader.getState().startJob(manual.trim(), 'translate');
              setManual('');
            }
          }}
          rows={2}
        />
      </div>
    </>
  );
}

function EntryView({ entry, compact, onRetry }: { entry: Entry; compact?: boolean; onRetry: () => void }) {
  const [showSrc, setShowSrc] = useState(!compact);
  const noProvider = entry.status === 'error' && /尚未配置/.test(entry.error ?? '');
  const canLocate = entry.job.pageIndex !== undefined;
  const locate = () => {
    if (entry.job.pageIndex === undefined) return;
    const st = useReader.getState();
    const layer = entry.job.layer ?? 'original';
    if (layer === 'translated' && st.viewMode === 'original') st.setViewMode('dual');
    else if (layer === 'original' && st.viewMode === 'translated') st.setViewMode('dual');
    if (entry.job.rects?.length) {
      st.setPinnedSelection({ pageIndex: entry.job.pageIndex, rects: entry.job.rects, layer: entry.job.layer });
    }
    st.scrollTo(entry.job.pageIndex);
  };
  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="badge">{entry.job.mode === 'explain' ? '解释' : '翻译'}</span>
        {canLocate && (
          <button
            className="btn ghost sm"
            style={{ height: 20, padding: '0 5px', fontSize: 11.5 }}
            title="在左侧 PDF 中定位并高亮此选区"
            onClick={locate}
          >
            p.{entry.job.pageIndex! + 1}
          </button>
        )}
        {entry.provider && <span className="hint">· {entry.provider}</span>}
        <div className="spacer" />
        {entry.status === 'running' && <span className="spinner" />}
        <button className="icon-btn" title="重新生成（忽略缓存）" onClick={onRetry} disabled={entry.status === 'running'}>
          <Icon name="refresh" size={15} />
        </button>
        <button
          className="icon-btn"
          title="复制结果"
          onClick={() => void navigator.clipboard.writeText(entry.output)}
          disabled={!entry.output}
        >
          <Icon name="copy" size={15} />
        </button>
      </div>
      {showSrc ? (
        <div className="source-quote" onClick={() => compact && setShowSrc(false)}>
          {entry.job.text}
        </div>
      ) : (
        <div className="hint" style={{ cursor: 'pointer' }} onClick={() => setShowSrc(true)}>
          {entry.job.text.slice(0, 80)}
          {entry.job.text.length > 80 ? '…' : ''}
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        {entry.job.mode === 'explain' ? (
          entry.output && <Markdown text={entry.output} />
        ) : (
          <div className="result" style={{ whiteSpace: 'pre-wrap' }}>
            {entry.output}
          </div>
        )}
        {entry.status === 'running' && !entry.output && <span className="hint">请求中…</span>}
        {entry.status === 'error' && (
          <div className="error-box">
            {entry.error}
            {noProvider && (
              <div style={{ marginTop: 8 }}>
                <button className="btn sm primary" onClick={() => openSettings('providers')}>
                  去设置
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function LangBar() {
  const s = useSettings();
  const translator = s.providers.find((p) => p.id === s.translateProviderId);
  const opts = (exclude?: LangCode) =>
    LANGUAGES.filter((l) => l.code !== exclude).map((l) => (
      <option key={l.code} value={l.code}>
        {l.label}
      </option>
    ));
  return (
    <div className="panel-head">
      <select
        className="select"
        style={{ width: 'auto', minHeight: 28, padding: '2px 6px' }}
        value={s.sourceLang}
        onChange={(e) => s.set({ sourceLang: e.target.value as LangCode })}
        aria-label="源语言"
      >
        {opts()}
      </select>
      <span className="muted">→</span>
      <select
        className="select"
        style={{ width: 'auto', minHeight: 28, padding: '2px 6px' }}
        value={s.targetLang}
        onChange={(e) => s.set({ targetLang: e.target.value as LangCode })}
        aria-label="目标语言"
      >
        {opts('auto')}
      </select>
      <div className="spacer" />
      <select
        className="select"
        style={{ width: 'auto', maxWidth: 150, minHeight: 28, padding: '2px 6px' }}
        value={translator?.id ?? ''}
        onChange={(e) => {
          if (e.target.value === '__add') openSettings('providers');
          else s.set({ translateProviderId: e.target.value || null });
        }}
        aria-label="翻译服务"
        title="翻译服务"
      >
        {!translator && <option value="">未选择翻译服务</option>}
        {s.providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        <option value="__add">+ 添加 API…</option>
      </select>
    </div>
  );
}

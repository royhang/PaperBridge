import { useState } from 'react';
import { desktop } from '../lib/desktop';
import { db, uid } from '../db/db';
import { exportLibrary, importLibrary } from '../library/backup';
import type { SettingsSection } from '../lib/nav';
import { PROVIDER_PRESETS, createProvider, testProvider } from '../providers';
import { makeContext } from '../providers/http';
import { LLM_KINDS, type ProviderConfig, type ProviderKind } from '../providers/types';
import { ensureOk } from '../providers/sse';
import { describeError } from '../services/translate';
import { DEFAULT_PROMPTS, useSettings, type PromptTemplates } from '../store/settings';
import { useEscape } from '../lib/useEscape';
import { Icon } from './Icon';

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'providers', label: 'API 服务' },
  { id: 'translate', label: '翻译' },
  { id: 'prompts', label: '提示词' },
  { id: 'proxy', label: '跨域代理' },
  { id: 'general', label: '外观' },
  { id: 'data', label: '数据' },
];

const KIND_LABEL: Record<ProviderKind, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic Claude',
  gemini: 'Google Gemini',
  deepl: 'DeepL',
  'google-translate': 'Google 翻译',
  baidu: '百度翻译',
  youdao: '有道智云',
};

const isLLM = (k: ProviderKind) => LLM_KINDS.includes(k);

export function SettingsDialog({ initial, onClose }: { initial: SettingsSection; onClose: () => void }) {
  const [section, setSection] = useState<SettingsSection>(initial);
  useEscape(onClose);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="设置">
        <div className="dialog-head">
          设置
          <div className="spacer" />
          <button className="icon-btn" onClick={onClose} title="关闭">
            <Icon name="close" />
          </button>
        </div>
        <div className="dialog-body">
          <nav className="settings-nav">
            {SECTIONS.map((s) => (
              <button key={s.id} className={section === s.id ? 'active' : ''} onClick={() => setSection(s.id)}>
                {s.label}
              </button>
            ))}
          </nav>
          <div className="settings-content">
            {section === 'providers' && <ProvidersSection />}
            {section === 'translate' && <TranslateSection />}
            {section === 'prompts' && <PromptsSection />}
            {section === 'proxy' && <ProxySection />}
            {section === 'general' && <GeneralSection />}
            {section === 'data' && <DataSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- providers

function ProvidersSection() {
  const providers = useSettings((s) => s.providers);
  const removeProvider = useSettings((s) => s.removeProvider);
  const translateId = useSettings((s) => s.translateProviderId);
  const chatId = useSettings((s) => s.chatProviderId);
  const [editing, setEditing] = useState<ProviderConfig | null>(null);

  if (editing) return <ProviderEditor initial={editing} onDone={() => setEditing(null)} />;

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <div>
          <div style={{ fontWeight: 600 }}>已接入的 API</div>
          <div className="hint">Key 仅保存在本机浏览器（localStorage），请求直接从浏览器发往服务商。</div>
        </div>
        <div className="spacer" />
        <button
          className="btn primary"
          onClick={() => setEditing({ id: uid(), name: '', kind: 'openai', apiKey: '' })}
        >
          <Icon name="plus" size={15} /> 添加
        </button>
      </div>
      {providers.length === 0 && <div className="empty">还没有添加任何 API。</div>}
      {providers.map((p) => (
        <div key={p.id} className="provider-row">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="name">{p.name || KIND_LABEL[p.kind]}</div>
            <div className="hint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {KIND_LABEL[p.kind]}
              {p.model ? ` · ${p.model}` : ''}
              {p.useProxy ? ' · 经代理' : ''}
            </div>
          </div>
          {translateId === p.id && <span className="badge">翻译</span>}
          {chatId === p.id && <span className="badge">问答</span>}
          <button className="btn sm" onClick={() => setEditing(p)}>
            编辑
          </button>
          <button
            className="icon-btn"
            title="删除"
            onClick={() => confirm(`删除「${p.name}」？`) && removeProvider(p.id)}
          >
            <Icon name="trash" size={15} />
          </button>
        </div>
      ))}
    </>
  );
}

function ProviderEditor({ initial, onDone }: { initial: ProviderConfig; onDone: () => void }) {
  const upsert = useSettings((s) => s.upsertProvider);
  const proxyUrl = useSettings((s) => s.proxyUrl);
  const proxyToken = useSettings((s) => s.proxyToken);
  const setSettings = useSettings((s) => s.set);
  const isNew = !useSettings.getState().providers.some((p) => p.id === initial.id);
  const [cfg, setCfg] = useState<ProviderConfig>(initial);
  const [showKey, setShowKey] = useState(false);
  const [test, setTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'error'; msg?: string }>({ state: 'idle' });
  const [models, setModels] = useState<string[]>([]);
  const preset = PROVIDER_PRESETS.find((p) => p.label === cfg.name);
  const llm = isLLM(cfg.kind);
  const needsAppId = cfg.kind === 'baidu' || cfg.kind === 'youdao';
  const patch = (p: Partial<ProviderConfig>) => setCfg((c) => ({ ...c, ...p }));

  const applyPreset = (label: string) => {
    const pr = PROVIDER_PRESETS.find((p) => p.label === label);
    if (!pr) return;
    setCfg((c) => ({
      ...c,
      name: pr.label,
      kind: pr.kind,
      baseUrl: pr.baseUrl,
      model: pr.model,
      useProxy: !!pr.note,
    }));
    setModels([]);
  };

  const runTest = async () => {
    setTest({ state: 'running' });
    try {
      const out = await testProvider(createProvider(cfg, makeContext(cfg, proxyUrl, proxyToken)));
      setTest({ state: 'ok', msg: out.slice(0, 200) });
    } catch (e) {
      setTest({ state: 'error', msg: describeError(e) });
    }
  };

  const fetchModels = async () => {
    try {
      const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
      const res = await makeContext(cfg, proxyUrl, proxyToken).fetch(`${base}/models`, {
        headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      });
      await ensureOk(res);
      const json = (await res.json()) as { data?: { id: string }[]; models?: { name: string }[] };
      const ids = (json.data?.map((m) => m.id) ?? json.models?.map((m) => m.name) ?? []).sort();
      setModels(ids);
      if (!ids.length) setTest({ state: 'error', msg: '没有返回模型列表' });
    } catch (e) {
      setTest({ state: 'error', msg: `获取模型列表失败：${describeError(e)}` });
    }
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="icon-btn" onClick={onDone} title="返回">
          <Icon name="back" />
        </button>
        <div style={{ fontWeight: 600 }}>{isNew ? '添加 API' : `编辑「${initial.name}」`}</div>
      </div>

      <div className="field">
        <label>快速选择服务商</label>
        <select className="select" value={preset?.label ?? ''} onChange={(e) => applyPreset(e.target.value)}>
          <option value="">— 自定义 —</option>
          <optgroup label="大模型（支持术语表、解释、问答）">
            {PROVIDER_PRESETS.filter((p) => isLLM(p.kind)).map((p) => (
              <option key={p.label} value={p.label}>
                {p.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="机器翻译">
            {PROVIDER_PRESETS.filter((p) => !isLLM(p.kind)).map((p) => (
              <option key={p.label} value={p.label}>
                {p.label}
              </option>
            ))}
          </optgroup>
        </select>
        {preset?.note && <div className="hint" style={{ color: 'var(--warn)' }}>{preset.note}</div>}
      </div>

      <div className="grid2">
        <div className="field">
          <label>名称</label>
          <input className="input" value={cfg.name} onChange={(e) => patch({ name: e.target.value })} placeholder="例如：DeepSeek" />
        </div>
        <div className="field">
          <label>接口类型</label>
          <select className="select" value={cfg.kind} onChange={(e) => patch({ kind: e.target.value as ProviderKind })}>
            {Object.entries(KIND_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
      </div>

      {cfg.kind !== 'baidu' && cfg.kind !== 'youdao' && (
        <div className="field">
          <label>Base URL {cfg.kind !== 'openai' && <span className="hint">（可选，留空用官方地址）</span>}</label>
          <input
            className="input"
            value={cfg.baseUrl ?? ''}
            onChange={(e) => patch({ baseUrl: e.target.value.trim() || undefined })}
            placeholder={
              cfg.kind === 'openai'
                ? 'https://api.openai.com/v1'
                : cfg.kind === 'anthropic'
                  ? 'https://api.anthropic.com'
                  : cfg.kind === 'gemini'
                    ? 'https://generativelanguage.googleapis.com'
                    : ''
            }
          />
        </div>
      )}

      {needsAppId && (
        <div className="field">
          <label>{cfg.kind === 'baidu' ? 'APP ID' : '应用 ID (appKey)'}</label>
          <input className="input" value={cfg.appId ?? ''} onChange={(e) => patch({ appId: e.target.value.trim() })} />
        </div>
      )}

      <div className="field">
        <label>{cfg.kind === 'baidu' ? '密钥' : cfg.kind === 'youdao' ? '应用密钥' : 'API Key'}</label>
        <div className="row">
          <input
            className="input"
            type={showKey ? 'text' : 'password'}
            value={cfg.apiKey}
            onChange={(e) => patch({ apiKey: e.target.value.trim() })}
            placeholder={cfg.kind === 'openai' ? '本地模型（Ollama 等）可留空' : ''}
            autoComplete="off"
          />
          <button className="btn sm" onClick={() => setShowKey((v) => !v)}>
            {showKey ? '隐藏' : '显示'}
          </button>
        </div>
      </div>

      {llm && (
        <div className="grid2">
          <div className="field">
            <label>模型</label>
            <div className="row">
              <input
                className="input"
                list="model-list"
                value={cfg.model ?? ''}
                onChange={(e) => patch({ model: e.target.value.trim() })}
              />
              {cfg.kind === 'openai' && (
                <button className="btn sm" onClick={() => void fetchModels()} title="从 /models 获取">
                  获取
                </button>
              )}
              <datalist id="model-list">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
          </div>
          <div className="field">
            <label>Temperature（{cfg.temperature ?? '默认'}）</label>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.1}
              value={cfg.temperature ?? 0.2}
              onChange={(e) => patch({ temperature: Number(e.target.value) })}
            />
          </div>
        </div>
      )}

      <label className="check">
        <input type="checkbox" checked={!!cfg.useProxy} onChange={(e) => patch({ useProxy: e.target.checked })} />
        通过跨域代理发送请求
        <span className="hint">（服务不允许浏览器直连时开启，例如 DeepL / 百度 / 有道 / 部分学校或公司的接口）</span>
      </label>
      {cfg.useProxy && (
        <div className="grid2" style={{ marginLeft: 24 }}>
          <div className="field">
            <label>代理地址（所有服务共用）</label>
            <input className="input" value={proxyUrl} onChange={(e) => setSettings({ proxyUrl: e.target.value.trim() })} />
          </div>
          <div className="field">
            <label>代理令牌（代理设置了 PROXY_TOKEN 时必填）</label>
            <input
              className="input"
              type="password"
              value={proxyToken}
              onChange={(e) => setSettings({ proxyToken: e.target.value.trim() })}
              autoComplete="off"
            />
          </div>
        </div>
      )}

      {test.state !== 'idle' && (
        <div
          className={test.state === 'error' ? 'error-box' : 'hint'}
          style={{ marginBottom: 12, color: test.state === 'ok' ? 'var(--success)' : undefined }}
        >
          {test.state === 'running' && <span className="spinner" />} {test.state === 'running' && '测试中…'}
          {test.state === 'ok' && `✓ 连接成功：${test.msg}`}
          {test.state === 'error' && test.msg}
        </div>
      )}

      <div className="row">
        <button className="btn" onClick={() => void runTest()} disabled={test.state === 'running'}>
          测试连接
        </button>
        <div className="spacer" />
        <button className="btn" onClick={onDone}>
          取消
        </button>
        <button
          className="btn primary"
          disabled={!cfg.name.trim() || (llm && !cfg.model)}
          onClick={() => {
            upsert({ ...cfg, name: cfg.name.trim() });
            onDone();
          }}
        >
          保存
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- translate

function TranslateSection() {
  const s = useSettings();
  const llms = s.providers.filter((p) => isLLM(p.kind));
  return (
    <>
      <div className="grid2">
        <div className="field">
          <label>翻译服务（划词 + 全文）</label>
          <select className="select" value={s.translateProviderId ?? ''} onChange={(e) => s.set({ translateProviderId: e.target.value || null })}>
            <option value="">未选择</option>
            {s.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>大模型（解释 + 问答）</label>
          <select className="select" value={s.chatProviderId ?? ''} onChange={(e) => s.set({ chatProviderId: e.target.value || null })}>
            <option value="">未选择</option>
            {llms.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label>选中文字后</label>
        <select className="select" value={s.selectionAction} onChange={(e) => s.set({ selectionAction: e.target.value as typeof s.selectionAction })}>
          <option value="popup">显示浮动工具栏</option>
          <option value="auto-translate">立即翻译（同时显示工具栏）</option>
          <option value="none">不做任何事</option>
        </select>
      </div>
      <div className="grid2">
        <div className="field">
          <label>全文翻译并发数：{s.concurrency}</label>
          <input type="range" min={1} max={10} value={s.concurrency} onChange={(e) => s.set({ concurrency: Number(e.target.value) })} />
          <div className="hint">同时发出的翻译请求数（含校验重译），越高越快；ECNU 等每个 Key 限 5 个，遇到 429 时调低</div>
        </div>
        <div className="field">
          <label>每次请求的段落数：{s.batchSize}</label>
          <input type="range" min={1} max={20} value={s.batchSize} onChange={(e) => s.set({ batchSize: Number(e.target.value) })} />
          <div className="hint">大模型合并请求可省 token；小模型建议 1–4</div>
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={s.autoTerms !== false} onChange={(e) => s.set({ autoTerms: e.target.checked })} />
        全文翻译前自动提取术语
        <span className="hint">（大模型先读前两页，生成本文献的术语表，保证全文译名一致；可在「术语」面板修改）</span>
      </label>
    </>
  );
}

function PromptsSection() {
  const prompts = useSettings((s) => s.prompts);
  const set = useSettings((s) => s.set);
  const fields: { key: keyof PromptTemplates; label: string; vars: string }[] = [
    { key: 'translateSystem', label: '翻译', vars: '{{from}} {{to}} {{glossary}} {{context}}' },
    { key: 'explainSystem', label: '解释', vars: '{{to}}' },
    { key: 'chatSystem', label: '问答', vars: '{{to}} {{title}}' },
  ];
  return (
    <>
      <div className="hint" style={{ marginBottom: 12 }}>
        系统提示词模板。修改翻译提示词后，旧的翻译缓存不会被复用。
      </div>
      {fields.map((f) => (
        <div className="field" key={f.key}>
          <div className="row">
            <label style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>{f.label}</label>
            <span className="hint">可用变量：{f.vars}</span>
            <div className="spacer" />
            <button className="btn sm ghost" onClick={() => set({ prompts: { ...prompts, [f.key]: DEFAULT_PROMPTS[f.key] } })}>
              恢复默认
            </button>
          </div>
          <textarea
            className="textarea"
            rows={7}
            value={prompts[f.key]}
            onChange={(e) => set({ prompts: { ...prompts, [f.key]: e.target.value } })}
            style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }}
          />
        </div>
      ))}
    </>
  );
}

function ProxySection() {
  const proxyUrl = useSettings((s) => s.proxyUrl);
  const proxyToken = useSettings((s) => s.proxyToken);
  const set = useSettings((s) => s.set);
  const [status, setStatus] = useState('');
  const d = desktop();
  if (d)
    return (
      <p className="hint" style={{ marginTop: 0 }}>
        桌面客户端已内置跨域代理（{d.proxyUrl}），所有接口和论文下载都会自动经过它，无需任何设置。客户端版本 {d.version}（{d.platform}）。
      </p>
    );
  return (
    <>
      <p className="hint" style={{ marginTop: 0 }}>
        浏览器会阻止网页直接调用不支持跨域（CORS）的接口，例如 DeepL、百度、有道。在本机运行项目自带的零依赖代理即可：
      </p>
      <pre className="source-quote" style={{ fontFamily: 'ui-monospace, monospace' }}>node proxy/server.mjs</pre>
      <p className="hint">
        代理默认只放行常见服务商域名。如果你的 API 是自建或学校/公司的服务（例如 chat.example.edu.cn），请把域名加入白名单：
      </p>
      <pre className="source-quote" style={{ fontFamily: 'ui-monospace, monospace' }}>ALLOWED_HOSTS=chat.example.edu.cn node proxy/server.mjs</pre>
      <p className="hint">也可以部署 proxy/worker.js 到 Cloudflare Workers。OpenAI / Claude / Gemini 和多数国内大模型无需代理。</p>
      <div className="field">
        <label>代理地址</label>
        <input className="input" value={proxyUrl} onChange={(e) => set({ proxyUrl: e.target.value.trim() })} placeholder="http://127.0.0.1:8787" />
      </div>
      <div className="field">
        <label>代理令牌（可选，对应 PROXY_TOKEN）</label>
        <input className="input" type="password" value={proxyToken} onChange={(e) => set({ proxyToken: e.target.value })} />
      </div>
      <div className="row">
        <button
          className="btn"
          onClick={async () => {
            setStatus('检测中…');
            try {
              const r = await fetch(`${proxyUrl.replace(/\/+$/, '')}/health`);
              setStatus(r.ok ? '✓ 代理可用' : `代理返回 HTTP ${r.status}`);
            } catch (e) {
              setStatus(`无法连接代理：${e instanceof Error ? e.message : e}`);
            }
          }}
        >
          检测代理
        </button>
        <span className="hint">{status}</span>
      </div>
    </>
  );
}

function GeneralSection() {
  const theme = useSettings((s) => s.theme);
  const fontSize = useSettings((s) => s.readerFontSize);
  const set = useSettings((s) => s.set);
  return (
    <>
      <div className="field">
        <label>主题</label>
        <select className="select" value={theme} onChange={(e) => set({ theme: e.target.value as typeof theme })}>
          <option value="system">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </div>
      <div className="field">
        <label>译文字号：{fontSize}px</label>
        <input type="range" min={12} max={22} value={fontSize} onChange={(e) => set({ readerFontSize: Number(e.target.value) })} />
      </div>
    </>
  );
}

function DataSection() {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="field">
        <label>整个文献库备份（PDF、元数据、分组、标签、笔记、术语、对话、翻译缓存；不含 API Key）</label>
        <div className="row">
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const blob = await exportLibrary(setMsg);
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `paperbridge-backup-${new Date().toLocaleDateString('sv-SE')}.zip`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 2000);
                setMsg(`已导出备份（${(blob.size / 1048576).toFixed(1)} MB）`);
              } catch (e) {
                setMsg(`导出失败：${e instanceof Error ? e.message : e}`);
              } finally {
                setBusy(false);
              }
            }}
          >
            导出整库
          </button>
          <label className={`btn${busy ? ' disabled' : ''}`}>
            从备份恢复
            <input
              type="file"
              accept=".zip,application/zip"
              hidden
              disabled={busy}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                setBusy(true);
                try {
                  const r = await importLibrary(f, setMsg);
                  setMsg(`恢复完成：新增 ${r.docs} 篇文献（${r.skippedDocs} 篇已存在被跳过），${r.notes} 条笔记，${r.translations} 条翻译缓存。`);
                } catch (err) {
                  setMsg(`恢复失败：${err instanceof Error ? err.message : err}`);
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label>
        </div>
        <div className="hint">恢复是合并：已有的文献和笔记会保留，不会被覆盖。换电脑或换浏览器时用它迁移数据。</div>
      </div>
      <div className="field">
        <label>翻译缓存</label>
        <div className="row">
          <button
            className="btn"
            onClick={async () => {
              const n = await db.translations.count();
              if (confirm(`清除全部 ${n} 条翻译缓存？`)) {
                await db.translations.clear();
                setMsg('已清除翻译缓存');
              }
            }}
          >
            清除翻译缓存
          </button>
          <button
            className="btn"
            onClick={async () => {
              await db.paragraphs.clear();
              setMsg('已清除段落解析缓存，重新打开文献后生效');
            }}
          >
            重新解析段落
          </button>
        </div>
      </div>
      <div className="field">
        <label>设置备份（含 API Key，请妥善保管）</label>
        <div className="row">
          <button
            className="btn"
            onClick={() => {
              const { providers, translateProviderId, chatProviderId, sourceLang, targetLang, proxyUrl, selectionAction, theme, concurrency, batchSize, prompts, readerFontSize } =
                useSettings.getState();
              const blob = new Blob(
                [JSON.stringify({ providers, translateProviderId, chatProviderId, sourceLang, targetLang, proxyUrl, selectionAction, theme, concurrency, batchSize, prompts, readerFontSize }, null, 2)],
                { type: 'application/json' },
              );
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = 'paperbridge-settings.json';
              a.click();
            }}
          >
            导出设置
          </button>
          <label className="btn">
            导入设置
            <input
              type="file"
              accept="application/json"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                try {
                  const data = JSON.parse(await f.text());
                  if (!Array.isArray(data.providers)) throw new Error('格式不正确');
                  useSettings.getState().set(data);
                  setMsg('已导入设置');
                } catch (err) {
                  setMsg(`导入失败：${err instanceof Error ? err.message : err}`);
                }
              }}
            />
          </label>
        </div>
      </div>
      {msg && <div className="hint">{msg}</div>}
    </>
  );
}

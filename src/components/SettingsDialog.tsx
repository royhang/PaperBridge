import { useEffect, useState } from 'react';
import { desktop } from '../lib/desktop';
import { db, uid } from '../db/db';
import { exportLibrary, importLibrary } from '../library/backup';
import type { SettingsSection } from '../lib/nav';
import { PROVIDER_PRESETS, createProvider, testProvider } from '../providers';
import { makeContext } from '../providers/http';
import { parseApiSnippet } from '../providers/quickParse';
import { LLM_KINDS, type ProviderConfig, type ProviderKind } from '../providers/types';
import { ensureOk } from '../providers/sse';
import { checkSyncServer, loginAccount, logoutAccount, registerAccount, syncNow } from '../services/sync';
import { describeError } from '../services/translate';
import { checkForUpdates, type UpdateInfo } from '../services/update';
import { DEFAULT_PROMPTS, useSettings, type PromptTemplates } from '../store/settings';
import { useSync } from '../store/sync';
import { useEscape } from '../lib/useEscape';
import { Icon } from './Icon';

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'providers', label: 'API 服务' },
  { id: 'sync', label: '云同步' },
  { id: 'translate', label: '翻译' },
  { id: 'prompts', label: '提示词' },
  { id: 'proxy', label: '跨域代理' },
  { id: 'general', label: '外观与版本' },
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

const QUICK_PRESET_LABELS = [
  'DeepSeek',
  'OpenAI',
  '通义千问 DashScope',
  '智谱 GLM',
  '硅基流动 SiliconFlow',
  'Moonshot/Kimi',
  'Anthropic Claude',
  'Google Gemini',
  'OpenRouter',
  'Ollama local',
];

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
            {section === 'sync' && <SyncSection />}
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

// ---------------------------------------------------------------- providers (streamlined quick import)

function ProvidersSection() {
  const providers = useSettings((s) => s.providers);
  const removeProvider = useSettings((s) => s.removeProvider);
  const upsertProvider = useSettings((s) => s.upsertProvider);
  const setSettings = useSettings((s) => s.set);
  const translateId = useSettings((s) => s.translateProviderId);
  const chatId = useSettings((s) => s.chatProviderId);
  const [editing, setEditing] = useState<{ cfg: ProviderConfig; isPreset: boolean } | null>(null);
  const [snippet, setSnippet] = useState('');
  const [pasteMsg, setPasteMsg] = useState('');
  const [copied, setCopied] = useState(false);

  if (editing) return <ProviderEditor initial={editing.cfg} isPreset={editing.isPreset} onDone={() => setEditing(null)} />;

  const startPreset = (label: string) => {
    const pr = PROVIDER_PRESETS.find((p) => p.label === label);
    if (!pr) return;
    setEditing({
      isPreset: true,
      cfg: {
        id: uid(),
        name: pr.label,
        kind: pr.kind,
        baseUrl: pr.baseUrl,
        apiKey: '',
        model: pr.model,
        useProxy: !desktop() && !!pr.note,
      },
    });
  };

  const handleSmartParse = (text = snippet) => {
    const parsed = parseApiSnippet(text);
    if (!parsed) {
      setPasteMsg('未能识别出有效的 API Key、URL 或配置 JSON，请检查粘贴内容。');
      return;
    }
    if (parsed.providers?.length) {
      for (const p of parsed.providers) {
        upsertProvider({ ...p, id: p.id || uid() });
      }
      setSnippet('');
      setPasteMsg(`✓ ${parsed.summary}，已直接导入`);
      return;
    }
    setSnippet('');
    setPasteMsg('');
    setEditing({
      isPreset: false,
      cfg: {
        id: uid(),
        name: parsed.name ?? '自定义 API',
        kind: parsed.kind ?? 'openai',
        baseUrl: parsed.baseUrl,
        apiKey: parsed.apiKey ?? '',
        model: parsed.model,
        useProxy: !desktop() && !!parsed.useProxy,
      },
    });
  };

  const copyConfigs = () => {
    const payload = JSON.stringify({ providers, translateProviderId: translateId, chatProviderId: chatId }, null, 2);
    void navigator.clipboard.writeText(payload);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      {providers.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <div style={{ fontWeight: 600 }}>已接入的 API</div>
            <div className="spacer" />
            <button className="btn sm ghost" onClick={copyConfigs} title="复制全部 API 配置 JSON，方便粘贴到另一台设备">
              <Icon name="copy" size={13} /> {copied ? '已复制 JSON' : '复制配置'}
            </button>
          </div>
          {providers.map((p) => (
            <div key={p.id} className="provider-row">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="name">{p.name || KIND_LABEL[p.kind]}</div>
                <div className="hint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {KIND_LABEL[p.kind]}
                  {p.model ? ` · ${p.model}` : ''}
                  {p.useProxy && !desktop() ? ' · 经代理' : ''}
                </div>
              </div>
              {translateId === p.id ? (
                <span className="badge active-badge">翻译</span>
              ) : (
                <button className="btn sm ghost" onClick={() => setSettings({ translateProviderId: p.id })} title="设为翻译服务">
                  设为翻译
                </button>
              )}
              {isLLM(p.kind) &&
                (chatId === p.id ? (
                  <span className="badge active-badge">问答</span>
                ) : (
                  <button className="btn sm ghost" onClick={() => setSettings({ chatProviderId: p.id })} title="设为问答模型">
                    设为问答
                  </button>
                ))}
              <button className="btn sm" onClick={() => setEditing({ cfg: p, isPreset: false })}>
                编辑
              </button>
              <button className="icon-btn sm-ico" title="删除" onClick={() => confirm(`删除「${p.name}」？`) && removeProvider(p.id)}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* One-box smart paste */}
      <div className="quick-paste">
        <div className="row" style={{ marginBottom: 6 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>一键粘贴导入</span>
          <span className="hint">支持直接粘贴中转站 URL + Key、.env、curl 命令、单个 Key 或导出的 JSON</span>
        </div>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <textarea
            className="textarea"
            rows={2}
            placeholder={'例：https://api.deepseek.com/v1  sk-xxxx\n或直接粘贴 OPENAI_API_KEY=... / curl 命令 / PaperBridge 配置 JSON'}
            value={snippet}
            onChange={(e) => {
              setSnippet(e.target.value);
              if (pasteMsg) setPasteMsg('');
            }}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && snippet.trim()) {
                e.preventDefault();
                handleSmartParse();
              }
            }}
            style={{ fontSize: 12.5, minHeight: 52 }}
          />
          <button className="btn primary" style={{ height: 52 }} disabled={!snippet.trim()} onClick={() => handleSmartParse()}>
            解析填入
          </button>
        </div>
        {pasteMsg && (
          <div className={pasteMsg.startsWith('✓') ? 'hint' : 'error-box'} style={{ marginTop: 6, color: pasteMsg.startsWith('✓') ? 'var(--success)' : undefined }}>
            {pasteMsg}
          </div>
        )}
      </div>

      {/* Quick preset cards */}
      <div className="row" style={{ margin: '14px 0 8px' }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>快速选择常用服务商</div>
        <span className="hint">点一下只需填 Key 即可使用</span>
      </div>
      <div className="preset-grid">
        {QUICK_PRESET_LABELS.map((label) => {
          const pr = PROVIDER_PRESETS.find((p) => p.label === label);
          if (!pr) return null;
          return (
            <button key={label} className="preset-card" onClick={() => startPreset(label)}>
              <div className="preset-name">{pr.label.replace(/\s+\w+$/, (m) => (m.length > 10 ? '' : m))}</div>
              <div className="hint" style={{ fontSize: 11.5 }}>{pr.model ?? KIND_LABEL[pr.kind]}</div>
            </button>
          );
        })}
        <button
          className="preset-card custom"
          onClick={() => setEditing({ isPreset: false, cfg: { id: uid(), name: '', kind: 'openai', apiKey: '', model: '' } })}
        >
          <div className="preset-name">+ 自定义 / 其他</div>
          <div className="hint" style={{ fontSize: 11.5 }}>中转站 / DeepL / 百度 / 有道</div>
        </button>
      </div>
      <div className="hint" style={{ marginTop: 10 }}>
        Key 仅保存在本机{desktop() ? '（桌面客户端内置跨域代理，无需额外配置代理）' : '浏览器'}；如开启「云同步」，会先在本地端到端加密再同步。
      </div>
    </>
  );
}

function ProviderEditor({ initial, isPreset, onDone }: { initial: ProviderConfig; isPreset: boolean; onDone: () => void }) {
  const upsert = useSettings((s) => s.upsertProvider);
  const proxyUrl = useSettings((s) => s.proxyUrl);
  const proxyToken = useSettings((s) => s.proxyToken);
  const setSettings = useSettings((s) => s.set);
  const isNew = !useSettings.getState().providers.some((p) => p.id === initial.id);
  const [cfg, setCfg] = useState<ProviderConfig>(initial);
  const [showKey, setShowKey] = useState(false);
  const [makeDefault, setMakeDefault] = useState(isNew);
  const [test, setTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'error'; msg?: string; corsHint?: boolean }>({ state: 'idle' });
  const [models, setModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const preset = PROVIDER_PRESETS.find((p) => p.label === cfg.name);
  const llm = isLLM(cfg.kind);
  const needsAppId = cfg.kind === 'baidu' || cfg.kind === 'youdao';
  const isDesktop = !!desktop();
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
      useProxy: !isDesktop && !!pr.note,
    }));
    setModels([]);
  };

  const saveCfg = (c = cfg) => {
    const cleaned = { ...c, name: c.name.trim() || KIND_LABEL[c.kind] };
    upsert(cleaned);
    if (makeDefault) {
      setSettings({
        translateProviderId: cleaned.id,
        ...(isLLM(cleaned.kind) ? { chatProviderId: cleaned.id } : {}),
      });
    }
    onDone();
  };

  const runTest = async (override?: Partial<ProviderConfig>, saveOnOk = false) => {
    const target = { ...cfg, ...override };
    if (override) setCfg(target);
    setTest({ state: 'running' });
    try {
      const out = await testProvider(createProvider(target, makeContext(target, proxyUrl, proxyToken)));
      setTest({ state: 'ok', msg: out.slice(0, 160) });
      if (saveOnOk) saveCfg(target);
    } catch (e) {
      const msg = describeError(e);
      const corsHint = !isDesktop && !target.useProxy && /Failed to fetch|Load failed|NetworkError|CORS/i.test(msg);
      setTest({ state: 'error', msg, corsHint });
    }
  };

  const fetchModels = async () => {
    setFetchingModels(true);
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
      else if (!cfg.model) patch({ model: ids[0] });
    } catch (e) {
      setTest({ state: 'error', msg: `获取模型列表失败：${describeError(e)}` });
    } finally {
      setFetchingModels(false);
    }
  };

  const canSave = !!(cfg.name.trim() || preset) && (!llm || !!cfg.model?.trim());

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="icon-btn sm-ico" onClick={onDone} title="返回">
          <Icon name="back" size={16} />
        </button>
        <div style={{ fontWeight: 600 }}>{isNew ? `配置 ${cfg.name || '自定义 API'}` : `编辑「${initial.name}」`}</div>
        {cfg.baseUrl && isPreset && <span className="hint" style={{ marginLeft: 4 }}>({new URL(cfg.baseUrl).hostname})</span>}
      </div>

      {!isPreset && (
        <div className="grid2">
          <div className="field">
            <label>名称</label>
            <input className="input" value={cfg.name} onChange={(e) => patch({ name: e.target.value })} placeholder="例如：DeepSeek / 学校接口" />
          </div>
          <div className="field">
            <label>服务类型 / 预设</label>
            <select
              className="select"
              value={preset?.label ?? `kind:${cfg.kind}`}
              onChange={(e) => {
                if (e.target.value.startsWith('kind:')) patch({ kind: e.target.value.slice(5) as ProviderKind });
                else applyPreset(e.target.value);
              }}
            >
              <optgroup label="接口类型">
                {Object.entries(KIND_LABEL).map(([k, v]) => (
                  <option key={k} value={`kind:${k}`}>
                    {v}
                  </option>
                ))}
              </optgroup>
              <optgroup label="快速套用预设">
                {PROVIDER_PRESETS.map((p) => (
                  <option key={p.label} value={p.label}>
                    预设：{p.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
        </div>
      )}

      {!isPreset && cfg.kind !== 'baidu' && cfg.kind !== 'youdao' && (
        <div className="field">
          <label>Base URL {cfg.kind !== 'openai' && <span className="hint">（留空使用官方地址）</span>}</label>
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
            autoFocus={isNew}
            type={showKey ? 'text' : 'password'}
            value={cfg.apiKey}
            onChange={(e) => patch({ apiKey: e.target.value.trim() })}
            placeholder={cfg.kind === 'openai' ? '粘贴 sk-...（本地 Ollama 可留空）' : '粘贴 API Key'}
            autoComplete="off"
          />
          <button className="btn sm" onClick={() => setShowKey((v) => !v)}>
            {showKey ? '隐藏' : '显示'}
          </button>
        </div>
      </div>

      {llm && (
        <div className="field">
          <label>模型名称</label>
          <div className="row">
            <input
              className="input"
              list="model-list"
              value={cfg.model ?? ''}
              placeholder="输入或点右侧获取模型列表"
              onChange={(e) => patch({ model: e.target.value.trim() })}
            />
            {cfg.kind === 'openai' && (
              <button className="btn sm" disabled={fetchingModels} onClick={() => void fetchModels()} title="从接口自动拉取可用模型">
                {fetchingModels ? '获取中…' : '获取模型'}
              </button>
            )}
            <datalist id="model-list">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
          {models.length > 0 && (
            <div className="hint" style={{ marginTop: 2 }}>
              已获取 {models.length} 个模型，点击输入框下拉选择。
            </div>
          )}
        </div>
      )}

      <label className="check" style={{ marginTop: 4 }}>
        <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
        保存后设为默认{llm ? '翻译和问答' : '翻译'}服务
      </label>

      <details className="inspector-sec" style={{ marginBottom: 12 }} open={!isDesktop && !!cfg.useProxy}>
        <summary>高级选项（{isPreset ? 'Base URL / ' : ''}Temperature{!isDesktop ? ' / 跨域代理' : ''}）</summary>
        <div className="inspector-sec-body">
          {isPreset && cfg.kind !== 'baidu' && cfg.kind !== 'youdao' && (
            <div className="field">
              <label>Base URL（如需走中转可修改）</label>
              <input className="input" value={cfg.baseUrl ?? ''} onChange={(e) => patch({ baseUrl: e.target.value.trim() || undefined })} />
            </div>
          )}
          {llm && (
            <div className="field">
              <label>Temperature（{cfg.temperature ?? '默认 0.2'}）</label>
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.1}
                value={cfg.temperature ?? 0.2}
                onChange={(e) => patch({ temperature: Number(e.target.value) })}
              />
            </div>
          )}
          {!isDesktop && (
            <>
              <label className="check" style={{ marginBottom: cfg.useProxy ? 8 : 0 }}>
                <input type="checkbox" checked={!!cfg.useProxy} onChange={(e) => patch({ useProxy: e.target.checked })} />
                通过跨域代理发送请求
                <span className="hint">（浏览器直连报 CORS 错误时勾选）</span>
              </label>
              {cfg.useProxy && (
                <div className="grid2">
                  <div className="field">
                    <label>代理地址</label>
                    <input className="input" value={proxyUrl} onChange={(e) => setSettings({ proxyUrl: e.target.value.trim() })} />
                  </div>
                  <div className="field">
                    <label>代理令牌（可选）</label>
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
            </>
          )}
        </div>
      </details>

      {test.state !== 'idle' && (
        <div
          className={test.state === 'error' ? 'error-box' : 'hint'}
          style={{ marginBottom: 12, color: test.state === 'ok' ? 'var(--success)' : undefined }}
        >
          <div>
            {test.state === 'running' && <span className="spinner" />} {test.state === 'running' && '正在测试连接…'}
            {test.state === 'ok' && `✓ 连接成功：${test.msg}`}
            {test.state === 'error' && test.msg}
          </div>
          {test.corsHint && (
            <button className="btn sm" style={{ marginTop: 6 }} onClick={() => void runTest({ useProxy: true }, false)}>
              可能是跨域拦截 → 一键启用代理并重试
            </button>
          )}
        </div>
      )}

      <div className="row">
        <button className="btn" onClick={() => void runTest(undefined, false)} disabled={test.state === 'running'}>
          仅测试
        </button>
        <div className="spacer" />
        <button className="btn ghost" onClick={onDone}>
          取消
        </button>
        <button className="btn" disabled={!canSave} onClick={() => saveCfg()}>
          直接保存
        </button>
        <button
          className="btn primary"
          disabled={!canSave || test.state === 'running'}
          onClick={() => void runTest(undefined, true)}
        >
          测试并保存
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- cloud sync

function SyncSection() {
  const sync = useSync();
  const [serverInput, setServerInput] = useState(sync.serverUrl);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [serverInfo, setServerInfo] = useState<{ ok: boolean; allowRegister: boolean; inviteRequired: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const testServer = async () => {
    setBusy(true);
    setMsg('');
    try {
      const info = await checkSyncServer(serverInput);
      setServerInfo(info);
      sync.set({ serverUrl: serverInput.trim().replace(/\/+$/, '') });
      setMsg(`✓ 已连接同步服务（${info.allowRegister ? (info.inviteRequired ? '需要邀请码注册' : '开放注册') : '仅支持已有账号登录'}）`);
    } catch (e) {
      setServerInfo(null);
      setMsg(`连接失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  const submitAuth = async () => {
    setBusy(true);
    setMsg('');
    try {
      if (mode === 'register') {
        await registerAccount(serverInput, username, password, inviteCode);
        setMsg('✓ 注册成功，已完成首次云同步');
      } else {
        await loginAccount(serverInput, username, password);
        setMsg('✓ 登录成功，已完成数据合并');
      }
      setPassword('');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (sync.token && sync.username) {
    return (
      <>
        <div className="sync-card">
          <div className="row">
            <span className="sync-avatar">
              <Icon name="user" size={18} />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 15 }}>@{sync.username}</div>
              <div className="hint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {sync.serverUrl}
              </div>
            </div>
            <button className="btn primary" disabled={sync.status === 'syncing'} onClick={() => void syncNow()}>
              <Icon name="refresh" size={14} /> {sync.status === 'syncing' ? '同步中…' : '立即同步'}
            </button>
          </div>
          <div className="hint" style={{ marginTop: 10 }}>
            {sync.status === 'syncing'
              ? sync.progress || '正在同步…'
              : sync.lastSyncAt
                ? `上次同步：${new Date(sync.lastSyncAt).toLocaleString()}（版本 r${sync.lastRevision}）`
                : '尚未同步'}
          </div>
          {sync.lastError && (
            <div className="error-box" style={{ marginTop: 8 }}>
              {sync.lastError}
            </div>
          )}
        </div>

        <label className="check" style={{ marginTop: 14 }}>
          <input type="checkbox" checked={sync.autoSync} onChange={(e) => sync.set({ autoSync: e.target.checked })} />
          自动后台同步
          <span className="hint">（启动时、切换回窗口及本地修改后自动双向合并）</span>
        </label>

        <label className="check">
          <input type="checkbox" checked={sync.syncSettings} onChange={(e) => sync.set({ syncSettings: e.target.checked })} />
          端到端加密同步 API 配置与偏好
          <span className="hint">（使用账号密码在本地 AES-256-GCM 加密后上传，换设备登录即用）</span>
        </label>

        <div className="hint" style={{ margin: '8px 0 16px', lineHeight: 1.6 }}>
          同步内容包括：文献题录、PDF 原文（SHA-256 去重）、分类、标签、阅读进度、高亮笔记、术语表、AI 对话与翻译缓存。所有数据始终优先保存在本地，断网也可离线阅读。
        </div>

        <button
          className="btn danger"
          onClick={() => {
            if (confirm('退出当前同步账号？本地已保存的文献和笔记不会被删除。')) void logoutAccount();
          }}
        >
          退出登录
        </button>
      </>
    );
  }

  return (
    <>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>同一账号多端云同步</div>
      <div className="hint" style={{ marginBottom: 14, lineHeight: 1.6 }}>
        在网页版、Windows 桌面客户端或其他电脑登录同一个账号，即可自动共享文献、PDF、笔记、术语、翻译缓存与加密后的 API 配置。
      </div>

      <div className="field">
        <label>同步服务器地址</label>
        <div className="row">
          <input
            className="input"
            value={serverInput}
            onChange={(e) => setServerInput(e.target.value)}
            placeholder="https://your-server:9999"
          />
          <button className="btn" disabled={busy || !serverInput.trim()} onClick={() => void testServer()}>
            检测
          </button>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <div className="view-switch">
          <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
            登录已有账号
          </button>
          <button className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
            注册新账号
          </button>
        </div>
      </div>

      <div className="grid2">
        <div className="field">
          <label>用户名（3–32 位字母/数字）</label>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="例如：royhang" autoComplete="username" />
        </div>
        <div className="field">
          <label>密码（至少 6 位，也用于本地加密 API）</label>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            onKeyDown={(e) => e.key === 'Enter' && username.trim() && password.length >= 6 && void submitAuth()}
          />
        </div>
      </div>

      {mode === 'register' && (serverInfo?.inviteRequired || inviteCode) && (
        <div className="field">
          <label>注册邀请码</label>
          <input className="input" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder="服务器设置了邀请码时填写" />
        </div>
      )}

      {msg && (
        <div className={msg.startsWith('✓') ? 'hint' : 'error-box'} style={{ marginBottom: 10, color: msg.startsWith('✓') ? 'var(--success)' : undefined }}>
          {msg}
        </div>
      )}

      <div className="row">
        <button
          className="btn primary"
          disabled={busy || !serverInput.trim() || !username.trim() || password.length < 6}
          onClick={() => void submitAuth()}
        >
          {busy ? '处理中…' : mode === 'register' ? '注册并开始同步' : '登录并同步'}
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
          <div className="hint">同时发出的翻译请求数（含校验重译），越高越快；遇到 429 时调低</div>
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
        桌面客户端已内置跨域代理（{d.proxyUrl}），所有接口和论文下载都会自动经过它，无需任何设置。客户端版本 v{d.version}（{d.platform}）。
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
  const d = desktop();
  const [upd, setUpd] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [updErr, setUpdErr] = useState('');

  useEffect(() => {
    if (!d) return;
    void checkForUpdates().then((r) => r && setUpd(r)).catch(() => {});
  }, [d]);

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
      <div className="field" style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
        <label>版本与更新</label>
        <div className="row">
          <span className="hint">
            PaperBridge {d ? `桌面版 v${d.version} (${d.platform})` : '网页版'}
          </span>
          <div className="spacer" />
          <button
            className="btn sm"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              setUpdErr('');
              try {
                const info = await checkForUpdates({ force: true });
                setUpd(info);
              } catch (e) {
                setUpdErr(e instanceof Error ? e.message : String(e));
              } finally {
                setChecking(false);
              }
            }}
          >
            {checking ? '检查中…' : '检查更新'}
          </button>
        </div>
        {upd && (
          <div className="hint" style={{ marginTop: 6 }}>
            {upd.hasUpdate ? (
              <>
                发现新版本 <b>v{upd.latest}</b> ·{' '}
                <a href={upd.url} target="_blank" rel="noreferrer">
                  前往 GitHub Release 下载
                </a>
              </>
            ) : (
              `当前已是最新版本（v${upd.latest}）`
            )}
          </div>
        )}
        {updErr && <div className="error-box" style={{ marginTop: 6 }}>{updErr}</div>}
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

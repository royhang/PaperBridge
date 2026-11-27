import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { desktop, type LanShareStatus } from '../lib/desktop';
import { usePwaInstall } from '../lib/pwa';
import { hasWebCryptoSubtle } from '../lib/sha256';
import { db, uid } from '../db/db';
import { exportLibrary, importLibrary } from '../library/backup';
import type { SettingsSection } from '../lib/nav';
import { PROVIDER_PRESETS, createProvider, testProvider } from '../providers';
import { makeContext } from '../providers/http';
import { parseApiSnippet } from '../providers/quickParse';
import { LLM_KINDS, type ProviderConfig, type ProviderKind } from '../providers/types';
import { ensureOk } from '../providers/sse';
import { checkSyncServer, loginAccount, logoutAccount, registerAccount, syncNow } from '../services/sync';
import { download } from '../services/export';
import { describeError } from '../services/translate';
import { checkForUpdates, type UpdateInfo } from '../services/update';
import { DEFAULT_PROMPTS, defaultProxyUrl, useSettings, type PromptTemplates } from '../store/settings';
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

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
const isLocalEndpoint = (baseUrl?: string): boolean => {
  if (!baseUrl) return false;
  try {
    return LOCAL_HOSTS.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
};

const isNetworkOrCorsError = (msg: string) => /Failed to fetch|Load failed|NetworkError|CORS|网络请求失败/i.test(msg);
const isProxyTokenError = (msg: string) => /proxy token|代理令牌/i.test(msg);
const isProxyHostError = (msg: string) => /not allowed|白名单/i.test(msg);

async function probeProxy(url: string): Promise<boolean> {
  const clean = url.trim().replace(/\/+$/, '');
  if (!clean) return false;
  try {
    const res = await fetch(`${clean}/health`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return false;
    const text = (await res.text()).trim().toLowerCase();
    return text === 'ok';
  } catch {
    return false;
  }
}

async function detectAvailableProxy(currentProxyUrl?: string): Promise<string | null> {
  const candidates = [...new Set([currentProxyUrl?.trim(), defaultProxyUrl(), 'http://127.0.0.1:8787'].filter((x): x is string => !!x))];
  for (const c of candidates) {
    if (await probeProxy(c)) return c.replace(/\/+$/, '');
  }
  return null;
}

type ProxyWizardState = {
  reason: 'token' | 'missing' | 'host';
  retryAction: 'models' | 'test' | 'testAndSave';
  detectedUrl?: string;
  host?: string;
};

// In-memory draft store so switching settings tabs or closing & reopening Settings never wipes half-filled inputs.
interface SettingsDraftStore {
  editingProvider: { cfg: ProviderConfig; isPreset: boolean; makeDefault: boolean } | null;
  snippet: string;
  syncDraft: { serverInput: string; mode: 'login' | 'register'; username: string; password: string; inviteCode: string } | null;
  setEditingProvider: (v: SettingsDraftStore['editingProvider']) => void;
  patchEditingCfg: (p: Partial<ProviderConfig>) => void;
  setEditingMakeDefault: (b: boolean) => void;
  setSnippet: (s: string) => void;
  setSyncDraft: (patch: Partial<NonNullable<SettingsDraftStore['syncDraft']>>) => void;
  clearSyncDraft: () => void;
}

const useSettingsDraft = create<SettingsDraftStore>()((set) => ({
  editingProvider: null,
  snippet: '',
  syncDraft: null,
  setEditingProvider: (editingProvider) => set({ editingProvider }),
  patchEditingCfg: (p) =>
    set((s) => (s.editingProvider ? { editingProvider: { ...s.editingProvider, cfg: { ...s.editingProvider.cfg, ...p } } } : s)),
  setEditingMakeDefault: (makeDefault) =>
    set((s) => (s.editingProvider ? { editingProvider: { ...s.editingProvider, makeDefault } } : s)),
  setSnippet: (snippet) => set({ snippet }),
  setSyncDraft: (patch) =>
    set((s) => ({
      syncDraft: {
        serverInput: s.syncDraft?.serverInput ?? useSync.getState().serverUrl,
        mode: s.syncDraft?.mode ?? 'login',
        username: s.syncDraft?.username ?? '',
        password: s.syncDraft?.password ?? '',
        inviteCode: s.syncDraft?.inviteCode ?? '',
        ...patch,
      },
    })),
  clearSyncDraft: () => set({ syncDraft: null }),
}));

export function SettingsDialog({ initial, onClose }: { initial: SettingsSection; onClose: () => void }) {
  const [section, setSection] = useState<SettingsSection>(initial);
  const [detectedProxy, setDetectedProxy] = useState<string | null>(null);
  const hasProviderDraft = useSettingsDraft((s) => !!s.editingProvider || !!s.snippet.trim());
  const hasSyncDraft = useSettingsDraft((s) => !!s.syncDraft && (!!s.syncDraft.username.trim() || !!s.syncDraft.password));
  useEscape(onClose);

  useEffect(() => {
    if (desktop()) return;
    let alive = true;
    void detectAvailableProxy(useSettings.getState().proxyUrl).then((found) => {
      if (!alive || !found) return;
      setDetectedProxy(found);
      if (!useSettings.getState().proxyUrl.trim()) {
        useSettings.getState().set({ proxyUrl: found });
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog settings-dialog" role="dialog" aria-label="设置">
        <div className="dialog-head">
          设置
          <div className="spacer" />
          <button className="icon-btn" onClick={onClose} title="关闭">
            <Icon name="close" />
          </button>
        </div>
        <div className="dialog-body">
          <nav className="settings-nav">
            {SECTIONS.map((s) => {
              const dot = (s.id === 'providers' && hasProviderDraft) || (s.id === 'sync' && hasSyncDraft);
              return (
                <button key={s.id} className={section === s.id ? 'active' : ''} onClick={() => setSection(s.id)}>
                  {s.label}
                  {dot && <span className="open-dot" style={{ marginLeft: 6, verticalAlign: 1 }} title="有未保存的填写内容" />}
                </button>
              );
            })}
          </nav>
          <div className="settings-content">
            {section === 'providers' && <ProvidersSection detectedProxy={detectedProxy} onOpenSection={setSection} />}
            {section === 'sync' && <SyncSection onOpenSection={setSection} />}
            {section === 'translate' && <TranslateSection />}
            {section === 'prompts' && <PromptsSection />}
            {section === 'proxy' && <ProxySection onOpenSection={setSection} />}
            {section === 'general' && <GeneralSection />}
            {section === 'data' && <DataSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- providers (streamlined quick import)

function ProvidersSection({
  detectedProxy,
  onOpenSection,
}: {
  detectedProxy: string | null;
  onOpenSection: (s: SettingsSection) => void;
}) {
  const providers = useSettings((s) => s.providers);
  const proxyToken = useSettings((s) => s.proxyToken);
  const removeProvider = useSettings((s) => s.removeProvider);
  const upsertProvider = useSettings((s) => s.upsertProvider);
  const setSettings = useSettings((s) => s.set);
  const translateId = useSettings((s) => s.translateProviderId);
  const chatId = useSettings((s) => s.chatProviderId);
  const editing = useSettingsDraft((s) => s.editingProvider);
  const setEditing = useSettingsDraft((s) => s.setEditingProvider);
  const snippet = useSettingsDraft((s) => s.snippet);
  const setSnippet = useSettingsDraft((s) => s.setSnippet);
  const [pasteMsg, setPasteMsg] = useState('');
  const [copied, setCopied] = useState(false);

  const shouldDefaultProxy = (baseUrl?: string, force?: boolean) =>
    !desktop() && !isLocalEndpoint(baseUrl) && (!!detectedProxy || !!proxyToken || !!force);

  if (editing) return <ProviderEditor detectedProxy={detectedProxy} onDone={() => setEditing(null)} onOpenSection={onOpenSection} />;

  const startPreset = (label: string) => {
    const pr = PROVIDER_PRESETS.find((p) => p.label === label);
    if (!pr) return;
    setEditing({
      isPreset: true,
      makeDefault: true,
      cfg: {
        id: uid(),
        name: pr.label,
        kind: pr.kind,
        baseUrl: pr.baseUrl,
        apiKey: '',
        model: pr.model,
        useProxy: shouldDefaultProxy(pr.baseUrl, !!pr.note),
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
        upsertProvider({ ...p, id: p.id || uid(), useProxy: p.useProxy ?? shouldDefaultProxy(p.baseUrl) });
      }
      setSnippet('');
      setPasteMsg(`✓ ${parsed.summary}，已直接导入`);
      return;
    }
    setSnippet('');
    setPasteMsg('');
    setEditing({
      isPreset: false,
      makeDefault: true,
      cfg: {
        id: uid(),
        name: parsed.name ?? '自定义 API',
        kind: parsed.kind ?? 'openai',
        baseUrl: parsed.baseUrl,
        apiKey: parsed.apiKey ?? '',
        model: parsed.model,
        useProxy: shouldDefaultProxy(parsed.baseUrl, !!parsed.useProxy),
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
              <button className="btn sm" onClick={() => setEditing({ cfg: { ...p }, isPreset: false, makeDefault: false })}>
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
          onClick={() =>
            setEditing({
              isPreset: false,
              makeDefault: true,
              cfg: { id: uid(), name: '', kind: 'openai', apiKey: '', model: '', useProxy: shouldDefaultProxy() },
            })
          }
        >
          <div className="preset-name">+ 自定义 / 其他</div>
          <div className="hint" style={{ fontSize: 11.5 }}>中转站 / DeepL / 百度 / 有道</div>
        </button>
      </div>
      <div className="hint" style={{ marginTop: 10 }}>
        Key 仅保存在本机{desktop() ? '（桌面客户端内置跨域代理，无需额外配置代理）' : detectedProxy ? `浏览器（已检测到代理 ${detectedProxy}，新建 API 默认自动走代理）` : '浏览器'}；如开启「云同步」，会先在本地端到端加密再同步。
      </div>
    </>
  );
}

function ProviderEditor({
  detectedProxy,
  onDone,
  onOpenSection,
}: {
  detectedProxy: string | null;
  onDone: () => void;
  onOpenSection: (s: SettingsSection) => void;
}) {
  const upsert = useSettings((s) => s.upsertProvider);
  const proxyUrl = useSettings((s) => s.proxyUrl);
  const proxyToken = useSettings((s) => s.proxyToken);
  const setSettings = useSettings((s) => s.set);
  const syncLoggedIn = useSync((s) => !!(s.token && s.username));
  const editing = useSettingsDraft((s) => s.editingProvider)!;
  const patch = useSettingsDraft((s) => s.patchEditingCfg);
  const setMakeDefault = useSettingsDraft((s) => s.setEditingMakeDefault);
  const { cfg, isPreset, makeDefault } = editing;
  const existing = useSettings((s) => s.providers.find((p) => p.id === cfg.id));
  const isNew = !existing;
  const [showKey, setShowKey] = useState(false);
  const [test, setTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'error'; msg?: string }>({ state: 'idle' });
  const [models, setModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelFiltering, setModelFiltering] = useState(false);
  const modelBoxRef = useRef<HTMLDivElement>(null);
  const [proxyWizard, setProxyWizard] = useState<ProxyWizardState | null>(null);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (modelBoxRef.current && !modelBoxRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
        setModelFiltering(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [modelMenuOpen]);
  const [wizardBusy, setWizardBusy] = useState(false);
  const [wizardNote, setWizardNote] = useState('');
  const [cmdCopied, setCmdCopied] = useState(false);
  const preset = PROVIDER_PRESETS.find((p) => p.label === cfg.name);
  const llm = isLLM(cfg.kind);
  const needsAppId = cfg.kind === 'baidu' || cfg.kind === 'youdao';
  const isDesktop = !!desktop();

  const targetHost = (url?: string) => {
    try {
      return new URL(url || 'https://api.openai.com/v1').hostname;
    } catch {
      return '';
    }
  };

  const classifyProxyErr = (msg: string, retryAction: ProxyWizardState['retryAction'], url?: string): ProxyWizardState | null => {
    if (isDesktop) return null;
    if (isProxyTokenError(msg)) return { reason: 'token', retryAction, detectedUrl: url || proxyUrl || defaultProxyUrl() };
    if (isProxyHostError(msg)) return { reason: 'host', retryAction, detectedUrl: url || proxyUrl || defaultProxyUrl(), host: targetHost(cfg.baseUrl) };
    return null;
  };

  const applyPreset = (label: string) => {
    const pr = PROVIDER_PRESETS.find((p) => p.label === label);
    if (!pr) return;
    patch({
      name: pr.label,
      kind: pr.kind,
      baseUrl: pr.baseUrl,
      model: pr.model,
      useProxy: !isDesktop && !isLocalEndpoint(pr.baseUrl) && (!!detectedProxy || !!proxyToken || !!pr.note),
    });
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

  const runTest = async (override?: Partial<ProviderConfig>, saveOnOk = false, proxyOverride?: { proxyUrl?: string; proxyToken?: string }) => {
    const target = { ...cfg, ...override };
    const pUrl = proxyOverride?.proxyUrl ?? useSettings.getState().proxyUrl;
    const pTok = proxyOverride?.proxyToken ?? useSettings.getState().proxyToken;
    const retryAction: ProxyWizardState['retryAction'] = saveOnOk ? 'testAndSave' : 'test';
    if (override) patch(override);
    setProxyWizard(null);
    setWizardNote('');
    setTest({ state: 'running', msg: '正在测试连接…' });
    try {
      const out = await testProvider(createProvider(target, makeContext(target, pUrl, pTok)));
      setTest({ state: 'ok', msg: out.slice(0, 160) });
      if (saveOnOk) saveCfg(target);
    } catch (e) {
      const msg = describeError(e);
      if (!isDesktop && !target.useProxy && isNetworkOrCorsError(msg)) {
        setTest({ state: 'running', msg: '检测到浏览器跨域拦截，正在自动探测代理并重试…' });
        const found = await detectAvailableProxy(pUrl);
        if (found) {
          setSettings({ proxyUrl: found });
          const next = { ...target, useProxy: true };
          patch({ useProxy: true });
          try {
            const out2 = await testProvider(createProvider(next, makeContext(next, found, pTok)));
            setTest({ state: 'ok', msg: `已自动开启代理并连接成功：${out2.slice(0, 140)}` });
            if (saveOnOk) saveCfg(next);
            return;
          } catch (e2) {
            const msg2 = describeError(e2);
            setTest({ state: 'error', msg: msg2 });
            const wiz = classifyProxyErr(msg2, retryAction, found);
            if (wiz) setProxyWizard(wiz);
            return;
          }
        }
        setTest({ state: 'error', msg });
        setProxyWizard({ reason: 'missing', retryAction, detectedUrl: pUrl || defaultProxyUrl() });
        return;
      }
      if (!isDesktop && target.useProxy) {
        if (isProxyTokenError(msg) && !pTok) {
          try {
            const direct = { ...target, useProxy: false };
            const outDirect = await testProvider(createProvider(direct, makeContext(direct, pUrl, pTok)));
            patch({ useProxy: false });
            setTest({ state: 'ok', msg: outDirect.slice(0, 160) });
            if (saveOnOk) saveCfg(direct);
            return;
          } catch {
            // Direct also failed (likely CORS), fall through to show the token wizard.
          }
        }
        const wiz = classifyProxyErr(msg, retryAction, pUrl);
        if (wiz) {
          setTest({ state: 'error', msg });
          setProxyWizard(wiz);
          return;
        }
        if (isNetworkOrCorsError(msg) && !(await probeProxy(pUrl))) {
          setTest({ state: 'error', msg: `无法连接到代理服务（${pUrl || '未填写'}）` });
          setProxyWizard({ reason: 'missing', retryAction, detectedUrl: pUrl || defaultProxyUrl() });
          return;
        }
      }
      setTest({ state: 'error', msg });
    }
  };

  const requestModels = async (target: ProviderConfig, pUrl: string, pTok: string) => {
    const base = (target.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    const res = await makeContext(target, pUrl, pTok).fetch(`${base}/models`, {
      headers: target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {},
    });
    await ensureOk(res);
    const json = (await res.json()) as { data?: { id: string }[]; models?: { name: string }[] };
    return (json.data?.map((m) => m.id) ?? json.models?.map((m) => m.name) ?? []).sort();
  };

  const fetchModels = async (override?: Partial<ProviderConfig>, proxyOverride?: { proxyUrl?: string; proxyToken?: string }) => {
    const target = { ...cfg, ...override };
    const pUrl = proxyOverride?.proxyUrl ?? useSettings.getState().proxyUrl;
    const pTok = proxyOverride?.proxyToken ?? useSettings.getState().proxyToken;
    if (override) patch(override);
    setFetchingModels(true);
    setProxyWizard(null);
    setWizardNote('');
    try {
      const ids = await requestModels(target, pUrl, pTok);
      setModels(ids);
      if (!ids.length) setTest({ state: 'error', msg: '没有返回模型列表' });
      else {
        if (!target.model) patch({ model: ids[0] });
        setModelMenuOpen(true);
        setModelFiltering(false);
        setTest({ state: 'ok', msg: `已获取 ${ids.length} 个模型` });
      }
    } catch (e) {
      const msg = describeError(e);
      if (!isDesktop && !target.useProxy && isNetworkOrCorsError(msg)) {
        setTest({ state: 'running', msg: '检测到浏览器跨域拦截，正在自动探测代理并重试获取模型…' });
        const found = await detectAvailableProxy(pUrl);
        if (found) {
          setSettings({ proxyUrl: found });
          const next = { ...target, useProxy: true };
          patch({ useProxy: true });
          try {
            const ids = await requestModels(next, found, pTok);
            setModels(ids);
            if (!ids.length) setTest({ state: 'error', msg: '没有返回模型列表' });
            else {
              if (!next.model) patch({ model: ids[0] });
              setModelMenuOpen(true);
              setModelFiltering(false);
              setTest({ state: 'ok', msg: `已自动开启代理，获取到 ${ids.length} 个模型` });
            }
            return;
          } catch (e2) {
            const msg2 = describeError(e2);
            setTest({ state: 'error', msg: `获取模型列表失败：${msg2}` });
            const wiz = classifyProxyErr(msg2, 'models', found);
            if (wiz) setProxyWizard(wiz);
            return;
          }
        }
        setTest({ state: 'error', msg: `获取模型列表失败：${msg}` });
        setProxyWizard({ reason: 'missing', retryAction: 'models', detectedUrl: pUrl || defaultProxyUrl() });
        return;
      }
      if (!isDesktop && target.useProxy) {
        if (isProxyTokenError(msg) && !pTok) {
          try {
            const direct = { ...target, useProxy: false };
            const ids = await requestModels(direct, pUrl, pTok);
            patch({ useProxy: false });
            setModels(ids);
            if (!ids.length) setTest({ state: 'error', msg: '没有返回模型列表' });
            else {
              if (!direct.model) patch({ model: ids[0] });
              setModelMenuOpen(true);
              setModelFiltering(false);
              setTest({ state: 'ok', msg: `已获取 ${ids.length} 个模型` });
            }
            return;
          } catch {
            // Direct also failed (likely CORS), fall through to show the token wizard.
          }
        }
        const wiz = classifyProxyErr(msg, 'models', pUrl);
        if (wiz) {
          setTest({ state: 'error', msg: `获取模型列表失败：${msg}` });
          setProxyWizard(wiz);
          return;
        }
        if (isNetworkOrCorsError(msg) && !(await probeProxy(pUrl))) {
          setTest({ state: 'error', msg: `无法连接到代理服务（${pUrl || '未填写'}）` });
          setProxyWizard({ reason: 'missing', retryAction: 'models', detectedUrl: pUrl || defaultProxyUrl() });
          return;
        }
      }
      setTest({ state: 'error', msg: `获取模型列表失败：${msg}` });
    } finally {
      setFetchingModels(false);
    }
  };

  const applyWizardAndRetry = async () => {
    if (!proxyWizard) return;
    setWizardBusy(true);
    setWizardNote('');
    try {
      const s = useSettings.getState();
      let candidate = s.proxyUrl.trim().replace(/\/+$/, '');
      if (proxyWizard.reason === 'missing') {
        const alive = candidate ? (await probeProxy(candidate) ? candidate : null) : await detectAvailableProxy();
        if (!alive) {
          setWizardNote(`暂时连不上 ${candidate || defaultProxyUrl()}，请确认代理已启动或填写正确的代理地址。`);
          return;
        }
        candidate = alive;
      } else if (!candidate) {
        candidate = proxyWizard.detectedUrl || defaultProxyUrl();
      }
      setSettings({ proxyUrl: candidate });
      const action = proxyWizard.retryAction;
      setProxyWizard(null);
      if (action === 'models') {
        await fetchModels({ useProxy: true }, { proxyUrl: candidate, proxyToken: s.proxyToken });
      } else {
        await runTest({ useProxy: true }, action === 'testAndSave', { proxyUrl: candidate, proxyToken: s.proxyToken });
      }
    } finally {
      setWizardBusy(false);
    }
  };

  const localCmd = proxyWizard?.reason === 'host' && proxyWizard.host
    ? `ALLOWED_HOSTS=${proxyWizard.host} node proxy/server.mjs`
    : 'ALLOWED_HOSTS=* node proxy/server.mjs';

  const copyLocalCmd = () => {
    void navigator.clipboard.writeText(localCmd);
    setCmdCopied(true);
    setTimeout(() => setCmdCopied(false), 1800);
  };

  const canSave = !!(cfg.name.trim() || preset) && (!llm || !!cfg.model?.trim());

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="icon-btn sm-ico" onClick={onDone} title="返回">
          <Icon name="back" size={16} />
        </button>
        <div style={{ fontWeight: 600 }}>{isNew ? `配置 ${cfg.name || '自定义 API'}` : `编辑「${existing?.name || cfg.name}」`}</div>
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

      {llm && (() => {
        const q = modelFiltering ? (cfg.model ?? '').trim().toLowerCase() : '';
        const visibleModels = q ? models.filter((m) => m.toLowerCase().includes(q)) : models;
        return (
          <div className="field">
            <label>模型名称</label>
            <div className="row">
              <div className="model-combo" ref={modelBoxRef}>
                <input
                  className="input"
                  style={models.length > 0 ? { paddingRight: 30 } : undefined}
                  value={cfg.model ?? ''}
                  placeholder="输入或点右侧获取模型列表"
                  onFocus={() => {
                    if (models.length > 0) {
                      setModelMenuOpen(true);
                      setModelFiltering(false);
                    }
                  }}
                  onClick={() => {
                    if (models.length > 0) {
                      setModelMenuOpen(true);
                      setModelFiltering(false);
                    }
                  }}
                  onChange={(e) => {
                    patch({ model: e.target.value.trim() });
                    if (models.length > 0) {
                      setModelMenuOpen(true);
                      setModelFiltering(true);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && modelMenuOpen) {
                      e.stopPropagation();
                      setModelMenuOpen(false);
                      setModelFiltering(false);
                    }
                  }}
                />
                {models.length > 0 && (
                  <button
                    type="button"
                    className="model-combo-toggle"
                    title={modelMenuOpen ? '收起模型列表' : '展开全部模型'}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setModelMenuOpen((v) => !v);
                      setModelFiltering(false);
                    }}
                  >
                    <Icon name={modelMenuOpen ? 'up' : 'down'} size={14} />
                  </button>
                )}
                {modelMenuOpen && models.length > 0 && (
                  <div className="model-menu" role="listbox">
                    {visibleModels.length === 0 ? (
                      <div className="model-menu-empty">无匹配模型（可直接使用当前自定义名称）</div>
                    ) : (
                      visibleModels.map((m) => (
                        <button
                          key={m}
                          type="button"
                          className={`model-menu-item${cfg.model === m ? ' active' : ''}`}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            patch({ model: m });
                            setModelMenuOpen(false);
                            setModelFiltering(false);
                          }}
                        >
                          <span className="model-menu-name">{m}</span>
                          {cfg.model === m && <span className="model-menu-chk">✓</span>}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
              {cfg.kind === 'openai' && (
                <button className="btn sm" disabled={fetchingModels} onClick={() => void fetchModels()} title="从接口自动拉取可用模型">
                  {fetchingModels ? '获取中…' : '获取模型'}
                </button>
              )}
            </div>
            {models.length > 0 && (
              <div className="hint" style={{ marginTop: 2 }}>
                已获取 {models.length} 个模型，点击输入框或右侧箭头可直接选择，也可输入关键词筛选。
              </div>
            )}
          </div>
        );
      })()}

      <label className="check" style={{ marginTop: 4 }}>
        <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
        保存后设为默认{llm ? '翻译和问答' : '翻译'}服务
      </label>

      <details className="inspector-sec" style={{ marginBottom: 12 }}>
        <summary>
          高级选项（{isPreset ? 'Base URL / ' : ''}Temperature{!isDesktop ? ` / 跨域代理${cfg.useProxy ? '：已开启' : ''}` : ''}）
        </summary>
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
                通过中转代理请求（解决浏览器跨域拦截）
                <span className="hint">仅当网页版直连报 CORS / Failed to fetch 时需要，如学校接口、DeepL、百度；OpenAI/DeepSeek 等通常无需勾选</span>
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
            {test.state === 'running' && <span className="spinner" />} {test.state === 'running' && (test.msg || '正在测试连接…')}
            {test.state === 'ok' && `✓ ${test.msg}`}
            {test.state === 'error' && test.msg}
          </div>
        </div>
      )}

      {!isDesktop && proxyWizard && (
        <div className="proxy-wizard">
          <div className="proxy-wizard-title">
            {proxyWizard.reason === 'token'
              ? '已自动检测到中转代理，还需完成令牌认证'
              : proxyWizard.reason === 'host'
                ? '中转代理拒绝了该接口域名（不在白名单中）'
                : '自动配置跨域中转代理'}
          </div>
          <div className="proxy-wizard-desc">
            {proxyWizard.reason === 'token' &&
              '浏览器直连该接口被跨域（CORS）拦截，系统已自动为你勾选「通过中转代理请求」。请登录「云同步」自动获取代理令牌，或在下方直接填入代理令牌：'}
            {proxyWizard.reason === 'host' &&
              `代理服务 ${proxyWizard.detectedUrl || proxyUrl} 未放行 ${proxyWizard.host || '该域名'}。请在代理端设置 ALLOWED_HOSTS=*（或加入该域名）后重试，或切换其他代理地址：`}
            {proxyWizard.reason === 'missing' &&
              '该接口不支持浏览器直接跨域访问，且当前未检测到运行中的中转代理。你可以直接填写自建代理地址、登录自建云同步自动配置，或在本地运行下方命令：'}
          </div>

          <div className="grid2">
            <div className="field" style={{ marginBottom: 8 }}>
              <label>代理地址</label>
              <input
                className="input"
                value={proxyUrl}
                onChange={(e) => setSettings({ proxyUrl: e.target.value.trim() })}
                placeholder={proxyWizard.detectedUrl || 'http://127.0.0.1:8787'}
              />
            </div>
            <div className="field" style={{ marginBottom: 8 }}>
              <label>代理令牌（PROXY_TOKEN，无密码可留空）</label>
              <input
                className="input"
                type="password"
                value={proxyToken}
                onChange={(e) => setSettings({ proxyToken: e.target.value.trim() })}
                placeholder="填写代理令牌"
                autoComplete="off"
                onKeyDown={(e) => e.key === 'Enter' && void applyWizardAndRetry()}
              />
            </div>
          </div>

          {wizardNote && (
            <div className="error-box" style={{ marginBottom: 8 }}>
              {wizardNote}
            </div>
          )}

          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn primary sm" disabled={wizardBusy} onClick={() => void applyWizardAndRetry()}>
              {wizardBusy ? '检测并重试中…' : '应用代理并自动重试'}
            </button>
            {!syncLoggedIn && (
              <button className="btn sm" onClick={() => onOpenSection('sync')}>
                登录云同步（自动填代理）→
              </button>
            )}
            <div className="spacer" />
            <button className="btn sm ghost" onClick={() => setProxyWizard(null)}>
              收起
            </button>
          </div>

          {(proxyWizard.reason === 'missing' || proxyWizard.reason === 'host') && (
            <>
              <div className="proxy-wizard-cmd">
                <code>{localCmd}</code>
                <button className="btn sm ghost" onClick={copyLocalCmd}>
                  {cmdCopied ? '已复制' : '复制命令'}
                </button>
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                提示：也可以直接使用{' '}
                <a href="https://github.com/royhang/PaperBridge/releases/latest" target="_blank" rel="noreferrer">
                  Windows 桌面客户端
                </a>
                ，已内置跨域代理，无需任何代理配置。
              </div>
            </>
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

function LanShareCard({
  currentServerUrl,
  loggedInUser,
  onUseLocalServer,
}: {
  currentServerUrl: string;
  loggedInUser: string;
  onUseLocalServer: (url: string) => void;
}) {
  const api = desktop()?.lanShare;
  const [status, setStatus] = useState<LanShareStatus | null>(null);
  const [portInput, setPortInput] = useState('8787');
  const [busy, setBusy] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState('');

  useEffect(() => {
    if (!api) return;
    let alive = true;
    void api.getStatus().then((st) => {
      if (!alive) return;
      setStatus(st);
      setPortInput(String(st.port));
    });
    return () => {
      alive = false;
    };
  }, [api]);

  if (!api) return null;

  const refresh = async () => {
    setBusy(true);
    try {
      const st = await api.getStatus();
      setStatus(st);
      setPortInput(String(st.port));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    if (!status) return;
    setBusy(true);
    try {
      const parsedPort = Number(portInput) || status.port || 8787;
      const st = await api.configure({ enabled: !status.enabled, port: parsedPort });
      setStatus(st);
      setPortInput(String(st.port));
    } finally {
      setBusy(false);
    }
  };

  const applyPort = async () => {
    if (!status) return;
    setBusy(true);
    try {
      const parsedPort = Number(portInput) || 8787;
      const st = await api.configure({ enabled: status.enabled, port: parsedPort });
      setStatus(st);
      setPortInput(String(st.port));
    } finally {
      setBusy(false);
    }
  };

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl((cur) => (cur === url ? '' : cur)), 1800);
    } catch {
      /* ignore */
    }
  };

  const normalizedCur = currentServerUrl.trim().replace(/\/+$/, '');
  const connectedToLan = Boolean(status?.running && normalizedCur === status.localUrl);
  const portDirty = Boolean(status && String(status.port) !== portInput.trim());

  return (
    <div className="sync-card lan-card">
      <div className="row" style={{ gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row" style={{ gap: 6 }}>
            <span style={{ fontWeight: 600, fontSize: 13.5 }}>局域网共享（iPad / 手机免 Docker 直连）</span>
            <span className={`lan-pill${status?.running ? ' on' : ''}`}>
              {status?.running ? `运行中 · :${status.port}` : '未开启'}
            </span>
          </div>
          <div className="hint" style={{ marginTop: 2 }}>
            开启后本机直接提供网页阅读、多端同步与跨域代理，同一 Wi-Fi 下 iPad、安卓平板或手机打开地址即可阅读并同步。
          </div>
        </div>
        <button className={`btn${status?.enabled ? '' : ' primary'}`} disabled={busy || !status} onClick={() => void toggle()}>
          {busy ? '处理中…' : status?.enabled ? '停止共享' : '开启共享'}
        </button>
      </div>

      <div className="row" style={{ marginTop: 10, gap: 8 }}>
        <label className="hint" style={{ margin: 0 }}>
          监听端口
        </label>
        <input
          className="input sm"
          style={{ width: 84 }}
          type="number"
          min={1024}
          max={65535}
          value={portInput}
          onChange={(e) => setPortInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && portDirty && void applyPort()}
        />
        {portDirty && (
          <button className="btn sm" disabled={busy} onClick={() => void applyPort()}>
            应用端口
          </button>
        )}
        <button className="btn sm ghost" disabled={busy} onClick={() => void refresh()} title="重新检测本机局域网 IP">
          <Icon name="refresh" size={12} /> 刷新地址
        </button>
      </div>

      {status?.error && (
        <div className="error-box" style={{ marginTop: 8 }}>
          {status.error}
        </div>
      )}

      {status?.running && (
        <div style={{ marginTop: 10 }}>
          <div className="hint" style={{ marginBottom: 4, fontWeight: 500, color: 'var(--fg-muted)' }}>
            iPad Safari / 安卓浏览器打开以下局域网地址（同一 Wi-Fi）：
          </div>
          {status.urls.length > 0 ? (
            status.urls.map((u, idx) => (
              <div className="lan-url-row" key={u.url}>
                <code className="lan-url-code">{u.url}</code>
                <span className="hint" style={{ fontSize: 11.5 }}>
                  {u.name}
                  {idx === 0 ? '（推荐）' : ''}
                </span>
                <div className="spacer" />
                <button className="btn sm" onClick={() => void copyUrl(u.url)}>
                  {copiedUrl === u.url ? '✓ 已复制' : '复制'}
                </button>
              </div>
            ))
          ) : (
            <div className="hint">未检测到局域网 IPv4 地址，请确认电脑已连接 Wi-Fi 或以太网后点击「刷新地址」。</div>
          )}

          <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
            {!loggedInUser ? (
              <button className="btn sm primary" onClick={() => onUseLocalServer(status.localUrl)}>
                一键填入本机同步地址（{status.localUrl}）
              </button>
            ) : connectedToLan ? (
              <span className="hint" style={{ color: 'var(--success)' }}>
                ✓ 本机已连接局域网同步，iPad 打开上方地址登录 @{loggedInUser} 即可实时互通
              </span>
            ) : (
              <span className="hint">
                当前本机已登录外部同步服务（{currentServerUrl}）；若需改用纯局域网同步，可先退出下方账号再接入 {status.localUrl}。
              </span>
            )}
          </div>

          <div className="hint" style={{ marginTop: 6, lineHeight: 1.55 }}>
            提示：首次开启如 Windows 防火墙弹窗，请勾选「专用网络」并允许访问；iPad 登录同步后会自动复用本机代理（含 Clash/VPN），无需单独配代理。
          </div>
        </div>
      )}
    </div>
  );
}

function SyncSection({ onOpenSection }: { onOpenSection: (s: SettingsSection) => void }) {
  const sync = useSync();
  const webCryptoOk = hasWebCryptoSubtle();
  const canInstallPwa = usePwaInstall((s) => s.canInstall);
  const promptInstallPwa = usePwaInstall((s) => s.promptInstall);
  const hasProviderDraft = useSettingsDraft((s) => !!s.editingProvider);
  const proxyToken = useSettings((s) => s.proxyToken);
  const draft = useSettingsDraft((s) => s.syncDraft);
  const setDraft = useSettingsDraft((s) => s.setSyncDraft);
  const clearDraft = useSettingsDraft((s) => s.clearSyncDraft);
  const serverInput = draft?.serverInput ?? sync.serverUrl;
  const mode = draft?.mode ?? 'login';
  const username = draft?.username ?? '';
  const password = draft?.password ?? '';
  const inviteCode = draft?.inviteCode ?? '';
  const setServerInput = (v: string) => setDraft({ serverInput: v });
  const setMode = (v: 'login' | 'register') => setDraft({ mode: v });
  const setUsername = (v: string) => setDraft({ username: v });
  const setPassword = (v: string) => setDraft({ password: v });
  const setInviteCode = (v: string) => setDraft({ inviteCode: v });
  const [serverInfo, setServerInfo] = useState<{ ok: boolean; allowRegister: boolean; inviteRequired: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const testServer = async (targetUrl?: string) => {
    const raw = (targetUrl ?? serverInput).trim();
    if (!raw) return;
    setBusy(true);
    setMsg('');
    try {
      const info = await checkSyncServer(raw);
      setServerInfo(info);
      sync.set({ serverUrl: raw.replace(/\/+$/, '') });
      setMsg(`✓ 已连接同步服务（${info.allowRegister ? (info.inviteRequired ? '需要邀请码注册' : '开放注册') : '仅支持已有账号登录'}）`);
    } catch (e) {
      setServerInfo(null);
      setMsg(`连接失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  const useLocalLanServer = (localUrl: string) => {
    setServerInput(localUrl);
    void testServer(localUrl);
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
      clearDraft();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (sync.token && sync.username) {
    return (
      <>
        <LanShareCard currentServerUrl={sync.serverUrl} loggedInUser={sync.username} onUseLocalServer={useLocalLanServer} />

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
          <span className="hint">启动时、切换回窗口及本地修改后自动双向合并</span>
        </label>

        <label className="check">
          <input type="checkbox" checked={sync.syncSettings} onChange={(e) => sync.set({ syncSettings: e.target.checked })} />
          端到端加密同步 API 配置与偏好
          <span className="hint">
            {webCryptoOk
              ? '使用账号密码在本地 AES-256-GCM 加密后上传，换设备登录即用'
              : '当前为局域网 HTTP 连接，浏览器禁用 WebCrypto 加密；文献、PDF、笔记与手写仍正常同步，API Key 请在当前设备「API 服务」中单独配置'}
          </span>
        </label>

        <div className="hint" style={{ margin: '8px 0 12px', lineHeight: 1.6 }}>
          同步内容包括：文献题录、PDF 原文（SHA-256 去重）、多级分类、彩色标签、阅读进度、高亮笔记、双层手写笔迹、术语表、AI 对话与翻译缓存。网页版、Windows 桌面端、iPadOS 与安卓平板/手机登录同一账号即可实时互通。
          {!desktop() && proxyToken && '（已自动同步该服务器的中转代理地址与令牌，网页版配置 API 时无需手动填写代理。）'}
        </div>

        <div className="sync-card" style={{ marginBottom: 14, fontSize: 12.5, lineHeight: 1.6 }}>
          <div className="row" style={{ marginBottom: 4, gap: 8 }}>
            <div style={{ fontWeight: 600 }}>在 iPadOS / 安卓平板与手机上使用（全屏 App 模式 + 手写笔支持）</div>
            {canInstallPwa && (
              <button className="btn sm primary" style={{ marginLeft: 'auto' }} onClick={() => void promptInstallPwa()}>
                一键安装为 App
              </button>
            )}
          </div>
          <div className="hint">
            1. <strong>安卓平板/手机</strong>：用 Chrome / Edge 打开 <code>{sync.serverUrl || '你的 PaperBridge 网址'}</code>，点击浏览器菜单「安装应用 / 添加到主屏幕」即可作为独立全屏 App 运行（原生支持三星 S-Pen / 华为 M-Pencil / 小米笔压感、侧键橡皮与防误触）。<br />
            2. <strong>iPadOS</strong>：用 Safari 打开后点击「分享 → 添加到主屏幕」，登录同一账号即可实时同步全部文献、PDF、双层手写与配置。
          </div>
        </div>

        <div className="row">
          {hasProviderDraft && (
            <button className="btn primary" onClick={() => onOpenSection('providers')}>
              ← 返回继续配置 API
            </button>
          )}
          <button
            className="btn danger"
            onClick={() => {
              if (confirm('退出当前同步账号？本地已保存的文献和笔记不会被删除。')) void logoutAccount();
            }}
          >
            退出登录
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <LanShareCard currentServerUrl={serverInput} loggedInUser="" onUseLocalServer={useLocalLanServer} />

      <div style={{ fontWeight: 600, marginBottom: 4 }}>网页 · 电脑 · iPadOS · 安卓平板/手机 多端云同步</div>
      <div className="hint" style={{ marginBottom: 14, lineHeight: 1.6 }}>
        在网页版、Windows 桌面客户端、iPadOS 与安卓平板/手机登录同一个账号，即可自动共享全部文献、PDF、多级分类、彩色标签、双层手写笔记、阅读进度与加密后的 API 配置。
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
      <div className="grid2">
        <div className="field">
          <label>选中文字后</label>
          <select className="select" value={s.selectionAction} onChange={(e) => s.set({ selectionAction: e.target.value as typeof s.selectionAction })}>
            <option value="popup">显示浮动工具栏</option>
            <option value="auto-translate">立即翻译（同时显示工具栏）</option>
            <option value="none">不做任何事</option>
          </select>
        </div>
        <div className="field">
          <label>PDF 纸张护眼模式</label>
          <select className="select" value={s.pdfTheme ?? 'auto'} onChange={(e) => s.set({ pdfTheme: e.target.value as typeof s.pdfTheme })}>
            <option value="auto">跟随深浅主题（黑夜自动暗夜护眼）</option>
            <option value="dim">柔光暖纸（保留原图色彩不刺眼）</option>
            <option value="dark">始终暗夜护眼（柔和深底浅字）</option>
            <option value="original">始终原始纯白</option>
          </select>
        </div>
      </div>
      <div className="grid2">
        <div className="field">
          <label>全文翻译并发数：{s.concurrency}</label>
          <input type="range" min={1} max={3} value={Math.min(3, s.concurrency)} onChange={(e) => s.set({ concurrency: Number(e.target.value) })} />
          <div className="hint">同时发出的翻译请求数（上限 3，避免触发接口 429 限流）</div>
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
        <span className="hint">大模型先读前两页，生成本文献的术语表，保证全文译名一致；可在「术语」面板修改</span>
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

function ProxySection({ onOpenSection }: { onOpenSection: (s: SettingsSection) => void }) {
  const proxyUrl = useSettings((s) => s.proxyUrl);
  const proxyToken = useSettings((s) => s.proxyToken);
  const set = useSettings((s) => s.set);
  const syncLoggedIn = useSync((s) => !!(s.token && s.username));
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
        浏览器会阻止网页直接调用不支持跨域（CORS）的接口（例如学校/中转站接口、DeepL、百度、有道）。当检测到可用代理时，新建 API 会自动默认开启中转代理。
      </p>
      {!syncLoggedIn && (
        <div className="sync-card" style={{ marginBottom: 12 }}>
          <div className="row">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>有自建同步服务器？</div>
              <div className="hint">登录「云同步」后会自动填入代理地址与代理令牌，无需手动配置。</div>
            </div>
            <button className="btn sm primary" onClick={() => onOpenSection('sync')}>
              前往云同步 →
            </button>
          </div>
        </div>
      )}
      <pre className="source-quote" style={{ fontFamily: 'ui-monospace, monospace' }}>ALLOWED_HOSTS=* node proxy/server.mjs</pre>
      <p className="hint">也可在本机运行上述零依赖代理命令，或部署 proxy/worker.js 到 Cloudflare Workers。</p>
      <div className="field">
        <label>代理地址</label>
        <input className="input" value={proxyUrl} onChange={(e) => set({ proxyUrl: e.target.value.trim() })} placeholder="http://127.0.0.1:8787" />
      </div>
      <div className="field">
        <label>代理令牌（可选，对应 PROXY_TOKEN）</label>
        <input className="input" type="password" value={proxyToken} onChange={(e) => set({ proxyToken: e.target.value })} />
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button
          className="btn primary"
          onClick={async () => {
            setStatus('正在自动探测可用代理…');
            const found = await detectAvailableProxy(proxyUrl);
            if (found) {
              set({ proxyUrl: found });
              setStatus(`✓ 已自动检测到可用代理：${found}`);
            } else {
              setStatus('未检测到运行中的代理（请检查代理地址或先运行 node proxy/server.mjs）');
            }
          }}
        >
          自动探测代理
        </button>
        <button
          className="btn"
          onClick={async () => {
            setStatus('检测中…');
            const ok = await probeProxy(proxyUrl);
            setStatus(ok ? '✓ 代理可用' : `无法连接代理：${proxyUrl || '未填写地址'}`);
          }}
        >
          检测当前地址
        </button>
        <span className="hint">{status}</span>
      </div>
    </>
  );
}

function GeneralSection() {
  const theme = useSettings((s) => s.theme);
  const pdfTheme = useSettings((s) => s.pdfTheme);
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
        <select className="select" value={theme} onChange={(e) => set({ theme: e.target.value as typeof theme, pdfTheme: 'auto' })}>
          <option value="system">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </div>
      <div className="field">
        <label>PDF 纸色</label>
        <select className="select" value={pdfTheme} onChange={(e) => set({ pdfTheme: e.target.value as typeof pdfTheme })}>
          <option value="auto">跟随主题（深色自动暗夜纸张）</option>
          <option value="original">原始白底</option>
          <option value="dim">柔光暖纸（保留图片原色）</option>
          <option value="dark">暗夜反色</option>
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
                download(`paperbridge-backup-${new Date().toLocaleDateString('sv-SE')}.zip`, blob, 'application/zip');
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
              download(
                'paperbridge-settings.json',
                JSON.stringify({ providers, translateProviderId, chatProviderId, sourceLang, targetLang, proxyUrl, selectionAction, theme, concurrency, batchSize, prompts, readerFontSize }, null, 2),
                'application/json',
              );
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

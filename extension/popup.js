const DESKTOP_BASE = 'http://127.0.0.1:23129';

const $ = (id) => document.getElementById(id);

let activeTabId = null;
let extracted = null;
let state = {
  mode: 'desktop', // 'desktop' | 'cloud'
  cloudUrl: '',
  cloudToken: '',
  cloudUser: '',
  lastFolderId: '',
  desktopOnline: false,
};

function flattenTree(collections) {
  const valid = new Set(collections.map((c) => c.id));
  const byParent = new Map();
  for (const c of collections) {
    const pid = c.parentId && valid.has(c.parentId) && c.parentId !== c.id ? c.parentId : null;
    const arr = byParent.get(pid) || [];
    arr.push(c);
    byParent.set(pid, arr);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => (a.order || 0) - (b.order || 0));
  const out = [];
  const seen = new Set();
  const walk = (pid, depth) => {
    for (const c of byParent.get(pid) || []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ col: c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function setConn(kind, text, showCloudBtn = false) {
  $('connDot').className = `dot${kind ? ' ' + kind : ''}`;
  $('connText').textContent = text;
  $('toggleCloudCfg').classList.toggle('hidden', !showCloudBtn);
}

function setStatus(kind, text) {
  const el = $('statusMsg');
  if (!text) {
    el.className = 'msg hidden';
    el.textContent = '';
    return;
  }
  el.className = `msg ${kind}`;
  el.textContent = text;
}

function renderModeButtons() {
  $('modeDesktop').classList.toggle('active', state.mode === 'desktop');
  $('modeCloud').classList.toggle('active', state.mode === 'cloud');
}

function populateFolders(collections) {
  const sel = $('folderSelect');
  sel.innerHTML = '<option value="">我的文库</option>';
  for (const { col, depth } of flattenTree(collections || [])) {
    const opt = document.createElement('option');
    opt.value = col.id;
    opt.textContent = `${'　'.repeat(depth)}${depth > 0 ? '└ ' : '▸ '}${col.name}`;
    sel.appendChild(opt);
  }
  if (state.lastFolderId && [...sel.options].some((o) => o.value === state.lastFolderId)) {
    sel.value = state.lastFolderId;
  }
}

async function loadConfig() {
  const stored = await chrome.storage.local.get(['mode', 'cloudUrl', 'cloudToken', 'cloudUser', 'lastFolderId']);
  state = { ...state, ...stored };
  $('serverUrl').value = state.cloudUrl || '';
  $('username').value = state.cloudUser || '';
}

async function saveConfig(patch) {
  Object.assign(state, patch);
  await chrome.storage.local.set(patch);
}

async function pingDesktop() {
  try {
    const r = await fetch(`${DESKTOP_BASE}/connector/ping`, { signal: AbortSignal.timeout(700) });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.ok ? j : null;
  } catch {
    return null;
  }
}

async function refreshTarget() {
  renderModeButtons();
  $('cloudPanel').classList.add('hidden');
  $('savePanel').classList.remove('hidden');

  if (state.mode === 'desktop') {
    setConn('', '正在检测本机 PaperBridge 桌面端…', false);
    const ping = await pingDesktop();
    state.desktopOnline = !!ping;
    if (!ping) {
      setConn('err', '未检测到本机桌面端（可打开桌面版或切到「云同步」）', false);
      populateFolders([]);
      $('saveBtn').disabled = true;
      return;
    }
    setConn('ok', `已连接 PaperBridge 桌面端 v${ping.version || ''}`, false);
    $('saveBtn').disabled = false;
    try {
      const r = await fetch(`${DESKTOP_BASE}/connector/collections`, { signal: AbortSignal.timeout(4000) });
      const j = await r.json();
      populateFolders(j.collections || []);
    } catch {
      populateFolders([]);
    }
    return;
  }

  // Cloud mode
  if (!state.cloudUrl || !state.cloudToken) {
    setConn('err', '尚未登录云同步服务器', true);
    showCloudPanel(false);
    return;
  }
  setConn('', `正在连接 ${state.cloudUrl}…`, true);
  try {
    const r = await fetch(`${state.cloudUrl.replace(/\/+$/, '')}/api/connector/collections`, {
      headers: { Authorization: `Bearer ${state.cloudToken}` },
      signal: AbortSignal.timeout(6000),
    });
    if (r.status === 401) {
      setConn('err', '云同步登录已过期，请重新登录', true);
      showCloudPanel(false);
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    setConn('ok', `云同步 @${j.username || state.cloudUser} · ${new URL(state.cloudUrl).host}`, true);
    populateFolders(j.collections || []);
    $('saveBtn').disabled = false;
  } catch (e) {
    setConn('err', `无法连接同步服务器：${e.message || e}`, true);
    $('saveBtn').disabled = true;
  }
}

function showCloudPanel(canCancel = true) {
  $('cloudErr').classList.add('hidden');
  $('savePanel').classList.add('hidden');
  $('cloudPanel').classList.remove('hidden');
  $('cloudLogoutBtn').classList.toggle('hidden', !state.cloudToken);
  $('cloudCancelBtn').classList.toggle('hidden', !canCancel);
}

async function extractCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/i.test(tab.url || '')) {
    extracted = null;
    $('sourceBadge').textContent = '不可抓取';
    $('titleInput').value = '';
    $('metaSummary').textContent = '请在知网、arXiv 或其他学术论文网页打开此扩展。';
    $('saveBtn').disabled = true;
    return;
  }
  activeTabId = tab.id;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['extractor.js'],
    });
    extracted = results?.[0]?.result || null;
  } catch (e) {
    extracted = {
      sourceLabel: '网页',
      meta: { title: tab.title || '未命名网页', authors: [], url: tab.url, type: 'other' },
      tags: [],
    };
    console.warn('extract failed', e);
  }
  if (!extracted) return;

  $('sourceBadge').textContent = extracted.sourceLabel || '网页';
  $('titleInput').value = extracted.meta?.title || '';
  $('tagsInput').value = (extracted.tags || []).join(', ');

  const authorsStr = (extracted.meta?.authors || [])
    .slice(0, 4)
    .map((a) => (/[\u4e00-\u9fff]/.test(a.family) ? `${a.family}${a.given}` : [a.given, a.family].filter(Boolean).join(' ')))
    .join(', ');
  const parts = [
    authorsStr,
    extracted.meta?.venue,
    extracted.meta?.year,
    extracted.meta?.volume ? `Vol.${extracted.meta.volume}` : '',
    extracted.meta?.issue ? `(${extracted.meta.issue})` : '',
    extracted.meta?.pages ? `pp.${extracted.meta.pages}` : '',
  ].filter(Boolean);
  $('metaSummary').textContent = parts.join(' · ') || extracted.meta?.url || '';

  if (extracted.pdfUrl) {
    $('pdfRow').classList.remove('hidden');
    $('fetchPdfChk').checked = true;
  } else {
    $('pdfRow').classList.add('hidden');
  }
}

/**
 * Download PDF inside the active tab's own context so the browser's logged-in campus cookies
 * and Referer are sent naturally. Never bypasses CAPTCHAs — if the server returns HTML/verification
 * instead of `%PDF-`, returns `{ ok: false, reason }` so we fall back gracefully to metadata-only.
 */
async function tryFetchPdfInTab(tabId, pdfUrl) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      args: [pdfUrl],
      func: async (url) => {
        try {
          const r = await fetch(url, { credentials: 'include', redirect: 'follow' });
          if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
          const buf = await r.arrayBuffer();
          if (buf.byteLength < 100) return { ok: false, reason: '响应过小' };
          if (buf.byteLength > 45 * 1024 * 1024) return { ok: false, reason: 'PDF 超过 45MB，请手动下载后拖入' };
          const head = new Uint8Array(buf, 0, 5);
          const magic = String.fromCharCode(...head);
          if (magic !== '%PDF-') return { ok: false, reason: '需要网页验证或登录权限' };
          const bytes = new Uint8Array(buf);
          let binary = '';
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
          }
          return { ok: true, base64: btoa(binary), size: buf.byteLength };
        } catch (err) {
          return { ok: false, reason: err?.message || '跨域限制' };
        }
      },
    });
    return res?.[0]?.result || { ok: false, reason: '无法读取页面脚本' };
  } catch (e) {
    return { ok: false, reason: e?.message || '无法在当前标签下载' };
  }
}

async function handleSave() {
  if (!extracted) return;
  const saveBtn = $('saveBtn');
  saveBtn.disabled = true;
  setStatus('', '正在准备题录…');

  const collectionId = $('folderSelect').value || null;
  await saveConfig({ lastFolderId: collectionId || '' });

  const tags = $('tagsInput')
    .value.split(/[,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const meta = {
    ...(extracted.meta || {}),
    title: $('titleInput').value.trim() || extracted.meta?.title || '未命名文献',
  };

  let pdfBase64;
  let pdfNote = '';
  if (extracted.pdfUrl && $('fetchPdfChk').checked && activeTabId) {
    setStatus('', '正在尝试附带 PDF…');
    const dl = await tryFetchPdfInTab(activeTabId, extracted.pdfUrl);
    if (dl.ok) {
      pdfBase64 = dl.base64;
    } else {
      pdfNote = `（未自动附带 PDF：${dl.reason}；可点页面「PDF下载」后直接拖入 PaperBridge，会自动合并到本条题录）`;
    }
  }

  const payload = {
    meta,
    tags,
    collectionId,
    pdfBase64,
    pdfFileName: extracted.pdfFileName,
  };

  try {
    setStatus('', state.mode === 'desktop' ? '正在写入 PaperBridge 桌面端…' : '正在同步到 PaperBridge 云端…');
    let res;
    if (state.mode === 'desktop') {
      res = await fetch(`${DESKTOP_BASE}/connector/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      res = await fetch(`${state.cloudUrl.replace(/\/+$/, '')}/api/connector/save`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.cloudToken}`,
        },
        body: JSON.stringify(payload),
      });
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    const tag = json.duplicate ? '已更新库中已有条目' : '已保存到 PaperBridge';
    const pdfTag = json.hasPdf ? '（含 PDF）' : pdfNote || '（仅题录）';
    setStatus(json.hasPdf || !pdfNote ? 'ok' : 'warn', `✓ ${tag}${pdfTag}`);
  } catch (e) {
    setStatus('err', `保存失败：${e.message || e}`);
  } finally {
    saveBtn.disabled = false;
  }
}

async function handleCloudLogin() {
  const url = $('serverUrl').value.trim().replace(/\/+$/, '');
  const username = $('username').value.trim().toLowerCase();
  const password = $('password').value;
  const errEl = $('cloudErr');
  errEl.classList.add('hidden');
  if (!url || !username || !password) {
    errEl.textContent = '请填写服务器地址、用户名和密码';
    errEl.classList.remove('hidden');
    return;
  }
  $('cloudLoginBtn').disabled = true;
  try {
    const r = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, device: 'PaperBridge Connector (Browser)' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    await saveConfig({ mode: 'cloud', cloudUrl: url, cloudToken: j.token, cloudUser: j.username });
    $('password').value = '';
    await refreshTarget();
  } catch (e) {
    errEl.textContent = `登录失败：${e.message || e}`;
    errEl.classList.remove('hidden');
  } finally {
    $('cloudLoginBtn').disabled = false;
  }
}

async function init() {
  await loadConfig();
  // Auto-prefer desktop if running when user hasn't explicitly chosen cloud
  const storedMode = (await chrome.storage.local.get('mode')).mode;
  if (!storedMode) {
    const desk = await pingDesktop();
    state.mode = desk ? 'desktop' : state.cloudToken ? 'cloud' : 'desktop';
  }
  await Promise.all([extractCurrentTab(), refreshTarget()]);
}

$('modeDesktop').addEventListener('click', async () => {
  await saveConfig({ mode: 'desktop' });
  setStatus('', '');
  await refreshTarget();
});

$('modeCloud').addEventListener('click', async () => {
  await saveConfig({ mode: 'cloud' });
  setStatus('', '');
  await refreshTarget();
});

$('toggleCloudCfg').addEventListener('click', () => showCloudPanel(true));
$('cloudCancelBtn').addEventListener('click', () => void refreshTarget());
$('cloudLoginBtn').addEventListener('click', () => void handleCloudLogin());
$('cloudLogoutBtn').addEventListener('click', async () => {
  await saveConfig({ cloudToken: '' });
  showCloudPanel(false);
});
$('password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void handleCloudLogin();
});
$('titleInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('saveBtn').disabled) void handleSave();
});
$('saveBtn').addEventListener('click', () => void handleSave());
$('refreshBtn').addEventListener('click', async () => {
  setStatus('', '');
  await Promise.all([extractCurrentTab(), refreshTarget()]);
});

void init();

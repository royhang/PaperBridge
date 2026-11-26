// PaperBridge desktop client (Electron).
//  - serves the built web app from app://paperbridge/ (a secure, standard scheme: IndexedDB, Cache Storage,
//    module workers and WebAssembly behave as on https)
//  - runs the CORS proxy in-process on 127.0.0.1:<random port> with a random token, so every translation
//    provider and paper download works without any setup; the page learns the address via the preload
//  - all data stays local (the profile's IndexedDB); links open in the system browser
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, Menu, app, ipcMain, net, protocol, screen, shell } from 'electron';
import {
  MAX_BODY_BYTES,
  ProxyError,
  bodyTooLarge,
  corsHeaders,
  errorResponse,
  parseTarget,
  responseHeaders,
  upstreamHeaders,
} from './proxy/worker.js';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, 'web');
const ORIGIN = 'app://paperbridge';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

// one window per user: a second launch focuses the first
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let info = null;
// PDFs to open: from the command line ("open with", file association), a second launch or macOS open-file
let pending = [];
let rendererReady = false;
const connectorPending = new Map();
let connectorSeq = 0;

function callRendererConnector(action, payload, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    if (!win || win.isDestroyed() || !rendererReady) {
      reject(new Error('PaperBridge 窗口尚未就绪，请稍后重试'));
      return;
    }
    const id = ++connectorSeq;
    const timer = setTimeout(() => {
      connectorPending.delete(id);
      reject(new Error('PaperBridge 桌面端响应超时'));
    }, timeoutMs);
    connectorPending.set(id, {
      resolve: (data) => {
        clearTimeout(timer);
        resolve(data);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    win.webContents.send('paperbridge:connector-req', { id, action, payload });
  });
}

/**
 * Local connector HTTP server (127.0.0.1:23129) for the PaperBridge Chrome/Edge extension,
 * modeled after Zotero Connector. Only allows extension origins or originless local calls.
 */
async function startConnectorServer(version) {
  const MAX_CONNECTOR_BODY = 64 * 1024 * 1024;
  const server = createServer(async (req, res) => {
    const origin = String(req.headers.origin ?? '');
    const allowedOrigin =
      !origin || /^(?:chrome-extension|moz-extension|edge-extension|safari-web-extension):\/\//i.test(origin);
    const cors = {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      ...(req.headers['access-control-request-private-network'] === 'true'
        ? { 'Access-Control-Allow-Private-Network': 'true' }
        : {}),
    };
    const send = (status, body) => {
      const buf = Buffer.from(JSON.stringify(body));
      res.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(buf.length) });
      res.end(buf);
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (!allowedOrigin) {
      return send(403, { error: 'Forbidden origin' });
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/connector/ping') {
        return send(200, { ok: true, app: 'paperbridge-desktop', version });
      }
      if (req.method === 'GET' && url.pathname === '/connector/collections') {
        const data = await callRendererConnector('collections', {});
        return send(200, data);
      }
      if (req.method === 'POST' && url.pathname === '/connector/save') {
        const raw = await readLimitedBody(req, MAX_CONNECTOR_BODY);
        const payload = raw ? JSON.parse(raw.toString('utf8')) : {};
        const data = await callRendererConnector('save', payload);
        return send(200, { ok: true, ...data });
      }
      send(404, { error: 'Not found' });
    } catch (e) {
      send(e?.status ?? 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(23129, '127.0.0.1', resolve);
    });
    return server;
  } catch (e) {
    console.warn('connector server disabled:', e?.message ?? e);
    return null;
  }
}
const pdfArgs = (argv) => argv.filter((a) => /\.pdf$/i.test(a) && !a.startsWith('-'));
pending.push(...pdfArgs(process.argv.slice(1)));

async function flushFiles() {
  if (!rendererReady || !win || !pending.length) return;
  const paths = pending;
  pending = [];
  const files = [];
  for (const path of paths) {
    try {
      files.push({ name: path.split(/[\\/]/).pop(), data: new Uint8Array(await readFile(path)) });
    } catch (e) {
      console.warn('cannot open', path, e.message);
    }
  }
  if (files.length) win.webContents.send('paperbridge:open-files', files);
}
app.on('open-file', (event, path) => {
  event.preventDefault();
  pending.push(path);
  flushFiles();
});

function writeNodeHeaders(response, status, headers) {
  const values = Object.fromEntries(headers);
  const cookies = headers.getSetCookie?.();
  if (cookies?.length) values['set-cookie'] = cookies;
  response.writeHead(status, values);
}

async function readLimitedBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw bodyTooLarge();
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

/**
 * Local desktop proxy powered by Electron's Chromium network stack (`net.fetch`),
 * so system proxy / Clash / VPN, Happy Eyeballs IPv4/IPv6 fallback, and OS root
 * certificates all work automatically on Windows, macOS and Linux.
 */
async function startProxy() {
  const token = randomBytes(24).toString('hex');
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    response.once('close', () => {
      if (!response.writableFinished) controller.abort();
    });
    request.socket.setNoDelay(true);

    const incoming = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) incoming.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const cors = corsHeaders(incoming, request.method === 'OPTIONS');

    try {
      if (request.method === 'OPTIONS') {
        writeNodeHeaders(response, 204, cors);
        response.end();
        return;
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/health' && request.method === 'GET') {
        cors.set('content-type', 'text/plain; charset=utf-8');
        writeNodeHeaders(response, 200, cors);
        response.end('ok');
        return;
      }
      if (url.pathname !== '/proxy') throw new ProxyError(404, 'Not found');
      if (incoming.get('x-proxy-token') !== token) throw new ProxyError(403, 'Invalid or missing proxy token');

      const target = parseTarget(url);
      if (Number(incoming.get('content-length')) > MAX_BODY_BYTES) throw bodyTooLarge();
      const method = request.method || 'GET';
      const hasAuth = incoming.has('authorization') || incoming.has('x-api-key');
      const isPublicDownload = (method === 'GET' || method === 'HEAD') && !hasAuth;
      const headers = upstreamHeaders(incoming, isPublicDownload);
      const body = method === 'GET' || method === 'HEAD' ? undefined : await readLimitedBody(request, MAX_BODY_BYTES);

      const upstream = await net.fetch(target.href, {
        method,
        headers,
        body,
        redirect: isPublicDownload ? 'follow' : 'manual',
        signal: controller.signal,
      });

      const status = upstream.status;
      const hasBody = method !== 'HEAD' && status !== 204 && status !== 205 && status !== 304 && !!upstream.body;
      // Electron net.fetch transparently decodes gzip/br/deflate, so strip stale content-encoding/length
      const outgoing = responseHeaders(upstream.headers, cors, true);
      writeNodeHeaders(response, status, outgoing);
      if (hasBody) {
        response.flushHeaders();
        await pipeline(Readable.fromWeb(upstream.body), response, { signal: controller.signal });
      } else {
        response.end();
      }
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const wrapped =
        error instanceof ProxyError
          ? error
          : new ProxyError(502, `Upstream request failed${error?.message ? ` (${error.message})` : ''}`);
      const failure = errorResponse(wrapped, cors);
      writeNodeHeaders(response, failure.status, failure.headers);
      response.end(await failure.text());
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { url: `http://127.0.0.1:${server.address().port}`, token, server };
}

async function serve(request) {
  const url = new URL(request.url);
  let path = decodeURIComponent(url.pathname);
  if (path === '/' || path === '') path = '/index.html';
  const file = normalize(join(WEB, path));
  if (file !== WEB && !file.startsWith(WEB + sep)) return new Response('forbidden', { status: 403 });
  try {
    const body = await readFile(file);
    return new Response(body, { headers: { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' } });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

// the window's size and position survive restarts (if the saved spot is still on a connected screen)
const stateFile = () => join(app.getPath('userData'), 'window.json');
function loadBounds() {
  try {
    const b = JSON.parse(readFileSync(stateFile(), 'utf8'));
    if (!(b.width >= 600 && b.height >= 400)) return null;
    const visible = screen.getAllDisplays().some(({ workArea: a }) => b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 20 && b.y < a.y + a.height - 80);
    return visible ? b : { width: b.width, height: b.height, maximized: b.maximized };
  } catch {
    return null;
  }
}
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    writeFileSync(stateFile(), JSON.stringify({ ...(win.isMaximized() || win.isMinimized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds()), maximized: win.isMaximized() }));
  } catch {
    /* read-only profile: ignore */
  }
}

function createWindow() {
  const saved = loadBounds();
  win = new BrowserWindow({
    width: saved?.width ?? 1400,
    height: saved?.height ?? 900,
    ...(saved?.x !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 900,
    minHeight: 600,
    title: 'PaperBridge',
    icon: join(here, 'build', 'icon.png'),
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  // only our own pages load in the window; everything else goes to the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(ORIGIN)) return;
    event.preventDefault();
    if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url);
  });
  if (saved?.maximized) win.maximize();
  let timer = null;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(saveBounds, 500);
  };
  win.on('resize', later);
  win.on('move', later);
  win.on('close', saveBounds);
  win.loadURL(`${ORIGIN}/index.html`);
}

app.on('second-instance', (_event, argv) => {
  pending.push(...pdfArgs(argv.slice(1)));
  flushFiles();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(async () => {
  const proxy = await startProxy();
  const connector = await startConnectorServer(app.getVersion());
  info = { proxyUrl: proxy.url, proxyToken: proxy.token, version: app.getVersion(), platform: process.platform };
  ipcMain.on('paperbridge:info', (event) => {
    event.returnValue = info;
  });
  ipcMain.on('paperbridge:ready', () => {
    rendererReady = true;
    flushFiles();
  });
  ipcMain.on('paperbridge:connector-res', (_event, msg) => {
    const entry = connectorPending.get(msg?.id);
    if (!entry) return;
    connectorPending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.data);
    else entry.reject(new Error(msg.error || 'Connector request failed'));
  });
  protocol.handle('app', serve);
  // a small menu (hidden until Alt on Windows/Linux) keeps the usual shortcuts: copy/paste, zoom, reload
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { label: '文件', submenu: [{ role: 'quit', label: '退出' }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      {
        label: '视图',
        submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
      },
    ]),
  );
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on('before-quit', () => {
    proxy.server.close();
    connector?.close();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

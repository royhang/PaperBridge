// PaperBridge desktop client (Electron).
//  - serves the built web app from app://paperbridge/ (a secure, standard scheme: IndexedDB, Cache Storage,
//    module workers and WebAssembly behave as on https)
//  - runs the CORS proxy in-process on 127.0.0.1:<random port> with a random token, so every translation
//    provider and paper download works without any setup; the page learns the address via the preload
//  - all data stays local (the profile's IndexedDB); links open in the system browser
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, Menu, app, ipcMain, protocol, screen, shell } from 'electron';
import { createProxyServer } from './proxy/server.mjs';

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

async function startProxy() {
  const token = randomBytes(24).toString('hex');
  const server = createProxyServer({
    env: { ALLOWED_HOSTS: '*', ALLOW_ANY_GET: '1', ALLOW_PRIVATE: '1', PROXY_TOKEN: token, MAX_DOWNLOAD_MB: '300' },
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
  info = { proxyUrl: proxy.url, proxyToken: proxy.token, version: app.getVersion(), platform: process.platform };
  ipcMain.on('paperbridge:info', (event) => {
    event.returnValue = info;
  });
  ipcMain.on('paperbridge:ready', () => {
    rendererReady = true;
    flushFiles();
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
  app.on('before-quit', () => proxy.server.close());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

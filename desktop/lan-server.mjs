// Built-in LAN Share Server for PaperBridge Desktop (Electron).
// Serves the built Web SPA + Multi-Device Sync API (/api/*) + authenticated CORS Proxy (/proxy)
// on 0.0.0.0:<port> so iPads / phones on the same Wi-Fi can read & sync without Docker or a cloud server.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.wasm']);
const VIRTUAL_IFACE_RE = /(vethernet|wsl|docker|vmware|virtualbox|vbox|hyper-v|loopback|tailscale|zerotier|utun|tun|tap|virbr|br-|meta|clash|mihomo|sing-box)/i;

function ifacePriority(name, address) {
  let score = 0;
  if (VIRTUAL_IFACE_RE.test(name)) score += 100;
  if (address.startsWith('192.168.')) score += 0;
  else if (address.startsWith('10.')) score += 10;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 20;
  else if (address.startsWith('100.')) score += 60; // CGNAT / Tailscale
  else score += 40;
  if (/(wi-fi|wifi|wlan|en0|ethernet|以太网|无线)/i.test(name) && !VIRTUAL_IFACE_RE.test(name)) score -= 5;
  return score;
}

/** Return sorted non-internal IPv4 addresses suitable for LAN access from iPad/mobile. */
export function detectLanAddresses() {
  const nets = networkInterfaces();
  const found = [];
  for (const [name, list] of Object.entries(nets)) {
    if (!list) continue;
    for (const info of list) {
      const family = typeof info.family === 'string' ? info.family : info.family === 4 ? 'IPv4' : 'IPv6';
      if (family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue; // link-local APIPA
      found.push({ name, address: info.address, score: ifacePriority(name, info.address) });
    }
  }
  found.sort((a, b) => a.score - b.score || a.address.localeCompare(b.address));
  const seen = new Set();
  return found.filter((x) => {
    if (seen.has(x.address)) return false;
    seen.add(x.address);
    return true;
  });
}

export function createLanHttpServer({ webDir, dataDir, proxyToken, proxyHandler, createSyncServer }) {
  const rootWeb = resolve(webDir);
  mkdirSync(dataDir, { recursive: true });
  const syncServer = createSyncServer({
    dataDir,
    env: {
      ALLOW_REGISTER: '1',
      PROXY_TOKEN: proxyToken,
      MAX_PDF_MB: '200',
      MAX_SYNC_MB: '64',
    },
  });

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }
    const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    let filePath = resolve(rootWeb, rel);
    if (filePath !== rootWeb && !filePath.startsWith(rootWeb + sep)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    let fileStat = null;
    try {
      fileStat = await stat(filePath);
    } catch {
      fileStat = null;
    }
    if (!fileStat || fileStat.isDirectory()) {
      if (!extname(rel)) {
        filePath = join(rootWeb, 'index.html');
        try {
          fileStat = await stat(filePath);
        } catch {
          fileStat = null;
        }
      }
      if (!fileStat || fileStat.isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
    }

    const ext = extname(filePath).toLowerCase();
    const contentType = MIME[ext] ?? 'application/octet-stream';
    const isImmutable = decoded.startsWith('/assets/');
    const headers = {
      'Content-Type': contentType,
      'Cache-Control': isImmutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };

    const body = await readFile(filePath);
    const acceptsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''));
    if (acceptsGzip && COMPRESSIBLE.has(ext) && body.length > 1024 && body.length < 4 * 1024 * 1024) {
      const gz = gzipSync(body, { level: 6 });
      res.writeHead(200, {
        ...headers,
        'Content-Encoding': 'gzip',
        Vary: 'Accept-Encoding',
        'Content-Length': String(gz.length),
      });
      res.end(req.method === 'HEAD' ? undefined : gz);
      return;
    }

    res.writeHead(200, { ...headers, 'Content-Length': String(body.length) });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  return createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname.startsWith('/api/')) {
      syncServer.emit('request', req, res);
      return;
    }
    if (pathname === '/proxy' || pathname === '/health') {
      proxyHandler(req, res);
      return;
    }
    void serveStatic(req, res, pathname).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(err instanceof Error ? err.message : 'Internal Server Error');
      }
    });
  });
}

function normalizePort(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1024 || n > 65535) return 8787;
  return n;
}

export function createLanController({ webDir, dataDir, configFile, createProxyHandler, createSyncServer }) {
  function loadConfig() {
    try {
      if (existsSync(configFile)) {
        const parsed = JSON.parse(readFileSync(configFile, 'utf8'));
        return {
          enabled: Boolean(parsed.enabled),
          port: normalizePort(parsed.port ?? 8787),
          proxyToken: typeof parsed.proxyToken === 'string' && parsed.proxyToken.length >= 16 ? parsed.proxyToken : randomBytes(24).toString('hex'),
        };
      }
    } catch {
      /* ignore corrupt config */
    }
    return { enabled: false, port: 8787, proxyToken: randomBytes(24).toString('hex') };
  }

  function saveConfig(cfg) {
    try {
      mkdirSync(dirname(configFile), { recursive: true });
      writeFileSync(configFile, JSON.stringify(cfg, null, 2));
    } catch {
      /* read-only profile */
    }
  }

  let config = loadConfig();
  saveConfig(config);

  let server = null;
  let activePort = config.port;
  let lastError = '';
  const sockets = new Set();

  async function stopServer() {
    if (!server) return;
    const s = server;
    server = null;
    for (const sock of sockets) {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
    }
    sockets.clear();
    await new Promise((r) => s.close(() => r()));
  }

  async function startServer(port) {
    await stopServer();
    lastError = '';
    const proxyHandler = createProxyHandler(config.proxyToken);
    const s = createLanHttpServer({
      webDir,
      dataDir,
      proxyToken: config.proxyToken,
      proxyHandler,
      createSyncServer,
    });
    s.on('connection', (sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
    });
    try {
      await new Promise((resolveStart, rejectStart) => {
        s.once('error', rejectStart);
        s.listen(port, '0.0.0.0', () => {
          s.removeListener('error', rejectStart);
          resolveStart();
        });
      });
      server = s;
      activePort = s.address().port;
    } catch (e) {
      const code = e?.code;
      lastError =
        code === 'EADDRINUSE'
          ? `端口 ${port} 已被占用，请更换其他端口后重试`
          : code === 'EACCES'
            ? `没有权限监听端口 ${port}，请使用 1024–65535 之间的端口`
            : `启动局域网共享失败：${e instanceof Error ? e.message : String(e)}`;
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
  }

  function getStatus() {
    const running = Boolean(server && server.listening);
    const port = running ? activePort : config.port;
    const addrs = detectLanAddresses();
    const urls = addrs.map((a) => ({ name: a.name, address: a.address, url: `http://${a.address}:${port}` }));
    return {
      enabled: config.enabled,
      running,
      port,
      localUrl: `http://127.0.0.1:${port}`,
      urls,
      primaryUrl: urls[0]?.url ?? `http://127.0.0.1:${port}`,
      dataDir,
      error: lastError,
    };
  }

  async function configure(opts = {}) {
    const nextEnabled = opts.enabled !== undefined ? Boolean(opts.enabled) : config.enabled;
    const nextPort = opts.port !== undefined ? normalizePort(opts.port) : config.port;
    config = { ...config, enabled: nextEnabled, port: nextPort };
    saveConfig(config);
    if (nextEnabled) {
      await startServer(nextPort);
    } else {
      lastError = '';
      await stopServer();
    }
    return getStatus();
  }

  async function startIfEnabled() {
    if (config.enabled) await startServer(config.port);
    return getStatus();
  }

  return {
    getStatus,
    configure,
    startIfEnabled,
    close: stopServer,
  };
}

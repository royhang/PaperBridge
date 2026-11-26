#!/usr/bin/env node
/**
 * PaperBridge All-in-One production server (Web SPA + CORS Proxy + Multi-Device Sync API).
 *
 * Serves everything on a single port (default 8080) with zero external dependencies:
 *   /api/*        → Multi-device incremental cloud sync & browser connector API
 *   /proxy        → Built-in CORS proxy for LLM / MT APIs & PDF fetching
 *   /health       → Proxy health check
 *   /*            → Static SPA assets from dist/ with Gzip & immutable asset caching
 *
 * Env:
 *   PORT=8080
 *   HOST=0.0.0.0
 *   WEB_DIR=./dist
 *   SYNC_DATA_DIR=/data
 *   ALLOW_REGISTER=1
 *   INVITE_CODE=
 *   ALLOWED_HOSTS=*
 *   ALLOWED_ORIGINS=
 *   PROXY_TOKEN=
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createProxyServer } from '../proxy/server.mjs';
import { createSyncServer } from '../sync/server.mjs';

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
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.wasm']);

export function createAllInOneServer(opts = {}) {
  const env = opts.env ?? process.env;
  const webDir = resolve(opts.webDir ?? env.WEB_DIR ?? join(fileURLToPath(new URL('..', import.meta.url)), 'dist'));
  const dataDir = resolve(opts.dataDir ?? env.SYNC_DATA_DIR ?? '/data');

  const syncServer = createSyncServer({ dataDir, env });
  const proxyServer = createProxyServer({ env });

  function serveStatic(req, res, pathname) {
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
    let filePath = resolve(webDir, rel);
    if (filePath !== webDir && !filePath.startsWith(webDir + sep)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      // SPA fallback only for extension-less routes
      if (!extname(rel)) filePath = join(webDir, 'index.html');
      if (!existsSync(filePath)) {
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

    const stat = statSync(filePath);
    const acceptsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''));
    if (acceptsGzip && COMPRESSIBLE.has(ext) && stat.size > 1024 && stat.size < 4 * 1024 * 1024) {
      const gz = gzipSync(readFileSync(filePath), { level: 6 });
      res.writeHead(200, {
        ...headers,
        'Content-Encoding': 'gzip',
        Vary: 'Accept-Encoding',
        'Content-Length': String(gz.length),
      });
      if (req.method === 'HEAD') res.end();
      else res.end(gz);
      return;
    }

    res.writeHead(200, { ...headers, 'Content-Length': String(stat.size) });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  }

  return createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname.startsWith('/api/')) {
      syncServer.emit('request', req, res);
      return;
    }
    if (pathname === '/proxy' || pathname === '/health') {
      proxyServer.emit('request', req, res);
      return;
    }
    serveStatic(req, res, pathname);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST ?? '0.0.0.0';
  const port = Number(process.env.PORT) || 8080;
  const server = createAllInOneServer();
  server.listen(port, host, () => {
    console.log(`PaperBridge All-in-One listening on http://${host}:${port} (data: ${resolve(process.env.SYNC_DATA_DIR ?? '/data')})`);
  });
}

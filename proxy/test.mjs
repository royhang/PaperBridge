import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Agent, createServer, request } from 'node:http';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { createProxyServer } from './server.mjs';
import worker from './worker.js';

const appOrigin = 'https://paper.example';
const localEnv = { ALLOWED_HOSTS: '*', ALLOW_PRIVATE: '1' };
const openEnv = { ALLOWED_HOSTS: 'api.example.com', ALLOW_ANY_GET: '1' };
const bodyLimit = 10 * 1024 * 1024;
const events = ['data: one\n\n', 'data: two\n\n', 'data: three\n\n'];
let upstreamBase;
let proxyBase;
let continueSse;
let lastSseChunkSent = false;
let observeDisconnect;
const sharedServers = [];

function stop(server) {
  server.closeAllConnections?.();
  if (server.listening) return new Promise(resolve => server.close(resolve));
}

async function start(server, testContext) {
  if (testContext) testContext.after(() => stop(server));
  else sharedServers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function send(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = request(url, options, resolve);
    req.once('error', reject);
    req.end(body);
  });
}

function proxied(url, base = proxyBase) {
  return `${base}/proxy?url=${encodeURIComponent(url)}`;
}

after(() => Promise.all(sharedServers.map(stop)));

before(async () => {
  upstreamBase = await start(createServer(async (req, res) => {
    if (req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream': 'sse' });
      res.write(events[0]);
      await new Promise(resolve => { continueSse = resolve; });
      await delay(25);
      res.write(events[1]);
      await delay(25);
      lastSseChunkSent = true;
      res.end(events[2]);
      return;
    }
    if (req.url === '/gzip') {
      const body = gzipSync('compressed response');
      res.writeHead(202, { 'content-encoding': 'gzip', 'content-length': body.length });
      res.end(body);
      return;
    }
    if (req.url === '/disconnect') {
      res.once('close', observeDisconnect);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(events[0]);
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(307, { location: `${upstreamBase}/echo` });
      res.end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    } catch (error) {
      if (!req.destroyed) res.destroy(error);
    }
  }));
  proxyBase = await start(createProxyServer({ env: localEnv }));
});

test('health and permissive preflight', async () => {
  const health = await fetch(`${proxyBase}/health`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');
  assert.equal(health.headers.get('access-control-allow-origin'), '*');

  const res = await fetch(proxied(`${upstreamBase}/echo`), {
    method: 'OPTIONS',
    headers: {
      origin: appOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type, x-proxy-token',
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), appOrigin);
  assert.match(res.headers.get('access-control-allow-methods'), /\bPOST\b/);
  assert.equal(res.headers.get('access-control-allow-headers'), 'authorization, content-type, x-proxy-token');
  assert.equal(res.headers.get('access-control-max-age'), '86400');
});

test('SSE reaches the client before the upstream sends its final event', async t => {
  t.after(() => continueSse?.());
  const res = await fetch(proxied(`${upstreamBase}/sse`), {
    headers: { origin: appOrigin },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.equal(res.headers.get('x-upstream'), 'sse');
  assert.equal(res.headers.get('access-control-allow-origin'), appOrigin);
  assert.equal(res.headers.get('access-control-expose-headers'), '*');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  while (!received.endsWith('\n\n')) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    received += decoder.decode(value, { stream: true });
  }
  assert.equal(received, events[0]);
  assert.equal(lastSseChunkSent, false);
  continueSse();
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    received += decoder.decode(chunk.value, { stream: true });
  }
  assert.equal(received + decoder.decode(), events.join(''));
});

test('forwards POST bodies and API headers while stripping browser and hop-by-hop headers', async () => {
  const body = JSON.stringify({ text: 'translate me' });
  const res = await send(proxied(`${upstreamBase}/echo`), {
    method: 'POST',
    headers: {
      'accept-encoding': 'gzip',
      authorization: 'Bearer vendor-key',
      connection: 'x-hop',
      'content-length': Buffer.byteLength(body),
      'content-type': 'application/json',
      cookie: 'session=private',
      origin: appOrigin,
      referer: `${appOrigin}/reader`,
      'sec-fetch-site': 'cross-site',
      'x-hop': 'strip me',
      'x-proxy-token': 'strip me too',
    },
  }, body);
  assert.equal(res.statusCode, 200);
  let json = '';
  for await (const chunk of res.setEncoding('utf8')) json += chunk;
  const echoed = JSON.parse(json);
  assert.equal(echoed.method, 'POST');
  assert.equal(echoed.body, body);
  assert.equal(echoed.headers.authorization, 'Bearer vendor-key');
  assert.equal(echoed.headers['accept-encoding'], 'identity');
  assert.equal(echoed.headers['content-type'], 'application/json');
  for (const header of ['origin', 'referer', 'cookie', 'sec-fetch-site', 'x-hop', 'x-proxy-token']) {
    assert.equal(echoed.headers[header], undefined, header);
  }
});

test('preserves status and streams a decoded response without stale encoding metadata', async () => {
  const res = await fetch(proxied(`${upstreamBase}/gzip`));
  assert.equal(res.status, 202);
  assert.equal(res.headers.get('content-encoding'), null);
  assert.equal(res.headers.get('content-length'), null);
  assert.equal(await res.text(), 'compressed response');
});

test('aborts the upstream stream when the client disconnects', { timeout: 5000 }, async () => {
  const disconnected = new Promise(resolve => { observeDisconnect = resolve; });
  const response = await fetch(proxied(`${upstreamBase}/disconnect`), {
    signal: AbortSignal.timeout(5000),
  });
  const reader = response.body.getReader();
  const { value } = await reader.read();
  assert.equal(new TextDecoder().decode(value), events[0]);
  await reader.cancel();
  await disconnected;
});

test('returns upstream redirects without following them', async () => {
  const res = await fetch(proxied(`${upstreamBase}/redirect`), { redirect: 'manual' });
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), `${upstreamBase}/echo`);
  await res.text();
});

test('requires the configured token and removes it from upstream requests', async t => {
  const base = await start(createProxyServer({
    env: { ...localEnv, PROXY_TOKEN: 'test-secret' },
  }), t);
  const url = proxied(`${upstreamBase}/echo`, base);
  for (const headers of [{}, { 'x-proxy-token': 'wrong' }]) {
    const denied = await fetch(url, { headers });
    assert.equal(denied.status, 403);
    assert.match((await denied.json()).error.message, /token/i);
  }
  const preflight = await fetch(url, {
    method: 'OPTIONS',
    headers: { 'access-control-request-headers': 'x-proxy-token' },
  });
  assert.equal(preflight.status, 204);
  const accepted = await fetch(url, { headers: { 'x-proxy-token': 'test-secret' } });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).headers['x-proxy-token'], undefined);
});

test('allows configured origins and same-origin fetches without requiring the token', async t => {
  const base = await start(createProxyServer({
    env: { ...localEnv, PROXY_TOKEN: 'test-secret', ALLOWED_ORIGINS: `${appOrigin},https://self.example:9999` },
  }), t);
  const url = proxied(`${upstreamBase}/echo`, base);

  const foreign = await fetch(url, { headers: { origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);

  const noOrigin = await fetch(url);
  assert.equal(noOrigin.status, 403);

  const byOrigin = await fetch(url, { headers: { origin: appOrigin } });
  assert.equal(byOrigin.status, 200);

  const bySameOrigin = await fetch(url, {
    headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-host': 'self.example:9999' },
  });
  assert.equal(bySameOrigin.status, 200);

  const wrongHost = await fetch(url, {
    headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-host': 'other.example:9999' },
  });
  assert.equal(wrongHost.status, 403);
});

test('rejects invalid schemes and defaults to blocking private IP literals and unlisted hosts', async t => {
  const invalid = await fetch(proxied('file:///tmp/paper'));
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error.message, /HTTP or HTTPS/);

  const base = await start(createProxyServer({ env: { ALLOWED_HOSTS: '*' } }), t);
  for (const target of [upstreamBase, 'http://0x7f000001/', 'http://[::1]/', 'http://[::ffff:10.0.0.1]/']) {
    const blocked = await fetch(proxied(target, base));
    assert.equal(blocked.status, 403, target);
    assert.match((await blocked.json()).error.message, /private or loopback/i);
  }

  const defaultBase = await start(createProxyServer({ env: {} }), t);
  const unlisted = await fetch(proxied('https://fakeapi.openai.com/', defaultBase));
  assert.equal(unlisted.status, 403);
  assert.match((await unlisted.json()).error.message, /not allowed/i);
});

test('rejects both declared and streamed bodies larger than 10 MB', async () => {
  const url = proxied(`${upstreamBase}/echo`);
  const declared = await send(url, {
    method: 'POST',
    headers: { 'content-length': bodyLimit + 1 },
  });
  assert.equal(declared.statusCode, 413);
  declared.resume();

  let remaining = bodyLimit + 1;
  const body = new ReadableStream({
    pull(stream) {
      const size = Math.min(remaining, 64 * 1024);
      stream.enqueue(new Uint8Array(size));
      remaining -= size;
      if (remaining === 0) stream.close();
    },
  });
  const streamed = await fetch(url, {
    method: 'POST', body, duplex: 'half', signal: AbortSignal.timeout(5000),
  });
  assert.equal(streamed.status, 413);
  assert.match((await streamed.json()).error.message, /10 MB/);
});

test('opens unlisted GET and HEAD only with the configured token and explicit private override', async t => {
  const blockedBase = await start(createProxyServer({ env: openEnv }), t);
  const blocked = await fetch(proxied(`${upstreamBase}/echo`, blockedBase));
  assert.equal(blocked.status, 403);
  assert.match((await blocked.json()).error.message, /private or loopback/i);

  const env = { ...openEnv, ALLOW_PRIVATE: '1', PROXY_TOKEN: 'download-token' };
  const base = await start(createProxyServer({ env }), t);
  const url = proxied(`${upstreamBase}/redirect`, base);
  const headers = {
    'x-proxy-token': env.PROXY_TOKEN,
    authorization: 'Bearer vendor-key',
    'x-api-key': 'vendor-key',
    cookie: 'session=private',
    origin: appOrigin,
  };
  const denied = await fetch(url);
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error.message, /token/i);
  const post = await fetch(url, { method: 'POST', headers });
  assert.equal(post.status, 403);
  assert.match((await post.json()).error.message, /not allowed/i);

  const res = await fetch(url, { headers });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), appOrigin);
  const echoed = await res.json();
  assert.equal(echoed.headers['accept-encoding'], 'identity');
  for (const name of ['authorization', 'x-api-key', 'cookie', 'x-proxy-token']) {
    assert.equal(echoed.headers[name], undefined, name);
  }
  const head = await fetch(url, { method: 'HEAD', headers });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('rejects a hostname if any DNS answer is private, including for allowlisted hosts', async t => {
  const privateAddress = { address: '127.0.0.1', family: 4 };
  const resolve = async (hostname, options) => {
    assert.deepEqual(options, { all: true });
    return hostname === 'mixed.example' ? [{ address: '93.184.215.14', family: 4 }, privateAddress] : [privateAddress];
  };
  const base = await start(createProxyServer({ env: openEnv, resolve }), t);
  for (const hostname of ['local.example', 'mixed.example', 'api.example.com']) {
    const url = new URL(upstreamBase);
    url.hostname = hostname;
    const res = await fetch(proxied(url, base), { signal: AbortSignal.timeout(5000) });
    assert.equal(res.status, 403, hostname);
    assert.match((await res.json()).error.message, /private or loopback/i);
  }
});

test('dials the checked DNS answer once per request and checks each redirect target', async t => {
  const hostname = 'public.example';
  const publicAddress = '93.184.215.14';
  const requests = [];
  const upstream = await start(createServer((req, res) => {
    requests.push(req);
    if (req.url === '/relative') {
      res.writeHead(302, { location: '/echo' });
      res.end();
    } else if (req.url === '/private') {
      res.writeHead(302, { location: `${upstreamBase}/echo` });
      res.end();
    } else {
      res.end('public');
    }
  }), t);
  const originalConnect = Agent.prototype.createConnection;
  const dialed = [];
  t.mock.method(Agent.prototype, 'createConnection', function (options, callback) {
    if (options.host !== hostname) return originalConnect.call(this, options, callback);
    // Capture the address Node gets from the pinning callback, then use the local fixture socket.
    return originalConnect.call(this, {
      ...options,
      lookup(name, lookupOptions, done) {
        options.lookup(name, lookupOptions, (error, address, family) => {
          if (error) return done(error);
          const list = Array.isArray(address) ? address : [{ address, family }];
          for (const entry of list) {
            dialed.push({ address: entry.address, family: entry.family });
            if (entry.address !== publicAddress) return done(new Error('Unexpected dial address'));
          }
          if (lookupOptions?.all) done(null, [{ address: '127.0.0.1', family: 4 }]);
          else done(null, '127.0.0.1', 4);
        });
      },
    }, callback);
  });
  let lookups = 0;
  const resolve = async name => {
    assert.equal(name, hostname);
    return [{ address: ++lookups === 1 ? publicAddress : '127.0.0.1', family: 4 }];
  };
  const base = await start(createProxyServer({ env: openEnv, resolve }), t);
  const target = new URL(upstream);
  target.hostname = hostname;
  target.pathname = '/echo';
  const ok = await fetch(proxied(target, base), { signal: AbortSignal.timeout(5000) });
  assert.equal(await ok.text(), 'public');
  assert.equal(lookups, 1);
  assert.deepEqual(dialed, [{ address: publicAddress, family: 4 }]);
  assert.equal(requests[0].headers.host, target.host);

  for (const path of ['/relative', '/private']) {
    lookups = 0;
    target.pathname = path;
    const res = await fetch(proxied(target, base), { signal: AbortSignal.timeout(5000) });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error.message, /private or loopback/i);
    assert.equal(lookups, path === '/relative' ? 2 : 1);
  }
  assert.deepEqual(requests.map(req => req.url), ['/echo', '/relative', '/private']);
});

test('caps open downloads by declared, streamed and decoded sizes and returns metadata', async t => {
  const large = Buffer.alloc(2048);
  const upstream = await start(createServer((req, res) => {
    if (req.url === '/declared') {
      res.writeHead(200, { 'content-length': large.length });
      res.end(large);
    } else if (req.url === '/gzip') {
      const compressed = gzipSync(large);
      res.writeHead(200, { 'content-length': compressed.length, 'content-encoding': 'gzip' });
      res.end(compressed);
    } else if (req.url === '/chunked') {
      res.write(large.subarray(0, 512));
      res.end(large.subarray(512));
    } else {
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="paper.pdf"',
        'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
        etag: '"paper"',
      });
      res.write('%PDF');
      res.end('-test');
    }
  }), t);
  const base = await start(createProxyServer({
    env: { ...openEnv, ALLOW_PRIVATE: '1', MAX_DOWNLOAD_MB: '0.001' },
  }), t);
  for (const [path, status] of [['/declared', 413], ['/chunked', 502], ['/gzip', 502]]) {
    const res = await fetch(proxied(`${upstream}${path}`, base));
    assert.equal(res.status, status, path);
    assert.match((await res.json()).error.message, /download size/i);
  }
  const res = await fetch(proxied(`${upstream}/paper`, base));
  for (const [name, expected] of Object.entries({
    'content-type': 'application/pdf',
    'content-length': '9',
    'content-disposition': 'attachment; filename="paper.pdf"',
    'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
    etag: '"paper"',
  })) assert.equal(res.headers.get(name), expected, name);
  assert.equal(await res.text(), '%PDF-test');
});

test('follows up to five redirects and keeps API credentials out of every hop', async t => {
  const seen = [];
  const upstream = await start(createServer((req, res) => {
    seen.push(req.headers);
    const hops = Number(req.url.slice(1));
    if (hops) {
      const location = hops === 1 ? `${upstream}/0` : `/${hops - 1}`;
      res.writeHead(301, { location });
    }
    res.end(hops ? undefined : 'done');
  }), t);
  const host = new URL(upstream).host;
  const base = await start(createProxyServer({
    env: { ALLOWED_HOSTS: '127.0.0.1', ALLOW_ANY_GET: '1', ALLOW_PRIVATE: '1' },
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
  }), t);
  const options = { headers: { authorization: 'Bearer secret', 'x-api-key': 'secret', cookie: 'secret' } };
  const startUrl = new URL(upstream);
  startUrl.hostname = 'public.example';
  startUrl.pathname = '/5';
  const ok = await fetch(proxied(startUrl, base), options);
  assert.equal(await ok.text(), 'done');
  assert.equal(seen.length, 6);
  startUrl.pathname = '/6';
  const exceeded = await fetch(proxied(startUrl, base), options);
  assert.equal(exceeded.status, 502);
  assert.match((await exceeded.json()).error.message, /5 redirects/);
  assert.equal(seen.length, 12);
  for (const headers of seen) {
    assert.equal(headers.authorization, undefined);
    assert.equal(headers['x-api-key'], undefined);
    assert.equal(headers.cookie, undefined);
  }
  const api = await fetch(proxied(`http://${host}/0`, base), options);
  assert.equal(await api.text(), 'done');
  assert.equal(seen.at(-1).authorization, 'Bearer secret');
});

test('Worker open GET applies redirects and rejects private IP literals', async t => {
  const upstream = t.mock.method(globalThis, 'fetch', async (target, options) => {
    assert.equal(options.headers.get('authorization'), null);
    assert.equal(options.headers.get('x-api-key'), null);
    return new Response(null, { status: 302, headers: { location: 'http://198.18.0.1/admin' } });
  });
  const handle = target => worker.fetch(new Request(proxied(target, 'https://proxy.example'), {
    headers: { authorization: 'Bearer secret', 'x-api-key': 'secret' },
  }), openEnv);
  const rejected = await handle('https://public.example/');
  assert.equal(rejected.status, 403);
  assert.equal(upstream.mock.callCount(), 1);
  for (const address of ['0.1.2.3', '100.64.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1',
    '255.255.255.255', '[::]', '[::ffff:198.18.0.1]', '[fe80::1]', '[fc00::1]', '[ff00::1]', '[2001:db8::1]', '[3fff::1]']) {
    const res = await handle(`http://${address}/`);
    assert.equal(res.status, 403, address);
  }
  assert.equal(upstream.mock.callCount(), 1);
});

const DEFAULT_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'translation.googleapis.com',
  'api.deepl.com',
  'api-free.deepl.com',
  'fanyi-api.baidu.com',
  'openapi.youdao.com',
  'api.deepseek.com',
  'api.moonshot.cn',
  'dashscope.aliyuncs.com',
  'open.bigmodel.cn',
  'api.siliconflow.cn',
  'openrouter.ai',
];

const HOP_BY_HOP = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
];

const DOWNLOAD_HEADERS = [
  'accept-ranges', 'content-disposition', 'content-encoding', 'content-length',
  'content-range', 'content-type', 'etag', 'last-modified', 'vary',
];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const MAX_BODY_BYTES = 10 * 1024 * 1024;

export class ProxyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function proxyConfig(env) {
  const hosts = env.ALLOWED_HOSTS?.trim();
  const origins = env.ALLOWED_ORIGINS?.trim();
  const downloadBytes = Math.floor(Number(env.MAX_DOWNLOAD_MB ?? 100) * 1024 * 1024);
  return {
    hosts: hosts === '*' ? null : (hosts?.split(',') ?? DEFAULT_HOSTS)
      .map(host => host.trim().toLowerCase().replace(/^\.|\.$/g, ''))
      .filter(Boolean),
    allowedOrigins: origins
      ? origins.split(',').map(o => o.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean)
      : [],
    allowPrivate: env.ALLOW_PRIVATE === '1',
    allowAnyGet: env.ALLOW_ANY_GET === '1',
    maxDownloadBytes: Number.isSafeInteger(downloadBytes) && downloadBytes > 0
      ? downloadBytes : 100 * 1024 * 1024,
    token: env.PROXY_TOKEN,
  };
}

function isPrivateIPv4([a, b, c]) {
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
}

export function isPrivateAddress(address) {
  if (!address.includes(':')) return isPrivateIPv4(address.split('.').map(Number));
  let host;
  try {
    host = new URL(`http://[${address}]/`).hostname;
  } catch {
    return true;
  }
  const mapped = /^\[::ffff:([\da-f]+):([\da-f]+)\]$/.exec(host);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return isPrivateIPv4([high >> 8, high & 255, low >> 8]);
  }
  // Require global unicast and exclude transition, benchmarking and documentation ranges.
  return !/^\[[23][\da-f]{3}:/.test(host)
    || /^\[(?:2001:(?::|0:|2:0?:|db8:)|2002:|3fff:(?::|[\da-f]{1,3}:))/.test(host);
}

function isPrivateHost(host) {
  // URL normalizes alternate IPv4 spellings and brackets IPv6 literals.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateAddress(host);
  if (host.startsWith('[')) return isPrivateAddress(host.slice(1, -1));
  return host === 'localhost' || host.endsWith('.localhost');
}

export function parseTarget(url) {
  let target;
  try {
    target = new URL(url.searchParams.get('url'));
  } catch {
    throw new ProxyError(400, 'A valid target URL is required');
  }
  return validateUrl(target);
}

function validateUrl(target) {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new ProxyError(400, 'Target URL must use HTTP or HTTPS');
  }
  if (target.username || target.password) {
    throw new ProxyError(400, 'Target URL must not contain credentials');
  }
  return target;
}

export function validatePublicTarget(target, config) {
  if (!config.allowPrivate && isPrivateHost(target.hostname.replace(/\.$/, ''))) {
    throw blockedAddress();
  }
}

export function blockedAddress() {
  return new ProxyError(403, 'Private or loopback targets are disabled');
}

function isAuthorizedOrigin(headers, allowedOrigins) {
  if (!allowedOrigins.length) return false;
  const origin = headers.get('origin')?.trim().replace(/\/+$/, '').toLowerCase();
  if (origin) return allowedOrigins.includes(origin);
  if (headers.get('sec-fetch-site') === 'same-origin') {
    const reqHost = (headers.get('x-forwarded-host') || headers.get('host') || '').trim().toLowerCase();
    if (!reqHost) return false;
    return allowedOrigins.some(o => {
      try { return new URL(o).host.toLowerCase() === reqHost; } catch { return false; }
    });
  }
  return false;
}

export function validateTarget(target, headers, config, method) {
  const host = target.hostname.replace(/\.$/, '');
  if (config.token && headers.get('x-proxy-token') !== config.token && !isAuthorizedOrigin(headers, config.allowedOrigins)) {
    throw new ProxyError(403, 'Invalid or missing proxy token');
  }
  validatePublicTarget(target, config);
  if (!config.hosts || config.hosts.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) return false;
  if (config.allowAnyGet && (method === 'GET' || method === 'HEAD')) return true;
  throw new ProxyError(403, 'Target host is not allowed');
}

export function redirectTarget(target, status, location, redirects, config) {
  if (!REDIRECT_STATUSES.has(status) || location === null || location === undefined) return;
  if (redirects >= 5) throw new ProxyError(502, 'Upstream exceeded 5 redirects');
  let next;
  try {
    next = new URL(location, target);
  } catch {
    throw new ProxyError(502, 'Upstream returned an invalid redirect URL');
  }
  validateUrl(next);
  validatePublicTarget(next, config);
  return next;
}

function stripHopByHop(headers) {
  const connection = headers.get('connection');
  for (const name of connection?.split(',') ?? []) {
    const token = name.trim();
    if (/^[!#$%&'*+.^_`|~\w-]+$/.test(token)) headers.delete(token);
  }
  for (const name of HOP_BY_HOP) headers.delete(name);
}

export function upstreamHeaders(incoming, openDownload = false) {
  const headers = new Headers(incoming);
  stripHopByHop(headers);
  for (const name of ['host', 'origin', 'referer', 'content-length', 'cookie', 'expect', 'x-proxy-token']) {
    headers.delete(name);
  }
  for (const name of [...headers.keys()]) {
    if (name.startsWith('sec-fetch-')) headers.delete(name);
  }
  if (openDownload) {
    headers.delete('authorization');
    headers.delete('x-api-key');
  }
  headers.set('accept-encoding', 'identity');
  return headers;
}

export function corsHeaders(requestHeaders, preflight = false) {
  const headers = new Headers({
    'Access-Control-Allow-Origin': requestHeaders.get('origin') || '*',
    'Access-Control-Expose-Headers': '*',
    Vary: 'Origin',
  });
  if (preflight) {
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    headers.set('Access-Control-Allow-Headers', requestHeaders.get('access-control-request-headers') || '*');
    headers.set('Access-Control-Max-Age', '86400');
    // Chromium's Private Network Access: a page (e.g. the desktop client) calling a proxy on localhost
    if (requestHeaders.get('access-control-request-private-network') === 'true') headers.set('Access-Control-Allow-Private-Network', 'true');
    headers.append('Vary', 'Access-Control-Request-Headers');
  }
  return headers;
}

export function responseHeaders(upstream, cors, decoded = false) {
  const headers = new Headers(upstream);
  stripHopByHop(headers);
  if (decoded) {
    headers.delete('content-encoding');
    headers.delete('content-length');
  }
  for (const name of [...headers.keys()]) {
    if (name.startsWith('access-control-')) headers.delete(name);
  }
  for (const [name, value] of cors) {
    if (name === 'vary') headers.append(name, value);
    else headers.set(name, value);
  }
  return headers;
}

export function downloadHeaders(upstream, cors, decoded = false) {
  const headers = responseHeaders(upstream, cors, decoded);
  for (const name of [...headers.keys()]) {
    if (!cors.has(name) && !DOWNLOAD_HEADERS.includes(name)) headers.delete(name);
  }
  return headers;
}

export function downloadTooLarge(status) {
  return new ProxyError(status, 'Upstream response exceeds the download size limit');
}

export function bodyTooLarge() {
  return new ProxyError(413, 'Request body exceeds 10 MB');
}

export function errorResponse(error, cors) {
  const { status, message } = error instanceof ProxyError
    ? error
    : { status: 502, message: 'Upstream request failed' };
  const headers = new Headers(cors);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify({ error: { message } }), { status, headers });
}

export default {
  async fetch(request, env) {
    const started = performance.now();
    const cors = corsHeaders(request.headers, request.method === 'OPTIONS');
    let host = '-';
    let bodyError;
    let response;
    try {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') {
        response = new Response(null, { status: 204, headers: cors });
      } else if (url.pathname === '/health' && request.method === 'GET') {
        response = new Response('ok', { headers: cors });
      } else {
        if (url.pathname !== '/proxy') throw new ProxyError(404, 'Not found');
        const target = parseTarget(url);
        host = target.hostname;
        const config = proxyConfig(env);
        const openDownload = validateTarget(target, request.headers, config, request.method);
        if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw bodyTooLarge();

        let size = 0;
        const body = request.body?.pipeThrough(new TransformStream({
          transform(chunk, stream) {
            size += chunk.byteLength;
            if (size > MAX_BODY_BYTES) {
              bodyError = bodyTooLarge();
              stream.error(bodyError);
            } else {
              stream.enqueue(chunk);
            }
          },
        }));
        const options = {
          method: request.method,
          headers: upstreamHeaders(request.headers, openDownload),
          body,
          duplex: 'half',
          signal: request.signal,
          redirect: 'manual',
        };
        let upstream = await fetch(target, options);
        if (openDownload) {
          let current = target;
          for (let redirects = 0; REDIRECT_STATUSES.has(upstream.status) && upstream.headers.has('location'); redirects++) {
            await upstream.body?.cancel();
            current = redirectTarget(current, upstream.status, upstream.headers.get('location'), redirects, config);
            upstream = await fetch(current, options);
          }
          if (Number(upstream.headers.get('content-length')) > config.maxDownloadBytes) {
            await upstream.body?.cancel();
            throw downloadTooLarge(413);
          }
        }
        if (bodyError) throw bodyError;
        const responseBody = openDownload ? upstream.body?.pipeThrough(new TransformStream({
          transform(chunk, stream) {
            size += chunk.byteLength;
            if (size > config.maxDownloadBytes) throw downloadTooLarge(502);
            stream.enqueue(chunk);
          },
        })) : upstream.body;
        response = new Response(responseBody, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: openDownload ? downloadHeaders(upstream.headers, cors) : responseHeaders(upstream.headers, cors),
        });
      }
    } catch (error) {
      response = errorResponse(bodyError ?? error, cors);
    }
    console.log(`${request.method} ${host} ${response.status} ${Math.round(performance.now() - started)}ms`);
    return response;
  },
};

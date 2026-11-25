import { lookup } from 'node:dns/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import {
  MAX_BODY_BYTES, ProxyError, blockedAddress, bodyTooLarge, corsHeaders, downloadHeaders,
  downloadTooLarge, errorResponse, isPrivateAddress, parseTarget, proxyConfig,
  redirectTarget, responseHeaders, upstreamHeaders, validateTarget,
} from './worker.js';

const decoders = new Map([
  ['gzip', zlib.createGunzip], ['x-gzip', zlib.createGunzip],
  ['deflate', zlib.createUnzip], ['br', zlib.createBrotliDecompress],
]);
if (zlib.createZstdDecompress) decoders.set('zstd', zlib.createZstdDecompress);
const IDLE_TIMEOUT_MS = 60_000;

async function* limitedBody(request, controller) {
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      controller.abort(bodyTooLarge());
      return;
    }
    yield chunk;
  }
}

function writeHeaders(response, status, headers) {
  const values = Object.fromEntries(headers);
  const cookies = headers.getSetCookie?.();
  if (cookies?.length) values['set-cookie'] = cookies;
  response.writeHead(status, values);
}

function pinnedLookup(resolve, allowPrivate) {
  return (hostname, options, callback) => {
    Promise.resolve().then(() => resolve(hostname, { all: true })).then(addresses => {
      if (!Array.isArray(addresses) || !addresses.length) throw new Error('No upstream DNS addresses');
      for (const { address, family } of addresses) {
        if (isIP(address) !== family || !family || (!allowPrivate && isPrivateAddress(address))) {
          throw blockedAddress();
        }
      }
      return addresses;
    }).then(addresses => {
      if (options.all) callback(null, addresses.map(({ address, family }) => ({ address, family })));
      else callback(null, addresses[0].address, addresses[0].family);
    }, callback);
  };
}

function requestUpstream(target, method, headers, body, signal, resolve, config, openDownload) {
  return new Promise((resolveResponse, reject) => {
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const fields = {
      accept: '*/*',
      'accept-language': '*',
      'user-agent': 'node',
      ...Object.fromEntries(headers),
    };
    if (body) fields['transfer-encoding'] = 'chunked';
    const outbound = send(target, {
      method,
      headers: fields,
      signal,
      agent: false,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 500,
      lookup: pinnedLookup(resolve, config.allowPrivate),
    }, resolveResponse);
    outbound.once('error', reject);
    outbound.once('close', () => reject(new Error('Upstream closed before responding')));
    if (openDownload) {
      const timeout = () => outbound.destroy(new ProxyError(502, 'Upstream request timed out'));
      const connecting = setTimeout(timeout, IDLE_TIMEOUT_MS);
      outbound.once('socket', socket => {
        socket.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(connecting));
      });
      outbound.once('close', () => clearTimeout(connecting));
      outbound.setTimeout(IDLE_TIMEOUT_MS, timeout);
    }
    if (body) pipeline(body, outbound).catch(error => outbound.destroy(error));
    else outbound.end();
  });
}

async function* limitDownload(source, maxBytes) {
  let size = 0;
  for await (const chunk of source) {
    size += chunk.length;
    if (size > maxBytes) throw downloadTooLarge(502);
    yield chunk;
  }
}

function upstreamDecoders(headers) {
  const encodings = headers.get('content-encoding')?.split(',').map(value => value.trim().toLowerCase());
  return encodings?.every(value => decoders.has(value))
    ? encodings.reverse().map(value => decoders.get(value)()) : [];
}

async function sendDownload(response, upstream, headers, cors, hasBody, config, signal) {
  const declared = headers.get('content-length');
  if (declared !== null && Number(declared) > config.maxDownloadBytes) {
    upstream.destroy();
    throw downloadTooLarge(413);
  }
  const status = upstream.statusCode;
  const transforms = hasBody ? upstreamDecoders(headers) : [];
  const outgoing = downloadHeaders(headers, cors, transforms.length > 0);
  if (!hasBody) {
    upstream.resume();
    writeHeaders(response, status, outgoing);
    response.end();
    return;
  }
  // Node's HTTP parser frames a declared-length body. Other bodies must pass the byte
  // limit before we commit headers, since a streamed 200 cannot become a JSON 502.
  if (declared !== null && !transforms.length) {
    writeHeaders(response, status, outgoing);
    response.flushHeaders();
    await pipeline(upstream, response, { signal });
    return;
  }
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'paper-proxy-'));
    const file = join(directory, 'download');
    const output = createWriteStream(file, { mode: 0o600 });
    const limit = source => limitDownload(source, config.maxDownloadBytes);
    const stages = transforms.length ? [limit, ...transforms, limit] : [limit];
    await pipeline(upstream, ...stages, output, { signal });
    outgoing.set('content-length', output.bytesWritten);
    writeHeaders(response, status, outgoing);
    await pipeline(createReadStream(file), response, { signal });
  } finally {
    upstream.destroy();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export function createProxyServer({ env = process.env, resolve = lookup } = {}) {
  const config = proxyConfig(env);
  return createServer(async (request, response) => {
    const started = performance.now();
    const controller = new AbortController();
    let host = '-';
    response.once('close', () => {
      if (!response.writableFinished) controller.abort();
      const status = response.headersSent ? response.statusCode : 499;
      console.log(`${request.method} ${host} ${status} ${Math.round(performance.now() - started)}ms`);
    });
    request.socket.setNoDelay(true);

    const incoming = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      incoming.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const cors = corsHeaders(incoming, request.method === 'OPTIONS');

    try {
      if (request.method === 'OPTIONS') {
        writeHeaders(response, 204, cors);
        response.end();
        return;
      }

      const url = new URL(request.url, 'http://proxy.invalid');
      if (url.pathname === '/health' && request.method === 'GET') {
        cors.set('content-type', 'text/plain; charset=utf-8');
        writeHeaders(response, 200, cors);
        response.end('ok');
        return;
      }
      if (url.pathname !== '/proxy') throw new ProxyError(404, 'Not found');

      let target = parseTarget(url);
      host = target.hostname;
      const openDownload = validateTarget(target, incoming, config, request.method);
      if (Number(incoming.get('content-length')) > MAX_BODY_BYTES) throw bodyTooLarge();

      const headers = upstreamHeaders(incoming, openDownload);
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : limitedBody(request, controller);
      let upstream;
      let upstreamFields;
      for (let redirects = 0; ; redirects++) {
        upstream = await requestUpstream(target, request.method, headers, body,
          controller.signal, resolve, config, openDownload);
        upstreamFields = new Headers();
        for (let i = 0; i < upstream.rawHeaders.length; i += 2) {
          upstreamFields.append(upstream.rawHeaders[i], upstream.rawHeaders[i + 1]);
        }
        if (!openDownload) break;
        let next;
        try {
          next = redirectTarget(target, upstream.statusCode, upstreamFields.get('location'), redirects, config);
        } catch (error) {
          upstream.destroy();
          throw error;
        }
        if (!next) break;
        upstream.destroy();
        target = next;
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      const status = upstream.statusCode;
      const hasBody = request.method !== 'HEAD' && status !== 204 && status !== 205 && status !== 304;
      if (openDownload) {
        await sendDownload(response, upstream, upstreamFields, cors, hasBody, config, controller.signal);
        return;
      }
      const transforms = hasBody ? upstreamDecoders(upstreamFields) : [];
      writeHeaders(response, status, responseHeaders(upstreamFields, cors, transforms.length > 0));
      if (hasBody) {
        response.flushHeaders();
        await pipeline(upstream, ...transforms, response);
      } else {
        upstream.resume();
        response.end();
      }
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const failure = errorResponse(controller.signal.reason ?? error, cors);
      if (failure.status === 413) failure.headers.set('connection', 'close');
      writeHeaders(response, failure.status, failure.headers);
      response.end(await failure.text());
    }
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST || '127.0.0.1';
  const server = createProxyServer();
  server.listen(port, host, () => {
    const address = server.address();
    const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    console.log(`CORS proxy listening on http://${displayHost}:${address.port}`);
  });
}

import { desktop } from '../lib/desktop';
import type { ProviderConfig, ProviderContext } from './types';

/**
 * CORS proxy wire protocol (implemented by /proxy/server.mjs):
 *   <proxyBase>/proxy?url=<encodeURIComponent(targetUrl)>
 * Method, headers and body are forwarded as-is; the response (including
 * streaming bodies) is piped back with permissive CORS headers.
 */
export function proxiedUrl(proxyBase: string, target: string): string {
  return `${proxyBase.replace(/\/+$/, '')}/proxy?url=${encodeURIComponent(target)}`;
}

export function makeContext(
  config: ProviderConfig,
  proxyBase: string | undefined,
  proxyToken?: string,
): ProviderContext {
  // the desktop client routes every provider through its built-in proxy (no CORS limits, nothing to set up)
  const d = desktop();
  if (d) {
    proxyBase = d.proxyUrl;
    proxyToken = d.proxyToken;
  }
  const useProxy = !!((config.useProxy || d) && proxyBase);
  const f: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!useProxy) return fetch(url, init);
    const headers = new Headers(init?.headers);
    if (proxyToken) headers.set('x-proxy-token', proxyToken);
    return fetch(proxiedUrl(proxyBase!, url), { ...init, headers });
  };
  return { fetch: f };
}

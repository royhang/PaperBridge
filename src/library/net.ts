import { effectiveProxy } from '../lib/desktop';
import { proxiedUrl } from '../providers/http';
import { getSettings } from '../store/settings';

export class NetError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'NetError';
    this.status = status;
  }
}

async function explain(res: Response, url: string): Promise<NetError> {
  let detail = '';
  try {
    const text = await res.text();
    detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text.slice(0, 200);
  } catch {
    /* ignore */
  }
  if (/proxy token/i.test(detail)) return new NetError('代理令牌不正确，请在「设置 → 跨域代理」中填写。', res.status);
  if (/not allowed/i.test(detail))
    return new NetError('代理不允许访问该网址。服务器上的代理需要开启 ALLOW_ANY_GET=1（见 proxy/README.md）。', res.status);
  if (res.status === 404) return new NetError(`找不到资源（404）：${url}`, 404);
  if (res.status === 401 || res.status === 403) return new NetError(`对方网站拒绝访问（${res.status}），可能需要机构订阅或登录。`, res.status);
  return new NetError(`请求失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`, res.status);
}

/** GET through the user's CORS proxy (needed for arXiv, publisher sites, arbitrary PDF links). */
export async function proxyGet(url: string, signal?: AbortSignal): Promise<Response> {
  const s = getSettings();
  const proxy = effectiveProxy(s);
  if (!proxy.url) throw new NetError('需要先在「设置 → 跨域代理」中配置代理地址。');
  const headers = new Headers();
  if (proxy.token) headers.set('x-proxy-token', proxy.token);
  let res: Response;
  try {
    res = await fetch(proxiedUrl(proxy.url, url), { headers, signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new NetError(proxy.builtIn ? '客户端内置代理无法访问该网址，请检查网络。' : `无法连接代理（${proxy.url}）。本地使用请先运行 pnpm proxy。`);
  }
  if (!res.ok) throw await explain(res, url);
  return res;
}

/** Try a direct CORS request first (Crossref allows it), then fall back to the proxy. */
export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  try {
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 404) throw new NetError(`找不到：${url}`, 404);
  } catch (e) {
    if (e instanceof NetError || (e as Error).name === 'AbortError') throw e;
    /* CORS / network → proxy */
  }
  return (await (await proxyGet(url, signal)).json()) as T;
}

import { ensureOk } from './sse';
import { ProviderError } from './types';
import type { LangCode, MTProvider, ProviderConfig, ProviderContext } from './types';

const languageCodes: Partial<Record<LangCode, string>> = { 'zh-CN': 'zh-CHS', 'zh-TW': 'zh-CHT' };

export function createYoudaoProvider(cfg: ProviderConfig, ctx: ProviderContext): MTProvider {
  const base = (cfg.baseUrl ?? 'https://openapi.youdao.com').replace(/\/+$/, '');
  const url = base.endsWith('/api') ? base : `${base}/api`;
  const appKey = cfg.appId ?? '';

  return {
    type: 'mt',
    async translate({ texts, from, to, signal }) {
      signal?.throwIfAborted();
      const translations: string[] = [];
      const encoder = new TextEncoder();
      for (const q of texts) {
        signal?.throwIfAborted();
        const salt = crypto.randomUUID();
        const curtime = Math.floor(Date.now() / 1000).toString();
        const input = q.length <= 20 ? q : q.slice(0, 10) + q.length + q.slice(-10);
        const digest = await crypto.subtle.digest('SHA-256', encoder.encode(appKey + input + salt + curtime + cfg.apiKey));
        const sign = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');

        signal?.throwIfAborted();
        const res = await ctx.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            q,
            from: languageCodes[from] ?? from,
            to: languageCodes[to] ?? to,
            appKey,
            salt,
            sign,
            signType: 'v3',
            curtime,
          }),
          signal,
        });
        await ensureOk(res);
        const data = await res.json();
        if (data.errorCode !== '0') {
          throw new ProviderError(`Youdao error ${data.errorCode}`, res.status, JSON.stringify(data).slice(0, 2000));
        }
        if (!Array.isArray(data.translation) || !data.translation.length) {
          throw new ProviderError('Youdao returned no translation', res.status);
        }
        translations.push(data.translation.join('\n'));
      }
      return translations;
    },
  };
}

import { ensureOk } from './sse';
import { ProviderError } from './types';
import type { LangCode, MTProvider, ProviderConfig, ProviderContext } from './types';

function languageCode(code: LangCode, target: boolean): string {
  switch (code) {
    case 'en': return target ? 'EN-US' : 'EN';
    case 'zh-CN': return target ? 'ZH-HANS' : 'ZH';
    case 'zh-TW': return target ? 'ZH-HANT' : 'ZH';
    case 'pt': return target ? 'PT-BR' : 'PT';
    default: return code.toUpperCase();
  }
}

export function createDeepLProvider(cfg: ProviderConfig, ctx: ProviderContext): MTProvider {
  const defaultBase = cfg.apiKey.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const base = (cfg.baseUrl ?? defaultBase).replace(/\/+$/, '');

  return {
    type: 'mt',
    async translate({ texts, from, to, signal }) {
      signal?.throwIfAborted();
      if (!texts.length) return [];

      const res = await ctx.fetch(`${base}/v2/translate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `DeepL-Auth-Key ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          text: texts,
          target_lang: languageCode(to, true),
          source_lang: from === 'auto' ? undefined : languageCode(from, false),
        }),
        signal,
      });
      await ensureOk(res);
      const { translations } = await res.json();
      if (!Array.isArray(translations) || translations.length !== texts.length) {
        throw new ProviderError('DeepL returned an unexpected number of translations', res.status);
      }
      return translations.map(({ text }) => text);
    },
  };
}

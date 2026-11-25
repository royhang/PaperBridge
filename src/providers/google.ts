import { ensureOk } from './sse';
import { ProviderError } from './types';
import type { MTProvider, ProviderConfig, ProviderContext } from './types';

const commonEntities = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', '\u00a0'],
]);

function decodeEntities(text: string): string {
  let textarea: HTMLTextAreaElement | undefined;

  return text.replace(/&(#(?:\d+|[xX][\da-fA-F]+)|[a-zA-Z][a-zA-Z\d]*);/g, (entity, name: string) => {
    const common = commonEntities.get(name);
    if (common !== undefined) return common;

    // Feed the browser parser only the matched reference, never surrounding text.
    if (typeof document !== 'undefined') {
      textarea ??= document.createElement('textarea');
      textarea.innerHTML = entity;
      return textarea.value;
    }

    if (!name.startsWith('#')) return entity;
    const value = name.slice(1);
    const code = /^[xX]/.test(value) ? Number.parseInt(value.slice(1), 16) : Number(value);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd';
    return String.fromCodePoint(code);
  });
}

export function createGoogleTranslateProvider(cfg: ProviderConfig, ctx: ProviderContext): MTProvider {
  const base = (cfg.baseUrl ?? 'https://translation.googleapis.com').replace(/\/+$/, '');
  const url = `${base}/language/translate/v2?key=${encodeURIComponent(cfg.apiKey)}`;

  return {
    type: 'mt',
    async translate({ texts, from, to, signal }) {
      signal?.throwIfAborted();
      if (!texts.length) return [];

      const res = await ctx.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q: texts, target: to, source: from === 'auto' ? undefined : from, format: 'text' }),
        signal,
      });
      await ensureOk(res);
      const { data }: { data?: { translations?: { translatedText: string }[] } } = await res.json();
      if (!Array.isArray(data?.translations) || data.translations.length !== texts.length) {
        throw new ProviderError('Google Translate returned an unexpected number of translations', res.status);
      }
      return data.translations.map(({ translatedText }) => decodeEntities(translatedText));
    },
  };
}

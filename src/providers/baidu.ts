import md5 from 'blueimp-md5';
import { ensureOk } from './sse';
import { ProviderError } from './types';
import type { LangCode, MTProvider, ProviderConfig, ProviderContext } from './types';

const maxQueryBytes = 6000;
const languageCodes: Partial<Record<LangCode, string>> = {
  'zh-CN': 'zh', 'zh-TW': 'cht', ja: 'jp', ko: 'kor', fr: 'fra', es: 'spa',
};

interface Segment {
  text: string;
  bytes: number;
  translation: string;
}

export function createBaiduProvider(cfg: ProviderConfig, ctx: ProviderContext): MTProvider {
  const base = (cfg.baseUrl ?? 'https://fanyi-api.baidu.com').replace(/\/+$/, '');
  const path = '/api/trans/vip/translate';
  const url = base.endsWith(path) ? base : `${base}${path}`;

  return {
    type: 'mt',
    async translate({ texts, from, to, signal }) {
      signal?.throwIfAborted();
      const encoder = new TextEncoder();
      const buffer = new Uint8Array(maxQueryBytes);
      const segments = texts.map((text) => {
        const normalized = text.replace(/\r\n|[\n\r\u2028\u2029]/g, ' ');
        const parts: Segment[] = [];
        // encodeInto gives a byte-limited prefix ending at a Unicode character boundary.
        for (let start = 0; start < normalized.length;) {
          const { read, written } = encoder.encodeInto(normalized.slice(start), buffer);
          const part = normalized.slice(start, start + read);
          parts.push({ text: part, bytes: written, translation: part.trim() ? '' : part });
          start += read;
        }
        return parts;
      });

      async function translateBatch(batch: Segment[]) {
        signal?.throwIfAborted();
        const q = batch.map(({ text }) => text).join('\n');
        const appid = cfg.appId ?? '';
        const salt = crypto.getRandomValues(new Uint32Array(1))[0].toString();
        const res = await ctx.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            q,
            from: languageCodes[from] ?? from,
            to: languageCodes[to] ?? to,
            appid,
            salt,
            sign: md5(appid + q + salt + cfg.apiKey),
          }),
          signal,
        });
        await ensureOk(res);
        const data = await res.json();
        const code = String(data.error_code ?? '0');
        if (code !== '0' && code !== '52000') {
          const detail = data.error_msg ? `: ${data.error_msg}` : '';
          throw new ProviderError(`Baidu error ${code}${detail}`, res.status, JSON.stringify(data).slice(0, 2000));
        }
        if (!Array.isArray(data.trans_result) || data.trans_result.length !== batch.length) {
          throw new ProviderError('Baidu returned an unexpected number of translations', res.status);
        }
        batch.forEach((segment, index) => {
          segment.translation = data.trans_result[index].dst;
        });
      }

      let batch: Segment[] = [];
      let bytes = 0;
      for (const segment of segments.flat()) {
        if (segment.translation) continue;
        const separatorBytes = batch.length ? 1 : 0;
        if (bytes + separatorBytes + segment.bytes > maxQueryBytes) {
          await translateBatch(batch);
          batch = [];
          bytes = 0;
        }
        bytes += (batch.length ? 1 : 0) + segment.bytes;
        batch.push(segment);
      }
      if (batch.length) await translateBatch(batch);

      return segments.map((parts) => parts.map(({ translation }) => translation).join(''));
    },
  };
}

import { ensureOk, parseSSE } from './sse';
import { ProviderError } from './types';
import type { LLMProvider, ProviderConfig, ProviderContext } from './types';

export function createGeminiProvider(cfg: ProviderConfig, ctx: ProviderContext): LLMProvider {
  const base = (cfg.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const model = encodeURIComponent(cfg.model ?? 'gemini-2.5-flash');
  const url = `${base}/v1beta/models/${model}:streamGenerateContent?alt=sse`;

  return {
    type: 'llm',
    async *chat({ messages, signal, temperature, maxTokens }) {
      const system = messages.filter(({ role }) => role === 'system').map(({ content }) => ({ text: content }));
      const contents = messages.filter(({ role }) => role !== 'system').map(({ role, content }) => ({
        role: role === 'assistant' ? 'model' : 'user',
        parts: [{ text: content }],
      }));
      const headers = new Headers({ 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey });
      new Headers(cfg.extraHeaders).forEach((value, name) => headers.set(name, value));

      const res = await ctx.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          contents,
          systemInstruction: system.length ? { parts: system } : undefined,
          generationConfig: { temperature: temperature ?? cfg.temperature, maxOutputTokens: maxTokens },
        }),
        signal,
      });
      await ensureOk(res);
      if (!res.body) throw new ProviderError('Gemini returned no response stream', res.status);

      for await (const { data } of parseSSE(res.body, signal)) {
        const chunk = JSON.parse(data);
        if (chunk.error) {
          throw new ProviderError(chunk.error.message ?? 'Gemini stream error', res.status, data.slice(0, 2000));
        }
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          if (typeof part.text === 'string' && part.text) yield part.text;
        }
      }
    },
  };
}

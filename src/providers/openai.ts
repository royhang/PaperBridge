import { ensureOk, parseSSE } from './sse';
import { ProviderError } from './types';
import type { LLMProvider, ProviderConfig, ProviderContext } from './types';

export function createOpenAIProvider(cfg: ProviderConfig, ctx: ProviderContext): LLMProvider {
  const base = (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;

  return {
    type: 'llm',
    async *chat({ messages, signal, temperature, maxTokens }) {
      const headers = new Headers({ 'content-type': 'application/json' });
      if (cfg.apiKey) headers.set('Authorization', `Bearer ${cfg.apiKey}`);
      new Headers(cfg.extraHeaders).forEach((value, name) => headers.set(name, value));

      const res = await ctx.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: cfg.model ?? 'gpt-4o-mini',
          messages,
          temperature: temperature ?? cfg.temperature,
          max_tokens: maxTokens,
          stream: true,
        }),
        signal,
      });
      await ensureOk(res);
      if (!res.body) throw new ProviderError('OpenAI returned no response stream', res.status);

      for await (const { data } of parseSSE(res.body, signal)) {
        if (data.trim() === '[DONE]') return;
        const chunk = JSON.parse(data);
        if (chunk.error) {
          throw new ProviderError(chunk.error.message ?? 'OpenAI stream error', res.status, data.slice(0, 2000));
        }
        const content = chunk.choices?.[0]?.delta?.content;
        if (typeof content === 'string' && content) yield content;
      }
    },
  };
}

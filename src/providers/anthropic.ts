import { ensureOk, parseSSE } from './sse';
import { ProviderError } from './types';
import type { LLMProvider, ProviderConfig, ProviderContext } from './types';

export function createAnthropicProvider(cfg: ProviderConfig, ctx: ProviderContext): LLMProvider {
  const base = (cfg.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');

  return {
    type: 'llm',
    async *chat({ messages, signal, temperature, maxTokens }) {
      const system = messages.filter(({ role }) => role === 'system').map(({ content }) => content);
      const headers = new Headers({
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      });
      new Headers(cfg.extraHeaders).forEach((value, name) => headers.set(name, value));

      const systemText = system.length ? system.join('\n\n') : '';
      // Enable explicit Prompt Caching on long static system prompts (e.g. full paper Q&A >= 4000 chars)
      // to unlock Anthropic's 90% cache-hit discount while keeping short prompts as plain strings.
      const systemPayload = !systemText
        ? undefined
        : systemText.length >= 4000
          ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
          : systemText;

      const res = await ctx.fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: cfg.model ?? 'claude-sonnet-5-5',
          messages: messages.filter(({ role }) => role !== 'system'),
          system: systemPayload,
          temperature: temperature ?? cfg.temperature,
          max_tokens: maxTokens ?? 4096,
          stream: true,
        }),
        signal,
      });
      await ensureOk(res);
      if (!res.body) throw new ProviderError('Anthropic returned no response stream', res.status);

      for await (const { event, data } of parseSSE(res.body, signal)) {
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          const body = data.slice(0, 2000);
          const message = event === 'error' && body ? body : 'Anthropic returned invalid stream data';
          throw new ProviderError(message, res.status, body);
        }
        const type = event ?? chunk?.type;
        if (type === 'error' || chunk?.type === 'error') {
          throw new ProviderError(chunk?.error?.message ?? 'Anthropic stream error', res.status, data.slice(0, 2000));
        }
        if (type === 'message_stop') return;
        if (type === 'content_block_delta' && chunk?.delta?.type === 'text_delta') {
          const text = chunk.delta.text;
          if (typeof text === 'string' && text) yield text;
        }
      }
    },
  };
}

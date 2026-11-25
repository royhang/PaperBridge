import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProvider, PROVIDER_PRESETS, testProvider } from '../index';
import { ProviderError } from '../types';
import type { ChatMessage, ProviderConfig, ProviderContext, ProviderKind } from '../types';

const messages: ChatMessage[] = [
  { role: 'system', content: 'Translate accurately.' },
  { role: 'user', content: 'Hello' },
  { role: 'system', content: 'Use simple language.' },
  { role: 'assistant', content: '你好' },
];

function providerConfig(kind: ProviderKind, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: kind, name: kind, kind, apiKey: 'secret', appId: 'app', ...overrides };
}

function response(text: string, init?: ResponseInit): Response {
  const bytes = new TextEncoder().encode(text);
  const middle = Math.floor(bytes.length / 2);
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, middle));
      controller.enqueue(bytes.slice(middle));
      controller.close();
    },
  }), init);
}

function json(data: unknown): Response {
  return response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
}

function event(data: unknown, type?: string): string {
  return (type ? `event: ${type}\r\n` : '') + `data: ${JSON.stringify(data)}\r\n\r\n`;
}

function mockedProvider(kind: ProviderKind, overrides?: Partial<ProviderConfig>) {
  const fetch = vi.fn<ProviderContext['fetch']>();
  const provider = createProvider(providerConfig(kind, overrides), { fetch });
  const signal = new AbortController().signal;
  return { provider, fetch, signal };
}

async function collect(values: AsyncIterable<string>): Promise<string[]> {
  const result: string[] = [];
  for await (const value of values) result.push(value);
  return result;
}

function expectPost(call: Parameters<ProviderContext['fetch']>, url: string, signal: AbortSignal) {
  const [input, init] = call;
  expect(input).toBe(url);
  expect(init?.method).toBe('POST');
  expect(init?.signal).toBe(signal);
  return { headers: new Headers(init?.headers), body: init?.body };
}

afterEach(() => vi.restoreAllMocks());

describe('LLM adapters', () => {
  it('streams OpenAI text up to DONE and ignores reasoning deltas', async () => {
    const { provider, fetch, signal } = mockedProvider('openai', {
      model: 'chat-model', temperature: 0.1, extraHeaders: { 'X-Client': 'paperbridge' },
    });
    if (provider.type !== 'llm') throw new Error('Expected LLM provider');
    fetch.mockResolvedValueOnce(response(
      event({ choices: [{ delta: { reasoning_content: 'hidden' } }] })
      + event({ choices: [{ delta: { content: '你', reasoning_content: 'hidden' } }] })
      + event({ choices: [{ delta: { content: '好' } }] })
      + 'data: [DONE]\n\ndata: should not be parsed\n\n',
    ));

    await expect(collect(provider.chat({ messages, signal, temperature: 0.2, maxTokens: 20 }))).resolves.toEqual(['你', '好']);
    const { headers, body } = expectPost(fetch.mock.calls[0], 'https://api.openai.com/v1/chat/completions', signal);
    expect(Object.fromEntries(headers.entries())).toEqual({
      authorization: 'Bearer secret', 'content-type': 'application/json', 'x-client': 'paperbridge',
    });
    expect(JSON.parse(String(body))).toEqual({
      model: 'chat-model', messages, temperature: 0.2, max_tokens: 20, stream: true,
    });
  });

  it.each(['http://localhost:11434/v1///', 'http://localhost:11434/v1/chat/completions/'])(
    'supports keyless OpenAI-compatible endpoints at %s', async (baseUrl) => {
      const { provider, fetch, signal } = mockedProvider('openai', { baseUrl, apiKey: '', temperature: 0 });
      if (provider.type !== 'llm') throw new Error('Expected LLM provider');
      fetch.mockResolvedValueOnce(response('data: [DONE]'));
      await expect(collect(provider.chat({ messages, signal }))).resolves.toEqual([]);
      const { headers, body } = expectPost(fetch.mock.calls[0], 'http://localhost:11434/v1/chat/completions', signal);
      expect(headers.has('authorization')).toBe(false);
      expect(JSON.parse(String(body))).toEqual({ model: 'gpt-4o-mini', messages, temperature: 0, stream: true });
    },
  );

  it('uses browser Anthropic headers, top-level system text, and text deltas', async () => {
    const { provider, fetch, signal } = mockedProvider('anthropic', { model: 'claude-test', temperature: 0.3 });
    if (provider.type !== 'llm') throw new Error('Expected LLM provider');
    fetch.mockResolvedValueOnce(response(
      event({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hidden' } }, 'content_block_delta')
      + event({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }, 'content_block_delta')
      + event({ type: 'message_stop' }, 'message_stop'),
    ));

    await expect(collect(provider.chat({ messages, signal }))).resolves.toEqual(['Hello']);
    const { headers, body } = expectPost(fetch.mock.calls[0], 'https://api.anthropic.com/v1/messages', signal);
    expect(Object.fromEntries(headers.entries())).toEqual({
      'content-type': 'application/json', 'x-api-key': 'secret',
      'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true',
    });
    expect(JSON.parse(String(body))).toEqual({
      model: 'claude-test', messages: [messages[1], messages[3]], system: 'Translate accurately.\n\nUse simple language.',
      temperature: 0.3, max_tokens: 4096, stream: true,
    });
  });

  it('throws ProviderError for Anthropic error events', async () => {
    const { provider, fetch, signal } = mockedProvider('anthropic');
    if (provider.type !== 'llm') throw new Error('Expected LLM provider');
    const failure = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
    fetch.mockResolvedValueOnce(response(event(failure, 'error')));
    const result = collect(provider.chat({ messages, signal }));
    await expect(result).rejects.toBeInstanceOf(ProviderError);
    await expect(result).rejects.toMatchObject({ message: 'Overloaded', body: JSON.stringify(failure) });
  });

  it('maps Gemini instructions, roles, and generation settings and yields text parts in order', async () => {
    const { provider, fetch, signal } = mockedProvider('gemini', { model: 'gemini-2.5-flash', temperature: 0.1 });
    if (provider.type !== 'llm') throw new Error('Expected LLM provider');
    fetch.mockResolvedValueOnce(response(
      event({ candidates: [
        { content: { parts: [{ text: 'a' }, { functionCall: { name: 'example' } }, { text: 'b' }] } },
        { content: { parts: [{ text: 'ignored' }] } },
      ] }) + event({ usageMetadata: { totalTokenCount: 9 } })
      + 'data: {"candidates":[{"content":{"parts":[{"text":"c"}]}}]}',
    ));

    await expect(collect(provider.chat({ messages, signal, temperature: 0, maxTokens: 50 }))).resolves.toEqual(['a', 'b', 'c']);
    const { headers, body } = expectPost(fetch.mock.calls[0],
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse', signal);
    expect(Object.fromEntries(headers.entries())).toEqual({ 'content-type': 'application/json', 'x-goog-api-key': 'secret' });
    expect(JSON.parse(String(body))).toEqual({
      contents: [
        { role: 'user', parts: [{ text: 'Hello' }] }, { role: 'model', parts: [{ text: '你好' }] },
      ],
      systemInstruction: { parts: [{ text: 'Translate accurately.' }, { text: 'Use simple language.' }] },
      generationConfig: { temperature: 0, maxOutputTokens: 50 },
    });
  });
});

describe('translation adapters', () => {
  it.each([
    { from: 'en', to: 'zh-CN', source: 'EN', target: 'ZH-HANS', key: 'secret:fx', host: 'https://api-free.deepl.com' },
    { from: 'zh-CN', to: 'zh-TW', source: 'ZH', target: 'ZH-HANT', key: 'secret', host: 'https://api.deepl.com' },
    { from: 'zh-TW', to: 'pt', source: 'ZH', target: 'PT-BR', key: 'secret', host: 'https://api.deepl.com' },
    { from: 'pt', to: 'en', source: 'PT', target: 'EN-US', key: 'secret', host: 'https://api.deepl.com' },
    { from: 'auto', to: 'ja', source: undefined, target: 'JA', key: 'secret:fx', host: 'https://example.test', baseUrl: 'https://example.test/' },
  ] as const)('maps DeepL $from to $to using $host', async (item) => {
    const { provider, fetch, signal } = mockedProvider('deepl', { apiKey: item.key, baseUrl: 'baseUrl' in item ? item.baseUrl : undefined });
    if (provider.type !== 'mt') throw new Error('Expected MT provider');
    fetch.mockResolvedValueOnce(json({ translations: [{ text: 'first' }, { text: 'second' }] }));
    const texts = ['a', 'b'];
    await expect(provider.translate({ texts, from: item.from, to: item.to, signal })).resolves.toEqual(['first', 'second']);
    const { headers, body } = expectPost(fetch.mock.calls[0], `${item.host}/v2/translate`, signal);
    expect(headers.get('authorization')).toBe(`DeepL-Auth-Key ${item.key}`);
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(body))).toEqual({
      text: texts, target_lang: item.target, ...(item.source ? { source_lang: item.source } : {}),
    });
  });

  it('posts Google Cloud Translation v2 JSON and decodes entities once', async () => {
    const { provider, fetch, signal } = mockedProvider('google-translate', { apiKey: 'key +&' });
    if (provider.type !== 'mt') throw new Error('Expected MT provider');
    fetch.mockResolvedValueOnce(json({ data: { translations: [
      { translatedText: '&quot;A &amp; B&quot; &#39; &#x1F642; &amp;lt; &#99999999; &unknown; <b>' },
      { translatedText: '你好' },
    ] } }));
    const texts = ['a', 'b'];
    await expect(provider.translate({ texts, from: 'auto', to: 'zh-CN', signal })).resolves.toEqual([
      '"A & B" \' 🙂 &lt; \ufffd &unknown; <b>', '你好',
    ]);
    const { headers, body } = expectPost(fetch.mock.calls[0], 'https://translation.googleapis.com/language/translate/v2?key=key%20%2B%26', signal);
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(body))).toEqual({ q: texts, target: 'zh-CN', format: 'text' });
  });

  it('signs the normalized Baidu batch with MD5', async () => {
    vi.spyOn(crypto, 'getRandomValues').mockReturnValueOnce(Uint32Array.of(42));
    const { provider, fetch, signal } = mockedProvider('baidu');
    if (provider.type !== 'mt') throw new Error('Expected MT provider');
    fetch.mockResolvedValueOnce(json({ trans_result: [{ dst: 'first' }, { dst: 'second' }] }));
    await expect(provider.translate({ texts: ['one\r\ntwo\nthree', '猫'], from: 'ja', to: 'zh-TW', signal })).resolves.toEqual(['first', 'second']);
    const { headers, body } = expectPost(fetch.mock.calls[0], 'https://fanyi-api.baidu.com/api/trans/vip/translate', signal);
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(String(body)))).toEqual({
      q: 'one two three\n猫', from: 'jp', to: 'cht', appid: 'app', salt: '42', sign: '351fa63ff610ae6ed59eeea246e8c8c4',
    });
  });

  it('keeps Baidu batches within the UTF-8 byte limit and reassembles oversized segments', async () => {
    const { provider, fetch, signal } = mockedProvider('baidu');
    if (provider.type !== 'mt') throw new Error('Expected MT provider');
    const observedQueries: string[] = [];
    fetch.mockImplementation(async (_, init) => {
      const params = new URLSearchParams(String(init?.body));
      const q = params.get('q')!;
      expect(init?.signal).toBe(signal);
      expect(params.get('from')).toBe('auto');
      expect(params.get('to')).toBe('zh');
      expect(new TextEncoder().encode(q).byteLength).toBeLessThanOrEqual(6000);
      observedQueries.push(q);
      return json({ trans_result: q.split('\n').map((text) => ({ dst: `[${text}]` })) });
    });
    const first = '界'.repeat(1999);
    const longPrefix = 'a'.repeat(5999);
    const texts = [first, '', 'é', longPrefix + '🙂!'];
    await expect(provider.translate({ texts, from: 'auto', to: 'zh-CN', signal })).resolves.toEqual([
      `[${first}]`, '', '[é]', `[${longPrefix}][🙂!]`,
    ]);
    expect(observedQueries).toEqual([`${first}\né`, longPrefix, '🙂!']);
  });

  it('reports Baidu API errors in successful HTTP responses', async () => {
    const { provider, fetch, signal } = mockedProvider('baidu');
    if (provider.type !== 'mt') throw new Error('Expected MT provider');
    fetch.mockResolvedValueOnce(json({ error_code: '54001', error_msg: 'Invalid signature' }));
    const result = provider.translate({ texts: ['Hello'], from: 'auto', to: 'en', signal });
    await expect(result).rejects.toBeInstanceOf(ProviderError);
    await expect(result).rejects.toThrow('54001: Invalid signature');
  });

  it('signs each Youdao text with the correct SHA-256 input for its length', async () => {
    const salt = '00000000-0000-4000-8000-000000000001';
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(salt);
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    const { provider, fetch, signal } = mockedProvider('youdao');
    if (provider.type !== 'mt') throw new Error('Expected MT provider');
    fetch.mockResolvedValueOnce(json({ errorCode: '0', translation: ['first'] }));
    fetch.mockResolvedValueOnce(json({ errorCode: '0', translation: ['second'] }));
    const texts = ['0123456789abcdefghij', '0123456789WXYZabcdefghij'];
    await expect(provider.translate({ texts, from: 'zh-CN', to: 'zh-TW', signal })).resolves.toEqual(['first', 'second']);
    const signatures = [
      '4c3c6ef27e0a08115e07806674a6d97b66991ee5d19c478ab085c64e3b5dbd0c',
      'b8e684435df953899082ea487e0721ea60771d1595d0a86717ec14f782fba705',
    ];
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mock.calls.forEach((call, index) => {
      const { headers, body } = expectPost(call, 'https://openapi.youdao.com/api', signal);
      expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
      expect(Object.fromEntries(new URLSearchParams(String(body)))).toEqual({
        q: texts[index], from: 'zh-CHS', to: 'zh-CHT', appKey: 'app', salt,
        sign: signatures[index], signType: 'v3', curtime: '1700000000',
      });
    });
  });

  it('reports Youdao API errors in successful HTTP responses', async () => {
    const { provider, fetch, signal } = mockedProvider('youdao');
    if (provider.type !== 'mt') throw new Error('Expected MT provider');
    fetch.mockResolvedValueOnce(json({ errorCode: '202' }));
    const result = provider.translate({ texts: ['Hello'], from: 'auto', to: 'zh-CN', signal });
    await expect(result).rejects.toBeInstanceOf(ProviderError);
    await expect(result).rejects.toThrow('Youdao error 202');
  });

  it.each(['baidu', 'youdao'] as const)('stops %s before starting a later request when aborted', async (kind) => {
    const { provider, fetch } = mockedProvider(kind);
    if (provider.type !== 'mt') throw new Error('Expected MT provider');
    const controller = new AbortController();
    const reason = new DOMException('Test cancelled the translation', 'AbortError');
    fetch.mockImplementationOnce(async () => {
      controller.abort(reason);
      return json(kind === 'baidu'
        ? { trans_result: [{ dst: 'first' }] }
        : { errorCode: '0', translation: ['first'] });
    });
    await expect(provider.translate({ texts: ['a'.repeat(6000), 'b'], from: 'auto', to: 'en', signal: controller.signal }))
      .rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('provider registry', () => {
  it.each(['openai', 'anthropic', 'gemini', 'deepl', 'google-translate', 'baidu', 'youdao'] as const)(
    'propagates %s HTTP failures as ProviderError', async (kind) => {
      const { provider, fetch, signal } = mockedProvider(kind);
      const body = '{"error":{"message":"Invalid credentials"}}';
      fetch.mockResolvedValueOnce(response(body, { status: 401 }));
      const result = provider.type === 'llm'
        ? collect(provider.chat({ messages, signal }))
        : provider.translate({ texts: ['Hello'], from: 'en', to: 'zh-CN', signal });
      await expect(result).rejects.toBeInstanceOf(ProviderError);
      await expect(result).rejects.toMatchObject({ status: 401, message: 'HTTP 401: Invalid credentials', body });
    },
  );

  it('offers the expected presets and CORS proxy notes', () => {
    expect(PROVIDER_PRESETS).toHaveLength(14);
    expect(PROVIDER_PRESETS.filter(({ note }) => note?.includes('CORS')).map(({ kind }) => kind))
      .toEqual(['deepl', 'baidu', 'youdao']);
    expect(PROVIDER_PRESETS.filter(({ needsAppId }) => needsAppId).map(({ kind }) => kind))
      .toEqual(['baidu', 'youdao']);
  });

  it('sends a tiny request to test an LLM connection', async () => {
    const { provider, fetch, signal } = mockedProvider('openai');
    fetch.mockResolvedValueOnce(response(event({ choices: [{ delta: { content: 'O' } }] })
      + event({ choices: [{ delta: { content: 'K' } }] })));
    await expect(testProvider(provider, signal)).resolves.toBe('OK');
    const { body } = expectPost(fetch.mock.calls[0], 'https://api.openai.com/v1/chat/completions', signal);
    expect(JSON.parse(String(body)).messages).toEqual([{ role: 'user', content: 'Reply with OK' }]);
  });

  it('translates Hello to Simplified Chinese to test an MT connection', async () => {
    const { provider, fetch, signal } = mockedProvider('google-translate');
    fetch.mockResolvedValueOnce(json({ data: { translations: [{ translatedText: '你好' }] } }));
    await expect(testProvider(provider, signal)).resolves.toBe('你好');
    const { body } = expectPost(fetch.mock.calls[0], 'https://translation.googleapis.com/language/translate/v2?key=secret', signal);
    expect(JSON.parse(String(body))).toEqual({ q: ['Hello'], target: 'zh-CN', source: 'en', format: 'text' });
  });
});

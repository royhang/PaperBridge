import { describe, expect, it } from 'vitest';
import { parseApiSnippet } from '../quickParse';

describe('parseApiSnippet', () => {
  it('parses curl command with URL, bearer key, and JSON model', () => {
    const cmd = `curl https://api.deepseek.com/v1/chat/completions \\
      -H "Authorization: Bearer sk-1234567890abcdef123456" \\
      -d '{"model": "deepseek-reasoner", "messages": []}'`;
    expect(parseApiSnippet(cmd)).toMatchObject({
      name: 'DeepSeek',
      kind: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-1234567890abcdef123456',
      model: 'deepseek-reasoner',
    });
  });

  it('parses .env / multi-line relay dashboard snippets', () => {
    const snippet = `
      BASE_URL=https://relay.example.com/v1/
      API_KEY=sk-abcdef1234567890xyz
      MODEL=gpt-4.1-mini
    `;
    expect(parseApiSnippet(snippet)).toMatchObject({
      name: 'relay',
      kind: 'openai',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-abcdef1234567890xyz',
      model: 'gpt-4.1-mini',
    });
  });

  it('auto-detects provider from bare API key prefix', () => {
    expect(parseApiSnippet('sk-ant-api03-1234567890abcdef')).toMatchObject({
      name: 'Anthropic Claude',
      kind: 'anthropic',
      apiKey: 'sk-ant-api03-1234567890abcdef',
    });
    expect(parseApiSnippet('AIzaSyA1234567890abcdefghijk')).toMatchObject({
      name: 'Google Gemini',
      kind: 'gemini',
    });
    expect(parseApiSnippet('sk-or-v1-1234567890abcdef')).toMatchObject({
      name: 'OpenRouter',
      kind: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
  });

  it('parses exported PaperBridge settings JSON with multiple providers', () => {
    const json = JSON.stringify({
      providers: [{ id: '1', name: 'DeepSeek', kind: 'openai', apiKey: 'sk-test', model: 'deepseek-chat' }],
    });
    const out = parseApiSnippet(json);
    expect(out?.providers).toHaveLength(1);
    expect(out?.providers?.[0].name).toBe('DeepSeek');
  });
});

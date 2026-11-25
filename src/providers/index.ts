import { createAnthropicProvider } from './anthropic';
import { createBaiduProvider } from './baidu';
import { createDeepLProvider } from './deepl';
import { createGeminiProvider } from './gemini';
import { createGoogleTranslateProvider } from './google';
import { createOpenAIProvider } from './openai';
import type { Provider, ProviderConfig, ProviderContext, ProviderKind } from './types';
import { createYoudaoProvider } from './youdao';

export function createProvider(cfg: ProviderConfig, ctx: ProviderContext): Provider {
  switch (cfg.kind) {
    case 'openai': return createOpenAIProvider(cfg, ctx);
    case 'anthropic': return createAnthropicProvider(cfg, ctx);
    case 'gemini': return createGeminiProvider(cfg, ctx);
    case 'deepl': return createDeepLProvider(cfg, ctx);
    case 'google-translate': return createGoogleTranslateProvider(cfg, ctx);
    case 'baidu': return createBaiduProvider(cfg, ctx);
    case 'youdao': return createYoudaoProvider(cfg, ctx);
  }
}

const corsNote = '必须启用 CORS 代理。';

export const PROVIDER_PRESETS: {
  label: string;
  kind: ProviderKind;
  baseUrl?: string;
  model?: string;
  needsAppId?: boolean;
  note?: string;
}[] = [
  { label: 'OpenAI', kind: 'openai', model: 'gpt-4o-mini' },
  { label: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'Moonshot/Kimi', kind: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  {
    label: '通义千问 DashScope', kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus',
  },
  { label: '智谱 GLM', kind: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  {
    label: '硅基流动 SiliconFlow', kind: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3',
  },
  { label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto' },
  { label: 'Ollama local', kind: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5' },
  { label: 'Anthropic Claude', kind: 'anthropic', model: 'claude-sonnet-5-5' },
  { label: 'Google Gemini', kind: 'gemini', model: 'gemini-2.5-flash' },
  { label: 'DeepL', kind: 'deepl', note: corsNote },
  { label: 'Google Translate', kind: 'google-translate' },
  { label: '百度翻译', kind: 'baidu', needsAppId: true, note: corsNote },
  { label: '有道智云', kind: 'youdao', needsAppId: true, note: corsNote },
];

export async function testProvider(p: Provider, signal?: AbortSignal): Promise<string> {
  if (p.type === 'mt') {
    const [text] = await p.translate({ texts: ['Hello'], from: 'en', to: 'zh-CN', signal });
    return text;
  }

  let text = '';
  for await (const delta of p.chat({ messages: [{ role: 'user', content: 'Reply with OK' }], signal })) {
    text += delta;
  }
  return text;
}

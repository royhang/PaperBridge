import { PROVIDER_PRESETS } from './index';
import type { ProviderConfig, ProviderKind } from './types';

export interface ParsedProviderDraft {
  name?: string;
  kind?: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  appId?: string;
  useProxy?: boolean;
  /** Multiple providers parsed from an exported settings JSON. */
  providers?: ProviderConfig[];
  summary: string;
}

const HOST_HINTS: { test: RegExp; name: string; kind: ProviderKind; model?: string; useProxy?: boolean }[] = [
  { test: /api\.deepseek\.com/i, name: 'DeepSeek', kind: 'openai', model: 'deepseek-chat' },
  { test: /api\.moonshot\.cn/i, name: 'Moonshot/Kimi', kind: 'openai', model: 'moonshot-v1-8k' },
  { test: /dashscope\.aliyuncs\.com/i, name: '通义千问 DashScope', kind: 'openai', model: 'qwen-plus' },
  { test: /open\.bigmodel\.cn/i, name: '智谱 GLM', kind: 'openai', model: 'glm-4-flash' },
  { test: /api\.siliconflow\.cn/i, name: '硅基流动 SiliconFlow', kind: 'openai', model: 'deepseek-ai/DeepSeek-V3' },
  { test: /openrouter\.ai/i, name: 'OpenRouter', kind: 'openai', model: 'openrouter/auto' },
  { test: /api\.anthropic\.com/i, name: 'Anthropic Claude', kind: 'anthropic', model: 'claude-sonnet-5-5' },
  { test: /generativelanguage\.googleapis\.com/i, name: 'Google Gemini', kind: 'gemini', model: 'gemini-2.5-flash' },
  { test: /api\.openai\.com/i, name: 'OpenAI', kind: 'openai', model: 'gpt-4o-mini' },
  { test: /localhost:11434|127\.0\.0\.1:11434/i, name: 'Ollama local', kind: 'openai', model: 'qwen2.5' },
  { test: /deepl\.com/i, name: 'DeepL', kind: 'deepl', useProxy: true },
  { test: /chat\.ecnu\.edu\.cn/i, name: 'ECNU', kind: 'openai', model: 'ecnu-plus', useProxy: true },
];

function cleanBaseUrl(raw: string): string {
  return raw
    .trim()
    .replace(/^['"`]|['"`]$/g, '')
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/messages$/i, '')
    .replace(/\/models$/i, '');
}

function guessByKeyPrefix(key: string): { name: string; kind: ProviderKind; baseUrl?: string; model?: string } | null {
  if (/^sk-ant-/i.test(key)) return { name: 'Anthropic Claude', kind: 'anthropic', model: 'claude-sonnet-5-5' };
  if (/^AIza[0-9A-Za-z_-]{20,}$/.test(key)) return { name: 'Google Gemini', kind: 'gemini', model: 'gemini-2.5-flash' };
  if (/^sk-or-v1-/i.test(key)) return { name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto' };
  if (/:fx$/i.test(key)) return { name: 'DeepL', kind: 'deepl' };
  return null;
}

function hostName(url: string): string | undefined {
  try {
    const h = new URL(url).hostname.replace(/^(?:api|chat|open)\./i, '');
    return h.split('.')[0] || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse a pasted API snippet into provider fields:
 * - PaperBridge settings JSON (`{ providers: [...] }`) or single provider JSON
 * - `curl` command with URL, Authorization / x-api-key header, and JSON body model
 * - `.env` / key=value lines / relay dashboard multi-line paste (URL + Key + Model)
 * - Bare API key (auto-detects Anthropic / Gemini / OpenRouter / DeepL prefixes)
 */
export function parseApiSnippet(input: string): ParsedProviderDraft | null {
  const raw = input.trim();
  if (!raw) return null;

  // 1. JSON object or array
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.providers) && obj.providers.length > 0) {
          const valid = obj.providers.filter(
            (p): p is ProviderConfig => !!p && typeof p === 'object' && typeof (p as ProviderConfig).kind === 'string',
          );
          if (valid.length) {
            return { providers: valid, summary: `已识别 ${valid.length} 个完整 API 配置` };
          }
        }
        const apiKey = String(obj.apiKey ?? obj.api_key ?? obj.key ?? '').trim() || undefined;
        const baseUrlRaw = String(obj.baseUrl ?? obj.base_url ?? obj.endpoint ?? obj.url ?? '').trim();
        const baseUrl = baseUrlRaw ? cleanBaseUrl(baseUrlRaw) : undefined;
        const model = String(obj.model ?? '').trim() || undefined;
        const name = String(obj.name ?? '').trim() || undefined;
        const kind = typeof obj.kind === 'string' ? (obj.kind as ProviderKind) : undefined;
        if (apiKey || baseUrl) {
          return enrichDraft({ name, kind, baseUrl, apiKey, model });
        }
      }
    } catch {
      /* fall through to text heuristics */
    }
  }

  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  let model: string | undefined;
  let name: string | undefined;

  // 2. Extract URL (supports curl, env vars, or bare URL line)
  const urlMatch = raw.match(/https?:\/\/[^\s'"`\\<>)}\]]+/i);
  if (urlMatch) {
    baseUrl = cleanBaseUrl(urlMatch[0]);
  }

  // 3. Extract API Key from headers, env vars, or bare token
  const keyPatterns = [
    /(?:Authorization\s*:\s*Bearer|x-api-key\s*:)\s*['"]?([A-Za-z0-9._:-]{12,})['"]?/i,
    /(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|DEEPSEEK_API_KEY|API_KEY|KEY|TOKEN|密钥)\s*[=:]\s*['"`]?([A-Za-z0-9._:-]{10,})['"`]?/i,
    /\b(sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:fx)\b/,
  ];
  for (const re of keyPatterns) {
    const m = raw.match(re);
    if (m?.[1] && !/^your[_-]|^xxx|^\*+$|^<.+>$/i.test(m[1])) {
      apiKey = m[1].trim();
      break;
    }
  }

  // 4. Extract model from JSON payload or key=value line
  const modelPatterns = [
    /"model"\s*:\s*"([^"\n]{2,80})"/i,
    /(?:OPENAI_MODEL|MODEL_NAME|MODEL|模型)\s*[=:]\s*['"`]?([A-Za-z0-9._:/-]{2,80})['"`]?/i,
  ];
  for (const re of modelPatterns) {
    const m = raw.match(re);
    if (m?.[1]) {
      model = m[1].trim();
      break;
    }
  }

  // 5. Fallback: if user pasted a single bare token (no spaces, length >= 16)
  if (!apiKey && !baseUrl && /^[A-Za-z0-9._:-]{16,}$/.test(raw)) {
    apiKey = raw;
  }

  if (!apiKey && !baseUrl && !model) return null;

  // Optional explicit name line
  const nameMatch = raw.match(/(?:NAME|名称)\s*[=:]\s*['"`]?([^\n'"`]{1,40})['"`]?/i);
  if (nameMatch?.[1]) name = nameMatch[1].trim();

  return enrichDraft({ name, baseUrl, apiKey, model });
}

function enrichDraft(d: Partial<ParsedProviderDraft>): ParsedProviderDraft {
  let { name, kind, baseUrl, apiKey, model, useProxy } = d;

  if (baseUrl) {
    const hint = HOST_HINTS.find((h) => h.test.test(baseUrl!));
    if (hint) {
      name ??= hint.name;
      kind ??= hint.kind;
      model ??= hint.model;
      if (hint.useProxy) useProxy = true;
    } else {
      kind ??= 'openai';
      name ??= hostName(baseUrl) ?? '自定义 API';
    }
  }

  if (apiKey) {
    const byKey = guessByKeyPrefix(apiKey);
    if (byKey) {
      kind ??= byKey.kind;
      name ??= byKey.name;
      baseUrl ??= byKey.baseUrl;
      model ??= byKey.model;
    }
  }

  kind ??= 'openai';
  if (!name) {
    const preset = PROVIDER_PRESETS.find((p) => p.kind === kind && (!baseUrl || p.baseUrl === baseUrl));
    name = preset?.label ?? (kind === 'openai' ? 'OpenAI 兼容' : kind);
  }
  if (!model && kind === 'openai') {
    const preset = PROVIDER_PRESETS.find((p) => p.label === name);
    model = preset?.model ?? 'gpt-4o-mini';
  }

  const parts = [name];
  if (baseUrl) parts.push(baseUrl);
  if (apiKey) parts.push('已识别 Key');
  if (model) parts.push(`模型 ${model}`);

  return {
    name,
    kind,
    baseUrl,
    apiKey,
    model,
    useProxy,
    summary: `已解析：${parts.join(' · ')}`,
  };
}

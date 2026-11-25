/**
 * Provider contract. Every API adapter (LLM or machine translation) implements
 * one of the two interfaces below. Adapters never call the global `fetch`
 * directly — they use `ctx.fetch`, which transparently routes through the
 * optional CORS proxy and can be mocked in tests.
 */

export type ProviderKind =
  | 'openai' // any OpenAI-compatible Chat Completions endpoint (DeepSeek, Kimi, Qwen, Ollama, vLLM...)
  | 'anthropic'
  | 'gemini'
  | 'deepl'
  | 'google-translate' // Google Cloud Translation v2 (API key)
  | 'baidu' // 百度翻译开放平台 通用文本翻译
  | 'youdao'; // 有道智云 文本翻译

export const LLM_KINDS: ProviderKind[] = ['openai', 'anthropic', 'gemini'];
export const MT_KINDS: ProviderKind[] = ['deepl', 'google-translate', 'baidu', 'youdao'];

export interface ProviderConfig {
  id: string;
  /** User-facing label, e.g. "DeepSeek" */
  name: string;
  kind: ProviderKind;
  /** Root URL, e.g. https://api.openai.com/v1 . Optional for fixed-endpoint services. */
  baseUrl?: string;
  /** API key / token. For baidu: secret key. For youdao: app secret. */
  apiKey: string;
  /** baidu: appid. youdao: appKey (应用ID). Unused by others. */
  appId?: string;
  /** LLM model name, e.g. gpt-4o-mini, claude-sonnet-5-5, gemini-2.5-flash */
  model?: string;
  temperature?: number;
  /** Route requests through the CORS proxy configured in settings. */
  useProxy?: boolean;
  /** Extra HTTP headers (LLM only), merged last. */
  extraHeaders?: Record<string, string>;
}

/** Internal language codes. Adapters map these to vendor-specific codes. */
export type LangCode =
  | 'auto'
  | 'en'
  | 'zh-CN'
  | 'zh-TW'
  | 'ja'
  | 'ko'
  | 'fr'
  | 'de'
  | 'es'
  | 'ru'
  | 'pt'
  | 'it';

export const LANGUAGES: { code: LangCode; label: string }[] = [
  { code: 'auto', label: '自动检测' },
  { code: 'en', label: 'English' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'ru', label: 'Русский' },
  { code: 'pt', label: 'Português' },
  { code: 'it', label: 'Italiano' },
];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMProvider {
  type: 'llm';
  /** Streams assistant text deltas. Throws ProviderError on HTTP/API errors. */
  chat(req: ChatRequest): AsyncIterable<string>;
}

export interface TranslateRequest {
  /** One or more independent segments; result array has the same length and order. */
  texts: string[];
  from: LangCode;
  to: LangCode;
  signal?: AbortSignal;
}

export interface MTProvider {
  type: 'mt';
  translate(req: TranslateRequest): Promise<string[]>;
}

export type Provider = LLMProvider | MTProvider;

export interface ProviderContext {
  /** Use this instead of global fetch. */
  fetch: typeof fetch;
}

export class ProviderError extends Error {
  status?: number;
  body?: string;
  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.body = body;
  }
}

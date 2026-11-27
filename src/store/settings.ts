import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { LangCode, ProviderConfig } from '../providers/types';

export type Theme = 'system' | 'light' | 'dark';
export type PdfTheme = 'auto' | 'original' | 'parchment' | 'dim' | 'dark';
export type SelectionAction = 'popup' | 'auto-translate' | 'none';
export type TagColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';

export const MAX_CONCURRENCY = 3;
export const clampConcurrency = (n: number | undefined) => Math.max(1, Math.min(MAX_CONCURRENCY, Math.round(Number(n) || MAX_CONCURRENCY)));

export const TAG_COLORS: { id: TagColor; hex: string; label: string }[] = [
  { id: 'red', hex: '#ef4444', label: '红（精读核心）' },
  { id: 'orange', hex: '#f97316', label: '橙（重要参考）' },
  { id: 'yellow', hex: '#eab308', label: '黄（方法借鉴）' },
  { id: 'green', hex: '#22c55e', label: '绿（待引用）' },
  { id: 'blue', hex: '#3b82f6', label: '蓝（组会汇报）' },
  { id: 'purple', hex: '#a855f7', label: '紫（灵感方向）' },
];

export const TAG_COLOR_HEX: Record<TagColor, string> = {
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  blue: '#3b82f6',
  purple: '#a855f7',
};

export interface PromptTemplates {
  /** Used for selection + full-text translation with LLMs. Placeholders: {{from}} {{to}} {{glossary}} {{context}} */
  translateSystem: string;
  /** Explain selected text. Placeholders: {{to}} */
  explainSystem: string;
  /** Q&A about the paper. Placeholders: {{to}} {{title}} */
  chatSystem: string;
}

export const DEFAULT_PROMPTS: PromptTemplates = {
  translateSystem: `You are a professional academic translator. Translate the user's text from {{from}} into {{to}}.
Rules:
- Keep academic tone, accuracy and terminology; do not add explanations.
- Keep LaTeX/math, citations like [12] or (Smith et al., 2020), URLs, code and variable names unchanged.
- Fix broken words caused by PDF line breaks.
- Output ONLY the translation.{{glossary}}{{context}}`,
  explainSystem: `You are a patient research mentor. The user selected a passage from an academic paper. Explain it in {{to}}: what it means, key terms, and any formulas or notation, using concise Markdown. Use $...$ for inline math.`,
  chatSystem: `You are a research assistant helping the user read the paper "{{title}}". Answer in {{to}} using concise Markdown, grounded in the paper text provided. When citing, refer to the page number like (p.3). If the paper does not contain the answer, say so. Use $...$ / $$...$$ for math.`,
};

export interface Settings {
  providers: ProviderConfig[];
  /** Provider used for selection and full-text translation. */
  translateProviderId: string | null;
  /** LLM used for explain / chat / summary. */
  chatProviderId: string | null;
  sourceLang: LangCode;
  targetLang: LangCode;
  proxyUrl: string;
  proxyToken: string;
  selectionAction: SelectionAction;
  theme: Theme;
  /** PDF page rendering color mode: auto (night-paper in dark mode), original (pure white), parchment (warm sepia paper), dim (soft eye-comfort), dark (inverted night paper). */
  pdfTheme: PdfTheme;
  /** Max parallel requests during full-text translation (capped at 3). */
  concurrency: number;
  /** Paragraphs per LLM request in full-text mode. */
  batchSize: number;
  prompts: PromptTemplates;
  readerFontSize: number;
  /** extract the paper's key terms into its glossary before a fresh full-text translation */
  autoTerms: boolean;
  /** Zotero-style colored tag assignments (tag name -> color id). */
  tagColors: Record<string, TagColor>;
}

/**
 * Local dev → the standalone proxy on :8787. Deployed (any other host) → the
 * proxy served by the same web server under /proxy (same origin, no CORS).
 */
export function defaultProxyUrl(): string {
  if (import.meta.env.DEV || typeof location === 'undefined') return 'http://127.0.0.1:8787';
  if (location.hostname === 'appassets.androidplatform.net') return '';
  return new URL('.', location.href).href.replace(/\/+$/, '');
}

interface SettingsStore extends Settings {
  set: (patch: Partial<Settings>) => void;
  upsertProvider: (p: ProviderConfig) => void;
  removeProvider: (id: string) => void;
  setTagColor: (tag: string, color: TagColor | null) => void;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      providers: [],
      translateProviderId: null,
      chatProviderId: null,
      sourceLang: 'auto',
      targetLang: 'zh-CN',
      proxyUrl: defaultProxyUrl(),
      proxyToken: '',
      selectionAction: 'popup',
      theme: 'system',
      pdfTheme: 'auto',
      concurrency: 3,
      batchSize: 6,
      prompts: DEFAULT_PROMPTS,
      readerFontSize: 15,
      autoTerms: true,
      tagColors: {},
      set: (patch) =>
        set(patch.concurrency !== undefined ? { ...patch, concurrency: clampConcurrency(patch.concurrency) } : patch),
      setTagColor: (tag, color) =>
        set((s) => {
          const next = { ...(s.tagColors ?? {}) };
          if (color) next[tag] = color;
          else delete next[tag];
          return { tagColors: next };
        }),
      upsertProvider: (p) =>
        set((s) => {
          const exists = s.providers.some((x) => x.id === p.id);
          const providers = exists ? s.providers.map((x) => (x.id === p.id ? p : x)) : [...s.providers, p];
          return {
            providers,
            translateProviderId: s.translateProviderId ?? p.id,
            chatProviderId:
              s.chatProviderId ?? (['openai', 'anthropic', 'gemini'].includes(p.kind) ? p.id : null),
          };
        }),
      removeProvider: (id) =>
        set((s) => ({
          providers: s.providers.filter((x) => x.id !== id),
          translateProviderId: s.translateProviderId === id ? null : s.translateProviderId,
          chatProviderId: s.chatProviderId === id ? null : s.chatProviderId,
        })),
    }),
    {
      name: 'paperbridge-settings',
      version: 1,
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Settings>;
        return {
          ...current,
          ...p,
          concurrency: clampConcurrency(p.concurrency ?? current.concurrency),
          pdfTheme: p.pdfTheme ?? current.pdfTheme,
          prompts: { ...DEFAULT_PROMPTS, ...(p.prompts ?? {}) },
        };
      },
    },
  ),
);

export const getSettings = () => useSettings.getState();

import { db, sha256Hex, type GlossaryEntry } from '../db/db';
import { createProvider } from '../providers';
import { makeContext } from '../providers/http';
import {
  LANGUAGES,
  ProviderError,
  type ChatMessage,
  type LangCode,
  type LLMProvider,
  type Provider,
  type ProviderConfig,
} from '../providers/types';
import { getSettings } from '../store/settings';
import { createLimiter } from './limiter';

export function langLabel(code: LangCode): string {
  if (code === 'auto') return 'the source language';
  const l = LANGUAGES.find((x) => x.code === code);
  return l ? `${l.label} (${code})` : code;
}

export function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
}

export function getProviderConfig(id: string | null): ProviderConfig | null {
  if (!id) return null;
  return getSettings().providers.find((p) => p.id === id) ?? null;
}

export function instantiate(cfg: ProviderConfig): Provider {
  const s = getSettings();
  return createProvider(cfg, makeContext(cfg, s.proxyUrl, s.proxyToken));
}

export class NoProviderError extends Error {
  constructor(what: string) {
    super(`尚未配置${what}，请先在「设置」中添加 API 并选择。`);
    this.name = 'NoProviderError';
  }
}

export function getTranslator(): { cfg: ProviderConfig; provider: Provider } {
  const cfg = getProviderConfig(getSettings().translateProviderId);
  if (!cfg) throw new NoProviderError('翻译服务');
  return { cfg, provider: instantiate(cfg) };
}

export function getChatLLM(): { cfg: ProviderConfig; provider: LLMProvider } {
  const s = getSettings();
  let cfg = getProviderConfig(s.chatProviderId);
  // Fall back to the translate provider if it is an LLM.
  if (!cfg) {
    const t = getProviderConfig(s.translateProviderId);
    if (t && ['openai', 'anthropic', 'gemini'].includes(t.kind)) cfg = t;
  }
  if (!cfg) throw new NoProviderError('大模型（用于解释 / 问答）');
  const provider = instantiate(cfg);
  if (provider.type !== 'llm') throw new NoProviderError('大模型（用于解释 / 问答）');
  return { cfg, provider };
}

// ---------------------------------------------------------------- glossary

export async function loadGlossary(docId?: string): Promise<GlossaryEntry[]> {
  const scopes = docId ? ['global', docId] : ['global'];
  const rows = await db.glossary.where('scope').anyOf(scopes).toArray();
  // doc-scoped entries override global ones with the same source term
  const map = new Map<string, GlossaryEntry>();
  for (const r of rows.sort((a, b) => (a.scope === 'global' ? -1 : 1) - (b.scope === 'global' ? -1 : 1))) {
    map.set(r.source.toLowerCase(), r);
  }
  return [...map.values()];
}

/** Only include glossary terms that actually occur in the text, to keep prompts small. */
export function relevantGlossary(glossary: GlossaryEntry[], text: string): GlossaryEntry[] {
  const lower = text.toLowerCase();
  return glossary.filter((g) => g.source && lower.includes(g.source.toLowerCase()));
}

function glossaryBlock(entries: GlossaryEntry[]): string {
  if (!entries.length) return '';
  return (
    '\n- Use this glossary consistently (source → target):\n' +
    entries.map((e) => `  ${e.source} → ${e.target}`).join('\n')
  );
}

// ---------------------------------------------------------------- prompts

export interface TranslateOpts {
  docId?: string;
  docTitle?: string;
  signal?: AbortSignal;
  /** Extra instruction appended to the LLM system prompt (e.g. keep {v0} placeholders). Part of the cache key. */
  extraRule?: string;
  /** Bulk request (full text, repairs, export): waits for one of the shared "并发数" slots. */
  bulk?: boolean;
  /** Bulk request a page is waiting for (a repair retry): takes the next free slot ahead of queued batches. */
  urgent?: boolean;
  /** translateBatch: called with (index, text) for each segment as soon as the model has finished it (not cached yet). */
  onSegment?: (index: number, text: string) => void;
}

/** Shared cap on bulk translation requests (see limiter.ts). */
export const bulkSlots = createLimiter(() => Math.max(1, Math.min(3, getSettings().concurrency)));
const inSlot = <T>(opts: TranslateOpts, fn: () => Promise<T>): Promise<T> => (opts.bulk === false ? fn() : bulkSlots.run(fn, opts.urgent, opts.signal));

/**
 * Everything that influences a translation, captured once per call so the
 * request and the cache key can never disagree (e.g. if the user switches the
 * target language while a request is in flight).
 */
interface Snapshot {
  cfg: ProviderConfig;
  provider: Provider;
  from: LangCode;
  to: LangCode;
  template: string;
  glossary: GlossaryEntry[];
  title: string;
  extra: string;
}

async function snapshot(opts: TranslateOpts, cfgOverride?: ProviderConfig): Promise<Snapshot> {
  const s = getSettings();
  const cfg = cfgOverride ?? getTranslator().cfg;
  return {
    cfg,
    provider: instantiate(cfg),
    from: s.sourceLang,
    to: s.targetLang,
    template: s.prompts.translateSystem,
    glossary: await loadGlossary(opts.docId),
    title: opts.docTitle ?? '',
    extra: opts.extraRule ?? '',
  };
}

const isLLMKind = (cfg: ProviderConfig) => cfg.kind === 'openai' || cfg.kind === 'anthropic' || cfg.kind === 'gemini';

function buildSystemPrompt(snap: Snapshot, text: string): string {
  return fillTemplate(snap.template + (snap.extra ? `\n- ${snap.extra}` : ''), {
    from: langLabel(snap.from),
    to: langLabel(snap.to),
    glossary: glossaryBlock(relevantGlossary(snap.glossary, text)),
    context: snap.title ? `\n- Context: the text is from the paper "${snap.title}".` : '',
  });
}

/** Cache key = hash of every input that materially changes the output for this text. */
export function cacheKey(snap: Snapshot, text: string): Promise<string> {
  const { cfg } = snap;
  const llm = isLLMKind(cfg);
  const glossary = llm
    ? relevantGlossary(snap.glossary, text)
        .map((e) => [e.source, e.target])
        .sort()
    : [];
  return sha256Hex(
    JSON.stringify([
      cfg.kind,
      cfg.baseUrl ?? '',
      cfg.model ?? '',
      llm ? (cfg.temperature ?? 0.2) : null,
      snap.from,
      snap.to,
      glossary,
      llm ? snap.template : '',
      // The paper title is only a soft hint in the prompt and is deliberately NOT part of the key:
      // metadata lookups rename documents after import, which would orphan every cached translation.
      llm ? snap.extra : '',
      text,
    ]),
  );
}

async function writeCache(key: string, source: string, result: string, docId?: string) {
  if (!result.trim()) return;
  await db.translations.put({ key, source, result, docId, createdAt: Date.now() });
}

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

// ---------------------------------------------------------------- single text (streaming)

/**
 * Translate one piece of text, streaming partial output via onDelta (full text so far).
 * Returns the final translation. Uses and fills the cache.
 */
export async function translateText(
  text: string,
  opts: TranslateOpts & {
    onDelta?: (full: string) => void;
    bypassCache?: boolean;
    /** One-off instruction for this request only (not part of the cache key), e.g. why a retry is needed. */
    hint?: string;
    /** false: do not store the result (the caller stores it with cacheTranslation once it is accepted) */
    cacheWrite?: boolean;
  },
): Promise<string> {
  const snap = await snapshot(opts);
  const { cfg, provider } = snap;
  const key = await cacheKey(snap, text);
  if (!opts.bypassCache) {
    const hit = (await db.translations.get(key))?.result;
    if (hit) {
      opts.onDelta?.(hit);
      return hit;
    }
  }
  abortIfNeeded(opts.signal);
  const slot = opts.bulk ? (fn: () => Promise<string>) => inSlot(opts, fn) : (fn: () => Promise<string>) => fn();
  let out = '';
  if (provider.type === 'mt') {
    out = await slot(async () => (await provider.translate({ texts: [text], from: snap.from, to: snap.to, signal: opts.signal }))[0]);
    opts.onDelta?.(out);
  } else {
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(snap, text) + (opts.hint ? `\n- ${opts.hint}` : '') },
      { role: 'user', content: text },
    ];
    out = await slot(() => {
      const guard = stallGuard(opts.signal);
      return guard.run(async (signal) => {
        let acc = '';
        for await (const d of provider.chat({ messages, signal, temperature: cfg.temperature ?? 0.2 })) {
          acc += d;
          guard.tick();
          opts.onDelta?.(acc);
        }
        return acc.trim();
      });
    });
  }
  if (opts.cacheWrite !== false) await writeCache(key, text, out, opts.docId);
  return out;
}

/**
 * Returns a function that stores an accepted translation of `text` under the key `translateText(text, opts)`
 * reads with the settings of now (call it before the request, so a settings change during the request
 * cannot file the result under the new settings).
 */
export async function cacheWriter(text: string, opts: TranslateOpts): Promise<(result: string) => Promise<void>> {
  const key = await cacheKey(await snapshot(opts), text);
  return (result) => writeCache(key, text, result, opts.docId);
}

// ---------------------------------------------------------------- batches (full-text mode)

const SEG_RE = /<seg id="?(\d+)"?>([\s\S]*?)<\/seg>/g;

export function buildBatchUserMessage(texts: string[]): string {
  return (
    `Translate each <seg> independently. Reply with exactly ${texts.length} <seg> elements with the same ids, and nothing else.\n\n` +
    texts.map((t, i) => `<seg id="${i + 1}">${t}</seg>`).join('\n')
  );
}

/** Strict: every id 1..n exactly once, each non-empty; otherwise null. */
export function parseBatchReply(reply: string, n: number): string[] | null {
  const out: string[] = new Array(n).fill('');
  const seen = new Set<number>();
  for (const m of reply.matchAll(SEG_RE)) {
    const idx = Number(m[1]) - 1;
    const value = m[2].trim();
    if (idx < 0 || idx >= n || seen.has(idx) || !value) return null;
    seen.add(idx);
    out[idx] = value;
  }
  return seen.size === n ? out : null;
}

export class StallError extends Error {
  constructor(seconds: number) {
    super(`请求超时：服务 ${seconds} 秒没有响应（timeout）`);
    this.name = 'TimeoutError';
  }
}

/**
 * Abort a request that stalls: no first byte within `firstMs`, or no new data for `idleMs`.
 * Without this a single hung connection would freeze a whole full-text run forever.
 */
export function stallGuard(parent?: AbortSignal, firstMs = 90_000, idleMs = 45_000) {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stalled: StallError | null = null;
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = new StallError(Math.round(ms / 1000));
      ctrl.abort(stalled);
    }, ms);
  };
  const onAbort = () => ctrl.abort(parent?.reason);
  if (parent?.aborted) ctrl.abort(parent.reason);
  else parent?.addEventListener('abort', onAbort, { once: true });
  arm(firstMs);
  return {
    signal: ctrl.signal,
    tick: () => arm(idleMs),
    /** run `fn`; a stall surfaces as StallError (retryable) instead of an abort */
    async run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
      try {
        return await fn(ctrl.signal);
      } catch (e) {
        if (stalled && !parent?.aborted) throw stalled;
        throw e;
      } finally {
        clearTimeout(timer);
        parent?.removeEventListener('abort', onAbort);
      }
    },
  };
}

async function llmCollect(snap: Snapshot, provider: LLMProvider, user: string, promptText: string, signal?: AbortSignal, onDelta?: (full: string) => void) {
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(snap, promptText) },
    { role: 'user', content: user },
  ];
  const guard = stallGuard(signal);
  return guard.run(async (sig) => {
    let out = '';
    for await (const d of provider.chat({ messages, signal: sig, temperature: snap.cfg.temperature ?? 0.2 })) {
      out += d;
      guard.tick();
      onDelta?.(out);
    }
    return out.trim();
  });
}

/** Calls `emit(index, text)` once for each <seg> of a streaming batch reply as soon as it is closed. */
export function segmentStream(n: number, emit: (index: number, text: string) => void): (full: string) => void {
  const done = new Set<number>();
  let scanned = 0;
  return (full) => {
    const end = full.lastIndexOf('</seg>');
    if (end < scanned) return;
    for (const m of full.slice(0, end + 6).matchAll(SEG_RE)) {
      const idx = Number(m[1]) - 1;
      const value = m[2].trim();
      if (idx < 0 || idx >= n || done.has(idx) || !value) continue;
      done.add(idx);
      emit(idx, value);
    }
    scanned = end + 1;
  };
}

export class EmptyTranslationError extends Error {
  constructor() {
    super('服务返回了空译文');
    this.name = 'EmptyTranslationError';
  }
}

/**
 * Translate many independent segments. Cached segments are skipped. For LLMs the
 * uncached segments are sent in one request with <seg> markers; if the model
 * breaks the format we fall back to one request per segment. Bulk by default (`bulk: false` opts out).
 */
export async function translateBatch(texts: string[], opts: TranslateOpts): Promise<string[]> {
  const snap = await snapshot(opts);
  const { provider } = snap;
  const keys = await Promise.all(texts.map((t) => cacheKey(snap, t)));
  const cached = await db.translations.bulkGet(keys);
  const results: string[] = cached.map((c) => c?.result ?? '');
  const todo = texts.map((_, i) => i).filter((i) => !results[i]);
  if (!todo.length) return results;
  abortIfNeeded(opts.signal);

  const todoTexts = todo.map((i) => texts[i]);
  let translated: string[];
  // every request holds one of the shared slots only while it runs (the per-segment fallback below asks for
  // its own, so a batch never waits on itself)
  if (provider.type === 'mt') {
    translated = await inSlot(opts, () => stallGuard(opts.signal).run((signal) => provider.translate({ texts: todoTexts, from: snap.from, to: snap.to, signal })));
  } else if (todoTexts.length === 1) {
    translated = [await inSlot(opts, () => llmCollect(snap, provider, todoTexts[0], todoTexts[0], opts.signal))];
  } else {
    const emit = opts.onSegment;
    const stream = emit && segmentStream(todoTexts.length, (j, t) => emit(todo[j], t));
    const reply = await inSlot(opts, () => llmCollect(snap, provider, buildBatchUserMessage(todoTexts), todoTexts.join('\n'), opts.signal, stream));
    const parsed = parseBatchReply(reply, todoTexts.length);
    // the model broke the <seg> format: one request per segment, in parallel (as many as the slots allow)
    translated =
      parsed ??
      (await Promise.all(
        todoTexts.map((t, j) =>
          inSlot(opts, async () => {
            const out = await llmCollect(snap, provider, t, t, opts.signal);
            if (out) emit?.(todo[j], out);
            return out;
          }),
        ),
      ));
  }
  if (translated.some((t) => !t?.trim())) throw new EmptyTranslationError();
  await Promise.all(
    todo.map((idx, j) => {
      results[idx] = translated[j];
      return writeCache(keys[idx], texts[idx], results[idx], opts.docId);
    }),
  );
  return results;
}

export function describeError(e: unknown): string {
  if (e instanceof DOMException && e.name === 'AbortError') return '已取消';
  if (e instanceof ProviderError) {
    if (/Target host is not allowed/i.test(e.message)) {
      return '代理拒绝了该域名（不在白名单中）。请用 ALLOWED_HOSTS=<域名> 启动代理，例如：ALLOWED_HOSTS=api.example.com node proxy/server.mjs';
    }
    if (/proxy token/i.test(e.message)) return '代理令牌不正确，请检查「设置 → 跨域代理」中的代理令牌。';
    const hint =
      e.status === 401 || e.status === 403
        ? '（API Key 无效或无权限）'
        : e.status === 429
          ? '（请求过于频繁或额度不足）'
          : e.status === 404
            ? '（地址或模型名错误）'
            : '';
    return `${e.message}${hint}`;
  }
  if (e instanceof TypeError && /fetch/i.test(e.message)) {
    return `网络请求失败：${e.message}。可能是该服务不允许浏览器跨域（CORS）或代理未连接，请在「设置 → API 服务」中开启中转代理并按引导完成配置。`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Cache-only lookup (no network). Returns '' for misses. Safe to call without a configured provider. */
export async function getCachedTranslations(texts: string[], opts: Pick<TranslateOpts, 'docId' | 'docTitle'>): Promise<string[]> {
  const cfg = getProviderConfig(getSettings().translateProviderId);
  if (!cfg || !texts.length) return texts.map(() => '');
  const snap = await snapshot(opts, cfg);
  const keys = await Promise.all(texts.map((t) => cacheKey(snap, t)));
  const rows = await db.translations.bulkGet(keys);
  return rows.map((r) => r?.result ?? '');
}

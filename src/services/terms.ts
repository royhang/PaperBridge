/**
 * Automatic terminology for full-text translation: before a fresh full-text run, one LLM request reads the
 * opening pages and proposes translations for the paper's key terms. They are stored as document glossary
 * entries (editable in the 术语 panel) and every later request of the document uses them, so a term is
 * translated the same way on page 1 and page 12.
 */
import { db, type GlossaryEntry } from '../db/db';
import type { ChatMessage, LLMProvider } from '../providers/types';
import { getSettings } from '../store/settings';
import { getCachedTranslations, getTranslator, langLabel, stallGuard } from './translate';

export const AUTO_TERM_NOTE = '自动提取';
// the opening (title, abstract, introduction) names the key terms; the request is output-bound (~70 chars/s on
// slow models), so a shorter sample and list keep it near 10 s — it runs before the first batch
const MAX_INPUT = 4000;

/** Parse the model's reply: a JSON array of {source, target} (fenced or not); junk entries are dropped. */
export function parseTerms(reply: string, targetLang: string): { source: string; target: string }[] {
  const json = reply.match(/\[[\s\S]*\]/)?.[0];
  if (!json) return [];
  let rows: unknown;
  try {
    rows = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const out: { source: string; target: string }[] = [];
  for (const r of rows) {
    const source = typeof r?.source === 'string' ? r.source.trim() : '';
    const target = typeof r?.target === 'string' ? r.target.trim() : '';
    if (source.length < 2 || source.length > 60 || !target || target.length > 40) continue;
    if (!/\p{L}/u.test(source) || source.toLowerCase() === target.toLowerCase()) continue;
    if (targetLang.startsWith('zh') && !/\p{Script=Han}/u.test(target)) continue;
    const key = source.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source, target });
  }
  return out.slice(0, 40);
}

export function termPrompt(sample: string, from: string, to: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        `You are a terminology assistant for translating an academic paper from ${from} to ${to}. ` +
        `From the excerpt, pick 10–20 technical terms that will recur in the paper and must be translated consistently ` +
        `(multi-word concepts, method components, task names, field-specific words). Give the standard ${to} rendering used ` +
        `in the field. Skip person names, model / dataset / software names and acronyms that stay untranslated, ` +
        `and everyday words. Reply with only a JSON array: [{"source": "...", "target": "..."}].`,
    },
    { role: 'user', content: sample.slice(0, MAX_INPUT) },
  ];
}

/** Plain text of planned items (placeholders and style tags removed) — the sample for term extraction. */
export function sampleText(texts: string[]): string {
  return texts
    .map((t) => t.replace(/<\/?s\d+>/g, '').replace(/\{v\d+\}/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 30)
    .join('\n');
}

/**
 * Extract and store terms for `docId` unless it already has automatic terms. `sample` = plain text of the
 * opening pages. Returns how many entries were added (0 when skipped or the provider is not an LLM).
 */
export async function extractDocTerms(docId: string, sample: string, signal?: AbortSignal): Promise<number> {
  const s = getSettings();
  if (s.autoTerms === false || sample.trim().length < 400) return 0;
  const existing = await db.glossary.where('scope').equals(docId).toArray();
  if (existing.some((e) => e.note === AUTO_TERM_NOTE)) return 0;
  const { cfg, provider } = getTranslator();
  if (provider.type !== 'llm') return 0;
  const guard = stallGuard(signal, 60_000, 30_000);
  const reply = await guard.run(async (sig) => {
    let out = '';
    for await (const d of (provider as LLMProvider).chat({ messages: termPrompt(sample, langLabel(s.sourceLang), langLabel(s.targetLang)), signal: sig, temperature: cfg.temperature ?? 0.2 })) {
      out += d;
      guard.tick();
    }
    return out;
  });
  const terms = parseTerms(reply, s.targetLang);
  // the user's own entries win
  const own = new Set(existing.map((e) => e.source.toLowerCase()));
  const now = Date.now();
  const rows: GlossaryEntry[] = terms
    .filter((t) => !own.has(t.source.toLowerCase()))
    .map((t, i) => ({ id: crypto.randomUUID(), source: t.source, target: t.target, note: AUTO_TERM_NOTE, scope: docId, createdAt: now + i }));
  if (rows.length) await db.glossary.bulkPut(rows);
  return rows.length;
}

/**
 * Run term extraction before a full-text translation — only for a fresh document (none of the opening
 * texts is cached: new glossary entries change the cache keys of the texts they occur in). Never throws.
 */
export async function prepareTerms(docId: string | undefined, openingTexts: string[], signal?: AbortSignal, onStart?: () => void): Promise<number> {
  if (!docId || getSettings().autoTerms === false) return 0;
  try {
    const cached = await getCachedTranslations(openingTexts, { docId });
    if (cached.some(Boolean)) return 0;
    onStart?.();
    return await extractDocTerms(docId, sampleText(openingTexts), signal);
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    console.info('term extraction skipped:', (e as Error)?.message ?? e);
    return 0;
  }
}

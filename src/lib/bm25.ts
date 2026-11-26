/**
 * Zero-dependency bilingual (CJK + Latin) Okapi BM25 retriever for long PDFs (100+ pages).
 *
 * Strategy ("Fit-First"):
 *  - Normal papers (<= 120,000 chars): send full paper text untouched in the system prompt
 *    so prefix Prompt Caching (DeepSeek / OpenAI / Claude / Gemini) stays 100% intact.
 *  - Long PDFs (> 120,000 chars, e.g. 100-500 page dissertations & textbooks): run fast local
 *    BM25 (~3-8 ms, < 1 MB transient memory) to assemble front matter (p.1-3), current reading
 *    window (currentPage ± 1), any explicitly referenced page numbers, and top BM25-ranked pages
 *    within budget — preventing the back half of long PDFs from ever being truncated away.
 */

export interface PageText {
  /** 1-indexed page number */
  page: number;
  text: string;
}

export interface PaperContextOptions {
  /** User question (optionally concatenated with recent user turns) */
  query: string;
  /** 1-indexed page currently viewed by the user */
  currentPage?: number;
  /** Documents shorter than or equal to this char count use full-text mode (default 120,000) */
  fullLimit?: number;
  /** Max characters assembled when BM25 retrieval activates (default 52,000 ≈ 13-18k tokens) */
  ragBudget?: number;
}

export interface PaperContextResult {
  mode: 'full' | 'bm25';
  context: string;
  totalPages: number;
  totalChars: number;
  usedChars: number;
  selectedPages: number[];
}

const EN_STOP = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'are', 'was', 'were', 'have', 'has', 'had',
  'not', 'but', 'can', 'will', 'would', 'should', 'could', 'which', 'their', 'there', 'these', 'those',
  'been', 'into', 'more', 'also', 'such', 'than', 'then', 'when', 'where', 'what', 'how', 'why', 'who',
  'about', 'between', 'through', 'using', 'used', 'based', 'paper', 'section', 'figure', 'show', 'shown',
  'please', 'explain', 'summarize', 'tell', 'does', 'did',
]);

/** Tokenize mixed English/numbers/acronyms and CJK text (character bigrams) with zero dictionary overhead. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();

  // Latin words, model names, numbers, identifiers (e.g. "ppo", "cplex", "resnet-50", "3.2")
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9._-]{1,}/g)) {
    const w = m[0].replace(/^[._-]+|[._-]+$/g, '');
    if (w.length >= 2 && !EN_STOP.has(w)) tokens.push(w);
  }

  // CJK runs → overlapping bigrams (plus single char for 1-char runs)
  for (const m of lower.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]+/g)) {
    const run = m[0];
    if (run.length === 1) {
      tokens.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
    }
  }
  return tokens;
}

/** Extract explicitly referenced 1-indexed page numbers from queries like "第 68 页", "p.42", "page 15". */
export function extractReferencedPages(query: string, maxPage: number): number[] {
  const pages = new Set<number>();
  const patterns = [
    /第\s*(\d{1,4})\s*页/g,
    /\b(?:p\.|pg\.|page)\s*(\d{1,4})\b/gi,
  ];
  for (const re of patterns) {
    for (const m of query.matchAll(re)) {
      const n = Number(m[1]);
      if (n >= 1 && n <= maxPage) pages.add(n);
    }
  }
  return [...pages];
}

/** Score pages using Okapi BM25 (k1 = 1.5, b = 0.75) against a query string. */
export function rankPagesBm25(pages: PageText[], query: string): { page: number; score: number }[] {
  const qTerms = [...new Set(tokenize(query))];
  if (!qTerms.length || !pages.length) return pages.map((p) => ({ page: p.page, score: 0 }));

  const N = pages.length;
  const docTFs: Map<string, number>[] = new Array(N);
  const docLens: number[] = new Array(N);
  const df = new Map<string, number>();
  let totalLen = 0;

  for (let i = 0; i < N; i++) {
    const toks = tokenize(pages[i].text);
    docLens[i] = toks.length;
    totalLen += toks.length;
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    docTFs[i] = tf;
    for (const qt of qTerms) {
      if (tf.has(qt)) df.set(qt, (df.get(qt) ?? 0) + 1);
    }
  }

  const avgdl = Math.max(1, totalLen / N);
  const k1 = 1.5;
  const b = 0.75;

  const scores = pages.map((p, i) => {
    const tf = docTFs[i];
    const dl = docLens[i];
    let s = 0;
    for (const qt of qTerms) {
      const f = tf.get(qt) ?? 0;
      if (!f) continue;
      const n = df.get(qt) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgdl))));
    }
    return { page: p.page, score: s };
  });

  return scores.sort((a, b) => b.score - a.score || a.page - b.page);
}

/**
 * Build optimal Q&A paper context:
 * - Short/normal papers (<= fullLimit chars): full text untouched (Prompt Cache friendly).
 * - Long 100+ page PDFs (> fullLimit chars): local BM25 page retrieval + anchors.
 */
export function buildPaperContext(pages: PageText[], opts: PaperContextOptions): PaperContextResult {
  const fullLimit = opts.fullLimit ?? 120_000;
  const ragBudget = opts.ragBudget ?? 52_000;
  const chunks = pages.map((p) => ({ page: p.page, text: p.text, formatted: `\n[p.${p.page}]\n${p.text}` }));
  const totalChars = chunks.reduce((acc, c) => acc + c.formatted.length, 0);

  if (totalChars <= fullLimit) {
    const context = chunks.map((c) => c.formatted).join('');
    return {
      mode: 'full',
      context,
      totalPages: pages.length,
      totalChars,
      usedChars: context.length,
      selectedPages: pages.map((p) => p.page),
    };
  }

  // Long PDF (> fullLimit): pick anchor pages + explicitly cited pages + BM25 top pages within ragBudget
  const byPage = new Map(chunks.map((c) => [c.page, c]));
  const picked = new Set<number>();
  let used = 0;

  const tryAdd = (pageNum: number): boolean => {
    if (picked.has(pageNum)) return true;
    const item = byPage.get(pageNum);
    if (!item) return false;
    if (used + item.formatted.length > ragBudget && picked.size >= 4) return false;
    picked.add(pageNum);
    used += item.formatted.length;
    return true;
  };

  // 1. Explicitly mentioned pages in query (e.g. "第 88 页" / "p.88")
  for (const p of extractReferencedPages(opts.query, pages.length)) {
    tryAdd(p);
    tryAdd(p + 1);
  }

  // 2. Front matter (title / abstract / TOC: pages 1..3)
  for (let p = 1; p <= Math.min(3, pages.length); p++) tryAdd(p);

  // 3. Current reading window (currentPage and its immediate neighbours)
  if (opts.currentPage && opts.currentPage >= 1 && opts.currentPage <= pages.length) {
    tryAdd(opts.currentPage);
    if (opts.currentPage > 1) tryAdd(opts.currentPage - 1);
    if (opts.currentPage < pages.length) tryAdd(opts.currentPage + 1);
  }

  // 4. Top BM25-ranked pages across the entire document (including back half / appendices)
  const ranked = rankPagesBm25(pages, opts.query);
  for (const r of ranked) {
    if (used >= ragBudget) break;
    if (r.score <= 0 && picked.size >= 8) break;
    tryAdd(r.page);
  }

  const ordered = [...picked].sort((a, b) => a - b);
  const header = `[Long document (${pages.length} pages): auto-selected ${ordered.length} most relevant pages (${ordered.map((n) => `p.${n}`).join(', ')}) via local BM25 + reading position]`;
  const body = ordered.map((n) => byPage.get(n)!.formatted).join('');
  const context = `${header}\n${body}`;

  return {
    mode: 'bm25',
    context,
    totalPages: pages.length,
    totalChars,
    usedChars: context.length,
    selectedPages: ordered,
  };
}

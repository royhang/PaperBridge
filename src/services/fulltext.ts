/**
 * Full-text translation for the reader. One run produces both
 *  - per-paragraph translations (side panel 「对照」, Markdown export), and
 *  - per-page layout-preserving translated PDFs (reader 双栏 / 译文 views), rendered as soon
 *    as all paragraphs of a page are translated.
 * Paragraph texts carry {vN} placeholders for inline formulas, so the translator keeps them
 * and the PDF renderer can put the original formula glyphs back in place.
 */
import type { PDFDocument } from 'pdf-lib';
import { db } from '../db/db';
import { getPageParagraphs, type PDFDocumentProxy } from '../pdf/loader';
import { isTranslatable } from '../pdf/paragraphs';
import type { Paragraph } from '../pdf/types';
import { PLACEHOLDER_RULE, withRetry } from '../pdfout/common';
import type { PageDiag, PageItem, PagePlan } from '../pdfout/translatePdf';
import { getSettings } from '../store/settings';
import { useReader, type ParaState } from '../store/reader';
import { registerFullTextEvictor } from '../store/tabs';
import { describeError, getCachedTranslations, translateBatch } from './translate';

type Pipeline = typeof import('../pdfout/translatePdf');

interface Session {
  pdf: PDFDocumentProxy;
  docId: string;
  mod: Promise<Pipeline>;
  src: Promise<PDFDocument | null>;
  plans: Map<number, Promise<PagePlan>>;
  /** plans before cross-page linking (linking needs the next page's plan) */
  base: Map<number, Promise<PagePlan>>;
  /** for pages with an incoming continuation: the text it was last drawn with (undefined = kept original) */
  incomingUsed: Map<number, string | undefined>;
  /** render generation per page: only the newest render of a page may publish its result */
  gen: Map<number, number>;
  /** aborted when translation settings change (stops in-flight repairs) */
  abort: AbortController;
  /** raw translations per page, aligned with plan.items ('' = not translated yet) */
  raw: Map<number, string[]>;
  rendering: Map<number, Promise<void>>;
  /** per-block diagnostics of the last render of each page */
  diags: Map<number, PageDiag>;
}

const sessions = new Map<string, Session>();
let controller: AbortController | null = null;

const MAX_BATCH_CHARS = 3500;

export function evictFullTextSession(docId: string) {
  const s = sessions.get(docId);
  if (s) {
    s.abort.abort();
    sessions.delete(docId);
  }
}

registerFullTextEvictor(evictFullTextSession);

function getSession(): Session | null {
  const { pdf, docId } = useReader.getState();
  if (!pdf || !docId) return null;
  const existing = sessions.get(docId);
  if (existing?.pdf === pdf) return existing;
  if (existing) existing.abort.abort();
  const mod = import('../pdfout/translatePdf');
  const created: Session = {
    pdf,
    docId,
    mod,
    src: (async () => {
      const blob = await db.blobs.get(docId);
      if (!blob) return null;
      const { PDFDocument } = await import('pdf-lib');
      return PDFDocument.load(await blob.blob.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false });
    })().catch((e) => {
      console.error('pdf-lib could not parse the document', e);
      return null;
    }),
    plans: new Map(),
    base: new Map(),
    incomingUsed: new Map(),
    gen: new Map(),
    abort: new AbortController(),
    raw: new Map(),
    rendering: new Map(),
    diags: new Map(),
  };
  sessions.set(docId, created);
  return created;
}

/**
 * The plan of a page, linked with its neighbours: a sentence cut by a page break is translated as one item
 * of the earlier page (see linkPages). Linking happens before anyone sees either plan, so the item lists
 * (and the raw translation arrays aligned with them) never change afterwards.
 */
function getPlan(sess: Session, pageIndex: number): Promise<PagePlan> {
  let p = sess.plans.get(pageIndex);
  if (!p) {
    p = (async () => {
      const [mod, plan] = await Promise.all([sess.mod, basePlan(sess, pageIndex)]);
      if (pageIndex > 0) mod.linkPages(await basePlan(sess, pageIndex - 1), plan);
      if (pageIndex + 1 < sess.pdf.numPages) mod.linkPages(plan, await basePlan(sess, pageIndex + 1));
      return plan;
    })();
    sess.plans.set(pageIndex, p);
    p.catch(() => sess.plans.delete(pageIndex));
  }
  return p;
}

function basePlan(sess: Session, pageIndex: number): Promise<PagePlan> {
  let p = sess.base.get(pageIndex);
  if (!p) {
    p = (async () => {
      const [mod, src] = await Promise.all([sess.mod, sess.src]);
      const fallback = async (reason: string): Promise<PagePlan> => ({
        pageIndex,
        skipped: reason,
        items: [],
        kept: [],
        regions: [],
        endsInReferences: false,
        paragraphs: (await getPageParagraphs(sess.pdf, sess.docId, pageIndex)).filter(isTranslatable),
      });
      if (!src) return fallback('无法解析此 PDF 的内容');
      // a reference list continuing from the previous page is kept as original too
      const inReferences = pageIndex > 0 ? (await basePlan(sess, pageIndex - 1)).endsInReferences : false;
      try {
        return mod.planPage(src, pageIndex, { inReferences });
      } catch (e) {
        console.error('planPage', pageIndex, e);
        return fallback('这一页的内容无法解析');
      }
    })();
    sess.base.set(pageIndex, p);
    p.catch(() => sess.base.delete(pageIndex));
  }
  return p;
}

/**
 * Identity of the document + translation settings a piece of async work started
 * with. Results are only applied while it is still current, so a run for paper A
 * (or for the previous target language) can never write into the next one.
 */
function captureEpoch() {
  const { pdf, transVersion } = useReader.getState();
  return () => {
    const s = useReader.getState();
    return s.pdf === pdf && s.transVersion === transVersion;
  };
}

const opts = (signal?: AbortSignal) => {
  const { docId, title } = useReader.getState();
  return { docId: docId ?? undefined, docTitle: title, signal, extraRule: PLACEHOLDER_RULE };
};

function rawFor(sess: Session, plan: PagePlan): string[] {
  let raw = sess.raw.get(plan.pageIndex);
  if (!raw || raw.length !== plan.items.length) {
    raw = plan.items.map(() => '');
    sess.raw.set(plan.pageIndex, raw);
  }
  return raw;
}

const paraIds = (item: PageItem) => [item.para.id, ...(item.cont ? [item.cont.para.id] : [])];

/** The previous page's item that carries this page's incoming continuation. */
async function incomingOwner(sess: Session, plan: PagePlan): Promise<{ prev: PagePlan; k: number; item: PageItem } | undefined> {
  if (!plan.incoming) return undefined;
  const [mod, prev] = await Promise.all([sess.mod, getPlan(sess, plan.incoming.fromPage)]);
  const k = mod.incomingOwner(prev, plan);
  return k >= 0 ? { prev, k, item: prev.items[k] } : undefined;
}

/** The paragraphs a page shows in the side panel, in reading order (incl. joined continuations). */
function panelParagraphs(plan: PagePlan): Paragraph[] {
  const paras = plan.items.flatMap((it) => [it.para, ...(it.cont && !it.cont.crossPage ? [it.cont.para] : [])]);
  if (plan.incoming) paras.push(plan.incoming.para);
  return paras.sort((a, b) => a.order - b.order);
}

/**
 * Page `pi` changed translations: if page `pi + 1` was drawn with a different share of the sentence that
 * continues there (or without it), draw it again.
 */
function wakeNext(sess: Session, pi: number, current: () => boolean) {
  const next = sess.plans.get(pi + 1);
  if (!next || !sess.incomingUsed.has(pi + 1)) return;
  void next.then(async (n) => {
    if (n.incoming?.fromPage !== pi || !current()) return;
    const [mod, prev] = await Promise.all([sess.mod, getPlan(sess, pi)]);
    const now = mod.incomingTranslation(prev, rawFor(sess, prev), n);
    if (now !== sess.incomingUsed.get(pi + 1)) maybeRenderPage(sess, n, current, true);
  });
}

async function showParagraphs(sess: Session, items: { item: PageItem; t: string }[]) {
  const mod = await sess.mod;
  return Object.fromEntries(items.flatMap(({ item, t }) => mod.displayParts(item, t).map(([id, translation]) => [id, { status: 'done', translation } as ParaState])));
}

/** Render the translated page once every paragraph of it has a translation. */
function maybeRenderPage(sess: Session, plan: PagePlan, current: () => boolean, force = false) {
  const st = useReader.getState();
  const pi = plan.pageIndex;
  if (!plan.items.length && !plan.incoming) {
    if (!st.pageStates[pi]) st.setPageState(pi, { status: 'skipped' });
    return;
  }
  if (plan.skipped) {
    if (st.pageStates[pi]?.status !== 'skipped') st.setPageState(pi, { status: 'skipped', msg: plan.skipped });
    return;
  }
  const raw = rawFor(sess, plan);
  if (raw.some((t) => !t)) return;
  if (!force && (sess.rendering.has(pi) || st.pageStates[pi]?.status === 'done')) return;
  const gen = (sess.gen.get(pi) ?? 0) + 1;
  sess.gen.set(pi, gen);
  const latest = () => current() && sess.gen.get(pi) === gen;
  const job = (async () => {
    const set = (s: Parameters<typeof st.setPageState>[1]) => latest() && useReader.getState().setPageState(pi, s);
    set({ status: 'running', msg: '排版中…' });
    try {
      const [mod, src] = await Promise.all([sess.mod, sess.src]);
      if (!src) {
        set({ status: 'skipped', msg: '这一页没有可替换的文字' });
        return;
      }
      // re-translate (once, uncached) blocks whose translation broke placeholders / lost numbers
      const { docId, docTitle } = opts();
      const retried = await mod.repairTranslations(plan, raw, { docId, docTitle, signal: sess.abort.signal });
      if (!latest()) return;
      if (retried.length && current()) useReader.getState().setParaStates(await showParagraphs(sess, retried.map((k) => ({ item: plan.items[k], t: raw[k] }))));
      // the continuation of the previous page's last sentence: drawn once that page is translated
      // (until then it stays in the original; the page is redrawn when the text arrives)
      const prev = plan.incoming ? await getPlan(sess, plan.incoming.fromPage) : undefined;
      const incoming = prev ? mod.incomingTranslation(prev, rawFor(sess, prev), plan) : undefined;
      if (plan.incoming) sess.incomingUsed.set(pi, incoming);
      if (!raw.length && !incoming) {
        set({ status: 'queued', done: 0, total: 1 });
        return;
      }
      const { bytes, diag } = await withRetry(
        () => mod.renderSinglePage(src, plan, raw, (m) => set({ status: 'running', msg: m }), incoming),
        undefined,
        (n) => set({ status: 'running', msg: `字体下载中断，第 ${n} 次重试…` }),
      );
      if (!latest()) return;
      sess.diags.set(pi, diag);
      set(bytes ? { status: 'done', bytes } : { status: 'skipped', msg: '这一页的译文都无法安全排入版面，保留原文' });
    } catch (e) {
      console.error('render translated page', pi, e);
      set({ status: 'error', msg: `排版失败：${describeError(e)}` });
    }
  })();
  sess.rendering.set(pi, job);
  void job.finally(() => {
    if (sess.rendering.get(pi) === job) sess.rendering.delete(pi);
    // the next page may be waiting for (or showing an older version of) this page's last sentence
    wakeNext(sess, pi, current);
  });
}

/** Load whatever is cached for a page (no API calls) and render it if complete. */
export async function hydratePageFromCache(pageIndex: number): Promise<Paragraph[]> {
  const sess = getSession();
  if (!sess) return [];
  const current = captureEpoch();
  const plan = await getPlan(sess, pageIndex);
  const paras = panelParagraphs(plan);
  if (!current()) return paras;
  const raw = rawFor(sess, plan);
  // this page's items, plus the previous page's item that carries this page's first sentence
  const owner = await incomingOwner(sess, plan);
  const entries = [...plan.items.map((item, k) => ({ item, k, raw })), ...(owner ? [{ item: owner.item, k: owner.k, raw: rawFor(sess, owner.prev) }] : [])];
  const missing = entries.filter((e) => !e.raw[e.k]);
  if (missing.length) {
    const cached = await getCachedTranslations(
      missing.map((m) => m.item.text),
      opts(),
    );
    if (!current()) return paras;
    missing.forEach((m, j) => cached[j] && (m.raw[m.k] = cached[j]));
  }
  const states = useReader.getState().paraStates;
  const show = entries.map((e) => ({ item: e.item, t: e.raw[e.k] })).filter((x) => x.t && paraIds(x.item).some((id) => states[id]?.status !== 'done'));
  if (show.length) {
    const patch = await showParagraphs(sess, show);
    if (current()) useReader.getState().setParaStates(patch);
  }
  if (current()) maybeRenderPage(sess, plan, current);
  return paras;
}

/** Cached display translations of a page, by paragraph id (for the Markdown export). */
export async function cachedPageTranslations(pageIndex: number): Promise<Map<string, string>> {
  const sess = getSession();
  if (!sess) return new Map();
  const plan = await getPlan(sess, pageIndex);
  const raw = rawFor(sess, plan);
  const cached = await getCachedTranslations(plan.items.map((i) => i.text), opts());
  const mod = await sess.mod;
  const map = new Map(plan.items.flatMap((item, k) => (raw[k] || cached[k] ? mod.displayParts(item, raw[k] || cached[k]) : [[item.para.id, ''] as [string, string]])));
  // the first sentence continuing from the previous page is translated there
  const owner = await incomingOwner(sess, plan);
  if (owner && plan.incoming) {
    const t = rawFor(sess, owner.prev)[owner.k] || (await getCachedTranslations([owner.item.text], opts()))[0];
    map.set(plan.incoming.para.id, t ? (new Map(mod.displayParts(owner.item, t)).get(plan.incoming.para.id) ?? '') : '');
  }
  return map;
}

/** Text blocks of a page in reading order (layout analysis), for the focus outline / Markdown export. */
export async function pageParagraphs(pageIndex: number): Promise<Paragraph[]> {
  const sess = getSession();
  if (!sess) return [];
  return (await getPlan(sess, pageIndex)).paragraphs;
}

/** Per-block diagnostics of the last rendered translation of a page (debugging aid). */
export function pageDiagnostics(pageIndex: number): PageDiag | undefined {
  const { docId } = useReader.getState();
  return docId ? sessions.get(docId)?.diags.get(pageIndex) : undefined;
}

function makeBatches<T extends { item: PageItem }>(entries: T[], size: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let chars = 0;
  for (const e of entries) {
    if (cur.length && (cur.length >= size || chars + e.item.text.length > MAX_BATCH_CHARS)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(e);
    chars += e.item.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Translate the whole document (or a page range), starting from the current page
 * so the user sees results where they are reading.
 */
export async function runFullText(range?: { from: number; to: number }) {
  const r = useReader.getState();
  if (!r.pdf || !r.docId || r.fullTextRunning) return;
  const sess = getSession();
  if (!sess) return;
  controller?.abort();
  const ctrl = new AbortController();
  controller = ctrl;
  const epoch = captureEpoch();
  const alive = () => controller === ctrl && !ctrl.signal.aborted && epoch();
  r.setFullTextRunning(true);
  const { pdf } = r;
  const s = getSettings();
  const first = range?.from ?? 0;
  const last = range?.to ?? pdf.numPages - 1;
  const start = Math.min(Math.max(r.currentPage, first), last);
  const order = [...Array(last - first + 1).keys()]
    .map((i) => i + first)
    .sort((a, b) => (a < start ? a + 1e6 : a) - (b < start ? b + 1e6 : b));
  const patch = (m: Record<string, ParaState>) => alive() && useReader.getState().setParaStates(m);
  const inRange = (plan: PagePlan) => plan.pageIndex >= first && plan.pageIndex <= last;
  const pageProgress = (plan: PagePlan) => {
    if (!alive() || plan.skipped || !inRange(plan)) return;
    const raw = rawFor(sess, plan);
    const done = raw.filter(Boolean).length;
    if (done < raw.length) useReader.getState().setPageState(plan.pageIndex, { status: done ? 'running' : 'queued', done, total: raw.length });
  };

  // key terms first (fresh documents only), so every page uses the same renderings
  try {
    const opening = await Promise.all([0, 1].filter((i) => i < pdf.numPages).map((i) => getPlan(sess, i)));
    const { prepareTerms } = await import('./terms');
    // one request (~10 s) before the first batch: say so on the page the user is looking at
    await prepareTerms(r.docId, opening.flatMap((p) => p.items.map((i) => i.text)), ctrl.signal, () => {
      if (alive() && !useReader.getState().pageStates[start]) useReader.getState().setPageState(start, { status: 'running', msg: '提取本文术语…' });
    });
  } catch {
    // aborted (stop pressed) — the run below notices and cleans up
  }

  type Entry = { plan: PagePlan; k: number; item: PageItem };
  const queue: Entry[][] = [];
  let producerDone = false;
  const produce = async () => {
    try {
      for (const pi of order) {
        if (!alive()) break;
        await hydratePageFromCache(pi);
        if (!alive()) break;
        const plan = await getPlan(sess, pi);
        const raw = rawFor(sess, plan);
        const todo: Entry[] = plan.items.map((item, k) => ({ plan, k, item })).filter((e) => !raw[e.k]);
        // the first sentence of the range may belong to an item of the page before it
        const owner = pi - 1 < first ? await incomingOwner(sess, plan) : undefined;
        if (owner && !rawFor(sess, owner.prev)[owner.k]) todo.unshift({ plan: owner.prev, k: owner.k, item: owner.item });
        if (!todo.length) continue;
        patch(Object.fromEntries(todo.flatMap((e) => paraIds(e.item).map((id) => [id, { status: 'pending' } as ParaState]))));
        pageProgress(plan);
        // while the queue is short (the first page, "仅本页") a page is split so every request slot has work —
        // requests are output-bound, so three small batches finish about three times sooner than one big one
        const conc = Math.max(1, Math.min(3, s.concurrency));
        const size = queue.length < conc ? Math.max(1, Math.min(s.batchSize, Math.ceil(todo.length / conc))) : Math.max(1, s.batchSize);
        queue.push(...makeBatches(todo, size));
      }
    } finally {
      producerDone = true;
    }
  };

  const worker = async () => {
    while (alive()) {
      const batch = queue.shift();
      if (!batch) {
        if (producerDone) return;
        await new Promise((res) => setTimeout(res, 50));
        continue;
      }
      patch(Object.fromEntries(batch.flatMap((e) => paraIds(e.item).map((id) => [id, { status: 'running' } as ParaState]))));
      try {
        // each paragraph shows up in the panel as soon as the model has written it (the page itself is drawn
        // once all of its paragraphs are translated and checked)
        const onSegment = (i: number, t: string) =>
          void showParagraphs(sess, [{ item: batch[i].item, t }]).then((m) => {
            if (alive() && !rawFor(sess, batch[i].plan)[batch[i].k]) patch(m);
          });
        const out = await withRetry(() => translateBatch(batch.map((e) => e.item.text), { ...opts(ctrl.signal), onSegment }), ctrl.signal);
        if (!alive()) return;
        batch.forEach((e, i) => (rawFor(sess, e.plan)[e.k] = out[i]));
        patch(await showParagraphs(sess, batch.map((e, i) => ({ item: e.item, t: out[i] }))));
        for (const plan of new Set(batch.map((e) => e.plan))) {
          pageProgress(plan);
          if (inRange(plan)) maybeRenderPage(sess, plan, epoch);
          wakeNext(sess, plan.pageIndex, epoch);
        }
      } catch (e) {
        if (!alive()) return;
        const msg = describeError(e);
        patch(Object.fromEntries(batch.flatMap((x) => paraIds(x.item).map((id) => [id, { status: 'error', error: msg } as ParaState]))));
        for (const plan of new Set(batch.map((x) => x.plan))) if (inRange(plan)) useReader.getState().setPageState(plan.pageIndex, { status: 'error', msg });
        // Stop early on auth/config errors — every other request would fail too.
        if (/401|403|404|尚未配置|Key/.test(msg)) ctrl.abort();
      }
    }
  };

  const tasks = [produce(), ...Array.from({ length: Math.max(1, Math.min(3, s.concurrency)) }, worker)];
  try {
    await Promise.all(tasks);
  } catch (e) {
    // e.g. page extraction / IndexedDB failure: stop the workers and surface it.
    ctrl.abort();
    await Promise.allSettled(tasks);
    console.error('full-text translation failed', e);
    if (epoch()) alert(`全文翻译中断：${describeError(e)}`);
  } finally {
    if (controller === ctrl) controller = null;
    if (epoch()) {
      // reset pending/running states that never ran
      const st = useReader.getState();
      const reset: Record<string, ParaState> = {};
      for (const [id, v] of Object.entries(st.paraStates)) {
        if (v.status === 'pending' || v.status === 'running') reset[id] = { status: 'error', error: '已取消' };
      }
      if (Object.keys(reset).length) st.setParaStates(reset);
      for (const [pi, v] of Object.entries(st.pageStates)) {
        if (v.status === 'queued' || (v.status === 'running' && v.total)) st.setPageState(Number(pi), { status: 'error', msg: '已停止' });
      }
    }
    if (useReader.getState().pdf === pdf) useReader.getState().setFullTextRunning(false);
  }
}

export function stopFullText() {
  controller?.abort();
}

/** Retry a single paragraph (and re-render its page when complete). */
export async function retryParagraph(p: Paragraph) {
  const sess = getSession();
  if (!sess) return;
  const current = captureEpoch();
  let plan = await getPlan(sess, p.pageIndex);
  // a paragraph continuing the previous page is translated with that page's last paragraph
  if (plan.incoming?.para.id === p.id) plan = await getPlan(sess, plan.incoming.fromPage);
  const k = plan.items.findIndex((i) => i.para.id === p.id || i.cont?.para.id === p.id);
  if (k < 0) return;
  const item = plan.items[k];
  // a paragraph joined across a column break is translated (and retried) as one unit
  const ids = [item.para.id, ...(item.cont ? [item.cont.para.id] : [])];
  const set = (st: ParaState) => current() && ids.forEach((id) => useReader.getState().setParaState(id, st));
  set({ status: 'running' });
  try {
    const [t] = await withRetry(() => translateBatch([item.text], { ...opts(), urgent: true }));
    if (!current()) return;
    rawFor(sess, plan)[k] = t;
    const shown = await showParagraphs(sess, [{ item, t }]);
    if (current()) ids.forEach((id) => shown[id] && useReader.getState().setParaState(id, shown[id]));
    maybeRenderPage(sess, plan, current, true);
    if (item.cont?.crossPage) {
      const n = await getPlan(sess, plan.pageIndex + 1);
      if (sess.incomingUsed.has(n.pageIndex) || useReader.getState().pageStates[n.pageIndex]) maybeRenderPage(sess, n, current, true);
    }
  } catch (e) {
    set({ status: 'error', error: describeError(e) });
  }
}

/** Call when translation-affecting settings change: stop work and drop shown results. */
export function invalidateTranslations() {
  stopFullText();
  for (const s of sessions.values()) {
    s.abort.abort();
    s.abort = new AbortController();
    s.incomingUsed.clear();
    s.raw.clear();
    s.rendering.clear();
  }
  useReader.getState().resetTranslations();
}

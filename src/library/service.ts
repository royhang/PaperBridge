import { db, sha256Hex, uid, type DocRecord, type ReadStatus } from '../db/db';
import { openPdf, readTitle, type PDFDocumentProxy } from '../pdf/loader';
import { parseBibTeX } from './bibtex';
import { crossrefToMeta, extractIdentifiers, guessMetaFromPdf, normalizeTitleForDedupe, parseArxivAtom, parseIdentifierInput, titleFromLayout, type TextRun } from './meta';
import { NetError, getJson, proxyGet } from './net';
import type { MetaSource, PaperMeta } from './types';

export const DOCTEXT_VERSION = 1;

// ---------------------------------------------------------------- helpers

function newDoc(meta: PaperMeta, metaSource: MetaSource, extra: Partial<DocRecord> = {}): DocRecord {
  const now = Date.now();
  return {
    id: uid(),
    title: meta.title || '未命名文献',
    fileName: '',
    size: 0,
    pageCount: 0,
    addedAt: now,
    lastOpenedAt: 0,
    lastPage: 0,
    hash: '',
    meta,
    metaSource,
    tags: [],
    collectionIds: [],
    starred: false,
    status: 'unread',
    hasPdf: false,
    updatedAt: now,
    ...extra,
  };
}

async function pageText(pdf: PDFDocumentProxy, i: number): Promise<string> {
  return (await pageTextAndTitle(pdf, i)).text;
}

/** Plain text of a page, plus the title its type sizes suggest (see titleFromLayout). */
async function pageTextAndTitle(pdf: PDFDocumentProxy, i: number): Promise<{ text: string; title?: string }> {
  const page = await pdf.getPage(i + 1);
  const tc = await page.getTextContent();
  let out = '';
  const runs: TextRun[] = [];
  for (const it of tc.items) {
    if (!('str' in it)) continue;
    out += it.str + (it.hasEOL ? '\n' : ' ');
    const [a, b, , , e, f] = it.transform as number[];
    // upright text only (a sideways stamp in the margin is not the title)
    if (it.str.trim() && Math.abs(b) < 1e-3 * Math.abs(a) && a > 0) runs.push({ str: it.str, x: e, y: f, width: it.width, size: Math.hypot(a, b) });
  }
  const [, y0, , y1] = page.view;
  page.cleanup();
  const title = titleFromLayout(runs.map((r) => ({ ...r, y: r.y - y0 })), y1 - y0);
  return { text: out.replace(/[ \t]+/g, ' ').replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2'), title };
}

/** Find an existing entry that is the same work (by DOI, arXiv id or normalised title). */
export async function findDuplicate(meta: Partial<PaperMeta>, exceptId?: string): Promise<DocRecord | undefined> {
  const cands: (DocRecord | undefined)[] = [];
  if (meta.doi) cands.push(await db.docs.where('meta.doi').equalsIgnoreCase(meta.doi).first());
  if (meta.arxivId) {
    const bare = meta.arxivId.replace(/v\d+$/, '');
    cands.push(await db.docs.filter((d) => d.meta.arxivId?.replace(/v\d+$/, '') === bare).first());
  }
  if (meta.title && meta.title.length > 12) {
    const t = normalizeTitleForDedupe(meta.title);
    cands.push(await db.docs.filter((d) => normalizeTitleForDedupe(d.meta.title) === t).first());
  }
  return cands.find((d) => d && d.id !== exceptId);
}

// ---------------------------------------------------------------- metadata lookup

export async function lookupArxiv(id: string, signal?: AbortSignal): Promise<PaperMeta | null> {
  const bare = id.replace(/^arxiv:/i, '');
  const res = await proxyGet(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(bare)}`, signal);
  return parseArxivAtom(await res.text());
}

export async function lookupDoi(doi: string, signal?: AbortSignal): Promise<{ meta: PaperMeta | null; pdfLinks: string[] }> {
  const json = await getJson<{ message?: { link?: { URL: string; 'content-type'?: string }[] } }>(
    `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    signal,
  );
  const pdfLinks = (json.message?.link ?? []).filter((l) => /pdf/i.test(l['content-type'] ?? '') || /\.pdf($|\?)/i.test(l.URL)).map((l) => l.URL);
  return { meta: crossrefToMeta(json), pdfLinks };
}

/** Merge looked-up metadata into a doc unless the user edited it by hand. */
export async function enrichMetadata(docId: string, opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<boolean> {
  const doc = await db.docs.get(docId);
  if (!doc || (doc.metaSource === 'manual' && !opts.force)) return false;
  let found: PaperMeta | null = null;
  let source: MetaSource = doc.metaSource;
  if (doc.meta.doi) {
    found = (await lookupDoi(doc.meta.doi, opts.signal)).meta;
    source = 'crossref';
  }
  if (!found && doc.meta.arxivId) {
    found = await lookupArxiv(doc.meta.arxivId, opts.signal);
    source = 'arxiv';
  }
  if (!found) return false;
  // keep identifiers we already know if the lookup lacks them
  const meta: PaperMeta = { ...doc.meta, ...stripEmpty(found), doi: found.doi ?? doc.meta.doi, arxivId: found.arxivId ?? doc.meta.arxivId };
  await db.docs.update(docId, { meta, title: meta.title || doc.title, metaSource: source, updatedAt: Date.now() });
  return true;
}

function stripEmpty<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))) as Partial<T>;
}

// ---------------------------------------------------------------- PDF import

export interface ImportResult {
  docId: string;
  duplicate: boolean;
  title: string;
}

/** Store PDF bytes on a doc (new or existing metadata-only entry) and index its text. */
async function attachBytes(doc: DocRecord, buf: ArrayBuffer, fileName: string): Promise<DocRecord> {
  const hash = await sha256Hex(buf);
  const task = openPdf(buf.slice(0));
  try {
    const pdf = await task.promise;
    const { text: first, title: layoutTitle } = await pageTextAndTitle(pdf, 0).catch(() => ({ text: '', title: undefined }));
    let info: Record<string, string> | undefined;
    try {
      info = (await pdf.getMetadata()).info as Record<string, string>;
    } catch {
      /* ignore */
    }
    const guess = guessMetaFromPdf(info, first, fileName, layoutTitle);
    const fallbackTitle = await readTitle(pdf, fileName);
    // Fill only what is missing — existing (e.g. BibTeX/Crossref) metadata wins.
    const meta: PaperMeta = {
      ...doc.meta,
      title: doc.meta.title || guess.title || fallbackTitle,
      authors: doc.meta.authors.length ? doc.meta.authors : (guess.authors ?? []),
      year: doc.meta.year ?? guess.year,
      doi: doc.meta.doi ?? guess.doi,
      arxivId: doc.meta.arxivId ?? guess.arxivId,
    };
    const updated: DocRecord = {
      ...doc,
      meta,
      title: meta.title,
      fileName,
      size: buf.byteLength,
      pageCount: pdf.numPages,
      hash,
      hasPdf: true,
      updatedAt: Date.now(),
    };
    await db.transaction('rw', db.docs, db.blobs, async () => {
      await db.docs.put(updated);
      await db.blobs.put({ id: doc.id, blob: new Blob([buf], { type: 'application/pdf' }) });
    });
    void indexDocText(doc.id, pdf).finally(() => void task.destroy());
    return updated;
  } catch (e) {
    void task.destroy();
    throw e;
  }
}

export async function importPdfBytes(
  buf: ArrayBuffer,
  fileName: string,
  opts: { meta?: PaperMeta; metaSource?: MetaSource; collectionId?: string } = {},
): Promise<ImportResult> {
  const hash = await sha256Hex(buf);
  const same = await db.docs.where('hash').equals(hash).first();
  if (same) return { docId: same.id, duplicate: true, title: same.title };
  // A metadata-only entry for the same work? Attach the PDF to it instead of duplicating.
  const existing = opts.meta ? await findDuplicate(opts.meta) : undefined;
  if (existing && !existing.hasPdf) {
    const d = await attachBytes(existing, buf, fileName);
    return { docId: d.id, duplicate: false, title: d.title };
  }
  const doc = newDoc(opts.meta ?? { title: '', authors: [], type: 'other' }, opts.metaSource ?? 'pdf', {
    collectionIds: opts.collectionId ? [opts.collectionId] : [],
  });
  const saved = await attachBytes(doc, buf, fileName);
  if (!opts.meta && (saved.meta.doi || saved.meta.arxivId)) {
    // best effort, in the background
    void enrichMetadata(saved.id).catch((e) => console.info('metadata lookup skipped:', (e as Error).message));
  }
  return { docId: saved.id, duplicate: false, title: saved.title };
}

export async function importPdfFile(file: File, collectionId?: string): Promise<ImportResult> {
  return importPdfBytes(await file.arrayBuffer(), file.name, { collectionId });
}

export async function attachPdfFile(docId: string, file: File) {
  const doc = await db.docs.get(docId);
  if (!doc) throw new Error('文献不存在');
  await db.paragraphs.where('docId').equals(docId).delete();
  await db.doctext.delete(docId);
  await attachBytes(doc, await file.arrayBuffer(), file.name);
}

export type Progress = (msg: string) => void;

async function readWithProgress(res: Response, onProgress?: Progress): Promise<ArrayBuffer> {
  if (!res.body || !onProgress) return res.arrayBuffer();
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    const mb = (n: number) => (n / 1048576).toFixed(1);
    onProgress(total ? `下载 PDF ${mb(got)} / ${mb(total)} MB` : `下载 PDF ${mb(got)} MB`);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out.buffer;
}

async function downloadPdf(url: string, signal?: AbortSignal, onProgress?: Progress): Promise<{ buf: ArrayBuffer; fileName: string }> {
  onProgress?.('连接中…');
  const res = await proxyGet(url, signal);
  const buf = await readWithProgress(res, onProgress);
  const head = new Uint8Array(buf.slice(0, 5));
  if (String.fromCharCode(...head) !== '%PDF-') {
    throw new NetError('该链接返回的不是 PDF（可能是网页、登录页或需要订阅）。可以手动下载 PDF 后再附加到条目上。');
  }
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(cd)?.[1];
  return { buf, fileName: decodeURIComponent(name ?? url.split('/').pop()?.split('?')[0] ?? 'paper') + (/\.pdf$/i.test(name ?? url) ? '' : '.pdf') };
}

/**
 * Import from a DOI, arXiv id/URL or direct PDF link. DOIs without an accessible
 * PDF become metadata-only entries (PDF can be attached later).
 */
export async function importFromIdentifier(
  input: string,
  opts: { collectionId?: string; signal?: AbortSignal; onProgress?: Progress } = {},
): Promise<ImportResult & { note?: string }> {
  const say = opts.onProgress;
  const id = parseIdentifierInput(input);
  if (!id) throw new Error('无法识别：请输入 DOI（10.xxxx/...）、arXiv 编号或链接、或 PDF 网址。');
  if (id.kind === 'arxiv') {
    say?.('查询 arXiv…');
    const meta = await lookupArxiv(id.value, opts.signal);
    if (!meta) throw new Error(`arXiv 上找不到 ${id.value}`);
    const dup = await findDuplicate(meta);
    if (dup?.hasPdf) return { docId: dup.id, duplicate: true, title: dup.title };
    const { buf, fileName } = await downloadPdf(id.pdfUrl!, opts.signal, say);
    say?.('解析 PDF…');
    return importPdfBytes(buf, fileName, { meta, metaSource: 'arxiv', collectionId: opts.collectionId });
  }
  if (id.kind === 'doi') {
    say?.('查询 Crossref…');
    const { meta, pdfLinks } = await lookupDoi(id.value, opts.signal);
    if (!meta) throw new Error(`Crossref 上找不到 DOI ${id.value}`);
    const dup = await findDuplicate(meta);
    if (dup?.hasPdf) return { docId: dup.id, duplicate: true, title: dup.title };
    // arXiv version is the most reliable open PDF
    const pdfUrls = [...(meta.arxivId ? [`https://arxiv.org/pdf/${meta.arxivId}`] : []), ...pdfLinks];
    for (const u of pdfUrls) {
      try {
        const { buf, fileName } = await downloadPdf(u, opts.signal, say);
        say?.('解析 PDF…');
        return importPdfBytes(buf, fileName, { meta, metaSource: 'crossref', collectionId: opts.collectionId });
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
      }
    }
    if (dup) return { docId: dup.id, duplicate: true, title: dup.title };
    const doc = newDoc(meta, 'crossref', { collectionIds: opts.collectionId ? [opts.collectionId] : [] });
    await db.docs.add(doc);
    return { docId: doc.id, duplicate: false, title: doc.title, note: '没有找到可直接下载的 PDF，已创建题录条目，可稍后手动附加 PDF。' };
  }
  const { buf, fileName } = await downloadPdf(id.value, opts.signal, say);
  say?.('解析 PDF…');
  return importPdfBytes(buf, fileName, { collectionId: opts.collectionId });
}

/** Try to fetch a PDF for a metadata-only entry (arXiv / Crossref links). */
export async function fetchPdfForDoc(docId: string, signal?: AbortSignal, onProgress?: Progress): Promise<boolean> {
  const doc = await db.docs.get(docId);
  if (!doc || doc.hasPdf) return false;
  const urls: string[] = [];
  if (doc.meta.arxivId) urls.push(`https://arxiv.org/pdf/${doc.meta.arxivId}`);
  if (doc.meta.doi) {
    try {
      urls.push(...(await lookupDoi(doc.meta.doi, signal)).pdfLinks);
    } catch {
      /* ignore */
    }
  }
  if (doc.meta.url && /\.pdf($|\?)/i.test(doc.meta.url)) urls.push(doc.meta.url);
  for (const u of urls) {
    try {
      const { buf, fileName } = await downloadPdf(u, signal, onProgress);
      await attachBytes(doc, buf, fileName);
      return true;
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
    }
  }
  return false;
}

export async function importBibTeXText(text: string, collectionId?: string): Promise<{ added: number; skipped: number }> {
  const entries = parseBibTeX(text);
  let added = 0;
  let skipped = 0;
  for (const e of entries) {
    if (await findDuplicate(e.meta)) {
      skipped++;
      continue;
    }
    await db.docs.add(newDoc(e.meta, 'bibtex', { collectionIds: collectionId ? [collectionId] : [] }));
    added++;
  }
  return { added, skipped };
}

// ---------------------------------------------------------------- edits

export async function updateMeta(docId: string, meta: PaperMeta) {
  await db.docs.update(docId, { meta, title: meta.title || '未命名文献', metaSource: 'manual', updatedAt: Date.now() });
}

export async function patchDocs(ids: string[], patch: (d: DocRecord) => Partial<DocRecord>) {
  await db.transaction('rw', db.docs, async () => {
    for (const id of ids) {
      const d = await db.docs.get(id);
      if (d) await db.docs.update(id, { ...patch(d), updatedAt: Date.now() });
    }
  });
}

export const setStatus = (ids: string[], status: ReadStatus) => patchDocs(ids, () => ({ status }));
export const setStarred = (ids: string[], starred: boolean) => patchDocs(ids, () => ({ starred }));
export const addTags = (ids: string[], tags: string[]) =>
  patchDocs(ids, (d) => ({ tags: [...new Set([...d.tags, ...tags.map((t) => t.trim()).filter(Boolean)])] }));
export const removeTag = (ids: string[], tag: string) => patchDocs(ids, (d) => ({ tags: d.tags.filter((t) => t !== tag) }));
export const addToCollection = (ids: string[], cid: string) =>
  patchDocs(ids, (d) => ({ collectionIds: d.collectionIds.includes(cid) ? d.collectionIds : [...d.collectionIds, cid] }));
export const removeFromCollection = (ids: string[], cid: string) =>
  patchDocs(ids, (d) => ({ collectionIds: d.collectionIds.filter((c) => c !== cid) }));

export async function createCollection(name: string) {
  const last = await db.collections.orderBy('order').last();
  const c = { id: uid(), name: name.trim() || '新分组', order: (last?.order ?? 0) + 1, createdAt: Date.now() };
  await db.collections.add(c);
  return c;
}

export async function deleteCollection(id: string) {
  await db.transaction('rw', db.docs, db.collections, async () => {
    await db.collections.delete(id);
    await db.docs
      .where('collectionIds')
      .equals(id)
      .modify((d) => {
        d.collectionIds = d.collectionIds.filter((c) => c !== id);
      });
  });
}

export async function renameTag(from: string, to: string) {
  const name = to.trim();
  await db.docs
    .where('tags')
    .equals(from)
    .modify((d) => {
      d.tags = [...new Set(d.tags.map((t) => (t === from ? name : t)).filter(Boolean))];
    });
}

// ---------------------------------------------------------------- full-text index

const indexing = new Map<string, Promise<void>>();

/** Extract and store per-page text (reuses an open PDF if given). */
export function indexDocText(docId: string, openDoc?: PDFDocumentProxy): Promise<void> {
  let p = indexing.get(docId);
  if (p) return p;
  p = (async () => {
    const cur = await db.doctext.get(docId);
    if (cur?.version === DOCTEXT_VERSION) return;
    let pdf = openDoc;
    let task: ReturnType<typeof openPdf> | null = null;
    if (!pdf) {
      const blob = await db.blobs.get(docId);
      if (!blob) return;
      task = openPdf(await blob.blob.arrayBuffer());
      pdf = await task.promise;
    }
    try {
      const pages: string[] = [];
      for (let i = 0; i < pdf.numPages; i++) pages.push(await pageText(pdf, i).catch(() => ''));
      await db.doctext.put({ docId, pages, version: DOCTEXT_VERSION });
    } finally {
      void task?.destroy();
    }
  })().finally(() => indexing.delete(docId));
  indexing.set(docId, p);
  return p;
}

/** Index every PDF that has no text yet. */
export async function indexAll(onProgress?: (done: number, total: number) => void) {
  const docs = await db.docs.filter((d) => d.hasPdf).primaryKeys();
  const have = new Set((await db.doctext.toArray()).filter((t) => t.version === DOCTEXT_VERSION).map((t) => t.docId));
  const todo = docs.filter((id) => !have.has(id));
  for (let i = 0; i < todo.length; i++) {
    onProgress?.(i, todo.length);
    await indexDocText(todo[i]).catch((e) => console.warn('index failed', todo[i], e));
  }
  onProgress?.(todo.length, todo.length);
}

export interface TextHit {
  docId: string;
  page: number;
  snippet: string;
  /** offset of the match inside snippet */
  at: number;
  source: 'original' | 'translation' | 'note';
}

function snippetAround(text: string, idx: number, len: number): { snippet: string; at: number } {
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + len + 80);
  const pre = start > 0 ? '…' : '';
  return { snippet: pre + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : ''), at: pre.length + (idx - start) };
}

/** Case-insensitive search over PDF text, translations and notes. Max `limit` hits per doc. */
export async function searchFullText(query: string, limit = 3): Promise<Map<string, TextHit[]>> {
  const q = query.trim().toLowerCase();
  const out = new Map<string, TextHit[]>();
  if (q.length < 2) return out;
  const push = (h: TextHit) => {
    const arr = out.get(h.docId) ?? [];
    if (arr.length < limit) arr.push(h);
    out.set(h.docId, arr);
  };
  await db.doctext.each((t) => {
    t.pages.forEach((p, i) => {
      const idx = p.toLowerCase().indexOf(q);
      if (idx >= 0) push({ docId: t.docId, page: i, source: 'original', ...snippetAround(p, idx, q.length) });
    });
  });
  await db.translations.each((t) => {
    if (!t.docId) return;
    const idx = t.result.toLowerCase().indexOf(q);
    if (idx >= 0) push({ docId: t.docId, page: -1, source: 'translation', ...snippetAround(t.result, idx, q.length) });
  });
  await db.notes.each((n) => {
    const hay = `${n.quote}\n${n.comment}`;
    const idx = hay.toLowerCase().indexOf(q);
    if (idx >= 0) push({ docId: n.docId, page: n.pageIndex, source: 'note', ...snippetAround(hay, idx, q.length) });
  });
  return out;
}

/** Identifiers in the first page text (used by "re-detect" in the detail panel). */
export async function redetectIdentifiers(docId: string) {
  const t = await db.doctext.get(docId);
  if (!t) return {};
  return extractIdentifiers(t.pages.slice(0, 2).join('\n'));
}

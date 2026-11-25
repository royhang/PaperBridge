import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { db } from '../db/db';
import { extractParagraphs } from './paragraphs';
import type { Paragraph, RawTextItem } from './types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
export type { PDFDocumentProxy };

const ASSETS = `${import.meta.env.BASE_URL}pdfjs/`;
const CMAP_URL = `${ASSETS}cmaps/`;
const FONT_URL = `${ASSETS}standard_fonts/`;
const WASM_URL = `${ASSETS}wasm/`;

export type PDFLoadingTask = ReturnType<typeof pdfjs.getDocument>;

/**
 * Start loading a PDF. Callers own the returned task and must `destroy()` it
 * (also when loading fails or is abandoned) to release the worker.
 * Note: pdf.js transfers `data` to the worker, so pass a buffer you no longer need.
 */
export function openPdf(data: ArrayBuffer | Uint8Array, worker?: InstanceType<typeof pdfjs.PDFWorker>): PDFLoadingTask {
  return pdfjs.getDocument({
    data: data instanceof Uint8Array ? data : new Uint8Array(data),
    worker,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: FONT_URL,
    // translated pages draw latin text with the (non-embedded) standard 14 fonts: render them with pdf.js'
    // bundled font data everywhere instead of whatever system font happens to match "Times" (squashed glyphs)
    useSystemFonts: false,
    wasmUrl: WASM_URL,
  });
}

let shared: InstanceType<typeof pdfjs.PDFWorker> | null = null;
/** One worker shared by the many small per-page PDFs of the translated view. */
export function sharedWorker() {
  shared ??= new pdfjs.PDFWorker();
  return shared;
}

export async function readTitle(pdf: PDFDocumentProxy, fallback: string): Promise<string> {
  try {
    const meta = await pdf.getMetadata();
    const t = (meta.info as { Title?: string } | undefined)?.Title?.trim();
    if (t && t.length > 3 && !/^(untitled|microsoft word|title)/i.test(t)) return t;
  } catch {
    /* ignore */
  }
  return fallback.replace(/\.pdf$/i, '');
}

const inflight = new Map<string, Promise<Paragraph[]>>();

/** Bump when the extractor changes so cached paragraphs are recomputed. */
export const PARAGRAPH_VERSION = 3;

/** Paragraphs of one page, cached in IndexedDB. */
export function getPageParagraphs(pdf: PDFDocumentProxy, docId: string, pageIndex: number): Promise<Paragraph[]> {
  const key = `${docId}:${pageIndex}`;
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      const cached = await db.paragraphs.get(key);
      if (cached && cached.version === PARAGRAPH_VERSION) return cached.paragraphs;
      const page = await pdf.getPage(pageIndex + 1);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = tc.items.filter((i) => 'str' in i) as RawTextItem[];
      // Extract in unrotated PDF space (relative to the view box origin)…
      const [x0, y0, x1, y1] = page.view;
      const shifted =
        x0 || y0
          ? items.map((it) => ({ ...it, transform: [...it.transform.slice(0, 4), it.transform[4] - x0, it.transform[5] - y0] }))
          : items;
      const raw = extractParagraphs(shifted, { pageIndex, width: x1 - x0, height: y1 - y0 });
      // …then project boxes into the (possibly rotated) scale-1 viewport used by the UI.
      const paragraphs = raw.map((p) => {
        const { x, y, w, h } = p.bbox;
        const [ax, ay] = vp.convertToViewportPoint(x0 + x, y1 - y - h) as [number, number];
        const [bx, by] = vp.convertToViewportPoint(x0 + x + w, y1 - y) as [number, number];
        return { ...p, bbox: { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) } };
      });
      await db.paragraphs.put({ key, docId, pageIndex, paragraphs, version: PARAGRAPH_VERSION });
      return paragraphs;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/** Plain text of the whole document (for Q&A context), with page markers. */
export async function getDocumentText(pdf: PDFDocumentProxy, docId: string, maxChars = 120_000): Promise<string> {
  const parts: string[] = [];
  let total = 0;
  for (let i = 0; i < pdf.numPages && total < maxChars; i++) {
    const paras = await getPageParagraphs(pdf, docId, i);
    const text = paras
      .filter((p) => p.kind !== 'other')
      .map((p) => p.text)
      .join('\n');
    const chunk = `\n[p.${i + 1}]\n${text}`;
    parts.push(chunk);
    total += chunk.length;
  }
  const all = parts.join('');
  return all.length > maxChars ? all.slice(0, maxChars) + '\n…(truncated)' : all;
}

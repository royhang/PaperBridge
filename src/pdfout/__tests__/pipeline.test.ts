/// <reference types="node" />
// End-to-end check of buildTranslatedPdf on a real arXiv paper with a fake translator.
// Needs ~/.cache/pb-e2e/dl/attention.pdf and ~/.cache/pb-fonts/NotoSerifSC-Regular.ttf (skipped otherwise).
// Output is written to $PB_OUT (default: OS tmp dir) for visual inspection.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import { extractParagraphs } from '../../pdf/paragraphs';
import type { RawTextItem } from '../../pdf/types';

const PDF = process.env.PB_PDF ?? join(homedir(), '.cache/pb-e2e/dl/attention.pdf');
const FONT = join(homedir(), '.cache/pb-fonts/NotoSerifSC-Regular.ttf');
const OUT = process.env.PB_OUT ?? tmpdir();

vi.mock('../../pdf/loader', () => ({
  openPdf: (data: ArrayBuffer) => pdfjs.getDocument({ data: new Uint8Array(data) }),
  getPageParagraphs: async (pdf: pdfjs.PDFDocumentProxy, _docId: string, pageIndex: number) => {
    const page = await pdf.getPage(pageIndex + 1);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items.filter((i) => 'str' in i) as RawTextItem[];
    const [x0, , x1, y1] = page.view;
    return extractParagraphs(items, { pageIndex, width: x1 - x0, height: y1 - page.view[1] }).map((p) => {
      const { x, y, w, h } = p.bbox;
      const [ax, ay] = vp.convertToViewportPoint(x0 + x, y1 - y - h) as [number, number];
      const [bx, by] = vp.convertToViewportPoint(x0 + x + w, y1 - y) as [number, number];
      return { ...p, bbox: { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) } };
    });
  },
}));

/** Fake "translation": Chinese filler about 0.6× the source length, placeholders kept in place. */
const FILL = '注意力机制模型通过编码器与解码器实现序列转换我们提出的方法在翻译任务上取得了更好的结果并且训练时间大幅缩短';
function fake(t: string): string {
  return (
    t
      .split(/(\{v\d+\}|<\/?s\d+>|\d+(?:[.,]\d+)*)/)
      .map((part, i) => {
        if (i % 2) return part;
        const n = Math.max(0, Math.round(part.replace(/\s+/g, '').length * 0.6));
        let s = '';
        for (let k = 0; k < n; k++) s += FILL[k % FILL.length];
        return n > 12 ? `${s.slice(0, n >> 1)}，${s.slice(n >> 1)}` : s;
      })
      .join('') + '。'
  );
}
vi.mock('../../services/translate', () => ({
  translateBatch: async (texts: string[]) => texts.map(fake),
  translateText: async (text: string) => fake(text),
}));
vi.mock('../../store/settings', () => ({ getSettings: () => ({ batchSize: 8, concurrency: 2, targetLang: 'zh-CN' }) }));
vi.mock('../fonts', async () => {
  const { createSubsetter } = await import('../subset');
  const wasm = readFileSync(join(process.cwd(), 'node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm'));
  return { getCjkSubsetter: async () => createSubsetter(new Uint8Array(readFileSync(FONT)), wasm) };
});

async function pageText(bytes: Uint8Array, pageNo: number) {
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const tc = await (await (await task.promise).getPage(pageNo)).getTextContent();
  const s = tc.items.map((i) => ('str' in i ? i.str : '')).join(' ');
  await task.destroy();
  return s;
}

describe.skipIf(!existsSync(PDF) || !existsSync(FONT))('translated PDF pipeline (attention.pdf)', () => {
  it('replaces body text, keeps title/figures, re-emits inline formulas', async () => {
    const { buildTranslatedPdf } = await import('../translatePdf');
    const src = readFileSync(PDF);
    const ab = src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength) as ArrayBuffer;
    const t0 = performance.now();
    const { bytes, stats, diagnostics } = await buildTranslatedPdf({ docId: 'd', title: 'Attention', bytes: ab, mode: 'mono', from: 0, to: 14 });
    const ms = performance.now() - t0;
    mkdirSync(OUT, { recursive: true });
    const file = join(OUT, 'attention-mono.pdf');
    writeFileSync(file, bytes);
    console.log(`→ ${file} (${(bytes.length / 1024).toFixed(0)} KB, ${ms.toFixed(0)} ms)`, stats);

    for (const b of diagnostics.flatMap((d) => d.blocks)) if (!['drawn', 'kept'].includes(b.status) && b.kind === 'body') console.log(b.id, b.status, b.reason, b.source.slice(0, 60));
    expect(stats.paragraphs).toBeGreaterThan(60);
    expect(stats.formulas).toBeGreaterThan(20);
    const p1 = await pageText(bytes, 1);
    if (PDF.endsWith('attention.pdf')) expect(p1).not.toContain('dominant sequence transduction');
    expect(p1).toMatch(/注意力机制/);
    // equations page: the display equation for scaled dot-product attention must survive
    if (PDF.endsWith('attention.pdf')) expect(await pageText(bytes, 4)).toMatch(/softmax/);

    const dual = await buildTranslatedPdf({ docId: 'd', title: 'Attention', bytes: ab, mode: 'dual', from: 0, to: 1 });
    writeFileSync(join(OUT, 'attention-dual.pdf'), dual.bytes);
    expect(dual.bytes.length).toBeGreaterThan(bytes.length * 0.5);
    if (PDF.endsWith('attention.pdf')) {
      expect(await pageText(dual.bytes, 1)).toContain('dominant sequence transduction');
      expect(await pageText(dual.bytes, 2)).not.toContain('dominant sequence transduction');
    }

    const side = await buildTranslatedPdf({ docId: 'd', title: 'Attention', bytes: ab, mode: 'side', from: 0, to: 0 });
    writeFileSync(join(OUT, 'attention-side.pdf'), side.bytes);
    const { PDFDocument } = await import('pdf-lib');
    const sd = await PDFDocument.load(side.bytes);
    const src0 = (await PDFDocument.load(src)).getPage(0);
    expect(sd.getPageCount()).toBe((await PDFDocument.load(src)).getPageCount());
    expect(sd.getPage(0).getWidth()).toBeCloseTo(src0.getWidth() * 2, 0);
    expect(sd.getPage(1).getWidth()).toBeCloseTo(src0.getWidth(), 0);
    // fonts must be finalized before pages are copied/embedded (pdf-lib embeds lazily)
    expect(await pageText(side.bytes, 1)).toMatch(/注意力机制/);
    expect(await pageText(dual.bytes, 2)).toMatch(/注意力机制/);
  }, 120_000);
});

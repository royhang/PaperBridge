// Dev helper: PDF=/path/to.pdf pnpm vitest run scripts/dump-paragraphs.test.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractParagraphs, isTranslatable } from '../src/pdf/paragraphs';
import type { RawTextItem } from '../src/pdf/types';

test.skipIf(!process.env.PDF)('dump paragraphs', async () => {
  const data = new Uint8Array(readFileSync(process.env.PDF!));
  const pdf = await pdfjs.getDocument({ data }).promise;
  const out: string[] = [];
  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items.filter((it) => 'str' in it) as RawTextItem[];
    const paras = extractParagraphs(items, { pageIndex: i, width: vp.width, height: vp.height });
    out.push(`\n===== page ${i + 1} =====`);
    for (const p of paras) out.push(`[${p.order}|${p.kind}${isTranslatable(p) ? '' : '|skip'}] (${p.bbox.x.toFixed(0)},${p.bbox.y.toFixed(0)}) ${p.text.slice(0, 140)}`);
  }
  writeFileSync(process.env.OUT ?? '/tmp/paragraphs-dump.txt', out.join('\n'));
}, 60000);

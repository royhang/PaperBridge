/// <reference types="node" />
// Title guessed from the first page of each PDF: DIR=… pnpm vitest run scripts/dev/titles.test.ts --silent=false
import { readdirSync, readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { test } from 'vitest';
import { guessMetaFromPdf, titleFromLayout, type TextRun } from '../../src/library/meta';
test.skipIf(!process.env.DIR)('titles', async () => {
  for (const f of readdirSync(process.env.DIR!).filter((n) => n.endsWith('.pdf'))) {
    const pdf = await getDocument({ data: new Uint8Array(readFileSync(`${process.env.DIR}/${f}`)) }).promise;
    const page = await pdf.getPage(1);
    const tc = await page.getTextContent();
    const runs: TextRun[] = [];
    let text = '';
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      text += it.str + (it.hasEOL ? '\n' : ' ');
      const [a, b, , , e, y] = it.transform as number[];
      if (it.str.trim() && Math.abs(b) < 1e-3 * Math.abs(a) && a > 0) runs.push({ str: it.str, x: e, y: y - page.view[1], width: it.width, size: Math.hypot(a, b) });
    }
    const layout = titleFromLayout(runs, page.view[3] - page.view[1]);
    const info = (await pdf.getMetadata()).info as { Title?: string };
    const before = guessMetaFromPdf(info, text, f).title;
    const after = guessMetaFromPdf(info, text, f, layout).title;
    console.log(`${f.padEnd(16)} ${before === after ? '=' : '≠'} ${JSON.stringify(after)}${before === after ? '' : `\n${''.padEnd(18)}was ${JSON.stringify(before)}`}`);
  }
}, 120000);

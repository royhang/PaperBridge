/// <reference types="node" />
// Show how paragraphs are joined across columns / pages: PDF=… [TO=7] pnpm vitest run scripts/dev/links.test.ts --silent=false
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { test } from 'vitest';
import { planPages } from '../../src/pdfout/translatePdf';
import { stripMarkup } from '../../src/pdfout/typeset';
test.skipIf(!process.env.PDF)('links', async () => {
  const doc = await PDFDocument.load(readFileSync(process.env.PDF!));
  const last = Math.min(doc.getPageCount(), Number(process.env.TO ?? 99)) - 1;
  const plans = planPages(doc, 0, last);
  const tail = (s: string) => stripMarkup(s).slice(-50);
  const head = (s: string) => stripMarkup(s).slice(0, 50);
  for (const plan of plans) {
    for (const it of plan.items) if (it.cont) console.log(`p${plan.pageIndex + 1} ${it.cont.crossPage ? 'PAGE  ' : 'COLUMN'} …${JSON.stringify(tail(it.job.source))} ⟶ ${JSON.stringify(head(it.cont.job.source))}…`);
    // page ends without a link: last body paragraph unfinished
    const flow = plan.items.filter((it) => it.block.region === 'text' && it.block.kind === 'body');
    const end = flow.at(-1);
    if (end && !end.cont && !/[.!?:;)\]"”]$/.test(stripMarkup(end.job.source).replace(/\{v\d+\}/g, '').trim())) console.log(`p${plan.pageIndex + 1} UNLINKED end …${JSON.stringify(tail(end.job.source))}`);
  }
});

/// <reference types="node" />
// PDF=… PAGES=5,6 OUT=dir pnpm vitest run scripts/dev/layout.test.ts --silent=false
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { test } from 'vitest';
import { readPageText } from '../../src/pdfout/engine';
import { analyzePage, describeLayout } from '../../src/pdfout/layout';
import { annotate, KIND_COLOR } from './annotate';

test.skipIf(!process.env.PDF)('layout', async () => {
  const bytes = new Uint8Array(readFileSync(process.env.PDF!));
  const doc = await PDFDocument.load(bytes);
  const out = process.env.OUT ?? '/tmp/layout';
  mkdirSync(out, { recursive: true });
  const pages = process.env.PAGES ? process.env.PAGES.split(',').map(Number) : [...Array(doc.getPageCount()).keys()].map((i) => i + 1);
  let refs = false;
  for (const p of pages) {
    const layout = analyzePage(readPageText(doc, p - 1), { pageIndex: p - 1, inReferences: refs });
    refs = layout.blocks.some((b) => b.kind === 'reference');
    const d = describeLayout(layout);
    writeFileSync(`${out}/layout-p${p}.json`, JSON.stringify(d, null, 1));
    if (process.env.PRINT) for (const b of d.blocks) console.log(`p${p} ${b.id.padEnd(16)} ${b.translate ? 'T' : '-'} ${b.align.padEnd(7)} ${b.size}pt ${b.box.join(',')} ${b.reason ?? ''} | ${b.text.slice(0, 90)}`);
    await annotate(bytes, p, [
      ...d.regions.map((r) => ({ box: r.box, color: KIND_COLOR[r.kind], dash: true, width: 2, label: `${r.kind} ${r.source}` })),
      ...d.blocks.map((b) => ({ box: b.box, color: KIND_COLOR[b.kind], label: `${b.id.split('-')[1]}${b.translate ? '' : '×'}` })),
    ], `${out}/layout-p${p}.png`);
  }
}, 120_000);

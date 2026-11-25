/// <reference types="node" />
// PDF=… PAGE=1 pnpm vitest run scripts/dev/fonts.test.ts --silent=false — font names / sizes / colours of a page's text ops
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { test } from 'vitest';
import { readPageText } from '../../src/pdfout/engine';

test.skipIf(!process.env.PDF)('fonts', async () => {
  const doc = await PDFDocument.load(readFileSync(process.env.PDF!));
  const m = readPageText(doc, Number(process.env.PAGE ?? 1) - 1);
  const seen = new Map<string, string>();
  for (const o of m.ops) {
    const k = `${o.baseFont} ${o.size.toFixed(1)} ${o.state.fill.join(',')} Tr${o.state.Tr}`;
    if (!seen.has(k)) seen.set(k, o.text.slice(0, 40));
  }
  for (const [k, v] of seen) console.log(k, '|', v);
});

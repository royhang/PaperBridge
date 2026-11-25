/// <reference types="node" />
// PDF=… pnpm vitest run scripts/dev/hidden.test.ts --silent=false — text ops the engine marks as clipped (hidden), per page
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { test } from 'vitest';
import { readPageText } from '../../src/pdfout/engine';

test.skipIf(!process.env.PDF)('hidden', async () => {
  const doc = await PDFDocument.load(readFileSync(process.env.PDF!));
  for (let i = 0; i < doc.getPageCount(); i++) {
    const h = readPageText(doc, i).ops.filter((o) => o.hidden);
    if (h.length) console.log(`p${i + 1}`, h.length, JSON.stringify(h.slice(0, 12).map((o) => `${o.text.trim().slice(0, 18)}@${o.x.toFixed(0)},${o.y.toFixed(0)}`)));
  }
});

/// <reference types="node" />
// Raw text lines of a page region: PDF=… PAGE=1 BOX=x0,y0,x1,y1 pnpm vitest run scripts/dev/lines.test.ts --silent=false
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { test } from 'vitest';
import { readPageText } from '../../src/pdfout/engine';
import { buildLines } from '../../src/pdfout/layout';
test.skipIf(!process.env.PDF)('lines', async () => {
  const doc = await PDFDocument.load(readFileSync(process.env.PDF!));
  const m = readPageText(doc, Number(process.env.PAGE ?? 1) - 1);
  const [x0, y0, x1, y1] = (process.env.BOX ?? '0,0,9999,9999').split(',').map(Number);
  const ops = m.ops.filter((o) => !o.rotated && !o.hidden);
  for (const l of buildLines(ops, { gap: 1.45, minGap: 10, weak: 0.9 }))
    if (l.x1 > x0 && l.x0 < x1 && l.baseline > y0 && l.baseline < y1) console.log(l.baseline.toFixed(1), l.size.toFixed(1), "bold=" + l.bold, l.ops.map((o) => o.baseFont).join("/"), l.x0.toFixed(0), l.x1.toFixed(0), l.ops.map((o) => `${o.y.toFixed(1)}/${o.size}`).join(' '), JSON.stringify(l.text.slice(0, 50)), process.env.TAIL ? [...l.text.slice(-4)].map((c) => c.codePointAt(0).toString(16)).join(",") + " ops:" + l.ops.slice(-2).map((o) => JSON.stringify(o.text)).join("") : "");
});

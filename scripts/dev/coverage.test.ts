/// <reference types="node" />
// Figure text coverage: per figure region, vector labels (translated / kept) vs bitmap image area.
//   PDF=orig.pdf DIAG=diag.json pnpm vitest run scripts/dev/coverage.test.ts --silent=false
// Text inside bitmap images can't be located without OCR; it is reported as bitmap area.
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { test } from 'vitest';
import { readPageText } from '../../src/pdfout/engine';
import type { PageDiag } from '../../src/pdfout/translatePdf';

test.skipIf(!process.env.PDF || !process.env.DIAG)('figure coverage', async () => {
  const doc = await PDFDocument.load(readFileSync(process.env.PDF!));
  const diag = JSON.parse(readFileSync(process.env.DIAG!, 'utf8')) as PageDiag[];
  const rows: string[] = ['page | figure box | source | bitmap share | vector labels | translated | kept (reasons)'];
  for (const d of diag) {
    const model = readPageText(doc, d.pageIndex);
    for (const r of d.regions.filter((x) => x.kind === 'figure')) {
      const b = r.box;
      const area = (b.x1 - b.x0) * (b.y1 - b.y0);
      const inside = (x0: number, y0: number, x1: number, y1: number) => Math.max(0, Math.min(x1, b.x1) - Math.max(x0, b.x0)) * Math.max(0, Math.min(y1, b.y1) - Math.max(y0, b.y0));
      const bitmap = model.graphics.filter((g) => g.kind === 'image').reduce((a, g) => a + inside(g.x, g.y, g.x + g.w, g.y + g.h), 0);
      const labels = d.blocks.filter((x) => x.region === 'figure' && x.box.x0 >= b.x0 - 2 && x.box.x1 <= b.x1 + 2 && x.box.y0 >= b.y0 - 2 && x.box.y1 <= b.y1 + 2 && x.kind !== 'other');
      const drawn = labels.filter((x) => x.status === 'drawn');
      const kept = labels.filter((x) => x.status !== 'drawn');
      const reasons = [...new Set(kept.map((x) => `${x.status}${x.reason ? ': ' + x.reason.slice(0, 40) : ''}`))];
      rows.push(`p${d.pageIndex + 1} | ${[b.x0, b.y0, b.x1, b.y1].map((v) => v.toFixed(0)).join(',')} | ${r.source} | ${((bitmap / area) * 100).toFixed(0)}% | ${labels.length} | ${drawn.length} | ${kept.length}${reasons.length ? ' (' + reasons.join('; ') + ')' : ''}`);
    }
  }
  console.log(rows.join('\n'));
});

/// <reference types="node" />
// Print the plan of some pages: PDF=… PAGES=1,2 [MATCH=regex] pnpm vitest run scripts/dev/plan.test.ts --silent=false
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { test } from 'vitest';
import { planPage } from '../../src/pdfout/translatePdf';
test.skipIf(!process.env.PDF)('plan', async () => {
  const doc = await PDFDocument.load(readFileSync(process.env.PDF!));
  const re = new RegExp(process.env.MATCH ?? '.');
  for (const p of (process.env.PAGES ?? '1').split(',').map(Number)) {
    const plan = planPage(doc, p - 1, { inReferences: !!process.env.INREF });
    for (const it of plan.items) {
      if (!re.test(it.text)) continue;
      console.log(`p${p} ${it.block.id} ${it.block.kind} size=${it.block.size.toFixed(1)}/${it.job.size.toFixed(1)} align=${it.job.align} indent=${it.job.indent.toFixed(1)} box=${JSON.stringify(it.job.box)}`);
      console.log('   ', it.text.slice(0, 300));
      for (const l of it.block.lines) console.log("     line", l.baseline.toFixed(1), l.size.toFixed(1), JSON.stringify(l.text.slice(0, 60)), l.x0.toFixed(1), l.x1.toFixed(1), l.ops.map((o) => o.y.toFixed(1)).join(","));
      for (const f of it.job.formulas) console.log('     {v' + f.id + '}', f.ops.map((o) => `${o.text}@${o.size.toFixed(1)}/${o.y.toFixed(1)}`).join(' ').slice(0, 200));
    }
    for (const b of plan.kept) if (re.test(b.lines.map((l) => l.text).join(' '))) console.log(`p${p} KEPT ${b.id} ${b.kind} ${b.reason} | ${b.lines.map((l) => l.text).join(' ').slice(0, 100)}`);
  }
});

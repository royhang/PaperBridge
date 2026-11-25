/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { test } from 'vitest';
import { readPageText } from '../../src/pdfout/engine';
test.skipIf(!process.env.PDF)('ops', async () => {
  const doc = await PDFDocument.load(readFileSync(process.env.PDF!));
  for (const p of (process.env.PAGES ?? '1').split(',').map(Number)) {
    const m = readPageText(doc, p - 1);
    const fonts = new Map<string, number>();
    for (const o of m.ops) fonts.set(`${o.baseFont}@${o.size.toFixed(1)}`, (fonts.get(`${o.baseFont}@${o.size.toFixed(1)}`) ?? 0) + o.text.length);
    console.log(`=== p${p} fonts:`, [...fonts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
    console.log('graphics:', m.graphics.filter((g) => g.kind !== 'path' || Math.max(g.w, g.h) > 30).map((g) => `${g.kind}${g.path ?? ''}[${g.x.toFixed(0)},${g.y.toFixed(0)} ${g.w.toFixed(0)}x${g.h.toFixed(0)}]${g.straight === false ? '~' : ''}`).join(' '));
    if (process.env.VERBOSE) for (const o of m.ops.filter((o) => !o.owner)) console.log(o.index, o.x.toFixed(1), o.y.toFixed(1), o.width.toFixed(1), o.size.toFixed(1), o.baseFont, o.state.fill.map((c) => c.toFixed(1)).join(','), JSON.stringify(o.text.slice(0, 60)));
  }
});

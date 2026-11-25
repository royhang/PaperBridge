/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { test } from 'vitest';
import { readPageText, removeShowOps } from '../../src/pdfout/engine';
test('tj', async () => {
  const doc = await PDFDocument.load(readFileSync(process.env.HOME + '/.cache/pb-med/orig.pdf'));
  const m = readPageText(doc, 5);
  const t = m.ops.filter((o) => /BioMedClip/.test(o.text));
  console.log(t.map((o) => [o.id, o.text, o.raw.slice(0, 120)]));
  const whole = m.ops.filter((o) => o.opIndex === t[0].opIndex);
  console.log(whole.map((o) => [o.id, o.x.toFixed(2), o.text]));
  removeShowOps(doc, 5, new Set(t.map((o) => o.id)));
  const out = await doc.save();
  const d2 = await PDFDocument.load(out);
  const m2 = readPageText(d2, 5);
  console.log(m2.ops.filter((o) => o.opIndex === t[0].opIndex).map((o) => [o.id, o.x.toFixed(2), o.text, o.raw.slice(0, 80)]));
});

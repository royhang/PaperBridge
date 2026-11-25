/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName, PDFDict, PDFStream } from 'pdf-lib';
import { test } from 'vitest';
import { readPageText } from '../../src/pdfout/engine';
test.skipIf(!process.env.PDF)('forms', async () => {
  const doc = await PDFDocument.load(readFileSync(process.env.PDF!));
  for (let i = 0; i < doc.getPageCount(); i++) {
    const m = readPageText(doc, i);
    const xo = doc.getPage(i).node.Resources()?.lookup(PDFName.of('XObject'));
    const kinds: string[] = [];
    if (xo instanceof PDFDict) for (const [k, v] of xo.entries()) { const s = doc.context.lookup(v); if (s instanceof PDFStream) kinds.push(`${k.decodeText()}:${(s.dict.lookup(PDFName.of('Subtype')) as PDFName)?.decodeText()}`); }
    const form = m.ops.filter((o) => o.index < 0);
    console.log(`p${i + 1} ops=${m.ops.length} formOps=${form.length} rotated=${m.ops.filter((o) => o.rotated).length} xobjects=${kinds.join(' ')} sample=${JSON.stringify(form.slice(0, 4).map((o) => o.text))}`);
  }
});

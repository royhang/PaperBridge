/// <reference types="node" />
// PDF=… PAGE=1 [GREP=re] pnpm vitest run scripts/dev/stream.test.ts --silent=false — print a page's last content stream
import { readFileSync } from 'node:fs';
import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream } from 'pdf-lib';
import { test } from 'vitest';

test.skipIf(!process.env.PDF)('stream', async () => {
  const doc = await PDFDocument.load(readFileSync(process.env.PDF!));
  const page = doc.getPage(Number(process.env.PAGE ?? 1) - 1);
  const c = page.node.Contents();
  const refs = c instanceof PDFArray ? c.asArray() : [c!];
  const s = doc.context.lookup(refs[refs.length - 1]) as PDFRawStream;
  const text = new TextDecoder('latin1').decode(decodePDFRawStream(s).decode());
  const re = process.env.GREP ? new RegExp(process.env.GREP) : null;
  console.log(text.split('\n').filter((l) => !re || re.test(l)).slice(0, Number(process.env.N ?? 40)).join('\n'));
});

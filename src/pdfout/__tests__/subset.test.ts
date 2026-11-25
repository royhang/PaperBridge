/// <reference types="node" />
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { createSubsetter } from '../subset';

const FONT = join(homedir(), '.cache/pb-fonts/NotoSerifSC-Regular.ttf');
const WASM = readFileSync(join(process.cwd(), 'node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm'));

describe.skipIf(!existsSync(FONT))('HarfBuzz subsetting (needs ~/.cache/pb-fonts/NotoSerifSC-Regular.ttf)', () => {
  it('subsets a CJK font to a small file that keeps every requested glyph', async () => {
    const s = await createSubsetter(new Uint8Array(readFileSync(FONT)), WASM);
    const text = '注意力机制就是你所需要的一切。Transformer 模型 2017 年提出，BLEU 达到 28.4。';
    const t0 = performance.now();
    const sub = s.subset([...text].map((c) => c.codePointAt(0)!));
    const ms = performance.now() - t0;
    expect(sub.length).toBeLessThan(60_000);
    expect(ms).toBeLessThan(500);
    const f = fontkit.create(sub as unknown as Buffer) as unknown as { hasGlyphForCodePoint(cp: number): boolean };
    for (const ch of new Set(text)) expect(f.hasGlyphForCodePoint(ch.codePointAt(0)!), ch).toBe(true);

    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(sub, { subset: false });
    doc.addPage([400, 200]).drawText(text.slice(0, 20), { x: 20, y: 150, size: 14, font });
    const bytes = await doc.save();
    expect(bytes.length).toBeLessThan(80_000);
    writeFileSync(join(tmpdir(), 'pb-subset-test.pdf'), bytes);
    s.destroy();
  });

  it('keeps digits next to Han text unshaped (extractable, widths match)', async () => {
    const s = await createSubsetter(new Uint8Array(readFileSync(FONT)), WASM);
    const text = 'WMT 2014英德任务上 BLEU 分数 41.8这';
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(s.subset([...text].map((c) => c.codePointAt(0)!)), { subset: false });
    doc.addPage([400, 100]).drawText(text, { x: 10, y: 50, size: 12, font });
    const measured = font.widthOfTextAtSize(text, 12);
    const task = pdfjs.getDocument({ data: await doc.save() });
    const tc = await (await (await task.promise).getPage(1)).getTextContent();
    const items = tc.items.filter((i) => 'str' in i) as { str: string; width: number }[];
    expect(items.map((i) => i.str).join('')).toBe(text);
    expect(Math.abs(items.reduce((a, i) => a + i.width, 0) - measured)).toBeLessThan(0.5);
    await task.destroy();
    s.destroy();
  });
});

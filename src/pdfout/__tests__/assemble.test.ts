// @vitest-environment node
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { degrees, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib';
import type { PDFObject, PDFPage } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { expect, it } from 'vitest';
import { assembleInterleaved, assembleSideBySide } from '../assemble';

const name = PDFName.of;
const uri = 'https://example.org/a?x=1&y=2';
const standardFontDataUrl = resolve('node_modules/pdfjs-dist/standard_fonts') + sep;

async function withPdf<T>(bytes: Uint8Array, inspect: (pdf: PDFDocumentProxy) => Promise<T>): Promise<T> {
  const task = getDocument({ data: bytes.slice(), standardFontDataUrl });
  try {
    return await inspect(await task.promise);
  } finally {
    await task.destroy();
  }
}

function addAnnot(page: PDFPage, subtype: string, rect: number[], entries: Record<string, PDFObject> = {}): void {
  const { context } = page.doc;
  const annotation = context.obj({ Type: 'Annot', Subtype: subtype, P: page.ref, Rect: rect, ...entries });
  page.node.addAnnot(context.register(annotation));
}

async function syntheticPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const pages = [0, 1, 2].map((index) => {
    const page = doc.addPage();
    page.setMediaBox(-20, 10, 200, 160);
    page.setCropBox(-10, 20, 160, 135);
    page.drawText(`Original ${index}`, { x: 25, y: 95, size: 11 });
    return page;
  });
  const [first, middle, last] = pages;
  last.setRotation(degrees(90));

  const chapter = PDFHexString.fromText('chapter');
  const move = PDFString.of('move');
  const xyz = ctx.register(ctx.obj([first.ref, 'XYZ', 35, 100, null]));
  const fitR = ctx.obj([first.ref, 'FitR', 10, 30, 100, 120]);
  const tree = ctx.obj({ Kids: [
    ctx.register(ctx.obj({ Limits: [chapter, chapter], Names: [chapter, ctx.obj({ D: [last.ref, 'FitH', 120] })] })),
    ctx.register(ctx.obj({ Limits: [move, move], Names: [move, ctx.obj([middle.ref, 'XYZ', 45, null, 1])] })),
  ] });
  doc.catalog.set(name('Names'), ctx.obj({ Dests: ctx.register(tree) }));
  doc.catalog.set(name('Dests'), ctx.obj({ legacy: ctx.obj({ D: fitR }) }));

  const root = ctx.nextRef();
  const parent = ctx.nextRef();
  const named = ctx.nextRef();
  const action = ctx.nextRef();
  const sibling = ctx.nextRef();
  ctx.assign(root, ctx.obj({ Type: 'Outlines', First: parent, Last: sibling, Count: 2 }));
  ctx.assign(parent, ctx.obj({
    Title: PDFHexString.fromText('Parent'), Parent: root, Next: sibling,
    First: named, Last: action, Count: -2, Dest: xyz,
  }));
  ctx.assign(named, ctx.obj({ Title: PDFString.of('Chapter'), Parent: parent, Next: action, Dest: chapter }));
  ctx.assign(action, ctx.obj({ Title: PDFString.of('Action'), Parent: parent, Prev: named, A: { S: 'GoTo', D: move } }));
  ctx.assign(sibling, ctx.obj({ Title: PDFString.of('Legacy'), Parent: root, Prev: parent, Dest: name('legacy') }));
  doc.catalog.set(name('Outlines'), root);

  addAnnot(first, 'Link', [10, 30, 40, 44], { Dest: xyz });
  addAnnot(first, 'Link', [20, 50, 60, 64], { Dest: chapter });
  addAnnot(first, 'Link', [30, 70, 80, 84], {
    A: ctx.obj({ S: 'URI', URI: PDFString.of(uri) }),
    QuadPoints: ctx.obj([30, 84, 80, 84, 30, 70, 80, 70]),
  });
  addAnnot(middle, 'Link', [10, 30, 40, 44], { Dest: name('legacy') });
  addAnnot(middle, 'Text', [20, 50, 40, 70], { Contents: PDFString.of('A note on the standalone page') });
  addAnnot(last, 'Link', [10, 30, 40, 44], { A: ctx.obj({ S: 'GoTo', D: [last.ref, 'FitV', 55] }) });
  addAnnot(last, 'Text', [20, 50, 40, 70], { Contents: PDFString.of('A note on a selected page') });
  return doc.save();
}

type Destination = string | unknown[];

async function resolveDestination(pdf: PDFDocumentProxy, destination: Destination) {
  const explicit = typeof destination === 'string' ? await pdf.getDestination(destination) : destination;
  expect(explicit).toBeTruthy();
  const [ref, ...operands] = explicit!;
  const index = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0]);
  expect(index).toBeGreaterThanOrEqual(0);
  expect(index).toBeLessThan(pdf.numPages);
  return { index, operands };
}

interface Link {
  subtype: 'Link';
  url?: string;
  dest?: Destination;
  rect: number[];
  quadPoints?: number[];
}

async function pageLinks(pdf: PDFDocumentProxy, index: number): Promise<Link[]> {
  const page = await pdf.getPage(index + 1);
  return (await page.getAnnotations()).filter((annot) => annot.subtype === 'Link');
}

const assemblers = [
  { mode: 'interleaved', assemble: assembleInterleaved },
  { mode: 'side-by-side', assemble: assembleSideBySide },
] as const;

it.each(assemblers)('$mode preserves synthetic outlines, named destinations, link geometry, and text', async ({ mode, assemble }) => {
  const bytes = await syntheticPdf();
  const orig = await PDFDocument.load(bytes);
  const trans = await PDFDocument.load(bytes);
  for (const [index, page] of trans.getPages().entries()) {
    page.node.delete(PDFName.Contents);
    page.drawText(`Translated ${index}`, { x: 25, y: 95, size: 11 });
  }
  await trans.flush();
  const output = await assemble(trans, orig, new Set([0, 2]));
  const saved = await output.save();
  expect(saved.length).toBeLessThan(3 * bytes.length);
  const side = mode === 'side-by-side';
  const targets = side ? [0, 1, 2] : [1, 2, 4];
  const [first, middle, last] = targets;

  await withPdf(saved, async (pdf) => {
    expect(pdf.numPages).toBe(side ? 3 : 5);
    const outline = await pdf.getOutline();
    expect(outline.map((item) => item.title)).toEqual(['Parent', 'Legacy']);
    expect(outline[0].count).toBe(-2);
    expect(outline[0].items.map((item) => item.title)).toEqual(['Chapter', 'Action']);
    expect(outline[1].items).toHaveLength(0);

    const xyz = { index: first, operands: [{ name: 'XYZ' }, side ? 195 : 35, 100, null] };
    const chapter = { index: last, operands: [{ name: 'FitH' }, side ? 255 : 120] };
    const move = { index: middle, operands: [{ name: 'XYZ' }, 45, null, 1] };
    const legacy = { index: first, operands: [{ name: 'FitR' }, side ? 170 : 10, 30, side ? 260 : 100, 120] };
    const fitV = { index: last, operands: [{ name: 'FitV' }, 55] };
    expect(await resolveDestination(pdf, outline[0].dest!)).toEqual(xyz);
    expect(await resolveDestination(pdf, outline[0].items[0].dest)).toEqual(chapter);
    expect(await resolveDestination(pdf, outline[0].items[1].dest)).toEqual(move);
    expect(await resolveDestination(pdf, outline[1].dest!)).toEqual(legacy);
    expect(await resolveDestination(pdf, 'chapter')).toEqual(chapter);
    expect(await resolveDestination(pdf, 'move')).toEqual(move);
    expect(await resolveDestination(pdf, 'legacy')).toEqual(legacy);

    const expectedLinks = side ? [6, 1, 2] : [3, 3, 1, 1, 1];
    const expectedNotes = side ? [0, 1, 0] : [0, 0, 1, 1, 1];
    const expectedText = side
      ? [['Original 0', 'Translated 0'], ['Original 1'], ['Original 2', 'Translated 2']]
      : [['Original 0'], ['Translated 0'], ['Original 1'], ['Original 2'], ['Translated 2']];
    for (const [index, linkCount] of expectedLinks.entries()) {
      const page = await pdf.getPage(index + 1);
      const links = await pageLinks(pdf, index);
      expect(links).toHaveLength(linkCount);
      expect((await page.getAnnotations()).filter((annot) => annot.subtype === 'Text')).toHaveLength(expectedNotes[index]);
      const text = (await page.getTextContent()).items.filter((item) => 'str' in item && item.str.trim());
      expect(text.map((item) => 'str' in item && item.str)).toEqual(expectedText[index]);
      const twoUp = expectedText[index].length === 2;
      const rotated = index === last || (!side && index === 3);
      const viewport = page.getViewport({ scale: 1 });
      const width = rotated ? 135 : 160;
      expect(viewport.width).toBe(width * (twoUp ? 2 : 1));
      expect(viewport.height).toBe(rotated ? 160 : 135);
      if (twoUp && 'transform' in text[0] && 'transform' in text[1]) {
        const positions = text.map((item) => {
          if (!('transform' in item)) throw new Error('Expected positioned text');
          return viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        });
        expect(positions[1]).toEqual([positions[0][0] + width, positions[0][1]]);
      }

      if (index < (side ? 1 : 2)) {
        const rects = [[10, 30, 40, 44], [20, 50, 60, 64], [30, 70, 80, 84]];
        for (const [copy, left] of (side ? [0, 160] : [0]).entries()) {
          const [explicit, namedLink, uriLink] = links.slice(copy * 3);
          // links on original copies (interleaved page 0, side left half) stay among the originals
          const local = side ? copy === 0 : index === 0;
          expect(await resolveDestination(pdf, explicit.dest!)).toEqual(local ? { index: 0, operands: [{ name: 'XYZ' }, 35, 100, null] } : xyz);
          expect(await resolveDestination(pdf, namedLink.dest!)).toEqual(local ? { index: side ? 2 : 3, operands: [{ name: 'FitH' }, 120] } : chapter);
          expect(uriLink.url).toBe(uri);
          const shift = (coords: number[]) => coords.map((value, i) => value + (i % 2 === 0 ? left : 0));
          expect([explicit.rect, namedLink.rect, uriLink.rect]).toEqual(rects.map(shift));
          expect(Array.from(uriLink.quadPoints ?? [])).toEqual(shift([30, 84, 80, 84, 30, 70, 80, 70]));
        }
      } else {
        // untranslated pages and original copies link to original pages; translated copies to translations
        const localLegacy = { index: 0, operands: [{ name: 'FitR' }, 10, 30, 100, 120] };
        const want = index === middle ? [localLegacy] : side ? [fitV, fitV] : index === 3 ? [{ index: 3, operands: [{ name: 'FitV' }, 55] }] : [fitV];
        for (const [k, link] of links.entries()) expect(await resolveDestination(pdf, link.dest!)).toEqual(want[k]);
        expect(links.map((link) => link.rect)).toEqual(side && index === last
          ? [[10, 30, 40, 44], [10, 165, 40, 179]] : [[10, 30, 40, 44]]);
      }
    }
  });

  const reloaded = await PDFDocument.load(saved);
  const linkRefs = new Set<PDFRef>();
  for (const page of reloaded.getPages()) {
    for (const ref of page.node.Annots()?.asArray() ?? []) {
      const annotation = reloaded.context.lookup(ref, PDFDict);
      expect(annotation.get(name('P'))).toBe(page.ref);
      if (annotation.get(name('Subtype')) === name('Link') && ref instanceof PDFRef) {
        expect(linkRefs.has(ref)).toBe(false);
        linkRefs.add(ref);
      }
    }
  }
  expect(linkRefs.size).toBe(9);
});

interface OutlineItem {
  title: string;
  dest: Destination | null;
  items: OutlineItem[];
  count?: number;
}

function flatten(items: OutlineItem[]): OutlineItem[] {
  return items.flatMap((item) => [item, ...flatten(item.items)]);
}

async function outlineSummary(pdf: PDFDocumentProxy, mapIndex: (index: number) => number, items: OutlineItem[]): Promise<unknown[]> {
  return Promise.all(items.map(async ({ title, dest, items, count }) => ({
    title,
    count,
    target: mapIndex((await resolveDestination(pdf, dest!)).index),
    children: await outlineSummary(pdf, mapIndex, items),
  })));
}

async function linkTargets(pdf: PDFDocumentProxy, links: Link[], mapIndex: (index: number) => number) {
  return Promise.all(links.map(async (link) => {
    if (link.dest) return mapIndex((await resolveDestination(pdf, link.dest)).index);
    expect(link.url).toBeTruthy();
    return link.url;
  }));
}

const fixtures = [
  { label: 'medical', file: join(homedir(), '.cache', 'pb-med', 'orig.pdf'), outline: 13, internal: 142, external: 3 },
  { label: 'attention', file: join(homedir(), '.cache', 'pb-e2e', 'dl', 'attention.pdf'), outline: 22, internal: 95, external: 18 },
];

for (const fixture of fixtures) {
  it.skipIf(!existsSync(fixture.file))(`${fixture.label} preserves all outlines and links in both modes`, async () => {
    const bytes = new Uint8Array(await readFile(fixture.file));
    const orig = await PDFDocument.load(bytes);
    const path = await mkdtemp(join(tmpdir(), `pdfout-${fixture.label}-`));
    const identity = (index: number) => index;
    await withPdf(bytes, async (source) => {
      expect(source.numPages).toBe(15);
      const outline = await source.getOutline();
      expect(flatten(outline)).toHaveLength(fixture.outline);
      const links = await Promise.all(orig.getPageIndices().map((index) => pageLinks(source, index)));
      expect(links.flat().filter((link) => link.dest)).toHaveLength(fixture.internal);
      expect(links.flat().filter((link) => link.url)).toHaveLength(fixture.external);

      for (const { mode, assemble } of assemblers) {
        const trans = await PDFDocument.load(bytes);
        await trans.flush();
        const output = await assemble(trans, orig, new Set(orig.getPageIndices()));
        const saved = await output.save();
        expect(saved.length).toBeLessThan(bytes.length * 3);
        const file = join(path, `${mode}.pdf`);
        await writeFile(file, saved);
        console.info(`${file} (${(saved.length / bytes.length).toFixed(2)}x input)`);

        const interleaved = mode === 'interleaved';
        const mapIndex = interleaved ? (index: number) => 2 * index + 1 : identity;
        const expectedOutline = await outlineSummary(source, mapIndex, outline);
        await withPdf(saved, async (pdf) => {
          expect(pdf.numPages).toBe(interleaved ? 30 : 15);
          const actualOutline = await pdf.getOutline();
          expect(flatten(actualOutline)).toHaveLength(fixture.outline);
          expect(await outlineSummary(pdf, identity, actualOutline)).toEqual(expectedOutline);
          for (const [index, sourceLinks] of links.entries()) {
            const expected = await linkTargets(source, sourceLinks, mapIndex);
            if (interleaved) {
              // original copy → originals, translated copy → translations
              expect(await linkTargets(pdf, await pageLinks(pdf, 2 * index), identity)).toEqual(await linkTargets(source, sourceLinks, (i) => 2 * i));
              expect(await linkTargets(pdf, await pageLinks(pdf, 2 * index + 1), identity)).toEqual(expected);
            } else {
              expect(await linkTargets(pdf, await pageLinks(pdf, index), identity)).toEqual([...expected, ...expected]);
            }
          }
        });
      }
    });
  }, 60_000);
}

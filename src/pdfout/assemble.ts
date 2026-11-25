import {
  drawObject, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFString,
  PDFPageEmbedder, PDFPageLeaf, PDFPageTree, PDFRef, PDFStream,
  popGraphicsState, pushGraphicsState,
} from 'pdf-lib';
import type { PageBoundingBox, PDFContext, PDFObject, PDFPage } from 'pdf-lib';

type Offset = readonly [x: number, y: number];

interface PageMapping {
  page: PDFPage;
  target: PDFPage;
  offset: Offset;
}

const origin: Offset = [0, 0];
const name = PDFName.of;
const destKey = name('Dest');
const destsKey = name('Dests');
const namesKey = name('Names');
const actionDestKey = name('D');
const ownerKey = name('P');

// Offsets follow the operands of each destination, in PDF user space.
const destinationAxes = new Map<PDFObject, readonly (0 | 1)[]>([
  [name('XYZ'), [0, 1]],
  [name('FitH'), [1]],
  [name('FitBH'), [1]],
  [name('FitV'), [0]],
  [name('FitBV'), [0]],
  [name('FitR'), [0, 1, 0, 1]],
]);

class SourceCopy {
  private readonly refs = new Map<PDFRef, PDFRef>();
  private readonly pages = new Map<PDFObject, PageMapping>();
  private readonly mappings: PageMapping[];
  private readonly source: PDFContext;
  private readonly output: PDFContext;
  private readonly catalog: PDFDict;
  private named?: Map<string, PDFObject>;

  constructor(source: PDFDocument, output: PDFDocument, mappings: PageMapping[]) {
    this.source = source.context;
    this.output = output.context;
    this.catalog = source.catalog;
    this.mappings = mappings;
    source.getPages().forEach((page, index) => {
      this.pages.set(page.ref, mappings[index]);
      this.pages.set(page.node, mappings[index]);
    });
  }

  copy(value: PDFObject): PDFObject {
    const page = this.pages.get(value);
    if (page) return page.page.ref;

    if (value instanceof PDFRef) {
      const existing = this.refs.get(value);
      if (existing) return existing;
      const object = this.source.lookup(value);
      if (!object || object instanceof PDFPageTree || object instanceof PDFPageLeaf) return PDFNull;
      const ref = this.output.nextRef();
      this.refs.set(value, ref);
      this.output.assign(ref, this.copy(object));
      return ref;
    }
    if (value instanceof PDFPageTree || value instanceof PDFPageLeaf) return PDFNull;
    if (value instanceof PDFArray) return this.output.obj(value.asArray().map((entry) => this.copy(entry)));
    if (value instanceof PDFDict) return this.copyDictionary(value, PDFDict.withContext(this.output));
    if (value instanceof PDFStream) {
      const stream = value.clone(this.output);
      this.copyDictionary(value.dict, stream.dict);
      return stream;
    }
    return value.clone();
  }

  private copyDictionary(source: PDFDict, output: PDFDict, skip: readonly PDFName[] = []): PDFDict {
    const goTo = source.lookup(name('S')) === name('GoTo');
    for (const [key, value] of source.entries()) {
      if (skip.includes(key)) continue;
      const destination = key === destKey || (goTo && key === actionDestKey);
      output.set(key, destination ? this.copyDestination(value) : this.copy(value));
    }
    return output;
  }

  /** Named destinations of the source (name tree and legacy /Dests), by decoded name. */
  private namedDestinations(): Map<string, PDFObject> {
    if (this.named) return this.named;
    const map = new Map<string, PDFObject>();
    const walk = (node: PDFObject | undefined, depth = 0) => {
      const tree = node && this.source.lookup(node);
      if (!(tree instanceof PDFDict) || depth > 32) return;
      const names = tree.lookup(namesKey);
      if (names instanceof PDFArray) {
        for (let i = 0; i + 1 < names.size(); i += 2) {
          const key = keyOf(names.lookup(i));
          if (key !== undefined) map.set(key, names.get(i + 1));
        }
      }
      const kids = tree.lookup(name('Kids'));
      if (kids instanceof PDFArray) for (const kid of kids.asArray()) walk(kid, depth + 1);
    };
    const names = this.catalog.lookup(namesKey);
    if (names instanceof PDFDict) walk(names.get(destsKey));
    const legacy = this.catalog.lookup(destsKey);
    if (legacy instanceof PDFDict) for (const [key, value] of legacy.entries()) map.set(key.decodeText(), value);
    this.named = map;
    return map;
  }

  /** Explicit destination pointing at the copy of the target page in the same half / language as `mapping.page`. */
  private localDestination(value: PDFObject): PDFArray | undefined {
    let dest = this.source.lookup(value);
    const key = keyOf(dest);
    if (key !== undefined) dest = this.source.lookup(this.namedDestinations().get(key));
    if (dest instanceof PDFDict) dest = dest.lookup(actionDestKey);
    if (!(dest instanceof PDFArray)) return undefined;
    const resolved = dest.lookup(0);
    const target = resolved instanceof PDFNumber ? this.mappings[resolved.asNumber()] : this.pages.get(dest.get(0)) ?? (resolved && this.pages.get(resolved));
    if (!target) return undefined;
    const result = this.output.obj([target.page.ref]);
    for (let i = 1; i < dest.size(); i++) result.push(this.copy(dest.get(i)));
    return result;
  }

  private copyDestination(value: PDFObject): PDFObject {
    const array = this.source.lookup(value);
    if (!(array instanceof PDFArray)) return this.copy(value);
    const page = array.get(0);
    const resolvedPage = array.lookup(0);
    const target = resolvedPage instanceof PDFNumber
      ? this.mappings[resolvedPage.asNumber()]
      : this.pages.get(page) ?? (resolvedPage && this.pages.get(resolvedPage));

    // Construct the array with its final page reference before copying any operands.
    const result = this.output.obj([target?.target.ref ?? PDFNull]);
    const type = array.lookup(1);
    const axes = type && destinationAxes.get(type);
    for (let i = 1; i < array.size(); i++) {
      const axis = axes?.[i - 2];
      const delta = target && axis !== undefined ? target.offset[axis] : 0;
      result.push(this.shiftNumber(array.get(i), delta));
    }
    return result;
  }

  private shiftNumber(value: PDFObject, offset: number): PDFObject {
    const number = this.source.lookup(value);
    return offset && number instanceof PDFNumber ? PDFNumber.of(number.asNumber() + offset) : this.copy(value);
  }

  private copyNamedDestination(value: PDFObject): PDFObject {
    const object = this.source.lookup(value);
    if (!(object instanceof PDFDict)) return this.copyDestination(value);
    const result = this.copyDictionary(object, PDFDict.withContext(this.output), [actionDestKey]);
    const destination = object.get(actionDestKey);
    if (destination) result.set(actionDestKey, this.copyDestination(destination));
    return result;
  }

  private copyNameTree(tree: PDFDict): PDFDict {
    const kidsKey = name('Kids');
    const result = this.copyDictionary(tree, PDFDict.withContext(this.output), [kidsKey, namesKey]);
    const kids = tree.lookup(kidsKey);
    if (kids instanceof PDFArray) {
      const children = this.output.obj([]);
      for (const value of kids.asArray()) {
        const child = this.source.lookup(value);
        if (child instanceof PDFDict) children.push(this.output.register(this.copyNameTree(child)));
      }
      result.set(kidsKey, children);
    }
    const names = tree.lookup(namesKey);
    if (names instanceof PDFArray) {
      result.set(namesKey, this.output.obj(names.asArray().map((entry, index) =>
        index % 2 === 0 ? this.copy(entry) : this.copyNamedDestination(entry))));
    }
    return result;
  }

  copyNavigation(source: PDFDict, output: PDFDict): void {
    for (const key of [name('Outlines'), name('PageMode'), name('URI')]) {
      const value = source.get(key);
      if (value) output.set(key, this.copy(value));
    }
    const names = source.lookup(namesKey);
    const tree = names instanceof PDFDict ? names.lookup(destsKey) : undefined;
    if (tree instanceof PDFDict) {
      output.set(namesKey, this.output.obj({ Dests: this.output.register(this.copyNameTree(tree)) }));
    }
    const legacy = source.lookup(destsKey);
    if (legacy instanceof PDFDict) {
      const dests = PDFDict.withContext(this.output);
      for (const [key, value] of legacy.entries()) dests.set(key, this.copyNamedDestination(value));
      output.set(destsKey, dests);
    }
  }

  copyPage(source: PDFPage, output: PDFPage): void {
    this.copyDictionary(source.node, output.node, [PDFName.Parent, PDFName.Annots]);
    for (const entry of PDFPageLeaf.InheritableEntries) {
      const key = name(entry);
      const inherited = source.node.getInheritableAttribute(key);
      if (inherited) output.node.set(key, this.copy(inherited));
    }
  }

  /**
   * `local`: internal links jump to pages of the same copy as `output` (originals stay among
   * originals) instead of the shared page map's translated target.
   */
  copyAnnotations(source: PDFPage, output: PDFPage, kind: 'all' | 'links' | 'non-links', offset = origin, local = false): void {
    const annotations = source.node.Annots();
    if (!annotations) return;
    const result = output.node.Annots() ?? this.output.obj([]);
    for (const value of annotations.asArray()) {
      const annotation = this.source.lookup(value);
      if (!(annotation instanceof PDFDict)) continue;
      const link = annotation.lookup(name('Subtype')) === name('Link');
      if (kind === 'links' && !link || kind === 'non-links' && link) continue;

      // Each link has its own dictionary, including when the source link appears twice.
      const ref = link ? this.output.register(this.copy(annotation)) : this.copy(value);
      const copied = this.output.lookup(ref, PDFDict);
      if (annotation.has(ownerKey)) copied.set(ownerKey, output.ref);
      if (link && local) {
        const action = annotation.lookup(name('A'));
        const isGoTo = action instanceof PDFDict && action.lookup(name('S')) === name('GoTo');
        const dest = annotation.get(destKey) ?? (isGoTo ? action.get(actionDestKey) : undefined);
        const explicit = dest && this.localDestination(dest);
        if (explicit) {
          copied.delete(name('A'));
          copied.set(destKey, explicit);
        }
      }
      if (offset !== origin) {
        for (const key of [name('Rect'), name('QuadPoints')]) {
          const coords = annotation.lookup(key);
          if (coords instanceof PDFArray) {
            copied.set(key, this.output.obj(coords.asArray().map((coordinate, index) =>
              this.shiftNumber(coordinate, offset[index % 2]))));
          }
        }
      }
      result.push(ref);
    }
    if (result.size()) output.node.set(PDFName.Annots, result);
  }

  async drawPage(source: PDFPage, output: PDFPage, box: PageBoundingBox, offset: Offset): Promise<void> {
    const contents = source.node.Contents();
    if (!contents) return;

    // The embedder reads source streams directly and writes one Form using copied resources.
    const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => this.source.lookup(ref)) : [contents];
    const page = PDFPageLeaf.fromMapWithContext(new Map(), this.output, false);
    page.set(PDFName.Contents, this.output.obj(streams));
    const resources = source.node.getInheritableAttribute(PDFName.Resources);
    if (resources) page.set(PDFName.Resources, this.copy(resources));
    const embedder = await PDFPageEmbedder.for(page, box, [1, 0, 0, 1, ...offset]);
    const ref = await embedder.embedIntoContext(this.output);
    const groupKey = name('Group');
    const group = source.node.get(groupKey);
    if (group) this.output.lookup(ref, PDFStream).dict.set(groupKey, this.copy(group));

    const xObject = output.node.newXObject('Page', ref);
    output.pushOperators(pushGraphicsState(), drawObject(xObject), popGraphicsState());
  }
}

function keyOf(value: PDFObject | undefined): string | undefined {
  if (value instanceof PDFString || value instanceof PDFHexString || value instanceof PDFName) return value.decodeText();
  return undefined;
}

function pageBounds({ x, y, width, height }: ReturnType<PDFPage['getMediaBox']>): PageBoundingBox {
  return { left: x, bottom: y, right: x + width, top: y + height };
}

function sideBySideGeometry(page: PDFPage) {
  const media = pageBounds(page.getMediaBox());
  const crop = pageBounds(page.getCropBox());
  const intersection = {
    left: Math.max(media.left, crop.left), bottom: Math.max(media.bottom, crop.bottom),
    right: Math.min(media.right, crop.right), top: Math.min(media.top, crop.top),
  };
  const box = intersection.right > intersection.left && intersection.top > intersection.bottom ? intersection : media;
  const width = box.right - box.left;
  const height = box.top - box.bottom;

  // Preserve /Rotate. In user space, viewer-right can point along either axis.
  const rotation = (page.getRotation().angle % 360 + 360) % 360;
  let offset: Offset = [width, 0];
  if (rotation === 90) offset = [0, height];
  if (rotation === 180) offset = [-width, 0];
  if (rotation === 270) offset = [0, -height];
  return { media, box, offset };
}

function widenBox(box: PageBoundingBox, offset: Offset): [number, number, number, number] {
  const [x, y] = offset;
  return [
    box.left + (x < 0 ? box.left - box.right : 0),
    box.bottom + (y < 0 ? box.bottom - box.top : 0),
    box.right + (x > 0 ? box.right - box.left : 0),
    box.top + (y > 0 ? box.top - box.bottom : 0),
  ];
}

function setWideBox(page: PDFPage, key: PDFName, box: PageBoundingBox, offset: Offset): void {
  page.node.set(key, page.doc.context.obj(widenBox(box, offset)));
}

/** Insert each selected translation immediately after its original page. */
export async function assembleInterleaved(trans: PDFDocument, orig: PDFDocument, translated: Set<number>): Promise<PDFDocument> {
  await orig.flush();
  const output = await PDFDocument.create();
  const originalPages = orig.getPages();
  const translatedPages = trans.getPages();
  const mappings = originalPages.map((_, index): PageMapping => {
    const page = output.addPage();
    const target = translated.has(index) ? output.addPage() : page;
    return { page, target, offset: origin };
  });
  const originals = new SourceCopy(orig, output, mappings);
  const translations = new SourceCopy(trans, output, mappings.map((mapping) => ({ ...mapping, page: mapping.target })));

  for (const [index, { page, target }] of mappings.entries()) {
    const original = originalPages[index];
    originals.copyPage(original, page);
    originals.copyAnnotations(original, page, 'all', origin, true);
    if (target !== page) {
      const translation = translatedPages[index];
      translations.copyPage(translation, target);
      translations.copyAnnotations(translation, target, 'non-links');
      originals.copyAnnotations(original, target, 'links');
    }
  }
  originals.copyNavigation(orig.catalog, output.catalog);
  return output;
}

/** Show each selected translation to the right of its original on a wide page. */
export async function assembleSideBySide(trans: PDFDocument, orig: PDFDocument, translated: Set<number>): Promise<PDFDocument> {
  await orig.flush();
  const output = await PDFDocument.create();
  const originalPages = orig.getPages();
  const translatedPages = trans.getPages();
  const geometry = originalPages.map((page, index) => translated.has(index) ? sideBySideGeometry(page) : undefined);
  const mappings = originalPages.map((_, index): PageMapping => {
    const page = output.addPage();
    return { page, target: page, offset: geometry[index]?.offset ?? origin };
  });
  const originals = new SourceCopy(orig, output, mappings);
  const translations = new SourceCopy(trans, output, mappings);

  for (const [index, { page, offset }] of mappings.entries()) {
    const original = originalPages[index];
    const wide = geometry[index];
    if (!wide) {
      originals.copyPage(original, page);
      originals.copyAnnotations(original, page, 'all', origin, true);
      continue;
    }
    setWideBox(page, PDFName.MediaBox, wide.media, offset);
    setWideBox(page, PDFName.CropBox, wide.box, offset);
    page.setRotation(original.getRotation());
    const unitKey = name('UserUnit');
    const unit = original.node.get(unitKey);
    if (unit) page.node.set(unitKey, originals.copy(unit));
    await originals.drawPage(original, page, wide.box, origin);
    await translations.drawPage(translatedPages[index], page, wide.box, offset);
    originals.copyAnnotations(original, page, 'links', origin, true);
    originals.copyAnnotations(original, page, 'links', offset);
  }
  originals.copyNavigation(orig.catalog, output.catalog);
  return output;
}

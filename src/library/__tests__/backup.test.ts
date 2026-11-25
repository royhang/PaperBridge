import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, uid, type DocRecord } from '../../db/db';
import { exportLibrary, importLibrary } from '../backup';
import { addTags, addToCollection, createCollection, deleteCollection, findDuplicate, importBibTeXText } from '../service';

function doc(over: Partial<DocRecord> = {}): DocRecord {
  const id = uid();
  return {
    id,
    title: 'Attention Is All You Need',
    fileName: 'a.pdf',
    size: 4,
    pageCount: 1,
    addedAt: 1,
    lastOpenedAt: 0,
    lastPage: 0,
    hash: 'h-' + id,
    meta: { title: 'Attention Is All You Need', authors: [{ family: 'Vaswani', given: 'Ashish' }], year: 2017, type: 'conference', arxivId: '1706.03762' },
    metaSource: 'manual',
    tags: [],
    collectionIds: [],
    starred: false,
    status: 'unread',
    hasPdf: true,
    updatedAt: 1,
    ...over,
  };
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('library service', () => {
  it('tags, collections and collection deletion', async () => {
    const d = doc();
    await db.docs.add(d);
    const c = await createCollection('Transformers');
    await addToCollection([d.id], c.id);
    await addTags([d.id], ['NLP', ' attention ', 'NLP']);
    let got = await db.docs.get(d.id);
    expect(got?.collectionIds).toEqual([c.id]);
    expect(got?.tags).toEqual(['NLP', 'attention']);
    await deleteCollection(c.id);
    got = await db.docs.get(d.id);
    expect(got?.collectionIds).toEqual([]);
    expect(await db.collections.count()).toBe(0);
  });

  it('finds duplicates by arXiv id (ignoring version), DOI and title', async () => {
    const d = doc({ meta: { ...doc().meta, doi: '10.5555/ABC' } });
    await db.docs.add(d);
    expect((await findDuplicate({ arxivId: '1706.03762v7' }))?.id).toBe(d.id);
    expect((await findDuplicate({ doi: '10.5555/abc' }))?.id).toBe(d.id);
    expect((await findDuplicate({ title: 'Attention is all you need!' }))?.id).toBe(d.id);
    expect(await findDuplicate({ title: 'Something completely different here' })).toBeUndefined();
  });

  it('imports BibTeX as metadata-only entries and skips duplicates', async () => {
    await db.docs.add(doc());
    const bib = `@inproceedings{vaswani2017,
  title={Attention Is All You Need}, author={Vaswani, Ashish and Shazeer, Noam}, year={2017}, eprint={1706.03762}}
@article{devlin2019, title={{BERT}: Pre-training of Deep Bidirectional Transformers}, author={Devlin, Jacob}, journal={NAACL}, year={2019}}`;
    const r = await importBibTeXText(bib);
    expect(r).toEqual({ added: 1, skipped: 1 });
    const bert = await db.docs.filter((d) => d.title.includes('BERT')).first();
    expect(bert?.hasPdf).toBe(false);
    expect(bert?.metaSource).toBe('bibtex');
  });
});

describe('whole-library backup', () => {
  it('round-trips docs, PDFs, notes, collections and merges without duplicates', async () => {
    const d = doc();
    await db.docs.add(d);
    await db.blobs.add({ id: d.id, blob: new Blob([new Uint8Array([37, 80, 68, 70, 45, 49])], { type: 'application/pdf' }) });
    const c = await createCollection('Reading group');
    await addToCollection([d.id], c.id);
    await db.notes.add({ id: 'n1', docId: d.id, pageIndex: 0, rects: [], quote: 'q', color: 'yellow', comment: 'c', createdAt: 1 });
    await db.translations.add({ key: 'k1', docId: d.id, source: 's', result: '译', createdAt: 1 });

    const zip = await exportLibrary();
    expect(zip.size).toBeGreaterThan(100);

    await Promise.all(db.tables.map((t) => t.clear()));
    const r1 = await importLibrary(zip);
    expect(r1).toMatchObject({ docs: 1, skippedDocs: 0, notes: 1, translations: 1 });
    const back = await db.docs.get(d.id);
    expect(back?.collectionIds).toEqual([c.id]);
    const pdf = new Uint8Array(await (await db.blobs.get(d.id))!.blob.arrayBuffer());
    expect(String.fromCharCode(...pdf)).toBe('%PDF-1');

    // importing again merges: nothing duplicated
    const r2 = await importLibrary(zip);
    expect(r2).toMatchObject({ docs: 0, skippedDocs: 1, notes: 0, translations: 0 });
    expect(await db.docs.count()).toBe(1);
  });

  it('rejects non-backup files', async () => {
    await expect(importLibrary(new Blob(['hello']))).rejects.toThrow();
  });
});

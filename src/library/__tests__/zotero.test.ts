import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, type Collection, type DocRecord } from '../../db/db';
import {
  createCollection,
  deleteCollection,
  deleteCollectionAndDocs,
  emptyTrash,
  findDuplicateGroups,
  flattenCollectionTree,
  getDescendantCollectionIds,
  moveCollection,
  restoreDocs,
  trashDocs,
} from '../service';

function makeDoc(id: string, overrides: Partial<DocRecord> = {}): DocRecord {
  const now = Date.now();
  return {
    id,
    title: `Paper ${id}`,
    fileName: `${id}.pdf`,
    size: 1024,
    pageCount: 5,
    addedAt: now,
    lastOpenedAt: 0,
    lastPage: 0,
    hash: `hash-${id}`,
    meta: { title: `Paper ${id}`, authors: [], type: 'article' },
    metaSource: 'pdf',
    tags: [],
    collectionIds: [],
    starred: false,
    status: 'unread',
    hasPdf: true,
    updatedAt: now,
    ...overrides,
  };
}

describe('Zotero library organization (nested collections, trash, duplicates)', () => {
  beforeEach(async () => {
    await db.docs.clear();
    await db.collections.clear();
  });

  it('builds depth-first collection tree and computes recursive descendants safely', () => {
    const cols: Collection[] = [
      { id: 'c1', name: 'LLM', parentId: null, order: 1, createdAt: 1 },
      { id: 'c2', name: 'Agents', parentId: 'c1', order: 2, createdAt: 2 },
      { id: 'c3', name: 'Reflection', parentId: 'c2', order: 3, createdAt: 3 },
      { id: 'c4', name: 'Vision', parentId: null, order: 4, createdAt: 4 },
    ];
    const flat = flattenCollectionTree(cols);
    expect(flat.map((x) => [x.col.id, x.depth, x.hasChildren])).toEqual([
      ['c1', 0, true],
      ['c2', 1, true],
      ['c3', 2, false],
      ['c4', 0, false],
    ]);
    expect([...getDescendantCollectionIds(cols, 'c1')].sort()).toEqual(['c1', 'c2', 'c3']);
    expect([...getDescendantCollectionIds(cols, 'c2')].sort()).toEqual(['c2', 'c3']);
  });

  it('prevents cyclic moves and recursively removes child collections without deleting papers', async () => {
    const root = await createCollection('Root');
    const child = await createCollection('Child', root.id);
    const grand = await createCollection('Grand', child.id);

    // Attempting to move root under its own descendant must be ignored
    await moveCollection(root.id, grand.id);
    expect((await db.collections.get(root.id))?.parentId).toBeNull();

    // Assign a doc to grand, then delete root: collections vanish, doc survives with clean collectionIds
    await db.docs.add(makeDoc('d1', { collectionIds: [grand.id] }));
    await deleteCollection(root.id);
    expect(await db.collections.count()).toBe(0);
    expect((await db.docs.get('d1'))?.collectionIds).toEqual([]);
  });

  it('deleteCollectionAndDocs removes nested collections and moves their docs to trash without affecting siblings', async () => {
    const target = await createCollection('Target');
    const sub = await createCollection('Sub', target.id);
    const keep = await createCollection('Keep');

    await db.docs.bulkAdd([
      makeDoc('d1', { collectionIds: [target.id] }),
      makeDoc('d2', { collectionIds: [sub.id] }),
      makeDoc('d3', { collectionIds: [keep.id] }),
    ]);

    const trashed = await deleteCollectionAndDocs(target.id);
    expect(trashed).toBe(2);
    expect(await db.collections.get(target.id)).toBeUndefined();
    expect(await db.collections.get(sub.id)).toBeUndefined();
    expect(await db.collections.get(keep.id)).toBeDefined();
    expect((await db.docs.get('d1'))?.deletedAt).toBeTypeOf('number');
    expect((await db.docs.get('d2'))?.deletedAt).toBeTypeOf('number');
    expect((await db.docs.get('d2'))?.collectionIds).toEqual([]);
    expect((await db.docs.get('d3'))?.deletedAt).toBeUndefined();
    expect((await db.docs.get('d3'))?.collectionIds).toEqual([keep.id]);
  });

  it('soft-deletes to trash, restores, and empties trash cleanly', async () => {
    await db.docs.bulkAdd([makeDoc('d1'), makeDoc('d2')]);
    await trashDocs(['d1']);
    expect((await db.docs.get('d1'))?.deletedAt).toBeTypeOf('number');
    expect((await db.docs.get('d2'))?.deletedAt).toBeUndefined();

    await restoreDocs(['d1']);
    expect((await db.docs.get('d1'))?.deletedAt).toBeUndefined();

    await trashDocs(['d1']);
    const removed = await emptyTrash();
    expect(removed).toBe(1);
    expect(await db.docs.get('d1')).toBeUndefined();
    expect(await db.docs.get('d2')).toBeDefined();
  });

  it('groups duplicate active docs by DOI, bare arXiv id, or normalized title while ignoring trashed docs', () => {
    const d1 = makeDoc('1', { meta: { title: 'Attention Is All You Need', authors: [], type: 'article', arxivId: '1706.03762v1' } });
    const d2 = makeDoc('2', { meta: { title: 'Attention Is All You Need (NeurIPS)', authors: [], type: 'conference', arxivId: '1706.03762v7' } });
    const d3 = makeDoc('3', { meta: { title: 'Deep Residual Learning for Image Recognition', authors: [], type: 'conference', doi: '10.1109/CVPR.2016.90' } });
    const d4 = makeDoc('4', { meta: { title: 'ResNet', authors: [], type: 'conference', doi: '10.1109/cvpr.2016.90' } });
    const d5 = makeDoc('5', { meta: { title: 'Unique Paper Title That Has No Match', authors: [], type: 'article' } });
    const dTrashed = makeDoc('6', { deletedAt: Date.now(), meta: { title: 'Attention Is All You Need', authors: [], type: 'article', arxivId: '1706.03762v2' } });

    const groups = findDuplicateGroups([d1, d2, d3, d4, d5, dTrashed]);
    expect(groups).toHaveLength(2);
    const idGroups = groups.map((g) => g.map((d) => d.id).sort()).sort();
    expect(idGroups).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });
});

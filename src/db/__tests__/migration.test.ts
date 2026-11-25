import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { expect, it } from 'vitest';

it('upgrades a v1 library (docs without metadata fields) to v2', async () => {
  const old = new Dexie('paperbridge');
  old.version(1).stores({
    docs: 'id, hash, lastOpenedAt',
    blobs: 'id',
    translations: 'key, docId',
    paragraphs: 'key, docId',
    glossary: 'id, scope, source',
    notes: 'id, docId, [docId+pageIndex]',
    chats: 'id, docId, updatedAt',
  });
  await old.table('docs').bulkAdd([
    { id: 'a', title: 'Old paper', fileName: 'a.pdf', size: 1, pageCount: 3, addedAt: 5, lastOpenedAt: 6, lastPage: 2, hash: 'h1' },
    { id: 'b', title: 'Unread paper', fileName: 'b.pdf', size: 1, pageCount: 3, addedAt: 7, lastOpenedAt: 7, lastPage: 0, hash: 'h2' },
  ]);
  await old.table('notes').add({ id: 'n', docId: 'a', pageIndex: 0, rects: [], quote: 'q', color: 'yellow', comment: '', createdAt: 1 });
  old.close();

  const { db } = await import('../db');
  const a = await db.docs.get('a');
  expect(a).toMatchObject({
    meta: { title: 'Old paper', authors: [], type: 'other' },
    metaSource: 'pdf',
    tags: [],
    collectionIds: [],
    starred: false,
    status: 'reading',
    hasPdf: true,
    updatedAt: 5,
  });
  expect((await db.docs.get('b'))?.status).toBe('unread');
  // new indexes work on migrated rows
  expect(await db.docs.where('tags').equals('x').count()).toBe(0);
  expect(await db.notes.count()).toBe(1);
  expect(await db.collections.count()).toBe(0);
});

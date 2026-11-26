import Dexie, { type EntityTable } from 'dexie';
import type { Paragraph } from '../pdf/types';
import type { ChatMessage } from '../providers/types';
import type { MetaSource, PaperMeta } from '../library/types';

export type ReadStatus = 'unread' | 'reading' | 'done';

export interface DocRecord {
  id: string;
  title: string;
  fileName: string;
  size: number;
  pageCount: number;
  addedAt: number;
  lastOpenedAt: number;
  lastPage: number;
  /** sha-256 of file bytes — used to dedupe imports ('' when there is no PDF yet) */
  hash: string;
  /** Bibliographic metadata. `title` above is kept in sync with meta.title for display. */
  meta: PaperMeta;
  /** Where the metadata came from; enrichment never overwrites 'manual'. */
  metaSource: MetaSource;
  tags: string[];
  collectionIds: string[];
  starred: boolean;
  status: ReadStatus;
  /** false for metadata-only entries (e.g. imported from BibTeX / DOI without open-access PDF) */
  hasPdf: boolean;
  /** Soft-delete timestamp (ms). Present when the item is in Trash. */
  deletedAt?: number;
  updatedAt: number;
}

export interface Collection {
  id: string;
  name: string;
  /** Optional parent collection id for nested Zotero-style folders. */
  parentId?: string | null;
  order: number;
  createdAt: number;
  updatedAt?: number;
}

/** Plain text of each page, for library-wide full-text search. */
export interface DocText {
  docId: string;
  pages: string[];
  version: number;
}

export interface DocBlob {
  id: string;
  blob: Blob;
}

export interface TranslationRecord {
  /** hash(provider fingerprint + langs + glossary version + text) */
  key: string;
  docId?: string;
  source: string;
  result: string;
  createdAt: number;
}

export interface ParagraphCache {
  /** `${docId}:${pageIndex}` */
  key: string;
  docId: string;
  pageIndex: number;
  paragraphs: Paragraph[];
  /** Extractor version that produced this entry. */
  version?: number;
}

export interface GlossaryEntry {
  id: string;
  source: string;
  target: string;
  note?: string;
  /** 'global' or a docId */
  scope: string;
  createdAt: number;
}

/** Rects are normalized to the page box: 0..1 in both axes, origin top-left. */
export interface NRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple';

export interface NoteRecord {
  id: string;
  docId: string;
  pageIndex: number;
  rects: NRect[];
  quote: string;
  color: HighlightColor;
  comment: string;
  /** Cached translation of the quote, if the user translated it. */
  translation?: string;
  createdAt: number;
}

export interface ChatRecord {
  id: string;
  docId: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
}

/** Normalized point [x (0..1), y (0..1), pressure (0..1)] for Apple Pencil / stylus ink. */
export type InkPoint = [number, number, number];
export type InkKind = 'pen' | 'highlighter';
export type InkTarget = 'original' | 'translated';

export interface InkStroke {
  id: string;
  docId: string;
  pageIndex: number;
  /** Which page canvas the stroke belongs to (omitted = 'original' for backwards compatibility). */
  layer?: InkTarget;
  kind: InkKind;
  color: string;
  /** Stroke width in PDF page points at scale = 1 (scales cleanly with zoom). */
  width: number;
  points: InkPoint[];
  createdAt: number;
}

export class PaperDB extends Dexie {
  docs!: EntityTable<DocRecord, 'id'>;
  blobs!: EntityTable<DocBlob, 'id'>;
  translations!: EntityTable<TranslationRecord, 'key'>;
  paragraphs!: EntityTable<ParagraphCache, 'key'>;
  glossary!: EntityTable<GlossaryEntry, 'id'>;
  notes!: EntityTable<NoteRecord, 'id'>;
  inks!: EntityTable<InkStroke, 'id'>;
  chats!: EntityTable<ChatRecord, 'id'>;
  collections!: EntityTable<Collection, 'id'>;
  doctext!: EntityTable<DocText, 'docId'>;

  constructor() {
    super('paperbridge');
    this.version(1).stores({
      docs: 'id, hash, lastOpenedAt',
      blobs: 'id',
      translations: 'key, docId',
      paragraphs: 'key, docId',
      glossary: 'id, scope, source',
      notes: 'id, docId, [docId+pageIndex]',
      chats: 'id, docId, updatedAt',
    });
    this.version(2)
      .stores({
        docs: 'id, hash, lastOpenedAt, addedAt, *tags, *collectionIds, meta.doi, meta.arxivId',
        collections: 'id, order',
        doctext: 'docId',
      })
      .upgrade((tx) =>
        tx
          .table('docs')
          .toCollection()
          .modify((d: Partial<DocRecord> & { title: string; lastPage: number; addedAt: number }) => {
            d.meta ??= { title: d.title, authors: [], type: 'other' };
            d.metaSource ??= 'pdf';
            d.tags ??= [];
            d.collectionIds ??= [];
            d.starred ??= false;
            d.status ??= d.lastPage > 0 ? 'reading' : 'unread';
            d.hasPdf ??= true;
            d.updatedAt ??= d.addedAt;
          }),
      );
    this.version(3).stores({
      inks: 'id, docId, [docId+pageIndex]',
    });
  }
}

export const db = new PaperDB();

export const uid = () =>
  (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

export async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function deleteDocument(docId: string) {
  await db.transaction('rw', [db.docs, db.blobs, db.translations, db.paragraphs, db.notes, db.inks, db.chats, db.glossary, db.doctext], async () => {
    await db.doctext.delete(docId);
    await db.docs.delete(docId);
    await db.blobs.delete(docId);
    await db.translations.where('docId').equals(docId).delete();
    await db.paragraphs.where('docId').equals(docId).delete();
    await db.notes.where('docId').equals(docId).delete();
    await db.inks.where('docId').equals(docId).delete();
    await db.chats.where('docId').equals(docId).delete();
    await db.glossary.where('scope').equals(docId).delete();
  });
}

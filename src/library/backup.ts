import { Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough, strFromU8, strToU8 } from 'fflate';
import { db, type ChatRecord, type Collection, type DocRecord, type GlossaryEntry, type NoteRecord, type TranslationRecord } from '../db/db';

/**
 * Whole-library backup: a .zip with manifest.json (records) + pdf/<docId>.pdf.
 * API keys / settings are NOT included (use 设置 → 数据 → 导出设置 for those).
 */
interface Manifest {
  app: 'paperbridge';
  version: 1;
  exportedAt: number;
  docs: DocRecord[];
  collections: Collection[];
  notes: NoteRecord[];
  glossary: GlossaryEntry[];
  chats: ChatRecord[];
  translations: TranslationRecord[];
}

export async function exportLibrary(onProgress?: (msg: string) => void): Promise<Blob> {
  const parts: BlobPart[] = [];
  let fail: unknown = null;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const zip = new Zip((err, chunk, final) => {
    if (err) fail = err;
    // copy: fflate may reuse buffers
    parts.push(chunk.slice());
    if (final) resolveDone();
  });

  const manifest: Manifest = {
    app: 'paperbridge',
    version: 1,
    exportedAt: Date.now(),
    docs: await db.docs.toArray(),
    collections: await db.collections.toArray(),
    notes: await db.notes.toArray(),
    glossary: await db.glossary.toArray(),
    chats: await db.chats.toArray(),
    translations: await db.translations.toArray(),
  };
  const m = new ZipDeflate('manifest.json', { level: 6 });
  zip.add(m);
  m.push(strToU8(JSON.stringify(manifest)), true);

  const withPdf = manifest.docs.filter((d) => d.hasPdf);
  for (let i = 0; i < withPdf.length; i++) {
    const d = withPdf[i];
    onProgress?.(`打包 PDF ${i + 1}/${withPdf.length}`);
    const b = await db.blobs.get(d.id);
    if (!b) continue;
    const f = new ZipPassThrough(`pdf/${d.id}.pdf`); // PDFs are already compressed
    zip.add(f);
    const reader = b.blob.stream().getReader();
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      f.push(value);
    }
    f.push(new Uint8Array(0), true);
  }
  zip.end();
  await done;
  if (fail) throw fail;
  return new Blob(parts, { type: 'application/zip' });
}

export interface RestoreResult {
  docs: number;
  skippedDocs: number;
  notes: number;
  translations: number;
}

/** Merge a backup into the current library. Existing records (same id / same PDF) are kept. */
export async function importLibrary(file: Blob, onProgress?: (msg: string) => void): Promise<RestoreResult> {
  const files = new Map<string, Uint8Array[]>();
  const unzip = new Unzip((entry) => {
    const chunks: Uint8Array[] = [];
    files.set(entry.name, chunks);
    entry.ondata = (err, data) => {
      if (err) throw err;
      chunks.push(data);
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  const reader = file.stream().getReader();
  let read = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      unzip.push(new Uint8Array(0), true);
      break;
    }
    read += value.length;
    onProgress?.(`读取备份 ${(read / 1048576).toFixed(1)} MB`);
    unzip.push(value);
  }
  const join = (chunks: Uint8Array[]) => {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  };
  const mf = files.get('manifest.json');
  if (!mf) throw new Error('不是有效的 PaperBridge 备份文件（缺少 manifest.json）');
  const manifest = JSON.parse(strFromU8(join(mf))) as Manifest;
  if (manifest.app !== 'paperbridge') throw new Error('不是 PaperBridge 备份文件');

  const result: RestoreResult = { docs: 0, skippedDocs: 0, notes: 0, translations: 0 };
  const idMap = new Map<string, string>(); // backup docId → local docId (for duplicates by hash)
  for (const d of manifest.docs) {
    onProgress?.(`导入文献 ${result.docs + result.skippedDocs + 1}/${manifest.docs.length}`);
    const byId = await db.docs.get(d.id);
    const byHash = d.hash ? await db.docs.where('hash').equals(d.hash).first() : undefined;
    const existing = byId ?? byHash;
    if (existing) {
      idMap.set(d.id, existing.id);
      result.skippedDocs++;
      continue;
    }
    const pdf = files.get(`pdf/${d.id}.pdf`);
    await db.transaction('rw', db.docs, db.blobs, async () => {
      await db.docs.add({ ...d, hasPdf: !!pdf && d.hasPdf });
      if (pdf) await db.blobs.put({ id: d.id, blob: new Blob([join(pdf)], { type: 'application/pdf' }) });
    });
    idMap.set(d.id, d.id);
    result.docs++;
  }
  const mapDoc = (id: string) => idMap.get(id) ?? id;
  for (const c of manifest.collections) if (!(await db.collections.get(c.id))) await db.collections.add(c);
  for (const n of manifest.notes) {
    if (await db.notes.get(n.id)) continue;
    await db.notes.add({ ...n, docId: mapDoc(n.docId) });
    result.notes++;
  }
  for (const g of manifest.glossary) {
    if (!(await db.glossary.get(g.id))) await db.glossary.add({ ...g, scope: g.scope === 'global' ? 'global' : mapDoc(g.scope) });
  }
  for (const c of manifest.chats) if (!(await db.chats.get(c.id))) await db.chats.add({ ...c, docId: mapDoc(c.docId) });
  const newTr = [];
  for (const t of manifest.translations) if (!(await db.translations.get(t.key))) newTr.push({ ...t, docId: t.docId && mapDoc(t.docId) });
  await db.translations.bulkPut(newTr);
  result.translations = newTr.length;
  return result;
}

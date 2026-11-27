import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/db';
import { extractPdfsFromFileList } from '../folder';
import { importFolderPdfs } from '../service';

function makeFile(name: string, relativePath: string, type = ''): File {
  const f = new File(['%PDF-1.4 dummy'], name, { type });
  Object.defineProperty(f, 'webkitRelativePath', { value: relativePath, configurable: true });
  return f;
}

describe('recursive folder PDF import preserving nested collection hierarchy', () => {
  beforeEach(async () => {
    await db.docs.clear();
    await db.collections.clear();
    await db.blobs.clear();
  });

  it('filters strictly to PDFs, ignores non-PDF and hidden/macOS junk files, and extracts folder paths', () => {
    const files = [
      makeFile('paper1.pdf', 'Research/LLM/Agents/paper1.pdf', 'application/pdf'),
      makeFile('notes.docx', 'Research/LLM/Agents/notes.docx'),
      makeFile('fig1.png', 'Research/LLM/Images/fig1.png', 'image/png'),
      makeFile('._paper1.pdf', 'Research/LLM/Agents/._paper1.pdf'),
      makeFile('junk.pdf', 'Research/__MACOSX/junk.pdf'),
      makeFile('hidden.pdf', 'Research/.git/hidden.pdf'),
      makeFile('paper2.PDF', 'Research/Vision/paper2.PDF'),
    ];
    const scan = extractPdfsFromFileList(files);
    expect(scan.hasFolders).toBe(true);
    expect(scan.ignoredCount).toBe(5);
    expect(scan.items.map((x) => ({ name: x.file.name, path: x.folderPath }))).toEqual([
      { name: 'paper1.pdf', path: ['Research', 'LLM', 'Agents'] },
      { name: 'paper2.PDF', path: ['Research', 'Vision'] },
    ]);
  });

  it('creates nested collections only for PDF-bearing folders, reuses existing folders, and assigns duplicates', async () => {
    const files = [
      makeFile('a.pdf', '课题/大语言模型/推理/a.pdf', 'application/pdf'),
      makeFile('b.pdf', '课题/大语言模型/b.pdf', 'application/pdf'),
      makeFile('readme.txt', '课题/空图片目录/readme.txt', 'text/plain'),
    ];
    const scan = extractPdfsFromFileList(files);

    const fakeDocs = new Map<string, string>();
    const stubImport = async (file: File, collectionId?: string) => {
      const existingId = fakeDocs.get(file.name);
      if (existingId) return { docId: existingId, duplicate: true, title: file.name };
      const id = `doc-${file.name}`;
      fakeDocs.set(file.name, id);
      await db.docs.add({
        id,
        title: file.name,
        fileName: file.name,
        size: 12,
        pageCount: 1,
        addedAt: Date.now(),
        lastOpenedAt: 0,
        lastPage: 0,
        hash: id,
        meta: { title: file.name, authors: [], type: 'other' },
        metaSource: 'pdf',
        tags: [],
        collectionIds: collectionId ? [collectionId] : [],
        starred: false,
        status: 'unread',
        hasPdf: true,
        updatedAt: Date.now(),
      });
      return { docId: id, duplicate: false, title: file.name };
    };

    const r1 = await importFolderPdfs(scan.items, { ignoredCount: scan.ignoredCount, importFile: stubImport });
    expect(r1.added).toBe(2);
    expect(r1.ignored).toBe(1);
    expect(r1.collectionsCreated).toBe(3); // 课题 -> 大语言模型 -> 推理 (空图片目录 skipped!)

    const cols = await db.collections.toArray();
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.has('空图片目录')).toBe(false);
    const root = byName.get('课题')!;
    const llm = byName.get('大语言模型')!;
    const reason = byName.get('推理')!;
    expect(root.parentId).toBeNull();
    expect(llm.parentId).toBe(root.id);
    expect(reason.parentId).toBe(llm.id);

    const docA = await db.docs.get('doc-a.pdf');
    const docB = await db.docs.get('doc-b.pdf');
    expect(docA?.collectionIds).toEqual([reason.id]);
    expect(docB?.collectionIds).toEqual([llm.id]);

    // Re-importing the same folder reuses existing collections without creating duplicates
    // and places an already-existing PDF into a new subfolder if moved there
    const scan2 = extractPdfsFromFileList([makeFile('a.pdf', '课题/大语言模型/新子目录/a.pdf', 'application/pdf')]);
    const r2 = await importFolderPdfs(scan2.items, { importFile: stubImport });
    expect(r2.added).toBe(0);
    expect(r2.duplicates).toBe(1);
    expect(r2.collectionsCreated).toBe(1); // Only '新子目录' created!
    const updatedA = await db.docs.get('doc-a.pdf');
    expect(updatedA?.collectionIds).toHaveLength(2);
  });
});

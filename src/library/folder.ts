/**
 * Recursive folder traversal utilities for importing local PDF folder trees
 * while preserving nested directory hierarchy (both <input webkitdirectory>
 * and drag-and-drop DataTransfer). Strictly filters to PDF files only.
 */

export interface FolderPdfItem {
  file: File;
  /** Ordered folder segments from outer-most dropped/selected folder down to the PDF's immediate parent. */
  folderPath: string[];
}

export interface FolderScanResult {
  items: FolderPdfItem[];
  ignoredCount: number;
  hasFolders: boolean;
}

const IGNORED_DIRS = new Set(['__MACOSX', 'node_modules', '.git', '.svn', '.DS_Store']);

export function isIgnoredFolderName(name: string): boolean {
  const n = name.trim();
  return !n || n.startsWith('.') || IGNORED_DIRS.has(n);
}

export function isValidPdfFile(name: string, mimeType = ''): boolean {
  const base = name.trim();
  if (!base || base.startsWith('.') || base.startsWith('._')) return false;
  return mimeType === 'application/pdf' || /\.pdf$/i.test(base);
}

/** Parse relative path segments (excluding the file name) from a webkitRelativePath or Entry fullPath. */
export function splitFolderSegments(relativePath: string): string[] {
  const parts = relativePath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= 1) return [];
  return parts.slice(0, -1);
}

/** Extract PDFs & their nested folder paths from a FileList / File[] (e.g. <input webkitdirectory>). */
export function extractPdfsFromFileList(files: Iterable<File>): FolderScanResult {
  const items: FolderPdfItem[] = [];
  let ignoredCount = 0;
  let hasFolders = false;

  for (const file of files) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
    const folderPath = rel ? splitFolderSegments(rel) : [];
    if (folderPath.length > 0) hasFolders = true;
    if (folderPath.some(isIgnoredFolderName)) {
      ignoredCount++;
      continue;
    }
    if (!isValidPdfFile(file.name, file.type)) {
      ignoredCount++;
      continue;
    }
    items.push({ file, folderPath });
  }

  sortFolderItems(items);
  return { items, ignoredCount, hasFolders };
}

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}

interface FsFileEntry extends FsEntry {
  isFile: true;
  file: (ok: (f: File) => void, err?: (e: unknown) => void) => void;
}

interface FsDirReader {
  readEntries: (ok: (entries: FsEntry[]) => void, err?: (e: unknown) => void) => void;
}

interface FsDirEntry extends FsEntry {
  isDirectory: true;
  createReader: () => FsDirReader;
}

function readAllDirEntries(dir: FsDirEntry): Promise<FsEntry[]> {
  return new Promise((resolve, reject) => {
    const reader = dir.createReader();
    const all: FsEntry[] = [];
    const next = () => {
      reader.readEntries(
        (batch) => {
          if (!batch.length) resolve(all);
          else {
            all.push(...batch);
            next();
          }
        },
        (err) => reject(err),
      );
    };
    next();
  });
}

function entryToFile(entry: FsFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function sortFolderItems(items: FolderPdfItem[]) {
  items.sort((a, b) => {
    const pa = a.folderPath.join('/');
    const pb = b.folderPath.join('/');
    return pa.localeCompare(pb, 'zh') || a.file.name.localeCompare(b.file.name, 'zh');
  });
}

/**
 * Synchronously captures DataTransfer entries (before the drop event ends) and
 * returns a promise that recursively scans all dropped files & nested folders,
 * keeping ONLY `.pdf` files and preserving their folder paths.
 */
export function scanDataTransfer(dt: DataTransfer): Promise<FolderScanResult> {
  const entries: FsEntry[] = [];
  if (dt.items && dt.items.length > 0) {
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i] as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null };
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
  }
  const fallbackFiles = [...dt.files];

  if (!entries.length) {
    return Promise.resolve(extractPdfsFromFileList(fallbackFiles));
  }

  return (async () => {
    const items: FolderPdfItem[] = [];
    let ignoredCount = 0;
    let hasFolders = false;

    const walk = async (entry: FsEntry, parentPath: string[]) => {
      if (entry.isDirectory) {
        if (isIgnoredFolderName(entry.name)) return;
        hasFolders = true;
        const nextPath = [...parentPath, entry.name.trim()];
        try {
          const children = await readAllDirEntries(entry as FsDirEntry);
          for (const child of children) {
            await walk(child, nextPath);
          }
        } catch {
          /* ignore unreadable directory */
        }
        return;
      }
      if (entry.isFile) {
        if (!isValidPdfFile(entry.name)) {
          ignoredCount++;
          return;
        }
        try {
          const file = await entryToFile(entry as FsFileEntry);
          if (!isValidPdfFile(file.name, file.type)) {
            ignoredCount++;
            return;
          }
          items.push({ file, folderPath: parentPath });
        } catch {
          ignoredCount++;
        }
      }
    };

    for (const e of entries) {
      await walk(e, []);
    }

    sortFolderItems(items);
    return { items, ignoredCount, hasFolders };
  })();
}

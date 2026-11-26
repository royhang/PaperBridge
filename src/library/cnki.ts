import { parseBibTeX } from './bibtex';
import { splitAuthorName } from './meta';
import type { Author, ItemType, PaperMeta } from './types';

export interface ParsedReference {
  meta: PaperMeta;
  tags: string[];
}

function cleanStr(v?: string): string | undefined {
  const s = v?.replace(/\s+/g, ' ').trim();
  return s || undefined;
}

function mapType(raw?: string): ItemType {
  const s = (raw ?? '').trim().toLowerCase();
  if (/journal|jour|期刊|j(\/ol)?$/.test(s)) return 'article';
  if (/conf|proc|会议|c(\/ol)?$/.test(s)) return 'conference';
  if (/thesis|dissertation|硕士|博士|学位|d(\/ol)?$/.test(s)) return 'thesis';
  if (/book section|chap|章节/.test(s)) return 'chapter';
  if (/book|专著|m(\/ol)?$/.test(s)) return 'book';
  if (/report|报告|r(\/ol)?$/.test(s)) return 'report';
  if (/preprint|arxiv/.test(s)) return 'preprint';
  return 'article';
}

function parseTagList(raw: string[]): string[] {
  const out: string[] = [];
  for (const item of raw) {
    for (const part of item.split(/[;；,，\n]+/)) {
      const t = part.trim();
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

function parseAuthorList(raw: string[]): Author[] {
  const out: Author[] = [];
  for (const item of raw) {
    for (const part of item.split(/[;；\n]+/)) {
      const cleaned = part.replace(/\d+$/g, '').trim();
      if (!cleaned) continue;
      const a = splitAuthorName(cleaned);
      if (a.family || a.given) out.push(a);
    }
  }
  return out;
}

/** Parse CNKI standard downloaded filename like `论文标题_第一作者.pdf` or `论文标题_第一作者_2025.pdf`. */
export function parseCnkiFileName(fileName: string): { title?: string; author?: string; year?: number } {
  const stem = (fileName.split(/[/\\]/).at(-1) ?? '').replace(/\.pdf$/i, '').trim();
  if (!stem || !stem.includes('_')) return {};
  // Strip trailing copy suffixes like " (1)"
  const clean = stem.replace(/\s*\(\d+\)$/, '');
  const parts = clean.split('_').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return {};
  let year: number | undefined;
  if (parts.length >= 3 && /^(?:19|20)\d{2}$/.test(parts[parts.length - 1])) {
    year = Number(parts.pop());
  }
  const authorPart = parts[parts.length - 1];
  const titlePart = parts.slice(0, -1).join('_').trim();
  // Author looks like a Chinese or short personal name (2-20 chars, not purely digits)
  const looksChineseAuthor = /^[\u4e00-\u9fff·]{2,6}(?:等)?$/.test(authorPart);
  const looksTitleHasHan = /[\u4e00-\u9fff]{3,}/.test(titlePart);
  if (titlePart.length >= 4 && (looksChineseAuthor || (looksTitleHasHan && authorPart.length >= 2 && authorPart.length <= 24 && !/^\d+$/.test(authorPart)))) {
    return {
      title: titlePart,
      author: authorPart.replace(/等$/, ''),
      ...(year ? { year } : {}),
    };
  }
  return {};
}

/** Parse CNKI NoteExpress format (`{Reference Type}: ...`). */
export function parseNoteExpress(text: string): ParsedReference[] {
  const blocks = text.split(/(?=\{Reference Type\}\s*:)/i).map((b) => b.trim()).filter((b) => /^\{Reference Type\}\s*:/i.test(b));
  const out: ParsedReference[] = [];
  for (const block of blocks) {
    const map = new Map<string, string[]>();
    let lastKey = '';
    for (const line of block.split(/\r?\n/)) {
      const m = /^\{([^}]+)\}\s*:\s*(.*)$/.exec(line.trim());
      if (m) {
        lastKey = m[1].trim().toLowerCase();
        const val = m[2].trim();
        if (val) map.set(lastKey, [...(map.get(lastKey) ?? []), val]);
      } else if (lastKey && line.trim()) {
        const arr = map.get(lastKey) ?? [];
        if (arr.length) arr[arr.length - 1] += ' ' + line.trim();
        else arr.push(line.trim());
        map.set(lastKey, arr);
      }
    }
    const first = (...keys: string[]) => {
      for (const k of keys) {
        const v = map.get(k)?.[0];
        if (v) return cleanStr(v);
      }
      return undefined;
    };
    const title = first('title');
    if (!title) continue;
    const yearStr = first('year', 'date')?.match(/(?:19|20)\d{2}/)?.[0];
    const meta: PaperMeta = {
      title,
      authors: parseAuthorList(map.get('author') ?? []),
      year: yearStr ? Number(yearStr) : undefined,
      venue: first('journal', 'secondary title', 'conference name', 'publisher'),
      volume: first('volume'),
      issue: first('issue', 'number'),
      pages: first('pages'),
      publisher: first('publisher', 'university'),
      doi: first('doi'),
      url: first('url'),
      abstract: first('abstract'),
      language: /[\u4e00-\u9fff]/.test(title) ? 'zh' : undefined,
      type: mapType(first('reference type')),
    };
    const tags = parseTagList(map.get('keywords') ?? []);
    out.push({ meta, tags });
  }
  return out;
}

/** Parse RIS format (`TY  - ... ER  -`). */
export function parseRIS(text: string): ParsedReference[] {
  const blocks = text.split(/(?=^TY\s{1,2}-\s)/m).map((b) => b.trim()).filter((b) => /^TY\s{1,2}-\s/.test(b));
  const out: ParsedReference[] = [];
  for (const block of blocks) {
    const map = new Map<string, string[]>();
    let lastTag = '';
    for (const line of block.split(/\r?\n/)) {
      const m = /^([A-Z0-9]{2})\s{1,2}-\s?(.*)$/.exec(line);
      if (m) {
        lastTag = m[1];
        if (lastTag === 'ER') break;
        const val = m[2].trim();
        if (val) map.set(lastTag, [...(map.get(lastTag) ?? []), val]);
      } else if (lastTag && line.trim()) {
        const arr = map.get(lastTag) ?? [];
        if (arr.length) arr[arr.length - 1] += ' ' + line.trim();
      }
    }
    const first = (...keys: string[]) => {
      for (const k of keys) {
        const v = map.get(k)?.[0];
        if (v) return cleanStr(v);
      }
      return undefined;
    };
    const title = first('TI', 'T1', 'CT');
    if (!title) continue;
    const sp = first('SP');
    const ep = first('EP');
    const pages = sp && ep ? `${sp}-${ep}` : sp;
    const yearStr = first('PY', 'Y1', 'DA')?.match(/(?:19|20)\d{2}/)?.[0];
    const meta: PaperMeta = {
      title,
      authors: parseAuthorList([...(map.get('AU') ?? []), ...(map.get('A1') ?? [])]),
      year: yearStr ? Number(yearStr) : undefined,
      venue: first('JO', 'JF', 'T2', 'JA'),
      volume: first('VL'),
      issue: first('IS'),
      pages,
      publisher: first('PB'),
      doi: first('DO'),
      url: first('UR', 'L1'),
      abstract: first('AB', 'N2'),
      language: /[\u4e00-\u9fff]/.test(title) ? 'zh' : undefined,
      type: mapType(first('TY')),
    };
    const tags = parseTagList(map.get('KW') ?? []);
    out.push({ meta, tags });
  }
  return out;
}

/** Parse EndNote / CNKI `.enw` (`%0 Journal Article`, `%T`, `%A`, ...). */
export function parseEndNote(text: string): ParsedReference[] {
  const blocks = text.split(/(?=^%0\s+)/m).map((b) => b.trim()).filter((b) => /^%0\s+/.test(b));
  const out: ParsedReference[] = [];
  for (const block of blocks) {
    const map = new Map<string, string[]>();
    let lastTag = '';
    for (const line of block.split(/\r?\n/)) {
      const m = /^%([A-Za-z0-9])\s+(.*)$/.exec(line.trim());
      if (m) {
        lastTag = m[1];
        const val = m[2].trim();
        if (val) map.set(lastTag, [...(map.get(lastTag) ?? []), val]);
      } else if (lastTag && line.trim()) {
        const arr = map.get(lastTag) ?? [];
        if (arr.length) arr[arr.length - 1] += ' ' + line.trim();
      }
    }
    const first = (...keys: string[]) => {
      for (const k of keys) {
        const v = map.get(k)?.[0];
        if (v) return cleanStr(v);
      }
      return undefined;
    };
    const title = first('T');
    if (!title) continue;
    const yearStr = first('D', '8')?.match(/(?:19|20)\d{2}/)?.[0];
    const meta: PaperMeta = {
      title,
      authors: parseAuthorList(map.get('A') ?? []),
      year: yearStr ? Number(yearStr) : undefined,
      venue: first('J', 'B'),
      volume: first('V'),
      issue: first('N'),
      pages: first('P'),
      publisher: first('I'),
      doi: first('R'),
      url: first('U'),
      abstract: first('X'),
      language: /[\u4e00-\u9fff]/.test(title) ? 'zh' : undefined,
      type: mapType(first('0')),
    };
    const tags = parseTagList(map.get('K') ?? []);
    out.push({ meta, tags });
  }
  return out;
}

/** Parse CNKI RefWorks tagged format (`RT Journal Article`, `T1 ...`, `A1 ...`). */
export function parseRefWorks(text: string): ParsedReference[] {
  const blocks = text.split(/(?=^RT\s+)/m).map((b) => b.trim()).filter((b) => /^RT\s+/.test(b));
  const out: ParsedReference[] = [];
  for (const block of blocks) {
    const map = new Map<string, string[]>();
    for (const line of block.split(/\r?\n/)) {
      const m = /^([A-Z][A-Z0-9])\s+(.*)$/.exec(line.trim());
      if (m) {
        const k = m[1];
        const v = m[2].trim();
        if (v) map.set(k, [...(map.get(k) ?? []), v]);
      }
    }
    const first = (...keys: string[]) => {
      for (const k of keys) {
        const v = map.get(k)?.[0];
        if (v) return cleanStr(v);
      }
      return undefined;
    };
    const title = first('T1');
    if (!title) continue;
    const sp = first('SP');
    const op = first('OP');
    const yearStr = first('YR')?.match(/(?:19|20)\d{2}/)?.[0];
    const meta: PaperMeta = {
      title,
      authors: parseAuthorList(map.get('A1') ?? []),
      year: yearStr ? Number(yearStr) : undefined,
      venue: first('JF', 'T2'),
      volume: first('VO'),
      issue: first('IS'),
      pages: sp && op ? `${sp}-${op}` : sp,
      publisher: first('PB'),
      doi: first('DO'),
      url: first('LK'),
      abstract: first('AB'),
      language: /[\u4e00-\u9fff]/.test(title) ? 'zh' : undefined,
      type: mapType(first('RT')),
    };
    const tags = parseTagList(map.get('K1') ?? []);
    out.push({ meta, tags });
  }
  return out;
}

/**
 * Parse CNKI GB/T 7714 plain-text citation lines, e.g.:
 *   [1] 徐凯翔, 王永贵. 变与不变：……[J]. 西北工业大学学报(社会科学版), 2026(06): 42-49.
 *   [2] 张三. 基于大模型的文献研究[D]. 清华大学, 2024.
 */
export function parseGb7714(text: string): ParsedReference[] {
  const out: ParsedReference[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^\[\d+\]\s*/, '');
    if (!line) continue;
    const m = /^(.+?)[.．]\s*(.+?)\[([A-Z](?:\/OL)?)\][.．]\s*(.+)$/.exec(line);
    if (!m) continue;
    const [, authorsRaw, titleRaw, typeCode, restRaw] = m;
    const title = titleRaw.trim();
    if (!title) continue;
    const authors = authorsRaw
      .split(/[,，、;；]/)
      .map((s) => s.replace(/等$|et\s+al\.?$/i, '').trim())
      .filter(Boolean)
      .map(splitAuthorName);

    let rest = restRaw.trim().replace(/[.。]+$/, '');
    const doiMatch = /\bDOI\s*[:：]\s*(10\.\d{4,9}\/[^\s,;，；]+)/i.exec(rest);
    const doi = doiMatch?.[1];
    if (doiMatch) rest = rest.slice(0, doiMatch.index).trim().replace(/[.。]+$/, '');

    // Extract venue, year, volume, issue, pages: e.g. "期刊名, 2026, 43(06): 42-49" or "期刊名, 2026(06): 42-49" or "清华大学, 2024"
    const detail = /^(.*?)[,，]\s*((?:19|20)\d{2})(?:[,，]\s*(\d+))?(?:\(([^)]+)\))?(?:\s*[:：]\s*([\d\-–—+]+))?/.exec(rest);
    const venue = cleanStr(detail?.[1] ?? rest.split(/[,，]/)[0]);
    const year = detail?.[2] ? Number(detail[2]) : Number(rest.match(/(?:19|20)\d{2}/)?.[0]) || undefined;
    const volume = cleanStr(detail?.[3]);
    const issue = cleanStr(detail?.[4]);
    const pages = cleanStr(detail?.[5]);

    const type = mapType(typeCode);
    const meta: PaperMeta = {
      title,
      authors,
      year,
      venue: type === 'thesis' ? undefined : venue,
      publisher: type === 'thesis' ? venue : undefined,
      volume,
      issue,
      pages,
      doi,
      language: /[\u4e00-\u9fff]/.test(title) ? 'zh' : undefined,
      type,
    };
    out.push({ meta, tags: [] });
  }
  return out;
}

/** Auto-detect and parse BibTeX, NoteExpress, RIS, EndNote (.enw), RefWorks, or CNKI GB/T 7714 citations. */
export function parseReferences(text: string): ParsedReference[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (/^\s*@[a-z]+\s*[{(]/im.test(trimmed)) {
    const bib = parseBibTeX(trimmed);
    if (bib.length) return bib.map((e) => ({ meta: e.meta, tags: [] }));
  }
  if (/\{Reference Type\}\s*:/i.test(trimmed)) {
    const ne = parseNoteExpress(trimmed);
    if (ne.length) return ne;
  }
  if (/^TY\s{1,2}-\s/m.test(trimmed)) {
    const ris = parseRIS(trimmed);
    if (ris.length) return ris;
  }
  if (/^%0\s+/m.test(trimmed)) {
    const enw = parseEndNote(trimmed);
    if (enw.length) return enw;
  }
  if (/^RT\s+/m.test(trimmed)) {
    const rw = parseRefWorks(trimmed);
    if (rw.length) return rw;
  }
  return parseGb7714(trimmed);
}

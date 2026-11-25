import type { Author, ItemType, PaperMeta } from './types';

const doiPattern = /(?<![\w.])10\.\d{4,9}\/[^\s<>"“”‘’]+/i;
const arxivIdPattern = String.raw`(?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})(?:v\d+)?`;
const bareArxivId = new RegExp('^' + arxivIdPattern + '$', 'i');
const arxivStamp = new RegExp(
  String.raw`(?:\barxiv:\s*|\barxiv\.org/(?:abs|pdf)/)(${arxivIdPattern})(?![\w/-])`,
  'i',
);
const referencesHeading = /^[ \t]*(?:(?:\d+(?:\.\d+)*|[IVXLCDM]+)[.)]?[ \t]+)?(?:references|bibliography)[ \t]*[:.]?[ \t]*\r?$/im;

function normalizeDoi(value: string): string {
  let doi = value;
  while (/[.,;:!?')\]]$/.test(doi)) {
    const last = doi.charAt(doi.length - 1);
    const opening = last === ')' ? '(' : last === ']' ? '[' : undefined;
    if (opening && doi.split(opening).length >= doi.split(last).length) break;
    doi = doi.slice(0, -1);
  }
  return doi;
}

export function extractIdentifiers(text: string): { doi?: string; arxivId?: string } {
  const heading = text.search(referencesHeading);
  const mainText = heading < 0 ? text : text.slice(0, heading);
  const match = mainText.match(doiPattern)?.[0];
  const doi = match && normalizeDoi(match);
  const arxivId = text.match(arxivStamp)?.[1];
  return {
    ...(doi && !doi.endsWith('/') ? { doi } : {}),
    ...(arxivId ? { arxivId } : {}),
  };
}

type IdentifierInput =
  | { kind: 'doi'; value: string; pdfUrl?: string }
  | { kind: 'arxiv'; value: string; pdfUrl: string }
  | { kind: 'url'; value: string; pdfUrl?: string };

function arxivInput(id: string): IdentifierInput {
  return { kind: 'arxiv', value: id, pdfUrl: 'https://arxiv.org/pdf/' + id };
}

export function parseIdentifierInput(input: string): IdentifierInput | null {
  const value = input.trim();
  const possibleId = value.replace(/^arxiv:\s*/i, '');
  if (bareArxivId.test(possibleId)) return arxivInput(possibleId);

  let possibleDoi = value.replace(/^doi:\s*/i, '');
  if (/^https?:\/\/[^\s]+$/i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
      if (/^(?:www\.|export\.)?arxiv\.org$/i.test(url.hostname)) {
        const id = decodeURIComponent(url.pathname)
          .match(/^\/(?:abs|pdf)\/(.+?)\/?$/i)?.[1].replace(/\.pdf$/i, '');
        if (id && bareArxivId.test(id)) return arxivInput(id);
      }
      if (!/^(?:dx\.)?doi\.org$/i.test(url.hostname)) {
        const pdf = /\.pdf$|\/pdf\//i.test(url.pathname);
        return pdf ? { kind: 'url', value, pdfUrl: value } : { kind: 'url', value };
      }
      possibleDoi = decodeURIComponent(url.pathname.slice(1));
    } catch {
      return null;
    }
  }

  if (possibleDoi.match(doiPattern)?.[0] === possibleDoi) {
    const doi = normalizeDoi(possibleDoi);
    if (!doi.endsWith('/')) return { kind: 'doi', value: doi };
  }
  return null;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const xmlEntities: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

function decodeXml(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, name: string) => {
    if (!name.startsWith('#')) return xmlEntities[name] ?? entity;
    const hex = name[1].toLowerCase() === 'x';
    const codePoint = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? String.fromCodePoint(codePoint)
      : entity;
  });
}

function xmlText(value: string): string {
  const parts = value.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/g);
  return collapseWhitespace(parts.map((part, index) => index % 2
    ? part.slice(9, -3)
    : decodeXml(part
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<\/?(?:[\w-]+:)?(?:p|sec|title|br)\b[^>]*>/gi, ' ')
      .replace(/<\/?[a-z][^>]*>/gi, ''))).join(''));
}

function xmlElements(xml: string, tag: string): RegExpStringIterator<RegExpExecArray> {
  return xml.matchAll(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '\\s*>', 'g'));
}

export function splitAuthorName(name: string): Author {
  const clean = collapseWhitespace(name);
  const comma = clean.indexOf(',');
  if (comma >= 0) return { family: clean.slice(0, comma).trim(), given: clean.slice(comma + 1).trim() };

  const han = clean.match(/^(\p{Script=Han})((?:\p{Script=Han}|\s)+)$/u);
  if (han) return { family: han[1], given: han[2].replace(/\s/g, '') };

  const lastSpace = clean.lastIndexOf(' ');
  return lastSpace < 0
    ? { family: clean, given: '' }
    : { family: clean.slice(lastSpace + 1), given: clean.slice(0, lastSpace) };
}

export function parseArxivAtom(xml: string): PaperMeta | null {
  const entry = xmlElements(xml, 'entry').next().value?.[1];
  if (!entry) return null;

  const field = (tag: string) => xmlText(xmlElements(entry, tag).next().value?.[1] ?? '') || undefined;
  const title = field('title');
  if (!title || /^error$/i.test(title)) return null;

  const authors = Array.from(xmlElements(entry, 'author'), ([, author]) =>
    splitAuthorName(xmlText(xmlElements(author, 'name').next().value?.[1] ?? '')),
  ).filter(({ family, given }) => family || given);
  const publishedYear = field('published')?.match(/^\d{4}(?=-|$)/)?.[0];
  const identifier = parseIdentifierInput(field('id') ?? '');
  const arxivId = identifier?.kind === 'arxiv' ? identifier.value.replace(/v\d+$/i, '') : undefined;
  const journal = field('arxiv:journal_ref');
  return {
    title,
    authors,
    year: publishedYear ? Number(publishedYear) : undefined,
    abstract: field('summary'),
    doi: field('arxiv:doi'),
    venue: journal ?? 'arXiv',
    type: journal ? 'article' : 'preprint',
    arxivId,
    url: arxivId ? 'https://arxiv.org/abs/' + arxivId : undefined,
  };
}

const crossrefTypes: ReadonlyMap<string, ItemType> = new Map([
  ['journal-article', 'article'],
  ['proceedings-article', 'conference'],
  ['posted-content', 'preprint'],
  ['book', 'book'],
  ['book-chapter', 'chapter'],
  ['dissertation', 'thesis'],
  ['report', 'report'],
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function firstString(value: unknown): string | undefined {
  return Array.isArray(value) ? nonemptyString(value[0]) : undefined;
}

function crossrefYear(date: unknown): number | undefined {
  const parts = record(date)?.['date-parts'];
  const year = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0][0] : undefined;
  return typeof year === 'number' && Number.isInteger(year) && year > 0 ? year : undefined;
}

export function crossrefToMeta(json: unknown): PaperMeta | null {
  const message = record(record(json)?.message);
  const title = firstString(message?.title);
  if (!message || !title) return null;

  const authors: Author[] = [];
  for (const value of Array.isArray(message.author) ? message.author : []) {
    const author = record(value);
    const family = nonemptyString(author?.family) ?? nonemptyString(author?.name) ?? '';
    const given = nonemptyString(author?.given) ?? '';
    if (family || given) authors.push({ family, given });
  }
  const abstract = nonemptyString(message.abstract);
  return {
    title,
    authors,
    year: crossrefYear(message.issued) ?? crossrefYear(message['published-print']) ?? crossrefYear(message['published-online']),
    venue: firstString(message['container-title']),
    volume: nonemptyString(message.volume),
    issue: nonemptyString(message.issue),
    pages: nonemptyString(message.page),
    publisher: nonemptyString(message.publisher),
    doi: nonemptyString(message.DOI),
    url: nonemptyString(message.URL),
    abstract: abstract ? xmlText(abstract) || undefined : undefined,
    type: crossrefTypes.get(nonemptyString(message.type) ?? '') ?? 'other',
  };
}

export function normalizeTitleForDedupe(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '');
}

function plausiblePdfTitle(title: string, fileName: string): boolean {
  const stem = (fileName.split(/[/\\]/).at(-1) ?? '').replace(/\.pdf$/i, '');
  return title.length > 3
    && !/^(?:(?:untitled|document)\d*$|microsoft\s+(?:word|powerpoint)\b)/i.test(title)
    && !/\.(?:pdf|docx?|tex|pptx?)$/i.test(title)
    && normalizeTitleForDedupe(title) !== normalizeTitleForDedupe(stem);
}

export interface TextRun {
  str: string;
  /** left edge and baseline, PDF user space (y up) */
  x: number;
  y: number;
  width: number;
  /** font size */
  size: number;
}

const NOT_TITLE = /^(?:arxiv\b|doi\s*:|https?:\/\/|abstract\b|references\b|bibliography\b|copyright\b|©|\(c\)\s|\d{4}\s*©|all rights reserved\b|provided proper attribution\b|proceedings of\b|(?:the )?journal of\b|(?:ieee|acm) (?:transactions|journal|proceedings)\b|(?:accepted|submitted|published) (?:to|in|at|on)\b|preprint\b|(?:running|page) (?:header|title)\b|(?:volume|vol\.|issue|page)\s*\d)/i;

/**
 * The title of a first page by type size: the lines of its largest text in the upper part of the page (up to
 * three adjacent lines). Robust where the text stream puts a running footer or conference stamp before the
 * title ("July 27 - August 1, 2025 ©2025 ACL" + "REFLECTOOL: …"). Small caps ("R" + "EFLECTOOL") stay on
 * their line.
 */
export function titleFromLayout(runs: TextRun[], pageHeight: number): string | undefined {
  const words = runs.filter((r) => /\p{L}/u.test(r.str) && r.size > 0 && r.y > pageHeight * 0.35);
  if (!words.length) return undefined;
  // the largest size carried by a reasonable amount of text (a big drop cap or logo letter does not count)
  const bySize = new Map<number, number>();
  for (const r of words) bySize.set(Math.round(r.size * 2) / 2, (bySize.get(Math.round(r.size * 2) / 2) ?? 0) + r.str.trim().length);
  const big = [...bySize].filter(([, n]) => n >= 8).sort((a, b) => b[0] - a[0])[0]?.[0];
  if (!big) return undefined;
  const body = [...bySize].sort((a, b) => b[1] - a[1])[0][0];
  if (big < body * 1.15) return undefined;
  const heads = words.filter((r) => r.size >= big * 0.95 - 0.25).sort((a, b) => b.y - a.y);
  // title lines: baselines of the large text, adjacent (≤ 2 line heights apart), from the topmost one down
  const lines: number[] = [];
  for (const r of heads) {
    if (lines.some((y) => Math.abs(y - r.y) < big * 0.4)) continue;
    if (lines.length && lines[lines.length - 1] - r.y > big * 2.2) break;
    lines.push(r.y);
    if (lines.length === 3) break;
  }
  const text = lines
    .map((y) =>
      runs
        .filter((r) => Math.abs(r.y - y) < big * 0.4 && r.size >= big * 0.5)
        .sort((a, b) => a.x - b.x)
        .reduce((acc, r, i, all) => {
          const prev = all[i - 1];
          const gap = prev ? r.x - (prev.x + prev.width) : 0;
          return acc + (prev && gap > big * 0.15 && !/\s$/.test(acc) ? ' ' : '') + r.str;
        }, ''),
    )
    .join(' ')
    .replace(/(\p{L})- (\p{Ll})/gu, '$1$2')
    .replace(/(\p{L})- (\p{Lu})/gu, '$1-$2')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length >= 8 && text.length <= 300 && !NOT_TITLE.test(text) ? text : undefined;
}

export function guessMetaFromPdf(
  info: { Title?: string; Author?: string; Subject?: string; Keywords?: string } | undefined,
  firstPageText: string,
  fileName: string,
  layoutTitle?: string,
): Partial<PaperMeta> {
  const result: Partial<PaperMeta> = extractIdentifiers(firstPageText);
  const pdfTitle = collapseWhitespace(info?.Title ?? '');
  const mainText = firstPageText.split(referencesHeading, 1)[0];
  const lines = mainText.split(/\r?\n/).map(collapseWhitespace).filter(Boolean).slice(0, 18);
  const title = plausiblePdfTitle(pdfTitle, fileName) ? pdfTitle : layoutTitle || lines.find((line) =>
    line.length >= 12
    && /\p{L}/u.test(line)
    && !NOT_TITLE.test(line),
  );
  if (title) result.title = title;
  if (info?.Author) {
    const authors = info.Author.split(/[;,]|\s+and\s+/i).map(splitAuthorName)
      .filter(({ family, given }) => family || given);
    if (authors.length) result.authors = authors;
  }
  const year = lines.join('\n').slice(0, 1500).match(/(?<![\w./-])(?:19|20)\d{2}(?![\w/-]|\.\d)/)?.[0];
  if (year) result.year = Number(year);
  return result;
}

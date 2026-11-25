import type { Author, ItemType, PaperMeta } from './types';

const stopwords = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with',
]);
const asciiLetters: Record<string, string> = {
  æ: 'ae', đ: 'd', ð: 'd', ł: 'l', ø: 'o', œ: 'oe', ß: 'ss', þ: 'th',
};

function foldAscii(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[æđðłøœßþ]/g, (letter) => asciiLetters[letter]);
}

export function citeKey(meta: PaperMeta): string {
  const family = foldAscii(meta.authors[0]?.family ?? '').replace(/[^a-z]/g, '');
  const year = meta.year ?? '';
  if (!family) return 'item' + year;
  const words = foldAscii(meta.title).match(/[a-z][a-z0-9]*/g) ?? [];
  const word = words.find((candidate) => !stopwords.has(candidate)) ?? '';
  return family + year + word;
}

const bibtexTypes: Record<ItemType, string> = {
  article: 'article',
  conference: 'inproceedings',
  preprint: 'misc',
  book: 'book',
  chapter: 'incollection',
  thesis: 'phdthesis',
  report: 'techreport',
  other: 'misc',
};

const bibtexChars: Record<string, string> = {
  '&': '\\&', '%': '\\%', '$': '\\$', '#': '\\#', '_': '\\_', '{': '\\{', '}': '\\}',
  '~': '\\textasciitilde{}', '^': '\\textasciicircum{}', '\\': '\\textbackslash{}',
};

function escapeBibTeX(value: string): string {
  return value.replace(/[&%$#_{}~^\\]/g, (character) => bibtexChars[character]);
}

function bibtexTitle(title: string): string {
  return title.split(/([\p{L}\p{M}\p{N}]+)/u).map((part) => {
    const escaped = escapeBibTeX(part);
    const internalCapital = /[\p{Ll}\p{N}].*\p{Lu}/u.test(part);
    const acronym = !/\p{Ll}/u.test(part) && /\p{Lu}.*\p{Lu}/u.test(part);
    return internalCapital || acronym ? '{' + escaped + '}' : escaped;
  }).join('');
}

function bibtexAuthor({ family, given }: Author): string {
  if (given) {
    const group = (name: string) => /,|\s+and\s+/i.test(name) ? '{' + escapeBibTeX(name) + '}' : escapeBibTeX(name);
    return group(family) + ', ' + group(given);
  }
  const name = escapeBibTeX(family || given);
  return /[\s,]/.test(name) ? '{' + name + '}' : name;
}

export function toBibTeX(meta: PaperMeta, key = citeKey(meta)): string {
  const lines: string[] = [];
  const add = (field: string, value: string | number | undefined, encode = escapeBibTeX) => {
    if (value !== undefined && value !== '') lines.push('  ' + field + ' = {' + encode(String(value)) + '}');
  };
  add('title', meta.title, bibtexTitle);
  add('author', meta.authors.map(bibtexAuthor).filter(Boolean).join(' and '), (value) => value);
  add('year', meta.year);
  switch (meta.type) {
    case 'article':
      add('journal', meta.venue);
      break;
    case 'conference':
    case 'chapter':
      add('booktitle', meta.venue);
      break;
    default:
      add('venue', meta.venue);
  }
  add('volume', meta.volume);
  add('number', meta.issue);
  add('pages', meta.pages?.replace(/–/g, '--'));
  const publisherField = meta.type === 'thesis' ? 'school' : meta.type === 'report' ? 'institution' : 'publisher';
  add(publisherField, meta.publisher);
  add('doi', meta.doi);
  add('url', meta.url);
  add('abstract', meta.abstract);
  add('language', meta.language);
  if (meta.arxivId) {
    add('eprint', meta.arxivId);
    add('archivePrefix', 'arXiv');
    add('primaryClass', meta.arxivId.match(/^([^/]+)\//)?.[1]);
  }
  if (meta.type === 'preprint' && !meta.arxivId) add('type', 'preprint');
  return '@' + bibtexTypes[meta.type] + '{' + key + ',\n' + (lines.length ? lines.join(',\n') + '\n' : '') + '}';
}

function initials(given: string, period: string, separator: string): string {
  return given.split(/\s+|(?<=\.)(?=\p{L})/u).filter(Boolean).map((name) =>
    name.split(/[-‐‑]/u).map((part) => {
      const letter = part.match(/\p{L}\p{M}*/u)?.[0];
      return letter ? letter.toUpperCase() + period : '';
    }).filter(Boolean).join('-'),
  ).filter(Boolean).join(separator);
}

function period(text: string): string {
  return text && !/[.!?]$/.test(text) ? text + '.' : text;
}

function pageRanges(value: string | undefined, dash: string): string | undefined {
  return value?.replace(/(\d)\s*(?:--?|[–—])\s*(?=\d)/g, '$1' + dash);
}

function arxivUrl(meta: PaperMeta): string | undefined {
  return meta.arxivId ? 'https://arxiv.org/abs/' + meta.arxivId : meta.url;
}

function apaNames(authors: Author[]): string {
  const names = authors.map(({ family, given }) => {
    const short = initials(given, '.', ' ');
    return family && short ? family + ', ' + short : family || short;
  }).filter(Boolean);
  if (names.length > 20) return names.slice(0, 19).join(', ') + ', … ' + names.at(-1);
  if (names.length < 2) return names[0] ?? '';
  return names.slice(0, -1).join(', ') + ', & ' + names.at(-1);
}

function apaSource(meta: PaperMeta): string {
  const venue = meta.venue ? '*' + meta.venue + '*' : '';
  const pages = pageRanges(meta.pages, '–');
  const volume = meta.volume ? '*' + meta.volume + '*' : '';
  const issue = meta.issue ? '(' + meta.issue + ')' : '';
  switch (meta.type) {
    case 'article':
    case 'conference':
      return [venue, volume + issue, pages].filter(Boolean).join(', ');
    case 'chapter':
      return [
        venue ? 'In ' + venue + (pages ? ' (pp. ' + pages + ')' : '') : pages,
        meta.publisher,
      ].filter(Boolean).join('. ');
    case 'preprint':
      return 'arXiv';
    default:
      return meta.publisher ?? venue;
  }
}

export function toAPA(meta: PaperMeta): string {
  const authors = apaNames(meta.authors);
  const date = '(' + (meta.year ?? 'n.d.') + ').';
  const italicTitle = meta.type === 'book' || meta.type === 'thesis' || meta.type === 'report';
  const title = italicTitle ? '*' + meta.title + '*.' : period(meta.title);
  const source = period(apaSource(meta));
  const url = (meta.type === 'preprint' ? arxivUrl(meta) : undefined)
    ?? (meta.doi ? 'https://doi.org/' + meta.doi : meta.url);
  const heading = authors ? [period(authors), date, title] : [title, date];
  return [...heading, source, url].filter(Boolean).join(' ');
}

const gbtTypeCodes: Record<ItemType, string> = {
  article: 'J',
  conference: 'C',
  preprint: 'EB/OL',
  book: 'M',
  chapter: 'M',
  thesis: 'D',
  report: 'R',
  other: 'Z',
};

function isHanName({ family, given }: Author): boolean {
  return /^[\p{Script=Han}\s]+$/u.test(family + given);
}

function gbtNames(meta: PaperMeta): string {
  const authors = meta.authors.filter(({ family, given }) => family || given);
  const names = authors.slice(0, 3).map((author) => {
    if (isHanName(author)) return author.family + author.given;
    return [author.family.toUpperCase(), initials(author.given, '', '')].filter(Boolean).join(' ');
  });
  if (authors.length > 3) {
    const chinese = meta.language
      ? /^(?:zh|chi|zho|chinese)(?:[-_]|$)/i.test(meta.language)
      : authors.slice(0, 3).some(isHanName) || /\p{Script=Han}/u.test(meta.title);
    names.push(chinese ? '等' : 'et al.');
  }
  return period(names.join(', '));
}

export function toGBT7714(meta: PaperMeta): string {
  const title = meta.title + '[' + gbtTypeCodes[meta.type] + ']';
  const authors = gbtNames(meta);
  const year = meta.year?.toString();
  const pages = pageRanges(meta.pages, '-');
  const doi = meta.doi ? period('DOI:' + meta.doi) : undefined;
  let source: string;
  let work = period(title);
  if (meta.type === 'article') {
    const volume = (meta.volume ?? '') + (meta.issue ? '(' + meta.issue + ')' : '');
    source = [meta.venue, year, volume].filter(Boolean).join(', ');
  } else if (meta.type === 'conference' || meta.type === 'chapter') {
    if (meta.venue) work = period(title + '//' + meta.venue);
    source = [meta.publisher, year].filter(Boolean).join(', ');
  } else {
    source = [meta.publisher ?? (meta.type === 'preprint' ? undefined : meta.venue), year].filter(Boolean).join(', ');
  }
  if (pages) source = source ? source + ': ' + pages : pages;
  const url = meta.type === 'preprint' ? arxivUrl(meta) : undefined;
  return [authors, work, period(source), url && period(url), doi].filter(Boolean).join(' ');
}

export function formatCitation(meta: PaperMeta, style: 'bibtex' | 'apa' | 'gbt7714'): string {
  switch (style) {
    case 'bibtex':
      return toBibTeX(meta);
    case 'apa':
      return toAPA(meta);
    case 'gbt7714':
      return toGBT7714(meta);
  }
}

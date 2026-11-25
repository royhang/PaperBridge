import { citeKey, toBibTeX } from './citation';
import { parseIdentifierInput, splitAuthorName } from './meta';
import type { Author, ItemType, PaperMeta } from './types';

const months = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

class BibTeXReader {
  private readonly text: string;
  private readonly macros = new Map(months.map((month) => [month.slice(0, 3).toLowerCase(), month]));
  private position = 0;

  constructor(text: string) {
    this.text = text;
  }

  *entries(): Generator<{ type: string; key: string; fields: Map<string, string> }> {
    const header = /%[^\r\n]*|@([a-z][\w-]*)(?:\s*([({]))?/gi;
    let match: RegExpExecArray | null;
    while ((match = header.exec(this.text))) {
      if (!match[1]) continue;
      const type = match[1].toLowerCase();
      const opener = match[2];
      this.position = header.lastIndex;
      if (!opener) {
        if (type === 'comment') {
          const line = /^[^\r\n]*/.exec(this.text.slice(this.position));
          header.lastIndex += line?.[0].length ?? 0;
        }
        continue;
      }

      if (type === 'comment' || type === 'preamble') {
        if (this.readDelimited(opener, this.position - 1) !== undefined) header.lastIndex = this.position;
        continue;
      }

      const close = opener === '{' ? '}' : ')';
      if (type === 'string') {
        const fields = this.readFields(close);
        if (fields) {
          for (const [name, value] of fields) this.macros.set(name, value);
          header.lastIndex = this.position;
        }
        continue;
      }

      const key = this.readToken(/[^,\s{}()=%"@#]+/y);
      if (!key) continue;
      const fields = this.consume(close) ? new Map<string, string>() : this.consume(',') && this.readFields(close);
      // On failure, search from the previous header so a later valid entry can still be read.
      if (!fields) continue;
      header.lastIndex = this.position;
      yield { type, key, fields };
    }
  }

  private skipTrivia(): void {
    const trivia = /(?:\s+|%[^\r\n]*)*/y;
    trivia.lastIndex = this.position;
    trivia.exec(this.text);
    this.position = trivia.lastIndex;
  }

  private consume(token: string): boolean {
    this.skipTrivia();
    if (this.text[this.position] !== token) return false;
    this.position++;
    return true;
  }

  private readToken(pattern: RegExp): string | undefined {
    this.skipTrivia();
    pattern.lastIndex = this.position;
    const match = pattern.exec(this.text);
    if (match) this.position = pattern.lastIndex;
    return match?.[0];
  }

  private readFields(close: string): Map<string, string> | undefined {
    const fields = new Map<string, string>();
    while (!this.consume(close)) {
      const name = this.readToken(/[a-z][\w:.-]*/iy);
      if (!name || !this.consume('=')) return undefined;
      const value = this.readValue();
      if (value === undefined) return undefined;
      fields.set(name.toLowerCase(), value);
      if (!this.consume(',')) return this.consume(close) ? fields : undefined;
    }
    return fields;
  }

  private readValue(): string | undefined {
    const parts: string[] = [];
    do {
      this.skipTrivia();
      const opener = this.text[this.position];
      if (opener === '{' || opener === '"') {
        const value = this.readDelimited(opener, this.position);
        if (value === undefined) return undefined;
        parts.push(value);
      } else {
        const token = this.readToken(/[^\s,{}()"#=%@]+/y);
        if (!token) return undefined;
        parts.push(this.macros.get(token.toLowerCase()) ?? token);
      }
    } while (this.consume('#'));
    return parts.join('');
  }

  private readDelimited(opener: string, start: number): string | undefined {
    let braces = 0;
    let parentheses = 0;
    let quoted = false;
    for (let index = start + 1; index < this.text.length; index++) {
      const character = this.text[index];
      if (character === '\\') {
        index++;
        continue;
      }
      if (character === '{') braces++;
      if (character === '}' && braces > 0) {
        braces--;
        continue;
      }
      if (braces > 0) continue;
      if (opener === '(') {
        if (character === '"') quoted = !quoted;
        if (quoted) continue;
        if (character === '(') parentheses++;
        if (character !== ')') continue;
        if (parentheses > 0) {
          parentheses--;
          continue;
        }
      } else if (character !== (opener === '{' ? '}' : '"')) {
        continue;
      }
      this.position = index + 1;
      return this.text.slice(start + 1, index);
    }
    return undefined;
  }
}

const accentMarks: Record<string, string> = {
  '"': '\u0308', "'": '\u0301', '.': '\u0307', '=': '\u0304', '^': '\u0302',
  '`': '\u0300', '~': '\u0303', b: '\u0331', c: '\u0327', d: '\u0323',
  H: '\u030b', k: '\u0328', r: '\u030a', u: '\u0306', v: '\u030c',
};

const latexCommands = new Map(Object.entries({
  aa: 'å', AA: 'Å', ae: 'æ', AE: 'Æ', dh: 'ð', DH: 'Ð', i: 'ı', j: 'ȷ',
  l: 'ł', L: 'Ł', o: 'ø', O: 'Ø', oe: 'œ', OE: 'Œ', ss: 'ß', SS: 'ẞ',
  th: 'þ', TH: 'Þ', LaTeX: 'LaTeX', TeX: 'TeX',
  textasciicircum: '^', textasciitilde: '~', textbackslash: '\\',
  textemdash: '—', textendash: '–', textquotesingle: "'", textquotedbl: '"',
}));

function decodeLatex(value: string, literalPunctuation = false): string {
  return value.replace(
    /---?|[{}~]|\\(?:([="'^~.`]|[bcdHkruv](?![a-zA-Z]))\s*(?:\{\s*(\\[ij]|[a-zA-Z])\s*\}|(\\[ij]|[a-zA-Z]))|([a-zA-Z]+)(?:\{\}|[ \t]+)?|([&%$#_{}\\ ,!]))/g,
    (match, accent: string | undefined, braced: string | undefined, bare: string | undefined,
      command: string | undefined, escaped: string | undefined) => {
      if (accent) return ((braced ?? bare ?? '').replace(/^\\/, '') + accentMarks[accent]).normalize('NFC');
      if (command) return latexCommands.get(command) ?? match;
      if (escaped) return escaped === '\\' ? ' ' : escaped;
      if (literalPunctuation && (match === '~' || match.startsWith('--'))) return match;
      if (match === '---') return '—';
      if (match === '--') return '–';
      return match === '~' ? ' ' : '';
    },
  );
}

function decodedText(value: string): string {
  return decodeLatex(value).replace(/\s+/g, ' ').trim();
}

function splitOutsideGroups(value: string, tokens: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (const match of value.matchAll(tokens)) {
    if (match[0] === '{') depth++;
    else if (match[0] === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && match[1]) {
      parts.push(value.slice(start, match.index).trim());
      start = match.index + match[0].length;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function parseAuthors(value: string): Author[] {
  return splitOutsideGroups(value, /\\[\s\S]|[{}]|(\s+and\s+)/gi).map((name) => {
    const [first, ...rest] = splitOutsideGroups(name, /\\[\s\S]|[{}]|(,)/g);
    if (rest.length) {
      const given = decodedText(rest.at(-1) ?? '');
      const family = [first, ...rest.slice(0, -1)].map(decodedText).join(', ');
      return { family, given };
    }
    const words = splitOutsideGroups(first, /\\[\s\S]|[{}]|(\s+)/g).filter(Boolean);
    if (words.length === 1 && /^\{[\s\S]*\}$/.test(first)) {
      return { family: decodedText(first), given: '' };
    }
    if (words.length > 1) {
      // In an unpunctuated BibTeX name, a lowercase particle starts the family name.
      const particle = words.slice(0, -1).findIndex((word) => /^\p{Ll}/u.test(decodedText(word)));
      const familyStart = particle >= 0 ? particle : words.length - 1;
      return {
        family: decodedText(words.slice(familyStart).join(' ')),
        given: decodedText(words.slice(0, familyStart).join(' ')),
      };
    }
    return splitAuthorName(decodedText(first));
  }).filter(({ family, given }) => family || given);
}

const itemTypes: ReadonlyMap<string, ItemType> = new Map([
  ['article', 'article'],
  ['inproceedings', 'conference'], ['conference', 'conference'], ['proceedings', 'conference'],
  ['book', 'book'], ['booklet', 'book'], ['collection', 'book'],
  ['inbook', 'chapter'], ['incollection', 'chapter'],
  ['phdthesis', 'thesis'], ['mastersthesis', 'thesis'], ['thesis', 'thesis'],
  ['techreport', 'report'], ['report', 'report'],
  ['preprint', 'preprint'], ['unpublished', 'preprint'],
]);

type BibTeXEntry = { key: string; meta: PaperMeta; file?: string };

export function parseBibTeX(text: string): BibTeXEntry[] {
  const entries: BibTeXEntry[] = [];
  for (const { type, key, fields } of new BibTeXReader(text).entries()) {
    const field = (name: string) => decodedText(fields.get(name) ?? '') || undefined;
    const identifierField = (name: string) => decodeLatex(fields.get(name) ?? '', true).trim() || undefined;
    const identifier = parseIdentifierInput(field('arxivid')
      ?? (/^(?:arxiv)?$/i.test(field('archiveprefix') ?? '') ? field('eprint') : undefined)
      ?? '');
    const arxivId = identifier?.kind === 'arxiv' ? identifier.value : undefined;
    const year = (field('year') ?? field('date'))?.match(/^\d{4}(?=\b)/)?.[0];
    const meta: PaperMeta = {
      title: field('title') ?? '',
      authors: parseAuthors(fields.get('author') ?? ''),
      year: year ? Number(year) : undefined,
      venue: field('journal') ?? field('journaltitle') ?? field('booktitle') ?? field('venue'),
      volume: field('volume'),
      issue: field('number') ?? field('issue'),
      pages: field('pages'),
      publisher: field('publisher') ?? field('school') ?? field('institution'),
      doi: identifierField('doi'),
      url: identifierField('url'),
      abstract: field('abstract'),
      arxivId,
      language: field('language'),
      type: itemTypes.get(type) ?? (arxivId || field('type')?.toLowerCase() === 'preprint' ? 'preprint' : 'other'),
    };
    const file = fields.get('file');
    entries.push(file === undefined ? { key, meta } : { key, meta, file });
  }
  return entries;
}

function letterSuffix(index: number): string {
  let suffix = '';
  for (let current = index; current > 0; current = Math.floor((current - 1) / 26)) {
    suffix = String.fromCharCode(97 + (current - 1) % 26) + suffix;
  }
  return suffix;
}

export function toBibTeXLibrary(items: { meta: PaperMeta; key?: string }[]): string {
  const keys = items.map(({ meta, key }) => key ?? citeKey(meta));
  const reserved = new Set(keys);
  const used = new Set<string>();
  const suffixes = new Map<string, number>();
  return items.map(({ meta }, index) => {
    const base = keys[index];
    let key = base;
    if (used.has(key)) {
      let suffix = suffixes.get(base) ?? 0;
      do {
        key = base + letterSuffix(++suffix);
      } while (used.has(key) || reserved.has(key));
      suffixes.set(base, suffix);
    }
    used.add(key);
    return toBibTeX(meta, key);
  }).join('\n\n');
}

import type { ReadStatus } from '../db/db';
import type { Author, PaperMeta } from './types';

export const STATUS_LABEL: Record<ReadStatus, string> = { unread: '未读', reading: '在读', done: '已读' };

const isCJK = (s: string) => /\p{Script=Han}/u.test(s);

export function authorName(a: Author): string {
  if (isCJK(a.family + a.given)) return a.family + a.given;
  return [a.given, a.family].filter(Boolean).join(' ');
}

/** "Vaswani et al." / "Vaswani & Shazeer" / "张三 等" */
export function authorsShort(authors: Author[]): string {
  if (!authors.length) return '';
  const first = authors[0];
  const cjk = isCJK(first.family + first.given);
  const fam = (a: Author) => (cjk ? authorName(a) : a.family || a.given);
  if (authors.length === 1) return fam(first);
  if (authors.length === 2) return `${fam(first)}${cjk ? '、' : ' & '}${fam(authors[1])}`;
  return `${fam(first)} ${cjk ? '等' : 'et al.'}`;
}

/** Editable text form: one author per line or ';'-separated "Family, Given". */
export function authorsToText(authors: Author[]): string {
  return authors.map((a) => (a.given ? `${a.family}, ${a.given}` : a.family)).join('; ');
}

export function textToAuthors(text: string): Author[] {
  return text
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (s.includes(',')) {
        const [family, ...rest] = s.split(',');
        return { family: family.trim(), given: rest.join(',').trim() };
      }
      if (isCJK(s) && !s.includes(' ')) return { family: s.slice(0, 1), given: s.slice(1) };
      const parts = s.split(/\s+/);
      return { family: parts.pop() ?? '', given: parts.join(' ') };
    });
}

export function venueLine(m: PaperMeta): string {
  return [m.venue, m.year].filter(Boolean).join(' · ');
}

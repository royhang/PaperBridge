import { describe, expect, it } from 'vitest';
import { citeKey, formatCitation, toAPA, toBibTeX, toGBT7714 } from '../citation';
import type { ItemType, PaperMeta } from '../types';

const attention: PaperMeta = {
  title: 'Attention is all you need',
  authors: [
    { family: 'Vaswani', given: 'Ashish' },
    { family: 'Shazeer', given: 'Noam' },
    { family: 'Parmar', given: 'Niki' },
    { family: 'Uszkoreit', given: 'Jakob' },
    { family: 'Jones', given: 'Llion' },
    { family: 'Gomez', given: 'Aidan N.' },
    { family: 'Kaiser', given: 'Łukasz' },
    { family: 'Polosukhin', given: 'Illia' },
  ],
  year: 2017,
  venue: 'Advances in Neural Information Processing Systems',
  volume: '30',
  pages: '5998-6008',
  type: 'conference',
};

describe('citation keys', () => {
  it('uses the family, year and first significant title word', () => {
    expect(citeKey(attention)).toBe('vaswani2017attention');
    expect(citeKey({ ...attention, title: 'An Introduction to Logic', authors: [{ family: 'Søgaard-López', given: 'Ana' }] }))
      .toBe('sogaardlopez2017introduction');
  });

  it('uses an item key if the first family name cannot be folded to ASCII', () => {
    expect(citeKey({ ...attention, authors: [{ family: '张', given: '三' }] })).toBe('item2017');
    expect(citeKey({ ...attention, authors: [], year: undefined })).toBe('item');
  });
});

describe('BibTeX formatting', () => {
  const cases: [ItemType, string][] = [
    ['article', 'article'], ['conference', 'inproceedings'], ['preprint', 'misc'], ['book', 'book'],
    ['chapter', 'incollection'], ['thesis', 'phdthesis'], ['report', 'techreport'], ['other', 'misc'],
  ];
  it.each(cases)('formats %s as @%s', (type, entryType) => {
    expect(toBibTeX({ ...attention, type }, 'custom')).toMatch(new RegExp('^@' + entryType + '\\{custom,'));
  });

  it('protects acronyms and internal capitals, escapes TeX characters and uses family-first names', () => {
    const citation = toBibTeX({
      ...attention, title: 'BERT and GPT-4 on iPhone & 50% of $x_1 # {~^\\}',
      authors: attention.authors.slice(0, 2),
    }, 'example');
    expect(citation).toContain(String.raw`title = {{BERT} and {GPT}-4 on {iPhone} \& 50\% of \$x\_1 \# \{\textasciitilde{}\textasciicircum{}\textbackslash{}\}}`);
    expect(citation).toContain('author = {Vaswani, Ashish and Shazeer, Noam}');
    expect(citation).toContain('booktitle = {Advances in Neural Information Processing Systems}');
  });

  it('exports arXiv eprint fields, including the category when carried by a legacy identifier', () => {
    const citation = toBibTeX({ ...attention, type: 'preprint', arxivId: 'hep-th/9901001' });
    expect(citation).toContain('eprint = {hep-th/9901001}');
    expect(citation).toContain('archivePrefix = {arXiv}');
    expect(citation).toContain('primaryClass = {hep-th}');
  });
});

describe('APA', () => {
  it('renders the conference citation with initials, italics, an en dash and a DOI URL', () => {
    expect(toAPA({ ...attention, doi: '10.1000/attention' })).toBe(
      'Vaswani, A., Shazeer, N., Parmar, N., Uszkoreit, J., Jones, L., Gomez, A. N., Kaiser, Ł., & Polosukhin, I. (2017). Attention is all you need. *Advances in Neural Information Processing Systems*, *30*, 5998–6008. https://doi.org/10.1000/attention',
    );
  });

  it('uses initials for hyphenated given names and an unitalicized issue', () => {
    expect(toAPA({
      ...attention, authors: [{ family: 'Martin', given: 'Jean-Pierre A.B.' }], volume: '30', issue: '2',
      type: 'article', year: undefined,
    })).toBe('Martin, J.-P. A. B. (n.d.). Attention is all you need. *Advances in Neural Information Processing Systems*, *30*(2), 5998–6008.');
  });

  it('keeps all 20 names but uses the first 19 and the final author with longer lists', () => {
    const authors = Array.from({ length: 23 }, (_, index) => ({ family: 'Author' + (index + 1), given: 'Alice' }));
    const truncate = toAPA({ ...attention, authors });
    expect(truncate).toContain('Author19, A., … Author23, A. (2017).');
    expect(truncate).not.toContain('Author20');
    expect(truncate).not.toContain('Author22');
    expect(truncate).not.toContain('&');
    expect(toAPA({ ...attention, authors: authors.slice(0, 20) })).toContain('Author19, A., & Author20, A. (2017).');
  });

  it('links arXiv preprints and uses the title before the date for an anonymous work', () => {
    const preprint: PaperMeta = { title: 'Attention is all you need', authors: [], type: 'preprint', arxivId: '1706.03762' };
    expect(toAPA(preprint)).toBe('Attention is all you need. (n.d.). arXiv. https://arxiv.org/abs/1706.03762');
  });
});

describe('GB/T 7714', () => {
  it('renders proceedings with three authors, type, range and DOI', () => {
    expect(toGBT7714({ ...attention, pages: '5998–6008', doi: '10.1000/attention' })).toBe(
      'VASWANI A, SHAZEER N, PARMAR N, et al. Attention is all you need[C]//Advances in Neural Information Processing Systems. 2017: 5998-6008. DOI:10.1000/attention.',
    );
  });

  it('keeps Chinese names and uses 等 for truncation', () => {
    expect(toGBT7714({
      title: '论文标题',
      authors: [
        { family: '张', given: '三' }, { family: '李', given: '四' },
        { family: '王', given: '小明' }, { family: '赵', given: '六' },
      ],
      type: 'article',
      venue: '计算机学报',
      year: 2024,
      volume: '47',
      issue: '2',
      pages: '101–115',
    })).toBe('张三, 李四, 王小明, 等. 论文标题[J]. 计算机学报, 2024, 47(2): 101-115.');
  });

  it.each([
    ['book', 'M'], ['thesis', 'D'], ['report', 'R'], ['preprint', 'EB/OL'],
  ] as const)('labels %s with [%s]', (type, code) => {
    const citation = toGBT7714({ title: 'A work', authors: [], type, url: 'https://arxiv.org/abs/1706.03762' });
    expect(citation).toContain('A work[' + code + '].');
    if (type === 'preprint') expect(citation).toContain('https://arxiv.org/abs/1706.03762');
  });
});

it('dispatches all three citation styles', () => {
  expect(formatCitation(attention, 'bibtex')).toBe(toBibTeX(attention));
  expect(formatCitation(attention, 'apa')).toBe(toAPA(attention));
  expect(formatCitation(attention, 'gbt7714')).toBe(toGBT7714(attention));
});

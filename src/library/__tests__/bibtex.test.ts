import { describe, expect, it } from 'vitest';
import { parseBibTeX, toBibTeXLibrary } from '../bibtex';
import { citeKey, toBibTeX } from '../citation';
import type { PaperMeta } from '../types';

const rawFile = String.raw`Full Text:storage/2P83FJSE/Müller et al. - 2021.pdf:application/pdf;Notes:C\:\\Papers\\notes.txt:text/plain`;
const zoteroExport = String.raw`% Manual note containing @book{ignored, title = {Ignored}}
@Comment{jabref-meta: databaseType:bibtex;}
@Preamble{"ignored " # "\LaTeX"}
@String{tnn = "IEEE Transactions on Neural Networks"}
@String{publisher = "Association for " # "Computing Machinery"}
@ARTICLE{muller2021,
  title = {Learning with {{BERT}} and G{\"o}del's {Models}},
  author = {M{\"u}ller, J{\"u}rgen and Garc\'{i}a, Jos{\'e} and {\AA}se S{\o}rensen and {Google Brain and Research Team}},
  journal = tnn # " and Learning Systems",
  volume = {32},
  number = "3",
  year = 2021,
  pages = {1051--1062},
  month = MAR,
  publisher = publisher,
  doi = {10.1109/tnnls--.2021.12345},
  url = {https://example.org/~jmueller/paper},
  abstract = "An evaluation in " # MAR # " of~Ludwig {van Beethoven's} \& Stra{\ss}e, with {\aa} and \c{c}.",
  file = {${rawFile}},
}
@misc(vaswaniPreprint,
  title = "Attention Is All You Need",
  author = "Ashish Vaswani and Noam Shazeer",
  year = {2017},
  archivePrefix = {arXiv},
  eprint = {1706.03762v7}
)`;

describe('BibTeX parsing', () => {
  it('reads a Zotero-style export with macros, TeX accents, and raw file paths', () => {
    const entries = parseBibTeX(zoteroExport);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      key: 'muller2021',
      file: rawFile,
      meta: {
        title: "Learning with BERT and Gödel's Models",
        authors: [
          { family: 'Müller', given: 'Jürgen' },
          { family: 'García', given: 'José' },
          { family: 'Sørensen', given: 'Åse' },
          { family: 'Google Brain and Research Team', given: '' },
        ],
        venue: 'IEEE Transactions on Neural Networks and Learning Systems',
        year: 2021,
        volume: '32',
        issue: '3',
        pages: '1051–1062',
        publisher: 'Association for Computing Machinery',
        doi: '10.1109/tnnls--.2021.12345',
        url: 'https://example.org/~jmueller/paper',
        abstract: "An evaluation in March of Ludwig van Beethoven's & Straße, with å and ç.",
        type: 'article',
      },
    });
    expect(entries[1]).toMatchObject({
      key: 'vaswaniPreprint',
      meta: {
        title: 'Attention Is All You Need',
        authors: [{ family: 'Vaswani', given: 'Ashish' }, { family: 'Shazeer', given: 'Noam' }],
        year: 2017,
        arxivId: '1706.03762v7',
        type: 'preprint',
      },
    });
  });

  it('handles quoted braces, author particles and suffixes, and legacy arXiv identifiers', () => {
    const entries = parseBibTeX(String.raw`
@INPROCEEDINGS{scholar,
  title="A {"Quoted"} Study with {{Nested {Groups}}}",
  author={Ludwig van Beethoven and von Neumann, Jr., John and John {Van Dam}},
  booktitle={Proceedings of the Symposium},
  year=2019
}
@misc{legacy, title={A preprint}, arxivId={arXiv:hep-th/9901001}}
@misc{other, title={A repository item}, eprint=1706.03762, archiveprefix={Other Archive}}
`);
    expect(entries[0]).toMatchObject({
      key: 'scholar',
      meta: {
        title: 'A "Quoted" Study with Nested Groups',
        authors: [
          { family: 'van Beethoven', given: 'Ludwig' },
          { family: 'von Neumann, Jr.', given: 'John' },
          { family: 'Van Dam', given: 'John' },
        ],
        venue: 'Proceedings of the Symposium',
        year: 2019,
        type: 'conference',
      },
    });
    expect(entries[1].meta).toMatchObject({ arxivId: 'hep-th/9901001', type: 'preprint' });
    expect(entries[2].meta.arxivId).toBeUndefined();
  });

  it('skips malformed entries and resumes at the next valid record', () => {
    const entries = parseBibTeX([
      '@comment',
      '@article{first, title={First}}',
      '@book{missingEquals, title "wrong"}',
      '@inproceedings{unclosed, title={Missing end',
      '@book{found, % comment inside the entry',
      '  title = {A Complete Book}, year = 2020,',
      '}',
      '@book{invalidConcat, title="Wrong" # }',
      '@techreport(report, title={A Report}, institution={Research Laboratory})',
    ].join('\n'));
    expect(entries.map(({ key }) => key)).toEqual(['first', 'found', 'report']);
    expect(entries[2].meta).toMatchObject({ title: 'A Report', publisher: 'Research Laboratory', type: 'report' });
    expect(parseBibTeX('ordinary notes without bibliographic records')).toEqual([]);
  });
});

const meta: PaperMeta = {
  type: 'article',
  title: 'BERT & GPT-4 for data {analysis} with ~, ^, \\ and 20% # $a_b',
  authors: [
    { family: 'García-López', given: 'Jean-Pierre' },
    { family: 'Google Brain and Research Team', given: '' },
    { family: 'van Neumann, Jr.', given: 'John' },
    { family: '张', given: '三' },
  ],
  year: 2024,
  venue: 'Research & Development',
  volume: '2',
  issue: '3',
  pages: '19–31',
  publisher: 'Computing Press',
  doi: '10.1000/data--set_01',
  url: 'https://example.org/~data/data--set_01?q=1&n=2',
  abstract: 'The study uses {BERT}.',
  arxivId: '2401.01234',
  language: 'en',
};

describe('BibTeX export and import', () => {
  it('round-trips all core fields including organizations, DOI, URL and punctuation', () => {
    const key = 'garcia2024bert';
    expect(parseBibTeX(toBibTeX(meta, key))).toEqual([{ key, meta }]);
  });

  it.each(['book', 'thesis', 'report', 'chapter', 'preprint'] as const)('round-trips %s metadata without an arXiv ID', (type) => {
    const item = { ...meta, type, arxivId: undefined };
    expect(parseBibTeX(toBibTeX(item))[0].meta).toEqual(item);
  });

  it('assigns unique keys without taking a key reserved by another item', () => {
    const base = citeKey(meta);
    const library = toBibTeXLibrary([{ meta }, { meta }, { meta, key: base + 'a' }, { meta }, { meta, key: 'manual' }]);
    expect(parseBibTeX(library).map(({ key }) => key)).toEqual([base, base + 'b', base + 'a', base + 'c', 'manual']);
    expect(library).toContain('}\n\n@article{');
    expect(toBibTeXLibrary([])).toBe('');
  });

  it('continues with two letters when all single-letter suffixes are taken', () => {
    const entries = parseBibTeX(toBibTeXLibrary(Array.from({ length: 28 }, () => ({ meta, key: 'paper' }))));
    expect(entries).toHaveLength(28);
    expect(entries.slice(-3).map(({ key }) => key)).toEqual(['papery', 'paperz', 'paperaa']);
  });
});

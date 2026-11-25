import { describe, expect, it } from 'vitest';
import {
  crossrefToMeta,
  extractIdentifiers,
  guessMetaFromPdf,
  normalizeTitleForDedupe,
  parseArxivAtom,
  parseIdentifierInput,
  splitAuthorName,
  titleFromLayout,
  type TextRun,
} from '../meta';

const firstPage = [
  'Proceedings of the 31st Conference on Neural Information Processing Systems',
  'arXiv:1706.03762v7 [cs.CL]  2 Aug 2023',
  'Provided proper attribution is provided, this work may be reproduced.',
  'Copyright 2023 by the authors.',
  'Attention is All You Need',
  'Ashish Vaswani, Noam Shazeer',
  'Abstract',
  'Article DOI: (https://doi.org/10.1145/3292500.3330701);',
  'Another DOI in the abstract: 10.1000/other.',
  '9 References',
  '[1] https://doi.org/10.1000/reference.',
].join('\n');

const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title>ArXiv Query: id_list=1706.03762</title>
  <id>http://arxiv.org/api/1706.03762</id>
  <updated>2023-08-02T18:20:09Z</updated>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">1</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <updated>2023-08-02T18:20:09Z</updated>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is
      All You Need</title>
    <summary>We propose a new simple network architecture, the Transformer,
      based solely on attention mechanisms.
      Queries &amp; keys use scores &lt; or &gt; zero &#x2014; &quot;scaled&quot; by the model&apos;s dimension.
      &#243;</summary>
    <author><name>Ashish Vaswani</name><arxiv:affiliation>Google Brain</arxiv:affiliation></author>
    <author><name>Noam Shazeer</name></author>
    <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
    <arxiv:primary_category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;

describe('identifier extraction', () => {
  it('uses the earliest identifiers in noisy page text', () => {
    expect(extractIdentifiers(firstPage)).toEqual({
      doi: '10.1145/3292500.3330701',
      arxivId: '1706.03762v7',
    });
    expect(extractIdentifiers('See https://arxiv.org/pdf/hep-th/9901001.pdf and arXiv:2401.01234.'))
      .toEqual({ arxivId: 'hep-th/9901001' });
    expect(extractIdentifiers('Available (doi:10.1000/Article(2)).')).toEqual({ doi: '10.1000/Article(2)' });
  });

  it('ignores DOIs after a bibliography heading', () => {
    expect(extractIdentifiers('Paper body\r\n  Bibliography:\r\n[1] doi:10.1234/reference]')).toEqual({});
    expect(extractIdentifiers('Paper references often include doi:10.123456789/Example];'))
      .toEqual({ doi: '10.123456789/Example' });
  });
});

describe('identifier input', () => {
  it.each([
    ' 10.1145/3292500.3330701 ',
    'doi: 10.1145/3292500.3330701.',
    'https://doi.org/10.1145/3292500.3330701',
    'https://dx.doi.org/10.1145/3292500.3330701',
  ])('parses DOI %s', (input) => {
    expect(parseIdentifierInput(input)).toEqual({ kind: 'doi', value: '10.1145/3292500.3330701' });
  });

  it.each([
    ['1706.03762', '1706.03762'],
    ['arXiv:1706.03762v7', '1706.03762v7'],
    ['https://arxiv.org/abs/1706.03762', '1706.03762'],
    ['https://arxiv.org/pdf/1706.03762v7.pdf?download=1', '1706.03762v7'],
    ['https://arxiv.org/pdf/1706.03762v7', '1706.03762v7'],
    ['https://arxiv.org/abs/hep-th/9901001', 'hep-th/9901001'],
    [' arXiv:2401.01234 ', '2401.01234'],
  ])('parses arXiv identifier %s', (input, id) => {
    expect(parseIdentifierInput(input)).toEqual({ kind: 'arxiv', value: id, pdfUrl: 'https://arxiv.org/pdf/' + id });
  });

  it.each(['https://example.org/paper.PDF', 'http://example.org/pdf/42?download=1'])('recognizes PDF URL %s', (url) => {
    expect(parseIdentifierInput(url)).toEqual({ kind: 'url', value: url, pdfUrl: url });
  });

  it('handles landing pages and rejects invalid input', () => {
    expect(parseIdentifierInput('  https://example.org/paper  ')).toEqual({ kind: 'url', value: 'https://example.org/paper' });
    for (const input of ['', 'some paper', '1706.03762v', '10.1000/', 'https://', 'ftp://example.org']) {
      expect(parseIdentifierInput(input)).toBeNull();
    }
  });
});

describe('arXiv Atom', () => {
  it('reads the published date, strips the version from the URL, and decodes XML', () => {
    expect(parseArxivAtom(atom)).toEqual({
      title: 'Attention Is All You Need',
      authors: [{ given: 'Ashish', family: 'Vaswani' }, { given: 'Noam', family: 'Shazeer' }],
      year: 2017,
      abstract: 'We propose a new simple network architecture, the Transformer, based solely on attention mechanisms. Queries & keys use scores < or > zero — "scaled" by the model\'s dimension. ó',
      venue: 'arXiv',
      type: 'preprint',
      arxivId: '1706.03762',
      url: 'https://arxiv.org/abs/1706.03762',
    });
  });

  it('promotes entries with a journal reference and reads the DOI', () => {
    const journalAtom = atom.replace('</entry>', [
      '<arxiv:journal_ref>Journal of Research &amp; Technology, 30 (2017)</arxiv:journal_ref>',
      '<arxiv:doi>10.1000/123</arxiv:doi>',
      '</entry>',
    ].join('\n'));
    expect(parseArxivAtom(journalAtom)).toMatchObject({
      doi: '10.1000/123',
      type: 'article',
      venue: 'Journal of Research & Technology, 30 (2017)',
    });
  });

  it('returns null for no results and for an error entry', () => {
    expect(parseArxivAtom('<feed><title>ArXiv Query</title></feed>')).toBeNull();
    expect(parseArxivAtom('<feed><entry><title>Error</title><summary>invalid id</summary></entry></feed>')).toBeNull();
  });
});

describe('Crossref', () => {
  it('maps journal work metadata and removes JATS tags', () => {
    const doi = '10.1145/362384.362685';
    expect(crossrefToMeta({
      'message-type': 'work',
      message: {
        title: ['A Relational Model of Data for Large Shared Data Banks'],
        author: [{ given: 'E. F.', family: 'Codd' }, { name: 'Research and Data Group' }],
        issued: { 'date-parts': [[1970, 6]] },
        'published-online': { 'date-parts': [[2002, 1, 1]] },
        'container-title': ['Communications of the ACM'],
        volume: '13',
        issue: '6',
        page: '377-387',
        publisher: 'Association for Computing Machinery (ACM)',
        DOI: doi,
        URL: 'https://doi.org/' + doi,
        abstract: '<jats:title>Abstract</jats:title><jats:p>Future users of <jats:italic>large</jats:italic> data banks.</jats:p><jats:p>Tables &amp; relations.</jats:p>',
        type: 'journal-article',
      },
    })).toEqual({
      title: 'A Relational Model of Data for Large Shared Data Banks',
      authors: [{ given: 'E. F.', family: 'Codd' }, { given: '', family: 'Research and Data Group' }],
      year: 1970,
      venue: 'Communications of the ACM',
      volume: '13',
      issue: '6',
      pages: '377-387',
      publisher: 'Association for Computing Machinery (ACM)',
      doi,
      url: 'https://doi.org/' + doi,
      abstract: 'Abstract Future users of large data banks. Tables & relations.',
      type: 'article',
    });
  });

  it('maps proceedings and falls back to print or online dates', () => {
    const message = {
      title: ['Neural Collaborative Filtering'],
      author: [{ given: 'Xiangnan', family: 'He' }],
      DOI: '10.1145/3038912.3052569',
      'container-title': ['Proceedings of the 26th International Conference on World Wide Web'],
      'published-online': { 'date-parts': [[2016]] },
      type: 'proceedings-article',
    };
    expect(crossrefToMeta({ message })).toMatchObject({
      title: 'Neural Collaborative Filtering',
      year: 2016,
      type: 'conference',
    });
    expect(crossrefToMeta({ message: { ...message, 'published-print': { 'date-parts': [[2017]] } } })?.year).toBe(2017);
  });

  it.each([
    ['posted-content', 'preprint'], ['book', 'book'], ['book-chapter', 'chapter'],
    ['dissertation', 'thesis'], ['report', 'report'], ['dataset', 'other'],
  ])('maps the Crossref type %s', (type, expected) => {
    expect(crossrefToMeta({ message: { title: ['A work'], type } })?.type).toBe(expected);
  });

  it('rejects non-work responses and missing titles', () => {
    for (const input of [null, [], 'failure', {}, { message: { title: [] } }]) {
      expect(crossrefToMeta(input)).toBeNull();
    }
  });
});

describe('PDF heuristics and names', () => {
  it.each([
    [' Vaswani, Ashish ', 'Vaswani', 'Ashish'],
    ['Ashish   Vaswani', 'Vaswani', 'Ashish'],
    ['A. Vaswani', 'Vaswani', 'A.'],
    ['张三', '张', '三'],
    ['王小明', '王', '小明'],
    ['Madonna', 'Madonna', ''],
  ])('splits %s', (name, family, given) => {
    expect(splitAuthorName(name)).toEqual({ family, given });
  });

  it.each(['Untitled', 'Microsoft Word - draft.docx', 'attention_main', 'attention_main.pdf', '???'])
  ('falls back to the page title when the PDF title is %s', (Title) => {
    expect(guessMetaFromPdf({ Title, Author: 'Ashish Vaswani; Noam Shazeer, Niki Parmar and 张三' }, firstPage, 'attention_main.pdf'))
      .toEqual({
        title: 'Attention is All You Need',
        authors: [
          { family: 'Vaswani', given: 'Ashish' },
          { family: 'Shazeer', given: 'Noam' },
          { family: 'Parmar', given: 'Niki' },
          { family: '张', given: '三' },
        ],
        doi: '10.1145/3292500.3330701',
        arxivId: '1706.03762v7',
        year: 2023,
      });
  });

  it('prefers plausible embedded metadata and can return no guesses', () => {
    expect(guessMetaFromPdf({ Title: ' An accurate  title ' }, firstPage, '123.pdf').title).toBe('An accurate title');
    expect(guessMetaFromPdf(undefined, 'Page 1\narXiv:1706.03762', 'paper.pdf')).toEqual({ arxivId: '1706.03762' });
    expect(guessMetaFromPdf(undefined, '', 'paper.pdf')).toEqual({});
  });

  it('normalizes superficial title differences while retaining Unicode letters', () => {
    expect(normalizeTitleForDedupe(' ＢＥＲＴ: A naïve approach—中文！ ')).toBe('bertanaïveapproach中文');
    expect(normalizeTitleForDedupe('De\u0301ja vu')).toBe(normalizeTitleForDedupe('Déja-vu'));
  });

  it('extracts multi-line and small-caps titles from page layout runs', () => {
    const runs: TextRun[] = [
      // conference footer / stamp in smaller font
      { str: 'July 27 - August 1, 2025 ©2025 ACL', x: 72, y: 760, width: 200, size: 9 },
      // small-caps title ("R" larger than "EFLECTOOL") + wrapped second line
      { str: 'R', x: 100, y: 700, width: 10, size: 15 },
      { str: 'EFLECTOOL', x: 110, y: 700, width: 65, size: 11.5 },
      { str: ': Towards Reflection-', x: 175, y: 700, width: 140, size: 15 },
      { str: 'Aware Tool-Augmented Clinical Agents', x: 120, y: 680, width: 250, size: 15 },
      // body text establishes the dominant body size
      { str: 'Large Language Models have shown promising potential in medical domains.', x: 72, y: 500, width: 400, size: 10 },
      { str: 'Additional body text to ensure the body font size is dominant on page.', x: 72, y: 486, width: 400, size: 10 },
    ];
    expect(titleFromLayout(runs, 792)).toBe('REFLECTOOL: Towards Reflection-Aware Tool-Augmented Clinical Agents');
  });

  it('prefers layoutTitle over noisy first-page text while still respecting plausible PDF metadata', () => {
    const noisy = 'July 27 - August 1, 2025 ©2025 ACL\nSome other line';
    expect(guessMetaFromPdf({ Title: '' }, noisy, 'paper.pdf', 'Accurate Layout Title').title).toBe('Accurate Layout Title');
    expect(guessMetaFromPdf({ Title: 'Embedded Real Title' }, noisy, 'paper.pdf', 'Accurate Layout Title').title).toBe('Embedded Real Title');
  });
});

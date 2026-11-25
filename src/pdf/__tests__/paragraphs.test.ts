import { describe, expect, it } from 'vitest'
import { extractParagraphs, isTranslatable } from '../paragraphs'
import type { PageGeometry, Paragraph, RawTextItem } from '../types'

const page: PageGeometry = { pageIndex: 3, width: 600, height: 800 }

function item(text: string, x: number, yBaseline: number, fontSize = 12, width = text.length * fontSize * 0.5): RawTextItem {
  return { str: text, transform: [fontSize, 0, 0, fontSize, x, yBaseline], width, height: fontSize }
}

describe('extractParagraphs', () => {
  it('groups a single column and starts a new paragraph at an indent after a short line', () => {
    const paragraphs = extractParagraphs([
      item('A long opening line extends across the column', 60, 700, 12, 450),
      item('and concludes without a terminal mark', 60, 686, 12, 240),
      item('The next paragraph begins with an indent', 84, 672, 12, 425),
      item('and continues at the normal left edge.', 60, 658, 12, 230),
    ], page)

    expect(paragraphs).toEqual([
      { id: '3-0', pageIndex: 3, order: 0, kind: 'body', bbox: { x: 60, y: 88, w: 450, h: 26 },
        text: 'A long opening line extends across the column and concludes without a terminal mark' },
      { id: '3-1', pageIndex: 3, order: 1, kind: 'body', bbox: { x: 60, y: 116, w: 449, h: 26 },
        text: 'The next paragraph begins with an indent and continues at the normal left edge.' },
    ])
  })

  it('reads both columns in each band around full-width blocks', () => {
    const paragraphs = extractParagraphs([
      item('The Molecular Dynamics of Water', 95, 705, 22, 410),
      item('Abstract: We compare several models of water across a range of temperatures.', 55, 675, 12, 485),
      item('First left paragraph', 55, 640, 12, 225),
      item('runs across two lines.', 55, 626, 12, 140),
      item('Second left paragraph', 55, 595, 12, 225),
      item('also continues here.', 55, 581, 12, 145),
      item('First right paragraph', 320, 643, 12, 225),
      item('starts higher on the page.', 320, 629, 12, 145),
      item('Second right paragraph', 320, 598, 12, 225),
      item('continues down the column.', 320, 584, 12, 160),
      item('Figure 3: Water density across the full range of experimental temperatures', 55, 530, 11, 490),
      item('with results for both simulation methods shown alongside the measured values.', 55, 516, 11, 485),
      item('Left column below the figure', 55, 466, 12, 225),
      item('continues its argument.', 55, 452, 12, 145),
      item('Right column below the figure', 320, 470, 12, 225),
      item('finishes the discussion.', 320, 456, 12, 150),
    ].reverse(), page)

    expect(paragraphs.map(({ text, kind }) => [text, kind])).toEqual([
      ['The Molecular Dynamics of Water', 'heading'],
      ['Abstract: We compare several models of water across a range of temperatures.', 'body'],
      ['First left paragraph runs across two lines.', 'body'],
      ['Second left paragraph also continues here.', 'body'],
      ['First right paragraph starts higher on the page.', 'body'],
      ['Second right paragraph continues down the column.', 'body'],
      ['Figure 3: Water density across the full range of experimental temperatures with results for both simulation methods shown alongside the measured values.', 'caption'],
      ['Left column below the figure continues its argument.', 'body'],
      ['Right column below the figure finishes the discussion.', 'body'],
    ])
    expect(paragraphs.map(({ id }) => id)).toEqual(paragraphs.map((_, order) => `3-${order}`))
  })

  it('de-hyphenates lowercase continuations and preserves other hyphens', () => {
    const paragraphs = extractParagraphs([
      item('We consider the inter-', 60, 700),
      item('action between the samples and X-', 60, 686),
      item('Ray measurements.', 60, 672),
    ], page)
    expect(paragraphs.map(({ text }) => text)).toEqual(['We consider the interaction between the samples and X- Ray measurements.'])
  })

  it('preserves a compound hyphen when the prefix is hyphenated or the compound appears intact', () => {
    const paragraphs = extractParagraphs([
      item('We compare left-to-', 60, 700, 12, 440),
      item('right decoding and task-', 60, 686, 12, 440),
      item('specific training against an inter-', 60, 672, 12, 440),
      item('active baseline with task-specific tuning.', 60, 658),
    ], page)

    expect(paragraphs.map(({ text }) => text)).toEqual([
      'We compare left-to-right decoding and task-specific training against an interactive baseline with task-specific tuning.',
    ])
  })

  it('preserves the hyphen when the continuation is itself a compound', () => {
    const paragraphs = extractParagraphs([
      item('on the WMT 2014 English-', 60, 700, 12, 440),
      item('to-German translation task, improving over the existing results.', 60, 686),
    ], page)

    expect(paragraphs.map(({ text }) => text)).toEqual([
      'on the WMT 2014 English-to-German translation task, improving over the existing results.',
    ])
  })

  it('incorporates offset fraction pieces and subscripts into an inline prose row', () => {
    const paragraphs = extractParagraphs([
      item('We compute the attention scores using a scaling factor', 60, 700, 12, 440),
      item('of', 60, 686, 12, 10),
      item('1', 74, 691, 8, 4),
      item('√', 77, 686, 8, 6),
      item('d', 84, 681, 8, 4),
      item('k', 88, 678, 6, 4),
      item('. Additive attention computes the score using', 93, 686, 12, 407),
      item('a feed-forward network with a single hidden layer.', 60, 672),
    ].reverse(), page)

    expect(paragraphs.map(({ text, kind }) => [text, kind])).toEqual([
      ['We compute the attention scores using a scaling factor of 1√dk. Additive attention computes the score using a feed-forward network with a single hidden layer.', 'body'],
    ])
  })

  it('outputs one skipped display equation including its displaced pieces and number', () => {
    const paragraphs = extractParagraphs([
      item('The next equation gives the result:', 60, 728, 12, 400),
      item('Attention(Q, K, V) = softmax(', 154, 700, 12, 140),
      item('QK', 294, 708, 12, 12),
      item('T', 306, 712, 8, 5),
      item('√', 312, 700, 12, 10),
      item('d', 322, 692, 12, 6),
      item('k', 328, 690, 8, 4),
      item(')V', 332, 700, 12, 15),
      item('(1)', 494, 704, 12, 16),
      item('We use the same function in the next layer.', 60, 672, 12, 400),
    ], page)

    expect(paragraphs.map(({ text, kind }) => [text, kind])).toEqual([
      ['The next equation gives the result:', 'body'],
      ['Attention(Q, K, V) = softmax(QKT√dk)V (1)', 'other'],
      ['We use the same function in the next layer.', 'body'],
    ])
    expect(isTranslatable(paragraphs[1])).toBe(false)
  })

  it('joins a centered notice at its font’s normal spacing', () => {
    const paragraphs = extractParagraphs([
      item('Permission is granted.', 150, 725, 14, 300),
      item('Please credit the authors.', 160, 708, 14, 280),
      item('Thank you.', 262, 691, 14, 76),
      item('The main text begins well below the notice and has a tighter line spacing', 60, 640, 10, 480),
      item('and continues in the same paragraph.', 60, 628, 10, 440),
      item('It takes several lines to establish the usual spacing', 60, 616, 10, 460),
      item('and this is the final line of the text.', 60, 604, 10, 200),
    ], page)

    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0].text).toBe('Permission is granted. Please credit the authors. Thank you.')
  })

  it('keeps an abstract wrap together beneath an author grid and marginal stamp', () => {
    const paragraphs = extractParagraphs([
      item('Ada Lee', 100, 720, 10, 52),
      item('Alan Ray', 240, 720, 10, 55),
      item('Marie Tan', 360, 720, 10, 55),
      item('Grace Cho', 455, 720, 10, 57),
      item('Institute A', 95, 708, 10, 64),
      item('Institute B', 236, 708, 10, 64),
      item('Institute C', 355, 708, 10, 64),
      item('Institute D', 450, 708, 10, 64),
      item('Abstract', 268, 650, 12, 64),
      item('The model works across a range of applications with both', 145, 625, 10, 310),
      item('arXiv:2601.01234', 20, 625, 10, 124),
      item('large and limited training data.', 145, 613, 10, 140),
      item('ada@example.org alan@example.org', 180, 684, 10, 212),
    ], page)

    expect(paragraphs.filter(isTranslatable).map(({ text }) => text)).toEqual([
      'Abstract',
      'The model works across a range of applications with both large and limited training data.',
    ])
    expect(paragraphs.find(({ text }) => text.startsWith('arXiv:'))?.kind).toBe('other')
  })

  it('marks table cells, figure labels and contact lines while retaining two-column prose', () => {
    const paragraphs = extractParagraphs([
      item('NSP', 63, 730, 8, 15),
      item('Mask LM', 130, 728, 8, 35),
      item('Encoder', 110, 711, 8, 29),
      item('C', 63, 692, 8, 5),
      item('T', 130, 692, 8, 5),
      item('1', 135, 690, 5, 3),
      item('Figure 1: The two components of the encoder.', 60, 660, 12, 480),
      item('Table 1: Scores for the evaluation set.', 60, 625, 12, 480),
      item('Model', 60, 605, 12, 35),
      item('Accuracy', 152, 605, 12, 52),
      item('Baseline', 60, 591, 12, 48),
      item('92.5', 152, 591, 12, 22),
      item('https://example.org www.example.net', 60, 550, 10, 180),
      item('The first column describes the method', 60, 500, 12, 220),
      item('and why we chose it.', 60, 486, 12, 125),
      item('The second column describes the results', 320, 500, 12, 220),
      item('and how we measured them.', 320, 486, 12, 175),
    ], page)

    expect(paragraphs.filter(isTranslatable).map(({ text }) => text)).toEqual([
      'Figure 1: The two components of the encoder.',
      'Table 1: Scores for the evaluation set.',
      'The first column describes the method and why we chose it.',
      'The second column describes the results and how we measured them.',
    ])
    expect(paragraphs.filter(({ kind }) => kind === 'other').map(({ text }) => text)).toEqual(expect.arrayContaining([
      'NSP', 'Mask LM', 'Encoder', 'C', 'T1', 'Model', 'Accuracy', 'Baseline', '92.5', 'https://example.org www.example.net',
    ]))
  })

  it('keeps standalone footnote marks out of prose rows', () => {
    const paragraphs = extractParagraphs([
      item('The first line continues with a reference', 60, 700, 12, 360),
      item('∗', 420, 706, 7, 4),
      item('† ‡', 90, 693, 7, 10),
      item('and finishes here with the remaining evidence.', 60, 686, 12, 270),
    ], page)

    expect(paragraphs.filter(isTranslatable).map(({ text }) => text)).toEqual([
      'The first line continues with a reference and finishes here with the remaining evidence.',
    ])
    expect(paragraphs.filter(({ kind }) => kind === 'other').map(({ text }) => text)).toEqual(['∗', '† ‡'])
  })

  it('joins CJK line wraps without introducing spaces', () => {
    const paragraphs = extractParagraphs([
      item('我们比较两种计算模型', 60, 700),
      item('并报告实验结果。', 60, 686),
    ], page)
    expect(paragraphs.map(({ text }) => text)).toEqual(['我们比较两种计算模型并报告实验结果。'])
  })

  it('isolates short running headers, footers, and page numbers', () => {
    const paragraphs = extractParagraphs([
      item('Journal of Computational Science', 60, 776),
      item('Several factors affect the experimental results.', 60, 700),
      item('Preprint submitted for review', 60, 40),
      item('14', 298, 24),
    ], page)

    expect(paragraphs.map(({ text, kind }) => [text, kind])).toEqual([
      ['Journal of Computational Science', 'other'],
      ['Several factors affect the experimental results.', 'body'],
      ['Preprint submitted for review', 'other'],
      ['14', 'other'],
    ])
  })

  it.each(['1 Introduction', '2.3 Experimental Setup', 'III. Results', 'A. Supplementary Material', 'Abstract', 'References'])(
    'recognizes the same-size heading %s and keeps the following prose separate',
    (heading) => {
      const paragraphs = extractParagraphs([
        item('The preceding line fills the column', 60, 700, 12, 450),
        item(heading, 60, 686),
        item('We include results from all of the experiments.', 60, 672),
      ], page)

      expect(paragraphs.map(({ kind }) => kind)).toEqual(['body', 'heading', 'body'])
      expect(paragraphs[1].text).toBe(heading)
    },
  )

  it('uses both item gaps and whitespace boxes to recover word spacing', () => {
    const paragraphs = extractParagraphs([
      item(' of', 151, 700, 12, 15),
      item('A', 60, 700, 12, 6),
      item(' ', 66, 700, 12, 0),
      item('wide', 66, 700, 12, 23),
      item('range', 93, 699, 12, 25),
      item('tests', 118.5, 700, 12, 28),
      item('topics', 170, 700, 12, 29),
    ], page)

    expect(paragraphs.map(({ text }) => text)).toEqual(['A wide rangetests of topics'])
    expect(paragraphs[0].bbox).toEqual({ x: 60, y: 88, w: 139, h: 13 })
  })

  it('isolates a rotated arXiv stamp even when its baseline matches the body', () => {
    const stamp = item('arXiv:2601.01234', 15, 700, 10, 105)
    stamp.transform = [0, 10, -10, 0, 15, 700]
    const paragraphs = extractParagraphs([
      item('The main text begins here', 60, 700),
      stamp,
      item('and continues here.', 60, 686),
    ], page)

    expect(paragraphs.map(({ text, kind }) => [text, kind])).toEqual([
      ['The main text begins here and continues here.', 'body'],
      ['arXiv:2601.01234', 'other'],
    ])
  })

  it('uses item height when the font scale is unavailable', () => {
    const raw = item('Font height fallback', 60, 700, 11)
    raw.transform[3] = 0
    const [paragraph] = extractParagraphs([raw], page)

    expect(paragraph.bbox).toEqual({ x: 60, y: 89, w: raw.width, h: 11 })
  })
})

describe('isTranslatable', () => {
  function paragraph(text: string, kind: Paragraph['kind'] = 'body'): Paragraph {
    return { id: '3-0', pageIndex: 3, order: 0, text, kind, bbox: { x: 0, y: 0, w: 1, h: 1 } }
  }

  it('keeps prose, headings and captions with sufficient letters', () => {
    expect(isTranslatable(paragraph('Several different methods were examined.'))).toBe(true)
    expect(isTranslatable(paragraph('2.3 Experimental Setup', 'heading'))).toBe(true)
    expect(isTranslatable(paragraph('图 3：实验结果', 'caption'))).toBe(true)
    expect(isTranslatable(paragraph('We use x = 3 in the calculation.'))).toBe(true)
  })

  it('filters other blocks, numbers, formulas and fragments', () => {
    expect(isTranslatable(paragraph('Running header', 'other'))).toBe(false)
    expect(isTranslatable(paragraph('134'))).toBe(false)
    expect(isTranslatable(paragraph('E = mc²'))).toBe(false)
    expect(isTranslatable(paragraph('x + y = z'))).toBe(false)
    expect(isTranslatable(paragraph('u v w = 0'))).toBe(false)
    expect(isTranslatable(paragraph('sin(x) = cos(y)'))).toBe(false)
    expect(isTranslatable(paragraph('α ≤ β'))).toBe(false)
    expect(isTranslatable(paragraph('Hi'))).toBe(false)
  })
})

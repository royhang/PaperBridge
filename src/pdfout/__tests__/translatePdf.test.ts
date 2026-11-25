import { describe, expect, it, vi } from 'vitest';
import type { ShowOp } from '../engine';
import { buildLines, unionBox, type Block } from '../layout';
import { buildJob, checkItem, joinLineTexts, checkTranslation, isMathFont, reemitOp, retryHint, splitJoined, withRetry, type Job, type PageItem } from '../translatePdf';

let idx = 0;
function op(text: string, x: number, y: number, o: Partial<ShowOp> = {}): ShowOp {
  const size = o.size ?? 10;
  const index = o.index ?? idx++;
  return {
    index,
    owner: '',
    opIndex: index,
    id: `#${index}`,
    x,
    y,
    width: text.length * size * 0.5,
    size,
    rotated: false,
    fontRes: 'F1',
    baseFont: 'Times-Roman',
    text,
    op: 'Tj',
    tfSize: size,
    state: { Tc: 0, Tw: 0, Tz: 100, Ts: 0, Tr: 0, fill: [0, 0, 0] },
    trm: [size, 0, 0, size, x, y],
    raw: `(${text})`,
    ...o,
  };
}


describe('isMathFont', () => {
  it('detects TeX and other math fonts', () => {
    for (const f of ['CMMI10', 'CMSY7', 'CMEX10', 'MSBM10', 'CambriaMath', 'STIXGeneral', 'LMMathItalic10-Regular', 'Symbol']) expect(isMathFont(f), f).toBe(true);
    for (const f of ['CMR10', 'NimbusRomNo9L-Regu', 'Times-Roman', 'CMBX12', 'Helvetica']) expect(isMathFont(f), f).toBe(false);
  });
});

describe('buildLines', () => {
  it('keeps a chain of maths glyphs and scripts on its text line ("matrices W_i^Q ∈ ℝ^{d_model×d_k}, W_i^K ∈ …")', () => {
    const m = (t: string, x: number, y: number, size: number, font = 'CMMI10') => op(t, x, y, { size, baseFont: font, width: t.length * size * 0.5 });
    const ops = [
      op('Where the projections are parameter matrices', 108, 578.7, { width: 177 }),
      m('W', 288, 578.7, 10), m('i', 297, 575.9, 7), m('Q', 297, 583.5, 7),
      m('∈', 306, 578.7, 10, 'CMSY10'), m('R', 316, 578.7, 10, 'MSBM10'),
      m('d', 323, 582.3, 7), op('model', 327, 581.3, { size: 5, width: 12 }), m('×d', 340, 582.3, 7, 'CMSY7'), m('k', 350, 581.3, 5, 'CMMI5'),
      op(',', 355, 578.7, { width: 2.5 }), m('W', 359, 578.7, 10), m('i', 368, 576.1, 7), m('K', 368, 582.3, 7),
      // footnote text of the other column at the same height stays apart
      op('1 Footnote of the right column', 540, 579, { size: 8, width: 110 }),
    ];
    const lines = buildLines(ops, { gap: 1.45 });
    const main = lines.find((l) => l.text.startsWith('Where'))!;
    expect(main.ops.length).toBe(14);
    expect(main.size).toBe(10);
    expect(lines.some((l) => l.text.startsWith('1 Footnote'))).toBe(true);
  });
});

/** a text-flow block of the given ops, the way layout.ts builds it */
function block(ops: ShowOp[], extra: Partial<Block> = {}): Block {
  const lines = buildLines(ops, { gap: 1.45 });
  const box = unionBox(ops.map((o) => ({ x0: o.x, x1: o.x + o.width, y0: o.y - 2.4, y1: o.y + 8 })));
  return { id: 'b', kind: 'body', region: 'text', lines, ops, box, limit: box, size: 10, pitch: 12, indent: 0, align: 'justify', bold: false, color: [0, 0, 0], order: 0, translate: true, ...extra };
}

describe('buildJob', () => {
  it('turns math-font runs and sub/superscripts into placeholders and joins lines', () => {
    const ops = [
      op('We use a model of size ', 100, 690),
      op('d', 210, 690, { baseFont: 'CMMI10' }),
      op('model', 215, 688, { size: 7, baseFont: 'CMR7' }),
      op(' for all inter-', 240, 690),
      op('nal layers.', 100, 678),
    ];
    const job = buildJob(block(ops)) as Job;
    expect(job.source).toBe('We use a model of size {v0} for all internal layers.');
    expect(job.formulas).toHaveLength(1);
    expect(job.formulas[0].ops.map((o) => o.text)).toEqual(['d', 'model']);
    expect(job.formulas[0].baseline).toBe(690);
    expect(job.box.top).toBeCloseTo(698);
  });

  it('keeps icon glyphs (FontAwesome, unmapped codes) as placeholders', () => {
    const ops = [
      op('Specifically, ‘', 100, 690, { width: 60 }),
      op('\uFFFF', 160, 690, { baseFont: 'FontAwesome', width: 8 }),
      op('’ indicates free text and ‘', 169, 690, { width: 110 }),
      op('\uE001', 280, 690, { baseFont: 'Arial', width: 8 }),
      op('’ an image.', 289, 690, { width: 45 }),
    ];
    const job = buildJob(block(ops)) as Job;
    expect(job.source).toBe('Specifically, ‘{v0}’ indicates free text and ‘{v1}’ an image.');
  });
  it('keeps compound hyphens and inserts spaces between words on gaps', () => {
    const ops = [op('English-', 100, 690), op('to-German', 100, 678), op('translation', 160, 678)];
    expect((buildJob(block(ops)) as Job).source).toBe('English-to-German translation');
  });

  it('marks bold and coloured runs with style spans', () => {
    const ops = [
      op('Quantitative analysis.', 100, 690, { baseFont: 'NimbusRomNo9L-Medi' }),
      op('We follow', 220, 690),
      op('[24]', 270, 690, { state: { Tc: 0, Tw: 0, Tz: 100, Ts: 0, Tr: 0, fill: [0, 0.5, 0] } }),
      op('closely.', 295, 690),
    ];
    const job = buildJob(block(ops)) as Job;
    expect(job.source).toBe('<s1>Quantitative analysis.</s1> We follow <s2>[24]</s2> closely.');
    expect(job.styles).toEqual([
      { bold: false, color: [0, 0, 0] },
      { bold: true, color: [0, 0, 0] },
      { bold: false, color: [0, 0.5, 0] },
    ]);
  });

  it('keeps form-xobject text but refuses rotated, invisible or wordless blocks', () => {
    expect(typeof buildJob(block([op('Hello world', 100, 690, { index: -1, owner: 'Im1', id: 'Im1#3' })]))).toBe('object');
    expect(buildJob(block([op('Hello world', 100, 690, { rotated: true })]))).toBe('rotated text');
    expect(buildJob(block([op('Hello world', 100, 690, { state: { Tc: 0, Tw: 0, Tz: 100, Ts: 0, Tr: 3, fill: [0, 0, 0] } })]))).toMatch(/invisible/);
    expect(buildJob(block([op('(1)', 100, 690)]))).toBe('no words');
  });

  it('keeps a raised radical sign on its own baseline, not the line above', () => {
    const ops = [
      op('queries and keys of dimension', 108, 403.8),
      op(', and values of dimension', 241.7, 403.8, { width: 102 }),
      op('query with all keys, divide each by', 108, 392.8, { width: 139.6 }),
      op('√', 250, 400.6, { baseFont: 'CMSY10', width: 8.3 }),
      op('d', 258.4, 392.8, { baseFont: 'CMMI10', width: 5.2 }),
      op('k', 263.5, 391.4, { baseFont: 'CMMI7', size: 7, width: 4.2 }),
    ];
    const job = buildJob(block(ops)) as Job;
    expect(job.formulas).toHaveLength(1);
    expect(job.formulas[0].ops.map((o) => o.text)).toEqual(['√', 'd', 'k']);
    expect(job.source).toMatch(/divide each by \{v0\}$/);
  });
});

describe('checkTranslation', () => {
  const src = 'Let {v0} be the loss of <s1>Model A</s1> on 56.4% of {v1} cases.';
  it('accepts a faithful translation and normalises placeholders', () => {
    expect(checkTranslation(src, 2, '设 { v0 } 为<s1>模型 A</s1>在 {v1} 中 56.4% 案例上的损失。', 'zh-CN')).toEqual({ ok: true, text: '设 {v0} 为<s1>模型 A</s1>在 {v1} 中 56.4% 案例上的损失。' });
  });
  it('rejects dropped, duplicated or invented placeholders', () => {
    expect(checkTranslation(src, 2, '设 {v0} 为损失 56.4%。', 'zh-CN')).toMatchObject({ ok: false, status: 'placeholder', detail: 'missing {v1}' });
    expect(checkTranslation(src, 2, '{v0}{v0}{v1} 56.4%', 'zh-CN')).toMatchObject({ ok: false, status: 'placeholder' });
    expect(checkTranslation(src, 2, '{v0}{v1}{v2} 56.4%', 'zh-CN')).toMatchObject({ ok: false, status: 'placeholder', detail: 'unknown {v2}' });
  });
  it('accepts scaled numbers, units glued to numbers and "531, 889"', () => {
    expect(checkTranslation('a 3.6 billion FLOPs model (15.3/19.6 billion)', 0, '一个 36 亿 FLOPs 的模型（153/196 亿）', 'zh-CN').ok).toBe(true);
    expect(checkTranslation('the 13B, 33B, and 65 models', 0, '13B、33B 和 65B 模型', 'zh-CN').ok).toBe(true);
    expect(checkTranslation('We consider 531, 889 articles', 0, '我们考察了 531,889 篇文章', 'zh-CN').ok).toBe(true);
  });
  it('flags a translation that leaves most of the source out', () => {
    const src = 'Somewhat surprisingly, the RPN still leads to a competitive result (55.1%) when using the top-ranked';
    expect(checkTranslation(src, 0, '令人惊讶的是，当使用排名靠前的', 'zh-CN').ok).toBe(false);
    expect(checkTranslation(src.replace('(55.1%) ', ''), 0, '令人惊讶的是，当使用排名靠前的', 'zh-CN')).toMatchObject({ ok: false, status: 'short' });
    expect(checkTranslation(src, 0, '令人惊讶的是，RPN 在使用排名靠前的提议时仍取得了有竞争力的结果（55.1%）', 'zh-CN').ok).toBe(true);
  });
  it('tells the retry why and whether the text is a fragment', () => {
    expect(retryHint('short', 'a text that stops at the')).toMatch(/left part of it out.*mid-sentence/);
    expect(retryHint('numbers', 'A full sentence.')).not.toMatch(/mid-sentence/);
  });
  it('lets the lenient check skip formulas made of symbols only', () => {
    const it = { text: 'The soft-max is{v0} defined as {v1}.', job: { formulas: [{ ops: [{ text: '()' }] }, { ops: [{ text: 'p' }] }] } } as unknown as PageItem;
    expect(checkItem(it, 'softmax 定义为 {v1}。', 'zh-CN').ok).toBe(false);
    expect(checkItem(it, 'softmax 定义为 {v1}。', 'zh-CN', true).ok).toBe(true);
    expect(checkItem(it, 'softmax 定义为。', 'zh-CN', true).ok).toBe(false);
  });
  it('drops invented placeholders only in the lenient check', () => {
    const src = 'Somewhat surprisingly, the RPN still leads to a competitive result (55.1%) when using the top-ranked';
    const t = '令人略感意外的是，当使用排名靠前的{v0}时，RPN 仍然取得了具有竞争力的结果（55.1%）';
    expect(checkTranslation(src, 0, t, 'zh-CN').ok).toBe(false);
    expect(checkTranslation(src, 0, t, 'zh-CN', true)).toMatchObject({ ok: true, text: t.replace('{v0}', '') });
  });
  it('accepts large numbers written with 万 / 亿', () => {
    expect(checkTranslation('more than 400,000 question-answer pairs', 0, '超过 40 万个问答对', 'zh-CN').ok).toBe(true);
    expect(checkTranslation('1,200,000,000 tokens', 0, '12亿个词元', 'zh-CN').ok).toBe(true);
    expect(checkTranslation('more than 400,000 pairs', 0, '超过 4 万个问答对', 'zh-CN').ok).toBe(false);
  });
  it('accepts small counts written in Chinese numerals', () => {
    expect(checkTranslation('the step-1 RPN and two kinds of 3 anchors', 0, '第一步的 RPN 和两种三个锚框', 'zh-CN').ok).toBe(true);
    expect(checkTranslation('we use 12 layers', 0, '我们使用十二层', 'zh-CN').ok).toBe(false);
  });
  it('keeps the first of a repeated placeholder in the lenient (final) check only', () => {
    expect(checkTranslation('x {v0} y {v1}', 2, '甲 {v0} 乙 {v1} 丙 {v0}', 'zh-CN').ok).toBe(false);
    expect(checkTranslation('x {v0} y {v1}', 2, '甲 {v0} 乙 {v1} 丙 {v0}', 'zh-CN', true)).toEqual({ ok: true, text: '甲 {v0} 乙 {v1} 丙 ' });
  });
  it('rejects lost numbers, untranslated text and empty output', () => {
    expect(checkTranslation(src, 2, '设 {v0} 为 {v1} 中 56% 的损失', 'zh-CN')).toMatchObject({ ok: false, status: 'numbers', detail: 'numbers lost: 56.4' });
    expect(checkTranslation('GPT-4o', 0, 'GPT-4o', 'zh-CN')).toMatchObject({ ok: false, status: 'identical' });
    expect(checkTranslation('Ours', 0, 'Ours (ours)', 'zh-CN')).toMatchObject({ ok: false, status: 'identical' });
    expect(checkTranslation('Ours', 0, '  ', 'zh-CN')).toMatchObject({ ok: false, status: 'empty' });
  });
  it('does not count digits inside names (3D, GPT-4o) as numbers, but checks numbers next to CJK', () => {
    expect(checkTranslation('this 3D echocardiography image', 0, '这张三维超声心动图图像', 'zh-CN').ok).toBe(true);
    expect(checkTranslation('see Table 1 and Fig. 4', 0, '见表1和图4', 'zh-CN').ok).toBe(true);
    expect(checkTranslation('see Table 1 and Fig. 4', 0, '见表1和图', 'zh-CN')).toMatchObject({ ok: false, status: 'numbers' });
  });
  it('drops unbalanced style tags instead of failing', () => {
    expect(checkTranslation('<s1>Bold</s1> text', 0, '<s1>粗体 文本', 'zh-CN')).toEqual({ ok: true, text: '粗体 文本' });
  });
});

describe('reemitOp', () => {
  it('places the op origin at the new position, scaled', () => {
    const o = op('x', 50, 60, { tfSize: 1, trm: [10, 0, 0, 10, 50, 60], raw: '<0078>', fontRes: 'F9' });
    const s = reemitOp(o, 200, 300, 0.8);
    expect(s).toContain('/F9 1 Tf');
    expect(s).toContain('8 0 0 8 200 300 Tm');
    expect(s).toContain('<0078> Tj');
  });
  it('accounts for Tz and Ts and uses TJ for arrays', () => {
    const o = op('x', 0, 0, { tfSize: 2, state: { Tc: 0, Tw: 0, Tz: 50, Ts: 1, Tr: 0, fill: [0, 0, 0] }, trm: [5, 0, 0, 10, 0, 5], raw: '[(a)-100(b)]' });
    // M = S^-1 × Trm with S=[1,0,0,2,0,1] → [5,0,0,5,0,0]; origin at (0,Ts)×M'+(e,f) = new pos
    const s = reemitOp(o, 10, 20, 1);
    expect(s).toContain('5 0 0 5 10 15 Tm');
    expect(s).toContain('[(a)-100(b)] TJ');
  });
});

describe('withRetry', () => {
  it('retries transient errors and gives up on auth errors', async () => {
    vi.useFakeTimers();
    let n = 0;
    const p = withRetry(async () => {
      if (++n < 3) throw new TypeError('network error');
      return 'ok';
    });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(n).toBe(3);
    let m = 0;
    const q = withRetry(async () => {
      m++;
      throw new Error('HTTP 401 invalid api key');
    });
    await expect(q).rejects.toThrow('401');
    expect(m).toBe(1);
    vi.useRealTimers();
  });
});

describe('splitJoined', () => {
  const item = (a: string, b: string, fa = 0, fb = 0) =>
    ({ job: { source: a, formulas: Array(fa).fill({ ops: [{ text: 'x' }] }) }, cont: { job: { source: b, formulas: Array(fb).fill({ ops: [{ text: 'y' }] }) }, offset: fa + 1 } }) as unknown as PageItem;
  it('splits at the column-break marker when both parts get a fair share', () => {
    const it = item('Our ensemble has 3.57% top-5 error on the', 'ImageNet test set and won the 1st place.');
    expect(splitJoined(it, '我们的集成模型在 ImageNet 测试集上的错误率为 {v0} 3.57%，并获得第一名。')).toEqual(['我们的集成模型在 ImageNet 测试集上的错误率为', '3.57%，并获得第一名。']);
  });
  it('ignores a marker that leaves one column nearly empty', () => {
    const it = item('Our ensemble has 3.57% top-5 error on the', 'ImageNet test set and won the 1st place.');
    const [a, b] = splitJoined(it, '我们的集成模型在 {v0} ImageNet 测试集上的错误率为 3.57%，并获得第一名。');
    expect(a.length).toBeGreaterThan(12);
    expect(b.length).toBeGreaterThan(8);
    expect(a + b).not.toContain('{v');
  });
  it('cuts in proportion (after punctuation, never inside a word) when the marker is off', () => {
    const it = item('A long first part of the sentence goes here and more', 'second part.');
    const [a, b] = splitJoined(it, '第一部分很长，这里还有更多内容，以及其他的一些文字和 ResNet 模型，第二部分。{v0}');
    expect(a.length).toBeGreaterThan(b.length);
    expect(a + b).not.toContain('{v0}');
    expect(/Res$/.test(a)).toBe(false);
  });
  it('accepts a joined translation without the break marker', () => {
    const it = { ...item('RPNs are designed to predict proposals. In contrast to prevalent methods that use', 'pyramids of images, we introduce anchor boxes.'), text: 'RPNs are designed to predict proposals. In contrast to prevalent methods that use {v0} pyramids of images, we introduce anchor boxes.' } as PageItem;
    const check = checkItem(it, 'RPN 旨在预测候选区域。与使用图像金字塔的主流方法不同，我们引入了锚框。', 'zh-CN', true);
    expect(check.ok).toBe(true);
    const [a, b] = splitJoined(it, check.ok ? check.text : '');
    expect(a.length).toBeGreaterThan(b.length);
    expect(a + b).not.toContain('{v');
  });
  it('keeps the space of a spaced language and never cuts inside an accented word', () => {
    const it = item('Short first clause', 'A substantial fragment of similar length.');
    const [a, b] = splitJoined(it, 'Esto es {v0} una explicación que contiene palabras de longitud normal.');
    expect(`${a} ${b}`).toContain('es una');
    expect(`${a} ${b}`).toContain('explicación');
  });
  it('accepts a dropped break marker even when formulas follow it', () => {
    const it = { ...item('where {v0} is the', 'loss of {v0}.', 1, 1), text: 'where {v0} is the {v1} loss of {v2}.' } as PageItem;
    expect(checkItem(it, '其中 {v0} 是相应的损失函数 {v2}。', 'zh-CN', true).ok).toBe(true);
  });
  it('keeps punctuation that follows the break marker with the first part', () => {
    const it = item('The output is computed as a weighted sum', 'of the values, where the weight assigned to each value is computed by a compatibility function.');
    const [a, b] = splitJoined(it, '输出计算为值的加权和 {v0}，其中分配给每个值的权重由兼容性函数计算。');
    expect(a.endsWith('，')).toBe(true);
    expect(b.startsWith('其中')).toBe(true);
  });
  it('never cuts inside brackets', () => {
    const it = item('In contrast to prevalent methods [8], [9], [1], [2] that use', 'pyramids of images (Figure 1, a) or pyramids of filters (Figure 1, b), we introduce novel anchor boxes.');
    const [a, b] = splitJoined(it, '与使用图像金字塔（图 1，a）或滤波器金字塔（图 1，b）的流行方法 [8]、[9]、[1]、[2] 相比，我们引入了新颖的锚框。');
    for (const part of [a, b]) expect((part.match(/（/g) ?? []).length).toBe((part.match(/）/g) ?? []).length);
  });
  it('rejects a joined translation whose formulas cross the break', () => {
    const it = { ...item('where {v0} is the', 'loss of {v0}.', 1, 1), text: 'where {v0} is the {v1} loss of {v2}.' } as PageItem;
    expect(checkItem(it, '{v2} 的损失，其中 {v0} 是 {v1}', 'zh-CN', true).ok).toBe(false);
    expect(checkItem(it, '其中 {v0} 是 {v1} {v2} 的损失。', 'zh-CN', true).ok).toBe(true);
  });
  it('keeps formulas on their own side and renumbers the continuation', () => {
    const it = item('where {v0} is the', 'loss of {v0}.', 1, 1);
    expect(splitJoined(it, '其中 {v0} 是 {v1} {v2} 的损失。')).toEqual(['其中 {v0} 是', '{v0} 的损失。']);
  });
});

describe('joinLineTexts', () => {
  it('rejoins words hyphenated at a line end and keeps compounds', () => {
    expect(joinLineTexts(['the medical domain, as-', 'sisting with tasks'])).toBe('the medical domain, assisting with tasks');
    expect(joinLineTexts(['an English-', 'to-German model'])).toBe('an English-to-German model');
    expect(joinLineTexts(['see Section 3 -', 'and', '  more  text '])).toBe('see Section 3 - and more text');
    expect(joinLineTexts(['GPT-', '4 results'])).toBe('GPT-4 results');
    expect(joinLineTexts(['BERT-', 'Large'])).toBe('BERT-Large');
  });
});

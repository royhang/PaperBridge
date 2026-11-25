import { describe, expect, it } from 'vitest';
import { layoutParagraph, spaceMixed, stripMarkup, tokenize, type Placed } from '../typeset';

// monospace-ish fake metrics: CJK = 1em, latin = 0.5em/char, space = 0.25em
const measure = (t: string, size: number) =>
  [...t].reduce((w, c) => w + (/[\p{Script=Han}，。、；：？！（）]/u.test(c) ? 1 : c === ' ' ? 0.25 : 0.5), 0) * size;

const base = { formulaWidths: new Map<number, number>(), box: { x: 100, top: 700, w: 100, h: 40 }, size: 10, lineGap: 12, indent: 0, measure };
const texts = (r: { lines: Placed[][] }) => r.lines.map((l) => l.map((p) => (p.kind === 'text' ? p.text : `{v${p.id}}`)).join(''));

describe('spaceMixed', () => {
  it('puts a space between Han and latin words / numbers, not around tags or placeholders', () => {
    expect(spaceMixed('在ImageNet上训练50层的ResNet模型')).toBe('在 ImageNet 上训练 50 层的 ResNet 模型');
    expect(spaceMixed('提高28%的<s1>精度</s1>，见{v0}。')).toBe('提高 28% 的<s1>精度</s1>，见{v0}。');
  });
});

describe('tokenize', () => {
  it('splits CJK chars, latin words, spaces and placeholders', () => {
    expect(tokenize('模型 BLEU {v0} 达到')).toEqual([
      { kind: 'text', text: '模', breakable: true, style: 0, latin: false },
      { kind: 'text', text: '型', breakable: true, style: 0, latin: false },
      { kind: 'space', style: 0 },
      { kind: 'text', text: 'BLEU', breakable: false, style: 0, latin: true },
      { kind: 'space', style: 0 },
      { kind: 'formula', id: 0 },
      { kind: 'space', style: 0 },
      { kind: 'text', text: '达', breakable: true, style: 0, latin: false },
      { kind: 'text', text: '到', breakable: true, style: 0, latin: false },
    ]);
  });

  it('applies style spans and ignores stray tags', () => {
    const t = tokenize('<s1>定量分析</s1>为了</s2>评估');
    expect(t.filter((x) => x.kind === 'text').map((x) => (x as { style: number }).style)).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
    expect(stripMarkup('<s1>定量</s1>分析')).toBe('定量分析');
  });
});

describe('layoutParagraph', () => {
  it('breaks CJK text at the box width and keeps a comfortable line pitch', () => {
    const r = layoutParagraph({ ...base, translation: '一二三四五六七八九十甲乙丙丁戊' });
    expect(r.scale).toBe(1);
    expect(texts(r)).toEqual(['一二三四五六七八九十', '甲乙丙丁戊']);
    expect(r.lines[0][0]).toMatchObject({ kind: 'text', x: 100 });
    // original pitch 12 < 1.22em → at least 12.2
    expect(r.lines[0][0].y - r.lines[1][0].y).toBeCloseTo(12.2);
  });

  it('never starts a line with a closing punctuation mark (kinsoku)', () => {
    const r = layoutParagraph({ ...base, translation: '一二三四五六七八九十。乙丙' });
    expect(texts(r).map((l) => l[0])).not.toContain('。');
  });

  it('keeps latin words whole and places formulas with their scaled width', () => {
    const r = layoutParagraph({ ...base, box: { ...base.box, h: 100 }, formulaWidths: new Map([[0, 30]]), translation: '设 {v0} 为 transformer 的维度' });
    const all = r.lines.flat();
    expect(all.find((p) => p.kind === 'formula')).toMatchObject({ kind: 'formula', id: 0, scale: 1 });
    expect(all.some((p) => p.kind === 'text' && p.text.includes('transformer'))).toBe(true);
  });

  it('compresses the line pitch before shrinking the font', () => {
    // 3 lines at 10pt in a 32pt box: room = 32 + 3 − 11 = 24 → pitch 12.2 does not fit, 12 does
    const r = layoutParagraph({ ...base, box: { ...base.box, h: 32 }, translation: '一二三四五六七八九十'.repeat(3) });
    expect(r.scale).toBe(1);
    expect(r.pitch).toBeLessThan(12.2);
    expect(r.pitch).toBeCloseTo(12);
  });

  it('shrinks the font when needed, scaling formulas too', () => {
    const r = layoutParagraph({ ...base, translation: '这是一个很长的段落'.repeat(6) });
    expect(r.scale).toBeLessThan(1);
    expect(r.overflow).toBe(false);
    expect(r.size).toBeCloseTo(10 * r.scale);
  });

  it('uses the larger limit area before going below ~86% size', () => {
    const r = layoutParagraph({ ...base, limit: { ...base.box, h: 80 }, translation: '这是一个很长的段落'.repeat(6) });
    expect(r.area).toBe('limit');
    expect(r.scale).toBeGreaterThan(0.95);
    expect(r.height).toBeLessThanOrEqual(80 + 3);
  });

  it('applies the first-line indent', () => {
    const r = layoutParagraph({ ...base, indent: 10, translation: '甲乙' });
    expect(r.lines[0][0].x).toBe(110);
  });

  it('supports hanging indents (bullets) and keeps closing punctuation off line starts without overflowing', () => {
    const h = layoutParagraph({ ...base, box: { ...base.box, x: 110, w: 90, h: 100 }, indent: -10, translation: '•一二三四五六七八九十甲乙丙' });
    expect(h.lines[0][0].x).toBe(100);
    expect(h.lines[1][0].x).toBe(110);
    // 10 chars fill the line exactly; the 。 takes the previous char along instead of hanging out
    const k = layoutParagraph({ ...base, box: { ...base.box, h: 30 }, translation: '一二三四五六七八九十。' });
    expect(k.overflow).toBe(false);
    expect(texts(k)).toEqual(['一二三四五六七八九', '十。']);
  });

  it('justifies full lines but not the last one, and centres when asked', () => {
    const j = layoutParagraph({ ...base, align: 'justify', box: { ...base.box, w: 105 }, translation: '一二三四五六七八九十甲乙' });
    const first = j.lines[0][0] as Extract<Placed, { kind: 'text' }>;
    expect(first.spacing).toBeCloseTo(5 / 9);
    expect((j.lines[1][0] as Extract<Placed, { kind: 'text' }>).spacing).toBe(0);
    const c = layoutParagraph({ ...base, align: 'center', translation: '甲乙' });
    expect(c.lines[0][0].x).toBe(140);
  });

  it('justifies between CJK chars and at spaces, never inside latin words', () => {
    // line 1 = 一二三 Fracture 四五六七: 30 + 2.5 + 40 + 2.5 + 40 = 115 of 118 → free 3 over 6 CJK gaps + 2 spaces
    const j = layoutParagraph({ ...base, align: 'justify', box: { ...base.box, w: 118 }, translation: '一二三 Fracture 四五六七八九十甲乙' });
    const [cjk, latin, cjk2] = j.lines[0] as Extract<Placed, { kind: 'text' }>[];
    expect(latin).toMatchObject({ text: 'Fracture', latin: true, spacing: 0 });
    expect(cjk.latin).toBe(false);
    expect(cjk.spacing).toBeCloseTo(3 / 8);
    expect(latin.wordSpacing).toBeCloseTo(cjk.spacing);
    expect(cjk2.x).toBeGreaterThan(latin.x + 40);
  });

  it('caps the scale with maxScale (sibling cells share one size)', () => {
    const r = layoutParagraph({ ...base, maxScale: 0.9, translation: '甲乙' });
    expect(r.scale).toBeCloseTo(0.9);
  });

  it('reports overflow when even the minimum size does not fit', () => {
    const r = layoutParagraph({ ...base, box: { ...base.box, h: 5 }, translation: '很长'.repeat(50) });
    expect(r.overflow).toBe(true);
    expect(r.scale).toBeCloseTo(0.61, 1);
  });
});

/**
 * Layout-preserving PDF translation (approach inspired by PDFMathTranslate / BabelDOC; independent
 * implementation).
 *
 *  1. `analyzePage` (layout.ts) splits each page into typed blocks from the content stream: text flow,
 *     figure labels (incl. Form XObject text), table cells, display equations, references…
 *  2. Each translatable block becomes a job: its text with `{vN}` placeholders for inline formulas and
 *     `<sN>` spans for bold / coloured runs.
 *  3. Translations are validated (placeholders exactly once, numbers kept, really translated); failing
 *     ones are retried once without the cache, otherwise the block keeps its original text.
 *  4. Every block is laid out first (typeset.ts); only blocks that fit are erased from the content
 *     stream and redrawn (original colour, faux bold, justification), inline-formula glyphs are
 *     re-emitted from their original fonts.
 * Every step is reported per block (`PageDiag`) so problems can be traced to extraction, blocking,
 * translation, erasure or drawing.
 */
import fontkit from '@pdf-lib/fontkit';
import { PDFDict, PDFDocument, PDFRef, StandardFonts, type PDFFont } from 'pdf-lib';
import type { Paragraph } from '../pdf/types';
import { cacheWriter, translateBatch, translateText } from '../services/translate';
import { getSettings } from '../store/settings';
import { assembleInterleaved, assembleSideBySide } from './assemble';
import { PLACEHOLDER_RULE, throwIfAborted, withRetry } from './common';
import { readPageText, removeShowOps, ruleKey, type Rgb, type RuleOp, type ShowOp } from './engine';
import { getCjkSubsetter } from './fonts';
import { apply, invert, orientPage, type Matrix } from './orient';
import { analyzePage, isBoldFont, isMathFont, type Block, type BlockKind, type Box, type PageLayout, type Region } from './layout';
import { layoutParagraph, stripMarkup, type Align, type Area, type LayoutResult } from './typeset';

export { PLACEHOLDER_RULE, withRetry, isMathFont };

export type PdfMode = 'mono' | 'dual' | 'side';

export interface PdfTranslateOptions {
  docId: string;
  title: string;
  bytes: ArrayBuffer;
  mode: PdfMode;
  /** inclusive 0-based page range; pages outside stay original */
  from: number;
  to: number;
  signal?: AbortSignal;
  onProgress?: (msg: string, frac?: number) => void;
}

export interface PdfTranslateStats {
  pages: number;
  /** blocks redrawn in translation */
  paragraphs: number;
  formulas: number;
  /** translatable blocks kept in the original because they did not fit */
  overflow: number;
  /** translatable blocks kept in the original for any reason (overflow, broken placeholders…) */
  kept: number;
  skippedPages: number[];
}

// ---------------------------------------------------------------- jobs

export interface FormulaGroup {
  id: number;
  ops: ShowOp[];
  /** anchor = leftmost op origin x and the line baseline */
  x: number;
  baseline: number;
  width: number;
  /** fraction bars / radical overbars drawn as vector rules, moved with the glyphs */
  rules: RuleOp[];
}

export interface TextStyle {
  bold: boolean;
  color: Rgb;
}

export interface Job {
  box: Area;
  limit: Area;
  ops: ShowOp[];
  /** text for the translator: {vN} formula placeholders, <sN>…</sN> style spans */
  source: string;
  formulas: FormulaGroup[];
  /** vector rules drawn as text (TeX's \\_ underscore): erased with the block, the text carries "_" */
  textRules?: RuleOp[];
  /** styles[0] = the block's base style */
  styles: TextStyle[];
  size: number;
  pitch: number;
  indent: number;
  align: Align;
  minScale: number;
  minSize: number;
  /** free space below the box (em) the last line's descenders may use */
  slack: number;
  /** western font family matching the original text (latin words / digits are drawn with it) */
  latinFamily: 'serif' | 'sans';
}

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

const sameColor = (a: Rgb, b: Rgb) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 0.06;

/** Readable lower bounds for re-typeset text, by block kind. */
function minimums(kind: BlockKind, size: number): { minScale: number; minSize: number } {
  if (kind === 'label' || kind === 'cell') return { minScale: 0.7, minSize: Math.min(size, 5) };
  if (kind === 'title' || kind === 'heading') return { minScale: 0.8, minSize: Math.min(size, 7) };
  return { minScale: 0.8, minSize: Math.min(size, 6.5) };
}

const SANS = /arial|helvet|sans|calibri|verdana|tahoma|segoe|roboto|lato|inter\b|nimbussan|futura|gill/i;
/** serif / sans of the dominant (by characters) non-math font of the block */
function latinFamilyOf(ops: ShowOp[]): 'serif' | 'sans' {
  let sans = 0;
  let all = 0;
  for (const o of ops) {
    if (isMathFont(o.baseFont)) continue;
    const n = o.text.replace(/\s/g, '').length;
    all += n;
    if (SANS.test(o.baseFont)) sans += n;
  }
  return sans * 2 > all ? 'sans' : 'serif';
}

/** Fonts used to draw translations: the embedded CJK font plus standard western faces for latin runs. */
export interface DrawFonts {
  cjk: PDFFont;
  latin: Record<'serif' | 'sans', { regular: PDFFont; bold: PDFFont; chars: Set<number> }>;
}

const drawFontsCache = new WeakMap<PDFDocument, Omit<DrawFonts, 'cjk'>>();
function latinFonts(doc: PDFDocument): Omit<DrawFonts, 'cjk'> {
  let f = drawFontsCache.get(doc);
  if (!f) {
    const face = (regular: StandardFonts, bold: StandardFonts) => {
      const r = doc.embedStandardFont(regular);
      return { regular: r, bold: doc.embedStandardFont(bold), chars: new Set(r.getCharacterSet()) };
    };
    f = { latin: { serif: face(StandardFonts.TimesRoman, StandardFonts.TimesRomanBold), sans: face(StandardFonts.Helvetica, StandardFonts.HelveticaBold) } };
    drawFontsCache.set(doc, f);
  }
  return f;
}

/** Font for a run: the western face when every char is encodable in it, else the CJK font. */
function fontFor(fonts: DrawFonts, family: 'serif' | 'sans', text: string, bold: boolean, latin: boolean): { font: PDFFont; latin: boolean } {
  const face = fonts.latin[family];
  if (latin && [...text].every((c) => face.chars.has(c.codePointAt(0)!))) return { font: bold ? face.bold : face.regular, latin: true };
  return { font: fonts.cjk, latin: false };
}

/** Build the translation job of a block, or return why it can't be rewritten. */
const COMBINING: Record<string, string> = { '¨': '\u0308', '´': '\u0301', '`': '\u0300', ˆ: '\u0302', '^': '\u0302', '˜': '\u0303', '~': '\u0303', '¯': '\u0304', '˘': '\u0306', ˇ: '\u030c', '˙': '\u0307', '˚': '\u030a', '¸': '\u0327' };
/**
 * TeX sets accented letters as a letter plus a separate accent glyph ("na\\\"ive" → n a ¨ ı v e). An accent
 * glyph over a letter of a text run is folded into that letter ("naïve"); the accent op is kept as a
 * zero-text op so it is still erased with the block.
 */
function composeAccents(ops: ShowOp[]): ShowOp[] {
  const out = ops.map((o) => ({ ...o }));
  const used = new Set<ShowOp>();
  for (const acc of out) {
    const mark = COMBINING[acc.text.trim()];
    if (!mark || isMathFont(acc.baseFont)) continue;
    const cx = acc.x + acc.width / 2;
    const dist = (o: ShowOp) => (cx < o.x ? o.x - cx : cx > o.x + o.width ? cx - o.x - o.width : 0);
    const host = out
      .filter((o) => o !== acc && o.text.trim() && !isMathFont(o.baseFont) && !COMBINING[o.text.trim()] && dist(o) < acc.width && Math.abs(o.y - acc.y) < o.size * 0.5)
      .sort((a, b) => dist(a) - dist(b))[0];
    if (!host) continue;
    // which character of the host run sits under the accent (proportional estimate)
    const chars = [...host.text];
    const k = Math.max(0, Math.min(chars.length - 1, Math.floor(((cx - host.x) / Math.max(host.width, 1e-6)) * chars.length)));
    if (!/\p{L}/u.test(chars[k])) continue;
    chars[k] = (chars[k] === 'ı' ? 'i' : chars[k] === 'ȷ' ? 'j' : chars[k]) + mark;
    host.text = chars.join('').normalize('NFC');
    used.add(acc);
  }
  // the folded accent glyphs leave the text (they are still erased: they stay in the block's ops)
  return used.size ? out.filter((o) => !used.has(o)) : out;
}

export function buildJob(block: Block): Job | string {
  const ops = block.ops;
  if (!ops.length) return 'no text';
  if (ops.some((o) => o.rotated)) return 'rotated text';
  if (ops.some((o) => o.state.Tr === 3 || o.state.Tr === 7)) return 'invisible (OCR) text';
  const lines = block.lines.map((l) => ({ baseline: l.baseline, dropCap: l.dropCap, ops: composeAccents([...l.ops].sort((a, b) => a.x - b.x)) })).sort((a, b) => b.baseline - a.baseline);
  // small caps (\textsc headings: "ABSTRACT", "1 INTRODUCTION", "I. Introduction") are drawn at the size of the capitals
  const UPPER = /^[\p{Lu}\d\s\p{P}]+$/u;
  const SC_TEXT = /^[\p{L}\d\s\p{P}]+$/u;
  const onBase = (o: ShowOp) => lines.some((l) => Math.abs(o.y - l.baseline) < o.size * 0.15);
  const lineOps = lines.flatMap((l) => l.ops);
  const capSize = Math.max(...lineOps.filter((o) => o.text.trim() && !isMathFont(o.baseFont)).map((o) => o.size), block.size);
  const smallCaps =
    (block.kind === 'heading' || block.kind === 'title') &&
    capSize > block.size * 1.1 &&
    lineOps.every((o) => !o.text.trim() || isMathFont(o.baseFont) || o.size > capSize * 0.95 || ((UPPER.test(o.text) || (o.size >= capSize * 0.68 && SC_TEXT.test(o.text))) && onBase(o)));
  const size = smallCaps ? capSize : block.size;
  // bullets, check marks, stars… keep their original glyphs (the CJK font draws them differently)
  const SYMBOL = /^[•◦▪▫■□●○‣⁃∙★☆✓✔✗✘➢►▶◆◇]+$/u;
  // icons (FontAwesome, Wingdings …) and glyphs without a Unicode value are drawn as they are
  const ICON_FONT = /FontAwesome|Wingding|Dingbat|Webding|Material(Icons|Symbols)|Icons?\b|Emoji/i;
  const UNMAPPED = /^[\uFFFF\uFFFD\uE000-\uF8FF\u{F0000}-\u{FFFFD}]+$/u;
  // a lone accent / modifier glyph (the bar of ᾱ, the hat of x̂ in a text font) belongs to its formula
  const ACCENT = /^[\p{Sk}\p{Mn}˙¨¯ˆ˜´`]+$/u;
  // inline small-caps words (e.g. "ETROLEUM" after drop-cap "P", or "NTRODUCTION"/"ntroduction" in IEEE headings)
  // sit dead on the baseline at ~70-85% of cap size — they are text, never math sub/superscripts
  const isSmallCapOp = (o: ShowOp, baseline: number) =>
    !isMathFont(o.baseFont) &&
    o.size >= size * 0.68 &&
    Math.abs(o.y - baseline) <= size * 0.12 &&
    /^[\p{L}\s\-–':.,]+$/u.test(o.text.trim());
  const smallCapOps = new Set<ShowOp>();
  for (const l of lines) {
    l.ops.forEach((o, i) => {
      if (!isSmallCapOp(o, l.baseline)) return;
      const letters = o.text.match(/\p{L}/gu)?.length ?? 0;
      const prev = l.ops[i - 1];
      const next = l.ops[i + 1];
      const adjSmallCap = (n?: ShowOp) =>
        !!n && isSmallCapOp(n, l.baseline) && Math.abs(n.size - o.size) < size * 0.08 && Math.max(n.x - (o.x + o.width), o.x - (n.x + n.width)) < size * 0.35;
      if (letters >= 2 || (letters === 1 && (adjSmallCap(prev) || adjSmallCap(next)))) smallCapOps.add(o);
    });
  }
  const script = (o: ShowOp, baseline: number) => !smallCapOps.has(o) && (o.size < size * 0.8 || Math.abs(o.y - baseline) > size * 0.18);
  // a short text-font base before a script is part of the formula: bold "z" of z₀⁰, "x" of x_class
  const bases = new Set<ShowOp>();
  for (const l of lines)
    l.ops.forEach((o, i) => {
      const next = l.ops[i + 1];
      if (next && /^\p{L}{1,2}$/u.test(o.text.trim()) && !isMathFont(o.baseFont) && !script(o, l.baseline) && script(next, l.baseline) && !(smallCaps && SC_TEXT.test(next.text)) && Math.abs(next.x - (o.x + o.width)) < size * 0.15) bases.add(o);
    });
  // ordinal suffixes ("1st", "2nd") are text, not superscript formulas
  const ordinal = (o: ShowOp, prev?: ShowOp) => /^(st|nd|rd|th)$/.test(o.text.trim()) && !!prev && /\d$/.test(prev.text) && o.x - (prev.x + prev.width) < size * 0.15;
  const formulaOps = new Set<ShowOp>();
  for (const l of lines) {
    // "10×" — a lone multiplication sign after a number reads as text (the translator keeps "10×")
    const times = (o: ShowOp, prev?: ShowOp) => /^[×]$/.test(o.text.trim()) && !!prev && /\d$/.test(prev.text.trim()) && !formulaOps.has(prev);
    const own = (o: ShowOp, i: number) =>
      !ordinal(o, l.ops[i - 1]) &&
      !times(o, l.ops[i - 1]) &&
      (bases.has(o) || isMathFont(o.baseFont) || ICON_FONT.test(o.baseFont) || UNMAPPED.test(o.text.trim()) || (o.text === '' && o.width > 0) || SYMBOL.test(o.text.trim()) || ACCENT.test(o.text.trim()) || (!!o.text.trim() && script(o, l.baseline) && !(smallCaps && SC_TEXT.test(o.text) && onBase(o))));
    l.ops.forEach((o, i) => own(o, i) && formulaOps.add(o));
    // TeX sets digits, parentheses and operators of formulas in the text font: a short such run touching a
    // formula glyph belongs to it ("√(1 − β₂)", "(1 − β₁)") — words are separated by a real space and stay text
    for (let grew = true; grew; ) {
      grew = false;
      l.ops.forEach((o, i) => {
        if (formulaOps.has(o) || !/^[\p{L}\d()[\].,+\-−=/|:;]{1,3}$/u.test(o.text.trim()) || /^\p{L}{2,3}$/u.test(o.text.trim())) return;
        const touches = (n?: ShowOp) => !!n && formulaOps.has(n) && Math.max(n.x - (o.x + o.width), o.x - (n.x + n.width)) < size * 0.12;
        if (touches(l.ops[i - 1]) || touches(l.ops[i + 1])) {
          formulaOps.add(o);
          grew = true;
        }
      });
    }
  }
  const isFormula = (o: ShowOp, _baseline: number) => formulaOps.has(o) || !o.text.trim();

  const base: TextStyle = { bold: block.bold, color: block.color };
  const styles: TextStyle[] = [base];
  const styleOf = (o: ShowOp) => {
    const st: TextStyle = { bold: isBoldFont(o.baseFont), color: o.state.fill };
    let k = styles.findIndex((s) => s.bold === st.bold && sameColor(s.color, st.color));
    if (k < 0) k = styles.push(st) - 1;
    return k;
  };

  const formulas: FormulaGroup[] = [];
  let source = '';
  let style = 0;
  let cur: FormulaGroup | null = null;
  const setStyle = (k: number) => {
    if (k === style) return;
    if (style) source += `</s${style}>`;
    if (k) source += `<s${k}>`;
    style = k;
  };
  const closeFormula = () => {
    if (!cur) return;
    cur.width = Math.max(...cur.ops.map((o) => Math.max(o.x, o.x + o.width))) - cur.x;
    source += `{v${cur.id}}`;
    cur = null;
  };
  const addSpaceIfGap = (gap: number) => {
    if (gap > size * 0.18 && source && !/\s$/.test(source)) source += ' ';
  };
  lines.forEach((line, li) => {
    if (li > 0) {
      closeFormula();
      const next = line.ops.find((o) => !isFormula(o, line.baseline))?.text.trimStart() ?? '';
      if (/\p{L}-$/u.test(source) && /^\p{Ll}/u.test(next)) {
        // "inter-\nnal" → "internal", but "English-\nto-German" keeps the hyphen
        if (!/^[^\s]*\p{L}-\p{L}/u.test(next)) source = source.slice(0, -1);
      } else if (/\p{L}-$/u.test(source) && /^[\p{Lu}\d]/u.test(next)) {
        // "GPT-\n4", "BERT-\nLarge": a real hyphen, no space
      } else if (source && !/\s$/.test(source)) source += ' ';
    } else if (line.dropCap) {
      const dc = line.dropCap;
      const firstOp = line.ops.find((o) => o.text.trim());
      const needsSpace =
        dc.text.trim() === 'A' &&
        !!firstOp &&
        /^\p{Ll}/u.test(firstOp.text.trim()) &&
        firstOp.size >= size * 0.9 &&
        firstOp.x - (dc.x + dc.width) > size * 0.25;
      source += dc.text.trim() + (needsSpace ? ' ' : '');
    }
    let prevEnd = Number.NaN;
    for (const op of line.ops) {
      // an undecodable glyph of a math font is still a formula glyph (re-emitted), not a word break
      if (!op.text.trim() && !(op.text === '' && isMathFont(op.baseFont))) {
        // a glyph-level space (common in figure text): a word break, never a formula — inside a
        // formula it is just part of the group's extent
        if (cur) cur.ops.push(op);
        else if (source && !/\s$/.test(source)) source += ' ';
        prevEnd = Math.max(Number.isNaN(prevEnd) ? -Infinity : prevEnd, op.x + op.width);
        continue;
      }
      if (!Number.isNaN(prevEnd)) addSpaceIfGap(op.x - prevEnd);
      if (isFormula(op, line.baseline)) {
        if (!cur || op.x - prevEnd > size * 0.5) {
          closeFormula();
          setStyle(0);
          if (!Number.isNaN(prevEnd)) addSpaceIfGap(op.x - prevEnd);
          cur = { id: formulas.length, ops: [], x: op.x, baseline: line.baseline, width: 0, rules: [] };
          formulas.push(cur);
        }
        cur.ops.push(op);
        cur.x = Math.min(cur.x, op.x);
      } else {
        closeFormula();
        const k = styleOf(op);
        if (k !== style) {
          // keep a leading space outside of the span
          if (/^\s/.test(op.text) && source && !/\s$/.test(source)) source += ' ';
          setStyle(k);
          source += op.text.replace(/^\s+/, '');
        } else source += op.text;
      }
      prevEnd = Math.max(Number.isNaN(prevEnd) ? -Infinity : prevEnd, op.x + op.width);
    }
  });
  closeFormula();
  setStyle(0);
  // formula glyphs are re-emitted with their own operators; the " operator also sets spacing → unsafe
  if (formulas.some((g) => g.ops.some((o) => o.op === '"'))) return 'formula drawn with the " operator';
  source = source
    .replace(/\s+/g, ' ')
    .replace(/<s(\d+)>\s+/g, ' <s$1>')
    .replace(/\s+<\/s(\d+)>/g, '</s$1> ')
    .replace(/<s(\d+)><\/s\1>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const letters = stripMarkup(source).replace(/\{v\d+\}/g, '').match(/\p{L}/gu)?.length ?? 0;
  if (letters < 2) return 'no words';

  const first = lines[0];
  const last = lines[lines.length - 1];
  const top = first.baseline + size * 0.8;
  const bottom = last.baseline - size * 0.24;
  // hanging indent (bullet / numbered items): continuation lines start right of the first line
  const x0s = lines.map((l) => Math.min(...l.ops.map((o) => o.x)));
  const rest = x0s.slice(1);
  const hang = block.align !== 'center' && rest.length && Math.min(...rest) - x0s[0] > size * 0.5 && Math.max(...rest) - Math.min(...rest) < size * 0.3 ? Math.min(...rest) - x0s[0] : 0;
  // a leading list marker re-emitted as {v0} occupies the whole hang, so the text starts where it did
  const marker = formulas[0];
  if (hang && marker && source.startsWith('{v0}') && marker.ops.every((o) => !o.text.trim() || SYMBOL.test(o.text.trim()) || isMathFont(o.baseFont)))
    marker.width = Math.max(marker.width, hang);
  const box: Area = { x: block.box.x0 + hang, top, w: block.box.x1 - block.box.x0 - hang, h: top - bottom };
  const lim = block.limit;
  const limX = Math.min(lim.x0 + hang, box.x);
  const limit: Area = { x: limX, top, w: Math.max(lim.x1, block.box.x1) - limX, h: Math.max(box.h, top - lim.y0) };
  return {
    box,
    limit,
    ops,
    source,
    formulas,
    styles,
    size,
    pitch: block.pitch || median(lines.slice(1).map((l, i) => lines[i].baseline - l.baseline)),
    indent: hang ? -hang : block.indent,
    align: block.align,
    slack: Math.max(0, Math.min(0.3, (limit.h - box.h) / size)),
    latinFamily: latinFamilyOf(ops),
    ...minimums(block.kind, size),
  };
}

/**
 * Attach thin vector rules (fraction bars, radical overbars) that overlap a formula group's
 * glyph extent, so they move together with it.
 */
export function attachRules(job: Job, rules: RuleOp[], used: Set<number | string>): void {
  for (const g of job.formulas) {
    const x0 = g.x;
    const x1 = g.x + g.width;
    const y0 = Math.min(...g.ops.map((o) => o.y - o.size * 0.4));
    const y1 = Math.max(...g.ops.map((o) => o.y + o.size * 0.9));
    for (const r of rules) {
      if (used.has(ruleKey(r))) continue;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      if (r.h > 1.5 || cx < x0 - 1 || cx > x1 + 1 || cy < y0 || cy > y1 || r.w > (x1 - x0) * 1.6 + 4) continue;
      g.rules.push(r);
      used.add(ruleKey(r));
      g.width = Math.max(g.width, r.x + r.w - g.x);
    }
  }
}

// ---------------------------------------------------------------- validation

export type CheckResult = { ok: true; text: string } | { ok: false; status: 'empty' | 'placeholder' | 'numbers' | 'identical' | 'short'; detail: string };

const PLACEHOLDER_ANY = /\{\s*v\s*(\d+)\s*\}/g;
/** standalone numbers (not parts of names such as 3D, GPT-4o, Qwen2.5-7B) */
const SCALE: Record<string, number> = { thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, billion: 1e9, b: 1e9, trillion: 1e12 };
/** "3.6 billion" may legitimately become "36 亿", "1.28 million" → "128 万": the number's other spellings. */
function scaledForms(source: string, n: string): string[] {
  const esc = n.replace('.', '\\.');
  const m = new RegExp(`(?<![\\d.])${esc}(?:\\s*[/,]\\s*\\d+(?:\\.\\d+)?)*\\s*(thousand|million|billion|trillion|[kmb])\\b`, 'i').exec(source);
  if (!m) return [];
  const v = Number(n) * SCALE[m[1].toLowerCase()];
  const fmt = (x: number) => String(Number(x.toPrecision(10)));
  return [1e3, 1e4, 1e8, 1e6, 1e9, 1].map((d) => fmt(v / d));
}
/** Large numbers in Chinese units: "400,000" → "40 万", "1,200,000,000" → "12 亿". */
function inChineseUnits(n: string, text: string): boolean {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1e4) return false;
  const fmt = (x: number) => String(Number(x.toPrecision(10)));
  return [
    [1e4, '万'],
    [1e8, '亿'],
  ].some(([d, u]) => new RegExp(`(?<![\\d.])${fmt(v / (d as number)).replace('.', '\\.')}\\s*${u}`).test(text));
}
const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
/** Small counts written out in Chinese: "step-1" → "第一步", "two kinds" → "两种", "3 times" → "三次". */
function inWords(n: string, text: string): boolean {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1 || v > 10) return false;
  const forms = v === 2 ? ['二', '两'] : [CN_DIGITS[v]];
  return forms.some((f) => new RegExp(`第${f}|${f}(?:个|种|步|次|项|类|层|组|阶段|部分|倍|篇|条|位|点|轮|方面)`).test(text));
}
const numbersOf = (s: string) => (s.replace(/(\d),\s?(?=\d{3}\b)/g, '$1').match(/(?<![A-Za-z\d.])\d+(?:\.\d+)?(?![A-Za-z\d])/gu) ?? []);

/**
 * Validate a translation of `source` with `count` formula placeholders. On success returns the
 * normalised text (placeholders as `{vN}`, broken style tags removed).
 */
/**
 * `lenient` (the final check, after the retry): a placeholder the model repeated is kept once — the first
 * occurrence — instead of throwing the whole translation away.
 */
export function checkTranslation(source: string, count: number, translation: string, targetLang?: string, lenient = false, optional?: Set<number>): CheckResult {
  const t = translation?.trim() ?? '';
  if (!t) return { ok: false, status: 'empty', detail: 'empty translation' };
  const seen = new Map<number, number>();
  let text = t.replace(PLACEHOLDER_ANY, (_, n: string) => {
    seen.set(Number(n), (seen.get(Number(n)) ?? 0) + 1);
    return `{v${Number(n)}}`;
  });
  // lenient: placeholders the model invented (a gap for the unfinished end of a fragment) are dropped
  if (lenient && [...seen.keys()].some((k) => k >= count)) {
    text = text.replace(/\{v(\d+)\}/g, (m, n: string) => (Number(n) >= count ? '' : m));
    for (const k of [...seen.keys()]) if (k >= count) seen.delete(k);
  }
  if (lenient && [...seen.values()].some((c) => c > 1)) {
    const done = new Set<number>();
    text = text.replace(/\{v(\d+)\}/g, (m, n: string) => (done.has(Number(n)) ? '' : (done.add(Number(n)), m)));
    for (const k of seen.keys()) seen.set(k, 1);
  }
  const missing = [...Array(count).keys()].filter((i) => !seen.has(i) && !(lenient && optional?.has(i)));
  const dup = [...seen].filter(([, c]) => c > 1).map(([i]) => i);
  const unknown = [...seen.keys()].filter((i) => i >= count);
  if (missing.length || dup.length || unknown.length)
    return {
      ok: false,
      status: 'placeholder',
      detail: [missing.length && `missing {v${missing.join('},{v')}}`, dup.length && `duplicated {v${dup.join('},{v')}}`, unknown.length && `unknown {v${unknown.join('},{v')}}`].filter(Boolean).join('; '),
    };
  const plain = (s: string) => stripMarkup(s).replace(/\{v\d+\}/g, ' ');
  // the translation may glue units to numbers ("65B", "10倍"): every digit run counts there
  const have = new Set([...numbersOf(plain(text)), ...(plain(text).replace(/(\d),\s?(?=\d{3}\b)/g, '$1').match(/\d+(?:\.\d+)?/g) ?? [])]);
  const lost = numbersOf(plain(source)).filter((n) => !have.has(n) && !scaledForms(plain(source), n).some((f) => have.has(f)) && !inWords(n, plain(text)) && !inChineseUnits(n, plain(text)));
  if (lost.length) return { ok: false, status: 'numbers', detail: `numbers lost: ${[...new Set(lost)].join(', ')}` };
  const squash = (s: string) => plain(s).replace(/\s/g, '').toLowerCase();
  if (squash(text) === squash(source)) return { ok: false, status: 'identical', detail: 'translation equals the original' };
  if (targetLang?.startsWith('zh') && !/\p{Script=Han}/u.test(plain(text))) return { ok: false, status: 'identical', detail: 'no Chinese in the translation' };
  if (targetLang?.startsWith('zh') && tooShort(plain(source), plain(text))) return { ok: false, status: 'short', detail: 'translation much shorter than the original' };
  // drop style tags that are not balanced (the typesetter ignores them, but keep the text clean)
  let clean = text;
  for (const m of new Set([...text.matchAll(/<\/?s(\d+)>/g)].map((x) => x[1]))) {
    const open = text.split(`<s${m}>`).length - 1;
    const close = text.split(`</s${m}>`).length - 1;
    if (open !== close) clean = clean.replaceAll(`<s${m}>`, '').replaceAll(`</s${m}>`, '');
  }
  return { ok: true, text: clean };
}

// ---------------------------------------------------------------- planning

/** One translatable block of a page. */
export interface PageItem {
  para: Paragraph;
  block: Block;
  job: Job;
  /** text sent to the translator ({vN} placeholders, <sN> style spans) */
  text: string;
  /**
   * The paragraph continues in the next column: its continuation is translated together with it (one
   * text, `{v<offset-1>}` marks the column break) and split again when drawing.
   */
  cont?: { para: Paragraph; block: Block; job: Job; offset: number; crossPage?: boolean };
}

const words = (it: PageItem) => stripMarkup(it.job.source).replace(/\{v\d+\}/g, ' ').trim().split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
/** Both sides look like running text (not a figure label such as "SS" ⟶ "RPN+VGG" or "… the" ⟶ "anchor"). */
// words that open a new sentence, not the middle of one ("… of the original" ⟶ "The MLP contains …")
const STARTER = /^(?:The|We|In|This|These|Those|Our|An?|For|To|It|Its|As|However|Then|Thus|Hence|Therefore|Finally|Here|Note|First|Second|Third|Moreover|Furthermore|Also|Since|When|While|If|Each|All|Both|There|They|Such|After|Before|Unlike|Similarly|Specifically|Overall|Instead|Although|Because)\b|^[A-Z][a-z]+,|^\(?[a-z]\)\s/;
const continues = (a: PageItem, b: PageItem) => {
  const head = stripMarkup(b.job.source).replace(/\{v\d+\}/g, ' ').trim();
  // a one-line continuation must finish its sentence (otherwise it is a figure title or plot label)
  return words(a) >= 4 && (b.block.lines.length >= 2 ? words(b) >= 3 : SENTENCE_END.test(head)) && !STARTER.test(head);
};

/** Number of {vN} placeholders in an item's text (a joined continuation adds the break marker and its formulas). */
export function itemFormulaCount(item: Pick<PageItem, 'job' | 'cont'>): number {
  return item.cont ? item.cont.offset + item.cont.job.formulas.length : item.job.formulas.length;
}

/**
 * checkTranslation for a planned item. The column-break marker of a joined item is optional: a model that
 * drops it still translated everything, and splitJoined then cuts the text in proportion.
 */
export function checkItem(item: Pick<PageItem, 'text' | 'job' | 'cont'>, translation: string | undefined, targetLang?: string, lenient = false): CheckResult {
  let t = translation ?? '';
  if (item.cont && t.trim()) {
    const marker = item.cont.offset - 1;
    if (![...t.matchAll(PLACEHOLDER_ANY)].some((m) => Number(m[1]) === marker)) t = `${t.trimEnd()} {v${marker}}`;
  }
  // formulas without letters or digits (a stray "()" or "·") may be left out by the lenient check
  const formulas = [...item.job.formulas, ...(item.cont ? [null, ...item.cont.job.formulas] : [])];
  const optional = new Set(formulas.flatMap((f, i) => (f && !f.ops.some((o) => /[\p{L}\p{N}]/u.test(o.text)) ? [i] : [])));
  const check = checkTranslation(item.text, itemFormulaCount(item), t, targetLang, lenient, optional);
  if (!check.ok || !item.cont) return check;
  // both parts must get text, and every formula has to stay on its own side of the break
  const marker = item.cont.offset - 1;
  const [a, b] = splitJoined(item as PageItem, check.text);
  const empty = (x: string) => !stripMarkup(x).replace(/\{v\d+\}/g, '').trim();
  if ([...a.matchAll(/\{v(\d+)\}/g)].some((m) => Number(m[1]) >= marker) || empty(a) || empty(b) || /\{v-/.test(b))
    return { ok: false, status: 'placeholder', detail: 'formulas moved across the column / page break' };
  return check;
}

const shiftPlaceholders = (t: string, by: number) => t.replace(/\{v(\d+)\}/g, (_, n: string) => `{v${Number(n) + by}}`);
const SENTENCE_END = /[.!?:;。！？；：”"')\]]$/;

/**
 * Join a body paragraph cut at the bottom of a column with its continuation at the top of the next column
 * (same page): translators drop or rewrite the unfinished tail of a fragment ("… top-5 error on the").
 */
function joinContinuations(items: PageItem[]): PageItem[] {
  const out: PageItem[] = [];
  const used = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const a = items[i];
    // the next paragraph of the text flow (a footnote or figure text may come between in reading order)
    let j = i + 1;
    while (j < items.length && (used.has(j) || items[j].block.region !== 'text' || !['body', 'heading'].includes(items[j].block.kind))) j++;
    const b = items[j];
    const A = a.block;
    const B = b?.block;
    const ok =
      !!b && !a.cont && A.kind === 'body' && B!.kind === 'body' && A.region === 'text' && B!.region === 'text' &&
      // B starts a new column to the right, higher up than A's end
      B!.box.x0 >= A.box.x1 - A.size && B!.box.y1 > A.box.y0 + A.size &&
      !SENTENCE_END.test(stripMarkup(a.job.source).replace(/\{v\d+\}/g, '').trim()) &&
      // the continuation does not open a new paragraph (indented first line / capitalised run-in)
      B!.indent <= B!.size * 0.5 && !/^<s\d+>/.test(b.job.source) && continues(a, b) &&
      a.job.source.length + b.job.source.length < 6000;
    if (!ok) {
      out.push(a);
      continue;
    }
    const offset = a.job.formulas.length + 1;
    out.push({ ...a, text: joinedText(a, b, offset), cont: { para: b.para, block: B!, job: b.job, offset } });
    used.add(j);
  }
  return out;
}

const joinedText = (a: PageItem, b: PageItem, offset: number) => `${a.job.source} {v${offset - 1}} ${shiftPlaceholders(b.job.source, offset)}`;

/**
 * Join the last body paragraph of `prev` with its continuation at the top of `next` (a sentence cut by the
 * page break): the pair is translated as one item of `prev`; `next` draws its share via `incoming`.
 * Both plans are modified; call it before either plan's items are translated.
 */
export function linkPages(prev: PagePlan, next: PagePlan): void {
  if (prev.skipped || next.skipped || next.incoming || prev.pageIndex + 1 !== next.pageIndex) return;
  // running heads / feet: one line that repeats on the other page, or sits in the top margin
  const shape = (t: string) => t.toLowerCase().replace(/[\d\s]+/g, '');
  const running = (it: PageItem, other: PagePlan, top = Infinity) =>
    it.block.lines.length <= 2 && (it.block.box.y1 > top - 60 || other.paragraphs.some((p) => shape(p.text) === shape(stripMarkup(it.job.source).replace(/\{v\d+\}/g, ''))));
  const flow = (it: PageItem) => it.block.region === 'text' && (it.block.kind === 'body' || it.block.kind === 'heading');
  // the last flowing paragraph of the previous page (footnotes after it are fine)
  const ai = prev.items.map((it) => flow(it) && !running(it, next)).lastIndexOf(true);
  const a = prev.items[ai];
  if (!a || a.cont || a.block.kind !== 'body') return;
  // the first flowing paragraph of the next page, skipping a running head
  // (and short labels of a figure at the top of the page)
  const label = (it: PageItem) => it.block.lines.length === 1 && !SENTENCE_END.test(stripMarkup(it.job.source).trim());
  const bi = next.items.findIndex((it) => flow(it) && !running(it, prev, next.top) && !label(it));
  const b = next.items[bi];
  // (an item already joined across its own column break cannot take a third part)
  if (!b || b.cont || b.block.kind !== 'body' || !continues(a, b)) return;
  if (next.items.slice(0, bi).some((it) => flow(it) && it.block.kind === 'heading' && !running(it, prev, next.top))) return;
  // a display equation between the two parts belongs to the sentence: joining would move it
  // (directly next to the text: labels of a figure, followed by its caption, do not count)
  const eqBetween = (plan: PagePlan, lo: number, hi: number) => {
    const all = [...plan.items.map((it) => it.block), ...plan.kept].filter((k) => k.order > lo && k.order < hi).sort((x, y) => x.order - y.order);
    const eq = (k: Block) => k.kind === 'equation' && k.region === 'text';
    return plan === prev ? !!all[0] && eq(all[0]) : !!all.at(-1) && eq(all.at(-1)!);
  };
  if (eqBetween(prev, a.block.order, Infinity) || eqBetween(next, -Infinity, b.block.order)) return;
  if (SENTENCE_END.test(stripMarkup(a.job.source).replace(/\{v\d+\}/g, '').trim())) return;
  if (b.block.indent > b.block.size * 0.5 || /^<s\d+>/.test(b.job.source) || Math.abs(a.block.size - b.block.size) > a.block.size * 0.1) return;
  if (a.job.source.length + b.job.source.length > 6000) return;
  const offset = a.job.formulas.length + 1;
  prev.items[ai] = { ...a, text: joinedText(a, b, offset), cont: { para: b.para, block: b.block, job: b.job, offset, crossPage: true } };
  next.items = next.items.filter((_, k) => k !== bi);
  next.incoming = { fromPage: prev.pageIndex, owner: a.para.id, para: b.para, block: b.block, job: b.job };
}

/** Index in `prev.items` of the item that carries `next`'s incoming paragraph (-1: none). */
export function incomingOwner(prev: PagePlan, next: PagePlan): number {
  const inc = next.incoming;
  if (!inc || inc.fromPage !== prev.pageIndex) return -1;
  return prev.items.findIndex((it) => it.para.id === inc.owner && it.cont?.crossPage && it.cont.para.id === inc.para.id);
}

/** The share of a page's incoming paragraph, from the previous page's (validated) translations. */
export function incomingTranslation(prev: PagePlan, prevRaw: string[], next: PagePlan): string | undefined {
  const inc = next.incoming;
  if (!inc || inc.fromPage !== prev.pageIndex) return undefined;
  const k = incomingOwner(prev, next);
  const item = prev.items[k];
  const t = prevRaw[k];
  if (!item?.cont || !t) return undefined;
  const check = checkItem(item, t, targetLang(), true);
  return check.ok ? splitJoined(item, check.text)[1] || undefined : undefined;
}

/**
 * Split the translation of a joined item at its column-break marker. The marker is only trusted when both
 * parts get a fair share of the text; otherwise the text is cut in proportion to the two source lengths
 * (after punctuation if possible), never moving a formula to the wrong side.
 */
export function splitJoined(item: PageItem, text: string): [string, string] {
  const cont = item.cont!;
  const srcA = stripMarkup(item.job.source).length;
  const srcB = stripMarkup(cont.job.source).length;
  const ratio = srcA / Math.max(1, srcA + srcB);
  // remove the break marker; between two words of a spaced language it leaves one space (the cut goes before it)
  const m = new RegExp(`(\\s*)\\{v${cont.offset - 1}\\}(\\s*)`).exec(text);
  const at = m ? m.index : -1;
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
  const spaced = !!m && !!(m[1] || m[2]) && !cjk.test(text[m.index - 1] ?? '') && !cjk.test(text[m.index + m[0].length] ?? '');
  const plain = m ? text.slice(0, m.index) + (spaced ? ' ' : '') + text.slice(m.index + m[0].length) : text;
  const len = stripMarkup(plain).length;
  const fair = (cut: number) => {
    const share = stripMarkup(plain.slice(0, cut)).length / Math.max(1, len);
    return share > ratio * 0.6 && share < ratio + (1 - ratio) * 0.4;
  };
  const sidesOk = (cut: number) =>
    [...plain.matchAll(/\{v(\d+)\}/g)].every((m) => (m.index! < cut ? Number(m[1]) < cont.offset - 1 : Number(m[1]) >= cont.offset));
  let cut = at;
  if (at < 0 || !fair(at) || !sidesOk(at)) {
    // allowed window: after A's last formula, before B's first one
    const ph = [...plain.matchAll(/\{v(\d+)\}/g)];
    const lo = Math.max(0, ...ph.filter((m) => Number(m[1]) < cont.offset).map((m) => m.index! + m[0].length));
    const hi = Math.min(plain.length, ...ph.filter((m) => Number(m[1]) >= cont.offset).map((m) => m.index!));
    const target = Math.min(hi, Math.max(lo, Math.round(plain.length * ratio)));
    // positions inside a placeholder, a tag or a latin word / number are not cut points
    const unsafe = new Set<number>();
    // nor inside brackets: "（图 1，b）" stays on one side
    let depth = 0;
    for (let i = 0; i < plain.length; i++) {
      if (depth > 0) unsafe.add(i);
      if (/[(（[【]/.test(plain[i])) depth++;
      else if (/[)）\]】]/.test(plain[i])) depth = Math.max(0, depth - 1);
    }
    for (const m of plain.matchAll(/\{v\d+\}|<\/?s\d+>|[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}][\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}_.%+'’-]*/gu)) for (let i = m.index! + 1; i < m.index! + m[0].length; i++) unsafe.add(i);
    const window = Math.max(4, Math.round(plain.length * 0.12));
    let best = -1;
    let bestScore = Infinity;
    for (let i = Math.max(lo, target - window); i <= Math.min(hi, target + window); i++) {
      if (unsafe.has(i)) continue;
      // prefer cutting right after punctuation
      const score = Math.abs(i - target) - (/[，。；、：,;]/.test(plain[i - 1] ?? '') ? window : 0);
      if (score < bestScore) [best, bestScore] = [i, score];
    }
    cut = best >= 0 ? best : target;
  }
  // punctuation right after the cut closes the first part ("加权和{v1}，其中…" → "加权和，" | "其中…")
  const lead = /^\s*[，。、；：！？,.;:!?）)\]】」』”]+/.exec(plain.slice(cut))?.[0].length ?? 0;
  cut += lead;
  const a = balanceTags(plain.slice(0, cut)).trim();
  const b = shiftPlaceholders(balanceTags(plain.slice(cut)).trim(), -cont.offset);
  return [a, b];
}

/** Drop <sN> / </sN> tags without a partner (a span cut in two by the column split). */
function balanceTags(t: string): string {
  const tags = [...t.matchAll(/<(\/?)s(\d+)>/g)];
  const drop = new Set<number>();
  const open: { n: string; i: number }[] = [];
  for (const m of tags) {
    if (!m[1]) open.push({ n: m[2], i: m.index! });
    else {
      const k = open.map((o) => o.n).lastIndexOf(m[2]);
      if (k < 0) drop.add(m.index!);
      else open.splice(k, 1);
    }
  }
  open.forEach((o) => drop.add(o.i));
  return t.replace(/<\/?s\d+>/g, (m, i: number) => (drop.has(i) ? '' : m));
}

export interface PagePlan {
  pageIndex: number;
  /** reason the page can't be rewritten (it is then shown/exported unchanged) */
  skipped?: string;
  items: PageItem[];
  /** blocks kept as original (equations, references, authors, unsupported text…) */
  kept: Block[];
  /** all text blocks in reading order, for the side panel / Markdown export */
  paragraphs: Paragraph[];
  regions: Region[];
  /** the page ends inside a reference list (the next page continues it) */
  endsInReferences: boolean;
  /** top of the page's visible area (user space), to tell running heads from the text */
  top?: number;
  /**
   * The first paragraph continues the last one of the previous page: it is translated together with it
   * (as that item's `cont`) and gets its share of the text when this page is drawn.
   */
  /** `owner` = paragraph id of the previous page's item that carries this text (indices can shift while linking) */
  incoming?: { fromPage: number; owner: string; para: Paragraph; block: Block; job: Job };
  /** sideways page (landscape table on a portrait page): page user space → the upright frame the plan lives in */
  frame?: Matrix;
}

const PANEL_KIND: Record<BlockKind, Paragraph['kind']> = {
  title: 'heading',
  heading: 'heading',
  body: 'body',
  caption: 'caption',
  footnote: 'body',
  label: 'other',
  cell: 'other',
  algo: 'body',
  equation: 'other',
  reference: 'body',
  author: 'body',
  other: 'other',
};

/** Line texts as running text (the panel's source / Markdown export): "inter-|nal" → "internal", while a
 * compound broken at its hyphen ("English-|to-German", "GPT-|4") keeps it — the rule buildJob uses for translation. */
export function joinLineTexts(texts: string[]): string {
  let out = '';
  for (const raw of texts) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (/\p{L}-$/u.test(out) && /^[\p{L}\d]/u.test(t)) {
      // a word split at the line end loses its hyphen; compounds and "GPT-|4" keep it (never a space)
      out = (/^\p{Ll}/u.test(t) && !/^[^\s]*\p{L}-\p{L}/u.test(t) ? out.slice(0, -1) : out) + t;
    } else out += (out ? ' ' : '') + t;
  }
  return out;
}

/** Page as the reader displays it: its view in user space, /Rotate, and the frame of a sideways page. */
interface PageGeom {
  view: PageLayout['view'];
  rotate: number;
  frame?: Matrix;
}

function toParagraph(layout: PageLayout, block: Block, page?: PageGeom): Paragraph {
  const [vx0, vy0, vx1, vy1] = page?.view ?? layout.view;
  // the reader highlights paragraphs on the page as displayed: frame → page user space → rotated display
  const back = page?.frame ? invert(page.frame) : undefined;
  const corners: [number, number][] = [
    [block.box.x0, block.box.y0],
    [block.box.x1, block.box.y1],
  ];
  const display = corners.map(([x, y]) => {
    const [px, py] = back ? apply(back, x, y) : [x, y];
    switch ((((page?.rotate ?? 0) % 360) + 360) % 360) {
      case 90:
        return [py - vy0, px - vx0];
      case 180:
        return [vx1 - px, py - vy0];
      case 270:
        return [vy1 - py, vx1 - px];
      default:
        return [px - vx0, vy1 - py];
    }
  });
  const xs = display.map((p) => p[0]);
  const ys = display.map((p) => p[1]);
  return {
    id: `${layout.pageIndex}-${block.order}`,
    pageIndex: layout.pageIndex,
    order: block.order,
    text: joinLineTexts(block.lines.map((l) => l.text)),
    bbox: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) },
    kind: PANEL_KIND[block.kind],
  };
}

const TRANSLATED_KINDS = new Set<BlockKind>(['title', 'heading', 'body', 'caption', 'footnote', 'label', 'cell', 'algo']);

/** Work out which blocks of a page get replaced and what text to translate. */
export function planPage(doc: PDFDocument, pageIndex: number, opts: { inReferences?: boolean } = {}): PagePlan {
  const read = readPageText(doc, pageIndex);
  // sideways text (a landscape table on a portrait page, or a /Rotate page whose content is drawn turned)
  // is laid out in an upright frame; /Rotate itself only changes how the page is displayed
  const oriented = orientPage(read);
  const model = oriented?.model ?? read;
  const frame = oriented?.frame;
  const page: PageGeom = { view: read.view, rotate: read.rotate, frame };
  const layout = analyzePage(model, { pageIndex, inReferences: opts.inReferences });
  const blocks = [...layout.blocks].sort((a, b) => a.order - b.order);
  const flow = blocks.filter((b) => b.region === 'text' && b.kind !== 'other');
  const lastFlow = flow[flow.length - 1];
  const endsInReferences = !!lastFlow && lastFlow.kind === 'reference';
  const paragraphs = blocks.filter((b) => b.kind !== 'other' && b.kind !== 'equation').map((b) => toParagraph(layout, b, page));
  const base = { pageIndex, paragraphs, regions: layout.regions, endsInReferences, top: layout.view[3], frame };

  const items: PageItem[] = [];
  const kept: Block[] = [];
  const usedRules = new Set<number | string>();
  for (const block of blocks) {
    if (!block.translate || !TRANSLATED_KINDS.has(block.kind)) {
      kept.push(block);
      continue;
    }
    const under = withUnderscores(block, model.rules, usedRules);
    const job = buildJob(under.block);
    if (typeof job === 'string') {
      kept.push({ ...block, translate: false, reason: job });
      continue;
    }
    attachRules(job, model.rules, usedRules);
    if (under.rules.length) job.textRules = under.rules;
    items.push({ para: toParagraph(layout, block, page), block, job, text: job.source });
  }
  const skipped = items.length || blocks.some((b) => b.kind !== 'other') ? undefined : model.ops.some((o) => !o.hidden && o.text.trim()) ? '这一页没有可翻译的正文（只有图表、数字或符号）' : '没有找到可替换的文字（可能是扫描件）';
  return { ...base, items: joinContinuations(items), kept, skipped };
}

/**
 * TeX draws \\_ as a short rule on the baseline instead of a glyph ("conv3_1"). Such rules between two
 * glyph runs of a line become "_" text ops (so the translator sees the name) and are erased with the block.
 */
function withUnderscores(block: Block, rules: RuleOp[], used: Set<number | string>): { block: Block; rules: RuleOp[] } {
  const found: RuleOp[] = [];
  const lines = block.lines.map((l) => {
    const extra: ShowOp[] = [];
    const ops = l.ops.filter((o) => o.text.trim());
    for (const r of rules) {
      if (used.has(ruleKey(r)) || r.h > l.size * 0.12 || r.w < l.size * 0.2 || r.w > l.size * 0.8) continue;
      const cy = r.y + r.h / 2;
      if (cy > l.baseline + l.size * 0.08 || cy < l.baseline - l.size * 0.3 || r.x < l.x0 - 1 || r.x + r.w > l.x1 + 1) continue;
      const left = ops.find((o) => Math.abs(o.x + o.width - r.x) < l.size * 0.25 && Math.abs(o.y - l.baseline) < l.size * 0.2);
      const right = ops.find((o) => Math.abs(o.x - (r.x + r.w)) < l.size * 0.25 && o !== left);
      if (!left || !right) continue;
      used.add(ruleKey(r));
      found.push(r);
      extra.push({ ...left, id: `${left.id}_u${r.index}`, text: '_', x: r.x, width: r.w });
    }
    return extra.length ? { ...l, ops: [...l.ops, ...extra] } : l;
  });
  return found.length ? { block: { ...block, lines, ops: lines.flatMap((l) => l.ops) }, rules: found } : { block, rules: found };
}

/** Plan pages from..to, chaining the reference-list state from page to page. */
/**
 * Plans of pages `from`..`to`, linked like the reader links them — including with the pages just outside the
 * range, so an exported range uses the same (cached) translation units as the reader. `before` is the page
 * before the range when its last item carries the range's first sentence.
 */
export function planPages(doc: PDFDocument, from: number, to: number): PagePlan[] & { before?: PagePlan } {
  const plans: PagePlan[] & { before?: PagePlan } = [];
  const end = Math.min(to + 1, doc.getPageCount() - 1);
  let inReferences = false;
  let prev: PagePlan | undefined;
  for (let i = 0; i <= end; i++) {
    const plan = planPage(doc, i, { inReferences });
    inReferences = plan.endsInReferences;
    // a sentence cut by the page break is translated in one piece
    if (prev && i >= from) linkPages(prev, plan);
    if (i === from && plan.incoming) plans.before = prev;
    if (i >= from && i <= to) plans.push(plan);
    prev = plan;
  }
  return plans;
}

/** Human-readable version of a placeholder translation (for the side panel / Markdown export). */
export function displayTranslation(item: Pick<PageItem, 'job' | 'cont'>, translation: string): string {
  const formulas = item.cont ? [...item.job.formulas, undefined, ...item.cont.job.formulas] : item.job.formulas;
  return stripMarkup(translation).replace(PLACEHOLDER_ANY, (_, n: string) => {
    const g = formulas[Number(n)];
    return g ? g.ops.map((o) => o.text).join('').trim() : '';
  });
}

/** Display translations of an item by paragraph id (a joined continuation gives each column its part). */
export function displayParts(item: PageItem, translation: string): [string, string][] {
  if (!item.cont) return [[item.para.id, displayTranslation(item, translation)]];
  // split what the PDF draws: the validated text ({ v 2 } normalised, a dropped break marker restored)
  const check = checkItem(item, translation, targetLang(), true);
  const [a, b] = splitJoined(item, check.ok ? check.text : translation);
  return [
    [item.para.id, displayTranslation({ job: item.job }, a)],
    [item.cont.para.id, displayTranslation({ job: item.cont.job }, b)],
  ];
}

export interface TranslateCtx {
  docId?: string;
  docTitle?: string;
  signal?: AbortSignal;
}

/**
 * Re-translate (once, bypassing the cache) every item whose translation fails validation for a
 * reason a new attempt can fix (broken placeholders, lost numbers, empty). `raw` is updated in place.
 * Returns the indices that were retried.
 */
export async function repairTranslations(plan: PagePlan, raw: string[], ctx: TranslateCtx, only?: number[]): Promise<number[]> {
  const lang = targetLang();
  const retry = plan.items
    .map((item, k) => ({ item, k, r: checkItem(item, raw[k], lang) }))
    .filter((x) => !x.r.ok && x.r.status !== 'identical' && raw[x.k] !== undefined && (!only || only.includes(x.k)));
  const queue = [...retry];
  const worker = async () => {
    for (let x = queue.shift(); x; x = queue.shift()) {
      const { item, k } = x;
      throwIfAborted(ctx.signal);
      try {
        const opts = { ...ctx, extraRule: PLACEHOLDER_RULE };
        const hint = retryHint(x.r.ok ? undefined : x.r.status, item.text, itemFormulaCount(item));
        // the cache key is taken now: settings may change while the request runs
        const commit = await cacheWriter(item.text, opts);
        // without formulas the placeholder rule only invites the model to turn numbers into {vN} ("In 5" → "在{v0}中")
        const rule = itemFormulaCount(item) ? PLACEHOLDER_RULE : undefined;
        const t = await withRetry(() => translateText(item.text, { ...ctx, extraRule: rule, bypassCache: true, cacheWrite: false, hint, bulk: true, urgent: true }), ctx.signal);
        throwIfAborted(ctx.signal);
        // strictly valid, or at least usable where the first attempt was not
        if (checkItem(item, t, lang).ok || (checkItem(item, t, lang, true).ok && !checkItem(item, raw[k], lang, true).ok)) {
          raw[k] = t;
          await commit(t);
        } else if (!raw[k]) raw[k] = t;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e;
        console.warn('retranslate failed', item.para.id, e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, retry.length) }, worker));
  return retry.map((x) => x.k);
}

/**
 * A Chinese translation that is far shorter than the English source has left something out (a model stopping
 * at an unfinished fragment, or keeping only a trailing "(Indicator 3)"). English letters per Chinese
 * character are ≈3.2 on average and stay below 4.5 for complete translations; Latin words kept in the
 * translation count a third.
 */
function tooShort(source: string, text: string): boolean {
  const letters = (source.match(/[A-Za-z]/g) ?? []).length;
  if (letters < 60) return false;
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return letters > 5.3 * (han + latin / 3);
}

/** What the retry request is told about the failed first attempt. */
export function retryHint(status: string | undefined, source: string, count = 0): string {
  const fragment = !SENTENCE_END.test(source.replace(/<\/?s\d+>|\{v\d+\}/g, '').trim());
  const why =
    status === 'short'
      ? 'A previous translation of this text left part of it out: translate every clause, from the first word to the last.'
      : status === 'numbers'
        ? 'A previous translation of this text dropped numbers: keep every number, percentage and reference of the original.'
        : status === 'placeholder'
          ? count
            ? `A previous translation of this text lost, repeated or invented {vN} placeholders: it has exactly ${count === 1 ? '{v0}' : `{v0} … {v${count - 1}}`}, keep each one exactly once and add no other.`
            : 'A previous translation of this text invented {vN} placeholders: this text has none, so the translation must not contain any.'
          : status === 'tags'
            ? 'A previous translation of this text broke the <sN> tags: keep each pair around the matching words.'
            : 'A previous translation of this text was rejected: translate all of it faithfully.';
  const marks =
    status === 'placeholder' ? '' : count ? ` Use only the placeholders of the text (${count === 1 ? '{v0}' : `{v0} … {v${count - 1}}`}).` : ' The text has no {vN} placeholders: do not add any.';
  return why + marks + (fragment ? ' The text stops mid-sentence (it continues elsewhere): translate it up to its last word and leave the end unfinished.' : '');
}

function targetLang(): string | undefined {
  try {
    return (getSettings() as { targetLang?: string }).targetLang;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- matrices / re-emission

type M6 = [number, number, number, number, number, number];
const mul = (a: M6, b: M6): M6 => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];
const fmt = (n: number) => (Math.abs(n) < 1e-6 ? '0' : Number(n.toFixed(4)).toString());
const rgbOp = (c: Rgb, op: 'rg' | 'RG') => `${fmt(c[0])} ${fmt(c[1])} ${fmt(c[2])} ${op}`;

/** Content-stream snippet that re-draws an original show op at a new origin with scale s. */
export function reemitOp(op: ShowOp, newX: number, newY: number, s: number, fontRes = op.fontRes): string {
  const tfs = op.tfSize;
  const th = (op.state.Tz || 100) / 100;
  const ts = op.state.Ts || 0;
  if (!tfs || !th) return '';
  // Trm = [Tfs·Th 0 0 Tfs 0 Ts] × M  →  M = S⁻¹ × Trm
  const sInv: M6 = [1 / (tfs * th), 0, 0, 1 / tfs, 0, -ts / tfs];
  const m = mul(sInv, op.trm);
  const a = m[0] * s;
  const b = m[1] * s;
  const c = m[2] * s;
  const d = m[3] * s;
  // origin = (0, Ts) × M' + (e, f)
  const e = newX - ts * c;
  const f = newY - ts * d;
  const show = op.raw.trim().startsWith('[') ? 'TJ' : 'Tj';
  return [
    'BT',
    `/${fontRes} ${fmt(tfs)} Tf`,
    `${fmt(op.state.Tc)} Tc ${fmt(op.state.Tw)} Tw ${fmt(op.state.Tz || 100)} Tz ${fmt(ts)} Ts 0 Tr`,
    rgbOp(op.state.fill ?? [0, 0, 0], 'rg'),
    `${fmt(a)} ${fmt(b)} ${fmt(c)} ${fmt(d)} ${fmt(e)} ${fmt(f)} Tm`,
    `${op.raw} ${show}`,
    'ET',
  ].join('\n');
}

// ---------------------------------------------------------------- rendering

export type BlockStatus = 'drawn' | 'kept' | 'missing' | 'empty' | 'placeholder' | 'numbers' | 'identical' | 'short' | 'overflow';

export interface BlockDiag {
  id: string;
  kind: BlockKind;
  region: Block['region'];
  order: number;
  status: BlockStatus;
  /** why the original was kept (layout reason, validation detail, overflow) */
  reason?: string;
  box: Box;
  limit: Box;
  /** area actually used by the translation */
  drawn?: Box;
  /** how far the paragraph was moved up to close the gap left by a shorter previous paragraph */
  shift?: number;
  size: number;
  fontSize?: number;
  scale?: number;
  area?: 'box' | 'limit';
  lines?: number;
  ops: number;
  /** form XObjects the block's glyphs live in ('' = page content) */
  owners: string[];
  formulas?: number;
  /** text of the re-emitted formula glyphs (they stay in the original script) */
  formulaText?: string[];
  source: string;
  translation?: string;
}

export interface PageDiag {
  pageIndex: number;
  skipped?: string;
  regions: Region[];
  blocks: BlockDiag[];
}

const owners = (ops: ShowOp[]) => [...new Set(ops.map((o) => o.owner))];
const blockText = (b: Block) => b.lines.map((l) => l.text).join(' ');

/** Diagnostics of a plan without rendering (all translatable blocks missing). */
export function planDiag(plan: PagePlan): PageDiag {
  return {
    pageIndex: plan.pageIndex,
    skipped: plan.skipped,
    regions: plan.regions,
    blocks: [
      ...plan.kept.map((b): BlockDiag => ({ id: b.id, kind: b.kind, region: b.region, order: b.order, status: 'kept', reason: b.reason, box: b.box, limit: b.limit, size: b.size, ops: b.ops.length, owners: owners(b.ops), source: blockText(b) })),
      ...plan.items
        .flatMap((it) => [{ block: it.block, job: it.job }, ...(it.cont && !it.cont.crossPage ? [{ block: it.cont.block, job: it.cont.job }] : [])])
        .concat(plan.incoming ? [{ block: plan.incoming.block, job: plan.incoming.job }] : [])
        .map((it): BlockDiag => ({ id: it.block.id, kind: it.block.kind, region: it.block.region, order: it.block.order, status: 'missing', box: it.block.box, limit: it.block.limit, size: it.block.size, ops: it.job.ops.length, owners: owners(it.job.ops), formulas: it.job.formulas.length, formulaText: it.job.formulas.map((g) => g.ops.map((o) => o.text).join('')), source: it.job.source })),
    ].sort((a, b) => a.order - b.order),
  };
}

/**
 * Rewrite page `targetIndex` of `doc` (whose content must be identical to the planned page):
 * validate and lay out every translation, erase only the blocks that will be redrawn, draw them.
 * `translations` is aligned with plan.items ('' = keep that block untouched).
 */
/** Diagnostics of a sideways page are computed in its upright frame: report them in page space. */
export function pageSpaceDiag(diag: PageDiag, frame?: Matrix): PageDiag {
  if (!frame) return diag;
  const back = invert(frame);
  const map = (b: Box): Box => {
    const [p, q] = [apply(back, b.x0, b.y0), apply(back, b.x1, b.y1)];
    return { x0: Math.min(p[0], q[0]), y0: Math.min(p[1], q[1]), x1: Math.max(p[0], q[0]), y1: Math.max(p[1], q[1]) };
  };
  return {
    ...diag,
    regions: diag.regions.map((r) => ({ ...r, box: map(r.box) })),
    blocks: diag.blocks.map((d) => ({ ...d, box: map(d.box), limit: map(d.limit), ...(d.drawn ? { drawn: map(d.drawn) } : {}) })),
  };
}

export function renderPlannedPage(doc: PDFDocument, targetIndex: number, plan: PagePlan, translations: string[], font: PDFFont, stats?: PdfTranslateStats, incoming?: string): { changed: boolean; diag: PageDiag } {
  const r = renderInFrame(doc, targetIndex, plan, translations, font, stats, incoming);
  return { ...r, diag: pageSpaceDiag(r.diag, plan.frame) };
}

function renderInFrame(doc: PDFDocument, targetIndex: number, plan: PagePlan, translations: string[], font: PDFFont, stats?: PdfTranslateStats, incoming?: string): { changed: boolean; diag: PageDiag } {
  const diag = planDiag(plan);
  if (plan.skipped) return { changed: false, diag };
  const byId = new Map(diag.blocks.map((d) => [d.id, d]));
  const lang = targetLang();
  const fonts: DrawFonts = { cjk: font, ...latinFonts(doc) };

  const lay = (item: PageItem, text: string, maxScale?: number) => {
    const job = item.job;
    return layoutParagraph({
      translation: text,
      formulaWidths: new Map(job.formulas.map((f) => [f.id, f.width])),
      box: job.box,
      limit: job.limit,
      size: job.size,
      lineGap: job.pitch,
      indent: job.indent,
      align: job.align,
      measure: (t, size, style, latin) => fontFor(fonts, job.latinFamily, t, (job.styles[style] ?? job.styles[0]).bold, latin).font.widthOfTextAtSize(t, size),
      minScale: job.minScale,
      minSize: job.minSize,
      maxScale,
      slack: job.slack,
      ascent: 0.8,
    });
  };

  const work: { item: PageItem; text: string; layout: LayoutResult }[] = [];
  const place = (item: PageItem, text: string) => {
    const d = byId.get(item.block.id)!;
    d.translation = text;
    const layout = lay(item, text);
    if (layout.overflow) {
      Object.assign(d, { fontSize: layout.size, scale: layout.scale, area: layout.area, lines: layout.lines.length });
      d.status = 'overflow';
      d.reason = `does not fit even at ${layout.size.toFixed(1)}pt (min ${item.job.minSize.toFixed(1)}pt)`;
      if (stats) {
        stats.overflow++;
        stats.kept++;
      }
      return;
    }
    work.push({ item, text, layout });
  };
  plan.items.forEach((item, k) => {
    const blocks = [item.block, ...(item.cont && !item.cont.crossPage ? [item.cont.block] : [])].map((b) => byId.get(b.id)!);
    const t = translations[k];
    blocks.forEach((d) => (d.translation = t || undefined));
    if (!t?.trim()) return;
    const check = checkItem(item, t, lang, true);
    if (!check.ok) {
      for (const d of blocks) {
        d.status = check.status;
        d.reason = check.detail;
        if (stats) stats.kept++;
      }
      return;
    }
    if (!item.cont) return place(item, check.text);
    const [a, b] = splitJoined(item, check.text);
    place({ ...item, text: item.job.source, cont: undefined }, a);
    // a continuation on the next page is drawn there (from `incoming`)
    if (!item.cont.crossPage) place({ para: item.cont.para, block: item.cont.block, job: item.cont.job, text: item.cont.job.source }, b);
  });
  if (plan.incoming) {
    const inc = plan.incoming;
    if (incoming) place({ para: inc.para, block: inc.block, job: inc.job, text: inc.job.source }, incoming);
    else {
      const d = byId.get(inc.block.id)!;
      d.status = 'kept';
      d.reason = 'continues the previous page, whose translation is not available';
    }
  }

  // one size per sibling group: cells of a table / labels of a figure that had the same original size
  // are drawn at the smallest scale any of them needed, so a header row doesn't mix 7pt and 6.2pt
  const regionOf = (b: Block) => plan.regions.findIndex((r) => b.box.x0 >= r.box.x0 - 2 && b.box.x1 <= r.box.x1 + 2 && b.box.y0 >= r.box.y0 - 2 && b.box.y1 <= r.box.y1 + 2);
  const groups = new Map<string, typeof work>();
  for (const w of work) {
    const b = w.item.block;
    if (b.kind !== 'cell' && b.kind !== 'label' && b.region !== 'algorithm') continue;
    const key = `${b.region === 'algorithm' ? 'algo' : b.kind}|${regionOf(b)}|${b.size.toFixed(1)}`;
    groups.set(key, [...(groups.get(key) ?? []), w]);
  }
  for (const g of groups.values()) {
    const min = Math.min(...g.map((w) => w.layout.scale));
    for (const w of g) {
      if (w.layout.scale <= min + 1e-6) continue;
      const again = lay(w.item, w.text, min);
      if (!again.overflow) w.layout = again;
    }
  }
  closeGaps(work, plan, diag);
  for (const { item, layout } of work) {
    const d = byId.get(item.block.id)!;
    const a = layout.area === 'limit' ? item.job.limit : item.job.box;
    Object.assign(d, { status: 'drawn', fontSize: layout.size, scale: layout.scale, area: layout.area, lines: layout.lines.length });
    d.drawn = { x0: a.x, x1: a.x + a.w, y1: a.top, y0: a.top - layout.height };
  }
  if (!work.length) return { changed: false, diag };

  // glyphs of the target document (fonts of form-owned formula glyphs must come from this document)
  const target = new Map(readPageText(doc, targetIndex).ops.map((o) => [o.id, o]));
  const ids = new Set<string>();
  const rules = new Set<number | string>();
  for (const { item } of work) {
    item.job.ops.forEach((o) => ids.add(o.id));
    item.job.formulas.forEach((g) => g.rules.forEach((r) => rules.add(ruleKey(r))));
    item.job.textRules?.forEach((r) => rules.add(ruleKey(r)));
  }
  removeShowOps(doc, targetIndex, ids, rules);

  const page = doc.getPage(targetIndex);
  // isolate the original graphics state (CTM, colours) from what we draw on top
  page.node.wrapContentStreams(doc.context.register(doc.context.stream('q\n')), doc.context.register(doc.context.stream('Q\n')));
  const fontKeys = new Map<PDFFont, string>();
  const keyOf = (f: PDFFont) => {
    let k = fontKeys.get(f);
    if (!k) {
      k = page.node.newFontDictionary(f === font ? 'PBCJK' : 'PBLat', f.ref).asString().slice(1);
      fontKeys.set(f, k);
    }
    return k;
  };
  const formFonts = new Map<unknown, string>();
  const fontKey = (op: ShowOp): string | null => {
    if (!op.owner) return op.fontRes;
    const fo = target.get(op.id)?.fontObj;
    if (!fo) return null;
    let key = formFonts.get(fo);
    if (!key) {
      const ref = fo instanceof PDFRef ? fo : fo instanceof PDFDict ? doc.context.register(fo) : null;
      if (!ref) return null;
      key = page.node.newFontDictionary('PBF', ref).asString().slice(1);
      formFonts.set(fo, key);
    }
    return key;
  };

  // a sideways page was laid out upright: draw through the inverse of its frame
  const out: string[] = ['q', ...(plan.frame ? [`${invert(plan.frame).map(fmt).join(' ')} cm`] : [])];
  for (const { item, layout } of work) {
    const job = item.job;
    if (stats) stats.paragraphs++;
    for (const placed of layout.lines.flat()) {
      if (placed.kind === 'text') {
        if (!placed.text.trim()) continue;
        const st = job.styles[placed.style] ?? job.styles[0];
        const f = fontFor(fonts, job.latinFamily, placed.text, st.bold, placed.latin);
        // western faces have a real bold; the CJK font is emboldened with a thin outline stroke
        const bold = st.bold && !f.latin ? `2 Tr ${fmt(layout.size * (layout.size > 14 ? 0.05 : 0.035))} w ${rgbOp(st.color, 'RG')}` : '0 Tr';
        // CJK runs justify with Tc (every glyph), latin runs with Tw (spaces only; single-byte code 32)
        const tc = f.latin ? 0 : placed.spacing;
        const tw = f.latin ? placed.wordSpacing : 0;
        out.push(
          'BT',
          `/${keyOf(f.font)} ${fmt(layout.size)} Tf ${fmt(tc)} Tc ${fmt(tw)} Tw 100 Tz 0 Ts ${bold}`,
          rgbOp(st.color, 'rg'),
          `1 0 0 1 ${fmt(placed.x)} ${fmt(placed.y)} Tm`,
          `${f.font.encodeText(placed.text).toString()} Tj`,
          'ET',
        );
        continue;
      }
      const g = job.formulas[placed.id];
      if (!g) continue;
      if (stats) stats.formulas++;
      for (const op of g.ops) {
        const key = fontKey(op);
        if (!key) continue;
        const dx = (op.x - g.x) * placed.scale;
        const dy = (op.y - g.baseline) * placed.scale;
        out.push(reemitOp(op, placed.x + dx, placed.y + dy, placed.scale, key));
      }
      for (const r of g.rules) {
        const rx = placed.x + (r.x - g.x) * placed.scale;
        const ry = placed.y + (r.y - g.baseline) * placed.scale;
        out.push(`${rgbOp(g.ops[0]?.state.fill ?? [0, 0, 0], 'rg')} ${fmt(rx)} ${fmt(ry)} ${fmt(r.w * placed.scale)} ${fmt(Math.max(0.3, r.h * placed.scale))} re f`);
      }
    }
  }
  out.push('Q');
  page.node.addContentStream(doc.context.register(doc.context.flateStream(out.join('\n') + '\n')));
  return { changed: true, diag };
}

/**
 * Chinese is shorter than English, so every translated paragraph leaves blank space at its bottom; drawn at
 * their original positions the paragraphs of a column look torn apart. Consecutive body paragraphs / headings
 * of one column with nothing else between them (a "chain") are pulled up to follow each other, and the freed
 * space is spread over the paragraph gaps (at most one line each) — the rest stays at the end of the chain.
 */
function closeGaps(work: { item: PageItem; layout: LayoutResult }[], plan: PagePlan, diag: PageDiag) {
  const flowKinds = new Set(['body', 'heading']);
  const moving = work.filter((w) => w.item.block.region === 'text' && flowKinds.has(w.item.block.kind) && w.layout.area === 'box').sort((a, b) => a.item.block.order - b.item.block.order);
  const movingIds = new Set(moving.map((w) => w.item.block.id));
  // everything that stays where it is: kept / failed blocks, equations, figures, tables
  const fixed: Box[] = [
    ...diag.blocks.filter((d) => !movingIds.has(d.id)).map((d) => d.box),
    ...plan.regions.map((r) => r.box),
  ];
  // something that stays put right beside a paragraph (a heading number, a margin note) pins it in place
  const pinned = (w: (typeof moving)[number]) => {
    const b = w.item.job.box;
    return fixed.some((f) => f.y0 < b.top && f.y1 > b.top - b.h && Math.max(f.x0 - (b.x + b.w), b.x - f.x1) < w.item.job.size * 3 && Math.max(f.x0 - (b.x + b.w), b.x - f.x1) >= -0.5);
  };
  for (let i = moving.length - 1; i >= 0; i--)
    if (pinned(moving[i])) {
      const b = moving[i].item.job.box;
      fixed.push({ x0: b.x, x1: b.x + b.w, y0: b.top - b.h, y1: b.top });
      moving.splice(i, 1);
    }
  const span = (w: (typeof moving)[number]) => ({ x0: w.item.job.box.x, x1: w.item.job.box.x + w.item.job.box.w, top: w.item.job.box.top, bottom: w.item.job.box.top - w.item.job.box.h });
  const chains: (typeof moving)[] = [];
  for (const w of moving) {
    const chain = chains[chains.length - 1];
    const prev = chain?.[chain.length - 1];
    if (prev) {
      const a = span(prev);
      const b = span(w);
      const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const below = b.top <= a.bottom + 1 && a.bottom - b.top < Math.max(prev.item.job.size, w.item.job.size) * 3;
      const blocked = fixed.some((f) => f.y0 < a.bottom - 0.5 && f.y1 > b.top + 0.5 && Math.min(f.x1, b.x1) - Math.max(f.x0, b.x0) > 1);
      if (overlap > Math.min(a.x1 - a.x0, b.x1 - b.x0) * 0.6 && below && !blocked) {
        chain.push(w);
        continue;
      }
    }
    chains.push([w]);
  }
  for (const chain of chains) {
    if (chain.length < 2) continue;
    const place = (extra: number) => {
      const tops = [span(chain[0]).top];
      for (let k = 1; k < chain.length; k++) {
        const a = span(chain[k - 1]);
        const b = span(chain[k]);
        const prevBottom = tops[k - 1] - chain[k - 1].layout.height;
        const gap = Math.max(0, a.bottom - b.top) + (chain[k - 1].item.block.kind === 'heading' ? 0 : extra);
        tops.push(Math.max(b.top, prevBottom - gap));
      }
      return tops;
    };
    const tight = place(0);
    const last = chain.length - 1;
    const free = tight[last] - chain[last].layout.height - span(chain[last]).bottom;
    const gaps = chain.slice(0, -1).filter((w) => w.item.block.kind !== 'heading').length;
    const pitch = median(chain.map((w) => w.item.job.pitch || w.item.job.size * 1.2));
    const tops = gaps && free > 0 ? place(Math.min(free / gaps, pitch)) : tight;
    chain.forEach((w, k) => {
      const dy = tops[k] - span(w).top;
      if (dy < 0.01) return;
      for (const p of w.layout.lines.flat()) p.y += dy;
      const d = diag.blocks.find((x) => x.id === w.item.block.id);
      if (d) d.shift = dy;
      w.item = { ...w.item, job: { ...w.item.job, box: { ...w.item.job.box, top: tops[k] } } };
    });
  }
}

export function codepointsOf(texts: string[]): Set<number> {
  const cps = new Set<number>([32, ...'0123456789'].map((c) => (typeof c === 'number' ? c : c.codePointAt(0)!)));
  for (const t of texts) for (const ch of stripMarkup(t ?? '').replace(PLACEHOLDER_ANY, '')) cps.add(ch.codePointAt(0)!);
  return cps;
}

export async function embedCjkFont(doc: PDFDocument, texts: string[], onProgress?: (msg: string) => void): Promise<PDFFont> {
  const subsetter = await getCjkSubsetter(onProgress);
  doc.registerFontkit(fontkit);
  return doc.embedFont(subsetter.subset(codepointsOf(texts)), { subset: false });
}

/** A standalone one-page PDF of the translated page (for the live reader view). */
export async function renderSinglePage(
  src: PDFDocument,
  plan: PagePlan,
  translations: string[],
  onProgress?: (msg: string) => void,
  incoming?: string,
): Promise<{ bytes: Uint8Array | null; diag: PageDiag }> {
  const texts = [...translations, incoming ?? ''].filter(Boolean);
  if (plan.skipped || !texts.length) return { bytes: null, diag: pageSpaceDiag(planDiag(plan), plan.frame) };
  const one = await PDFDocument.create();
  const [page] = await one.copyPages(src, [plan.pageIndex]);
  one.addPage(page);
  const font = await embedCjkFont(one, texts, onProgress);
  const { changed, diag } = renderPlannedPage(one, 0, plan, translations, font, undefined, incoming);
  return { bytes: changed ? await one.save({ useObjectStreams: true }) : null, diag };
}

export interface PdfTranslateResult {
  bytes: Uint8Array;
  stats: PdfTranslateStats;
  diagnostics: PageDiag[];
  /** pages that were rewritten */
  translated: number[];
}

export async function buildTranslatedPdf(opts: PdfTranslateOptions): Promise<PdfTranslateResult> {
  const say = opts.onProgress ?? (() => {});
  const stats: PdfTranslateStats = { pages: 0, paragraphs: 0, formulas: 0, overflow: 0, kept: 0, skippedPages: [] };
  say('解析 PDF…', 0);
  const doc = await PDFDocument.load(opts.bytes.slice(0), { ignoreEncryption: true });
  const last = Math.min(opts.to, doc.getPageCount() - 1);
  say('分析版面…', 0.02);
  const plans = planPages(doc, opts.from, last);
  for (const p of plans) if (p.skipped && p.paragraphs.length) stats.skippedPages.push(p.pageIndex);
  const active = plans.filter((p) => !p.skipped && (p.items.length || p.incoming));
  if (!active.length) throw new Error('没有找到可翻译的段落（可能是扫描件或页面已旋转）。');
  // the range starts mid-sentence: the previous page's item carrying that sentence is translated too (not drawn)
  const before = plans.before && plans[0] ? plans.before : undefined;
  const ownerK = before ? incomingOwner(before, plans[0]) : -1;

  // ---- key terms of the paper into its glossary (fresh documents only), then translate (batched,
  // concurrent, cached — shares the cache with the reader's full-text run)
  const { prepareTerms } = await import('../services/terms');
  await prepareTerms(opts.docId, active.slice(0, 2).flatMap((p) => p.items.map((i) => i.text)), opts.signal, () => say('提取术语…', 0.03));
  const s = getSettings();
  const ctx: TranslateCtx = { docId: opts.docId, docTitle: opts.title, signal: opts.signal };
  const all = active.flatMap((plan) => plan.items.map((item, k) => ({ plan, k, item })));
  if (before && ownerK >= 0) all.unshift({ plan: before, k: ownerK, item: before.items[ownerK] });
  const out = new Map<PagePlan, string[]>([...active, ...(before ? [before] : [])].map((p) => [p, p.items.map(() => '')]));
  const queue: (typeof all)[] = [];
  const size = Math.max(1, s.batchSize);
  for (let i = 0; i < all.length; i += size) queue.push(all.slice(i, i + size));
  let done = 0;
  const worker = async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      throwIfAborted(opts.signal);
      const res = await withRetry(
        () => translateBatch(b.map((x) => x.item.text), { ...ctx, extraRule: PLACEHOLDER_RULE }),
        opts.signal,
        (n) => say(`网络异常，第 ${n} 次重试…`),
      );
      b.forEach((x, k) => (out.get(x.plan)![x.k] = res[k]));
      done += b.length;
      say(`翻译 ${done}/${all.length} 段`, 0.05 + 0.75 * (done / all.length));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(3, s.concurrency)) }, worker));
  throwIfAborted(opts.signal);
  say('校验译文…', 0.82);
  // all pages at once: the shared request slots (services/limiter.ts) keep the total within the cap
  await Promise.all([
    ...active.map((plan) => repairTranslations(plan, out.get(plan)!, ctx)),
    ...(before && ownerK >= 0 ? [repairTranslations(before, out.get(before)!, ctx, [ownerK])] : []),
  ]);

  say('准备字体…', 0.86);
  const font = await embedCjkFont(doc, [...out.values()].flat(), (m) => say(m, 0.86));
  const translated = new Set<number>();
  const diagnostics: PageDiag[] = [];
  plans.forEach((plan, n) => {
    say(`排版 ${n + 1}/${plans.length} 页`, 0.88 + 0.1 * ((n + 1) / plans.length));
    const raw = out.get(plan);
    if (!raw) {
      diagnostics.push(pageSpaceDiag(planDiag(plan), plan.frame));
      return;
    }
    const prev = plan.incoming ? [before, ...plans].find((p) => p?.pageIndex === plan.incoming!.fromPage) : undefined;
    const incoming = prev && out.get(prev) ? incomingTranslation(prev, out.get(prev)!, plan) : undefined;
    const { changed, diag } = renderPlannedPage(doc, plan.pageIndex, plan, raw, font, stats, incoming);
    diagnostics.push(diag);
    if (changed) {
      translated.add(plan.pageIndex);
      stats.pages++;
    }
  });

  say('生成文件…', 0.99);
  let result: PDFDocument = doc;
  if (opts.mode !== 'mono') {
    // pdf-lib writes embedded fonts lazily on save(); finalize them before pages are copied out
    await doc.flush();
    const orig = await PDFDocument.load(opts.bytes.slice(0), { ignoreEncryption: true });
    result = opts.mode === 'side' ? await assembleSideBySide(doc, orig, translated) : await assembleInterleaved(doc, orig, translated);
  }
  result.setTitle(`${opts.title}（译文）`);
  result.setProducer('PaperBridge');
  const bytes = await result.save({ useObjectStreams: true });
  say('完成', 1);
  return { bytes, stats, diagnostics, translated: [...translated].sort((a, b) => a - b) };
}


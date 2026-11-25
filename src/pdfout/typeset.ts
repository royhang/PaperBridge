/**
 * Line breaking + fitting of a translated paragraph into the original paragraph box.
 * Pure and font-agnostic: callers pass a `measure(text, size, style, latin)` function.
 *
 * Coordinates: PDF user space, y grows UP. The box is given by its left x, TOP y, width, height.
 *
 * Markup understood in the translation:
 *  - {vN}            formula placeholder (width from `formulaWidths`, scaled with the text)
 *  - <sN>…</sN>      style span (bold / colour run of the original); unknown or broken tags are ignored
 */

export type Token =
  /** latin = drawn with the western font (words, digits, ASCII punctuation); CJK chars are single breakable tokens */
  | { kind: 'text'; text: string; breakable: boolean; style: number; latin: boolean }
  | { kind: 'space'; style: number }
  | { kind: 'formula'; id: number };

export type Placed =
  | {
      kind: 'text';
      text: string;
      x: number;
      y: number;
      style: number;
      latin: boolean;
      /** justification: extra space after every char (CJK runs, PDF Tc) */
      spacing: number;
      /** justification: extra space at every space char (latin runs, PDF Tw) */
      wordSpacing: number;
    }
  | { kind: 'formula'; id: number; x: number; y: number; scale: number };

export interface Area {
  x: number;
  top: number;
  w: number;
  h: number;
}

export type Align = 'left' | 'center' | 'justify';

export interface LayoutInput {
  translation: string;
  /** width (at scale 1, user space) of each formula placeholder {vN} */
  formulaWidths: Map<number, number>;
  box: Area;
  /** larger area the text may use when it does not fit the box (same x / top) */
  limit?: Area;
  /** original body font size of the paragraph */
  size: number;
  /** original baseline-to-baseline distance (0 = unknown / single line) */
  lineGap: number;
  /** first-line indent in user space */
  indent: number;
  align?: Align;
  /** width of a run; `latin` runs are drawn with the western font */
  measure: (text: string, size: number, style: number, latin: boolean) => number;
  /** never grow above size × maxScale (used to give sibling cells / labels one common size) */
  maxScale?: number;
  /** never shrink below size × minScale (default 0.6) … */
  minScale?: number;
  /** … nor below this absolute size (default 4) */
  minSize?: number;
  /** vertical position of the first baseline below the box top, as a fraction of size (default 0.86) */
  ascent?: number;
  /** how far (in em) descenders of the last line may go below the box (default 0.3; 0 when something sits right below) */
  slack?: number;
}

export interface LayoutResult {
  size: number;
  /** formula scale relative to the original glyphs (= size / original size) */
  scale: number;
  pitch: number;
  lines: Placed[][];
  /** true when even the smallest allowed size does not fit the limit */
  overflow: boolean;
  /** which area was needed */
  area: 'box' | 'limit';
  /** height actually used, from the box top */
  height: number;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
/** may not start a line */
const NO_START = new Set([...'，。、；：？！）」』》】〉…—～,.;:?!)]}%”’·']);
/** may not end a line */
const NO_END = new Set([...'（「『《【〈“‘([{']);
const MARKUP = /\{v(\d+)\}|<s(\d+)>|<\/s(\d+)>/g;

export function stripMarkup(text: string): string {
  return text.replace(/<\/?s\d+>/g, '');
}

export function tokenize(translation: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  let style = 0;
  const pushText = (s: string) => {
    // split into CJK chars (individually breakable), latin words, spaces
    const re = /(\s+)|([^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]+)|(.)/gsu;
    for (const m of s.matchAll(re)) {
      if (m[1]) out.push({ kind: 'space', style });
      else if (m[2]) out.push({ kind: 'text', text: m[2], breakable: false, style, latin: true });
      else if (m[3]) out.push({ kind: 'text', text: m[3], breakable: CJK.test(m[3]), style, latin: !CJK.test(m[3]) });
    }
  };
  for (const m of translation.matchAll(MARKUP)) {
    pushText(translation.slice(last, m.index));
    if (m[1] !== undefined) out.push({ kind: 'formula', id: Number(m[1]) });
    else if (m[2] !== undefined) style = Number(m[2]);
    else if (m[3] !== undefined && Number(m[3]) === style) style = 0;
    last = m.index + m[0].length;
  }
  pushText(translation.slice(last));
  return out;
}

interface Item {
  tok: Token;
  w: number;
}

function breakLines(items: Item[], width: number, firstIndent: number, spaceW: number): Item[][] {
  const lines: Item[][] = [];
  let line: Item[] = [];
  let x = firstIndent;
  const flush = () => {
    while (line.length && line[line.length - 1].tok.kind === 'space') line.pop();
    lines.push(line);
    line = [];
    x = 0;
  };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.tok.kind === 'space') {
      if (line.length) {
        line.push({ tok: it.tok, w: spaceW });
        x += spaceW;
      }
      continue;
    }
    if (x + it.w <= width + 0.01 || !line.length) {
      // oversize unbreakable word on an empty line: split by characters
      if (it.w > width && it.tok.kind === 'text' && !it.tok.breakable && it.tok.text.length > 1) {
        const chars = [...it.tok.text];
        const per = it.w / chars.length;
        for (const ch of chars) {
          if (x + per > width && line.length) flush();
          line.push({ tok: { kind: 'text', text: ch, breakable: true, style: it.tok.style, latin: it.tok.latin }, w: per });
          x += per;
        }
        continue;
      }
      line.push(it);
      x += it.w;
      continue;
    }
    // kinsoku: punctuation that may not start a line takes the previous character with it to the
    // next line (hanging it past the edge would overflow the box)…
    const prevTok = line[line.length - 1]?.tok;
    if (it.tok.kind === 'text' && NO_START.has(it.tok.text[0]) && line.length > 1 && prevTok?.kind === 'text' && prevTok.breakable && !NO_START.has(prevTok.text[0])) {
      const prev = line.pop()!;
      flush();
      line.push(prev, it);
      x += prev.w + it.w;
      continue;
    }
    // …or, when that is not possible, hangs on the current line
    if (it.tok.kind === 'text' && NO_START.has(it.tok.text[0])) {
      line.push(it);
      x += it.w;
      continue;
    }
    // a char that may not end a line moves down with the next token
    const lastTok = line[line.length - 1]?.tok;
    let carry: Item | undefined;
    if (lastTok?.kind === 'text' && NO_END.has(lastTok.text[lastTok.text.length - 1]) && line.length > 1) carry = line.pop();
    flush();
    if (carry) {
      line.push(carry);
      x += carry.w;
    }
    line.push(it);
    x += it.w;
  }
  if (line.length) flush();
  return lines;
}

const lineWidth = (ln: Item[]) => ln.reduce((a, it) => a + it.w, 0);

/** A space between Han and a latin word / number ("使用 ResNet 的 50 层"), as translators do inconsistently. */
export function spaceMixed(text: string): string {
  return text.replace(/(\p{Script=Han})([A-Za-z0-9])/gu, '$1 $2').replace(/([A-Za-z0-9%])(\p{Script=Han})/gu, '$1 $2');
}

export function layoutParagraph(input: LayoutInput): LayoutResult {
  const tokens = tokenize(spaceMixed(input.translation));
  const minScale = input.minScale ?? 0.6;
  const minSize = input.minSize ?? 4;
  const ascent = input.ascent ?? 0.86;
  const descent = 0.24;
  const align = input.align ?? 'left';
  const box = input.box;
  const limit = input.limit && (input.limit.w > box.w + 0.5 || input.limit.h > box.h + 0.5) ? input.limit : undefined;

  // first-line indent scales with the text; a hanging indent (negative) keeps the original geometry
  const indentAt = (scale: number, w: number) => (input.indent < 0 ? input.indent : Math.min(input.indent * scale, w * 0.3));
  type Fit = { scale: number; lines: Item[][]; pitch: number; area: Area; which: 'box' | 'limit' };
  const tryFit = (scale: number, area: Area): Fit | null => {
    const size = input.size * scale;
    const spaceW = input.measure(' ', size, 0, true) || size * 0.25;
    const items: Item[] = tokens.map((tok) => ({
      tok,
      w: tok.kind === 'text' ? input.measure(tok.text, size, tok.style, tok.latin) : tok.kind === 'formula' ? (input.formulaWidths.get(tok.id) ?? 0) * scale : spaceW,
    }));
    const indent = indentAt(scale, area.w);
    const lines = breakLines(items, area.w, indent, spaceW);
    // an unbreakable token wider than the area cannot fit at this size
    // trailing punctuation may hang into the margin by at most half an em
    const hang = (ln: Item[]) => {
      const t = ln[ln.length - 1]?.tok;
      return t?.kind === 'text' && NO_START.has(t.text[0]) ? Math.min(ln[ln.length - 1].w, size * 0.5) : 0;
    };
    if (lines.some((ln, i) => lineWidth(ln) - hang(ln) + (i === 0 ? indent : 0) > area.w + 0.5 && !(ln.length === 1 && ln[0].tok.kind === 'formula' && area.w >= (input.formulaWidths.get((ln[0].tok as { id: number }).id) ?? 0) * scale))) return null;
    const n = lines.length;
    const orig = input.lineGap > 0 ? input.lineGap : size * 1.3;
    const pref = Math.min(Math.max(orig, size * 1.22), size * 1.6);
    // never demand more leading than the original had (tight figure labels) — but full-height CJK glyphs
    // need ~8% of leading not to touch, even where the latin original was set solid (8/8pt headers)
    const minP = Math.max(size * 1.08, Math.min(size * 1.15, input.lineGap > 0 ? input.lineGap * scale : Infinity));
    const room = area.h + (area === box ? (input.slack ?? 0.3) * size : 0) - size * (ascent + descent);
    if (n <= 1) return room >= -0.01 ? { scale, lines, pitch: pref, area, which: 'box' } : null;
    if ((n - 1) * pref <= room) return { scale, lines, pitch: pref, area, which: 'box' };
    if ((n - 1) * minP <= room) return { scale, lines, pitch: room / (n - 1), area, which: 'box' };
    return null;
  };

  const scales: number[] = [];
  const top = Math.min(1, input.maxScale ?? 1);
  for (let s = top; s >= minScale - 1e-6 && input.size * s >= minSize - 1e-6; s -= 0.03) scales.push(Math.round(s * 1000) / 1000);
  if (!scales.length) scales.push(Math.min(top, Math.max(minScale, minSize / input.size)));
  let fit: Fit | null = null;
  // 1) the original box, shrinking a little; 2) the larger limit, shrinking down to the minimum;
  // 3) the original box down to the minimum (no limit available)
  for (const s of scales) if (s >= 0.86 && (fit = tryFit(s, box))) break;
  if (!fit && limit) for (const s of scales) if ((fit = tryFit(s, limit))) {
    fit.which = 'limit';
    break;
  }
  if (!fit) for (const s of scales) if ((fit = tryFit(s, box))) break;
  let overflow = false;
  if (!fit) {
    overflow = true;
    const s = scales[scales.length - 1];
    const size = input.size * s;
    const area = limit ?? box;
    const spaceW = input.measure(' ', size, 0, true) || size * 0.25;
    const items: Item[] = tokens.map((tok) => ({
      tok,
      w: tok.kind === 'text' ? input.measure(tok.text, size, tok.style, tok.latin) : tok.kind === 'formula' ? (input.formulaWidths.get(tok.id) ?? 0) * s : spaceW,
    }));
    fit = { scale: s, lines: breakLines(items, area.w, indentAt(s, area.w), spaceW), pitch: size * 1.15, area, which: limit ? 'limit' : 'box' };
  }

  const size = input.size * fit.scale;
  const area = fit.area;
  const indent = indentAt(fit.scale, area.w);
  const isCjk = (it: Item) => it.tok.kind === 'text' && !it.tok.latin;
  const placed: Placed[][] = fit.lines.map((ln, li) => {
    const first = li === 0 ? indent : 0;
    const natural = lineWidth(ln);
    const free = area.w - first - natural;
    let x = area.x + first;
    // justification slots: after every CJK char (not at the line end) and at every space — never inside latin words
    let extra = 0;
    if (align === 'center' && free > 0) x += free / 2;
    else if (align === 'justify' && li < fit.lines.length - 1 && free > 0 && free < area.w * 0.2) {
      const slots = ln.reduce((a, it, i) => a + (it.tok.kind === 'space' ? 1 : isCjk(it) ? [...(it.tok as { text: string }).text].length - (i === ln.length - 1 ? 1 : 0) : 0), 0);
      // a line followed by an unbreakable token (URL, long word) is left ragged rather than spread out
      if (slots > 0 && free / slots <= size * 0.12) extra = free / slots;
    }
    const y = area.top - size * ascent - li * fit.pitch;
    type Run = Extract<Placed, { kind: 'text' }> & { end: number };
    const out: (Run | Placed)[] = [];
    for (const it of ln) {
      const tok = it.tok;
      if (tok.kind === 'formula') {
        out.push({ kind: 'formula', id: tok.id, x, y, scale: fit.scale });
        x += it.w;
        continue;
      }
      const prev = out[out.length - 1] as Run | undefined;
      const joins = prev?.kind === 'text' && Math.abs(prev.end - x) < 0.01;
      if (tok.kind === 'space') {
        // spaces belong to latin runs (word spacing); elsewhere they are just an advance
        if (joins && prev.latin && prev.style === tok.style) {
          prev.text += ' ';
          prev.end = x + it.w + extra;
        }
        x += it.w + extra;
        continue;
      }
      const n = [...tok.text].length;
      const adv = it.w + (tok.latin ? 0 : extra * n);
      if (joins && prev.latin === tok.latin && prev.style === tok.style) {
        prev.text += tok.text;
        prev.end = x + adv;
      } else out.push({ kind: 'text', text: tok.text, x, y, style: tok.style, latin: tok.latin, spacing: tok.latin ? 0 : extra, wordSpacing: tok.latin ? extra : 0, end: x + adv });
      x += adv;
    }
    return out.map((p) => {
      if (p.kind !== 'text') return p;
      const { end: _end, ...rest } = p as Run;
      void _end;
      rest.text = rest.text.replace(/ +$/, '');
      return rest;
    });
  });
  const height = (fit.lines.length - 1) * fit.pitch + size * (ascent + descent);
  return { size, scale: fit.scale, pitch: fit.pitch, lines: placed, overflow, area: fit.which, height };
}

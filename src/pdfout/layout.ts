/**
 * Page layout analysis on content-stream text (engine ShowOps) + graphics.
 *
 * Splits a page into typed blocks so that the translator only rewrites what it can rewrite safely:
 *  - text flow: title, heading, body, caption, footnote          → translated & re-typeset in place
 *  - figure labels (vector text inside figures, incl. Form XObjects) → translated inside their own box
 *  - table cells                                                   → translated inside their own cell
 *  - display equations                                             → protected (never erased)
 *  - references, author block, page furniture                     → kept as original
 * All coordinates are PDF user space (y up).
 */
import type { GraphicOp, PageTextModel, Rgb, RuleOp, ShowOp } from './engine';

export type BlockKind =
  | 'title'
  | 'heading'
  | 'body'
  | 'caption'
  | 'footnote'
  | 'label'
  | 'cell'
  /** one line of pseudo-code in an algorithm box */
  | 'algo'
  | 'equation'
  | 'reference'
  | 'author'
  | 'other';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type Align = 'left' | 'center' | 'justify';

export interface Line {
  ops: ShowOp[];
  baseline: number;
  x0: number;
  x1: number;
  /** dominant (body) font size of the line */
  size: number;
  text: string;
  /** share of non-space characters drawn with math fonts */
  math: number;
  bold: boolean;
}

export interface Block {
  id: string;
  kind: BlockKind;
  /** where the block lives */
  region: 'text' | 'figure' | 'table' | 'algorithm';
  lines: Line[];
  ops: ShowOp[];
  box: Box;
  /** area the re-typeset translation may use (box plus free space below / around) */
  limit: Box;
  size: number;
  /** baseline-to-baseline distance (0 = single line) */
  pitch: number;
  /** first-line indent */
  indent: number;
  align: Align;
  bold: boolean;
  color: Rgb;
  /** reading order on the page */
  order: number;
  translate: boolean;
  /** why a block is kept as original */
  reason?: string;
}

export interface Region {
  kind: 'figure' | 'table' | 'algorithm';
  box: Box;
  /** figures: image/form/vector; tables: number of rules */
  source: string;
}

export interface PageLayout {
  pageIndex: number;
  view: [number, number, number, number];
  bodySize: number;
  regions: Region[];
  blocks: Block[];
}

export interface LayoutContext {
  pageIndex: number;
  /** blocks on this page that continue a reference list from the previous page */
  inReferences?: boolean;
}

// ------------------------------------------------------------------ font / text helpers

const MATH_FONT =
  /^(cm(mi|sy|ex|bsy|mib|bx?ti?)?\d|msam|msbm|eufm|eusm|eurm|rsfs|esint|wasy|stix|lmmath|lmmi|lmsy|lmex|txsy|txex|txmi|pxsy|pxex|pxmi|newcm.*math|asana|cambria.?math|symbol|mt(mi|sy|ex))/i;

export function isMathFont(baseFont: string): boolean {
  return MATH_FONT.test(baseFont) || /math/i.test(baseFont);
}

export function isBoldFont(baseFont: string): boolean {
  return /bold|medi(um)?\b|-medi|semibold|demi|black|heavy|cmbx|bd\b|-bd/i.test(baseFont) && !/cmmib|cmbsy/i.test(baseFont);
}

const MATH_CHARS = /[∀∃∈∉∋⊂⊃⊆⊇∪∩∧∨¬⇒⇔→←↔≤≥≠≈≡∼∝∞∂∇∑∏∫√±×÷·⟨⟩∥⊥αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩϕϵ=<>|^_]/;

const opBox = (o: ShowOp): Box => ({
  x0: Math.min(o.x, o.x + o.width),
  x1: Math.max(o.x, o.x + o.width),
  y0: o.y - 0.24 * o.size,
  y1: o.y + 0.8 * o.size,
});

export function unionBox(boxes: Box[]): Box {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

const inside = (x: number, y: number, b: Box, pad = 0) => x >= b.x0 - pad && x <= b.x1 + pad && y >= b.y0 - pad && y <= b.y1 + pad;
const hOverlap = (a: { x0: number; x1: number }, b: { x0: number; x1: number }) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
const vOverlap = (a: Box, b: Box) => Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
const area = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/** Weighted mode of font sizes (by character count), rounded to 0.1pt. */
function dominantSize(ops: ShowOp[]): number {
  const w = new Map<number, number>();
  for (const o of ops) {
    if (isMathFont(o.baseFont)) continue;
    const n = o.text.replace(/\s/g, '').length;
    if (!n) continue;
    const k = Math.round(o.size * 10) / 10;
    w.set(k, (w.get(k) ?? 0) + n);
  }
  let best = 0;
  let bestW = -1;
  for (const [k, v] of w) if (v > bestW) [best, bestW] = [k, v];
  return best || median(ops.map((o) => o.size)) || 10;
}

/** Join ops of one visual line into text, inserting spaces at gaps. */
export function lineText(ops: ShowOp[], size: number): string {
  let s = '';
  let prevEnd = Number.NaN;
  for (const o of [...ops].sort((a, b) => a.x - b.x)) {
    if (!Number.isNaN(prevEnd) && o.x - prevEnd > size * 0.16 && s && !/\s$/.test(s) && !/^\s/.test(o.text)) s += ' ';
    s += o.text;
    prevEnd = Math.max(Number.isNaN(prevEnd) ? -Infinity : prevEnd, o.x + o.width);
  }
  return s.replace(/\s+/g, ' ').trim();
}

const mathShare = (ops: ShowOp[]) => {
  let m = 0;
  let t = 0;
  for (const o of ops) {
    const chars = o.text.replace(/\s/g, '');
    t += chars.length;
    if (isMathFont(o.baseFont)) m += chars.length;
    else m += [...chars].filter((c) => MATH_CHARS.test(c)).length * 0.6;
  }
  return t ? m / t : 0;
};

// ------------------------------------------------------------------ lines & segments

/**
 * Cluster ops into visual lines: body-size ops anchor lines; scripts, radicals and other small or
 * raised glyphs join the nearby line where they don't overlap existing text horizontally.
 * Then split each line into segments at horizontal gaps wider than `gap`.
 */
export interface LineOptions {
  /** split at gaps wider than gap × size (and at least minGap) */
  gap: number;
  minGap?: number;
  /** also split at gaps ≥ weak × size when a neighbouring line has a gap at the same x (local gutter) */
  weak?: number;
  gutters?: [number, number][];
}

export function buildLines(ops: ShowOp[], opts: LineOptions): Line[] {
  const { gap: gapFactor, minGap = 0, weak, gutters = [] } = opts;
  if (!ops.length) return [];
  const size = dominantSize(ops);
  const anchor = (o: ShowOp) => !isMathFont(o.baseFont) && o.size >= size * 0.78 && o.text.trim() !== '';
  type Raw = { baseline: number; size: number; ops: ShowOp[]; anchored?: boolean };
  const raws: Raw[] = [];
  const sorted = [...ops].sort((a, b) => b.y - a.y || a.x - b.x);
  for (const o of sorted.filter(anchor)) {
    // a line of the other column whose baseline is a little off (2pt) is a different line: join a raw line
    // within 0.3 em only next to its glyphs, otherwise only on (nearly) the same baseline
    const ob = opBox(o);
    const cands = raws.filter((l) => Math.abs(l.baseline - o.y) < Math.min(l.size, o.size) * 0.3);
    const touching = cands.filter((l) => l.ops.some((b) => {
      const bb = opBox(b);
      return Math.max(bb.x0 - ob.x1, ob.x0 - bb.x1) < Math.max(l.size, o.size);
    }));
    const r = (touching.length ? touching : cands.filter((l) => Math.abs(l.baseline - o.y) < Math.min(l.size, o.size) * 0.12)).sort((a, b) => Math.abs(a.baseline - o.y) - Math.abs(b.baseline - o.y))[0];
    if (r) r.ops.push(o);
    else raws.push({ baseline: o.y, size: o.size, ops: [o], anchored: true });
  }
  // smaller text and math glyphs join a text line only next to that line's glyphs (a script, a symbol) — not a
  // body line of the other column at the same height (footnotes, figure text). Glyphs that joined count as
  // neighbours for the rest, so a chain like "W_i^Q ∈ ℝ^{d_model×d_k}" stays on its line: repeat until stable.
  const beside = (l: Raw, ob: Box) => l.ops.some((b) => {
    const bb = opBox(b);
    return Math.max(bb.x0 - ob.x1, ob.x0 - bb.x1) < l.size;
  });
  const vNear = (l: Raw, o: ShowOp) => o.y - l.baseline > -l.size * 0.6 && o.y - l.baseline < l.size * 0.95;
  // small text that passed as an anchor (a CMR8 "max" under "TopK" at 10.9pt body size) is a script of the
  // line it touches: move it there when its baseline sits within a script's offset
  for (let moved = true; moved; ) {
    moved = false;
    for (const r of raws) {
      for (const o of [...r.ops]) {
        const ob = opBox(o);
        // (only out of a smaller line into a larger one, so nothing moves back and forth)
        const host = raws.find((l) => l !== r && l.anchored && r.size <= l.size * 0.85 && o.size <= l.size * 0.85 && o.y - l.baseline > -l.size * 0.45 && o.y - l.baseline < l.size * 0.55 && beside(l, ob));
        if (!host) continue;
        r.ops.splice(r.ops.indexOf(o), 1);
        host.ops.push(o);
        moved = true;
      }
    }
    for (let k = raws.length - 1; k >= 0; k--) if (!raws[k].ops.length) raws.splice(k, 1);
  }
  let pending = sorted.filter((o) => !anchor(o));
  for (let moved = true; moved && pending.length; ) {
    moved = false;
    const rest: ShowOp[] = [];
    for (const o of pending) {
      const ob = opBox(o);
      const near = raws.filter((l) => l.anchored && vNear(l, o) && beside(l, ob));
      const free = near.filter((l) => !l.ops.some((b) => anchor(b) && hOverlap(opBox(b), ob) > 0.5));
      const pick = (free.length ? free : near).sort((a, b) => Math.abs(o.y - a.baseline) - Math.abs(o.y - b.baseline))[0];
      if (pick) {
        pick.ops.push(o);
        moved = true;
      } else rest.push(o);
    }
    pending = rest;
  }
  // the rest (display maths, figure text) group among themselves on one baseline
  for (const o of pending) {
    const pick = raws.filter((l) => !l.anchored && vNear(l, o) && Math.abs(o.y - l.baseline) < Math.min(l.size, o.size) * 0.3).sort((a, b) => Math.abs(o.y - a.baseline) - Math.abs(o.y - b.baseline))[0];
    if (pick) pick.ops.push(o);
    else raws.push({ baseline: o.y, size: o.size, ops: [o] });
  }
  // gaps of every raw line (for local gutters)
  const gapsOf = new Map<Raw, [number, number][]>();
  for (const r of raws) {
    const byX = [...r.ops].sort((a, b) => a.x - b.x);
    const gaps: [number, number][] = [];
    let end = -Infinity;
    for (const o of byX) {
      const b = opBox(o);
      if (end > -Infinity && b.x0 - end > (weak ?? gapFactor) * r.size) gaps.push([end, b.x0]);
      end = Math.max(end, b.x1);
    }
    gapsOf.set(r, gaps);
  }
  const localGutter = (r: Raw, g0: number, g1: number) =>
    raws.some(
      (o) =>
        o !== r &&
        Math.abs(o.baseline - r.baseline) < Math.max(o.size, r.size) * 1.7 &&
        (gapsOf.get(o) ?? []).some(([a, b]) => Math.min(b, g1) - Math.max(a, g0) > 3),
    );
  const lines: Line[] = [];
  for (const r of raws) {
    const lineSize = dominantSize(r.ops) || r.size;
    const gap = Math.max(lineSize * gapFactor, minGap);
    const byX = [...r.ops].sort((a, b) => a.x - b.x);
    let cur: ShowOp[] = [];
    let end = -Infinity;
    const flush = () => {
      if (!cur.length) return;
      const anchors = cur.filter(anchor);
      // the text glyphs set the size: scripts of a formula-heavy line ("and W^O ∈ ℝ^{hd_v×d_model}.") can outnumber
      // them, and small text fonts (CMR8 "max", "Plan") can pass as anchors — the largest anchors count
      const top = Math.max(0, ...anchors.map((o) => o.size));
      const main = anchors.filter((o) => o.size >= top * 0.9);
      const sz = dominantSize(main.length ? main : cur) || lineSize;
      lines.push({
        ops: cur,
        // a fragment without anchors (split off at a gap — e.g. smaller text in the other column) keeps its own baseline
        baseline: anchors.length ? median(anchors.map((o) => o.y)) : cur.length > 1 || Math.abs(cur[0].y - r.baseline) > sz * 0.6 ? median(cur.map((o) => o.y)) : r.baseline,
        x0: Math.min(...cur.map((o) => opBox(o).x0)),
        x1: Math.max(...cur.map((o) => opBox(o).x1)),
        size: sz,
        text: lineText(cur, sz),
        math: mathShare(cur),
        bold: cur.filter((o) => o.text.trim()).every((o) => isBoldFont(o.baseFont)),
      });
      cur = [];
    };
    for (const o of byX) {
      const b = opBox(o);
      const crossesGutter = gutters.some(([g0, g1]) => end <= g0 + 1 && b.x0 >= g1 - 1);
      const local = weak !== undefined && b.x0 - end > weak * lineSize && localGutter(r, end, b.x0);
      if (cur.length && (b.x0 - end > gap || local || (crossesGutter && b.x0 - end > lineSize * 0.5))) flush();
      cur.push(o);
      end = Math.max(end, b.x1);
    }
    flush();
  }
  return lines.sort((a, b) => b.baseline - a.baseline || a.x0 - b.x0);
}

const lineBox = (l: Line): Box => ({ x0: l.x0, x1: l.x1, y0: l.baseline - 0.26 * l.size, y1: l.baseline + 0.82 * l.size });

// ------------------------------------------------------------------ regions

function figureRegions(model: PageTextModel, pageArea: number): Region[] {
  const regions: Region[] = [];
  const add = (b: Box, source: string) => regions.push({ kind: 'figure', box: b, source });
  for (const g of model.graphics) {
    const b = { x0: g.x, y0: g.y, x1: g.x + g.w, y1: g.y + g.h };
    const a = area(b);
    if (g.kind === 'form' && g.owner === '' && a > 1500 && a < pageArea * 0.8) add(b, `form ${g.path}`);
    if (g.kind === 'image' && g.owner === '' && a > 1500 && a < pageArea * 0.8) add(b, 'image');
  }
  // vector drawings: clusters of non-rule page-level paths
  const paths = model.graphics.filter(
    (g) => g.kind === 'path' && g.owner === '' && !(g.straight && Math.min(g.w, g.h) <= 1.5) && g.w * g.h < pageArea * 0.5,
  );
  const clusters: { box: Box; n: number }[] = [];
  for (const g of paths) {
    let b: Box = { x0: g.x, y0: g.y, x1: g.x + g.w, y1: g.y + g.h };
    let n = 1;
    for (let i = clusters.length - 1; i >= 0; i--) {
      const c = clusters[i].box;
      if (b.x0 <= c.x1 + 6 && c.x0 <= b.x1 + 6 && b.y0 <= c.y1 + 6 && c.y0 <= b.y1 + 6) {
        b = unionBox([b, c]);
        n += clusters[i].n;
        clusters.splice(i, 1);
      }
    }
    clusters.push({ box: b, n });
  }
  for (const c of clusters) if (c.n >= 6 && area(c.box) > 2500) add(c.box, `vector ×${c.n}`);
  // merge overlapping figure regions
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < regions.length && !merged; i++)
      for (let j = i + 1; j < regions.length && !merged; j++) {
        const a = regions[i].box;
        const b = regions[j].box;
        if (hOverlap(a, b) > 0 && vOverlap(a, b) > 0) {
          regions[i] = { kind: 'figure', box: unionBox([a, b]), source: `${regions[i].source}+${regions[j].source}` };
          regions.splice(j, 1);
          merged = true;
        }
      }
  }
  return regions;
}

/**
 * A justified line of a wide table column is cut at its stretched spaces by the tight table gap ("query." |
 * "This action is helpful when the"). Pieces on one baseline are one line when another line of the table
 * spans both (they sit in one column).
 */
function joinColumnPieces(lines: Line[]): Line[] {
  const out = [...lines].sort((a, b) => b.baseline - a.baseline || a.x0 - b.x0);
  for (let k = 0; k + 1 < out.length; k++) {
    const a = out[k];
    const b = out[k + 1];
    if (Math.abs(a.baseline - b.baseline) > 0.5 || b.x0 - a.x1 > a.size * 3 || b.x0 < a.x1) continue;
    const spans = out.some((l) => l !== a && l !== b && Math.abs(l.baseline - a.baseline) > 1 && l.x0 <= a.x0 + 2 && l.x1 >= b.x1 - 2 && l.x1 - l.x0 < (b.x1 - a.x0) * 1.3);
    if (!spans) continue;
    const [joined] = buildLines([...a.ops, ...b.ops], { gap: 10 });
    if (!joined) continue;
    out.splice(k, 2, joined);
    k--;
  }
  return out;
}

/** Baselines of the rows of a table with a column of small row numbers (≥3, one column), newest first; [] if none. */
function numberColumn(lines: Line[]): number[] {
  const nums = lines.filter((l) => /^\d{1,3}\.?$/.test(l.text.trim()));
  let best: Line[] = [];
  for (const n of nums) {
    const col = nums.filter((m) => Math.abs((m.x0 + m.x1) / 2 - (n.x0 + n.x1) / 2) < 3);
    if (col.length > best.length) best = col;
  }
  if (best.length < 3) return [];
  // the numbers count up row by row
  const sorted = [...best].sort((a, b) => b.baseline - a.baseline);
  const values = sorted.map((l) => parseInt(l.text, 10));
  if (values.some((v, k) => k > 0 && v <= values[k - 1])) return [];
  return sorted.map((l) => l.baseline);
}

/** Tables: stacks of ≥2 long horizontal rules with matching extents (booktabs / ruled tables). */
/** Horizontal rules drawn as several touching segments (one per table column) joined into one. */
function joinSegments(rules: RuleOp[]): RuleOp[] {
  const flat = rules.filter((r) => r.h <= 1.5 && r.w > 0).sort((a, b) => b.y - a.y || a.x - b.x);
  const out: RuleOp[] = [];
  for (const r of flat) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.y - r.y) < 0.3 && Math.abs(prev.h - r.h) < 0.3 && r.x - (prev.x + prev.w) < 3 && r.x >= prev.x) {
      out[out.length - 1] = { ...prev, w: Math.max(prev.w, r.x + r.w - prev.x) };
    } else out.push(r);
  }
  return out;
}

function tableRegions(model: PageTextModel, figures: Region[]): Region[] {
  const rules = joinSegments(model.rules)
    .filter((r) => r.w >= 60 && r.h <= 1.5)
    .filter((r) => !figures.some((f) => inside(r.x + r.w / 2, r.y, f.box, 1)))
    .sort((a, b) => b.y - a.y);
  const captions = model.ops.filter((o) => !o.rotated && !o.hidden && CAPTION.test(o.text.trim())).map((o) => ({ x: o.x, y: o.y }));
  // an algorithm box (caption between its top rules, pseudo-code down to the bottom rule) can be a page tall
  const algoTitles = model.ops.filter((o) => !o.rotated && !o.hidden && ALGORITHM.test(o.text.trim()));
  const algo = (g: { x0: number; x1: number; ys: number[] }) => algoTitles.some((o) => o.y < g.ys[0] + 2 && o.y > g.ys[0] - 25 && o.x >= g.x0 - 5 && o.x <= g.x1);
  const groups: { x0: number; x1: number; ys: number[] }[] = [];
  for (const r of rules) {
    const g = groups.find(
      (g) =>
        Math.abs(g.x0 - r.x) < 4 &&
        Math.abs(g.x1 - (r.x + r.w)) < 4 &&
        g.ys[g.ys.length - 1] - r.y < (algo(g) ? 650 : 260) &&
        // a caption between two rules separates two tables
        !captions.some((c) => c.y < g.ys[g.ys.length - 1] && c.y > r.y && c.x >= g.x0 - 30 && c.x <= g.x1),
    );
    if (g) g.ys.push(r.y);
    else groups.push({ x0: r.x, x1: r.x + r.w, ys: [r.y] });
  }
  return groups
    .filter((g) => g.ys.length >= 2)
    .map((g) => {
      const box = { x0: g.x0 - 2, x1: g.x1 + 2, y0: Math.min(...g.ys) - 0.5, y1: Math.max(...g.ys) + 0.5 };
      // a header row sitting on the top rule (no rule above it) belongs to the table: a single text row just
      // above the rule, split into ≥2 cells, that is not the caption
      const above = model.ops.filter((o) => !o.rotated && !o.hidden && o.text.trim() && o.x >= box.x0 - 1 && o.x + o.width <= box.x1 + 1 && o.y > box.y1 && o.y - box.y1 < o.size * 1.1);
      if (above.length && !above.some((o) => CAPTION.test(o.text.trim()))) {
        const row = above.filter((o) => Math.abs(o.y - above[0].y) < o.size * 0.3);
        const xs = row.map((o) => [o.x, o.x + o.width]).sort((a, b) => a[0] - b[0]);
        let cells = 1;
        for (let i = 1; i < xs.length; i++) if (xs[i][0] - Math.max(...xs.slice(0, i).map((x) => x[1])) > row[0].size * 0.9) cells++;
        if (cells >= 2 && row.length === above.length) box.y1 = Math.max(...row.map((o) => o.y + o.size * 0.8)) + 0.5;
      }
      return { kind: 'table' as const, box, source: `${g.ys.length} rules` };
    });
}

// ------------------------------------------------------------------ classification helpers

const CAPTION = /^(figure|fig\.|table|tab\.|algorithm|listing)\s*[A-Z]?\d+[.:]/i;
const ALGORITHM = /^algorithm\s*\d+/i;
const REF_START = /^\[\d{1,4}\]/;
const BULLET = /^[•◦▪▫■●○‣⁃∙➢►▶◆◇]\s*\S/u;
const CAPS_HEADING = /^(?:[A-Z\d]+(?:\.\d+)*\.?\s+)?[\p{Lu}][\p{Lu}\d\s&,:;()'’\-–]+$/u;
/** "[12] Author…" — a citation at the start of a body line ("[36] to show", "[20], suggesting") is not an entry */
const REF_ENTRY = /^\[\d{1,4}\]\s+(?:[\p{Lu}\d"“‘'(]|(?:van|von|de|da|di|le|la|du|der|den|del)\s)/u;
const REF_HEADING = /^(?:\d+\.?|[IVX]+\.)?(?:references?|bibliography|literaturecited|workscited|referencelist|参考文献)$/i;
const APPENDIX_HEADING = /^(?:appendix|appendices|supplementary|supplemental|[A-Z](?:\.\d+)*\.?\s+\p{Lu})/u;
const EQ_NUMBER = /^\(\s*[A-Z]?\d{1,3}(\.\d+)?[a-z]?\s*\)$/;
/** short metric / acronym cells kept as written: bAcc, AUC, F1, IoU, mAP@50, CT/MRI (not plain words like "Lung") */
const ABBREVIATION = /^(?=\S{1,8}$)(?=.*(?:[A-Z].*[A-Z]|[a-z][A-Z]|[A-Za-z]\d|\d[A-Za-z]))[A-Za-z\d@/&.+-]+$/;
const NUMERIC = /^[\s\d.,:;%±+\-–—−()[\]/×x*✓✗✔✘↑↓]*$/;
const LETTERS = /\p{L}{2}/u;

/**
 * Pseudo-code: every visual line is its own left-aligned block (indentation kept, may use the box width);
 * the "Algorithm N …" line is a caption; formula-only lines stay as they are.
 */
function algorithmBlocks(region: Region, ops: ShowOp[], blocks: Block[], keep: (lines: Line[], kind: BlockKind, region: Block['region'], reason: string) => void) {
  const lines = buildLines(ops, { gap: 1.45, minGap: 10 }).sort((a, b) => b.baseline - a.baseline);
  for (const l of lines) {
    if (!LETTERS.test(l.text) || NUMERIC.test(l.text) || l.math > 0.6) {
      keep([l], 'other', 'algorithm', 'algorithm: formula line');
      continue;
    }
    const b = makeBlock([l], ALGORITHM.test(l.text) ? 'caption' : 'algo', 'algorithm', true);
    b.align = 'left';
    b.limit = { x0: b.box.x0, x1: Math.max(b.box.x1, region.box.x1 - 2), y0: b.box.y0, y1: b.box.y1 };
    blocks.push(b);
  }
}

function dominantColor(ops: ShowOp[]): Rgb {
  const w = new Map<string, number>();
  for (const o of ops) {
    if (!o.text.trim()) continue;
    const k = o.state.fill.map((c) => c.toFixed(3)).join(',');
    w.set(k, (w.get(k) ?? 0) + o.text.length);
  }
  let best = '0,0,0';
  let bw = -1;
  for (const [k, v] of w) if (v > bw) [best, bw] = [k, v];
  return best.split(',').map(Number) as Rgb;
}

// ------------------------------------------------------------------ main

export function analyzePage(model: PageTextModel, ctx: LayoutContext): PageLayout {
  const [vx0, vy0, vx1, vy1] = model.view;
  const pageArea = (vx1 - vx0) * (vy1 - vy0);
  const out: PageLayout = { pageIndex: ctx.pageIndex, view: model.view, bodySize: 10, regions: [], blocks: [] };
  const blocks: Block[] = [];
  const keep = (lines: Line[], kind: BlockKind, region: Block['region'], reason: string) =>
    blocks.push(makeBlock(lines, kind, region, false, reason));

  // usable text: visible, horizontal, from removable owners
  const multiUse = new Set(Object.entries(model.formUses).filter(([, n]) => n > 1).map(([k]) => k));
  const usable: ShowOp[] = [];
  const furniture: ShowOp[] = [];
  for (const o of model.ops) {
    if (o.rotated || o.hidden || o.state.Tr === 3 || o.state.Tr === 7 || o.op === '"') furniture.push(o);
    else if (o.owner && [...multiUse].some((m) => o.owner === m || o.owner.startsWith(`${m}/`))) furniture.push(o);
    else usable.push(o);
  }
  const bodySize = dominantSize(usable.filter((o) => !o.owner));
  out.bodySize = bodySize;

  // background colour under a line (highlight bars, coloured boxes): lines on different backgrounds never merge
  const fills = model.graphics.filter((g) => g.kind === 'path' && g.fill && /^[fFbB]/.test(g.paint ?? '') && g.fill.reduce((a, c) => a + c, 0) < 2.85 && g.w * g.h < pageArea * 0.5);
  const background = (l: Line) => {
    const x = (l.x0 + Math.min(l.x1, l.x0 + 40)) / 2;
    const y = l.baseline + l.size * 0.3;
    const hit = fills.filter((g) => x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h).sort((a, b) => a.w * a.h - b.w * b.h)[0];
    return hit ? hit.fill!.map((c) => c.toFixed(2)).join(',') : '';
  };

  const figures = figureRegions(model, pageArea);
  const tables = tableRegions(model, figures);
  out.regions = [...figures, ...tables];

  // assign ops to regions (form text belongs to the figure of its form)
  const inFigure = new Map<Region, ShowOp[]>();
  const inTable = new Map<Region, ShowOp[]>();
  const flow: ShowOp[] = [];
  for (const o of usable) {
    const b = opBox(o);
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    const fig = figures.find((f) => inside(cx, cy, f.box, 1));
    if (fig) {
      inFigure.set(fig, [...(inFigure.get(fig) ?? []), o]);
      continue;
    }
    const tab = tables.find((t) => inside(cx, cy, t.box, 0.5));
    if (tab) {
      inTable.set(tab, [...(inTable.get(tab) ?? []), o]);
      continue;
    }
    if (o.owner) {
      // text of a page-wrapping or small form outside any figure: treat as flow text
      flow.push(o);
      continue;
    }
    flow.push(o);
  }

  // ---- figures: each label cluster is its own block
  for (const [fig, ops] of inFigure) {
    const lines = buildLines(ops, { gap: 0.75, minGap: 2.5 });
    // legend markers: small icons, short arrows / line samples
    const icons = model.graphics.filter((g) => (g.kind === 'image' || g.kind === 'path') && Math.max(g.w, g.h) <= 26 && Math.min(g.w, g.h) <= 12);
    // an entry starts with a bold / coloured keyword or right after an icon
    const entryStart = (l: Line) => {
      const first = [...l.ops].filter((o) => o.text.trim()).sort((a, b) => a.x - b.x)[0];
      if (!first) return false;
      const styled = isBoldFont(first.baseFont) || first.state.fill.some((c) => c > 0.25);
      const icon = icons.some((g) => g.x + g.w <= l.x0 + 1 && g.x + g.w > l.x0 - 12 && Math.abs(g.y + g.h / 2 - (l.baseline + l.size * 0.3)) < l.size * 0.8);
      // "Thought 1:", "Action 2:", "Trial #1:" — numbered steps of a transcript start new entries even unstyled
      return (styled && /^[\p{L}\s-]{2,30}:/u.test(l.text)) || icon || /^\p{Lu}[\p{L}]{1,20}\s*#?\d{1,3}\s*:/u.test(l.text);
    };
    for (const group of clusterLines(lines, (a, b) => {
      const gap = a.baseline - b.baseline;
      const s = Math.max(a.size, b.size);
      if (entryStart(b)) return false;
      if (background(a) !== background(b)) return false;
      // legend entries in their own colours ("conv 3x3, ReLU" blue, "copy and crop" grey) are separate labels
      const ink = (l: Line) => (l.ops.find((o) => o.text.trim())?.state.fill ?? []).map((c) => c.toFixed(2)).join();
      if (ink(a) !== ink(b)) return false;
      return gap > 0 && gap < s * 1.45 && Math.abs(a.size - b.size) < s * 0.2 && hOverlap(lineBox(a), lineBox(b)) > Math.min(a.x1 - a.x0, b.x1 - b.x0) * 0.3 && Math.abs(a.x0 - b.x0) < s * 3;
    })) {
      const text = group.map((l) => l.text).join(' ');
      if (!LETTERS.test(text) || NUMERIC.test(text)) keep(group, 'other', 'figure', 'figure: no words');
      else {
        const b = makeBlock(group, 'label', 'figure', true);
        b.limit = { x0: b.box.x0, x1: Math.min(fig.box.x1, b.box.x1 + b.size * 0.5), y0: b.box.y0, y1: b.box.y1 };
        blocks.push(b);
      }
    }
  }

  // ---- tables: header cells may span two lines, data cells are single segments
  for (const [tab, ops] of inTable) {
    // ruled algorithm boxes look like booktabs tables (top / caption / bottom rules) but hold pseudo-code
    const algoCaption = usable.some((o) => ALGORITHM.test(o.text.trim()) && o.y <= tab.box.y1 + 25 && o.y >= tab.box.y0 && o.x >= tab.box.x0 - 30 && o.x <= tab.box.x1);
    if (algoCaption) {
      tab.kind = 'algorithm';
      algorithmBlocks(tab, ops, blocks, keep);
      continue;
    }
    const lines = joinColumnPieces(buildLines(ops, { gap: 0.45, minGap: 2.2 }));
    const rows = [...new Set(lines.map((l) => Math.round(l.baseline * 2) / 2))].sort((a, b) => b - a);
    const numericRow = rows.find((y) => lines.filter((l) => Math.abs(l.baseline - y) < 1 && NUMERIC.test(l.text)).length >= 2);
    // rows marked by a number column ("Id" 1, 2, 3 …): below the header, a line on a row's baseline starts a
    // cell, a line between row baselines continues the cell above it (wrapped descriptions)
    const rowStarts = numberColumn(lines);
    const firstRow = rowStarts.length ? Math.max(...rowStarts) : undefined;
    const header = (l: Line) => (firstRow !== undefined ? l.baseline > firstRow + 0.5 : numericRow === undefined || l.baseline > numericRow + 0.5);
    const groups = clusterLines(lines, (a, b) => {
      if (firstRow !== undefined && !header(a) && !header(b)) {
        if (NUMERIC.test(a.text) || NUMERIC.test(b.text)) return false;
        const gap = a.baseline - b.baseline;
        const s = Math.max(a.size, b.size);
        if (!(gap > 0 && gap < s * 1.45) || hOverlap(a, b) <= 0) return false;
        const sameColumn = Math.abs(a.x0 - b.x0) < 2 || Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2) < 2;
        return sameColumn && !rowStarts.some((y) => Math.abs(y - b.baseline) < 1);
      }
      if (!header(a) || !header(b) || NUMERIC.test(a.text) || NUMERIC.test(b.text)) return false;
      const gap = a.baseline - b.baseline;
      const s = Math.max(a.size, b.size);
      if (!(gap > 0 && gap < s * 1.3)) return false;
      // a two-line label is centred on one column; a spanning header has several sub-headers below it
      const wa = a.x1 - a.x0;
      const wb = b.x1 - b.x0;
      const centred = Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2) < Math.max(wa, wb) * 0.2;
      const siblings = lines.some((o) => o !== b && Math.abs(o.baseline - b.baseline) < 1 && hOverlap(o, a) > 0);
      return centred && !siblings && Math.max(wa, wb) / Math.max(1, Math.min(wa, wb)) < 2.6;
    });
    for (const group of groups) {
      const text = group.map((l) => l.text).join(' ');
      if (NUMERIC.test(text) || !LETTERS.test(text)) {
        keep(group, 'other', 'table', 'table: numbers/symbols');
        continue;
      }
      if (ABBREVIATION.test(text.trim())) {
        keep(group, 'other', 'table', 'table: metric / abbreviation');
        continue;
      }
      const b = makeBlock(group, 'cell', 'table', true);
      // a cell may grow sideways up to its neighbours in the same row band, never past the table
      const band = lines.filter((l) => !group.includes(l) && l.baseline <= b.box.y1 && l.baseline >= b.box.y0 - b.size * 0.3);
      // … up to the middle of the gap (the neighbour may grow too), symmetrically so it stays centred
      const left = Math.max(tab.box.x0, ...band.filter((l) => l.x1 <= b.box.x0 + 0.5).map((l) => (l.x1 + b.box.x0) / 2));
      const right = Math.min(tab.box.x1, ...band.filter((l) => l.x0 >= b.box.x1 - 0.5).map((l) => (l.x0 + b.box.x1) / 2));
      // column alignment from the other cells of the column: shared left edges → left, shared centres → centred
      const column = lines.filter((l) => !group.includes(l) && hOverlap(l, b.box) > 0 && !band.includes(l));
      const lefts = column.filter((l) => Math.abs(l.x0 - b.box.x0) < 1.5).length;
      const centres = column.filter((l) => Math.abs((l.x0 + l.x1) / 2 - (b.box.x0 + b.box.x1) / 2) < 1.5).length;
      const leftAligned = lefts > centres || (lefts > 0 && lefts === centres && group.length > 1);
      const cx = (b.box.x0 + b.box.x1) / 2;
      const half = Math.max((b.box.x1 - b.box.x0) / 2, Math.min(cx - left, right - cx));
      b.limit = leftAligned ? { x0: b.box.x0, x1: Math.max(b.box.x1, right), y0: b.box.y0, y1: b.box.y1 } : { x0: cx - half, x1: cx + half, y0: b.box.y0, y1: b.box.y1 };
      b.align = leftAligned ? 'left' : 'center';
      blocks.push(b);
    }
  }

  // ---- text flow
  const lines = mergeSectionNumbers(buildLines(flow, { gap: 1.45, minGap: 10, weak: 0.9, gutters: findGutters(flow) }));
  const textW = lines.length ? Math.max(...lines.map((l) => l.x1)) - Math.min(...lines.map((l) => l.x0)) : vx1 - vx0;
  const longLines = lines.filter((l) => l.x1 - l.x0 > textW * 0.33 && l.size >= bodySize * 0.9);
  const column = (l: { x0: number; x1: number }) => {
    const over = longLines.filter((m) => hOverlap(m, l) > 0);
    if (!over.length) return { x0: l.x0, x1: l.x1 };
    return { x0: median(over.map((m) => m.x0)), x1: median(over.map((m) => m.x1)) };
  };

  // equation lines
  const eqNumberLines = lines.filter((l) => EQ_NUMBER.test(l.text));
  const isEq = new Set<Line>(eqNumberLines);
  for (const l of lines) {
    if (isEq.has(l)) continue;
    const col = column(l);
    const indented = l.x0 > col.x0 + l.size * 1.5 && l.x1 < col.x1 - l.size * 1.5;
    const hasNumber = eqNumberLines.some((n) => Math.abs(n.baseline - l.baseline) < l.size * 0.6 && n.x0 > l.x1 && n.x1 <= col.x1 + l.size * 2);
    if (l.math >= 0.55 || (hasNumber && l.math > 0.05) || (indented && l.math >= 0.22)) isEq.add(l);
  }
  // grow equations: short centred pieces next to an equation (limits, case lines, sums)
  let grew = true;
  while (grew) {
    grew = false;
    for (const l of lines) {
      if (isEq.has(l)) continue;
      const col = column(l);
      const short = l.x1 - l.x0 < (col.x1 - col.x0) * 0.45 && l.x0 > col.x0 + l.size;
      const near = [...isEq].some((e) => Math.abs(e.baseline - l.baseline) < Math.max(e.size, l.size) * 1.6 && hOverlap({ x0: e.x0 - 20, x1: e.x1 + 20 }, l) > 0);
      if (short && near && (l.math > 0 || l.text.length <= 14)) {
        isEq.add(l);
        grew = true;
      }
    }
  }
  const eqGroups = groupBy(
    [...isEq],
    (a, b) =>
      (Math.abs(a.baseline - b.baseline) < Math.max(a.size, b.size) * 0.6 && hOverlap(column(a), column(b)) > 0) ||
      (Math.abs(a.baseline - b.baseline) < Math.max(a.size, b.size) * 2.4 && hOverlap({ x0: a.x0 - 60, x1: a.x1 + 60 }, b) > 0),
  );
  for (const g of eqGroups) keep(g, 'equation', 'text', 'display equation');

  // references. A reference zone starts at a "References" heading (or at the top of a page that continues
  // the list) and runs in reading order (columns left → right, top → bottom) until an appendix heading.
  // Without a heading, a page with ≥3 "[n] Author…" entries at the column's left edge is a reference page.
  const order = (l: Line) => {
    const c = column(l);
    return [c.x0 + (c.x1 - c.x0) / 2, l.baseline] as const;
  };
  const before = (a: Line, b: Line) => {
    const [ax, ay] = order(a);
    const [bx, by] = order(b);
    // a's column lies wholly left of b's column → earlier; same column → higher on the page is earlier
    const ca = column(a);
    const cb = column(b);
    if (ca.x1 <= cb.x0 + 2) return true;
    if (cb.x1 <= ca.x0 + 2) return false;
    return ay > by || (ay === by && ax < bx);
  };
  const headingLike = (l: Line) => l.bold || l.size >= bodySize * 1.05 || /^[\p{Lu}\d.\s]+$/u.test(l.text);
  const refHeading = lines.find((l) => !isEq.has(l) && REF_HEADING.test(l.text.replace(/\s+/g, '')) && headingLike(l));
  const refStarts = lines.filter((l) => !isEq.has(l) && REF_ENTRY.test(l.text) && l.x0 < column(l).x0 + l.size * 1.5);
  const zoneStart = refHeading ?? (ctx.inReferences ? null : refStarts.length >= 3 ? refStarts.reduce((a, b) => (before(b, a) ? b : a)) : undefined);
  const refZone = zoneStart !== undefined;
  const appendix = refZone
    ? lines
        .filter((l) => l !== zoneStart && APPENDIX_HEADING.test(l.text) && (l.bold || l.size >= bodySize * 1.05) && (zoneStart === null || before(zoneStart, l)))
        .reduce<Line | undefined>((a, b) => (!a || before(b, a) ? b : a), undefined)
    : undefined;
  const inRefZone = (l: Line) => refZone && (zoneStart === null || zoneStart === l || before(zoneStart, l)) && !(appendix && (appendix === l || before(appendix, l)));
  const refPage = refZone;

  // paragraphs
  const textLines = lines.filter((l) => !isEq.has(l));
  type Open = { lines: Line[]; closed: boolean };
  const paras: Open[] = [];
  for (const l of textLines) {
    const col = column(l);
    // "Fig. 4. First, …" in the middle of a sentence is a reference to a figure, not a caption
    const midSentence = (p: Open) => {
      const last = p.lines[p.lines.length - 1];
      const gap = last.baseline - l.baseline;
      return !p.closed && gap > 0 && gap <= Math.max(last.size, l.size) * 1.75 && Math.abs(last.size - l.size) < l.size * 0.07 && hOverlap(last, l) > 0 && !/[.:!?。]$/.test(last.text.trim());
    };
    const starts = (CAPTION.test(l.text) && !paras.some(midSentence)) || (refPage && inRefZone(l) && REF_START.test(l.text)) || l === refHeading || l === appendix;
    // a bold numbered title wrapped onto a second line: the next line's first word did not fit on the first
    const wrapsTitle = (p: Open, l: Line) => {
      const last = p.lines[0];
      if (p.lines.length !== 1 || !last.bold || !l.bold || Math.abs(last.size - l.size) > 0.3) return false;
      if (!/^(?:\d+(?:\.\d+)*\.?|[A-Z](?:\.\d+)*\.?)\s+\S/.test(last.text.trim()) || /[.:!?]$/.test(last.text.trim())) return false;
      const gap = last.baseline - l.baseline;
      if (gap <= 0 || gap > l.size * 1.6 || l.x0 < last.x0 - 1 || l.x0 - last.x0 > l.size * 4) return false;
      const word = l.text.trim().split(/\s+/)[0];
      const wordW = ((l.x1 - l.x0) * word.length) / Math.max(1, l.text.trim().length);
      return last.x1 + l.size * 0.25 + wordW > col.x1 - l.size * 0.5;
    };
    const runIn = l.ops.length > 1 && isBoldFont(l.ops.filter((o) => o.text.trim()).sort((a, b) => a.x - b.x)[0]?.baseFont ?? '') && !l.bold;
    let target: Open | undefined;
    if (!starts) {
      for (const p of paras) {
        if (p.closed && !wrapsTitle(p, l)) continue;
        const last = p.lines[p.lines.length - 1];
        const gap = last.baseline - l.baseline;
        const s = Math.max(last.size, l.size);
        if (gap <= 0 || gap > s * 1.75) continue;
        if (Math.abs(last.size - l.size) > s * 0.07) continue;
        // a rule between the two lines (footnote separator, table rule — not a fraction / radical bar) ends the paragraph
        if (model.rules.some((r) => r.w > s * 3 && r.y < last.baseline - last.size * 0.25 && r.y > l.baseline + l.size * 0.85 && hOverlap({ x0: r.x, x1: r.x + r.w }, l) > 0)) continue;
        // bold ↔ regular separates a heading from its text — unless a long bold line breaks mid-sentence
        // ("Figure 1: Training loss over train tokens for the 7B," → "13B, 33B, and 65 models. LLaMA-33B …")
        const midBold = last.bold && !l.bold && last.x1 - last.x0 > (col.x1 - col.x0) * 0.7 && /[,;\-–(]$|\p{Ll}$|\d$|\p{Lu}$/u.test(last.text.trim()) && !/[.:!?]$/.test(last.text.trim()) && !/^(?:\d+(?:\.\d+)*\.?|[A-Z](?:\.\d+)+\.?)\s+\p{Lu}/u.test(last.text.trim());
        if (last.bold !== l.bold && (last.bold || l.bold) && !midBold) continue;
        if (background(last) !== background(l)) continue;
        const pb = { x0: Math.min(...p.lines.map((x) => x.x0)), x1: Math.max(...p.lines.map((x) => x.x1)) };
        if (hOverlap(pb, l) < Math.min(pb.x1 - pb.x0, l.x1 - l.x0) * 0.5) continue;
        // centred lines (titles, headers) share an axis rather than a left edge
        const sameAxis = Math.abs((l.x0 + l.x1) / 2 - (last.x0 + last.x1) / 2) < s * 0.8 && Math.abs((pb.x0 + pb.x1) / 2 - (last.x0 + last.x1) / 2) < s * 0.8;
        if (l.x0 > pb.x0 + s * 6 && !sameAxis) continue;
        // new paragraph: indented first line after a short last line, or a run-in bold heading
        // the right edge the paragraph runs to: the column's, unless the paragraph is narrower (indented abstract)
        const reach = Math.max(...p.lines.map((x) => x.x1), l.x1);
        const lastShort = last.x1 < (Math.abs(col.x1 - reach) < s * 2 ? col.x1 : reach) - s * 2;
        // a wrapped numbered title hangs its second line under the title text: "3.6 Massive Multitask Language" / "Understanding"
        const hangingTitle = last.bold && l.bold && p.lines.length === 1 && /^(?:\d+(?:\.\d+)*\.?|[A-Z](?:\.\d+)*\.?)\s+\S/.test(last.text.trim()) && l.x0 - last.x0 < s * 4;
        const indented = !hangingTitle && l.x0 > Math.min(...p.lines.map((x) => x.x0)) + s * 0.7;
        if ((lastShort && /[.:!?。)]$/.test(last.text)) || (indented && lastShort) || (runIn && (lastShort || /[.:!?。)\]]$/.test(last.text.trim())))) continue;
        // a numbered sub-section title on its own short line ("3.1.1 Anchors") is not the start of the paragraph
        // (bold titles are separated by the bold ↔ regular rule, and may wrap: "3.6 Massive Multitask Language" / "Understanding")
        if (p.lines.length === 1 && !last.bold && !l.bold && lastShort && NUMBERED_HEADING.test(last.text.trim()) && last.text.trim().split(/\s+/).length <= 9) continue;
        // extra vertical space (\parskip) after a sentence end starts a new paragraph
        if (p.lines.length >= 2) {
          const pitch = Math.min(...p.lines.slice(1).map((x, i) => p.lines[i].baseline - x.baseline));
          if (gap > pitch * 1.3 + 0.5 && /[.:!?。)\]]$/.test(last.text)) continue;
        }
        if (refPage && inRefZone(l) && REF_START.test(l.text)) continue;
        if (BULLET.test(l.text)) continue;
        if (inRefZone(l) !== inRefZone(last)) continue;
        target = p;
        break;
      }
    }
    if (target) target.lines.push(l);
    else paras.push({ lines: [l], closed: false });
    // headings never take continuation lines; an equation below closes nothing (gap rules suffice)
    if (l.bold && l.x1 - l.x0 < (col.x1 - col.x0) * 0.8) (target ?? paras[paras.length - 1]).closed = true;
  }

  // classify paragraphs
  const titleSize = ctx.pageIndex === 0 ? Math.max(...textLines.filter((l) => l.baseline > vy0 + (vy1 - vy0) * 0.55).map((l) => l.size), 0) : 0;
  const runInBold = (l: Line) => isBoldFont([...l.ops].filter((o) => o.text.trim()).sort((a, b) => a.x - b.x)[0]?.baseFont ?? '');
  const abstractLine = ctx.pageIndex === 0 ? textLines.find((l) => /^abstract\b/i.test(l.text.trim()) && (l.bold || l.text.trim().length <= 12 || runInBold(l))) : undefined;
  const titleLines = titleSize >= bodySize * 1.3 ? textLines.filter((l) => l.size >= titleSize * 0.92) : [];
  const titleBottom = titleLines.length ? Math.min(...titleLines.map((l) => l.baseline)) : Infinity;

  for (const p of paras) {
    const text = p.lines.map((l) => l.text).join(' ');
    const first = p.lines[0];
    const size = median(p.lines.map((l) => l.size));
    let kind: BlockKind = 'body';
    let translate = true;
    let reason: string | undefined;
    if (titleLines.includes(first)) kind = 'title';
    else if (ctx.pageIndex === 0 && abstractLine && first.baseline > abstractLine.baseline + 1 && first.baseline < titleBottom) {
      kind = 'author';
      translate = false;
      reason = 'author block kept as original';
    } else if (refPage && inRefZone(first) && first !== refHeading && !CAPTION.test(first.text)) {
      kind = 'reference';
      translate = false;
      reason = REF_START.test(first.text) ? 'reference entry kept as original' : 'reference continuation kept as original';
    } else if (CAPTION.test(first.text)) kind = 'caption';
    else if (p.lines.every((l) => l.bold) && p.lines.length <= 3) kind = 'heading';
    // small-caps / all-caps headings ("1 INTRODUCTION", "ABSTRACT", "3.1 VISION TRANSFORMER (VIT)")
    else if (p.lines.length <= 2 && CAPS_HEADING.test(text) && text.replace(/[^\p{L}]/gu, '').length >= 4 && p.lines.every((l) => l.x1 - l.x0 < (column(l).x1 - column(l).x0) * 0.8)) kind = 'heading';
    else if (size >= bodySize * 1.15 && p.lines.length <= 2) kind = 'heading';
    else if (p.lines.length === 1 && NUMBERED_HEADING.test(text) && text.split(/\s+/).length <= 9 && first.x1 - first.x0 < (column(first).x1 - column(first).x0) * 0.7) kind = 'heading';
    else if (size <= bodySize * 0.9 && first.baseline < vy0 + (vy1 - vy0) * 0.22) kind = 'footnote';
    if (translate && (!LETTERS.test(text) || NUMERIC.test(text))) {
      kind = 'other';
      translate = false;
      reason = 'no words (page number / symbols)';
    }
    blocks.push(makeBlock(p.lines, kind, 'text', translate, reason));
  }

  // furniture (rotated stamps, invisible OCR text, shared forms) is never touched and not listed

  // ---- geometry: alignment, limits, order
  const obstacles = (b: Block) => [
    ...blocks.filter((o) => o !== b).map((o) => o.box),
    ...out.regions.map((r) => r.box),
  ];
  for (const b of blocks) {
    if (b.region !== 'text') continue;
    const col = column({ x0: b.box.x0, x1: b.box.x1 });
    // alignment
    const centres = b.lines.map((l) => (l.x0 + l.x1) / 2);
    const colMid = (col.x0 + col.x1) / 2;
    const centred = b.lines.every((l, i) => Math.abs(centres[i] - colMid) < l.size * 0.3) &&
      (b.lines.some((l) => l.x0 > col.x0 + Math.min(l.size, 10) * 0.6) ||
        Math.max(...b.lines.map((l) => l.x1 - l.x0)) - Math.min(...b.lines.map((l) => l.x1 - l.x0)) > Math.min(b.size, 10));
    // lines centred on each other (page headers centred on the page, not on the text column)
    const widths = b.lines.map((l) => l.x1 - l.x0);
    const selfCentred = b.lines.length >= 2 && Math.max(...centres) - Math.min(...centres) < b.size * 0.6 && Math.max(...widths) - Math.min(...widths) > b.size * 1.5;
    b.align = centred || selfCentred ? 'center' : b.lines.length > 1 ? 'justify' : 'left';
    if (selfCentred) b.indent = 0;
    if (b.kind === 'heading' || b.kind === 'title') b.align = centred || selfCentred ? 'center' : 'left';
    // limit: grow down into free space (never into another block, figure, table or equation)
    const below = obstacles(b).filter((o) => o.y1 <= b.box.y0 + 0.5 && hOverlap(o, b.box) > 0);
    const floor = Math.max(vy0 + 18, ...below.map((o) => o.y1 + 1.5));
    let right = b.align === 'justify' ? Math.max(b.box.x1, Math.min(col.x1, b.box.x1 + b.size)) : b.box.x1;
    if (b.align === 'left') {
      // a short left-aligned line ("Received: July 5, 2019") may run to the right edge of the text around it,
      // up to the next thing on its right
      const near = blocks.filter((o) => o !== b && o.region === 'text' && Math.abs(o.box.x0 - b.box.x0) < b.size * 2 && Math.min(Math.abs(o.box.y0 - b.box.y1), Math.abs(b.box.y0 - o.box.y1)) < b.size * 6);
      const edge = Math.max(b.box.x1, col.x1, ...near.map((o) => o.box.x1));
      const blockers = obstacles(b).filter((o) => o.x0 >= b.box.x1 - 0.5 && o.y0 < b.box.y1 && o.y1 > b.box.y0);
      right = Math.max(b.box.x1, Math.min(edge, ...blockers.map((o) => o.x0 - 2)));
    }
    b.limit = { x0: b.box.x0, x1: right, y0: Math.min(b.box.y0, floor), y1: b.box.y1 };
  }
  const mid = (vx0 + vx1) / 2;
  const colKey = (b: Block) => (b.box.x0 >= mid - 10 && b.box.x1 - b.box.x0 < (vx1 - vx0) * 0.55 ? 1 : 0);
  blocks.sort((a, b) => colKey(a) - colKey(b) || b.box.y1 - a.box.y1 || a.box.x0 - b.box.x0);
  blocks.forEach((b, i) => {
    b.order = i;
    b.id = `${ctx.pageIndex}-${i}-${b.kind}`;
  });
  out.blocks = blocks;
  return out;
}

/** "3.1.1 Anchors", "A.2 Training details": a numbered sub-section title on a line of its own (often italic) */
const NUMBERED_HEADING = /^(?:\d+(?:\.\d+)+\.?|[A-Z]\.\d+(?:\.\d+)*\.?)\s+\p{Lu}[^.!?;,]{0,70}$/u;
const SECTION_NUMBER = /^(?:\d+(?:\.\d+)*\.?|[IVX]+\.|[A-Z]\.?)$/;
/** "2." set an em away from "THE CASE FOR EXPLANATIONS" (a separate TJ fragment) is part of that heading line. */
function mergeSectionNumbers(lines: Line[]): Line[] {
  const drop = new Set<Line>();
  for (const a of lines) {
    if (!SECTION_NUMBER.test(a.text.trim())) continue;
    const b = lines.find((l) => l !== a && !drop.has(l) && Math.abs(l.baseline - a.baseline) < a.size * 0.2 && l.x0 >= a.x1 - 0.5 && l.x0 - a.x1 < a.size * 2.5 && Math.abs(l.size - a.size) < a.size * 0.15);
    if (!b) continue;
    b.ops = [...a.ops, ...b.ops];
    b.x0 = a.x0;
    b.text = `${a.text.trim()} ${b.text}`;
    b.bold = a.bold && b.bold;
    drop.add(a);
  }
  return drop.size ? lines.filter((l) => !drop.has(l)) : lines;
}

/** Connected components under a symmetric relation. */
function groupBy<T>(items: T[], joins: (a: T, b: T) => boolean): T[][] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (joins(items[i], items[j])) parent[find(i)] = find(j);
  const out = new Map<number, T[]>();
  items.forEach((it, i) => out.set(find(i), [...(out.get(find(i)) ?? []), it]));
  return [...out.values()];
}

/**
 * Vertical white bands between text columns: x ranges no flow text crosses, found from glyph
 * coverage across the page (full-width lines such as titles may cross a few times).
 */
export function findGutters(ops: ShowOp[]): [number, number][] {
  const text = ops.filter((o) => o.text.trim() && o.width > 0);
  if (text.length < 20) return [];
  const x0 = Math.floor(Math.min(...text.map((o) => o.x)));
  const x1 = Math.ceil(Math.max(...text.map((o) => o.x + o.width)));
  const bins = new Array(Math.max(1, x1 - x0)).fill(0);
  const rows = new Set<number>();
  for (const o of text) {
    rows.add(Math.round(o.y));
    for (let x = Math.floor(o.x) - x0; x < Math.ceil(o.x + o.width) - x0; x++) if (x >= 0 && x < bins.length) bins[x]++;
  }
  const scan = (limit: number) => {
    const out: [number, number][] = [];
    let start = -1;
    const w = bins.length;
    for (let i = 0; i <= w; i++) {
      const free = i < w && bins[i] <= limit;
      if (free && start < 0) start = i;
      if (!free && start >= 0) {
        if (i - start >= 6 && start > w * 0.25 && i < w * 0.75) out.push([x0 + start, x0 + i]);
        start = -1;
      }
    }
    return out;
  };
  const strict = scan(Math.max(2, rows.size * 0.04));
  if (strict.length) return strict;
  // a full-width block (algorithm, wide table, equation) crossing the gutter on part of the page: accept a
  // gap that many lines cross, if many rows end just left of it and start just right of it (two real columns)
  // (the two columns' baselines need not match exactly)
  return scan(rows.size * 0.3).filter(([g0, g1]) => {
    const ends = text.filter((o) => o.x + o.width <= g0 + 1 && o.x + o.width > g0 - 25);
    const starts = text.filter((o) => o.x >= g1 - 1 && o.x < g1 + 25);
    const both = new Set(ends.filter((e) => starts.some((st) => Math.abs(st.y - e.y) < 2.5) && !text.some((o) => Math.abs(o.y - e.y) < 1 && o.x < g0 && o.x + o.width > g1)).map((e) => Math.round(e.y)));
    return both.size >= Math.max(5, rows.size * 0.15);
  });
}

function clusterLines(lines: Line[], joins: (upper: Line, lower: Line) => boolean): Line[][] {
  const groups: Line[][] = [];
  for (const l of [...lines].sort((a, b) => b.baseline - a.baseline || a.x0 - b.x0)) {
    const g = groups.find((g) => joins(g[g.length - 1], l));
    if (g) g.push(l);
    else groups.push([l]);
  }
  return groups;
}

function makeBlock(lines: Line[], kind: BlockKind, region: Block['region'], translate: boolean, reason?: string): Block {
  const ops = lines.flatMap((l) => l.ops);
  const box = unionBox(lines.map(lineBox));
  const size = median(lines.map((l) => l.size)) || 10;
  const gaps = lines.slice(1).map((l, i) => lines[i].baseline - l.baseline).filter((g) => g > 0);
  const firstX = lines[0]?.x0 ?? box.x0;
  const restX = lines.length > 1 ? Math.min(...lines.slice(1).map((l) => l.x0)) : box.x0;
  return {
    id: '',
    kind,
    region,
    lines,
    ops,
    box,
    limit: box,
    size,
    pitch: median(gaps),
    indent: lines.length > 1 && firstX - restX > size * 0.5 ? firstX - restX : 0,
    align: 'left',
    bold: lines.every((l) => l.bold),
    color: dominantColor(ops),
    order: 0,
    translate,
    reason,
  };
}

/** Plain-data summary of a layout for diagnostics (no PDF objects). */
export function describeLayout(l: PageLayout) {
  const r = (b: Box) => [b.x0, b.y0, b.x1, b.y1].map((v) => Math.round(v * 10) / 10);
  return {
    page: l.pageIndex + 1,
    bodySize: l.bodySize,
    regions: l.regions.map((x) => ({ kind: x.kind, box: r(x.box), source: x.source })),
    blocks: l.blocks.map((b) => ({
      id: b.id,
      kind: b.kind,
      region: b.region,
      translate: b.translate,
      reason: b.reason,
      box: r(b.box),
      limit: r(b.limit),
      size: Math.round(b.size * 10) / 10,
      pitch: Math.round(b.pitch * 10) / 10,
      align: b.align,
      bold: b.bold,
      color: b.color,
      ops: b.ops.length,
      owners: [...new Set(b.ops.map((o) => o.owner || 'page'))],
      text: b.lines.map((x) => x.text).join(' ').slice(0, 160),
    })),
  };
}

export type { GraphicOp };

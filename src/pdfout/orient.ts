/**
 * Pages whose text runs sideways: a landscape table or figure set on a portrait page (\begin{sidewaystable},
 * rotated appendix tables). The page itself is not rotated (/Rotate 0); its text is drawn with a quarter-turn
 * text matrix. We turn the page's text model upright ("the frame"), run the usual layout analysis and
 * typesetting in that frame, and draw the result through the inverse transform (one `cm`), so tables,
 * formulas and captions of such pages are handled exactly like upright ones.
 */
import type { GraphicOp, PageTextModel, RuleOp, ShowOp } from './engine';

export type Matrix = [number, number, number, number, number, number];

/** compose(A, B): apply B first, then A (column-vector convention, as in engine.ts) */
export function compose([a, b, c, d, e, f]: Matrix, [g, h, i, j, k, l]: Matrix): Matrix {
  return [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f];
}

export function invert([a, b, c, d, e, f]: Matrix): Matrix {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export const apply = ([a, b, c, d, e, f]: Matrix, x: number, y: number): [number, number] => [a * x + c * y + e, b * x + d * y + f];

/** Quarter turns (0–3, counter-clockwise) of an op's baseline; -1 for skewed, mirrored or odd angles. */
export function quarterOf(trm: Matrix): number {
  const [a, b, c, d] = trm;
  const angle = (Math.atan2(b, a) * 180) / Math.PI;
  const q = Math.round(angle / 90);
  if (Math.abs(angle - q * 90) > 2) return -1;
  // upright glyphs: the text space y axis is a quarter turn counter-clockwise from its x axis
  if (a * d - b * c <= 0) return -1;
  return ((q % 4) + 4) % 4;
}

// exact rotations by -q quarter turns (no floating-point noise in b / c)
const UNTURN: Matrix[] = [
  [1, 0, 0, 1, 0, 0],
  [0, -1, 1, 0, 0, 0],
  [-1, 0, 0, -1, 0, 0],
  [0, 1, -1, 0, 0, 0],
];

function boxOf(m: Matrix, x: number, y: number, w: number, h: number) {
  const pts = [apply(m, x, y), apply(m, x + w, y), apply(m, x, y + h), apply(m, x + w, y + h)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/**
 * The upright frame of a page whose text mostly runs sideways, or null for a normal page. `frame` maps page
 * user space into the frame; the returned model has every op, rule, graphic and the view in frame coordinates.
 */
export function orientPage(model: PageTextModel): { model: PageTextModel; frame: Matrix } | null {
  const chars = [0, 0, 0, 0];
  let total = 0;
  for (const o of model.ops) {
    if (o.hidden) continue;
    const n = o.text.replace(/\s/g, '').length;
    total += n;
    const q = quarterOf(o.trm as Matrix);
    if (q >= 0) chars[q] += n;
  }
  const q = chars.indexOf(Math.max(...chars));
  if (q === 0 || total < 40 || chars[q] < total * 0.6) return null;
  const turn = UNTURN[q];
  // keep the frame's coordinates positive: its view starts where the page's view starts
  const [vx0, vy0, vx1, vy1] = model.view;
  const v = boxOf(turn, vx0, vy0, vx1 - vx0, vy1 - vy0);
  const frame: Matrix = [...turn.slice(0, 4), turn[4] - v.x + vx0, turn[5] - v.y + vy0] as Matrix;
  const ops: ShowOp[] = model.ops.map((o) => {
    const trm = compose(frame, o.trm as Matrix);
    const [a, b, c, d] = trm;
    const h = Math.hypot(a, b);
    const vert = Math.hypot(c, d);
    return { ...o, x: trm[4], y: trm[5], trm, rotated: Math.abs(b) > 1e-6 * h || Math.abs(c) > 1e-6 * vert || a < 0 || d < 0 };
  });
  const rules: RuleOp[] = model.rules.map((r) => ({ ...r, ...boxOf(frame, r.x, r.y, r.w, r.h) }));
  const graphics: GraphicOp[] = model.graphics.map((g) => ({ ...g, ...boxOf(frame, g.x, g.y, g.w, g.h) }));
  const fv = boxOf(frame, vx0, vy0, vx1 - vx0, vy1 - vy0);
  return { model: { ...model, ops, rules, graphics, view: [fv.x, fv.y, fv.x + fv.w, fv.y + fv.h] }, frame };
}

import { describe, expect, it } from 'vitest';
import type { PageTextModel, ShowOp } from '../engine';
import { apply, compose, invert, orientPage, quarterOf, type Matrix } from '../orient';

const op = (text: string, trm: Matrix, i: number): ShowOp =>
  ({ index: i, owner: '', opIndex: i, id: `#${i}`, x: trm[4], y: trm[5], width: text.length * 5, size: 10, rotated: true, fontRes: 'F1', baseFont: 'Times-Roman', text, op: 'Tj', tfSize: 10, state: { Tc: 0, Tw: 0, Tz: 100, Ts: 0, Tr: 0, fill: [0, 0, 0] }, trm, raw: '' }) as ShowOp;
const page = (ops: ShowOp[]): PageTextModel => ({ pageIndex: 0, view: [0, 0, 595, 842], rotate: 0, ops, rules: [{ index: 1, x: 100, y: 50, w: 0.4, h: 700 }], graphics: [], formUses: {} });

describe('orientPage', () => {
  it('reads the quarter turn of a text matrix', () => {
    expect(quarterOf([10, 0, 0, 10, 0, 0])).toBe(0);
    expect(quarterOf([0, 10, -10, 0, 0, 0])).toBe(1);
    expect(quarterOf([0, -10, 10, 0, 0, 0])).toBe(3);
    expect(quarterOf([10, 0, 0, -10, 0, 0])).toBe(-1); // mirrored
    expect(quarterOf([10, 3, 0, 10, 0, 0])).toBe(-1); // skewed
  });
  it('leaves upright pages alone', () => {
    expect(orientPage(page([op('An ordinary line of upright body text, long enough.', [10, 0, 0, 10, 72, 700], 0)]))).toBeNull();
  });
  it('turns a sideways table page upright and maps back exactly', () => {
    // text reading bottom-to-top (90° counter-clockwise), as \begin{sidewaystable} draws it
    const ops = [0, 1, 2].map((k) => op('Table 10: Experimental results of four types of models', [0, 10, -10, 0, 500 - k * 12, 80], k));
    ops.push(op('13531', [10, 0, 0, 10, 285, 50], 3)); // upright page number
    const r = orientPage(page(ops))!;
    expect(r).not.toBeNull();
    const [a, b, c, d] = r.model.ops[0].trm;
    expect([a, b, c, d]).toEqual([10, 0, 0, 10]);
    expect(r.model.ops[0].rotated).toBe(false);
    expect(r.model.ops[3].rotated).toBe(true); // the page number is now the sideways one
    // landscape frame, positive coordinates
    expect(r.model.view[2] - r.model.view[0]).toBeCloseTo(842);
    expect(r.model.view[3] - r.model.view[1]).toBeCloseTo(595);
    for (const o of r.model.ops) expect(o.x).toBeGreaterThanOrEqual(0);
    // a vertical rule on the page is a horizontal rule in the frame
    expect(r.model.rules[0].w).toBeCloseTo(700);
    // drawing through the inverse puts frame points back where they were
    const back = invert(r.frame);
    const [px, py] = apply(back, r.model.ops[1].x, r.model.ops[1].y);
    expect(px).toBeCloseTo(488);
    expect(py).toBeCloseTo(80);
    expect(compose(back, r.frame).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

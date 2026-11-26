import { describe, expect, it } from 'vitest';
import type { InkStroke } from '../../db/db';
import { appendInkPoint, pointsToSvgPath, renderStrokeWidth, strokeHitsPoint } from '../ink';

describe('Apple Pencil / freehand ink helpers', () => {
  it('decimates micro-jitter points and clamps coordinates/pressure', () => {
    let pts = appendInkPoint([], 0.5, 0.5, 0.8, 0);
    pts = appendInkPoint(pts, 0.5002, 0.5002, 0.8); // too close -> ignored
    expect(pts).toHaveLength(1);
    pts = appendInkPoint(pts, 1.5, -0.2, 2.0); // clamped
    expect(pts).toHaveLength(2);
    expect(pts[1]).toEqual([1, 0, 1]);
  });

  it('builds smooth midpoint quadratic Bézier SVG paths', () => {
    expect(pointsToSvgPath([[0.1, 0.2, 0.5]], 100, 200)).toBe('M 10 40 L 10.01 40');
    const path = pointsToSvgPath(
      [
        [0.1, 0.1, 0.5],
        [0.2, 0.3, 0.7],
        [0.4, 0.2, 0.6],
      ],
      100,
      100,
    );
    expect(path).toBe('M 10 10 Q 20 30 30 25 L 40 20');
  });

  it('modulates pen width by pressure and keeps highlighter width flat', () => {
    const light = renderStrokeWidth({ kind: 'pen', width: 2, points: [[0, 0, 0.1]] }, 1);
    const heavy = renderStrokeWidth({ kind: 'pen', width: 2, points: [[0, 0, 1.0]] }, 1);
    expect(heavy).toBeGreaterThan(light);
    expect(renderStrokeWidth({ kind: 'highlighter', width: 16, points: [[0, 0, 0.1]] }, 1.5)).toBe(24);
  });

  it('hit-tests eraser points accurately along stroke segments', () => {
    const stroke: InkStroke = {
      id: 's1',
      docId: 'd1',
      pageIndex: 0,
      kind: 'pen',
      color: '#e11d48',
      width: 2.2,
      points: [
        [0.1, 0.5, 0.5],
        [0.9, 0.5, 0.5],
      ],
      createdAt: 1,
    };
    expect(strokeHitsPoint(stroke, 0.5, 0.51)).toBe(true);
    expect(strokeHitsPoint(stroke, 0.5, 0.7)).toBe(false);
  });
});

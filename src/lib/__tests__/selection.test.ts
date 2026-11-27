import { describe, expect, it } from 'vitest';
import type { NoteRecord } from '../../db/db';
import { filterPageNotes, noteLayer, resolveSelectionTarget, type ClientBox } from '../selection';

function box(left: number, top: number, width: number, height: number): ClientBox {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

describe('PDF selection & dual-layer highlight helpers', () => {
  it('resolves text selections on original pages', () => {
    const orig = [box(100, 50, 400, 600)];
    const trans = [box(520, 50, 400, 600)];
    const res = resolveSelectionTarget(
      [
        { left: 140, top: 110, width: 100, height: 18 },
        { left: 240, top: 110, width: 80, height: 18 },
      ],
      orig,
      trans,
    );
    expect(res).not.toBeNull();
    expect(res!.layer).toBe('original');
    expect(res!.pageIndex).toBe(0);
    expect(res!.multiPage).toBe(false);
    expect(res!.rects).toHaveLength(1);
    expect(res!.rects[0].x).toBeCloseTo(0.1);
    expect(res!.rects[0].w).toBeCloseTo(0.45);
  });

  it('resolves text selections on translated pages in dual mode and translated-only mode', () => {
    const origDual = [box(100, 50, 400, 600)];
    const transDual = [box(520, 50, 400, 600)];
    const dualRes = resolveSelectionTarget([{ left: 560, top: 200, width: 160, height: 24 }], origDual, transDual);
    expect(dualRes).toMatchObject({ pageIndex: 0, layer: 'translated', multiPage: false });
    expect(dualRes!.rects[0].x).toBeCloseTo(0.1);
    expect(dualRes!.rects[0].y).toBeCloseTo(0.25);

    // Translated-only mode: original page refs are null
    const transOnlyRes = resolveSelectionTarget(
      [{ left: 140, top: 200, width: 200, height: 24 }],
      [null, null],
      [box(100, 50, 400, 600), box(100, 670, 400, 600)],
    );
    expect(transOnlyRes).toMatchObject({ pageIndex: 0, layer: 'translated', multiPage: false });
  });

  it('marks selections spanning pages or original/translated columns as multiPage', () => {
    const orig = [box(100, 50, 400, 600)];
    const trans = [box(520, 50, 400, 600)];
    const res = resolveSelectionTarget(
      [
        { left: 540, top: 100, width: 120, height: 18 },
        { left: 540, top: 130, width: 120, height: 18 },
        { left: 150, top: 100, width: 120, height: 18 },
      ],
      orig,
      trans,
    );
    expect(res).toMatchObject({ pageIndex: 0, layer: 'translated', multiPage: true });
  });

  it('returns null when rects fall outside all page boxes', () => {
    const res = resolveSelectionTarget([{ left: 10, top: 10, width: 50, height: 16 }], [box(100, 50, 400, 600)], [null]);
    expect(res).toBeNull();
  });

  it('separates original (including legacy undefined) and translated highlight notes', () => {
    const base = { docId: 'd1', pageIndex: 1, rects: [], quote: 'q', color: 'yellow' as const, comment: '', createdAt: 1 };
    const notes: NoteRecord[] = [
      { ...base, id: 'legacy' },
      { ...base, id: 'orig', layer: 'original' },
      { ...base, id: 'trans', layer: 'translated' },
      { ...base, id: 'other-page', pageIndex: 2, layer: 'translated' },
    ];
    expect(noteLayer(notes[0])).toBe('original');
    expect(noteLayer(notes[2])).toBe('translated');
    expect(filterPageNotes(notes, 1, 'original')?.map((n) => n.id)).toEqual(['legacy', 'orig']);
    expect(filterPageNotes(notes, 1, 'translated')?.map((n) => n.id)).toEqual(['trans']);
  });
});

import type { InkTarget, NoteRecord, NRect } from '../db/db';

export interface ClientBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface SelectionTarget {
  pageIndex: number;
  layer: InkTarget;
  rects: NRect[];
  multiPage: boolean;
}

/** Resolve which page layer a highlight note belongs to (legacy notes without `layer` belong to 'original'). */
export function noteLayer(note: Pick<NoteRecord, 'layer'>): InkTarget {
  return note.layer === 'translated' ? 'translated' : 'original';
}

/** Filter a document's highlight notes to a specific page and layer ('original' or 'translated'). */
export function filterPageNotes(notes: NoteRecord[] | undefined, pageIndex: number, layer: InkTarget): NoteRecord[] | undefined {
  if (!notes) return undefined;
  return notes.filter((n) => n.pageIndex === pageIndex && noteLayer(n) === layer);
}

/** Merge rects on the same line that touch/overlap (text layer produces one per span). */
export function mergeRects(rects: NRect[]): NRect[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: NRect[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - r.y) < last.h * 0.5 && r.x <= last.x + last.w + 0.01) {
      const x2 = Math.max(last.x + last.w, r.x + r.w);
      const y2 = Math.max(last.y + last.h, r.y + r.h);
      last.x = Math.min(last.x, r.x);
      last.y = Math.min(last.y, r.y);
      last.w = x2 - last.x;
      last.h = y2 - last.y;
    } else out.push({ ...r });
  }
  return out;
}

/**
 * Assign browser selection client rects to the matching original or translated PDF page box.
 * Keeps the single `(layer, pageIndex)` target with the most rects, flagging `multiPage` when
 * the selection spans multiple pages or crosses between original and translated columns.
 */
export function resolveSelectionTarget(
  clientRects: ReadonlyArray<Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>>,
  originalBoxes: ReadonlyArray<ClientBox | null | undefined>,
  translatedBoxes: ReadonlyArray<ClientBox | null | undefined>,
): SelectionTarget | null {
  const byTarget = new Map<string, { pageIndex: number; layer: InkTarget; rects: NRect[] }>();
  const layers: Array<{ layer: InkTarget; boxes: ReadonlyArray<ClientBox | null | undefined> }> = [
    { layer: 'original', boxes: originalBoxes },
    { layer: 'translated', boxes: translatedBoxes },
  ];

  for (const r of clientRects) {
    if (r.width <= 1 || r.height <= 1) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let matched = false;
    for (const { layer, boxes } of layers) {
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (!b || b.width <= 0 || b.height <= 0) continue;
        if (cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom) {
          const key = `${layer}:${i}`;
          const entry = byTarget.get(key) ?? { pageIndex: i, layer, rects: [] };
          entry.rects.push({
            x: (r.left - b.left) / b.width,
            y: (r.top - b.top) / b.height,
            w: r.width / b.width,
            h: r.height / b.height,
          });
          byTarget.set(key, entry);
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
  }

  if (!byTarget.size) return null;
  const best = [...byTarget.values()].sort((a, b) => b.rects.length - a.rects.length)[0];
  return {
    pageIndex: best.pageIndex,
    layer: best.layer,
    rects: mergeRects(best.rects),
    multiPage: byTarget.size > 1,
  };
}

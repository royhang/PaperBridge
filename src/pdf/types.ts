/** Minimal subset of pdf.js `TextItem` we depend on (keeps the extractor testable without pdf.js). */
export interface RawTextItem {
  str: string;
  /** [a, b, c, d, e, f] — e/f are x/y of the baseline origin in PDF user space (y grows upward). */
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
  fontName?: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A logical paragraph on one page. Coordinates are in PDF user space with the
 * origin at the TOP-LEFT of the page (y grows downward), so the UI can map
 * them to the canvas by multiplying with the render scale.
 */
export interface Paragraph {
  /** Stable id: `${pageIndex}-${order}` */
  id: string;
  pageIndex: number;
  /** Reading order within the page, starting at 0. */
  order: number;
  text: string;
  bbox: Rect;
  /** Heuristic role. */
  kind: 'heading' | 'body' | 'caption' | 'other';
}

export interface PageGeometry {
  pageIndex: number;
  width: number;
  height: number;
}

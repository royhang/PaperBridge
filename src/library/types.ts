/** Bibliographic metadata shared by the library UI, importers and citation formatters. */

export type ItemType = 'article' | 'conference' | 'preprint' | 'book' | 'chapter' | 'thesis' | 'report' | 'other';

export interface Author {
  /** Family name, e.g. "Vaswani" or "张". */
  family: string;
  /** Given names, e.g. "Ashish" or "三". May be empty for organisations / single names. */
  given: string;
}

export interface PaperMeta {
  title: string;
  authors: Author[];
  year?: number;
  /** Journal / conference / publisher container, e.g. "Advances in Neural Information Processing Systems". */
  venue?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  doi?: string;
  /** Bare arXiv id without version prefix "arXiv:", e.g. "1706.03762" (version suffix like v7 allowed). */
  arxivId?: string;
  url?: string;
  abstract?: string;
  type: ItemType;
  /** Language of the item, e.g. "en", "zh". Used by GB/T 7714 (等 vs et al.). */
  language?: string;
}

export type MetaSource = 'pdf' | 'crossref' | 'arxiv' | 'bibtex' | 'manual';

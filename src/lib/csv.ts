/** Minimal RFC 4180 parser (quoted fields, escaped quotes, embedded newlines, CRLF). */
export function parseDelimited(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

export function csvCell(s: string) {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Glossary import: "source,target[,note]" CSV or TSV, optional header row, '#' comments. */
export function parseGlossary(text: string): { source: string; target: string; note?: string }[] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = firstLine.includes('\t') ? '\t' : ',';
  return parseDelimited(text, delimiter)
    .filter((r) => !r[0]?.trim().startsWith('#'))
    .map((r) => ({ source: r[0]?.trim() ?? '', target: r[1]?.trim() ?? '', note: r.slice(2).join(delimiter).trim() || undefined }))
    .filter((r) => r.source && r.target && !/^(source|原文)$/i.test(r.source));
}

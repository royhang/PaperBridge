import { db } from '../db/db';
import { desktop } from '../lib/desktop';
import type { PDFDocumentProxy } from '../pdf/loader';
import { cachedPageTranslations, pageParagraphs } from './fulltext';

export function download(filename: string, data: string | Blob, type = 'text/markdown;charset=utf-8') {
  const safeName = filename.replace(/[\\/:*?"<>|]+/g, '_');
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const nativeSave = desktop()?.saveFile;
  if (nativeSave) {
    void blob.arrayBuffer().then((buf) => {
      nativeSave(safeName, new Uint8Array(buf), blob.type || type);
    });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export type BilingualMode = 'bilingual' | 'translation';

/** Markdown export of the full-text translation (uses cached translations only). */
/** Markdown export from the reader's current document (cached translations only). */
export async function exportBilingual(pdf: PDFDocumentProxy, _docId: string, title: string, mode: BilingualMode) {
  const lines: string[] = [`# ${title}`, ''];
  let missing = 0;
  for (let i = 0; i < pdf.numPages; i++) {
    const paras = (await pageParagraphs(i)).filter((p) => p.kind !== 'other');
    const map = await cachedPageTranslations(i);
    lines.push(`<!-- page ${i + 1} -->`, '');
    for (const p of paras) {
      const t = map.get(p.id);
      if (!t && map.has(p.id)) missing++;
      const heading = p.kind === 'heading';
      if (mode === 'bilingual') {
        if (heading) lines.push(`## ${p.text}${t ? ` / ${t}` : ''}`, '');
        else {
          lines.push(p.text, '');
          if (t) lines.push(`> ${t.replace(/\n/g, '\n> ')}`, '');
        }
      } else {
        const out = t || p.text;
        lines.push(heading ? `## ${out}` : out, '');
      }
    }
  }
  download(`${title}${mode === 'bilingual' ? '.双语' : '.译文'}.md`, lines.join('\n'));
  return missing;
}

export async function exportNotes(docId: string, title: string) {
  const notes = await db.notes.where('docId').equals(docId).toArray();
  notes.sort((a, b) => a.pageIndex - b.pageIndex || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0));
  const lines = [`# ${title} · 笔记`, ''];
  for (const n of notes) {
    lines.push(`> ${n.quote.replace(/\n/g, '\n> ')}`);
    lines.push(`> — p.${n.pageIndex + 1}${n.layer === 'translated' ? '（译文）' : ''}`, '');
    if (n.translation) lines.push(`**译文**：${n.translation}`, '');
    if (n.comment) lines.push(n.comment, '');
    lines.push('---', '');
  }
  download(`${title}.笔记.md`, lines.join('\n'));
}

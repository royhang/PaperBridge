/** Normalise text copied from the pdf.js text layer (line breaks, hyphenation). */
export function cleanSelectedText(s: string): string {
  return s
    .replace(/(\p{L})-\s*\n\s*(\p{Ll})/gu, '$1$2') // de-hyphenate line breaks
    .replace(/([\p{Script=Han}])\s*\n\s*([\p{Script=Han}])/gu, '$1$2')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t ]+/g, ' ')
    .trim();
}

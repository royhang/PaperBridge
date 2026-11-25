// Downloads the CJK font used for translated-PDF output into public/fonts/ (not committed:
// ~15 MB). Noto Serif SC is licensed under the SIL Open Font License 1.1.
// Uses a local copy from $PB_FONT_DIR or ~/.cache/pb-fonts when available.
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const NAME = 'NotoSerifSC-Regular.ttf';
const dest = join(import.meta.dirname, '..', 'public', 'fonts');
const out = join(dest, NAME);
mkdirSync(dest, { recursive: true });
if (existsSync(out) && statSync(out).size > 1_000_000) process.exit(0);

const local = [process.env.PB_FONT_DIR, join(homedir(), '.cache', 'pb-fonts')].filter(Boolean).map((d) => join(d, NAME));
for (const f of local) {
  if (existsSync(f)) {
    copyFileSync(f, out);
    console.log(`font copied from ${f}`);
    process.exit(0);
  }
}

try {
  // Google Fonts serves a single static TTF to non-browser user agents.
  const css = await (await fetch('https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400', { headers: { 'User-Agent': 'Wget/1.21' } })).text();
  const url = css.match(/url\((https:[^)]+\.ttf)\)/)?.[1];
  if (!url) throw new Error('font URL not found in Google Fonts CSS');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  writeFileSync(out, new Uint8Array(await res.arrayBuffer()));
  console.log(`font downloaded: ${out}`);
} catch (e) {
  // Not fatal: the app shows a clear error when generating translated PDFs without the font.
  console.warn(`[fetch-fonts] could not download ${NAME}: ${e.message}. Translated-PDF export will be unavailable until it is placed in public/fonts/.`);
}

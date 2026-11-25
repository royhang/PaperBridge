import hbWasmUrl from 'harfbuzzjs/dist/harfbuzz-subset.wasm?url';
import { createSubsetter, type Subsetter } from './subset';

/** CJK-capable font used for translated text (Noto Serif SC, SIL OFL 1.1). See scripts/fetch-fonts.mjs. */
export const FONT_URL = `${import.meta.env.BASE_URL}fonts/NotoSerifSC-Regular.ttf`;
const CACHE = 'paperbridge-fonts-v1';

let subsetterPromise: Promise<Subsetter> | null = null;

async function fetchWithProgress(url: string, onProgress?: (msg: string) => void): Promise<Uint8Array> {
  // Cache Storage survives HTTP-cache eviction; unavailable outside secure contexts → plain fetch.
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch {
    cache = null;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`中文字体加载失败（HTTP ${res.status}）。部署时请运行 node scripts/fetch-fonts.mjs 生成 public/fonts/。`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(`首次使用，下载中文字体 ${(got / 1048576).toFixed(1)}${total ? ` / ${(total / 1048576).toFixed(1)}` : ''} MB`);
  }
  const bytes = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  try {
    await cache?.put(url, new Response(bytes.slice(), { headers: { 'content-type': 'font/ttf' } }));
  } catch {
    /* quota etc. */
  }
  return bytes;
}

let fontPromise: Promise<Uint8Array> | null = null;
/** progress listener of whoever is waiting for the font right now (the prefetch has none) */
let progressSink: ((msg: string) => void) | undefined;

function fontBytes(onProgress?: (msg: string) => void): Promise<Uint8Array> {
  if (onProgress) progressSink = onProgress;
  fontPromise ??= fetchWithProgress(FONT_URL, (m) => progressSink?.(m)).catch((e) => {
    fontPromise = null;
    throw e;
  });
  return fontPromise;
}

/**
 * Download the CJK font into Cache Storage in the background (once per browser), so the first
 * layout-preserving translation doesn't wait for ~15 MB. Skipped on data-saver connections.
 */
export function prefetchCjkFont(): void {
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData) return;
  void fontBytes().catch(() => {
    /* retried on first real use */
  });
}

export function getCjkSubsetter(onProgress?: (msg: string) => void): Promise<Subsetter> {
  subsetterPromise ??= (async () => {
    const font = await fontBytes(onProgress);
    return createSubsetter(font, async () => (await fetch(hbWasmUrl)).arrayBuffer());
  })().catch((e) => {
    subsetterPromise = null;
    throw e;
  });
  return subsetterPromise;
}

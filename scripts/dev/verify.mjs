// Structural acceptance checks of translated PDFs against the original.
//   node scripts/dev/verify.mjs orig.pdf diag.json mono.pdf [dual.pdf] [side.pdf] > report.json
// Checks
//  - navigation: outline count + targets, link count, internal link targets / external URIs (all modes)
//  - text (mono): decimals / percentages, equation numbers "(n)", reference numbers "[n]", kept blocks intact,
//    leftover original glyphs inside redrawn blocks, overlaps between redrawn blocks and other content
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(new URL('../../package.json', import.meta.url));
const pdfjs = await import(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
const base = require.resolve('pdfjs-dist/package.json').replace('package.json', '');
const [origFile, diagFile, monoFile, dualFile, sideFile] = process.argv.slice(2);

const open = (f) => pdfjs.getDocument({ data: new Uint8Array(readFileSync(f)), verbosity: 0, standardFontDataUrl: base + 'standard_fonts/', cMapUrl: base + 'cmaps/', cMapPacked: true }).promise;

async function destPage(pdf, dest) {
  if (!dest) return null;
  const d = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
  if (!d) return null;
  try {
    return { page: await pdf.getPageIndex(d[0]), y: typeof d[3] === 'number' ? d[3] : null, x: typeof d[2] === 'number' ? d[2] : null };
  } catch {
    return null;
  }
}

async function nav(pdf) {
  const outline = [];
  const walk = async (items) => {
    for (const it of items ?? []) {
      outline.push({ title: it.title, target: await destPage(pdf, it.dest) });
      await walk(it.items);
    }
  };
  await walk(await pdf.getOutline());
  const links = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    for (const a of await page.getAnnotations()) {
      if (a.subtype !== 'Link') continue;
      links.push({ page: p - 1, rect: a.rect, url: a.url ?? a.unsafeUrl ?? null, target: a.dest ? await destPage(pdf, a.dest) : null });
    }
  }
  return { pages: pdf.numPages, outline, links };
}

async function pageItems(pdf, p) {
  const page = await pdf.getPage(p + 1);
  const tc = await page.getTextContent();
  return tc.items.filter((i) => 'str' in i).map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: Math.abs(i.transform[3]) }));
}
const textOf = (items) => items.map((i) => i.s).join(' ');
const squash = (s) => s.replace(/[\s­]/g, '').toLowerCase();

const orig = await open(origFile);
const diag = JSON.parse(readFileSync(diagFile, 'utf8'));
const report = { navigation: {}, pages: [] };
const origNav = await nav(orig);
report.navigation.original = { pages: origNav.pages, outline: origNav.outline.length, links: origNav.links.length, internal: origNav.links.filter((l) => l.target).length, external: origNav.links.filter((l) => l.url).length };

// --- navigation per mode
for (const [mode, file] of [['mono', monoFile], ['dual', dualFile], ['side', sideFile]]) {
  if (!file) continue;
  const pdf = await open(file);
  const n = await nav(pdf);
  const translated = new Set(diag.filter((d) => d.blocks.some((b) => b.status === 'drawn')).map((d) => d.pageIndex));
  // original page index → output page of its original copy / of its translation (dual: next page)
  const map = (i) => (mode === 'dual' ? i + [...translated].filter((t) => t < i).length : i);
  const tmap = (i) => (mode === 'dual' && translated.has(i) ? map(i) + 1 : map(i));
  const widthOf = async (i) => {
    const v = (await orig.getPage(i + 1)).view;
    return v[2] - v[0];
  };
  // expected destination: `trans` = a translated copy is the intended target
  const want = async (t, trans) => {
    if (!t) return null;
    const toTrans = trans && translated.has(t.page);
    return { page: toTrans ? tmap(t.page) : map(t.page), y: t.y, x: t.x == null ? null : t.x + (toTrans && mode === 'side' ? await widthOf(t.page) : 0) };
  };
  const same = (a, b) => a && b && a.page === b.page && (a.y == null || Math.abs(a.y - b.y) < 0.5) && (a.x == null || b.x == null || Math.abs(a.x - b.x) < 0.5);
  const res = { pages: n.pages, outline: n.outline.length, links: n.links.length, problems: [] };
  const expectPages = mode === 'dual' ? origNav.pages + translated.size : origNav.pages;
  if (n.pages !== expectPages) res.problems.push(`page count ${n.pages} ≠ ${expectPages}`);
  if (n.outline.length !== origNav.outline.length) res.problems.push(`outline ${n.outline.length} ≠ ${origNav.outline.length}`);
  for (const [i, o] of n.outline.entries()) {
    const w = origNav.outline[i];
    const exp = await want(w?.target, mode !== 'mono');
    if (!w || o.title !== w.title || !same(exp, o.target)) res.problems.push(`bookmark "${o.title}" → ${JSON.stringify(o.target)} (want ${JSON.stringify(exp)})`);
  }
  // every original link exists on the original copy; translated pages carry a second copy
  const findLink = (page, rect, dx = 0) => n.links.find((l) => l.page === page && Math.abs(l.rect[0] - rect[0] - dx) < 0.5 && Math.abs(l.rect[1] - rect[1]) < 0.5);
  let copies = 0;
  for (const l of origNav.links) {
    const targets = [[map(l.page), 0, false]];
    if (translated.has(l.page) && mode === 'dual') targets.push([map(l.page) + 1, 0, true]);
    if (translated.has(l.page) && mode === 'side') targets.push([l.page, await widthOf(l.page), true]);
    for (const [pg, dx, onTrans] of targets) {
      const got = findLink(pg, l.rect, dx);
      if (!got) {
        res.problems.push(`missing link p${l.page + 1} ${l.url ?? JSON.stringify(l.target)} on out p${pg + 1}`);
        continue;
      }
      if (onTrans) copies++;
      if (l.url && got.url !== l.url) res.problems.push(`link p${l.page + 1} url ${got.url} ≠ ${l.url}`);
      if (l.target) {
        const exp = await want(l.target, onTrans);
        if (!same(exp, got.target)) res.problems.push(`link p${l.page + 1}${onTrans ? ' (translated copy)' : ''} → ${JSON.stringify(got.target)} (want ${JSON.stringify(exp)})`);
      }
    }
  }
  res.extraLinks = n.links.length - origNav.links.length - copies;
  res.translatedCopies = copies;
  res.problems = res.problems.slice(0, 40);
  report.navigation[mode] = res;
}

// --- text checks (mono)
const mono = await open(monoFile);
const decimals = (s) => s.match(/\d+\.\d+%?|\d+%/g) ?? [];
const counts = (a) => a.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
const overlapArea = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
for (const d of diag) {
  const p = d.pageIndex;
  const oi = await pageItems(orig, p);
  const ti = await pageItems(mono, p);
  const ot = textOf(oi);
  const tt = textOf(ti);
  const pr = { page: p + 1, status: {}, problems: [] };
  for (const b of d.blocks) pr.status[b.status] = (pr.status[b.status] ?? 0) + 1;
  // numbers: every decimal / percentage of the original must still be there (same count)
  const want = counts(decimals(ot));
  const have = counts(decimals(tt));
  for (const [k, v] of want) if ((have.get(k) ?? 0) < v) pr.problems.push(`number ${k}: ${have.get(k) ?? 0}/${v}`);
  // equation numbers and reference numbers
  for (const re of [/\((\d{1,2})\)\s*$/, /^\[(\d{1,3})\]/]) {
    const o = new Set(oi.filter((i) => re.test(i.s.trim())).map((i) => i.s.trim().match(re)[0]));
    for (const k of o) if (!ti.some((i) => i.s.includes(k))) pr.problems.push(`lost ${k}`);
  }
  // kept blocks: untouched glyphs (their text must still be on the page)
  const tsq = squash(tt);
  for (const b of d.blocks.filter((x) => x.status !== 'drawn' && (x.kind !== 'other'))) {
    const words = b.source.replace(/\{v\d+\}|<\/?s\d+>/g, ' ').split(/\s+/).filter((w) => /^[A-Za-z]{4,}[.,;:]?$/.test(w));
    const missing = words.filter((w) => !tsq.includes(squash(w).replace(/[.,;:]$/, '')));
    if (words.length && missing.length > Math.max(1, words.length * 0.1)) pr.problems.push(`kept block ${b.id} lost words: ${missing.slice(0, 5).join(' ')}`);
  }
  // leftovers: latin words inside a redrawn block's original box that are not part of its translation
  for (const b of d.blocks.filter((x) => x.status === 'drawn')) {
    const box = b.box;
    const allowed = squash((b.formulaText ?? []).join(' ')) + squash(b.translation ?? '') + squash(d.blocks.filter((x) => x.status === 'drawn').map((x) => x.translation ?? '').join(''));
    const inBox = ti.filter((i) => i.x >= box.x0 - 1 && i.x <= box.x1 && i.y >= box.y0 - 1 && i.y <= box.y1 && /[A-Za-z]{3,}/.test(i.s));
    for (const i of inBox) {
      const latin = i.s.match(/[A-Za-z]{3,}/g) ?? [];
      const stray = latin.filter((w) => !allowed.includes(w.toLowerCase()));
      // glyphs of other (kept) blocks that legitimately sit inside this box
      const owned = d.blocks.some((o) => o.id !== b.id && o.status !== 'drawn' && i.x >= o.box.x0 - 1 && i.x <= o.box.x1 + 1 && i.y >= o.box.y0 - 1 && i.y <= o.box.y1 + 1);
      if (stray.length && !owned) pr.problems.push(`leftover in ${b.id}: "${i.s.slice(0, 40)}"`);
    }
  }
  // overlaps: redrawn areas must not cover other redrawn areas or kept text
  const drawn = d.blocks.filter((x) => x.drawn);
  for (const a of drawn) {
    for (const o of d.blocks) {
      if (o.id === a.id) continue;
      const other = o.drawn ?? (o.status === 'drawn' ? null : o.box);
      if (!other || (o.kind === 'other' && o.region !== 'text')) continue;
      const ov = overlapArea(a.drawn, other);
      const small = Math.min((a.drawn.x1 - a.drawn.x0) * (a.drawn.y1 - a.drawn.y0), (other.x1 - other.x0) * (other.y1 - other.y0));
      if (ov > Math.max(4, small * 0.08)) pr.problems.push(`overlap ${a.id} × ${o.id} (${ov.toFixed(0)}pt²)`);
    }
  }
  report.pages.push(pr);
}
console.log(JSON.stringify(report, null, 1));

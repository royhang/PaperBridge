/// <reference types="node" />
// Full run of buildTranslatedPdf with a real OpenAI-compatible translator (key via env only).
//   KEY=… BASE=https://…/v1 MODEL=… PDF=paper.pdf OUT=dir [NAME=x] [MODES=mono,dual,side] [FROM=0 TO=99]
//   [CACHE=file.json] [ANNOTATE=1] pnpm vitest run scripts/dev/real.test.ts --silent=false
// Translations are cached in CACHE (JSON) between runs. Writes <NAME>-<mode>.pdf, <NAME>-diag.json and
// (ANNOTATE=1) diag-p<N>.png: the translated page with each block coloured by its final status.
import 'fake-indexeddb/auto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { annotate } from './annotate';

const FONT = join(homedir(), '.cache/pb-fonts/NotoSerifSC-Regular.ttf');

vi.mock('../../src/pdfout/fonts', async () => {
  const { createSubsetter } = await import('../../src/pdfout/subset');
  const wasm = readFileSync(join(process.cwd(), 'node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm'));
  return { getCjkSubsetter: async () => createSubsetter(new Uint8Array(readFileSync(FONT)), wasm) };
});

const STATUS_COLOR: Record<string, string> = {
  drawn: '#2ca02c', kept: '#7f7f7f', overflow: '#ff0000', placeholder: '#ff00ff', numbers: '#ff7f0e', identical: '#1f77b4', short: '#8c564b', empty: '#d62728', missing: '#d62728',
};

test.skipIf(!process.env.KEY || !process.env.PDF)('real translation run', async () => {
  const { db } = await import('../../src/db/db');
  const { useSettings } = await import('../../src/store/settings');
  const { buildTranslatedPdf } = await import('../../src/pdfout/translatePdf');
  useSettings.getState().set({
    providers: [{ id: 'llm', name: 'LLM', kind: 'openai', baseUrl: process.env.BASE ?? 'https://chat.ecnu.edu.cn/open/api/v1', apiKey: process.env.KEY!, model: process.env.MODEL ?? 'ecnu-plus' }],
    translateProviderId: 'llm',
    sourceLang: 'en',
    targetLang: 'zh-CN',
    batchSize: 8,
    concurrency: Number(process.env.CONC ?? 4),
  });
  const cache = process.env.CACHE ?? join(homedir(), '.cache/pb-med/tcache.json');
  if (existsSync(cache)) await db.translations.bulkPut(JSON.parse(readFileSync(cache, 'utf8')));
  const save = async () => writeFileSync(cache, JSON.stringify(await db.translations.toArray()));

  const src = readFileSync(process.env.PDF!);
  const ab = src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength) as ArrayBuffer;
  const out = process.env.OUT ?? join(homedir(), '.cache/pb-med/out');
  const name = process.env.NAME ?? basename(process.env.PDF!, '.pdf');
  mkdirSync(out, { recursive: true });
  const modes = (process.env.MODES ?? 'mono,dual,side').split(',') as ('mono' | 'dual' | 'side')[];
  const from = Number(process.env.FROM ?? 0);
  const to = Number(process.env.TO ?? 999);
  for (const mode of modes) {
    const t0 = performance.now();
    let res;
    try {
      res = await buildTranslatedPdf({ docId: name, title: name, bytes: ab, mode, from, to, onProgress: (m) => /翻译|重试|校验/.test(m) && process.stdout.write(`\r${mode}: ${m}      `) });
    } finally {
      await save();
    }
    const file = join(out, `${name}-${mode}.pdf`);
    writeFileSync(file, res.bytes);
    console.log(`\n${mode} → ${file} ${(res.bytes.length / 1024).toFixed(0)} KB ${((performance.now() - t0) / 1000).toFixed(1)}s`, res.stats);
    if (mode !== 'mono') continue;
    writeFileSync(join(out, `${name}-diag.json`), JSON.stringify(res.diagnostics, null, 1));
    for (const d of res.diagnostics) {
      const count: Record<string, number> = {};
      for (const b of d.blocks) count[b.status] = (count[b.status] ?? 0) + 1;
      console.log(`p${d.pageIndex + 1}`, JSON.stringify(count), d.skipped ?? '');
      for (const b of d.blocks.filter((x) => x.status !== 'drawn' && x.status !== 'kept')) console.log(`   ${b.id} ${b.status} ${b.reason ?? ''} | ${b.source.slice(0, 70)} → ${(b.translation ?? '').slice(0, 50)}`);
      if (process.env.ANNOTATE)
        await annotate(
          res.bytes,
          d.pageIndex + 1,
          [
            ...d.regions.map((r) => ({ box: [r.box.x0, r.box.y0, r.box.x1, r.box.y1], color: '#cccccc', dash: true, label: r.kind })),
            ...d.blocks.map((b) => {
              const box = b.drawn ?? b.box;
              return { box: [box.x0, box.y0, box.x1, box.y1], color: STATUS_COLOR[b.status] ?? '#000', label: `${b.id.split('-')[1]}${b.status === 'drawn' ? '' : ' ' + b.status}` };
            }),
          ],
          join(out, `diag-p${d.pageIndex + 1}.png`),
          1.6,
        );
    }
  }
  expect(true).toBe(true);
}, 3_600_000);

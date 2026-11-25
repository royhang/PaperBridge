/// <reference types="node" />
// Dev helper: draw layout blocks / regions / placements over a rendered page.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire(import.meta.url);
const canvasMod = createRequire(require.resolve('pdfjs-dist/package.json'))('@napi-rs/canvas') as {
  createCanvas: (w: number, h: number) => { getContext: (k: '2d') => CanvasRenderingContext2D; toBuffer: (t: string) => Buffer; width: number; height: number };
};
const base = require.resolve('pdfjs-dist/package.json').replace('package.json', '');

export const KIND_COLOR: Record<string, string> = {
  title: '#d62728', heading: '#ff7f0e', body: '#1f77b4', caption: '#9467bd', footnote: '#8c564b',
  label: '#e377c2', cell: '#17becf', equation: '#2ca02c', reference: '#7f7f7f', author: '#bcbd22', other: '#aaaaaa',
  figure: '#e377c2', table: '#17becf', placed: '#000000', fallback: '#ff0000',
};

export interface Mark { box: number[]; color: string; label?: string; dash?: boolean; width?: number }

export async function annotate(bytes: Uint8Array, pageNo: number, marks: Mark[], out: string, scale = 1.6) {
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, standardFontDataUrl: base + 'standard_fonts/', cMapUrl: base + 'cmaps/', cMapPacked: true }).promise;
  const page = await pdf.getPage(pageNo);
  const vp = page.getViewport({ scale });
  const c = canvasMod.createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp, canvas: c as unknown as HTMLCanvasElement }).promise;
  for (const m of marks) {
    const [x0, y0, x1, y1] = m.box;
    const [ax, ay] = vp.convertToViewportPoint(x0, y1);
    const [bx, by] = vp.convertToViewportPoint(x1, y0);
    ctx.strokeStyle = m.color;
    ctx.lineWidth = m.width ?? 1.2;
    ctx.setLineDash(m.dash ? [4, 3] : []);
    ctx.strokeRect(ax, ay, bx - ax, by - ay);
    if (m.label) {
      ctx.font = '10px sans-serif';
      ctx.fillStyle = m.color;
      ctx.fillText(m.label, ax + 1, ay + 9);
    }
  }
  writeFileSync(out, c.toBuffer('image/png'));
  await pdf.cleanup();
}

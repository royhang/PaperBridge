// @vitest-environment node
import { accessSync, constants } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, it } from 'vitest'
import { readPageText, removeShowOps } from '../engine'
import type { ShowOp } from '../engine'

function fixture(file: string): string {
  return join(homedir(), '.cache', 'pb-e2e', 'dl', file)
}

function itWithFixture(file: string) {
  try {
    accessSync(fixture(file), constants.R_OK)
    return it
  } catch {
    console.warn('Skipping PDF fixture tests because the file is unreadable: ' + fixture(file))
    return it.skip
  }
}

async function pdfJsText(data: Uint8Array) {
  const task = getDocument({ data: data.slice(), useSystemFonts: true })
  try {
    const doc = await task.promise
    const page = await doc.getPage(1)
    const content = await page.getTextContent()
    return content.items.filter((item) => 'str' in item).filter((item) => item.str.trim())
  } finally {
    await task.destroy()
  }
}

function readingOrder(ops: ShowOp[]): string {
  return ops.filter(({ text }) => text).sort((a, b) => b.y - a.y || a.x - b.x)
    .map(({ text }) => text).join(' ').replace(/\s+/g, ' ')
}

async function expectMatchingOrigins(data: Uint8Array, ops: ShowOp[], file: string): Promise<void> {
  const items = await pdfJsText(data)
  const textOps = ops.filter(({ text }) => text.trim())
  expect(items.length).toBeGreaterThan(20)
  const matched = items.filter(({ transform: [, , , , x, y] }) => textOps.some((op) => (
    Math.hypot(x - op.x, y - op.y) <= 1.5 ||
    (!op.rotated && Math.abs(y - op.y) <= 1.5 && x >= op.x - 1.5 && x <= op.x + op.width + 1.5)
  )))
  console.info(file + ' PDF.js origin matches: ' + matched.length + '/' + items.length)
  expect(matched.length / items.length).toBeGreaterThanOrEqual(0.9)
}

itWithFixture('attention.pdf')('locates and erases the Attention abstract while retaining the title', async () => {
  const bytes = new Uint8Array(await readFile(fixture('attention.pdf')))
  const doc = await PDFDocument.load(bytes)
  const { ops } = readPageText(doc, 0)
  expect(ops.filter(({ text }) => text.trim()).length).toBeGreaterThan(50)
  const title = 'Attention Is All You Need'
  const phrase = 'dominant sequence transduction'
  expect(readingOrder(ops)).toContain(title)
  expect(readingOrder(ops)).toContain(phrase)
  await expectMatchingOrigins(bytes, ops, 'attention.pdf')

  const top = ops.find(({ text }) => text.trim() === 'Abstract')!.y
  const bottom = ops.find(({ text }) => text.includes('large and limited training data'))!.y
  const indices = new Set(ops.filter(({ y, index }) => index >= 0 && y >= bottom - 0.25 && y <= top + 0.25)
    .map(({ index }) => index))
  expect(indices.size).toBeGreaterThan(10)
  removeShowOps(doc, 0, indices)
  const output = await doc.save()
  const text = (await pdfJsText(output)).map(({ str }) => str).join(' ')
  expect(text).toContain(title)
  expect(text).toContain('31st Conference on Neural Information Processing Systems')
  expect(text).not.toContain(phrase)
  expect(text).not.toContain('large and limited training data')
  const path = join(await mkdtemp(join(tmpdir(), 'pdfout-engine-')), 'attention-abstract-removed.pdf')
  await writeFile(path, output)
  console.info('Rewritten Attention PDF: ' + path)
})

itWithFixture('attention.pdf')('reads all 15 Attention pages in under three seconds', async () => {
  const doc = await PDFDocument.load(await readFile(fixture('attention.pdf')))
  expect(doc.getPageCount()).toBe(15)
  const start = performance.now()
  const models = doc.getPageIndices().map((pageIndex) => readPageText(doc, pageIndex))
  const elapsed = performance.now() - start
  expect(models.every(({ ops }) => ops.some(({ text }) => text.trim()))).toBe(true)
  console.info('Reading 15 Attention pages: ' + elapsed.toFixed(0) + ' ms')
  expect(elapsed).toBeLessThan(3000)
})

itWithFixture('bert.pdf')('reads BERT page one and agrees with PDF.js origins', async () => {
  const bytes = new Uint8Array(await readFile(fixture('bert.pdf')))
  const doc = await PDFDocument.load(bytes)
  const { ops } = readPageText(doc, 0)
  expect(ops.filter(({ text }) => text.trim()).length).toBeGreaterThan(50)
  expect(readingOrder(ops)).toContain('Deep Bidirectional Transformers')
  await expectMatchingOrigins(bytes, ops, 'bert.pdf')
})

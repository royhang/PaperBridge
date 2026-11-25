// @vitest-environment node
/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'
import { readPageText, removeShowOps } from '../engine'

const FILE = join(homedir(), '.cache/pb-med/orig.pdf') // arXiv 2503.18968v3

async function items(bytes: Uint8Array, page: number) {
  const task = getDocument({ data: bytes.slice(), verbosity: 0 })
  const tc = await (await (await task.promise).getPage(page + 1)).getTextContent()
  await task.destroy()
  return tc.items.filter((i) => 'str' in i) as { str: string; transform: number[] }[]
}

describe.skipIf(!existsSync(FILE))('form XObject text (MedAgent-Pro figure 4)', () => {
  it('reports form text with owners, colours and figure regions', async () => {
    const doc = await PDFDocument.load(readFileSync(FILE))
    const m = readPageText(doc, 4)
    const form = m.ops.filter((o) => o.owner)
    expect(form.length).toBeGreaterThan(1000)
    expect(new Set(form.map((o) => o.owner))).toEqual(new Set(['Im4']))
    expect(m.formUses.Im4).toBe(1)
    const box = m.graphics.find((g) => g.kind === 'form' && g.path === 'Im4')!
    expect(box.w).toBeGreaterThan(300)
    // coloured agent names (blue / green) are reported
    expect(form.some((o) => o.state.fill[2] > 0.5 && o.state.fill[0] < 0.3)).toBe(true)
  })

  it('removes selected form glyphs through a page-local clone, leaving everything else in place', async () => {
    const bytes = new Uint8Array(readFileSync(FILE))
    const doc = await PDFDocument.load(bytes)
    const m = readPageText(doc, 4)
    const before = await items(bytes, 4)
    // erase every glyph of the form's top-left heading row (y within the first title line)
    const heading = m.ops.filter((o) => o.owner === 'Im4' && o.y > 700)
    expect(heading.length).toBeGreaterThan(10)
    const ids = new Set<string>(heading.map((o) => o.id))
    const sharedBefore = (doc.getPage(4).node.Resources()!.lookup(PDFName.of('XObject')) as PDFDict).get(PDFName.of('Im4'))
    removeShowOps(doc, 4, ids)
    const sharedAfter = (doc.getPage(4).node.Resources()!.lookup(PDFName.of('XObject')) as PDFDict).get(PDFName.of('Im4'))
    expect(sharedAfter).not.toBe(sharedBefore)
    const out = await doc.save()
    const after = await items(out, 4)
    const text = (xs: { str: string }[]) => xs.map((i) => i.str).join('')
    expect(text(after)).not.toContain('Disease-level')
    expect(text(after)).toContain('Figure 4')
    // text that was not removed keeps its exact position
    const key = (i: { str: string; transform: number[] }) => `${i.str}@${i.transform[4].toFixed(2)},${i.transform[5].toFixed(2)}`
    const kept = new Set(after.map(key))
    const survivors = before.filter((i) => i.str.trim() && !heading.some((o) => Math.abs(o.y - i.transform[5]) < 0.5 && Math.abs(o.x - i.transform[4]) < 0.5))
    const moved = survivors.filter((i) => !kept.has(key(i)))
    expect(moved.length / survivors.length).toBeLessThan(0.02)
    // other pages still use the untouched original
    expect(readPageText(await PDFDocument.load(out), 3).ops.length).toBe(readPageText(await PDFDocument.load(bytes), 3).ops.length)
  })

  it('splits pdfTeX table rows drawn in one TJ into cell fragments and erases some of them in place', async () => {
    const bytes = new Uint8Array(readFileSync(FILE))
    const doc = await PDFDocument.load(bytes)
    const m = readPageText(doc, 5)
    const frags = m.ops.filter((o) => o.id.includes('~'))
    expect(frags.length).toBeGreaterThan(20)
    const names = frags.filter((o) => /^(BioMedClip|Glaucoma|Heart Disease|Method)/.test(o.text.trim()))
    expect(names.length).toBeGreaterThanOrEqual(4)
    // every fragment is a single cell: names never carry numbers along
    expect(frags.some((o) => /BioMedClip \[24\]\s*\d/.test(o.text))).toBe(false)
    const before = await items(bytes, 5)
    removeShowOps(doc, 5, new Set(names.map((o) => o.id)))
    const out = await doc.save()
    const after = await items(out, 5)
    const all = after.map((i) => i.str).join(' ')
    expect(all).not.toMatch(/BioMedClip|Glaucoma/)
    // numbers keep their exact positions
    const nums = (xs: { str: string; transform: number[] }[]) =>
      xs.flatMap((i) => (/\d/.test(i.str) ? i.str.trim().split(/\s+/).map((t) => t) : [])).join(' ')
    expect(nums(after)).toContain('58.1')
    const pos = (xs: { str: string; transform: number[] }[], t: string) => xs.filter((i) => i.str.includes(t)).map((i) => `${i.transform[4].toFixed(1)},${i.transform[5].toFixed(1)}`)
    for (const t of ['56.4', '90.4', '76.4', '89.7']) expect(pos(after, t).length).toBeGreaterThan(0)
    const re = readPageText(await PDFDocument.load(out), 5)
    for (const t of ['56.4', '21.1', '58.1', '90.4']) {
      const a = m.ops.filter((o) => o.text.includes(t)).map((o) => `${o.x.toFixed(2)},${o.y.toFixed(2)}`)
      const b = re.ops.filter((o) => o.text.includes(t)).map((o) => `${o.x.toFixed(2)},${o.y.toFixed(2)}`)
      expect(b).toEqual(a)
    }
    void before
  })
})

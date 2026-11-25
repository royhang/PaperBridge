// @vitest-environment node
import {
  PDFArray, PDFDocument, PDFName, PDFOperator, PDFOperatorNames, PDFRawStream,
  StandardFonts, decodePDFRawStream, degrees,
} from 'pdf-lib'
import type { PDFPage } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'
import { parseContent, readPageText, removeShowOps, serializeContent, spaceGapOf } from '../engine'

const ascii = (source: string) => Uint8Array.from(source, (char) => char.charCodeAt(0))

function append(page: PDFPage, source: string): void {
  page.node.addContentStream(page.doc.context.register(page.doc.context.flateStream(ascii(source))))
}

async function extracted(doc: PDFDocument) {
  const task = getDocument({ data: await doc.save(), useSystemFonts: true })
  try {
    const pdf = await task.promise
    const page = await pdf.getPage(1)
    const content = await page.getTextContent()
    return content.items.filter((item) => 'str' in item).filter((item) => item.str.trim())
  } finally {
    await task.destroy()
  }
}

describe('content syntax', () => {
  it('round-trips strings, comments, escaped names, direct composites and inline images', () => {
    const literal = '(a(b)c\\n\\r\\t\\b\\f\\(\\)\\\\\\101\\377\\053\\z)'
    const continued = '(a\\\r\nb\r\nc\rd)'
    const image = 'BI /W 11 /H 1 /BPC 8 /CS /G ID \x00\xffxEIy EI !\r\nEI'
    const ops = parseContent(ascii([
      '% prologue with ( and EI', '/Span#20tag << /MCID 3 /Extra [true null << /Name /A#2fb >>] >> BDC',
      'BT /F#31 +12. Tf', literal + ' Tj % comment after string',
      '[' + continued + ' -.25 % comment inside an operand\r\n <41 4f 8>] TJ ET', image,
      'EMC q 0 0 20 10 re S Q',
    ].join('\n')))
    expect(ops.map(({ op }) => op)).toEqual(['BDC', 'BT', 'Tf', 'Tj', 'TJ', 'ET', 'BI', 'EMC', 'q', 're', 'S', 'Q'])
    expect(ops[0].operands).toEqual([{ name: 'Span tag' }, {
      entries: [['MCID', 3], ['Extra', [true, null, { entries: [['Name', { name: 'A/b' }]] }]]],
    }])
    expect(ops[2].operands).toEqual([{ name: 'F1' }, 12])
    expect(ops[3].operands).toEqual([{ bytes: ascii('a(b)c\n\r\t\b\f()\\A\xff+z') }])
    expect(ops[4].operands).toEqual([[{ bytes: ascii('ab\nc\nd') }, -0.25, { bytes: ascii('AO\x80') }]])
    expect(ops[6].raw).toBe(image)
    expect(parseContent(serializeContent(ops))).toEqual(ops)

    const filtered = 'BI /W 1 /H 1 /F /Fl ID \xffEI\x00\x80EIy EI'
    expect(parseContent(ascii(filtered))).toEqual([{ op: 'BI', operands: [], raw: filtered }])
  })
})

describe('page text engine', () => {
  it('preserves the PDF.js transform of later text after removal across a font switch', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage()
    const first = doc.embedStandardFont(StandardFonts.Helvetica)
    const second = doc.embedStandardFont(StandardFonts.Courier)
    page.node.setFontDictionary(PDFName.of('F1'), first.ref)
    page.node.setFontDictionary(PDFName.of('F2'), second.ref)
    page.pushOperators(
      PDFOperator.of(PDFOperatorNames.BeginText),
      PDFOperator.of(PDFOperatorNames.SetFontAndSize, ['/F1', '12']),
      PDFOperator.of(PDFOperatorNames.MoveText, ['72', '700']),
      PDFOperator.of(PDFOperatorNames.SetCharacterSpacing, ['1']),
      PDFOperator.of(PDFOperatorNames.ShowText, ['(Hello )']),
      PDFOperator.of(PDFOperatorNames.SetFontAndSize, ['/F2', '12']),
      PDFOperator.of(PDFOperatorNames.ShowText, ['(World)']),
      PDFOperator.of(PDFOperatorNames.EndText),
    )
    await doc.flush()
    const [hello, world] = readPageText(doc, 0).ops
    expect(hello).toMatchObject({ x: 72, y: 700, text: 'Hello ', size: 12, fontRes: 'F1', baseFont: 'Helvetica', raw: '(Hello )' })
    expect(hello.width).toBeCloseTo((722 + 556 + 222 + 222 + 556 + 278) * 0.012 + 6, 7)
    expect(world.x).toBeCloseTo(hello.x + hello.width, 7)
    expect(world.width).toBeCloseTo(41, 7)
    const original = await extracted(doc)
    const originalWorld = original.find((item) => item.str === 'World')!
    expect(original.some((item) => item.str.includes('Hello'))).toBe(true)
    expect(originalWorld.transform[4]).toBeCloseTo(world.x, 10)

    removeShowOps(doc, 0, new Set([hello.index]))
    const remaining = readPageText(doc, 0).ops.filter((op) => op.text)
    expect(remaining.map((op) => op.text)).toEqual(['World'])
    remaining[0].trm.forEach((value, i) => expect(value).toBeCloseTo(world.trm[i], 10))
    const rewritten = await extracted(doc)
    expect(rewritten.map((item) => item.str).join('')).toBe('World')
    rewritten[0].transform.forEach((value, i) => expect(value).toBeCloseTo(originalWorld.transform[i], 10))

    page.pushOperators(
      PDFOperator.of(PDFOperatorNames.BeginText),
      PDFOperator.of(PDFOperatorNames.SetFontAndSize, ['/F2', '12']),
      PDFOperator.of(PDFOperatorNames.SetTextMatrix, ['1', '0', '0', '1', '72', '680']),
      PDFOperator.of(PDFOperatorNames.ShowText, ['(Appended)']),
      PDFOperator.of(PDFOperatorNames.EndText),
    )
    expect((await extracted(doc)).map((item) => item.str).join(' ')).toBe('World Appended')
  })

  it('tracks TJ, quote operators, line anchors, rise, rotation and stacked CTMs', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage()
    page.setCropBox(3, 5, 500, 600)
    page.setRotation(degrees(90))
    const courier = doc.embedStandardFont(StandardFonts.Courier)
    page.node.setFontDictionary(PDFName.of('C'), courier.ref)
    append(page, 'q 2 0 0 3 10 20 cm BT /C 10 Tf 2 Tc 1 Tw 50 Tz 2 Ts 1 Tr 0 1 -1 0 100 200 Tm [(A ) 100 <42>] TJ')
    append(page, '(X) Tj 0 -12 TD (Y) Tj 4 3 (Q ) " (Z) Tj (R) \' (S) Tj ET Q'
      + ' BT /C 10 Tf 1 0 0 1 35 50 Tm (U) Tj ET /Span << /MCID 1 >> BDC 0 0 5 5 re S EMC')
    await doc.flush()
    const model = readPageText(doc, 0)
    expect(model.view).toEqual([3, 5, 503, 605])
    expect(model.rotate).toBe(90)
    const [kerned, crossStream, newLine, doubleQuote, afterDouble, singleQuote, afterSingle, outside] = model.ops
    expect(kerned).toMatchObject({
      text: 'A B', x: 206, y: 620, size: 20, width: 36, rotated: true, tfSize: 10,
      raw: '[(A ) 100 <42>]', trm: [0, 15, -20, 0, 206, 620],
      state: { Tc: 2, Tw: 1, Tz: 50, Ts: 2, Tr: 1 },
    })
    expect(crossStream.y).toBe(656)
    expect(newLine).toMatchObject({ x: 230, y: 620 })
    expect(doubleQuote).toMatchObject({ x: 254, y: 620, raw: '4 3 (Q )', state: { Tc: 3, Tw: 4 } })
    expect(afterDouble.y).toBe(653)
    expect(singleQuote).toMatchObject({ x: 278, y: 620 })
    expect(afterSingle.y).toBe(633.5)
    expect(outside).toMatchObject({ x: 35, y: 50, size: 10, rotated: false, state: { Tc: 0, Tr: 0 } })
    removeShowOps(doc, 0, new Set([kerned.index, doubleQuote.index, singleQuote.index]))
    const after = readPageText(doc, 0).ops.filter((op) => op.text)
    expect(after.map(({ text, trm }) => ({ text, trm }))).toEqual(
      [crossStream, newLine, afterDouble, afterSingle, outside].map(({ text, trm }) => ({ text, trm })),
    )
  })

  it('preserves the line anchor when a show advances at zero font size', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage()
    const font = doc.embedStandardFont(StandardFonts.Courier)
    page.node.setFontDictionary(PDFName.of('C'), font.ref)
    append(page, 'BT /C 0 Tf 3 Tc 14 TL 1 0 0 1 50 200 Tm (XX) Tj /C 10 Tf (A) Tj T* (B) Tj ET')
    await doc.flush()
    const [zero, first, second] = readPageText(doc, 0).ops
    expect(first.x).toBe(56)
    expect([second.x, second.y]).toEqual([50, 186])
    removeShowOps(doc, 0, new Set([zero.index]))
    expect(readPageText(doc, 0).ops.map(({ trm }) => trm)).toEqual([first.trm, second.trm])
  })

  it('reads Form XObjects with local resources and retains their streams', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage()
    const courier = doc.embedStandardFont(StandardFonts.Courier)
    const times = doc.embedStandardFont(StandardFonts.TimesRoman)
    page.node.setFontDictionary(PDFName.of('F'), courier.ref)
    const form = doc.context.flateStream(ascii('BT /F 8 Tf 4 5 Td (Form) Tj ET'), {
      Type: 'XObject', Subtype: 'Form', Matrix: [0, 1, -1, 0, 15, 25], BBox: [0, 0, 25, 25],
      Resources: { Font: { F: times.ref } },
    })
    const ref = doc.context.register(form)
    page.node.setXObject(PDFName.of('Form1'), ref)
    const graphics = 'q 2 0 0 2 30 50 cm /Form1 Do Q /Span << /MCID 1 >> BDC\n'
      + '0 0 20 20 re S BI /W 4 /H 1 /BPC 8 /CS /G ID \xffEI\x80 EI EMC'
    append(page, graphics + '\nBT /F 10 Tf (Page) Tj ET')
    await doc.flush()
    const [inside, outside] = readPageText(doc, 0).ops
    expect(inside).toMatchObject({ index: -1, x: 50, y: 108, size: 16, rotated: true, text: 'Form', baseFont: 'Times-Roman' })
    expect(outside).toMatchObject({ x: 0, y: 0, text: 'Page', baseFont: 'Courier' })
    removeShowOps(doc, 0, new Set([-1, outside.index]))
    expect(doc.context.lookup(ref)).toBe(form)
    expect(readPageText(doc, 0).ops.filter(({ text }) => text)).toEqual([inside])
    const contents = page.node.Contents() as PDFArray
    expect(contents.size()).toBe(1)
    const rewritten = parseContent(decodePDFRawStream(contents.lookup(0, PDFRawStream)).decode())
    expect(rewritten.slice(0, -4)).toEqual(parseContent(ascii(graphics)))
    expect(rewritten.some(({ raw }) => raw.includes('(Page)'))).toBe(false)
  })

  it('decodes CMap ranges and uses CID widths, byte lengths and explicit kerning', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage()
    const { context } = doc
    const stream = (program: string) => context.register(context.flateStream(ascii(program)))
    const encoding = stream([
      '2 begincodespacerange <20> <7f> <8100> <81ff> endcodespacerange',
      '1 begincidchar <20> 4 endcidchar',
      '1 begincidrange <8100> <8107> 10 endcidrange',
    ].join('\n'))
    const unicode = stream([
      '1 beginbfchar <20> <0020> endbfchar',
      '3 beginbfrange',
      '<8100> <8102> [<00660069> <D83DDE00> <03B1>]',
      '<8103> <8104> <D83DDE01>',
      '<8105> <8106> <00FF>',
      'endbfrange',
    ].join('\n'))
    const descendant = context.register(context.obj({
      Type: 'Font', Subtype: 'CIDFontType2', DW: 900, W: [4, [250], 10, 11, 500, 12, [700]],
    }))
    page.node.setFontDictionary(PDFName.of('CID'), context.register(context.obj({
      Type: 'Font', Subtype: 'Type0', BaseFont: 'ABCDEF+Sample', Encoding: encoding,
      DescendantFonts: [descendant], ToUnicode: unicode,
    })))
    append(page, 'BT /CID 10 Tf 2 Tw 1 Tc 80 Tz 10 30 Td [<2081008101> 250 <81028103810481058106>] TJ <20> Tj ET')
    const [mixed, following] = readPageText(doc, 0).ops
    expect(mixed).toMatchObject({ text: ' fi😀α😁😂ÿĀ', baseFont: 'Sample', fontRes: 'CID' })
    expect(mixed.width).toBeCloseTo((2.5 + 2 + 5 + 5 + 7 + 4 * 9 + 8 - 2.5) * 0.8, 8)
    expect(following.x).toBeCloseTo(10 + mixed.width, 8)
    removeShowOps(doc, 0, new Set([mixed.index]))
    expect(readPageText(doc, 0).ops.at(-1)?.x).toBeCloseTo(following.x, 8)
  })

  it('uses Type3 FontMatrix, MissingWidth, glyph differences and named encodings', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage()
    const { context } = doc
    const zapf = doc.embedStandardFont(StandardFonts.ZapfDingbats)
    const defs = [
      { Subtype: 'Type3', FontMatrix: [0.002, 0, 0, 0.002, 0, 0], FirstChar: 65,
        Widths: [300, 500, 1000], FontDescriptor: { MissingWidth: 200 },
        Encoding: { Differences: [65, 'alpha', 'uni0066006C', 'u1F600', 'minus'] } },
      { Subtype: 'Type1', Encoding: 'MacRomanEncoding' },
      { Subtype: 'Type1', Encoding: 'WinAnsiEncoding' },
    ]
    defs.forEach((font, i) => page.node.setFontDictionary(PDFName.of('F' + i), context.register(context.obj(font))))
    page.node.setFontDictionary(PDFName.of('Z'), zapf.ref)
    append(page, 'BT /F0 10 Tf (ABCD) Tj /F1 10 Tf <80> Tj /F2 10 Tf <8096> Tj /Z 10 Tf (!) Tj ET')
    await doc.flush()
    const ops = readPageText(doc, 0).ops
    expect(ops.map(({ text }) => text)).toEqual(['αfl😀−', 'Ä', '€–', '✁'])
    expect(ops[0].width).toBeCloseTo(40, 8)
  })

  it('uses two-byte Identity-V codes and vertical CID advances', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage()
    const { context } = doc
    const descendant = context.register(context.obj({
      Type: 'Font', Subtype: 'CIDFontType2', DW2: [880, -900],
      W2: [32, [-600, 300, 880], 65, 66, -800, 400, 880],
    }))
    const unicode = context.register(context.flateStream('1 beginbfrange <0041> <0043> <0041> endbfrange'))
    page.node.setFontDictionary(PDFName.of('V'), context.register(context.obj({
      Type: 'Font', Subtype: 'Type0', BaseFont: 'Sample', Encoding: 'Identity-V',
      DescendantFonts: [descendant], ToUnicode: unicode,
    })))
    append(page, 'BT /V 10 Tf 1 Tc 5 Tw 50 Tz 10 100 Td [<00410020> 200 <0043>] TJ <0042> Tj ET')
    const [first, second] = readPageText(doc, 0).ops
    expect(first).toMatchObject({ text: 'AC', x: 10, y: 100, width: 22, trm: [5, 0, 0, 10, 10, 100] })
    expect(second).toMatchObject({ text: 'B', x: 10, y: 78, width: 7 })
    removeShowOps(doc, 0, new Set([first.index]))
    expect(readPageText(doc, 0).ops.at(-1)?.trm).toEqual(second.trm)
  })
})

describe('clipping', () => {
  it('marks text outside clip paths and form bounding boxes as hidden', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([400, 400])
    const font = doc.embedStandardFont(StandardFonts.Helvetica)
    page.node.setFontDictionary(PDFName.of('F1'), font.ref)
    // a form whose BBox (0..100) cuts off the second line
    const form = doc.context.register(doc.context.flateStream(ascii('BT /F1 10 Tf 10 50 Td (inside form) Tj 0 100 Td (outside form) Tj ET'), {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 100], Resources: { Font: { F1: font.ref } },
    }))
    const fm = page.node.newXObject('Fm', form).decodeText()
    append(page, [
      'q 0 0 200 200 re W n BT /F1 10 Tf 20 20 Td (clipped in) Tj 0 250 Td (clipped out) Tj ET Q',
      'BT /F1 10 Tf 20 380 Td (free) Tj ET',
      `q 1 0 0 1 200 0 cm /${fm} Do Q`,
    ].join('\n'))
    // in content order: clipped in, clipped out, free, inside form, outside form
    const ops = readPageText(doc, 0).ops
    expect(ops.map((o) => !!o.hidden)).toEqual([false, true, false, false, true])
    expect(ops.map((o) => o.owner)).toEqual(['', '', '', fm, fm])
  })
})

describe('spaceGapOf', () => {
  type P = Parameters<typeof spaceGapOf>[0][number]
  const tj = (...parts: (string | number)[]): P[] => parts.map((x, i) => (typeof x === 'number' ? { i, kind: 'num', start: 0, end: 0, text: '', value: x } : { i, kind: 'str', start: 0, end: 0, text: x }))
  it('treats a space-sized gap as a word space in ordinary TJ', () => {
    expect(spaceGapOf(tj('Attention', -333, 'is', -333, 'all', -333, 'you', -333, 'need'))).toBe(100)
  })
  it('ignores tracking between every glyph when the text has its own spaces (Word justification)', () => {
    const letters = 'You are a clinical agent'.split('')
    const parts = letters.flatMap((c, k) => (k ? [-101, c] : [c]))
    expect(spaceGapOf(tj(...parts))).toBeGreaterThan(200)
  })
  it('finds word gaps above uniform tracking without space glyphs', () => {
    const parts: (string | number)[] = []
    for (const w of ['You', 'are', 'a', 'clinical', 'agent']) {
      if (parts.length) parts.push(-450)
      w.split('').forEach((c, k) => parts.push(...(k ? [-110, c] : [c])))
    }
    const g = spaceGapOf(tj(...parts))
    expect(g).toBeGreaterThan(110)
    expect(g).toBeLessThan(450)
  })
})

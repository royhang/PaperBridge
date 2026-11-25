import { quarterOf } from './orient'
import {
  PDFArray, PDFContentStream, PDFDict, PDFName, PDFNumber, PDFRawStream,
  PDFStream, StandardFontEmbedder, StandardFonts, decodePDFRawStream,
} from 'pdf-lib'
import type { PDFDocument, PDFPage } from 'pdf-lib'
import { codeLength, readCMap, readCode } from './cmap'
import type { CMap } from './cmap'
import { encodedGlyph, glyphText } from './glyphlist'

type Matrix = [number, number, number, number, number, number]

export type Rgb = [number, number, number]

export interface ShowOp {
  /** Page operator index at the time of reading. Form operators use -1. */
  index: number
  /** '' for page content, else the XObject resource-name path of the owning form, e.g. "Im1" or "Im1/Fm3" */
  owner: string
  /** operator index inside the owner's content stream */
  opIndex: number
  /** stable id for removal: `${owner}#${opIndex}` */
  id: string
  /** font object (dict or ref) — needed to re-emit form-owned glyphs from page level */
  fontObj?: unknown
  /** Origin in default page user space, including text rise. */
  x: number
  y: number
  /** Signed advance along the baseline, in user-space units. */
  width: number
  /** Effective vertical font scale in user space. */
  size: number
  rotated: boolean
  /** Font resource name without the leading slash. Form names are form-local. */
  fontRes: string
  /** BaseFont with the subset prefix removed. */
  baseFont: string
  /** Best-effort Unicode, including inferred word spaces between TJ strings. */
  text: string
  op: string
  tfSize: number
  state: { Tc: number; Tw: number; Tz: number; Ts: number; Tr: number; fill: Rgb }
  /** Full text rendering matrix, including font size, scaling, rise and CTM. */
  trm: Matrix
  /** Original operands as a byte string, including spacing operands for ". */
  raw: string
  /** (mostly) outside the clipping area: invisible, never translated or erased */
  hidden?: boolean
}

export interface PageTextModel {
  pageIndex: number
  /** CropBox (or MediaBox) in default page user space. */
  view: [number, number, number, number]
  rotate: number
  ops: ShowOp[]
  /** Thin straight page-level rules (fraction bars, radical overbars, underlines). */
  rules: RuleOp[]
  /** painted page-level paths, images and form XObjects (any depth) with their boxes */
  graphics: GraphicOp[]
  /** how often each form owner path is drawn on the page (text of forms drawn >1× can't be removed) */
  formUses: Record<string, number>
}

export interface GraphicOp {
  kind: 'path' | 'image' | 'form'
  /** painting operator index (page-level paths) or Do operator index in the owner */
  index: number
  owner: string
  /** for forms: the owner path of the form itself */
  path?: string
  x: number
  y: number
  w: number
  h: number
  /** paths: only straight segments / rectangles */
  straight?: boolean
  paint?: string
  fill?: Rgb
}

/**
 * A painted path made only of straight segments/rectangles whose bounding box is thin
 * (≤ 1.5 user units in one direction), e.g. a TeX fraction bar `x y w h re f`.
 * `index` is the painting operator; pass it to removeShowOps' `paths` to erase the rule.
 */
export interface RuleOp {
  index: number
  /** '' = page content; otherwise the Form XObject path the rule is drawn in (see ruleKey) */
  owner?: string
  /** axis-aligned box in default user space; stroked lines include the line width */
  x: number
  y: number
  w: number
  h: number
}

export type ContentOperand = number | boolean | null | ContentOperand[]
  | { name: string }
  | { bytes: Uint8Array }
  | { entries: [string, ContentOperand][] }
  | { keyword: string }

export interface ContentOp {
  op: string
  operands: ContentOperand[]
  /** Original operand bytes. For BI this is the entire inline image through EI. */
  raw: string
}

function byteString(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return text
}

// oxlint-disable-next-line no-control-regex -- NUL is PDF whitespace
const whitespace = /[\x00\t\n\f\r ]/
const delimiter = /[()[\]{}<>/%]/
const pdfNumber = /^[+-]?(?:\d+\.?\d*|\.\d+)$/
const hex = /^[\da-f]$/i
const escapedBytes: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 }

function operandName(value: ContentOperand | undefined): string | undefined {
  return value && typeof value === 'object' && 'name' in value ? value.name : undefined
}

class ContentLexer {
  readonly source: string
  offset = 0

  constructor(source: string) {
    this.source = source
  }

  skipTrivia(): void {
    while (this.offset < this.source.length) {
      const char = this.source[this.offset]
      if (whitespace.test(char)) {
        this.offset++
      } else if (char === '%') {
        while (this.offset < this.source.length && !/[\r\n]/.test(this.source[this.offset])) {
          this.offset++
        }
      } else {
        return
      }
    }
  }

  word(): string {
    const start = this.offset++
    while (this.offset < this.source.length) {
      const char = this.source[this.offset]
      if (whitespace.test(char) || delimiter.test(char)) break
      this.offset++
    }
    return this.source.slice(start, this.offset)
  }

  literalString(): Uint8Array {
    const bytes: number[] = []
    let depth = 1
    this.offset++
    while (this.offset < this.source.length) {
      let char = this.source[this.offset++]
      if (char === '\\') {
        char = this.source[this.offset++]
        if (char === undefined) break
        if (char === '\r' || char === '\n') {
          if (char === '\r' && this.source[this.offset] === '\n') this.offset++
          continue
        }
        if (/^[0-7]$/.test(char)) {
          let octal = char
          while (octal.length < 3 && /^[0-7]$/.test(this.source[this.offset] ?? '')) {
            octal += this.source[this.offset++]
          }
          bytes.push(Number.parseInt(octal, 8) & 0xff)
          continue
        }
        bytes.push(escapedBytes[char] ?? char.charCodeAt(0))
        continue
      }
      if (char === '(') depth++
      if (char === ')' && --depth === 0) return Uint8Array.from(bytes)
      if (char === '\r') {
        if (this.source[this.offset] === '\n') this.offset++
        char = '\n'
      }
      bytes.push(char.charCodeAt(0))
    }
    throw new Error('Unterminated PDF literal string')
  }

  hexString(): Uint8Array {
    const bytes: number[] = []
    let high = -1
    this.offset++
    while (this.offset < this.source.length) {
      const char = this.source[this.offset++]
      if (char === '>') {
        if (high >= 0) bytes.push(high * 16)
        return Uint8Array.from(bytes)
      }
      if (whitespace.test(char)) continue
      if (!hex.test(char)) throw new Error('Invalid PDF hex string')
      const digit = Number.parseInt(char, 16)
      if (high >= 0) {
        bytes.push(high * 16 + digit)
        high = -1
      } else {
        high = digit
      }
    }
    throw new Error('Unterminated PDF hex string')
  }

  operand(): ContentOperand {
    const char = this.source[this.offset]
    if (char === '(') return { bytes: this.literalString() }
    if (char === '<' && this.source[this.offset + 1] !== '<') {
      return { bytes: this.hexString() }
    }
    if (char === '/' || char === '[' || char === '<') {
      this.offset++
      if (char === '/') {
        const start = this.offset
        while (this.offset < this.source.length
          && !whitespace.test(this.source[this.offset]) && !delimiter.test(this.source[this.offset])) {
          this.offset++
        }
        const name = this.source.slice(start, this.offset)
          .replace(/#([\da-f]{2})/gi, (_, digits: string) => String.fromCharCode(Number.parseInt(digits, 16)))
        return { name }
      }
      if (char === '<') {
        this.offset++
        const entries: [string, ContentOperand][] = []
        for (;;) {
          this.skipTrivia()
          if (this.source.startsWith('>>', this.offset)) {
            this.offset += 2
            return { entries }
          }
          if (this.source[this.offset] !== '/') throw new Error('Invalid PDF dictionary key')
          const key = operandName(this.operand())!
          this.skipTrivia()
          if (this.offset >= this.source.length) throw new Error('Unterminated PDF dictionary')
          entries.push([key, this.operand()])
        }
      }
      const items: ContentOperand[] = []
      for (;;) {
        this.skipTrivia()
        if (this.source[this.offset] === ']') {
          this.offset++
          return items
        }
        if (this.offset >= this.source.length) throw new Error('Unterminated PDF array')
        items.push(this.operand())
      }
    }
    const word = this.word()
    if (pdfNumber.test(word)) return Number(word)
    if (word === 'true') return true
    if (word === 'false') return false
    if (word === 'null') return null
    return { keyword: word }
  }

  inlineImage(start: number): string {
    const params = new Map<string, ContentOperand>()
    for (;;) {
      this.skipTrivia()
      if (this.offset >= this.source.length) throw new Error('Unterminated PDF inline image dictionary')
      const key = this.operand()
      if (key && typeof key === 'object' && 'keyword' in key && key.keyword === 'ID') break
      const name = operandName(key)
      if (name === undefined) throw new Error('Invalid PDF inline image key')
      this.skipTrivia()
      params.set(name, this.operand())
    }
    if (this.source.startsWith('\r\n', this.offset)) this.offset += 2
    else if (whitespace.test(this.source[this.offset] ?? '')) this.offset++
    const dataStart = this.offset
    const isEnd = (ei: number) => whitespace.test(this.source[ei - 1] ?? '')
      && (ei + 2 === this.source.length || whitespace.test(this.source[ei + 2] ?? ''))

    // A known data length disambiguates even whitespace-delimited EI bytes in samples.
    const explicitLength = params.get('Length') ?? params.get('L')
    const length = typeof explicitLength === 'number' ? explicitLength : imageSampleLength(params)
    if (length !== undefined) {
      let end = dataStart + length
      while (end < this.source.length && whitespace.test(this.source[end])) end++
      if (this.source.startsWith('EI', end) && isEnd(end)) {
        this.offset = end + 2
        return this.source.slice(start, this.offset)
      }
    }
    for (let ei = this.source.indexOf('EI', dataStart); ei >= 0; ei = this.source.indexOf('EI', ei + 2)) {
      if (isEnd(ei)) {
        this.offset = ei + 2
        return this.source.slice(start, this.offset)
      }
    }
    throw new Error('Unterminated PDF inline image')
  }
}

function imageSampleLength(params: Map<string, ContentOperand>): number | undefined {
  if (params.has('F') || params.has('Filter')) return
  const width = params.get('W') ?? params.get('Width')
  const height = params.get('H') ?? params.get('Height')
  const mask = params.get('IM') ?? params.get('ImageMask')
  const bits = mask ? 1 : params.get('BPC') ?? params.get('BitsPerComponent')
  const color = params.get('CS') ?? params.get('ColorSpace')
  const space = operandName(Array.isArray(color) ? color[0] : color)
  let components: number
  if (mask || space === 'G' || space === 'DeviceGray' || space === 'I' || space === 'Indexed') {
    components = 1
  } else if (space === 'RGB' || space === 'DeviceRGB') {
    components = 3
  } else if (space === 'CMYK' || space === 'DeviceCMYK') {
    components = 4
  } else {
    return
  }
  if (typeof width === 'number' && typeof height === 'number' && typeof bits === 'number') {
    return Math.ceil(width * bits * components / 8) * height
  }
}

/** Parse content bytes, grouping operands with their operators and keeping inline images opaque. */
export function parseContent(bytes: Uint8Array): ContentOp[] {
  const source = byteString(bytes)
  const lexer = new ContentLexer(source)
  const result: ContentOp[] = []
  let operands: ContentOperand[] = []
  let start = 0
  let end = 0
  for (;;) {
    lexer.skipTrivia()
    if (lexer.offset >= source.length) return result
    const at = lexer.offset
    const operand = lexer.operand()
    if (operand && typeof operand === 'object' && 'keyword' in operand) {
      const op = operand.keyword
      const raw = op === 'BI' ? lexer.inlineImage(at) : operands.length ? source.slice(start, end) : ''
      result.push({ op, operands, raw })
      operands = []
    } else {
      if (!operands.length) start = at
      operands.push(operand)
      end = lexer.offset
    }
  }
}

/** Serialize the raw operands and operator names, preserving every inline image byte. */
export function serializeContent(ops: ContentOp[]): Uint8Array {
  const source = ops.map(({ op, raw }) => op === 'BI' ? raw : raw ? raw + ' ' + op : op).join('\n')
  return Uint8Array.from(source ? source + '\n' : '', (char) => char.charCodeAt(0))
}

const identity: Matrix = [1, 0, 0, 1, 0, 0]

// Apply the inner transform first, then the outer transform.
function compose([a, b, c, d, e, f]: Matrix, [g, h, i, j, k, l]: Matrix): Matrix {
  return [
    a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j,
    a * k + c * l + e, b * k + d * l + f,
  ]
}

function translate([a, b, c, d, e, f]: Matrix, x: number, y: number): Matrix {
  return [a, b, c, d, e + a * x + c * y, f + b * x + d * y]
}

const name = PDFName.of
const numberOf = (value: unknown): number | undefined => value instanceof PDFNumber ? value.asNumber() : undefined
const nameOf = (value: unknown): string | undefined => value instanceof PDFName ? value.decodeText() : undefined
const dictOf = (value: unknown): PDFDict | undefined => value instanceof PDFDict ? value : undefined
const arrayOf = (value: unknown): PDFArray | undefined => value instanceof PDFArray ? value : undefined

function streamBytes(stream: PDFStream): Uint8Array {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode()
  if (stream instanceof PDFContentStream) return stream.getUnencodedContents()
  throw new Error('Unsupported pdf-lib page content stream')
}

function pageOperators(page: PDFPage): ContentOp[] {
  const contents = page.node.Contents()
  if (contents instanceof PDFStream) return parseContent(streamBytes(contents))
  if (!(contents instanceof PDFArray)) return []
  const chunks: Uint8Array[] = []
  let length = 0
  for (let i = 0; i < contents.size(); i++) {
    const stream = contents.lookup(i)
    if (!(stream instanceof PDFStream)) continue
    const bytes = streamBytes(stream)
    chunks.push(bytes)
    length += bytes.length + 1
  }
  const combined = new Uint8Array(length)
  let offset = 0
  for (const bytes of chunks) {
    combined.set(bytes, offset)
    offset += bytes.length
    combined[offset++] = 10
  }
  return parseContent(combined)
}

interface FontInfo {
  baseFont: string
  vertical: boolean
  codeSize: (bytes: Uint8Array, offset: number) => number
  width: (code: number, length: number) => number
  text: (code: number, length: number) => string
}

const unknownFont: FontInfo = {
  baseFont: '',
  vertical: false,
  codeSize: () => 1,
  width: () => 0.5,
  text: () => '',
}

function cmapFrom(value: unknown, seen = new Set<PDFStream>()): CMap | undefined {
  if (!(value instanceof PDFStream) || seen.has(value)) return
  seen.add(value)
  const parent = cmapFrom(value.dict.lookup(name('UseCMap')), seen)
  return readCMap(parseContent(streamBytes(value)), parent)
}

interface WidthRange {
  first: number
  last: number
  value: number | number[]
}

function cidWidths(array: PDFArray | undefined, stride: number): WidthRange[] {
  if (!array) return []
  const ranges: WidthRange[] = []
  let i = 0
  while (i + 1 < array.size()) {
    const first = numberOf(array.lookup(i++))
    const next = array.lookup(i++)
    if (first === undefined) break
    if (next instanceof PDFArray) {
      const widths: number[] = []
      for (let j = 0; j < next.size(); j += stride) widths.push(numberOf(next.lookup(j)) ?? NaN)
      ranges.push({ first, last: first + widths.length - 1, value: widths })
    } else {
      const last = numberOf(next)
      const width = numberOf(array.lookup(i))
      if (last !== undefined && width !== undefined) ranges.push({ first, last, value: width })
      i += stride
    }
  }
  return ranges.reverse()
}

function compositeFont(dict: PDFDict, baseFont: string, unicode: CMap | undefined): FontInfo {
  const encoding = dict.lookup(name('Encoding'))
  const encodingMap = cmapFrom(encoding)
  const encodingName = nameOf(encoding) ?? ''
  const vertical = encodingMap?.vertical ?? encodingName.endsWith('-V')
  const identityEncoding = encodingName === 'Identity-H' || encodingName === 'Identity-V'
  const spaces = encodingMap?.spaces.length ? encodingMap.spaces : unicode?.spaces ?? []
  const descendant = dictOf(arrayOf(dict.lookup(name('DescendantFonts')))?.lookup(0))
  const defaultWidth = vertical
    ? numberOf(arrayOf(descendant?.lookup(name('DW2')))?.lookup(1)) ?? -1000
    : numberOf(descendant?.lookup(name('DW'))) ?? 1000
  const widths = cidWidths(arrayOf(descendant?.lookup(name(vertical ? 'W2' : 'W'))), vertical ? 3 : 1)
  return {
    baseFont,
    vertical,
    codeSize(bytes, offset) {
      // Without a character-to-CID map, use the character code as a CID.
      return (!identityEncoding && codeLength(spaces, bytes, offset)) || Math.min(2, bytes.length - offset)
    },
    width(code, length) {
      const cid = encodingMap?.cid(code, length) ?? code
      const range = widths.find(({ first, last }) => cid >= first && cid <= last)
      const width = Array.isArray(range?.value) ? range.value[cid - range.first] : range?.value
      return Number.isFinite(width) ? width! / 1000 : defaultWidth / 1000
    },
    text: (code, length) => unicode?.unicode(code, length) ?? '',
  }
}

const standardFonts = new Set<string>(Object.values(StandardFonts))

/** The built-in encoding of an embedded Type 1 font program (cleartext part of /FontFile). */
function type1Encoding(descriptor: PDFDict | undefined): Map<number, string> {
  const out = new Map<number, string>()
  const file = descriptor?.lookup(name('FontFile'))
  if (!(file instanceof PDFStream)) return out
  try {
    const bytes = streamBytes(file)
    const length1 = numberOf(file.dict.lookup(name('Length1'))) ?? bytes.length
    const clear = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(length1, bytes.length, 65536)))
    if (/\/Encoding\s+StandardEncoding/.test(clear)) return out
    for (const m of clear.matchAll(/dup\s+(\d+)\s*\/([^\s/]+)\s+put/g)) out.set(Number(m[1]), m[2])
  } catch {
    // unreadable font program: glyphs stay unknown
  }
  return out
}

function readFont(dict: PDFDict): FontInfo {
  const baseFont = (nameOf(dict.lookup(name('BaseFont'))) ?? '').replace(/^[A-Z]{6}\+/, '')
  const subtype = nameOf(dict.lookup(name('Subtype')))
  const unicode = cmapFrom(dict.lookup(name('ToUnicode')))
  if (subtype === 'Type0' || subtype === 'CIDFontType0' || subtype === 'CIDFontType2') {
    return compositeFont(dict, baseFont, unicode)
  }

  const encoding = dict.lookup(name('Encoding'))
  const encodingDict = dictOf(encoding)
  const baseEncoding = nameOf(encoding) ?? nameOf(encodingDict?.lookup(name('BaseEncoding')))
  const diff = arrayOf(encodingDict?.lookup(name('Differences')))
  const differences = new Map<number, string>()
  if (diff) {
    let code = 0
    for (let i = 0; i < diff.size(); i++) {
      const entry = diff.lookup(i)
      if (entry instanceof PDFNumber) code = entry.asNumber()
      else if (entry instanceof PDFName) differences.set(code++, entry.decodeText())
    }
  }
  const descriptor = dictOf(dict.lookup(name('FontDescriptor')))
  const standard = standardFonts.has(baseFont)
    ? StandardFontEmbedder.for(baseFont as Parameters<typeof StandardFontEmbedder.for>[0])
    : undefined
  const flags = numberOf(descriptor?.lookup(name('Flags'))) ?? 0
  const builtin = new Map<number, [string, string]>()
  if (!baseEncoding && standard && (baseFont === 'Symbol' || baseFont === 'ZapfDingbats')) {
    for (const scalar of standard.encoding.supportedCodePoints) {
      const { code, name: glyph } = standard.encoding.encodeUnicodeCodePoint(scalar)
      builtin.set(code, [glyph, String.fromCodePoint(scalar)])
    }
  }
  const unknownBuiltin = !baseEncoding && !standard && (
    /^(?:CMMI|CMSY|CMEX|LMMath)/i.test(baseFont) || (flags & 4) !== 0 || subtype === 'Type3'
  )
  // embedded Type 1 programs carry their own encoding ("dup 70 /F put") — TeX math fonts without ToUnicode
  if (unknownBuiltin && !unicode && !builtin.size) {
    for (const [code, glyph] of type1Encoding(descriptor)) builtin.set(code, [glyph, glyphText(glyph)])
  }
  const first = numberOf(dict.lookup(name('FirstChar'))) ?? 0
  const widths = arrayOf(dict.lookup(name('Widths')))
  const missing = numberOf(descriptor?.lookup(name('MissingWidth')))
  const factor = subtype === 'Type3'
    ? numberOf(arrayOf(dict.lookup(name('FontMatrix')))?.lookup(0)) ?? 0.001
    : 0.001

  const glyphs: [string, string][] = Array.from({ length: 256 }, (_, code) => {
    const glyph = differences.get(code)
    if (glyph !== undefined) return [glyph, glyphText(glyph)]
    return builtin.get(code) ?? (builtin.size || unknownBuiltin
      ? ['', ''] : encodedGlyph(baseEncoding ?? 'StandardEncoding', code))
  })
  const advances = glyphs.map(([glyph, text], code) => {
    const index = code - first
    const width = widths && index >= 0 && index < widths.size() ? numberOf(widths.lookup(index)) : undefined
    if (width !== undefined || missing !== undefined) return (width ?? missing!) * factor
    const metrics = standard?.font
    if (metrics) {
      let afm = metrics.getWidthOfGlyph(glyph)
      const scalar = text.codePointAt(0)
      if (afm === undefined && scalar !== undefined && standard.encoding.canEncodeUnicodeCodePoint(scalar)) {
        afm = metrics.getWidthOfGlyph(standard.encoding.encodeUnicodeCodePoint(scalar).name)
      }
      if (afm !== undefined) return afm / 1000
      if (metrics.IsFixedPitch) return 0.6
    }
    return 0.5
  })
  return {
    baseFont,
    vertical: false,
    codeSize: () => 1,
    width: (code) => advances[code],
    text: (code, length) => unicode?.unicode(code, length) ?? glyphs[code][1],
  }
}

interface GraphicsState {
  ctm: Matrix
  font: FontInfo
  fontRes: string
  tfSize: number
  Tc: number
  Tw: number
  Tz: number
  TL: number
  Ts: number
  Tr: number
  lineWidth: number
  fill: Rgb
  fontObj?: unknown
  /** conservative clip rectangle in user space (intersection of clip-path and form BBox extents) */
  clip?: Clip
}

type Clip = [x0: number, y0: number, x1: number, y1: number]
const intersectClip = (a: Clip | undefined, b: Clip): Clip => (a ? [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])] : b)
/** share of a show op's glyph box that lies inside the clip */
function visibleShare(o: ShowOp, clip: Clip): number {
  const x0 = Math.min(o.x, o.x + o.width)
  const x1 = Math.max(o.x, o.x + o.width, x0 + o.size * 0.3)
  const y0 = o.y - 0.2 * o.size
  const y1 = o.y + 0.75 * o.size
  const w = Math.max(0, Math.min(x1, clip[2]) - Math.max(x0, clip[0]))
  const h = Math.max(0, Math.min(y1, clip[3]) - Math.max(y0, clip[1]))
  return (w * h) / Math.max(1e-6, (x1 - x0) * (y1 - y0))
}

const initialGraphics: GraphicsState = {
  ctm: identity, font: unknownFont, fontRes: '', tfSize: 0,
  Tc: 0, Tw: 0, Tz: 100, TL: 0, Ts: 0, Tr: 0, lineWidth: 1, fill: [0, 0, 0],
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
function colorOf(values: number[]): Rgb | undefined {
  if (values.length === 1) return [clamp01(values[0]), clamp01(values[0]), clamp01(values[0])]
  if (values.length === 3) return values.map(clamp01) as Rgb
  if (values.length === 4) {
    const [c, m, y, k] = values.map(clamp01)
    return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]
  }
  return undefined
}
const unitBox = (m: Matrix) => {
  const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => applyPoint(m, x, y))
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

const pathPaintOps = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n'])
const applyPoint = ([a, b, c, d, e, f]: Matrix, x: number, y: number): [number, number] => [a * x + c * y + e, b * x + d * y + f]

function matrixOf(operands: ContentOperand[]): Matrix {
  return identity.map((fallback, i) => (
    typeof operands[i] === 'number' ? operands[i] : fallback
  )) as Matrix
}

function pdfMatrix(array: PDFArray | undefined): Matrix {
  return identity.map((fallback, i) => numberOf(array?.lookup(i)) ?? fallback) as Matrix
}

function byteOperand(operand: ContentOperand): Uint8Array | undefined {
  return operand && typeof operand === 'object' && 'bytes' in operand ? operand.bytes : undefined
}

const isShow = (op: string) => op === 'Tj' || op === 'TJ' || op === "'" || op === '"'
const relativeLineOps = new Set(['Td', 'TD', 'T*', "'", '"'])

interface Piece {
  /** index in the TJ array (0 for Tj) */
  i: number
  kind: 'str' | 'num'
  /** advance before / after this piece, in unscaled text space */
  start: number
  end: number
  text: string
  bytes?: Uint8Array
  /** the TJ kerning value for numbers */
  value?: number
}

interface ShowStep {
  show: ShowOp
  distance: number
  adjustmentScale: number
  next: Matrix
  line: Matrix
  pieces: Piece[]
  /** base matrix (CTM × Tm at op start) for computing fragment origins */
  basis: Matrix
  horizontal: number
  /** TJ adjustment (thousandths of an em, as a positive gap) from which a word space is inferred */
  spaceGap: number
  clip?: Clip
}

/**
 * The TJ gap that stands for a word space. Usually 100 (tight justified lines go down to ~0.15 em; letter
 * kerns that open a gap are far smaller). Letter-spaced text (Word justifies by tracking: "Y o u ␣ a r e"
 * with -101 between every glyph) has the gap everywhere: when the TJ has its own space glyphs, or when
 * nearly every glyph boundary carries a similar gap, only clearly larger gaps are word spaces.
 */
export function spaceGapOf(pieces: Piece[]): number {
  const gaps: number[] = []
  let boundaries = 0
  let explicit = false
  let prevStr = false
  let pending = 0
  for (const p of pieces) {
    if (p.kind === 'num') {
      pending -= p.value ?? 0
      continue
    }
    if (p.text.includes(' ')) explicit = true
    if (prevStr) {
      boundaries++
      if (pending > 0) gaps.push(pending)
    }
    // boundaries inside one string count too (no gap there)
    boundaries += Math.max(0, [...p.text].length - 1)
    prevStr = true
    pending = 0
  }
  const big = gaps.filter((g) => g >= 100).sort((a, b) => a - b)
  if (big.length < 4) return 100
  const median = big[big.length >> 1]
  if (explicit && big.length >= boundaries * 0.3) return Math.max(100, median * 2.5)
  if (big.length >= boundaries * 0.6) return Math.max(100, median * 1.6)
  return 100
}

/** TJ kerning (thousandths of an em) at or above which a TJ is split into separate fragments. */
export const FRAGMENT_GAP = 700

class TextInterpreter {
  private readonly fonts = new WeakMap<PDFDict, FontInfo>()
  private readonly forms = new WeakMap<PDFStream, ContentOp[]>()
  private readonly activeForms = new Set<PDFStream>()
  private readonly visit: (step: ShowStep) => void
  private readonly readForms: boolean
  private readonly visitGraphic?: (g: GraphicOp) => void

  constructor(visit: (step: ShowStep) => void, readForms: boolean, visitGraphic?: (g: GraphicOp) => void) {
    this.visit = visit
    this.readForms = readForms
    this.visitGraphic = visitGraphic
  }

  font(dict: PDFDict | undefined): FontInfo {
    if (!dict) return unknownFont
    let info = this.fonts.get(dict)
    if (!info) {
      info = readFont(dict)
      this.fonts.set(dict, info)
    }
    return info
  }

  walk(ops: ContentOp[], resources: PDFDict | undefined, inherited = initialGraphics, owner = ''): void {
    const fonts = dictOf(resources?.lookup(PDFName.Font))
    const xobjects = this.readForms ? dictOf(resources?.lookup(PDFName.XObject)) : undefined
    const extStates = dictOf(resources?.lookup(PDFName.ExtGState))
    const stack: GraphicsState[] = []
    let graphics = { ...inherited }
    let tm = identity
    let tlm = identity
    // current path (page level only): user-space points, straight-only flag, clip flag
    let pathPoints: [number, number][] = []
    let pathStraight = true
    let pathClip = false
    // clip tracking (any level): bbox of the current path, W/W* pending
    let clipPts: [number, number][] = []
    let clipPending = false

    for (const [index, content] of ops.entries()) {
      const { op, operands } = content
      const n = (i: number) => typeof operands[i] === 'number' ? operands[i] : 0
      if (op === 'm' || op === 'l') clipPts.push(applyPoint(graphics.ctm, n(0), n(1)))
      else if (op === 're') {
        const [x, y, w, h] = [n(0), n(1), n(2), n(3)]
        clipPts.push(...[[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => applyPoint(graphics.ctm, px, py)))
      } else if (op === 'c' || op === 'v' || op === 'y') for (let k = 0; k + 1 < operands.length; k += 2) clipPts.push(applyPoint(graphics.ctm, n(k), n(k + 1)))
      else if (op === 'W' || op === 'W*') clipPending = true
      else if (pathPaintOps.has(op)) {
        if (clipPending && clipPts.length) {
          const xs = clipPts.map((p) => p[0])
          const ys = clipPts.map((p) => p[1])
          graphics.clip = intersectClip(graphics.clip, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])
        }
        clipPts = []
        clipPending = false
      }
      if (this.visitGraphic) {
        if (op === 'm' || op === 'l') pathPoints.push(applyPoint(graphics.ctm, n(0), n(1)))
        else if (op === 're') {
          const [x, y, w, h] = [n(0), n(1), n(2), n(3)]
          pathPoints.push(...[[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => applyPoint(graphics.ctm, px, py)))
        } else if (op === 'c' || op === 'v' || op === 'y') {
          pathStraight = false
          for (let k = 0; k + 1 < operands.length; k += 2) pathPoints.push(applyPoint(graphics.ctm, n(k), n(k + 1)))
        }
        else if (op === 'W' || op === 'W*') pathClip = true
        else if (pathPaintOps.has(op)) {
          if (op !== 'n' && !pathClip && pathStraight && pathPoints.length) {
            const xs = pathPoints.map((p) => p[0])
            const ys = pathPoints.map((p) => p[1])
            let [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
            if (op === 'S' || op === 's') {
              const half = graphics.lineWidth * Math.hypot(graphics.ctm[2], graphics.ctm[3]) / 2
              x0 -= half; x1 += half; y0 -= half; y1 += half
            }
            this.visitGraphic({ kind: 'path', index, owner, x: x0, y: y0, w: x1 - x0, h: y1 - y0, straight: true, paint: op, fill: graphics.fill })
          } else if (op !== 'n' && !pathClip && pathPoints.length) {
            const xs = pathPoints.map((p) => p[0])
            const ys = pathPoints.map((p) => p[1])
            const [x0, y0] = [Math.min(...xs), Math.min(...ys)]
            this.visitGraphic({ kind: 'path', index, owner, x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0, straight: false, paint: op, fill: graphics.fill })
          }
          pathPoints = []
          pathStraight = true
          pathClip = false
        }
      }
      switch (op) {
        case 'w':
          graphics.lineWidth = n(0)
          break
        case 'g':
        case 'rg':
        case 'k':
        case 'sc':
        case 'scn': {
          const values = operands.filter((v): v is number => typeof v === 'number')
          graphics.fill = colorOf(values) ?? graphics.fill
          break
        }
        case 'cs':
          graphics.fill = [0, 0, 0]
          break
        case 'BI':
          this.visitGraphic?.({ kind: 'image', index, owner, ...unitBox(graphics.ctm) })
          break
        case 'q':
          stack.push({ ...graphics })
          break
        case 'Q':
          graphics = stack.pop() ?? graphics
          break
        case 'cm':
          graphics.ctm = compose(graphics.ctm, matrixOf(operands))
          break
        case 'gs': {
          const key = operandName(operands[0])
          const ext = key === undefined ? undefined : dictOf(extStates?.lookup(resourceName(key)))
          const setting = arrayOf(ext?.lookup(PDFName.Font))
          const font = dictOf(setting?.lookup(0))
          const size = numberOf(setting?.lookup(1))
          if (font && size !== undefined) {
            graphics.font = this.font(font)
            graphics.tfSize = size
            graphics.fontRes = fonts?.entries().find(([, value]) => fonts.context.lookup(value) === font)?.[0].decodeText() ?? ''
          }
          break
        }
        case 'BT':
        case 'ET':
          tm = tlm = identity
          break
        case 'Tm':
          tm = tlm = matrixOf(operands)
          break
        case 'TD':
          graphics.TL = -n(1)
          // TD also performs Td.
          tm = tlm = translate(tlm, n(0), n(1))
          break
        case 'Td':
          tm = tlm = translate(tlm, n(0), n(1))
          break
        case 'T*':
          tm = tlm = translate(tlm, 0, -graphics.TL)
          break
        case 'Tf': {
          const key = operandName(operands[0]) ?? ''
          graphics.fontRes = key
          graphics.tfSize = n(1)
          graphics.font = this.font(dictOf(fonts?.lookup(resourceName(key))))
          graphics.fontObj = fonts?.get(resourceName(key))
          break
        }
        case 'Tc':
        case 'Tw':
        case 'Tz':
        case 'TL':
        case 'Ts':
        case 'Tr':
          graphics[op] = n(0)
          break
        case 'Do': {
          const key = operandName(operands[0])
          const xobjectsAll = dictOf(resources?.lookup(PDFName.XObject))
          const xobject = key === undefined ? undefined : xobjectsAll?.lookup(resourceName(key))
          const subtype = xobject instanceof PDFStream ? nameOf(xobject.dict.lookup(name('Subtype'))) : undefined
          if (subtype === 'Image') this.visitGraphic?.({ kind: 'image', index, owner, ...unitBox(graphics.ctm) })
          if (subtype === 'Form' && key !== undefined && xobject instanceof PDFStream) {
            const path = owner ? `${owner}/${key}` : key
            const bbox = arrayOf(xobject.dict.lookup(name('BBox')))
            let formClip = graphics.clip
            if (bbox) {
              const m = compose(graphics.ctm, pdfMatrix(arrayOf(xobject.dict.lookup(name('Matrix')))))
              const [bx0, by0, bx1, by1] = [0, 1, 2, 3].map((i) => numberOf(bbox.lookup(i)) ?? 0)
              const pts = [[bx0, by0], [bx1, by0], [bx0, by1], [bx1, by1]].map(([px, py]) => applyPoint(m, px, py))
              const xs = pts.map((p) => p[0])
              const ys = pts.map((p) => p[1])
              this.visitGraphic?.({ kind: 'form', index, owner, path, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) })
              formClip = intersectClip(graphics.clip, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])
            }
            if (xobjects) this.walkForm(xobject, resources, { ...graphics, clip: formClip }, path)
          }
          break
        }
      }
      if (!isShow(op)) continue
      if (op === '"') {
        graphics.Tw = n(0)
        graphics.Tc = n(1)
      }
      if (op === "'" || op === '"') tm = tlm = translate(tlm, 0, -graphics.TL)
      const step = showStep(content, owner ? -1 : index, graphics, tm, tlm, owner, index)
      step.clip = graphics.clip
      this.visit(step)
      tm = step.next
    }
  }

  private walkForm(form: PDFStream, enclosing: PDFDict | undefined, state: GraphicsState, path: string): void {
    if (this.activeForms.has(form)) return
    let ops = this.forms.get(form)
    if (!ops) {
      ops = parseContent(streamBytes(form))
      this.forms.set(form, ops)
    }
    const ctm = compose(state.ctm, pdfMatrix(arrayOf(form.dict.lookup(name('Matrix')))))
    const resources = dictOf(form.dict.lookup(PDFName.Resources)) ?? enclosing
    this.activeForms.add(form)
    this.walk(ops, resources, { ...state, ctm }, path)
    this.activeForms.delete(form)
  }
}

function resourceName(decoded: string): PDFName {
  // PDFName.of interprets #xx escapes. Protect literal # bytes in the decoded name.
  return name(decoded.replace(/#/g, '#23'))
}

function showStep(content: ContentOp, index: number, graphics: GraphicsState, tm: Matrix, line: Matrix, owner = '', opIndex = index): ShowStep {
  const { op, operands, raw } = content
  const { ctm, font, fontRes, tfSize, Tc, Tw, Tz, Ts, Tr, fill, fontObj } = graphics
  const last = operands[operands.length - 1]
  const pieces = op === 'TJ' && Array.isArray(last) ? last : [last]
  const horizontalScale = Tz / 100
  const axisScale = font.vertical ? 1 : horizontalScale
  const adjustmentScale = tfSize * axisScale / 1000
  let distance = 0
  let text = ''
  let gap = 0
  const infos: Piece[] = []
  for (const [pi, piece] of pieces.entries()) {
    if (typeof piece === 'number' && op === 'TJ') {
      infos.push({ i: pi, kind: 'num', start: distance, end: distance - piece * adjustmentScale, text: '', value: piece })
      distance -= piece * adjustmentScale
      continue
    }
    const bytes = byteOperand(piece)
    if (!bytes) continue
    const pieceStart = distance
    let decoded = ''
    for (let offset = 0; offset < bytes.length;) {
      const length = font.codeSize(bytes, offset)
      const code = readCode(bytes, offset, length)
      const wordSpace = length === 1 && code === 32 ? Tw : 0
      distance += (font.width(code, length) * tfSize + Tc + wordSpace) * axisScale
      decoded += font.text(code, length)
      offset += length
    }
    infos.push({ i: pi, kind: 'str', start: pieceStart, end: distance, text: decoded, bytes })
  }
  // Some producers use a space-sized adjustment where there is no space glyph
  const spaceGap = spaceGapOf(infos)
  for (const x of infos) {
    if (x.kind === 'num') {
      gap -= x.value ?? 0
      continue
    }
    if (gap >= spaceGap && /\S$/.test(text) && /^\S/.test(x.text)) text += ' '
    text += x.text
    gap = 0
  }
  const basis = compose(ctm, tm)
  const [a, b, c, d] = basis
  const [horizontal, vertical] = [Math.hypot(a, b), Math.hypot(c, d)]
  const trm = compose(basis, [tfSize * horizontalScale, 0, 0, tfSize, 0, Ts])
  const rotated = Math.abs(b) > 1e-8 * horizontal || Math.abs(c) > 1e-8 * vertical || (a < 0 && d < 0)
  return {
    show: {
      index, owner, opIndex, id: `${owner}#${opIndex}`, fontObj,
      x: trm[4], y: trm[5], width: font.vertical ? -distance * vertical : distance * horizontal,
      size: Math.hypot(trm[2], trm[3]), rotated, fontRes, baseFont: font.baseFont,
      text, op, tfSize, state: { Tc, Tw, Tz, Ts, Tr, fill: [...fill] as Rgb }, trm, raw,
    },
    distance,
    adjustmentScale,
    next: font.vertical ? translate(tm, 0, distance) : translate(tm, distance, 0),
    line,
    pieces: infos,
    basis,
    horizontal,
    spaceGap,
  }
}

const hexOf = (bytes: Uint8Array) => '<' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') + '>'

/** Groups of TJ piece indices separated by kerning gaps ≥ FRAGMENT_GAP (one group = whole op otherwise). */
function fragmentRanges(step: ShowStep): Piece[][] {
  const { show, pieces } = step
  // quarter-turn text (sideways tables) splits like upright text; other rotations stay whole
  if (show.op !== 'TJ' || (show.rotated && quarterOf(show.trm) < 0)) return [pieces]
  const groups: Piece[][] = [[]]
  for (const p of pieces) {
    if (p.kind === 'num' && (p.value ?? 0) <= -FRAGMENT_GAP && groups[groups.length - 1].some((x) => x.kind === 'str')) {
      groups.push([])
      continue
    }
    groups[groups.length - 1].push(p)
  }
  return groups.filter((g) => g.some((x) => x.kind === 'str'))
}

/**
 * Split a TJ show at large internal gaps (pdfTeX draws several table cells / side-by-side captions in
 * one TJ). Each fragment is a ShowOp of its own with id `owner#opIndex~k`; ops without such gaps are
 * returned unchanged.
 */
function fragmentsOf(step: ShowStep): ShowOp[] {
  const groups = fragmentRanges(step)
  const leading = step.pieces.find((p) => p.kind === 'str')?.start ?? 0
  if (groups.length <= 1 && Math.abs(leading) < 1e-9) return [step.show]
  const { show } = step
  const scale: Matrix = [show.tfSize * (show.state.Tz / 100), 0, 0, show.tfSize, 0, show.state.Ts]
  return groups.map((g, k) => {
    const strs = g.filter((x) => x.kind === 'str')
    const start = strs[0].start
    const end = strs[strs.length - 1].end
    const trm = compose(compose(step.basis, [1, 0, 0, 1, start, 0]), scale)
    const body = g.slice(g.indexOf(strs[0]), g.indexOf(strs[strs.length - 1]) + 1)
    let text = ''
    for (const x of body) {
      if (x.kind === 'num' && (x.value ?? 0) <= -step.spaceGap && /\S$/.test(text)) text += ' '
      if (x.kind === 'str') text += x.text
    }
    return {
      ...show,
      id: groups.length > 1 ? `${show.owner}#${show.opIndex}~${k}` : show.id,
      x: trm[4],
      y: trm[5],
      width: (end - start) * step.horizontal,
      text,
      trm,
      raw: '[' + body.map((x) => (x.kind === 'num' ? pdfDecimal(x.value ?? 0) : hexOf(x.bytes!))).join(' ') + ']',
    }
  })
}

/** Read page text in paint order, including text in Form XObjects (index -1). */
export function readPageText(doc: PDFDocument, pageIndex: number): PageTextModel {
  const page = doc.getPage(pageIndex)
  const { x, y, width, height } = page.getCropBox()
  const ops: ShowOp[] = []
  const graphics: GraphicOp[] = []
  new TextInterpreter((step) => {
    for (const f of fragmentsOf(step)) {
      if (step.clip && !f.rotated && visibleShare(f, step.clip) < 0.5) f.hidden = true
      ops.push(f)
    }
  }, true, (g) => graphics.push(g)).walk(pageOperators(page), page.node.Resources())
  const formUses: Record<string, number> = {}
  for (const g of graphics) if (g.kind === 'form' && g.path) formUses[g.path] = (formUses[g.path] ?? 0) + 1
  // rules inside a form count when the form is drawn once (a whole page placed with pdfpages, a figure):
  // they can be erased there without touching other uses
  const rules: RuleOp[] = graphics
    .filter((g) => g.kind === 'path' && g.straight && Math.min(g.w, g.h) <= 1.5 && Math.max(g.w, g.h) >= 1)
    .filter((g) => !g.owner || g.owner.split('/').every((_, k, all) => formUses[all.slice(0, k + 1).join('/')] === 1))
    .map(({ index, owner, x, y, w, h }) => ({ index, ...(owner ? { owner } : {}), x, y, w, h }))
  return { pageIndex, view: [x, y, x + width, y + height], rotate: page.getRotation().angle, ops, rules, graphics, formUses }
}

function pdfDecimal(value: number): string {
  const [mantissa, exponent] = String(value).split('e')
  if (!exponent) return mantissa
  const negative = mantissa.startsWith('-')
  const [whole, fraction = ''] = (negative ? mantissa.slice(1) : mantissa).split('.')
  const digits = whole + fraction
  const point = whole.length + Number(exponent)
  const decimal = point <= 0 ? '0.' + '0'.repeat(-point) + digits
    : point >= digits.length ? digits + '0'.repeat(point - digits.length)
      : digits.slice(0, point) + '.' + digits.slice(point)
  return (negative ? '-' : '') + decimal
}

function matrixOperator(matrix: Matrix): ContentOp {
  return { op: 'Tm', operands: matrix, raw: matrix.map(pdfDecimal).join(' ') }
}

interface Removal {
  step: ShowStep
  /** TJ piece indices to blank; undefined = the whole operator */
  pieces?: Set<number>
}

/** A TJ with some string pieces replaced by equal kerning, so later glyphs keep their positions. */
function partialTJ(step: ShowStep, blank: Set<number>): ContentOp {
  const items: (number | string)[] = []
  for (const p of step.pieces) {
    if (p.kind === 'num') items.push(p.value ?? 0)
    else if (blank.has(p.i)) items.push(-(p.end - p.start) / step.adjustmentScale)
    else items.push(hexOf(p.bytes!))
  }
  // merge adjacent numbers
  const merged: (number | string)[] = []
  for (const it of items) {
    const last = merged[merged.length - 1]
    if (typeof it === 'number' && typeof last === 'number') merged[merged.length - 1] = last + it
    else merged.push(it)
  }
  const raw = '[' + merged.map((x) => (typeof x === 'number' ? pdfDecimal(Math.round(x * 1000) / 1000) : x)).join(' ') + ']'
  return { op: 'TJ', operands: [], raw }
}

/** Rewrite an operator list: drop removed shows (keeping later text in place) and unpaint `paths`. */
function rewriteOps(ops: ContentOp[], removedAll: Map<number, Removal>, paths: Set<number>): ContentOp[] {
  const removed = new Map<number, ShowStep>()
  const partial = new Map<number, Removal>()
  for (const [k, r] of removedAll) {
    if (r.pieces) partial.set(k, r)
    else removed.set(k, r.step)
  }
  const output: ContentOp[] = []
  let restoreLine: Matrix | undefined
  for (const [index, content] of ops.entries()) {
    const { op } = content
    if (restoreLine && relativeLineOps.has(op)) {
      output.push(matrixOperator(restoreLine))
      restoreLine = undefined
    }
    if (op === 'Tm' || op === 'BT' || op === 'ET') restoreLine = undefined
    if (paths.has(index) && pathPaintOps.has(op)) {
      // end the path without painting it
      output.push({ op: 'n', operands: [], raw: '' })
      continue
    }
    const part = partial.get(index)
    if (part?.pieces) {
      // a blanked string becomes a kerning number equal to its full advance (incl. Tc / Tw)
      output.push(partialTJ(part.step, part.pieces))
      continue
    }
    const step = removed.get(index)
    if (!step) {
      output.push(content)
      continue
    }
    if (op === '"') {
      const { Tw, Tc } = step.show.state
      output.push({ op: 'Tw', operands: [Tw], raw: pdfDecimal(Tw) })
      output.push({ op: 'Tc', operands: [Tc], raw: pdfDecimal(Tc) })
    }
    if (op === "'" || op === '"') output.push({ op: 'T*', operands: [], raw: '' })
    if (!step.distance) continue
    const adjustment = -step.distance / step.adjustmentScale
    if (Number.isFinite(adjustment)) {
      // A number-only TJ advances Tm without modifying Tlm, the anchor for Td and T*.
      // Zero Tc during the adjustment so extractors that count it on empty runs
      // use the same advance as PDF renderers.
      const { Tc } = step.show.state
      if (Tc) output.push({ op: 'Tc', operands: [0], raw: '0' })
      output.push({ op: 'TJ', operands: [[adjustment]], raw: '[' + pdfDecimal(adjustment) + ']' })
      if (Tc) output.push({ op: 'Tc', operands: [Tc], raw: pdfDecimal(Tc) })
    } else {
      // With zero font size, character spacing can move Tm even though TJ cannot.
      output.push(matrixOperator(step.next))
      restoreLine = step.line
    }
  }
  return output
}

/**
 * Return a copy of `resources` in which the form at `segments` (a path of XObject names) is replaced by
 * a clone whose content is `content`. Parent forms along the path are cloned too, so other pages / other
 * uses of the same XObjects are unaffected.
 */
function replaceFormContent(doc: PDFDocument, resources: PDFDict, segments: string[], content: Uint8Array): PDFDict | undefined {
  const xobjects = dictOf(resources.lookup(PDFName.XObject))
  const key = resourceName(segments[0])
  const form = xobjects?.lookup(key)
  if (!xobjects || !(form instanceof PDFStream)) return undefined
  let clone: PDFStream
  if (segments.length === 1) {
    const fresh = doc.context.flateStream(content)
    for (const [k, v] of form.dict.entries()) {
      const n = k.decodeText()
      if (n !== 'Length' && n !== 'Filter' && n !== 'DecodeParms' && n !== 'DL') fresh.dict.set(k, v)
    }
    clone = fresh
  } else {
    const inner = dictOf(form.dict.lookup(PDFName.Resources)) ?? resources
    const innerClone = replaceFormContent(doc, inner, segments.slice(1), content)
    if (!innerClone) return undefined
    const dict = form.dict.clone(doc.context)
    dict.set(PDFName.Resources, innerClone)
    clone = form instanceof PDFRawStream ? PDFRawStream.of(dict, form.contents) : doc.context.flateStream(streamBytes(form), {})
    if (!(form instanceof PDFRawStream)) for (const [k, v] of dict.entries()) if (!['Length', 'Filter', 'DecodeParms'].includes(k.decodeText())) clone.dict.set(k, v)
  }
  const xoClone = xobjects.clone(doc.context)
  xoClone.set(key, doc.context.register(clone))
  const resClone = resources.clone(doc.context)
  resClone.set(PDFName.XObject, xoClone)
  return resClone
}

function formStream(resources: PDFDict | undefined, segments: string[]): PDFStream | undefined {
  let res = resources
  let stream: PDFStream | undefined
  for (const seg of segments) {
    const xo = dictOf(res?.lookup(PDFName.XObject))?.lookup(resourceName(seg))
    if (!(xo instanceof PDFStream)) return undefined
    stream = xo
    res = dictOf(xo.dict.lookup(PDFName.Resources)) ?? res
  }
  return stream
}

/**
 * Remove selected shows and keep everything else (later text stays exactly in place).
 * `ids`: page operator indices (numbers) or ShowOp ids (`owner#opIndex`) — text inside Form XObjects is
 * removed by rewriting page-local clones of those forms.
 * `paths`: page-level painting-operator indices of rules (see RuleOp) to erase: they become `n`.
 * Removing text drawn in a clipping mode also removes its contribution to the clip.
 */
/** Removal key of a rule: its op index in the page content, or `owner#index` inside a form. */
export const ruleKey = (r: Pick<RuleOp, 'index' | 'owner'>): number | string => (r.owner ? `${r.owner}#${r.index}` : r.index)

export function removeShowOps(doc: PDFDocument, pageIndex: number, ids: Set<number | string>, rulePaths: Set<number | string> = new Set()): void {
  if (!ids.size && !rulePaths.size) return
  const paths = new Set([...rulePaths].filter((k): k is number => typeof k === 'number'))
  const formPaths = new Map<string, Set<number>>()
  for (const k of rulePaths) {
    if (typeof k !== 'string') continue
    const at = k.lastIndexOf('#')
    const owner = k.slice(0, at)
    if (!formPaths.has(owner)) formPaths.set(owner, new Set())
    formPaths.get(owner)!.add(Number(k.slice(at + 1)))
  }
  const page = doc.getPage(pageIndex)
  const ops = pageOperators(page)
  const wanted = new Set([...ids].map((v) => (typeof v === 'number' ? `#${v}` : v)))
  const removed = new Map<string, Map<number, Removal>>()
  const needForms = [...wanted].some((id) => !id.startsWith('#'))
  new TextInterpreter((step) => {
    const { owner, opIndex, id } = step.show
    let r: Removal | undefined
    if (wanted.has(id)) r = { step }
    else {
      const frags = fragmentRanges(step)
      if (frags.length > 1) {
        const hit = frags.map((_, k) => wanted.has(`${id}~${k}`))
        if (hit.every(Boolean)) r = { step }
        else if (hit.some(Boolean)) r = { step, pieces: new Set(frags.flatMap((grp, k) => (hit[k] ? grp.filter((p) => p.kind === 'str').map((p) => p.i) : []))) }
      }
    }
    if (!r) return
    let m = removed.get(owner)
    if (!m) removed.set(owner, (m = new Map()))
    if (!m.has(opIndex)) m.set(opIndex, r)
  }, needForms).walk(ops, page.node.Resources())

  const pageRemovals = removed.get('') ?? new Map<number, Removal>()
  if (pageRemovals.size || paths.size) {
    const stream = doc.context.register(doc.context.flateStream(serializeContent(rewriteOps(ops, pageRemovals, paths))))
    page.node.set(PDFName.Contents, doc.context.obj([stream]))
  }
  for (const owner of new Set([...removed.keys(), ...formPaths.keys()])) {
    if (!owner) continue
    const steps = removed.get(owner) ?? new Map<number, Removal>()
    const segments = owner.split('/')
    const resources = page.node.Resources()
    const form = formStream(resources, segments)
    if (!resources || !form) continue
    const content = serializeContent(rewriteOps(parseContent(streamBytes(form)), steps, formPaths.get(owner) ?? new Set()))
    const next = replaceFormContent(doc, resources, segments, content)
    if (next) page.node.set(PDFName.Resources, next)
  }
  // pdf-lib 1.17 caches the drawing stream on PDFPage. Invalidate it so that
  // drawText and pushOperators append to the replacement Contents array.
  Object.assign(page, { contentStream: undefined, contentStreamRef: undefined })
}

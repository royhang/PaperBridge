import type { ContentOp, ContentOperand } from './engine'

interface CodeRange {
  length: number
  first: number
  last: number
}

type UnicodeRange = CodeRange & { values: Uint8Array | ContentOperand[] }
type CidRange = CodeRange & { cid: number }

export interface CMap {
  spaces: CodeRange[]
  vertical: boolean
  unicode: (code: number, length: number) => string | undefined
  cid: (code: number, length: number) => number | undefined
}

function inRange(range: CodeRange, code: number, length: number): boolean {
  return range.length === length && code >= range.first && code <= range.last
}

export function readCode(bytes: Uint8Array, start: number, length: number): number {
  let code = 0
  for (let i = start; i < start + length; i++) code = code * 256 + bytes[i]
  return code
}

/** PDF character codes can be up to four bytes and vary in length within a CMap. */
export function codeLength(spaces: CodeRange[], bytes: Uint8Array, start: number): number | undefined {
  let code = 0
  for (let length = 1; length <= 4 && start + length <= bytes.length; length++) {
    code = code * 256 + bytes[start + length - 1]
    if (spaces.some((range) => inRange(range, code, length))) return length
  }
}

function bytesOf(operand: ContentOperand | undefined): Uint8Array | undefined {
  return typeof operand === 'object' && operand !== null && 'bytes' in operand
    ? operand.bytes : undefined
}

function sourceRange(first: ContentOperand, last: ContentOperand): CodeRange | undefined {
  const from = bytesOf(first)
  const to = bytesOf(last)
  if (!from || !to || from.length !== to.length || from.length < 1 || from.length > 4) return
  const length = from.length
  return { length, first: readCode(from, 0, length), last: readCode(to, 0, length) }
}

const utf16 = new TextDecoder('utf-16be', { ignoreBOM: true })

function decodeDestination(bytes: Uint8Array, increment = 0): string {
  if (!increment) return utf16.decode(bytes)
  // A sequential bfrange increments the entire big-endian destination string.
  const result = bytes.slice()
  for (let i = result.length - 1; i >= 0 && increment; i--) {
    const sum = result[i] + increment
    result[i] = sum % 256
    increment = Math.floor(sum / 256)
  }
  return utf16.decode(result)
}

/** Read the declarative codespace, Unicode, and CID sections of an embedded CMap. */
export function readCMap(ops: ContentOp[], parent?: CMap): CMap {
  const spaces: CodeRange[] = []
  const unicodeRanges: UnicodeRange[] = []
  const cidRanges: CidRange[] = []
  let vertical = parent?.vertical ?? false
  for (const { op, operands } of ops) {
    if (op === 'def') {
      const [name, value] = operands
      if (typeof name === 'object' && name !== null && 'name' in name && name.name === 'WMode') {
        vertical = value === 1
      }
    }
    const single = op === 'endbfchar' || op === 'endcidchar'
    const isUnicode = op === 'endbfchar' || op === 'endbfrange'
    const isCid = op === 'endcidchar' || op === 'endcidrange'
    const isSpace = op === 'endcodespacerange'
    if (!isUnicode && !isCid && !isSpace) continue
    const stride = single || isSpace ? 2 : 3
    for (let i = 0; i + stride <= operands.length; i += stride) {
      const range = sourceRange(operands[i], operands[i + (single ? 0 : 1)])
      if (!range || range.first > range.last) continue
      const dest = operands[i + stride - 1]
      if (isSpace) spaces.push(range)
      if (isCid && typeof dest === 'number') cidRanges.push({ ...range, cid: dest })
      if (isUnicode) {
        const values = Array.isArray(dest) ? dest : bytesOf(dest)
        if (values) unicodeRanges.push({ ...range, values })
      }
    }
  }
  unicodeRanges.reverse()
  cidRanges.reverse()
  const unicodeCache = new Map<number, string | undefined>()
  return {
    spaces: [...spaces, ...(parent?.spaces ?? [])],
    vertical,
    unicode(code, length) {
      const key = code * 4 + length
      if (unicodeCache.has(key)) return unicodeCache.get(key)
      const range = unicodeRanges.find((entry) => inRange(entry, code, length))
      let text: string | undefined
      if (range) {
        const offset = code - range.first
        if (Array.isArray(range.values)) {
          const bytes = bytesOf(range.values[offset])
          if (bytes) text = decodeDestination(bytes)
        } else {
          text = decodeDestination(range.values, offset)
        }
      }
      text ??= parent?.unicode(code, length)
      unicodeCache.set(key, text)
      return text
    },
    cid(code, length) {
      const range = cidRanges.find((entry) => inRange(entry, code, length))
      return range ? range.cid + code - range.first : parent?.cid(code, length)
    },
  }
}

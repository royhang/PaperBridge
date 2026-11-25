import type { PageGeometry, Paragraph, RawTextItem, Rect } from './types'

// Baseline and horizontal-gap tolerances are relative to the local font size.
// A gutter needs recurring text on both sides at overlapping heights. Lines
// across it delimit reading-order bands. Column spacing and edges then help
// distinguish paragraph breaks from ordinary line wraps.

interface TextLine {
  text: string
  bbox: Rect
  baseline: number
  fontSize: number
  fontName?: string
}

interface TextBox extends TextLine {
  index: number
}

interface TextRow {
  anchor: TextBox
  boxes: TextBox[]
}

type ParagraphContent = Pick<Paragraph, 'text' | 'bbox' | 'kind'>

const captionStart = /^(?:(?:Figure|Table|Fig)\s+|(?:Fig\.|[图表])\s*)\p{Nd}+/iu
const sectionStart = /^(?:\d+(?:\.\d+)*\.?|[IVXLCDM]+\.|[A-Z]\.)\s+\p{Lu}/u
const namedHeading = /^(?:Abstract|References|Acknowledg(?:e)?ments|Introduction|Conclusion)[.:]?$/i
const namedStart = /^(?:Abstract|References|Acknowledg(?:e)?ments|Introduction|Conclusion)(?=$|[\s.:–—])/i
const pageNumber = /^(?:page\s+)?\p{Nd}+(?:\s*(?:\/|of)\s*\p{Nd}+)?$/iu
const equationNumber = /^\(\d+(?:\.\d+)*[a-z]?\)$/i
const equationOperator = /[=≠≤≥≈∑∫]/u
const proseWord = /(?:^|\s)\p{L}{3,}(?=$|[\s,.;:!?])/u
const contactAddress = /^(?:[^\s@]+@[\w-]+(?:\.[\w-]+)+|(?:https?:\/\/|www\.)\S+)$/i
const footnoteMarker = /^[∗†‡\s]+$/u
const wrappedWord = /(\p{L}+(?:[-\u2010]\p{L}+)*)[-\u00ad\u2010]$/u
const cjkStart = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const cjkEnd = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u

function median(values: number[]): number {
  if (!values.length) return 0
  values.sort((a, b) => a - b)
  const middle = Math.floor(values.length / 2)
  return (values[middle] + values[Math.floor((values.length - 1) / 2)]) / 2
}

function right(box: Rect): number {
  return box.x + box.w
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(right(a), right(b)) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

function byPosition(a: { bbox: Rect }, b: { bbox: Rect }): number {
  return a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function makeRowLines({ anchor, boxes }: TextRow): TextLine[] {
  boxes.sort((a, b) => a.bbox.x - b.bbox.x || a.index - b.index)
  const lines: TextLine[] = []
  let parts: string[] = []
  let bbox: Rect | undefined
  let previous: TextBox | undefined
  let main: TextBox | undefined
  let separator = false

  function finishLine() {
    if (bbox && main) {
      lines.push({ text: collapseWhitespace(parts.join('')), bbox, baseline: anchor.baseline,
        fontSize: main.fontSize, fontName: main.fontName })
    }
    parts = []
    bbox = undefined
    previous = undefined
    main = undefined
  }

  for (const box of boxes) {
    if (!box.text.trim()) {
      separator = true
      continue
    }

    if (bbox && previous) {
      const gap = box.bbox.x - right(bbox)
      const fontSize = Math.min(box.fontSize, previous.fontSize)
      if (gap > 1.5 * Math.max(box.fontSize, previous.fontSize)) {
        finishLine()
      } else if (!/\s$/.test(previous.text) && !/^[\s.,;:!?]/.test(box.text) &&
        (separator || gap > 0.15 * fontSize ||
          (parts.length === 1 && /^\d+$/.test(previous.text) && previous.fontSize < 0.8 * box.fontSize && gap >= 0))) {
        parts.push(' ')
      }
    }

    parts.push(box.text)
    bbox = bbox ? union(bbox, box.bbox) : box.bbox
    if (!main || box.bbox.w > main.bbox.w) main = box
    previous = box
    separator = false
  }
  finishLine()
  return lines
}

function overlapsLine(fragment: TextBox, box: TextBox): boolean {
  const gap = Math.max(fragment.bbox.x - right(box.bbox), box.bbox.x - right(fragment.bbox))
  // A fragment can sit over a math glyph, but should not jump into the middle of a word or phrase.
  return gap <= 0.8 * box.fontSize && (gap >= -0.15 * box.fontSize || box.bbox.w <= 3 * box.fontSize) &&
    Math.min(fragment.baseline, box.baseline) > Math.max(fragment.bbox.y, box.bbox.y)
}

function attachFragments(rows: TextRow[]) {
  // Give wide text and larger glyphs first claim on adjacent fragments, using fixed row baselines.
  const strength = ({ anchor }: TextRow) => Math.max(anchor.bbox.w, 3 * anchor.fontSize) * anchor.fontSize
  const indices = rows.map((_, index) => index).sort((a, b) => strength(rows[b]) - strength(rows[a]))
  const attached = new Set<TextBox>()
  for (const index of indices) {
    const row = rows[index]
    const { baseline, fontSize } = row.anchor
    if (!row.boxes.length) continue

    const neighbours: TextRow[] = []
    const distance = 1.2 * fontSize
    let start = index
    while (start > 0 && baseline - rows[start - 1].anchor.baseline < distance) start--
    for (let i = start; i < rows.length && rows[i].anchor.baseline - baseline < distance; i++) {
      if (i !== index) neighbours.push(rows[i])
    }
    neighbours.sort((a, b) => Math.abs(a.anchor.baseline - baseline) - Math.abs(b.anchor.baseline - baseline))
    for (const neighbour of neighbours) {
      neighbour.boxes = neighbour.boxes.filter((box) => {
        if (attached.has(box) || (box === neighbour.anchor && strength(neighbour) >= strength(row)) ||
          box.bbox.w > 3 * fontSize || box.fontSize > 1.05 * fontSize ||
          !row.boxes.some((part) => overlapsLine(box, part)) ||
          neighbour.boxes.some((part) => part !== box && part.bbox.w > 3 * fontSize && overlapsLine(box, part))) {
          return true
        }
        attached.add(box)
        row.boxes.push(box)
        return false
      })
    }
  }
}

function groupLines(boxes: TextBox[]): TextLine[][] {
  boxes.sort((a, b) => a.baseline - b.baseline)
  const rows: TextRow[] = []
  const separators: TextBox[] = []
  for (const box of boxes) {
    if (!box.text.trim()) {
      separators.push(box)
      continue
    }
    const row = rows.at(-1)
    if (row && box.baseline - row.anchor.baseline <= 0.25 * Math.min(box.fontSize, row.anchor.fontSize)) {
      row.boxes.push(box)
    } else {
      rows.push({ anchor: box, boxes: [box] })
    }
  }

  for (const row of rows) {
    row.boxes.sort((a, b) => b.bbox.w - a.bbox.w)
    row.anchor = row.boxes[0]
  }
  attachFragments(rows)
  const occupied = rows.filter((row) => row.boxes.length)
  // Assign spaces after finding the baselines so empty boxes cannot shift or split a row.
  let rowIndex = 0
  for (const separator of separators) {
    while (rowIndex + 1 < occupied.length &&
      separator.baseline >= (occupied[rowIndex].anchor.baseline + occupied[rowIndex + 1].anchor.baseline) / 2) {
      rowIndex++
    }
    const row = occupied[rowIndex]
    if (row && Math.abs(separator.baseline - row.anchor.baseline) < 0.5 * row.anchor.fontSize) {
      row.boxes.push(separator)
    }
  }

  const lines = occupied.map(makeRowLines)
  for (const [i, row] of lines.entries()) {
    const label = row.at(-1)
    if (!label || !equationNumber.test(label.text)) continue
    const adjacent = [row.at(-2), lines[i - 1]?.at(-1), lines[i + 1]?.at(-1)]
    const equation = adjacent.find((line) => line && right(line.bbox) <= label.bbox.x &&
      Math.abs(line.baseline - label.baseline) <= 0.5 * line.fontSize && isEquation(line.text))
    if (equation) {
      equation.text += ` ${label.text}`
      equation.bbox = union(equation.bbox, label.bbox)
      row.pop()
    }
  }
  return lines.filter((row) => row.length)
}

function findGutter(lines: TextLine[], pageWidth: number, bodyFont: number): number | undefined {
  // Sample a bounded number of positions so the projection takes linear time.
  // Require a strip of clear space to avoid identifying touching columns.
  const halfWidth = Math.max(pageWidth * 0.004, bodyFont * 0.25)
  let gutter: number | undefined
  let bestScore = 0
  for (let step = -20; step <= 20; step++) {
    const center = pageWidth * (0.5 + step * 0.005)
    let leftCount = 0
    let rightCount = 0
    let pairedCount = 0
    let lastLeft = -Infinity
    let lastRight = -Infinity

    for (const line of lines) {
      const y = line.bbox.y
      if (right(line.bbox) <= center - halfWidth) {
        leftCount++
        if (y - lastRight < 2 * bodyFont) pairedCount++
        lastLeft = y
      } else if (line.bbox.x >= center + halfWidth) {
        rightCount++
        if (y - lastLeft < 2 * bodyFont) pairedCount++
        lastRight = y
      }
    }

    if (Math.min(leftCount, rightCount) < 2 || pairedCount < 2 || leftCount + rightCount <= lines.length / 2) continue
    const score = 2 * Math.min(leftCount, rightCount) + pairedCount - Math.abs(step) / 21
    if (score > bestScore) {
      bestScore = score
      gutter = center
    }
  }
  return gutter
}

function isContactLine(text: string): boolean {
  return text.replace(/^\d+ ?(?=https?:\/\/|www\.)/i, '').split(' ').every((word) => contactAddress.test(word))
}

function centerX({ bbox }: TextLine): number {
  return bbox.x + bbox.w / 2
}

function gridLines(rows: TextLine[][], bodyFont: number, pageWidth: number): Set<TextLine> {
  const grid = new Set<TextLine>()
  let region: TextLine[][] = []
  const visualRows: TextLine[][] = []
  for (const row of rows) {
    const previous = visualRows.at(-1)
    if (previous && row[0].baseline - previous[0].baseline <= 0.4 * bodyFont) {
      previous.push(...row)
    } else {
      visualRows.push([...row])
    }
  }

  function hasCellGap(row: TextLine[]): boolean {
    const ordered = [...row].sort((a, b) => a.bbox.x - b.bbox.x)
    return ordered.some((line, i) => i > 0 &&
      line.bbox.x - right(ordered[i - 1].bbox) > 2.5 * Math.min(line.fontSize, ordered[i - 1].fontSize))
  }

  function finishRegion() {
    const cells = region.filter((row) => !row.every((line) => isContactLine(line.text)))
    const gridRows = cells.filter(hasCellGap)
    for (const row of gridRows.length * 2 > cells.length ? cells : gridRows) {
      for (const line of row) grid.add(line)
    }
    region = []
  }

  for (const row of visualRows) {
    const first = row[0]
    const previous = region.at(-1)?.[0]
    if (previous && first.baseline - previous.baseline > 3 * bodyFont) finishRegion()
    const maxWords = hasCellGap(row) ? 8 : 6
    if (row.every((line) => wordCount(line.text) <= maxWords && !captionStart.test(line.text) && !isSectionHeading(line.text))) {
      region.push(row)
    } else {
      finishRegion()
    }
  }
  finishRegion()

  // A centered byline can have tighter gaps between names than the grid rule requires.
  for (let i = 1; i < rows.length; i++) {
    const [contact, extra] = rows[i]
    if (extra || !isContactLine(contact.text) || contact.bbox.w < 0.25 * pageWidth ||
      Math.abs(centerX(contact) - pageWidth / 2) > contact.fontSize) continue
    let next = contact
    for (let j = i - 1; j >= 0; j--) {
      const [line, second] = rows[j]
      if (second || wordCount(line.text) > 10 || captionStart.test(line.text) || isSectionHeading(line.text) ||
        Math.abs(centerX(line) - pageWidth / 2) > line.fontSize ||
        next.baseline - line.baseline > 1.5 * line.fontSize ||
        Math.abs(line.fontSize - contact.fontSize) > 0.15 * contact.fontSize) break
      grid.add(line)
      next = line
    }
  }
  return grid
}

function columnMetrics(lines: TextLine[], bodyFont: number) {
  let left = Infinity
  let edge = -Infinity
  const spacing: number[] = []
  const bodyLines = lines.filter((line) => Math.abs(line.fontSize - bodyFont) <= bodyFont * 0.15 &&
    !captionStart.test(line.text) && !namedHeading.test(line.text) && !sectionStart.test(line.text))
  for (const line of bodyLines.length ? bodyLines : lines) {
    left = Math.min(left, line.bbox.x)
    edge = Math.max(edge, right(line.bbox))
  }
  for (let i = 1; i < lines.length; i++) {
    const previous = lines[i - 1]
    const gap = lines[i].baseline - previous.baseline
    if (gap > 0 && gap <= 2 * Math.max(previous.fontSize, lines[i].fontSize)) spacing.push(gap)
  }
  return { left, center: (left + edge) / 2, shortEdge: left + 0.75 * (edge - left), spacing: median(spacing) || 1.2 * bodyFont }
}

function joinLines(lines: TextLine[], compounds: Set<string>): string {
  const parts: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const { text } = lines[i]
    const next = lines[i + 1]?.text
    const tail = wrappedWord.exec(text)?.[1]
    const continuation = next?.match(/^\p{Ll}\p{L}*/u)?.[0]
    if (tail && continuation) {
      const compound = `${tail}-${continuation}`.replaceAll('\u2010', '-').toLowerCase()
      parts.push(text.slice(0, -1))
      // keep the hyphen for compounds: "left-to-|right", "English-|to-German", or seen intact elsewhere
      const continuesCompound = /^\p{Ll}\p{L}*[-\u2010]\p{L}/u.test(next ?? '')
      if (/[-\u2010]/u.test(tail) || continuesCompound || compounds.has(compound)) parts.push(text.endsWith('\u00ad') ? '-' : text.slice(-1))
    } else {
      parts.push(text)
      if (next && !(cjkEnd.test(text) && cjkStart.test(next))) parts.push(' ')
    }
  }
  return parts.join('')
}

function wordCount(text: string): number {
  return text.split(' ').length
}

function isSectionHeading(text: string): boolean {
  return namedHeading.test(text) || (sectionStart.test(text) && wordCount(text) < 15)
}

function isEquation(text: string): boolean {
  return equationOperator.test(text) && !proseWord.test(text)
}

function classify(text: string, fontSize: number, bodyFont: number): Paragraph['kind'] {
  if (captionStart.test(text)) return 'caption'
  if (isEquation(text) || (text.match(/\p{L}/gu)?.length ?? 0) < 3) return 'other'
  if (isSectionHeading(text) || (wordCount(text) < 15 && fontSize > 1.15 * bodyFont)) return 'heading'
  return 'body'
}

function groupParagraphs(lines: TextLine[], metrics: ReturnType<typeof columnMetrics>, bodyFont: number,
  compounds: Set<string>): ParagraphContent[] {
  const paragraphs: ParagraphContent[] = []
  let members: TextLine[] = []

  function finishParagraph() {
    if (!members.length) return
    const text = joinLines(members, compounds)
    const bbox = members.map((line) => line.bbox).reduce(union)
    paragraphs.push({ text, bbox, kind: classify(text, members[0].fontSize, bodyFont) })
    members = []
  }

  for (const line of lines) {
    if (isEquation(line.text) && !captionStart.test(line.text)) {
      finishParagraph()
      paragraphs.push({ text: line.text, bbox: line.bbox, kind: 'other' })
      continue
    }
    const previous = members.at(-1)
    if (previous) {
      const previousEndedShort = right(previous.bbox) < metrics.shortEdge
      const centered = line.fontName === previous.fontName &&
        Math.abs(centerX(line) - centerX(previous)) <= 0.5 * line.fontSize &&
        (Math.abs(centerX(line) - metrics.center) <= line.fontSize || Math.abs(line.bbox.x - previous.bbox.x) > line.fontSize)
      const spacing = centered ? Math.max(metrics.spacing, 1.2 * previous.fontSize) : metrics.spacing
      if (line.baseline - previous.baseline > spacing + 0.25 * previous.fontSize ||
        Math.abs(line.fontSize - previous.fontSize) > 0.15 * previous.fontSize ||
        (!centered && previousEndedShort && (line.bbox.x - metrics.left > 1.5 * line.fontSize || /[.?!:;]$/.test(previous.text))) ||
        captionStart.test(line.text) || sectionStart.test(line.text) || namedStart.test(line.text) ||
        isSectionHeading(previous.text)) {
        finishParagraph()
      }
    }
    members.push(line)
  }
  finishParagraph()
  return paragraphs
}

export function extractParagraphs(items: RawTextItem[], page: PageGeometry): Paragraph[] {
  const boxes: TextBox[] = []
  const marginBoxes: TextBox[] = []
  const other: ParagraphContent[] = []
  for (const [index, item] of items.entries()) {
    const [a, b, c, d, x, y] = item.transform
    const fontSize = Math.hypot(c, d) || item.height
    const baseline = page.height - y
    const bbox = { x, y: baseline - fontSize, w: item.width, h: fontSize }
    const rotated = Math.max(Math.abs(b), Math.abs(c)) > 0.1 * Math.abs(a)
    const text = collapseWhitespace(item.str)
    const sideStamp = /^arXiv\s*:/i.test(text) && (x <= page.width * 0.06 || right(bbox) >= page.width * 0.94)
    if (rotated || sideStamp || footnoteMarker.test(text)) {
      if (text) other.push({ text, bbox, kind: 'other' })
      continue
    }
    const centerY = bbox.y + bbox.h / 2
    const inPageMargin = centerY <= page.height * 0.06 || centerY >= page.height * 0.94
    const destination = inPageMargin ? marginBoxes : boxes
    destination.push({ index, text: item.str, bbox, baseline, fontSize, fontName: item.fontName })
  }

  const marginRows = groupLines(marginBoxes).map((row) => row.filter((line) => {
    if (wordCount(line.text) >= 12) return true
    other.push({ text: line.text, bbox: line.bbox, kind: 'other' })
    return false
  })).filter((row) => row.length)
  const rows = [...groupLines(boxes), ...marginRows].sort((a, b) => a[0].baseline - b[0].baseline)
  const candidates = rows.flat().filter(({ text }) => !pageNumber.test(text) && !isContactLine(text))
  const prose = candidates.filter(({ text }) => !isSectionHeading(text) && !captionStart.test(text) && !isEquation(text))
  // Short cells by themselves are weak evidence of a page-wide column gutter.
  const substantial = prose.filter((line) => line.bbox.w >= 0.20 * page.width || wordCount(line.text) >= 6)
  const bodyFont = median((substantial.length ? substantial : prose.length ? prose : candidates).map((line) => line.fontSize))
  const gutter = findGutter(substantial, page.width, bodyFont)
  const columnOf = (line: TextLine) => gutter === undefined ? 0 : right(line.bbox) <= gutter ? 0 : line.bbox.x >= gutter ? 1 : 2
  const columnRows: TextLine[][][] = [[], [], []]
  for (const row of rows) {
    const cells: TextLine[][] = [[], [], []]
    for (const line of row) cells[columnOf(line)].push(line)
    cells.forEach((column, i) => { if (column.length) columnRows[i].push(column) })
  }
  const grid = new Set(columnRows.flatMap((column) => [...gridLines(column, bodyFont, page.width)]))
  const lines = rows.flat().filter((line) => {
    if (!grid.has(line) && !pageNumber.test(line.text) && !isContactLine(line.text)) return true
    other.push({ text: line.text, bbox: line.bbox, kind: 'other' })
    return false
  })
  const compounds = new Set(lines.flatMap(({ text }) =>
    (text.match(/\p{L}+(?:[-\u2010]\p{L}+)+/gu) ?? []).map((word) => word.replaceAll('\u2010', '-').toLowerCase())))

  const paragraphs: ParagraphContent[] = []
  if (gutter === undefined) {
    paragraphs.push(...groupParagraphs(lines, columnMetrics(lines, bodyFont), bodyFont, compounds))
  } else {
    const columns: TextLine[][] = [[], [], []]
    for (const line of lines) columns[columnOf(line)].push(line)
    const metrics = columns.map((column) => columnMetrics(column, bodyFont))
    const band: TextLine[][] = [[], [], []]
    for (const line of lines) {
      const column = columnOf(line)
      const flush = column === 2 ? [0, 1] : [2]
      for (const previousColumn of flush) {
        paragraphs.push(...groupParagraphs(band[previousColumn], metrics[previousColumn], bodyFont, compounds))
        band[previousColumn] = []
      }
      band[column].push(line)
    }
    for (let column = 0; column < band.length; column++) {
      paragraphs.push(...groupParagraphs(band[column], metrics[column], bodyFont, compounds))
    }
  }

  // Insert marginal material by position without interrupting the column flow.
  other.sort(byPosition)
  const ordered: ParagraphContent[] = []
  let marginIndex = 0
  for (const paragraph of paragraphs) {
    while (marginIndex < other.length && byPosition(other[marginIndex], paragraph) <= 0) {
      ordered.push(other[marginIndex++])
    }
    ordered.push(paragraph)
  }
  ordered.push(...other.slice(marginIndex))
  return ordered.map((paragraph, order) => ({ ...paragraph, id: `${page.pageIndex}-${order}`, pageIndex: page.pageIndex, order }))
}

export function isTranslatable(paragraph: Paragraph): boolean {
  if (paragraph.kind === 'other') return false
  const text = paragraph.text.replace(/\s/g, '')
  const letters = text.match(/\p{L}/gu)?.length ?? 0
  if (letters < 3 || 2 * letters <= [...text].length) return false
  return !isEquation(paragraph.text)
}

const glyphs: Record<string, string> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$',
  percent: '%', ampersand: '&', quotesingle: "'", parenleft: '(', parenright: ')',
  asterisk: '*', plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/',
  colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?',
  at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^',
  underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
  ff: 'ff', fi: 'fi', fl: 'fl', ffi: 'ffi', ffl: 'ffl', germandbls: 'ß',
  quoteleft: '‘', quoteright: '’', quotesinglbase: '‚', quotedblleft: '“',
  quotedblright: '”', quotedblbase: '„', endash: '–', emdash: '—', bullet: '•',
  ellipsis: '…', dagger: '†', daggerdbl: '‡', guillemotleft: '«', guillemotright: '»',
  guilsinglleft: '‹', guilsinglright: '›', exclamdown: '¡', questiondown: '¿',
  AE: 'Æ', ae: 'æ', OE: 'Œ', oe: 'œ', Lslash: 'Ł', lslash: 'ł', Oslash: 'Ø',
  oslash: 'ø', Eth: 'Ð', eth: 'ð', Thorn: 'Þ', thorn: 'þ', dotlessi: 'ı',
  dotlessj: 'ȷ', franc: '₣', currency: '¤', Euro: '€', cent: '¢', sterling: '£',
  yen: '¥', section: '§', paragraph: '¶', copyright: '©', registered: '®',
  trademark: '™', ordmasculine: 'º', ordfeminine: 'ª', perthousand: '‰',
  brokenbar: '¦', logicalnot: '¬', fraction: '⁄', florin: 'ƒ', nbspace: '\u00a0',
  acute: '´', circumflex: 'ˆ', tilde: '˜', macron: '¯', breve: '˘',
  dotaccent: '˙', dieresis: '¨', ring: '˚', cedilla: '¸', hungarumlaut: '˝',
  ogonek: '˛', caron: 'ˇ',
  minus: '−', plusminus: '±', multiply: '×', divide: '÷', infinity: '∞',
  partialdiff: '∂', summation: '∑', product: '∏', integral: '∫', radical: '√',
  element: '∈', notelement: '∉', arrowright: '→', arrowleft: '←', arrowup: '↑',
  arrowdown: '↓', arrowboth: '↔', lessequal: '≤', greaterequal: '≥', notequal: '≠',
  approxequal: '≈', equivalence: '≡', prime: '′', second: '″', periodcentered: '·',
  degree: '°', emptyset: '∅', universal: '∀', existential: '∃', gradient: '∇',
  union: '∪', intersection: '∩', proportional: '∝', perpendicular: '⊥',
  // TeX math font glyph names (cmsy / cmmi / cmex)
  asteriskmath: '∗', circlemultiply: '⊗', circleplus: '⊕', circledot: '⊙', similar: '∼', bardbl: '‖',
  angbracketleft: '⟨', angbracketright: '⟩', negationslash: '/', openbullet: '∘', lessmuch: '≪', greatermuch: '≫',
  propersubset: '⊂', propersuperset: '⊃', reflexsubset: '⊆', reflexsuperset: '⊇', logicaland: '∧', logicalor: '∨',
  arrowdblright: '⇒', arrowdblleft: '⇐', arrowdblboth: '⇔', mapsto: '↦', dotmath: '⋅',
  summationtext: '∑', summationdisplay: '∑', integraltext: '∫', integraldisplay: '∫', producttext: '∏', productdisplay: '∏',
  parenleftbig: '(', parenrightbig: ')', parenleftBig: '(', parenrightBig: ')', parenleftbigg: '(', parenrightbigg: ')',
  bracketleftbig: '[', bracketrightbig: ']', braceleftbig: '{', bracerightbig: '}', radicalbig: '√', radicalBig: '√',
  epsilon1: 'ε', rho1: 'ϱ', vector: '⃗', tie: '⁀', dotlessj1: 'ȷ', lscript: 'ℓ', weierstrass: '℘', star: '⋆',
  triangle: '△', triangleinv: '▽', follows: '≻', precedes: '≺', followsequal: '⪰', precedesequal: '⪯',
  minute: '′', mu1: 'µ', sigma1: 'ς', theta1: 'ϑ', phi1: 'ϕ', omega1: 'ϖ',
}

const greek = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega'.split(' ')
const greekLower = 'αβγδεζηθικλμνξοπρστυφχψω'
const greekUpper = 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ'
for (const [index, name] of greek.entries()) {
  glyphs[name] = greekLower[index]
  glyphs[name[0].toUpperCase() + name.slice(1)] = greekUpper[index]
}

const accents: Record<string, string> = {
  hungarumlaut: '\u030b', circumflex: '\u0302', dotaccent: '\u0307',
  dieresis: '\u0308', cedilla: '\u0327', macron: '\u0304', ogonek: '\u0328',
  acute: '\u0301', grave: '\u0300', breve: '\u0306', caron: '\u030c',
  tilde: '\u0303', ring: '\u030a',
}

function unicodeScalar(hex: string): string {
  const code = Number.parseInt(hex, 16)
  return code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
    ? String.fromCodePoint(code) : ''
}

/** Decode common Adobe glyph names and the AGL Unicode naming conventions. */
export function glyphText(name: string): string {
  return name.split('.')[0].split('_').map((part) => {
    if (/^[A-Za-z]$/.test(part)) return part
    if (Object.hasOwn(glyphs, part)) return glyphs[part]
    if (/^uni(?:[0-9A-F]{4})+$/i.test(part)) {
      const scalars = part.slice(3).match(/.{4}/g)!.map(unicodeScalar)
      return scalars.every(Boolean) ? scalars.join('') : ''
    }
    if (/^u[0-9A-F]{4,6}$/i.test(part)) return unicodeScalar(part.slice(1))
    if (/^[A-Za-z][a-z]+$/.test(part) && Object.hasOwn(accents, part.slice(1))) {
      return (part[0] + accents[part.slice(1)]).normalize('NFC')
    }
    return ''
  }).join('')
}

const glyphByText = new Map<string, string>()
for (const [name, value] of Object.entries(glyphs)) {
  if (!glyphByText.has(value)) glyphByText.set(value, name)
}

const standardNames: Record<number, string> = {
  39: 'quoteright', 96: 'quoteleft',
  161: 'exclamdown', 162: 'cent', 163: 'sterling', 164: 'fraction',
  165: 'yen', 166: 'florin', 167: 'section', 168: 'currency',
  169: 'quotesingle', 170: 'quotedblleft', 171: 'guillemotleft',
  172: 'guilsinglleft', 173: 'guilsinglright', 174: 'fi', 175: 'fl',
  177: 'endash', 178: 'dagger', 179: 'daggerdbl', 180: 'periodcentered',
  182: 'paragraph', 183: 'bullet', 184: 'quotesinglbase', 185: 'quotedblbase',
  186: 'quotedblright', 187: 'guillemotright', 188: 'ellipsis',
  189: 'perthousand', 191: 'questiondown', 193: 'grave', 194: 'acute',
  195: 'circumflex', 196: 'tilde', 197: 'macron', 198: 'breve',
  199: 'dotaccent', 200: 'dieresis', 202: 'ring', 203: 'cedilla',
  205: 'hungarumlaut', 206: 'ogonek', 207: 'caron', 208: 'emdash',
  225: 'AE', 227: 'ordfeminine', 232: 'Lslash', 233: 'Oslash', 234: 'OE',
  235: 'ordmasculine', 241: 'ae', 245: 'dotlessi', 248: 'lslash',
  249: 'oslash', 250: 'oe', 251: 'germandbls',
}

const encodingBytes = Uint8Array.from({ length: 256 }, (_, code) => code)
const winAnsi = new TextDecoder('windows-1252').decode(encodingBytes)
const macRoman = new TextDecoder('macintosh').decode(encodingBytes)

/** Return the base encoding's glyph name and text for a simple-font character code. */
export function encodedGlyph(encoding: string, code: number): [string, string] {
  if (encoding === 'WinAnsiEncoding' || encoding === 'MacRomanEncoding') {
    const table = encoding === 'WinAnsiEncoding' ? winAnsi : macRoman
    let text = code >= 32 && code !== 127 ? table[code] : ''
    if (table === winAnsi) {
      if ([127, 129, 141, 143, 144, 157].includes(code)) text = '•'
      if (code === 160) text = ' '
      if (code === 173) text = '-'
    }
    return [glyphByText.get(text) ?? text, text]
  }
  const name = standardNames[code]
  if (name) return [name, glyphText(name)]
  const text = code >= 32 && code <= 126 ? String.fromCharCode(code) : ''
  return [glyphByText.get(text) ?? text, text]
}

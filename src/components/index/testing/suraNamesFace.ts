/**
 * The sura-names decor face for browser tests: the real one from `data/dev-packs` (`pnpm dev-packs`) when it is there
 * and is the file the catalog pins, else a stand-in built here. The decor fonts are never committed and CI never
 * fetches them, so the stand-in is what CI draws: a TrueType font with one rectangle per surah at
 * the real face's code point, with its advance and the horizontal extent of its ink (`SURA_NAMES_INK`), so whatever
 * aligns the names by their ink meets the same geometry as with the real face.
 */
import { SURA_NAMES_INK, SURA_NAMES_SHA256, SURA_NAMES_UPM, suraNameGlyph } from '$lib/mushaf/suraNames'

/** The real face's vertical metrics (hhea and OS/2), and a box roughly as tall as its names. */
const ASCENT = 840
const DESCENT = 183
const INK_Y = [-70, 720] as const

export interface SuraNamesFace {
  bytes: ArrayBuffer
  /** The real face, not the stand-in. */
  real: boolean
  /** Why the stand-in is used. */
  reason?: string
}

/** The real face when `data/dev-packs` has the pinned file, else the stand-in (with the reason). */
export async function suraNamesFace(): Promise<SuraNamesFace> {
  const path = '/data/dev-packs/decor/sura-names.woff2'
  let reason: string
  try {
    const res = await fetch(path)
    const bytes = await res.arrayBuffer()
    const magic = String.fromCharCode(...new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength)))
    if (res.ok && magic === 'wOF2') {
      const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
      if (sha === SURA_NAMES_SHA256) return { bytes, real: true }
      reason = `${path} is not the file the catalog pins (sha256 ${sha})`
    } else {
      reason = `${path} is not there (pnpm dev-packs; CI never has it)`
    }
  } catch (e) {
    reason = `${path} could not be read: ${String(e)}`
  }
  return { bytes: suraNamesStandIn(), real: false, reason }
}

/** The stand-in TrueType font (module docs): glyph n is a rectangle over the real glyph's ink, with its advance. */
export function suraNamesStandIn(): ArrayBuffer {
  const glyphs = SURA_NAMES_INK.map(([advance, xMin, xMax], i) => ({
    cp: suraNameGlyph(i + 1).codePointAt(0) ?? 0,
    advance,
    xMin,
    xMax,
  }))
  const numGlyphs = glyphs.length + 1
  const [yMin, yMax] = INK_Y

  // glyf + loca (long offsets): glyph 0 (.notdef) is empty; each other glyph is one closed contour of four points.
  const glyf = new Writer()
  const loca = new Writer()
  loca.u32(0)
  loca.u32(0)
  for (const g of glyphs) {
    glyf.i16(1).i16(g.xMin).i16(yMin).i16(g.xMax).i16(yMax)
    glyf.u16(3).u16(0) // endPtsOfContours[0], instructionLength
    for (let i = 0; i < 4; i++) glyf.u8(0x01) // on-curve; coordinates as int16 deltas
    // Clockwise: (xMin, yMin) → (xMin, yMax) → (xMax, yMax) → (xMax, yMin).
    glyf
      .i16(g.xMin)
      .i16(0)
      .i16(g.xMax - g.xMin)
      .i16(0)
    glyf
      .i16(yMin)
      .i16(yMax - yMin)
      .i16(0)
      .i16(yMin - yMax)
    glyf.pad()
    loca.u32(glyf.length)
  }

  const hmtx = new Writer().u16(SURA_NAMES_UPM / 2).i16(0)
  for (const g of glyphs) hmtx.u16(g.advance).i16(g.xMin)

  const xMin = Math.min(...glyphs.map((g) => g.xMin))
  const xMax = Math.max(...glyphs.map((g) => g.xMax))
  const head = new Writer()
    .u16(1)
    .u16(0)
    .u32(0x00010000) // fontRevision
    .u32(0) // checkSumAdjustment, set below
    .u32(0x5f0f3cf5)
    .u16(0x0001) // baseline at y = 0
    .u16(SURA_NAMES_UPM)
    .u32(0)
    .u32(0) // created
    .u32(0)
    .u32(0) // modified
    .i16(xMin)
    .i16(yMin)
    .i16(xMax)
    .i16(yMax)
    .u16(0) // macStyle
    .u16(8) // lowestRecPPEM
    .i16(2) // fontDirectionHint
    .i16(1) // indexToLocFormat: long
    .i16(0)

  const hhea = new Writer()
    .u16(1)
    .u16(0)
    .i16(ASCENT)
    .i16(-DESCENT)
    .i16(0)
    .u16(Math.max(...glyphs.map((g) => g.advance)))
    .i16(Math.min(...glyphs.map((g) => g.xMin)))
    .i16(Math.min(...glyphs.map((g) => g.advance - g.xMax)))
    .i16(xMax)
    .i16(1) // caretSlopeRise
    .i16(0)
    .i16(0)
    .i16(0)
    .i16(0)
    .i16(0)
    .i16(0)
    .i16(0) // metricDataFormat
    .u16(numGlyphs) // numberOfHMetrics

  const maxp = new Writer().u32(0x00010000).u16(numGlyphs).u16(4).u16(1).u16(0).u16(0).u16(2)
  for (let i = 0; i < 8; i++) maxp.u16(0)

  const os2 = new Writer()
    .u16(4)
    .i16(Math.round(glyphs.reduce((s, g) => s + g.advance, 0) / glyphs.length))
    .u16(400)
    .u16(5)
    .u16(0) // fsType: installable
  for (let i = 0; i < 10; i++) os2.i16(0) // sub/superscript and strikeout metrics
  os2.i16(0) // sFamilyClass
  for (let i = 0; i < 10; i++) os2.u8(0) // panose
  os2
    .u32(0)
    .u32(1 << 28)
    .u32(0)
    .u32(0) // ulUnicodeRange: bit 60, Private Use Area
  os2.u8(0x51).u8(0x44).u8(0x54).u8(0x53) // achVendID "QDTS"
  os2.u16(0x0040) // fsSelection: REGULAR
  os2.u16(glyphs[0]?.cp ?? 0).u16(glyphs.at(-1)?.cp ?? 0)
  os2.i16(ASCENT).i16(-DESCENT).i16(0).u16(ASCENT).u16(DESCENT)
  os2.u32(1).u32(0) // ulCodePageRange
  os2.i16(0).i16(0).u16(0).u16(0x20).u16(1) // sxHeight, sCapHeight, usDefaultChar, usBreakChar, usMaxContext

  // cmap: one format 4 subtable (Windows, Unicode BMP); a segment per run of consecutive code points.
  const segments: { start: number; end: number; glyph: number }[] = []
  glyphs.forEach((g, i) => {
    const last = segments.at(-1)
    if (last && last.end + 1 === g.cp) last.end = g.cp
    else segments.push({ start: g.cp, end: g.cp, glyph: i + 1 })
  })
  segments.push({ start: 0xffff, end: 0xffff, glyph: 0 })
  const segCount = segments.length
  const searchRange = 2 ** (Math.floor(Math.log2(segCount)) + 1)
  const sub = new Writer()
    .u16(4)
    .u16(16 + 8 * segCount)
    .u16(0)
    .u16(segCount * 2)
    .u16(searchRange)
    .u16(Math.log2(searchRange / 2))
    .u16(segCount * 2 - searchRange)
  for (const s of segments) sub.u16(s.end)
  sub.u16(0)
  for (const s of segments) sub.u16(s.start)
  for (const s of segments) sub.u16(s.start === 0xffff ? 1 : (s.glyph - s.start) & 0xffff)
  for (let i = 0; i < segCount; i++) sub.u16(0)
  const cmap = new Writer().u16(0).u16(1).u16(3).u16(1).u32(12).bytes(sub.done())

  const names = ['QD Sura Names Stand-in', 'Regular', 'QD Sura Names Stand-in', 'QD Sura Names Stand-in']
  names.push('Version 1.0', 'QDSuraNamesStandIn-Regular')
  const name = new Writer()
    .u16(0)
    .u16(names.length)
    .u16(6 + 12 * names.length)
  const strings = new Writer()
  names.forEach((text, i) => {
    const offset = strings.length
    for (const ch of text) strings.u16(ch.charCodeAt(0))
    name
      .u16(3)
      .u16(1)
      .u16(0x0409)
      .u16(i + 1)
      .u16(strings.length - offset)
      .u16(offset)
  })
  name.bytes(strings.done())

  const post = new Writer().u32(0x00030000).u32(0).i16(-100).i16(50)
  for (let i = 0; i < 5; i++) post.u32(0)

  return sfnt([
    ['OS/2', os2],
    ['cmap', cmap],
    ['glyf', glyf],
    ['head', head],
    ['hhea', hhea],
    ['hmtx', hmtx],
    ['loca', loca],
    ['maxp', maxp],
    ['name', name],
    ['post', post],
  ])
}

/** The font file: the table directory, then each table padded to 4 bytes, with checksums and `checkSumAdjustment`. */
function sfnt(tables: [string, Writer][]): ArrayBuffer {
  const count = tables.length
  const searchRange = 2 ** Math.floor(Math.log2(count)) * 16
  const out = new Writer()
    .u32(0x00010000)
    .u16(count)
    .u16(searchRange)
    .u16(Math.log2(searchRange / 16))
    .u16(count * 16 - searchRange)
  let offset = 12 + 16 * count
  const bodies = tables.map(([tag, w]) => {
    const data = w.done()
    const record = { tag, data, offset, sum: checksum(data) }
    offset += Math.ceil(data.length / 4) * 4
    return record
  })
  for (const t of bodies) {
    for (const ch of t.tag) out.u8(ch.charCodeAt(0))
    out.u32(t.sum).u32(t.offset).u32(t.data.length)
  }
  for (const t of bodies) out.bytes(t.data).pad()
  const file = out.done()
  const head = bodies.find((t) => t.tag === 'head')
  if (head) new DataView(file.buffer).setUint32(head.offset + 8, (0xb1b0afba - checksum(file)) >>> 0)
  return file.buffer
}

function checksum(data: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < data.length; i += 4) {
    const word =
      ((data[i] ?? 0) << 24) | ((data[i + 1] ?? 0) << 16) | ((data[i + 2] ?? 0) << 8) | (data[i + 3] ?? 0)
    sum = (sum + (word >>> 0)) >>> 0
  }
  return sum
}

/** A big-endian byte writer. */
class Writer {
  #bytes: number[] = []

  get length(): number {
    return this.#bytes.length
  }

  u8(v: number): this {
    this.#bytes.push(v & 0xff)
    return this
  }

  u16(v: number): this {
    return this.u8(v >> 8).u8(v)
  }

  i16(v: number): this {
    return this.u16(v & 0xffff)
  }

  u32(v: number): this {
    return this.u16(v >>> 16).u16(v & 0xffff)
  }

  bytes(data: Uint8Array): this {
    for (const b of data) this.#bytes.push(b)
    return this
  }

  /** Zeros up to the next multiple of 4. */
  pad(): this {
    while (this.#bytes.length % 4 !== 0) this.#bytes.push(0)
    return this
  }

  done(): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(this.#bytes)
  }
}

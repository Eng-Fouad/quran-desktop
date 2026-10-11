/**
 * `printLabels.ts` (§8.9; LEAD 25): the code points of the bundled print-labels face, the kinds of margin label, the
 * one-line quarter, the head's placement, and the metrics table checked against the committed font itself (its cmap
 * and its vertical metrics, read here with a minimal OpenType reader).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HEAD } from './geometry'
import { arabicNum } from './ornaments'
import {
  PRINT_CP,
  PRINT_EM,
  PRINT_HEAD_BASELINE,
  PRINT_LABELS_FAMILY,
  PRINT_METRICS,
  PRINT_WORD,
  PRINT_WORD_GAP,
  printFontSize,
  printHeadDrop,
  printJuzHead,
  printLabelInk,
  printMarginKind,
  printQuarterLine,
  printRubLabel,
  printSurahHead,
} from './printLabels'

/** The committed font's cmap (format 4, Windows Unicode BMP) and its hhea ascender/descender. */
function readFont(): { cmap: Set<number>; ascent: number; descent: number; unitsPerEm: number } {
  const buf = readFileSync(resolve(process.cwd(), 'public/fonts/QuranPrintLabels.otf'))
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const tables = new Map<string, number>()
  for (let i = 0, n = view.getUint16(4); i < n; i++) {
    const rec = 12 + 16 * i
    tables.set(buf.toString('latin1', rec, rec + 4), view.getUint32(rec + 8))
  }
  const table = (tag: string): number => {
    const offset = tables.get(tag)
    if (offset === undefined) throw new Error(`no ${tag} table`)
    return offset
  }
  const cmap = table('cmap')
  let sub = -1
  for (let i = 0, n = view.getUint16(cmap + 2); i < n; i++) {
    const rec = cmap + 4 + 8 * i
    const offset = cmap + view.getUint32(rec + 4)
    if (view.getUint16(rec) === 3 && view.getUint16(rec + 2) === 1 && view.getUint16(offset) === 4)
      sub = offset
  }
  if (sub < 0) throw new Error('no format 4 cmap')
  const segX2 = view.getUint16(sub + 6)
  const ends = sub + 14
  const starts = ends + segX2 + 2
  const deltas = starts + segX2
  const ranges = deltas + segX2
  const codes = new Set<number>()
  for (let s = 0; s < segX2 / 2; s++) {
    const end = view.getUint16(ends + 2 * s)
    const start = view.getUint16(starts + 2 * s)
    const delta = view.getInt16(deltas + 2 * s)
    const rangeOffset = view.getUint16(ranges + 2 * s)
    for (let c = start; c <= end && c !== 0xffff; c++) {
      const glyph =
        rangeOffset === 0
          ? (c + delta) & 0xffff
          : view.getUint16(ranges + 2 * s + rangeOffset + 2 * (c - start))
      if (glyph !== 0) codes.add(c)
    }
  }
  const hhea = table('hhea')
  return {
    cmap: codes,
    ascent: view.getInt16(hhea + 4),
    descent: -view.getInt16(hhea + 6),
    unitsPerEm: view.getUint16(table('head') + 18),
  }
}

describe('the print-labels face (LEAD 25)', () => {
  const font = readFont()

  it('has a glyph for every code point the furniture asks for', () => {
    const cp = (s: string | null) => s?.codePointAt(0) ?? -1
    for (let n = 2; n <= 114; n++) expect(font.cmap.has(cp(printSurahHead(n))), `surah ${n}`).toBe(true)
    for (let j = 1; j <= 30; j++) expect(font.cmap.has(cp(printJuzHead(j))), `juz ${j}`).toBe(true)
    for (let r = 1; r <= 240; r++) expect(font.cmap.has(cp(printRubLabel(r))), `rub ${r}`).toBe(true)
    for (const word of Object.values(PRINT_WORD)) expect(font.cmap.has(cp(word))).toBe(true)
    for (let d = 0; d <= 9; d++) expect(font.cmap.has(PRINT_CP.digit0 + d)).toBe(true)
    // The kinds of glyph add up to the generator's counts.
    expect(PRINT_METRICS.surah.count + PRINT_METRICS.juz.count).toBe(113 + 30)
    const margin = ['marginJuz', 'marginHizb', 'marginQuarter1', 'marginQuarter2', 'marginQuarter3'] as const
    expect(margin.reduce((sum, k) => sum + PRINT_METRICS[k].count, 0)).toBe(240)
  })

  it('carries the metrics the table was generated from', () => {
    expect(font.unitsPerEm).toBe(PRINT_METRICS.unitsPerEm)
    expect(font.ascent).toBe(PRINT_METRICS.ascent)
    expect(font.descent).toBe(PRINT_METRICS.descent)
    expect(PRINT_LABELS_FAMILY).toBe('qd-print-labels')
  })
})

describe('code points (LEAD 25)', () => {
  it('maps a surah, a juz and a rub to their glyphs, and nothing else', () => {
    expect(printSurahHead(15)?.codePointAt(0)).toBe(0xf60f)
    expect(printSurahHead(114)?.codePointAt(0)).toBe(0xf672)
    expect(printJuzHead(14)?.codePointAt(0)).toBe(0xf70e)
    expect(printRubLabel(105)?.codePointAt(0)).toBe(0xf869)
    expect(printRubLabel(240)?.codePointAt(0)).toBe(0xf8f0)
    // Surah 1's pages carry no running head; out of range or not an integer: no glyph.
    for (const n of [1, 0, 115, 2.5, Number.NaN]) expect(printSurahHead(n)).toBeNull()
    for (const n of [0, 31, 1.5]) expect(printJuzHead(n)).toBeNull()
    for (const n of [0, 241, -3]) expect(printRubLabel(n)).toBeNull()
    expect(printLabelInk(0)).toBeNull()
  })

  it('tells the stacked layout of a rub’s label from its number', () => {
    expect([1, 9, 105, 233].map(printMarginKind)).toEqual([
      'marginJuz',
      'marginJuz',
      'marginJuz',
      'marginJuz',
    ])
    expect([5, 13, 109, 237].map(printMarginKind)).toEqual([
      'marginHizb',
      'marginHizb',
      'marginHizb',
      'marginHizb',
    ])
    expect([106, 107, 108].map(printMarginKind)).toEqual([
      'marginQuarter1',
      'marginQuarter2',
      'marginQuarter3',
    ])
  })

  it('composes the head’s quarter in reading order: fraction word, «الحِزۡبُ», the print digits', () => {
    expect(printQuarterLine(108, 27)).toEqual([PRINT_WORD.thalatha, PRINT_WORD.hizb, '٢٧'])
    expect(printQuarterLine(106, 27)).toEqual([PRINT_WORD.rub, PRINT_WORD.hizb, '٢٧'])
    expect(printQuarterLine(239, 60)).toEqual([PRINT_WORD.nisf, PRINT_WORD.hizb, '٦٠'])
    // A hizb start (and a juz start) names the hizb alone; multi-digit numbers keep their order.
    expect(printQuarterLine(105, 27)).toEqual([PRINT_WORD.hizb, '٢٧'])
    expect(printQuarterLine(9, 3)).toEqual([PRINT_WORD.hizb, '٣'])
    // The digits are the same code points as the Hafs fallback's (the face draws them in the print's hand).
    for (const h of [1, 9, 10, 27, 53, 60]) expect(printQuarterLine(4 * h - 2, h).at(-1)).toBe(arabicNum(h))
    expect(PRINT_WORD_GAP).toBeCloseTo(0.037)
  })
})

describe('sizes (LEAD 25)', () => {
  it('sets the face at the print’s proportion: 1 em is 25 source units, its 243.2-unit line is TB_W', () => {
    expect(PRINT_EM).toBeCloseTo(25 / (243.2 / 16.5), 1)
    expect(printFontSize(30)).toBeCloseTo(51)
  })

  it('keeps every head glyph inside the HEAD band, clear of the frame', () => {
    for (const qfs of [20, 24, 30, 60, 160]) {
      const fs = printFontSize(qfs)
      const em = PRINT_METRICS.unitsPerEm
      const box = { bottom: 0, top: HEAD * qfs }
      // The baseline above the band's bottom, from the `line-height: normal` box standing on it and the drop.
      const baseline = (PRINT_METRICS.descent / em) * fs
      expect(baseline - printHeadDrop(qfs)).toBeCloseTo(PRINT_HEAD_BASELINE * qfs)
      for (const kind of ['surah', 'juz'] as const) {
        const { yMin, yMax } = PRINT_METRICS[kind]
        const inkBottom = PRINT_HEAD_BASELINE * qfs + (yMin / em) * fs
        const inkTop = PRINT_HEAD_BASELINE * qfs + (yMax / em) * fs
        expect(inkBottom, `${kind} at qfs ${qfs}`).toBeGreaterThan(box.bottom)
        expect(inkTop, `${kind} at qfs ${qfs}`).toBeLessThan(box.top)
      }
    }
  })

  it('gives a margin label the extent of its kind, centred by the face’s metrics', () => {
    const ink = printLabelInk(106)
    expect(ink).toMatchObject({ family: 'qd-print-labels', ascent: 0.615, descent: 0.384 })
    expect(ink?.top).toBeCloseTo(PRINT_METRICS.marginQuarter1.yMax / 1000)
    expect(ink?.bottom).toBeCloseTo(-PRINT_METRICS.marginQuarter1.yMin / 1000)
    expect(ink?.size).toBeCloseTo(PRINT_EM * ((ink?.top ?? 0) + (ink?.bottom ?? 0)))
    // Every label is narrower than the outer margin (1.9·qfs) at the print's size.
    for (const kind of [
      'marginJuz',
      'marginHizb',
      'marginQuarter1',
      'marginQuarter2',
      'marginQuarter3',
    ] as const)
      expect((PRINT_METRICS[kind].advance / 1000) * PRINT_EM, kind).toBeLessThan(1.9)
  })
})

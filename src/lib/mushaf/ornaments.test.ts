/**
 * `ornaments.ts` (WP8c; §8.8, §8.9): the ornament geometry (khatam, rosette, band tile, frame, opening medallion,
 * cartouche, footer), the margin model (markers, labels, stacking, marks), the ribbon, the page-stack edges and the
 * note preview. Self-contained: the pages are built here, so the tests need no exported fixtures.
 */
import { describe, expect, it } from 'vitest'
import type { PageAyah, PageData, PageLine } from '$lib/ipc/bindings'
import { BLOCK_TOP, FR, LH, M_IN, M_OUT, M_TB, HEAD, OPENING_TOP_LINES, PH, PW, TB_H, TB_W } from './geometry'
import {
  arabicNum,
  BAND_TILE,
  bandTile,
  cartouche,
  CARTOUCHE_INSETS,
  CARTOUCHE_MEDALLION,
  decorJuzGlyph,
  decorStroke,
  DECOR_HIZB,
  DECOR_QUARTER,
  firstRubStart,
  fitTiles,
  footerMedallion,
  frameBoxQ,
  frameGeometry,
  INK,
  inkHeight,
  inkShift,
  insetBox,
  INSET_TEXT,
  isDecorInk,
  khatam,
  LABEL_LEADING,
  labelSize,
  lineCenterY,
  marginLabelsVisible,
  MARKER_INK,
  MARKER_INK_MIN_PX,
  markerBoxHeight,
  markerDrawn,
  markerGlyphBox,
  markerHeight,
  markerInk,
  markerInset,
  MEDALLION_APEX,
  MEDALLION_HALF_W,
  medallionGeometry,
  notePreview,
  ogeeBand,
  pageMarkers,
  pageMarks,
  placeMarkers,
  placeMarks,
  reverseCubics,
  ribbonGeometry,
  ribbonPath,
  rosette,
  round2,
  rubKind,
  rubLabel,
  rubQuarter,
  rubShortLabel,
  RUB_SIGN,
  sajdaLabel,
  SAJDA_SIGN,
  stackCentered,
  stackEdgeCount,
  stackFrom,
  STACK_GAP,
  type Cubic,
  type MarginMarker,
} from './ornaments'

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

/** Every number in a path, as [x, y] pairs (the path builders only emit absolute coordinate pairs, and arc params). */
function numbers(d: string): number[] {
  return [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]))
}

/** The vertices of the M/L/H/V polylines of a path (no curves), per subpath. */
function polylines(d: string): [number, number][][] {
  const out: [number, number][][] = []
  let x = 0
  let y = 0
  for (const [, cmd, args] of d.matchAll(/([MLHVZ])([^MLHVZ]*)/g)) {
    const n = numbers(args ?? '')
    if (cmd === 'M') {
      x = n[0] ?? 0
      y = n[1] ?? 0
      out.push([[x, y]])
    } else if (cmd === 'L') {
      x = n[0] ?? 0
      y = n[1] ?? 0
      out.at(-1)?.push([x, y])
    } else if (cmd === 'H') {
      x = n[0] ?? 0
      out.at(-1)?.push([x, y])
    } else if (cmd === 'V') {
      y = n[0] ?? 0
      out.at(-1)?.push([x, y])
    }
  }
  return out
}

const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0))

/** The end points of the curve commands of a path (`C … x y`, `Q … x y`), with the start point. */
function curvePoints(d: string): [number, number][] {
  const pts: [number, number][] = []
  const start = /^M(-?[\d.]+) (-?[\d.]+)/.exec(d)
  if (start) pts.push([Number(start[1]), Number(start[2])])
  for (const m of d.matchAll(/[CQS]([^CQSMLHVZA]*)/g)) {
    const n = numbers(m[1] ?? '')
    pts.push([n.at(-2) ?? 0, n.at(-1) ?? 0])
  }
  return pts
}

function ayah(partial: Partial<PageAyah> & Pick<PageAyah, 'id' | 'line'>): PageAyah {
  return {
    surah: 15,
    ayah: partial.id - 1802,
    juz: 14,
    hizb: 27,
    rub: 105,
    sajda: null,
    flags: 0,
    firstWordId: partial.id * 10,
    lastWordId: partial.id * 10 + 5,
    startsOnPage: true,
    endsOnPage: true,
    ...partial,
  }
}

/** A page whose line `l` holds words `l*100 … l*100 + 9` (enough for `lastLineOf`). */
function page(
  n: number,
  ayahs: PageAyah[],
  lineCount = 15,
): Pick<PageData, 'page' | 'ayahs' | 'lines'> & PageData {
  const lines: PageLine[] = Array.from({ length: lineCount }, (_, i) => ({
    line: i + 1,
    kind: 'ayah',
    centered: false,
    surah: null,
    words: Array.from({ length: 10 }, (_, w) => ({
      id: (i + 1) * 100 + w,
      ayahId: 0,
      surah: 0,
      ayah: 0,
      position: w + 1,
      isEnd: false,
      glyph: '',
      text: '',
    })),
  }))
  return {
    layout: 'v2',
    style: 'hafs',
    page: n,
    lines,
    ayahs,
    info: {
      firstAyahId: ayahs[0]?.id ?? 1,
      lastAyahId: ayahs.at(-1)?.id ?? 1,
      juz: 14,
      hizb: 27,
      headSurah: 15,
      surahIds: [15],
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------------

describe('path primitives', () => {
  it('round2 keeps two decimals and never prints -0', () => {
    expect(round2(1.23456)).toBe(1.23)
    expect(round2(-0.001)).toBe(0)
    expect(Object.is(round2(-0.004), -0)).toBe(false)
  })

  it('khatam: two closed squares at 45° with every vertex on the radius', () => {
    const d = khatam(50, 40, 20)
    const squares = polylines(d)
    expect(squares).toHaveLength(2)
    expect(d.match(/Z/g)).toHaveLength(2)
    for (const square of squares) {
      expect(square).toHaveLength(4)
      for (const v of square) expect(dist(v, [50, 40])).toBeCloseTo(20, 1)
    }
    // The first square is axis-aligned, the second a diamond.
    expect(squares[0]?.[0]?.[0]).not.toBe(50)
    expect(squares[1]?.[0]).toEqual([50, 20])
  })

  it('rosette: lobes crest exactly on the radius, valleys on radius × depth', () => {
    const d = rosette(0, 0, 10, 12, 0.8)
    expect(d.match(/Q/g)).toHaveLength(12)
    const ends = curvePoints(d)
    for (const p of ends) expect(Math.hypot(p[0], p[1])).toBeCloseTo(8, 1)
    // A quadratic's midpoint (P0 + 2C + P1) / 4 is the crest.
    const segs = [...d.matchAll(/Q(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/g)]
    let prev = ends[0] ?? [0, 0]
    for (const s of segs) {
      const c = [Number(s[1]), Number(s[2])]
      const p1 = [Number(s[3]), Number(s[4])]
      const mid = [
        (prev[0] + 2 * (c[0] ?? 0) + (p1[0] ?? 0)) / 4,
        (prev[1] + 2 * (c[1] ?? 0) + (p1[1] ?? 0)) / 4,
      ]
      expect(Math.hypot(mid[0] ?? 0, mid[1] ?? 0)).toBeCloseTo(10, 0)
      prev = [p1[0] ?? 0, p1[1] ?? 0]
    }
  })

  it('bandTile: four half-ellipses, one per edge, meeting at the tile centre', () => {
    const d = bandTile(10, 8)
    expect(d.match(/A/g)).toHaveLength(4)
    expect(d).toContain('A5 4 0 0 0 10 0')
    expect(d).toContain('M0 8A5 4 0 0 1 10 8')
  })

  it('fitTiles splits a length into whole tiles close to the nominal size', () => {
    expect(fitTiles(16.5, 0.32)).toEqual({ count: 52, size: 16.5 / 52 })
    expect(fitTiles(26.25, 0.32).count).toBe(82)
    expect(fitTiles(0, 0.32).count).toBe(0)
    expect(fitTiles(0.1, 0.32).count).toBe(1)
  })

  it('reverseCubics runs a curve backwards', () => {
    const run: Cubic[] = [
      [
        [0, 0],
        [1, 0],
        [2, 1],
        [3, 3],
      ],
      [
        [3, 3],
        [4, 5],
        [5, 5],
        [6, 6],
      ],
    ]
    const back = reverseCubics(run)
    expect(back[0]?.[0]).toEqual([6, 6])
    expect(back.at(-1)?.[3]).toEqual([0, 0])
  })
})

describe('frameGeometry (§8.9)', () => {
  const q = 24

  it('places the frame box around the block, against the outer margin of each side', () => {
    expect(frameBoxQ('right')).toEqual({ x: M_IN, y: M_TB + HEAD, w: TB_W + 2 * FR, h: TB_H + 2 * FR })
    expect(frameBoxQ('left').x).toBe(M_OUT)
    const right = frameGeometry(q, 'right')
    expect(right.width).toBeCloseTo(PW * q)
    expect(right.height).toBeCloseTo(PH * q)
    expect(right.box.x).toBeCloseTo(M_IN * q)
    expect(right.box.x + right.box.w).toBeCloseTo((PW - M_OUT) * q)
    const left = frameGeometry(q, 'left')
    expect(left.box.x).toBeCloseTo(M_OUT * q)
    // The frame band ends exactly FR outside the block: block top = M_TB + HEAD + FR.
    expect(right.box.y + FR * q).toBeCloseTo(BLOCK_TOP * q)
  })

  it('draws the outer rule at 0.09·qfs on its centre line and the inner rule at max(1px, 0.04·qfs)', () => {
    const g = frameGeometry(q, 'right')
    expect(g.outerStroke).toBeCloseTo(0.09 * q)
    expect(g.outerRule.x).toBeCloseTo(g.box.x + g.outerStroke / 2)
    expect(g.outerRule.w).toBeCloseTo(g.box.w - g.outerStroke)
    expect(g.innerStroke).toBeCloseTo(Math.max(1, 0.04 * q))
    expect(frameGeometry(18, 'right').innerStroke).toBe(1)
    expect(g.innerRule.match(/M/g)).toHaveLength(4)
  })

  it('fills the 0.32·qfs bands between the corner blocks with whole tiles', () => {
    const g = frameGeometry(q, 'right')
    const { top, right } = g.bands
    expect(top.h).toBeCloseTo(BAND_TILE * q)
    expect(top.w).toBeCloseTo(TB_W * q)
    expect(right.h).toBeCloseTo(TB_H * q)
    expect(top.w / top.tile.w).toBeCloseTo(Math.round(top.w / top.tile.w), 6)
    expect(right.h / right.tile.h).toBeCloseTo(Math.round(right.h / right.tile.h), 6)
    expect(Math.abs(top.tile.w / (BAND_TILE * q) - 1)).toBeLessThan(0.02)
    expect(top.y).toBeCloseTo(g.box.y + g.outerStroke)
    expect(g.bands.bottom.y + g.bands.bottom.h).toBeCloseTo(g.box.y + g.box.h - g.outerStroke)
  })

  it('puts a khatam in each 0.85·qfs corner block', () => {
    const g = frameGeometry(q, 'left')
    expect(g.stars.match(/M/g)).toHaveLength(8)
    const squares = polylines(g.stars)
    const centre = (s: [number, number][]) => [
      s.reduce((a, p) => a + p[0], 0) / s.length,
      s.reduce((a, p) => a + p[1], 0) / s.length,
    ]
    const half = (FR * q) / 2
    expect(centre(squares[0] ?? [])[0]).toBeCloseTo(g.box.x + half, 1)
    expect(centre(squares[0] ?? [])[1]).toBeCloseTo(g.box.y + half, 1)
    expect(g.corners.match(/M/g)).toHaveLength(4)
  })

  it('is memoised per (qfs, side, opening) and adds the medallion only on the opening pages', () => {
    expect(frameGeometry(q, 'right')).toBe(frameGeometry(q, 'right'))
    expect(frameGeometry(q, 'right')).not.toBe(frameGeometry(q, 'left'))
    expect(frameGeometry(q, 'right').medallion).toBeNull()
    expect(frameGeometry(q, 'right', true).medallion).not.toBeNull()
  })

  it('degrades to an empty frame for a non-finite qfs instead of producing NaN', () => {
    const g = frameGeometry(Number.NaN, 'right')
    expect(g.width).toBe(0)
    expect(g.innerRule).not.toContain('NaN')
  })
})

describe('medallionGeometry (§8.9, pages 1–2)', () => {
  const q = 20
  const m = medallionGeometry(q, 'right')
  const blockX = (PW - M_OUT - FR - TB_W) * q
  const cx = blockX + (TB_W / 2) * q
  const cy = (BLOCK_TOP + TB_H / 2) * q

  it('is a closed ogee-arched outline, symmetric about the block centre, around the 8 lines', () => {
    expect(m.outline.startsWith('M')).toBe(true)
    expect(m.outline.endsWith('Z')).toBe(true)
    const pts = curvePoints(m.outline)
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(2 * cx, 0)
    expect(Math.min(...ys) + Math.max(...ys)).toBeCloseTo(2 * cy, 0)
    expect(Math.max(...xs) - cx).toBeCloseTo(MEDALLION_HALF_W * q, 0)
    expect(cy - Math.min(...ys)).toBeCloseTo(MEDALLION_APEX * q, 0)
    // The 8 opening lines (3.5 lines down, 2.2 qfs inset) fit inside the straight sides.
    const linesTop = (BLOCK_TOP + OPENING_TOP_LINES * LH) * q
    const linesBottom = linesTop + 8 * LH * q
    expect(cy - Math.min(...ys)).toBeGreaterThan(cy - linesTop)
    expect(Math.max(...ys) - cy).toBeGreaterThan(linesBottom - cy)
    expect(MEDALLION_HALF_W).toBeGreaterThan(TB_W / 2 - 2.2)
  })

  it('carries 12 rosettes on the outline: apex, five per side, foot', () => {
    expect(m.rosettes).toHaveLength(12)
    expect(m.rosettes[0]?.cx).toBeCloseTo(cx)
    expect(m.rosettes[0]?.cy).toBeCloseTo(cy - MEDALLION_APEX * q)
    expect(m.rosettes[6]?.cy).toBeCloseTo(cy + MEDALLION_APEX * q)
    expect(m.rosettePaths.match(/M/g)).toHaveLength(12)
    expect(m.rosetteStars.match(/M/g)).toHaveLength(24)
  })

  it('cuts the medallion out of the spandrels (evenodd: the frame inside, then the outline)', () => {
    expect(m.spandrels.startsWith('M')).toBe(true)
    expect(m.spandrels.endsWith(m.outline)).toBe(true)
    expect(m.inner).not.toBe(m.outline)
  })

  it('mirrors with the page side', () => {
    const left = medallionGeometry(q, 'left')
    const lx = (M_OUT + FR + TB_W / 2) * q
    expect(left.rosettes[0]?.cx).toBeCloseTo(lx)
  })
})

describe('cartouche (§8.8 fallback)', () => {
  it('is 1650 × 155 on an ordinary line and 1210 wide on the opening lines', () => {
    expect(cartouche(TB_W).viewBox).toBe('0 0 1650 155')
    expect(cartouche(12.1).viewBox).toBe('0 0 1210 155')
    expect(cartouche(TB_W)).toBe(cartouche(16.5))
  })

  it('nests three strokes (0.06 / 0.02 / 0.02·qfs) inside the box', () => {
    const g = cartouche(TB_W)
    expect(g.outlines.map((o) => o.stroke)).toEqual([6, 2, 2])
    for (const [i, o] of g.outlines.entries()) {
      const pts = curvePoints(o.d)
      const inset = (CARTOUCHE_INSETS[i] ?? 0) * 100
      for (const [x, y] of pts) {
        expect(x).toBeGreaterThanOrEqual(inset - 0.01)
        expect(x).toBeLessThanOrEqual(g.width - inset + 0.01)
        expect(y).toBeGreaterThanOrEqual(inset - 0.01)
        expect(y).toBeLessThanOrEqual(g.height - inset + 0.01)
      }
    }
  })

  it('has two 1.1·qfs end medallions on the centre line and the name box between them', () => {
    const g = cartouche(TB_W)
    expect(g.medallions).toHaveLength(2)
    for (const m of g.medallions) {
      expect(m.r * 2).toBeCloseTo(CARTOUCHE_MEDALLION * 100)
      expect(m.cy).toBeCloseTo(77.5)
    }
    expect((g.medallions[0]?.cx ?? 0) + (g.medallions[1]?.cx ?? 0)).toBeCloseTo(1650)
    expect(g.text.x).toBeGreaterThan((g.medallions[0]?.cx ?? 0) + (g.medallions[0]?.r ?? 0))
    expect(g.text.x + g.text.w).toBeLessThan((g.medallions[1]?.cx ?? 0) - (g.medallions[1]?.r ?? 0))
    expect(g.stars.match(/M/g)).toHaveLength(4)
  })

  it('ogeeBand: pointed tips on the centre line at both ends, mirror-symmetric', () => {
    const d = ogeeBand(1000, 155, 5)
    const pts = curvePoints(d)
    const xs = pts.map((p) => p[0])
    expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(1000, 0)
    expect(pts[0]?.[1]).toBeCloseTo(77.5)
    expect(d.match(/H/g)).toHaveLength(2)
  })
})

describe('footerMedallion (§8.9)', () => {
  it('is 1.1·qfs with the ring and the disc inside the box', () => {
    const m = footerMedallion(20)
    expect(m.size).toBeCloseTo(22)
    expect(m.disc.cx).toBeCloseTo(11)
    expect(m.disc.r).toBeLessThan(11)
    for (const [x, y] of curvePoints(m.ring)) expect(Math.hypot(x - 11, y - 11)).toBeLessThanOrEqual(11)
  })
})

describe('division labels (§3.1.2, §8.9)', () => {
  it('names the quarters of a hizb', () => {
    expect([1, 2, 3, 4, 5, 240].map(rubQuarter)).toEqual([0, 1, 2, 3, 0, 3])
    expect(rubKind({ flags: 7, rub: 105 })).toBe('juz')
    expect(rubKind({ flags: 3, rub: 9 })).toBe('hizb')
    expect(rubKind({ flags: 1, rub: 71 })).toBe('quarter')
  })

  it('writes the Arabic margin labels with Arabic-Indic digits', () => {
    expect(rubLabel({ flags: 7, rub: 105, juz: 14, hizb: 27 })).toBe('الجزء ١٤')
    expect(rubLabel({ flags: 3, rub: 109, juz: 14, hizb: 28 })).toBe('الحزب ٢٨')
    expect(rubLabel({ flags: 1, rub: 70, juz: 9, hizb: 18 })).toBe('¼ الحزب ١٨')
    expect(rubLabel({ flags: 1, rub: 71, juz: 9, hizb: 18 })).toBe('½ الحزب ١٨')
    expect(rubLabel({ flags: 1, rub: 72, juz: 9, hizb: 18 })).toBe('¾ الحزب ١٨')
    expect(rubShortLabel({ rub: 105, hizb: 27 })).toBe('الحزب ٢٧')
    expect(rubShortLabel({ rub: 108, hizb: 27 })).toBe('¾ الحزب ٢٧')
    expect(sajdaLabel('recommended')).toBe('سجدة')
    expect(sajdaLabel('obligatory')).toBe('سجدة واجبة')
    expect(arabicNum(1234)).toBe('١٢٣٤')
  })

  it('picks the juz calligraphy "الجزء …" (U+E001 + juz − 1), clamped to 1–30', () => {
    expect(decorJuzGlyph(1).codePointAt(0)).toBe(0xe001)
    expect(decorJuzGlyph(14).codePointAt(0)).toBe(0xe00e)
    expect(decorJuzGlyph(30).codePointAt(0)).toBe(0xe01e)
    expect(decorJuzGlyph(99).codePointAt(0)).toBe(0xe01e)
    expect(decorJuzGlyph(0).codePointAt(0)).toBe(0xe001)
  })
})

describe('pageMarkers (§8.9)', () => {
  it('marks rub starts on their first line and sajdas where their ayah ends, in line order', () => {
    const data = page(176, [
      ayah({ id: 1150, line: 1 }),
      ayah({ id: 1151, line: 4, flags: 1, rub: 71, hizb: 18, juz: 9 }),
      // The sajda ayah starts on line 14 and its last word (1506) is on line 15.
      ayah({ id: 1160, line: 14, sajda: 'recommended', lastWordId: 1506 }),
    ])
    const markers = pageMarkers(data)
    expect(markers.map((m) => [m.kind, m.line, m.label])).toEqual([
      ['rub', 4, '½ الحزب ١٨'],
      ['sajda', 15, 'سجدة'],
    ])
    expect(markers[0]?.rub).toEqual({ kind: 'quarter', quarter: 2, hizb: 18, juz: 9 })
  })

  it('skips a rub whose ayah began on the previous page, and a sajda that ends on the next', () => {
    const data = page(300, [
      ayah({ id: 2000, line: 1, flags: 1, startsOnPage: false }),
      ayah({ id: 2010, line: 15, sajda: 'obligatory', endsOnPage: false }),
    ])
    expect(pageMarkers(data)).toEqual([])
  })

  it('puts a rub before a sajda on the same line', () => {
    const data = page(400, [
      ayah({ id: 3000, line: 7, flags: 1, rub: 120, sajda: 'obligatory', lastWordId: 705 }),
    ])
    expect(pageMarkers(data).map((m) => m.kind)).toEqual(['rub', 'sajda'])
  })

  it('draws none on the opening pages', () => {
    expect(pageMarkers(page(1, [ayah({ id: 1, line: 2, flags: 15, rub: 1, juz: 1, hizb: 1 })], 8))).toEqual(
      [],
    )
    expect(firstRubStart(page(1, [ayah({ id: 1, line: 2, flags: 15 })], 8))).toBeNull()
  })

  it('marks a quarter start whose first word carries the inline ۞ as label-only (LEAD 17)', () => {
    // Page 42 (qcf_v2): 2:253 opens juz 3 on line 1 with the word "۞ تِلۡكَ" (word 5360).
    const data = page(42, [
      ayah({ id: 260, surah: 2, ayah: 253, line: 1, flags: 7, rub: 17, juz: 3, hizb: 5, firstWordId: 5360 }),
      ayah({ id: 261, surah: 2, ayah: 254, line: 5, firstWordId: 5413 }),
    ])
    const line1 = data.lines[0]
    if (!line1) throw new Error('line 1')
    line1.words = [
      {
        id: 5360,
        ayahId: 260,
        surah: 2,
        ayah: 253,
        position: 1,
        isEnd: false,
        glyph: 'ﱁ ﱂ',
        text: '۞ تِلۡكَ',
      },
      {
        id: 5361,
        ayahId: 260,
        surah: 2,
        ayah: 253,
        position: 2,
        isEnd: false,
        glyph: 'ﱃ',
        text: 'ٱلرُّسُلُ',
      },
    ]
    const [marker] = pageMarkers(data)
    expect(marker).toMatchObject({ kind: 'rub', line: 1, label: 'الجزء ٣', inline: true })
    // Label-only while labels are drawn: one label line, centred on the line, and no ۞ glyph of its own.
    const labelled = placeMarkers(pageMarkers(data), 30, true, true).placed
    expect(labelled).toHaveLength(1)
    expect(labelled[0]?.height).toBeCloseTo(labelSize(30) * LABEL_LEADING)
    expect((labelled[0]?.top ?? 0) + (labelled[0]?.height ?? 0) / 2).toBeCloseTo(lineCenterY(30, 1))
    expect(markerBoxHeight(marker as MarginMarker, 30, true, true)).toBeCloseTo(labelSize(30) * LABEL_LEADING)
    // Below qfs 28 nothing is drawn in the margin: the inline ۞ marks the place, the running head names the quarter.
    expect(markerDrawn(marker as MarginMarker, false)).toBe(false)
    expect(placeMarkers(pageMarkers(data), 20, false, true).placed).toEqual([])
  })

  it('keeps the margin glyph of a rub start without an inline ۞ (a surah start)', () => {
    const data = page(262, [ayah({ id: 1803, line: 3, flags: 15, rub: 105, firstWordId: 302 })])
    const line3 = data.lines[2]
    if (!line3) throw new Error('line 3')
    line3.words = line3.words.map((w) =>
      w.id === 302 ? { ...w, ayahId: 1803, position: 1, text: 'الٓرۚ' } : w,
    )
    const [marker] = pageMarkers(data)
    expect(marker?.inline).toBe(false)
    expect(markerDrawn(marker as MarginMarker, false)).toBe(true)
    const placed = placeMarkers(pageMarkers(data), 20, false).placed
    expect(placed).toHaveLength(1)
    expect(placed[0]?.height).toBeCloseTo(markerGlyphBox(20, INK.rub).height)
  })

  it('centres a sajda alone on its line when the inline rub start beside it is not drawn', () => {
    const data = page(400, [
      ayah({ id: 3000, line: 7, flags: 1, rub: 120, sajda: 'obligatory', firstWordId: 700, lastWordId: 705 }),
    ])
    const line7 = data.lines[6]
    if (!line7) throw new Error('line 7')
    line7.words = line7.words.map((w) =>
      w.id === 700 ? { ...w, ayahId: 3000, position: 1, text: '۞ قُلۡ' } : w,
    )
    expect(pageMarkers(data).map((m) => [m.kind, m.inline])).toEqual([
      ['rub', true],
      ['sajda', false],
    ])
    const small = placeMarkers(pageMarkers(data), 20, false)
    expect(small.placed.map((p) => p.item.kind)).toEqual(['sajda'])
    const [sajda] = small.placed
    expect((sajda?.top ?? 0) + (sajda?.height ?? 0) / 2).toBeCloseTo(lineCenterY(20, 7))
    expect(placeMarkers(pageMarkers(data), 30, true).placed.map((p) => p.item.kind)).toEqual(['rub', 'sajda'])
  })

  it('is not inline when the ۞ word is not the ayah’s first word', () => {
    const data = page(5, [ayah({ id: 33, line: 4, flags: 1, rub: 2, firstWordId: 400 })])
    const line4 = data.lines[3]
    if (!line4) throw new Error('line 4')
    line4.words = [
      { id: 400, ayahId: 33, surah: 2, ayah: 26, position: 2, isEnd: false, glyph: '', text: '۞ x' },
    ]
    expect(pageMarkers(data)[0]?.inline).toBe(false)
  })

  it('finds the first rub start for the running head', () => {
    const data = page(262, [
      ayah({ id: 1803, line: 3, flags: 15, rub: 105 }),
      ayah({ id: 1810, line: 9, flags: 1, rub: 106 }),
    ])
    expect(firstRubStart(data)?.id).toBe(1803)
  })
})

describe('marker sizes (§8.9)', () => {
  it('shows labels only while 0.36·qfs ≥ 10 px', () => {
    expect(marginLabelsVisible(27.75)).toBe(false)
    expect(marginLabelsVisible(28)).toBe(true)
    expect(labelSize(20)).toBe(11)
    expect(labelSize(40)).toBeCloseTo(14.4)
  })

  it('sizes glyphs by their measured ink and centres it', () => {
    expect(inkHeight(INK.rub)).toBeCloseTo(0.45)
    expect(inkShift(INK.rub)).toBeCloseTo(-0.115, 3)
    expect(inkShift(INK.sajda)).toBeCloseTo(0.025, 3)
    const box = markerGlyphBox(30, INK.rub)
    expect(box.height).toBeCloseTo(MARKER_INK * 30)
    expect(box.fontSize * inkHeight(INK.rub)).toBeCloseTo(box.height)
    expect(markerGlyphBox(10, INK.sajda).height).toBe(MARKER_INK_MIN_PX)
    expect(markerGlyphBox(30, INK.decorHizb).height).toBeGreaterThan(box.height)
  })

  it('chooses ۞, ۩ or the decor ornaments', () => {
    const rub = { kind: 'rub', rub: { kind: 'quarter', quarter: 1, hizb: 1, juz: 1 } } as Pick<
      MarginMarker,
      'kind' | 'rub'
    >
    const hizb = { kind: 'rub', rub: { kind: 'hizb', quarter: 0, hizb: 2, juz: 1 } } as Pick<
      MarginMarker,
      'kind' | 'rub'
    >
    expect(markerInk(rub, false).char).toBe(RUB_SIGN)
    expect(markerInk(rub, true).char).toBe(DECOR_QUARTER)
    expect(markerInk(hizb, true).char).toBe(DECOR_HIZB)
    expect(markerInk({ kind: 'sajda', rub: null }, true).char).toBe(SAJDA_SIGN)
    // The ornaments only with their labels: smaller pages draw the solid ۞ even with decor loaded.
    expect(markerInk(rub, true, false).char).toBe(RUB_SIGN)
    expect(markerInk(hizb, true, false).char).toBe(RUB_SIGN)
  })

  it('thickens the ornaments’ hairlines: max(0.5px, 0.018em)', () => {
    expect(decorStroke(20)).toBe(0.5)
    expect(decorStroke(50)).toBeCloseTo(0.9)
    expect(isDecorInk(INK.decorHizb)).toBe(true)
    expect(isDecorInk(INK.rub)).toBe(false)
  })

  it('fills an ornament’s frame with the hizb number or the quarter, fitted and centred', () => {
    const quarter = { rub: { kind: 'quarter' as const, quarter: 2 as const, hizb: 19, juz: 10 } }
    const hizb = { rub: { kind: 'juz' as const, quarter: 0 as const, hizb: 27, juz: 14 } }
    expect(markerInset(quarter, INK.decorQuarter)).toBe('½')
    expect(markerInset(hizb, INK.decorHizb)).toBe('٢٧')
    expect(markerInset(hizb, INK.rub)).toBeNull()
    expect(markerInset({ rub: null }, INK.decorHizb)).toBeNull()
    for (const q of [28, 32, 40, 60]) {
      for (const [ink, text] of [
        [INK.decorHizb, '٤٨'],
        [INK.decorHizb, '٢٧'],
        [INK.decorQuarter, '¾'],
      ] as const) {
        const box = insetBox(q, ink, text)
        if (!box) throw new Error('an ornament has a frame')
        const glyph = markerGlyphBox(q, ink)
        // Never larger than 0.34·qfs, and never wider than the frame's inner width less the thickening.
        expect(box.fontSize).toBeLessThanOrEqual(INSET_TEXT * q + 1e-9)
        const widthEm = text === '¾' ? 0.75 : 0.864
        expect(box.fontSize * widthEm).toBeLessThan(
          (ink.hollow?.w ?? 0) * glyph.fontSize - decorStroke(glyph.fontSize),
        )
        // Inside the glyph box, at the frame's height.
        expect(box.top).toBeGreaterThan(0)
        expect(box.top + box.fontSize).toBeLessThan(glyph.height)
      }
    }
    // The quarter frame is wide enough for the full 0.34·qfs; the hizb frame centres its number on the ink's middle.
    expect(insetBox(30, INK.decorQuarter, '¾')?.fontSize).toBeCloseTo(INSET_TEXT * 30)
    const h = insetBox(30, INK.decorHizb, '٢٧')
    const g = markerGlyphBox(30, INK.decorHizb)
    expect(((h?.top ?? 0) + 0.53 * (h?.fontSize ?? 0)) / g.height).toBeCloseTo(0.5, 1)
    expect(insetBox(30, INK.rub, '٢٧')).toBeNull()
  })

  it('adds the label to the height only when labels are drawn', () => {
    expect(markerHeight(30, INK.rub, true)).toBeGreaterThan(markerHeight(30, INK.rub, false))
    expect(markerHeight(30, INK.rub, false)).toBeCloseTo(MARKER_INK * 30)
  })
})

describe('margin stacking (§8.9)', () => {
  it('centres lines on block top + (line − 1)·LH + LH/2, shifted 3.5 lines on the opening pages', () => {
    expect(lineCenterY(20, 1)).toBeCloseTo((BLOCK_TOP + LH / 2) * 20)
    expect(lineCenterY(20, 15)).toBeCloseTo((BLOCK_TOP + 14.5 * LH) * 20)
    expect(lineCenterY(20, 1, true)).toBeCloseTo((BLOCK_TOP + (OPENING_TOP_LINES + 0.5) * LH) * 20)
  })

  it('stacks items with a gap, centred or from a start', () => {
    expect(stackCentered(100, [10, 20], 4)).toEqual([83, 97])
    expect(stackFrom(50, [10, 20], 4)).toEqual([50, 64])
    expect(stackCentered(10, [], 4)).toEqual([])
  })

  it('stacks two markers on one line 0.2·qfs apart, centred on the line', () => {
    const q = 30
    const data = page(400, [
      ayah({ id: 3000, line: 7, flags: 1, rub: 120, sajda: 'obligatory', lastWordId: 705 }),
    ])
    const { placed, bottoms } = placeMarkers(pageMarkers(data), q, true)
    expect(placed).toHaveLength(2)
    const [a, b] = placed
    if (!a || !b) throw new Error('two markers')
    expect(b.top - (a.top + a.height)).toBeCloseTo(STACK_GAP * q)
    expect((a.top + b.top + b.height) / 2).toBeCloseTo(lineCenterY(q, 7))
    expect(bottoms.get(7)).toBeCloseTo(b.top + b.height)
  })

  it('places marks after the markers of their line, or centred on a line without markers', () => {
    const q = 30
    const marks = [
      { key: 'bookmark-1', kind: 'bookmark' as const, ayahId: 1, line: 3, id: 'b1' },
      { key: 'note-n', kind: 'note' as const, ayahId: 2, line: 5, id: 'n' },
    ]
    const placed = placeMarks(marks, q, new Map([[3, 200]]))
    expect(placed[0]?.top).toBeCloseTo(200 + STACK_GAP * q)
    expect((placed[1]?.top ?? 0) + (placed[1]?.height ?? 0) / 2).toBeCloseTo(lineCenterY(q, 5))
  })

  it('derives the marks of a page from user marks', () => {
    const data = page(262, [
      ayah({ id: 1803, line: 3 }),
      ayah({ id: 1806, line: 5 }),
      ayah({ id: 1811, line: 9 }),
    ])
    const marks = pageMarks(
      data,
      [
        { ayahId: 1811, bookmarkId: 'b9' },
        { ayahId: 1803, bookmarkId: 'b1' },
        { ayahId: 1803, bookmarkId: 'dup' },
        { ayahId: 9999, bookmarkId: 'elsewhere' },
      ],
      [
        { id: 'n1', fromAyahId: 1806, toAyahId: 1807 },
        // A note that began on an earlier page is marked on its first ayah on this page.
        { id: 'n0', fromAyahId: 1790, toAyahId: 1804 },
        { id: 'far', fromAyahId: 5000, toAyahId: 5001 },
      ],
    )
    expect(marks.map((m) => [m.kind, m.ayahId, m.line, m.id])).toEqual([
      ['bookmark', 1803, 3, 'b1'],
      ['note', 1803, 3, 'n0'],
      ['note', 1806, 5, 'n1'],
      ['bookmark', 1811, 9, 'b9'],
    ])
  })
})

describe('reading ribbon, dog-ear and page-stack edges (§8.9)', () => {
  it('hangs the ribbon in the spine margin down to its line + 0.6·qfs', () => {
    const q = 20
    const right = ribbonGeometry(q, 'right', 4)
    expect(right.w).toBeCloseTo(0.55 * q)
    expect(right.x + right.w / 2).toBeCloseTo((M_IN / 2) * q)
    expect(right.h).toBeCloseTo(lineCenterY(q, 4) + 0.6 * q)
    const left = ribbonGeometry(q, 'left', 4)
    expect(left.x + left.w / 2).toBeCloseTo((PW - M_IN / 2) * q)
    expect(ribbonGeometry(q, 'right', 2, true).h).toBeGreaterThan(ribbonGeometry(q, 'right', 2).h)
  })

  it('cuts a V-notch into the ribbon tail', () => {
    expect(ribbonPath(10, 100, 4)).toBe('M0 0H10V100L5 96L0 100Z')
    expect(ribbonPath(10, 2, 4)).toBe('M0 0H10V2L5 0L0 2Z')
  })

  it('draws 1–5 hairlines proportional to the pages on each side', () => {
    expect(stackEdgeCount(1, 'right')).toBe(1)
    expect(stackEdgeCount(2, 'left')).toBe(5)
    expect(stackEdgeCount(603, 'right')).toBe(5)
    expect(stackEdgeCount(604, 'left')).toBe(1)
    expect(stackEdgeCount(301, 'right')).toBe(3)
    expect(stackEdgeCount(Number.NaN, 'right')).toBe(1)
  })
})

describe('notePreview (§8.9)', () => {
  it('drops Markdown and collapses whitespace', () => {
    expect(notePreview('# Title\n\n**Bold** and _em_ with [a link](https://x.y) and `code`.')).toBe(
      'Title Bold and em with a link and code.',
    )
    expect(notePreview('- one\n- two\n> quoted')).toBe('one two quoted')
  })

  it('cuts at 80 graphemes with an ellipsis, never inside a cluster', () => {
    const long = 'ﷺ'.repeat(10) + 'a'.repeat(100)
    const out = notePreview(long, 80)
    expect([...new Intl.Segmenter().segment(out)]).toHaveLength(81)
    expect(out.endsWith('…')).toBe(true)
    expect(notePreview('short')).toBe('short')
    expect(notePreview('  ')).toBe('')
  })
})

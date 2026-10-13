/**
 * `ornaments.ts` (WP8c; §8.8, §8.9): the ornament geometry (khatam, rosette, band tile, frame, opening medallion,
 * cartouche, footer), the margin model (markers, labels, stacking, marks), the ribbon, the page-stack edges and the
 * note preview. Self-contained: the pages are built here, so the tests need no exported fixtures.
 */
import { describe, expect, it } from 'vitest'
import type { PageAyah, PageData, PageLine } from '$lib/ipc/bindings'
import {
  BLOCK_TOP,
  FR,
  FRAME_BOTTOM,
  LH,
  M_IN,
  M_OUT,
  M_TB,
  HEAD,
  OPENING_TOP_LINES,
  PH,
  PW,
  TB_H,
  TB_W,
} from './geometry'
import {
  arabicNum,
  BAND_TILE,
  bandTile,
  cartouche,
  CARTOUCHE_INSETS,
  CARTOUCHE_MEDALLION,
  decorStroke,
  DECOR_HIZB,
  DECOR_LAMP,
  DECOR_MEDALLION,
  DECOR_MEDALLION_JUZ,
  DECOR_QUARTER,
  DOG_EAR,
  firstRubStart,
  fitTiles,
  FOOTER_DEPTH,
  FOOTER_LOBES,
  footerMedallion,
  frameBoxQ,
  frameGeometry,
  INK,
  inkHeight,
  inkShift,
  isDecorInk,
  khatam,
  labelBoxHeight,
  LABEL_GAP,
  LABEL_LEADING,
  labelSize,
  lineCenterY,
  marginLabelsVisible,
  MARKER_INK,
  MARK_BOOKMARK,
  MARKER_INK_MIN_PX,
  markerAnchor,
  markerBoxHeight,
  markerLabelShown,
  markerLabelTop,
  markerGlyphBox,
  markerHeight,
  markerInk,
  markerPrintLabel,
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
  rubLabelLines,
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
import {
  MARGIN_LABEL_EM,
  marginLabelBox,
  PRINT_METRICS,
  printLabelShift,
  printMarginKind,
} from './printLabels'

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
    // Its outer bottom edge is FRAME_BOTTOM on both sides (the page rail's reveal zone starts there, §8.11).
    for (const side of ['right', 'left'] as const) {
      const box = frameBoxQ(side)
      expect(box.y + box.h).toBeCloseTo(FRAME_BOTTOM, 12)
    }
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
  /** The rosette's crest radius: the box's half-size less half the stroke. */
  const crest = (m: ReturnType<typeof footerMedallion>) => m.size / 2 - m.stroke / 2

  it.each([8, 20, 40])('is 1.1·qfs with one stroke and no separate disc (qfs %i)', (qfs) => {
    const m = footerMedallion(qfs)
    expect(m.size).toBeCloseTo(1.1 * qfs)
    expect(m.stroke).toBe(Math.max(0.75, 0.03 * qfs))
    // The tint is the rosette's own fill: nothing else is drawn.
    expect(Object.keys(m).sort()).toEqual(['rosette', 'size', 'stroke'])
  })

  it.each([8, 20, 40])('draws one closed rosette of FOOTER_LOBES lobes (qfs %i)', (qfs) => {
    const d = footerMedallion(qfs).rosette
    expect(d.match(/M/g)).toHaveLength(1)
    expect(d.match(/Q/g)).toHaveLength(FOOTER_LOBES)
    expect(d.endsWith('Z')).toBe(true)
  })

  it.each([8, 20, 40])(
    'puts the valleys on FOOTER_DEPTH·r and the crests on r, inside the box (qfs %i)',
    (qfs) => {
      const m = footerMedallion(qfs)
      const c = m.size / 2
      const r = crest(m)
      const ends = curvePoints(m.rosette)
      expect(ends).toHaveLength(FOOTER_LOBES + 1)
      for (const [x, y] of ends) expect(Math.hypot(x - c, y - c)).toBeCloseTo(FOOTER_DEPTH * r, 1)
      // A quadratic's midpoint (P0 + 2C + P1) / 4 is the crest; with half the stroke it stays inside the box.
      const segs = [...m.rosette.matchAll(/Q(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/g)]
      expect(segs).toHaveLength(FOOTER_LOBES)
      segs.forEach((s, i) => {
        const [x0, y0] = ends[i] ?? [0, 0]
        const x = (x0 + 2 * Number(s[1]) + Number(s[3])) / 4
        const y = (y0 + 2 * Number(s[2]) + Number(s[4])) / 4
        expect(Math.hypot(x - c, y - c)).toBeCloseTo(r, 1)
        expect(Math.hypot(x - c, y - c) + m.stroke / 2).toBeLessThanOrEqual(c + 0.02)
      })
    },
  )

  it('scales with qfs above the stroke floor', () => {
    // 0.03·qfs passes the 0.75 px floor at qfs 25: at 30 and 60 the whole medallion is one shape at two sizes.
    const small = numbers(footerMedallion(30).rosette)
    const large = numbers(footerMedallion(60).rosette)
    expect(large).toHaveLength(small.length)
    large.forEach((v, i) => expect(Math.abs(v - 2 * (small[i] ?? 0))).toBeLessThanOrEqual(0.02))
  })
})

describe('division labels (§3.1.2, §8.9)', () => {
  it('names the quarters of a hizb', () => {
    expect([1, 2, 3, 4, 5, 240].map(rubQuarter)).toEqual([0, 1, 2, 3, 0, 3])
    expect(rubKind({ flags: 7, rub: 105 })).toBe('juz')
    expect(rubKind({ flags: 3, rub: 9 })).toBe('hizb')
    expect(rubKind({ flags: 1, rub: 71 })).toBe('quarter')
  })

  it('writes the Arabic margin labels in Eastern Arabic numbers, the quarters in words', () => {
    expect(rubLabel({ flags: 7, rub: 105, juz: 14, hizb: 27 })).toBe('الجزء ١٤')
    expect(rubLabel({ flags: 3, rub: 109, juz: 14, hizb: 28 })).toBe('الحزب ٢٨')
    expect(rubLabel({ flags: 1, rub: 70, juz: 9, hizb: 18 })).toBe('ربع الحزب ١٨')
    expect(rubLabel({ flags: 1, rub: 71, juz: 9, hizb: 18 })).toBe('نصف الحزب ١٨')
    expect(rubLabel({ flags: 1, rub: 72, juz: 9, hizb: 18 })).toBe('ثلاثة أرباع الحزب ١٨')
    // The margin sets a quarter on two lines: its words over its hizb.
    expect(rubLabelLines({ flags: 1, rub: 108, juz: 14, hizb: 27 })).toEqual(['ثلاثة أرباع', 'الحزب ٢٧'])
    expect(rubLabelLines({ flags: 1, rub: 106, juz: 14, hizb: 27 })).toEqual(['ربع', 'الحزب ٢٧'])
    expect(rubLabelLines({ flags: 7, rub: 105, juz: 14, hizb: 27 })).toEqual(['الجزء ١٤'])
    expect(rubLabelLines({ flags: 3, rub: 109, juz: 14, hizb: 28 })).toEqual(['الحزب ٢٨'])
    // The running head keeps one line.
    expect(rubShortLabel({ rub: 105, hizb: 27 })).toBe('الحزب ٢٧')
    expect(rubShortLabel({ rub: 106, hizb: 27 })).toBe('ربع الحزب ٢٧')
    expect(rubShortLabel({ rub: 107, hizb: 27 })).toBe('نصف الحزب ٢٧')
    expect(rubShortLabel({ rub: 108, hizb: 27 })).toBe('ثلاثة أرباع الحزب ٢٧')
    expect(sajdaLabel('recommended')).toBe('سجدة')
    expect(sajdaLabel('obligatory')).toBe('سجدة واجبة')
    expect(arabicNum(1234)).toBe('١٢٣٤')
  })

  it('never writes a Western Arabic digit or a vulgar fraction in any of the 240 rub labels', () => {
    const quarter = '(?:(?:ربع|نصف|ثلاثة أرباع) )?'
    const label = new RegExp(`^${quarter}الحزب [٠-٩]+$|^الجزء [٠-٩]+$`, 'u')
    const line = /^(?:ربع|نصف|ثلاثة أرباع|الحزب [٠-٩]+|الجزء [٠-٩]+)$/u
    for (let rub = 1; rub <= 240; rub++) {
      const hizb = Math.ceil(rub / 4)
      const juz = Math.ceil(rub / 8)
      for (const flags of [1, 3, 7]) {
        const a = { flags, rub, juz, hizb }
        const lines = rubLabelLines(a)
        expect(rubLabel(a), `rub ${rub} flags ${flags}`).toMatch(label)
        expect(rubLabel(a)).not.toMatch(/[0-9¼½¾/]/u)
        expect(lines.length).toBe(rubKind(a) === 'quarter' ? 2 : 1)
        for (const l of lines) expect(l).toMatch(line)
      }
      expect(rubShortLabel({ rub, hizb })).toMatch(new RegExp(`^${quarter}الحزب [٠-٩]+$`, 'u'))
    }
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
    expect(markers.map((m) => [m.kind, m.line, m.label, m.lines])).toEqual([
      ['rub', 4, 'نصف الحزب ١٨', ['نصف', 'الحزب ١٨']],
      ['sajda', 15, 'سجدة', ['سجدة']],
    ])
    expect(markers[0]?.rub).toEqual({ kind: 'quarter', quarter: 2, hizb: 18, juz: 9, number: 71 })
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

  it('draws a rub start whose first word carries the inline ۞ like any other (LEAD 17; owner request 2026-10-13)', () => {
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
    if (!marker) throw new Error('no marker')
    expect(marker).toMatchObject({ kind: 'rub', line: 1, label: 'الجزء ٣', inline: true })
    // The text keeps its ۞; the margin draws exactly what it draws for a rub start without one, at every size, with
    // or without decor and the print face.
    const plain = { ...marker, inline: false }
    for (const qfs of [18, 24, 30, 60]) {
      for (const [decor, print] of [
        [true, true],
        [false, true],
        [true, false],
        [false, false],
      ] as const) {
        const labels = marginLabelsVisible(qfs)
        const placed = placeMarkers([marker], qfs, labels, decor, false, print).placed
        expect(placed, `qfs ${qfs}`).toHaveLength(1)
        expect(placed).toEqual(
          placeMarkers([plain], qfs, labels, decor, false, print).placed.map((p) => ({ ...p, item: marker })),
        )
      }
    }
    // The juz's medallion at every size; without the print face below qfs 28, the ۞ alone.
    expect(markerInk(marker, true, true)).toBe(INK.decorJuz)
    expect(markerBoxHeight(marker, 18, false, true, true)).toBeCloseTo(DECOR_MEDALLION_JUZ * 18)
    expect(markerBoxHeight(marker, 20, false, true, false)).toBeCloseTo(markerGlyphBox(20, INK.rub).height)
  })

  it('draws ۞ for a surah start without the print face: alone below qfs 28, over its Hafs words from there', () => {
    const data = page(262, [ayah({ id: 1803, line: 3, flags: 15, rub: 105, firstWordId: 302 })])
    const line3 = data.lines[2]
    if (!line3) throw new Error('line 3')
    line3.words = line3.words.map((w) =>
      w.id === 302 ? { ...w, ayahId: 1803, position: 1, text: 'الٓرۚ' } : w,
    )
    const [marker] = pageMarkers(data)
    expect(marker?.inline).toBe(false)
    const placed = placeMarkers(pageMarkers(data), 20, false).placed
    expect(placed).toHaveLength(1)
    expect(placed[0]?.height).toBeCloseTo(markerGlyphBox(20, INK.rub).height)
    // Decor alone draws no ornament: it holds the print's label.
    const labelled = placeMarkers(pageMarkers(data), 30, true, true).placed
    expect(labelled[0]?.height).toBeCloseTo(
      markerGlyphBox(30, INK.rub).height + LABEL_GAP * 30 + labelSize(30) * LABEL_LEADING,
    )
  })

  it('stacks a rub start and the sajda that ends on its line, the rub first, its anchor never below the line', () => {
    // Page 309: the sajda of 19:58 ends on line 8, where 19:59 opens three quarters of hizb 31 with an inline ۞.
    const data = page(309, [
      ayah({
        id: 2308,
        surah: 19,
        ayah: 58,
        line: 5,
        rub: 123,
        sajda: 'recommended',
        firstWordId: 500,
        lastWordId: 803,
      }),
      ayah({
        id: 2309,
        surah: 19,
        ayah: 59,
        line: 8,
        flags: 1,
        rub: 124,
        hizb: 31,
        juz: 16,
        firstWordId: 804,
      }),
    ])
    const line8 = data.lines[7]
    if (!line8) throw new Error('line 8')
    line8.words = line8.words.map((w) =>
      w.id === 804 ? { ...w, ayahId: 2309, position: 1, text: '۞ فَخَلَفَ' } : w,
    )
    expect(pageMarkers(data).map((m) => [m.kind, m.line, m.inline])).toEqual([
      ['rub', 8, true],
      ['sajda', 8, false],
    ])
    for (const [qfs, decor, print] of [
      [20, false, false],
      [30, false, false],
      [18, false, true],
      [30, false, true],
      [18, true, true],
      [30, true, true],
    ] as const) {
      const labels = marginLabelsVisible(qfs)
      const { placed, stacks } = placeMarkers(pageMarkers(data), qfs, labels, decor, false, print)
      const [rub, sajda] = placed
      if (!rub || !sajda) throw new Error('two markers')
      const where = `qfs ${qfs}, decor ${decor}, print ${print}`
      const center = lineCenterY(qfs, 8)
      expect(rub.height, where).toBeCloseTo(markerBoxHeight(rub.item, qfs, labels, decor, print))
      expect(sajda.top - (rub.top + rub.height), where).toBeCloseTo(STACK_GAP * qfs)
      expect(stacks.get(8), where).toEqual({ top: rub.top, bottom: sajda.top + sajda.height })
      const anchor = rub.top + markerAnchor(rub.item, qfs, labels, decor, print)
      if (decor && print) {
        // The lamp's anchor is near its foot: centred, the stack would hang its box 0.7·qfs below the line and the
        // ۩ under it beside the next line. Its box stays on the line, the ۩ right under the lamp: 1.15·qfs below.
        expect(anchor, where).toBeCloseTo(center)
        expect((sajda.top + markerGlyphBox(qfs, INK.sajda).height / 2 - center) / qfs, where).toBeCloseTo(
          (1 - 0.8375) * DECOR_LAMP + STACK_GAP + MARKER_INK / 2,
          6,
        )
      } else {
        // The ۞ (over its label) is no taller below its anchor than the ۩ stack: centred, its anchor above the line.
        expect((rub.top + sajda.top + sajda.height) / 2, where).toBeCloseTo(center)
        expect(anchor, where).toBeLessThanOrEqual(center + 1e-9)
      }
    }
  })

  it('keeps a medallion and the sajda on its line centred together (page 272), the ۩ about a line below', () => {
    // Page 272: the sajda of 16:50 ends on line 11, where 16:51 opens hizb 28.
    const data = page(272, [
      ayah({ id: 1951, surah: 16, ayah: 50, line: 10, rub: 108, sajda: 'recommended', lastWordId: 1103 }),
      ayah({ id: 1952, surah: 16, ayah: 51, line: 11, flags: 3, rub: 109, hizb: 28, juz: 14 }),
    ])
    // Pinned (qfs): the frame's centre above the line, the ۩'s glyph centre below it.
    for (const [qfs, frame, glyph] of [
      [18, -0.475, 1.96],
      [30, -0.749, 1.686],
    ] as const) {
      const labels = marginLabelsVisible(qfs)
      const [medallion, sajda] = placeMarkers(pageMarkers(data), qfs, labels, true, false, true).placed
      if (!medallion || !sajda) throw new Error('two markers')
      const center = lineCenterY(qfs, 11)
      expect(medallion.item.kind, `qfs ${qfs}`).toBe('rub')
      expect(
        (medallion.top + markerAnchor(medallion.item, qfs, labels, true, true) - center) / qfs,
      ).toBeCloseTo(frame, 2)
      expect((sajda.top + (MARKER_INK * qfs) / 2 - center) / qfs).toBeCloseTo(glyph, 2)
      expect((medallion.top + sajda.top + sajda.height) / 2).toBeCloseTo(center)
    }
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
  it('shows the Hafs labels only while 0.36·qfs ≥ 10 px', () => {
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
    // The ornaments' ink is one em tall (0.1875 em below the baseline to 0.8125 above): their font size is their
    // height.
    for (const [ink, size] of [
      [INK.decorQuarter, DECOR_LAMP],
      [INK.decorHizb, DECOR_MEDALLION],
      [INK.decorJuz, DECOR_MEDALLION_JUZ],
    ] as const) {
      expect(inkHeight(ink)).toBeCloseTo(1)
      expect(markerGlyphBox(30, ink).fontSize).toBeCloseTo(size * 30)
      expect(markerGlyphBox(30, ink).height).toBeCloseTo(size * 30)
    }
  })

  it('chooses the lamp, the medallion, ۞ or ۩, at every size', () => {
    const marker = (kind: 'quarter' | 'hizb' | 'juz') =>
      ({
        kind: 'rub',
        rub: { kind, quarter: kind === 'quarter' ? 1 : 0, hizb: 2, juz: 1, number: 6 },
      }) as Pick<MarginMarker, 'kind' | 'rub'>
    const quarter = marker('quarter')
    const hizb = marker('hizb')
    const juz = marker('juz')
    expect(markerInk(quarter, true, true).char).toBe(DECOR_QUARTER)
    expect(markerInk(hizb, true, true)).toBe(INK.decorHizb)
    expect(markerInk(juz, true, true)).toBe(INK.decorJuz)
    expect(INK.decorHizb.char).toBe(DECOR_HIZB)
    expect(INK.decorJuz.char).toBe(DECOR_HIZB)
    expect(markerInk({ kind: 'sajda', rub: null }, true, true).char).toBe(SAJDA_SIGN)
    // Without decor, or without the print face whose label the ornament holds: the solid ۞.
    for (const m of [quarter, hizb, juz]) {
      expect(markerInk(m, false, true).char).toBe(RUB_SIGN)
      expect(markerInk(m, true, false).char).toBe(RUB_SIGN)
    }
  })

  it('thickens the ornaments’ ≈0.01 em hairlines to a pixel, and no further', () => {
    // The lamp at qfs 18 (font 64 px): its 0.64 px hairlines get 0.36 px; from about qfs 28 they are a pixel already,
    // and a thickening would only fill the filigree and merge the box's double rule.
    expect(decorStroke(markerGlyphBox(18, INK.decorQuarter).fontSize)).toBeCloseTo(0.36, 2)
    for (const qfs of [28.1, 30, 60]) {
      expect(decorStroke(markerGlyphBox(qfs, INK.decorQuarter).fontSize)).toBe(0)
      expect(decorStroke(markerGlyphBox(qfs, INK.decorHizb).fontSize)).toBe(0)
    }
    expect(decorStroke(400)).toBe(0)
    expect(isDecorInk(INK.decorHizb)).toBe(true)
    expect(isDecorInk(INK.decorJuz)).toBe(true)
    expect(isDecorInk(INK.rub)).toBe(false)
  })

  it('sizes each ornament so the print label of its kind fills its box, as in print, inside the margin', () => {
    const em = PRINT_METRICS.unitsPerEm
    const cases = [
      [INK.decorQuarter, ['marginQuarter1', 'marginQuarter2', 'marginQuarter3']],
      [INK.decorHizb, ['marginHizb']],
      [INK.decorJuz, ['marginJuz']],
    ] as const
    for (const qfs of [18, 30, 60, 160]) {
      for (const [ink, kinds] of cases) {
        const { fontSize } = markerGlyphBox(qfs, ink)
        const stroke = decorStroke(fontSize)
        for (const kind of kinds) {
          const { yMin, yMax, advance } = PRINT_METRICS[kind]
          const size = MARGIN_LABEL_EM * qfs
          // The label's ink, centred in its advance with 0.05 em bearings, fits the box less the thickening.
          const where = `${kind} at qfs ${qfs}`
          expect((advance / em - 0.1) * size, where).toBeLessThan(ink.hollow.w * fontSize - stroke)
          expect(((yMax - yMin) / em) * size, where).toBeLessThan(ink.hollow.h * fontSize - stroke)
        }
      }
    }
    // What the label fills: 80 % of the lamp's box height, 84 % of the medallion's frame width (the print's air).
    const quarter = PRINT_METRICS.marginQuarter1
    expect(
      (((quarter.yMax - quarter.yMin) / em) * MARGIN_LABEL_EM) / (INK.decorQuarter.hollow.h * DECOR_LAMP),
    ).toBeCloseTo(0.8, 2)
    expect(
      ((PRINT_METRICS.marginHizb.advance / em - 0.1) * MARGIN_LABEL_EM) /
        (INK.decorHizb.hollow.w * DECOR_MEDALLION),
    ).toBeCloseTo(0.84, 2)
    expect(
      ((PRINT_METRICS.marginJuz.advance / em - 0.1) * MARGIN_LABEL_EM) /
        (INK.decorJuz.hollow.w * DECOR_MEDALLION_JUZ),
    ).toBeCloseTo(0.84, 2)
    // Every ornament's ink is narrower than the outer margin.
    for (const [ink] of cases) expect(ink.width * ink.size).toBeLessThan(M_OUT)
  })

  it('adds the label to the height only when labels are drawn, a line per label line', () => {
    expect(markerHeight(30, INK.rub, true)).toBeGreaterThan(markerHeight(30, INK.rub, false))
    expect(markerHeight(30, INK.rub, false)).toBeCloseTo(MARKER_INK * 30)
    expect(markerHeight(30, INK.rub, true)).toBeCloseTo(
      MARKER_INK * 30 + LABEL_GAP * 30 + labelSize(30) * LABEL_LEADING,
    )
    expect(markerHeight(30, INK.rub, true, 2) - markerHeight(30, INK.rub, true)).toBeCloseTo(
      labelSize(30) * LABEL_LEADING,
    )
    expect(markerHeight(20, INK.rub, false, 2)).toBeCloseTo(markerHeight(20, INK.rub, false))
  })

  it('gives a quarter’s two Hafs label lines their height under the ۞, inline ۞ or not (no print face)', () => {
    // 54:9 (page 529) opens the third quarter of hizb 53 with an inline ۞; 8:1 (page 177) the half of hizb 18 without.
    const inline = page(529, [
      ayah({
        id: 4855,
        surah: 54,
        ayah: 9,
        line: 2,
        flags: 1,
        rub: 212,
        juz: 27,
        hizb: 53,
        firstWordId: 200,
      }),
    ])
    const line2 = inline.lines[1]
    if (!line2) throw new Error('line 2')
    line2.words = line2.words.map((w) =>
      w.id === 200 ? { ...w, ayahId: 4855, position: 1, text: '۞ كَذَّبَتۡ' } : w,
    )
    const [third] = pageMarkers(inline)
    expect(third).toMatchObject({
      inline: true,
      label: 'ثلاثة أرباع الحزب ٥٣',
      lines: ['ثلاثة أرباع', 'الحزب ٥٣'],
    })
    const twoLines = markerGlyphBox(30, INK.rub).height + LABEL_GAP * 30 + 2 * labelSize(30) * LABEL_LEADING
    expect(markerBoxHeight(third as MarginMarker, 30, true)).toBeCloseTo(twoLines)
    const [placed] = placeMarkers(pageMarkers(inline), 30, true).placed
    expect((placed?.top ?? 0) + (placed?.height ?? 0) / 2).toBeCloseTo(lineCenterY(30, 2))

    const ornate = page(177, [
      ayah({ id: 1161, surah: 8, ayah: 1, line: 3, flags: 9, rub: 71, juz: 9, hizb: 18, firstWordId: 302 }),
    ])
    const [half] = pageMarkers(ornate)
    expect(half?.lines).toEqual(['نصف', 'الحزب ١٨'])
    // Decor without the print face draws no lamp: the ۞ over the words.
    expect(markerBoxHeight(half as MarginMarker, 30, true, true)).toBeCloseTo(twoLines)
    // Below qfs 28 the words are not drawn, so the second line adds nothing there.
    expect(markerBoxHeight(half as MarginMarker, 20, false, true)).toBeCloseTo(
      markerGlyphBox(20, INK.rub).height,
    )
  })
})

describe('the print’s margin labels (§8.9; LEAD 25; owner request 2026-10-13)', () => {
  /** A rub-start marker of rub `n` on `line` (its kind of label follows from the number, its kind from the flags). */
  const rubMarker = (n: number, line = 7) => {
    const kind = printMarginKind(n)
    const flags = kind === 'marginJuz' ? 7 : kind === 'marginHizb' ? 3 : 1
    const data = page(300, [
      ayah({ id: 2000, line, flags, rub: n, hizb: Math.ceil(n / 4), juz: Math.ceil(n / 8) }),
    ])
    const [m] = pageMarkers(data)
    if (!m) throw new Error('no marker')
    return m
  }

  it('draws a rub start’s own print label (U+F800 + rub) only with the face, never for a sajda', () => {
    const data = page(400, [
      ayah({
        id: 3000,
        line: 7,
        flags: 1,
        rub: 120,
        hizb: 30,
        juz: 15,
        sajda: 'obligatory',
        lastWordId: 705,
      }),
    ])
    const [rub, sajda] = pageMarkers(data)
    if (!rub || !sajda) throw new Error('two markers')
    expect(rub.rub?.number).toBe(120)
    expect(markerPrintLabel(rub, true)?.char).toBe(String.fromCodePoint(0xf800 + 120))
    expect(markerPrintLabel(rub, true)?.family).toBe('qd-print-labels')
    expect(markerPrintLabel(rub, false)).toBeNull()
    expect(markerPrintLabel(sajda, true)).toBeNull()
    expect(labelBoxHeight(sajda, 30, true)).toBeCloseTo(labelSize(30) * LABEL_LEADING)
  })

  it('sizes every label at one size, MARGIN_LABEL_EM·qfs, in a box as tall as the ink of its kind', () => {
    for (const [n, kind] of [
      [105, 'marginJuz'],
      [109, 'marginHizb'],
      [106, 'marginQuarter1'],
      [107, 'marginQuarter2'],
      [108, 'marginQuarter3'],
    ] as const) {
      const m = rubMarker(n)
      const { yMin, yMax } = PRINT_METRICS[kind]
      const ink = markerPrintLabel(m, true)
      if (!ink) throw new Error(`rub ${n}: no print label`)
      // No px floor: the label keeps its size beside its ornament on the smallest page.
      for (const qfs of [18, 30, 160]) {
        const box = marginLabelBox(qfs, ink)
        const where = `rub ${n} at qfs ${qfs}`
        expect(box.fontSize, where).toBeCloseTo(MARGIN_LABEL_EM * qfs)
        expect(box.height, where).toBeCloseTo(((yMax - yMin) / 1000) * MARGIN_LABEL_EM * qfs)
        expect(labelBoxHeight(m, qfs, true), where).toBeCloseTo(box.height)
        // The ink fills the box: its line starts at the box's top, the ink top `yMax` above the baseline (ascent
        // 0.615).
        expect(box.shift, where).toBeCloseTo(yMax / 1000 - 0.615)
        expect(printLabelShift(ink)).toBeCloseTo(box.shift)
        // Without the face: the Hafs lines (a quarter's two).
        expect(labelBoxHeight(m, qfs, false), where).toBeCloseTo(
          m.lines.length * labelSize(qfs) * LABEL_LEADING,
        )
      }
    }
  })

  it('draws the label at every size: in the ornament, else under the ۞ (decor off)', () => {
    const quarter = rubMarker(108)
    // In the lamp: the marker is the lamp, its label inside.
    for (const qfs of [18, 30]) {
      expect(markerBoxHeight(quarter, qfs, marginLabelsVisible(qfs), true, true)).toBeCloseTo(
        DECOR_LAMP * qfs,
      )
      expect(markerLabelTop(quarter, qfs, true, true)).not.toBeNull()
    }
    // Without decor: the ۞, the gap and the label under it, at every size, inline ۞ or not.
    for (const qfs of [18, 24, 30, 60]) {
      for (const inline of [false, true]) {
        const m = { ...quarter, inline }
        expect(markerBoxHeight(m, qfs, marginLabelsVisible(qfs), false, true), `qfs ${qfs}`).toBeCloseTo(
          markerGlyphBox(qfs, INK.rub).height + LABEL_GAP * qfs + labelBoxHeight(m, qfs, true),
        )
        expect(markerLabelTop(m, qfs, false, true)).toBeNull()
      }
    }
    // Without the print face the Hafs words wait for qfs 28.
    expect(markerBoxHeight(quarter, 20, false, false, false)).toBeCloseTo(markerGlyphBox(20, INK.rub).height)
    expect(markerLabelShown(quarter, false, true)).toBe(true)
    expect(markerLabelShown(quarter, false, false)).toBe(false)
    expect(markerLabelShown({ kind: 'sajda', rub: null }, false, true)).toBe(false)
  })

  it('hangs each ornament with its box on its line, the label’s ink centred in it, inside the paper', () => {
    // The lamp's box is centred 0.025 em below its baseline, its ink top 0.8125 em above it; the medallion's frame
    // 0.3125 em above the baseline, the middle of its ink.
    for (const [n, size, anchor] of [
      [106, DECOR_LAMP, 0.8125 + 0.025],
      [107, DECOR_LAMP, 0.8125 + 0.025],
      [108, DECOR_LAMP, 0.8125 + 0.025],
      [109, DECOR_MEDALLION, 0.8125 - 0.3125],
      [105, DECOR_MEDALLION_JUZ, 0.8125 - 0.3125],
    ] as const) {
      for (const qfs of [18, 24, 30, 60, 160]) {
        for (const line of [1, 8, 15]) {
          const m = rubMarker(n, line)
          const where = `rub ${n}, qfs ${qfs}, line ${line}`
          const labels = marginLabelsVisible(qfs)
          const [p] = placeMarkers([m], qfs, labels, true, false, true).placed
          if (!p) throw new Error(`not placed (${where})`)
          const center = lineCenterY(qfs, line)
          expect(markerAnchor(m, qfs, labels, true, true), where).toBeCloseTo(anchor * size * qfs, 6)
          expect(p.top, where).toBeCloseTo(center - anchor * size * qfs, 6)
          expect(p.height, where).toBeCloseTo(size * qfs, 6)
          const top = markerLabelTop(m, qfs, true, true)
          if (top === null) throw new Error(`no label inside (${where})`)
          expect(p.top + top + labelBoxHeight(m, qfs, true) / 2, where).toBeCloseTo(center, 6)
          expect(p.top, where).toBeGreaterThan(0)
          expect(p.top + p.height, where).toBeLessThan(PH * qfs)
        }
      }
    }
    // The lamp beside line 1: its crest's tip 0.74·qfs below the paper's top edge.
    const [first] = placeMarkers([rubMarker(106, 1)], 30, true, true, false, true).placed
    expect((first?.top ?? 0) / 30).toBeCloseTo(0.74, 2)
    // Without decor the label's ink centre is on the line too, the ۞ above it as a crest is: decor arriving late moves
    // no label. Then the marks continue under the label.
    for (const qfs of [18, 30, 160]) {
      for (const n of [105, 109, 106]) {
        const m = rubMarker(n, 8)
        const label = labelBoxHeight(m, qfs, true)
        const { placed, stacks } = placeMarkers([m], qfs, marginLabelsVisible(qfs), false, false, true)
        const top = placed[0]?.top ?? 0
        const glyph = markerGlyphBox(qfs, INK.rub).height
        expect(top + glyph + LABEL_GAP * qfs + label / 2, `rub ${n} at qfs ${qfs}`).toBeCloseTo(
          lineCenterY(qfs, 8),
          6,
        )
        expect(stacks.get(8)?.bottom).toBeCloseTo(lineCenterY(qfs, 8) + label / 2, 6)
        expect(top + glyph / 2, `rub ${n} at qfs ${qfs}`).toBeGreaterThan(lineCenterY(qfs, 7.5))
      }
    }
  })

  it('reaches into the page bookmark’s dog-ear only with the line-1 lamp’s finial, which is drawn over its flap', () => {
    // The lamp beside line 1 starts 0.74·qfs below the paper's top, inside the 1.2·qfs dog-ear at the outer corner.
    // On its axis, in the middle of the outer margin, that is on the flap's side of the fold (the flap covers the
    // points whose distances from the outer edge and the top sum to more than DOG_EAR), never the cut-away corner,
    // which shows the canvas: frame.css draws the ornament's ink over the flap.
    const [lamp] = placeMarkers([rubMarker(106, 1)], 18, false, true, false, true).placed
    const top = (lamp?.top ?? 0) / 18
    expect(top).toBeLessThan(DOG_EAR)
    expect(M_OUT / 2 + top).toBeGreaterThan(DOG_EAR)
    // The medallions on line 1 stay below it.
    for (const n of [105, 109]) {
      const [medallion] = placeMarkers([rubMarker(n, 1)], 18, false, true, false, true).placed
      expect((medallion?.top ?? 0) / 18).toBeGreaterThan(DOG_EAR)
    }
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
    const { placed, stacks } = placeMarkers(pageMarkers(data), q, true)
    expect(placed).toHaveLength(2)
    const [a, b] = placed
    if (!a || !b) throw new Error('two markers')
    expect(b.top - (a.top + a.height)).toBeCloseTo(STACK_GAP * q)
    expect((a.top + b.top + b.height) / 2).toBeCloseTo(lineCenterY(q, 7))
    expect(stacks.get(7)).toEqual({ top: a.top, bottom: b.top + b.height })
  })

  it('places marks after the markers of their line, or centred on a line without markers', () => {
    const q = 30
    const marks = [
      { key: 'bookmark-1', kind: 'bookmark' as const, ayahId: 1, line: 3, id: 'b1' },
      { key: 'note-n', kind: 'note' as const, ayahId: 2, line: 5, id: 'n' },
    ]
    const placed = placeMarks(marks, q, new Map([[3, { top: 180, bottom: 200 }]]))
    expect(placed[0]?.top).toBeCloseTo(200 + STACK_GAP * q)
    expect((placed[1]?.top ?? 0) + (placed[1]?.height ?? 0) / 2).toBeCloseTo(lineCenterY(q, 5))
  })

  /** A bookmark (and a note) on `line`: the marks of one ayah. */
  const marksOn = (line: number, note = false) => [
    { key: `bookmark-${line}`, kind: 'bookmark' as const, ayahId: line * 10, line, id: `b${line}` },
    ...(note
      ? [{ key: `note-${line}`, kind: 'note' as const, ayahId: line * 10, line, id: `n${line}` }]
      : []),
  ]
  /** The rub start of `kind` on `line` (and the sajda that ends there), as the page's markers. */
  const division = (kind: 'quarter' | 'hizb' | 'juz', line: number, sajda = false) => {
    const flags = kind === 'juz' ? 7 : kind === 'hizb' ? 3 : 1
    const rub = kind === 'juz' ? 105 : kind === 'hizb' ? 109 : 106
    return pageMarkers(
      page(300, [
        ...(sajda
          ? [ayah({ id: 1999, line: line - 1, sajda: 'recommended' as const, lastWordId: line * 100 + 2 })]
          : []),
        ayah({ id: 2000, line, flags, rub, hizb: Math.ceil(rub / 4), juz: Math.ceil(rub / 8) }),
      ]),
    )
  }
  /** The overlap in px of two boxes (negative: the gap between them). */
  const overlap = (a: { top: number; height: number }, b: { top: number; height: number }) =>
    Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top)

  it('starts the marks of a line below a marker stack that reaches into it from the line above', () => {
    // Page 262: the juz 14 start on line 3, its medallion hanging 2.24·qfs below the line, and a bookmark on line 4.
    const q = 30
    const { stacks } = placeMarkers(division('juz', 3), q, true, true, false, true)
    const below = stacks.get(3)?.bottom
    if (below === undefined) throw new Error('a marker on line 3')
    const [bookmark] = marksOn(4)
    if (!bookmark) throw new Error('a bookmark')
    // Centred on line 4, the bookmark would start above the stack's bottom.
    expect(lineCenterY(q, 4) - (MARK_BOOKMARK * q) / 2).toBeLessThan(below)
    expect(placeMarks([bookmark], q, stacks)[0]?.top).toBeCloseTo(below + STACK_GAP * q)
    // A stack that ends within its own line leaves the next line's marks centred.
    const short = placeMarks([bookmark], q, new Map([[3, { top: 0, bottom: lineCenterY(q, 3) + q }]]))[0]
    expect((short?.top ?? 0) + (short?.height ?? 0) / 2).toBeCloseTo(lineCenterY(q, 4))
  })

  it('keeps the marks of a medallion’s line and of the next line apart, in line order, at every size', () => {
    // Pages 531 and 262: a bookmark on the hizb or juz start (55:1, 15:1) and on the next line's ayah (55:5, 15:3).
    for (const kind of ['hizb', 'juz'] as const) {
      for (const qfs of [18, 24, 30, 60]) {
        const { stacks } = placeMarkers(division(kind, 7), qfs, marginLabelsVisible(qfs), true, false, true)
        const [own, next] = placeMarks([...marksOn(7), ...marksOn(8)], qfs, stacks)
        if (!own || !next) throw new Error('two marks')
        const where = `${kind} at qfs ${qfs}`
        expect(own.top, where).toBeCloseTo((stacks.get(7)?.bottom ?? 0) + STACK_GAP * qfs)
        expect(next.top, where).toBeCloseTo(own.top + own.height + STACK_GAP * qfs)
      }
    }
  })

  it('moves the marks of the line above a lamp or a medallion off its crest, to the nearer side', () => {
    // Pages 529 and 536: a bookmark on the line above a quarter's lamp (54:7 over 54:9, 56:73 over 56:75).
    for (const kind of ['quarter', 'hizb', 'juz'] as const) {
      for (const qfs of [18, 30]) {
        const { placed, stacks } = placeMarkers(
          division(kind, 8),
          qfs,
          marginLabelsVisible(qfs),
          true,
          false,
          true,
        )
        const [marker] = placed
        const [mark] = placeMarks(marksOn(7), qfs, stacks)
        if (!marker || !mark) throw new Error('a marker and a mark')
        const where = `${kind} at qfs ${qfs}`
        // Centred on its line it would sit in the crest; it ends 0.2·qfs above the ornament instead (the nearer side).
        const centred = { top: lineCenterY(qfs, 7) - mark.height / 2, height: mark.height }
        expect(overlap(centred, marker), where).toBeGreaterThan(0)
        expect(mark.top + mark.height, where).toBeCloseTo(marker.top - STACK_GAP * qfs)
      }
    }
    // Where the line above has its own marks above that, they make room (page 536: 56:71 on line 12, 56:73 on 13).
    const q = 30
    const { placed, stacks } = placeMarkers(division('quarter', 14), q, true, true, false, true)
    const lamp = placed[0]
    const [twelve, thirteen] = placeMarks([...marksOn(12), ...marksOn(13)], q, stacks)
    if (!lamp || !twelve || !thirteen) throw new Error('a lamp and two marks')
    expect(thirteen.top + thirteen.height).toBeCloseTo(lamp.top - STACK_GAP * q)
    expect(twelve.top + twelve.height).toBeCloseTo(thirteen.top - STACK_GAP * q)
    // Still beside its own line.
    expect(Math.abs(twelve.top + twelve.height / 2 - lineCenterY(q, 12))).toBeLessThan((LH / 2) * q)
  })

  it('never draws a mark over a marker or another mark, nor above the dog-ear, on any line, at every size', () => {
    // Every ornament (alone, or over the sajda that ends on its line), and the ۞ without decor, on every line, with a
    // bookmark, a bookmark and a note, or nothing on each of the two lines above and below it and on its own.
    const problems: string[] = []
    const kinds = [
      ['quarter', false],
      ['hizb', false],
      ['juz', false],
      ['quarter', true],
      ['hizb', true],
    ] as const
    for (const qfs of [18, 30, 60]) {
      for (const [kind, sajda] of kinds) {
        for (let line = sajda ? 2 : 1; line <= 15; line++) {
          for (const decor of [true, false]) {
            const { placed, stacks } = placeMarkers(
              division(kind, line, sajda),
              qfs,
              marginLabelsVisible(qfs),
              decor,
              false,
              true,
            )
            for (let pattern = 0; pattern < 3 ** 5; pattern++) {
              const marks = [-2, -1, 0, 1, 2].flatMap((d, i) => {
                const n = Math.floor(pattern / 3 ** i) % 3
                const l = line + d
                return n === 0 || l < 1 || l > 15 ? [] : marksOn(l, n === 2)
              })
              const out = placeMarks(marks, qfs, stacks)
              const where = `${kind}${sajda ? '+sajda' : ''} line ${line}, qfs ${qfs}, decor ${decor}, marks ${pattern}`
              for (const [i, m] of out.entries()) {
                if (m.top < DOG_EAR * qfs - 1e-6) problems.push(`${where}: ${m.item.key} above the dog-ear`)
                for (const p of placed)
                  if (overlap(m, p) > -STACK_GAP * qfs + 1e-6)
                    problems.push(`${where}: ${m.item.key} over the ${p.item.kind} marker`)
                const prev = out[i - 1]
                if (prev && m.top < prev.top + prev.height + STACK_GAP * qfs - 1e-6)
                  problems.push(`${where}: ${m.item.key} over ${prev.item.key}, or out of line order`)
              }
            }
          }
        }
      }
    }
    expect(problems.slice(0, 10)).toEqual([])
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

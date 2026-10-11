/**
 * Highlight geometry (§8.7, §12.5): `measure`, `ayahPills`, `wordPill` and the one-fill-per-word plan. Boxes are
 * synthetic (qfs 20, LH 35 px): three lines of a 330 px text block, with ayah ids chosen so pills cross ayah boundaries,
 * line ends and a centred line.
 */
import { describe, expect, it } from 'vitest'
import type { Rect, WordBox } from '$lib/contracts/components'
import { LH, TB_W } from './geometry'
import {
  ayahPills,
  boxOf,
  HL_OUTSET,
  type HighlightState,
  lineBoxes,
  measure,
  PILL,
  planHighlights,
  wordPill,
} from './layout'
import { STYLE_METRICS } from './metrics'
import { UNICODE_FIT } from './unicodeFit'

const QFS = 20
const lh = LH * QFS
const blockW = TB_W * QFS
const half = PILL.halfBand * lh

/** A word on `line` (1-based) at `x` px wide `w`, centred vertically in its line box. */
function box(id: number, ayahId: number, line: number, x: number, w: number): WordBox {
  const h = QFS
  return { id, ayahId, line, x, y: (line - 1) * lh + (lh - h) / 2, w, h }
}

const cyOf = (line: number) => (line - 1) * lh + lh / 2

// Line 1 (justified, flush at both edges): ayah 11 on the right (read first), ayah 10 on the left.
// Line 2: ayahs 11 → 12 → 13.  Line 3 (centred): ayah 13 only.
const BOXES: WordBox[] = [
  box(1, 10, 1, 0, 60),
  box(2, 10, 1, 70, 50),
  box(3, 11, 1, 130, 90),
  box(4, 11, 1, 230, 100),
  box(5, 13, 2, 0, 80),
  box(6, 12, 2, 100, 100),
  box(7, 11, 2, 220, 110),
  box(8, 13, 3, 120, 40),
  box(9, 13, 3, 170, 40),
]

const STATE: HighlightState = {
  user: [],
  search: null,
  selection: null,
  hoverAyahId: null,
  audioAyahId: null,
  flashAyahId: null,
  cursorAyahId: null,
}

const geom = { qfs: QFS, lh, blockW }
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6)

describe('lineBoxes', () => {
  it('groups by line, sorts left to right and takes the median centre', () => {
    const lines = lineBoxes([...BOXES].reverse())
    expect(lines.map((l) => l.line)).toEqual([1, 2, 3])
    expect(lines[0]?.words.map((w) => w.id)).toEqual([1, 2, 3, 4])
    for (const l of lines) close(l.cy, cyOf(l.line))
  })
})

describe('ayahPills (§8.7)', () => {
  it('spans the range on each line in the 0.76·LH band, radius 0.28·qfs', () => {
    const [p1, p2, ...rest] = ayahPills(BOXES, 11, 11, lh, blockW)
    expect(rest).toEqual([])
    if (!p1 || !p2) throw new Error('two pills expected')
    // Line 1: from the half gap to ayah 10 (120 → 130 ⇒ 125) to the edge pad past the last word.
    close(p1.x, 125)
    close(p1.x + p1.w, 330 + PILL.edgePad * QFS)
    close(p1.y, cyOf(1) - half)
    close(p1.h, 0.76 * lh)
    close(p1.y - 0, 0.12 * lh)
    close(p1.r, 0.28 * QFS)
    // Line 2: ayah 11 starts the line on the right; its left neighbour is ayah 12 (200 → 220 ⇒ 210).
    close(p2.x, 210)
    close(p2.x + p2.w, 330 + PILL.edgePad * QFS)
  })

  it('pads a centred line by the edge pad instead of running to the block edge', () => {
    const [p] = ayahPills(BOXES, 13, 13, lh, blockW).filter((r) => r.y > 2 * lh)
    if (!p) throw new Error('no line-3 pill')
    close(p.x, 120 - PILL.edgePad * QFS)
    close(p.x + p.w, 210 + PILL.edgePad * QFS)
  })

  it('never extends further than maxExtend towards a distant neighbour', () => {
    const sparse = [box(1, 1, 1, 0, 20), box(2, 2, 1, 300, 30)]
    const [p] = ayahPills(sparse, 2, 2, lh, blockW)
    close(p?.x ?? NaN, 300 - PILL.maxExtend * QFS)
  })

  it('covers a range across ayahs as one pill per line, and stays inside the outset layer', () => {
    const pills = ayahPills(BOXES, 10, 13, lh, blockW)
    expect(pills).toHaveLength(3)
    for (const p of pills) {
      expect(p.x).toBeGreaterThanOrEqual(-HL_OUTSET * QFS)
      expect(p.x + p.w).toBeLessThanOrEqual(blockW + HL_OUTSET * QFS)
    }
    close(pills[0]?.x ?? NaN, -PILL.edgePad * QFS)
  })

  it('is empty for a range with no word on the page', () => {
    expect(ayahPills(BOXES, 500, 600, lh, blockW)).toEqual([])
    expect(ayahPills([], 1, 6236, lh, blockW)).toEqual([])
  })
})

describe('wordPill (§8.7)', () => {
  it('pads the word box by 0.10·qfs, uses the line band and radius 0.24·qfs', () => {
    const b = box(3, 11, 1, 130, 90)
    const p = wordPill(b, QFS, lh)
    close(p.x, 130 - 0.1 * QFS)
    close(p.w, 90 + 0.2 * QFS)
    close(p.y, cyOf(1) - half)
    close(p.h, 0.76 * lh)
    close(p.r, 0.24 * QFS)
  })
})

/** Which fills paint under each word's glyph (its box centre): §8.7 allows at most one. */
function fillsUnder(plan: ReturnType<typeof planHighlights>, w: WordBox): string[] {
  const cx = w.x + w.w / 2
  const cy = w.y + w.h / 2
  return plan.fills
    .filter((f) => cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h)
    .map((f) => f.kind)
}

/** Whether two rects overlap by more than a hair (shared edges are fine). */
const overlaps = (a: Rect, b: Rect) =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.01 &&
  Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.01

describe('planHighlights (§8.7)', () => {
  it('draws nothing without a state', () => {
    expect(planHighlights(BOXES, STATE, geom)).toEqual({ fills: [], rings: [], bars: [] })
  })

  it('draws user highlights as ayah pills in their colour', () => {
    const plan = planHighlights(
      BOXES,
      { ...STATE, user: [{ id: 'h1', fromAyahId: 11, toAyahId: 11, color: 'yellow' }] },
      geom,
    )
    expect(plan.fills.map((f) => [f.kind, f.color])).toEqual([
      ['user', 'yellow'],
      ['user', 'yellow'],
    ])
    expect(plan.fills.map(({ x, y, w, h, r }) => ({ x, y, w, h, r }))).toEqual(
      ayahPills(BOXES, 11, 11, lh, blockW),
    )
    expect(plan.bars).toEqual([])
  })

  it('demotes a user highlight under a state fill to a bar at the bottom of the band', () => {
    const plan = planHighlights(
      BOXES,
      {
        ...STATE,
        user: [{ id: 'h1', fromAyahId: 11, toAyahId: 12, color: 'green' }],
        selection: { fromAyahId: 11, toAyahId: 11 },
      },
      geom,
    )
    // Ayah 11 is selected: selection fills; ayah 12 keeps its green fill.
    expect(plan.fills.map((f) => f.kind).sort()).toEqual(['selection', 'selection', 'user'])
    expect(plan.bars.map((b) => [b.kind, b.color])).toEqual([
      ['user-bar', 'green'],
      ['user-bar', 'green'],
    ])
    for (const bar of plan.bars) {
      close(bar.h, PILL.userBar * QFS)
      close(bar.r, bar.h / 2)
    }
    const [bar1] = plan.bars
    close((bar1?.y ?? 0) + (bar1?.h ?? 0), cyOf(1) + half)
    // The ring outlines the full selection pills.
    expect(plan.rings.map((r) => r.kind)).toEqual(['selection-ring', 'selection-ring'])
    expect(plan.rings.map(({ x, y, w, h, r }) => ({ x, y, w, h, r }))).toEqual(
      ayahPills(BOXES, 11, 11, lh, blockW),
    )
  })

  it('keeps at most one fill under every word for any combination of states', () => {
    const states: HighlightState[] = []
    for (const sel of [null, { fromAyahId: 10, toAyahId: 12 }])
      for (const audio of [null, 11, 12])
        for (const hover of [null, 10, 11, 13])
          for (const search of [null, { ayahId: 11, wordIds: [3] }, { ayahId: 13, wordIds: [8, 9] }])
            states.push({
              ...STATE,
              user: [
                { id: 'a', fromAyahId: 10, toAyahId: 11, color: 'blue' },
                { id: 'b', fromAyahId: 13, toAyahId: 13, color: 'purple' },
              ],
              selection: sel,
              audioAyahId: audio,
              hoverAyahId: hover,
              search,
              flashAyahId: null,
            })
    expect(states.length).toBe(72)
    for (const s of states) {
      const plan = planHighlights(BOXES, s, geom)
      for (const w of BOXES) expect(fillsUnder(plan, w).length, JSON.stringify(s)).toBeLessThanOrEqual(1)
      // Fills never overlap one another (shared edges only), so no glyph ink sits on two fills.
      for (const [i, a] of plan.fills.entries())
        for (const b of plan.fills.slice(i + 1)) expect(overlaps(a, b), `${a.key} × ${b.key}`).toBe(false)
    }
  })

  it('orders state fills: search > audio > flash > selection > user > hover', () => {
    const at = (s: Partial<HighlightState>, wordId: number) => {
      const w = BOXES.find((b) => b.id === wordId)
      if (!w) throw new Error('no word')
      return fillsUnder(planHighlights(BOXES, { ...STATE, ...s }, geom), w)
    }
    const user = [{ id: 'u', fromAyahId: 11, toAyahId: 11, color: 'red' as const }]
    expect(at({ user, hoverAyahId: 11 }, 3)).toEqual(['user'])
    expect(at({ hoverAyahId: 11 }, 3)).toEqual(['hover'])
    expect(at({ user, selection: { fromAyahId: 11, toAyahId: 11 } }, 3)).toEqual(['selection'])
    expect(at({ selection: { fromAyahId: 11, toAyahId: 11 }, flashAyahId: 11 }, 3)).toEqual(['flash'])
    expect(at({ flashAyahId: 11, audioAyahId: 11 }, 3)).toEqual(['audio'])
    expect(at({ audioAyahId: 11, search: { ayahId: 11, wordIds: [3] } }, 3)).toEqual(['search'])
    expect(at({ audioAyahId: 11, search: { ayahId: 11, wordIds: [3] } }, 4)).toEqual(['audio'])
  })

  it('draws search hits as word pills with an underline, and butts the ayah fill against them', () => {
    const plan = planHighlights(
      BOXES,
      { ...STATE, search: { ayahId: 13, wordIds: [8, 9] }, audioAyahId: 13 },
      geom,
    )
    const search = plan.fills.filter((f) => f.kind === 'search')
    // Consecutive hit words share one pill: 120…210 padded by 0.10·qfs.
    expect(search).toHaveLength(1)
    close(search[0]?.x ?? NaN, 120 - 0.1 * QFS)
    close((search[0]?.x ?? 0) + (search[0]?.w ?? 0), 210 + 0.1 * QFS)
    close(search[0]?.r ?? NaN, 0.24 * QFS)
    const underline = plan.bars.filter((b) => b.kind === 'search-bar')
    expect(underline).toHaveLength(1)
    close(underline[0]?.h ?? NaN, PILL.searchBar * QFS)
    // Line 2 ayah 13 is all audio; line 3 is all search, so audio has no fill there.
    expect(plan.fills.filter((f) => f.kind === 'audio').every((f) => f.y < 2 * lh)).toBe(true)
  })

  it('splits an ayah fill around a hit word at the hit pill edges', () => {
    const plan = planHighlights(
      BOXES,
      { ...STATE, search: { ayahId: 11, wordIds: [3] }, selection: { fromAyahId: 11, toAyahId: 11 } },
      geom,
    )
    const line1 = plan.fills.filter((f) => f.y < lh)
    const sel = line1.filter((f) => f.kind === 'selection')
    const hit = line1.find((f) => f.kind === 'search')
    expect(sel).toHaveLength(1)
    if (!hit || !sel[0]) throw new Error('fills expected')
    // The selection fill on line 1 starts where the hit pill ends (220 + 2 = 222).
    close(sel[0].x, hit.x + hit.w)
  })

  it('draws the cursor ring around the cursor ayah only when asked', () => {
    expect(planHighlights(BOXES, { ...STATE, cursorAyahId: 12 }, geom).rings.map((r) => r.kind)).toEqual([
      'cursor-ring',
    ])
  })

  it('keeps stable keys for unchanged shapes', () => {
    const s = { ...STATE, selection: { fromAyahId: 11, toAyahId: 11 }, hoverAyahId: 13 }
    const a = planHighlights(BOXES, s, geom)
    const b = planHighlights(BOXES, { ...s, hoverAyahId: 12 }, geom)
    const keys = (p: typeof a) => p.fills.filter((f) => f.kind === 'selection').map((f) => f.key)
    expect(keys(b)).toEqual(keys(a))
    expect(new Set(a.fills.map((f) => f.key)).size).toBe(a.fills.length)
  })
})

describe('bars sit below the glyphs (§8.7: page + at most one fill under the ink)', () => {
  it.each([
    ...Object.entries(STYLE_METRICS),
    ['the largest Unicode spread scale', { glyphScale: UNICODE_FIT.max }] as const,
  ])('%s: the bar tops clear the em box', (_style, { glyphScale }) => {
    const emBottom = (glyphScale * QFS) / 2 // below the line centre
    const userBarTop = half - PILL.userBar * QFS
    const searchBarTop = half - PILL.searchBar * QFS
    expect(userBarTop).toBeGreaterThanOrEqual(emBottom)
    expect(searchBarTop).toBeGreaterThanOrEqual(emBottom)
  })
})

describe('boxOf', () => {
  it('finds the box of a word id', () => {
    expect(boxOf(BOXES, 6)?.ayahId).toBe(12)
    expect(boxOf(BOXES, 99)).toBeUndefined()
  })
})

describe('measure (§8.7)', () => {
  /** A fake rendition: `.ln[data-l] > .lw > .w[data-w][data-a]` with fixed client rects. */
  function rendition(scale = 1) {
    const block = document.createElement('div')
    const layer = document.createElement('div')
    block.append(layer)
    Object.defineProperty(block, 'offsetWidth', { value: 330 })
    Object.defineProperty(block, 'offsetHeight', { value: 525 })
    block.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 100, y: 50, width: 330 * scale, height: 525 * scale })
    for (const b of BOXES) {
      let ln = layer.querySelector<HTMLElement>(`.ln[data-l="${b.line}"]`)
      if (!ln) {
        ln = document.createElement('div')
        ln.className = 'ln'
        ln.dataset.l = String(b.line)
        ln.append(Object.assign(document.createElement('div'), { className: 'lw' }))
        layer.append(ln)
      }
      const span = document.createElement('span')
      span.className = b.id === 4 ? 'w e' : 'w'
      span.dataset.w = String(b.id)
      span.dataset.a = String(b.ayahId)
      span.getBoundingClientRect = () =>
        DOMRect.fromRect({
          x: 100 + b.x * scale,
          y: 50 + b.y * scale,
          width: b.w * scale,
          height: b.h * scale,
        })
      ln.querySelector('.lw')?.append(span)
    }
    // A header line without word spans is skipped.
    const header = Object.assign(document.createElement('div'), { className: 'ln' })
    header.dataset.l = '4'
    layer.append(header)
    return { block, layer }
  }

  it('returns every word box relative to the block, end markers included', () => {
    const { block, layer } = rendition()
    const boxes = measure(layer, block)
    expect(boxes.map((b) => b.id).sort((a, b) => a - b)).toEqual(BOXES.map((b) => b.id))
    for (const b of boxes) {
      const want = BOXES.find((x) => x.id === b.id)
      expect(b).toEqual(want)
    }
  })

  it('divides out an ancestor scale (CSS zoom, a view transition)', () => {
    const { block, layer } = rendition(1.5)
    for (const b of measure(layer, block)) {
      const want = BOXES.find((x) => x.id === b.id)
      if (!want) throw new Error('unexpected box')
      close(b.x, want.x)
      close(b.w, want.w)
      close(b.y, want.y)
    }
  })

  it('returns nothing for a rendition that is not laid out', () => {
    const { block, layer } = rendition()
    block.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 })
    expect(measure(layer, block)).toEqual([])
  })
})

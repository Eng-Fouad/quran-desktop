/**
 * The word window of a Quran hit: ±12 whole words around the first match, fitted to three lines with a
 * measurer, the cut edges and the matches left out ("+N more in this ayah").
 */
import { describe, expect, it } from 'vitest'
import { countLines, hitWindow, LEAD, type LineFit, matchedIndices, WINDOW_RADIUS } from './window'

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`)
/** Every word 40 px, spaces 5 px, lines of 200 px: four words a line (4 × 40 + 3 × 5 = 175; a fifth needs 220). */
const fit: LineFit = { measure: () => 40, space: 5, lineWidth: 200, maxLines: 3 }

describe('matchedIndices', () => {
  it('maps word ids into the words, sorted, without duplicates or strays', () => {
    expect(matchedIndices(100, 5, [103, 101, 101, 99, 105, 104])).toEqual([1, 3, 4])
    expect(matchedIndices(100, 5, [])).toEqual([])
  })
})

describe('countLines', () => {
  it('wraps greedily like the browser', () => {
    expect(countLines(words(4), 0, 4, fit)).toBe(1)
    expect(countLines(words(5), 0, 5, fit)).toBe(2)
    expect(countLines(words(12), 0, 12, fit)).toBe(3)
    expect(countLines(words(13), 0, 13, fit)).toBe(4)
    expect(countLines(words(3), 1, 1, fit)).toBe(0)
    // A word wider than the line takes a line of its own.
    const wide: LineFit = { ...fit, measure: (w) => (w === 'w1' ? 500 : 40) }
    expect(countLines(words(3), 0, 3, wide)).toBe(3)
  })
})

describe('hitWindow without a measurer', () => {
  it('shows ±12 words around the first match', () => {
    const w = hitWindow(words(40), [20, 22])
    expect(w).toEqual({
      start: 20 - WINDOW_RADIUS,
      end: 20 + WINDOW_RADIUS + 1,
      cutBefore: true,
      cutAfter: true,
      hiddenMatches: 0,
    })
  })

  it('shows a short ayah whole', () => {
    expect(hitWindow(words(9), [4])).toEqual({
      start: 0,
      end: 9,
      cutBefore: false,
      cutAfter: false,
      hiddenMatches: 0,
    })
  })

  it('counts the matches outside the window', () => {
    const w = hitWindow(words(60), [5, 6, 30, 45])
    expect(w.start).toBe(0)
    expect(w.end).toBe(18)
    expect(w.hiddenMatches).toBe(2)
  })

  it('starts at the ayah when nothing matched', () => {
    expect(hitWindow(words(30), [])).toMatchObject({ start: 0, end: 13, cutBefore: false, cutAfter: true })
  })
})

describe('hitWindow fitted to lines', () => {
  it('keeps a window that fits whole', () => {
    expect(hitWindow(words(12), [6], fit)).toEqual({
      start: 0,
      end: 12,
      cutBefore: false,
      cutAfter: false,
      hiddenMatches: 0,
    })
  })

  it('puts the match on the first line with a short lead, then fills three lines', () => {
    const w = hitWindow(words(40), [20], fit)
    // Lead: at most 40 % of 200 px = 80 px, one word (45 px with its space).
    expect(LEAD * fit.lineWidth).toBe(80)
    expect(w.start).toBe(19)
    expect(w.end).toBe(31)
    expect(countLines(words(40), w.start, w.end, fit)).toBe(3)
    expect(w.cutBefore && w.cutAfter).toBe(true)
  })

  it('gives the room left at the end of the ayah back to the lead', () => {
    const w = hitWindow(words(24), [21], fit)
    expect(w.end).toBe(24)
    expect(w.cutAfter).toBe(false)
    expect(countLines(words(24), w.start, w.end, fit)).toBe(3)
    expect(w.start).toBe(12)
  })

  it('never goes further than 12 words from the match', () => {
    const roomy: LineFit = { ...fit, lineWidth: 10_000 }
    const w = hitWindow(words(100), [50], roomy)
    expect(w.start).toBe(50 - WINDOW_RADIUS)
    expect(w.end).toBe(50 + WINDOW_RADIUS + 1)
  })

  it('shows at least the matched word', () => {
    const narrow: LineFit = { ...fit, lineWidth: 30, maxLines: 1 }
    const w = hitWindow(words(10), [5], narrow)
    expect(w.start).toBe(5)
    expect(w.end).toBe(6)
  })
})

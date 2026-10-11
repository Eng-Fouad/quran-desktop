/**
 * The per-spread glyph scale of the Unicode renditions (§8.2, §8.4; unicodeFit.ts): the demand of a page from its
 * line data, the scale of a spread (floor, cap, two decimals, the opening pages), and the fallbacks without a canvas.
 */
import { describe, expect, it } from 'vitest'
import type { PageData } from '$lib/ipc/bindings'
import { OPENING_INSET, TB_W } from './geometry'
import { STYLE_METRICS } from './metrics'
import {
  demandOf,
  pageDemand,
  scaleFor,
  UNICODE_FIT,
  UNICODE_GAP,
  unicodeScale,
  unicodeText,
} from './unicodeFit'

type Lines = Pick<PageData, 'page' | 'style' | 'lines'>

/** A page whose ayah lines hold words of the given advances (the word text is its advance, for `advance`). */
function pageOf(page: number, lines: { words: number[]; centered?: boolean }[], style = 'hafs'): Lines {
  return {
    page,
    style: style as PageData['style'],
    lines: lines.map((l, i) => ({
      line: i + 1,
      kind: 'ayah',
      centered: l.centered ?? false,
      words: l.words.map((w, j) => ({
        id: i * 100 + j,
        ayahId: 1,
        surah: 1,
        ayah: 1,
        position: j + 1,
        isEnd: false,
        glyph: String(w),
        text: `t${w}`,
      })),
    })) as PageData['lines'],
  }
}

const advance = (text: string) => Number(text.replace(/^t/, ''))

describe('the demand of a page', () => {
  it('is the widest ayah line, words plus the 0.22 em minimum gaps, over the 16.5 qfs line box', () => {
    const page = pageOf(50, [{ words: [3, 3, 3] }, { words: [4, 4, 4, 4] }, { words: [2], centered: true }])
    const d = demandOf(page, advance)
    expect(UNICODE_GAP).toBe(STYLE_METRICS.hafs.centerGap)
    expect(d.ratio).toBeCloseTo((16 + 3 * UNICODE_GAP) / TB_W, 10)
    expect(d.justified).toBe(true)
  })

  it('counts centred lines too, and the opening pages’ lines against their 12.1 qfs inset box', () => {
    const d = demandOf(pageOf(1, [{ words: [5, 5], centered: true }]), advance)
    expect(d.ratio).toBeCloseTo((10 + UNICODE_GAP) / (TB_W - 2 * OPENING_INSET), 10)
    expect(d.justified).toBe(false)
  })

  it('skips lines without words (headers, basmalas)', () => {
    expect(demandOf(pageOf(50, [{ words: [] }]), advance)).toEqual({ ratio: 0, justified: false })
  })

  it('measures what each rendition draws: the hafs glyph, else the Unicode text', () => {
    const word = { glyph: 'g', text: 't' }
    expect(unicodeText({ style: 'hafs' }, word)).toBe('g')
    expect(unicodeText({ style: 'qcf_v2' }, word)).toBe('t')
    const seen: string[] = []
    demandOf(pageOf(50, [{ words: [1, 2] }], 'qcf_v1'), (t) => (seen.push(t), 1))
    expect(seen).toEqual(['t1', 't2'])
  })
})

describe('the scale of a spread', () => {
  const fill = UNICODE_FIT.fill

  it('fits the widest line of the spread to 98 % of its box, floored to two decimals', () => {
    // 0.98 / 1.1 = 0.8909… → 0.89; the facing page's wider line decides for both.
    expect(
      scaleFor([
        { ratio: 1.0, justified: true },
        { ratio: 1.1, justified: true },
      ]),
    ).toBe(0.89)
    // 0.98 / 1.12 = 0.875 → 0.87.
    expect(scaleFor([{ ratio: 1.12, justified: true }])).toBe(0.87)
  })

  it('stays within the floor (the global measured scale) and the cap', () => {
    expect(UNICODE_FIT.min).toBe(STYLE_METRICS.hafs.glyphScale)
    expect(UNICODE_FIT.max).toBe(0.92)
    expect(scaleFor([{ ratio: 0.5, justified: true }])).toBe(UNICODE_FIT.max)
    expect(scaleFor([{ ratio: 1.6, justified: true }])).toBe(UNICODE_FIT.min)
  })

  it('keeps the floor for a spread without a justified line (the opening pages) or with an unknown page', () => {
    expect(
      scaleFor([
        { ratio: 0.5, justified: false },
        { ratio: 0.6, justified: false },
      ]),
    ).toBe(UNICODE_FIT.min)
    expect(scaleFor([{ ratio: 1.0, justified: true }, null])).toBe(UNICODE_FIT.min)
    expect(scaleFor([])).toBe(UNICODE_FIT.min)
  })

  it('every line of a fitted spread then fits at --fit ≥ 0.98 without squeezing', () => {
    for (const ratio of [0.9, 1.0, 1.05, 1.1, 1.15, 1.19]) {
      const scale = scaleFor([{ ratio, justified: true }])
      if (scale > UNICODE_FIT.min) expect(ratio * scale).toBeLessThanOrEqual(fill + 1e-9)
    }
  })

  it('falls back to the floor where nothing can be measured (jsdom has no canvas)', () => {
    const page = pageOf(50, [{ words: [3, 3] }]) as PageData
    expect(pageDemand(page)).toBeNull()
    expect(unicodeScale([page])).toBe(UNICODE_FIT.min)
  })
})

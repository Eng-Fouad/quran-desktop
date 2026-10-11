/**
 * Page navigation affordances, pure parts (§8.11, §8.12; WP8f): the rail's book-order geometry, label thinning, keys
 * and reveal zone; the page label shared by the rail and the FlipHUD (on the mock's real index); the turn zones'
 * geometry; the Arabic genitive ordinals and the division starts of the arrival chip.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '$lib/contracts/settings'
import { api, call, initIpc } from '$lib/ipc'
import type { Division } from '$lib/ipc/bindings'
import { state } from '$lib/ipc/mock/state'
import { app, i18n, quran, settings } from '$lib/stores'
import { LRI, PDI, RLI } from '$lib/stores/i18n.svelte'
import { arabicOrdinal, divisionStarts, isForwardStep } from './DivisionChip.svelte'
import {
  HOT_ZONE_PX,
  inRevealZone,
  isolatedRange,
  juzLabelled,
  juzLabelStep,
  pageAtFraction,
  pageAtX,
  pageLabel,
  railFraction,
  railKeyTarget,
  type RevealGeometry,
} from './PageRail.svelte'
import { CHEVRON, SCROLLBAR_CLEARANCE, ZONE_GAP, ZONE_W, zoneGeometry } from './PageTurnZones.svelte'

describe('rail geometry (book order, §8.11)', () => {
  it('puts page 1 at the right end and the last page at the left end', () => {
    expect(railFraction(1, 604)).toBe(0)
    expect(railFraction(604, 604)).toBe(1)
    expect(railFraction(302.5, 604)).toBeCloseTo(0.5, 6)
    expect(railFraction(0, 604)).toBe(0)
    expect(railFraction(900, 604)).toBe(1)
    expect(railFraction(Number.NaN, 604)).toBe(0)
    expect(railFraction(5, 1)).toBe(0)
  })

  it('maps fractions back to pages, rounded and clamped', () => {
    expect(pageAtFraction(0, 604)).toBe(1)
    expect(pageAtFraction(1, 604)).toBe(604)
    expect(pageAtFraction(-0.3, 604)).toBe(1)
    expect(pageAtFraction(1.7, 604)).toBe(604)
    expect(pageAtFraction(Number.NaN, 604)).toBe(1)
    for (const page of [1, 2, 261, 262, 297, 603, 604])
      expect(pageAtFraction(railFraction(page, 604), 604)).toBe(page)
  })

  it('reads the page under a pointer from the right edge of the track', () => {
    // A 603 px track starting at x = 100: one page per px, page 1 at x = 703 (the right edge).
    expect(pageAtX(703, 100, 603, 604)).toBe(1)
    expect(pageAtX(100, 100, 603, 604)).toBe(604)
    expect(pageAtX(703 - 261, 100, 603, 604)).toBe(262)
    expect(pageAtX(2000, 100, 603, 604)).toBe(1)
    expect(pageAtX(0, 100, 603, 604)).toBe(604)
    expect(pageAtX(300, 100, 0, 604)).toBe(1)
  })

  it('thins the juz labels so they never collide', () => {
    expect(juzLabelStep(1086)).toBe(1) // 36 px apart
    expect(juzLabelStep(600)).toBe(2) // 20 px → every other juz
    expect(juzLabelStep(300)).toBe(3)
    expect(juzLabelStep(150)).toBe(5)
    expect(juzLabelStep(0)).toBe(30)
    const labelled = (step: number) =>
      Array.from({ length: 30 }, (_, i) => i + 1).filter((n) => juzLabelled(n, step))
    expect(labelled(1)).toHaveLength(30)
    expect(labelled(2)).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29])
    expect(labelled(5)).toEqual([1, 5, 10, 15, 20, 25, 30])
    expect(labelled(10)).toEqual([1, 10, 20, 30])
  })

  it('takes ← as the next page and → as the previous one, Shift ×10, the juz keys and the ends', () => {
    const juz = [1, 22, 42, 62]
    expect(railKeyTarget('ArrowLeft', false, 262, 604, juz)).toBe(263)
    expect(railKeyTarget('ArrowRight', false, 262, 604, juz)).toBe(261)
    expect(railKeyTarget('ArrowLeft', true, 262, 604, juz)).toBe(272)
    expect(railKeyTarget('ArrowRight', true, 262, 604, juz)).toBe(252)
    expect(railKeyTarget('ArrowUp', false, 262, 604, juz)).toBe(263)
    expect(railKeyTarget('ArrowDown', false, 262, 604, juz)).toBe(261)
    expect(railKeyTarget('ArrowLeft', true, 600, 604, juz)).toBe(604)
    expect(railKeyTarget('ArrowRight', true, 4, 604, juz)).toBe(1)
    expect(railKeyTarget('Home', false, 262, 604, juz)).toBe(1)
    expect(railKeyTarget('End', false, 262, 604, juz)).toBe(604)
    expect(railKeyTarget('PageDown', false, 30, 604, juz)).toBe(42)
    expect(railKeyTarget('PageDown', false, 42, 604, juz)).toBe(62)
    expect(railKeyTarget('PageDown', false, 62, 604, juz)).toBe(604)
    expect(railKeyTarget('PageUp', false, 42, 604, juz)).toBe(22)
    expect(railKeyTarget('PageUp', false, 1, 604, juz)).toBe(1)
    expect(railKeyTarget('a', false, 262, 604, juz)).toBeNull()
    expect(railKeyTarget('Enter', false, 262, 604, juz)).toBeNull()
  })
})

describe('rail reveal zone (§8.11)', () => {
  // A 1000 px page area over an 800 px canvas; the book spans 200–800 with its frame's bottom edge at y = 650.
  const book = { left: 200, right: 800, frameBottom: 650 }
  const geo = (b: RevealGeometry['book'] = book): RevealGeometry => ({
    left: 0,
    right: 1000,
    top: 0,
    bottom: 800,
    book: b,
  })

  it('starts at the frame’s bottom edge (the page-number strip) and runs down to the canvas bottom', () => {
    expect(inRevealZone(500, 649, geo())).toBe(false)
    expect(inRevealZone(500, 650, geo())).toBe(true)
    expect(inRevealZone(500, 799, geo())).toBe(true)
    expect(inRevealZone(500, 800, geo())).toBe(false)
    expect(inRevealZone(500, 300, geo())).toBe(false)
  })

  it('spans the book, not the gutters beside it, while the bottom band spans the whole page area', () => {
    expect(inRevealZone(200, 700, geo())).toBe(true)
    expect(inRevealZone(800, 700, geo())).toBe(true)
    expect(inRevealZone(100, 700, geo())).toBe(false)
    expect(inRevealZone(900, 700, geo())).toBe(false)
    expect(HOT_ZONE_PX).toBe(24)
    expect(inRevealZone(100, 780, geo())).toBe(true)
    expect(inRevealZone(100, 776, geo())).toBe(true)
    expect(inRevealZone(100, 775, geo())).toBe(false)
    expect(inRevealZone(0, 790, geo())).toBe(true)
    expect(inRevealZone(1000, 790, geo())).toBe(true)
  })

  it('stays inside the page area (never over the side card column) and the canvas', () => {
    expect(inRevealZone(1100, 790, geo())).toBe(false)
    expect(inRevealZone(-1, 790, geo())).toBe(false)
    // A book wider than the page area (zoomed) is clipped to it.
    const wide = geo({ left: -400, right: 1400, frameBottom: 650 })
    expect(inRevealZone(10, 700, wide)).toBe(true)
    expect(inRevealZone(1050, 700, wide)).toBe(false)
    expect(inRevealZone(500, -10, geo({ left: 200, right: 800, frameBottom: -50 }))).toBe(false)
  })

  it('leaves only the bottom band with no book laid out or its frame below the canvas (zoomed)', () => {
    expect(inRevealZone(500, 700, geo(null))).toBe(false)
    expect(inRevealZone(500, 776, geo(null))).toBe(true)
    const below = geo({ left: 200, right: 800, frameBottom: 900 })
    expect(inRevealZone(500, 700, below)).toBe(false)
    expect(inRevealZone(500, 790, below)).toBe(true)
    const unknown = geo({ left: 200, right: 800, frameBottom: Number.NaN })
    expect(inRevealZone(500, 700, unknown)).toBe(false)
    expect(inRevealZone(500, 790, unknown)).toBe(true)
  })

  it('covers everything under a book zoomed out, across its width', () => {
    const small = geo({ left: 350, right: 650, frameBottom: 400 })
    expect(inRevealZone(500, 400, small)).toBe(true)
    expect(inRevealZone(500, 600, small)).toBe(true)
    expect(inRevealZone(300, 600, small)).toBe(false)
  })
})

describe('turn zones (§8.11)', () => {
  it('hugs the paper with a 16 px gap when there is room', () => {
    expect(zoneGeometry(128, 200)).toEqual({ start: 56, width: ZONE_W, chevron: CHEVRON, compact: false })
    const z = zoneGeometry(100, 180)
    expect(z?.start).toBe(100 - ZONE_GAP - ZONE_W)
  })

  it('sits at the canvas edge, narrowed to the free space, when there is less', () => {
    expect(zoneGeometry(63, 130)).toEqual({ start: 0, width: 56, chevron: 40, compact: false })
    expect(zoneGeometry(40, 90)).toEqual({ start: 0, width: 36, chevron: 32, compact: false })
    // Never over the paper: the zone ends at least 4 px before it.
    for (const free of [36, 40, 50, 60, 64, 72, 90, 200]) {
      const g = zoneGeometry(free, free + 60)
      expect(g && g.start + g.width).toBeLessThanOrEqual(free - 4)
    }
  })

  it('keeps clear of the overlay scrollbars at the canvas edge while the canvas scrolls', () => {
    expect(zoneGeometry(60, 130, SCROLLBAR_CLEARANCE)).toEqual({
      start: 12,
      width: 44,
      chevron: 40,
      compact: false,
    })
    expect(zoneGeometry(128, 200, SCROLLBAR_CLEARANCE)).toEqual(zoneGeometry(128, 200))
    for (const free of [40, 60, 90, 200]) {
      const g = zoneGeometry(free, free + 60, SCROLLBAR_CLEARANCE)
      expect(g?.start).toBeGreaterThanOrEqual(SCROLLBAR_CLEARANCE)
    }
  })

  it('keeps only a chevron over the outer margin when the free space is too narrow, never over the text', () => {
    const g = zoneGeometry(24, 74)
    expect(g?.compact).toBe(true)
    expect(g && g.start + g.width).toBeLessThanOrEqual(74 - 8)
    expect(zoneGeometry(24, 40)).toBeNull()
    expect(zoneGeometry(-30, 20)).toBeNull()
    expect(zoneGeometry(Number.NaN, 100)).toBeNull()
  })
})

describe('arrival chip (§8.12)', () => {
  it('writes the genitive ordinals that follow «بداية الجزء»', () => {
    expect(arabicOrdinal(1)).toBe('الأول')
    expect(arabicOrdinal(2)).toBe('الثاني')
    expect(arabicOrdinal(10)).toBe('العاشر')
    expect(arabicOrdinal(11)).toBe('الحادي عشر')
    expect(arabicOrdinal(12)).toBe('الثاني عشر')
    expect(arabicOrdinal(15)).toBe('الخامس عشر')
    expect(arabicOrdinal(20)).toBe('العشرين')
    expect(arabicOrdinal(21)).toBe('الحادي والعشرين')
    expect(arabicOrdinal(29)).toBe('التاسع والعشرين')
    expect(arabicOrdinal(30)).toBe('الثلاثين')
    expect(arabicOrdinal(41)).toBe('الحادي والأربعين')
    expect(arabicOrdinal(60)).toBe('الستين')
    expect(arabicOrdinal(0)).toBe('٠')
    expect(arabicOrdinal(100)).toBe('١٠٠')
  })

  it('lists juz and hizb starts in Mushaf order, a hizb that opens a juz as the juz', () => {
    const juz: Division[] = [
      { id: 1, firstAyahId: 1, lastAyahId: 148 },
      { id: 2, firstAyahId: 149, lastAyahId: 259 },
    ]
    const hizb: Division[] = [
      { id: 1, firstAyahId: 1, lastAyahId: 74 },
      { id: 2, firstAyahId: 75, lastAyahId: 148 },
      { id: 3, firstAyahId: 149, lastAyahId: 199 },
      { id: 4, firstAyahId: 200, lastAyahId: 259 },
    ]
    const starts = divisionStarts(juz, hizb, (id) => Math.ceil(id / 7))
    expect(starts.map((d) => `${d.kind}${d.n}@${d.page}`)).toEqual([
      'juz1@1',
      'hizb2@11',
      'juz2@22',
      'hizb4@29',
    ])
  })

  it('counts only a step to the next page or spread as reading forward', () => {
    expect(isForwardStep([279, 280], [281, 282])).toBe(true)
    expect(isForwardStep([261], [262])).toBe(true)
    expect(isForwardStep([281, 282], [279, 280])).toBe(false)
    expect(isForwardStep([1, 2], [281, 282])).toBe(false)
    expect(isForwardStep([261, 262], [262])).toBe(false)
    expect(isForwardStep([], [1, 2])).toBe(false)
  })
})

describe('the page label (§8.11), on the mock index', () => {
  beforeAll(async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    await initIpc()
    state.resetAll()
    state.loadAll()
    state.settings.set({ ...defaultSettings(), mushafStyle: 'hafs' })
    const b = await call(api.appBootstrap())
    app.init(b)
    settings.init(b)
    i18n.init(b)
    quran.init(b)
  })

  afterEach(async () => {
    await settings.update({ uiLanguage: 'en', digits: 'auto' })
  })

  it('reads "surah · page · juz" from the first ayah of the page', () => {
    const label = pageLabel([262])
    expect(label?.text).toBe('Al-Hijr · Page 262 · Juz 14')
    expect(label?.surahAr).toBe('الحجر')
    expect(label?.valueText).toBe('Page 262, Al-Hijr, Juz 14')
    // Al-Fatihah's transliteration differs between a real core.db (exported fixtures) and the synthetic Tanzil index.
    expect(pageLabel([1])?.text).toBe(`${quran.surah(1)?.nameSimple} · Page 1 · Juz 1`)
    expect(pageLabel([])).toBeNull()
  })

  it('names a spread by its pages, isolated for bidi', () => {
    expect(pageLabel([261, 262])?.text).toBe(`Ibrahim · Pages ${LRI}261–262${PDI} · Juz 13`)
    expect(isolatedRange(281, 282)).toBe(`${LRI}281–282${PDI}`)
  })

  it('follows the Arabic UI: Arabic names and Eastern Arabic numbers (الحجر · ص ٢٦٢ · ج ١٤)', async () => {
    await settings.update({ uiLanguage: 'ar' })
    expect(pageLabel([262])?.text).toBe('الحجر · ص ٢٦٢ · ج ١٤')
    expect(pageLabel([262])?.valueText).toBe('الصفحة ٢٦٢، الحجر، الجزء ١٤')
    expect(pageLabel([261, 262])?.text).toBe(`${quran.surah(14)?.nameAr} · ص ${RLI}٢٦١–٢٦٢${PDI} · ج ١٣`)
  })
})

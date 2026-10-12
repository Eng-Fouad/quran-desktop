/**
 * The surah names in the sura-names calligraphy line up by their ink (§9.7; owner feedback 2026-10-12: in the English
 * UI Yusuf's name sat to the right of the others). In the Index and the command palette, in both UI directions, and in
 * the surah info popover (English UI), each of the 114 names ends its ink on the same edge as the others, within 0.5 px:
 * the right in the English UI, the left in the Arabic UI.
 *
 * The face is the real decor face when `data/dev-packs` has the pinned file (`pnpm dev-packs`), else the stand-in of
 * `testing/suraNamesFace.ts`, a box per surah with the real advance and ink extent: CI never has the decor fonts, and
 * there these checks run against the stand-in (the table check below is then skipped, with its reason).
 *
 * The ink is measured without the table: each glyph is drawn on a canvas at 8× its size and its inked columns found,
 * then placed at the glyph's origin on screen (the left end of a Range over its text).
 */
import { flushSync, tick } from 'svelte'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import SurahInfoPopover, { surahInfo } from '$components/mushaf/SurahInfoPopover.svelte'
import OverlayHost from '$components/shell/OverlayHost.svelte'
import { defaultSettings } from '$lib/contracts/settings'
import { api, call, initIpc } from '$lib/ipc'
import { state as mockState } from '$lib/ipc/mock'
import { fixtures } from '$lib/ipc/mock/fixtures'
import { SURA_NAMES_FAMILY, SURA_NAMES_INK, SURA_NAMES_UPM, suraNameGlyph } from '$lib/mushaf/suraNames'
import { app } from '$lib/stores/app.svelte'
import { fonts } from '$lib/stores/fonts.svelte'
import { history } from '$lib/stores/history.svelte'
import { i18n } from '$lib/stores/i18n.svelte'
import { quran } from '$lib/stores/quran.svelte'
import { settings } from '$lib/stores/settings.svelte'
import { shortcuts } from '$lib/stores/shortcuts.svelte'
import { ui } from '$lib/stores/ui.svelte'
import IndexHarness from './testing/IndexHarness.svelte'
import { bootIndex, resetIndex, settle } from './testing/setup'
import { type SuraNamesFace, suraNamesFace } from './testing/suraNamesFace'

/** How far a name's ink may end from the others' (px). */
const TOLERANCE = 0.5
/** The canvas draws each glyph this many times larger than the page does (1/8 px steps). */
const SCALE = 8

const html = document.documentElement
const $$ = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)]

let face: SuraNamesFace
let fontFace: FontFace | null = null

beforeAll(async () => {
  face = await suraNamesFace()
  fontFace = new FontFace(SURA_NAMES_FAMILY, face.bytes)
  await fontFace.load()
  document.fonts.add(fontFace)
  if (!face.real) console.info(`[sura-names test] the stand-in face: ${face.reason ?? ''}`)
})

afterAll(() => {
  if (fontFace) document.fonts.delete(fontFace)
})

afterEach(() => {
  fonts.status.delete(SURA_NAMES_FAMILY)
  surahInfo.reset()
  shortcuts.reset()
  history.reset()
  app.reset()
  resetIndex()
})

/** The face is loaded: what the fonts store reports once the decor pack's face is in `document.fonts`. */
function faceReady(): void {
  fonts.status.set(SURA_NAMES_FAMILY, 'ready')
}

const inks = new Map<string, { left: number; right: number }>()

/**
 * Where a text's ink lies, in px from the left edge of its advance at `size` px: its inked columns on a canvas at
 * `SCALE` times the size, to 1/8 px.
 */
function inkOf(text: string, family: string, size: number): { left: number; right: number } {
  const key = `${family} ${size} ${text}`
  const known = inks.get(key)
  if (known) return known
  const px = size * SCALE
  const font = `${px}px ${family}`
  const canvas = document.createElement('canvas')
  const probe = canvas.getContext('2d')
  if (!probe) throw new Error('no canvas')
  probe.font = font
  // Half an em of room on each side of the advance; the baseline 1.1 em below the top of a 1.5 em canvas (the face's
  // ink spans −0.08 to 0.88 em around it).
  const room = Math.ceil(px / 2)
  canvas.width = Math.ceil(probe.measureText(text).width) + 2 * room
  canvas.height = Math.ceil(1.5 * px)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('no canvas')
  ctx.font = font
  ctx.direction = 'ltr'
  ctx.textAlign = 'left'
  ctx.fillText(text, room, 1.1 * px)
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const inked = (x: number) => {
    for (let y = 0; y < canvas.height; y++) if ((data[(y * canvas.width + x) * 4 + 3] ?? 0) > 0) return true
    return false
  }
  let first = 0
  while (first < canvas.width && !inked(first)) first++
  let last = canvas.width - 1
  while (last > first && !inked(last)) last--
  const cut = (y: number) => {
    for (let x = 0; x < canvas.width; x++) if ((data[(y * canvas.width + x) * 4 + 3] ?? 0) > 0) return true
    return false
  }
  if (first === 0 || first >= canvas.width || last === canvas.width - 1 || cut(0) || cut(canvas.height - 1))
    throw new Error(`no ink, or ink cut off, for ${JSON.stringify(text)} in ${family}`)
  const ink = { left: (first - room) / SCALE, right: (last + 1 - room) / SCALE }
  inks.set(key, ink)
  return ink
}

/**
 * The horizontal extent of a name glyph's ink on screen (client px): from the glyph's origin, the left end of its text
 * box, scaled as the element is (a popover scales in from 0.97; the glyph's line is one em tall).
 */
function inkOnScreen(glyph: HTMLElement): { left: number; right: number } {
  const range = document.createRange()
  range.selectNodeContents(glyph)
  const origin = range.getBoundingClientRect().left
  const style = getComputedStyle(glyph)
  const size = Number.parseFloat(style.fontSize)
  const ink = inkOf(glyph.textContent ?? '', style.fontFamily, size)
  const scale = glyph.getBoundingClientRect().height / size
  return { left: origin + ink.left * scale, right: origin + ink.right * scale }
}

/** The surah of a name glyph: its code point is U+E000 + the zero-padded number read as hex. */
function surahOf(glyph: HTMLElement): number {
  const hex = ((glyph.textContent ?? '').codePointAt(0) ?? 0) - 0xe000
  return Number(hex.toString(16))
}

/**
 * Each surah's ink at the inline end (right in the English UI, left in the Arabic UI) against `edge` (the same for all,
 * or per surah): the surahs farther than the tolerance, with the distance in px (positive: towards the inline end).
 */
function misaligned(
  ends: ReadonlyMap<number, number>,
  edge: number | ((n: number) => number),
  rtl: boolean,
): [number, number][] {
  const out: [number, number][] = []
  for (const [n, x] of ends) {
    const e = typeof edge === 'number' ? edge : edge(n)
    const d = rtl ? e - x : x - e
    if (Math.abs(d) > TOLERANCE) out.push([n, Math.round(d * 100) / 100])
  }
  return out
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? Number.NaN
}

describe('the sura-names table', () => {
  // The ink only: the app never uses the advance, which Chromium on Linux hints to whole pixels.
  it('matches the real face: each glyph’s ink from its origin, within 0.005 em', (ctx) => {
    if (!face.real) ctx.skip(face.reason)
    // Drawn at 384 px: steps of 1/384 em.
    const size = 48
    const off: string[] = []
    SURA_NAMES_INK.forEach(([, xMin, xMax], i) => {
      const ink = inkOf(suraNameGlyph(i + 1), SURA_NAMES_FAMILY, size)
      const measured = [ink.left / size, ink.right / size]
      const table = [xMin / SURA_NAMES_UPM, xMax / SURA_NAMES_UPM]
      if (measured.some((m, k) => Math.abs(m - (table[k] ?? 0)) > 0.005))
        off.push(`${i + 1}: ink ${measured.map((m) => m.toFixed(3)).join('–')} em`)
    })
    expect(off).toEqual([])
  })
})

describe('the Index', () => {
  for (const lang of ['en', 'ar'] as const) {
    it(`ends every name's ink on the end column's edge (${lang} UI)`, async () => {
      bootIndex({ index: await fixtures.index(), lang })
      faceReady()
      await render(IndexHarness)
      await settle(100)
      const rtl = lang === 'ar'
      const ends = new Map<number, number>()
      const columnEdge = new Map<number, number>()
      for (const row of $$('[data-surah]')) {
        const glyph = row.querySelector<HTMLElement>('.end .glyph')
        const end = row.querySelector<HTMLElement>('.end')
        if (!glyph || !end) throw new Error(`row ${row.dataset.surah}: no name glyph`)
        const n = surahOf(glyph)
        expect(n).toBe(Number(row.dataset.surah))
        const ink = inkOnScreen(glyph)
        const box = end.getBoundingClientRect()
        const style = getComputedStyle(end)
        ends.set(n, rtl ? ink.left : ink.right)
        columnEdge.set(
          n,
          rtl
            ? box.left + Number.parseFloat(style.paddingLeft)
            : box.right - Number.parseFloat(style.paddingRight),
        )
      }
      expect(ends.size).toBe(114)
      expect(
        misaligned(ends, (n) => columnEdge.get(n) ?? Number.NaN, rtl),
        'surahs whose ink ends off the column edge (px)',
      ).toEqual([])
    })
  }
})

describe('the command palette', () => {
  /** The palette over the mock bootstrap (as CommandPalette.browser.test.ts), opened on the Surahs scope. */
  async function openSurahs(lang: 'en' | 'ar'): Promise<void> {
    localStorage.clear()
    await initIpc()
    mockState.resetAll()
    mockState.settings.set({ ...defaultSettings(), uiLanguage: lang, theme: 'paper' })
    const b = await call(api.appBootstrap())
    app.init(b)
    settings.init(b)
    i18n.init(b)
    quran.init(b)
    ui.init(b)
    shortcuts.init(b)
    faceReady()
    const host = document.createElement('div')
    host.dataset.testHost = ''
    document.body.append(host)
    render(OverlayHost)
    ui.open('palette', { query: '#' })
    flushSync()
    await settle(150)
  }

  for (const lang of ['en', 'ar'] as const) {
    it(`ends every surah row's name ink on one edge (${lang} UI)`, async () => {
      await openSurahs(lang)
      const rtl = lang === 'ar'
      const options = $$('[role="dialog"] [role="option"]')
      expect(options.map((o) => getComputedStyle(o).direction)).toEqual(
        options.map(() => (rtl ? 'rtl' : 'ltr')),
      )
      const ends = new Map<number, number>()
      for (const glyph of $$('[role="dialog"] [role="option"] .glyph')) {
        const ink = inkOnScreen(glyph)
        ends.set(surahOf(glyph), rtl ? ink.left : ink.right)
      }
      expect(ends.size).toBe(114)
      expect(misaligned(ends, median([...ends.values()]), rtl), 'surahs off the others (px)').toEqual([])
    })
  }
})

describe('the surah info popover', () => {
  it('ends every name glyph’s ink on the header’s inline end (en UI)', async () => {
    html.lang = 'en'
    html.dir = 'ltr'
    html.dataset.theme = 'paper'
    settings.value = { ...defaultSettings(), uiLanguage: 'en' }
    quran.index = await fixtures.index()
    faceReady()
    const anchor = document.createElement('div')
    anchor.dataset.testHost = ''
    anchor.style.blockSize = '40px'
    document.body.append(anchor)
    await render(SurahInfoPopover)
    const ends = new Map<number, number>()
    const edges = new Map<number, number>()
    for (let n = 1; n <= 114; n++) {
      surahInfo.show(n, anchor, 'v2')
      await tick()
      if (n === 1) await vi.waitFor(() => expect(document.querySelector('.si .glyph')).not.toBeNull())
      const glyph = document.querySelector<HTMLElement>(`.si[data-surah="${n}"] .glyph`)
      const head = document.querySelector<HTMLElement>(`.si[data-surah="${n}"] .si-head`)
      if (!glyph || !head) throw new Error(`surah ${n}: no name glyph`)
      expect(surahOf(glyph)).toBe(n)
      ends.set(n, inkOnScreen(glyph).right)
      edges.set(n, head.getBoundingClientRect().right)
    }
    expect(
      misaligned(ends, (n) => edges.get(n) ?? Number.NaN, false),
      'surahs whose ink ends off the header edge (px)',
    ).toEqual([])
  })
})

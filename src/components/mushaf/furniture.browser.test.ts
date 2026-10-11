/**
 * Page furniture (WP8c; §8.8, §8.9) in a real browser, inside a real MushafPage (hafs style, so the page font is always
 * ready): the frame and its settings switch, the opening medallion, the running heads (prefixes, quarter, opening
 * pages), the footer, the surah header (cartouche and decor glyph), the surah info popover opened from a header, the
 * basmala (fallback, decor, the audio basmala highlight), the margin markers and every margin mark (loaded through the
 * library store's `user_marks` cache). The user-data IPC is faked; pages come from the exported fixtures. The footer
 * medallion's tint is checked on screenshots, pixel by pixel, in every theme (and forced colours, Chromium only). The
 * quarters of a hizb are written in words with Eastern Arabic numbers in the margin, its tooltip and the running head,
 * and fit there at every size, in both UI languages.
 */
import { flushSync } from 'svelte'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cdp, page as browserPage, server, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import type { Note, PageData, UserMarks } from '$lib/ipc/bindings'
import { fixtures } from '$lib/ipc/mock/fixtures'
import {
  FOOTER_DEPTH,
  FOOTER_LOBES,
  footerMedallion,
  LABEL_LEADING,
  labelSize,
  lineCenterY,
} from '$lib/mushaf/ornaments'
import { parseColor, type Rgba } from '../../styles/token-harness'
import { fonts, library, player, quran, reader, settings } from '$lib/stores'
import MushafPage from './MushafPage.svelte'
import { resetPaintedHeaders } from './HeaderLine.svelte'
import SurahInfoPopover, { surahInfo } from './SurahInfoPopover.svelte'

const user = vi.hoisted(() => ({
  marks: null as UserMarks | null,
  notes: [] as Note[],
  /** `user_marks` requests made (the library store caches them per page). */
  calls: 0,
}))

vi.mock('$lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/ipc')>()
  const empty: UserMarks = {
    bookmarks: [],
    pageBookmarks: [],
    highlights: [],
    notes: [],
    readingAyahId: null,
  }
  const fake = {
    userMarks: async () => {
      user.calls++
      return { status: 'ok' as const, data: structuredClone(user.marks ?? empty) }
    },
    noteList: async () => ({ status: 'ok' as const, data: structuredClone(user.notes) }),
  }
  const api = new Proxy(actual.api, {
    get: (target, key) => (key in fake ? fake[key as keyof typeof fake] : Reflect.get(target, key)),
  })
  // No backend emits here: the highlight layer's `user-data-changed` listener gets an inert subscription.
  const events = new Proxy(actual.events, {
    get: (target, key) =>
      key === 'userDataChanged' ? { listen: async () => () => {} } : Reflect.get(target, key),
  })
  return { ...actual, api, events }
})

const html = document.documentElement
const QFS = 24
const NOW = Math.floor(Date.now() / 1000)
const initialSettings = settings.value

const frames = (n = 2) =>
  new Promise<void>((resolve) => {
    const step = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1)))
    step(n)
  })

beforeAll(async () => {
  html.dataset.theme = 'paper'
  html.lang = 'en'
  html.dir = 'ltr'
  quran.index = await fixtures.index()
  await document.fonts.load(`${QFS}px "qd-hafs"`)
})

afterAll(() => {
  delete html.dataset.theme
})

beforeEach(() => {
  user.marks = null
  user.notes = []
  user.calls = 0
  settings.value = { ...initialSettings, mushafStyle: 'hafs' }
})

afterEach(() => {
  fonts.status.delete('qd-surah-header')
  fonts.status.delete('qd-quran-common')
  // Lists, the reading bookmark and the `user_marks` cache (never initialised here, so no listeners to drop).
  library.reset()
  player.snapshot = null
  player.heard = null
  reader.hover = null
  surahInfo.reset()
  vi.restoreAllMocks()
})

const page = (n: number): Promise<PageData> => fixtures.page('hafs', n)

async function show(n: number, props: { qfs?: number; interactive?: boolean; ornaments?: boolean } = {}) {
  const data = await page(n)
  const screen = await render(MushafPage, {
    data,
    qfs: props.qfs ?? QFS,
    side: n % 2 === 1 ? 'right' : 'left',
    interactive: props.interactive ?? true,
    ornaments: props.ornaments,
  })
  const section = screen.container.querySelector<HTMLElement>('section.mp')
  if (!section) throw new Error('no section.mp')
  await frames()
  return { screen, section, data }
}

const near = (a: number, b: number, tol = 0.75) => Math.abs(a - b) <= tol

describe('CLS 0 (§8.1)', () => {
  it('a late decor switch replaces header, basmala, head and markers without moving anything', async () => {
    const supported = PerformanceObserver.supportedEntryTypes.includes('layout-shift')
    const { section } = await show(262)
    await frames(3)
    const shifts: number[] = []
    const observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) shifts.push((e as unknown as { value: number }).value)
    })
    if (supported) observer.observe({ type: 'layout-shift' })
    fonts.status.set('qd-surah-header', 'ready')
    fonts.status.set('qd-quran-common', 'ready')
    flushSync()
    await frames(3)
    observer.disconnect()
    expect(section.querySelector('.sh-line')?.hasAttribute('data-decor')).toBe(true)
    expect(section.querySelector('.bsm-decor')).not.toBeNull()
    expect(section.querySelector('.mp-head-juz-glyph')).not.toBeNull()
    if (supported) expect(shifts.reduce((a, b) => a + b, 0)).toBe(0)
  })
})

describe('Ornate surah headers off (§8.8, §8.9; owner 2026-10-11)', () => {
  /**
   * The decor faces are loaded, yet nothing ornate is drawn: the cartouche, the Unicode basmala, the juz in words, the
   * solid ۞ without a frame (a quarter keeps its words in the label). Page 262 at qfs 30: 15:1's header and basmala,
   * the juz 14 head and marker.
   */
  async function expectPlain(props: { ornaments?: boolean }, where: string): Promise<void> {
    const { section, screen } = await show(262, { qfs: 30, ...props })
    const sh = section.querySelector('.sh-line')
    expect(sh?.hasAttribute('data-decor'), where).toBe(false)
    expect(sh?.querySelector('.sc'), where).not.toBeNull()
    expect(section.querySelector('.bsm-decor'), where).toBeNull()
    expect(section.querySelector('.bsm-line')?.hasAttribute('data-decor'), where).toBe(false)
    expect(section.querySelector('.mp-head-juz-glyph'), where).toBeNull()
    expect(section.querySelector('.mp-head-juz')?.textContent?.trim(), where).toBe('الجزء ١٤')
    const glyph = section.querySelector<HTMLElement>('.mp-markers .mk-glyph')
    expect(glyph?.textContent, where).toBe('۞')
    expect(glyph?.hasAttribute('data-ornament'), where).toBe(false)
    expect(section.querySelector('.mp-markers .mk-inset'), where).toBeNull()
    expect(section.querySelector('.mp-markers .mk-label')?.textContent, where).toBe('الجزء ١٤')
    screen.unmount()
    // A quarter: the solid ۞, its words in the label (9:1, the half of hizb 19, page 187).
    const quarter = await show(187, { qfs: 30, ...props })
    const mk = quarter.section.querySelector<HTMLElement>('.mp-markers .mk[data-rub="quarter"]')
    expect(mk?.querySelector('.mk-glyph')?.textContent, where).toBe('۞')
    expect(mk?.querySelector('.mk-inset'), where).toBeNull()
    expect(mk?.querySelector('.mk-label')?.textContent, where).toBe('نصف\nالحزب ١٩')
    quarter.screen.unmount()
  }

  beforeEach(() => {
    fonts.status.set('qd-surah-header', 'ready')
    fonts.status.set('qd-quran-common', 'ready')
  })

  it('draws the plain headers on a page whose ornaments are off, the decor faces loaded', async () => {
    await expectPlain({ ornaments: false }, 'ornaments={false}')
  })

  it('follows the ornateHeaders setting by default, and a page’s ornaments prop overrides it', async () => {
    settings.value = { ...settings.value, ornateHeaders: false }
    await expectPlain({}, 'ornateHeaders off')
    // The onboarding's preview shows the ornaments before the choice is saved.
    const { section } = await show(262, { qfs: 30, ornaments: true })
    expect(section.querySelector('.sh-line')?.hasAttribute('data-decor')).toBe(true)
    expect(section.querySelector('.bsm-decor')).not.toBeNull()
    expect(section.querySelector('.mp-head-juz-glyph')).not.toBeNull()
    expect(section.querySelector('.mp-markers .mk-glyph')?.hasAttribute('data-ornament')).toBe(true)
  })

  it('switching the ornaments off and on moves nothing (CLS 0)', async () => {
    const supported = PerformanceObserver.supportedEntryTypes.includes('layout-shift')
    const { section } = await show(262)
    await frames(3)
    const shifts: number[] = []
    const observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) shifts.push((e as unknown as { value: number }).value)
    })
    if (supported) observer.observe({ type: 'layout-shift' })
    for (const ornateHeaders of [false, true]) {
      settings.value = { ...settings.value, ornateHeaders }
      flushSync()
      await frames(3)
      expect(section.querySelector('.sh-line')?.hasAttribute('data-decor')).toBe(ornateHeaders)
    }
    observer.disconnect()
    if (supported) expect(shifts.reduce((a, b) => a + b, 0)).toBe(0)
  })
})

describe('PageFrame (§8.9)', () => {
  it('draws one page-sized SVG: rules, four bands of interlace tiles, khatam corners', async () => {
    const { section } = await show(262)
    const svg = section.querySelector<SVGSVGElement>(':scope > svg.mp-frame')
    expect(svg).not.toBeNull()
    const box = svg?.getBoundingClientRect()
    expect(box && near(box.width, 21 * QFS) && near(box.height, 31.95 * QFS)).toBe(true)
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.querySelectorAll('pattern')).toHaveLength(2)
    expect(svg?.querySelectorAll('rect.band')).toHaveLength(4)
    expect(svg?.querySelector(':scope > path.star')?.getAttribute('d')?.match(/M/g)).toHaveLength(8)
    expect(svg?.querySelector('.opening')).toBeNull()
    // Pattern ids are unique per page instance.
    const ids = [...(svg?.querySelectorAll('pattern') ?? [])].map((p) => p.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('hides the SVG when showPageFrame is off, keeping the page-stack edges', async () => {
    settings.value = { ...settings.value, showPageFrame: false }
    const { section } = await show(262)
    expect(section.querySelector('svg.mp-frame')).toBeNull()
    // Page 262 (left): (604 − 262) / 604 of the book lies beyond its outer edge → 1 + round(0.57 × 4) = 3 hairlines.
    expect(section.querySelector('.mp-edges')?.children.length).toBe(3)
  })

  it('shows the page-stack hairlines only inside a spread', async () => {
    const { section } = await show(262)
    const edges = section.querySelector<HTMLElement>('.mp-edges')
    expect(edges && getComputedStyle(edges).display).toBe('none')
    section.parentElement?.classList.add('spread')
    expect(edges && getComputedStyle(edges).display).toBe('block')
    // Page 262 (left): the hairlines lie beyond its left (outer) edge.
    const pageBox = section.getBoundingClientRect()
    const first = edges?.firstElementChild?.getBoundingClientRect()
    expect(first && first.right <= pageBox.left).toBe(true)
  })

  it('surrounds the opening lines with the arched medallion on pages 1–2', async () => {
    const { section } = await show(1)
    const opening = section.querySelector('svg.mp-frame .opening')
    expect(opening).not.toBeNull()
    expect(opening?.querySelector('.medallion')?.getAttribute('d')?.endsWith('Z')).toBe(true)
    expect(opening?.querySelector('.rosette')?.getAttribute('d')?.match(/M/g)).toHaveLength(12)
  })
})

describe('RunningHead (§8.9)', () => {
  it('names the surah on the right and the juz on the left, with the quarter while labels are glyph-only', async () => {
    const { section, data } = await show(262)
    const head = section.querySelector<HTMLElement>(':scope > .mp-head')
    expect(head?.dir).toBe('rtl')
    const surah = head?.querySelector<HTMLElement>('.mp-head-surah')
    const juz = head?.querySelector<HTMLElement>('.mp-head-juz')
    expect(surah?.textContent).toBe(`سورة ${quran.surah(data.info.headSurah)?.nameAr}`)
    expect(juz?.textContent).toContain('الجزء ١٤')
    expect(head?.querySelector('.mp-head-quarter')?.textContent).toBe('الحزب ٢٧')
    // Physical sides: the surah is right of the juz.
    const s = surah?.getBoundingClientRect()
    const j = juz?.getBoundingClientRect()
    expect(s && j && s.left > j.right).toBe(true)
    // max(0.5·qfs, 12px).
    expect(head && getComputedStyle(head).fontSize).toBe('12px')
  })

  it('drops the quarter once the labels are drawn, and the prefixes below qfs 20', async () => {
    const big = await show(262, { qfs: 30 })
    expect(big.section.querySelector('.mp-head-quarter')).toBeNull()
    big.screen.unmount()
    const small = await show(262, { qfs: 18 })
    expect(small.section.querySelector('.mp-head-surah')?.textContent).toBe('الحجر')
    expect(small.section.querySelector('.mp-head-juz')?.textContent).toContain('ج ١٤')
  })

  it('is hidden on the opening pages and when showRunningHeads is off', async () => {
    const opening = await show(1)
    expect(opening.section.querySelector('.mp-head')).toBeNull()
    opening.screen.unmount()
    settings.value = { ...settings.value, showRunningHeads: false }
    const off = await show(262)
    expect(off.section.querySelector('.mp-head')).toBeNull()
  })

  it('uses the decor juz calligraphy when quran-common is loaded', async () => {
    fonts.status.set('qd-quran-common', 'ready')
    const { section } = await show(262)
    expect(section.querySelector('.mp-head-juz-glyph')?.textContent?.codePointAt(0)).toBe(0xe00e)
  })

  it('centres the juz calligraphy’s ink on the head text’s, so the head reads as one line', async (ctx) => {
    // The decor face itself (dev packs, `pnpm dev-packs`); without it there is no calligraphy to measure.
    const face = new FontFace('qd-quran-common', 'url(/data/dev-packs/decor/quran-common.ttf)')
    try {
      await face.load()
    } catch {
      ctx.skip()
    }
    document.fonts.add(face)
    onTestFinished(() => void document.fonts.delete(face))
    fonts.status.set('qd-quran-common', 'ready')
    const { section } = await show(262)
    await document.fonts.ready
    const glyph = section.querySelector<HTMLElement>('.mp-head-juz-glyph')
    const surah = section.querySelector<HTMLElement>('.mp-head-surah')
    const quarter = section.querySelector<HTMLElement>('.mp-head-quarter')
    if (!glyph || !surah || !quarter) throw new Error('no running head')
    const centre = inkCentre(glyph)
    // Before: 7 px above the text (≈ 0.27·qfs) on page 256; now within 0.05·qfs of both texts.
    expect(Math.abs(centre - inkCentre(surah))).toBeLessThanOrEqual(0.05 * QFS)
    expect(Math.abs(centre - inkCentre(quarter))).toBeLessThanOrEqual(0.05 * QFS)
  })
})

/**
 * The vertical centre of an element's text ink, in client px: its baseline (a zero-size inline-block laid out after the
 * text, translate included) minus the middle of the text's canvas ink box in the element's font.
 */
function inkCentre(el: HTMLElement): number {
  const text = el.textContent ?? ''
  const style = getComputedStyle(el)
  // A flex container (the surah head) holds its text in an anonymous item: wrap it so the probe shares its line.
  const wrap = document.createElement('span')
  wrap.append(...el.childNodes)
  const probe = document.createElement('span')
  probe.style.cssText = 'display:inline-block;inline-size:0;block-size:0'
  wrap.append(probe)
  el.append(wrap)
  const baseline = probe.getBoundingClientRect().bottom
  probe.remove()
  el.append(...wrap.childNodes)
  wrap.remove()
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) throw new Error('no canvas')
  ctx.font = `${style.fontSize} ${style.fontFamily}`
  const ink = ctx.measureText(text)
  return baseline - (ink.actualBoundingBoxAscent - ink.actualBoundingBoxDescent) / 2
}

describe('PageFooter (§8.9)', () => {
  it('centres the page number in Eastern Arabic numbers under the block in a 1.1·qfs inert medallion', async () => {
    const { section } = await show(262)
    const foot = section.querySelector<HTMLElement>(':scope > .mp-foot')
    expect(foot?.textContent?.trim()).toBe('٢٦٢')
    expect(foot && getComputedStyle(foot).pointerEvents).toBe('none')
    const medallion = foot?.querySelector('.mp-foot-medallion')?.getBoundingClientRect()
    const block = section.querySelector('.mp-block')?.getBoundingClientRect()
    expect(
      medallion && block && near(medallion.left + medallion.width / 2, block.left + block.width / 2),
    ).toBe(true)
    expect(medallion && near(medallion.width, 1.1 * QFS)).toBe(true)
  })

  it.each([12, QFS, 60])(
    'tints the rosette itself: the band under the valleys and every lobe (qfs %i)',
    async (qfs) => {
      const { section } = await show(262, { qfs })
      const svg = section.querySelector('.mp-foot-medallion > svg')
      // One shape, filled and stroked: no second shape whose outline could differ from the rosette's.
      expect(svg?.querySelectorAll('path, circle, ellipse, rect, polygon, polyline, line')).toHaveLength(1)
      const outline = svg?.querySelector<SVGPathElement>(':scope > path.rosette')
      if (!outline) throw new Error('no rosette')
      const m = footerMedallion(qfs)
      const c = m.size / 2
      const r = c - m.stroke / 2
      const at = (radius: number, angle: number) =>
        new DOMPoint(c + radius * Math.cos(angle), c + radius * Math.sin(angle))
      const misses: string[] = []
      for (let i = 0; i < FOOTER_LOBES; i++) {
        const valley = -Math.PI / 2 + (2 * Math.PI * i) / FOOTER_LOBES
        const crest = valley + Math.PI / FOOTER_LOBES
        // Just inside a valley (the band the old 0.8·r disc left bare), and near a lobe's crest.
        if (!outline.isPointInFill(at((FOOTER_DEPTH - 0.03) * r, valley))) misses.push(`valley ${i}`)
        if (!outline.isPointInFill(at(0.95 * r, crest))) misses.push(`lobe ${i}`)
        // No further: just past a valley lies between two lobes, outside.
        if (outline.isPointInFill(at((FOOTER_DEPTH + 0.03) * r, valley))) misses.push(`past valley ${i}`)
      }
      expect(misses).toEqual([])
    },
  )

  it('fills and strokes it in --frame-gold, the fill at 10 %, in every theme', async () => {
    onTestFinished(() => setTheme('paper'))
    const { section } = await show(262)
    const outline = section.querySelector<SVGPathElement>('.mp-foot path.rosette')
    if (!outline) throw new Error('no rosette')
    const probe = document.createElement('span')
    probe.style.color = 'var(--frame-gold)'
    section.append(probe)
    const failures: string[] = []
    for (const [theme, hc] of THEMES) {
      setTheme(theme, hc)
      const css = getComputedStyle(outline)
      const gold = getComputedStyle(probe).color
      const name = themeName(theme, hc)
      if (css.fill !== gold || css.stroke !== gold)
        failures.push(`${name}: ${css.fill} / ${css.stroke} ≠ ${gold}`)
      if (!near(Number(css.fillOpacity), 0.1, 1e-6)) failures.push(`${name}: fill-opacity ${css.fillOpacity}`)
      if (Number(css.strokeOpacity) !== 1) failures.push(`${name}: stroke-opacity ${css.strokeOpacity}`)
    }
    expect(failures).toEqual([])
  })

  it('paints every pixel inside the outline with the tint and none outside it, in every theme', async () => {
    onTestFinished(() => setTheme('paper'))
    const shots = await medallionShots(120)
    const failures: string[] = []
    for (const [theme, hc] of THEMES) {
      setTheme(theme, hc)
      failures.push(...(await shots.check(themeName(theme, hc))))
    }
    expect(failures).toEqual([])
  })

  it('keeps the tint in forced colours: CanvasText at 10 % over Canvas (Chromium)', async (ctx) => {
    // Forced colours are a Windows mode: Chromium emulates it through the DevTools protocol, WebKit has none.
    if (server.browser !== 'chromium') ctx.skip()
    const session = cdp()
    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'forced-colors', value: 'active' }],
    })
    onTestFinished(async () => {
      await session.send('Emulation.setEmulatedMedia', { features: [] })
    })
    expect(matchMedia('(forced-colors: active)').matches).toBe(true)
    const shots = await medallionShots(120)
    expect(await shots.check('forced colours')).toEqual([])
  })
})

/** The six themes (high contrast in both variants), as `[data-theme, data-hc]`. */
const THEMES: [string, string | undefined][] = [
  ['paper', undefined],
  ['sepia', undefined],
  ['night', undefined],
  ['black', undefined],
  ['high_contrast', undefined],
  ['high_contrast', 'dark'],
]

function setTheme(theme: string, hc?: string) {
  html.dataset.theme = theme
  if (hc) html.dataset.hc = hc
  else delete html.dataset.hc
}

const themeName = (theme: string, hc?: string) => (hc ? `${theme}-${hc}` : theme)

/**
 * Page 262 at `qfs` with its footer medallion ready to be checked on screenshots. Its pixels are sorted once, by the
 * rosette path itself: inside its fill or outside it, each at least half the stroke plus 1.5 px (anti-aliasing and the
 * screenshot's pixel snapping) from the path; and on the path, within 0.3 px of it, where the opaque stroke covers the
 * pixel whole. `check` then screenshots the medallion (number hidden) and lists every pixel that is not the paper
 * outside, the paper with 10 % of `--frame-gold` inside, or the gold on the path; and every lobe not tested beyond the
 * old 0.8·r disc.
 */
async function medallionShots(qfs: number) {
  const { section } = await show(262, { qfs })
  const medallion = section.querySelector<HTMLElement>('.mp-foot-medallion')
  const outline = medallion?.querySelector<SVGPathElement>('path.rosette')
  const num = medallion?.querySelector<HTMLElement>('.mp-foot-num')
  if (!medallion || !outline || !num) throw new Error('no medallion')
  // The number covers the middle of the tint.
  num.style.visibility = 'hidden'
  const probe = document.createElement('span')
  probe.style.color = 'var(--frame-gold)'
  section.append(probe)
  const m = footerMedallion(qfs)
  const c = m.size / 2
  const r = c - m.stroke / 2
  const length = outline.getTotalLength()
  const path = Array.from({ length: 2400 }, (_, k) => outline.getPointAtLength((length * k) / 2400))
  const radii = path.map((p) => Math.hypot(p.x - c, p.y - c))
  const nearest = Math.min(...radii)
  const farthest = Math.max(...radii)
  const clear = m.stroke / 2 + 1.5
  const box = medallion.getBoundingClientRect()
  /** Each class's pixel indices, sorted once at the screenshot's scale, and the inside pixels per lobe beyond 0.8·r. */
  let classes: { inside: number[]; outside: number[]; onPath: number[]; lobes: number[] } | null = null
  const classify = (width: number, height: number) => {
    const scale = width / box.width
    const out = {
      inside: [] as number[],
      outside: [] as number[],
      onPath: [] as number[],
      lobes: Array.from({ length: FOOTER_LOBES }, () => 0),
    }
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const x = (i + 0.5) / scale
        const y = (j + 0.5) / scale
        // A pixel is at least |ρ − ρ(p)| from any point p of the path: only the ring the path spans needs the search.
        const rho = Math.hypot(x - c, y - c)
        let d2 = Infinity
        if (rho > nearest - clear && rho < farthest + clear)
          for (const p of path) d2 = Math.min(d2, (p.x - x) ** 2 + (p.y - y) ** 2)
        const d = Math.sqrt(d2)
        const k = j * width + i
        if (d <= 0.3) out.onPath.push(k)
        if (d < clear) continue
        if (!outline.isPointInFill(new DOMPoint(x, y))) {
          out.outside.push(k)
          continue
        }
        out.inside.push(k)
        // Beyond the old disc: count it for its lobe (lobe i spans the valleys at i and i + 1).
        if (rho > 0.8 * r) {
          const turn = (Math.atan2(y - c, x - c) + Math.PI / 2) / (2 * Math.PI)
          const lobe = Math.floor((((turn % 1) + 1) % 1) * FOOTER_LOBES)
          out.lobes[lobe] = (out.lobes[lobe] ?? 0) + 1
        }
      }
    }
    return out
  }
  const check = async (name: string): Promise<string[]> => {
    await frames()
    const img = await screenshotPixels(medallion)
    classes ??= classify(img.width, img.height)
    const at = (k: number): Rgba => ({
      r: img.data[k * 4] ?? 0,
      g: img.data[k * 4 + 1] ?? 0,
      b: img.data[k * 4 + 2] ?? 0,
      a: 1,
    })
    // The paper: the screenshot's own colour at the box's corner (outside the rosette).
    const paper = at(0)
    const gold = parseColor(getComputedStyle(probe).color)
    const tint = mix(paper, gold, 0.1)
    const failures: string[] = []
    const expectAll = (where: string, pixels: number[], want: Rgba) => {
      const off = pixels.filter((k) => !sameRgb(at(k), want, 3))
      if (off.length)
        failures.push(
          `${name}: ${off.length}/${pixels.length} ${where} pixels off ${rgb(want)}, e.g. ${rgb(at(off[0] ?? 0))}`,
        )
    }
    expectAll('outside', classes.outside, paper)
    expectAll('inside', classes.inside, tint)
    expectAll('on-path', classes.onPath, gold)
    if (sameRgb(tint, paper, 3))
      failures.push(`${name}: the tint ${rgb(tint)} does not show on ${rgb(paper)}`)
    classes.lobes.forEach((n, i) => {
      if (n < 10) failures.push(`${name}: lobe ${i} has ${n} pixels beyond 0.8·r`)
    })
    return failures
  }
  return { check }
}

/** The RGBA pixels of a screenshot of `el`, as the browser rendered it. */
async function screenshotPixels(el: Element): Promise<ImageData> {
  const base64 = await browserPage.screenshot({ element: el, save: false })
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  })
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('no canvas')
  ctx.drawImage(bitmap, 0, 0)
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height)
}

/** `top` at `alpha` over `base`, in sRGB as browsers composite. */
const mix = (base: Rgba, top: Rgba, alpha: number): Rgba => ({
  r: base.r + (top.r - base.r) * alpha,
  g: base.g + (top.g - base.g) * alpha,
  b: base.b + (top.b - base.b) * alpha,
  a: 1,
})
const sameRgb = (a: Rgba, b: Rgba, tol: number) =>
  Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol
const rgb = (c: Rgba) => `rgb(${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)})`

describe('HeaderLine, SurahCartouche and SurahInfoPopover (§8.8)', () => {
  it('draws the cartouche across the 16.5 qfs line with the surah name', async () => {
    const { section } = await show(262)
    const sh = section.querySelector<HTMLElement>('.mp-glyphs .ln[data-k="surah_name"] .sh-line')
    expect(sh?.dataset.surah).toBe('15')
    const sc = sh?.querySelector<HTMLElement>('.sc')
    const box = sc?.getBoundingClientRect()
    expect(box && near(box.width, 16.5 * QFS) && near(box.height, 1.55 * QFS)).toBe(true)
    expect(sc?.querySelector('.sc-name')?.textContent).toBe('سُورَةُ الحجر')
    expect(sc?.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 1650 155')
  })

  it('narrows the cartouche to the 12.1 qfs opening line', async () => {
    const { section } = await show(2)
    const box = section.querySelector('.sc')?.getBoundingClientRect()
    expect(box && near(box.width, 12.1 * QFS)).toBe(true)
  })

  it('switches to the QCF header glyph when the surah-header face is loaded', async () => {
    fonts.status.set('qd-surah-header', 'ready')
    const { section } = await show(262)
    const sh = section.querySelector('.sh-line')
    expect(sh?.hasAttribute('data-decor')).toBe(true)
    expect(sh?.querySelector('.sh')?.textContent?.codePointAt(0)).toBe(quran.surah(15)?.headerCp)
    expect(sh?.querySelector('.sc')).toBeNull()
  })

  it('while flipping, keeps the cartouche for a header glyph not drawn before at this size (§8.11)', async () => {
    resetPaintedHeaders()
    fonts.status.set('qd-surah-header', 'ready')
    reader.flipping = true
    try {
      const { section } = await show(262)
      const sh = section.querySelector('.sh-line')
      // A first raster of the colour glyph would stall the flip's frames: the cartouche stands in.
      expect(sh?.hasAttribute('data-decor')).toBe(false)
      expect(sh?.querySelector('.sc')).not.toBeNull()
      // The flip ends: the glyph comes, and from then on a flip shows it too.
      reader.flipping = false
      flushSync()
      expect(sh?.querySelector('.sh')?.textContent?.codePointAt(0)).toBe(quran.surah(15)?.headerCp)
      reader.flipping = true
      flushSync()
      expect(sh?.hasAttribute('data-decor')).toBe(true)
    } finally {
      reader.flipping = false
    }
  })

  it('opens the surah info from a click and tints ayah 1 on hover, leaving the selection alone', async () => {
    reader.selection = { fromAyahId: 1805, toAyahId: 1805, anchorAyahId: 1805 }
    const { section } = await show(262)
    const sh = section.querySelector<HTMLElement>('.sh-line')
    if (!sh) throw new Error('no header')
    sh.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
    expect(reader.hover?.ayahId).toBe(quran.surah(15)?.firstAyahId)
    sh.click()
    flushSync()
    expect(reader.selection?.fromAyahId).toBe(1805)
    reader.selection = null
    expect(surahInfo.open).toBe(true)
    expect(surahInfo.surah).toBe(15)
    expect(surahInfo.anchor).toBe(sh)
    sh.dispatchEvent(new PointerEvent('pointerleave'))
    expect(reader.hover).toBeNull()
  })

  it('does nothing on a decorative (non-interactive) page', async () => {
    const { section } = await show(262, { interactive: false })
    section.querySelector<HTMLElement>('.sh-line')?.click()
    expect(surahInfo.open).toBe(false)
  })

  it('renders the surah facts and plays the whole surah', async () => {
    player.reciters = [
      {
        id: 7,
        packId: 'audio.qdc.7',
        name: { en: 'Mishary Rashid Alafasy', ar: 'مشاري راشد العفاسي' },
        style: null,
        wordLevel: true,
        sizeKib: 0,
        downloadedSurahs: 0,
        cachedSurahs: 0,
      },
    ]
    settings.value = { ...settings.value, reciterId: 7 }
    const { section } = await show(262)
    await render(SurahInfoPopover)
    const play = vi.spyOn(player, 'playFrom').mockResolvedValue()
    section.querySelector<HTMLElement>('.sh-line')?.click()
    await expect.poll(() => document.querySelector('.si[data-surah="15"]')).not.toBeNull()
    const si = document.querySelector<HTMLElement>('.si')
    const info = quran.surah(15)
    expect(si?.textContent).toContain(info?.nameSimple ?? '?')
    expect(si?.textContent).toContain(String(info?.ayahCount))
    expect(si?.textContent).toContain('Meccan')
    const button = [...(si?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Play surah'),
    )
    button?.click()
    expect(play).toHaveBeenCalledWith(
      { ayahId: info?.firstAyahId },
      { to: (info?.firstAyahId ?? 0) + (info?.ayahCount ?? 0) - 1 },
    )
    expect(surahInfo.open).toBe(false)
    expect(si?.textContent).toContain('Mishary Rashid Alafasy')
    player.reciters = []
  })

  it('a second click on the same header closes the popover', async () => {
    const { section } = await show(262)
    const sh = section.querySelector<HTMLElement>('.sh-line')
    if (!sh) throw new Error('no header')
    surahInfo.show(15, sh, 'v2')
    surahInfo.show(15, sh, 'v2')
    expect(surahInfo.open).toBe(false)
  })
})

describe('BasmalaLine (§8.8)', () => {
  it('draws the Unicode basmala in qd-hafs at 0.95·qfs, or the decor calligraphy', async () => {
    const plain = await show(262)
    const bsm = plain.section.querySelector<HTMLElement>('.ln[data-k="basmallah"] .bsm')
    expect(bsm?.textContent).toBe('بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ')
    expect(bsm && Number.parseFloat(getComputedStyle(bsm).fontSize)).toBeCloseTo(0.95 * QFS, 1)
    plain.screen.unmount()
    fonts.status.set('qd-quran-common', 'ready')
    const decor = await show(262)
    expect(decor.section.querySelector('.bsm-decor')?.textContent).toBe('﷽')
  })

  it('carries the audio highlight while the basmala segment before its surah plays', async () => {
    const { section } = await show(262)
    const line = section.querySelector<HTMLElement>('.bsm-line')
    expect(line?.hasAttribute('data-playing')).toBe(false)
    // The heard ayah (WP9a): ayah 0 is the basmala segment before the surah.
    player.heard = { surah: 15, ayah: 0, ayahId: 0 }
    flushSync()
    expect(line?.hasAttribute('data-playing')).toBe(true)
    player.heard = { surah: 15, ayah: 1, ayahId: quran.ayahId(15, 1) }
    flushSync()
    expect(line?.hasAttribute('data-playing')).toBe(false)
  })
})

describe('MarginMarkers (§8.9)', () => {
  it('puts the juz marker of 15:1 in the outer margin, centred on its line, glyph-only below qfs 28', async () => {
    const { section } = await show(262)
    const markers = [...section.querySelectorAll<HTMLElement>(':scope > .mp-markers .mk')]
    expect(markers).toHaveLength(1)
    const mk = markers[0]
    expect(mk?.dataset.line).toBe('3')
    expect(mk?.querySelector('.mk-glyph')?.textContent).toBe('۞')
    expect(mk?.querySelector('.mk-label')).toBeNull()
    expect(mk?.tabIndex).toBe(-1)
    const box = mk?.getBoundingClientRect()
    const pageBox = section.getBoundingClientRect()
    if (!box) throw new Error('no marker box')
    expect(near(box.top + box.height / 2 - pageBox.top, lineCenterY(QFS, 3), 1)).toBe(true)
    // Page 262 is a left page: its outer margin is on the left.
    expect(near(box.left + box.width / 2 - pageBox.left, 0.95 * QFS, 1.5)).toBe(true)
  })

  it('labels markers from qfs 28 and selects the ayah on click', async () => {
    const select = vi.spyOn(reader, 'select')
    const { section } = await show(176, { qfs: 30 })
    const mk = section.querySelector<HTMLElement>('.mp-markers .mk')
    expect(mk?.dataset.kind).toBe('sajda')
    expect(mk?.dataset.line).toBe('15')
    expect(mk?.querySelector('.mk-label')?.textContent).toBe('سجدة')
    mk?.click()
    expect(select).toHaveBeenCalledWith(Number(mk?.dataset.ayah))
  })

  it('labels a quarter whose first word carries the inline ۞ without a second ۞ (LEAD 17)', async () => {
    // 2:253 opens juz 3 on page 42's first line with "۞ تِلۡكَ".
    const { section, screen } = await show(42, { qfs: 30 })
    const first = section.querySelector('.mp-glyphs .ln:first-child .w')
    expect(first?.textContent?.startsWith('۞')).toBe(true)
    const markers = [...section.querySelectorAll<HTMLElement>(':scope > .mp-markers .mk')]
    expect(markers).toHaveLength(1)
    const mk = markers[0]
    expect(mk?.hasAttribute('data-inline')).toBe(true)
    expect(mk?.querySelector('.mk-glyph')).toBeNull()
    expect(mk?.querySelector('.mk-label')?.textContent).toBe('الجزء ٣')
    const box = mk?.getBoundingClientRect()
    const pageBox = section.getBoundingClientRect()
    if (!box) throw new Error('no marker box')
    expect(near(box.top + box.height / 2 - pageBox.top, lineCenterY(30, 1), 1)).toBe(true)
    screen.unmount()
    // Below qfs 28 the margin draws nothing for it: the inline ۞ marks the place, the running head names it.
    const small = await show(42)
    expect(small.section.querySelector('.mp-markers')).toBeNull()
    expect(small.section.querySelector('.mp-head')?.textContent).toContain('الحزب ٥')
  })

  it('draws the decor ornament, thickened and with the hizb number in its frame, only with labels', async () => {
    fonts.status.set('qd-quran-common', 'ready')
    const { section, screen } = await show(262, { qfs: 30 })
    const glyph = section.querySelector<HTMLElement>('.mp-markers .mk-glyph')
    expect(glyph?.hasAttribute('data-ornament')).toBe(true)
    expect(glyph?.textContent).toBe('ﰣ')
    expect(Number.parseFloat(getComputedStyle(glyph as HTMLElement).webkitTextStrokeWidth)).toBeGreaterThan(
      0.5,
    )
    expect(getComputedStyle(glyph as HTMLElement).fontFamily).toContain('qd-quran-common')
    const inset = section.querySelector<HTMLElement>('.mp-markers .mk-inset')
    expect(inset?.textContent).toBe('٢٧')
    // Inside the ornament's box, centred on it.
    const g = glyph?.getBoundingClientRect()
    const i = inset?.getBoundingClientRect()
    if (!g || !i) throw new Error('no boxes')
    expect(i.top).toBeGreaterThan(g.top)
    expect(i.bottom).toBeLessThan(g.bottom)
    expect(near(i.left + i.width / 2, g.left + g.width / 2, 1)).toBe(true)
    expect(section.querySelector('.mp-markers .mk-label')?.textContent).toBe('الجزء ١٤')
    screen.unmount()
    // Smaller pages draw the solid ۞ even with decor loaded.
    const small = await show(262)
    const smallGlyph = small.section.querySelector<HTMLElement>('.mp-markers .mk-glyph')
    expect(smallGlyph?.textContent).toBe('۞')
    expect(smallGlyph?.hasAttribute('data-ornament')).toBe(false)
    expect(small.section.querySelector('.mp-markers .mk-inset')).toBeNull()
  })

  it('is hidden when showMarginMarkers is off, and absent on the opening pages', async () => {
    settings.value = { ...settings.value, showMarginMarkers: false }
    const off = await show(262)
    expect(off.section.querySelector('.mp-markers')).toBeNull()
    off.screen.unmount()
    settings.value = { ...settings.value, showMarginMarkers: true }
    const opening = await show(1)
    expect(opening.section.querySelector('.mp-markers')).toBeNull()
  })
})

describe('Hizb quarters in words (§8.9; owner 2026-10-11)', () => {
  /** A Western Arabic digit, a vulgar fraction or a solidus: none belongs in the furniture. */
  const WESTERN = /[0-9¼½¾/]/u

  /** The UI language: html lang/dir and the settings, both restored after the test. */
  function uiLanguage(lang: 'en' | 'ar'): void {
    html.lang = lang
    html.dir = lang === 'ar' ? 'rtl' : 'ltr'
    settings.value = { ...settings.value, uiLanguage: lang }
    onTestFinished(() => {
      html.lang = 'en'
      html.dir = 'ltr'
    })
  }

  /** The line boxes of an element's text, top to bottom (a line's bidi runs merged into one box). */
  function lineBoxes(el: Element): { top: number; bottom: number; left: number; right: number }[] {
    const range = document.createRange()
    range.selectNodeContents(el)
    const lines: { top: number; bottom: number; left: number; right: number }[] = []
    for (const r of range.getClientRects()) {
      if (r.width < 0.5) continue
      const mid = (r.top + r.bottom) / 2
      const line = lines.find((l) => mid > l.top && mid < l.bottom)
      if (line) {
        line.left = Math.min(line.left, r.left)
        line.right = Math.max(line.right, r.right)
      } else lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right })
    }
    return lines.sort((a, b) => a.top - b.top)
  }

  it('writes a quarter in words over its hizb in Eastern Arabic numbers, in both UI languages and decor states', async () => {
    for (const lang of ['en', 'ar'] as const) {
      uiLanguage(lang)
      for (const decor of [false, true]) {
        if (decor) fonts.status.set('qd-quran-common', 'ready')
        else fonts.status.delete('qd-quran-common')
        // 9:1 opens the half of hizb 19 on page 187's line 2.
        const { section, screen } = await show(187, { qfs: 30 })
        const where = `${lang}, decor ${decor}`
        const markers = section.querySelector<HTMLElement>(':scope > .mp-markers')
        expect(markers?.dir, where).toBe('rtl')
        expect(markers?.lang, where).toBe('ar')
        const mk = markers?.querySelector<HTMLElement>('.mk[data-rub="quarter"]')
        const label = mk?.querySelector<HTMLElement>('.mk-label')
        if (!mk || !label) throw new Error(`no quarter marker (${where})`)
        expect(label.textContent, where).toBe('نصف\nالحزب ١٩')
        // Two lines, each centred under the glyph, and the marker box counts both.
        const lines = lineBoxes(label)
        expect(lines, where).toHaveLength(2)
        const box = label.getBoundingClientRect()
        for (const l of lines)
          expect(near((l.left + l.right) / 2, box.left + box.width / 2, 1), where).toBe(true)
        expect(near(box.height, 2 * labelSize(30) * LABEL_LEADING, 1), where).toBe(true)
        expect(mk.getBoundingClientRect().bottom, where).toBeGreaterThanOrEqual(box.bottom - 0.5)
        // The ornament's frame holds the hizb number (the words do not fit it); the solid ۞ has no frame.
        const inset = mk.querySelector<HTMLElement>('.mk-inset')
        if (decor) {
          expect(inset?.textContent, where).toBe('١٩')
          const g = mk.querySelector('.mk-glyph')?.getBoundingClientRect()
          const i = inset?.getBoundingClientRect()
          if (!g || !i) throw new Error('no ornament boxes')
          expect(i.top).toBeGreaterThan(g.top)
          expect(i.bottom).toBeLessThan(g.bottom)
          expect(near(i.left + i.width / 2, g.left + g.width / 2, 1), where).toBe(true)
        } else expect(inset, where).toBeNull()
        expect(markers?.textContent, where).not.toMatch(WESTERN)
        expect(section.querySelector(':scope > .mp-head')?.textContent, where).not.toMatch(WESTERN)
        screen.unmount()
      }
    }
  })

  it('names the quarter in words in the marker’s tooltip, the description in the UI language', async () => {
    for (const [lang, description] of [
      ['en', 'Half of hizb 19'],
      ['ar', 'نصف الحزب ١٩'],
    ] as const) {
      uiLanguage(lang)
      const { section, screen } = await show(187, { qfs: 30 })
      const mk = section.querySelector<HTMLElement>('.mp-markers .mk[data-rub="quarter"]')
      if (!mk) throw new Error('no quarter marker')
      await userEvent.hover(mk)
      const end = performance.now() + 3_000
      while (!document.querySelector('.mk-tip-label') && performance.now() < end) await frames()
      expect(document.querySelector('.mk-tip-label')?.textContent).toBe('نصف الحزب ١٩')
      expect(document.querySelector('.mk-tip-text')?.textContent).toContain(description)
      await userEvent.unhover(mk)
      screen.unmount()
    }
  })

  it('fits a quarter’s two lines in the outer margin at every size that draws labels, on both sides', async () => {
    fonts.status.set('qd-quran-common', 'ready')
    // The widest line, ثلاثة أرباع: label-only on page 529 (right) and 600 (left); ربع under its ornament on 594.
    for (const [n, text] of [
      [529, 'ثلاثة أرباع\nالحزب ٥٣'],
      [600, 'ثلاثة أرباع\nالحزب ٦٠'],
      [594, 'ربع\nالحزب ٦٠'],
    ] as const) {
      // qfs 28 is the tightest (the 11 px label floor in a 1.9·qfs margin), 160 the largest page.
      for (const qfs of [28, 30, 31, 48, 96, 160]) {
        const { section, screen } = await show(n, { qfs, interactive: false })
        const where = `page ${n} at qfs ${qfs}`
        const column = section.querySelector(':scope > .mp-markers')?.getBoundingClientRect()
        const block = section.querySelector('.mp-block')?.getBoundingClientRect()
        const label = section.querySelector<HTMLElement>('.mp-markers .mk[data-rub="quarter"] .mk-label')
        if (!column || !block || !label) throw new Error(`no quarter label (${where})`)
        expect(label.textContent, where).toBe(text)
        const lines = lineBoxes(label)
        expect(lines, where).toHaveLength(2)
        for (const l of lines) {
          // Inside the margin column (never over the frame band or past the paper's edge).
          expect(l.left, where).toBeGreaterThanOrEqual(column.left - 0.5)
          expect(l.right, where).toBeLessThanOrEqual(column.right + 0.5)
          expect(l.right <= block.left || l.left >= block.right, where).toBe(true)
        }
        screen.unmount()
      }
    }
  })

  it('keeps the running head’s quarter on one line beside the widest surah name, from the smallest page up', async () => {
    // The widest «سورة …» head in qd-hafs, to put beside the widest quarter (ثلاثة أرباع, page 529).
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) throw new Error('no canvas')
    ctx.font = '100px "qd-hafs"'
    let widest = 1
    for (let id = 1, best = 0; id <= 114; id++) {
      const w = ctx.measureText(`سورة ${quran.surah(id)?.nameAr ?? ''}`).width
      if (w > best) [best, widest] = [w, id]
    }
    const data = await page(529)
    for (const decor of [false, true]) {
      if (decor) fonts.status.set('qd-quran-common', 'ready')
      else fonts.status.delete('qd-quran-common')
      // Glyph-only pages (QFS_MIN 18 to 27), and a large page with the margin markers off.
      for (const [qfs, showMarginMarkers] of [
        [18, true],
        [19, true],
        [20, true],
        [24, true],
        [27, true],
        [60, false],
      ] as const) {
        settings.value = { ...settings.value, showMarginMarkers }
        const screen = await render(MushafPage, {
          data: { ...data, info: { ...data.info, headSurah: widest } },
          qfs,
          side: 'right',
          interactive: false,
        })
        await frames()
        const where = `qfs ${qfs}, decor ${decor}`
        const head = screen.container.querySelector<HTMLElement>('section.mp > .mp-head')
        const quarter = head?.querySelector<HTMLElement>('.mp-head-quarter')
        const surah = head?.querySelector<HTMLElement>('.mp-head-surah')
        const juz = head?.querySelector<HTMLElement>('.mp-head-juz')
        if (!head || !quarter || !surah || !juz) throw new Error(`no running head quarter (${where})`)
        expect(quarter.textContent, where).toBe('ثلاثة أرباع الحزب ٥٣')
        expect(lineBoxes(quarter), where).toHaveLength(1)
        const h = head.getBoundingClientRect()
        const s = surah.getBoundingClientRect()
        const j = juz.getBoundingClientRect()
        // Inside the head band, the surah name on the right of the juz group, apart.
        expect(j.left, where).toBeGreaterThanOrEqual(h.left - 0.5)
        expect(s.right, where).toBeLessThanOrEqual(h.right + 0.5)
        expect(s.left, where).toBeGreaterThan(j.right)
        expect(head.textContent, where).not.toMatch(WESTERN)
        screen.unmount()
      }
    }
  })
})

describe('MarginMarks (§8.9)', () => {
  const seed = () => {
    user.marks = {
      bookmarks: [
        { ayahId: 1803, bookmarkId: 'b1' },
        { ayahId: 1811, bookmarkId: 'b9' },
      ],
      pageBookmarks: [{ page: 262, bookmarkId: 'p' }],
      highlights: [],
      notes: [{ id: 'n1', fromAyahId: 1806, toAyahId: 1807 }],
      readingAyahId: 1808,
    }
    user.notes = [
      {
        id: 'n1',
        fromAyahId: 1806,
        toAyahId: 1807,
        title: null,
        body: '**Leave them** to eat and enjoy.',
        tagIds: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]
    library.readingBookmark = { ayahId: 1808, layout: 'v2', page: 262, updatedAt: NOW - 3 * 86_400 }
  }

  it('draws bookmarks after the line markers, the note glyph, the ribbon and the dog-ear', async () => {
    seed()
    const { section, data } = await show(262)
    await expect.poll(() => section.querySelectorAll('.mp-marks .mm').length).toBe(3)
    const marks = [...section.querySelectorAll<HTMLElement>('.mp-marks .mm')]
    expect(marks.map((m) => [m.dataset.kind, m.dataset.ayah])).toEqual([
      ['bookmark', '1803'],
      ['note', '1806'],
      ['bookmark', '1811'],
    ])
    const marker = section.querySelector('.mp-markers .mk')?.getBoundingClientRect()
    const first = marks[0]?.getBoundingClientRect()
    expect(marker && first && first.top >= marker.bottom + 0.2 * QFS - 0.75).toBe(true)
    const ribbon = section.querySelector<HTMLElement>('.mp-ribbon')
    expect(ribbon?.dataset.ayah).toBe('1808')
    const pageBox = section.getBoundingClientRect()
    const rb = ribbon?.getBoundingClientRect()
    // Page 262 is a left page: the spine is on the right.
    expect(rb && rb.left > pageBox.right - 0.9 * QFS && rb.right <= pageBox.right).toBe(true)
    expect(rb && near(rb.width, 0.55 * QFS)).toBe(true)
    expect(section.querySelector('.mp-dogear')).not.toBeNull()
    // The page's `user_marks` went through the library store's cache (§1.2 step 4), shared with the highlight layer.
    const { firstAyahId, lastAyahId } = data.info
    expect([...library.marks.keys()]).toContain(`v2|262|${firstAyahId}-${lastAyahId}`)
  })

  it('reloads when the library replaces a list, and draws nothing when highlightBookmarks is off', async () => {
    seed()
    const { section } = await show(262)
    await expect.poll(() => section.querySelectorAll('.mp-marks .mm').length).toBe(3)
    const before = user.calls
    // What the store does on a change (its own mutation, or the re-read after another surface's
    // `user-data-changed`): it empties its marks cache, then replaces the list.
    user.marks = { ...(user.marks as UserMarks), bookmarks: [] }
    library.marks.clear()
    library.bookmarks = [...library.bookmarks]
    await expect.poll(() => section.querySelectorAll('.mp-marks .mm').length).toBe(1)
    expect(user.calls).toBe(before + 1)
    // A list replaced while the cache still holds the page (nothing that moves a mark changed) costs no request.
    library.notes = [...library.notes]
    await frames(3)
    expect(user.calls).toBe(before + 1)
    expect(section.querySelectorAll('.mp-marks .mm').length).toBe(1)
    settings.value = { ...settings.value, highlightBookmarks: false }
    flushSync()
    expect(section.querySelector('.mp-marks')).toBeNull()
    expect(section.querySelector('.mp-ribbon')).toBeNull()
  })

  it('loads no marks on a decorative page', async () => {
    seed()
    const { section } = await show(262, { interactive: false })
    await frames(3)
    expect(user.calls).toBe(0)
    expect(section.querySelector('.mp-marks, .mp-ribbon, .mp-dogear')).toBeNull()
  })

  it('opens the reading-bookmark popover and moves the ribbon to the action target', async () => {
    seed()
    const move = vi.spyOn(library, 'moveReadingBookmark').mockResolvedValue(null)
    // The action target is the *visible* selection (§8.15): the reader shows page 262.
    const before = reader.page
    reader.page = 262
    reader.selection = { fromAyahId: 1810, toAyahId: 1810, anchorAyahId: 1810 }
    onTestFinished(() => {
      reader.selection = null
      reader.page = before
    })
    expect(reader.actionTarget).toBe(1810)
    const { section } = await show(262)
    await expect.poll(() => section.querySelector('.mp-ribbon')).not.toBeNull()
    section.querySelector<HTMLElement>('.mp-ribbon')?.click()
    await expect.poll(() => document.querySelector('.rb')).not.toBeNull()
    const rb = document.querySelector<HTMLElement>('.rb')
    expect(rb?.textContent).toContain('Reading bookmark')
    expect(rb?.textContent).toContain('15:6')
    expect(rb?.textContent).toContain('3 days ago')
    const button = [...(rb?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Move here'),
    )
    button?.click()
    expect(move).toHaveBeenCalledWith(1810, reader.layout, quran.pageOfAyah(reader.layout, 1810))
    reader.selection = null
  })
})

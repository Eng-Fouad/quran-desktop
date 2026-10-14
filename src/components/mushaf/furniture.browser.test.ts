/**
 * Page furniture in a real browser, inside a real MushafPage (hafs style, so the page font is always ready): the frame
 * and its settings switch, the opening medallion, the running heads (prefixes, quarter, opening pages), the footer, the
 * surah header (cartouche and decor glyph), the surah info popover opened from a header, the basmala (fallback, decor,
 * the audio basmala highlight), the margin markers and every margin mark (loaded through the library store's
 * `user_marks` cache). The user-data IPC is faked; pages come from the exported fixtures. The footer medallion's tint
 * is checked on screenshots, pixel by pixel, in every theme (and forced colours, Chromium only). The quarters of a hizb
 * are written in words with Eastern Arabic numbers in the margin, its tooltip and the running head, and fit there at
 * every size, in both UI languages. With the bundled print-labels face (loaded for real here, `fonts.printLabelsReady`)
 * the running heads and the rub labels are the 1441H print's own calligraphy: their glyphs and face, one baseline
 * inside the head band, the stacked labels in boxes as tall as their ink, the quarter right to left, whatever the
 * ornaments, without a layout shift, in both UI languages; with decor on (owner request 2026-10-13), every rub start
 * hangs the print's lamp or medallion with its label inside, its box on the line, at every size, inline ۞ or not, and
 * its ink over the page bookmark's dog-ear. The marks never cover a marker. None of that geometry depends on the decor
 * face (the marker's size is set inline, the label's ink is measured in the bundled face), so it runs in CI, which has
 * no decor fonts; the one check that measures the ornaments' own ink and boxes needs the dev packs' quran-common
 * (`pnpm dev-packs`) and skips without it. Without the print face, the Hafs text under a ۞.
 */
import { flushSync } from 'svelte'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cdp, page as browserPage, server, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import type { MushafStyle, Note, PageData, UserMarks } from '$lib/ipc/bindings'
import { fixtures } from '$lib/ipc/mock/fixtures'
import {
  decorStroke,
  DOG_EAR,
  FOOTER_DEPTH,
  FOOTER_LOBES,
  footerMedallion,
  INK,
  LABEL_GAP,
  LABEL_LEADING,
  labelSize,
  lineCenterY,
  STACK_GAP,
} from '$lib/mushaf/ornaments'
import {
  MARGIN_LABEL_EM,
  PRINT_EM,
  PRINT_HEAD_BASELINE,
  PRINT_METRICS,
  printMarginKind,
} from '$lib/mushaf/printLabels'
import { parseColor, type Rgba } from '../../styles/token-harness'
import { fonts, library, pages, player, quran, reader, settings } from '$lib/stores'
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
    // The pages cache, as the reader fills it (one test needs it), from the same fixtures.
    mushafGetPages: async (style: MushafStyle, pages: number[]) => {
      const { fixtures: f } = await import('$lib/ipc/mock/fixtures')
      return { status: 'ok' as const, data: await Promise.all(pages.map((n) => f.page(style, n))) }
    },
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

describe('CLS 0', () => {
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
    // The running head is no decor: its juz stays as it was (the print's calligraphy, or its text).
    expect(section.querySelector('.mp-head-juz')?.textContent).toContain('الجزء ١٤')
    if (supported) expect(shifts.reduce((a, b) => a + b, 0)).toBe(0)
  })
})

describe('Ornate surah headers off (owner 2026-10-11)', () => {
  /**
   * The decor faces are loaded, yet nothing ornate is drawn: the cartouche, the Unicode basmala, the juz in words, the
   * solid ۞, never an ornament (a quarter keeps its words in the label). Page 262 at qfs 30: 15:1's header and basmala,
   * the juz 14 head and marker.
   */
  async function expectPlain(props: { ornaments?: boolean }, where: string): Promise<void> {
    const { section, screen } = await show(262, { qfs: 30, ...props })
    const sh = section.querySelector('.sh-line')
    expect(sh?.hasAttribute('data-decor'), where).toBe(false)
    expect(sh?.querySelector('.sc'), where).not.toBeNull()
    expect(section.querySelector('.bsm-decor'), where).toBeNull()
    expect(section.querySelector('.bsm-line')?.hasAttribute('data-decor'), where).toBe(false)
    expect(section.querySelector('.mp-head-juz')?.textContent?.trim(), where).toBe('الجزء ١٤')
    const glyph = section.querySelector<HTMLElement>('.mp-markers .mk-glyph')
    expect(glyph?.textContent, where).toBe('۞')
    expect(glyph?.hasAttribute('data-ornament'), where).toBe(false)
    expect(section.querySelector('.mp-markers .mk-label')?.textContent, where).toBe('الجزء ١٤')
    screen.unmount()
    // A quarter: the solid ۞, its words in the label (9:1, the half of hizb 19, page 187).
    const quarter = await show(187, { qfs: 30, ...props })
    const mk = quarter.section.querySelector<HTMLElement>('.mp-markers .mk[data-rub="quarter"]')
    expect(mk?.querySelector('.mk-glyph')?.textContent, where).toBe('۞')
    expect(mk?.querySelector('.mk-glyph')?.hasAttribute('data-ornament'), where).toBe(false)
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
    // The onboarding's preview shows the ornaments before the choice is saved (they hold the print's label).
    fonts.printLabelsReady = true
    onTestFinished(() => {
      fonts.printLabelsReady = false
    })
    const { section } = await show(262, { qfs: 30, ornaments: true })
    expect(section.querySelector('.sh-line')?.hasAttribute('data-decor')).toBe(true)
    expect(section.querySelector('.bsm-decor')).not.toBeNull()
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

describe('PageFrame', () => {
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

describe('RunningHead', () => {
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

  it('stays text without the print-labels face, whatever the decor', async () => {
    fonts.status.set('qd-quran-common', 'ready')
    const { section } = await show(262)
    const head = section.querySelector<HTMLElement>(':scope > .mp-head')
    expect(head?.hasAttribute('data-print')).toBe(false)
    expect(head?.querySelector('.mp-head-print')).toBeNull()
    expect(head?.querySelector('.mp-head-juz')?.textContent).toContain('الجزء ١٤')
  })
})

describe('PageFooter', () => {
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

describe('HeaderLine, SurahCartouche and SurahInfoPopover', () => {
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

  it('while flipping, keeps the cartouche for a header glyph not drawn before at this size', async () => {
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
    // The page is in the pages cache, as in the reader: the word layer's hover reads there which surah a header opens.
    await pages.ensure('hafs', [262])
    onTestFinished(() => pages.reset())
    const { section } = await show(262)
    const sh = section.querySelector<HTMLElement>('.sh-line')
    if (!sh) throw new Error('no header')
    // The pointer comes from a word, as a hand does (and as the browser reports a pointer resting where the page is
    // drawn): the word layer hands the hover over to the header's ayah 1.
    const over = { bubbles: true, pointerType: 'mouse' } as const
    section.querySelector('.mp-glyphs .w')?.dispatchEvent(new PointerEvent('pointerover', over))
    sh.dispatchEvent(new PointerEvent('pointerover', over))
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

describe('BasmalaLine', () => {
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
    // The heard ayah: ayah 0 is the basmala segment before the surah.
    player.heard = { surah: 15, ayah: 0, ayahId: 0 }
    flushSync()
    expect(line?.hasAttribute('data-playing')).toBe(true)
    player.heard = { surah: 15, ayah: 1, ayahId: quran.ayahId(15, 1) }
    flushSync()
    expect(line?.hasAttribute('data-playing')).toBe(false)
  })
})

describe('MarginMarkers', () => {
  it('puts the juz marker of 15:1 in the outer margin, centred on its line, glyph-only below qfs 28 (no print face)', async () => {
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

  it('draws a juz start whose first word carries the inline ۞ like any other (owner request 2026-10-13)', async () => {
    // 2:253 opens juz 3 on page 42's first line with "۞ تِلۡكَ": the text keeps its ۞, the margin draws its own.
    const { section, screen } = await show(42, { qfs: 30 })
    const first = section.querySelector('.mp-glyphs .ln:first-child .w')
    expect(first?.textContent?.startsWith('۞')).toBe(true)
    const markers = [...section.querySelectorAll<HTMLElement>(':scope > .mp-markers .mk')]
    expect(markers).toHaveLength(1)
    const mk = markers[0]
    expect(mk?.hasAttribute('data-inline')).toBe(true)
    expect(mk?.querySelector('.mk-glyph')?.textContent).toBe('۞')
    expect(mk?.querySelector('.mk-label')?.textContent).toBe('الجزء ٣')
    const box = mk?.getBoundingClientRect()
    const pageBox = section.getBoundingClientRect()
    if (!box) throw new Error('no marker box')
    expect(near(box.top + box.height / 2 - pageBox.top, lineCenterY(30, 1), 1)).toBe(true)
    screen.unmount()
    // Below qfs 28, without the print face, the ۞ alone; the running head names the hizb.
    const small = await show(42)
    expect(small.section.querySelector('.mp-markers .mk-glyph')?.textContent).toBe('۞')
    expect(small.section.querySelector('.mp-markers .mk-label')).toBeNull()
    expect(small.section.querySelector('.mp-head')?.textContent).toContain('الحزب ٥')
  })

  it('draws no ornament without the print face, whose label it holds: the ۞ and the Hafs words', async () => {
    fonts.status.set('qd-quran-common', 'ready')
    for (const qfs of [30, QFS]) {
      const { section, screen } = await show(262, { qfs })
      const glyph = section.querySelector<HTMLElement>('.mp-markers .mk-glyph')
      expect(glyph?.textContent).toBe('۞')
      expect(glyph?.hasAttribute('data-ornament')).toBe(false)
      expect(section.querySelector('.mp-markers .mk-label')?.textContent ?? null).toBe(
        qfs >= 28 ? 'الجزء ١٤' : null,
      )
      screen.unmount()
    }
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

describe('Hizb quarters in words (owner 2026-10-11)', () => {
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
        // Without the print face no ornament is drawn, decor or not: the words go under the solid ۞.
        expect(mk.querySelector('.mk-glyph')?.textContent, where).toBe('۞')
        expect(mk.querySelector('.mk-glyph')?.hasAttribute('data-ornament'), where).toBe(false)
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
    // The widest line, ثلاثة أرباع: inline ۞ on page 529 (right) and 600 (left); ربع on 594; each under its ۞.
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

describe('The 1441H print’s calligraphy', () => {
  /** The bundled face, loaded for real in this engine; `fonts.printLabelsReady` is what main.ts's load sets. */
  const FACE = 'qd-print-labels'
  const cp = (n: number) => String.fromCodePoint(n)

  /**
   * The real quran-common face (dev packs, `pnpm dev-packs`; CI has none): only the check that measures the ornaments'
   * own ink needs it. Elsewhere `fonts.status` alone switches the margin to its ornaments, whose boxes are set inline.
   */
  let decorFace: FontFace | null = null

  beforeAll(async () => {
    await document.fonts.load(`30px "${FACE}"`, cp(0xf801))
    try {
      const face = new FontFace('qd-quran-common', 'url(/data/dev-packs/decor/quran-common.ttf)')
      await face.load()
      document.fonts.add(face)
      decorFace = face
    } catch {
      decorFace = null
    }
  })

  afterAll(() => {
    if (decorFace) document.fonts.delete(decorFace)
  })

  beforeEach(() => {
    fonts.printLabelsReady = true
  })

  afterEach(() => {
    fonts.printLabelsReady = false
  })

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

  /** The baseline (client px) of an element's text: a zero-size inline-block probe laid out after it. */
  function baselineOf(el: HTMLElement): number {
    const probe = document.createElement('span')
    probe.style.cssText = 'display:inline-block;inline-size:0;block-size:0'
    el.append(probe)
    const y = probe.getBoundingClientRect().bottom
    probe.remove()
    return y
  }

  /** Ink extents (em above and below the baseline) by text, measured once per engine. */
  const inkEm = new Map<string, { top: number; bottom: number }>()

  /**
   * The ink of a text in the face, in em above and below its baseline, as the engine draws it: the inked rows of a
   * 1000 px canvas rendition, exact to a thousandth of an em (0.27 px at qfs 160). Canvas text metrics will not do:
   * Skia with FreeType (Chromium and WebKit on Linux) reports the outline's control box, which overshoots this face's
   * curves by up to 0.015 em, rounded out to whole pixels; Core Text reports the ink.
   */
  function glyphInk(text: string): { top: number; bottom: number } {
    const known = inkEm.get(text)
    if (known) return known
    const px = 1000
    const font = `${px}px "${FACE}"`
    const probe = document.createElement('canvas').getContext('2d')
    if (!probe) throw new Error('no canvas')
    probe.font = font
    // An em of room around the advance, and the face's whole height and more above and below the baseline.
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(probe.measureText(text).width) + 2 * px
    canvas.height = 2 * px
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('no canvas')
    ctx.font = font
    ctx.textAlign = 'center'
    ctx.fillText(text, canvas.width / 2, px)
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const stride = canvas.width * 4
    let first = -1
    let last = -1
    for (let y = 0; y < canvas.height; y++) {
      for (let a = y * stride + 3; a < (y + 1) * stride; a += 4) {
        if ((data[a] ?? 0) > 0) {
          if (first < 0) first = y
          last = y
          break
        }
      }
    }
    if (first <= 0 || last >= canvas.height - 1)
      throw new Error(`no ink, or ink cut off, for ${JSON.stringify(text)}`)
    const ink = { top: (px - first) / px, bottom: (last + 1 - px) / px }
    inkEm.set(text, ink)
    return ink
  }

  /** The ink (client px) of an element's glyph: its baseline and the glyph's ink (`glyphInk`) at the element's size. */
  function inkOf(el: HTMLElement): { top: number; bottom: number; base: number } {
    const size = Number.parseFloat(getComputedStyle(el).fontSize)
    const ink = glyphInk(el.textContent ?? '')
    const base = baselineOf(el)
    return { top: base - ink.top * size, bottom: base + ink.bottom * size, base }
  }

  /** An element's box where layout put it: its client rect less its `translate` (which moves only the ink). */
  function layoutBox(el: HTMLElement): {
    top: number
    bottom: number
    left: number
    right: number
    height: number
  } {
    const r = el.getBoundingClientRect()
    const ty = Number.parseFloat(getComputedStyle(el).translate.split(' ')[1] ?? '0') || 0
    return { top: r.top - ty, bottom: r.bottom - ty, left: r.left, right: r.right, height: r.height }
  }

  /** The rub that starts on a page (its margin label is U+F800 + rub). */
  const rubOn = (data: PageData) => data.ayahs.find((a) => a.flags & 1 && a.startsOnPage)?.rub ?? 0

  it('is loaded in this engine before the furniture draws with it', () => {
    for (const glyph of [cp(0xf60f), cp(0xf70e), cp(0xf869), cp(0xf503), '٢٧'])
      expect(document.fonts.check(`24px "${FACE}"`, glyph)).toBe(true)
  })

  it('names the surah and the juz in the print’s calligraphy, with the quarter right to left, in both UIs', async () => {
    for (const lang of ['en', 'ar'] as const) {
      uiLanguage(lang)
      // Page 262 at qfs 24: 15:1 opens juz 14 and hizb 27. The margin names it at every size with this face, so the
      // head names the hizb only with the markers off.
      settings.value = { ...settings.value, showMarginMarkers: false }
      const { section, screen } = await show(262, { interactive: false })
      const head = section.querySelector<HTMLElement>(':scope > .mp-head')
      const surah = head?.querySelector<HTMLElement>('.mp-head-surah .mp-head-print')
      const juz = head?.querySelector<HTMLElement>('.mp-head-juz > .mp-head-print:not(.mp-head-quarter)')
      const quarter = head?.querySelector<HTMLElement>('.mp-head-quarter')
      if (!head || !surah || !juz || !quarter) throw new Error(`no print running head (${lang})`)
      expect(head.hasAttribute('data-print'), lang).toBe(true)
      expect(head.dir, lang).toBe('rtl')
      expect(surah.textContent, lang).toBe(cp(0xf60f))
      expect(surah.dataset.text, lang).toBe('سورة الحجر')
      expect(juz.textContent, lang).toBe(cp(0xf70e))
      expect(juz.dataset.text, lang).toBe('الجزء ١٤')
      expect(quarter.dataset.text, lang).toBe('الحزب ٢٧')
      const parts = [...quarter.children] as HTMLElement[]
      expect(
        parts.map((p) => p.textContent),
        lang,
      ).toEqual([cp(0xf503), '٢٧'])
      for (const el of [surah, juz, quarter]) {
        const style = getComputedStyle(el)
        expect(style.fontFamily, lang).toContain(FACE)
        expect(Number.parseFloat(style.fontSize), lang).toBeCloseTo(PRINT_EM * QFS, 1)
      }
      // Right to left by the flex row, not bidi: «الحِزۡبُ» on the right of the number.
      const [word, number] = parts.map((p) => p.getBoundingClientRect())
      expect(word && number && word.left >= number.right - 0.5, lang).toBe(true)
      // Physical sides: the surah right of the juz, the juz right of its quarter.
      expect(surah.getBoundingClientRect().left, lang).toBeGreaterThan(juz.getBoundingClientRect().right)
      expect(juz.getBoundingClientRect().left, lang).toBeGreaterThan(quarter.getBoundingClientRect().right)
      expect(head.textContent, lang).not.toMatch(/[0-9]/u)
      screen.unmount()
    }
  })

  it('sets every head on one baseline inside the HEAD band, clear of the frame, at every size', async () => {
    // Al-Hijr / juz 14 (a juz start), At-Tawbah, Al-Qamar (a three-quarter), Al-‘Adiyat (the last pages).
    for (const n of [262, 187, 529, 600]) {
      for (const qfs of [20, 24, 30, 60]) {
        const { section, screen } = await show(n, { qfs, interactive: false })
        const where = `page ${n} at qfs ${qfs}`
        const head = section.querySelector<HTMLElement>(':scope > .mp-head')
        if (!head) throw new Error(`no head (${where})`)
        const band = head.getBoundingClientRect()
        const glyphs = [
          ...head.querySelectorAll<HTMLElement>(
            '.mp-head-print:not(.mp-head-quarter), .mp-head-quarter > span',
          ),
        ]
        expect(glyphs.length, where).toBeGreaterThanOrEqual(2)
        for (const g of glyphs) {
          const ink = inkOf(g)
          expect(near(ink.base, band.bottom - PRINT_HEAD_BASELINE * qfs, 1), where).toBe(true)
          expect(ink.top, where).toBeGreaterThanOrEqual(band.top - 1)
          expect(ink.bottom, where).toBeLessThanOrEqual(band.bottom)
        }
        screen.unmount()
      }
    }
  })

  it('is drawn whatever the ornaments say (bundled furniture, not decor); compact pages keep the text', async () => {
    fonts.status.set('qd-quran-common', 'ready')
    for (const [ornateHeaders, ornaments] of [
      [false, undefined],
      [true, undefined],
      [true, false],
      [false, true],
    ] as const) {
      settings.value = { ...settings.value, ornateHeaders }
      const { section, screen } = await show(262, { ornaments, interactive: false })
      const where = `ornateHeaders ${ornateHeaders}, ornaments ${ornaments}`
      expect(section.querySelector(':scope > .mp-head')?.hasAttribute('data-print'), where).toBe(true)
      expect(section.querySelector('.mp-head-juz .mp-head-print')?.textContent, where).toBe(cp(0xf70e))
      screen.unmount()
    }
    const small = await show(262, { qfs: 18, interactive: false })
    const head = small.section.querySelector<HTMLElement>(':scope > .mp-head')
    expect(head?.hasAttribute('data-print')).toBe(false)
    expect(head?.querySelector('.mp-head-surah')?.textContent).toBe('الحجر')
    expect(head?.querySelector('.mp-head-juz')?.textContent).toContain('ج ١٤')
  })

  it('fits the widest heads beside the widest quarter on one line, from qfs 20 up', async () => {
    // The widest glyphs of the face: «سُورَةُ المُرۡسَلَاتِ» (77) and juz 25's ordinal, beside ثلاثة أرباع الحزب ٥٣. With
    // this face the margin names the quarter at every size, so the head carries it with the markers off.
    const data = await page(529)
    settings.value = { ...settings.value, showMarginMarkers: false }
    for (const qfs of [20, 24, 27, 60]) {
      const screen = await render(MushafPage, {
        data: { ...data, info: { ...data.info, headSurah: 77, juz: 25 } },
        qfs,
        side: 'right',
        interactive: false,
      })
      await frames()
      const where = `qfs ${qfs}`
      const head = screen.container.querySelector<HTMLElement>('section.mp > .mp-head')
      const quarter = head?.querySelector<HTMLElement>('.mp-head-quarter')
      const surah = head?.querySelector<HTMLElement>('.mp-head-surah')
      const juz = head?.querySelector<HTMLElement>('.mp-head-juz')
      if (!head || !quarter || !surah || !juz) throw new Error(`no running head quarter (${where})`)
      expect(head.hasAttribute('data-print'), where).toBe(true)
      expect(quarter.dataset.text, where).toBe('ثلاثة أرباع الحزب ٥٣')
      expect(
        [...quarter.children].map((c) => c.textContent),
        where,
      ).toEqual([cp(0xf502), cp(0xf503), '٥٣'])
      // One line: the three parts share their top, right to left.
      const boxes = [...quarter.children].map((c) => c.getBoundingClientRect())
      for (const b of boxes) expect(b.top, where).toBeCloseTo(boxes[0]?.top ?? 0, 0)
      for (let i = 1; i < boxes.length; i++)
        expect(boxes[i - 1]?.left ?? 0, where).toBeGreaterThanOrEqual((boxes[i]?.right ?? 0) - 0.5)
      const h = head.getBoundingClientRect()
      const s = surah.getBoundingClientRect()
      const j = juz.getBoundingClientRect()
      expect(j.left, where).toBeGreaterThanOrEqual(h.left - 0.5)
      expect(s.right, where).toBeLessThanOrEqual(h.right + 0.5)
      expect(s.left, where).toBeGreaterThan(j.right)
      screen.unmount()
    }
  })

  it('labels the margin with the print’s stacked labels at one size, sized by the ink of their kind, in both UIs', async () => {
    // A juz start (262), a hizb start with the inline ۞ (51), a half (187), a three-quarter with the inline ۞ (529), a
    // quarter and a three-quarter on left pages (594, 600): every kind of stacked label, hizbs 6 to 60, in the
    // ornament (decor on) or under the ۞ (decor off).
    for (const lang of ['en', 'ar'] as const) {
      uiLanguage(lang)
      for (const decor of [false, true]) {
        if (decor) fonts.status.set('qd-quran-common', 'ready')
        else fonts.status.delete('qd-quran-common')
        for (const n of [262, 51, 187, 529, 594, 600]) {
          const { section, screen, data } = await show(n, { qfs: 30, interactive: false })
          const where = `page ${n}, ${lang}, decor ${decor}`
          const rub = rubOn(data)
          const column = section.querySelector(':scope > .mp-markers')?.getBoundingClientRect()
          const block = section.querySelector('.mp-block')?.getBoundingClientRect()
          const mk = section.querySelector<HTMLElement>('.mp-markers .mk[data-kind="rub"]')
          const label = mk?.querySelector<HTMLElement>('.mk-label')
          if (!column || !block || !mk || !label) throw new Error(`no rub label (${where})`)
          expect(label.hasAttribute('data-print'), where).toBe(true)
          expect(label.textContent, where).toBe(cp(0xf800 + rub))
          expect(document.fonts.check(`30px "${FACE}"`, label.textContent ?? ''), where).toBe(true)
          const style = getComputedStyle(label)
          expect(style.fontFamily, where).toContain(FACE)
          expect(Number.parseFloat(style.fontSize), where).toBeCloseTo(MARGIN_LABEL_EM * 30, 1)
          // The box is the ink extent of its kind of label; the glyph's own ink stays inside it.
          const { yMin, yMax } = PRINT_METRICS[printMarginKind(rub)]
          const box = layoutBox(label)
          expect(box.height, where).toBeCloseTo(((yMax - yMin) / 1000) * MARGIN_LABEL_EM * 30, 0)
          const ink = inkOf(label)
          expect(ink.top, where).toBeGreaterThanOrEqual(box.top - 1)
          expect(ink.bottom, where).toBeLessThanOrEqual(box.bottom + 1)
          // Inside its marker, which stays in the outer margin column, never over the frame or past the paper.
          const m = mk.getBoundingClientRect()
          expect(box.top, where).toBeGreaterThanOrEqual(m.top - 0.75)
          expect(box.bottom, where).toBeLessThanOrEqual(m.bottom + 0.75)
          for (const r of [box, m]) {
            expect(r.left, where).toBeGreaterThanOrEqual(column.left - 0.5)
            expect(r.right, where).toBeLessThanOrEqual(column.right + 0.5)
            expect(r.right <= block.left || r.left >= block.right, where).toBe(true)
          }
          const line = section.getBoundingClientRect().top + lineCenterY(30, Number(mk.dataset.line))
          // The label's box (the ink of its kind) on the line's centre: in its ornament, or under the ۞, which then
          // stands above the line as the crest does.
          expect(near(box.top + box.height / 2, line, 1), where).toBe(true)
          if (decor) {
            expect(label.hasAttribute('data-inside'), where).toBe(true)
            expect(mk.querySelector('.mk-glyph')?.hasAttribute('data-ornament'), where).toBe(true)
          } else {
            expect(label.hasAttribute('data-inside'), where).toBe(false)
            expect(mk.querySelector('.mk-glyph')?.textContent, where).toBe('۞')
            expect(m.top + m.height / 2, where).toBeLessThan(line)
          }
          expect(mk.textContent, where).not.toMatch(/[0-9]/u)
          screen.unmount()
        }
      }
    }
  })

  it('hangs the lamp or the medallion with the label in its box on the line, at every size, inline ۞ or not', async () => {
    // No decor face needed: the marker's font size, width and height come from the model (`INK`, set inline) and the
    // label's ink is measured in the bundled face; the model's ink and free boxes are measured in the real ornaments by
    // the next test.
    fonts.status.set('qd-quran-common', 'ready')
    for (const [n, o] of [
      [262, INK.decorJuz], // juz 14 on line 3, a surah start
      [42, INK.decorJuz], // juz 3 on line 1, the inline ۞
      [51, INK.decorHizb], // hizb 6, the inline ۞ (a right page)
      [534, INK.decorQuarter], // a quarter at a surah start (the owner's page)
      [529, INK.decorQuarter], // three quarters, the inline ۞ (a right page)
      [415, INK.decorQuarter], // a quarter on line 14, the inline ۞
    ] as const) {
      for (const qfs of [18, 24, 30, 60]) {
        const { section, screen } = await show(n, { qfs, interactive: false })
        const where = `page ${n} at qfs ${qfs}`
        const pageBox = section.getBoundingClientRect()
        const column = section.querySelector(':scope > .mp-markers')?.getBoundingClientRect()
        const mk = section.querySelector<HTMLElement>('.mp-markers .mk[data-kind="rub"]')
        const glyph = mk?.querySelector<HTMLElement>('.mk-glyph')
        const label = mk?.querySelector<HTMLElement>('.mk-label')
        if (!column || !mk || !glyph || !label) throw new Error(`no ornament (${where})`)
        const G = o.size * qfs
        expect(glyph.textContent, where).toBe(o.char)
        expect(glyph.hasAttribute('data-ornament'), where).toBe(true)
        const style = getComputedStyle(glyph)
        expect(style.fontFamily, where).toContain('qd-quran-common')
        expect(Number.parseFloat(style.fontSize), where).toBeCloseTo(G, 0)
        // The hairlines thickened just to a pixel (none from about qfs 28), halved at 2 dppx.
        const k = window.devicePixelRatio >= 2 ? 0.5 : 1
        expect(Number.parseFloat(style.webkitTextStrokeWidth), where).toBeCloseTo(decorStroke(G) * k, 1)
        // The marker is the ornament's ink, centred in the outer margin, inside the paper.
        const m = mk.getBoundingClientRect()
        expect(m.width, where).toBeCloseTo(o.width * G, 0)
        expect(m.height, where).toBeCloseTo(G, 0)
        expect(near(m.left + m.width / 2, column.left + column.width / 2, 1), where).toBe(true)
        expect(m.left, where).toBeGreaterThanOrEqual(column.left - 0.5)
        expect(m.right, where).toBeLessThanOrEqual(column.right + 0.5)
        expect(m.top, where).toBeGreaterThanOrEqual(pageBox.top)
        expect(m.bottom, where).toBeLessThanOrEqual(pageBox.bottom)
        // Its free box on the line's centre: `hollow.cy` em above the baseline, `top` em below the ink's top.
        const line = pageBox.top + lineCenterY(qfs, Number(mk.dataset.line))
        const free = { cy: m.top + (o.top - o.hollow.cy) * G, w: o.hollow.w * G, h: o.hollow.h * G }
        expect(near(free.cy, line, 1), where).toBe(true)
        // The label inside it: the box of its kind centred there, its own ink within the free box, its advance
        // centred, and its ink (the advance less 0.05 em bearings) narrower than the box.
        expect(label.hasAttribute('data-inside'), where).toBe(true)
        const box = layoutBox(label)
        expect(near(box.top + box.height / 2, line, 1), where).toBe(true)
        const ink = inkOf(label)
        expect(ink.top, where).toBeGreaterThanOrEqual(free.cy - free.h / 2 - 0.5)
        expect(ink.bottom, where).toBeLessThanOrEqual(free.cy + free.h / 2 + 0.5)
        const range = document.createRange()
        range.selectNodeContents(label)
        const advance = range.getBoundingClientRect()
        expect(advance.width - 0.1 * MARGIN_LABEL_EM * qfs, where).toBeLessThan(free.w)
        expect(near(advance.left + advance.width / 2, m.left + m.width / 2, 1), where).toBe(true)
        screen.unmount()
      }
    }
  })

  it('measures the real ornaments as the model has them: one em of ink, its width, a free box their rules bound', (ctx) => {
    // The one check that needs the dev packs' quran-common (`pnpm dev-packs`; CI has no decor fonts): `INK`'s ink and
    // free box of each ornament, which size and place it and its label, rasterised from the face at 1024 px.
    if (!decorFace) ctx.skip()
    const px = 1024
    for (const [name, o] of [
      ['lamp', INK.decorQuarter],
      ['medallion', INK.decorHizb],
    ] as const) {
      const canvas = document.createElement('canvas')
      canvas.width = 2 * px
      canvas.height = 2 * px
      const c = canvas.getContext('2d', { willReadFrequently: true })
      if (!c) throw new Error('no canvas')
      c.font = `${px}px "qd-quran-common"`
      c.textAlign = 'center'
      c.fillText(o.char, px, px)
      const { data } = c.getImageData(0, 0, 2 * px, 2 * px)
      // Ink at a pixel; (x, y) in em from the advance's centre and the baseline, y up.
      const inked = (i: number, j: number) => (data[(j * 2 * px + i) * 4 + 3] ?? 0) > 96
      const col = (x: number) => Math.round(px + x * px)
      const row = (y: number) => Math.round(px - y * px)
      let [top, bottom, left, right] = [2 * px, 0, 2 * px, 0]
      for (let j = 0; j < 2 * px; j++)
        for (let i = 0; i < 2 * px; i++)
          if (inked(i, j)) {
            top = Math.min(top, j)
            bottom = Math.max(bottom, j + 1)
            left = Math.min(left, i)
            right = Math.max(right, i + 1)
          }
      expect((px - top) / px, `${name}: ink top`).toBeCloseTo(o.top, 2)
      expect((bottom - px) / px, `${name}: ink bottom`).toBeCloseTo(o.bottom, 2)
      expect((right - left) / px, `${name}: ink width`).toBeCloseTo(o.width, 2)
      expect((left + right) / 2 - px, `${name}: ink centred in the advance`).toBeLessThanOrEqual(2)
      /** Whether any pixel of the rectangle (em) is inked. */
      const any = (x0: number, x1: number, y0: number, y1: number) => {
        for (let j = row(y1); j <= row(y0); j++)
          for (let i = col(x0); i <= col(x1); i++) if (inked(i, j)) return true
        return false
      }
      const { cy, w, h } = o.hollow
      // Empty: 0.02 em in from its sides (the lamp's arch springs, the frame's corners are rounded) and 0.004 em in
      // from its top and foot.
      expect(
        any(-w / 2 + 0.02, w / 2 - 0.02, cy - h / 2 + 0.004, cy + h / 2 - 0.004),
        `${name}: free box`,
      ).toBe(false)
      // Bound within 0.02 em: its sides at its middle, and its foot (the medallion's top too) off the axis, where the
      // medallion's frame has a notch.
      expect(any(-w / 2 - 0.02, -w / 2 + 0.004, cy - 0.01, cy + 0.01), `${name}: left rule`).toBe(true)
      expect(any(w / 2 - 0.004, w / 2 + 0.02, cy - 0.01, cy + 0.01), `${name}: right rule`).toBe(true)
      expect(any(0.05, 0.07, cy - h / 2 - 0.02, cy - h / 2 + 0.004), `${name}: foot`).toBe(true)
      if (name === 'medallion')
        expect(any(0.05, 0.07, cy + h / 2 - 0.004, cy + h / 2 + 0.02), `${name}: top`).toBe(true)
    }
  })

  it('draws the ۞ with the print’s label under it while the ornaments are off, at every size', async () => {
    fonts.status.set('qd-quran-common', 'ready')
    for (const qfs of [18, 30]) {
      for (const n of [262, 529]) {
        const { section, screen } = await show(n, { qfs, ornaments: false, interactive: false })
        const where = `page ${n} at qfs ${qfs}`
        const mk = section.querySelector<HTMLElement>('.mp-markers .mk[data-kind="rub"]')
        const glyph = mk?.querySelector<HTMLElement>('.mk-glyph')
        const label = mk?.querySelector<HTMLElement>('.mk-label')
        if (!mk || !glyph || !label) throw new Error(`no marker (${where})`)
        expect(glyph.textContent, where).toBe('۞')
        expect(glyph.hasAttribute('data-ornament'), where).toBe(false)
        expect(label.hasAttribute('data-print'), where).toBe(true)
        expect(label.hasAttribute('data-inside'), where).toBe(false)
        expect(Number.parseFloat(getComputedStyle(label).fontSize), where).toBeCloseTo(
          MARGIN_LABEL_EM * qfs,
          1,
        )
        // `LABEL_GAP` under the ۞, its box (the ink of its kind) on the line: the ۞ stands above it as a crest does.
        const box = layoutBox(label)
        expect(box.top - layoutBox(glyph).bottom, where).toBeCloseTo(LABEL_GAP * qfs, 0)
        const line = section.getBoundingClientRect().top + lineCenterY(qfs, Number(mk.dataset.line))
        expect(near(box.top + box.height / 2, line, 1), where).toBe(true)
        // The margin names the quarter, so the running head does not.
        expect(section.querySelector('.mp-head-quarter'), where).toBeNull()
        screen.unmount()
      }
    }
  })

  it('sets the label exactly at every size, from qfs 18 to 160, and the marks continue after its marker', async () => {
    for (const decor of [false, true]) {
      if (decor) fonts.status.set('qd-quran-common', 'ready')
      else fonts.status.delete('qd-quran-common')
      for (const n of [529, 594]) {
        for (const qfs of [18, 28, 48, 96, 160]) {
          const { section, screen } = await show(n, { qfs, interactive: false })
          const where = `page ${n} at qfs ${qfs}, decor ${decor}`
          const label = section.querySelector<HTMLElement>('.mp-markers .mk-label[data-print]')
          const column = section.querySelector(':scope > .mp-markers')?.getBoundingClientRect()
          if (!label || !column) throw new Error(`no print label (${where})`)
          const box = layoutBox(label)
          const ink = inkOf(label)
          expect(ink.top, where).toBeGreaterThanOrEqual(box.top - 1)
          expect(ink.bottom, where).toBeLessThanOrEqual(box.bottom + 1)
          expect(box.left, where).toBeGreaterThanOrEqual(column.left - 0.5)
          expect(box.right, where).toBeLessThanOrEqual(column.right + 0.5)
          screen.unmount()
        }
      }
    }
    // A bookmark on 15:1 (page 262) goes on 0.2·qfs below the juz marker: its ۞ and print label, or its medallion.
    user.marks = {
      bookmarks: [{ ayahId: 1803, bookmarkId: 'b1' }],
      pageBookmarks: [],
      highlights: [],
      notes: [],
      readingAyahId: null,
    }
    for (const decor of [false, true]) {
      if (decor) fonts.status.set('qd-quran-common', 'ready')
      else fonts.status.delete('qd-quran-common')
      const { section, screen } = await show(262, { qfs: 30 })
      await expect.poll(() => section.querySelectorAll('.mp-marks .mm').length).toBe(1)
      const marker = section.querySelector('.mp-markers .mk')?.getBoundingClientRect()
      const mark = section.querySelector('.mp-marks .mm')?.getBoundingClientRect()
      if (!marker || !mark) throw new Error('no marker or mark')
      expect(near(mark.top - marker.bottom, 0.2 * 30, 1), `decor ${decor}`).toBe(true)
      screen.unmount()
    }
  })

  it('keeps the Hafs words in the marker’s tooltip', async () => {
    const { section } = await show(187, { qfs: 30 })
    const mk = section.querySelector<HTMLElement>('.mp-markers .mk[data-rub="quarter"]')
    if (!mk) throw new Error('no quarter marker')
    expect(mk.querySelector('.mk-label')?.hasAttribute('data-print')).toBe(true)
    await userEvent.hover(mk)
    const end = performance.now() + 3_000
    while (!document.querySelector('.mk-tip-label') && performance.now() < end) await frames()
    expect(document.querySelector('.mk-tip-label')?.textContent).toBe('نصف الحزب ١٩')
    await userEvent.unhover(mk)
  })

  it('draws the label’s hairlines in the ink on the smallest page, paper and night', async () => {
    // At qfs 18 its stacked lines are about 5 px tall: without the hairline under its fill they antialias to a tint,
    // the faintest thing in the ornament. Measured on the label alone (the ۞ hidden), as the share of its inked pixels
    // that reach 3:1 against the page.
    onTestFinished(() => setTheme('paper'))
    const off = document.createElement('style')
    off.textContent = '.mk-label[data-print] { -webkit-text-stroke-width: 0 !important }'
    onTestFinished(() => off.remove())
    for (const theme of ['paper', 'night']) {
      setTheme(theme)
      const shares: number[] = []
      for (const hairline of [false, true]) {
        if (hairline) off.remove()
        else document.head.append(off)
        const { section, screen } = await show(534, { qfs: 18, interactive: false })
        const label = section.querySelector<HTMLElement>('.mp-markers .mk-label[data-print]')
        const glyph = section.querySelector<HTMLElement>('.mp-markers .mk-glyph')
        const paperEl = section.querySelector<HTMLElement>('.mp-paper')
        if (!label || !glyph || !paperEl) throw new Error('no label')
        glyph.style.visibility = 'hidden'
        await frames()
        const img = await screenshotPixels(label)
        const paper = parseColor(getComputedStyle(paperEl).backgroundColor)
        const ink = parseColor(getComputedStyle(label).color)
        const lum = (c: Rgba) => {
          const f = (v: number) => {
            const s = v / 255
            return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
          }
          return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
        }
        const span = [ink.r - paper.r, ink.g - paper.g, ink.b - paper.b] as const
        const norm = span[0] ** 2 + span[1] ** 2 + span[2] ** 2
        let inked = 0
        let dark = 0
        for (let k = 0; k < img.data.length; k += 4) {
          const c = { r: img.data[k] ?? 0, g: img.data[k + 1] ?? 0, b: img.data[k + 2] ?? 0, a: 1 }
          const cover =
            ((c.r - paper.r) * span[0] + (c.g - paper.g) * span[1] + (c.b - paper.b) * span[2]) / norm
          if (cover <= 0.1) continue
          inked++
          const [hi, lo] = [Math.max(lum(c), lum(paper)), Math.min(lum(c), lum(paper))]
          if ((hi + 0.05) / (lo + 0.05) >= 3) dark++
        }
        shares.push(inked ? dark / inked : 0)
        screen.unmount()
      }
      const [plain = 0, drawn = 0] = shares
      // Measured in Edge (1×): paper 11 % → 36 %, night 18 % → 52 %.
      expect(
        drawn,
        `${theme}: ${(plain * 100).toFixed(1)} % → ${(drawn * 100).toFixed(1)} %`,
      ).toBeGreaterThan(Math.max(0.2, 1.4 * plain))
    }
  })

  it('moves nothing while the page is drawn with it and the decor arrives (CLS 0)', async () => {
    const supported = PerformanceObserver.supportedEntryTypes.includes('layout-shift')
    const shifts: number[] = []
    const observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) shifts.push((e as unknown as { value: number }).value)
    })
    if (supported) observer.observe({ type: 'layout-shift' })
    const { section } = await show(262, { qfs: 30, interactive: false })
    await frames(3)
    fonts.status.set('qd-surah-header', 'ready')
    fonts.status.set('qd-quran-common', 'ready')
    flushSync()
    await frames(3)
    for (const ornateHeaders of [false, true]) {
      settings.value = { ...settings.value, ornateHeaders }
      flushSync()
      await frames(3)
    }
    observer.disconnect()
    expect(section.querySelector(':scope > .mp-head')?.hasAttribute('data-print')).toBe(true)
    expect(section.querySelector('.mp-markers .mk-label')?.hasAttribute('data-print')).toBe(true)
    if (supported) expect(shifts.reduce((a, b) => a + b, 0)).toBe(0)
  })
})

describe('MarginMarks', () => {
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
    // The page's `user_marks` went through the library store's cache, shared with the highlight layer.
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

  it('never draws a mark over an ornament or another mark: beside a juz start and above a quarter’s lamp', async () => {
    // No decor face needed: the marks keep clear of the ornaments' boxes, which the model sizes (set inline).
    fonts.printLabelsReady = true
    fonts.status.set('qd-quran-common', 'ready')
    onTestFinished(() => {
      fonts.printLabelsReady = false
    })
    // Page 262: 15:1 opens juz 14 on line 3 and 15:3 starts line 4, under the medallion's lower crest. Page 529: 54:7
    // on line 1 sits under the crest of the lamp that 54:9 hangs on line 2, and 54:10 starts line 3.
    for (const [n, ayahs] of [
      [262, [1803, 1805]],
      [529, [4853, 4855, 4856]],
    ] as const) {
      user.marks = {
        bookmarks: ayahs.map((ayahId, i) => ({ ayahId, bookmarkId: `b${i}` })),
        pageBookmarks: [],
        highlights: [],
        notes: [],
        readingAyahId: null,
      }
      for (const qfs of [18, 30]) {
        // The page's marks afresh (the store caches them per page).
        library.reset()
        const { section, screen } = await show(n, { qfs })
        await expect.poll(() => section.querySelectorAll('.mp-marks .mm').length).toBe(ayahs.length)
        const where = `page ${n} at qfs ${qfs}`
        expect(section.querySelector('.mp-markers .mk-glyph')?.hasAttribute('data-ornament'), where).toBe(
          true,
        )
        const boxes = [...section.querySelectorAll<HTMLElement>('.mp-markers .mk, .mp-marks .mm')].map(
          (el) => ({
            key: `${el.className.split(' ')[0]} ${el.dataset.ayah}`,
            r: el.getBoundingClientRect(),
          }),
        )
        for (const [i, a] of boxes.entries())
          for (const b of boxes.slice(i + 1)) {
            const gap = Math.max(b.r.top - a.r.bottom, a.r.top - b.r.bottom)
            expect(gap, `${where}: ${a.key} and ${b.key}`).toBeGreaterThan(STACK_GAP * qfs - 1)
          }
        screen.unmount()
      }
    }
  })

  it('draws a line-1 lamp’s ink over the page bookmark’s dog-ear, which keeps the pointer, and the marks over both', async () => {
    fonts.printLabelsReady = true
    fonts.status.set('qd-quran-common', 'ready')
    onTestFinished(() => {
      fonts.printLabelsReady = false
    })
    // Page 42 opens juz 3 on line 1 (2:253): drawn as a quarter's start, the lamp rises nearest the paper's top.
    const data = await page(42)
    const quarter = {
      ...data,
      ayahs: data.ayahs.map((a) => (a.flags & 1 && a.startsOnPage ? { ...a, flags: 1, rub: 18 } : a)),
    }
    user.marks = {
      bookmarks: [{ ayahId: quarter.ayahs.find((a) => a.flags & 1)?.id ?? 0, bookmarkId: 'b' }],
      pageBookmarks: [{ page: 42, bookmarkId: 'p' }],
      highlights: [],
      notes: [],
      readingAyahId: null,
    }
    const qfs = 30
    const screen = await render(MushafPage, { data: quarter, qfs, side: 'left', interactive: true })
    await expect.poll(() => screen.container.querySelector('.mp-dogear')).not.toBeNull()
    await expect.poll(() => screen.container.querySelector('.mp-marks .mm')).not.toBeNull()
    const glyph = screen.container.querySelector<HTMLElement>('.mp-markers .mk-glyph[data-ornament]')
    const dogear = screen.container.querySelector<HTMLElement>('.mp-dogear')
    const marks = screen.container.querySelector<HTMLElement>('.mp-marks')
    if (!glyph || !dogear || !marks) throw new Error('no lamp, dog-ear or marks')
    expect(glyph.textContent).toBe(INK.decorQuarter.char)
    // The lamp starts 0.74·qfs below the paper's top, inside the 1.2·qfs dog-ear.
    const page42 = screen.container.querySelector('section.mp')?.getBoundingClientRect()
    const g = glyph.getBoundingClientRect()
    expect((g.top - (page42?.top ?? 0)) / qfs).toBeLessThan(DOG_EAR)
    expect(g.top).toBeLessThan(dogear.getBoundingClientRect().bottom)
    // Its ink is painted over the dog-ear (z 2 over z 1, one stacking context: the page), which keeps the pointer.
    const z = (el: Element) => Number(getComputedStyle(el).zIndex)
    expect(z(glyph)).toBeGreaterThan(z(dogear))
    expect(getComputedStyle(glyph).pointerEvents).toBe('none')
    // The marks come later in the page at the same level: over the markers.
    expect(z(marks)).toBeGreaterThanOrEqual(z(glyph))
    // The bookmark of 2:253 hangs under the lamp.
    const lamp = glyph.closest('.mk')?.getBoundingClientRect()
    expect(marks.querySelector('.mm')?.getBoundingClientRect().top).toBeCloseTo(
      (lamp?.bottom ?? 0) + STACK_GAP * qfs,
      0,
    )
  })

  it('opens the reading-bookmark popover and moves the ribbon to the action target', async () => {
    seed()
    const move = vi.spyOn(library, 'moveReadingBookmark').mockResolvedValue(null)
    // The action target is the *visible* selection: the reader shows page 262.
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

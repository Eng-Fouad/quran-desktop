/**
 * Page furniture (WP8c; §8.8, §8.9) in a real browser, inside a real MushafPage (hafs style, so the page font is always
 * ready): the frame and its settings switch, the opening medallion, the running heads (prefixes, quarter, opening
 * pages), the footer, the surah header (cartouche and decor glyph), the surah info popover opened from a header, the
 * basmala (fallback, decor, the audio basmala highlight), the margin markers and every margin mark (loaded through the
 * library store's `user_marks` cache). The user-data IPC is faked; pages come from the exported fixtures.
 */
import { flushSync } from 'svelte'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import type { Note, PageData, UserMarks } from '$lib/ipc/bindings'
import { fixtures } from '$lib/ipc/mock/fixtures'
import { lineCenterY } from '$lib/mushaf/ornaments'
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

async function show(n: number, props: { qfs?: number; interactive?: boolean } = {}) {
  const data = await page(n)
  const screen = await render(MushafPage, {
    data,
    qfs: props.qfs ?? QFS,
    side: n % 2 === 1 ? 'right' : 'left',
    interactive: props.interactive ?? true,
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
  it('centres the Arabic-Indic page number under the block in a 1.1·qfs medallion, inert to the pointer', async () => {
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
})

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

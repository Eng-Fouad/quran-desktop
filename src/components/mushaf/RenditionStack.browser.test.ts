/**
 * RenditionStack (WP8b; §8.5, D13, §8.1 invariant 1) in a real browser, inside a real MushafPage:
 * - the fallback → QCF swap is a cross-fade between stacked renditions with zero layout shift: page, block and line
 *   boxes are identical before and after, while the word boxes change (it really is another font);
 * - a face that becomes ready within 120 ms is drawn directly (the fallback never mounts); a loaded face renders at once;
 * - `unavailable` / `failed` keep the fallback and show the footer dot; Retry recovers with the same cross-fade;
 * - a style change on the same page cross-fades; a different page starts afresh; a qfs change refits and re-measures;
 * - under reduced motion the swap completes without a transition;
 * - leaving a style unloads its faces once nothing draws them: no QCF V4 (COLR) face stays in `document.fonts` after
 *   the reader moved to QCF V2, while the V4 rendition keeps its face for as long as it is on screen.
 * The page-font IPC is faked; the "QCF" face is the real page font when `data/dev-packs` exists, else the bundled Hafs
 * TTF registered under the QCF family name (any different font proves the swap).
 *
 * The tests about what happens within the waits (`FONT_WAIT_MS` for the face, `GLYPH_WAIT_MS` for its glyphs) run the
 * component's timers on a fake clock (`setTimeout` only) and hold the IPC answer: they prove the order of events, not
 * how fast this engine loads a face or shapes a page, which takes what it takes in real time while the clock stands
 * still (on a loaded CI runner WebKit needed more than the 120 ms of a real clock). Tests about something else start
 * with the face loaded and its glyphs warm where a wait would otherwise decide their path. A cross-fade is proven by
 * the opacity transitions it starts, not by a frame that happens to fall within its 180 ms.
 */
import { flushSync } from 'svelte'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import type { Bootstrap, FetchPriority, MushafStyle, PageData, PageFontStatus } from '$lib/ipc/bindings'
import { initIpc } from '$lib/ipc'
import { fixtures } from '$lib/ipc/mock/fixtures'
import { STYLE_METRICS } from '$lib/mushaf/metrics'
import { PALETTE_STYLE_ID } from '$lib/mushaf/palettes'
import { glyphKey, shapeWarmer } from '$lib/mushaf/warmup'
import { app, fonts, quran, reader, settings } from '$lib/stores'
import MushafPage from './MushafPage.svelte'
import { FONT_WAIT_MS, GLYPH_WAIT_MS } from './RenditionStack.svelte'

const ipc = vi.hoisted(() => ({
  calls: 0,
  availability: 'ready' as 'ready' | 'failed' | 'unavailable',
  /** Hold every reply until `release()` (a slow download). */
  hold: false,
  held: [] as (() => void)[],
  url: '/fonts/KFGQPC-Hafs-V30.ttf',
  /** A real page font per style, when the dev packs have it (page 262). */
  styleUrl: {} as Partial<Record<string, string>>,
  release() {
    for (const r of this.held.splice(0)) r()
  },
}))

vi.mock('$lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/ipc')>()
  const fake = {
    mushafEnsurePageFonts: async (style: MushafStyle, pages: number[], _priority: FetchPriority) => {
      ipc.calls++
      if (ipc.hold) await new Promise<void>((resolve) => ipc.held.push(resolve))
      const data = pages.map((page): PageFontStatus => {
        const ready = ipc.availability === 'ready'
        return {
          style,
          page,
          availability: ipc.availability,
          family: `qcf-${style.slice(4)}-p${page}`,
          url: ready ? `${ipc.styleUrl[style] ?? ipc.url}?p=${page}&style=${style}` : null,
          rel: ready ? `mushaf/${style.slice(4)}/p${page}.woff2` : null,
          bytes: ready ? 1 : 0,
        }
      })
      return { status: 'ok' as const, data }
    },
  }
  const api = new Proxy(actual.api, {
    get: (target, key) => (key in fake ? fake[key as keyof typeof fake] : Reflect.get(target, key)),
  })
  return { ...actual, api }
})

const measured = vi.hoisted(() => ({ calls: 0 }))
vi.mock('$lib/mushaf/layout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/mushaf/layout')>()
  return {
    ...actual,
    measure: (rendition: HTMLElement, block: HTMLElement) => {
      measured.calls++
      return actual.measure(rendition, block)
    },
  }
})

const QFS = 26

const frames = (n = 2) =>
  new Promise<void>((resolve) => {
    const step = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1)))
    step(n)
  })

/**
 * Waits for `done()` frame by frame, `ms` at most: never on a timer, which the fake clock holds (and `expect.poll`
 * would advance the fake clock between its tries).
 */
async function untilFrame(done: () => boolean, ms: number, what: string): Promise<void> {
  const end = performance.now() + ms
  while (!done()) {
    if (performance.now() > end) throw new Error(`${what} not within ${ms} ms`)
    await frames(1)
  }
}

const rect = (el: Element | null | undefined) => {
  const r = el?.getBoundingClientRect()
  return r ? [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100) : null
}

function snapshot(section: HTMLElement) {
  const top = [...section.querySelectorAll('.mp-glyphs')].at(-1)
  return {
    page: rect(section),
    block: rect(section.querySelector('.mp-block')),
    lines: [...(top?.querySelectorAll(':scope > .ln') ?? [])].map(rect),
    words: [...(top?.querySelectorAll('.w') ?? [])].map(rect),
  }
}

const renditions = (section: HTMLElement) =>
  [...section.querySelectorAll<HTMLElement>('.mp-block > .mp-glyphs')].map((el) => el.dataset.rendition)

/** An opacity transition a rendition started: from and to which opacity, over how long. */
interface Fade {
  rendition: string
  from: number
  to: number
  ms: number
}

/**
 * Records every rendition that ever mounts, the opacities seen on each frame, and every opacity transition a rendition
 * starts. A transition is read when the stack writes the rendition's inline opacity (`getAnimations()` brings the style
 * up to date, which starts it), and on no other style write: the watch must not compute styles at moments the page
 * itself would not.
 */
function watch(section: HTMLElement) {
  const mounted: string[] = []
  const fades: Fade[] = []
  const counted = new WeakSet<Animation>()
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes)
        if (n instanceof HTMLElement && n.classList.contains('mp-glyphs'))
          mounted.push(n.dataset.rendition ?? '?')
      const el = r.target
      if (r.type !== 'attributes' || !(el instanceof HTMLElement) || !el.classList.contains('mp-glyphs'))
        continue
      if (el.style.opacity === '') continue
      for (const a of el.getAnimations()) {
        if (counted.has(a) || !(a instanceof CSSTransition) || a.transitionProperty !== 'opacity') continue
        counted.add(a)
        const effect = a.effect instanceof KeyframeEffect ? a.effect : null
        const keyframes = effect?.getKeyframes() ?? []
        fades.push({
          rendition: el.dataset.rendition ?? '?',
          from: Number(keyframes[0]?.opacity),
          to: Number(keyframes.at(-1)?.opacity),
          ms: Number(effect?.getTiming().duration ?? 0),
        })
      }
    }
  })
  observer.observe(section, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
  const frames: number[][] = []
  let on = true
  const sample = () => {
    frames.push(
      [...section.querySelectorAll<HTMLElement>('.mp-block > .mp-glyphs')].map((el) =>
        Number(getComputedStyle(el).opacity),
      ),
    )
    if (on) requestAnimationFrame(sample)
  }
  requestAnimationFrame(sample)
  return {
    mounted,
    frames,
    fades,
    stop() {
      on = false
      observer.disconnect()
    },
  }
}

function layoutShifts() {
  const values: number[] = []
  const supported = PerformanceObserver.supportedEntryTypes?.includes('layout-shift') ?? false
  const observer = supported
    ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) values.push((entry as unknown as { value: number }).value)
      })
    : null
  observer?.observe({ type: 'layout-shift', buffered: false })
  return {
    supported,
    total: () => values.reduce((a, b) => a + b, 0),
    stop: () => observer?.disconnect(),
  }
}

let pages: Record<string, PageData> = {}

beforeAll(async () => {
  document.documentElement.dataset.theme = 'paper'
  quran.index = await fixtures.index()
  await document.fonts.load(`${QFS}px "qd-hafs"`)
  // Prefer the real QCF V2 page font when the dev packs exist (and the real V4 COLR face for the V4 page).
  const real = async (path: string): Promise<boolean> => {
    try {
      const res = await fetch(path)
      const head = new Uint8Array(await res.arrayBuffer()).slice(0, 4)
      return res.ok && String.fromCharCode(...head) === 'wOF2'
    } catch {
      return false
    }
  }
  if (await real('/data/dev-packs/mushaf/v2/p262.woff2')) ipc.url = '/data/dev-packs/mushaf/v2/p262.woff2'
  if (await real('/data/dev-packs/mushaf/v4/p262.woff2'))
    ipc.styleUrl.qcf_v4 = '/data/dev-packs/mushaf/v4/p262.woff2'
  pages = {
    'qcf_v2:262': await fixtures.page('qcf_v2', 262),
    'hafs:262': await fixtures.page('hafs', 262),
    'qcf_v2:263': await fixtures.page('qcf_v2', 263),
    'qcf_v4:262': await fixtures.page('qcf_v4', 262),
  }
})

const initialSettings = settings.value

beforeEach(() => {
  ipc.calls = 0
  ipc.availability = 'ready'
  ipc.hold = false
  ipc.held = []
  measured.calls = 0
  delete document.documentElement.dataset.motion
})

afterEach(() => {
  ipc.release()
  fonts.reset()
  shapeWarmer.reset()
  settings.value = initialSettings
})

afterAll(() => {
  delete document.documentElement.dataset.theme
})

function page(key: string): PageData {
  const data = pages[key]
  if (!data) throw new Error(`no page ${key}`)
  return data
}

async function mount(key: string, side: 'left' | 'right' = 'left') {
  const screen = await render(MushafPage, { data: page(key), qfs: QFS, side })
  const section = screen.container.querySelector<HTMLElement>('section.mp')
  if (!section) throw new Error('no section.mp')
  return { screen, section }
}

describe('the fallback → QCF swap (D13)', () => {
  it('waits up to 120 ms, paints the fallback, then cross-fades to QCF with zero layout shift', async () => {
    ipc.hold = true
    const started = performance.now()
    const { section } = await mount('qcf_v2:262')
    // §8.5 (b): nothing is drawn while the page waits for its face.
    expect(renditions(section)).toEqual([])
    await expect.poll(() => renditions(section), { timeout: 2000 }).toEqual(['fallback'])
    expect(performance.now() - started).toBeGreaterThanOrEqual(FONT_WAIT_MS - 5)
    await frames()
    expect(section.querySelector('.mp-glyphs')?.hasAttribute('data-unicode')).toBe(true)
    const before = snapshot(section)
    const measuredBefore = measured.calls

    const shifts = layoutShifts()
    const seen = watch(section)
    ipc.release()
    await expect.poll(() => renditions(section), { timeout: 3000 }).toEqual(['qcf'])
    await frames(3)
    seen.stop()
    shifts.stop()

    const after = snapshot(section)
    expect(after.page).toEqual(before.page)
    expect(after.block).toEqual(before.block)
    expect(after.lines).toEqual(before.lines)
    expect(after.words).not.toEqual(before.words)
    if (shifts.supported) expect(shifts.total()).toBe(0)
    // It was a cross-fade: both renditions were on screen together, the new one invisible on its first frame, then
    // faded in over `--dur-glyph-swap` while the fallback faded out.
    expect(seen.mounted).toEqual(['qcf'])
    expect(seen.frames.find((f) => f.length === 2)?.[1]).toBe(0)
    const ms = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--dur-glyph-swap'),
    )
    expect(ms).toBeGreaterThan(0)
    expect(seen.fades).toEqual([
      { rendition: 'fallback', from: 1, to: 0, ms },
      { rendition: 'qcf', from: 0, to: 1, ms },
    ])
    // The new rendition was measured for the highlight layer.
    expect(measured.calls).toBeGreaterThan(measuredBefore)
    expect(section.querySelector<HTMLElement>('.mp-glyphs')?.style.opacity).toBe('')
  })

  it('draws a face that is ready within 120 ms directly: the fallback never mounts', async () => {
    ipc.hold = true
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { section } = await mount('qcf_v2:262')
      const seen = watch(section)
      await vi.advanceTimersByTimeAsync(FONT_WAIT_MS - 20)
      // Still waiting for the face: nothing is drawn.
      expect(renditions(section)).toEqual([])
      // The face answers 100 ms into the wait and loads; its cold glyphs are warmed, a slice per task.
      ipc.release()
      await untilFrame(() => fonts.isReady('qcf_v2', 262), 5000, 'the face')
      // Past every wait (the face's and its glyphs'), the page shows its face, and only ever did.
      await vi.advanceTimersByTimeAsync(FONT_WAIT_MS + GLYPH_WAIT_MS)
      flushSync()
      expect(renditions(section)).toEqual(['qcf'])
      await frames()
      seen.stop()
      expect(seen.mounted).toEqual(['qcf'])
      expect(seen.fades).toEqual([])
      expect(ipc.calls).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders a page whose face is already loaded (and its glyphs warm) at once, without asking again', async () => {
    await fonts.ensure('qcf_v2', [262], 'interactive')
    expect(fonts.isReady('qcf_v2', 262)).toBe(true)
    // As the reader's warm-up leaves a neighbour (warmup.ts); a cold page is warmed first ("starts afresh…").
    shapeWarmer.markWarm(glyphKey('qcf_v2', 262, QFS))
    ipc.calls = 0
    const { section } = await mount('qcf_v2:262')
    flushSync()
    expect(renditions(section)).toEqual(['qcf'])
    expect(ipc.calls).toBe(0)
    // Fitted before the first paint: every ayah line carries its line-fit.
    const lines = [...section.querySelectorAll<HTMLElement>('.mp-glyphs .ln[data-k="ayah"]')]
    expect(lines.length).toBeGreaterThan(0)
    for (const ln of lines) expect(ln.style.getPropertyValue('--fx')).not.toBe('')
  })

  it('completes the swap without a transition under reduced motion', async () => {
    document.documentElement.dataset.motion = 'reduce'
    ipc.hold = true
    const { section } = await mount('qcf_v2:262')
    await expect.poll(() => renditions(section), { timeout: 2000 }).toEqual(['fallback'])
    const seen = watch(section)
    ipc.release()
    await expect.poll(() => renditions(section), { timeout: 2000 }).toEqual(['qcf'])
    await frames()
    seen.stop()
    expect(seen.frames.some((f) => f.some((o) => o > 0 && o < 1))).toBe(false)
    // Nor does any fade take time (base.css leaves every transition 0.01 ms long under reduced motion).
    expect(seen.fades.filter((f) => f.ms >= 1)).toEqual([])
  })
})

describe('unavailable and failed fonts (§8.5, §9.8)', () => {
  it('keeps the fallback quietly and shows the offline dot', async () => {
    ipc.availability = 'unavailable'
    const { section } = await mount('qcf_v2:262')
    await expect
      .poll(() => section.querySelector('.rs-dot')?.getAttribute('data-state'), { timeout: 2000 })
      .toBe('unavailable')
    expect(renditions(section)).toEqual(['fallback'])
    // The fallback keeps the measured hafs scale (only the hafs style is fitted per spread, unicodeFit.ts).
    const fallback = section.querySelector<HTMLElement>('.mp-glyphs[data-rendition="fallback"]')
    expect(fallback?.style.getPropertyValue('--glyph-scale')).toBe(String(STYLE_METRICS.hafs.glyphScale))
    const dot = section.querySelector<HTMLElement>('.rs-dot')
    expect(dot?.getAttribute('aria-label')).toBe('Offline — showing the Hafs font')
    expect(dot?.getAttribute('aria-disabled')).toBe('true')
    // The dot sits in the footer band, below the text block, on the spine side of an even (left) page.
    const block = section.querySelector('.mp-block')?.getBoundingClientRect()
    const box = dot?.getBoundingClientRect()
    if (!block || !box) throw new Error('no boxes')
    const centreY = box.top + box.height / 2
    expect(centreY).toBeCloseTo(block.bottom + (0.85 + 0.7) * QFS, 0)
    expect(box.left + box.width / 2).toBeGreaterThan(block.left + block.width / 2)
  })

  it('offers Retry on a failed font and cross-fades to QCF once it works', async () => {
    ipc.availability = 'failed'
    const { section } = await mount('qcf_v2:262')
    await expect
      .poll(() => section.querySelector('.rs-dot')?.getAttribute('data-state'), { timeout: 2000 })
      .toBe('failed')
    const dot = section.querySelector<HTMLButtonElement>('.rs-dot')
    expect(dot?.getAttribute('aria-label')).toBe("Couldn't download this page's font. Retry")
    ipc.availability = 'ready'
    dot?.click()
    await expect.poll(() => renditions(section), { timeout: 3000 }).toEqual(['qcf'])
    expect(section.querySelector('.rs-dot')).toBeNull()
  })
})

describe('style and page changes', () => {
  it('cross-fades a style change on the same page with zero layout shift', async () => {
    // The new style's face is loaded and its glyphs warm (the reader's prefetch and warm-up): the swap is under test,
    // not the waits (above), which on a slow machine would bring the fallback in between.
    await fonts.ensure('qcf_v2', [262], 'interactive')
    shapeWarmer.markWarm(glyphKey('qcf_v2', 262, QFS))
    const { screen, section } = await mount('hafs:262')
    await expect.poll(() => renditions(section)).toEqual(['qcf'])
    expect(
      section.querySelector<HTMLElement>('.mp-glyphs')?.style.getPropertyValue('--glyph-family'),
    ).toContain('qd-hafs')
    await frames()
    const before = snapshot(section)
    const shifts = layoutShifts()
    const seen = watch(section)
    await screen.rerender({ data: page('qcf_v2:262') })
    const topFamily = () =>
      [...section.querySelectorAll<HTMLElement>('.mp-block > .mp-glyphs')]
        .at(-1)
        ?.style.getPropertyValue('--glyph-family')
    await expect.poll(() => topFamily() ?? '', { timeout: 3000 }).toContain('qcf-v2-p262')
    await expect
      .poll(() => section.querySelectorAll('.mp-block > .mp-glyphs').length, { timeout: 3000 })
      .toBe(1)
    await frames(2)
    seen.stop()
    shifts.stop()
    const after = snapshot(section)
    expect(after.page).toEqual(before.page)
    expect(after.block).toEqual(before.block)
    expect(after.lines).toEqual(before.lines)
    if (shifts.supported) expect(shifts.total()).toBe(0)
    expect(seen.mounted).toEqual(['qcf'])
    expect(seen.frames.some((f) => f.length === 2)).toBe(true)
  })

  it('drops a pending rendition when the style returns to the one on screen', async () => {
    await fonts.ensure('qcf_v2', [262], 'interactive')
    shapeWarmer.markWarm(glyphKey('qcf_v2', 262, QFS))
    const { screen, section } = await mount('hafs:262')
    await expect.poll(() => renditions(section)).toEqual(['qcf'])
    await frames()
    // The QCF face is loaded, so the new style's rendition mounts at once (invisible, waiting for its fade)…
    void screen.rerender({ data: page('qcf_v2:262') })
    flushSync()
    expect(section.querySelectorAll('.mp-block > .mp-glyphs')).toHaveLength(2)
    // …and going back before that fade started drops it: the rendition on screen never moved.
    void screen.rerender({ data: page('hafs:262') })
    flushSync()
    const seen = watch(section)
    await frames(4)
    seen.stop()
    expect(renditions(section)).toEqual(['qcf'])
    expect(
      section.querySelector<HTMLElement>('.mp-glyphs')?.style.getPropertyValue('--glyph-family'),
    ).toContain('qd-hafs')
    expect(seen.frames.every((f) => f.length === 1 && f[0] === 1)).toBe(true)
  })

  it('while flipping, a page not painted in its font shows the fallback at once; QCF follows the flip (§8.11)', async () => {
    await fonts.ensure('qcf_v2', [262, 263], 'interactive')
    // Page 263 was drawn in its font before (its glyph images exist): a flip may show it at once.
    shapeWarmer.markWarm(glyphKey('qcf_v2', 263, QFS))
    shapeWarmer.markPainted(glyphKey('qcf_v2', 263, QFS))
    reader.flipping = true
    try {
      const { screen, section } = await mount('qcf_v2:262')
      flushSync()
      // No wait at all while flipping, and no warm-up: the fallback is drawn in the same flush and stays.
      expect(renditions(section)).toEqual(['fallback'])
      await frames(6)
      expect(renditions(section)).toEqual(['fallback'])
      expect(shapeWarmer.hasGlyphsNow(glyphKey('qcf_v2', 262, QFS))).toBe(false)
      await screen.rerender({ data: page('qcf_v2:263') })
      flushSync()
      expect(renditions(section)).toEqual(['qcf'])
      await screen.rerender({ data: page('qcf_v2:262') })
      flushSync()
      expect(renditions(section)).toEqual(['fallback'])
      // The flip ends: the page's glyphs are warmed, then the QCF rendition cross-fades in, and it counts as painted.
      reader.flipping = false
      await expect.poll(() => renditions(section), { timeout: 3000 }).toEqual(['qcf'])
      expect(shapeWarmer.wasPainted(glyphKey('qcf_v2', 262, QFS))).toBe(true)
    } finally {
      reader.flipping = false
    }
  })

  it('starts afresh on another page: no cross-fade between pages', async () => {
    await fonts.ensure('qcf_v2', [262, 263], 'interactive')
    // The glyphs' warm-up takes real time; the page's wait for it runs on the fake clock (see the top).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { screen, section } = await mount('qcf_v2:262')
      await vi.advanceTimersByTimeAsync(FONT_WAIT_MS + GLYPH_WAIT_MS)
      expect(renditions(section)).toEqual(['qcf'])
      const need = vi.spyOn(shapeWarmer, 'need')
      const seen = watch(section)
      await screen.rerender({ data: page('qcf_v2:263') })
      // A reader page's cold glyphs are measured and shaped first, in slices (warmup.ts, §8.18), then the page is drawn
      // directly in its font: never the fallback, never a cross-fade, however long the waits run.
      await vi.advanceTimersByTimeAsync(FONT_WAIT_MS + GLYPH_WAIT_MS)
      flushSync()
      expect(renditions(section)).toEqual(['qcf'])
      seen.stop()
      expect(seen.mounted).toEqual(['qcf'])
      expect(seen.fades).toEqual([])
      expect(need).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({ key: glyphKey('qcf_v2', 263, QFS) }),
        expect.any(Number),
      )
      expect(shapeWarmer.hasGlyphsNow(glyphKey('qcf_v2', 263, QFS))).toBe(true)
      expect(section.querySelector('.qd-warm')?.childElementCount).toBe(0)
      const first = page('qcf_v2:263').lines.flatMap((l) => l.words)[0]
      expect(section.querySelector('.mp-glyphs .w')?.getAttribute('data-w')).toBe(String(first?.id))
      expect(
        section.querySelector<HTMLElement>('.mp-glyphs')?.style.getPropertyValue('--glyph-family'),
      ).toContain('qcf-v2-p263')
    } finally {
      vi.useRealTimers()
    }
  })

  it('refits and re-measures after a qfs change', async () => {
    const { screen, section } = await mount('hafs:262')
    await expect.poll(() => renditions(section)).toEqual(['qcf'])
    const calls = measured.calls
    await screen.rerender({ qfs: QFS + 6 })
    await frames()
    expect(measured.calls).toBeGreaterThan(calls)
    expect(section.getBoundingClientRect().width).toBeCloseTo(21 * (QFS + 6), 0)
  })
})

describe('leaving a style (§8.5)', () => {
  // `fonts.init` listens to backend events: the mock runtime answers them.
  beforeAll(() => initIpc())

  /** The QCF V4 families in `document.fonts` (a FontFace's family may come back quoted). */
  const v4Faces = () =>
    [...document.fonts]
      .map((f) => f.family.replace(/^["']|["']$/g, ''))
      .filter((f) => f.startsWith('qcf-v4-'))
      .sort()

  /** The fonts store as the app runs it (`init` watches the style), on a webview that draws COLR. */
  function initFonts(style: MushafStyle): void {
    settings.value = { ...settings.value, mushafStyle: style, networkAllowed: false }
    fonts.init({
      app: { ...app.info, webviewVersion: 'Test 1.0' },
      online: false,
      settings: settings.value,
      decor: { installed: false, surahHeaderUrl: null, quranCommonUrl: null, suraNamesUrl: null },
    } as unknown as Bootstrap)
    fonts.v4Supported = true
    flushSync()
  }

  function setStyle(style: MushafStyle): void {
    settings.value = { ...settings.value, mushafStyle: style }
    flushSync()
  }

  it('unloads every QCF V4 face once the reader moved to QCF V2, keeping the one on screen until it is replaced', async () => {
    initFonts('qcf_v4')
    // The page and its prefetched neighbours, as the reader leaves them.
    await fonts.ensure('qcf_v4', [260, 261, 262, 263, 264], 'interactive')
    expect(v4Faces()).toHaveLength(5)
    const { screen, section } = await mount('qcf_v4:262')
    // Cold glyphs: warmed first, or after the waits the fallback, then a cross-fade (either way within seconds).
    await expect.poll(() => renditions(section), { timeout: 3000 }).toEqual(['qcf'])
    expect(document.getElementById(PALETTE_STYLE_ID)?.textContent).toContain('qcf-v4-p262')

    // Leaving V4: the faces nothing draws go at once; page 262 is still drawn in V4 until its V2 rendition is in.
    setStyle('qcf_v2')
    expect(v4Faces()).toEqual(['qcf-v4-p262'])
    expect([...fonts.v4Families]).toEqual(['qcf-v4-p262'])

    // Every frame of the swap: while a V4 rendition is in the DOM, its face is loaded.
    const unfaced: number[] = []
    let on = true
    const sample = () => {
      const v4Layer = [...section.querySelectorAll<HTMLElement>('.mp-block > .mp-glyphs')].some((el) =>
        el.style.getPropertyValue('--glyph-family').includes('qcf-v4-p262'),
      )
      if (v4Layer && v4Faces().length === 0) unfaced.push(performance.now())
      if (on) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    await screen.rerender({ data: page('qcf_v2:262') })
    await expect
      .poll(
        () =>
          [...section.querySelectorAll<HTMLElement>('.mp-block > .mp-glyphs')].map((el) =>
            el.style.getPropertyValue('--glyph-family'),
          ),
        { timeout: 3000 },
      )
      .toEqual([expect.stringContaining('qcf-v2-p262')])
    await expect.poll(() => v4Faces(), { timeout: 1000 }).toEqual([])
    on = false
    expect(unfaced).toEqual([])
    expect(fonts.v4Families.size).toBe(0)
    expect(fonts.state('qcf_v4', 262)).toBeNull()
    expect(document.getElementById(PALETTE_STYLE_ID)?.textContent ?? '').toBe('')
    // The style on screen keeps its faces.
    expect(fonts.isReady('qcf_v2', 262)).toBe(true)

    // Coming back loads the V4 face again on demand.
    setStyle('qcf_v4')
    await screen.rerender({ data: page('qcf_v4:262') })
    await expect.poll(() => fonts.isReady('qcf_v4', 262), { timeout: 3000 }).toBe(true)
    expect(v4Faces()).toEqual(['qcf-v4-p262'])
  })

  it('never loads a late answer for a style the reader has left', async () => {
    initFonts('qcf_v4')
    ipc.hold = true
    const prefetch = fonts.ensure('qcf_v4', [100, 101], 'prefetch')
    await Promise.resolve()
    setStyle('qcf_v2')
    ipc.release()
    await prefetch
    expect(v4Faces()).toEqual([])
    expect(fonts.state('qcf_v4', 100)).toBeNull()
    expect(fonts.v4Families.size).toBe(0)
  })

  it('treats a style the reader returns to as shown again (its faces stay, under the 24-face LRU)', async () => {
    initFonts('qcf_v2')
    await fonts.ensure('qcf_v2', [10, 11, 12], 'prefetch')
    setStyle('hafs')
    expect(fonts.state('qcf_v2', 10)).toBeNull()
    setStyle('qcf_v2')
    await fonts.ensure('qcf_v2', [10, 11, 12], 'prefetch')
    expect([10, 11, 12].map((p) => fonts.isReady('qcf_v2', p))).toEqual([true, true, true])
  })
})

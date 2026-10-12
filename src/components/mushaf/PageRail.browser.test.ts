/**
 * PageRail in a real browser (§8.11, §10.1, §11.3; WP8f acceptance), mounted in the real `App` on the browser mock:
 * `P` shows and focuses a labelled `role=slider`; its keys keep book semantics (← is the next page, Shift ×10, the juz
 * keys, Home/End), preview at once and turn once; Enter and Escape give focus back, and Escape closes the rail before
 * the reader's own Escape; the rail runs right to left with page 1 at the right end in both UI languages; the pointer
 * under the pages' frame (the page-number strip and below, across the book) or at the bottom edge of the canvas
 * reveals it above the dock (in zen too), never beside the book or over the dock, the memorisation bars or a toast, and
 * the zone follows a zoomed book as it scrolls; a drag previews in the FlipHUD and its release turns once, and a
 * pointer never takes focus.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page as browserPage, userEvent } from 'vitest/browser'
import '../../app.css'
import { bootApp, resetApp, settle } from '../shell/testing/boot'
import { FRAME_BOTTOM, PH } from '$lib/mushaf/geometry'
import { quran, reader, settings, ui } from '$lib/stores'
import { HOT_ZONE_PX, railState } from './PageRail.svelte'

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const rect = (selector: string) => $(selector)?.getBoundingClientRect() ?? new DOMRect()
const RAIL = '[data-qd-page-rail]'
const HUD = '[data-qd-flip-hud]'

/** Waits (real time) until `done()` holds, checked after every wait (MushafView.browser.test.ts: a long task in WebKitGTK). */
async function until(done: () => boolean, timeout = 5_000, message = 'condition'): Promise<void> {
  const end = performance.now() + timeout
  for (;;) {
    flushSync()
    if (done()) return
    if (performance.now() >= end) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`${message} not met within ${timeout} ms`)
}

/**
 * Waits up to `frames` rendering frames for `done`: for what an exit transition removes, which advances on frames, not
 * on the clock. Right after a turn Linux WebKit rasterises the new spread in software, and that first frame takes
 * 0.2–0.4 s on an idle machine and longer on a loaded CI runner; the strip's 160 ms exit needs a few frames, however
 * long they are.
 */
async function untilFrames(done: () => boolean, frames: number, message: string): Promise<void> {
  for (let i = 0; i <= frames; i++) {
    flushSync()
    if (done()) return
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }
  throw new Error(`${message} not met within ${frames} frames`)
}

async function boot(settings: Parameters<typeof bootApp>[0] = {}): Promise<void> {
  await bootApp({
    ...settings,
    settings: { mushafStyle: 'hafs', pageTurnAnimation: false, ...settings.settings },
  })
  await until(() => $('section.mp') !== null, 5_000, 'the pages')
}

async function goTo(page: number): Promise<void> {
  reader.goToPage(page, { push: false, transition: false })
  await until(() => reader.visiblePages.includes(page) && !reader.turning, 5_000, `turn to ${page}`)
  await settle(40)
}

/** `P`, then the rail has focus. */
async function openWithP(): Promise<HTMLElement> {
  await userEvent.keyboard('p')
  await until(() => document.activeElement?.matches(RAIL) === true, 2_000, 'the focused rail')
  return $(RAIL) as HTMLElement
}

const now = () => Number($(RAIL)?.getAttribute('aria-valuenow'))

/** A pointer event at a client x on the rail's track. */
function pointer(type: string, x: number, target: Element): void {
  const y = target.getBoundingClientRect().top + 14
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      isPrimary: true,
      pointerId: 7,
      pointerType: 'mouse',
    }),
  )
}

/** The client x of a page on the track (page 1 at the right end). */
function xOf(page: number): number {
  const t = rect(`${RAIL} .track`)
  return t.right - ((page - 1) / 603) * t.width
}

/** The bottom edge of the pages' frame on screen (client px): the page-number strip starts there. */
function frameBottom(): number {
  const s = rect('[data-qd-stage]')
  return s.top + s.height * (FRAME_BOTTOM / PH)
}

/** The real mouse to client (x, y), aimed at the canvas (the page-number band takes no pointer events). */
async function hoverAt(x: number, y: number): Promise<void> {
  const view = $('.mushaf-view') as HTMLElement
  const r = view.getBoundingClientRect()
  await userEvent.hover(view, { position: { x: x - r.left, y: y - r.top } })
}

const centreX = (r: DOMRect) => r.left + r.width / 2

/**
 * The revealed rail at rest: its fly-in over (Svelte cancels an intro's animation when it ends) and no lift transition
 * running. A fixed wait is not enough: headless WebKitGTK's software-rendered frames can leave an animation sampled
 * part-way long after its duration.
 */
async function railAtRest(): Promise<HTMLElement> {
  await until(() => $(RAIL) !== null, 2_000, 'the rail')
  const rail = $(RAIL) as HTMLElement
  await until(() => rail.getAnimations().length === 0, 2_000, 'the rail at rest')
  return rail
}

afterEach(async () => {
  // The mouse is shared by the tests: parked on the title bar, it leaves no rail open in the next app (the reveal zone
  // reaches up to the page number) and no tooltip behind.
  await userEvent.hover(document.querySelector('.titlebar, header') ?? document.body)
  await settle(250)
  resetApp()
  vi.restoreAllMocks()
  await browserPage.viewport(1280, 800)
})

describe('the rail as a slider (§8.11)', () => {
  it('shows on P and takes focus as a labelled slider with the page, surah and juz as its value text', async () => {
    await boot()
    await goTo(262)
    expect($(RAIL)).toBeNull()
    const rail = await openWithP()
    expect(rail.getAttribute('role')).toBe('slider')
    expect(rail.getAttribute('aria-label')).toBe('Page rail')
    expect(rail.getAttribute('aria-orientation')).toBe('horizontal')
    expect(rail.getAttribute('aria-valuemin')).toBe('1')
    expect(rail.getAttribute('aria-valuemax')).toBe('604')
    expect(now()).toBe(262)
    expect(rail.getAttribute('aria-valuetext')).toBe('Page 262, Al-Hijr, Juz 14')
    expect(rail.tabIndex).toBe(0)
    // A focused rail is a floating layer (§7.4): Escape reaches it first.
    expect(ui.floating).toBeGreaterThan(0)
  })

  it('steps in book order: ← next, → previous, ↑/↓, Shift ×10; previews at once and turns once after the last step', async () => {
    await boot()
    await goTo(262)
    const jumps = reader.navBack.length
    const go = vi.spyOn(reader, 'goToPage')
    await openWithP()
    await userEvent.keyboard('{ArrowLeft}')
    expect(now()).toBe(263)
    await userEvent.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    expect(now()).toBe(273)
    await userEvent.keyboard('{ArrowRight}')
    expect(now()).toBe(272)
    await userEvent.keyboard('{ArrowUp}{ArrowUp}{ArrowDown}')
    expect(now()).toBe(273)
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}')
    expect(now()).toBe(263)
    // Only a preview so far: the FlipHUD names it, the page has not moved.
    expect(reader.visiblePages).toEqual([261, 262])
    expect(railState.preview).toBe(263)
    await until(() => $(HUD) !== null, 1_000, 'the HUD')
    expect($(HUD)?.textContent).toContain('Al-Hijr · Page 263 · Juz 14')
    await until(() => reader.visiblePages.includes(263), 2_000, 'the turn')
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(263, { push: true })
    expect(reader.navBack.length).toBe(jumps + 1)
    expect(now()).toBe(263)
    // The rail keeps focus for more steps; the next turn of the same visit is not another history entry.
    await userEvent.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    await until(() => reader.visiblePages.includes(273), 2_000, 'the second turn')
    expect(go).toHaveBeenLastCalledWith(273, { push: false })
    expect(reader.navBack.length).toBe(jumps + 1)
  })

  it('goes to the ends with Home and End and from juz to juz with PageDown and PageUp', async () => {
    await boot()
    await goTo(262)
    await openWithP()
    const juzPage = (n: number) => quran.pageOfAyah('v2', quran.juzRange(n).from)
    await userEvent.keyboard('{PageDown}')
    expect(now()).toBe(juzPage(15))
    await userEvent.keyboard('{PageUp}{PageUp}')
    expect(now()).toBe(juzPage(13))
    await userEvent.keyboard('{End}')
    expect(now()).toBe(604)
    await userEvent.keyboard('{Home}')
    expect(now()).toBe(1)
    await until(() => reader.visiblePages.includes(1), 2_000, 'the turn to page 1')
  })

  it('turns at once on Enter and gives focus back', async () => {
    await boot()
    await goTo(262)
    const go = vi.spyOn(reader, 'goToPage')
    await openWithP()
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}{Enter}')
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(265, { push: true })
    expect(document.activeElement?.matches(RAIL)).toBe(false)
    // Nothing holds it (no pointer near): it leaves at once, and the strip goes after its exit transition.
    expect(railState.open).toBe(false)
    await until(() => reader.visiblePages.includes(265), 2_000, 'the turn')
    await untilFrames(() => $(RAIL) === null, 60, 'the rail gone')
    expect(ui.floating).toBe(0)
  })

  it('drops the preview on Escape, gives focus back, and leaves the reader’s selection alone', async () => {
    await boot()
    await goTo(262)
    const ayah = reader.visibleRange.from + 3
    reader.select(ayah)
    const go = vi.spyOn(reader, 'goToPage')
    await openWithP()
    await userEvent.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    expect(now()).toBe(272)
    await userEvent.keyboard('{Escape}')
    await settle(500)
    expect(go).not.toHaveBeenCalled()
    expect(railState.preview).toBeNull()
    expect(reader.visiblePages).toEqual([261, 262])
    // The rail took Escape as a floating layer: the reader's Escape (clear the selection) did not run.
    expect(reader.selection?.fromAyahId).toBe(ayah)
    expect(document.activeElement?.matches(RAIL)).toBe(false)
    expect($(RAIL)).toBeNull()
    expect(ui.floating).toBe(0)
    // A second Escape now reaches the reader.
    await userEvent.keyboard('{Escape}')
    expect(reader.selection).toBeNull()
  })
})

describe('book order, never mirrored (§11.3)', () => {
  for (const uiLanguage of ['en', 'ar'] as const) {
    it(`runs right to left with page 1 at the right end (${uiLanguage} UI)`, async () => {
      await boot({ settings: { uiLanguage } })
      await goTo(262)
      await openWithP()
      const track = rect(`${RAIL} .track`)
      const ticks = [...document.querySelectorAll(`${RAIL} .tick`)].map((t) => t.getBoundingClientRect())
      expect(ticks).toHaveLength(30)
      const centre = (r: DOMRect) => r.left + r.width / 2
      const first = ticks[0]
      const last = ticks.at(-1)
      if (!first || !last) throw new Error('no ticks')
      // Juz 1 (page 1) at the right end, juz 30 (page 582) near the left end.
      expect(Math.abs(centre(first) - track.right)).toBeLessThan(1.5)
      expect(Math.abs(centre(last) - (track.right - (581 / 603) * track.width))).toBeLessThan(1.5)
      // The thumb (page 262) between them, the fill from the right end to the thumb.
      const thumb = rect(`${RAIL} .thumb`)
      expect(Math.abs(centre(thumb) - xOf(262))).toBeLessThan(1.5)
      const fill = rect(`${RAIL} .fill`)
      expect(Math.abs(fill.right - track.right)).toBeLessThan(1.5)
      expect(Math.abs(fill.left - xOf(262))).toBeLessThan(1.5)
      // Juz labels in Eastern Arabic numbers, ١ at the right end.
      const labels = [...document.querySelectorAll<HTMLElement>(`${RAIL} .tick-label`)]
      expect(labels[0]?.textContent).toBe('١')
      expect(labels.at(-1)?.textContent).toBe('٣٠')
      expect(centre(labels[0]?.getBoundingClientRect() ?? new DOMRect())).toBeGreaterThan(
        centre(labels.at(-1)?.getBoundingClientRect() ?? new DOMRect()),
      )
      // ← is still the next page in the Arabic UI.
      await userEvent.keyboard('{ArrowLeft}')
      expect(now()).toBe(263)
      // The live label sits over the thumb, inside the track.
      const bubble = rect(`${RAIL} .bubble`)
      expect(bubble.left).toBeGreaterThanOrEqual(track.left - 0.5)
      expect(bubble.right).toBeLessThanOrEqual(track.right + 0.5)
      expect(Math.abs(centre(bubble) - xOf(263))).toBeLessThan(2)
      expect($(`${RAIL} .bubble`)?.textContent?.trim()).toBe(
        uiLanguage === 'ar' ? 'الحجر · ص ٢٦٣ · ج ١٤' : 'Al-Hijr · Page 263 · Juz 14',
      )
    })
  }
})

describe('the pointer (§8.11, §10.2)', () => {
  it('reveals the rail from the canvas-bottom band beside the dock, above the dock, and lets it go', async () => {
    await boot({ size: [1600, 1000] })
    await goTo(262)
    const view = $('.mushaf-view') as HTMLElement
    const r = view.getBoundingClientRect()
    await userEvent.hover(view, { position: { x: 90, y: r.height - 6 } })
    await until(() => $(RAIL) !== null, 2_000, 'the rail')
    const appeared = rect(RAIL)
    await railAtRest()
    const rail = rect(RAIL)
    const dock = rect('[data-qd-dock-pill]')
    expect(rail.height).toBe(28)
    expect(rail.bottom).toBeLessThanOrEqual(dock.top - 4)
    // It appears where it floats: only its 6 px fly-in moves it, never a rise from the canvas edge through the dock.
    expect(Math.abs(appeared.bottom - rail.bottom)).toBeLessThanOrEqual(6.5)
    expect(rail.left).toBeGreaterThanOrEqual(r.left)
    expect(rail.right).toBeLessThanOrEqual(r.right)
    // Hovering never takes focus.
    expect(document.activeElement?.matches(RAIL)).toBe(false)
    expect(ui.floating).toBe(0)
    // Up onto the rail keeps it; away from it lets it go after a short grace.
    await userEvent.hover(view, {
      position: { x: rail.left - r.left + rail.width / 2, y: rail.top - r.top + 14 },
    })
    await settle(600)
    expect($(RAIL)).not.toBeNull()
    expect($(`${RAIL} .tick-label`)?.getBoundingClientRect().width).toBeGreaterThan(0)
    await userEvent.hover(view, { position: { x: r.width / 2, y: 120 } })
    await until(() => $(RAIL) === null, 2_000, 'the rail gone')
  })

  it('reveals just under the page frame, over the page number, and not above it', async () => {
    await boot({ size: [1600, 1000] })
    await goTo(262)
    const view = rect('.mushaf-view')
    const right = $('section.mp[data-side="right"]') as HTMLElement
    const x = centreX(right.getBoundingClientRect())
    const edge = frameBottom()
    // The zone starts where the page-number band does, well above the canvas-bottom band and the dock.
    expect(Math.abs(edge - (right.querySelector('.mp-foot')?.getBoundingClientRect().top ?? 0))).toBeLessThan(
      0.5,
    )
    expect(edge).toBeLessThan(view.bottom - HOT_ZONE_PX - 40)
    // In the frame's band, just above its bottom edge: nothing.
    await hoverAt(x, edge - 4)
    await settle(300)
    expect($(RAIL)).toBeNull()
    // Just under it: the rail, above the dock, without taking focus.
    await hoverAt(x, edge + 4)
    await railAtRest()
    const rail = rect(RAIL)
    expect(rail.bottom).toBeLessThanOrEqual(rect('[data-qd-dock-pill]').top - 4)
    expect(document.activeElement?.matches(RAIL)).toBe(false)
    expect(ui.floating).toBe(0)
    // Over the page number it stays; up on the text it leaves after the grace.
    const medallion = right.querySelector('.mp-foot-medallion')?.getBoundingClientRect() ?? new DOMRect()
    expect(medallion.top).toBeGreaterThanOrEqual(edge - 0.5)
    await hoverAt(centreX(medallion), medallion.top + medallion.height / 2)
    await settle(600)
    expect($(RAIL)).not.toBeNull()
    await hoverAt(x, 300)
    await until(() => $(RAIL) === null, 2_000, 'the rail gone')
  })

  it('waits for the pointer to rest: moving on through the zone never reveals it', async () => {
    await boot({ size: [1600, 1000] })
    await goTo(262)
    const view = $('.mushaf-view') as HTMLElement
    const x = centreX(rect('section.mp[data-side="right"]'))
    const y = frameBottom() + 8
    const move = (dy: number) =>
      view.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          clientX: x,
          clientY: y + dy,
          isPrimary: true,
          pointerType: 'mouse',
        }),
      )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      // On its way down to the dock: 6 px every 60 ms, 240 ms in the zone and never a 90 ms rest.
      for (const dy of [0, 6, 12, 18]) {
        move(dy)
        vi.advanceTimersByTime(60)
        flushSync()
        expect(railState.open, `${dy} px under the frame`).toBe(false)
      }
      // A jitter of 2 px is still a rest: 90 ms after the last real move, the rail.
      move(20)
      vi.advanceTimersByTime(40)
      flushSync()
      expect(railState.open).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never reveals over the floating sidebar or its scrim in a narrow window', async () => {
    await boot({ size: [880, 800] })
    await goTo(262)
    ui.openSidebar()
    await until(() => $('.sidebar.floating') !== null && $('.scrim') !== null, 2_000, 'the floating sidebar')
    await settle(300)
    const sidebar = $('.sidebar.floating') as HTMLElement
    const sb = sidebar.getBoundingClientRect()
    const stage = rect('[data-qd-stage]')
    const y = frameBottom() + 10
    // Points under the pages' frame, across the book: in the zone, were the sidebar and its scrim not over it.
    const overSidebar = { x: sb.right - 10, y }
    const overScrim = { x: Math.max(sb.right + 40, centreX(stage)), y }
    expect(overSidebar.x).toBeGreaterThan(stage.left)
    expect(overScrim.x).toBeLessThan(stage.right)
    expect(y).toBeLessThan(Math.min(sb.bottom, rect('.mushaf-view').bottom - HOT_ZONE_PX))
    await userEvent.hover(sidebar, { position: { x: overSidebar.x - sb.left, y: y - sb.top } })
    await settle(400)
    expect($(RAIL)).toBeNull()
    const scrim = $('.scrim') as HTMLElement
    expect(document.elementFromPoint(overScrim.x, y)).toBe(scrim)
    const s = scrim.getBoundingClientRect()
    await userEvent.hover(scrim, { position: { x: overScrim.x - s.left, y: y - s.top } })
    await settle(400)
    expect($(RAIL)).toBeNull()
  })

  it('does not reveal beside the book, only under it', async () => {
    await boot({ settings: { pageMode: 'single' } })
    await goTo(262)
    const view = rect('.mushaf-view')
    const stage = rect('[data-qd-stage]')
    const y = frameBottom() + 10
    expect(stage.left - 100).toBeGreaterThan(view.left)
    expect(y).toBeLessThan(view.bottom - HOT_ZONE_PX)
    await hoverAt(stage.left - 100, y)
    await settle(300)
    expect($(RAIL)).toBeNull()
    await hoverAt(centreX(stage), y)
    await until(() => $(RAIL) !== null, 2_000, 'the rail')
  })

  it('follows a zoomed book: the bottom band, then the strip under the frame once it scrolls into view', async () => {
    await boot()
    await goTo(262)
    await settings.update({ zoomPct: 200 })
    await until(() => reader.scrolls && reader.zoomPct === 200, 2_000, 'zoomed')
    await settle(200)
    const view = rect('.mushaf-view')
    const scroller = $('.mushaf-view [data-scroll-area-viewport]') as HTMLElement
    // Where the frame's bottom edge lands with the book scrolled to its end.
    scroller.scrollTop = scroller.scrollHeight
    await settle(100)
    const y = frameBottom() + 12
    expect(y).toBeLessThan(view.bottom - HOT_ZONE_PX - 8)
    scroller.scrollTop = 0
    await settle(100)
    expect(frameBottom()).toBeGreaterThan(view.bottom)
    // Above the bottom band, with the frame's bottom out of view: nothing.
    await hoverAt(centreX(view), y)
    await settle(300)
    expect($(RAIL)).toBeNull()
    // The book scrolls under the resting pointer until its page-number strip is there: the rail comes, no move needed.
    scroller.scrollTop = scroller.scrollHeight
    await until(() => $(RAIL) !== null, 2_000, 'the rail')
    expect(frameBottom()).toBeLessThanOrEqual(y)
  })

  it('never reveals over the memorisation toolbar, and floats above it when revealed from the page number', async () => {
    // The blank style: WebKitGTK without a GPU (CI) blurs every hidden word in software, seconds a frame (MushafView's
    // toolbar test).
    await boot({ settings: { pageMode: 'spread', memoHideStyle: 'blank' } })
    await goTo(50)
    await userEvent.hover(document.querySelector('.titlebar, header') ?? document.body)
    await userEvent.keyboard('e')
    await until(() => $('[data-qd-memo-toolbar]') !== null, 2_000, 'the toolbar')
    await settle(300)
    const toolbar = $('[data-qd-memo-toolbar]') as HTMLElement
    const bar = toolbar.getBoundingClientRect()
    // The toolbar lies in the zone (under the frame), so only the slot's exception keeps the rail away.
    expect(bar.top).toBeGreaterThan(frameBottom())
    await hoverAt(bar.left + 6, bar.top + bar.height / 2)
    await settle(400)
    expect($(RAIL)).toBeNull()
    const medallion = rect('section.mp[data-side="right"] .mp-foot-medallion')
    await hoverAt(centreX(medallion), medallion.top + medallion.height / 2)
    await railAtRest()
    expect(rect(RAIL).bottom).toBeLessThanOrEqual(toolbar.getBoundingClientRect().top - 4)
  })

  it('reveals under the frame in zen, 8 px off the bottom while the dock stays hidden', async () => {
    await boot({ size: [1800, 1300] })
    await goTo(262)
    ui.setZen(true)
    try {
      await settle(300)
      const view = rect('.mushaf-view')
      const right = rect('section.mp[data-side="right"]')
      const y = frameBottom() + 6
      // Above the zen dock's reveal zone (the window's bottom 80 px).
      expect(y).toBeLessThan(window.innerHeight - 80)
      await hoverAt(centreX(right), y)
      await railAtRest()
      expect(ui.zenDock).toBe(false)
      expect(Math.abs(rect(RAIL).bottom - (view.bottom - 8))).toBeLessThan(1.5)
    } finally {
      ui.setZen(false)
      await settle(100)
    }
  })

  it('never reveals over a toast above the dock, in the zone', async () => {
    await boot()
    await goTo(262)
    ui.toast({ message: 'Bookmarked 2:255', action: { label: 'Undo', run: () => {} } })
    await settle(500)
    const toast = $('[data-sonner-toast]') as HTMLElement
    const box = toast.getBoundingClientRect()
    const stage = rect('[data-qd-stage]')
    // A point of the toast under the pages' frame, across the book: in the zone, so only the exception holds the rail.
    const at = { x: box.width / 2, y: box.height - 6 }
    expect(box.top + at.y).toBeGreaterThan(frameBottom())
    expect(box.left + at.x).toBeGreaterThan(stage.left)
    expect(box.left + at.x).toBeLessThan(stage.right)
    await userEvent.hover(toast, { position: at })
    await settle(400)
    expect($(RAIL)).toBeNull()
  })

  it('does not reveal over the dock', async () => {
    await boot({ size: [1600, 1000] })
    await goTo(262)
    // The pointer over the dock's content, in its bottom band (the pill is behind it).
    const dock = $('[data-qd-dock] .pane') as HTMLElement
    const d = dock.getBoundingClientRect()
    await userEvent.hover(dock, { position: { x: d.width / 2, y: d.height - 4 } })
    await settle(400)
    expect($(RAIL)).toBeNull()
  })

  it('previews a drag in the FlipHUD and turns once on release', async () => {
    await boot()
    await goTo(262)
    await openWithP()
    ;(document.activeElement as HTMLElement).blur()
    const rail = $(RAIL) as HTMLElement
    const go = vi.spyOn(reader, 'goToPage')
    pointer('pointerdown', xOf(400), rail)
    flushSync()
    expect(railState.preview).toBe(400)
    await until(() => $(HUD)?.textContent?.includes('Page 400') === true, 1_000, 'the HUD at 400')
    pointer('pointermove', xOf(450), rail)
    flushSync()
    expect(now()).toBe(450)
    await until(() => $(HUD)?.textContent?.includes('Page 450') === true, 1_000, 'the HUD at 450')
    expect(go).not.toHaveBeenCalled()
    expect(reader.visiblePages).toEqual([261, 262])
    pointer('pointerup', xOf(450), rail)
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(450, { push: true })
    await until(() => reader.visiblePages.includes(450), 2_000, 'the turn')
    // The HUD fades 600 ms after the last preview step.
    await until(() => $(HUD) === null, 2_000, 'the HUD gone')
  })

  it('turns to the clicked page without taking focus, so ← keeps turning pages', async () => {
    await boot({ size: [1600, 1000] })
    await goTo(262)
    const view = $('.mushaf-view') as HTMLElement
    const r = view.getBoundingClientRect()
    await userEvent.hover(view, { position: { x: 90, y: r.height - 6 } })
    await until(() => $(RAIL) !== null, 2_000, 'the rail')
    await settle(250)
    const rail = $(RAIL) as HTMLElement
    const box = rail.getBoundingClientRect()
    await userEvent.click(rail, { position: { x: xOf(300) - box.left, y: 14 } })
    await until(() => reader.visiblePages.includes(300), 2_000, 'the turn to 300')
    expect(document.activeElement?.matches(RAIL)).toBe(false)
    const shown = Math.max(...reader.visiblePages)
    await userEvent.keyboard('{ArrowLeft}')
    await until(() => Math.min(...reader.visiblePages) === shown + 1, 2_000, 'the next spread')
  })
})

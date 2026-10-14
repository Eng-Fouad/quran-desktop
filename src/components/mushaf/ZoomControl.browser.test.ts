/**
 * The zoom control in the real `App` on the browser mock: its place in the canvas's top inline-end corner, clear of the
 * page, the dock, the slot and the turn zones at the scenario sizes; + / the level / − around the canvas centre, the
 * limits, names, tooltips and keys; how it shows (quieter away from the canvas, quiet over it, full strength over
 * itself and after any zoom); yielding to the text of a zoomed book; the wheel over it; zen; reduced motion.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page as browserPage, userEvent } from 'vitest/browser'
import '../../app.css'
import { bootApp, resetApp, settle } from '../shell/testing/boot'
import type { Settings } from '$lib/ipc/bindings'
import { reader, settings, shortcuts, ui } from '$lib/stores'
import { A11Y_TAB_STOP } from '$lib/stores/reader.svelte'
import { ZEN_TOP_ZONE_PX } from '$lib/stores/ui.svelte'
import { REACH_PX } from './canvasControl.svelte'

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const rect = (selector: string) => $(selector)?.getBoundingClientRect() ?? new DOMRect()
const ZC = '[data-qd-zoom-control]'
const IN = `${ZC} [data-zoom="in"]`
const FIT = `${ZC} [data-zoom="fit"]`
const OUT = `${ZC} [data-zoom="out"]`
const view = () => $('.mushaf-view') as HTMLElement
const viewport = () => view().querySelector<HTMLElement>('[data-scroll-area-viewport]') as HTMLElement
const shownAs = () => $(ZC)?.dataset.state
const opacity = () => Number(getComputedStyle($(ZC) as HTMLElement).opacity)
const SIDEBAR_CLOSED: Settings['sidebar'] = { open: false, widthPx: 300, tab: 'index' }

async function until(done: () => boolean, timeout = 5_000, message = 'condition'): Promise<void> {
  const end = performance.now() + timeout
  while (performance.now() < end) {
    flushSync()
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`${message} not met within ${timeout} ms`)
}

async function boot(options: Parameters<typeof bootApp>[0] = {}): Promise<void> {
  await bootApp({
    size: [1600, 1000],
    ...options,
    settings: { mushafStyle: 'hafs', pageTurnAnimation: false, ...options.settings },
  })
  await until(() => $('section.mp .mp-block') !== null && $(ZC) !== null, 5_000, 'the pages and the control')
}

async function goTo(page: number): Promise<void> {
  reader.goToPage(page, { push: false, transition: false })
  await until(() => reader.visiblePages.includes(page) && !reader.turning, 5_000, `turn to ${page}`)
  await settle(80)
}

/** Moves the pointer over the canvas at a point relative to its top left (default: its centre). */
async function hoverCanvas(x?: number, y?: number): Promise<void> {
  const v = view()
  await userEvent.hover(v, { position: { x: x ?? v.clientWidth / 2, y: y ?? v.clientHeight / 2 } })
  await settle(250)
}

/** Parks the pointer on the navigation rail, off the canvas. */
async function hoverOff(): Promise<void> {
  await userEvent.hover($('nav') as HTMLElement)
  await settle(250)
}

const intersects = (a: DOMRect, b: DOMRect) =>
  a.width > 0 &&
  a.height > 0 &&
  b.width > 0 &&
  b.height > 0 &&
  a.left < b.right &&
  b.left < a.right &&
  a.top < b.bottom &&
  b.top < a.bottom

const rects = (selector: string) =>
  [...document.querySelectorAll(selector)].map((el) => el.getBoundingClientRect())

/** The book's text blocks as one box. */
function textBlock(): { left: number; top: number; right: number; bottom: number } {
  const blocks = rects('section.mp .mp-block')
  return {
    left: Math.min(...blocks.map((r) => r.left)),
    top: Math.min(...blocks.map((r) => r.top)),
    right: Math.max(...blocks.map((r) => r.right)),
    bottom: Math.max(...blocks.map((r) => r.bottom)),
  }
}

afterEach(async () => {
  ui.setZen(false)
  resetApp()
  vi.restoreAllMocks()
  await browserPage.viewport(1280, 800)
})

describe('ZoomControl: place', () => {
  it.each([
    ['a spread above the compact bar (1366×768)', [1366, 768], {}, false],
    ['the side card, sidebar closed (1920×1080)', [1920, 1080], { sidebar: SIDEBAR_CLOSED }, false],
    [
      'a single page beside the side card (1600×1000)',
      [1600, 1000],
      { pageMode: 'single', sidebar: SIDEBAR_CLOSED },
      false,
    ],
    ['a single page held at QFS_MIN (1024×700)', [1024, 700], {}, false],
    ['the side pane docked (1536×864)', [1536, 864], {}, true],
  ] as const)(
    "sits in the canvas's top inline-end corner, clear of the text, running heads, dock and slot: %s",
    async (_label, size, extra, pane) => {
      await boot({ size: [...size], settings: { ...extra } })
      await goTo(50)
      if (pane) {
        ui.openSidePane()
        await until(() => ui.paneDocked, 2_000, 'the docked side pane')
        await settle(200)
      }
      if ('sidebar' in extra) expect(reader.dock).toBe('side')
      const v = view().getBoundingClientRect()
      const zc = rect(ZC)
      expect(Math.abs(zc.top - v.top - 16)).toBeLessThan(1)
      expect(Math.abs(v.right - zc.right - 12)).toBeLessThan(1)
      expect(Math.abs(zc.width - 40)).toBeLessThan(0.5)
      expect(Math.abs(zc.height - 92)).toBeLessThan(1)
      const clear = [
        ...rects('section.mp .mp-block'),
        ...rects('section.mp .mp-head'),
        ...rects('[data-qd-region="dock"] [data-qd-dock-pill]'),
        ...rects('.mv-slot > *'),
      ]
      for (const r of clear) expect(intersects(zc, r)).toBe(false)
      await hoverCanvas()
      expect(shownAs()).toBe('quiet')
    },
  )

  it('Arabic UI: the top-left corner, + above −, the level in Eastern Arabic numbers and Arabic names', async () => {
    await boot({ settings: { uiLanguage: 'ar' } })
    await goTo(50)
    const v = view().getBoundingClientRect()
    const zc = rect(ZC)
    expect(Math.abs(zc.left - v.left - 12)).toBeLessThan(1)
    expect(rect(IN).top).toBeLessThan(rect(OUT).top)
    expect($(FIT)?.textContent?.trim()).toBe('١٠٠٪')
    expect($(ZC)?.getAttribute('aria-label')).toBe('التكبير')
    expect($(IN)?.getAttribute('aria-label')).toBe('تكبير')
    expect($(OUT)?.getAttribute('aria-label')).toBe('تصغير')
    expect($(FIT)?.getAttribute('aria-label')).toBe('التكبير ١٠٠٪، ملاءمة النافذة')
    // The widest level fits its button.
    await settings.update({ zoomPct: 300 })
    await settle(120)
    const level = $(FIT) as HTMLElement
    expect(level.textContent?.trim()).toBe('٣٠٠٪')
    expect(level.scrollWidth).toBeLessThanOrEqual(level.clientWidth)
  })

  it.each([
    ['English UI: the right zone', 'en', '[data-qd-turn-zone="prev"]'],
    ['Arabic UI: the left zone', 'ar', '[data-qd-turn-zone="next"]'],
  ] as const)(
    'never blocks the turn-zone chevron at 1366×768, and a click on + never turns the page (%s)',
    async (_label, uiLanguage, zone) => {
      await boot({ size: [1366, 768], settings: { uiLanguage } })
      await goTo(50)
      await until(() => $(zone) !== null, 2_000, 'the zone beside the capsule')
      await hoverCanvas()
      expect(shownAs()).toBe('quiet')
      const chevron = rect(`${zone} .chev`)
      // The full-height zone hugs the canvas edge here: the capsule covers the top of its column, not its chevron.
      expect(rect(zone).height).toBeGreaterThan(400)
      expect(intersects(rect(ZC), rect(zone))).toBe(true)
      expect(intersects(rect(ZC), chevron)).toBe(false)
      const before = [...reader.visiblePages]
      const next = vi.spyOn(reader, 'next')
      const prev = vi.spyOn(reader, 'prev')
      // + takes its own click, over whatever zone lies under the capsule.
      const plus = rect(IN)
      expect(
        document.elementFromPoint(plus.left + plus.width / 2, plus.top + plus.height / 2)?.closest(ZC),
      ).not.toBeNull()
      await userEvent.click($(IN) as HTMLElement)
      await until(() => reader.zoomPct === 110, 2_000, 'zoomed in')
      await settle(150)
      expect(next).not.toHaveBeenCalled()
      expect(prev).not.toHaveBeenCalled()
      expect(reader.visiblePages).toEqual(before)
      // Back at the fit, the chevron beside the capsule still turns.
      await userEvent.click($(FIT) as HTMLElement)
      await until(() => reader.zoomPct === 100 && !reader.scrolls, 2_000, 'back to the fit')
      await settle(150)
      await until(() => $(zone) !== null, 2_000, 'the zone again')
      await hoverCanvas()
      // Quiet again once the zoom's wake is over.
      await until(() => shownAs() === 'quiet', 2_000, 'quiet')
      await userEvent.click($(`${zone} .chev`) as HTMLElement)
      const turned = zone.includes('prev') ? prev : next
      await until(() => turned.mock.calls.length === 1 && !reader.turning, 2_000, 'the turn')
    },
  )
})

describe('ZoomControl: buttons', () => {
  it('zooms in, out and back to the fit around the canvas centre, keeping focus on the page', async () => {
    await boot()
    await goTo(50)
    const v = view().getBoundingClientRect()
    const cx = v.left + v.width / 2
    const cy = v.top + v.height / 2
    const block = $('section.mp[data-page="50"] .mp-block') as HTMLElement
    const b0 = block.getBoundingClientRect()
    const fx = (cx - b0.left) / b0.width
    const fy = (cy - b0.top) / b0.height

    await userEvent.click($(IN) as HTMLElement)
    await until(() => reader.zoomPct === 110, 2_000, '110 %')
    await settle(60)
    expect($(FIT)?.textContent?.trim()).toBe('110%')
    expect($(FIT)?.getAttribute('aria-label')).toBe('Zoom 110%, fit to window')
    expect(ui.announcement).toBe('Zoom 110%')
    // The book point at the canvas centre stays there (±1 px).
    const b1 = block.getBoundingClientRect()
    expect(b1.width).toBeGreaterThan(b0.width * 1.05)
    expect(Math.abs(b1.left + fx * b1.width - cx)).toBeLessThanOrEqual(1)
    expect(Math.abs(b1.top + fy * b1.height - cy)).toBeLessThanOrEqual(1)
    // A click never takes focus.
    expect(document.activeElement?.closest(ZC)).toBeNull()

    await userEvent.click($(OUT) as HTMLElement)
    await userEvent.click($(OUT) as HTMLElement)
    await until(() => reader.zoomPct === 90, 2_000, '90 %')
    await userEvent.click($(FIT) as HTMLElement)
    await until(() => reader.zoomPct === 100, 2_000, 'the fit')
    expect(document.activeElement?.closest(ZC)).toBeNull()
    // ← still turns the page (book order: the next spread).
    await userEvent.keyboard('{ArrowLeft}')
    await until(() => reader.visiblePages.includes(51) && !reader.turning, 2_000, 'the next spread')
  })

  it('stops at 50 % and 300 %; at the fit the level is a readout', async () => {
    await boot({ settings: { zoomPct: 300 } })
    await goTo(50)
    expect($(IN)?.getAttribute('aria-disabled')).toBe('true')
    expect($(OUT)?.hasAttribute('aria-disabled')).toBe(false)
    // An aria-disabled button stays clickable (and focusable); its click does nothing.
    ;($(IN) as HTMLElement).click()
    await settle(120)
    expect(reader.zoomPct).toBe(300)
    await settings.update({ zoomPct: 50 })
    await settle(120)
    expect($(OUT)?.getAttribute('aria-disabled')).toBe('true')
    expect($(IN)?.hasAttribute('aria-disabled')).toBe(false)
    ;($(OUT) as HTMLElement).click()
    await settle(120)
    expect(reader.zoomPct).toBe(50)
    await settings.update({ zoomPct: 100 })
    await settle(120)
    expect($(FIT)?.getAttribute('aria-disabled')).toBe('true')
    expect(Number(getComputedStyle($(FIT) as HTMLElement).opacity)).toBe(1)
  })

  it('names the toolbar and its buttons, and shows each shortcut in its tooltip', async () => {
    await boot()
    await goTo(50)
    expect($(ZC)?.getAttribute('role')).toBe('toolbar')
    expect($(ZC)?.getAttribute('aria-orientation')).toBe('vertical')
    expect($(ZC)?.getAttribute('aria-label')).toBe('Zoom')
    expect($(IN)?.getAttribute('aria-label')).toBe('Zoom in')
    expect($(FIT)?.getAttribute('aria-label')).toBe('Zoom 100%, fit to window')
    expect($(OUT)?.getAttribute('aria-label')).toBe('Zoom out')
    const chord = shortcuts.format(
      shortcuts.defs.find((d) => d.id === 'view.zoomIn') as (typeof shortcuts.defs)[number],
    )
    expect(chord).not.toBe('')
    // Keyboard focus (never a pointer) opens the tooltip with the keycaps.
    await userEvent.keyboard('{Shift}')
    ;($(IN) as HTMLElement).focus()
    await until(() => $('[data-tooltip-content]') !== null, 2_000, 'the tooltip')
    const tip = $('[data-tooltip-content]') as HTMLElement
    expect(tip.textContent).toContain('Zoom in')
    expect(tip.querySelector('kbd')?.textContent?.replace(/\s/g, '')).toBe(chord.replace(/\s/g, ''))
    expect(shownAs()).toBe('active')
  })

  it('is one tab stop: ↑/↓ move, Enter zooms, Escape returns to the Quran text and keeps the selection', async () => {
    await boot()
    await goTo(50)
    const ayah = Number(($('section.mp[data-page="50"] .mp-a11y li') as HTMLElement).dataset.ayah)
    reader.select(ayah)
    await settle(60)
    const tabStops = () =>
      [...document.querySelectorAll(`${ZC} button`)].filter((b) => b.getAttribute('tabindex') === '0')
    expect(tabStops()).toEqual([$(IN)])
    ;($(IN) as HTMLElement).focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe($(FIT))
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe($(OUT))
    await userEvent.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe($(FIT))
    expect(tabStops()).toEqual([$(FIT)])
    await userEvent.keyboard('{End}')
    expect(document.activeElement).toBe($(OUT))
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe($(IN))
    await userEvent.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe($(OUT))
    await userEvent.keyboard('{Enter}')
    await until(() => reader.zoomPct === 90, 2_000, '90 %')
    expect(document.activeElement).toBe($(OUT))
    await userEvent.keyboard('{Escape}')
    await settle(60)
    expect(document.activeElement).toBe($(A11Y_TAB_STOP))
    expect(reader.selection?.fromAyahId).toBe(ayah)
  })
})

describe('ZoomControl: how it shows', () => {
  it('is quieter off the canvas, 60 % over it, 100 % over itself and for 0.9 s after a zoom', async () => {
    await boot()
    await goTo(50)
    await hoverOff()
    expect(shownAs()).toBe('idle')
    expect(opacity()).toBeCloseTo(0.4, 2)
    await hoverCanvas()
    expect(shownAs()).toBe('quiet')
    expect(opacity()).toBeCloseTo(0.6, 2)
    await userEvent.hover($(IN) as HTMLElement)
    await settle(250)
    expect(opacity()).toBe(1)
    await hoverOff()
    expect(opacity()).toBeCloseTo(0.4, 2)
    // Any zoom (here the keyboard's) wakes it, then it settles back.
    const at = performance.now()
    reader.zoomOut()
    await settle(250)
    expect(shownAs()).toBe('active')
    expect(opacity()).toBe(1)
    await until(() => shownAs() === 'idle', 2_000, 'back to rest')
    expect(performance.now() - at).toBeGreaterThanOrEqual(850)
    await settle(250)
    expect(opacity()).toBeCloseTo(0.4, 2)
  })

  it('yields to the text of a zoomed book and comes back when the pointer reaches for it', async () => {
    await boot({ settings: { zoomPct: 250 } })
    await goTo(50)
    expect(reader.scrolls).toBe(true)
    // Scroll the book so its text lies under the capsule.
    const vp = viewport()
    const zc = rect(ZC)
    const t = textBlock()
    const midX = zc.left + zc.width / 2
    const midY = zc.top + zc.height / 2
    if (t.right < midX + 20) vp.scrollLeft -= midX + 20 - t.right
    if (t.top > midY - 20) vp.scrollTop += t.top - (midY - 20)
    await settle(200)
    const moved = textBlock()
    expect(moved.right).toBeGreaterThan(midX)
    expect(moved.top).toBeLessThan(midY)
    await hoverCanvas()
    await until(() => shownAs() === 'hidden', 2_000, 'yielded')
    expect(getComputedStyle($(ZC) as HTMLElement).pointerEvents).toBe('none')
    expect(document.elementFromPoint(midX, midY)?.closest(ZC)).toBeNull()
    // The pointer reaching for it brings it back.
    const v = view().getBoundingClientRect()
    await hoverCanvas(zc.left - (REACH_PX - 8) - v.left, midY - v.top)
    await until(() => shownAs() === 'active', 2_000, 'back')
    await userEvent.click($(IN) as HTMLElement)
    await until(() => reader.zoomPct === 260, 2_000, '260 %')
  })

  it('a plain wheel over it scrolls a zoomed canvas, and turns the page while it fits', async () => {
    await boot({ settings: { zoomPct: 200 } })
    await goTo(50)
    await hoverCanvas()
    const vp = viewport()
    const top = vp.scrollTop
    $(ZC)?.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }))
    await until(() => vp.scrollTop > top, 2_000, 'scrolled')
    expect(reader.visiblePages).toContain(50)
    await settings.update({ zoomPct: 100 })
    await until(() => !reader.scrolls, 2_000, 'the fit')
    await settle(500)
    $(ZC)?.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }))
    await until(() => reader.visiblePages.includes(52) && !reader.turning, 2_000, 'the next spread')
  })

  it('zen: hidden until the pointer moves and while it rests, below the title bar’s reveal zone', async () => {
    await boot()
    await goTo(50)
    await hoverCanvas(300, 300)
    ui.setZen(true)
    await settle(250)
    expect(shownAs()).toBe('hidden')
    await hoverCanvas(320, 320)
    expect(shownAs()).toBe('quiet')
    const v = view().getBoundingClientRect()
    expect(rect(ZC).top - v.top).toBeGreaterThanOrEqual(ZEN_TOP_ZONE_PX + 16 - 0.5)
    await userEvent.hover($(IN) as HTMLElement)
    await settle(120)
    expect(shownAs()).toBe('active')
    expect(ui.zenTitleBar).toBe(false)
    await hoverCanvas(340, 340)
    ui.pointerIdle = true
    await settle(250)
    expect(shownAs()).toBe('hidden')
  })

  it('does not animate under reduced motion', async () => {
    await boot({ settings: { motion: 'reduce' } })
    await goTo(50)
    expect(Number.parseFloat(getComputedStyle($(ZC) as HTMLElement).transitionDuration)).toBeLessThan(0.001)
  })
})

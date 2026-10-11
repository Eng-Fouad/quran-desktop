/**
 * PageRail in a real browser (§8.11, §10.1, §11.3; WP8f acceptance), mounted in the real `App` on the browser mock:
 * `P` shows and focuses a labelled `role=slider`; its keys keep book semantics (← is the next page, Shift ×10, the juz
 * keys, Home/End), preview at once and turn once; Enter and Escape give focus back, and Escape closes the rail before
 * the reader's own Escape; the rail runs right to left with page 1 at the right end in both UI languages; the bottom
 * edge of the canvas reveals it above the dock; a drag previews in the FlipHUD and its release turns once, and a pointer
 * never takes focus.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page as browserPage, userEvent } from 'vitest/browser'
import '../../app.css'
import { bootApp, resetApp, settle } from '../shell/testing/boot'
import { quran, reader, ui } from '$lib/stores'
import { railState } from './PageRail.svelte'

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const rect = (selector: string) => $(selector)?.getBoundingClientRect() ?? new DOMRect()
const RAIL = '[data-qd-page-rail]'
const HUD = '[data-qd-flip-hud]'

async function until(done: () => boolean, timeout = 5_000, message = 'condition'): Promise<void> {
  const end = performance.now() + timeout
  while (performance.now() < end) {
    flushSync()
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`${message} not met within ${timeout} ms`)
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

afterEach(async () => {
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
    await until(() => reader.visiblePages.includes(265), 2_000, 'the turn')
    await until(() => $(RAIL) === null, 2_000, 'the rail gone')
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
      // Arabic-Indic juz labels, ١ at the right end.
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
  it('reveals the rail from the bottom edge of the canvas beside the dock, above the dock, and lets it go', async () => {
    await boot({ size: [1600, 1000] })
    await goTo(262)
    const view = $('.mushaf-view') as HTMLElement
    const r = view.getBoundingClientRect()
    await userEvent.hover(view, { position: { x: 90, y: r.height - 6 } })
    await until(() => $(RAIL) !== null, 2_000, 'the rail')
    await settle(250)
    const rail = rect(RAIL)
    const dock = rect('[data-qd-dock-pill]')
    expect(rail.height).toBe(28)
    expect(rail.bottom).toBeLessThanOrEqual(dock.top - 4)
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

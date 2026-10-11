/**
 * The "Aa" display button and its popover (§8.13, §9.7; owner request 2026-10-11) in the real `App` on the browser mock:
 * its place under the zoom control (and in translation mode's gutter), clear of the page, the dock, the slot and the
 * turn-zone chevrons; how it shows (the zoom control's rules: quiet, yielding to the text or the paper, zen); the
 * arrowless popover beside it with Settings' controls (the theme cards three across, ink on Night and Black, the Mushaf
 * style with its availability rules, the pages, the translation text size where translation text shows), applied live
 * with no scrim; the floating layer; keys and focus; "All settings" and `Mod+,` opening the Settings dialog on the
 * reading mode's section; the Arabic mirror.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page as browserPage, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import App from '../../App.svelte'
import { settingsView } from '../settings/view.svelte'
import { bootApp, resetApp, settle } from '../shell/testing/boot'
import { boot as bootTranslation, verse } from '../translation/testing/setup'
import type { Settings } from '$lib/ipc/bindings'
import { app, fonts, reader, settings, shortcuts, ui } from '$lib/stores'
import { A11Y_TAB_STOP } from '$lib/stores/reader.svelte'
import { ZEN_TOP_ZONE_PX } from '$lib/stores/ui.svelte'
import { REACH_PX } from './canvasControl.svelte'

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const $$ = <T extends Element = HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)]
const rect = (selector: string) => $(selector)?.getBoundingClientRect() ?? new DOMRect()
const ZC = '[data-qd-zoom-control]'
const DC = '[data-qd-display-control]'
const BUTTON = `${DC} button[data-action="display"]`
const POPOVER = '[data-qd-popover="display"]'
const DIALOG = `[role="dialog"]:has(${POPOVER})`
const button = () => $(BUTTON) as HTMLElement
const shownAs = () => $(DC)?.dataset.state
const SIDEBAR_CLOSED: Settings['sidebar'] = { open: false, widthPx: 300, tab: 'index' }
const rowsShown = () => $$(`${POPOVER} [data-row]`).map((r) => r.dataset.row)
/** The page-layout options and their visible labels (the segmented control keeps a hidden copy of each). */
const pageOptions = () => $$(`${POPOVER} [data-row="pageMode"] button`)
const optionLabel = (o: Element) => o.querySelector('.text > span')?.textContent?.trim()
/** `Mod` (§7.7): ⌘ when the browser runs on macOS (the mock reports the browser's platform), Ctrl elsewhere. */
const mod = () => (app.isMac ? 'Meta' : 'Control')

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
  await until(() => $('section.mp .mp-block') !== null && $(DC) !== null, 5_000, 'the pages and the button')
}

/** Translation mode in the real shell, with two translations installed (WP11a's set-up). */
async function bootTranslationMode(
  size: [number, number],
  extra: Parameters<typeof bootTranslation>[0] = {},
) {
  await bootTranslation({ ...extra, settings: { onboardingDone: true, ...extra.settings } })
  await browserPage.viewport(...size)
  render(App)
  app.markReady()
  await until(
    () => verse(1)?.querySelector('.arabic') != null && $(DC) !== null,
    5_000,
    'the feed and the button',
  )
  await settle(300)
}

async function goTo(page: number): Promise<void> {
  reader.goToPage(page, { push: false, transition: false })
  await until(() => reader.visiblePages.includes(page) && !reader.turning, 5_000, `turn to ${page}`)
  await settle(80)
}

/** Moves the pointer over the canvas view at a point relative to its top left (default: its centre). */
async function hoverCanvas(x?: number, y?: number): Promise<void> {
  const v = $('main#qd-main > [data-qd-view]') as HTMLElement
  await userEvent.hover(v, { position: { x: x ?? v.clientWidth / 2, y: y ?? v.clientHeight / 2 } })
  await settle(250)
}

async function hoverOff(): Promise<void> {
  await userEvent.hover($('nav') as HTMLElement)
  await settle(250)
}

async function openByPointer(): Promise<HTMLElement> {
  await userEvent.click(button())
  await until(() => $(POPOVER) !== null, 2_000, 'the popover')
  await settle(250)
  return $(DIALOG) as HTMLElement
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

const rects = (selector: string) => $$(selector).map((el) => el.getBoundingClientRect())

afterEach(async () => {
  ui.setZen(false)
  resetApp()
  vi.restoreAllMocks()
  await browserPage.viewport(1280, 800)
})

describe('DisplayControl: place and look (§8.13)', () => {
  it.each([
    ['a spread above the bar (1600×1000)', [1600, 1000], {}],
    ['a spread above the compact bar (1366×768)', [1366, 768], {}],
    ['the side card, sidebar closed (1920×1080)', [1920, 1080], { sidebar: SIDEBAR_CLOSED }],
  ] as const)(
    'sits 8 px under the zoom control, clear of the page, the dock, the slot and the chevrons: %s',
    async (_label, size, extra) => {
      await boot({ size: [...size], settings: { ...extra } })
      await goTo(50)
      if ('sidebar' in extra) expect(reader.dock).toBe('side')
      const zc = rect(ZC)
      const dc = rect(DC)
      expect(Math.abs(dc.width - 40)).toBeLessThan(0.5)
      expect(Math.abs(dc.height - 40)).toBeLessThan(0.5)
      expect(Math.abs(dc.right - zc.right)).toBeLessThan(0.5)
      expect(Math.abs(dc.top - zc.bottom - 8)).toBeLessThan(1)
      const clear = [
        ...rects('section.mp .mp-block'),
        ...rects('section.mp .mp-head'),
        ...rects('[data-qd-region="dock"] > *'),
        ...rects('.mv-slot > *'),
        ...rects('[data-qd-turn-zone] .chev'),
      ]
      for (const r of clear) expect(intersects(dc, r)).toBe(false)
      // The zoom control's look: quieter off the canvas, quiet over it, full strength over itself.
      await hoverOff()
      expect(shownAs()).toBe('idle')
      expect(Number(getComputedStyle($(DC) as HTMLElement).opacity)).toBeCloseTo(0.4, 2)
      await hoverCanvas()
      expect(shownAs()).toBe('quiet')
      await userEvent.hover(button())
      await settle(250)
      expect(shownAs()).toBe('active')
    },
  )

  it('yields to the text of a zoomed book and comes back when the pointer reaches for it', async () => {
    await boot({ settings: { zoomPct: 250 } })
    await goTo(50)
    const vp = $('.mushaf-view [data-scroll-area-viewport]') as HTMLElement
    const dc = rect(DC)
    const midX = dc.left + dc.width / 2
    const midY = dc.top + dc.height / 2
    const blocks = rects('section.mp .mp-block')
    const right = Math.max(...blocks.map((r) => r.right))
    const top = Math.min(...blocks.map((r) => r.top))
    if (right < midX + 20) vp.scrollLeft -= midX + 20 - right
    if (top > midY - 20) vp.scrollTop += top - (midY - 20)
    await settle(200)
    await hoverCanvas()
    await until(() => shownAs() === 'hidden', 2_000, 'yielded')
    expect(getComputedStyle($(DC) as HTMLElement).pointerEvents).toBe('none')
    const v = rect('.mushaf-view')
    await hoverCanvas(dc.left - (REACH_PX - 8) - v.left, midY - v.top)
    await until(() => shownAs() === 'active', 2_000, 'back')
    await openByPointer()
    expect(shownAs()).toBe('active')
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
    expect(rect(DC).top - rect('.mushaf-view').top).toBeGreaterThanOrEqual(ZEN_TOP_ZONE_PX + 116 - 0.5)
    ui.pointerIdle = true
    await settle(250)
    expect(shownAs()).toBe('hidden')
  })
})

describe('DisplayControl: the popover (§9.7)', () => {
  it('opens arrowless beside the button with Settings’ controls, as a floating layer; a pointer never takes focus', async () => {
    await boot()
    await goTo(50)
    // Tajweed cannot be drawn here: the card says so and cannot be chosen, as in Settings.
    fonts.v4Supported = false
    const b = button()
    expect(b.getAttribute('aria-label')).toBe('Display')
    expect(b.getAttribute('aria-haspopup')).toBe('dialog')
    expect(b.getAttribute('aria-expanded')).toBe('false')
    ;(document.activeElement as HTMLElement | null)?.blur()

    const dialog = await openByPointer()
    expect(b.getAttribute('aria-expanded')).toBe('true')
    expect(ui.layerOpen).toBe(true)
    expect(dialog.getAttribute('aria-label')).toBe('Display')
    expect(dialog.querySelector('.arrow')).toBeNull()
    expect($('.backdrop')).toBeNull()
    // 340 px wide, 8 px beside the capsule toward the canvas, top edges aligned.
    const p = dialog.getBoundingClientRect()
    const dc = rect(DC)
    expect(Math.abs(p.width - 340)).toBeLessThan(1)
    expect(Math.abs(dc.left - p.right - 8)).toBeLessThan(1)
    expect(Math.abs(p.top - dc.top)).toBeLessThan(1)
    // It opens on its heading; the button stays at full strength while it is open.
    expect(document.activeElement?.textContent?.trim()).toBe('Display')
    expect(shownAs()).toBe('active')

    // Paper, beside the Mushaf: the theme, the style and the pages (no ink, no text size).
    expect(rowsShown()).toEqual(['theme', 'mushafStyle', 'pageMode'])
    const cards = $$(`${POPOVER} [data-row="theme"] [role="radio"]`)
    expect(cards.map((c) => c.dataset.value)).toEqual([
      'system',
      'paper',
      'sepia',
      'night',
      'black',
      'high_contrast',
    ])
    expect(new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top))).size).toBe(2)
    expect($(`${POPOVER} [data-row="theme"] .hint`)).toBeNull()
    const styles = $$(`${POPOVER} [data-row="mushafStyle"] [role="radio"]`)
    expect(styles.map((s) => s.dataset.value)).toEqual(['hafs', 'qcf_v2', 'qcf_v1', 'qcf_v4'])
    const tajweed = styles[3] as HTMLElement
    expect(tajweed.getAttribute('aria-disabled')).toBe('true')
    expect(tajweed.querySelector('.status-text')?.textContent).toBe('Not supported on this system')
    expect(styles[0]?.querySelector('.status-text')?.textContent).toBe('Included')
    // (A DOM click: the pointer driver refuses an aria-disabled target.)
    tajweed.click()
    await settle(120)
    expect(settings.value.mushafStyle).toBe('hafs')
    expect(pageOptions().map(optionLabel)).toEqual(['Automatic', 'One page', 'Two pages'])
    // "All settings" with the Settings key.
    const all = $(`${POPOVER} [data-action="all-settings"]`) as HTMLElement
    expect(all.textContent).toContain('All settings')
    const def = shortcuts.defs.find((d) => d.id === 'app.settings')
    expect(def).toBeDefined()
    expect(all.querySelector('kbd')?.textContent?.replace(/\s/g, '')).toBe(
      shortcuts.format(def as NonNullable<typeof def>).replace(/\s/g, ''),
    )

    await userEvent.keyboard('{Escape}')
    await until(() => $(POPOVER) === null, 2_000, 'closed')
    expect(ui.layerOpen).toBe(false)
    expect(b.getAttribute('aria-expanded')).toBe('false')
    // Opened by the pointer, focus never stays on the button: ← still turns the page.
    expect(document.activeElement).not.toBe(b)
    await userEvent.keyboard('{ArrowLeft}')
    await until(() => reader.visiblePages.includes(51) && !reader.turning, 2_000, 'the next spread')
  })

  it('applies every change live on the page under it: theme, ink on Night, style and pages', async () => {
    await boot()
    await goTo(50)
    await openByPointer()
    await userEvent.click($(`${POPOVER} [role="radio"][data-value="night"]`) as HTMLElement)
    await until(() => settings.value.theme === 'night', 2_000, 'night')
    expect(document.documentElement.dataset.theme).toBe('night')
    // Night dims its ink: the row joins, right after the theme.
    await until(() => rowsShown()[1] === 'inkBrightnessPct', 2_000, 'the ink row')
    const thumb = $(`${POPOVER} [data-row="inkBrightnessPct"] [role="slider"]`) as HTMLElement
    thumb.focus()
    await userEvent.keyboard('{Home}')
    await until(() => settings.value.inkBrightnessPct === 65, 2_000, 'ink 65 %')
    expect($(`${POPOVER} [data-row="inkBrightnessPct"] .value`)?.textContent).toBe('65%')

    const one = pageOptions().find((o) => optionLabel(o) === 'One page')
    await userEvent.click(one as HTMLElement)
    await until(
      () => settings.value.pageMode === 'single' && reader.visiblePages.length === 1,
      2_000,
      'one page',
    )
    await userEvent.click($(`${POPOVER} [role="radio"][data-value="qcf_v2"]`) as HTMLElement)
    await until(() => settings.value.mushafStyle === 'qcf_v2', 2_000, 'the 1421 AH print')
    // Still open, over no scrim.
    await settle(200)
    expect($(POPOVER)).not.toBeNull()
    expect($('.backdrop')).toBeNull()
  })

  it('beside the Mushaf, adds the translation text size while the study pane shows its Translation tab', async () => {
    await boot()
    await goTo(50)
    ui.openSidePane('translation')
    await until(() => ui.sidePaneOpen, 2_000, 'the study pane')
    await settle(200)
    await openByPointer()
    expect(rowsShown()).toEqual(['theme', 'mushafStyle', 'pageMode', 'translationFontPct'])
    expect($(`${POPOVER} [data-row="translationFontPct"] .label`)?.textContent).toBe('Translation text size')
    await userEvent.keyboard('{Escape}')
    await until(() => $(POPOVER) === null, 2_000, 'closed')
    ui.openSidePane('tafsir')
    await settle(200)
    await openByPointer()
    expect(rowsShown()).toEqual(['theme', 'mushafStyle', 'pageMode'])
  })

  it('keys: one tab stop after the zoom control; Enter opens on the heading; Escape returns to the button, then to the Quran text', async () => {
    await boot()
    await goTo(50)
    const ayah = Number(($('section.mp[data-page="50"] .mp-a11y li') as HTMLElement).dataset.ayah)
    reader.select(ayah)
    await settle(60)
    ;($(`${ZC} [data-zoom="in"]`) as HTMLElement).focus()
    await userEvent.keyboard('{Tab}')
    expect(document.activeElement).toBe(button())
    expect(shownAs()).toBe('active')
    await userEvent.keyboard('{Enter}')
    await until(() => document.activeElement?.textContent?.trim() === 'Display', 2_000, 'the heading')
    await userEvent.keyboard('{Tab}')
    expect(document.activeElement?.getAttribute('role')).toBe('radio')
    expect(document.activeElement?.getAttribute('aria-checked')).toBe('true')
    await userEvent.keyboard('{Escape}')
    await until(() => $(POPOVER) === null, 2_000, 'closed')
    await until(() => document.activeElement === button(), 2_000, 'focus on the button')
    await userEvent.keyboard('{Escape}')
    await settle(60)
    expect(document.activeElement).toBe($(A11Y_TAB_STOP))
    expect(reader.selection?.fromAyahId).toBe(ayah)
  })

  it('"All settings" and Mod+, open the Settings dialog on the Mushaf section; closing it returns to the button', async () => {
    await boot()
    await goTo(50)
    settingsView.open('audio')
    button().focus()
    await userEvent.keyboard('{Enter}')
    await until(() => $(POPOVER) !== null, 2_000, 'the popover')
    await settle(200)
    // The floating layer holds Mod+, back; the popover runs it itself.
    await userEvent.keyboard(`{${mod()}>},{/${mod()}}`)
    await until(() => ui.view === 'settings' && ui.settingsOpen, 2_000, 'the Settings dialog')
    expect(settingsView.section).toBe('mushaf')
    await until(() => $(POPOVER) === null, 2_000, 'the popover closed')
    await expect.poll(() => document.activeElement?.hasAttribute('data-settings-search')).toBe(true)
    await userEvent.keyboard('{Escape}')
    await until(() => ui.view === 'reader', 2_000, 'back to the reader')
    await expect.poll(() => document.activeElement).toBe(button())

    // By pointer, the footer button.
    await openByPointer()
    await userEvent.click($(`${POPOVER} [data-action="all-settings"]`) as HTMLElement)
    await until(() => ui.view === 'settings', 2_000, 'Settings')
    expect(settingsView.section).toBe('mushaf')
    ui.setView('reader')
    await settle(300)

    // It never stays open over another view (here Settings opened by a deep link).
    await openByPointer()
    ui.setView('settings')
    await until(() => $(POPOVER) === null, 2_000, 'closed for Settings')
  })

  it('Arabic UI: the top-left corner, the popover to its right, names in Arabic', async () => {
    await boot({ settings: { uiLanguage: 'ar' } })
    await goTo(50)
    const v = rect('.mushaf-view')
    const dc = rect(DC)
    expect(Math.abs(dc.left - v.left - 12)).toBeLessThan(1)
    expect(Math.abs(dc.left - rect(ZC).left)).toBeLessThan(0.5)
    expect(button().getAttribute('aria-label')).toBe('العرض')
    const dialog = await openByPointer()
    const p = dialog.getBoundingClientRect()
    expect(Math.abs(p.left - dc.right - 8)).toBeLessThan(1)
    expect(dialog.getAttribute('aria-label')).toBe('العرض')
    expect(getComputedStyle(dialog).direction).toBe('rtl')
    // The theme cards mirror: "Match system" first, at the inline start (right).
    const cards = $$(`${POPOVER} [data-row="theme"] [role="radio"]`)
    const first = (cards[0] as HTMLElement).getBoundingClientRect()
    const second = (cards[1] as HTMLElement).getBoundingClientRect()
    expect(first.left).toBeGreaterThan(second.left)
    expect($(`${POPOVER} [data-action="all-settings"]`)?.textContent).toContain('جميع الإعدادات')
  })
})

describe('DisplayControl: the smallest window (760 × 600 at 200 %, 380 × 300 CSS px)', () => {
  it.each(['en', 'ar'] as const)(
    'keeps the popover inside the window: the rows scroll between the fixed heading and footer (%s)',
    async (uiLanguage) => {
      await boot({
        size: [380, 300],
        settings: { uiLanguage, sidebar: { open: false, widthPx: 300, tab: 'index' } },
      })
      // The book fills this canvas, so the button yields to it until the pointer reaches for it.
      const dc = rect(DC)
      const v = rect('.mushaf-view')
      const reach = uiLanguage === 'ar' ? dc.right + 8 : dc.left - 8
      await hoverCanvas(reach - v.left, dc.top + dc.height / 2 - v.top)
      await until(() => shownAs() === 'active', 2_000, 'reached for')
      const dialog = await openByPointer()
      const p = dialog.getBoundingClientRect()
      expect(p.left).toBeGreaterThanOrEqual(0)
      expect(p.top).toBeGreaterThanOrEqual(0)
      expect(p.right).toBeLessThanOrEqual(380)
      expect(p.bottom).toBeLessThanOrEqual(300)
      const viewport = $(`${POPOVER} [data-scroll-area-viewport]`) as HTMLElement
      expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight)
      const footer = rect(`${POPOVER} [data-action="all-settings"]`)
      expect(footer.height).toBeGreaterThan(0)
      expect(footer.bottom).toBeLessThanOrEqual(p.bottom)
      // Two or three theme cards a row, never one alone.
      const cards = $$(`${POPOVER} [data-row="theme"] [role="radio"]`)
      expect(new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top))).size).toBeLessThanOrEqual(3)
    },
  )
})

describe('DisplayControl: translation mode (§9.7)', () => {
  it('sits in the gutter at the top inline-end corner; the theme and the text size only; All settings opens Translations', async () => {
    await bootTranslationMode([1280, 900], {
      settings: { sidebar: { open: true, widthPx: 300, tab: 'index' } },
    })
    const tv = rect('[data-qd-view="translation"]')
    const dc = rect(DC)
    expect(Math.abs(dc.top - tv.top - 16)).toBeLessThan(1)
    expect(Math.abs(tv.right - dc.right - 12)).toBeLessThan(1)
    expect(intersects(dc, rect('[data-qd-view="translation"] > .sheet'))).toBe(false)
    expect($(ZC)).toBeNull()
    await hoverCanvas()
    expect(shownAs()).toBe('quiet')

    await openByPointer()
    expect(rowsShown()).toEqual(['theme', 'translationFontPct'])
    const thumb = $(`${POPOVER} [data-row="translationFontPct"] [role="slider"]`) as HTMLElement
    thumb.focus()
    await userEvent.keyboard('{ArrowRight}')
    await until(() => settings.value.translationFontPct === 110, 2_000, 'text size 110 %')
    await until(
      () =>
        getComputedStyle($('[data-qd-view="translation"]') as HTMLElement).getPropertyValue('--tv-scale') ===
        '1.1',
      2_000,
      'the feed rescaled',
    )
    await userEvent.click($(`${POPOVER} [data-action="all-settings"]`) as HTMLElement)
    await until(() => ui.view === 'settings', 2_000, 'Settings')
    expect(settingsView.section).toBe('translations')
  })

  it('a canvas too narrow for the gutter: it yields to the paper until the pointer reaches for it', async () => {
    await bootTranslationMode([880, 800], {
      settings: { sidebar: { open: false, widthPx: 300, tab: 'index' } },
    })
    const dc = rect(DC)
    expect(intersects(dc, rect('[data-qd-view="translation"] > .sheet'))).toBe(true)
    await hoverCanvas()
    await until(() => shownAs() === 'hidden', 2_000, 'yielded to the paper')
    const tv = rect('[data-qd-view="translation"]')
    await hoverCanvas(dc.left - (REACH_PX - 8) - tv.left, dc.top + dc.height / 2 - tv.top)
    await until(() => shownAs() === 'active', 2_000, 'back')
    await openByPointer()
    expect(rowsShown()).toEqual(['theme', 'translationFontPct'])
  })
})

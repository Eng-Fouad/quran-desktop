/**
 * The Settings dialog (owner request 2026-10-11) in a real browser with the real shell: it opens over the
 * reader, which stays mounted, sized and centred between the title bar and the player dock on the faint scrim (or
 * filling a small window);
 * the rail button's dialog semantics; focus in and out (back to the opener, or on to Downloads); Escape, the X, a click
 * outside and Ctrl+, close it; the title bar, the player dock and its popovers, and toasts stay usable; every overlay
 * paints above it, a confirmation opened from it keeps it mounted and one already up makes it wait; its shortcut
 * allow-list, Ctrl+F from About and over the palette, the palette's "Settings" row only where it runs; popovers left
 * open close as it opens; the one-row section strip; zen, below the title bar; About in the same frame; the Arabic
 * mirror.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, server, userEvent } from 'vitest/browser'
import '../../app.css'
import { app, settings, ui } from '$lib/stores'
import { bootApp, resetApp, settle } from './testing/boot'

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const near = (actual: number, expected: number, tolerance = 2) => Math.abs(actual - expected) <= tolerance
/** `Mod`: ⌘ when the browser runs on macOS (the mock reports the browser's platform), Ctrl elsewhere. */
const mod = () => (app.isMac ? 'Meta' : 'Control')
const settingsDialog = () => $('[role="dialog"]:has([data-qd-settings-dialog])')
const confirmDialog = () => $('[role="dialog"]:has([data-confirm])')
const railButton = () => $('.rail button[data-view="settings"]') as HTMLElement
const isSearchField = (el: Element | null) => el?.hasAttribute('data-settings-search') === true
/** The accessible name from `aria-labelledby` (one or more ids). */
const nameOf = (el: Element | null) =>
  (el?.getAttribute('aria-labelledby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
    .join(' ')
/** Whether a point on `el`'s centre reaches `el` (nothing paints over it). */
function onTop(el: Element | null): boolean {
  if (el === null) return false
  const r = el.getBoundingClientRect()
  return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
}

/** Dispatches a keydown on `target` as a browser delivers it. */
function key(init: KeyboardEventInit, target: EventTarget): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, composed: true, ...init })
  target.dispatchEvent(e)
  return e
}

async function openFromRail(): Promise<HTMLElement> {
  const button = railButton()
  await userEvent.click(button)
  await settle(300)
  return button
}

/**
 * Waits until the dialog has closed and left the page: bits-ui unmounts it once its exit transition has run, which
 * takes as many frames as the runner gives it (WebKit under load can take longer than a fixed wait).
 */
async function closed(): Promise<void> {
  await expect.poll(settingsDialog, { timeout: 3_000 }).toBeNull()
}

async function section(id: string): Promise<void> {
  await userEvent.click($(`[role="dialog"] nav button[data-section="${id}"]`) as HTMLElement)
  await settle()
}

afterEach(async () => {
  resetApp()
  vi.restoreAllMocks()
  await page.viewport(1280, 800)
})

/**
 * WebKit on the Linux runner paints in software (no GPU), and every opening and closing of the dialog over the reader
 * waits on its frames: the tests that open it several times took 9–13 s there in CI and up to 16 s in a CI-like
 * container, against vitest's 15 s. They get 30 s there.
 */
const softwarePaint = server.browser === 'webkit' && server.platform === 'linux'

describe('Settings dialog', softwarePaint ? { timeout: 30_000 } : {}, () => {
  it('opens over the reader, which stays mounted, centred between the title bar and the dock on a faint scrim', async () => {
    await bootApp()
    const reader = $('[data-qd-view="mushaf"]')
    expect(reader).not.toBeNull()
    const rail = railButton()
    expect(rail.getAttribute('aria-haspopup')).toBe('dialog')
    expect(rail.getAttribute('aria-expanded')).toBe('false')
    expect(rail.hasAttribute('aria-pressed')).toBe(false)
    expect(rail.hasAttribute('data-active')).toBe(false)

    await openFromRail()
    expect(ui.view).toBe('settings')
    const dialog = settingsDialog() as HTMLElement
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(nameOf(dialog)).toBe('Settings')
    // The section title is said once: the column's h2, never a second header row.
    expect(dialog.querySelectorAll('h1')).toHaveLength(1)
    // The reader under it is the very same element.
    expect($('[data-qd-view="mushaf"]')).toBe(reader)

    // 1040 × 760 at 1600 × 1000, centred between the 40 px title bar and the dock's 58 px band, just under the dialog
    // layer; the dock never lies over it.
    const box = dialog.getBoundingClientRect()
    expect(near(box.width, 1040)).toBe(true)
    expect(near(box.height, 760)).toBe(true)
    expect(near(box.left + box.width / 2, 800)).toBe(true)
    expect(near(box.top + box.height / 2, 40 + (960 - 58) / 2)).toBe(true)
    const dockTop = ($('[data-qd-region="dock"] > *') as HTMLElement).getBoundingClientRect().top
    expect(box.bottom).toBeLessThanOrEqual(dockTop - 8 + 0.5)
    expect(getComputedStyle(dialog.parentElement as HTMLElement).zIndex).toBe('59')

    // The scrim is the onboarding's faint one and starts below the title bar; the caption buttons stay live.
    const scrim = $('.backdrop.layer-view') as HTMLElement
    expect(scrim.getBoundingClientRect().top).toBe(40)
    expect(getComputedStyle(scrim).backgroundColor).toBe('rgba(0, 0, 0, 0.18)')
    expect(document.elementFromPoint(200, 500)).toBe(scrim)
    expect(document.elementFromPoint(26, 980)).toBe(scrim)
    expect(ui.settingsOpen).toBe(true)
    expect(ui.layerOpen).toBe(false)
    expect(ui.captionVisible).toBe(true)

    expect(rail.getAttribute('aria-expanded')).toBe('true')
    expect(rail.hasAttribute('data-active')).toBe(true)
    // Focus starts on "Search settings"; the X sits in the top inline-end corner.
    expect(isSearchField(document.activeElement)).toBe(true)
    const x = ($('[data-action="close-dialog"]') as HTMLElement).getBoundingClientRect()
    expect(x.right).toBeGreaterThan(box.right - 24)
    expect(x.top).toBeLessThan(box.top + 24)
  })

  it('closes with Ctrl+, from its search field, the X, Escape and a click outside, focus back on the opener', async () => {
    await bootApp()
    const rail = await openFromRail()
    expect(isSearchField(document.activeElement)).toBe(true)
    await userEvent.keyboard(`{${mod()}>},{/${mod()}}`)
    await closed()
    expect(ui.view).toBe('reader')
    expect(document.activeElement).toBe(rail)

    await openFromRail()
    await userEvent.click($('[data-action="close-dialog"]') as HTMLElement)
    await closed()
    expect(document.activeElement).toBe(rail)

    await openFromRail()
    await userEvent.keyboard('{Escape}')
    await closed()
    expect(ui.view).toBe('reader')
    expect(document.activeElement).toBe(rail)

    await openFromRail()
    // Beside the dialog, over the reader: the scrim.
    await userEvent.click(document.body, { position: { x: 200, y: 500 } })
    await closed()
    expect(ui.view).toBe('reader')

    // Ctrl+, opens it too, and the rail button closes it again.
    ;(document.activeElement as HTMLElement | null)?.blur()
    await userEvent.keyboard(`{${mod()}>},{/${mod()}}`)
    await settle(300)
    expect(settingsDialog()).not.toBeNull()
    railButton().click()
    await settle(300)
    expect(ui.view).toBe('reader')
  })

  it('keeps the title bar, the player dock and its popovers, and toasts usable', async () => {
    await bootApp()
    await openFromRail()

    // The title bar: its palette button opens the palette above the dialog, which stays.
    await userEvent.click($('button.command') as HTMLElement)
    await settle(300)
    expect(ui.topOverlay?.kind).toBe('palette')
    expect(ui.view).toBe('settings')
    expect(onTop($('[role="dialog"]:has([data-command-input])'))).toBe(true)
    await userEvent.keyboard('{Escape}')
    await settle(300)
    expect(ui.overlays).toEqual([])
    expect(settingsDialog()?.contains(document.activeElement)).toBe(true)

    // The dock is lifted above the scrim; a click on it keeps the dialog, and its popover (the reciter picker of the
    // idle dock) stacks above the dialog, where clicks reach it.
    const reciter = $('[data-qd-region="dock"] button.mono-button') as HTMLElement
    expect(onTop(reciter)).toBe(true)
    await userEvent.click(reciter)
    await settle(300)
    expect(ui.view).toBe('settings')
    const picker = () => $('input[role="combobox"]')?.closest('[data-popover-content]') ?? null
    expect(picker()).not.toBeNull()
    expect(onTop(picker()?.querySelector('[role="listbox"]') ?? null)).toBe(true)
    await userEvent.click(picker()?.querySelector('input') as HTMLElement)
    await userEvent.keyboard('{Escape}')
    await settle(300)
    expect(picker()).toBeNull()
    expect(settingsDialog()).not.toBeNull()

    // A toast's action works and keeps the dialog.
    const run = vi.fn()
    ui.toast({ message: 'Backup created', action: { label: 'Show', run } })
    await settle(500)
    const action = [...document.querySelectorAll<HTMLElement>('[data-sonner-toast] button')].find(
      (b) => b.textContent?.trim() === 'Show',
    ) as HTMLElement
    expect(onTop(action)).toBe(true)
    await userEvent.click(action)
    await settle(300)
    expect(run).toHaveBeenCalledOnce()
    expect(ui.view).toBe('settings')
    expect(settingsDialog()).not.toBeNull()
  })

  it('stays mounted under a confirmation opened from it, and waits for one that is already up', async () => {
    await bootApp()
    await openFromRail()
    await section('storage')
    const view = $('[data-qd-view="settings"]')
    const clear = $('[data-action="clear-cache"]') as HTMLElement
    await userEvent.click(clear)
    await settle(300)
    expect(ui.topOverlay?.kind).toBe('confirm')
    // The confirmation paints above the dialog (--z-dialog over --z-dialog − 1) and holds focus.
    const confirm = confirmDialog()
    expect(onTop(confirm)).toBe(true)
    expect(confirm?.contains(document.activeElement)).toBe(true)
    await userEvent.keyboard('{Escape}')
    await settle(300)
    expect(ui.overlays).toEqual([])
    expect(ui.view).toBe('settings')
    expect($('[data-qd-view="settings"]')).toBe(view)
    expect(document.activeElement).toBe(clear)

    // Settings asked for while a confirmation is up (a tray link): the confirmation keeps the top and the keys.
    ui.setView('reader')
    await settle(300)
    const answer = ui.confirm({
      title: 'Delete note?',
      body: 'This cannot be undone.',
      confirmLabel: 'Delete',
    })
    await settle(300)
    ui.setView('settings')
    await settle(300)
    expect(settingsDialog()).toBeNull()
    expect(onTop(confirmDialog())).toBe(true)
    expect(confirmDialog()?.contains(document.activeElement)).toBe(true)
    await userEvent.keyboard('{Escape}')
    await expect(answer).resolves.toBe(false)
    await settle(300)
    expect(settingsDialog()).not.toBeNull()
    expect(ui.view).toBe('settings')
    await expect.poll(() => isSearchField(document.activeElement)).toBe(true)
  })

  it('hands focus to Downloads when it closes for it (Settings › Storage), never back to the opener', async () => {
    await bootApp()
    const rail = await openFromRail()
    await section('storage')
    await userEvent.click($('[data-action="open-downloads"]') as HTMLElement)
    await closed()
    expect(ui.view).toBe('downloads')
    expect(document.activeElement).not.toBe(rail)
    expect($('main#qd-main')?.contains(document.activeElement)).toBe(true)
    // The manager's heading has it (owner request 2026-10-11, the manager's focus).
    await expect.poll(() => document.activeElement?.getAttribute('data-qd-focus')).toBe('downloads')
  })

  it('runs only its allow-list of shortcuts, and Ctrl+F searches the settings', async () => {
    await bootApp()
    await openFromRail()
    const sidebar = { open: ui.sidebarOpen, tab: settings.value.sidebar.tab }
    // From "Search settings": the sidebar keys do nothing; the theme key works (it types nothing).
    await userEvent.keyboard(`{${mod()}>}b{/${mod()}}`)
    await userEvent.keyboard(`{${mod()}>}2{/${mod()}}`)
    await userEvent.keyboard(`{${mod()}>}{Shift>}L{/Shift}{/${mod()}}`)
    await settle()
    expect({ open: ui.sidebarOpen, tab: settings.value.sidebar.tab }).toEqual(sidebar)
    await expect.poll(() => settings.value.theme).toBe('sepia')

    // From a section button: a key off the list is consumed (never the webview's own) and does nothing.
    const audio = $('[role="dialog"] nav button[data-section="audio"]') as HTMLElement
    audio.focus()
    const goTo = key({ key: 'g', code: 'KeyG', ctrlKey: !app.isMac, metaKey: app.isMac }, audio)
    expect(goTo.defaultPrevented).toBe(true)
    expect(ui.overlays).toEqual([])
    const toasts = key({ key: 'F6', code: 'F6' }, audio)
    expect(toasts.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(audio)

    // Ctrl+F brings focus back to "Search settings", not to the sidebar's Search tab.
    await userEvent.keyboard(`{${mod()}>}f{/${mod()}}`)
    await settle()
    expect(isSearchField(document.activeElement)).toBe(true)
    expect(settings.value.sidebar.tab).toBe(sidebar.tab)

    // Ctrl+, never acts over another layer: with the palette open over the dialog, both stay.
    await userEvent.keyboard(`{${mod()}>}k{/${mod()}}`)
    await settle(300)
    expect(ui.topOverlay?.kind).toBe('palette')
    await userEvent.keyboard(`{${mod()}>},{/${mod()}}`)
    await settle()
    expect(ui.topOverlay?.kind).toBe('palette')
    expect(ui.view).toBe('settings')
  })

  it('Ctrl+F turns About back to Settings and searches, and closes a palette over the dialog first', async () => {
    await bootApp()
    await openFromRail()
    await section('about')
    await userEvent.click($('[data-action="open-about"]') as HTMLElement)
    await settle(300)
    expect(ui.view).toBe('about')
    await userEvent.keyboard(`{${mod()}>}f{/${mod()}}`)
    await settle(300)
    expect(ui.view).toBe('settings')
    expect(settingsDialog()).not.toBeNull()
    await expect.poll(() => isSearchField(document.activeElement)).toBe(true)

    // The palette opened from a section button: Ctrl+F closes it, and the field takes focus rather than the button.
    await section('audio')
    await userEvent.keyboard(`{${mod()}>}k{/${mod()}}`)
    await settle(300)
    expect(ui.topOverlay?.kind).toBe('palette')
    await userEvent.keyboard(`{${mod()}>}f{/${mod()}}`)
    await settle(400)
    expect(ui.overlays).toEqual([])
    expect(settingsDialog()).not.toBeNull()
    expect(isSearchField(document.activeElement)).toBe(true)
    expect(settings.value.sidebar.tab).toBe('index')
  })

  it('is offered by the palette only where it opens: alone, not over a popover left open under it', async () => {
    await bootApp()
    const row = () => $('[role="dialog"] [data-value="cmd:app.settings"]')
    // The palette alone: its own dialog is one floating and one modal layer; "Settings" opens once it has closed.
    await userEvent.keyboard(`{${mod()}>}k{/${mod()}}`)
    await settle(300)
    expect([ui.floating, ui.modals]).toEqual([1, 1])
    await userEvent.keyboard('settings')
    await settle(200)
    await userEvent.click(row() as HTMLElement)
    await settle(400)
    expect(ui.view).toBe('settings')
    expect(settingsDialog()).not.toBeNull()
    await userEvent.keyboard('{Escape}')
    await settle(300)
    expect(ui.view).toBe('reader')

    // Over the rail's Downloads flyout, which stays up under the palette: the row would do nothing, so it is not there.
    await userEvent.click($('.rail button[data-view="downloads"]') as HTMLElement)
    await settle(300)
    expect($('[data-qd-flyout="downloads"]')).not.toBeNull()
    await userEvent.keyboard(`{${mod()}>}k{/${mod()}}`)
    await settle(300)
    expect(ui.topOverlay?.kind).toBe('palette')
    await userEvent.keyboard('settings')
    await settle(200)
    expect(document.querySelectorAll('[role="dialog"] [role="option"]').length).toBeGreaterThan(0)
    expect(row()).toBeNull()
  })

  it('closes what is left open over the reader as it opens (a tray link, the palette’s About)', async () => {
    await bootApp()
    // The rail's Downloads flyout closes only for the manager by itself.
    const downloads = $('.rail button[data-view="downloads"]') as HTMLElement
    await userEvent.click(downloads)
    await settle(300)
    expect($('[data-qd-flyout="downloads"]')).not.toBeNull()
    expect(ui.floating).toBe(1)
    ui.setView('settings')
    await settle(400)
    expect(settingsDialog()).not.toBeNull()
    expect($('[data-qd-flyout="downloads"]')).toBeNull()
    expect(downloads.getAttribute('aria-expanded')).toBe('false')
    expect(ui.floating).toBe(0)
    expect(ui.layerOpen).toBe(false)
    await expect.poll(() => isSearchField(document.activeElement)).toBe(true)
    // So Ctrl+, still closes it.
    await userEvent.keyboard(`{${mod()}>},{/${mod()}}`)
    await settle(300)
    expect(ui.view).toBe('reader')

    // The ayah context menu too.
    ui.openContextMenu({ x: 600, y: 400, ayahId: 1 })
    await settle(300)
    expect($('.qd-menu')).not.toBeNull()
    ui.setView('about')
    await settle(400)
    expect(settingsDialog()).not.toBeNull()
    expect(ui.contextMenu).toBeNull()
    expect($('.qd-menu')).toBeNull()
    expect(ui.floating).toBe(0)
  })

  it('fills a small window under the title bar, keeps the dock off its rows, and puts the sections in one row', async () => {
    await bootApp({ size: [860, 640] })
    await openFromRail()
    const dialog = settingsDialog() as HTMLElement
    const box = dialog.getBoundingClientRect()
    expect([box.left, box.top, box.right, box.bottom].map(Math.round)).toEqual([0, 40, 860, 640])
    expect(getComputedStyle(dialog).borderStartStartRadius).toBe('0px')

    // The dock lies over the dialog's bottom: scrolled to the end, the last row ends above it.
    const viewport = dialog.querySelector<HTMLElement>('[data-scroll-area-viewport]') as HTMLElement
    viewport.scrollTo({ top: viewport.scrollHeight })
    await settle()
    const rows = dialog.querySelectorAll('[data-row]')
    const last = rows[rows.length - 1] as HTMLElement
    const dockTop = ($('[data-qd-region="dock"] > *') as HTMLElement).getBoundingClientRect().top
    expect(last.getBoundingClientRect().bottom).toBeLessThanOrEqual(dockTop)

    // One row of sections that scrolls sideways, beside nothing but itself; End then Enter shows the last one, in view.
    const strip = dialog.querySelector<HTMLElement>('ul.sections') as HTMLElement
    const buttons = [...strip.querySelectorAll<HTMLElement>('button[data-section]')]
    expect(new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size).toBe(1)
    expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth)
    buttons[0]?.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(buttons[1])
    await userEvent.keyboard('{End}')
    await userEvent.keyboard('{Enter}')
    await settle(200)
    const current = strip.querySelector<HTMLElement>('[aria-current="page"]') as HTMLElement
    expect(current.dataset.section).toBe('about')
    const s = strip.getBoundingClientRect()
    const c = current.getBoundingClientRect()
    expect(c.left >= s.left - 1 && c.right <= s.right + 1).toBe(true)
    // The close button keeps clear of the search field.
    const x = ($('[data-action="close-dialog"]') as HTMLElement).getBoundingClientRect()
    const search = ($('[data-settings-search]') as HTMLElement).getBoundingClientRect()
    expect(search.right).toBeLessThanOrEqual(x.left)
  })

  // A roomy window (centred) and a short one (filled): the frame never reaches into the bar's band, so the bar slides in
  // uncovered, its buttons on top, and reaching for the X never brings it.
  for (const [w, h] of [
    [1600, 1000],
    [900, 540],
  ] as const) {
    it(`in zen stays below the title bar’s band (${w} × ${h}), uncovered by the scrim while the bar slides in`, async () => {
      await bootApp({ size: [w, h] })
      ui.setZen(true)
      await settle(300)
      ;(document.activeElement as HTMLElement | null)?.blur()
      await userEvent.keyboard(`{${mod()}>},{/${mod()}}`)
      await settle(300)
      expect(ui.zen).toBe(true)
      const scrim = $('.backdrop.layer-view') as HTMLElement
      expect(scrim.getBoundingClientRect().top).toBe(0)
      const before = (settingsDialog() as HTMLElement).getBoundingClientRect()
      // Clear of the dock's band too: in zen the dock slides in like the bar.
      if (w === 1600) expect(near(before.top + before.height / 2, 40 + (960 - 58) / 2)).toBe(true)
      else expect(Math.round(before.top)).toBe(40)
      const x = ($('[data-action="close-dialog"]') as HTMLElement).getBoundingClientRect()
      expect(x.top).toBeGreaterThan(40)

      ui.notePointer(4, window.innerHeight)
      await settle(400)
      expect(scrim.getBoundingClientRect().top).toBe(40)
      // The dialog does not move, and the bar paints above everything in its band.
      expect((settingsDialog() as HTMLElement).getBoundingClientRect().top).toBe(before.top)
      expect(ui.captionVisible).toBe(true)
      const buttons = [...document.querySelectorAll<HTMLElement>('.titlebar button')]
      expect(buttons.length).toBeGreaterThan(1)
      expect(buttons.filter((b) => !onTop(b)).map((b) => b.outerHTML.slice(0, 120))).toEqual([])
    })
  }

  it('shows About in the same frame, named "About Quran for Desktop", and Escape returns to the reader', async () => {
    await bootApp()
    await openFromRail()
    await section('about')
    await userEvent.click($('[data-action="open-about"]') as HTMLElement)
    await settle(300)
    expect(ui.view).toBe('about')
    const dialog = settingsDialog() as HTMLElement
    expect(dialog.querySelector('[data-qd-view="about"]')).not.toBeNull()
    expect(nameOf(dialog)).toBe('About Quran for Desktop')
    await expect.poll(() => document.activeElement?.getAttribute('data-action')).toBe('copy-diagnostics')
    expect(railButton().getAttribute('aria-expanded')).toBe('true')
    await userEvent.keyboard('{Escape}')
    await closed()
    expect(ui.view).toBe('reader')
  })

  it('mirrors in the Arabic UI: the close button at the top left, the navigation on the right', async () => {
    await bootApp({ settings: { uiLanguage: 'ar' } })
    await openFromRail()
    const dialog = settingsDialog() as HTMLElement
    expect(nameOf(dialog)).toBe('الإعدادات')
    const box = dialog.getBoundingClientRect()
    const x = ($('[data-action="close-dialog"]') as HTMLElement).getBoundingClientRect()
    expect(x.left).toBeLessThan(box.left + 24)
    const nav = (dialog.querySelector('nav.nav') as HTMLElement).getBoundingClientRect()
    const column = (dialog.querySelector('.content') as HTMLElement).getBoundingClientRect()
    expect(nav.left).toBeGreaterThan(column.left)
  })
})

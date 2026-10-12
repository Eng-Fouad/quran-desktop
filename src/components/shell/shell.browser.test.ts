/**
 * The shell in a real browser (§7.5, §9.6, §9.8, §8.15): landmarks and the skip link, the title bar per platform,
 * PaneLayout (pixel widths, keyboard resizing, the docking rule, the floating sidebar and the sheet), zen, the shortcut
 * sheet, the confirmation dialog, the fatal screen, the startup banner, the offline badge, toasts and the Arabic mirror.
 * Everything runs against the browser mock, booted like `main.ts`.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, server, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import App from '../../App.svelte'
import { IpcError, events } from '$lib/ipc'
import { mockCommands } from '$lib/ipc/mock'
import { idleSnapshot } from '$lib/ipc/mock/state'
import { app, player, reader, settings, ui } from '$lib/stores'
import { bootApp, resetApp, settle, widthOf } from './testing/boot'
import { BLOCK_BOTTOM } from './toastPlacement'
import { BLOCK_TOP } from '$lib/mushaf/geometry'

/** The file dialogs (`@tauri-apps/plugin-dialog`): `open` answers `picked`, as if the user chose that file. */
const dialog = vi.hoisted(() => ({ picked: null as string | null }))
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => dialog.picked),
  save: vi.fn(async () => null),
}))

/** WebKit on the Linux runner paints in software (no GPU): tests that open many dialogs get 30 s there. */
const softwarePaint = server.browser === 'webkit' && server.platform === 'linux' ? { timeout: 30_000 } : {}

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const rect = (selector: string) => $(selector)?.getBoundingClientRect() ?? new DOMRect()
const near = (actual: number, expected: number, tolerance = 2) => Math.abs(actual - expected) <= tolerance
/** Waits (real time) until `done()` holds. */
async function until(done: () => boolean, timeout = 5_000): Promise<void> {
  const end = performance.now() + timeout
  while (!done()) {
    if (performance.now() > end) throw new Error(`condition not met within ${timeout} ms`)
    await new Promise((resolve) => setTimeout(resolve, 20))
    flushSync()
  }
}
const dialogNamed = (name: string) =>
  $$('[role="dialog"]').find((d) => {
    const id = d.getAttribute('aria-labelledby')
    return id !== null && document.getElementById(id)?.textContent === name
  })

afterEach(async () => {
  resetApp()
  dialog.picked = null
  vi.restoreAllMocks()
  await page.viewport(1280, 800)
})

describe('App shell: landmarks and title bar', () => {
  it('lays out the §8.15 landmarks with the skip link as the first tab stop', async () => {
    await bootApp()
    expect($('nav[aria-label="Sections"]')).not.toBeNull()
    expect($('aside[data-qd-region="sidebar"]')?.getAttribute('aria-label')).toBe('Index')
    expect($('main#qd-main')).not.toBeNull()
    expect($('[role="region"][aria-label="Recitation player"]')).not.toBeNull()
    expect($('header.titlebar')).not.toBeNull()

    ;(document.activeElement as HTMLElement | null)?.blur()
    await userEvent.tab()
    const skip = document.activeElement as HTMLElement
    expect(skip.classList.contains('skip-link')).toBe(true)
    expect(skip.textContent).toBe('Skip to Quran text')
    expect(skip.getBoundingClientRect().width).toBeGreaterThan(40)
    await userEvent.keyboard('{Enter}')
    const target = document.activeElement as HTMLElement
    expect(target.id === 'qd-main' || target.matches('.mp-a11y li')).toBe(true)
  })

  it('shows the breadcrumb and opens the palette and Go to from the title bar', async () => {
    await bootApp()
    const crumbs = $('nav.crumbs')?.textContent ?? ''
    expect(crumbs).toContain('Al-Fatihah')
    expect(crumbs).toContain('Juz 1')
    expect(crumbs).toMatch(/Pages 1–2|Page 1/)
    await userEvent.click($('button.command') as HTMLElement)
    expect(ui.topOverlay?.kind).toBe('palette')
    ui.close()
    await userEvent.click($('button.crumb-button') as HTMLElement)
    expect(ui.topOverlay?.kind).toBe('goto')
    ui.close()
    ui.setView('settings')
    flushSync()
    expect($('nav.crumbs')?.textContent).toContain('Settings')
    await userEvent.click($('button.crumb-button.back') as HTMLElement)
    expect(ui.view).toBe('reader')
  })

  it('draws the title bar per platform: Windows caption buttons, the macOS inset, a plain Linux toolbar', async () => {
    await bootApp({ edit: (b) => ({ ...b, app: { ...b.app, platform: 'windows' } }) })
    const bar = $('header.titlebar') as HTMLElement
    expect(bar.getAttribute('data-tauri-drag-region')).toBe('deep')
    const captions = $$('.controls .control').map((b) => b.getAttribute('aria-label'))
    expect(captions).toEqual(['Minimize', 'Maximize', 'Close'])
    // The caption group ends at the window edge, 46 × 40 each.
    expect(near(rect('.controls').right, window.innerWidth, 1)).toBe(true)
    expect(rect('.controls .close').width).toBe(46)
    expect(rect('.controls .close').height).toBe(40)
    resetApp()

    await bootApp({ edit: (b) => ({ ...b, app: { ...b.app, platform: 'macos' } }) })
    expect($$('.controls .control')).toHaveLength(0)
    expect(getComputedStyle($('header.titlebar') as HTMLElement).paddingLeft).toBe('78px')
    resetApp()

    await bootApp({ edit: (b) => ({ ...b, app: { ...b.app, platform: 'linux' } }) })
    expect($('header.titlebar')?.hasAttribute('data-tauri-drag-region')).toBe(false)
    expect($$('.controls .control')).toHaveLength(0)
  })

  it('stands the native Snap Layouts target down while zen or a modal hides the caption buttons (§9.6)', async () => {
    const caption = vi.spyOn(mockCommands, 'windowSetCaption')
    await bootApp({ edit: (b) => ({ ...b, app: { ...b.app, platform: 'windows' } }) })
    const last = () => caption.mock.calls.at(-1)?.[0]
    await expect.poll(last).toBe(true)
    ui.open('shortcuts', {})
    await expect.poll(last).toBe(false)
    ui.close()
    await expect.poll(last).toBe(true)
    ui.toggleZen()
    await expect.poll(last).toBe(false)
    ui.toggleZen()
    await expect.poll(last).toBe(true)
    // The Snap Layouts target's pointer state shows on the maximise button like :hover (WP6b).
    const max = $('[data-qd-snap]') as HTMLElement
    window.dispatchEvent(
      new CustomEvent('qd:caption-button', { detail: { button: 'maximize', state: 'hover' } }),
    )
    await expect.poll(() => max.dataset.nativeState).toBe('hover')
    window.dispatchEvent(
      new CustomEvent('qd:caption-button', { detail: { button: 'maximize', state: 'none' } }),
    )
    await expect.poll(() => max.dataset.nativeState).toBeUndefined()
    expect(caption.mock.calls.every(([v]) => typeof v === 'boolean')).toBe(true)
  })
})

describe('PaneLayout (§9.6)', () => {
  it('keeps the sidebar at its pixel width and resizes it from the keyboard, persisting the width', async () => {
    await bootApp()
    expect(near(widthOf('aside[data-qd-region="sidebar"]'), 300)).toBe(true)
    const splitter = $('[role="separator"][aria-label="Resize sidebar"]') as HTMLElement
    splitter.focus()
    await userEvent.keyboard('{ArrowRight}')
    await settle()
    expect(settings.value.sidebar.widthPx).toBe(316)
    expect(near(widthOf('aside[data-qd-region="sidebar"]'), 316)).toBe(true)
    // The width is pixels, not a share of the window: a wider window leaves it alone.
    await page.viewport(1800, 1000)
    await settle(120)
    expect(near(widthOf('aside[data-qd-region="sidebar"]'), 316)).toBe(true)
    // Double-click restores the default.
    await userEvent.dblClick(splitter)
    await settle()
    expect(settings.value.sidebar.widthPx).toBe(300)
    expect(near(widthOf('aside[data-qd-region="sidebar"]'), 300)).toBe(true)
  })

  it('docks the side pane beside an open sidebar at 1536 × 864 (S32), and collapses the sidebar first when it must', async () => {
    await bootApp({ size: [1536, 864] })
    ui.openSidePane()
    await settle(120)
    expect(ui.paneDocked).toBe(true)
    expect(near(widthOf('aside[data-qd-region="side-pane"]'), 400)).toBe(true)
    expect(near(widthOf('aside[data-qd-region="sidebar"]'), 300)).toBe(true)
    expect(near(widthOf('main#qd-main'), 1536 - 52 - 300 - 400)).toBe(true)

    await page.viewport(1100, 800)
    await settle(120)
    expect(ui.sidebarAutoCollapsed).toBe(true)
    expect($('aside[data-qd-region="sidebar"]')).toBeNull()
    expect(near(widthOf('aside[data-qd-region="side-pane"]'), 400)).toBe(true)

    // Too narrow to dock at all: the pane becomes a sheet from the inline end.
    await page.viewport(700, 600)
    await settle(400)
    expect(ui.paneDocked).toBe(false)
    expect($('aside[data-qd-region="side-pane"]')).toBeNull()
    expect(dialogNamed('Study pane')).toBeDefined()
    // Focus is inside the sheet (on its first enabled control, finding 16), and one Escape closes it.
    expect(dialogNamed('Study pane')?.contains(document.activeElement)).toBe(true)
    await userEvent.keyboard('{Escape}')
    await settle(400)
    expect(ui.sidePaneOpen).toBe(false)
  })

  it('floats the sidebar over a narrow window and closes it from the scrim or Escape', async () => {
    await bootApp({ size: [820, 700] })
    expect(ui.sidebarOverlay).toBe(true)
    expect($('aside[data-qd-region="sidebar"]')).toBeNull()
    await userEvent.click($('.rail button[data-tab="bookmarks"]') as HTMLElement)
    await settle(260)
    const floating = $('aside.floating') as HTMLElement
    expect(floating).not.toBeNull()
    expect(floating.getAttribute('aria-label')).toBe('Bookmarks')
    // The canvas keeps its width: the sidebar floats over it.
    expect(near(widthOf('main#qd-main'), 820 - 52)).toBe(true)
    await userEvent.click($('.scrim') as HTMLElement, { position: { x: 700, y: 300 } })
    await settle(260)
    expect($('aside.floating')).toBeNull()
    ui.openSidebar()
    await settle(260)
    ;(document.activeElement as HTMLElement | null)?.blur()
    await userEvent.keyboard('{Escape}')
    await settle(260)
    expect($('aside.floating')).toBeNull()
  })
})

describe('zen (§9.6)', () => {
  it('keeps only the canvas, names the key that leaves, and reveals the title bar at the top edge', async () => {
    await bootApp()
    ui.setZen(true)
    await settle(320)
    expect(widthOf('nav.rail')).toBe(0)
    expect($('aside[data-qd-region="sidebar"]')).toBeNull()
    expect(rect('.titlebar-slot').bottom).toBeLessThanOrEqual(1)
    expect(near(widthOf('main#qd-main'), 1600)).toBe(true)
    expect($('.zen-hint')?.textContent).toContain('Zen mode')

    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 800, clientY: 6 }))
    await settle(320)
    expect(rect('.titlebar-slot').top).toBe(0)
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 800, clientY: 980 }))
    await settle(320)
    expect(getComputedStyle($('[data-qd-region="dock"]') as HTMLElement).opacity).toBe('1')

    ;(document.activeElement as HTMLElement | null)?.blur()
    await userEvent.keyboard('{Escape}')
    await settle()
    expect(ui.zen).toBe(false)
    expect(widthOf('nav.rail')).toBe(52)
  })
})

describe('overlays', () => {
  it('shortcut sheet: lists the registered shortcuts, filters, and closes with Escape', async () => {
    await bootApp()
    ;(document.activeElement as HTMLElement | null)?.blur()
    await userEvent.keyboard('?')
    await settle(300)
    const sheet = dialogNamed('Keyboard shortcuts')
    expect(sheet).toBeDefined()
    expect(document.activeElement?.matches('input[type="search"]')).toBe(true)
    expect(sheet?.querySelector('[data-shortcut="app.palette"]')?.textContent).toContain('Command palette')
    expect(sheet?.querySelector('[data-shortcut="app.palette"] .keys')?.textContent).toContain('K')

    await userEvent.keyboard('palette')
    await settle()
    expect(
      [...(sheet?.querySelectorAll('[data-shortcut]') ?? [])].map((r) => r.getAttribute('data-shortcut')),
    ).toEqual(['app.palette'])
    await userEvent.keyboard('zzz')
    await settle()
    expect(sheet?.textContent).toContain('No shortcut matches')

    // Escape empties the filter first, then closes the sheet.
    await userEvent.keyboard('{Escape}')
    await settle()
    expect(dialogNamed('Keyboard shortcuts')).toBeDefined()
    expect(sheet?.querySelectorAll('[data-shortcut]').length).toBeGreaterThan(10)
    await userEvent.keyboard('{Escape}')
    await settle(400)
    expect(dialogNamed('Keyboard shortcuts')).toBeUndefined()
    expect(ui.overlays).toEqual([])
  })

  it('confirm dialog: yes only from its confirm button; a destructive question starts on Cancel', async () => {
    await bootApp()
    const no = ui.confirm({
      title: 'Delete note?',
      body: 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    })
    await settle(300)
    expect(dialogNamed('Delete note?')).toBeDefined()
    expect(document.activeElement?.textContent?.trim()).toBe('Cancel')
    await userEvent.keyboard('{Enter}')
    await expect(no).resolves.toBe(false)

    const yes = ui.confirm({ title: 'Clear cache?', body: 'Downloads are kept.', confirmLabel: 'Clear' })
    await settle(300)
    expect(document.activeElement?.textContent?.trim()).toBe('Clear')
    expect((document.activeElement as HTMLElement).hasAttribute('data-confirm')).toBe(true)
    await userEvent.click(document.activeElement as HTMLElement)
    await expect(yes).resolves.toBe(true)
    await settle(400)
    expect(dialogNamed('Clear cache?')).toBeUndefined()
  })

  // Seven dialogs open and close over the reader, each waiting on frames that WebKit on the Linux runner paints on the
  // CPU: 11.6 s in CI and up to 12.1 s in a CI-like container, against vitest's 15 s. It gets 30 s there, as the
  // Settings dialog's tests do.
  it('renders every overlay kind as its own dialog, never a placeholder', softwarePaint, async () => {
    await bootApp()
    const kinds = [
      ['goto', {}],
      ['shortcuts', {}],
      ['palette', {}],
      ['note-editor', { fromAyahId: 1, toAyahId: 1 }],
      ['self-test', { fromAyahId: 1, toAyahId: 7 }],
      ['onboarding', {}],
      ['confirm', { title: 'Sure?', body: 'Really.', confirmLabel: 'Yes' }],
    ] as const
    for (const [kind, props] of kinds) {
      ui.open(kind, props as never)
      await settle(120)
      const slot = $(`.overlay-slot[data-overlay="${kind}"]`)
      expect(slot, kind).not.toBeNull()
      expect($('[data-placeholder]'), kind).toBeNull()
      expect(($('[role="dialog"]')?.getBoundingClientRect().width ?? 0) > 100, kind).toBe(true)
      ui.close()
      await settle(400)
      expect($('.overlay-slot'), kind).toBeNull()
    }
  })

  it('releases the body lock when an overlay opens during the previous one’s exit (WP9b)', async () => {
    await bootApp()
    const ask = () => ui.confirm({ title: 'Sure?', body: 'Really.', confirmLabel: 'Yes' })
    void ask()
    await settle(120)
    ui.close('confirm')
    // Inside OverlayHost's exit window: the closing instance is replaced while bits-ui is mid-exit.
    await new Promise((resolve) => setTimeout(resolve, 150))
    void ask()
    await settle(120)
    expect(document.body.style.pointerEvents).toBe('none')
    ui.close('confirm')
    await expect
      .poll(() => [document.body.style.pointerEvents, document.body.style.overflow], { timeout: 2000 })
      .toEqual(['', ''])
    // The app takes clicks again.
    await userEvent.click($('.crumb-button') as HTMLElement)
    await expect.poll(() => ui.isTop('goto')).toBe(true)
  })
})

describe('first run (§9.7)', () => {
  it('opens the welcome flow on the first run, and never once it is done or in test mode', async () => {
    await bootApp({ firstRun: true })
    await expect.poll(() => ui.isTop('onboarding')).toBe(true)
    await expect.poll(() => $('.qd-onboarding') !== null).toBe(true)
    resetApp()

    await bootApp({ firstRun: true, settings: { onboardingDone: true } })
    await settle(120)
    expect(ui.isOpen('onboarding')).toBe(false)
    resetApp()

    await bootApp({ firstRun: true, edit: (b) => ({ ...b, app: { ...b.app, testMode: true } }) })
    await settle(120)
    expect(ui.isOpen('onboarding')).toBe(false)
  })
})

describe('§9.8 states', () => {
  it('fatal screen: the core.db-missing copy with the command, details and the QA marker', async () => {
    app.failBootstrap(new IpcError('not_found', 'core.db missing — run pnpm core:qdc'))
    await render(App)
    const main = $('main.fatal') as HTMLElement
    expect(main.dataset.qdFatal).toBe('not_found')
    expect(main.querySelector('h1')?.textContent).toBe('Core data missing (dev build)')
    expect(main.querySelector('code')?.textContent).toBe('pnpm core:qdc')
    await userEvent.click(main.querySelector('summary') as HTMLElement)
    expect(main.querySelector('pre')?.textContent).toContain('core.db missing')
    expect($('.app')).toBeNull()
  })

  it('fatal screen: any other failure shows the localised error, never the raw message as text', async () => {
    app.failBootstrap(new IpcError('database', 'SQLITE_CORRUPT at page 7'))
    await render(App)
    const main = $('main.fatal') as HTMLElement
    expect(main.querySelector('h1')?.textContent).toBe("Quran couldn't start")
    expect(main.querySelector('.body')?.textContent).toBe('The local database reported a problem.')
    expect(main.querySelector('details')?.open).toBe(false)
  })

  it('startup banner: names the kept copy, shows the files, and goes away when dismissed', async () => {
    const reveal = vi.spyOn(mockCommands, 'systemRevealDataDir')
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await bootApp({
      edit: (b) => ({
        ...b,
        notices: [
          { type: 'user_db_recovered', data: { quarantinedFile: 'C:\\data\\user.db.corrupt-1760083200000' } },
        ],
      }),
    })
    const banner = $('[role="alert"][data-notice="user_db_recovered"]') as HTMLElement
    expect(banner.textContent).toContain("Your library couldn't be opened. A copy was kept.")
    expect(banner.textContent).toContain('user.db.corrupt-1760083200000')
    const bodyTop = rect('.app-body').top
    expect(bodyTop).toBeGreaterThan(40)
    await userEvent.click(
      [...banner.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Show files'),
      ) as HTMLElement,
    )
    expect(reveal).toHaveBeenCalledTimes(1)
    await userEvent.click(banner.querySelector('button[aria-label="Dismiss"]') as HTMLElement)
    await settle()
    expect($('[role="alert"][data-notice]')).toBeNull()
    expect(rect('.app-body').top).toBe(40)
  })

  it('startup banner: restores a chosen backup after confirming, then goes away (§9.8)', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await bootApp({
      edit: (b) => ({
        ...b,
        notices: [{ type: 'user_db_recovered', data: { quarantinedFile: 'C:\\data\\user.db.corrupt-1' } }],
      }),
    })
    const path = 'D:/Backups/library.qdb'
    await mockCommands.userBackupCreate(path)
    dialog.picked = path
    const restore = vi.spyOn(mockCommands, 'userBackupRestore')
    const banner = $('[role="alert"][data-notice="user_db_recovered"]') as HTMLElement
    const button = [...banner.querySelectorAll('button')].find((b) => b.textContent?.includes('Restore'))
    await userEvent.click(button as HTMLElement)
    await expect.poll(() => dialogNamed('Restore this backup?')).toBeDefined()
    expect(dialogNamed('Restore this backup?')?.textContent).toContain('library.qdb')
    expect(restore).not.toHaveBeenCalled()
    await userEvent.click($('[data-confirm]') as HTMLElement)
    await expect.poll(() => restore.mock.calls.length).toBe(1)
    expect(restore).toHaveBeenCalledWith(path)
    await expect.poll(() => $('[role="alert"][data-notice]')).toBeNull()
    await expect
      .poll(() => $('[data-sonner-toast]')?.textContent ?? '')
      .toContain('Library restored from library.qdb')
  })

  it('offline badge: shows while offline or with network use off, and opens Settings', async () => {
    await bootApp()
    expect($('.titlebar .badge')).toBeNull()
    await events.networkChanged.emit({ online: false })
    await settle()
    expect($('.titlebar .badge')?.textContent?.trim()).toBe('Offline')
    await events.networkChanged.emit({ online: true })
    await settings.update({ networkAllowed: false })
    await settle()
    const badge = $('.titlebar .badge') as HTMLElement
    expect(badge.textContent?.trim()).toBe('Offline mode')
    expect(badge.dataset.reason).toBe('disallowed')
    await userEvent.click(badge)
    expect(ui.view).toBe('settings')
  })
})

describe('toasts', () => {
  it('centres toasts on the canvas above the dock, and F6 reaches them', async () => {
    await bootApp()
    ui.toast({ message: 'Bookmarked 2:255', action: { label: 'Undo', run: () => {} } })
    await settle(500)
    const toast = $('[data-sonner-toast]') as HTMLElement
    expect(toast).not.toBeNull()
    const canvas = rect('main#qd-main')
    const box = toast.getBoundingClientRect()
    expect(near(box.left + box.width / 2, canvas.left + canvas.width / 2, 3)).toBe(true)
    expect(box.bottom).toBeLessThanOrEqual(canvas.bottom - 90)
    ;(document.activeElement as HTMLElement | null)?.blur()
    await userEvent.keyboard('{F6}')
    expect(toast.contains(document.activeElement) || document.activeElement === toast).toBe(true)
  })

  it('keeps toasts above "Return to recitation" in the overlay slot, and back down once it goes (§7.5)', async () => {
    await bootApp({ settings: { pageMode: 'spread', mushafStyle: 'hafs', pageTurnAnimation: false } })
    await until(() => document.querySelector('.mushaf-view section.mp') !== null)
    player.snapshot = { ...idleSnapshot(settings.value), status: 'playing' }
    player.heard = { surah: 1, ayah: 2, ayahId: 2 }
    reader.goToPage(50)
    await until(() => document.querySelector('[data-qd-follow-chip]') !== null)
    ui.toastUndo('Bookmarked 2:255', () => {})
    await settle(600)
    const chip = ($('[data-qd-follow-chip]') as HTMLElement).getBoundingClientRect()
    const toast = ($('[data-sonner-toast]') as HTMLElement).getBoundingClientRect()
    // The toast sits wholly above the chip, and the chip takes its own clicks.
    expect(toast.bottom).toBeLessThanOrEqual(chip.top)
    const hit = document.elementFromPoint(chip.left + chip.width / 2, chip.top + chip.height / 2)
    expect(hit?.closest('[data-qd-follow-chip]')).not.toBeNull()
    expect(ui.overlayReach).toBeGreaterThan(0)
    // Dismissed: the slot is empty again and new toasts return above the dock.
    reader.dismissFollowChip()
    await until(() => document.querySelector('[data-qd-follow-chip]') === null)
    await until(() => ui.overlayReach === 0)
    player.snapshot = null
    player.heard = null
  })
})

describe('toasts and the Quran text', () => {
  /** The text block of the book on the canvas (its paper less the head and foot bands, §8.2). */
  function textBlock(): { top: number; bottom: number } {
    const book = rect('[data-qd-stage]')
    return { top: book.top + BLOCK_TOP * reader.qfs, bottom: book.bottom - BLOCK_BOTTOM * reader.qfs }
  }

  it('in zen (no dock band) an Undo toast never lies over the text block', async () => {
    await bootApp({ settings: { pageMode: 'spread', mushafStyle: 'hafs', pageTurnAnimation: false } })
    await until(() => document.querySelector('[data-qd-stage] section.mp') !== null)
    reader.goToPage(262)
    ui.setZen(true)
    await settle(700)
    expect(reader.scrolls).toBe(false)
    ui.toastUndo('Removed the bookmark from Al-Hijr 15:4', () => {})
    await settle(700)
    const toast = rect('[data-sonner-toast]')
    const text = textBlock()
    expect(toast.height).toBeGreaterThan(0)
    expect(toast.top >= text.bottom - 1 || toast.bottom <= text.top + 1).toBe(true)
  })

  it('with qfs held at its floor (the book overflows the canvas) the toast takes the top edge', async () => {
    await bootApp({ size: [1024, 560], settings: { pageMode: 'single', mushafStyle: 'hafs' } })
    await until(() => document.querySelector('[data-qd-stage] section.mp') !== null)
    await settle(300)
    expect(reader.scrolls).toBe(true)
    ui.toastUndo('Removed the bookmark from Al-Hijr 15:4', () => {})
    await settle(700)
    const canvas = rect('main#qd-main')
    const toast = rect('[data-sonner-toast]')
    expect(toast.top - canvas.top).toBeLessThan(40)
    // Over the paper's top margin and running head: at most a sliver of the first line.
    expect(toast.bottom - textBlock().top).toBeLessThan(16)
  })
})

describe('Arabic UI (§11.3)', () => {
  it('mirrors the chrome: rail and sidebar on the right, caption buttons on the left with close outermost', async () => {
    await bootApp({
      settings: { uiLanguage: 'ar' },
      edit: (b) => ({ ...b, app: { ...b.app, platform: 'windows' } }),
    })
    expect(document.documentElement.dir).toBe('rtl')
    const rail = rect('nav.rail')
    const sidebar = rect('aside[data-qd-region="sidebar"]')
    expect(near(rail.right, window.innerWidth, 1)).toBe(true)
    expect(sidebar.right).toBeLessThanOrEqual(rail.left + 1)
    expect(rect('.controls .close').left).toBe(0)
    expect($('aside[data-qd-region="sidebar"]')?.getAttribute('aria-label')).toBe('الفهرس')
    // The splitter follows the mirror: ArrowLeft widens a sidebar that sits on the right.
    ;($('[role="separator"]') as HTMLElement).focus()
    await userEvent.keyboard('{ArrowLeft}')
    await settle()
    expect(settings.value.sidebar.widthPx).toBe(316)
  })
})

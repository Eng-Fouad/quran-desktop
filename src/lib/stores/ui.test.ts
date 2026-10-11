import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '$lib/contracts/settings'
import { ar } from '$lib/i18n'
import { api, call, events, initIpc, IpcError } from '$lib/ipc'
import type { NavTarget, Settings } from '$lib/ipc/bindings'
import { state } from '$lib/ipc/mock/state'
import { app } from './app.svelte'
import { i18n } from './i18n.svelte'
import { settings } from './settings.svelte'
import { paneCanDock } from '$lib/mushaf/geometry'
import {
  inDialog,
  paneLimits,
  readingCursor,
  RAIL_W,
  shellLayout,
  TITLEBAR_H,
  TOAST_ACTION_MIN_MS,
  TOAST_MS,
  ui,
  ZEN_DOCK_POKE_MS,
  ZEN_IDLE_MS,
  type ShellInput,
} from './ui.svelte'

interface SonnerCall {
  type: string
  message: string
  data: { id: number; duration: number; important: boolean; action?: unknown; onAutoClose: () => void }
}
const sonner = vi.hoisted(() => ({ calls: [] as SonnerCall[] }))

vi.mock('svelte-sonner', () => {
  const record = (type: string) => (message: string, data: SonnerCall['data']) => {
    sonner.calls.push({ type, message, data })
    return data.id
  }
  const toast = Object.assign(record('default'), {
    error: record('error'),
    warning: record('warning'),
    success: record('success'),
    dismiss: vi.fn(),
  })
  return { toast }
})

const sizeDescriptors = {
  innerWidth: Object.getOwnPropertyDescriptor(window, 'innerWidth'),
  innerHeight: Object.getOwnPropertyDescriptor(window, 'innerHeight'),
}

function resizeWindow(w: number, h: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: h })
  window.dispatchEvent(new Event('resize'))
}

async function boot(stored?: Partial<Settings>): Promise<void> {
  localStorage.clear()
  await initIpc()
  state.resetAll()
  state.loadAll()
  if (stored) state.settings.set({ ...defaultSettings(), ...stored })
  const b = await call(api.appBootstrap())
  app.init(b)
  settings.init(b)
  i18n.init(b)
  ui.init(b)
}

beforeEach(async () => {
  sonner.calls.length = 0
  await boot()
})

afterEach(() => {
  ui.reset()
  i18n.reset()
  settings.reset()
  app.reset()
  for (const [name, descriptor] of Object.entries(sizeDescriptors)) {
    if (descriptor) Object.defineProperty(window, name, descriptor)
  }
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('ui store: overlays and layers (§7.4)', () => {
  it('stacks overlays, moves a reopened kind to the top and toggles the palette', () => {
    ui.open('goto', { initial: '2:255' })
    ui.open('palette', {})
    expect(ui.topOverlay?.kind).toBe('palette')
    ui.open('goto', {})
    expect(ui.overlays.map((o) => o.kind)).toEqual(['palette', 'goto'])
    expect(ui.topOverlay).toEqual({ kind: 'goto', props: {} })
    ui.close()
    expect(ui.topOverlay?.kind).toBe('palette')
    ui.open('palette', {})
    expect(ui.overlays).toEqual([])
    ui.open('palette', { query: 'kahf' })
    expect(ui.isOpen('palette')).toBe(true)
    ui.close('palette')
    ui.close()
    expect(ui.overlays).toEqual([])
  })

  it('counts floating layers and the context menu as open layers', () => {
    expect(ui.layerOpen).toBe(false)
    ui.pushFloating()
    ui.pushFloating()
    expect(ui.layerOpen).toBe(true)
    ui.popFloating()
    ui.popFloating()
    ui.popFloating()
    expect(ui.floating).toBe(0)
    expect(ui.layerOpen).toBe(false)
    ui.openContextMenu({ x: 10, y: 20, ayahId: 262 })
    expect(ui.layerOpen).toBe(true)
    // An overlay replaces the context menu.
    ui.open('shortcuts', {})
    expect(ui.contextMenu).toBeNull()
  })

  it('keeps the Settings dialog out of the layers: neither floating nor modal, reset with the store', () => {
    expect(['settings', 'about'].map((v) => inDialog(v as 'settings'))).toEqual([true, true])
    expect(['reader', 'downloads'].map((v) => inDialog(v as 'reader'))).toEqual([false, false])
    ui.setSettingsOpen(true)
    expect(ui.layerOpen).toBe(false)
    expect(ui.captionVisible).toBe(true)
    ui.reset()
    expect(ui.settingsOpen).toBe(false)
  })

  it('asks every floating layer to close, and closes the context menu (the Settings dialog opening)', () => {
    ui.openContextMenu({ x: 0, y: 0, ayahId: 1 })
    const before = ui.floatingDismissals
    ui.dismissFloating()
    expect(ui.floatingDismissals).toBe(before + 1)
    expect(ui.contextMenu).toBeNull()
    // Overlays are no floating layers: they stay.
    ui.open('goto', {})
    ui.dismissFloating()
    expect(ui.isOpen('goto')).toBe(true)
  })

  it('dismisses the context menu first, then the top overlay', () => {
    ui.open('goto', {})
    ui.openContextMenu({ x: 0, y: 0, ayahId: 1 })
    expect(ui.dismissLayer()).toBe(true)
    expect(ui.contextMenu).toBeNull()
    expect(ui.isOpen('goto')).toBe(true)
    expect(ui.dismissLayer()).toBe(true)
    expect(ui.dismissLayer()).toBe(false)
  })

  it('never closes the onboarding as a layer: it ends through Finish (or Skip on a re-run, §9.7)', () => {
    ui.open('onboarding', {})
    expect(ui.dismissLayer()).toBe(true)
    expect(ui.isOpen('onboarding')).toBe(true)
    // An overlay on top of it is dismissed as usual, the onboarding stays.
    ui.open('palette', {})
    expect(ui.dismissLayer()).toBe(true)
    expect(ui.isOpen('palette')).toBe(false)
    expect(ui.isTop('onboarding')).toBe(true)
  })

  it('resolves confirm() from the dialog, and "no" for every other way it closes', async () => {
    const options = {
      title: 'Delete note?',
      body: 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    }
    const yes = ui.confirm(options)
    expect(ui.topOverlay).toEqual({ kind: 'confirm', props: options })
    ui.resolveConfirm(true)
    await expect(yes).resolves.toBe(true)
    expect(ui.isOpen('confirm')).toBe(false)

    const closed = ui.confirm(options)
    ui.close()
    await expect(closed).resolves.toBe(false)

    const replaced = ui.confirm(options)
    const second = ui.confirm({ ...options, title: 'Second' })
    await expect(replaced).resolves.toBe(false)
    expect(ui.topOverlay?.props).toMatchObject({ title: 'Second' })
    ui.reset()
    await expect(second).resolves.toBe(false)
  })
})

describe('ui store: views, zen, full screen', () => {
  it('switches views and closes the context menu', () => {
    ui.openContextMenu({ x: 0, y: 0, ayahId: 1 })
    ui.setView('settings')
    expect(ui.view).toBe('settings')
    expect(ui.contextMenu).toBeNull()
  })

  it('hides both panes in zen and leaves zen when a pane is opened', () => {
    // Wide enough for both panes (jsdom's 1024×768 would collapse the sidebar for the pane).
    resizeWindow(1920, 1080)
    ui.openSidePane()
    expect(ui.sidebarOpen).toBe(true)
    expect(ui.sidePaneOpen).toBe(true)
    ui.toggleZen()
    expect(ui.sidebarOpen).toBe(false)
    expect(ui.sidePaneOpen).toBe(false)
    ui.openSidebar()
    expect(ui.zen).toBe(false)
    expect(ui.sidebarOpen).toBe(true)
  })

  it('reveals the zen chrome at the window edges and hides the cursor when the pointer rests (§9.6)', () => {
    vi.useFakeTimers()
    ui.notePointer(990, 1000)
    expect(ui.zenDock).toBe(false)
    ui.setZen(true)
    expect(ui.pointerIdle).toBe(false)
    vi.advanceTimersByTime(ZEN_IDLE_MS)
    expect(ui.pointerIdle).toBe(true)
    ui.notePointer(500, 1000)
    expect(ui.pointerIdle).toBe(false)
    expect(ui.zenDock).toBe(false)
    ui.notePointer(940, 1000)
    expect(ui.zenDock).toBe(true)
    ui.notePointer(12, 1000)
    expect(ui.zenTitleBar).toBe(true)
    expect(ui.zenDock).toBe(false)
    ui.notePointerLeave()
    expect(ui.zenTitleBar).toBe(false)
    // An audio key shows the dock for a moment.
    ui.pokeDock()
    expect(ui.zenDock).toBe(true)
    vi.advanceTimersByTime(ZEN_DOCK_POKE_MS)
    expect(ui.zenDock).toBe(false)
    ui.setZen(false)
    expect({ idle: ui.pointerIdle, dock: ui.zenDock, top: ui.zenTitleBar }).toEqual({
      idle: false,
      dock: false,
      top: false,
    })
    ui.pokeDock()
    expect(ui.zenDock).toBe(false)
  })

  it('toggles full screen through the window API', async () => {
    await ui.toggleFullscreen()
    expect(ui.fullscreen).toBe(true)
    await ui.setFullscreen(false)
    expect(ui.fullscreen).toBe(false)
  })
})

describe('ui store: panes', () => {
  it('toggles the sidebar like the rail: another tab opens it, the shown tab closes it', async () => {
    expect(ui.sidebarOpen).toBe(true)
    ui.toggleSidebar('search')
    expect(settings.value.sidebar).toMatchObject({ open: true, tab: 'search' })
    ui.toggleSidebar('search')
    expect(ui.sidebarOpen).toBe(false)
    ui.toggleSidebar()
    expect(settings.value.sidebar).toMatchObject({ open: true, tab: 'search' })
    ui.toggleSidebar()
    expect(ui.sidebarOpen).toBe(false)
    await settings.update({})
    expect(state.settings.value.sidebar).toMatchObject({ open: false, tab: 'search' })
  })

  it('toggles the side pane and switches its tab', () => {
    ui.toggleSidePane()
    expect(settings.value.sidePane).toMatchObject({ open: true, tab: 'translation' })
    ui.toggleSidePane('tafsir')
    expect(settings.value.sidePane).toMatchObject({ open: true, tab: 'tafsir' })
    ui.toggleSidePane('tafsir')
    expect(ui.sidePaneOpen).toBe(false)
  })

  it('clamps and persists splitter widths, and resets them', async () => {
    ui.resizeSidebar(1000)
    expect(settings.value.sidebar.widthPx).toBe(420)
    ui.resizeSidebar(100.4)
    expect(settings.value.sidebar.widthPx).toBe(240)
    ui.resizeSidePane(512.6)
    expect(settings.value.sidePane.widthPx).toBe(513)
    ui.resetSidebarWidth()
    ui.resetSidePaneWidth()
    await settings.update({})
    expect(state.settings.value.sidebar.widthPx).toBe(300)
    expect(state.settings.value.sidePane.widthPx).toBe(400)
  })

  it('keeps a narrow window’s floating sidebar as session state and persists only its tab', async () => {
    resizeWindow(800, 600)
    expect(ui.sidebarOverlay).toBe(true)
    expect(ui.sidebarOpen).toBe(false)
    ui.toggleSidebar('bookmarks')
    expect(ui.sidebarOpen).toBe(true)
    await settings.update({})
    expect(state.settings.value.sidebar).toMatchObject({ open: true, tab: 'bookmarks' })
    ui.toggleSidebar('bookmarks')
    expect(ui.sidebarOpen).toBe(false)
    // Closing the floating sidebar does not close the docked one of a wide window.
    expect(settings.value.sidebar.open).toBe(true)
    resizeWindow(1600, 1000)
    expect(ui.sidebarOpen).toBe(true)
  })

  it('hides the sidebar in the Downloads manager; a tab, Mod+B or Mod+F there returns to the reader', () => {
    expect(ui.sidebarOpen).toBe(true)
    ui.setView('downloads')
    expect(ui.sidebarOpen).toBe(false)
    // The preference is kept for the reader.
    expect(settings.value.sidebar.open).toBe(true)
    ui.toggleSidebar('bookmarks')
    expect(ui.view).toBe('reader')
    expect(ui.sidebarOpen).toBe(true)
    expect(settings.value.sidebar.tab).toBe('bookmarks')

    ui.setView('downloads')
    ui.toggleSidebar()
    expect(ui.view).toBe('reader')
    expect(ui.sidebarOpen).toBe(true)
    expect(settings.value.sidebar.tab).toBe('bookmarks')

    ui.setView('downloads')
    ui.focusSearch()
    expect(ui.view).toBe('reader')
    expect(settings.value.sidebar.tab).toBe('search')
    // Elsewhere opening a tab leaves the view alone.
    ui.setView('settings')
    ui.openSidebar('index')
    expect(ui.view).toBe('settings')
  })

  it('collapses the sidebar so the side pane can dock, and restores it when the pane closes (§9.6)', () => {
    resizeWindow(1100, 800)
    expect(ui.windowSize).toEqual({ w: 1100, h: 800 })
    ui.openSidePane()
    expect(ui.sidebarAutoCollapsed).toBe(true)
    expect(ui.sidebarOpen).toBe(false)
    expect(ui.paneDocked).toBe(true)
    // The user insists on the sidebar: the pane cannot shrink enough, so it overlays.
    ui.openSidebar()
    expect(ui.sidebarOpen).toBe(true)
    expect(ui.paneDocked).toBe(false)
    ui.closeSidePane()
    expect(ui.sidebarOpen).toBe(true)
    ui.openSidePane()
    expect(ui.sidebarAutoCollapsed).toBe(true)
  })
})

describe('shellLayout (§9.6)', () => {
  const input = (over: Partial<ShellInput> = {}): ShellInput => ({
    windowW: 1536,
    windowH: 864,
    zen: false,
    sidebar: { open: true, widthPx: 300, tab: 'index' },
    sidePane: { ...defaultSettings().sidePane, open: true },
    sidebarForced: false,
    ...over,
  })

  it('docks the pane with the sidebar open at 1366×768, 1536×864 and 1920×1080 (S32)', () => {
    for (const [windowW, windowH] of [
      [1366, 768],
      [1536, 864],
      [1920, 1080],
    ] as const) {
      expect(shellLayout(input({ windowW, windowH })), `${windowW}×${windowH}`).toMatchObject({
        sidebarOpen: true,
        sidePaneOpen: true,
        paneDocked: true,
        paneWidthPx: 400,
        sidebarAutoCollapsed: false,
      })
    }
  })

  it('collapses the sidebar first, then shrinks the pane, then overlays it', () => {
    expect(shellLayout(input({ windowW: 1100, windowH: 800 }))).toMatchObject({
      sidebarOpen: false,
      sidebarAutoCollapsed: true,
      paneDocked: true,
      paneWidthPx: 400,
    })
    const noCollapse = { ...defaultSettings().sidePane, open: true, autoCollapseSidebar: false }
    // canvas 1252 − 52 − 300 = 900 px; a single page at this height needs 521.2 px, so the pane may take 378 px.
    expect(shellLayout(input({ windowW: 1252, windowH: 800, sidePane: noCollapse }))).toMatchObject({
      sidebarOpen: true,
      paneDocked: true,
      paneWidthPx: 378,
    })
    expect(shellLayout(input({ windowW: 1100, windowH: 800, sidebarForced: true }))).toMatchObject({
      sidebarOpen: true,
      paneDocked: false,
      paneWidthPx: 400,
    })
  })

  it('overlays the sidebar below 900 px and never collapses an overlay sidebar', () => {
    // A narrow window starts with the page uncovered: the overlay sidebar is session state, closed by default.
    expect(shellLayout(input({ windowW: 800, windowH: 600 }))).toMatchObject({
      sidebarOverlay: true,
      sidebarOpen: false,
      paneDocked: true,
    })
    expect(shellLayout(input({ windowW: 800, windowH: 600, overlaySidebarOpen: true }))).toMatchObject({
      sidebarOverlay: true,
      sidebarOpen: true,
      sidebarAutoCollapsed: false,
      paneDocked: true,
      paneWidthPx: 364,
    })
    expect(shellLayout(input({ windowW: 700, windowH: 600 }))).toMatchObject({ paneDocked: false })
  })

  it('limits the splitters so a docked pane stays dockable', () => {
    const at = (over: Partial<ShellInput>) => {
      const i = input(over)
      return paneLimits(i, shellLayout(i))
    }
    // No side pane: the settings ranges.
    expect(at({ sidePane: { ...defaultSettings().sidePane, open: false } })).toEqual({
      sidebarMin: 240,
      sidebarMax: 420,
      paneMin: 320,
      paneMax: 640,
    })
    // 1536×864 with both panes: a single page needs 22.75 qfs × 22.6 + 64 ≈ 578 px of canvas.
    const limits = at({})
    expect(limits.sidebarMin).toBe(240)
    expect(limits.sidebarMax).toBeGreaterThanOrEqual(300)
    expect(limits.sidebarMax).toBeLessThanOrEqual(420)
    expect(limits.paneMax).toBeGreaterThanOrEqual(400)
    expect(limits.paneMax).toBeLessThanOrEqual(640)
    const canvas = (sidebarW: number, paneW: number) => 1536 - RAIL_W - sidebarW - paneW
    // At the limits the pane still docks; one pixel more and it would not.
    expect(paneCanDock(canvas(limits.sidebarMax, 0), 864 - TITLEBAR_H, 400)).toBe(true)
    if (limits.sidebarMax < 420) {
      expect(paneCanDock(canvas(limits.sidebarMax + 1, 0), 864 - TITLEBAR_H, 400)).toBe(false)
    }
    expect(paneCanDock(canvas(300, 0), 864 - TITLEBAR_H, limits.paneMax)).toBe(true)
    // The current widths are always inside the limits, even where nothing wider would dock.
    const tight = at({ windowW: 1252, windowH: 800 })
    expect(tight.sidebarMax).toBeGreaterThanOrEqual(240)
  })

  it('hides the sidebar, docked or floating, while the Downloads manager shows (owner 2026-10-11)', () => {
    expect(shellLayout(input({ manager: true }))).toMatchObject({ sidebarOpen: false, sidePaneOpen: true })
    expect(
      shellLayout(input({ manager: true, windowW: 800, windowH: 600, overlaySidebarOpen: true })),
    ).toMatchObject({ sidebarOpen: false, sidebarOverlay: true })
  })

  it('hides both panes in zen and assumes docking before the window is measured', () => {
    expect(shellLayout(input({ zen: true }))).toMatchObject({ sidebarOpen: false, sidePaneOpen: false })
    expect(shellLayout(input({ windowW: 0, windowH: 0 }))).toMatchObject({
      paneDocked: true,
      sidebarOpen: true,
    })
  })
})

describe('ui store: toasts and announcements', () => {
  it('passes toasts to svelte-sonner with the §9.5 durations', () => {
    const run = vi.fn()
    const plain = ui.toast({ message: 'Copied' })
    ui.toast({ message: 'Bookmarked 2:255', action: { label: 'Undo', run }, durationMs: 3000 })
    ui.toast({ message: 'Saved', tone: 'success', durationMs: 2000 })
    ui.toast({ message: 'Failed', tone: 'danger' })
    expect(sonner.calls.map((c) => [c.type, c.message, c.data.duration])).toEqual([
      ['default', 'Copied', TOAST_MS],
      ['default', 'Bookmarked 2:255', TOAST_ACTION_MIN_MS],
      ['success', 'Saved', 2000],
      ['error', 'Failed', TOAST_MS],
    ])
    expect(sonner.calls[3]?.data.important).toBe(true)
    expect(ui.toasts.map((t) => t.id)).toEqual([plain, plain + 1, plain + 2, plain + 3])
    ;(sonner.calls[1]?.data.action as { onClick: () => void }).onClick()
    expect(run).toHaveBeenCalledTimes(1)
    sonner.calls[0]?.data.onAutoClose()
    expect(ui.toasts.some((t) => t.id === plain)).toBe(false)
    ui.dismissToast(plain + 1)
    expect(ui.toasts.some((t) => t.id === plain + 1)).toBe(false)
  })

  it('shows one undo toast at a time and runs the undo from its action', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const undo = vi.fn()
    const first = ui.toastUndo('Bookmarked 2:255', undo)
    const second = ui.toastUndo('Highlighted 2:255 yellow', () =>
      Promise.reject(new IpcError('io', 'denied')),
    )
    const sonnerModule = await import('svelte-sonner')
    expect(sonnerModule.toast.dismiss).toHaveBeenCalledWith(first)
    expect(ui.toasts.map((t) => t.id)).toEqual([second])
    const call = sonner.calls.at(-1)
    expect(call?.data.duration).toBe(TOAST_ACTION_MIN_MS)
    expect((call?.data.action as { label: string }).label).toBe(i18n.t('common.undo'))
    ;(call?.data.action as { onClick: () => void }).onClick()
    await vi.waitFor(() => expect(ui.toasts.at(-1)?.message).toBe(i18n.t('errors.io')))
    ;(sonner.calls[0]?.data.action as { onClick: () => void }).onClick()
    expect(undo).toHaveBeenCalledTimes(1)
  })

  it('keeps unsaved drafts across a reload of the store (localStorage mirror)', () => {
    ui.setDraft('note:new:262-262', 'A thought on 2:255')
    expect(ui.draft('note:new:262-262')).toBe('A thought on 2:255')
    ui.reset()
    expect(ui.draft('note:new:262-262')).toBe('A thought on 2:255')
    ui.setDraft('note:new:262-262', '')
    expect(ui.draft('note:new:262-262')).toBe('')
    ui.setDraft('a', 'x')
    ui.clearDraft('a')
    expect(localStorage.getItem('qd-drafts-v1')).toBeNull()
    localStorage.setItem('qd-drafts-v1', '{not json')
    ui.reset()
    expect(ui.draft('a')).toBe('')
  })

  it('keeps a bounded toast history', () => {
    for (let i = 0; i < 30; i++) ui.toast({ message: `t${i}` })
    expect(ui.toasts).toHaveLength(20)
    expect(ui.toasts.at(-1)?.message).toBe('t29')
  })

  it('shows failed commands as the localised error, never the raw message', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    ui.toastError(new IpcError('offline', 'dns lookup failed'))
    expect(ui.toasts.at(-1)).toMatchObject({ message: i18n.t('errors.offline'), tone: 'danger' })
    expect(JSON.stringify(ui.toasts)).not.toContain('dns lookup failed')
    ui.toastError('string rejection')
    expect(ui.toasts.at(-1)?.message).toBe(i18n.t('errors.internal'))
    const before = ui.toasts.length
    ui.toastError(new IpcError('cancelled', 'user'))
    expect(ui.toasts).toHaveLength(before)
    await settings.update({ uiLanguage: 'ar' })
    ui.toastError(new IpcError('offline', 'x'))
    expect(ui.toasts.at(-1)?.message).toBe(ar.errors.offline)
  })

  it('moves focus to the toasts when there are any', () => {
    expect(ui.focusToasts()).toBe(false)
    const region = document.createElement('section')
    region.setAttribute('data-sonner-toaster', '')
    region.tabIndex = -1
    const item = document.createElement('li')
    item.setAttribute('data-sonner-toast', '')
    item.tabIndex = 0
    region.append(item)
    document.body.append(region)
    expect(ui.focusToasts()).toBe(true)
    expect(document.activeElement).toBe(item)
  })

  it('announces, and re-announces the same text', () => {
    vi.useFakeTimers()
    ui.announce('Al-Baqarah 2:255, page 42')
    expect(ui.announcement).toBe('Al-Baqarah 2:255, page 42')
    ui.announce('Al-Baqarah 2:255, page 42')
    expect(ui.announcement).toBe('')
    vi.advanceTimersByTime(100)
    expect(ui.announcement).toBe('Al-Baqarah 2:255, page 42')
  })
})

describe('ui store: focus and navigation', () => {
  it('Mod+F target: opens the Search tab and focuses its input, closing a palette on top', async () => {
    ui.open('palette', {})
    const input = document.createElement('input')
    input.dataset.qdFocus = 'search'
    input.value = 'mercy'
    document.body.append(input)
    ui.focusSearch()
    expect(ui.isOpen('palette')).toBe(false)
    expect(settings.value.sidebar).toMatchObject({ open: true, tab: 'search' })
    await vi.waitFor(() => expect(document.activeElement).toBe(input))
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(5)
  })

  it('reports a focus target that never renders', async () => {
    await expect(ui.focusWhenRendered('[data-qd-focus="nothing"]')).resolves.toBe(false)
  })

  it('finds the reading cursor in either reading mode, else the first ayah item, else the canvas', async () => {
    const main = document.createElement('main')
    main.id = 'qd-main'
    main.tabIndex = -1
    document.body.append(main)
    expect(readingCursor()).toBe(main)

    // Translation mode: the feed's roving verse, which leaving the manager focuses too (`focusReader`).
    const feed = document.createElement('div')
    feed.dataset.qdView = 'translation'
    feed.innerHTML =
      '<article data-qd-ayah="1" tabindex="-1"></article><article data-qd-ayah="2" tabindex="0"></article>'
    main.append(feed)
    const verse = feed.querySelector('[tabindex="0"]')
    expect(readingCursor()).toBe(verse)
    await expect(ui.focusReader(null, 0)).resolves.toBe(true)
    expect(document.activeElement).toBe(verse)
    feed.remove()

    // The Mushaf: its roving ayah item, else the first one.
    const list = document.createElement('ol')
    list.className = 'mp-a11y'
    list.innerHTML = '<li tabindex="-1" data-ayah="1"></li><li tabindex="-1" data-ayah="2"></li>'
    main.append(list)
    expect(readingCursor()).toBe(list.firstElementChild)
    list.lastElementChild?.setAttribute('tabindex', '0')
    expect(readingCursor()).toBe(list.lastElementChild)
  })

  it('routes views itself and other targets to the newest handler, keeping unhandled ones', () => {
    ui.navigate({ type: 'view', data: { view: 'downloads' } })
    expect(ui.view).toBe('downloads')

    const ayah: NavTarget = { type: 'ayah', data: { ayahId: 262 } }
    ui.navigate(ayah)
    expect(ui.view).toBe('reader')
    const seen: NavTarget[] = []
    const declines = vi.fn(() => false)
    const stop = ui.onNavigate((t) => {
      seen.push(t)
      return true
    })
    expect(seen).toEqual([ayah])
    ui.onNavigate(declines)
    ui.navigate({ type: 'page', data: { page: 300 } })
    expect(declines).toHaveBeenCalledTimes(1)
    expect(seen.at(-1)).toEqual({ type: 'page', data: { page: 300 } })
    stop()
    ui.navigate({ type: 'surah', data: { surah: 18 } })
    const late = vi.fn(() => true)
    ui.onNavigate(late)
    expect(late).toHaveBeenCalledWith({ type: 'surah', data: { surah: 18 } })
  })

  it('opens the Search tab for search targets and follows NavigateRequested', async () => {
    ui.closeSidebar()
    await events.navigateRequested.emit({ type: 'search', data: { query: 'الرحمن' } })
    expect(settings.value.sidebar).toMatchObject({ open: true, tab: 'search' })
    await events.navigateRequested.emit({ type: 'view', data: { view: 'about' } })
    expect(ui.view).toBe('about')
  })
})

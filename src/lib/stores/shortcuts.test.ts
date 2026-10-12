import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShortcutDef } from '$lib/contracts/shortcuts'
import { defaultSettings } from '$lib/contracts/settings'
import { api, call, events, initIpc } from '$lib/ipc'
import type { Bootstrap, Platform, Settings } from '$lib/ipc/bindings'
import { state } from '$lib/ipc/mock/state'
import { appShortcuts } from '$lib/shortcuts/app'
import { app } from './app.svelte'
import { i18n } from './i18n.svelte'
import { settings } from './settings.svelte'
import { shortcuts } from './shortcuts.svelte'
import { ui } from './ui.svelte'

type KeyInit = KeyboardEventInit & { altGraph?: boolean }

let bootstrap: Bootstrap

async function boot(stored?: Partial<Settings>, platform: Platform = 'windows'): Promise<void> {
  localStorage.clear()
  await initIpc()
  state.resetAll()
  state.loadAll()
  if (stored) state.settings.set({ ...defaultSettings(), ...stored })
  const b = await call(api.appBootstrap())
  bootstrap = { ...b, app: { ...b.app, platform } }
  for (const store of [app, settings, i18n, ui, shortcuts]) store.init(bootstrap)
}

/** Dispatches a keydown on `target` (default: body) the way a browser does: capture → target → bubble. */
function press({ altGraph, ...init }: KeyInit, target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init,
    ...(altGraph ? { modifierAltGraph: true } : {}),
  } as KeyboardEventInit)
  target.dispatchEvent(e)
  return e
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  parent: Element = document.body,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
  parent.append(node)
  return node
}

/** A definition owned by another package, for the §7.7 test vectors. */
function def(over: Partial<ShortcutDef> & Pick<ShortcutDef, 'id' | 'keys'>): ShortcutDef {
  return { group: 'study', labelKey: 'shortcuts.study.bookmark', scope: 'global', run: vi.fn(), ...over }
}

const K = {
  ctrlK: { key: 'k', code: 'KeyK', ctrlKey: true },
  space: { key: ' ', code: 'Space' },
  escape: { key: 'Escape', code: 'Escape' },
  question: { key: '?', code: 'Slash', shiftKey: true },
} satisfies Record<string, KeyInit>

beforeEach(async () => {
  await boot()
})

afterEach(() => {
  for (const store of [shortcuts, ui, i18n, settings, app]) store.reset()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('registry', () => {
  it('registers the app shortcuts on init, every group present in sheet order', () => {
    expect(shortcuts.defs).toEqual(appShortcuts)
    expect(Object.keys(shortcuts.byGroup)).toEqual([
      'navigation',
      'view',
      'audio',
      'study',
      'memorize',
      'app',
    ])
    expect(shortcuts.byGroup.app.map((d) => d.id)).toContain('app.palette')
    expect(shortcuts.byGroup.view.map((d) => d.id)).toContain('view.sidebarTab.memorize')
  })

  it('registers each definition once and unregisters exactly what it added', () => {
    const a = def({ id: 'test.a', keys: ['x'] })
    const off = shortcuts.register([a, a])
    const offAgain = shortcuts.register([a])
    expect(shortcuts.defs.filter((d) => d === a)).toHaveLength(1)
    offAgain()
    expect(shortcuts.defs).toContain(a)
    off()
    expect(shortcuts.defs).not.toContain(a)
  })

  it('reports invalid chords and duplicate ids in development, and never matches them', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = def({ id: 'test.broken', keys: ['Mod+Foo', 'K'] })
    shortcuts.register([broken, def({ id: 'app.palette', keys: ['x'] })])
    expect(error).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('app.palette'))
    press({ key: 'K', code: 'KeyK', shiftKey: true })
    expect(broken.run).not.toHaveBeenCalled()
  })

  it('stops listening on reset', () => {
    shortcuts.reset()
    press(K.ctrlK)
    expect(ui.isOpen('palette')).toBe(false)
  })
})

describe('§7.7 test vectors', () => {
  it('Arabic layout: ن on KeyK is k (previous ayah)', () => {
    const prevAyah = def({ id: 'nav.prevAyah', keys: ['ArrowUp', 'k'], scope: 'reader' })
    shortcuts.register([prevAyah])
    press({ key: 'ن', code: 'KeyK' })
    expect(prevAyah.run).toHaveBeenCalledTimes(1)
  })

  it('AZERTY: ? typed as Shift+, opens the sheet; the key labelled Q peeks; m is not ?', () => {
    const peek = def({ id: 'memo.peek', keys: ['q'], scope: 'reader' })
    const mute = def({ id: 'audio.mute', keys: ['m'] })
    shortcuts.register([peek, mute])
    press({ key: '?', code: 'KeyM', shiftKey: true })
    expect(ui.topOverlay?.kind).toBe('shortcuts')
    expect(mute.run).not.toHaveBeenCalled()
    ui.close()
    press({ key: 'q', code: 'KeyA' })
    expect(peek.run).toHaveBeenCalledTimes(1)
  })

  it('macOS: Mod is ⌘', async () => {
    shortcuts.reset()
    await boot(undefined, 'macos')
    press(K.ctrlK)
    expect(ui.isOpen('palette')).toBe(false)
    press({ key: 'k', code: 'KeyK', metaKey: true })
    expect(ui.isOpen('palette')).toBe(true)
  })

  it('Space on a focused button is left to the button (no audio toggle)', () => {
    const toggle = def({ id: 'audio.playPause', keys: ['Space'] })
    shortcuts.register([toggle])
    const button = el('button')
    button.focus()
    const e = press(K.space, button)
    expect(toggle.run).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
    press(K.space)
    expect(toggle.run).toHaveBeenCalledTimes(1)
  })

  it('ArrowRight in the speed slider moves the slider, not the page', () => {
    const prevPage = def({
      id: 'nav.prevPage',
      keys: ['ArrowRight', 'PageUp'],
      scope: 'mushaf',
      repeat: true,
    })
    shortcuts.register([prevPage])
    const slider = el('div', { role: 'slider', tabindex: '0', 'aria-valuenow': '100' })
    const onKey = vi.fn((e: KeyboardEvent) => e.preventDefault())
    slider.addEventListener('keydown', onKey)
    press({ key: 'ArrowRight', code: 'ArrowRight' }, slider)
    expect(onKey).toHaveBeenCalled()
    expect(prevPage.run).not.toHaveBeenCalled()
    // Even a widget that does not call preventDefault keeps its keys (widget guard).
    slider.removeEventListener('keydown', onKey)
    press({ key: 'ArrowRight', code: 'ArrowRight' }, slider)
    expect(prevPage.run).not.toHaveBeenCalled()
    press({ key: 'ArrowRight', code: 'ArrowRight' })
    expect(prevPage.run).toHaveBeenCalledTimes(1)
  })

  it('typing b in the open context menu does not toggle a bookmark', () => {
    const bookmark = def({ id: 'study.bookmark', keys: ['b'], scope: 'reader' })
    shortcuts.register([bookmark])
    ui.openContextMenu({ x: 0, y: 0, ayahId: 262 })
    const menu = el('div', { role: 'menu', tabindex: '-1' })
    press({ key: 'b', code: 'KeyB' }, menu)
    expect(bookmark.run).not.toHaveBeenCalled()
    ui.closeContextMenu()
    // On the Mushaf's roving ayah item the same key bookmarks.
    const list = el('ul', { class: 'mp-a11y', role: 'listbox' })
    const item = el('li', { role: 'option', tabindex: '0' }, list)
    press({ key: 'b', code: 'KeyB' }, item)
    expect(bookmark.run).toHaveBeenCalledTimes(1)
    press({ key: 'b', code: 'KeyB' }, el('main', { class: 'canvas' }))
    expect(bookmark.run).toHaveBeenCalledTimes(2)
  })
})

describe('rules', () => {
  it('rule 1: with a layer open only allowInInput definitions run', () => {
    ui.open('goto', {})
    press(K.question)
    expect(ui.topOverlay?.kind).toBe('goto')
    press(K.ctrlK)
    expect(ui.topOverlay?.kind).toBe('palette')
  })

  it('rule 2: while typing only allowInInput definitions run, in the capture phase', () => {
    const input = el('input', { type: 'search' })
    // A widget that stops propagation cannot block a capture definition.
    input.addEventListener('keydown', (e) => e.stopPropagation())
    press(K.question, input)
    expect(ui.overlays).toEqual([])
    press({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true }, input)
    expect(ui.view).toBe('reader')
    press(K.ctrlK, input)
    expect(ui.isOpen('palette')).toBe(true)
    press(K.ctrlK, input)
    expect(ui.isOpen('palette')).toBe(false)
  })

  it('rule 4: scopes follow the view and the reading mode', async () => {
    const mushafOnly = def({ id: 'view.pageMode', keys: ['d'], scope: 'mushaf' })
    const translationOnly = def({ id: 'test.translation', keys: ['d'], scope: 'translation' })
    shortcuts.register([mushafOnly, translationOnly])
    press({ key: 'd', code: 'KeyD' })
    expect(mushafOnly.run).toHaveBeenCalledTimes(1)
    await settings.update({ readingMode: 'translation' })
    press({ key: 'd', code: 'KeyD' })
    expect(translationOnly.run).toHaveBeenCalledTimes(1)
    ui.setView('settings')
    press({ key: 'd', code: 'KeyD' })
    press({ key: 'i', code: 'KeyI', ctrlKey: true })
    expect(mushafOnly.run).toHaveBeenCalledTimes(1)
    expect(translationOnly.run).toHaveBeenCalledTimes(1)
    expect(settings.value.sidePane.open).toBe(false)
  })

  it('rule 5: when() gates, and a throwing when() counts as false', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let enabled = false
    const gated = def({ id: 'test.gated', keys: ['g'], when: () => enabled })
    const broken = def({
      id: 'test.broken',
      keys: ['h'],
      when: () => {
        throw new Error('bug')
      },
    })
    shortcuts.register([gated, broken])
    const e = press({ key: 'g', code: 'KeyG' })
    expect(gated.run).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
    enabled = true
    expect(press({ key: 'g', code: 'KeyG' }).defaultPrevented).toBe(true)
    expect(gated.run).toHaveBeenCalledTimes(1)
    press({ key: 'h', code: 'KeyH' })
    expect(broken.run).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('test.broken'), expect.any(Error))
  })

  it('rule 6: auto-repeat runs only repeat definitions, but the held key stays consumed', () => {
    const toggle = def({ id: 'audio.playPause', keys: ['Space'] })
    const next = def({ id: 'nav.nextPage', keys: ['ArrowLeft'], scope: 'mushaf', repeat: true })
    shortcuts.register([toggle, next])
    const held = press({ ...K.space, repeat: true })
    expect(toggle.run).not.toHaveBeenCalled()
    expect(held.defaultPrevented).toBe(true)
    press({ key: 'ArrowLeft', code: 'ArrowLeft', repeat: true })
    press({ key: 'ArrowLeft', code: 'ArrowLeft', repeat: true })
    expect(next.run).toHaveBeenCalledTimes(2)
  })

  it('rule 7: run(e) receives the event; a throwing or rejecting run is logged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = vi.fn()
    const sync = def({
      id: 'test.throws',
      keys: ['t'],
      run: () => {
        throw new Error('sync')
      },
    })
    // An async run (TS accepts it where `void` is expected): its rejection is logged, not left unhandled.
    const rejecting = def({ id: 'test.rejects', keys: ['u'], run: () => Promise.reject(new Error('async')) })
    shortcuts.register([def({ id: 'test.ok', keys: ['o'], run }), sync, rejecting])
    const e = press({ key: 'o', code: 'KeyO' })
    expect(run).toHaveBeenCalledWith(e)
    expect(press({ key: 't', code: 'KeyT' }).defaultPrevented).toBe(true)
    press({ key: 'u', code: 'KeyU' })
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2))
  })

  it('ignores IME composition and keys already handled by a widget', () => {
    const run = vi.fn()
    shortcuts.register([def({ id: 'test.k', keys: ['k'], run })])
    press({ key: 'k', code: 'KeyK', isComposing: true })
    press({ key: 'Process', code: 'KeyK', keyCode: 229 })
    const widget = el('div')
    widget.addEventListener('keydown', (e) => e.preventDefault())
    press({ key: 'k', code: 'KeyK' }, widget)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('context-menu keys', () => {
  it('Shift+F10 and the Menu key open the focused element’s context menu on macOS, as browsers do on Windows', async () => {
    const row = el('button')
    const menus: MouseEvent[] = []
    row.addEventListener('contextmenu', (e) => menus.push(e))
    expect(press({ key: 'F10', code: 'F10', shiftKey: true }, row).defaultPrevented).toBe(false)
    expect(menus).toEqual([]) // Windows: the browser fires it itself
    for (const store of [shortcuts, ui, i18n, settings, app]) store.reset()
    await boot(undefined, 'macos')
    const e = press({ key: 'F10', code: 'F10', shiftKey: true }, row)
    press({ key: 'ContextMenu', code: 'ContextMenu' }, row)
    press({ key: 'F10', code: 'F10' }, row)
    press({ key: 'F10', code: 'F10', shiftKey: true, metaKey: true }, row)
    expect(menus).toHaveLength(2)
    expect(e.defaultPrevented).toBe(true)
    // No pointer button: the widgets place a keyboard menu themselves.
    expect(menus.map((m) => m.button)).toEqual([0, 0])
  })

  it('opens it on Linux too, where WebKitGTK fires one only for keys that pass through GTK; text fields keep theirs', async () => {
    for (const store of [shortcuts, ui, i18n, settings, app]) store.reset()
    await boot(undefined, 'linux')
    const row = el('button')
    const field = el('input', { type: 'text' })
    const menus: EventTarget[] = []
    for (const node of [row, field]) node.addEventListener('contextmenu', () => menus.push(node))
    // Handled, so neither WebKitGTK's key binding nor Chromium follows with a second one.
    expect(press({ key: 'F10', code: 'F10', shiftKey: true }, row).defaultPrevented).toBe(true)
    press({ key: 'ContextMenu', code: 'ContextMenu' }, row)
    expect(press({ key: 'F10', code: 'F10', shiftKey: true }, field).defaultPrevented).toBe(false)
    press({ key: 'ContextMenu', code: 'ContextMenu' }, field)
    expect(menus).toEqual([row, row])
  })
})

describe('precedence', () => {
  it('prefers the more specific scope, then the most recent registration', () => {
    const global = def({ id: 'test.global', keys: ['x'] })
    const reader = def({ id: 'test.reader', keys: ['x'], scope: 'reader' })
    const newer = def({ id: 'test.reader2', keys: ['x'], scope: 'reader' })
    shortcuts.register([reader, global])
    press({ key: 'x', code: 'KeyX' })
    expect(reader.run).toHaveBeenCalledTimes(1)
    expect(global.run).not.toHaveBeenCalled()
    shortcuts.register([newer])
    press({ key: 'x', code: 'KeyX' })
    expect(newer.run).toHaveBeenCalledTimes(1)
    ui.setView('downloads')
    press({ key: 'x', code: 'KeyX' })
    expect(global.run).toHaveBeenCalledTimes(1)
  })

  it('prefers an exact chord over punctuation matched by character (German Ctrl+Shift+0 types =)', async () => {
    const zoomIn = def({ id: 'view.zoomIn', keys: ['Mod+='], scope: 'mushaf' })
    shortcuts.register([zoomIn])
    await settings.update({ uiScalePct: 150 })
    press({ key: '=', code: 'Digit0', ctrlKey: true, shiftKey: true })
    expect(zoomIn.run).not.toHaveBeenCalled()
    expect(settings.value.uiScalePct).toBe(100)
    press({ key: '=', code: 'Equal', ctrlKey: true })
    expect(zoomIn.run).toHaveBeenCalledTimes(1)
  })
})

describe('Escape (§10.1)', () => {
  it('lets an open layer close itself first (bits-ui calls preventDefault)', () => {
    ui.open('note-editor', { fromAyahId: 262, toAyahId: 262 })
    const layer = vi.fn((e: KeyboardEvent) => e.preventDefault())
    document.addEventListener('keydown', layer)
    press(K.escape)
    document.removeEventListener('keydown', layer)
    expect(layer).toHaveBeenCalled()
    expect(ui.isOpen('note-editor')).toBe(true)
  })

  it('closes the top overlay when the layer did not handle it, also from an input', () => {
    ui.open('goto', {})
    ui.open('palette', {})
    press(K.escape, el('input'))
    expect(ui.overlays.map((o) => o.kind)).toEqual(['goto'])
    press(K.escape)
    expect(ui.overlays).toEqual([])
  })

  it('closes the context menu, then returns to the reader, then leaves zen', () => {
    ui.setZen(true)
    ui.setView('settings')
    ui.openContextMenu({ x: 0, y: 0, ayahId: 1 })
    press(K.escape)
    expect(ui.contextMenu).toBeNull()
    expect(ui.view).toBe('settings')
    press(K.escape)
    expect(ui.view).toBe('reader')
    expect(ui.zen).toBe(true)
    press(K.escape)
    expect(ui.zen).toBe(false)
    expect(press(K.escape).defaultPrevented).toBe(false)
  })

  it('hides a sidebar floating over a narrow window before leaving a view or zen', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    window.dispatchEvent(new Event('resize'))
    try {
      // The Downloads manager hides the sidebar: a tab there returns to the reader, floating sidebar shown.
      ui.setView('downloads')
      ui.openSidebar('index')
      expect(ui.view).toBe('reader')
      expect(ui.sidebarOverlay && ui.sidebarOpen).toBe(true)
      ui.setZen(true)
      ui.openSidebar('index')
      expect(ui.zen).toBe(false)
      ui.setView('about')
      expect(ui.sidebarOpen).toBe(true)
      press(K.escape)
      expect(ui.sidebarOpen).toBe(false)
      expect(ui.view).toBe('about')
      press(K.escape)
      expect(ui.view).toBe('reader')
    } finally {
      if (original) Object.defineProperty(window, 'innerWidth', original)
      else Reflect.deleteProperty(window, 'innerWidth')
    }
  })

  it('gives a reader-scoped Escape (clear the selection) precedence while it applies', () => {
    let selection = true
    const clear = def({
      id: 'nav.clearSelection',
      keys: ['Escape'],
      scope: 'reader',
      capture: true,
      when: () => selection,
      run: vi.fn(() => (selection = false)),
    })
    shortcuts.register([clear])
    ui.setZen(true)
    press(K.escape)
    expect(clear.run).toHaveBeenCalledTimes(1)
    expect(ui.zen).toBe(true)
    press(K.escape)
    expect(ui.zen).toBe(false)
    // With a layer open the reader definition never runs (rule 1): the layer closes first.
    selection = true
    ui.open('shortcuts', {})
    press(K.escape)
    expect(ui.overlays).toEqual([])
    expect(clear.run).toHaveBeenCalledTimes(1)
  })
})

describe('the Settings dialog (§7.4)', () => {
  /** The dialog as its host leaves it: the view, and the registered layer. */
  function openSettings(view: 'settings' | 'about' = 'settings'): void {
    ui.setView(view)
    ui.setSettingsOpen(true)
  }

  it('runs only its allow-list (and the audio group); the rest is consumed and does nothing', () => {
    const toggle = def({ id: 'audio.toggle', keys: ['Space'], group: 'audio' })
    const goTo = def({ id: 'nav.goTo', keys: ['Mod+g'], group: 'navigation', capture: true })
    shortcuts.register([toggle, goTo])
    openSettings()
    const sidebar = { ...settings.value.sidebar }
    expect(press({ key: 'b', code: 'KeyB', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(press({ key: '2', code: 'Digit2', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(press({ key: 'i', code: 'KeyI', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(settings.value.sidebar).toEqual(sidebar)
    expect(ui.sidePaneOpen).toBe(false)
    expect(press({ key: 'g', code: 'KeyG', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(goTo.run).not.toHaveBeenCalled()
    const toast = el('li', { 'data-sonner-toast': '', tabindex: '0' })
    press({ key: 'F6', code: 'F6' })
    expect(document.activeElement).not.toBe(toast)
    press(K.question)
    expect(ui.overlays).toEqual([])
    // The allowed ones: audio, theme, UI scale, the palette, Downloads.
    press(K.space)
    expect(toggle.run).toHaveBeenCalledTimes(1)
    press({ key: 'L', code: 'KeyL', ctrlKey: true, shiftKey: true })
    expect(settings.value.theme).toBe('sepia')
    press({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true })
    expect(settings.value.uiScalePct).toBe(110)
    press(K.ctrlK)
    expect(ui.topOverlay?.kind).toBe('palette')
    ui.close()
    press({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true })
    expect(ui.view).toBe('downloads')
    // Closed again, everything runs as before.
    ui.setSettingsOpen(false)
    ui.setView('reader')
    press({ key: 'b', code: 'KeyB', ctrlKey: true })
    expect(ui.sidebarOpen).toBe(!sidebar.open)
  })

  it('Mod+F focuses "Search settings" while it is open, from its field too', () => {
    const field = el('input', { type: 'search', 'data-settings-search': '' })
    openSettings()
    press({ key: 'f', code: 'KeyF', ctrlKey: true }, field)
    expect(settings.value.sidebar.tab).toBe('index')
    return vi.waitFor(() => expect(document.activeElement).toBe(field))
  })

  it('Mod+F turns About back to Settings for its search, and closes a palette over the dialog first', async () => {
    openSettings('about')
    press({ key: 'f', code: 'KeyF', ctrlKey: true })
    expect(ui.view).toBe('settings')
    expect(ui.settingsOpen).toBe(true)
    expect(settings.value.sidebar.tab).toBe('index')
    const field = el('input', { type: 'search', 'data-settings-search': '' })
    await vi.waitFor(() => expect(document.activeElement).toBe(field))

    field.blur()
    ui.open('palette', {})
    press({ key: 'f', code: 'KeyF', ctrlKey: true }, el('input'))
    expect(ui.overlays).toEqual([])
    expect(ui.view).toBe('settings')
    await vi.waitFor(() => expect(document.activeElement).toBe(field))
  })

  it('the theme and UI scale keys also run from a field and over a layer (they type nothing)', () => {
    const input = el('input')
    press({ key: 'L', code: 'KeyL', ctrlKey: true, shiftKey: true }, input)
    expect(settings.value.theme).toBe('sepia')
    ui.open('goto', {})
    press({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }, input)
    expect(settings.value.uiScalePct).toBe(110)
    press({ key: ')', code: 'Digit0', ctrlKey: true, shiftKey: true }, input)
    expect(settings.value.uiScalePct).toBe(100)
  })

  it('Mod+, toggles it, from its search field too, and closes About', () => {
    const comma = { key: ',', code: 'Comma', ctrlKey: true }
    press(comma)
    expect(ui.view).toBe('settings')
    ui.setSettingsOpen(true)
    press(comma, el('input', { type: 'search', 'data-settings-search': '' }))
    expect(ui.view).toBe('reader')
    openSettings('about')
    press(comma)
    expect(ui.view).toBe('reader')
  })

  it('Mod+, never acts over another layer, except the palette alone, which it closes first', () => {
    const comma = { key: ',', code: 'Comma', ctrlKey: true }
    for (const open of [
      () => void ui.confirm({ title: 'Delete note?', body: '', confirmLabel: 'Delete' }),
      () => ui.open('note-editor', { fromAyahId: 1, toAyahId: 1 }),
      () => ui.open('onboarding', {}),
      () => ui.pushFloating(),
      () => ui.openContextMenu({ x: 0, y: 0, ayahId: 1 }),
      // The palette over a popover, then over a sheet (its own dialog is one floating and one modal layer, and each of
      // those adds its own): closing it would still leave a layer up, so neither the key nor its "Settings" row acts.
      () => {
        ui.pushFloating()
        ui.open('palette', {})
        ui.pushFloating()
      },
      () => {
        ui.pushFloating()
        ui.pushModal()
        ui.open('palette', {})
        ui.pushFloating()
        ui.pushModal()
      },
    ]) {
      open()
      expect(press(comma).defaultPrevented).toBe(false)
      expect(ui.view).toBe('reader')
      ui.reset()
      ui.init(bootstrap)
    }
    ui.open('palette', {})
    // Its own dialog registers one floating and one modal layer.
    ui.pushFloating()
    ui.pushModal()
    press(comma, el('input'))
    expect(ui.overlays).toEqual([])
    expect(ui.view).toBe('settings')
    // Over the open dialog the palette leaves both alone.
    ui.setSettingsOpen(true)
    ui.open('palette', {})
    expect(press(comma).defaultPrevented).toBe(false)
    expect(ui.topOverlay?.kind).toBe('palette')
    expect(ui.view).toBe('settings')
  })

  it('the macOS app menu’s "Settings…" opens it where Mod+, would act, and never closes it', async () => {
    const fromMenu = async () => {
      await events.settingsRequested.emit()
      await Promise.resolve()
    }
    await Promise.resolve() // the store's listener is attached
    await fromMenu()
    expect(ui.view).toBe('settings')
    // A menu command, not a toggle: the dialog stays, and About turns to Settings.
    openSettings()
    await fromMenu()
    expect(ui.view).toBe('settings')
    openSettings('about')
    await fromMenu()
    expect(ui.view).toBe('settings')
    // Over another layer it declines, as Mod+, does (WKWebView hands ⌘, to the menu exactly then).
    ui.setSettingsOpen(false)
    ui.setView('reader')
    for (const open of [
      () => void ui.confirm({ title: 'Delete note?', body: '', confirmLabel: 'Delete' }),
      () => ui.open('onboarding', {}),
      () => ui.pushFloating(),
    ]) {
      open()
      await fromMenu()
      expect(ui.view).toBe('reader')
      ui.reset()
      ui.init(bootstrap)
    }
    // The palette alone closes first.
    ui.open('palette', {})
    ui.pushFloating()
    ui.pushModal()
    await fromMenu()
    expect(ui.overlays).toEqual([])
    expect(ui.view).toBe('settings')
  })
})

describe('zen (§9.6)', () => {
  it('shows the zen dock for a moment when an audio key runs', () => {
    const toggle = def({ id: 'audio.toggle', keys: ['Space'], group: 'audio' })
    const bookmark = def({ id: 'study.bookmark', keys: ['b'] })
    shortcuts.register([toggle, bookmark])
    ui.setZen(true)
    press({ key: 'b', code: 'KeyB' })
    expect(ui.zenDock).toBe(false)
    press(K.space)
    expect(toggle.run).toHaveBeenCalledTimes(1)
    expect(ui.zenDock).toBe(true)
  })
})

describe('app shortcuts (app.ts)', () => {
  it('opens the palette, sheet, settings and downloads', () => {
    press(K.ctrlK)
    expect(ui.topOverlay?.kind).toBe('palette')
    press(K.ctrlK)
    press(K.question)
    expect(ui.topOverlay?.kind).toBe('shortcuts')
    ui.close()
    press({ key: ',', code: 'Comma', ctrlKey: true })
    expect(ui.view).toBe('settings')
    press({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true })
    expect(ui.view).toBe('downloads')
  })

  it('Mod+F opens the Search tab even from an input', () => {
    const input = el('input')
    press({ key: 'f', code: 'KeyF', ctrlKey: true }, input)
    expect(settings.value.sidebar).toMatchObject({ open: true, tab: 'search' })
  })

  it('toggles the sidebar, its tabs and the side pane', () => {
    press({ key: '2', code: 'Digit2', ctrlKey: true })
    expect(settings.value.sidebar).toMatchObject({ open: true, tab: 'search' })
    press({ key: '7', code: 'Digit7', ctrlKey: true })
    expect(settings.value.sidebar.tab).toBe('memorize')
    press({ key: '7', code: 'Digit7', ctrlKey: true })
    expect(ui.sidebarOpen).toBe(false)
    press({ key: 'b', code: 'KeyB', ctrlKey: true })
    expect(ui.sidebarOpen).toBe(true)
    press({ key: 'i', code: 'KeyI', ctrlKey: true })
    expect(ui.sidePaneOpen).toBe(true)
  })

  it('leaves the Downloads manager for the reader with Mod+1…7, Mod+B and Mod+F (it hides the sidebar)', () => {
    ui.setView('downloads')
    expect(ui.sidebarOpen).toBe(false)
    press({ key: '3', code: 'Digit3', ctrlKey: true })
    expect(ui.view).toBe('reader')
    expect(settings.value.sidebar).toMatchObject({ open: true, tab: 'bookmarks' })
    ui.setView('downloads')
    press({ key: 'b', code: 'KeyB', ctrlKey: true })
    expect(ui.view).toBe('reader')
    expect(ui.sidebarOpen).toBe(true)
    ui.setView('downloads')
    press({ key: 'f', code: 'KeyF', ctrlKey: true }, el('input'))
    expect(ui.view).toBe('reader')
    expect(settings.value.sidebar.tab).toBe('search')
  })

  it('tells whether an event presses a registered shortcut (a layer that runs its action itself)', () => {
    const e = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)
    expect(
      shortcuts.matches('app.downloads', e({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true })),
    ).toBe(true)
    expect(shortcuts.matches('app.downloads', e({ key: 'd', code: 'KeyD', ctrlKey: true }))).toBe(false)
    expect(
      shortcuts.matches('app.downloads', e({ key: 'Control', code: 'ControlLeft', ctrlKey: true })),
    ).toBe(false)
    expect(
      shortcuts.matches('app.nothing', e({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true })),
    ).toBe(false)
  })

  it('steps the UI scale (held keys repeat) and resets it', () => {
    press({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true })
    press({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true, repeat: true })
    expect(settings.value.uiScalePct).toBe(120)
    for (let i = 0; i < 20; i++)
      press({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true, repeat: true })
    expect(settings.value.uiScalePct).toBe(200)
    press({ key: '_', code: 'Minus', ctrlKey: true, shiftKey: true })
    expect(settings.value.uiScalePct).toBe(190)
    press({ key: ')', code: 'Digit0', ctrlKey: true, shiftKey: true })
    expect(settings.value.uiScalePct).toBe(100)
  })

  it('cycles the theme from what is shown', () => {
    const cycle = () => press({ key: 'L', code: 'KeyL', ctrlKey: true, shiftKey: true })
    expect(settings.resolvedTheme).toBe('paper')
    cycle()
    expect(settings.value.theme).toBe('sepia')
    cycle()
    cycle()
    expect(settings.value.theme).toBe('black')
    cycle()
    expect(settings.value.theme).toBe('paper')
  })

  it('toggles full screen with F11 and focuses toasts with F6', async () => {
    press({ key: 'F11', code: 'F11' })
    await vi.waitFor(() => expect(ui.fullscreen).toBe(true))
    const toast = el('li', { 'data-sonner-toast': '', tabindex: '0' })
    press({ key: 'F6', code: 'F6' }, el('button'))
    expect(document.activeElement).toBe(toast)
  })
})

describe('labels', () => {
  it('formats chords for the platform, with every alternative', () => {
    const byId = (id: string) => appShortcuts.find((d) => d.id === id) as ShortcutDef
    expect(shortcuts.format(byId('app.palette'))).toBe('Ctrl+K')
    expect(shortcuts.formatAll(byId('app.focusToasts'))).toEqual(['F6', 'Ctrl+Shift+U'])
    expect(shortcuts.format(byId('view.fullscreen'))).toBe('F11')
    expect(shortcuts.format(byId('app.escape'))).toBe('Esc')
    expect(shortcuts.format(def({ id: 'x', keys: ['Mod+Ctrl+f'] }))).toBe('')
    expect(shortcuts.isAvailable(def({ id: 'x', keys: ['Mod+Ctrl+f'] }))).toBe(false)
  })

  it('formats macOS chords with symbols', async () => {
    shortcuts.reset()
    await boot(undefined, 'macos')
    const byId = (id: string) => shortcuts.defs.find((d) => d.id === id) as ShortcutDef
    expect(shortcuts.format(byId('app.downloads'))).toBe('⇧⌘D')
    expect(shortcuts.format(byId('view.fullscreen'))).toBe('⌃⌘F')
  })

  it('localises spelled-out keys and reads the keyboard layout map', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      keyboard: { getLayoutMap: () => Promise.resolve(new Map([['Equal', '´']])) },
    })
    await shortcuts.refreshLayoutMap()
    expect(shortcuts.layoutMap?.get('Equal')).toBe('´')
    const scaleUp = appShortcuts.find((d) => d.id === 'view.uiScaleUp') as ShortcutDef
    expect(shortcuts.format(scaleUp)).toBe('Ctrl+Shift+´')
    await settings.update({ uiLanguage: 'ar' })
    expect(shortcuts.format(def({ id: 'x', keys: ['Space'] }))).toBe(i18n.t('shortcuts.keys.space'))
  })

  it('takes an empty layout map (Chromium on Linux with no layout to read) for none', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      keyboard: { getLayoutMap: () => Promise.resolve(new Map([['Equal', '´']])) },
    })
    await shortcuts.refreshLayoutMap()
    expect(shortcuts.layoutMap?.size).toBe(1)
    vi.stubGlobal('navigator', { ...navigator, keyboard: { getLayoutMap: () => Promise.resolve(new Map()) } })
    await shortcuts.refreshLayoutMap()
    expect(shortcuts.layoutMap).toBeNull()
    const scaleUp = appShortcuts.find((d) => d.id === 'view.uiScaleUp') as ShortcutDef
    expect(shortcuts.format(scaleUp)).toBe('Ctrl+Shift+=')
  })
})

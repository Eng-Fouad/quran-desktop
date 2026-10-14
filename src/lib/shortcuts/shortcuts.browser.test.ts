/**
 * The shortcut runtime in a real browser with the real shell mounted: the two window listeners, the widget guard
 * against real focus and real key events (Space on a button, arrows in a slider, typeahead in an open menu, typing in
 * a field), the hybrid matching on non-Latin and AZERTY layouts, the Escape hand-off to open layers, the Mushaf
 * roving items, and labels from the browser's keyboard layout map.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import { bootApp, resetApp, settle } from '$components/shell/testing/boot'
import { ContextMenu, Slider } from '$components/ui'
import type { ShortcutDef, ShortcutGroup, ShortcutScope } from '$lib/contracts/shortcuts'
import { app, reader, settings, shortcuts, ui } from '$lib/stores'

/** `Mod`: ⌘ when the browser runs on macOS (the mock reports the browser's platform), Ctrl elsewhere. */
const mod = () => (app.isMac ? 'Meta' : 'Control')

/** Registers a spy definition (another package's shortcut stand-in) and returns its `run` mock. */
function spy(
  keys: string[],
  options: { group?: ShortcutGroup; scope?: ShortcutScope; id?: string } = {},
): ReturnType<typeof vi.fn<(e: KeyboardEvent) => void>> {
  const run = vi.fn<(e: KeyboardEvent) => void>()
  const def: ShortcutDef = {
    id: options.id ?? `test.${keys.join('|')}`,
    keys,
    group: options.group ?? 'study',
    labelKey: 'shortcuts.study.bookmark',
    scope: options.scope ?? 'global',
    run,
  }
  shortcuts.register([def])
  return run
}

/** Dispatches a keydown the way a browser delivers one from a given layout (Playwright types US keys only). */
function key(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, composed: true, ...init })
  target.dispatchEvent(e)
  return e
}

function blur(): void {
  ;(document.activeElement as HTMLElement | null)?.blur()
}

afterEach(async () => {
  resetApp()
  document.querySelectorAll('[data-test-node]').forEach((n) => n.remove())
  vi.restoreAllMocks()
  await page.viewport(1280, 800)
})

describe('widget guard with real focus', () => {
  it('Space on a focused button clicks it and never toggles the recitation', async () => {
    await bootApp()
    const toggle = spy(['Space'], { group: 'audio', id: 'audio.playPause' })
    const index = document.querySelector<HTMLElement>('.rail button[data-tab="index"]') as HTMLElement
    index.focus()
    expect(ui.sidebarOpen).toBe(true)
    await userEvent.keyboard(' ')
    await settle()
    expect(ui.sidebarOpen).toBe(false)
    expect(toggle).not.toHaveBeenCalled()
    blur()
    await userEvent.keyboard(' ')
    expect(toggle).toHaveBeenCalledOnce()
  })

  it('ArrowRight in the speed slider moves the slider and leaves the page alone', async () => {
    // The real `nav.prevPage` (ArrowRight, scope `mushaf`) is the definition the slider must keep the key from.
    await bootApp({ settings: { pageTurnAnimation: false } })
    reader.goToPage(5, { push: false, transition: false })
    await expect.poll(() => reader.visiblePages[0]).toBe(5)
    const onValueChange = vi.fn()
    await render(Slider, { props: { min: 50, max: 200, step: 5, value: 100, label: 'Speed', onValueChange } })
    const thumb = document.querySelector<HTMLElement>('[role="slider"][aria-label="Speed"]') as HTMLElement
    thumb.focus()
    await userEvent.keyboard('{ArrowRight}')
    await settle()
    expect(onValueChange).toHaveBeenCalledWith(105)
    expect(reader.visiblePages[0]).toBe(5)
    blur()
    await userEvent.keyboard('{ArrowRight}')
    await expect.poll(() => reader.visiblePages[0]).toBe(3)
  })

  it('typing b in an open menu moves to "Bookmark" and does not toggle a bookmark', async () => {
    await bootApp()
    const bookmark = spy(['b'], { id: 'study.bookmark' })
    const onClose = vi.fn()
    await render(ContextMenu, {
      props: {
        at: { x: 400, y: 300 },
        onClose,
        label: 'Ayah 2:255',
        items: [
          { id: 'play', label: 'Play from here', onSelect: () => {} },
          { id: 'bookmark', label: 'Bookmark', onSelect: () => {} },
          { id: 'copy', label: 'Copy', onSelect: () => {} },
        ],
      },
    })
    await settle(200)
    expect(ui.layerOpen).toBe(true)
    await userEvent.keyboard('b')
    await settle()
    expect(document.activeElement?.textContent?.trim()).toBe('Bookmark')
    expect(bookmark).not.toHaveBeenCalled()
  })

  it('keeps plain keys in a text field, while Ctrl+K still opens the palette (capture phase)', async () => {
    await bootApp()
    const bookmark = spy(['b'], { id: 'study.bookmark' })
    const input = document.createElement('input')
    input.dataset.testNode = ''
    document.body.append(input)
    input.focus()
    await userEvent.keyboard('b')
    expect(input.value).toBe('b')
    expect(bookmark).not.toHaveBeenCalled()
    await userEvent.keyboard(`{${mod()}>}k{/${mod()}}`)
    expect(ui.topOverlay?.kind).toBe('palette')
  })

  it('lets the Mushaf roving items keep the reader keys', async () => {
    await bootApp()
    const bookmark = spy(['b'], { id: 'study.bookmark', scope: 'reader' })
    const list = document.createElement('ol')
    list.className = 'mp-a11y'
    list.dataset.testNode = ''
    const item = document.createElement('li')
    item.tabIndex = 0
    list.append(item)
    document.querySelector('main#qd-main')?.append(list)
    item.focus()
    await userEvent.keyboard('b')
    expect(bookmark).toHaveBeenCalledOnce()
  })
})

describe('hybrid matching', () => {
  it('Arabic layout: ن on the K key is k (previous ayah)', async () => {
    await bootApp()
    const prevAyah = spy(['ArrowUp', 'k'], { group: 'navigation', id: 'nav.prevAyah', scope: 'reader' })
    blur()
    key({ key: 'ن', code: 'KeyK' })
    expect(prevAyah).toHaveBeenCalledOnce()
    // ض on the Q key is not k.
    key({ key: 'ض', code: 'KeyQ' })
    expect(prevAyah).toHaveBeenCalledOnce()
  })

  it('AZERTY: ? typed as Shift+, opens the sheet; the key labelled Q peeks', async () => {
    await bootApp()
    const peek = spy(['q'], { group: 'memorize', id: 'memo.peek', scope: 'reader' })
    const stray = spy(['a'], { id: 'test.a' })
    blur()
    // On AZERTY "?" is Shift + the key at the US M position.
    key({ key: '?', code: 'KeyM', shiftKey: true })
    expect(ui.topOverlay?.kind).toBe('shortcuts')
    ui.close()
    await settle(300)
    // The key labelled Q sits where US has A: it types q, so it peeks.
    key({ key: 'q', code: 'KeyA' })
    expect(peek).toHaveBeenCalledOnce()
    expect(stray).not.toHaveBeenCalled()
  })
})

describe('Escape', () => {
  it('closes an open dialog first; the next Escape leaves zen', async () => {
    await bootApp()
    ui.setZen(true)
    blur()
    await userEvent.keyboard('?')
    await settle(300)
    expect(ui.topOverlay?.kind).toBe('shortcuts')
    // The sheet's filter field is focused and empty: Escape closes the dialog (bits-ui), nothing else.
    await userEvent.keyboard('{Escape}')
    await settle(400)
    expect(ui.overlays).toEqual([])
    expect(ui.zen).toBe(true)
    blur()
    await userEvent.keyboard('{Escape}')
    expect(ui.zen).toBe(false)
  })

  it('a view’s search field clears on the first Escape; the next one leaves the view (or closes Settings)', async () => {
    await bootApp()
    const fields = {
      settings: '[role="dialog"] input[data-settings-search]',
      downloads: 'main.canvas input[type="search"]',
    } as const
    for (const view of ['settings', 'downloads'] as const) {
      ui.setView(view)
      await settle(300)
      const field = document.querySelector<HTMLInputElement>(fields[view])
      expect(field, view).not.toBeNull()
      await userEvent.click(field as HTMLInputElement)
      await userEvent.keyboard('the')
      expect(field?.value).toBe('the')
      await userEvent.keyboard('{Escape}')
      await settle()
      expect(ui.view, view).toBe(view)
      expect(field?.value, view).toBe('')
      expect(document.activeElement, view).toBe(field)
      await userEvent.keyboard('{Escape}')
      await settle()
      expect(ui.view, view).toBe('reader')
    }
  })

  it('in a narrow window a sidebar filter clears first; the next Escape closes the floating sidebar', async () => {
    await bootApp({ size: [860, 900] })
    blur()
    await userEvent.keyboard(`{${mod()}>}f{/${mod()}}`)
    await settle(400)
    expect(ui.sidebarOverlay).toBe(true)
    const field = document.querySelector<HTMLInputElement>('[data-qd-focus="search"]') as HTMLInputElement
    expect(document.activeElement).toBe(field)
    await userEvent.keyboard('rahman')
    await userEvent.keyboard('{Escape}')
    await settle()
    expect(field.value).toBe('')
    expect(ui.sidebarOpen).toBe(true)
    await userEvent.keyboard('{Escape}')
    await settle(300)
    expect(ui.sidebarOpen).toBe(false)
  })

  it('cancels the preset editor and keeps the reader’s selection', async () => {
    await bootApp({ settings: { pageMode: 'spread' } })
    reader.goToAyah(300, { select: true })
    await settle()
    const selection = reader.selection
    expect(selection).not.toBeNull()
    await settings.update({ sidebar: { ...settings.value.sidebar, open: true, tab: 'memorize' } })
    await settle(400)
    const create = [...document.querySelectorAll<HTMLElement>('aside button')].find((b) =>
      /new preset/i.test(b.textContent ?? ''),
    )
    await userEvent.click(create as HTMLElement)
    await settle(300)
    const editor = () => document.querySelector('[data-qd-preset-editor]')
    expect(editor()).not.toBeNull()
    // A button inside the editor (not a text field) has focus.
    ;(editor()?.querySelector('.stepper button') as HTMLElement).focus()
    await userEvent.keyboard('{Escape}')
    await settle()
    expect(editor()).toBeNull()
    expect(reader.selection).toEqual(selection)
  })
})

describe('labels (format)', () => {
  it('prints the platform chord and reads the keyboard layout map where the browser has one', async () => {
    await bootApp({ edit: (b) => ({ ...b, app: { ...b.app, platform: 'windows' } }) })
    const palette = shortcuts.defs.find((d) => d.id === 'app.palette')
    expect(palette && shortcuts.format(palette)).toBe('Ctrl+K')
    // Chromium has the Keyboard Map API everywhere, but on Linux without a keyboard layout to read (headless CI) its map
    // is empty: the store then keeps no map, as where the API is missing (WebKit).
    const keyboard = (
      navigator as { keyboard?: { getLayoutMap?: () => Promise<ReadonlyMap<string, string>> } }
    ).keyboard
    const browserMap = typeof keyboard?.getLayoutMap === 'function' ? await keyboard.getLayoutMap() : null
    await shortcuts.refreshLayoutMap()
    if (browserMap !== null && browserMap.size > 0) expect(shortcuts.layoutMap?.size ?? 0).toBeGreaterThan(20)
    else expect(shortcuts.layoutMap).toBeNull()
  })
})

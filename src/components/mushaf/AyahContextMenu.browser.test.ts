/**
 * The ayah context menu and the study shortcuts in a real browser (§10.3, §10.1, §7.7; WP11c acceptance): the menu's
 * rows and keyboard hints, typeahead that never reaches the reader shortcuts (typing `b` in the menu does not
 * bookmark), the selection rule, every study action (bookmark, reading bookmark, highlight 1–5 / 0, note, copy, side
 * pane, Shift+F10, undo/redo), and the "New collection…" and "Custom…" dialogs.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import '../../app.css'
import { library, player, reader, settings, ui } from '$lib/stores'
import { bootApp, resetApp, settle } from '../shell/testing/boot'

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const plainText = (s: string | null | undefined) => (s ?? '').replace(/[\u2066-\u2069]/gu, '')
const plain = (el: Element | null | undefined) => plainText(el?.textContent)
const menu = () => $('.qd-menu[aria-label^="Ayah menu"]')
const item = (label: string) =>
  $$('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]').find((m) =>
    plain(m.querySelector('.label')).startsWith(label),
  )

async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await settle(20)
  }
}

async function openMenu(ayahId: number): Promise<HTMLElement> {
  ui.openContextMenu({ x: 420, y: 260, ayahId })
  flushSync()
  await until(() => menu() !== null)
  await settle(60)
  return menu() as HTMLElement
}

/** A keydown on the page body, where the reader shortcuts listen (§7.7). */
async function press(keys: string): Promise<void> {
  ;(document.activeElement as HTMLElement | null)?.blur()
  await userEvent.keyboard(keys)
  await settle(40)
}

afterEach(async () => {
  resetApp()
  vi.restoreAllMocks()
  await page.viewport(1280, 800)
})

describe('AyahContextMenu (§10.3)', () => {
  it('opens at the pointer with the §10.3 rows and the shortcut hints', async () => {
    await bootApp()
    const m = await openMenu(262)
    expect(plainText(m.getAttribute('aria-label'))).toContain('Al-Baqarah 2:255')
    const labels = $$('.qd-menu [role^="menuitem"] .label').map((l) => plain(l))
    expect(labels).toEqual([
      'Play from here',
      'Play this ayah only',
      'Repeat',
      'Bookmark',
      'Move reading bookmark here',
      'Highlight',
      'Add note…',
      'Add to collection',
      'Copy',
      'Translation',
      'Tafsir',
      'Word by word',
      'Memorize',
    ])
    const hint = (label: string) => plain(item(label)?.querySelector('.hint'))
    expect(hint('Play from here')).toBe('Ctrl+Click')
    expect(hint('Bookmark')).toBe('B')
    expect(hint('Move reading bookmark here')).toBe('Shift+B')
    expect(hint('Add note…')).toBe('N')
    // It is a floating layer while open.
    expect(ui.layerOpen).toBe(true)
    await userEvent.keyboard('{Escape}')
    await until(() => ui.contextMenu === null)
  })

  it('typing b in the open menu moves to Bookmark and does not bookmark', async () => {
    await bootApp()
    reader.cursorAyahId = 262
    await openMenu(262)
    await userEvent.keyboard('b')
    await settle(80)
    expect(library.bookmarks).toEqual([])
    expect(document.activeElement?.closest('[role="menuitem"]')?.textContent).toContain('Bookmark')
    // Enter on the highlighted row is the menu's own action.
    await userEvent.keyboard('{Enter}')
    await until(() => library.bookmarkedAyahs.has(262))
    expect(library.bookmarks).toHaveLength(1)
    expect(ui.contextMenu).toBeNull()
  })

  it('applies to the selection when the clicked ayah lies inside it', async () => {
    await bootApp()
    reader.selection = { fromAyahId: 8, toAyahId: 10, anchorAyahId: 8 }
    await openMenu(9)
    expect(menu()?.getAttribute('aria-label')).toContain('2:1–3')
    expect(plain(item('Play the selection'))).toContain('Play the selection')
    await userEvent.hover(item('Highlight') as HTMLElement)
    await until(() => item('Green') !== undefined)
    await userEvent.click(item('Green') as HTMLElement)
    await until(() => library.highlights.length === 1)
    expect(library.highlights[0]).toMatchObject({ fromAyahId: 8, toAyahId: 10, color: 'green' })
    // Outside the selection, the clicked ayah alone.
    await openMenu(20)
    expect(menu()?.getAttribute('aria-label')).toContain('2:13')
    await userEvent.click(item('Bookmark') as HTMLElement)
    await until(() => library.bookmarkedAyahs.has(20))
    await openMenu(20)
    expect(item('Remove bookmark')).toBeDefined()
  })

  it('creates a collection from "New collection…" and puts the ayah in it', async () => {
    await bootApp()
    await openMenu(262)
    await userEvent.hover(item('Add to collection') as HTMLElement)
    await until(() => item('New collection…') !== undefined)
    await userEvent.click(item('New collection…') as HTMLElement)
    await until(() => $('[role="dialog"] input') !== null)
    await userEvent.type($('[role="dialog"] input') as HTMLElement, 'Duas')
    await userEvent.keyboard('{Enter}')
    await until(() => library.collections.length === 1 && library.bookmarkOf(262) !== undefined)
    expect(library.collections[0]?.name).toBe('Duas')
    expect(library.bookmarkOf(262)?.collectionIds).toEqual([library.collections[0]?.id])
  })

  it('plays a custom repeat from "Custom…"', async () => {
    await bootApp()
    const play = vi.spyOn(player, 'playRange').mockResolvedValue()
    reader.selection = { fromAyahId: 8, toAyahId: 12, anchorAyahId: 8 }
    await openMenu(10)
    await userEvent.hover(item('Repeat') as HTMLElement)
    await until(() => item('Custom…') !== undefined)
    await userEvent.click(item('Custom…') as HTMLElement)
    await until(
      () => $$('[role="dialog"] [role="radio"]').length > 0 || $$('[role="dialog"] button').length > 2,
    )
    const dialog = $('[role="dialog"]') as HTMLElement
    expect(plain(dialog)).toContain('Custom repeat')
    expect(plain(dialog)).toContain('The whole selection')
    const playButton = [...dialog.querySelectorAll<HTMLElement>('button')].find(
      (b) => plain(b).trim() === 'Play',
    )
    await userEvent.click(playButton as HTMLElement)
    expect(play).toHaveBeenCalledWith(8, 12, { ayahRepeat: 3, rangeRepeat: 1 })
  })

  it('puts the C hint on the copy row that does what C does: the user’s copy format', async () => {
    await bootApp()
    const hint = (label: string) => plain(item(label)?.querySelector('.hint'))
    async function copyMenu(): Promise<void> {
      await openMenu(262)
      await userEvent.hover(item('Copy') as HTMLElement)
      await until(() => item('Arabic only') !== undefined)
    }
    async function close(): Promise<void> {
      await userEvent.keyboard('{Escape}')
      await userEvent.keyboard('{Escape}')
      await until(() => ui.contextMenu === null)
    }
    // The default format adds the reference: C copies "Arabic with reference".
    await copyMenu()
    expect(hint('Arabic with reference')).toBe('C')
    expect(hint('Arabic only')).toBe('')
    expect(hint('With translation')).toBe('Ctrl+Shift+C')
    await close()
    // Without the reference, C copies the Arabic alone.
    await settings.update({ copy: { ...settings.value.copy, includeReference: false } })
    await copyMenu()
    expect(hint('Arabic with reference')).toBe('')
    expect(hint('Arabic only')).toBe('C')
    await close()
    // With a copy translation, C appends it, like Ctrl+Shift+C.
    await settings.update({ copy: { ...settings.value.copy, translationPackId: 'tr.en.saheeh' } })
    await copyMenu()
    expect(hint('Arabic only')).toBe('')
    expect(hint('With translation')).toBe('C')
  })

  it('copies the reference alone', async () => {
    await bootApp()
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    await openMenu(262)
    await userEvent.hover(item('Copy') as HTMLElement)
    await until(() => item('Reference') !== undefined)
    expect(plain(item('Reference'))).toContain('Reference (2:255)')
    await userEvent.click(item('Reference') as HTMLElement)
    await until(() => write.mock.calls.length === 1)
    expect(write).toHaveBeenCalledWith('Al-Baqarah 2:255')
  })
})

describe('study shortcuts (§10.1)', () => {
  it('bookmarks, highlights and moves the reading bookmark on the action target, and undoes with Mod+Z', async () => {
    await bootApp()
    // The action target is the visible cursor (§8.15): bring 2:255's page on screen first.
    reader.goToAyah(262)
    await until(() => reader.visiblePages.includes(42) && !reader.turning, 5000)
    reader.cursorAyahId = 262
    expect(reader.actionTarget).toBe(262)
    await press('b')
    await until(() => library.bookmarkedAyahs.has(262))
    expect(plain($('[data-sonner-toast]'))).toContain('Bookmarked Al-Baqarah 2:255')

    await press('2')
    await until(() => library.highlightAt(262)?.color === 'green')
    await press('0')
    await until(() => library.highlightAt(262) === undefined)

    await press('{Shift>}B{/Shift}')
    await until(() => library.readingBookmark?.ayahId === 262)

    await press('{Control>}z{/Control}')
    await until(() => library.readingBookmark === null)
    await press('{Control>}z{/Control}')
    await until(() => library.highlightAt(262)?.color === 'green')
    await press('{Control>}{Shift>}Z{/Shift}{/Control}')
    await until(() => library.highlightAt(262) === undefined)
  })

  it('highlights the whole selection, opens the note editor and the side pane, and Shift+F10 opens the menu', async () => {
    await bootApp()
    reader.selection = { fromAyahId: 8, toAyahId: 10, anchorAyahId: 8 }
    reader.cursorAyahId = 8
    await press('5')
    await until(() => library.highlights.length === 1)
    expect(library.highlights[0]).toMatchObject({ fromAyahId: 8, toAyahId: 10, color: 'purple' })

    await press('n')
    expect(ui.topOverlay).toMatchObject({ kind: 'note-editor', props: { fromAyahId: 8, toAyahId: 10 } })
    ui.close('note-editor')
    await settle(300)

    await press('{Enter}')
    expect(settings.value.sidePane.open).toBe(true)

    await press('{Shift>}{F10}{/Shift}')
    await until(() => ui.contextMenu !== null)
    expect(ui.contextMenu?.ayahId).toBe(8)
  })

  it('never runs while the context menu, an input or a focused button has the keys', async () => {
    await bootApp()
    reader.cursorAyahId = 262
    const search = $('input[type="search"]')
    if (search) {
      search.focus()
      await userEvent.keyboard('b')
      await settle(40)
      expect(library.bookmarks).toEqual([])
    }
    const button = $('button.command') as HTMLElement
    button.focus()
    await userEvent.keyboard('b')
    await settle(40)
    expect(library.bookmarks).toEqual([])
  })
})

/**
 * The library panels in a real browser: the four empty states with their keys, rows built from the library store,
 * opening an entry in the reader, the item menus, Delete with undo, the filters (text, collections, colours, tags), the
 * History panel's days, paging and "Clear history", and the Arabic mirror. The App is booted like `main.ts` against the
 * browser mock; data is written through the mock's commands.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import '../../app.css'
import { api, call } from '$lib/ipc'
import type { SidebarTab } from '$lib/ipc/bindings'
import { history, library, reader, settings, ui } from '$lib/stores'
import { bootApp, resetApp, settle } from '../shell/testing/boot'
import { panelPrefs, previews } from './library.svelte'

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
/** Text without the bidi isolates that wrap references. */
const plain = (el: Element | null | undefined) =>
  (el?.textContent ?? '').replace(/[\u2066-\u2069]/gu, '').replace(/\s/gu, ' ')
const panel = () => $('.sidebar-panel') as HTMLElement
const rows = () => $$('.sidebar-panel li.item')

async function show(tab: SidebarTab): Promise<void> {
  await settings.update({ sidebar: { ...settings.value.sidebar, open: true, tab } })
  flushSync()
  await settle(80)
}

/** Waits until `fn` holds (the store's re-reads and the mock's events are asynchronous). */
async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await settle(20)
  }
}

afterEach(async () => {
  resetApp()
  previews.reset()
  panelPrefs.reset()
  vi.restoreAllMocks()
  await page.viewport(1280, 800)
})

describe('empty states', () => {
  it('teaches each panel its key', async () => {
    // The reader records page 1 after a 3 s dwell, which a slow runner reaches before the History panel shows.
    vi.spyOn(history, 'record').mockResolvedValue()
    await bootApp()
    await show('bookmarks')
    expect(plain(panel())).toContain('No bookmarks yet')
    expect(plain(panel())).toContain('Press B on any ayah')
    expect($('.sidebar-panel kbd')?.textContent).toContain('B')
    // Nothing to filter: the empty state stands alone.
    expect($('.sidebar-panel input[type="search"]')).toBeNull()

    await show('highlights')
    expect(plain(panel())).toContain('1–5 to highlight')
    expect($$('.sidebar-panel .key')).toHaveLength(5)

    await show('notes')
    expect(plain(panel())).toContain('N to add a note')

    await show('history')
    await until(() => history.status === 'ready')
    expect(plain(panel())).toContain('Pages you read appear here')
  })

  it('writes the highlight keys in the UI digits, as on the key chips', async () => {
    await bootApp({ settings: { uiLanguage: 'ar' } })
    await show('highlights')
    expect(plain(panel())).toContain('من ١ إلى ٥ للتظليل')
    expect($$('.sidebar-panel .key').map((k) => k.textContent?.trim())).toEqual(['١', '٢', '٣', '٤', '٥'])
  })
})

describe('Bookmarks panel', () => {
  it('lists bookmarks with their reference, page and collections, and opens one in the reader', async () => {
    await bootApp()
    const c = await library.createCollection('Duas')
    await library.toggleBookmark(262)
    await library.toggleCollection(262, c?.id ?? '')
    await library.toggleBookmark(1)
    await show('bookmarks')
    expect(rows()).toHaveLength(2)
    const kursi = rows().find((r) => plain(r).includes('Al-Baqarah 2:255'))
    expect(kursi).toBeDefined()
    expect(plain(kursi)).toMatch(/p \d+/)
    expect(plain(kursi)).toContain('Duas')
    // The collection chips filter the list.
    const chips = $$('.sidebar-panel .chips .chip')
    expect(chips.map((ch) => plain(ch).replace(/\s+/gu, ' ').trim())).toEqual(['All 2', 'Duas 1'])
    await userEvent.click(chips[1] as HTMLElement)
    expect(rows()).toHaveLength(1)
    await userEvent.click(chips[0] as HTMLElement)
    expect(rows()).toHaveLength(2)

    const goTo = vi.spyOn(reader, 'goToAyah')
    await userEvent.click(kursi?.querySelector('button.row') as HTMLElement)
    expect(goTo).toHaveBeenCalledWith(262, expect.objectContaining({ flash: true, focus: true }))
  })

  it('shows the ayah opening in Quran text, filters by surah name, and deletes with Delete (undoable)', async () => {
    await bootApp()
    await library.toggleBookmark(262)
    await library.toggleBookmark(2141)
    await show('bookmarks')
    await until(() => $$('.sidebar-panel .ayah.quran-text').length === 2)
    const ayah = $('.sidebar-panel .ayah.quran-text') as HTMLElement
    expect(ayah.getAttribute('dir')).toBe('rtl')
    expect(ayah.getAttribute('lang')).toBe('ar')

    const filter = $('.sidebar-panel input[type="search"]') as HTMLInputElement
    await userEvent.type(filter, 'kahf')
    await settle(40)
    expect(rows()).toHaveLength(1)
    expect(plain(rows()[0])).toContain('Al-Kahf')
    await userEvent.clear(filter)
    await settle(40)

    const row = rows()[0]?.querySelector('button.row') as HTMLElement
    row.focus()
    await userEvent.keyboard('{Delete}')
    await until(() => library.bookmarks.length === 1)
    expect(plain(document.querySelector('[data-sonner-toast]'))).toMatch(/Removed the bookmark from/)
    await library.undo()
    await until(() => rows().length === 2)
  })

  it('opens the item menu and edits the label', async () => {
    await bootApp()
    await library.toggleBookmark(262)
    await show('bookmarks')
    const row = rows()[0]?.querySelector('button.row') as HTMLElement
    row.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 120,
        clientY: 160,
      }),
    )
    await settle(120)
    const items = $$('[role="menuitem"]').map((m) => plain(m).trim())
    expect(items.some((t) => t.startsWith('Open'))).toBe(true)
    expect(items.some((t) => t.startsWith('Open in side pane'))).toBe(true)
    expect(items.some((t) => t.startsWith('Edit label'))).toBe(true)
    expect(items.some((t) => t.startsWith('Delete'))).toBe(true)
    await userEvent.click($$('[role="menuitem"]').find((m) => plain(m).includes('Edit label')) as HTMLElement)
    await until(() => $('[role="dialog"] input') !== null)
    // The field by its role, found when the keys go in: an element handed to userEvent is sent as a CSS path through
    // its ancestors' places among their siblings, taken at once, and the item menu's portal leaves <body> when its exit
    // transition ends, which on a slow runner comes after that. The stale path matched nothing, and typing waited out
    // the test.
    await userEvent.type(page.getByRole('dialog').getByRole('textbox'), 'Ayat al-Kursi')
    await userEvent.keyboard('{Enter}')
    await until(() => library.bookmarkOf(262)?.label === 'Ayat al-Kursi')
    await until(() => plain(rows()[0]).includes('Ayat al-Kursi'))
  })

  it('heads the list with the reading bookmark', async () => {
    await bootApp()
    await library.moveReadingBookmark(2185, 'v2', 297)
    await show('bookmarks')
    const ribbon = $('.sidebar-panel .ribbon-row') as HTMLElement
    expect(plain(ribbon)).toContain('Reading bookmark')
    expect(plain(ribbon)).toContain('Al-Kahf 18:45')
    expect(plain(ribbon)).toContain('p 297')
  })
})

describe('Highlights panel', () => {
  it('groups highlights by surah, tints the Quran line and filters by colour', async () => {
    await bootApp()
    await library.setHighlight(2, 4, 'yellow')
    await library.setHighlight(262, 262, 'green')
    await library.setHighlight(263, 264, 'yellow')
    await show('highlights')
    const heads = $$('.sidebar-panel .group-head').map((h) => plain(h))
    expect(heads[0]).toContain('Al-Fatihah')
    expect(heads[1]).toContain('Al-Baqarah')
    expect(rows()).toHaveLength(3)
    expect(plain(rows()[1])).toContain('2:255')
    await until(() => $$('.sidebar-panel .ayah.tinted').length === 3)

    const yellow = $$('.sidebar-panel .colors .chip').find((ch) =>
      ch.getAttribute('aria-label')?.startsWith('Yellow'),
    )
    await userEvent.click(yellow as HTMLElement)
    expect(rows()).toHaveLength(2)
    expect($$('.sidebar-panel .colors .chip[aria-pressed="true"]')).toHaveLength(1)
  })

  it('removes a highlight from its menu', async () => {
    await bootApp()
    await library.setHighlight(262, 262, 'blue')
    await show('highlights')
    const row = rows()[0]?.querySelector('button.row') as HTMLElement
    row.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 100,
        clientY: 150,
      }),
    )
    await settle(120)
    await userEvent.click(
      $$('[role="menuitem"]').find((m) => plain(m).includes('Remove highlight')) as HTMLElement,
    )
    await until(() => library.highlights.length === 0)
    await until(() => plain(panel()).includes('No highlights yet'))
  })
})

describe('Notes panel', () => {
  it('shows a plain excerpt (never the Markdown), opens the note in the reader and edits it on double-click', async () => {
    await bootApp()
    await library.saveNote({
      id: null,
      fromAyahId: 1,
      toAyahId: 7,
      title: null,
      body: '# The Opening\nSeven **oft-repeated** verses. See [this](https://example.com).',
      tagIds: [],
    })
    await show('notes')
    const row = rows()[0] as HTMLElement
    expect(plain(row.querySelector('.title'))).toBe('The Opening')
    expect(plain(row.querySelector('.excerpt'))).toBe('Seven oft-repeated verses. See this.')
    expect(row.innerHTML).not.toContain('<strong')
    expect(plain(row)).toContain('Al-Fatihah 1:1–7')

    const goTo = vi.spyOn(reader, 'goToAyah')
    await userEvent.click(row.querySelector('button.row') as HTMLElement)
    expect(goTo).toHaveBeenCalledWith(1, expect.objectContaining({ select: true }))
    expect(settings.value.sidePane.tab).toBe('notes')

    await userEvent.dblClick(row.querySelector('button.row') as HTMLElement)
    expect(ui.isOpen('note-editor')).toBe(true)
    expect(ui.topOverlay?.props).toMatchObject({ fromAyahId: 1, toAyahId: 7 })
  })
})

describe('Delete keeps keyboard focus in the panel', () => {
  const firstRow = () => rows()[0]?.querySelector<HTMLElement>('button.row') ?? null

  async function deleteFirstAndCheck(count: () => number): Promise<void> {
    const before = rows().length
    const label = (el: Element | null | undefined) => el?.getAttribute('aria-label') ?? ''
    const second = label(rows()[1]?.querySelector('button.row'))
    ;(firstRow() as HTMLElement).focus()
    await userEvent.keyboard('{Delete}')
    await until(() => count() === before - 1 && rows().length === before - 1)
    // Focus is on the row that took the deleted one's place (a group may have re-created its rows).
    await until(() => document.activeElement === firstRow())
    expect(label(firstRow())).toBe(second)
    expect(firstRow()?.tabIndex).toBe(0)
    const cursor = reader.cursorAyahId
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(rows()[1]?.querySelector('button.row'))
    expect(reader.cursorAyahId).toBe(cursor)
  }

  it('Bookmarks: Delete on the first row leaves focus on the new first row', async () => {
    await bootApp()
    for (const id of [8, 262, 2141]) await library.toggleBookmark(id)
    await show('bookmarks')
    await until(() => rows().length === 3)
    await deleteFirstAndCheck(() => library.bookmarks.length)
  })

  it('Highlights: Delete on the first row leaves focus on the new first row', async () => {
    await bootApp()
    await library.setHighlight(8, 8, 'yellow')
    await library.setHighlight(262, 262, 'green')
    await library.setHighlight(2141, 2141, 'blue')
    await show('highlights')
    await until(() => rows().length === 3)
    await deleteFirstAndCheck(() => library.highlights.length)
  })

  it('Notes: Delete on the first row leaves focus on the new first row', async () => {
    await bootApp()
    for (const id of [8, 262, 2141]) {
      await library.saveNote({
        id: null,
        fromAyahId: id,
        toAyahId: id,
        title: null,
        body: `note ${id}`,
        tagIds: [],
      })
    }
    await show('notes')
    await until(() => rows().length === 3)
    await deleteFirstAndCheck(() => library.notes.length)
  })

  it('the item menu’s Delete hands focus on too; after the last row, the panel’s tab in the rail takes it', async () => {
    await bootApp()
    for (const id of [8, 262]) await library.toggleBookmark(id)
    await show('bookmarks')
    await until(() => rows().length === 2)
    const removeVia = async (row: HTMLElement) => {
      row.focus()
      await userEvent.keyboard('{Shift>}{F10}{/Shift}')
      await settle(120)
      await userEvent.click(
        $$('[role="menuitem"]').find((m) => /^Delete/.test(plain(m).trim())) as HTMLElement,
      )
    }
    await removeVia(firstRow() as HTMLElement)
    await until(() => library.bookmarks.length === 1)
    await until(() => document.activeElement === firstRow())
    await removeVia(firstRow() as HTMLElement)
    await until(() => library.bookmarks.length === 0)
    // No row and no filter left (the empty state stands alone): the panel's tab in the rail holds focus.
    await until(() => document.activeElement === $('.rail button[data-tab="bookmarks"]'))
  })
})

describe('History panel', () => {
  it('groups entries by day, opens a page and clears the history after asking', async () => {
    await bootApp()
    await call(api.historyRecord({ mode: 'read', layout: 'v2', page: 297, ayahId: 2185, dwellS: 300 }))
    await call(api.historyRecord({ mode: 'listen', layout: null, page: null, ayahId: 262, dwellS: 30 }))
    await show('history')
    await until(() => rows().length === 2)
    expect(plain($('.sidebar-panel .day-head'))).toBe('Today')
    expect(plain(rows()[0])).toContain('Listened')
    expect(plain(rows()[1])).toContain('Read · Page 297 · 5 min')

    const goTo = vi.spyOn(reader, 'goToPage')
    await userEvent.click(rows()[1]?.querySelector('button.row') as HTMLElement)
    expect(goTo).toHaveBeenCalledWith(297, expect.anything())

    await userEvent.click(
      $$('.sidebar-panel button').find((b) => plain(b).trim() === 'Clear history') as HTMLElement,
    )
    await until(() => ui.isOpen('confirm'))
    ui.resolveConfirm(true)
    await until(() => history.entries.length === 0)
    await until(() => plain(panel()).includes('Pages you read appear here'))
  })
})

describe('Arabic UI', () => {
  it('mirrors the panel and keeps Latin labels isolated at the start', async () => {
    await bootApp({ settings: { uiLanguage: 'ar' } })
    await library.toggleBookmark(262)
    const id = library.bookmarkOf(262)?.id ?? ''
    await library.setBookmarkLabel(id, 'Ayat al-Kursi')
    await show('bookmarks')
    expect(document.documentElement.dir).toBe('rtl')
    const row = rows()[0]?.querySelector('button.row') as HTMLElement
    const title = row.querySelector('.title') as HTMLElement
    expect(title.querySelector('bdi')?.textContent).toBe('Ayat al-Kursi')
    // The lead mark sits at the inline start: the right edge in RTL.
    const lead = (row.querySelector('.lead') as HTMLElement).getBoundingClientRect()
    expect(lead.left).toBeGreaterThan(title.getBoundingClientRect().left)
    expect(plain(row)).toMatch(/[٠-٩]/u)
  })
})

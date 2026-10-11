/**
 * The library store against the browser mock (§7.3; WP11c acceptance): loading, every mutation with its toast naming
 * the target, the 20-deep undo/redo stacks (including the highlight snapshot protocol and undoing a first reading
 * bookmark), the marks cache, refreshes driven by `user-data-changed`, and failures that toast instead of rejecting.
 */
import { flushSync } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, call, initIpc } from '$lib/ipc'
import type { Bootstrap, HighlightColor } from '$lib/ipc/bindings'
import { state } from '$lib/ipc/mock/state'
import { app } from './app.svelte'
import { i18n } from './i18n.svelte'
import { library, UNDO_DEPTH } from './library.svelte'
import { quran } from './quran.svelte'
import { settings } from './settings.svelte'
import { ui } from './ui.svelte'

function stubMatchMedia(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

/** Text without the bidi isolates that wrap references (§11.3). */
const plain = (s: string | undefined) => (s ?? '').replace(/[\u2066-\u2069]/gu, '')
const lastToast = () => plain(ui.toasts.at(-1)?.message)
/**
 * Surah `n`'s English name in the loaded mock index. A real core.db's names (the exported fixtures: "Al-Baqarah") and
 * the synthetic Tanzil index of a fresh checkout ("Al-Baqara") differ; the toasts must name the target either way.
 */
const surah = (n: number) => quran.surah(n)?.nameSimple ?? `<no surah ${n}>`
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function boot(edit: (b: Bootstrap) => Bootstrap = (b) => b): Promise<Bootstrap> {
  localStorage.clear()
  await initIpc()
  state.resetAll()
  state.loadAll()
  const b = edit(await call(api.appBootstrap()))
  app.init(b)
  settings.init(b)
  i18n.init(b)
  quran.init(b)
  ui.init(b)
  library.init(b)
  await library.loadAll()
  return b
}

/** The colour of every ayah in `[from, to]` in the store's list ('' = none). */
function coloring(from: number, to: number): string[] {
  const out: string[] = []
  for (let a = from; a <= to; a++) out.push(library.highlightAt(a)?.color ?? '')
  return out
}

async function paint(from: number, to: number, color: HighlightColor): Promise<void> {
  await call(api.highlightSet({ fromAyahId: from, toAyahId: to, color }))
}

beforeEach(async () => {
  stubMatchMedia()
  await boot()
})

afterEach(() => {
  library.reset()
  ui.reset()
  quran.reset()
  settings.reset()
  app.reset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('loading', () => {
  it('loads every list at init and starts from the bootstrap reading bookmark', async () => {
    await paint(1, 1, 'yellow')
    await call(api.bookmarkToggleAyah(262))
    library.reset()
    await boot((b) => ({ ...b, readingBookmark: { ayahId: 2185, layout: 'v2', page: 297, updatedAt: 1 } }))
    expect(library.status).toBe('ready')
    expect(library.readingBookmark?.ayahId).toBe(2185)
    // The mock was reset by boot(): the lists are empty again.
    expect(library.bookmarks).toEqual([])
    expect(library.canUndo).toBe(false)
  })
})

describe('bookmarks', () => {
  it('toggles a bookmark, names it in the toast, and undoes and redoes it', async () => {
    expect(await library.toggleBookmark(262)).toBe(true)
    expect(library.bookmarkedAyahs.has(262)).toBe(true)
    expect(library.bookmarkOf(262)?.surah).toBe(2)
    expect(lastToast()).toBe(`Bookmarked ${surah(2)} 2:255`)
    expect(ui.toasts.at(-1)?.action?.label).toBe('Undo')
    expect(library.canUndo).toBe(true)

    expect(await library.undo()).toBe(true)
    expect(library.bookmarkedAyahs.has(262)).toBe(false)
    expect(lastToast()).toBe(`Undone: Bookmarked ${surah(2)} 2:255`)
    expect(ui.toasts.at(-1)?.action?.label).toBe('Redo')
    expect(library.canRedo).toBe(true)

    expect(await library.redo()).toBe(true)
    expect(library.bookmarkedAyahs.has(262)).toBe(true)
    expect(lastToast()).toBe(`Redone: Bookmarked ${surah(2)} 2:255`)

    expect(await library.toggleBookmark(262)).toBe(false)
    expect(lastToast()).toBe(`Removed the bookmark from ${surah(2)} 2:255`)
    expect(library.canRedo).toBe(false)
  })

  it('keeps the undo and redo stacks 20 deep', async () => {
    for (let i = 1; i <= UNDO_DEPTH + 5; i++) await library.toggleBookmark(i)
    expect(library.undoStack).toHaveLength(UNDO_DEPTH)
    for (let i = 0; i < UNDO_DEPTH; i++) await library.undo()
    expect(library.redoStack).toHaveLength(UNDO_DEPTH)
    expect(library.bookmarks.map((b) => b.ayahId).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
    expect(await library.undo()).toBe(false)
    expect(lastToast()).toBe('Nothing to undo')
  })

  it('undoes from the toast that announced the change', async () => {
    await library.toggleBookmark(8)
    const toast = ui.toasts.at(-1)
    toast?.action?.run()
    await wait(0)
    await library.toggleBookmark(9) // queued after the undo
    expect(library.bookmarkedAyahs.has(8)).toBe(false)
    expect(library.bookmarkedAyahs.has(9)).toBe(true)
  })

  it('bookmarks a page and removes it again', async () => {
    expect(await library.bookmarkPage('v2', 262)).toBe(true)
    expect(library.pageBookmark('v2', 262)?.ayahId).toBe(quran.pageRange('v2', 262).from)
    expect(lastToast()).toBe('Bookmarked page 262')
    expect(await library.bookmarkPage('v2', 262)).toBe(false)
    expect(library.pageBookmark('v2', 262)).toBeUndefined()
    await library.undo()
    expect(library.pageBookmark('v2', 262)).toBeDefined()
  })

  it('labels a bookmark and deletes it, both undoable', async () => {
    await library.toggleBookmark(262)
    const id = library.bookmarkOf(262)?.id ?? ''
    await library.setBookmarkLabel(id, '  Ayat al-Kursi ')
    expect(library.bookmarkOf(262)?.label).toBe('Ayat al-Kursi')
    await library.undo()
    expect(library.bookmarkOf(262)?.label).toBeNull()
    expect(await library.deleteBookmark(id)).toBe(true)
    expect(library.bookmarks).toEqual([])
    await library.undo()
    expect(library.bookmarkOf(262)?.id).toBe(id)
  })
})

describe('the reading bookmark', () => {
  it('undoing a first set clears it; undoing a move puts it back', async () => {
    await library.moveReadingBookmark(2185, 'v2', 297)
    expect(library.readingBookmark?.ayahId).toBe(2185)
    expect(lastToast()).toBe(`Reading bookmark placed at ${surah(18)} 18:45`)
    await library.undo()
    expect(library.readingBookmark).toBeNull()
    expect(state.user.value.readingBookmark).toBeNull()
    await library.redo()
    await library.moveReadingBookmark(262, 'v2', 42)
    expect(lastToast()).toBe(`Reading bookmark moved to ${surah(2)} 2:255`)
    await library.undo()
    expect(library.readingBookmark).toMatchObject({ ayahId: 2185, page: 297 })
    expect(state.user.value.readingBookmark?.ayahId).toBe(2185)
  })

  it('does nothing (and says so) when the ribbon is already there', async () => {
    await library.moveReadingBookmark(262, 'v2', 42)
    await library.moveReadingBookmark(262, 'v2', 42)
    expect(lastToast()).toBe(`The reading bookmark is already at ${surah(2)} 2:255`)
    expect(library.undoStack).toHaveLength(1)
  })
})

describe('highlights', () => {
  it('snapshots the overlapping highlights and restores them exactly on undo (§7.3)', async () => {
    const tag = await call(api.tagUpsert({ id: null, name: 'study', color: null }))
    await paint(2, 8, 'green')
    await paint(10, 12, 'yellow')
    await library.loadAll()
    const green = library.highlightAt(2)
    await call(api.itemTagsSet('highlight', green?.id ?? '', [tag.id]))
    await library.loadAll()
    const before = coloring(1, 14)
    const yellowId = library.highlightAt(10)?.id

    await library.setHighlight(5, 11, 'red')
    expect(coloring(1, 14)).toEqual([
      '',
      'green',
      'green',
      'green',
      'red',
      'red',
      'red',
      'red',
      'red',
      'red',
      'red',
      'yellow',
      '',
      '',
    ])
    expect(lastToast()).toBe(`Highlighted ${surah(1)} 1:5–2:4 red (replaced other colours)`)

    await library.undo()
    expect(coloring(1, 14)).toEqual(before)
    expect(library.highlightAt(2)?.id).toBe(green?.id)
    expect(library.highlightAt(2)?.tagIds).toEqual([tag.id])
    expect(library.highlightAt(10)?.id).toBe(yellowId)

    await library.redo()
    expect(coloring(5, 11)).toEqual(Array<string>(7).fill('red'))
    await library.undo()
    expect(coloring(1, 14)).toEqual(before)
  })

  it('names the replaced colour, and skips painting a colour that is already there', async () => {
    await library.setHighlight(262, 262, 'green')
    await library.setHighlight(262, 262, 'yellow')
    expect(lastToast()).toBe(`Highlighted ${surah(2)} 2:255 yellow (replaced green)`)
    const depth = library.undoStack.length
    await library.setHighlight(262, 262, 'yellow')
    expect(lastToast()).toBe(`${surah(2)} 2:255 is already highlighted yellow`)
    expect(library.undoStack).toHaveLength(depth)
  })

  it('clears a range and undoes the clear', async () => {
    await paint(20, 30, 'purple')
    await library.loadAll()
    const id = library.highlightAt(20)?.id
    expect(await library.clearHighlight(22, 25)).toBe(true)
    expect(coloring(20, 30)).toEqual(['purple', 'purple', '', '', '', '', ...Array<string>(5).fill('purple')])
    await library.undo()
    expect(coloring(20, 30)).toEqual(Array<string>(11).fill('purple'))
    expect(library.highlightAt(20)?.id).toBe(id)
    expect(await library.clearHighlight(100, 101)).toBe(false)
    expect(lastToast()).toBe(`${surah(2)} 2:93–94 has no highlight`)
  })

  it('deletes a highlight row and restores it on undo', async () => {
    await library.setHighlight(40, 42, 'blue')
    const id = library.highlightAt(40)?.id ?? ''
    expect(await library.deleteHighlight(id)).toBe(true)
    expect(library.highlights).toEqual([])
    await library.undo()
    expect(library.highlightAt(41)?.id).toBe(id)
  })
})

describe('notes', () => {
  it('creates, edits and deletes notes, each undoable', async () => {
    const n = await library.saveNote({
      id: null,
      fromAyahId: 1,
      toAyahId: 7,
      title: 'Al-Fatiha',
      body: 'The opening',
      tagIds: [],
    })
    expect(n?.id).toBeTruthy()
    expect(library.notedAyahs.has(4)).toBe(true)
    expect(lastToast()).toBe(`Added a note to ${surah(1)} 1:1–7`)
    await library.saveNote({
      id: n?.id ?? '',
      fromAyahId: 1,
      toAyahId: 7,
      title: 'Al-Fatiha',
      body: 'Edited',
      tagIds: [],
    })
    expect(library.notes[0]?.body).toBe('Edited')
    await library.undo()
    expect(library.notes[0]?.body).toBe('The opening')
    expect(await library.deleteNote(n?.id ?? '')).toBe(true)
    expect(library.notes).toEqual([])
    expect(lastToast()).toBe(`Deleted the note on ${surah(1)} 1:1–7`)
    await library.undo()
    expect(library.noteFor(3)?.id).toBe(n?.id)
    await library.undo()
    await library.undo()
    expect(library.notes).toEqual([])
  })

  it('finds the note to edit for a target', async () => {
    await library.saveNote({ id: null, fromAyahId: 10, toAyahId: 12, title: null, body: 'range', tagIds: [] })
    expect(library.noteFor(11)?.body).toBe('range')
    expect(library.noteFor(10, 12)?.body).toBe('range')
    expect(library.noteFor(10, 11)).toBeUndefined()
  })
})

describe('collections and tags', () => {
  it('adds an ayah to a collection (creating its bookmark) and undoes it', async () => {
    const c = await library.createCollection('Duas')
    expect(c?.name).toBe('Duas')
    expect(await library.toggleCollection(262, c?.id ?? '')).toBe(true)
    expect(library.bookmarkOf(262)?.collectionIds).toEqual([c?.id])
    expect(library.collection(c?.id ?? '')?.itemCount).toBe(1)
    expect(lastToast()).toBe(`Added ${surah(2)} 2:255 to Duas`)
    await library.undo()
    expect(library.bookmarkOf(262)).toBeUndefined()
    expect(library.collection(c?.id ?? '')?.itemCount).toBe(0)

    // B revives the bookmark with its collections (WP2a deviation 4); the menu then takes it out again.
    await library.toggleBookmark(262)
    expect(library.bookmarkOf(262)?.collectionIds).toEqual([c?.id])
    expect(await library.toggleCollection(262, c?.id ?? '')).toBe(false)
    expect(lastToast()).toBe(`Removed ${surah(2)} 2:255 from Duas`)
    await library.undo()
    expect(library.bookmarkOf(262)?.collectionIds).toEqual([c?.id])
  })

  it('sets tags and undoes them; deleting a collection keeps its bookmarks', async () => {
    const t = await library.createTag('mercy')
    await library.toggleBookmark(5)
    const id = library.bookmarkOf(5)?.id ?? ''
    expect(await library.setTags('bookmark', id, [t?.id ?? ''])).toBe(true)
    expect(library.bookmarkOf(5)?.tagIds).toEqual([t?.id])
    expect(library.tag(t?.id ?? '')?.usageCount).toBe(1)
    await library.undo()
    expect(library.bookmarkOf(5)?.tagIds).toEqual([])
    const c = await library.createCollection('x')
    await library.setCollections(id, [c?.id ?? ''])
    expect(await library.deleteCollection(c?.id ?? '')).toBe(true)
    expect(library.collections).toEqual([])
    expect(library.bookmarkOf(5)?.collectionIds).toEqual([])
  })
})

describe('marks, events and failures', () => {
  it('caches marks, shares concurrent requests and refetches after a change', async () => {
    const spy = vi.spyOn(api, 'userMarks')
    const [a, b] = await Promise.all([
      library.marksFor('v2', [42], 255, 263),
      library.marksFor('v2', [42, 42], 255, 263),
    ])
    expect(a).toEqual(b)
    expect(spy).toHaveBeenCalledTimes(1)
    await library.marksFor('v2', [42], 255, 263)
    expect(spy).toHaveBeenCalledTimes(1)
    await library.toggleBookmark(262)
    const m = await library.marksFor('v2', [42], 255, 263)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(m?.bookmarks.map((x) => x.ayahId)).toEqual([262])
  })

  it('re-reads a list that another surface changed (user-data-changed)', async () => {
    await call(
      api.noteUpsert({ id: null, fromAyahId: 3, toAyahId: 3, title: null, body: 'elsewhere', tagIds: [] }),
    )
    await wait(120)
    flushSync()
    expect(library.notes.map((n) => n.body)).toEqual(['elsewhere'])
  })

  it('forgets undo and redo after a backup restore: Mod+Z never edits the restored library', async () => {
    // The backup holds green 8–12; after it, the library is cleared and 2:3 highlighted yellow from the UI.
    await paint(8, 12, 'green')
    const path = await call(api.userBackupCreate('D:/Backups/undo.qdb'))
    await call(api.highlightClearRange(1, quran.ayahCount))
    await library.loadAll()
    await library.setHighlight(10, 10, 'yellow')
    expect(coloring(8, 12)).toEqual(['', '', 'yellow', '', ''])
    await library.setHighlight(11, 11, 'red')
    await library.undo() // one entry on each stack
    expect(library.canUndo && library.canRedo).toBe(true)
    const dismissed = vi.spyOn(ui, 'dismissToast')

    await call(api.userBackupRestore(path))
    await wait(120)
    flushSync()
    expect(coloring(8, 12)).toEqual(Array<string>(5).fill('green'))
    expect(library.canUndo).toBe(false)
    expect(library.canRedo).toBe(false)
    expect(dismissed).toHaveBeenCalled() // the "Undone … · Redo" toast of the old library goes

    expect(await library.undo()).toBe(false)
    expect(lastToast()).toBe(i18n.t('library.undo.nothingToUndo'))
    expect(await library.redo()).toBe(false)
    await library.loadAll()
    expect(coloring(8, 12)).toEqual(Array<string>(5).fill('green')) // untouched: no hole at 2:3
  })

  it('follows the reading bookmark when another surface moves it', async () => {
    const page = quran.pageOfAyah('v2', 2185)
    await call(api.readingBookmarkSet({ ayahId: 2185, layout: 'v2', page }))
    await wait(120)
    expect(library.readingBookmark).toMatchObject({ ayahId: 2185, layout: 'v2', page })
    await call(api.readingBookmarkClear())
    await wait(120)
    expect(library.readingBookmark).toBeNull()
  })

  it('toasts a failure and resolves null instead of rejecting', async () => {
    const r = await library.setHighlight(7000, 7001, 'red')
    expect(r).toBeNull()
    expect(ui.toasts.at(-1)?.tone).toBe('danger')
    expect(library.canUndo).toBe(false)
  })
})

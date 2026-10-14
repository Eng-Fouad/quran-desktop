/**
 * The user-library mock against `UserDb`'s rules, history and backups included: target-keyed bookmarks, toggle revival,
 * tombstones, highlight splitting and merging (with a randomised model check of the invariant), the snapshot undo, text
 * normalisation, collections, tags, marks, history and the events every mutation emits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { events, type Bookmark, type Highlight, type HighlightColor, type UserDataKind } from '../../bindings'
import { installMockRuntime } from '../index'
import type { Result } from '../result'
import { state } from '../state'
import { searchHandlers } from './search'
import { backupPath, cleanBody, HISTORY_MAX_ENTRIES, singleLine, userHandlers as h, uuidv7 } from './user'

/** Unwraps an ok result; fails the test with the error otherwise. */
function ok<T>(r: Result<T>): T {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.error.kind}: ${r.error.message}`)
  return r.data
}

/** The error kind of a result that must have failed. */
function errKind<T>(r: Result<T>): string {
  if (r.status === 'ok') throw new Error(`expected an error, got ${JSON.stringify(r.data)}`)
  return r.error.kind
}

const BOOKMARKS_ALL = { kind: null, collectionId: null, tagId: null, surah: null, limit: 1000 }

async function bookmarks(): Promise<Bookmark[]> {
  return ok(await h.bookmarkList(BOOKMARKS_ALL))
}

async function highlights(): Promise<Highlight[]> {
  return ok(await h.highlightList(null))
}

/** The colour of every ayah in `[from, to]` as the live rows say ('' = none). */
async function coloring(from: number, to: number): Promise<string[]> {
  const rows = await highlights()
  const out: string[] = []
  for (let a = from; a <= to; a++)
    out.push(rows.find((r) => a >= r.fromAyahId && a <= r.toAyahId)?.color ?? '')
  return out
}

function checkInvariant(rows: readonly Highlight[]): void {
  const sorted = [...rows].sort((a, b) => a.fromAyahId - b.fromAyahId)
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    if (!prev || !cur) continue
    expect(cur.fromAyahId, 'live highlights never overlap').toBeGreaterThan(prev.toAyahId)
    if (cur.color === prev.color) {
      expect(cur.fromAyahId, 'same colours never touch').toBeGreaterThan(prev.toAyahId + 1)
    }
  }
}

let seen: UserDataKind[][] = []
let stopListening: (() => void) | null = null

beforeEach(async () => {
  localStorage.clear()
  await installMockRuntime()
  state.resetAll()
  state.loadAll()
  seen = []
  stopListening = await events.userDataChanged.listen((e) => seen.push(e.payload.kinds))
})

afterEach(() => {
  stopListening?.()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ids and text', () => {
  it('makes time-ordered UUIDv7 ids', () => {
    const a = uuidv7()
    const b = uuidv7()
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(a < b).toBe(true)
  })

  it('normalises single lines and note bodies like UserDb', () => {
    expect(singleLine('  Ayat\n al-\tKursi  ')).toBe('Ayat al- Kursi')
    expect(singleLine('a\u0007b')).toBe('ab')
    expect(cleanBody('  # Title\r\nline\rnext\u0000 \t  ')).toBe('# Title\nline\nnext')
  })

  it('places backups like user_backup_create', () => {
    const at = new Date(Date.UTC(2026, 9, 10, 8, 5, 3))
    expect(backupPath(null, at)).toBe('C:/mock/com.quran.labs.desktop/backups/user-20261010-080503Z.qdb')
    expect(backupPath('D:\\Backups\\', at)).toBe('D:/Backups/user-20261010-080503Z.qdb')
    expect(backupPath('D:/Backups/mine.qdb', at)).toBe('D:/Backups/mine.qdb')
    expect(() => backupPath('relative/x.qdb', at)).toThrow()
  })

  it('restores a backup made this session, keeping the current library as a new backup first', async () => {
    ok(await h.bookmarkToggleAyah(262))
    state.settings.update((s) => (s.theme = 'sepia'))
    const path = ok(await h.userBackupCreate('D:/Backups/mine.qdb'))
    expect(path).toBe('D:/Backups/mine.qdb')
    ok(await h.bookmarkToggleAyah(262))
    ok(await h.bookmarkToggleAyah(8))
    state.settings.update((s) => (s.theme = 'night'))
    seen = []
    const settingsSeen: string[] = []
    const stop = await events.settingsChanged.listen((e) => settingsSeen.push(e.payload.theme))
    expect(ok(await h.userBackupRestore('D:\\Backups\\mine.qdb'))).toBeNull()
    stop()
    expect((await bookmarks()).map((b) => b.ayahId)).toEqual([262])
    expect(state.settings.value.theme).toBe('sepia')
    expect(settingsSeen).toEqual(['sepia'])
    expect(seen.at(-1)?.sort()).toEqual(
      [
        'bookmarks',
        'reading_bookmark',
        'highlights',
        'notes',
        'collections',
        'tags',
        'positions',
        'history',
        'memo',
        'presets',
      ].sort(),
    )
    // Not a file this session wrote, or not a path at all.
    expect(errKind(await h.userBackupRestore('D:/Backups/other.qdb'))).toBe('not_found')
    expect(errKind(await h.userBackupRestore('relative.qdb'))).toBe('invalid_argument')
    expect(errKind(await h.userBackupRestore('  '))).toBe('invalid_argument')
  })

  it('restores the search history with the rest of user.db', async () => {
    const recent = async () => ok(await searchHandlers.searchHistoryList(10)).map((e) => e.query)
    ok(await searchHandlers.searchHistoryAdd('before', { type: 'quran' }))
    ok(await h.userBackupCreate('D:/Backups/search.qdb'))
    ok(await searchHandlers.searchHistoryAdd('after-backup', { type: 'quran' }))
    expect(await recent()).toEqual(['after-backup', 'before'])
    ok(await h.userBackupRestore('D:/Backups/search.qdb'))
    expect(await recent()).toEqual(['before'])
  })
})

describe('bookmarks', () => {
  it('toggles, tombstones and revives an ayah bookmark with its label', async () => {
    const on = ok(await h.bookmarkToggleAyah(262))
    expect(on.active).toBe(true)
    expect(on.bookmark).toMatchObject({
      kind: 'ayah',
      ayahId: 262,
      surah: 2,
      ayah: 255,
      layout: null,
      page: null,
    })
    ok(
      await h.bookmarkUpsert({
        id: on.bookmark.id,
        kind: 'ayah',
        ayahId: 262,
        layout: null,
        page: null,
        label: '  Ayat   al-Kursi ',
        collectionIds: [],
        tagIds: [],
      }),
    )
    const off = ok(await h.bookmarkToggleAyah(262))
    expect(off.active).toBe(false)
    expect(off.bookmark.label).toBe('Ayat al-Kursi')
    expect(await bookmarks()).toEqual([])
    const again = ok(await h.bookmarkToggleAyah(262))
    expect(again.active).toBe(true)
    expect(again.bookmark.id).toBe(on.bookmark.id)
    expect(again.bookmark.label).toBe('Ayat al-Kursi')
    expect(seen).toContainEqual(['bookmarks', 'collections', 'tags'])
  })

  it('keys upserts by target and rejects moving onto a held target', async () => {
    const a = ok(await h.bookmarkToggleAyah(10)).bookmark
    const b = ok(await h.bookmarkToggleAyah(11)).bookmark
    const updated = ok(
      await h.bookmarkUpsert({
        id: null,
        kind: 'ayah',
        ayahId: 10,
        layout: null,
        page: null,
        label: 'first',
        collectionIds: [],
        tagIds: [],
      }),
    )
    expect(updated.id).toBe(a.id)
    expect(await bookmarks()).toHaveLength(2)
    const move = await h.bookmarkUpsert({
      id: b.id,
      kind: 'ayah',
      ayahId: 10,
      layout: null,
      page: null,
      label: null,
      collectionIds: [],
      tagIds: [],
    })
    expect(errKind(move)).toBe('invalid_argument')
    expect(errKind(await h.bookmarkUpsert({ ...BOOK_INPUT, id: 'nope' }))).toBe('not_found')
  })

  it('needs a layout and page for a page bookmark and keys it by (layout, page)', async () => {
    expect(errKind(await h.bookmarkUpsert({ ...BOOK_INPUT, kind: 'page' }))).toBe('invalid_argument')
    const p = ok(
      await h.bookmarkUpsert({ ...BOOK_INPUT, kind: 'page', ayahId: 2185, layout: 'v2', page: 297 }),
    )
    expect(p).toMatchObject({ kind: 'page', layout: 'v2', page: 297, surah: 18 })
    const again = ok(
      await h.bookmarkUpsert({
        ...BOOK_INPUT,
        kind: 'page',
        ayahId: 2185,
        layout: 'v2',
        page: 297,
        label: 'x',
      }),
    )
    expect(again.id).toBe(p.id)
    const other = ok(
      await h.bookmarkUpsert({ ...BOOK_INPUT, kind: 'page', ayahId: 2185, layout: 'v1', page: 297 }),
    )
    expect(other.id).not.toBe(p.id)
  })

  it('tombstones: delete answers the row as it was, twice is not_found, restore of a live row is a no-op', async () => {
    const a = ok(await h.bookmarkToggleAyah(5)).bookmark
    const deleted = ok(await h.bookmarkDelete(a.id))
    expect(deleted).toEqual(a)
    expect(errKind(await h.bookmarkDelete(a.id))).toBe('not_found')
    const restored = ok(await h.bookmarkRestore(a.id))
    expect(restored.id).toBe(a.id)
    expect(ok(await h.bookmarkRestore(a.id))).toEqual(restored)
    expect(errKind(await h.bookmarkRestore('missing'))).toBe('not_found')
  })

  it('refuses to restore onto a target another bookmark took', async () => {
    const a = ok(await h.bookmarkToggleAyah(7)).bookmark
    ok(await h.bookmarkDelete(a.id))
    // A fresh toggle revives the tombstone, so create the competitor through an upsert after purging the trash.
    state.user.update((u) => (u.trash.bookmarks = []))
    state.user.update((u) => u.trash.bookmarks.push({ ...a }))
    ok(await h.bookmarkUpsert({ ...BOOK_INPUT, ayahId: 7 }))
    expect(errKind(await h.bookmarkRestore(a.id))).toBe('invalid_argument')
  })

  it('lists most recent first, filters by surah and kind, and answers nothing for limit 0', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000_000)
    ok(await h.bookmarkToggleAyah(1))
    vi.setSystemTime(1_000_005_000)
    ok(await h.bookmarkToggleAyah(262))
    const all = await bookmarks()
    expect(all.map((b) => b.ayahId)).toEqual([262, 1])
    expect(ok(await h.bookmarkList({ ...BOOKMARKS_ALL, surah: 2 })).map((b) => b.ayahId)).toEqual([262])
    expect(ok(await h.bookmarkList({ ...BOOKMARKS_ALL, kind: 'page' }))).toEqual([])
    expect(ok(await h.bookmarkList({ ...BOOKMARKS_ALL, limit: 0 }))).toEqual([])
    expect(errKind(await h.bookmarkList({ ...BOOKMARKS_ALL, surah: 115 }))).toBe('invalid_argument')
  })

  it('moves the reading bookmark and clears it (undo of a first set)', async () => {
    const first = ok(await h.readingBookmarkSet({ ayahId: 2185, layout: 'v2', page: 297 }))
    expect(first.previous).toBeNull()
    const second = ok(await h.readingBookmarkSet({ ayahId: 262, layout: 'v2', page: 42 }))
    expect(second.previous?.ayahId).toBe(2185)
    expect(second.current.ayahId).toBe(262)
    expect(ok(await h.readingBookmarkClear())?.ayahId).toBe(262)
    expect(ok(await h.readingBookmarkClear())).toBeNull()
    expect(errKind(await h.readingBookmarkSet({ ayahId: 262, layout: 'v2', page: 605 }))).toBe(
      'invalid_argument',
    )
    expect(seen).toContainEqual(['reading_bookmark'])
  })
})

const BOOK_INPUT = {
  id: null,
  kind: 'ayah' as const,
  ayahId: 1,
  layout: null,
  page: null,
  label: null,
  collectionIds: [] as string[],
  tagIds: [] as string[],
}

async function paint(from: number, to: number, color: HighlightColor): Promise<Highlight> {
  return ok(await h.highlightSet({ fromAyahId: from, toAyahId: to, color }))
}

describe('highlights', () => {
  it('splits another colour: the left piece keeps the id, the right piece is new with the same tags', async () => {
    const tag = ok(await h.tagUpsert({ id: null, name: 'study', color: null }))
    const g = await paint(3, 10, 'green')
    ok(await h.itemTagsSet('highlight', g.id, [tag.id]))
    await paint(5, 6, 'yellow')
    const rows = await highlights()
    expect(rows.map((r) => [r.fromAyahId, r.toAyahId, r.color])).toEqual([
      [3, 4, 'green'],
      [5, 6, 'yellow'],
      [7, 10, 'green'],
    ])
    expect(rows[0]?.id).toBe(g.id)
    expect(rows[2]?.id).not.toBe(g.id)
    expect(rows[2]?.tagIds).toEqual([tag.id])
    expect(rows[2]?.createdAt).toBe(g.createdAt)
    checkInvariant(rows)
  })

  it('merges same-colour rows that overlap or touch into the earliest, and painting inside one writes nothing', async () => {
    const a = await paint(1, 2, 'blue')
    await paint(5, 6, 'blue')
    const merged = await paint(3, 4, 'blue')
    expect(merged).toMatchObject({ id: a.id, fromAyahId: 1, toAyahId: 6 })
    expect(await highlights()).toHaveLength(1)
    const inside = await paint(2, 3, 'blue')
    expect(inside).toEqual(merged)
  })

  it('clears a range and answers the overlapping rows as they were; re-setting them restores the colouring', async () => {
    await paint(1, 4, 'red')
    await paint(6, 9, 'purple')
    const before = await coloring(1, 10)
    const removed = ok(await h.highlightClearRange(3, 7))
    expect(removed.map((r) => [r.fromAyahId, r.toAyahId, r.color])).toEqual([
      [1, 4, 'red'],
      [6, 9, 'purple'],
    ])
    expect(await coloring(1, 10)).toEqual(['red', 'red', '', '', '', '', '', 'purple', 'purple', ''])
    for (const r of removed) await paint(r.fromAyahId, r.toAyahId, r.color)
    expect(await coloring(1, 10)).toEqual(before)
  })

  it('supports the snapshot undo of a set (clear the range, re-apply the snapshot)', async () => {
    await paint(2, 8, 'green')
    await paint(10, 12, 'yellow')
    const before = await coloring(1, 14)
    const snapshot = (await highlights()).filter((r) => r.fromAyahId <= 11 && r.toAyahId >= 5)
    await paint(5, 11, 'red')
    ok(await h.highlightClearRange(5, 11))
    for (const r of snapshot) {
      const restored = ok(await h.highlightRestore(r.id))
      if (restored.fromAyahId > r.fromAyahId || restored.toAyahId < r.toAyahId) {
        await paint(r.fromAyahId, r.toAyahId, r.color)
      }
    }
    expect(await coloring(1, 14)).toEqual(before)
    checkInvariant(await highlights())
  })

  it('deletes and restores a row on top of newer rows, keeping its id', async () => {
    const a = await paint(20, 25, 'yellow')
    ok(await h.highlightDelete(a.id))
    expect(errKind(await h.highlightDelete(a.id))).toBe('not_found')
    await paint(22, 30, 'blue')
    const back = ok(await h.highlightRestore(a.id))
    expect(back).toMatchObject({ id: a.id, fromAyahId: 20, toAyahId: 25, color: 'yellow' })
    expect(await coloring(20, 31)).toEqual([
      ...Array<string>(6).fill('yellow'),
      ...Array<string>(5).fill('blue'),
      '',
    ])
  })

  it('keeps the invariant and matches a per-ayah model under random paints and clears', async () => {
    const N = 40
    const model: string[] = Array<string>(N + 1).fill('')
    const colors: HighlightColor[] = ['yellow', 'green', 'blue', 'red', 'purple']
    let seed = 7
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let step = 0; step < 120; step++) {
      const a = 1 + rand(N)
      const b = Math.min(N, a + rand(8))
      if (rand(4) === 0) {
        ok(await h.highlightClearRange(a, b))
        for (let i = a; i <= b; i++) model[i] = ''
      } else {
        const c = colors[rand(colors.length)] ?? 'yellow'
        await paint(a, b, c)
        for (let i = a; i <= b; i++) model[i] = c
      }
      checkInvariant(await highlights())
    }
    expect(await coloring(1, N)).toEqual(model.slice(1))
  })

  it('validates ranges and colours', async () => {
    expect(errKind(await h.highlightSet({ fromAyahId: 9, toAyahId: 3, color: 'red' }))).toBe(
      'invalid_argument',
    )
    expect(
      errKind(await h.highlightSet({ fromAyahId: 1, toAyahId: 2, color: 'teal' as HighlightColor })),
    ).toBe('invalid_argument')
  })
})

describe('notes', () => {
  it('needs a title or a body, normalises them and tombstones', async () => {
    const empty = await h.noteUpsert({
      id: null,
      fromAyahId: 1,
      toAyahId: 1,
      title: '  ',
      body: ' \n ',
      tagIds: [],
    })
    expect(errKind(empty)).toBe('invalid_argument')
    const n = ok(
      await h.noteUpsert({
        id: null,
        fromAyahId: 1,
        toAyahId: 7,
        title: ' Al-Fatiha \n',
        body: 'x\r\ny',
        tagIds: [],
      }),
    )
    expect(n).toMatchObject({ title: 'Al-Fatiha', body: 'x\ny' })
    const long = 'a'.repeat(201)
    expect(errKind(await h.noteUpsert({ ...NOTE, title: long }))).toBe('invalid_argument')
    ok(await h.noteDelete(n.id))
    expect(errKind(await h.noteGet(n.id))).toBe('not_found')
    expect(ok(await h.noteRestore(n.id)).id).toBe(n.id)
    expect(ok(await h.noteGet(n.id)).title).toBe('Al-Fatiha')
    expect(seen).toContainEqual(['notes', 'tags'])
  })

  it('lists notes that overlap the filter range, most recent first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(2_000_000_000)
    const a = ok(await h.noteUpsert({ ...NOTE, fromAyahId: 1, toAyahId: 7 }))
    vi.setSystemTime(2_000_009_000)
    const b = ok(await h.noteUpsert({ ...NOTE, fromAyahId: 262, toAyahId: 262 }))
    const all = ok(await h.noteList({ fromAyahId: null, toAyahId: null, tagId: null, limit: 10 }))
    expect(all.map((n) => n.id)).toEqual([b.id, a.id])
    const some = ok(await h.noteList({ fromAyahId: 5, toAyahId: 100, tagId: null, limit: 10 }))
    expect(some.map((n) => n.id)).toEqual([a.id])
    expect(errKind(await h.noteUpsert({ ...NOTE, id: 'missing' }))).toBe('not_found')
  })
})

const NOTE = { id: null, fromAyahId: 1, toAyahId: 1, title: null, body: 'body', tagIds: [] as string[] }

describe('collections and tags', () => {
  it('orders collections, counts live bookmarks and sets memberships exactly', async () => {
    const z = ok(await h.collectionUpsert({ id: null, name: 'zeta', color: null, sortKey: 0 }))
    const a = ok(await h.collectionUpsert({ id: null, name: 'Alpha', color: 'teal', sortKey: 0 }))
    expect(ok(await h.collectionList()).map((c) => c.name)).toEqual(['Alpha', 'zeta'])
    const b = ok(await h.bookmarkToggleAyah(3)).bookmark
    const set = ok(await h.collectionSetMembership(b.id, [z.id, a.id, z.id]))
    expect(set.collectionIds).toEqual([a.id, z.id])
    expect(ok(await h.collectionList()).map((c) => c.itemCount)).toEqual([1, 1])
    ok(await h.bookmarkDelete(b.id))
    expect(ok(await h.collectionList()).map((c) => c.itemCount)).toEqual([0, 0])
    expect(errKind(await h.collectionSetMembership(b.id, [a.id]))).toBe('not_found')
    expect(
      errKind(await h.collectionUpsert({ id: null, name: 'x', color: 'not a token!', sortKey: 0 })),
    ).toBe('invalid_argument')
    ok(await h.collectionDelete(a.id))
    expect(ok(await h.bookmarkRestore(b.id)).collectionIds).toEqual([z.id])
  })

  it('gets or creates tags by name, rejects a rename onto another name and counts usage', async () => {
    const t = ok(await h.tagUpsert({ id: null, name: 'Dua', color: null }))
    const same = ok(await h.tagUpsert({ id: null, name: '  dua ', color: 'red' }))
    expect(same.id).toBe(t.id)
    const u = ok(await h.tagUpsert({ id: null, name: 'mercy', color: null }))
    expect(errKind(await h.tagUpsert({ id: u.id, name: 'DUA', color: null }))).toBe('invalid_argument')
    const b = ok(await h.bookmarkToggleAyah(9)).bookmark
    ok(await h.itemTagsSet('bookmark', b.id, [u.id, t.id]))
    expect((await bookmarks())[0]?.tagIds).toEqual([t.id, u.id])
    expect(ok(await h.tagList()).map((x) => [x.name, x.usageCount])).toEqual([
      ['Dua', 1],
      ['mercy', 1],
    ])
    ok(await h.tagDelete(t.id))
    expect((await bookmarks())[0]?.tagIds).toEqual([u.id])
    expect(errKind(await h.itemTagsSet('note', 'missing', []))).toBe('not_found')
    expect(seen).toContainEqual(['tags', 'bookmarks', 'notes', 'highlights'])
  })
})

describe('marks', () => {
  it('answers the marks of a range and pages, in mushaf order', async () => {
    ok(await h.bookmarkToggleAyah(262))
    ok(await h.bookmarkUpsert({ ...BOOK_INPUT, kind: 'page', ayahId: 255, layout: 'v2', page: 42 }))
    await paint(260, 263, 'yellow')
    ok(await h.noteUpsert({ ...NOTE, fromAyahId: 250, toAyahId: 300 }))
    ok(await h.readingBookmarkSet({ ayahId: 262, layout: 'v2', page: 42 }))
    const m = ok(await h.userMarks('v2', 255, 264, [42]))
    expect(m.bookmarks.map((b) => b.ayahId)).toEqual([262])
    expect(m.pageBookmarks.map((p) => p.page)).toEqual([42])
    expect(m.highlights.map((x) => x.color)).toEqual(['yellow'])
    expect(m.notes).toHaveLength(1)
    expect(m.readingAyahId).toBe(262)
    expect(ok(await h.userMarks('v2', 1, 7, [1])).readingAyahId).toBeNull()
    expect(errKind(await h.userMarks('v2', 1, 7, [605]))).toBe('invalid_argument')
  })
})

describe('positions and history', () => {
  it('stores positions without an event', async () => {
    ok(
      await h.positionSet({
        context: 'audio',
        layout: null,
        page: null,
        ayahId: 2185,
        scrollPx: null,
        updatedAt: 0,
      }),
    )
    ok(
      await h.positionSet({
        context: 'mushaf',
        layout: 'v2',
        page: 297,
        ayahId: 2185,
        scrollPx: null,
        updatedAt: 0,
      }),
    )
    expect(state.user.value.positions.map((p) => p.context)).toEqual(['mushaf', 'audio'])
    expect(seen).toEqual([])
  })

  it('merges a visit to the same place within 10 minutes and keeps the newest on top', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_700_000_000_000)
    const visit = { mode: 'read' as const, layout: 'v2' as const, page: 297, ayahId: 2185, dwellS: 30 }
    ok(await h.historyRecord(visit))
    ok(await h.historyRecord({ ...visit, page: 298, ayahId: 2190 }))
    vi.setSystemTime(1_700_000_300_000)
    ok(await h.historyRecord({ ...visit, ayahId: 2186, dwellS: 45 }))
    let list = ok(await h.historyList(10, null))
    expect(list.map((e) => [e.page, e.dwellS, e.ayahId])).toEqual([
      [297, 75, 2186],
      [298, 30, 2190],
    ])
    vi.setSystemTime(1_700_001_000_000)
    ok(await h.historyRecord(visit))
    list = ok(await h.historyList(10, null))
    expect(list).toHaveLength(3)
    const older = ok(await h.historyList(10, list[0]?.id ?? null))
    expect(older).toHaveLength(2)
    expect(ok(await h.historyList(0, null))).toEqual([])
    ok(await h.historyClear())
    expect(ok(await h.historyList(10, null))).toEqual([])
    expect(seen).toContainEqual(['history'])
  })

  it('keeps at most 10,000 entries', async () => {
    state.user.update((u) => {
      u.history = Array.from({ length: HISTORY_MAX_ENTRIES }, (_, i) => ({
        id: i + 1,
        at: 1,
        mode: 'read' as const,
        layout: 'v2' as const,
        page: 1,
        ayahId: 1,
        dwellS: 1,
      }))
      u.nextHistoryId = HISTORY_MAX_ENTRIES + 1
    })
    ok(await h.historyRecord({ mode: 'listen', layout: null, page: null, ayahId: 5, dwellS: 3 }))
    expect(state.user.value.history).toHaveLength(HISTORY_MAX_ENTRIES)
    expect(state.user.value.history.some((e) => e.id === 1)).toBe(false)
  })
})

describe('transactions', () => {
  it('leaves the slice untouched when a mutation fails', async () => {
    const before = structuredClone(state.user.value)
    const t = await h.bookmarkUpsert({ ...BOOK_INPUT, tagIds: ['missing-tag'] })
    expect(errKind(t)).toBe('not_found')
    expect(state.user.value).toEqual(before)
    expect(seen).toEqual([])
  })
})

/**
 * `library` store: bookmarks, highlights, notes, collections, tags, the reading bookmark, the page-marks cache and the
 * 20-deep undo/redo stacks. Layer L1 (imports L0 stores only: `quran`, `i18n`, `ui`).
 *
 * **Lists.** `loadAll()` (started by `init`) loads every list; afterwards each list is re-read from the backend after
 * every change this store makes, and whenever `user-data-changed` names it (another surface, a picker, a second
 * window). Reads are sequenced per list, so a slow answer never overwrites a newer one. A re-read that brings nothing
 * new keeps the old array, so surfaces that depend on a list (the highlight layer, the margin marks) only refresh when
 * something did change.
 *
 * **Mutations** run one at a time, in call order, after the first load (undo needs the lists). Each one:
 * 1. calls the command and applies its answer locally at once (bookmarks, notes, the reading bookmark);
 * 2. re-reads the affected lists, so the store matches the backend when the returned promise settles;
 * 3. pushes an undo entry and shows an undo toast naming the change ("Bookmarked Al-Baqarah 2:255").
 *
 * Mutations never reject: a failure is shown with `ui.toastError` (the localised `errors.<kind>`) and the promise
 * resolves `null` (or `false`). Callers may still attach `.catch()`; it never fires.
 *
 * **Undo** covers bookmark toggles, deletes, page bookmarks and labels, the reading bookmark (undoing a first set
 * clears it), highlight set, clear and delete, note create, edit and delete, collection membership and tags. Before
 * `setHighlight` the store snapshots the highlights overlapping `[from, to]` from its own list; undo clears the range and
 * re-applies the snapshot (restoring a tombstoned row keeps its id and tags, re-setting a trimmed one merges it back),
 * so no contract change is needed. `Mod+Z` / `Mod+Shift+Z` and the toasts' Undo / Redo call `undo()` / `redo()`.
 */
import type { Store } from '$lib/contracts/stores'
import { api, call, events, IpcError } from '$lib/ipc'
import type {
  Bookmark,
  Bootstrap,
  Collection,
  Highlight,
  HighlightColor,
  MushafLayout,
  Note,
  NoteInput,
  ReadingBookmark,
  Tag,
  TaggableKind,
  UserDataKind,
  UserMarks,
} from '$lib/ipc/bindings'
import { listenEvent } from './app.svelte'
import { i18n } from './i18n.svelte'
import { quran } from './quran.svelte'
import { ui } from './ui.svelte'

/** One reversible library change. `label` is what its toast said. */
export interface UndoEntry {
  label: string
  undo: () => Promise<void>
  redo: () => Promise<void>
}

/** The lists this store keeps. */
export type ListKind = 'bookmarks' | 'highlights' | 'notes' | 'collections' | 'tags'

/** Where the first load stands: panels show skeletons while `loading` and a retry card on `error`. */
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

/** The highlight colours in their shortcut order (`1`…`5`). */
export const HIGHLIGHT_COLORS = [
  'yellow',
  'green',
  'blue',
  'red',
  'purple',
] as const satisfies readonly HighlightColor[]

/** Depth of each of the undo and redo stacks. */
export const UNDO_DEPTH = 20
/** Most bookmarks and notes listed (a personal library stays far below; the panels virtualise). */
export const LIST_LIMIT = 10_000
/** Cached `user_marks` answers (a spread asks once per page). */
export const MARKS_CACHE_SIZE = 48
/** Changes announced by `user-data-changed` within this window are re-read together. */
const EVENT_COALESCE_MS = 30

const LIST_KINDS: readonly ListKind[] = ['bookmarks', 'highlights', 'notes', 'collections', 'tags']
/** Lists whose changes alter the page marks (`user_marks`). */
const MARK_KINDS: ReadonlySet<UserDataKind> = new Set([
  'bookmarks',
  'highlights',
  'notes',
  'reading_bookmark',
])

const isListKind = (k: UserDataKind): k is ListKind => (LIST_KINDS as readonly string[]).includes(k)

/** An ayah-id range (`from ≤ to`). */
export interface AyahSpan {
  from: number
  to: number
}

/** The part of a highlight undo needs: the range, the colour and the id (to restore it with its tags). */
type HighlightRow = Pick<Highlight, 'id' | 'fromAyahId' | 'toAyahId' | 'color'>

/** The row type of each list. */
interface Lists {
  bookmarks: Bookmark[]
  highlights: Highlight[]
  notes: Note[]
  collections: Collection[]
  tags: Tag[]
}

/** Whether two reads of a list hold the same rows (the DTOs are plain JSON). */
function sameRows(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a === b || (a.length === b.length && JSON.stringify(a) === JSON.stringify(b))
}

class LibraryStore implements Store {
  bookmarks = $state.raw<Bookmark[]>([])
  highlights = $state.raw<Highlight[]>([])
  notes = $state.raw<Note[]>([])
  collections = $state.raw<Collection[]>([])
  tags = $state.raw<Tag[]>([])
  readingBookmark = $state.raw<ReadingBookmark | null>(null)
  /**
   * `user_marks` answers by `layout|pages|from-to`. A cache, deliberately not reactive: surfaces re-ask `marksFor`
   * when the lists change (or on `user-data-changed`), and the cache is emptied before they do.
   */
  readonly marks = new Map<string, UserMarks>()
  undoStack = $state.raw<UndoEntry[]>([])
  redoStack = $state.raw<UndoEntry[]>([])
  /** The first `loadAll()`. */
  status = $state<LoadStatus>('idle')

  /** Ayahs with a live ayah bookmark. */
  readonly bookmarkedAyahs: Set<number> = $derived(
    new Set(this.bookmarks.filter((b) => b.kind === 'ayah').map((b) => b.ayahId)),
  )
  /** Ayahs covered by at least one note. */
  readonly notedAyahs: Set<number> = $derived.by(() => {
    const ids: number[] = []
    for (const n of this.notes) for (let a = n.fromAyahId; a <= n.toAyahId; a++) ids.push(a)
    return new Set(ids)
  })
  readonly canUndo = $derived(this.undoStack.length > 0)
  readonly canRedo = $derived(this.redoStack.length > 0)

  readonly #ayahBookmarks = $derived(
    new Map(this.bookmarks.filter((b) => b.kind === 'ayah').map((b) => [b.ayahId, b] as const)),
  )
  readonly #collectionsById = $derived(new Map(this.collections.map((c) => [c.id, c] as const)))
  readonly #tagsById = $derived(new Map(this.tags.map((t) => [t.id, t] as const)))

  /** Per-list read sequence: only the newest read of a list is applied. */
  #seq: Record<ListKind, number> = { bookmarks: 0, highlights: 0, notes: 0, collections: 0, tags: 0 }
  #marksEpoch = 0
  #marksInflight = new Map<string, Promise<UserMarks>>()
  /** Mutations, undo and redo run one at a time in this chain. */
  #queue: Promise<unknown> = Promise.resolve()
  /** Settles when the first load has finished (successfully or not). */
  #ready: Promise<void> = Promise.resolve()
  #pendingKinds = new Set<ListKind>()
  #ribbonPending = false
  /** Ribbon read sequence: a local move outdates a read in flight. */
  #ribbonSeq = 0
  #flushTimer: ReturnType<typeof setTimeout> | undefined
  /** The toast that offers Undo for the newest entry, and the one that offers Redo. */
  #undoToast: { entry: UndoEntry; id: number } | null = null
  #redoToast: number | null = null
  #disposers: (() => void)[] = []

  init(b: Bootstrap): void {
    this.#dispose()
    this.readingBookmark = b.readingBookmark
    this.#disposers.push(listenEvent(events.userDataChanged, ({ kinds }) => this.#onChanged(kinds)))
    this.#ready = this.loadAll()
  }

  // --- reading ---------------------------------------------------------------------------------------------------------

  /** Loads every list (the panels' first paint). Never rejects: a failure sets `status = 'error'`. */
  async loadAll(): Promise<void> {
    if (this.status !== 'ready') this.status = 'loading'
    try {
      await this.#refresh(LIST_KINDS)
      this.status = 'ready'
    } catch (e) {
      console.warn('[qd] the library could not be loaded', e)
      if (this.status !== 'ready') this.status = 'error'
    }
  }

  /**
   * The marks of a page set (the marks query): bookmarks, page bookmarks, highlights, notes and the reading ribbon
   * within `[from, to]` and `pages`. Cached until the library changes; concurrent asks share one request. Rejects with
   * the command's `IpcError`.
   */
  async marksFor(layout: MushafLayout, pages: number[], from: number, to: number): Promise<UserMarks | null> {
    const sorted = [...new Set(pages)].sort((a, b) => a - b)
    const key = `${layout}|${sorted.join(',')}|${from}-${to}`
    const hit = this.marks.get(key)
    if (hit) {
      // Refresh the entry's place in the LRU order.
      this.marks.delete(key)
      this.marks.set(key, hit)
      return hit
    }
    const pending = this.#marksInflight.get(key)
    if (pending) return pending
    const epoch = this.#marksEpoch
    const request = call(api.userMarks(layout, from, to, sorted))
      .then((m) => {
        if (epoch === this.#marksEpoch) {
          this.marks.set(key, m)
          while (this.marks.size > MARKS_CACHE_SIZE) {
            const oldest = this.marks.keys().next()
            if (oldest.done) break
            this.marks.delete(oldest.value)
          }
        }
        return m
      })
      .finally(() => {
        if (this.#marksInflight.get(key) === request) this.#marksInflight.delete(key)
      })
    this.#marksInflight.set(key, request)
    return request
  }

  /** The live ayah bookmark of an ayah. */
  bookmarkOf(ayahId: number): Bookmark | undefined {
    return this.#ayahBookmarks.get(ayahId)
  }

  /** The live page bookmark of a page in a layout. */
  pageBookmark(layout: MushafLayout, page: number): Bookmark | undefined {
    return this.bookmarks.find((b) => b.kind === 'page' && b.layout === layout && b.page === page)
  }

  /** The highlight that covers an ayah (highlights never overlap). */
  highlightAt(ayahId: number): Highlight | undefined {
    return this.highlights.find((h) => ayahId >= h.fromAyahId && ayahId <= h.toAyahId)
  }

  /**
   * The note to edit for a target: one with exactly this range, else (for a single ayah) the most recent note that
   * covers it.
   */
  noteFor(from: number, to: number = from): Note | undefined {
    const exact = this.notes.find((n) => n.fromAyahId === from && n.toAyahId === to)
    if (exact || from !== to) return exact
    return this.notes.find((n) => from >= n.fromAyahId && from <= n.toAyahId)
  }

  collection(id: string): Collection | undefined {
    return this.#collectionsById.get(id)
  }

  tag(id: string): Tag | undefined {
    return this.#tagsById.get(id)
  }

  // --- bookmarks -------------------------------------------------------------------------------------------------------

  /** `B`: bookmarks the ayah, or removes its bookmark. Resolves whether it is bookmarked now. */
  toggleBookmark(ayahId: number): Promise<boolean | null> {
    return this.#mutation(async () => {
      const r = await call(api.bookmarkToggleAyah(ayahId))
      const id = r.bookmark.id
      this.#patchBookmark(r.bookmark, r.active)
      await this.#refreshAfter('bookmarks')
      const ref = this.#ref(ayahId)
      const set = async (on: boolean) => {
        this.#patchBookmark(await call(on ? api.bookmarkRestore(id) : api.bookmarkDelete(id)), on)
        await this.#refreshAfter('bookmarks')
      }
      this.#record(i18n.t(r.active ? 'library.toast.bookmarked' : 'library.toast.unbookmarked', { ref }), {
        undo: () => set(!r.active),
        redo: () => set(r.active),
      })
      return r.active
    })
  }

  /** Bookmarks a page of a layout (the dog-ear), or removes its bookmark. Resolves whether it is bookmarked now. */
  bookmarkPage(layout: MushafLayout, page: number): Promise<boolean | null> {
    return this.#mutation(async () => {
      const existing = this.pageBookmark(layout, page)
      const pageLabel = i18n.num(page)
      if (existing) {
        await this.#deleteBookmarkNow(existing, i18n.t('library.toast.pageUnbookmarked', { page: pageLabel }))
        return false
      }
      const first = quran.pageRange(layout, page).from
      const created = await call(
        api.bookmarkUpsert({
          id: null,
          kind: 'page',
          ayahId: first > 0 ? first : 1,
          layout,
          page,
          label: null,
          collectionIds: [],
          tagIds: [],
        }),
      )
      this.#patchBookmark(created, true)
      await this.#refreshAfter('bookmarks')
      const set = async (on: boolean) => {
        this.#patchBookmark(
          await call(on ? api.bookmarkRestore(created.id) : api.bookmarkDelete(created.id)),
          on,
        )
        await this.#refreshAfter('bookmarks')
      }
      this.#record(i18n.t('library.toast.pageBookmarked', { page: pageLabel }), {
        undo: () => set(false),
        redo: () => set(true),
      })
      return true
    })
  }

  /** Deletes a bookmark (the bookmark item's Delete). */
  deleteBookmark(id: string): Promise<boolean> {
    return this.#mutation(async () => {
      const b = this.bookmarks.find((x) => x.id === id)
      if (!b) return false
      const label =
        b.kind === 'page' && b.page !== null
          ? i18n.t('library.toast.pageUnbookmarked', { page: i18n.num(b.page) })
          : i18n.t('library.toast.unbookmarked', { ref: this.#ref(b.ayahId) })
      await this.#deleteBookmarkNow(b, label)
      return true
    }).then((r) => r === true)
  }

  /** Sets or clears a bookmark's label (the bookmark item's "Edit label"). */
  setBookmarkLabel(id: string, label: string | null): Promise<Bookmark | null> {
    return this.#mutation(async () => {
      const before = this.bookmarks.find((b) => b.id === id)
      if (!before) return null
      const write = async (value: string | null) => {
        const saved = await call(
          api.bookmarkUpsert({
            id,
            kind: before.kind,
            ayahId: before.ayahId,
            layout: before.layout,
            page: before.page,
            label: value,
            collectionIds: this.bookmarks.find((b) => b.id === id)?.collectionIds ?? before.collectionIds,
            tagIds: this.bookmarks.find((b) => b.id === id)?.tagIds ?? before.tagIds,
          }),
        )
        this.#patchBookmark(saved, true)
        await this.#refreshAfter('bookmarks')
        return saved
      }
      const saved = await write(label)
      if ((saved.label ?? null) === (before.label ?? null)) return saved
      const ref = this.#bookmarkRef(saved)
      this.#record(
        i18n.t(saved.label === null ? 'library.toast.labelCleared' : 'library.toast.labelSaved', { ref }),
        {
          undo: async () => void (await write(before.label)),
          redo: async () => void (await write(saved.label)),
        },
      )
      return saved
    })
  }

  // --- the reading bookmark --------------------------------------------------------------------------------------------

  /** `Shift+B`: moves the reading bookmark (the ribbon) to an ayah. Undoing a first set removes it. */
  moveReadingBookmark(ayahId: number, layout: MushafLayout, page: number): Promise<ReadingBookmark | null> {
    return this.#mutation(async () => {
      const ref = this.#ref(ayahId)
      const current = this.readingBookmark
      if (current && current.ayahId === ayahId && current.layout === layout && current.page === page) {
        ui.toast({ message: i18n.t('library.toast.readingAlready', { ref }) })
        return current
      }
      const move = await call(api.readingBookmarkSet({ ayahId, layout, page }))
      this.#setRibbon(move.current)
      const previous = move.previous
      const target = { ayahId: move.current.ayahId, layout: move.current.layout, page: move.current.page }
      this.#record(i18n.t(previous ? 'library.toast.readingMoved' : 'library.toast.readingPlaced', { ref }), {
        undo: async () => {
          if (previous) {
            const back = await call(
              api.readingBookmarkSet({
                ayahId: previous.ayahId,
                layout: previous.layout,
                page: previous.page,
              }),
            )
            this.#setRibbon(back.current)
          } else {
            await call(api.readingBookmarkClear())
            this.#setRibbon(null)
          }
        },
        redo: async () => {
          this.#setRibbon((await call(api.readingBookmarkSet(target))).current)
        },
      })
      return move.current
    })
  }

  // --- highlights ------------------------------------------------------------------------------------------------------

  /** `1`…`5`: highlights `[from, to]`; overlapping highlights are trimmed or replaced. */
  setHighlight(from: number, to: number, color: HighlightColor): Promise<Highlight | null> {
    const span = this.#span(from, to)
    return this.#mutation(async () => {
      const ref = this.#ref(span.from, span.to)
      const colorWord = i18n.t(`library.colorWords.${color}`)
      const before = this.#overlapping(span)
      if (this.#covered(span, color, before)) {
        ui.toast({ message: i18n.t('library.toast.alreadyHighlighted', { ref, color: colorWord }) })
        return this.highlightAt(span.from) ?? null
      }
      let snapshot: HighlightRow[] = before
      const apply = async () => {
        const saved = await call(api.highlightSet({ fromAyahId: span.from, toAyahId: span.to, color }))
        await this.#refreshAfter('highlights')
        return saved
      }
      const saved = await apply()
      const replaced = [...new Set(before.filter((h) => h.color !== color).map((h) => h.color))]
      const label =
        replaced.length === 0
          ? i18n.t('library.toast.highlighted', { ref, color: colorWord })
          : replaced.length === 1 && replaced[0] !== undefined
            ? i18n.t('library.toast.highlightedReplaced', {
                ref,
                color: colorWord,
                previous: i18n.t(`library.colorWords.${replaced[0]}`),
              })
            : i18n.t('library.toast.highlightedReplacedMany', { ref, color: colorWord })
      this.#record(label, {
        undo: async () => {
          await call(api.highlightClearRange(span.from, span.to))
          await this.#reapply(snapshot)
          await this.#refreshAfter('highlights')
        },
        redo: async () => {
          snapshot = this.#overlapping(span)
          await apply()
        },
      })
      return saved
    })
  }

  /** `0`: removes every highlight from `[from, to]` (trimming ranges that reach beyond it). */
  clearHighlight(from: number, to: number): Promise<boolean> {
    const span = this.#span(from, to)
    return this.#mutation(async () => {
      const ref = this.#ref(span.from, span.to)
      if (this.#overlapping(span).length === 0) {
        ui.toast({ message: i18n.t('library.toast.noHighlight', { ref }) })
        return false
      }
      let removed: HighlightRow[] = []
      const clear = async () => {
        removed = (await call(api.highlightClearRange(span.from, span.to))).map(rowOf)
        await this.#refreshAfter('highlights')
      }
      await clear()
      this.#record(i18n.t('library.toast.unhighlighted', { ref }), {
        undo: async () => {
          await this.#reapply(removed)
          await this.#refreshAfter('highlights')
        },
        redo: clear,
      })
      return true
    }).then((r) => r === true)
  }

  /** Deletes one highlight row (the Highlights panel's Remove). */
  deleteHighlight(id: string): Promise<boolean> {
    return this.#mutation(async () => {
      const h = this.highlights.find((x) => x.id === id)
      if (!h) return false
      const set = async (on: boolean) => {
        await call(on ? api.highlightRestore(id) : api.highlightDelete(id))
        await this.#refreshAfter('highlights')
      }
      await set(false)
      this.#record(
        i18n.t('library.toast.highlightDeleted', {
          ref: this.#ref(h.fromAyahId, h.toAyahId),
          color: i18n.t(`library.colorWords.${h.color}`),
        }),
        { undo: () => set(true), redo: () => set(false) },
      )
      return true
    }).then((r) => r === true)
  }

  // --- notes -----------------------------------------------------------------------------------------------------------

  /**
   * Creates (`id: null`) or updates a note (the note editor). Resolves the stored note, or `null` after an error
   * toast (the editor keeps its draft then).
   */
  saveNote(input: NoteInput): Promise<Note | null> {
    return this.#mutation(async () => {
      const previous = input.id === null ? undefined : this.notes.find((n) => n.id === input.id)
      const saved = await call(api.noteUpsert(input))
      this.#patchNote(saved, true)
      await this.#refreshAfter('notes')
      const ref = this.#ref(saved.fromAyahId, saved.toAyahId)
      if (input.id === null) {
        const set = async (on: boolean) => {
          this.#patchNote(await call(on ? api.noteRestore(saved.id) : api.noteDelete(saved.id)), on)
          await this.#refreshAfter('notes')
        }
        this.#record(i18n.t('library.toast.noteAdded', { ref }), {
          undo: () => set(false),
          redo: () => set(true),
        })
      } else if (previous) {
        const write = async (n: Note) => {
          this.#patchNote(
            await call(
              api.noteUpsert({
                id: n.id,
                fromAyahId: n.fromAyahId,
                toAyahId: n.toAyahId,
                title: n.title,
                body: n.body,
                tagIds: n.tagIds,
              }),
            ),
            true,
          )
          await this.#refreshAfter('notes')
        }
        this.#record(i18n.t('library.toast.noteSaved', { ref }), {
          undo: () => write(previous),
          redo: () => write(saved),
        })
      }
      return saved
    })
  }

  /** Deletes a note (undo restores it). */
  deleteNote(id: string): Promise<boolean> {
    return this.#mutation(async () => {
      const note = this.notes.find((n) => n.id === id) ?? (await call(api.noteGet(id)))
      const set = async (on: boolean) => {
        this.#patchNote(await call(on ? api.noteRestore(id) : api.noteDelete(id)), on)
        await this.#refreshAfter('notes')
      }
      await set(false)
      this.#record(i18n.t('library.toast.noteDeleted', { ref: this.#ref(note.fromAyahId, note.toAyahId) }), {
        undo: () => set(true),
        redo: () => set(false),
      })
      return true
    }).then((r) => r === true)
  }

  // --- collections and tags --------------------------------------------------------------------------------------------

  /** Makes a bookmark's collections exactly `collectionIds` (the collections picker). */
  setCollections(bookmarkId: string, collectionIds: string[]): Promise<Bookmark | null> {
    return this.#mutation(() => this.#setCollectionsNow(bookmarkId, collectionIds))
  }

  async #setCollectionsNow(bookmarkId: string, collectionIds: string[]): Promise<Bookmark | null> {
    const before = this.bookmarks.find((b) => b.id === bookmarkId)
    if (!before) return null
    const write = async (ids: string[]) => {
      const saved = await call(api.collectionSetMembership(bookmarkId, ids))
      this.#patchBookmark(saved, true)
      await this.#refreshAfter('bookmarks', 'collections')
      return saved
    }
    const saved = await write(collectionIds)
    const added = saved.collectionIds.filter((c) => !before.collectionIds.includes(c))
    const removed = before.collectionIds.filter((c) => !saved.collectionIds.includes(c))
    if (added.length === 0 && removed.length === 0) return saved
    const ref = this.#bookmarkRef(saved)
    const name = (id: string | undefined) => (id === undefined ? '' : (this.collection(id)?.name ?? ''))
    const label =
      added.length === 1 && removed.length === 0
        ? i18n.t('library.toast.addedToCollection', { ref, collection: name(added[0]) })
        : removed.length === 1 && added.length === 0
          ? i18n.t('library.toast.removedFromCollection', { ref, collection: name(removed[0]) })
          : i18n.t('library.toast.collectionsChanged', { ref })
    const previous = [...before.collectionIds]
    const next = [...saved.collectionIds]
    this.#record(label, {
      undo: async () => void (await write(previous)),
      redo: async () => void (await write(next)),
    })
    return saved
  }

  /**
   * Adds an ayah to a collection, or takes it out (the context menu's "Add to collection"). An ayah without a
   * bookmark gets one, in that collection (undo removes it again). Resolves whether the ayah is in the collection now.
   */
  toggleCollection(ayahId: number, collectionId: string): Promise<boolean | null> {
    return this.#mutation(async () => {
      const existing = this.bookmarkOf(ayahId)
      if (existing) {
        const inside = existing.collectionIds.includes(collectionId)
        const next = inside
          ? existing.collectionIds.filter((c) => c !== collectionId)
          : [...existing.collectionIds, collectionId]
        const saved = await this.#setCollectionsNow(existing.id, next)
        return saved === null ? null : saved.collectionIds.includes(collectionId)
      }
      const created = await call(
        api.bookmarkUpsert({
          id: null,
          kind: 'ayah',
          ayahId,
          layout: null,
          page: null,
          label: null,
          collectionIds: [collectionId],
          tagIds: [],
        }),
      )
      this.#patchBookmark(created, true)
      await this.#refreshAfter('bookmarks', 'collections')
      const set = async (on: boolean) => {
        this.#patchBookmark(
          await call(on ? api.bookmarkRestore(created.id) : api.bookmarkDelete(created.id)),
          on,
        )
        await this.#refreshAfter('bookmarks', 'collections')
      }
      this.#record(
        i18n.t('library.toast.addedToCollection', {
          ref: this.#ref(ayahId),
          collection: this.collection(collectionId)?.name ?? '',
        }),
        { undo: () => set(false), redo: () => set(true) },
      )
      return true
    })
  }

  /** Creates a collection, last in the order. Not undoable (there is no restore command); delete it instead. */
  createCollection(name: string, color: string | null = null): Promise<Collection | null> {
    return this.#mutation(async () => {
      const sortKey = this.collections.reduce((max, c) => Math.max(max, c.sortKey + 1), 0)
      const created = await call(api.collectionUpsert({ id: null, name, color, sortKey }))
      await this.#refreshAfter('collections')
      ui.toast({
        message: i18n.t('library.toast.collectionCreated', { name: created.name }),
        tone: 'success',
      })
      return created
    })
  }

  /** Renames (and recolours) a collection. */
  renameCollection(id: string, name: string, color?: string | null): Promise<Collection | null> {
    return this.#mutation(async () => {
      const c = this.collection(id)
      if (!c) return null
      const saved = await call(
        api.collectionUpsert({ id, name, color: color === undefined ? c.color : color, sortKey: c.sortKey }),
      )
      await this.#refreshAfter('collections', 'bookmarks')
      return saved
    })
  }

  /** Deletes a collection; its bookmarks stay. Not undoable (the UI confirms first). */
  deleteCollection(id: string): Promise<boolean> {
    return this.#mutation(async () => {
      const name = this.collection(id)?.name ?? ''
      await call(api.collectionDelete(id))
      await this.#refreshAfter('collections', 'bookmarks')
      ui.toast({ message: i18n.t('library.toast.collectionDeleted', { name }) })
      return true
    }).then((r) => r === true)
  }

  /** A tag by name: the existing one (case-insensitive) or a new one (get-or-create). */
  createTag(name: string, color: string | null = null): Promise<Tag | null> {
    return this.#mutation(async () => {
      const tag = await call(api.tagUpsert({ id: null, name, color }))
      await this.#refreshAfter('tags')
      return tag
    })
  }

  /** Makes an item's tags exactly `tagIds` (the tag picker). */
  setTags(kind: TaggableKind, itemId: string, tagIds: string[]): Promise<boolean> {
    return this.#mutation(async () => {
      const item = this.#taggable(kind, itemId)
      const previous = item ? [...item.tagIds] : []
      const list = kind === 'bookmark' ? 'bookmarks' : kind === 'note' ? 'notes' : 'highlights'
      const write = async (ids: string[]) => {
        await call(api.itemTagsSet(kind, itemId, ids))
        await this.#refreshAfter(list, 'tags')
      }
      await write(tagIds)
      const next = [...(this.#taggable(kind, itemId)?.tagIds ?? tagIds)]
      if (sameIds(previous, next)) return true
      this.#record(i18n.t('library.toast.tagsChanged', { ref: item ? this.#itemRef(kind, item) : '' }), {
        undo: () => write(previous),
        redo: () => write(next),
      })
      return true
    }).then((r) => r === true)
  }

  // --- undo and redo ---------------------------------------------------------------------------------------------------

  /** `Mod+Z` and the undo toasts: reverts the newest change. Resolves whether something was undone. */
  undo(): Promise<boolean> {
    return this.#serial(async () => {
      const entry = this.undoStack.at(-1)
      if (!entry) {
        ui.toast({ message: i18n.t('library.undo.nothingToUndo') })
        return false
      }
      this.undoStack = this.undoStack.slice(0, -1)
      this.#dismissUndoToast()
      try {
        await entry.undo()
      } catch (e) {
        // The entry's state is unknown now: it is dropped rather than offered again.
        ui.toastError(e)
        return false
      }
      this.redoStack = [...this.redoStack, entry].slice(-UNDO_DEPTH)
      this.#dismissRedoToast()
      this.#redoToast = ui.toast({
        message: i18n.t('library.undo.undone', { change: entry.label }),
        action: { label: i18n.t('common.redo'), run: () => void this.redo() },
      })
      return true
    })
  }

  /** `Mod+Shift+Z` and the "Undone" toasts' Redo: re-applies the newest undone change. */
  redo(): Promise<boolean> {
    return this.#serial(async () => {
      const entry = this.redoStack.at(-1)
      if (!entry) {
        ui.toast({ message: i18n.t('library.undo.nothingToRedo') })
        return false
      }
      this.redoStack = this.redoStack.slice(0, -1)
      this.#dismissRedoToast()
      try {
        await entry.redo()
      } catch (e) {
        ui.toastError(e)
        return false
      }
      this.undoStack = [...this.undoStack, entry].slice(-UNDO_DEPTH)
      this.#showUndoToast(entry, i18n.t('library.undo.redone', { change: entry.label }))
      return true
    })
  }

  reset(): void {
    this.#dispose()
    clearTimeout(this.#flushTimer)
    this.#flushTimer = undefined
    this.#pendingKinds.clear()
    this.#ribbonPending = false
    this.#ribbonSeq++
    this.bookmarks = []
    this.highlights = []
    this.notes = []
    this.collections = []
    this.tags = []
    this.readingBookmark = null
    this.marks.clear()
    this.#marksInflight.clear()
    this.#marksEpoch++
    this.undoStack = []
    this.redoStack = []
    this.status = 'idle'
    this.#seq = { bookmarks: 0, highlights: 0, notes: 0, collections: 0, tags: 0 }
    this.#queue = Promise.resolve()
    this.#ready = Promise.resolve()
    this.#undoToast = null
    this.#redoToast = null
  }

  // --- internals -------------------------------------------------------------------------------------------------------

  #dispose(): void {
    for (const dispose of this.#disposers.splice(0)) dispose()
  }

  /** Runs `fn` after every earlier mutation, undo and redo has finished. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn)
    this.#queue = run.catch(() => undefined)
    return run
  }

  /** A mutation: serial, after the first load; a failure becomes an error toast and resolves `null`. */
  #mutation<T>(fn: () => Promise<T>): Promise<T | null> {
    return this.#serial(async () => {
      await this.#ready
      try {
        return await fn()
      } catch (e) {
        ui.toastError(e)
        return null
      }
    })
  }

  /** Pushes an undo entry (the redo stack is cleared by any new change) and shows its undo toast. */
  #record(label: string, ops: Pick<UndoEntry, 'undo' | 'redo'>): void {
    const entry: UndoEntry = { label, ...ops }
    this.undoStack = [...this.undoStack, entry].slice(-UNDO_DEPTH)
    if (this.redoStack.length > 0) this.redoStack = []
    this.#dismissRedoToast()
    this.#showUndoToast(entry, label)
  }

  #showUndoToast(entry: UndoEntry, message: string): void {
    const id = ui.toastUndo(message, () => this.#undoFromToast(entry))
    this.#undoToast = { entry, id }
  }

  /** The toast's Undo reverts its own change, which is the newest one while the toast shows. */
  #undoFromToast(entry: UndoEntry): Promise<boolean> {
    if (this.#undoToast?.entry === entry) this.#undoToast = null
    if (this.undoStack.at(-1) !== entry) return Promise.resolve(false)
    return this.undo()
  }

  #dismissUndoToast(): void {
    if (this.#undoToast) ui.dismissToast(this.#undoToast.id)
    this.#undoToast = null
  }

  #dismissRedoToast(): void {
    if (this.#redoToast !== null) ui.dismissToast(this.#redoToast)
    this.#redoToast = null
  }

  /** Re-reads lists from the backend. Each list applies only its newest read; unchanged content keeps its array. */
  async #refresh(kinds: Iterable<ListKind>): Promise<void> {
    await Promise.all([...new Set(kinds)].map((k) => this.#refreshList(k)))
  }

  async #refreshList(kind: ListKind): Promise<void> {
    const seq = ++this.#seq[kind]
    const latest = () => seq === this.#seq[kind]
    switch (kind) {
      case 'bookmarks': {
        const rows = await call(
          api.bookmarkList({ kind: null, collectionId: null, tagId: null, surah: null, limit: LIST_LIMIT }),
        )
        if (latest()) this.#assign('bookmarks', rows)
        return
      }
      case 'highlights': {
        const rows = await call(api.highlightList(null))
        if (latest()) this.#assign('highlights', rows)
        return
      }
      case 'notes': {
        const rows = await call(
          api.noteList({ fromAyahId: null, toAyahId: null, tagId: null, limit: LIST_LIMIT }),
        )
        if (latest()) this.#assign('notes', rows)
        return
      }
      case 'collections': {
        const rows = await call(api.collectionList())
        if (latest()) this.#assign('collections', rows)
        return
      }
      case 'tags': {
        const rows = await call(api.tagList())
        if (latest()) this.#assign('tags', rows)
        return
      }
    }
  }

  /**
   * After a local change: re-reads `kinds` (collections only when there are any, for their counts; tags likewise for
   * their usage), so the store matches the backend before the mutation resolves.
   */
  async #refreshAfter(...kinds: ListKind[]): Promise<void> {
    const wanted: ListKind[] = [...kinds]
    if (kinds.includes('bookmarks') && this.collections.length > 0) wanted.push('collections')
    if (kinds.some((k) => k !== 'collections' && k !== 'tags') && this.tags.length > 0) wanted.push('tags')
    await this.#refresh(wanted)
  }

  #assign<K extends ListKind>(kind: K, rows: Lists[K]): void {
    if (sameRows(this[kind], rows)) return
    if (kind === 'bookmarks' || kind === 'highlights' || kind === 'notes') this.#invalidateMarks()
    switch (kind) {
      case 'bookmarks':
        this.bookmarks = rows as Lists['bookmarks']
        break
      case 'highlights':
        this.highlights = rows as Lists['highlights']
        break
      case 'notes':
        this.notes = rows as Lists['notes']
        break
      case 'collections':
        this.collections = rows as Lists['collections']
        break
      case 'tags':
        this.tags = rows as Lists['tags']
        break
    }
  }

  /**
   * `user-data-changed`: re-reads the named lists together, shortly after. `positions` is named only by a backup
   * restore (`user_backup_restore` replaces the whole library), so it also forgets what was recorded for undo.
   */
  #onChanged(kinds: readonly UserDataKind[]): void {
    if (kinds.includes('positions')) this.#forgetHistory()
    if (kinds.some((k) => MARK_KINDS.has(k))) this.#invalidateMarks()
    for (const k of kinds) if (isListKind(k)) this.#pendingKinds.add(k)
    if (kinds.includes('reading_bookmark')) this.#ribbonPending = true
    if ((this.#pendingKinds.size === 0 && !this.#ribbonPending) || this.#flushTimer !== undefined) return
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined
      const pending = [...this.#pendingKinds]
      const ribbon = this.#ribbonPending
      this.#pendingKinds.clear()
      this.#ribbonPending = false
      Promise.all([this.#refresh(pending), ribbon ? this.#refreshRibbon() : undefined]).catch((e: unknown) =>
        console.warn('[qd] the library could not be refreshed', e),
      )
    }, EVENT_COALESCE_MS)
  }

  /**
   * The reading bookmark moved elsewhere (an event this store did not cause). No command reads the ribbon alone, so the
   * marks query over the whole Quran names its ayah; the page follows from the stored layout (else v2).
   */
  async #refreshRibbon(): Promise<void> {
    if (quran.ayahCount < 1) return
    const seq = ++this.#ribbonSeq
    const layout = this.readingBookmark?.layout ?? 'v2'
    const m = await call(api.userMarks(layout, 1, quran.ayahCount, []))
    if (seq !== this.#ribbonSeq) return
    const id = m.readingAyahId
    if (id === null) {
      if (this.readingBookmark !== null) this.#setRibbon(null)
      return
    }
    if (this.readingBookmark?.ayahId === id) return
    this.#setRibbon({
      ayahId: id,
      layout,
      page: quran.pageOfAyah(layout, id),
      updatedAt: Math.floor(Date.now() / 1000),
    })
  }

  /**
   * A restored library is another library: the undo and redo entries recorded against the one before it (inverses by
   * id or by range) would edit or delete restored rows. Both stacks go, with their toasts and the marks cache.
   */
  #forgetHistory(): void {
    this.undoStack = []
    this.redoStack = []
    this.#dismissUndoToast()
    this.#dismissRedoToast()
    this.#invalidateMarks()
  }

  #invalidateMarks(): void {
    this.#marksEpoch++
    this.#marksInflight.clear()
    this.marks.clear()
  }

  #setRibbon(rb: ReadingBookmark | null): void {
    this.#ribbonSeq++
    this.readingBookmark = rb
    this.#invalidateMarks()
  }

  /** Applies one bookmark row at once (before the re-read lands): replaced or added when live, removed otherwise. */
  #patchBookmark(b: Bookmark, live: boolean): void {
    const rest = this.bookmarks.filter((x) => x.id !== b.id)
    this.#assign('bookmarks', live ? [b, ...rest] : rest)
  }

  #patchNote(n: Note, live: boolean): void {
    const rest = this.notes.filter((x) => x.id !== n.id)
    this.#assign('notes', live ? [n, ...rest] : rest)
  }

  async #deleteBookmarkNow(b: Bookmark, label: string): Promise<void> {
    const set = async (on: boolean) => {
      this.#patchBookmark(await call(on ? api.bookmarkRestore(b.id) : api.bookmarkDelete(b.id)), on)
      await this.#refreshAfter('bookmarks')
    }
    await set(false)
    this.#record(label, { undo: () => set(true), redo: () => set(false) })
  }

  /** Live highlights overlapping a span, from the store's list (the undo snapshot), in mushaf order. */
  #overlapping(span: AyahSpan): HighlightRow[] {
    return this.highlights.filter((h) => h.fromAyahId <= span.to && h.toAyahId >= span.from).map(rowOf)
  }

  /** Whether `color` already covers every ayah of the span. */
  #covered(span: AyahSpan, color: HighlightColor, rows: readonly HighlightRow[]): boolean {
    const same = rows.filter((h) => h.color === color)
    return (
      same.length === 1 &&
      same[0] !== undefined &&
      same[0].fromAyahId <= span.from &&
      same[0].toAyahId >= span.to
    )
  }

  /**
   * Re-applies highlight rows as they were (undo of a set or a clear): a tombstoned row is restored with its id and tags;
   * a row that is still live (trimmed or split) is painted over its full range again, which merges the pieces back.
   */
  async #reapply(rows: readonly HighlightRow[]): Promise<void> {
    for (const row of rows) {
      let restored: Highlight | null = null
      try {
        restored = await call(api.highlightRestore(row.id))
      } catch (e) {
        // Purged meanwhile: painting the range below brings the colour back without the old id.
        if (!(e instanceof IpcError && e.kind === 'not_found')) throw e
      }
      const whole =
        restored !== null &&
        restored.color === row.color &&
        restored.fromAyahId <= row.fromAyahId &&
        restored.toAyahId >= row.toAyahId
      if (!whole) {
        await call(api.highlightSet({ fromAyahId: row.fromAyahId, toAyahId: row.toAyahId, color: row.color }))
      }
    }
  }

  #taggable(kind: TaggableKind, id: string): { tagIds: string[]; fromAyahId?: number } | undefined {
    if (kind === 'bookmark') return this.bookmarks.find((b) => b.id === id)
    if (kind === 'note') return this.notes.find((n) => n.id === id)
    return this.highlights.find((h) => h.id === id)
  }

  #itemRef(kind: TaggableKind, item: object): string {
    if (kind === 'bookmark') return this.#bookmarkRef(item as Bookmark)
    const span = item as { fromAyahId: number; toAyahId: number }
    return this.#ref(span.fromAyahId, span.toAyahId)
  }

  /** A clamped, ordered ayah span. */
  #span(from: number, to: number): AyahSpan {
    return { from: Math.min(from, to), to: Math.max(from, to) }
  }

  /** "Al-Baqarah 2:255" (or "Al-Baqarah 2:255–257"), bidi-isolated. */
  #ref(from: number, to?: number): string {
    return quran.refLabel(from, 'long', to !== undefined && to !== from ? to : undefined)
  }

  #bookmarkRef(b: Bookmark): string {
    return b.kind === 'page' && b.page !== null
      ? i18n.t('library.pageLabel', { page: i18n.num(b.page) })
      : this.#ref(b.ayahId)
  }
}

function rowOf(h: Highlight): HighlightRow {
  return { id: h.id, fromAyahId: h.fromAyahId, toAyahId: h.toAyahId, color: h.color }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id))
}

export const library = new LibraryStore()

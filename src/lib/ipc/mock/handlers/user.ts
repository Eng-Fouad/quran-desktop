/**
 * Mock handlers: user library and study data (§5.17). Owner: WP11c.
 *
 * The browser mock behaves like `quran-core`'s `UserDb` (§3.2; WP2a deviations 3–14, WP2b deviations 8–9 and 14) on the
 * `user` state slice, so the library store, the panels, the context menu and every surface that marks ayahs can be
 * built against it:
 *
 * - **Tombstones.** Deleting a bookmark, highlight or note moves it to `trash` and answers the row as it was; restoring
 *   brings it back with `updatedAt` bumped (a live row is answered unchanged, an unknown one is `not_found`). Lists and
 *   `note_get` see live rows only. Collections and tags are removed outright (there is no restore command for them), and
 *   their memberships and links go with them.
 * - **Bookmarks** are keyed by target: one live bookmark per ayah and per (layout, page). An upsert without an id on a
 *   held target updates that bookmark (the input wins); moving a bookmark onto another live bookmark's target, or
 *   restoring onto a taken target, is `invalid_argument`. `bookmark_toggle_ayah` tombstones a live ayah bookmark, else
 *   revives the most recently deleted one of that ayah (label, collections and tags), else creates one.
 * - **Highlights** never overlap, and two of the same colour never overlap or touch (WP2a deviation 6): `highlight_set`
 *   trims, splits (the left piece keeps its id) or tombstones other colours and merges same-colour neighbours into the
 *   earliest; painting inside a same-colour row writes nothing. `highlight_clear_range` answers the overlapping rows as
 *   they were, so re-setting them restores the colouring exactly. `highlight_restore` re-applies a row on top, keeping
 *   its id.
 * - **Text** is normalised like WP2a's: names, labels and titles are one line (whitespace runs collapsed, control
 *   characters dropped, trimmed); note bodies keep their lines; names ≤ 100, labels and titles ≤ 200 and bodies
 *   ≤ 100,000 characters; colours are tokens of ≤ 32 ASCII letters, digits, `#`, `-` and `_`; id lists are deduplicated
 *   and hold at most 100 ids. Tags are get-or-create by name (ASCII case-insensitive).
 * - **Order.** Bookmarks and notes: most recently updated first; highlights and marks: mushaf order; collections:
 *   `sortKey`, name, id; tags: name, id. `limit = 0` answers nothing.
 * - **History** merges a record of the same mode and place (layout + page, else the ayah) from the last 10 minutes into
 *   one entry at the top (dwell summed), keeps at most 10,000 entries and pages newest first (at most 1,000 per call).
 * - **Events.** Every successful mutation except `position_set` emits `user-data-changed` with the kinds whose lists or
 *   counts it can change (WP2a deviation 14).
 * - **Backups.** The mock has no disk: `user_backup_create` keeps the library (the `user` and `memo` slices and the
 *   settings) in memory under the path it answers, and `user_backup_restore` restores such a path like the real
 *   command: the current library is kept as a new backup first, then `settings-changed`, `user-data-changed` with
 *   every kind and `packs-changed` with every pack follow. Any other path is `not_found` (the file picker of the mock never answers one, §5.17).
 */
import {
  events,
  type Bookmark,
  type BookmarkFilter,
  type BookmarkInput,
  type BookmarkToggle,
  type Collection,
  type CollectionInput,
  type Highlight,
  type HighlightColor,
  type HighlightInput,
  type HistoryEntry,
  type HistoryInput,
  type MushafLayout,
  type Note,
  type NoteFilter,
  type NoteInput,
  type QuranIndex,
  type ReadingBookmark,
  type ReadingBookmarkInput,
  type ReadingBookmarkMove,
  type ReadingPosition,
  type Settings,
  type Tag,
  type TagInput,
  type TaggableKind,
  type UserDataKind,
  type UserMarks,
} from '../../bindings'
import { fixtures } from '../fixtures'
import { assertAyahRange, assertRange, type Handlers, handle, MockError, nowSecs } from '../result'
import { type MemoState, type SearchState, state, type UserState } from '../state'
import { AYAH_COUNT, PAGE_COUNT, refOf, syntheticIndex } from '../synthetic'

// --- limits (quran-core `user_db::tags`, `notes`, `history`) ----------------------------------------------------------

/** Longest tag or collection name, in characters. */
export const NAME_MAX_CHARS = 100
/** Longest bookmark label or note title, in characters. */
export const LABEL_MAX_CHARS = 200
/** Longest colour token, in characters. */
export const COLOR_MAX_CHARS = 32
/** Most tags on one item, and most collections one bookmark belongs to. */
export const MAX_LINKS = 100
/** Longest note body, in characters. */
export const BODY_MAX_CHARS = 100_000
/** Records of the same place within this window (seconds) are merged. */
export const HISTORY_DEDUPE_S = 10 * 60
/** Oldest history entries beyond this count are dropped. */
export const HISTORY_MAX_ENTRIES = 10_000
/** Upper bound of one `history_list` page. */
export const HISTORY_LIST_MAX = 1_000

const COLORS: ReadonlySet<string> = new Set(['yellow', 'green', 'blue', 'red', 'purple'])
const LAYOUTS: ReadonlySet<string> = new Set(['v2', 'v1', 'v4'])

// --- small helpers ----------------------------------------------------------------------------------------------------

let lastIdMs = 0
let idSeq = 0

/** A UUIDv7 string (time-ordered, like the real ids): 48-bit ms timestamp, version 7, variant 10, random bits. */
export function uuidv7(): string {
  const ms = Date.now()
  // Ids made in the same millisecond still sort in creation order (a 12-bit counter in `rand_a`).
  idSeq = ms === lastIdMs ? (idSeq + 1) & 0xfff : 0
  lastIdMs = ms
  const rand = new Uint8Array(8)
  crypto.getRandomValues(rand)
  const hex = (n: number, width: number) => n.toString(16).padStart(width, '0')
  const tail = [...rand].map((b) => hex(b, 2)).join('')
  const variant = (0x8 | ((rand[0] ?? 0) & 0x3)).toString(16)
  const time = hex(ms, 12)
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${hex(idSeq, 3)}-${variant}${tail.slice(1, 4)}-${tail.slice(4, 16)}`
}

function index(): QuranIndex {
  return fixtures.cachedIndex() ?? syntheticIndex()
}

function checkAyah(id: number, what: string): void {
  if (!Number.isInteger(id) || id < 1 || id > AYAH_COUNT) {
    throw new MockError('invalid_argument', `${what} ${id} is outside 1..=${AYAH_COUNT}`)
  }
}

function checkPage(page: number | null): void {
  if (page !== null) assertRange('page', page, 1, PAGE_COUNT)
}

function checkLayout(layout: MushafLayout): void {
  if (!LAYOUTS.has(layout)) throw new MockError('invalid_argument', `layout ${String(layout)} is unknown`)
}

/** Unicode-aware length in characters (code points), like Rust's `chars().count()`. */
const charCount = (s: string) => [...s].length

/** Control characters (Unicode `Cc`, Rust's `char::is_control`). */
const CONTROL = /\p{Cc}/gu

/** One line: whitespace runs (newlines and tabs too) become one space, control characters go, ends trimmed. */
export function singleLine(s: string): string {
  return s
    .split(/\s+/u)
    .map((word) => word.replace(CONTROL, ''))
    .filter((word) => word !== '')
    .join(' ')
}

function checkLen(s: string, max: number, what: string): void {
  if (charCount(s) > max) throw new MockError('invalid_argument', `${what} is longer than ${max} characters`)
}

/** An optional one-line field: blank is `null`; longer than `max` characters is `invalid_argument`. */
function optSingleLine(s: string | null, max: number, what: string): string | null {
  if (s === null) return null
  const line = singleLine(s)
  if (line === '') return null
  checkLen(line, max, what)
  return line
}

/** A required one-line name. */
function requiredName(s: string, max: number, what: string): string {
  const line = singleLine(s)
  if (line === '') throw new MockError('invalid_argument', `${what} is empty`)
  checkLen(line, max, what)
  return line
}

/** The stored form of a note body: line endings → `\n`, control characters other than `\n`/`\t` dropped, trimmed. */
export function cleanBody(body: string): string {
  return body
    .replace(/\r\n?/gu, '\n')
    .replace(/[^\P{Cc}\n\t]/gu, '')
    .trim()
}

/** An optional colour token: blank is `null`; otherwise ASCII letters, digits, `#`, `-`, `_`, at most 32. */
function cleanColor(color: string | null): string | null {
  const c = color?.trim() ?? ''
  if (c === '') return null
  if (c.length > COLOR_MAX_CHARS || !/^[A-Za-z0-9#_-]+$/u.test(c)) {
    throw new MockError(
      'invalid_argument',
      `colour ${JSON.stringify(c)} is not a token of at most ${COLOR_MAX_CHARS} letters, digits, '#', '-' or '_'`,
    )
  }
  return c
}

/** Ids in input order without duplicates, at most 100; a blank id is `invalid_argument`. */
function dedupeIds(ids: readonly string[], what: string): string[] {
  const out: string[] = []
  for (const id of ids) {
    if (id.trim() === '') throw new MockError('invalid_argument', `blank id in ${what}`)
    if (!out.includes(id)) out.push(id)
  }
  if (out.length > MAX_LINKS)
    throw new MockError('invalid_argument', `more than ${MAX_LINKS} ${what} on one item`)
  return out
}

/** SQLite `COLLATE NOCASE`: ASCII letters only. */
const nocase = (s: string) => s.replace(/[A-Z]/gu, (c) => c.toLowerCase())
const compareNocase = (a: string, b: string) => {
  const x = nocase(a)
  const y = nocase(b)
  return x < y ? -1 : x > y ? 1 : 0
}
const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function user(): UserState {
  return state.user.value
}

async function changed(kinds: readonly UserDataKind[]): Promise<void> {
  try {
    await events.userDataChanged.emit({ kinds: [...new Set(kinds)] })
  } catch (e) {
    console.error('[mock IPC] user-data-changed', e)
  }
}

/**
 * Runs a mutation as a transaction: `fn` edits a copy of the user slice, which replaces the slice (and is saved) only
 * when `fn` returns; a thrown error leaves the slice untouched, like a rolled-back SQLite transaction. Then emits
 * `user-data-changed` with `kinds` and answers a copy of the result.
 */
async function mutate<T>(kinds: readonly UserDataKind[], fn: (u: UserState) => T): Promise<T> {
  const draft = structuredClone(state.user.value)
  const out = fn(draft)
  state.user.set(draft)
  await changed(kinds)
  return structuredClone(out)
}

// --- tags and collections ---------------------------------------------------------------------------------------------

function liveTags(u: UserState): Map<string, Tag> {
  return new Map(u.tags.map((t) => [t.id, t] as const))
}

/** Tag ids in tag order (name, then id), live tags only. */
function orderTags(u: UserState, ids: readonly string[]): string[] {
  const tags = liveTags(u)
  return ids
    .filter((id) => tags.has(id))
    .sort((a, b) => {
      const x = tags.get(a)
      const y = tags.get(b)
      return (x && y ? compareNocase(x.name, y.name) : 0) || compareId(a, b)
    })
}

function compareCollections(a: Collection, b: Collection): number {
  return a.sortKey - b.sortKey || compareNocase(a.name, b.name) || compareId(a.id, b.id)
}

/** Collection ids in collection order, live collections only. */
function orderCollections(u: UserState, ids: readonly string[]): string[] {
  const live = new Map(u.collections.map((c) => [c.id, c] as const))
  return ids
    .filter((id) => live.has(id))
    .sort((a, b) => {
      const x = live.get(a)
      const y = live.get(b)
      return x && y ? compareCollections(x, y) : 0
    })
}

function requireLiveTags(u: UserState, ids: readonly string[]): void {
  const tags = liveTags(u)
  for (const id of ids) if (!tags.has(id)) throw new MockError('not_found', `tag ${id}`)
}

function requireLiveCollections(u: UserState, ids: readonly string[]): void {
  for (const id of ids) {
    if (!u.collections.some((c) => c.id === id)) throw new MockError('not_found', `collection ${id}`)
  }
}

function withCounts(u: UserState, c: Collection): Collection {
  return { ...c, itemCount: u.bookmarks.filter((b) => b.collectionIds.includes(c.id)).length }
}

function tagWithUsage(u: UserState, t: Tag): Tag {
  const uses = (items: readonly { tagIds: string[] }[]) => items.filter((i) => i.tagIds.includes(t.id)).length
  return { ...t, usageCount: uses(u.bookmarks) + uses(u.notes) + uses(u.highlights) }
}

type Taggable = Bookmark | Note | Highlight

function liveItem(u: UserState, kind: TaggableKind, id: string): Taggable {
  const list: readonly Taggable[] =
    kind === 'bookmark' ? u.bookmarks : kind === 'note' ? u.notes : u.highlights
  const item = list.find((i) => i.id === id)
  if (!item) throw new MockError('not_found', `${kind} ${id}`)
  return item
}

// --- bookmarks --------------------------------------------------------------------------------------------------------

type Target = { kind: 'ayah'; ayahId: number } | { kind: 'page'; layout: MushafLayout; page: number }

function targetOf(b: Pick<Bookmark, 'kind' | 'ayahId' | 'layout' | 'page'>): Target {
  if (b.kind === 'ayah') return { kind: 'ayah', ayahId: b.ayahId }
  if (b.layout === null || b.page === null) {
    throw new MockError('internal', 'a page bookmark without a layout or page')
  }
  return { kind: 'page', layout: b.layout, page: b.page }
}

function onTarget(b: Bookmark, t: Target): boolean {
  return t.kind === 'ayah'
    ? b.kind === 'ayah' && b.ayahId === t.ayahId
    : b.kind === 'page' && b.layout === t.layout && b.page === t.page
}

function describeTarget(t: Target): string {
  return t.kind === 'ayah' ? `ayah ${t.ayahId}` : `page ${t.page} of layout ${t.layout}`
}

function holderOf(u: UserState, t: Target): Bookmark | undefined {
  return u.bookmarks.find((b) => onTarget(b, t))
}

function liveBookmark(u: UserState, id: string): Bookmark {
  const b = u.bookmarks.find((x) => x.id === id)
  if (!b) throw new MockError('not_found', `bookmark ${id}`)
  return b
}

function compareRecent(a: { updatedAt: number; id: string }, b: { updatedAt: number; id: string }): number {
  return b.updatedAt - a.updatedAt || compareId(b.id, a.id)
}

interface ValidBookmark {
  target: Target
  ayahId: number
  label: string | null
  collectionIds: string[]
  tagIds: string[]
}

function validBookmark(input: BookmarkInput): ValidBookmark {
  checkAyah(input.ayahId, 'bookmark ayah')
  let target: Target
  if (input.kind === 'ayah') {
    target = { kind: 'ayah', ayahId: input.ayahId }
  } else {
    if (input.layout === null || input.page === null) {
      throw new MockError('invalid_argument', 'a page bookmark needs a layout and a page')
    }
    checkLayout(input.layout)
    checkPage(input.page)
    target = { kind: 'page', layout: input.layout, page: input.page }
  }
  return {
    target,
    ayahId: input.ayahId,
    label: optSingleLine(input.label, LABEL_MAX_CHARS, 'bookmark label'),
    collectionIds: dedupeIds(input.collectionIds, 'collections'),
    tagIds: dedupeIds(input.tagIds, 'tags'),
  }
}

function writeBookmark(u: UserState, b: Bookmark, v: ValidBookmark, now: number): void {
  const { surah, ayah } = refOf(index(), v.ayahId)
  b.kind = v.target.kind
  b.ayahId = v.ayahId
  b.surah = surah
  b.ayah = ayah
  b.layout = v.target.kind === 'page' ? v.target.layout : null
  b.page = v.target.kind === 'page' ? v.target.page : null
  b.label = v.label
  b.collectionIds = orderCollections(u, v.collectionIds)
  b.tagIds = orderTags(u, v.tagIds)
  b.updatedAt = now
}

/** A tombstoned row's links, cleaned of collections and tags deleted while it was in the trash. */
function relink<T extends Taggable>(u: UserState, row: T): T {
  const out = { ...row, tagIds: orderTags(u, row.tagIds) }
  if ('collectionIds' in out) out.collectionIds = orderCollections(u, out.collectionIds)
  return out
}

// --- highlights ---------------------------------------------------------------------------------------------------------

function compareMushaf(a: { fromAyahId: number; id: string }, b: { fromAyahId: number; id: string }): number {
  return a.fromAyahId - b.fromAyahId || compareId(a.id, b.id)
}

const overlaps = (from: number, to: number, a: number, b: number) => a <= to && b >= from

/** Live highlights that overlap or touch `[from, to]`, in mushaf order. */
function spansNear(u: UserState, from: number, to: number): Highlight[] {
  return u.highlights.filter((h) => overlaps(from - 1, to + 1, h.fromAyahId, h.toAyahId)).sort(compareMushaf)
}

function tombstoneHighlight(u: UserState, h: Highlight, now: number): void {
  u.highlights = u.highlights.filter((x) => x.id !== h.id)
  u.trash.highlights.push({ ...h, updatedAt: now })
}

/**
 * Removes `[from, to]` from every span that overlaps it: trims it, splits it in two (the right piece is a new row with
 * the same colour, `createdAt` and tags) or tombstones it. Returns the affected rows as they were.
 */
function cut(u: UserState, spans: readonly Highlight[], from: number, to: number, now: number): Highlight[] {
  const before: Highlight[] = []
  for (const s of spans) {
    if (!overlaps(from, to, s.fromAyahId, s.toAyahId)) continue
    before.push(structuredClone(s))
    const left = s.fromAyahId < from
    const right = s.toAyahId > to
    if (!left && !right) {
      tombstoneHighlight(u, s, now)
    } else if (left && right) {
      u.highlights.push({
        id: uuidv7(),
        fromAyahId: to + 1,
        toAyahId: s.toAyahId,
        color: s.color,
        tagIds: [...s.tagIds],
        createdAt: s.createdAt,
        updatedAt: now,
      })
      s.toAyahId = from - 1
      s.updatedAt = now
    } else if (left) {
      s.toAyahId = from - 1
      s.updatedAt = now
    } else {
      s.fromAyahId = to + 1
      s.updatedAt = now
    }
  }
  return before
}

/**
 * Paints `[from, to]` with `color` and returns the id of the row that covers it now: `keep` when given (a restored row,
 * live or in the trash), else the first same-colour neighbour, else a new row.
 */
function paint(
  u: UserState,
  from: number,
  to: number,
  color: HighlightColor,
  now: number,
  keep: string | null,
): string {
  const near = spansNear(u, from, to).filter((s) => s.id !== keep)
  const same = near.filter((s) => s.color === color)
  const other = near.filter((s) => s.color !== color)
  const cutRows = cut(u, other, from, to, now)
  const lo = Math.min(from, ...same.map((s) => s.fromAyahId))
  const hi = Math.max(to, ...same.map((s) => s.toAyahId))
  const first = same[0]
  let survivorId: string
  if (keep !== null) {
    survivorId = keep
  } else if (first) {
    if (same.length === 1 && cutRows.length === 0 && first.fromAyahId === lo && first.toAyahId === hi) {
      return first.id // painting inside a same-colour row: nothing changes
    }
    survivorId = first.id
  } else {
    const id = uuidv7()
    u.highlights.push({ id, fromAyahId: lo, toAyahId: hi, color, tagIds: [], createdAt: now, updatedAt: now })
    return id
  }
  let survivor = u.highlights.find((h) => h.id === survivorId)
  if (!survivor) {
    const trashed = u.trash.highlights.find((h) => h.id === survivorId)
    if (!trashed) throw new MockError('not_found', `highlight ${survivorId}`)
    u.trash.highlights = u.trash.highlights.filter((h) => h.id !== survivorId)
    survivor = relink(u, trashed)
    u.highlights.push(survivor)
  }
  const tags = new Set(survivor.tagIds)
  for (const absorbed of same) {
    if (absorbed.id === survivorId) continue
    for (const t of absorbed.tagIds) tags.add(t)
    tombstoneHighlight(u, absorbed, now)
  }
  survivor.fromAyahId = lo
  survivor.toAyahId = hi
  survivor.color = color
  survivor.tagIds = orderTags(u, [...tags])
  survivor.updatedAt = now
  return survivorId
}

function liveHighlight(u: UserState, id: string): Highlight {
  const h = u.highlights.find((x) => x.id === id)
  if (!h) throw new MockError('not_found', `highlight ${id}`)
  return h
}

function checkColor(color: string): asserts color is HighlightColor {
  if (!COLORS.has(color)) throw new MockError('invalid_argument', `highlight colour ${color} is unknown`)
}

// --- notes ---------------------------------------------------------------------------------------------------------------

function liveNote(u: UserState, id: string): Note {
  const n = u.notes.find((x) => x.id === id)
  if (!n) throw new MockError('not_found', `note ${id}`)
  return n
}

// --- history -------------------------------------------------------------------------------------------------------------

function samePlace(e: HistoryEntry, h: HistoryInput): boolean {
  return h.page !== null
    ? e.page === h.page && e.layout === h.layout
    : e.page === null && e.ayahId === h.ayahId
}

// --- backups -------------------------------------------------------------------------------------------------------------

const DATA_DIR = 'C:/mock/com.quran.labs.desktop'

/** A library as a backup holds it (the real backup is a copy of user.db: library, memorisation, settings). */
/** What a backup holds: the whole of user.db, so the search history too (Rust backs up the file). */
interface BackupImage {
  user: UserState
  memo: MemoState
  search: SearchState
  settings: Settings
}

/** The backups written this session, by the path `user_backup_create` answered. */
const backups = new Map<string, BackupImage>()

const ALL_USER_DATA: readonly UserDataKind[] = [
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
]

function libraryImage(): BackupImage {
  return structuredClone({
    user: user(),
    memo: state.memo.value,
    search: state.search.value,
    settings: state.settings.value,
  })
}

/** `user_backup_restore`'s source path rules (WP2b): absolute, an existing file. */
function restoreSource(src: string): BackupImage {
  const path = src.trim().replace(/\\/gu, '/')
  if (path === '') throw new MockError('invalid_argument', 'backup path is empty')
  if (!/^[A-Za-z]:\//u.test(path) && !path.startsWith('/'))
    throw new MockError('invalid_argument', `backup path ${src} is not absolute`)
  const image = backups.get(path)
  if (!image) throw new MockError('not_found', `backup ${src} does not exist`)
  return image
}

function backupName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const date = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`
  const time = `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  return `user-${date}-${time}Z.qdb`
}

/** WP2b deviation 14: `null` → `<data>/backups/<name>`; a folder gets that name inside it; a file is used as given. */
export function backupPath(dest: string | null, now = new Date()): string {
  if (dest === null) return `${DATA_DIR}/backups/${backupName(now)}`
  const path = dest.trim().replace(/\\/gu, '/')
  const absolute = /^[A-Za-z]:\//u.test(path) || path.startsWith('/')
  if (path === '' || !absolute) {
    throw new MockError(
      'invalid_argument',
      `backup destination ${JSON.stringify(dest)} is not an absolute path`,
    )
  }
  const last = path.split('/').at(-1) ?? ''
  if (path.endsWith('/') || !last.includes('.')) return `${path.replace(/\/+$/u, '')}/${backupName(now)}`
  return path
}

// --- handlers ------------------------------------------------------------------------------------------------------------

export const userHandlers: Handlers<
  | 'bookmarkList'
  | 'bookmarkUpsert'
  | 'bookmarkToggleAyah'
  | 'bookmarkDelete'
  | 'bookmarkRestore'
  | 'readingBookmarkSet'
  | 'readingBookmarkClear'
  | 'highlightList'
  | 'highlightSet'
  | 'highlightDelete'
  | 'highlightRestore'
  | 'highlightClearRange'
  | 'noteList'
  | 'noteGet'
  | 'noteUpsert'
  | 'noteDelete'
  | 'noteRestore'
  | 'collectionList'
  | 'collectionUpsert'
  | 'collectionDelete'
  | 'collectionSetMembership'
  | 'tagList'
  | 'tagUpsert'
  | 'tagDelete'
  | 'itemTagsSet'
  | 'userMarks'
  | 'positionSet'
  | 'historyRecord'
  | 'historyList'
  | 'historyClear'
  | 'userBackupCreate'
  | 'userBackupRestore'
> = {
  // --- bookmarks ---

  bookmarkList: handle((filter: BookmarkFilter): Bookmark[] => {
    let range: [number, number] = [1, AYAH_COUNT]
    if (filter.surah !== null) {
      const s = index().surahs.find((x) => x.id === filter.surah)
      if (!s) throw new MockError('invalid_argument', `surah ${filter.surah} is out of range (1..=114)`)
      range = [s.firstAyahId, s.firstAyahId + s.ayahCount - 1]
    }
    return structuredClone(
      user()
        .bookmarks.filter(
          (b) =>
            (filter.kind === null || b.kind === filter.kind) &&
            (filter.collectionId === null || b.collectionIds.includes(filter.collectionId)) &&
            (filter.tagId === null || b.tagIds.includes(filter.tagId)) &&
            b.ayahId >= range[0] &&
            b.ayahId <= range[1],
        )
        .sort(compareRecent)
        .slice(0, filter.limit),
    )
  }),

  bookmarkUpsert: handle((input: BookmarkInput) => {
    const v = validBookmark(input)
    return mutate(['bookmarks', 'collections', 'tags'], (u) => {
      requireLiveCollections(u, v.collectionIds)
      requireLiveTags(u, v.tagIds)
      const now = nowSecs()
      const holder = holderOf(u, v.target)
      let row: Bookmark
      if (input.id === null) {
        if (holder) {
          row = holder
        } else {
          row = {
            id: uuidv7(),
            kind: v.target.kind,
            ayahId: v.ayahId,
            surah: 0,
            ayah: 0,
            layout: null,
            page: null,
            label: null,
            collectionIds: [],
            tagIds: [],
            createdAt: now,
            updatedAt: now,
          }
          u.bookmarks.push(row)
        }
      } else {
        row = liveBookmark(u, input.id)
        if (holder && holder.id !== input.id) {
          throw new MockError('invalid_argument', `${describeTarget(v.target)} already has another bookmark`)
        }
      }
      writeBookmark(u, row, v, now)
      return row
    })
  }),

  bookmarkToggleAyah: handle((ayahId: number) => {
    checkAyah(ayahId, 'ayah')
    return mutate(['bookmarks', 'collections', 'tags'], (u): BookmarkToggle => {
      const now = nowSecs()
      const live = holderOf(u, { kind: 'ayah', ayahId })
      if (live) {
        const before = structuredClone(live)
        u.bookmarks = u.bookmarks.filter((b) => b.id !== live.id)
        u.trash.bookmarks.push({ ...live, updatedAt: now })
        return { bookmark: before, active: false }
      }
      const revived = u.trash.bookmarks.findLast((b) => b.kind === 'ayah' && b.ayahId === ayahId)
      let row: Bookmark
      if (revived) {
        u.trash.bookmarks = u.trash.bookmarks.filter((b) => b !== revived)
        row = { ...relink(u, revived), updatedAt: now }
      } else {
        const { surah, ayah } = refOf(index(), ayahId)
        row = {
          id: uuidv7(),
          kind: 'ayah',
          ayahId,
          surah,
          ayah,
          layout: null,
          page: null,
          label: null,
          collectionIds: [],
          tagIds: [],
          createdAt: now,
          updatedAt: now,
        }
      }
      u.bookmarks.push(row)
      return { bookmark: row, active: true }
    })
  }),

  bookmarkDelete: handle((id: string) =>
    mutate(['bookmarks', 'collections', 'tags'], (u) => {
      const b = liveBookmark(u, id)
      const before = structuredClone(b)
      u.bookmarks = u.bookmarks.filter((x) => x.id !== id)
      u.trash.bookmarks.push({ ...b, updatedAt: nowSecs() })
      return before
    }),
  ),

  bookmarkRestore: handle((id: string) =>
    mutate(['bookmarks', 'collections', 'tags'], (u) => {
      const live = u.bookmarks.find((b) => b.id === id)
      if (live) return live
      const trashed = u.trash.bookmarks.findLast((b) => b.id === id)
      if (!trashed) throw new MockError('not_found', `bookmark ${id}`)
      const target = targetOf(trashed)
      if (holderOf(u, target)) {
        throw new MockError('invalid_argument', `${describeTarget(target)} already has another bookmark`)
      }
      u.trash.bookmarks = u.trash.bookmarks.filter((b) => b.id !== id)
      const row = { ...relink(u, trashed), updatedAt: nowSecs() }
      u.bookmarks.push(row)
      return row
    }),
  ),

  readingBookmarkSet: handle((input: ReadingBookmarkInput) => {
    checkAyah(input.ayahId, 'reading bookmark ayah')
    checkLayout(input.layout)
    checkPage(input.page)
    return mutate(['reading_bookmark'], (u): ReadingBookmarkMove => {
      const previous = u.readingBookmark
      const current: ReadingBookmark = {
        ayahId: input.ayahId,
        layout: input.layout,
        page: input.page,
        updatedAt: nowSecs(),
      }
      u.readingBookmark = current
      return { previous, current }
    })
  }),

  readingBookmarkClear: handle(() =>
    mutate(['reading_bookmark'], (u) => {
      const previous = u.readingBookmark
      u.readingBookmark = null
      return previous
    }),
  ),

  // --- highlights ---

  highlightList: handle((color: HighlightColor | null) =>
    structuredClone(
      user()
        .highlights.filter((h) => color === null || h.color === color)
        .sort(compareMushaf),
    ),
  ),

  highlightSet: handle((input: HighlightInput) => {
    assertAyahRange(input.fromAyahId, input.toAyahId, AYAH_COUNT)
    checkColor(input.color)
    return mutate(['highlights', 'tags'], (u) => {
      const id = paint(u, input.fromAyahId, input.toAyahId, input.color, nowSecs(), null)
      return liveHighlight(u, id)
    })
  }),

  highlightDelete: handle((id: string) =>
    mutate(['highlights', 'tags'], (u) => {
      const h = liveHighlight(u, id)
      const before = structuredClone(h)
      tombstoneHighlight(u, h, nowSecs())
      return before
    }),
  ),

  highlightRestore: handle((id: string) =>
    mutate(['highlights', 'tags'], (u) => {
      const live = u.highlights.find((h) => h.id === id)
      if (live) return live
      const trashed = u.trash.highlights.findLast((h) => h.id === id)
      if (!trashed) throw new MockError('not_found', `highlight ${id}`)
      paint(u, trashed.fromAyahId, trashed.toAyahId, trashed.color, nowSecs(), id)
      return liveHighlight(u, id)
    }),
  ),

  highlightClearRange: handle((fromAyahId: number, toAyahId: number) => {
    assertAyahRange(fromAyahId, toAyahId, AYAH_COUNT)
    return mutate(['highlights', 'tags'], (u) =>
      cut(u, spansNear(u, fromAyahId, toAyahId), fromAyahId, toAyahId, nowSecs()),
    )
  }),

  // --- notes ---

  noteList: handle((filter: NoteFilter) => {
    if (filter.fromAyahId !== null) checkAyah(filter.fromAyahId, 'from ayah')
    if (filter.toAyahId !== null) checkAyah(filter.toAyahId, 'to ayah')
    const from = filter.fromAyahId ?? 1
    const to = filter.toAyahId ?? AYAH_COUNT
    assertAyahRange(from, to, AYAH_COUNT)
    return structuredClone(
      user()
        .notes.filter(
          (n) =>
            overlaps(from, to, n.fromAyahId, n.toAyahId) &&
            (filter.tagId === null || n.tagIds.includes(filter.tagId)),
        )
        .sort(compareRecent)
        .slice(0, filter.limit),
    )
  }),

  noteGet: handle((id: string) => structuredClone(liveNote(user(), id))),

  noteUpsert: handle((input: NoteInput) => {
    assertAyahRange(input.fromAyahId, input.toAyahId, AYAH_COUNT)
    const title = optSingleLine(input.title, LABEL_MAX_CHARS, 'note title')
    const body = cleanBody(input.body)
    checkLen(body, BODY_MAX_CHARS, 'note body')
    if (title === null && body === '')
      throw new MockError('invalid_argument', 'a note needs a title or a body')
    const tagIds = dedupeIds(input.tagIds, 'tags')
    return mutate(['notes', 'tags'], (u) => {
      requireLiveTags(u, tagIds)
      const now = nowSecs()
      let row: Note
      if (input.id === null) {
        row = {
          id: uuidv7(),
          fromAyahId: input.fromAyahId,
          toAyahId: input.toAyahId,
          title,
          body,
          tagIds: [],
          createdAt: now,
          updatedAt: now,
        }
        u.notes.push(row)
      } else {
        row = liveNote(u, input.id)
      }
      row.fromAyahId = input.fromAyahId
      row.toAyahId = input.toAyahId
      row.title = title
      row.body = body
      row.tagIds = orderTags(u, tagIds)
      row.updatedAt = now
      return row
    })
  }),

  noteDelete: handle((id: string) =>
    mutate(['notes', 'tags'], (u) => {
      const n = liveNote(u, id)
      const before = structuredClone(n)
      u.notes = u.notes.filter((x) => x.id !== id)
      u.trash.notes.push({ ...n, updatedAt: nowSecs() })
      return before
    }),
  ),

  noteRestore: handle((id: string) =>
    mutate(['notes', 'tags'], (u) => {
      const live = u.notes.find((n) => n.id === id)
      if (live) return live
      const trashed = u.trash.notes.findLast((n) => n.id === id)
      if (!trashed) throw new MockError('not_found', `note ${id}`)
      u.trash.notes = u.trash.notes.filter((n) => n.id !== id)
      const row = { ...relink(u, trashed), updatedAt: nowSecs() }
      u.notes.push(row)
      return row
    }),
  ),

  // --- collections ---

  collectionList: handle(() => {
    const u = user()
    return structuredClone(u.collections.map((c) => withCounts(u, c)).sort(compareCollections))
  }),

  collectionUpsert: handle((input: CollectionInput) => {
    const name = requiredName(input.name, NAME_MAX_CHARS, 'collection name')
    const color = cleanColor(input.color)
    if (!Number.isInteger(input.sortKey)) throw new MockError('invalid_argument', 'sortKey is not an integer')
    return mutate(['collections'], (u) => {
      const now = nowSecs()
      let row: Collection
      if (input.id === null) {
        row = {
          id: uuidv7(),
          name,
          color,
          itemCount: 0,
          sortKey: input.sortKey,
          createdAt: now,
          updatedAt: now,
        }
        u.collections.push(row)
      } else {
        const found = u.collections.find((c) => c.id === input.id)
        if (!found) throw new MockError('not_found', `collection ${input.id}`)
        row = found
        row.name = name
        row.color = color
        row.sortKey = input.sortKey
        row.updatedAt = now
      }
      // The new name or sort key may reorder every bookmark's collection list.
      for (const b of u.bookmarks) b.collectionIds = orderCollections(u, b.collectionIds)
      return withCounts(u, row)
    })
  }),

  collectionDelete: handle((id: string) =>
    mutate(['collections', 'bookmarks'], (u) => {
      if (!u.collections.some((c) => c.id === id)) throw new MockError('not_found', `collection ${id}`)
      u.collections = u.collections.filter((c) => c.id !== id)
      for (const b of [...u.bookmarks, ...u.trash.bookmarks]) {
        b.collectionIds = b.collectionIds.filter((c) => c !== id)
      }
      return null
    }),
  ),

  collectionSetMembership: handle((bookmarkId: string, collectionIds: string[]) => {
    const ids = dedupeIds(collectionIds, 'collections')
    return mutate(['collections', 'bookmarks'], (u) => {
      const b = liveBookmark(u, bookmarkId)
      requireLiveCollections(u, ids)
      b.collectionIds = orderCollections(u, ids)
      b.updatedAt = nowSecs()
      return b
    })
  }),

  // --- tags ---

  tagList: handle(() => {
    const u = user()
    return structuredClone(
      u.tags
        .map((t) => tagWithUsage(u, t))
        .sort((a, b) => compareNocase(a.name, b.name) || compareId(a.id, b.id)),
    )
  }),

  tagUpsert: handle((input: TagInput) => {
    const name = requiredName(input.name, NAME_MAX_CHARS, 'tag name')
    const color = cleanColor(input.color)
    const existing = user().tags.find((t) => nocase(t.name) === nocase(name))
    // Get-or-create: a tag of that name answers unchanged and writes nothing (WP2a deviation 7). The real command
    // still emits the event after its (empty) transaction.
    if (input.id === null && existing) {
      return mutate(['tags'], (u) => tagWithUsage(u, existing))
    }
    return mutate(['tags'], (u) => {
      let row: Tag
      if (input.id === null) {
        row = { id: uuidv7(), name, color, usageCount: 0 }
        u.tags.push(row)
      } else {
        if (existing && existing.id !== input.id) {
          throw new MockError('invalid_argument', `another tag is already named ${JSON.stringify(name)}`)
        }
        const found = u.tags.find((t) => t.id === input.id)
        if (!found) throw new MockError('not_found', `tag ${input.id}`)
        row = found
        row.name = name
        row.color = color
      }
      // A rename may reorder every item's tag list.
      for (const item of [...u.bookmarks, ...u.notes, ...u.highlights])
        item.tagIds = orderTags(u, item.tagIds)
      return tagWithUsage(u, row)
    })
  }),

  tagDelete: handle((id: string) =>
    mutate(['tags', 'bookmarks', 'notes', 'highlights'], (u) => {
      if (!u.tags.some((t) => t.id === id)) throw new MockError('not_found', `tag ${id}`)
      u.tags = u.tags.filter((t) => t.id !== id)
      const items = [
        ...u.bookmarks,
        ...u.notes,
        ...u.highlights,
        ...u.trash.bookmarks,
        ...u.trash.notes,
        ...u.trash.highlights,
      ]
      for (const item of items) item.tagIds = item.tagIds.filter((t) => t !== id)
      return null
    }),
  ),

  itemTagsSet: handle((kind: TaggableKind, itemId: string, tagIds: string[]) => {
    const ids = dedupeIds(tagIds, 'tags')
    const kindList: UserDataKind =
      kind === 'bookmark' ? 'bookmarks' : kind === 'note' ? 'notes' : 'highlights'
    return mutate(['tags', kindList], (u) => {
      const item = liveItem(u, kind, itemId)
      requireLiveTags(u, ids)
      item.tagIds = orderTags(u, ids)
      item.updatedAt = nowSecs()
      return null
    })
  }),

  // --- marks ---

  userMarks: handle(
    (layout: MushafLayout, fromAyahId: number, toAyahId: number, pages: number[]): UserMarks => {
      assertAyahRange(fromAyahId, toAyahId, AYAH_COUNT)
      checkLayout(layout)
      for (const p of pages) assertRange('page', p, 1, PAGE_COUNT)
      const u = user()
      const inRange = (a: number) => a >= fromAyahId && a <= toAyahId
      return structuredClone({
        bookmarks: u.bookmarks
          .filter((b) => b.kind === 'ayah' && inRange(b.ayahId))
          .sort((a, b) => a.ayahId - b.ayahId)
          .map((b) => ({ ayahId: b.ayahId, bookmarkId: b.id })),
        pageBookmarks: u.bookmarks
          .flatMap((b) =>
            b.kind === 'page' && b.layout === layout && b.page !== null && pages.includes(b.page)
              ? [{ page: b.page, bookmarkId: b.id }]
              : [],
          )
          .sort((a, b) => a.page - b.page),
        highlights: u.highlights
          .filter((h) => overlaps(fromAyahId, toAyahId, h.fromAyahId, h.toAyahId))
          .sort(compareMushaf)
          .map(({ id, fromAyahId: f, toAyahId: t, color }) => ({ id, fromAyahId: f, toAyahId: t, color })),
        notes: u.notes
          .filter((n) => overlaps(fromAyahId, toAyahId, n.fromAyahId, n.toAyahId))
          .sort(compareMushaf)
          .map(({ id, fromAyahId: f, toAyahId: t }) => ({ id, fromAyahId: f, toAyahId: t })),
        readingAyahId:
          u.readingBookmark && inRange(u.readingBookmark.ayahId) ? u.readingBookmark.ayahId : null,
      })
    },
  ),

  // --- positions and history ---

  positionSet: handle((position: ReadingPosition) => {
    checkAyah(position.ayahId, 'ayah')
    checkPage(position.page)
    state.user.update((u) => {
      const next = { ...position, updatedAt: nowSecs() }
      const i = u.positions.findIndex((p) => p.context === position.context)
      if (i >= 0) u.positions[i] = next
      else u.positions.push(next)
      const order = ['mushaf', 'translation', 'audio']
      u.positions.sort((a, b) => order.indexOf(a.context) - order.indexOf(b.context))
    })
    return null
  }),

  historyRecord: handle((entry: HistoryInput) => {
    checkAyah(entry.ayahId, 'ayah')
    checkPage(entry.page)
    return mutate(['history'], (u) => {
      const now = nowSecs()
      const previous = u.history
        .filter((e) => e.mode === entry.mode && e.at >= now - HISTORY_DEDUPE_S && samePlace(e, entry))
        .sort((a, b) => b.id - a.id)[0]
      let dwell = entry.dwellS
      if (previous) {
        u.history = u.history.filter((e) => e.id !== previous.id)
        dwell = Math.min(0xffff_ffff, dwell + Math.max(0, previous.dwellS))
      }
      u.history.push({
        id: u.nextHistoryId++,
        at: now,
        mode: entry.mode,
        layout: entry.layout,
        page: entry.page,
        ayahId: entry.ayahId,
        dwellS: dwell,
      })
      if (u.history.length > HISTORY_MAX_ENTRIES) {
        u.history = u.history.sort((a, b) => a.id - b.id).slice(-HISTORY_MAX_ENTRIES)
      }
      return null
    })
  }),

  historyList: handle((limit: number, beforeId: number | null) =>
    structuredClone(
      user()
        .history.filter((h) => beforeId === null || h.id < beforeId)
        .sort((a, b) => b.id - a.id)
        .slice(0, Math.min(limit, HISTORY_LIST_MAX)),
    ),
  ),

  historyClear: handle(() =>
    mutate(['history'], (u) => {
      u.history = []
      return null
    }),
  ),

  // --- backups ---

  userBackupCreate: handle((destPath: string | null) => {
    const path = backupPath(destPath)
    backups.set(path, libraryImage())
    return path
  }),

  userBackupRestore: handle(async (srcPath: string) => {
    const image = restoreSource(srcPath)
    // The current library is kept as a backup before it is replaced (WP2b).
    backups.set(backupPath(null), libraryImage())
    state.user.set(structuredClone(image.user))
    state.memo.set(structuredClone(image.memo))
    state.search.set(structuredClone(image.search))
    const settings = state.settings.set(structuredClone(image.settings))
    await events.settingsChanged.emit(structuredClone(settings))
    await changed(ALL_USER_DATA)
    // The real command re-syncs the download registry with the disk and reports every pack.
    await events.packsChanged.emit({ packIds: state.packs.value.list.map((p) => p.id) })
    return null
  }),
}

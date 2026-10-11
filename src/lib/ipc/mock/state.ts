/**
 * Mock state (§5.17; WP0C, frozen). Typed slices, each mutated **only by its owner's handler**:
 *
 * | slice      | owner handler | holds                                                                              |
 * |------------|---------------|------------------------------------------------------------------------------------|
 * | `settings` | settings.ts   | `Settings`                                                                         |
 * | `user`     | user.ts       | bookmarks, reading bookmark, highlights, notes, collections, tags, positions, history |
 * | `memo`     | memo.ts       | progress, self-tests, loop presets                                                 |
 * | `packs`    | packs.ts      | the `PackInfo` list (fixtures/packs/list.json or synthetic), jobs, per-pack items  |
 * | `audio`    | audio.ts      | the snapshot and the reciters                                                      |
 * | `fonts`    | fonts.ts      | the decor status                                                                   |
 * | `search`   | search.ts     | search history                                                                     |
 *
 * `app_bootstrap` (app.ts) only reads them. Each slice mirrors itself to `localStorage["qd-mock-v1:<slice>"]` so a
 * reload keeps the mock's data; that is a per-viewer convenience, so every storage access is wrapped in try/catch and a
 * blocked or corrupt store falls back to the initial value. Load `?mockReset` to start from a clean state.
 */
import type {
  AudioSnapshot,
  Bookmark,
  Collection,
  DecorStatus,
  Highlight,
  HistoryEntry,
  JobSnapshot,
  LoopPreset,
  MemoProgress,
  MemoTest,
  Note,
  PackInfo,
  PackItemState,
  ReadingBookmark,
  ReadingPosition,
  ReciterInfo,
  SearchHistoryEntry,
  Settings,
  Tag,
} from '../bindings'
import { defaultSettings } from '$lib/contracts/settings'
import { fixtures } from './fixtures'
import { recitersFromPacks, syntheticPacks } from './synthetic'

export const STORAGE_PREFIX = 'qd-mock-v1:'

/** `Settings::default()` of quran-types (the shared twin in `contracts/settings.ts`). */
export { defaultSettings }

export interface UserState {
  bookmarks: Bookmark[]
  readingBookmark: ReadingBookmark | null
  highlights: Highlight[]
  notes: Note[]
  collections: Collection[]
  tags: Tag[]
  positions: ReadingPosition[]
  history: HistoryEntry[]
  /** Tombstoned rows, so `*_restore` (undo) can bring them back. */
  trash: { bookmarks: Bookmark[]; highlights: Highlight[]; notes: Note[] }
  nextHistoryId: number
}

export interface MemoState {
  progress: MemoProgress[]
  tests: MemoTest[]
  presets: LoopPreset[]
  nextTestId: number
  nextPresetId: number
}

export interface PacksState {
  list: PackInfo[]
  jobs: JobSnapshot[]
  /** `packs_items` per on-demand pack id. */
  items: Record<string, PackItemState[]>
  nextJobId: number
}

export interface AudioState {
  snapshot: AudioSnapshot
  reciters: ReciterInfo[]
}

export interface FontsState {
  decor: DecorStatus
}

export interface SearchState {
  history: SearchHistoryEntry[]
}

/** The idle audio snapshot, with the playback defaults taken from settings. */
export function idleSnapshot(settings: Settings): AudioSnapshot {
  return {
    status: 'idle',
    reciterId: settings.reciterId,
    current: null,
    currentAyahId: null,
    range: null,
    ayahRepeat: settings.ayahRepeat,
    ayahRepeatLeft: 0,
    rangeRepeat: settings.rangeRepeat,
    rangeRepeatLeft: 0,
    gap: settings.gap,
    abLoop: null,
    speedPct: settings.speedPct,
    volumePct: settings.volumePct,
    fileMs: 0,
    fileDurationMs: 0,
    ayahFromMs: 0,
    ayahToMs: 0,
    bufferedPct: 0,
    device: 'Mock output',
    basmalaSkipped: false,
    error: null,
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Overlays a stored value on the initial one, recursively for plain objects (arrays and scalars are replaced), so a
 * field added after the value was stored keeps its default. A stored value of the wrong kind is rejected.
 */
export function mergeDefaults<T>(initial: T, stored: unknown): T | null {
  if (isPlainObject(initial)) {
    if (!isPlainObject(stored)) return null
    const out: Record<string, unknown> = { ...initial }
    for (const [k, v] of Object.entries(stored)) {
      const base = (initial as Record<string, unknown>)[k]
      out[k] = isPlainObject(base) && isPlainObject(v) ? (mergeDefaults(base, v) ?? base) : v
    }
    return out as T
  }
  if (Array.isArray(initial)) return Array.isArray(stored) ? (stored as T) : null
  return typeof stored === typeof initial ? (stored as T) : null
}

export type SliceName = 'settings' | 'user' | 'memo' | 'packs' | 'audio' | 'fonts' | 'search'

/** One state slice: a value, its initial factory, and its `localStorage` mirror. */
export class Slice<T> {
  #value: T | undefined
  #fromStorage = false

  constructor(
    readonly name: SliceName,
    private readonly initial: () => T,
  ) {}

  get storageKey(): string {
    return STORAGE_PREFIX + this.name
  }

  /** The current value (initialised lazily). Mutate through `set`/`update` so the mirror stays current. */
  get value(): T {
    if (this.#value === undefined) this.#value = this.initial()
    return this.#value
  }

  /** Whether the current value was restored from `localStorage`. */
  get fromStorage(): boolean {
    return this.#fromStorage
  }

  set(value: T): T {
    this.#value = value
    this.save()
    return value
  }

  /** Mutates the value in place, then saves it. */
  update(mutate: (draft: T) => void): T {
    const v = this.value
    mutate(v)
    this.save()
    return v
  }

  load(): void {
    this.#fromStorage = false
    this.#value = undefined
    try {
      const raw = localStorage.getItem(this.storageKey)
      if (raw !== null) {
        const merged = mergeDefaults(this.initial(), JSON.parse(raw))
        if (merged !== null) {
          this.#value = merged
          this.#fromStorage = true
        }
      }
    } catch {
      // Blocked or corrupt storage: start from the initial value.
    }
  }

  save(): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.value))
    } catch {
      // Storage full or blocked: the in-memory value still works for this session.
    }
  }

  reset(): void {
    this.#value = undefined
    this.#fromStorage = false
    try {
      localStorage.removeItem(this.storageKey)
    } catch {
      // Ignore: nothing to remove.
    }
  }
}

const settings = new Slice<Settings>('settings', defaultSettings)

const user = new Slice<UserState>('user', () => ({
  bookmarks: [],
  readingBookmark: null,
  highlights: [],
  notes: [],
  collections: [],
  tags: [],
  positions: [],
  history: [],
  trash: { bookmarks: [], highlights: [], notes: [] },
  nextHistoryId: 1,
}))

const memo = new Slice<MemoState>('memo', () => ({
  progress: [],
  tests: [],
  presets: [],
  nextTestId: 1,
  nextPresetId: 1,
}))

const packs = new Slice<PacksState>('packs', () => ({
  list: structuredClone(fixtures.cachedPacks() ?? syntheticPacks()),
  jobs: [],
  items: {},
  nextJobId: 1,
}))

const audio = new Slice<AudioState>('audio', () => ({
  snapshot: idleSnapshot(settings.value),
  reciters: recitersFromPacks(packs.value.list),
}))

const fonts = new Slice<FontsState>('fonts', () => ({
  decor: { installed: false, surahHeaderUrl: null, quranCommonUrl: null, suraNamesUrl: null },
}))

const search = new Slice<SearchState>('search', () => ({ history: [] }))

const slices = [settings, user, memo, packs, audio, fonts, search] as const

/** The mock's state. Handlers import the slice they own (and read others). */
export const state = {
  settings,
  user,
  memo,
  packs,
  audio,
  fonts,
  search,
  /** Loads every slice from `localStorage` (called once by `installMockRuntime`). */
  loadAll(): void {
    for (const s of slices) s.load()
  },
  /** Clears every slice and its mirror (`?mockReset`, tests). */
  resetAll(): void {
    for (const s of slices) s.reset()
  },
  /** First run in this browser profile: no settings were stored yet (the real app: a freshly created user.db). */
  get firstRun(): boolean {
    return !settings.fromStorage
  },
}

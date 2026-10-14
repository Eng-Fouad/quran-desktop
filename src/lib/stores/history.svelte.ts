/**
 * `history` store: the reading/listening/memorising history and the reading positions. Layer L1
 * (imports L0 stores only).
 *
 * - **Positions** come from the bootstrap and are kept current by `setPosition` (the reader writes it, debounced
 *   1 s; `position_set` emits no event). `last(context)` answers the stored position of a context. A restored library
 *   (`user-data-changed` with `positions`) is read again (`reloadPositions`; the bootstrap is the only command that
 *   answers them).
 * - **Entries** load on demand (`load()`, when the History panel first shows), newest first, a page at a time
 *   (`loadMore()`). Once loaded they follow `user-data-changed` with `history` (the reader's 3 s dwell records, the
 *   audio glue's listening records, a clear elsewhere), re-reading as many entries as are shown.
 * - `record()` and `setPosition()` are background writes: a failure is logged, never toasted (the reader keeps
 *   reading). `clear()` is the History panel's "Clear history" (the panel confirms first).
 */
import type { Store } from '$lib/contracts/stores'
import { api, call, events } from '$lib/ipc'
import type {
  Bootstrap,
  HistoryEntry,
  HistoryInput,
  PositionContext,
  ReadingPosition,
} from '$lib/ipc/bindings'
import { listenEvent } from './app.svelte'
import { i18n } from './i18n.svelte'
import { ui } from './ui.svelte'

/** Entries per `history_list` page. */
export const HISTORY_PAGE = 100
/** Most entries the store re-reads at once after a change (the command's own cap). */
export const HISTORY_RELOAD_MAX = 1_000
/** `history-changed` events within this window are re-read together. */
const EVENT_COALESCE_MS = 50

/** Where the entries stand: nothing asked yet, the first page loading, loaded, or the first load failed. */
export type HistoryStatus = 'idle' | 'loading' | 'ready' | 'error'

const CONTEXT_ORDER: readonly PositionContext[] = ['mushaf', 'translation', 'audio']

class HistoryStore implements Store {
  entries = $state.raw<HistoryEntry[]>([])
  positions = $state.raw<ReadingPosition[]>([])
  status = $state<HistoryStatus>('idle')
  /** More entries exist beyond the loaded ones (`loadMore()`). */
  hasMore = $state(false)
  loadingMore = $state(false)

  /** Read sequence: only the newest read of the entries is applied. */
  #seq = 0
  /** The positions being read again (shared by every caller meanwhile). */
  #positionsLoad: Promise<ReadingPosition[] | null> | null = null
  #reloadTimer: ReturnType<typeof setTimeout> | undefined
  #disposers: (() => void)[] = []

  init(b: Bootstrap): void {
    this.#dispose()
    this.positions = sortPositions(b.positions)
    this.#disposers.push(
      listenEvent(events.userDataChanged, ({ kinds }) => {
        if (kinds.includes('history')) this.#scheduleReload()
        if (kinds.includes('positions')) void this.reloadPositions()
      }),
    )
  }

  /** The stored position of a context (mushaf, translation, audio). */
  last(context: PositionContext): ReadingPosition | undefined {
    return this.positions.find((p) => p.context === context)
  }

  /**
   * Reads the stored positions again (after a library restore replaced them). Callers meanwhile share one read; it
   * answers the positions, or `null` when they could not be read (logged; the known ones stay).
   */
  reloadPositions(): Promise<ReadingPosition[] | null> {
    if (this.#positionsLoad) return this.#positionsLoad
    const load = call(api.appBootstrap()).then(
      (b) => {
        this.positions = sortPositions(b.positions)
        return this.positions
      },
      (e: unknown) => {
        console.warn('[qd] the reading positions could not be read again', e)
        return null
      },
    )
    this.#positionsLoad = load
    void load.finally(() => {
      if (this.#positionsLoad === load) this.#positionsLoad = null
    })
    return load
  }

  /** Loads the newest page of entries (the History panel's first paint). Never rejects. */
  async load(): Promise<void> {
    if (this.status === 'loading') return
    if (this.status !== 'ready') this.status = 'loading'
    const seq = ++this.#seq
    try {
      const rows = await call(api.historyList(HISTORY_PAGE, null))
      if (seq !== this.#seq) return
      this.entries = rows
      this.hasMore = rows.length === HISTORY_PAGE
      this.status = 'ready'
    } catch (e) {
      console.warn('[qd] the history could not be loaded', e)
      if (seq === this.#seq && this.status !== 'ready') this.status = 'error'
    }
  }

  /** Appends the next page of older entries. Never rejects. */
  async loadMore(): Promise<void> {
    const last = this.entries.at(-1)
    if (this.status !== 'ready' || !this.hasMore || this.loadingMore || !last) return
    this.loadingMore = true
    const seq = this.#seq
    try {
      const rows = await call(api.historyList(HISTORY_PAGE, last.id))
      // A reload replaced the list meanwhile: the page no longer continues it.
      if (seq !== this.#seq) return
      const known = new Set(this.entries.map((e) => e.id))
      this.entries = [...this.entries, ...rows.filter((r) => !known.has(r.id))]
      this.hasMore = rows.length === HISTORY_PAGE
    } catch (e) {
      ui.toastError(e)
    } finally {
      this.loadingMore = false
    }
  }

  /** Records a visit (the reader after a 3 s dwell). Errors are logged. */
  async record(input: HistoryInput): Promise<void> {
    try {
      await call(api.historyRecord(input))
    } catch (e) {
      console.warn('[qd] a history entry could not be recorded', e)
    }
  }

  /** Clears the whole history ("Clear history"; the panel asks first). Resolves whether it was cleared. */
  async clear(): Promise<boolean> {
    try {
      await call(api.historyClear())
    } catch (e) {
      ui.toastError(e)
      return false
    }
    this.#seq++
    this.entries = []
    this.hasMore = false
    if (this.status !== 'idle') this.status = 'ready'
    ui.toast({ message: i18n.t('library.history.cleared') })
    return true
  }

  /** Stores the position of a context (the reader debounces it). Applied locally at once; errors are logged. */
  async setPosition(position: ReadingPosition): Promise<void> {
    const local: ReadingPosition = { ...position, updatedAt: Math.floor(Date.now() / 1000) }
    this.positions = sortPositions([...this.positions.filter((p) => p.context !== position.context), local])
    try {
      await call(api.positionSet(position))
    } catch (e) {
      console.warn('[qd] the reading position could not be saved', e)
    }
  }

  reset(): void {
    this.#dispose()
    clearTimeout(this.#reloadTimer)
    this.#reloadTimer = undefined
    this.#seq++
    this.#positionsLoad = null
    this.entries = []
    this.positions = []
    this.status = 'idle'
    this.hasMore = false
    this.loadingMore = false
  }

  #dispose(): void {
    for (const dispose of this.#disposers.splice(0)) dispose()
  }

  /** A change elsewhere: re-read the shown entries (only once they were loaded). */
  #scheduleReload(): void {
    if (this.status === 'idle' || this.#reloadTimer !== undefined) return
    this.#reloadTimer = setTimeout(() => {
      this.#reloadTimer = undefined
      void this.#reload()
    }, EVENT_COALESCE_MS)
  }

  async #reload(): Promise<void> {
    const seq = ++this.#seq
    const limit = Math.min(HISTORY_RELOAD_MAX, Math.max(HISTORY_PAGE, this.entries.length))
    try {
      const rows = await call(api.historyList(limit, null))
      if (seq !== this.#seq) return
      this.entries = rows
      this.hasMore = rows.length === limit
      this.status = 'ready'
    } catch (e) {
      console.warn('[qd] the history could not be refreshed', e)
    }
  }
}

function sortPositions(positions: readonly ReadingPosition[]): ReadingPosition[] {
  return [...positions].sort((a, b) => CONTEXT_ORDER.indexOf(a.context) - CONTEXT_ORDER.indexOf(b.context))
}

export const history = new HistoryStore()

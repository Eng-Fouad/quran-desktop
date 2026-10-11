/**
 * `search` store (§7.3, §1.5, §9.7, §9.8): the query, its scope, mode and filters, the results, the active hit and the
 * search history. Owner: WP10b. Layer L1 (imports the L0 stores and `packs`).
 *
 * - **Typing** (`setQuery`) searches 120 ms after the last keystroke; scope, mode and filter changes search at once.
 *   Every request carries a sequence number, so an answer that arrives after a newer request is dropped. While a new
 *   request runs the previous results stay on screen (`status = 'loading'`).
 * - **Requests** (`request`): the query, scope, mode, filters, `limit` 500 and the layout of the Mushaf style (page
 *   numbers in hits). There is none for an empty query, a translation scope without an installed pack, or a Quran
 *   query that is a reference ("2:255", "p 262", "255"): the panel offers that jump instead (`references`), since the
 *   Quran text holds no digits.
 * - **Hits** open through the `HitOpener` the search components install (`src/components/search/open.ts`): this L1 store
 *   must not import the reader (§7.2). `openHit` makes the hit active, records the query in the history and asks the
 *   reader for the ayah with the matched words on the search-hit layer. `move(±1)` (F3 / Shift+F3 from the reader,
 *   Enter / Shift+Enter in the field) opens the next or previous hit, wrapping around, and the list follows
 *   `activeIndex`.
 * - **History**: a query is recorded once per (query, scope) when it is submitted or a hit of it is opened (again after
 *   a clear); `history` holds the most recent entries for the empty panel (§9.8) and is read again when the library
 *   reports a `history` change (a restore, a clear elsewhere).
 * - **Suggestions**: word completions from the Quran vocabulary for the word being typed (Quran scope).
 * - **Re-runs**: a Mushaf style with another layout re-runs the search (page numbers), a note change re-runs a notes
 *   search, and a translation scope whose pack is removed moves to another installed translation. A re-run of the same
 *   request keeps the active hit.
 * - Deep navigation (`NavTarget::Search`, §7.4) sets the query and searches at once.
 */
import { untrack } from 'svelte'
import type { Store } from '$lib/contracts/stores'
import { api, call, events, type IpcError, toIpcError } from '$lib/ipc'
import type {
  Bootstrap,
  MushafLayout,
  MushafStyle,
  NavTarget,
  PackInfo,
  SearchHistoryEntry,
  SearchHit,
  SearchMode,
  SearchRequest,
  SearchResults,
  SearchScope,
  SearchSuggestion,
} from '$lib/ipc/bindings'
import { parseReference, type ParseResult } from '$lib/text/refparse'
import { listenEvent } from './app.svelte'
import { i18n } from './i18n.svelte'
import { packs } from './packs.svelte'
import { quran } from './quran.svelte'
import { settings } from './settings.svelte'
import { ui } from './ui.svelte'

export type SearchStatus = 'idle' | 'loading' | 'done' | 'error'

/** §1.5: typing searches after this pause. */
export const SEARCH_DEBOUNCE_MS = 120
/** §5.6: hits asked for per search (the engine still counts every match: `total`, `truncated`). */
export const SEARCH_LIMIT = 500
/** Recent searches kept for the empty panel (§9.8). */
export const HISTORY_LIMIT = 12
/** `history` changes within this window are read together. */
const HISTORY_RELOAD_MS = 300
/** Word completions asked for while typing. */
export const SUGGEST_LIMIT = 5
/** `localStorage` key of the last mode (a per-machine convenience; `Settings` has no field for it). */
export const MODE_STORAGE_KEY = 'qd.search.mode'

export const SEARCH_MODES: readonly SearchMode[] = ['smart', 'exact', 'substring']

const LAYOUT_OF: Record<MushafStyle, MushafLayout> = { hafs: 'v2', qcf_v2: 'v2', qcf_v1: 'v1', qcf_v4: 'v4' }

export interface OpenHitOptions {
  /**
   * Move focus to the ayah once it renders (default true: a click or Enter in the list, F3 from the reader). Enter in
   * the search field passes false, so the field keeps focus and Enter can step through the hits.
   */
  focus?: boolean
}

/**
 * Opens hits in the reader. The search components install it (`setOpener`) because the reader is an L2 store; without
 * one, hits open through deep navigation (`ui.navigate`, no word highlight).
 */
export interface HitOpener {
  /** Shows the hit's ayah: selected, the matched words on the search-hit layer (§8.7). */
  open(hit: SearchHit, options: { highlightWords: number[]; focus: boolean }): void
  /** Shows the hit's ayah in the side pane without turning the page (`Mod+Enter`, middle click, §10.2). */
  openInPane(hit: SearchHit): void
}

/** A stable key of a hit within its results (notes can share an ayah). */
export function hitKey(hit: SearchHit): string {
  return hit.noteId === null ? `a${hit.ayahId}` : `n${hit.noteId}`
}

/** The request a set of results answers, as a comparable string. */
export function requestKey(r: SearchRequest): string {
  return JSON.stringify([r.query, r.scope, r.mode, r.surah, r.juz, r.limit, r.layout])
}

/** Whether results answer the same query, scope and mode as a request (filters, limit and layout aside). */
function sameSearch(results: SearchResults, request: SearchRequest): boolean {
  return results.query.trim() === request.query && searchOf.get(results) === searchKey(request)
}

/** The query, scope, mode and filters of a request: what decides which hits there are. */
function searchKey(r: SearchRequest): string {
  return JSON.stringify([r.query, r.scope, r.mode, r.surah, r.juz])
}

/** `searchKey` of the request each results object answers. */
const searchOf = new WeakMap<SearchResults, string>()

function sameScope(a: SearchScope, b: SearchScope): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function isMode(v: unknown): v is SearchMode {
  return typeof v === 'string' && (SEARCH_MODES as readonly string[]).includes(v)
}

function readMode(): SearchMode | null {
  try {
    const v = localStorage.getItem(MODE_STORAGE_KEY)
    return isMode(v) ? v : null
  } catch {
    return null
  }
}

function writeMode(mode: SearchMode): void {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, mode)
  } catch {
    // Blocked storage: the mode still applies for this session.
  }
}

class SearchStore implements Store {
  query = $state('')
  scope = $state.raw<SearchScope>({ type: 'quran' })
  mode = $state<SearchMode>('smart')
  surahFilter = $state<number | null>(null)
  juzFilter = $state<number | null>(null)
  status = $state<SearchStatus>('idle')
  results = $state.raw<SearchResults | null>(null)
  /** Index into `flatHits` of the hit open in the reader (the list marks it), or -1. */
  activeIndex = $state(-1)
  history = $state.raw<SearchHistoryEntry[]>([])
  /** Completions of the word being typed (Quran vocabulary, most frequent first). */
  suggestions = $state.raw<SearchSuggestion[]>([])
  /** Why the last search failed (`status = 'error'`). */
  error = $state.raw<IpcError | null>(null)
  /** `requestKey` of the request `results` answer. */
  #answered = $state<string | null>(null)

  readonly flatHits: SearchHit[] = $derived(this.results?.groups.flatMap((g) => g.hits) ?? [])
  readonly count: number = $derived(this.results?.total ?? 0)
  readonly activeHit: SearchHit | null = $derived(this.flatHits[this.activeIndex] ?? null)
  /** The layout of the current Mushaf style: hits carry its page numbers. */
  readonly layout: MushafLayout = $derived(LAYOUT_OF[settings.value.mushafStyle])
  readonly trimmed: string = $derived(this.query.trim())

  /**
   * Installed translations: the reader's own (`settings.translations`, in order) first, then recommended packs, then
   * those in the UI language, then by title.
   */
  readonly translationPacks: readonly PackInfo[] = $derived.by(() => {
    const order = settings.value.translations
    const locale = i18n.locale
    const rank = (p: PackInfo) => {
      const i = order.indexOf(p.id)
      if (i >= 0) return i
      return order.length + (p.recommended ? 0 : 2) + (p.language === locale ? 0 : 1)
    }
    return [...packs.installedTranslations].sort(
      (a, b) => rank(a) - rank(b) || packs.title(a).localeCompare(packs.title(b), locale),
    )
  })

  /** The translation scope has no installed pack to search (§9.8: the install card). */
  readonly needsPack: boolean = $derived(this.scope.type === 'translation' && this.scope.data.packId === '')

  /**
   * The query read as a reference or a bare number ("2:255", "p 262", "j 15", "255"): the panel offers the jump. Only
   * queries with a digit are parsed (a word query is never a reference here).
   */
  readonly references: readonly ParseResult[] = $derived.by(() => {
    const q = this.trimmed
    if (!/[\p{Nd}]/u.test(q) || quran.index.surahs.length === 0) return []
    return parseReference(q, { names: false }).filter((r) => r.source !== 'name')
  })

  /** What a search for the current state would ask, or null when there is nothing to search (see the header). */
  readonly request: SearchRequest | null = $derived.by(() => {
    const query = this.trimmed
    if (query === '' || this.needsPack) return null
    if (this.scope.type === 'quran' && this.references.length > 0) return null
    return {
      query,
      scope: this.scope,
      mode: this.mode,
      surah: this.surahFilter,
      juz: this.juzFilter,
      limit: SEARCH_LIMIT,
      layout: this.layout,
    }
  })

  /** The results on screen answer an older request (typing, or a search still running). */
  readonly stale: boolean = $derived(
    this.request === null ? this.results !== null : this.#answered !== requestKey(this.request),
  )

  #seq = 0
  #suggestSeq = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  /** The (query, scope) recorded in the history last, so stepping through hits records it once. */
  #recorded: string | null = null
  #opener: HitOpener | null = null
  #disposers: (() => void)[] = []
  #historyTimer: ReturnType<typeof setTimeout> | undefined

  init(_b: Bootstrap): void {
    this.#dispose()
    const stored = readMode()
    if (stored) this.mode = stored
    this.#disposers.push(
      ui.onNavigate((target: NavTarget) => {
        if (target.type !== 'search') return false
        this.searchFor(target.data.query)
        return true
      }),
      listenEvent(events.userDataChanged, (e) => {
        if (e.kinds.includes('notes') && this.scope.type === 'notes' && this.results !== null) void this.run()
        // Search history changes travel as `history` (no kind of its own): a restore, a clear elsewhere. The audio
        // glue reports listening the same way, so the reads are coalesced.
        if (e.kinds.includes('history')) this.#reloadHistorySoon()
      }),
      $effect.root(() => {
        // Another layout: the hits' page numbers change.
        let layout = untrack(() => this.layout)
        $effect(() => {
          const next = this.layout
          untrack(() => {
            if (next === layout) return
            layout = next
            if (this.results !== null && this.request !== null) void this.run()
          })
        })
        // A translation scope follows the installed packs (a pack removed, the first one installed).
        $effect(() => {
          const ids = this.translationPacks.map((p) => p.id)
          untrack(() => {
            if (this.scope.type !== 'translation') return
            const current = this.scope.data.packId
            if (current !== '' && ids.includes(current)) return
            const next = ids[0] ?? ''
            if (next === current) return
            this.scope = { type: 'translation', data: { packId: next } }
            void this.run()
          })
        })
      }),
    )
    void this.loadHistory()
  }

  /** Installs how hits open (the search components, once). */
  setOpener(opener: HitOpener | null): void {
    this.#opener = opener
  }

  // --- the query and its options -----------------------------------------------------------------------------------

  /**
   * The field's text: searches 120 ms after the last change. With nothing to search (emptied, or a reference that
   * the panel offers as a jump) the results clear at once.
   */
  setQuery(q: string): void {
    if (q === this.query) return
    this.query = q
    clearTimeout(this.#timer)
    if (this.request === null) {
      void this.run()
      return
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.run()
    }, SEARCH_DEBOUNCE_MS)
  }

  /** Quran, a translation (`packId` '' picks the default installed one) or notes; searches again. */
  setScope(scope: SearchScope): void {
    let next = scope
    if (next.type === 'translation' && next.data.packId === '') {
      next = { type: 'translation', data: { packId: this.defaultPack() } }
    }
    if (sameScope(next, this.scope)) return
    this.scope = next
    void this.run()
  }

  /** The installed translation a translation search uses by default: the reader's first, else any; '' when none. */
  defaultPack(): string {
    return this.translationPacks[0]?.id ?? ''
  }

  setMode(mode: SearchMode): void {
    writeMode(mode)
    if (mode === this.mode) return
    this.mode = mode
    void this.run()
  }

  /** Limits the search to a surah and/or a juz (null clears each; ranges are applied in SQL, §2.2.5). */
  setFilters(filters: { surah?: number | null; juz?: number | null }): void {
    const surah = filters.surah === undefined ? this.surahFilter : filters.surah
    const juz = filters.juz === undefined ? this.juzFilter : filters.juz
    const valid = (n: number | null, max: number) => n === null || (Number.isInteger(n) && n >= 1 && n <= max)
    if (!valid(surah, 114) || !valid(juz, 30)) return
    if (surah === this.surahFilter && juz === this.juzFilter) return
    this.surahFilter = surah
    this.juzFilter = juz
    void this.run()
  }

  clearFilters(): void {
    this.setFilters({ surah: null, juz: null })
  }

  /** Replaces the word being typed with a completion and searches for it at once. */
  useSuggestion(term: string): void {
    const head = this.query.replace(/\S*$/u, '')
    this.query = `${head}${term} `
    void this.run()
  }

  /**
   * Searches for `query` at once, in `scope` when given (a translation scope whose pack is not installed, or `packId`
   * '', takes the default installed translation).
   */
  searchFor(query: string, scope?: SearchScope): void {
    if (scope) {
      const packId = scope.type === 'translation' ? scope.data.packId : null
      const next: SearchScope =
        packId !== null && !this.translationPacks.some((p) => p.id === packId)
          ? { type: 'translation', data: { packId: this.defaultPack() } }
          : scope
      if (!sameScope(next, this.scope)) this.scope = next
    }
    this.query = query
    void this.run()
  }

  /** Runs a recent search again, in its scope. */
  useHistory(entry: SearchHistoryEntry): void {
    this.searchFor(entry.query, entry.scope)
  }

  // --- searching ---------------------------------------------------------------------------------------------------

  /** Searches now for the current state (cancels a pending debounce). */
  async run(): Promise<void> {
    clearTimeout(this.#timer)
    this.#timer = undefined
    const seq = ++this.#seq
    const request = this.request
    if (request === null) {
      this.#clear()
      return
    }
    const key = requestKey(request)
    // The same search again (another layout, a changed note): the active hit stays active.
    const keep = this.results !== null && sameSearch(this.results, request) ? this.activeHit : null
    this.status = 'loading'
    this.#suggest(request)
    try {
      const results = await call(api.searchQuery(request))
      if (seq !== this.#seq) return
      searchOf.set(results, searchKey(request))
      this.results = results
      this.#answered = key
      this.error = null
      this.status = 'done'
      const flat = results.groups.flatMap((g) => g.hits)
      this.activeIndex = keep === null ? -1 : flat.findIndex((h) => hitKey(h) === hitKey(keep))
    } catch (e) {
      if (seq !== this.#seq) return
      this.results = null
      this.#answered = key
      this.error = toIpcError(e)
      this.status = 'error'
      this.activeIndex = -1
    }
  }

  /**
   * Enter in the field (`direction` 1) or Shift+Enter (-1): records the query, then opens the next (previous) hit,
   * keeping focus in the field. A query whose results are not on screen yet is searched first; its first (last) hit
   * opens.
   */
  async submit(direction: 1 | -1 = 1): Promise<void> {
    if (this.request === null) return
    this.#record()
    if (this.stale || this.#timer !== undefined || this.status === 'loading') {
      const seq = this.#seq
      await this.run()
      if (seq + 1 !== this.#seq || this.flatHits.length === 0) return
      this.activeIndex = -1
    }
    this.move(direction, { focus: false })
  }

  /** Opens a hit in the reader and makes it the active one (§1.5). */
  openHit(hit: SearchHit, options: OpenHitOptions = {}): void {
    const index = this.flatHits.indexOf(hit)
    this.activeIndex = index >= 0 ? index : this.flatHits.findIndex((h) => hitKey(h) === hitKey(hit))
    this.#record()
    const focus = options.focus ?? true
    if (this.#opener) this.#opener.open(hit, { highlightWords: hit.matchedWordIds, focus })
    else ui.navigate({ type: 'ayah', data: { ayahId: hit.ayahId } })
  }

  /** Shows a hit's ayah in the side pane without navigating (`Mod+Enter`, middle click). */
  openInPane(hit: SearchHit): void {
    this.#record()
    if (this.#opener) this.#opener.openInPane(hit)
    else ui.navigate({ type: 'ayah', data: { ayahId: hit.ayahId } })
  }

  /**
   * Opens the next (`1`) or previous (`-1`) hit, wrapping around (F3 / Shift+F3, §10.1). Without an active hit, `1`
   * opens the first and `-1` the last. The results list follows `activeIndex`.
   */
  move(delta: 1 | -1, options: OpenHitOptions = {}): void {
    const n = this.flatHits.length
    if (n === 0) return
    const from = this.activeIndex
    const next = from < 0 || from >= n ? (delta > 0 ? 0 : n - 1) : (from + delta + n) % n
    const hit = this.flatHits[next]
    if (!hit) return
    this.openHit(hit, options)
    if (options.focus === false) {
      const ref = quran.refLabel(hit.ayahId, 'long')
      ui.announce(i18n.t('search.announce.hit', { n: next + 1, total: n, ref }))
    }
  }

  // --- history -------------------------------------------------------------------------------------------------------

  async loadHistory(): Promise<void> {
    try {
      this.history = await call(api.searchHistoryList(HISTORY_LIMIT))
    } catch (e) {
      // The history is a convenience: the panel shows the examples without it.
      console.warn('[qd] search: history unavailable', e)
    }
  }

  async clearHistory(): Promise<void> {
    const before = this.history
    this.history = []
    // A query searched again after the clear is recorded again.
    this.#recorded = null
    try {
      await call(api.searchHistoryClear())
    } catch (e) {
      this.history = before
      ui.toastError(e)
    }
  }

  // --- internals -----------------------------------------------------------------------------------------------------

  #clear(): void {
    this.results = null
    this.#answered = null
    this.error = null
    this.status = 'idle'
    this.activeIndex = -1
    this.suggestions = []
    ++this.#suggestSeq
  }

  /** Completions for the word being typed (Quran scope only: the vocabulary is the Quran's). */
  #suggest(request: SearchRequest): void {
    const seq = ++this.#suggestSeq
    if (request.scope.type !== 'quran' || request.mode === 'substring' || /\s$/u.test(this.query)) {
      this.suggestions = []
      return
    }
    call(api.searchSuggest(request.query, SUGGEST_LIMIT)).then(
      (list) => {
        if (seq === this.#suggestSeq) this.suggestions = list
      },
      (e: unknown) => {
        if (seq === this.#suggestSeq) this.suggestions = []
        console.warn('[qd] search: suggestions unavailable', e)
      },
    )
  }

  /** Records the current (query, scope) once (submitting, or opening a hit). */
  #record(): void {
    const request = this.request
    if (request === null) return
    const key = JSON.stringify([request.query, request.scope])
    if (key === this.#recorded) return
    this.#recorded = key
    call(api.searchHistoryAdd(request.query, request.scope)).then(
      () => this.loadHistory(),
      (e: unknown) => console.warn('[qd] search: could not record the query', e),
    )
  }

  #reloadHistorySoon(): void {
    clearTimeout(this.#historyTimer)
    this.#historyTimer = setTimeout(() => {
      this.#historyTimer = undefined
      void this.loadHistory()
    }, HISTORY_RELOAD_MS)
  }

  #dispose(): void {
    for (const dispose of this.#disposers.splice(0)) dispose()
    clearTimeout(this.#historyTimer)
    this.#historyTimer = undefined
  }

  reset(): void {
    this.#dispose()
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#seq++
    this.#suggestSeq++
    this.#answered = null
    this.#recorded = null
    this.query = ''
    this.scope = { type: 'quran' }
    this.mode = 'smart'
    this.surahFilter = null
    this.juzFilter = null
    this.status = 'idle'
    this.results = null
    this.activeIndex = -1
    this.history = []
    this.suggestions = []
    this.error = null
  }
}

export const search = new SearchStore()

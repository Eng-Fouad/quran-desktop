/**
 * `translations` store (layer L1): the ayah text, translation, tafsir and word-by-word caches behind translation mode
 * and the side pane.
 *
 * Caches are plain `Map`s (no deep proxies over thousands of rows). `version` is the only reactive counter: it
 * bumps whenever a cache or a load state changes, and every lookup (`row`, `state`, `tafsirOf`, …) reads it, so
 * templates re-render when data arrives.
 * - `rows`: ayah id → `{ ayah, tr }`. The text comes from `quran_get_ayahs` in the current Mushaf layout (its `page` is
 *   per layout); `tr` holds the translations of `activePacks` in that order (empty while they load or when none).
 * - `tafsir`: `"{packId}:{ayahId}"` → the `TafsirEntry` covering that ayah; a range entry ("Covers 2:255–257") is stored
 *   under every ayah of its range. Bounded to `TAFSIR_CACHE_SIZE` keys, least recently used first out.
 * - `wbw`: word id → `WbwEntry` for the word-by-word pack asked for last (`wbwPackId`); another pack replaces it.
 *
 * Loading (`ensureWindow(from, to)`): what is missing is fetched in aligned blocks of `BLOCK` ayahs (both commands take at
 * most 300), requests in flight are shared, and the promise never rejects: a failure is kept per block (`state(id)`),
 * retried by a later `ensureWindow` after `RETRY_AFTER_MS`, or at once by `retry()`.
 * - Selecting, reordering, installing or removing a translation refetches only the translations; a layout change
 *   refetches only the text. The last window asked for is reloaded at once, so views need no extra wiring.
 * - `activePacks` are the selected translations (`settings.translations`) that are installed. When a request for several
 *   packs fails with `not_found` (a pack removed behind the catalogue's back), each pack is fetched alone, so one broken
 *   pack never hides the others; it is listed in `brokenPacks` until `retry()`.
 *
 * Pack metadata (title, language, direction, size, state) comes from the `packs` store's catalogue when it has
 * loaded, else from a catalogue this store loads itself on demand (`loadCatalog`), else from the bootstrap summaries.
 */
import { untrack } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'
import type { Store } from '$lib/contracts/stores'
import { api, call, events, type IpcError, toIpcError } from '$lib/ipc'
import type {
  AyahText,
  Bootstrap,
  CopyOptions,
  L10nText,
  MushafLayout,
  MushafStyle,
  PackInfo,
  PackKind,
  PackSummary,
  TafsirEntry,
  TextDir,
  TranslationText,
  WbwEntry,
} from '$lib/ipc/bindings'
import { app, listenEvent } from './app.svelte'
import { packs } from './packs.svelte'
import { quran } from './quran.svelte'
import { settings } from './settings.svelte'

/** One cached ayah with its translations, in the requested pack order. */
export interface TranslationRowEntry {
  ayah: AyahText
  tr: TranslationText[]
}

/** Load state of one part of a row: `idle` (never asked for), `loading`, `ready` or `error`. */
export type LoadState = 'idle' | 'loading' | 'ready' | 'error'

/** Load state of an ayah's text and of its translations. */
export interface RowState {
  text: LoadState
  tr: LoadState
  /** The failure behind an `error`, text first. */
  error: IpcError | null
}

/** Where a pack stands, from the catalogue: `unknown` when no catalogue lists it. */
export type PackAvailability = 'installed' | 'not_installed' | 'downloading' | 'failed' | 'unknown'

/** What the views need to know about a content pack. */
export interface PackMeta {
  id: string
  kind: PackKind | null
  title: L10nText
  /** BCP 47 language of the content (`en`, `ur`, …), when known. */
  language: string | null
  dir: TextDir
  availability: PackAvailability
  /** Fetched per chapter on demand (Quran.com tafsir, word by word) rather than installed whole. */
  onDemand: boolean
  sizeKib: number | null
  recommended: boolean
}

/**
 * Where translation mode stood: the verse at the top edge and how far the view was scrolled past the top of its row
 * (px, ≥ 0). For ayah 1 the row is its surah card (the card opens the surah), so the distance is measured from the
 * card. It is what a `translation` `ReadingPosition` stores (`ayahId`, `scrollPx`).
 */
export interface ScrollAnchor {
  ayahId: number
  delta: number
  /** The page translation mode reported to the reader with it: the anchor holds while the reader is still there. */
  page: number
}

/** Ayahs per request block. Aligned (`1–50`, `51–100`, …) so neighbouring windows share blocks. */
export const BLOCK = 50
/** A failed block is retried by `ensureWindow` only after this long (`retry()` retries at once). */
export const RETRY_AFTER_MS = 4000
/** `translation_get` takes at most 5 packs. */
export const MAX_PACKS = 5
/** Word-by-word entries are fetched in aligned chunks of this many words (`wbw_get_range` takes ≤ 2000). */
export const WBW_CHUNK = 500
/** Tafsir keys (`pack:ayah`) kept in memory. */
export const TAFSIR_CACHE_SIZE = 800

const AYAH_COUNT = 6236
const WORD_COUNT = 83_665

/** Languages written right to left (content packs that carry no `direction`). */
const RTL_LANGUAGES = new Set(['ar', 'ur', 'fa', 'ps', 'he', 'ug', 'ckb', 'sd', 'dv', 'yi', 'ku'])

const LAYOUT_OF: Record<MushafStyle, MushafLayout> = { hafs: 'v2', qcf_v2: 'v2', qcf_v1: 'v1', qcf_v4: 'v4' }

/** A pack's state type as availability. `update_available` is still installed (the old version works). */
function availabilityOf(type: string | undefined, jobPhase?: string): PackAvailability {
  if (jobPhase !== undefined && jobPhase !== 'completed' && jobPhase !== 'failed' && jobPhase !== 'cancelled')
    return 'downloading'
  switch (type) {
    case 'installed':
    case 'update_available':
      return 'installed'
    case 'paused':
    case 'partial':
      return 'downloading'
    case 'failed':
      return 'failed'
    case 'not_installed':
      return 'not_installed'
    default:
      return 'unknown'
  }
}

/** The text direction of a language code (`ur` → rtl). */
export function dirOfLanguage(language: string | null): TextDir {
  if (!language) return 'ltr'
  return RTL_LANGUAGES.has(language.toLowerCase().split('-')[0] ?? '') ? 'rtl' : 'ltr'
}

/** `tr.en.saheeh` → `en`; `tafsir.ar.muyassar` → `ar`; `wbw.ur` → `ur`. */
export function languageOfPackId(id: string): string | null {
  const parts = id.split('.')
  const lang = parts[1]
  return lang && /^[a-z]{2,3}$/.test(lang) ? lang : null
}

/** The aligned block an ayah belongs to (0-based). */
export function blockOf(ayahId: number): number {
  return Math.floor((ayahId - 1) / BLOCK)
}

/** The inclusive ayah range of a block, clamped to the Quran. */
export function blockRange(block: number, last = AYAH_COUNT): [number, number] {
  const from = block * BLOCK + 1
  return [from, Math.min(last, from + BLOCK - 1)]
}

interface Block {
  /** The request in flight, if any. */
  promise: Promise<void> | null
  done: boolean
  error: IpcError | null
  /** `Date.now()` of the failure. */
  failedAt: number
}

const newBlock = (): Block => ({ promise: null, done: false, error: null, failedAt: 0 })

class TranslationsStore implements Store {
  /** Bumped whenever a cache or a load state changes: read it (through the lookups) to stay reactive. */
  version = $state(0)
  rows = new Map<number, TranslationRowEntry>()
  tafsir = new Map<string, TafsirEntry>()
  wbw = new Map<number, WbwEntry>()
  /** The WBW pack `wbw` holds entries of. */
  wbwPackId: string | null = null
  /**
   * Where translation mode was scrolled to (written by `TranslationView` as it scrolls, read when it mounts again),
   * so leaving and re-entering the mode lands on the same pixel (the position is kept by ayah).
   */
  anchor: ScrollAnchor | null = null
  /**
   * The verse translation mode is reading now: the one at the top of its viewport (set by `TranslationView`, only when
   * it changes). `null` outside translation mode. The reader can save it as the `translation` position.
   */
  topAyahId = $state<number | null>(null)

  /** The bootstrap's pack summaries (the catalogue of last resort). */
  #summaries = $state.raw<readonly PackSummary[]>([])
  /** A catalogue this store loaded itself, while the `packs` store has none. */
  #catalog = $state.raw<readonly PackInfo[] | null>(null)
  #catalogLoading: Promise<void> | null = null
  /** Packs whose requests failed with `not_found` although the catalogue lists them as installed. */
  #broken = new SvelteMap<string, IpcError>()

  /** Layout of the cached text, and the packs of the cached translations (`|`-joined). */
  #textKey = ''
  #trKey = ''
  #texts = new Map<number, AyahText>()
  #trs = new Map<number, TranslationText[]>()
  #textBlocks = new Map<number, Block>()
  #trBlocks = new Map<number, Block>()
  /** Bumped when a cache is dropped: answers to requests started before never land in the new cache. */
  #textEpoch = 0
  #trEpoch = 0
  #lastWindow: [number, number] | null = null

  #tafsirInflight = new Map<string, Promise<TafsirEntry>>()
  #wbwChunks = new Map<number, Block>()
  #wbwEpoch = 0

  #disposers: (() => void)[] = []

  /** The layout translation mode reads text in (the Mushaf style's layout). */
  readonly layout: MushafLayout = $derived(LAYOUT_OF[settings.value.mushafStyle])

  /** The selected translations (`settings.translations`), each once, at most `MAX_PACKS`, in the user's order. */
  readonly selectedPacks: readonly string[] = $derived.by(() => {
    const out: string[] = []
    for (const id of settings.value.translations) {
      if (out.length >= MAX_PACKS) break
      if (id.trim() !== '' && !out.includes(id)) out.push(id)
    }
    return out
  })

  /** The selected translations that can be read now: installed (or not listed by any catalogue) and not broken. */
  readonly activePacks: readonly string[] = $derived.by(() =>
    this.selectedPacks.filter((id) => {
      const availability = this.packMeta(id).availability
      return (availability === 'installed' || availability === 'unknown') && !this.#broken.has(id)
    }),
  )

  /** Selected translations that are not installed (yet): not downloaded, downloading or failed. */
  readonly missingPacks: readonly PackMeta[] = $derived.by(() =>
    this.selectedPacks
      .map((id) => this.packMeta(id))
      .filter((m) => m.availability !== 'installed' && m.availability !== 'unknown'),
  )

  /** Selected translations the backend could not open, with the error. */
  readonly brokenPacks: readonly { meta: PackMeta; error: IpcError }[] = $derived.by(() =>
    [...this.#broken].map(([id, error]) => ({ meta: this.packMeta(id), error })),
  )

  /** Every translation pack the catalogue knows, installed ones first, then in catalogue order. */
  readonly translationCatalog: readonly PackMeta[] = $derived.by(() => {
    const metas = this.#catalogEntries()
      .filter((p) => p.kind === 'translation')
      .map((p) => this.packMeta(p.id))
    return [
      ...metas.filter((m) => m.availability === 'installed'),
      ...metas.filter((m) => m.availability !== 'installed'),
    ]
  })

  init(b: Bootstrap): void {
    this.#dispose()
    this.#summaries = b.packs
    // The saved translation-mode position: translation mode reopens on the same pixel.
    const saved = b.positions.find((p) => p.context === 'translation')
    this.anchor = saved
      ? {
          ayahId: saved.ayahId,
          delta: Math.max(0, saved.scrollPx ?? 0),
          page:
            saved.page !== null && saved.layout === this.layout
              ? saved.page
              : quran.pageOfAyah(this.layout, saved.ayahId),
        }
      : null
    this.#disposers.push(listenEvent(events.packsChanged, ({ packIds }) => this.#packsChanged(packIds)))
    this.#disposers.push(
      $effect.root(() => {
        // Drop what no longer matches the settings (layout, selected and installed packs) and reload the last window.
        $effect(() => {
          const textKey = this.layout
          const trKey = this.activePacks.join('|')
          untrack(() => this.#sync(textKey, trKey))
        })
      }),
    )
  }

  // --- lookups (reactive through `version`) --------------------------------------------------------------------------

  /** The cached row of an ayah (text loaded), or `undefined`. */
  row(ayahId: number): TranslationRowEntry | undefined {
    void this.version
    return this.rows.get(ayahId)
  }

  /** Load state of an ayah's text and translations. */
  state(ayahId: number): RowState {
    void this.version
    const textBlock = this.#textBlocks.get(blockOf(ayahId))
    const trBlock = this.#trBlocks.get(blockOf(ayahId))
    const text = this.#texts.has(ayahId) ? 'ready' : blockState(textBlock)
    const tr = this.activePacks.length === 0 || this.#trs.has(ayahId) ? 'ready' : blockState(trBlock)
    return { text, tr, error: textBlock?.error ?? trBlock?.error ?? null }
  }

  /** What the catalogue says about a pack (title, language, direction, size, availability). */
  packMeta(id: string): PackMeta {
    const fromPacks = packs.list.find((p) => p.id === id)
    const info = fromPacks ?? this.#catalog?.find((p) => p.id === id)
    const job = packs.jobs.get(id)
    if (info) {
      const language = info.language ?? languageOfPackId(id)
      return {
        id,
        kind: info.kind,
        title: info.title,
        language,
        dir: info.direction ?? dirOfLanguage(language),
        availability: availabilityOf(info.state.type, job?.phase),
        onDemand: info.installMode === 'on_demand',
        sizeKib: info.sizeKib,
        recommended: info.recommended,
      }
    }
    const summary = this.#summaries.find((p) => p.id === id)
    const language = summary?.language ?? languageOfPackId(id)
    return {
      id,
      kind: summary?.kind ?? null,
      title: summary?.title ?? { en: id, ar: id },
      language,
      dir: dirOfLanguage(language),
      availability: summary ? availabilityOf(summary.state.type, job?.phase) : 'unknown',
      onDemand: summary?.kind === 'wbw',
      sizeKib: null,
      recommended: false,
    }
  }

  /** The pack's title in the UI language. */
  packTitle(id: string): string {
    const { title } = this.packMeta(id)
    return settings.value.uiLanguage === 'ar' ? title.ar || title.en : title.en || title.ar
  }

  /** The cached tafsir entry covering an ayah, if any (reactive). */
  tafsirOf(packId: string, ayahId: number): TafsirEntry | undefined {
    void this.version
    return this.tafsir.get(`${packId}:${ayahId}`)
  }

  // --- loading -------------------------------------------------------------------------------------------------------

  /**
   * Loads the text and the active translations of `[from, to]` (clamped to the Quran) that are not cached yet. Resolves
   * when every block of the window has an answer; never rejects (failures are in `state(id)`). Untracked, so an
   * `$effect` may call it without depending on the store.
   *
   * The window is remembered: a layout or pack change reloads it, and `retry()` re-ensures it. A side load (the study
   * pane's ayahs) passes `remember: false`, so it never replaces the feed's window.
   */
  ensureWindow(from: number, to: number, opts: { remember?: boolean } = {}): Promise<void> {
    return untrack(() => {
      const last = this.#ayahCount()
      const a = Math.max(1, Math.floor(Math.min(from, to)))
      const b = Math.min(last, Math.ceil(Math.max(from, to)))
      if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return Promise.resolve()
      if (opts.remember ?? true) this.#lastWindow = [a, b]
      // The settings may have changed in this tick, before the effect ran: settle the caches first.
      this.#sync(this.layout, this.activePacks.join('|'))
      const work: Promise<void>[] = []
      for (let k = blockOf(a); k <= blockOf(b); k++) {
        work.push(this.#loadText(k, false))
        if (this.activePacks.length > 0) work.push(this.#loadTranslations(k, false))
      }
      return Promise.all(work).then(() => undefined)
    })
  }

  /**
   * Retries at once: the blocks around `ayahId` (or every failed block), and packs reported broken. Resolves when the
   * retried requests have answered.
   */
  async retry(ayahId?: number): Promise<void> {
    const work = untrack(() => {
      this.#broken.clear()
      const out: Promise<void>[] = []
      const blocks =
        ayahId !== undefined
          ? [blockOf(ayahId)]
          : [...new Set([...failed(this.#textBlocks), ...failed(this.#trBlocks)])]
      for (const k of blocks) {
        out.push(this.#loadText(k, true))
        if (this.activePacks.length > 0) out.push(this.#loadTranslations(k, true))
      }
      return out
    })
    await Promise.all(work)
    const window = this.#lastWindow
    if (window) await this.ensureWindow(...window)
  }

  /**
   * The tafsir entry of `packId` that covers `ayahId` (it may span a range). Cached per ayah of the range; concurrent
   * calls share one request. Rejects with the `IpcError` (offline and not cached: `offline`; unknown pack: `not_found`).
   */
  tafsirFor(packId: string, ayahId: number): Promise<TafsirEntry> {
    const key = `${packId}:${ayahId}`
    const cached = this.tafsir.get(key)
    // A stale entry (saved over 7 days ago) is fetched again once the network is back.
    if (cached && !(cached.stale && untrack(() => app.online))) {
      // Most recently used last, so eviction drops what was read longest ago.
      this.tafsir.delete(key)
      this.tafsir.set(key, cached)
      return Promise.resolve(cached)
    }
    const inflight = this.#tafsirInflight.get(key)
    if (inflight) return inflight
    const request = (async () => {
      try {
        const entry = await call(api.tafsirGet(packId, ayahId))
        const from = Math.min(entry.fromAyahId, ayahId)
        const to = Math.max(entry.toAyahId, ayahId)
        for (let a = from; a <= to; a++) this.tafsir.set(`${packId}:${a}`, entry)
        this.#evictTafsir()
        this.#bump()
        return entry
      } catch (e) {
        throw toIpcError(e)
      } finally {
        this.#tafsirInflight.delete(key)
      }
    })()
    this.#tafsirInflight.set(key, request)
    return request
  }

  /**
   * The word-by-word entries of `packId` for the words `[fromWord, toWord]` (end markers have none), in word order.
   * Fetched in aligned chunks of `WBW_CHUNK` words and cached; another pack replaces the cache. A chunk can reach into a
   * surah that is not cached: offline, the exact range is asked for instead, which succeeds when its own surah is
   * cached. Rejects with the `IpcError` of the failed request (offline and not cached: `offline`).
   */
  async wbwForRange(packId: string, fromWord: number, toWord: number): Promise<WbwEntry[]> {
    if (packId !== this.wbwPackId) {
      this.wbwPackId = packId
      this.wbw.clear()
      this.#wbwChunks.clear()
      this.#wbwEpoch++
      this.#bump()
    }
    const a = Math.max(1, Math.floor(Math.min(fromWord, toWord)))
    const b = Math.min(WORD_COUNT, Math.ceil(Math.max(fromWord, toWord)))
    if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return []
    const work: Promise<void>[] = []
    for (let k = Math.floor((a - 1) / WBW_CHUNK); k <= Math.floor((b - 1) / WBW_CHUNK); k++)
      work.push(this.#loadWbwChunk(packId, k))
    await Promise.all(work)
    const failure = [...this.#wbwChunks.entries()].find(
      ([k, c]) => c.error && k >= Math.floor((a - 1) / WBW_CHUNK) && k <= Math.floor((b - 1) / WBW_CHUNK),
    )
    const error = failure?.[1].error
    if (error) {
      if (error.kind !== 'offline') throw error
      const epoch = this.#wbwEpoch
      let entries: WbwEntry[]
      try {
        entries = await call(api.wbwGetRange(packId, a, b))
      } catch {
        throw error
      }
      if (epoch === this.#wbwEpoch) {
        for (const entry of entries) this.wbw.set(entry.wordId, entry)
        this.#bump()
      }
      return entries.filter((e) => e.wordId >= a && e.wordId <= b).sort((x, y) => x.wordId - y.wordId)
    }
    const out: WbwEntry[] = []
    for (let w = a; w <= b; w++) {
      const entry = this.wbw.get(w)
      if (entry) out.push(entry)
    }
    return out
  }

  /**
   * Copies ayahs `[from, to]` to the clipboard in the user's copy format (`settings.copy`), with the first active
   * translation (or the copy settings' pack) appended when `withTranslation`. Resolves with the text; rejects with the
   * `IpcError` of the command or a clipboard failure (`internal`).
   */
  async copyAyahs(fromAyahId: number, toAyahId: number, withTranslation = false): Promise<string> {
    const copy = settings.value.copy
    const options: CopyOptions = {
      includeReference: copy.includeReference,
      referenceStyle: copy.referenceStyle,
      ayahNumbers: copy.ayahNumbers,
      translationPackId: withTranslation
        ? (copy.translationPackId ?? this.activePacks[0] ?? null)
        : copy.translationPackId,
    }
    const from = Math.min(fromAyahId, toAyahId)
    const to = Math.max(fromAyahId, toAyahId)
    const text = await call(api.quranCopyText(from, to, options))
    try {
      await navigator.clipboard.writeText(text)
    } catch (e) {
      throw toIpcError(e instanceof Error ? e.message : e)
    }
    return text
  }

  /**
   * Loads the full catalogue (`packs_list`) when the `packs` store has none yet, for the "Add a translation" card
   * (sizes, recommendations). Errors are logged: the bootstrap summaries still name the packs.
   */
  loadCatalog(): Promise<void> {
    if (untrack(() => packs.list.length > 0 || this.#catalog !== null)) return Promise.resolve()
    return this.#refreshCatalog()
  }

  reset(): void {
    this.#dispose()
    this.rows.clear()
    this.tafsir.clear()
    this.wbw.clear()
    this.wbwPackId = null
    this.anchor = null
    this.topAyahId = null
    this.#summaries = []
    this.#catalog = null
    this.#catalogLoading = null
    this.#broken.clear()
    this.#textKey = ''
    this.#trKey = ''
    this.#texts.clear()
    this.#trs.clear()
    this.#textBlocks.clear()
    this.#trBlocks.clear()
    this.#textEpoch++
    this.#trEpoch++
    this.#lastWindow = null
    this.#tafsirInflight.clear()
    this.#wbwChunks.clear()
    this.#wbwEpoch++
    this.version = 0
  }

  // --- internals -----------------------------------------------------------------------------------------------------

  #ayahCount(): number {
    return quran.ayahCount > 0 ? quran.ayahCount : AYAH_COUNT
  }

  #catalogEntries(): readonly (PackInfo | PackSummary)[] {
    if (packs.list.length > 0) return packs.list
    return this.#catalog ?? this.#summaries
  }

  /** Drops caches that no longer match the layout or the active packs, then reloads the last window. */
  #sync(textKey: string, trKey: string): void {
    let changed = false
    if (textKey !== this.#textKey) {
      this.#textKey = textKey
      this.#texts.clear()
      this.#textBlocks.clear()
      this.#textEpoch++
      this.rows.clear()
      changed = true
    }
    if (trKey !== this.#trKey) {
      const before = this.#trKey === '' ? [] : this.#trKey.split('|')
      const after = trKey === '' ? [] : trKey.split('|')
      this.#trKey = trKey
      this.#trEpoch++
      if (before.length > 0 && after.every((id) => before.includes(id))) {
        // Packs removed or reordered: what is cached still holds; keep it, in the new order. Requests in flight carry
        // the old set: they are discarded (epoch) and their blocks load again.
        for (const [k, block] of this.#trBlocks) if (block.promise && !block.done) this.#trBlocks.delete(k)
        for (const [id, items] of this.#trs) {
          const kept = orderItems(
            items.filter((t) => after.includes(t.packId)),
            after,
          )
          this.#trs.set(id, kept)
          const row = this.rows.get(id)
          if (row) this.rows.set(id, { ayah: row.ayah, tr: kept })
        }
      } else {
        this.#trs.clear()
        this.#trBlocks.clear()
        for (const [id, row] of this.rows) this.rows.set(id, { ayah: row.ayah, tr: [] })
      }
      changed = true
    }
    if (!changed) return
    this.#bump()
    const window = this.#lastWindow
    if (window) {
      // Re-enter through ensureWindow on a microtask, so this never runs inside the effect that called it.
      queueMicrotask(() => void this.ensureWindow(...window))
    }
  }

  /**
   * Runs one block's request. `apply` writes the answer unless the cache it belongs to was dropped meanwhile
   * (`current()` is false); the block is marked done first, so whatever `apply` triggers sees it loaded.
   */
  #start<T>(
    block: Block,
    current: () => boolean,
    request: Promise<T>,
    apply: (data: T) => void,
  ): Promise<void> {
    block.error = null
    const p: Promise<void> = request
      .then(
        (data) => {
          if (!current()) return
          block.done = true
          apply(data)
        },
        (e: unknown) => {
          if (!current()) return
          block.error = toIpcError(e)
          block.failedAt = Date.now()
        },
      )
      .finally(() => {
        if (block.promise === p) block.promise = null
        if (current()) this.#bump()
      })
    block.promise = p
    this.#bump()
    return p
  }

  #loadText(k: number, force: boolean): Promise<void> {
    const block = this.#textBlocks.get(k) ?? newBlock()
    if (!shouldLoad(block, force)) return block.promise ?? Promise.resolve()
    this.#textBlocks.set(k, block)
    const epoch = this.#textEpoch
    const [a, b] = blockRange(k, this.#ayahCount())
    return this.#start(
      block,
      () => epoch === this.#textEpoch,
      call(api.quranGetAyahs(this.layout, a, b)),
      (list) => {
        for (const ayah of list) {
          this.#texts.set(ayah.id, ayah)
          this.rows.set(ayah.id, { ayah, tr: this.#trs.get(ayah.id) ?? [] })
        }
      },
    )
  }

  #loadTranslations(k: number, force: boolean): Promise<void> {
    const block = this.#trBlocks.get(k) ?? newBlock()
    if (!shouldLoad(block, force)) return block.promise ?? Promise.resolve()
    this.#trBlocks.set(k, block)
    const epoch = this.#trEpoch
    const [a, b] = blockRange(k, this.#ayahCount())
    return this.#start(
      block,
      () => epoch === this.#trEpoch,
      this.#fetchTranslations([...this.activePacks], a, b),
      ({ rows, broken }) => {
        for (let id = a; id <= b; id++) {
          const items = rows.get(id) ?? []
          this.#trs.set(id, items)
          const row = this.rows.get(id)
          if (row) this.rows.set(id, { ayah: row.ayah, tr: items })
        }
        // After the rows: dropping a broken pack from `activePacks` keeps what was just loaded for the others.
        for (const [id, err] of broken) this.#markBroken(id, err)
      },
    )
  }

  /**
   * `translation_get` for every pack at once; when that fails with `not_found`, each pack alone, reporting the ones
   * that fail as broken (they leave `activePacks`). A single pack that fails is broken at once and the block fails.
   */
  async #fetchTranslations(
    ids: string[],
    from: number,
    to: number,
  ): Promise<{ rows: ReadonlyMap<number, TranslationText[]>; broken: [string, IpcError][] }> {
    try {
      const list = await call(api.translationGet(ids, from, to))
      return { rows: new Map(list.map((row) => [row.ayahId, orderItems(row.items, ids)])), broken: [] }
    } catch (e) {
      const err = toIpcError(e)
      if (err.kind !== 'not_found' || ids.length < 2) {
        if (err.kind === 'not_found' && ids[0] !== undefined) this.#markBroken(ids[0], err)
        throw err
      }
    }
    const broken: [string, IpcError][] = []
    /** Items per ayah id, merged from the single-pack answers. */
    const merged: Record<number, TranslationText[]> = {}
    const results = await Promise.allSettled(ids.map((id) => call(api.translationGet([id], from, to))))
    results.forEach((r, i) => {
      const id = ids[i]
      if (id === undefined) return
      if (r.status === 'rejected') {
        broken.push([id, toIpcError(r.reason)])
        return
      }
      for (const row of r.value) (merged[row.ayahId] ??= []).push(...row.items)
    })
    if (broken.length === ids.length && broken[0]) {
      for (const [id, err] of broken) this.#markBroken(id, err)
      throw broken[0][1]
    }
    const rows = new Map(
      Object.entries(merged).map(([ayahId, items]) => [Number(ayahId), orderItems(items, ids)]),
    )
    return { rows, broken }
  }

  #markBroken(id: string, err: IpcError): void {
    if (untrack(() => this.#broken.has(id))) return
    console.warn(`[qd] translation ${id} could not be opened`, err)
    this.#broken.set(id, err)
  }

  #loadWbwChunk(packId: string, k: number): Promise<void> {
    const chunk = this.#wbwChunks.get(k) ?? newBlock()
    if (!shouldLoad(chunk, chunk.error !== null)) return chunk.promise ?? Promise.resolve()
    this.#wbwChunks.set(k, chunk)
    const epoch = this.#wbwEpoch
    const from = k * WBW_CHUNK + 1
    const to = Math.min(WORD_COUNT, from + WBW_CHUNK - 1)
    return this.#start(
      chunk,
      () => epoch === this.#wbwEpoch,
      call(api.wbwGetRange(packId, from, to)),
      (entries) => {
        for (const entry of entries) this.wbw.set(entry.wordId, entry)
      },
    )
  }

  #evictTafsir(): void {
    while (this.tafsir.size > TAFSIR_CACHE_SIZE) {
      const oldest = this.tafsir.keys().next()
      if (oldest.done) break
      this.tafsir.delete(oldest.value)
    }
  }

  /** `packs_list` into the store's own catalogue (only used while the `packs` store has none). Shared while in flight. */
  #refreshCatalog(): Promise<void> {
    this.#catalogLoading ??= call(api.packsList())
      .then((list) => {
        this.#catalog = list
      })
      .catch((e: unknown) => console.warn('[qd] the pack catalogue could not be loaded', e))
      .finally(() => {
        this.#catalogLoading = null
      })
    return this.#catalogLoading
  }

  /** Bumps `version` without reading it in the caller's reactive context. */
  #bump(): void {
    untrack(() => this.version++)
  }

  /**
   * `PacksChanged` (install, update, removal, an on-demand chapter fetched, Clear cache). Installed state reaches
   * `activePacks` through the catalogue (the `packs` store refreshes its own; this store refreshes the one it loaded).
   * A changed translation in use reloads; a whole tafsir pack that changed drops its cached entries. On-demand chapters
   * (Quran.com tafsir, word by word) keep theirs: fetching or clearing a chapter does not change what was read.
   */
  #packsChanged(ids: readonly string[]): void {
    if (ids.length === 0) return
    untrack(() => {
      const touched = new Set(ids)
      if (packs.list.length === 0 && (this.#catalog !== null || this.#summaries.length > 0)) {
        void this.#refreshCatalog()
      }
      let changed = false
      for (const id of touched) if (this.#broken.delete(id)) changed = true
      // A translation in use was updated (or reinstalled): its text may differ, so the translations reload.
      if (this.activePacks.some((id) => touched.has(id))) {
        this.#trKey = ''
        changed = true
      }
      const dropped = new Set([...touched].filter((id) => !this.packMeta(id).onDemand))
      for (const key of [...this.tafsir.keys()]) {
        if (dropped.has(key.slice(0, key.lastIndexOf(':')))) {
          this.tafsir.delete(key)
          changed = true
        }
      }
      if (changed) {
        this.#bump()
        this.#sync(this.layout, this.activePacks.join('|'))
      }
    })
  }

  #dispose(): void {
    for (const dispose of this.#disposers.splice(0)) dispose()
  }
}

function blockState(block: Block | undefined): LoadState {
  if (!block) return 'idle'
  if (block.promise) return 'loading'
  if (block.error) return 'error'
  return block.done ? 'ready' : 'idle'
}

function shouldLoad(block: Block, force: boolean): boolean {
  if (block.promise) return false
  if (block.done) return false
  if (block.error && !force && Date.now() - block.failedAt < RETRY_AFTER_MS) return false
  return true
}

function failed(blocks: Map<number, Block>): number[] {
  return [...blocks].filter(([, b]) => b.error !== null).map(([k]) => k)
}

/** Items in the requested pack order (the command promises it; per-pack fallbacks are merged here). */
function orderItems(items: readonly TranslationText[], ids: readonly string[]): TranslationText[] {
  return [...items].sort((x, y) => ids.indexOf(x.packId) - ids.indexOf(y.packId))
}

export const translations = new TranslationsStore()

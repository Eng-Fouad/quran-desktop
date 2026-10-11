/**
 * `packs` store (§7.3): the catalogue with each pack's state, download jobs (Channel `DownloadEvent`), on-demand
 * items (`packs_items`), disk usage, updates, the Downloads filters and the onboarding starter set (§2.5.4). Owner:
 * WP12a. Layer L1 (imports `app`, `settings`, `i18n`, `quran`, `ui`).
 *
 * - **Jobs.** `jobs` maps a pack id to its live job (queued, running, paused or failed), fed by the subscription
 *   snapshot and the download events; a completed or cancelled job leaves the map. A list refresh only adds jobs the
 *   map does not know, never brings back one that ended.
 * - **One job per pack** (§2.5.5): asking for more items of a pack whose job is queued or running does not fail with
 *   `conflict`: the items wait in `pending` (shown as queued) and start as the next job when this one completes.
 * - **Freshness.** `packs-changed` refreshes the list, the items of the packs it names (when loaded) and the disk
 *   usage (when loaded); progress that finishes items reloads that pack's items, so a surah grid fills live.
 * - **Connectivity.** Jobs that failed with `offline` resume when the app is online with network use allowed.
 *   `installWhenOnline` (the dock's "Download when online") is a request, not a job that must fail: while the app is
 *   offline or network use is off it waits in `waiting` ("Waits for a connection") and starts by itself once
 *   downloads can run. A job started that way that still fails for being offline waits again, without a failure toast.
 * - **Errors.** Commands reject with `IpcError`; callers show them (`ui.toastError`). Job outcomes toast here (with
 *   Retry on a failure), except while the Downloads view shows them in place.
 * - **The rail's flyout** (owner request 2026-10-11) reads `waitingIds` (what waits for a connection), `failedJobs`
 *   and `recent`: the last jobs that completed this session, newest first (a completed job leaves `jobs`).
 */
import { Channel } from '@tauri-apps/api/core'
import { untrack } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'
import { SETTING_LIMITS } from '$lib/contracts/settings'
import type { Store } from '$lib/contracts/stores'
import { api, call, events, toAppError, type AppError } from '$lib/ipc'
import type {
  Bootstrap,
  DiskUsage,
  DownloadEvent,
  InstallScope,
  JobPhase,
  JobSnapshot,
  MushafStyle,
  PackInfo,
  PackItemState,
  PackKind,
  PackUpdate,
  QuranIndex,
  UiLanguage,
} from '$lib/ipc/bindings'
import { app, listenEvent } from './app.svelte'
import { i18n } from './i18n.svelte'
import { quran } from './quran.svelte'
import { settings } from './settings.svelte'
import { ui } from './ui.svelte'

/** Phases of a job that is queued or doing work (the NavRail's progress ring). */
export const ACTIVE_PHASES: readonly JobPhase[] = ['queued', 'downloading', 'verifying', 'installing']

export function isActivePhase(phase: JobPhase): boolean {
  return ACTIVE_PHASES.includes(phase)
}

/** An installed version exists (it may have an update). */
export function isInstalled(p: PackInfo): boolean {
  return p.state.type === 'installed' || p.state.type === 'update_available'
}

/** Some of the pack is on disk: installed, or items of an on-demand pack. */
export function hasContent(p: PackInfo): boolean {
  if (isInstalled(p)) return true
  if (p.state.type === 'partial' || p.state.type === 'paused') return p.state.data.itemsPresent > 0
  return p.installedKib > 0
}

/** The BCP-47 primary subtag of a pack's content language (`en-US` → `en`), or null. */
export function languageOf(p: PackInfo): string | null {
  return p.language ? (p.language.split('-')[0] ?? '').toLowerCase() || null : null
}

/** The QDC reciter id of a recitation pack (`audio.qdc.7` → 7), else null. */
export function reciterIdOf(packId: string): number | null {
  const m = /^audio\.qdc\.(\d+)$/.exec(packId)
  return m ? Number(m[1]) : null
}

/** The page-font pack of a Mushaf style (`qcf_v2` → `mushaf.v2`); hafs has none. */
export function mushafPackId(style: MushafStyle): string | null {
  return style === 'hafs' ? null : `mushaf.${style.slice(4)}`
}

/** What an item of a per-item pack is (§2.5.3): pages (Mushaf fonts), surahs (recitation), chapters (WBW, tafsir). */
export type ItemNoun = 'page' | 'surah' | 'chapter'

export function itemNoun(kind: PackKind): ItemNoun {
  if (kind === 'mushaf_fonts') return 'page'
  if (kind === 'recitation') return 'surah'
  return 'chapter'
}

/** Word count per surah (index 0 = surah 1), the weight of a surah's recitation or chapter in a pack's size. */
export function surahWords(index: QuranIndex, totalWords = 83_665): number[] {
  const first = (n: number): number => {
    const s = index.surahs[n - 1]
    return s ? (index.ayahFirstWord[s.firstAyahId - 1] ?? 0) : 0
  }
  const out: number[] = []
  for (let n = 1; n <= index.surahs.length; n++) {
    const start = first(n)
    const end = n < index.surahs.length ? first(n + 1) : Math.max(totalWords + 1, start + 1)
    out.push(Math.max(1, end - start))
  }
  return out
}

/** When a starter-set pack is fetched (`quran_packs::StarterFetch`). */
export type StarterFetch = 'now' | 'on_demand' | 'timings_on_first_play'

export interface StarterItem {
  pack: PackInfo
  fetch: StarterFetch
  /** KiB that "Download now" fetches for this pack: its size when `now` and not yet installed, else 0. */
  kib: number
}

/** The exact onboarding starter set (§2.5.4), in its order, with the exact "Download now" total. */
export interface StarterSet {
  items: StarterItem[]
  nowKib: number
}

/** A job that completed this session (the Downloads flyout's "Recently finished"). */
export interface FinishedJob {
  packId: string
  jobId: number
  /** KiB the job downloaded (its last total; 0 when unknown). */
  kib: number
  /** It installed a newer version of an installed pack. */
  update: boolean
  /** The items it downloaded (a surah, pages), or null for the whole pack. */
  items: number[] | null
  /** When it completed (ms). */
  at: number
}

/** How many finished jobs `recent` keeps. */
export const RECENT_KEPT = 5

/** What onboarding chose (§9.7 steps 1–3). */
export interface StarterChoices {
  uiLanguage: UiLanguage
  /** The translation (or tafsir) pack; `undefined` = the UI language's default, `null` = none. */
  translation?: string | null
  style: MushafStyle
  /** "Download all pages in the background" (off by default). */
  downloadAllPages?: boolean
  reciterId: number
}

/** Ordering of a job's phases (a newer snapshot of the same job never goes back). */
const PHASE_RANK: Record<JobPhase, number> = {
  queued: 0,
  downloading: 1,
  verifying: 2,
  installing: 3,
  paused: 4,
  failed: 4,
  completed: 5,
  cancelled: 5,
}

const REFRESH_DEBOUNCE_MS = 120
const ITEMS_THROTTLE_MS = 350
const USAGE_DEBOUNCE_MS = 400
/** `checkUpdates({ ifStale: true })` asks again after this long. */
const UPDATE_CHECK_EVERY_MS = 6 * 3_600_000
const ENDED_KEPT = 512

function blankJob(jobId: number, packId: string): JobSnapshot {
  return {
    jobId,
    packId,
    phase: 'queued',
    receivedKib: 0,
    totalKib: 0,
    itemsDone: 0,
    itemsTotal: 0,
    rateKibS: 0,
    etaS: null,
    error: null,
  }
}

function mergeScope(a: InstallScope, b: InstallScope): InstallScope {
  if (a.type === 'all' || b.type === 'all') return { type: 'all' }
  return {
    type: 'items',
    data: { items: [...new Set([...a.data.items, ...b.data.items])].sort((x, y) => x - y) },
  }
}

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

class PacksStore implements Store {
  list = $state.raw<PackInfo[]>([])
  jobs = new SvelteMap<string, JobSnapshot>()
  items = new SvelteMap<string, PackItemState[]>()
  usage = $state.raw<DiskUsage | null>(null)
  updates = $state.raw<PackUpdate[]>([])
  /** Downloads view filters: the kind tab (`mushaf_fonts` also shows the ornament packs), language, search. */
  filter = $state<PackKind | 'all'>('all')
  language = $state<string>('all')
  query = $state('')
  /** The catalogue load (`packs_list`). */
  status = $state<LoadStatus>('idle')
  error = $state.raw<AppError | null>(null)
  /** Items asked for while a job of the pack runs; they start as its next job (one job per pack, §2.5.5). */
  pending = new SvelteMap<string, InstallScope>()
  /**
   * Downloads asked for while downloads cannot run (offline, or network use off): they start by themselves once the
   * app is online with network use allowed (`installWhenOnline`).
   */
  waiting = new SvelteMap<string, InstallScope>()
  /** When `packs_check_updates` last answered (ms), or null. */
  updatesCheckedAt = $state<number | null>(null)
  /** Jobs that completed this session, newest first, one per pack, at most `RECENT_KEPT`. */
  recent = $state.raw<FinishedJob[]>([])

  readonly byId: ReadonlyMap<string, PackInfo> = $derived(new Map(this.list.map((p) => [p.id, p] as const)))
  readonly byKind = $derived.by(() => {
    const out: Partial<Record<PackKind, PackInfo[]>> = {}
    for (const p of this.list) (out[p.kind] ??= []).push(p)
    return out
  })
  /** Translations with an installed version (the reader can show them). */
  readonly installedTranslations = $derived(
    this.list.filter((p) => p.kind === 'translation' && isInstalled(p)),
  )
  /** Tafsir with content on disk: an installed whole pack, or downloaded chapters of a Quran.com tafsir. */
  readonly installedTafsir = $derived(
    this.list.filter(
      (p) => p.kind === 'tafsir' && (p.installMode === 'on_demand' ? hasContent(p) : isInstalled(p)),
    ),
  )
  /** The exact starter set (§2.5.4) for the current UI language, style and reciter (onboarding's preselection). */
  readonly starterSet: StarterSet = $derived(
    this.starterSetFor({
      uiLanguage: settings.value.uiLanguage,
      style: settings.value.mushafStyle,
      reciterId: settings.value.reciterId,
    }),
  )
  /** Jobs that are queued or doing work. */
  readonly activeJobs = $derived([...this.jobs.values()].filter((j) => isActivePhase(j.phase)))
  /** Packs whose installed version has an update. */
  readonly updatable = $derived(this.list.filter((p) => p.state.type === 'update_available'))
  /**
   * Packs that wait for a connection (`isWaiting`): downloads asked for while offline, then jobs the connection broke
   * while the app still is. They start by themselves, so they are neither active nor failed.
   */
  readonly waitingIds: readonly string[] = $derived.by(() => {
    const ids = [...this.waiting.keys()]
    for (const job of this.jobs.values()) {
      if (!ids.includes(job.packId) && this.isWaiting(job.packId)) ids.push(job.packId)
    }
    return ids
  })
  /** Jobs that failed and do not merely wait for a connection (they offer Retry). */
  readonly failedJobs = $derived(
    [...this.jobs.values()].filter((j) => j.phase === 'failed' && !this.isWaiting(j.packId)),
  )

  /** Words per surah from the index (and their sum): the weights of per-surah size estimates. */
  readonly #weights = $derived.by(() => {
    const words = quran.index.surahs.length === 114 ? surahWords(quran.index) : []
    return { words, total: words.reduce((a, b) => a + b, 0) }
  })

  #gen = 0
  #channel: Channel<DownloadEvent> | null = null
  #unlisten: (() => void) | null = null
  #disposeEffects: (() => void) | null = null
  #wasOnline: boolean | null = null
  /** Job ids that completed, were cancelled or were replaced: never shown again. */
  #ended = new Set<number>()
  /** What install() asked for, per pack (the completion toast names it; `whenOnline`: a request that may wait). */
  #asked = new Map<string, { scope: InstallScope; update: boolean; whenOnline: boolean }>()
  #listLoad: Promise<void> | null = null
  #listDirty = false
  #itemLoads = new Map<string, Promise<void>>()
  #itemsDirty = new Set<string>()
  #refreshTimer: ReturnType<typeof setTimeout> | null = null
  #usageTimer: ReturnType<typeof setTimeout> | null = null
  #itemTimers = new Map<string, ReturnType<typeof setTimeout>>()

  async init(_b: Bootstrap): Promise<void> {
    const gen = ++this.#gen
    this.#unlisten = listenEvent(events.packsChanged, ({ packIds }) => {
      if (gen === this.#gen) this.#onPacksChanged(packIds)
    })
    this.#disposeEffects = $effect.root(() => {
      $effect(() => {
        const on = app.online && settings.value.networkAllowed
        untrack(() => {
          if (on && this.#wasOnline === false) {
            this.#resumeOfflineJobs()
            this.#startWaiting()
          }
          this.#wasOnline = on
        })
      })
    })
    let subscribed: Promise<void> = Promise.resolve()
    try {
      const channel = new Channel<DownloadEvent>()
      channel.onmessage = (e) => {
        if (gen === this.#gen) this.#onEvent(e)
      }
      this.#channel = channel
      subscribed = call(api.packsSubscribe(channel)).then(
        (jobs) => {
          if (gen === this.#gen) this.#replaceJobs(jobs)
        },
        (e: unknown) => console.warn('[qd] packs: download events unavailable', e),
      )
    } catch (e) {
      console.warn('[qd] packs: no IPC channel', e)
    }
    await Promise.all([subscribed, this.refresh()])
  }

  // --- lookups -------------------------------------------------------------------------------------------------------

  pack(id: string): PackInfo | undefined {
    return this.byId.get(id)
  }

  /** Downloads can run now: the app is online and network use is allowed. */
  get canDownload(): boolean {
    return app.online && settings.value.networkAllowed
  }

  /**
   * The pack waits for a connection: a download asked for while offline (`waiting`), or a job that failed for being
   * offline while the app still is (it resumes by itself once online).
   */
  isWaiting(id: string): boolean {
    if (this.waiting.has(id)) return true
    const job = this.jobs.get(id)
    return job?.phase === 'failed' && job.error?.kind === 'offline' && !this.canDownload
  }

  /** The pack's live job (queued, running, paused or failed). */
  jobOf(id: string): JobSnapshot | undefined {
    return this.jobs.get(id)
  }

  /** A job of the pack is queued or doing work. */
  isBusy(id: string): boolean {
    const job = this.jobs.get(id)
    return job !== undefined && isActivePhase(job.phase)
  }

  /** The pack's title in the UI language. */
  title(p: PackInfo): string {
    return p.title[i18n.locale] || p.title.en
  }

  /** The recitation pack of a reciter. */
  reciterPack(reciterId: number): PackInfo | undefined {
    return this.byId.get(`audio.qdc.${reciterId}`)
  }

  /**
   * The KiB an item of a per-item pack takes: its real size once present, else an estimate (surahs and chapters
   * weigh by their word count, pages share the pack evenly).
   */
  itemKib(p: PackInfo, item: number): number {
    const present = this.items.get(p.id)?.find((i) => i.item === item && i.kib > 0)
    return present ? present.kib : this.#estimateKib(p, item)
  }

  /**
   * KiB still to download for a complete install of a per-item pack (the size of a whole pack). Every item on disk
   * counts as there, pinned or fetched as you read (a page, a chapter, a streamed surah): an install pins those in
   * place without downloading them again (the adapter reports them present). Only the missing ones are estimated.
   */
  remainingKib(p: PackInfo): number {
    if (p.installMode !== 'on_demand') return isInstalled(p) ? 0 : p.sizeKib
    const items = this.items.get(p.id)
    if (!items) return Math.max(0, p.sizeKib - p.installedKib)
    const present = new Set(items.filter((i) => i.kib > 0 || !i.queued).map((i) => i.item))
    let kib = 0
    for (let n = 1; n <= p.itemCount; n++) if (!present.has(n)) kib += this.#estimateKib(p, n)
    return kib
  }

  #estimateKib(p: PackInfo, item: number): number {
    const { words, total } = this.#weights
    if (p.itemCount === 114 && words.length === 114 && total > 0) {
      return Math.max(1, Math.round((p.sizeKib * (words[item - 1] ?? 0)) / total))
    }
    return Math.max(1, Math.round(p.sizeKib / Math.max(1, p.itemCount)))
  }

  /** The UI language's default translation: its recommended translation, else its recommended tafsir (WP5a). */
  defaultTranslation(ui: UiLanguage): PackInfo | undefined {
    const recommended = (kind: PackKind) =>
      this.list.find((p) => p.kind === kind && p.recommended && languageOf(p) === ui)
    return recommended('translation') ?? recommended('tafsir')
  }

  /** The exact starter set (§2.5.4) for onboarding's choices, mirroring `Catalog::starter_set` (WP5a). */
  starterSetFor(choices: StarterChoices): StarterSet {
    const items: StarterItem[] = []
    const push = (p: PackInfo | undefined, fetch: StarterFetch) => {
      if (!p || items.some((i) => i.pack.id === p.id)) return
      items.push({ pack: p, fetch, kib: fetch === 'now' && !isInstalled(p) ? p.sizeKib : 0 })
    }
    push(this.byId.get('decor'), 'now')
    const translationId =
      choices.translation === undefined
        ? (this.defaultTranslation(choices.uiLanguage)?.id ?? null)
        : choices.translation
    const translation = translationId ? this.byId.get(translationId) : undefined
    if (translation && (translation.kind === 'translation' || translation.kind === 'tafsir')) {
      push(translation, translation.installMode === 'whole' ? 'now' : 'on_demand')
    }
    const mushaf = mushafPackId(choices.style)
    if (mushaf) push(this.byId.get(mushaf), choices.downloadAllPages ? 'now' : 'on_demand')
    push(
      this.list.find((p) => p.kind === 'wbw' && languageOf(p) === choices.uiLanguage),
      'on_demand',
    )
    push(this.reciterPack(choices.reciterId), 'timings_on_first_play')
    // Whatever a "now" pack requires is fetched now too (transitively).
    const queue = items.filter((i) => i.fetch === 'now').flatMap((i) => i.pack.requires)
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      const p = this.byId.get(id)
      if (!p || items.some((i) => i.pack.id === id)) continue
      queue.push(...p.requires)
      push(p, 'now')
    }
    return { items, nowKib: items.reduce((sum, i) => sum + i.kib, 0) }
  }

  // --- loading -------------------------------------------------------------------------------------------------------

  /** Reloads the catalogue and every pack's state (`packs_list`). Never rejects: a failure sets `status`/`error`. */
  refresh(): Promise<void> {
    if (this.#listLoad) {
      this.#listDirty = true
      return this.#listLoad
    }
    const load = this.#loadList(this.#gen)
    this.#listLoad = load
    const done = () => {
      if (this.#listLoad === load) this.#listLoad = null
    }
    load.then(done, done)
    return load
  }

  async #loadList(gen: number): Promise<void> {
    do {
      this.#listDirty = false
      if (this.list.length === 0) this.status = 'loading'
      try {
        const list = await call(api.packsList())
        if (gen !== this.#gen) return
        this.list = list
        this.#reconcileJobs(list)
        this.status = 'ready'
        this.error = null
      } catch (e) {
        if (gen !== this.#gen) return
        this.error = toAppError(e)
        this.status = 'error'
        console.warn('[qd] packs: list failed', e)
      }
    } while (this.#listDirty && gen === this.#gen)
  }

  /** Loads the per-item state of an on-demand pack (`packs_items`); a call during a load joins it. */
  loadItems(id: string): Promise<void> {
    const inflight = this.#itemLoads.get(id)
    if (inflight) return inflight
    const load = this.#loadItems(id, this.#gen)
    this.#itemLoads.set(id, load)
    const done = () => {
      if (this.#itemLoads.get(id) === load) this.#itemLoads.delete(id)
    }
    load.then(done, done)
    return load
  }

  async #loadItems(id: string, gen: number): Promise<void> {
    do {
      this.#itemsDirty.delete(id)
      const items = await call(api.packsItems(id))
      if (gen !== this.#gen) return
      this.items.set(id, items)
    } while (this.#itemsDirty.has(id) && gen === this.#gen)
  }

  /** Measures what the packs take on disk (`packs_disk_usage`). */
  async loadUsage(): Promise<void> {
    const gen = this.#gen
    const usage = await call(api.packsDiskUsage())
    if (gen === this.#gen) this.usage = usage
  }

  /** Asks for pack updates (`packs_check_updates`, network); `ifStale` skips a check younger than 6 h. */
  async checkUpdates(options: { ifStale?: boolean } = {}): Promise<void> {
    const at = this.updatesCheckedAt
    if (options.ifStale && at !== null && Date.now() - at < UPDATE_CHECK_EVERY_MS) return
    const gen = this.#gen
    const updates = await call(api.packsCheckUpdates())
    if (gen !== this.#gen) return
    this.updates = updates
    this.updatesCheckedAt = Date.now()
    await this.refresh()
  }

  // --- actions -------------------------------------------------------------------------------------------------------

  /**
   * Downloads a pack (`All`) or some of its items. While a job of the pack is queued or running, the items wait in
   * `pending` and start as its next job (one job per pack, §2.5.5).
   */
  async install(
    id: string,
    scope: InstallScope = { type: 'all' },
    options: { whenOnline?: boolean } = {},
  ): Promise<void> {
    if (this.isBusy(id)) {
      this.#addPending(id, scope)
      return
    }
    const update = this.byId.get(id)?.state.type === 'update_available'
    const whenOnline = options.whenOnline ?? false
    let jobId: number
    try {
      jobId = await call(api.packsInstall(id, scope))
    } catch (e) {
      // Another job of the pack started meanwhile: wait for it, like a click during the job.
      if (toAppError(e).kind === 'conflict') {
        this.#addPending(id, scope)
        return
      }
      throw e
    }
    this.#asked.set(id, { scope, update, whenOnline })
    this.#expectJob(id, jobId)
    this.#scheduleItems(id, 0)
  }

  /**
   * "Download when online" (§9.8, the dock's offline error): downloads now when downloads can run, else waits for a
   * connection (`waiting`, merged with what already waits) and starts by itself once they can. Resolves `started` or
   * `waiting`.
   */
  async installWhenOnline(id: string, scope: InstallScope): Promise<'started' | 'waiting'> {
    if (!this.canDownload) {
      this.#wait(id, scope)
      return 'waiting'
    }
    await this.install(id, scope, { whenOnline: true })
    return 'started'
  }
  /** Downloads the newer version of an installed pack (`packs_install(id, All)` on `update_available`, §5.9). */
  update(id: string): Promise<void> {
    return this.install(id, { type: 'all' })
  }

  async pause(id: string): Promise<void> {
    await call(api.packsPause(id))
  }

  /** Resumes a paused job, or retries a failed one. */
  async resume(id: string): Promise<void> {
    const jobId = await call(api.packsResume(id))
    this.#expectJob(id, jobId)
  }

  /** "Retry" = `packs_resume` on a failed job or pack (§5.9). */
  retry(id: string): Promise<void> {
    return this.resume(id)
  }

  /** Cancels the pack's job (items already downloaded stay) and drops items waiting for it or for a connection. */
  async cancel(id: string): Promise<void> {
    this.pending.delete(id)
    const waited = this.waiting.delete(id)
    // A request that only waited for a connection has no job to cancel.
    if (waited && !this.jobs.has(id)) return
    await call(api.packsCancel(id))
  }

  /** Removes the pack from disk (a running job is cancelled first). */
  async remove(id: string): Promise<void> {
    this.pending.delete(id)
    this.waiting.delete(id)
    await call(api.packsRemove(id))
    this.#afterChange([id])
  }

  /** Removes items of an on-demand pack; returns the KiB freed. */
  async removeItems(id: string, items: number[]): Promise<number> {
    const pending = this.pending.get(id)
    if (pending?.type === 'items') {
      const left = pending.data.items.filter((n) => !items.includes(n))
      if (left.length > 0) this.pending.set(id, { type: 'items', data: { items: left } })
      else this.pending.delete(id)
    }
    const freed = await call(api.packsRemoveItems(id, items))
    this.#afterChange([id])
    return freed
  }

  /** Drops the streamed (unpinned) recitation cache; returns the KiB freed. */
  async clearStreamCache(): Promise<number> {
    const freed = await call(api.packsClearStreamCache())
    this.#afterChange(this.list.filter((p) => p.kind === 'recitation').map((p) => p.id))
    return freed
  }

  /** "Clear cache" (Settings › Storage, `cache_clear`): unpinned audio and fetched content; returns the KiB freed. */
  async clearCache(): Promise<number> {
    const freed = await call(api.cacheClear())
    this.#afterChange(this.list.filter((p) => p.installMode === 'on_demand').map((p) => p.id))
    return freed
  }

  /**
   * "Download now" of onboarding: installs the starter set's `now` packs that are not installed yet, in order.
   * Rejects with the first error after trying them all.
   */
  async installStarter(set: StarterSet): Promise<void> {
    let first: unknown = null
    for (const item of set.items) {
      if (item.fetch !== 'now' || isInstalled(item.pack) || this.isBusy(item.pack.id)) continue
      try {
        await this.install(item.pack.id)
      } catch (e) {
        first ??= e
      }
    }
    if (first !== null) throw first
  }

  reset(): void {
    this.#gen++
    this.#unlisten?.()
    this.#unlisten = null
    this.#disposeEffects?.()
    this.#disposeEffects = null
    if (this.#channel) this.#channel.onmessage = () => {}
    this.#channel = null
    for (const timer of [this.#refreshTimer, this.#usageTimer, ...this.#itemTimers.values()]) {
      if (timer !== null) clearTimeout(timer)
    }
    this.#refreshTimer = null
    this.#usageTimer = null
    this.#itemTimers.clear()
    this.#listLoad = null
    this.#listDirty = false
    this.#itemLoads.clear()
    this.#itemsDirty.clear()
    this.#ended.clear()
    this.#asked.clear()
    this.#wasOnline = null
    this.list = []
    this.jobs.clear()
    this.items.clear()
    this.pending.clear()
    this.waiting.clear()
    this.usage = null
    this.updates = []
    this.updatesCheckedAt = null
    this.recent = []
    this.filter = 'all'
    this.language = 'all'
    this.query = ''
    this.status = 'idle'
    this.error = null
  }

  // --- events --------------------------------------------------------------------------------------------------------

  #onEvent(e: DownloadEvent): void {
    const { jobId, packId } = e.data
    if (this.#ended.has(jobId)) return
    const prev = this.jobs.get(packId)
    if (prev && prev.jobId > jobId) return // a late event of a job this pack has replaced
    const base = prev && prev.jobId === jobId ? prev : blankJob(jobId, packId)
    switch (e.type) {
      case 'queued':
        this.#noteJob({ ...base, phase: 'queued' })
        break
      case 'started':
        this.#noteJob({
          ...base,
          phase: 'downloading',
          totalKib: e.data.totalKib,
          itemsTotal: e.data.itemsTotal,
          error: null,
        })
        break
      case 'progress': {
        const { receivedKib, totalKib, itemsDone, itemsTotal, rateKibS, etaS } = e.data
        this.#noteJob({
          ...base,
          phase: 'downloading',
          receivedKib,
          totalKib,
          itemsDone,
          itemsTotal,
          rateKibS,
          etaS,
        })
        if (itemsDone !== base.itemsDone) this.#scheduleItems(packId, ITEMS_THROTTLE_MS)
        break
      }
      case 'verifying':
      case 'installing':
        this.#noteJob({ ...base, phase: e.type, rateKibS: 0, etaS: null })
        break
      case 'paused':
        this.#noteJob({ ...base, phase: 'paused', rateKibS: 0, etaS: null })
        this.#afterChange([packId])
        break
      case 'failed': {
        const asked = this.#asked.get(packId)
        if (e.data.error.kind === 'offline' && asked?.whenOnline) {
          // Asked for "when online": the connection went (or never came), so it waits again; no failure to report.
          this.#endJob(packId, jobId)
          this.#asked.delete(packId)
          this.#wait(packId, asked.scope)
          this.#afterChange([packId])
          break
        }
        this.#noteJob({ ...base, phase: 'failed', rateKibS: 0, etaS: null, error: e.data.error })
        this.#afterChange([packId])
        this.#toastFailure(packId, e.data.error)
        break
      }
      case 'completed':
        this.#endJob(packId, jobId)
        this.#afterChange([packId])
        this.#adopt(packId)
        this.#noteFinished(packId, jobId, base.totalKib)
        this.#toastDone(packId)
        this.#flushPending(packId)
        break
      case 'cancelled':
        this.#endJob(packId, jobId)
        this.pending.delete(packId)
        this.waiting.delete(packId)
        this.#asked.delete(packId)
        this.#afterChange([packId])
        break
    }
  }

  #onPacksChanged(packIds: string[]): void {
    this.#afterChange(packIds)
  }

  /**
   * A command answered with this job id: show it as queued until its events arrive, unless they already did (the
   * events can overtake the answer) or the job already ended (a tiny job).
   */
  #expectJob(packId: string, jobId: number): void {
    if (this.#ended.has(jobId)) return
    const cur = this.jobs.get(packId)
    if (cur && cur.jobId >= jobId) return
    this.#noteJob(blankJob(jobId, packId))
  }

  /** Records a job snapshot; a new job of a pack retires the previous one. */
  #noteJob(job: JobSnapshot): void {
    const prev = this.jobs.get(job.packId)
    if (prev && prev.jobId !== job.jobId) this.#retire(prev.jobId)
    this.jobs.set(job.packId, job)
  }

  #endJob(packId: string, jobId: number): void {
    this.#retire(jobId)
    if (this.jobs.get(packId)?.jobId === jobId) this.jobs.delete(packId)
  }

  #retire(jobId: number): void {
    this.#ended.add(jobId)
    if (this.#ended.size > ENDED_KEPT) {
      const oldest = this.#ended.values().next().value
      if (oldest !== undefined) this.#ended.delete(oldest)
    }
  }

  /** The subscription snapshot is authoritative: it replaces the job map. */
  #replaceJobs(jobs: JobSnapshot[]): void {
    const keep: string[] = []
    for (const job of jobs) {
      if (this.#ended.has(job.jobId)) continue
      keep.push(job.packId)
      const prev = this.jobs.get(job.packId)
      if (!prev || prev.jobId < job.jobId || PHASE_RANK[job.phase] >= PHASE_RANK[prev.phase]) {
        this.#noteJob(job)
      }
    }
    for (const id of [...this.jobs.keys()]) if (!keep.includes(id)) this.jobs.delete(id)
  }

  /** A list snapshot only adds jobs the map does not know, or a later state of the same job. */
  #reconcileJobs(list: PackInfo[]): void {
    for (const p of list) {
      const job = p.job
      if (!job || this.#ended.has(job.jobId)) continue
      const prev = this.jobs.get(p.id)
      const newer =
        !prev ||
        prev.jobId < job.jobId ||
        (prev.jobId === job.jobId &&
          (PHASE_RANK[job.phase] > PHASE_RANK[prev.phase] ||
            (PHASE_RANK[job.phase] === PHASE_RANK[prev.phase] && job.receivedKib > prev.receivedKib)))
      if (newer) this.#noteJob(job)
    }
  }

  /** Records a completed job in `recent` (what `install()` asked for names it: an update, some items). */
  #noteFinished(packId: string, jobId: number, kib: number): void {
    const asked = this.#asked.get(packId)
    const entry: FinishedJob = {
      packId,
      jobId,
      kib: Math.max(0, kib),
      update: asked?.update ?? false,
      items: asked?.scope.type === 'items' ? asked.scope.data.items : null,
      at: Date.now(),
    }
    const rest = untrack(() => this.recent).filter((f) => f.packId !== packId)
    this.recent = [entry, ...rest].slice(0, RECENT_KEPT)
  }

  #addPending(id: string, scope: InstallScope): void {
    const prev = this.pending.get(id)
    this.pending.set(id, prev ? mergeScope(prev, scope) : scope)
  }

  #flushPending(id: string): void {
    const next = this.pending.get(id)
    if (!next) return
    this.pending.delete(id)
    this.install(id, next).catch((e: unknown) => ui.toastError(e))
  }

  #wait(id: string, scope: InstallScope): void {
    const prev = this.waiting.get(id)
    this.waiting.set(id, prev ? mergeScope(prev, scope) : scope)
  }

  /** Starts what waited for a connection (each once; one that cannot start yet waits again by its failure). */
  #startWaiting(): void {
    for (const [id, scope] of [...this.waiting]) {
      this.waiting.delete(id)
      this.install(id, scope, { whenOnline: true }).catch((e: unknown) => {
        if (toAppError(e).kind === 'offline') this.#wait(id, scope)
        else ui.toastError(e)
      })
    }
  }

  #resumeOfflineJobs(): void {
    for (const job of [...this.jobs.values()]) {
      if (job.phase === 'failed' && job.error?.kind === 'offline') {
        this.resume(job.packId).catch((e: unknown) => console.warn('[qd] packs: resume after offline', e))
      }
    }
  }

  // --- refresh scheduling --------------------------------------------------------------------------------------------

  /** After a change to these packs: refresh the list, their loaded items and the loaded disk usage. */
  #afterChange(ids: readonly string[]): void {
    if (this.#refreshTimer === null) {
      this.#refreshTimer = setTimeout(() => {
        this.#refreshTimer = null
        void this.refresh()
      }, REFRESH_DEBOUNCE_MS)
    }
    for (const id of ids) this.#scheduleItems(id, 0)
    if (this.usage !== null && this.#usageTimer === null) {
      const gen = this.#gen
      this.#usageTimer = setTimeout(() => {
        this.#usageTimer = null
        if (gen === this.#gen) this.loadUsage().catch((e: unknown) => console.warn('[qd] packs: usage', e))
      }, USAGE_DEBOUNCE_MS)
    }
  }

  /** Reloads a pack's items (if anyone loaded them) after `delayMs`, coalescing calls in between. */
  #scheduleItems(id: string, delayMs: number): void {
    if (!this.items.has(id) && !this.#itemLoads.has(id)) return
    if (this.#itemTimers.has(id)) return
    const gen = this.#gen
    this.#itemTimers.set(
      id,
      setTimeout(() => {
        this.#itemTimers.delete(id)
        if (gen !== this.#gen) return
        if (this.#itemLoads.has(id)) this.#itemsDirty.add(id)
        else this.loadItems(id).catch((e: unknown) => console.warn('[qd] packs: items', e))
      }, delayMs),
    )
  }

  // --- toasts --------------------------------------------------------------------------------------------------------

  /** Job outcomes toast unless the Downloads view shows them in place. */
  #quiet(): boolean {
    return ui.view === 'downloads'
  }

  /**
   * A translation, tafsir or word-by-word pack the user just downloaded in full is put to use (§1.4: the download
   * "enables the translation in settings"): a translation joins the reading translations (up to 5), a tafsir or WBW
   * pack becomes the one shown when none is chosen yet. Updates and per-item downloads change nothing.
   */
  #adopt(packId: string): void {
    const asked = this.#asked.get(packId)
    if (!asked || asked.update || asked.scope.type !== 'all') return
    const p = this.byId.get(packId)
    if (!p) return
    untrack(() => {
      const s = settings.value
      if (p.kind === 'translation') {
        if (!s.translations.includes(p.id) && s.translations.length < SETTING_LIMITS.maxTranslations) {
          settings.update({ translations: [...s.translations, p.id] })
        }
      } else if (p.kind === 'tafsir' && s.tafsirPackId === null) {
        settings.update({ tafsirPackId: p.id })
      } else if (p.kind === 'wbw' && s.wbwPackId === null) {
        settings.update({ wbwPackId: p.id })
      }
    })
  }

  #toastDone(packId: string): void {
    const asked = this.#asked.get(packId)
    this.#asked.delete(packId)
    const p = this.byId.get(packId)
    if (!p || this.#quiet()) return
    untrack(() => {
      const name = this.title(p)
      let message: string
      if (asked?.update) message = i18n.t('downloads.toast.updated', { name })
      else if (asked?.scope.type === 'items') {
        const items = asked.scope.data.items
        const first = items[0]
        message =
          items.length === 1 && first !== undefined && p.kind === 'recitation'
            ? i18n.t('downloads.toast.surahDone', { surah: quran.surahName(first), name })
            : i18n.tp(`downloads.toast.itemsDone.${itemNoun(p.kind)}`, items.length, { name })
      } else message = i18n.t('downloads.toast.done', { name })
      ui.toast({ message, tone: 'success' })
    })
  }

  #toastFailure(packId: string, error: AppError): void {
    const p = this.byId.get(packId)
    if (!p || this.#quiet() || error.kind === 'cancelled') return
    untrack(() =>
      ui.toast({
        message: i18n.t('downloads.toast.failed', { name: this.title(p) }),
        description: i18n.t(`errors.${error.kind}`),
        tone: 'danger',
        action: {
          label: i18n.t('common.retry'),
          run: () => void this.retry(packId).catch((e: unknown) => ui.toastError(e)),
        },
      }),
    )
  }
}

export const packs = new PacksStore()

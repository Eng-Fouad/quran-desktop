/**
 * Mock handlers: packs, downloads and caches (§5.17). Owner: WP12a.
 *
 * The browser mock behaves like `quran-packs` (§2.5.5, and WP5b's job runner: deviations 3–14 and `jobs.rs`) on a
 * simulated disk, so the Downloads manager, onboarding, the Index and the reciter picker can be built against it:
 *
 * - **Queue.** One job per pack, FIFO, at most {@link MAX_RUNNING} running. `packs_install` answers `conflict` while a
 *   job of the pack is queued or running; a paused or failed job is replaced (its progress is reused). `packs_resume`
 *   (also Retry) re-queues the paused or failed job's scope with a new job id and returns the running job's id as is.
 * - **Throughput.** Every running job downloads at 2 MB/s ({@link MOCK_RATE_KIB_S}; `?mockPackRate=<MB/s>` changes
 *   it). Progress events come at most every 100 ms, with the rate as a 3 s EWMA and an ETA, like the runner.
 * - **Items.** Per-item packs (`on_demand`: page fonts, recitations, Quran.com chapters) finish item by item and record
 *   each in `packs_items` as it completes, so a resumed job continues where it stopped. Item sizes follow the text: a
 *   surah's recitation and chapters weigh by its word count, page fonts vary around the mean. A recitation download
 *   of any surah also pins surah 1 (its basmala, §2.5.6), and `packs_remove_items` never removes surah 1 while another
 *   surah of the reciter stays pinned (WP5d). Whole packs go `verifying` → `installing` → `completed`.
 * - **Registry.** Per-item packs are `installed` when every item is pinned, `partial` otherwise, `paused`/`failed`
 *   while their job is; whole packs keep an installed version through a paused or failed update (`update_available`
 *   when it is older than the catalogue's). Every job end emits `packs-changed`.
 * - **Failures.** With network use off (or the browser offline) a running job fails with `offline` at its next
 *   chunk, and a new one at its start. `?mockPackFail=<id>[:<kind>][@<pct>]` (comma-separated) fails that pack's next
 *   job once, at `pct` % (default 40) with `kind` (default `network`), so Retry then succeeds.
 * - **Demo data.** `?mockPacks=demo` seeds a lived-in state on a fresh slice: ornaments, two translations (one with an
 *   update), Al-Muyassar, Alafasy with downloaded and stream-cached surahs, and a few on-demand Mushaf pages.
 * - **Restart.** Jobs persist in the `packs` slice. After a reload, queued and running jobs are queued again (from
 *   their progress) and paused or failed ones stay resumable, like `JobQueue::restore`.
 *
 * Other mock handlers record stream-cached audio and on-demand items through {@link recordCachedItem} (they never
 * write the `packs` slice themselves).
 */
import type { Channel } from '@tauri-apps/api/core'
import {
  events,
  type AppError,
  type DiskUsage,
  type DownloadEvent,
  type InstallScope,
  type JobPhase,
  type JobSnapshot,
  type PackInfo,
  type PackItemState,
  type PackUpdate,
  type QuranIndex,
} from '../../bindings'
import { fixtures } from '../fixtures'
import { type ErrorKind, type Handlers, handle, MockError, send } from '../result'
import { state } from '../state'
import { syntheticIndex } from '../synthetic'
import { mockOnline } from './settings'

/** 2 MB/s, in KiB/s (§5.17). */
export const MOCK_RATE_KIB_S = 2_000_000 / 1024
/** Jobs running at once (`jobs::MAX_RUNNING`). */
export const MAX_RUNNING = 3
/** The progress cadence (`jobs::PROGRESS_INTERVAL`). */
export const TICK_MS = 100
/** Time constant of the displayed rate (`jobs::RATE_WINDOW`). */
const RATE_WINDOW_MS = 3_000
/** How long a whole pack spends in `verifying` and `installing`. */
export const VERIFY_MS = 400
export const INSTALL_MS = 300
/** Progress is mirrored to `localStorage` at most this often while jobs run (phase changes save at once). */
const SAVE_EVERY_MS = 1_000
/** A job that is not told otherwise fails at this share of its bytes (`?mockPackFail=<id>`). */
const DEFAULT_FAIL_PCT = 40
/** Words in the Quran (word ids 1..=83,665, end markers included; §0.2). */
const QURAN_WORDS = 83_665
/** Fixed part of a surah's recitation file (silence, the reciter's opening). */
const SURAH_OVERHEAD_KIB = 64
const DATA_DIR = 'C:/mock/com.quran.labs.desktop'
/** The handler's own mirror (job scopes), next to the `packs` slice. */
const SIM_KEY = 'qd-mock-v1:packs-sim'

const ACTIVE: ReadonlySet<JobPhase> = new Set(['queued', 'downloading', 'verifying', 'installing'])
const RUNNING: ReadonlySet<JobPhase> = new Set(['downloading', 'verifying', 'installing'])

/** The channel `packs_subscribe` registered last (replaces any previous one, like `PackEventsImpl`). */
export const packsChannels: { events: Channel<DownloadEvent> | null } = { events: null }

// ---------------------------------------------------------------------------------------------------------------------
// Simulated jobs

interface Sim {
  jobId: number
  packId: string
  scope: InstallScope
  phase: JobPhase
  /** Per-item packs: the items this job fetches, in order; `cursor` is the one downloading now. */
  items: number[]
  cursor: number
  /** KiB of the current item (per-item) received so far. */
  itemKib: number
  receivedKib: number
  totalKib: number
  itemsDone: number
  itemsTotal: number
  /** The displayed rate (EWMA), KiB/s. */
  rate: number
  error: AppError | null
  /** Milliseconds left in `verifying` / `installing`. */
  phaseLeftMs: number
  /** Whole packs resumed from a partial download start here (`.dl.part` resume). */
  resumeKib: number
  /** Fails when `receivedKib` reaches this (a scripted failure). */
  failAt: { kib: number; kind: ErrorKind } | null
  /** The last progress event sent, to emit only on change. */
  lastProgress: string
}

interface SimMirror {
  scope: InstallScope
  receivedKib: number
}

/** Live jobs by pack id, in queue order (a replaced job moves to the end, like a new enqueue). */
const sims = new Map<string, Sim>()
let ticker: ReturnType<typeof setInterval> | null = null
let lastTick = 0
let lastSave = 0
/** The slice value the jobs were restored from: a reset slice (`?mockReset`, tests) restores again. */
let restoredFrom: object | null = null
/** Scripted failures (pack id → kind and percent), consumed by the next job of the pack. */
const scripted = new Map<string, { kind: ErrorKind; pct: number }>()
/** `?mockPackFail` entries already used in this page session (Retry then succeeds). */
const urlFailuresUsed = new Set<string>()
let rateOverride: number | null = null

function params(): URLSearchParams {
  return new URLSearchParams(typeof location === 'undefined' ? '' : location.search)
}

function online(): boolean {
  return mockOnline(state.settings.value)
}

function rateKibS(): number {
  if (rateOverride !== null) return rateOverride
  const mbps = Number(params().get('mockPackRate'))
  return Number.isFinite(mbps) && mbps > 0 ? (mbps * 1_000_000) / 1024 : MOCK_RATE_KIB_S
}

function emit(e: DownloadEvent): void {
  send(packsChannels.events, e)
}

function packsChanged(ids: string[]): void {
  if (ids.length === 0) return
  void events.packsChanged.emit({ packIds: [...new Set(ids)] }).catch((e: unknown) => {
    console.error('[mock IPC] packs-changed', e)
  })
}

function snapshotOf(sim: Sim): JobSnapshot {
  const downloading = sim.phase === 'downloading'
  const rate = downloading ? Math.round(sim.rate) : 0
  const left = Math.max(0, sim.totalKib - sim.receivedKib)
  return {
    jobId: sim.jobId,
    packId: sim.packId,
    phase: sim.phase,
    receivedKib: Math.min(sim.totalKib, Math.floor(sim.receivedKib)),
    totalKib: Math.round(sim.totalKib),
    itemsDone: sim.itemsDone,
    itemsTotal: sim.itemsTotal,
    rateKibS: rate,
    etaS: downloading && rate > 0 ? Math.ceil(left / rate) : null,
    error: sim.error ? { ...sim.error } : null,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Catalogue, items and sizes

function packs(): PackInfo[] {
  return state.packs.value.list
}

function findPack(packId: string): PackInfo | undefined {
  return packs().find((p) => p.id === packId)
}

function requirePack(packId: string): PackInfo {
  const p = findPack(packId)
  if (!p) throw new MockError('not_found', `pack ${packId} is not in the catalog`)
  return p
}

/** Per-item packs: page fonts, recitations, Quran.com tafsir and WBW chapters (§2.5.3). */
function itemized(p: PackInfo): boolean {
  return p.installMode === 'on_demand'
}

function itemsOf(packId: string): PackItemState[] {
  return (state.packs.value.items[packId] ??= [])
}

function installedVersion(p: PackInfo): string | null {
  if (p.state.type === 'installed') return p.state.data.version
  if (p.state.type === 'update_available') return p.state.data.installed
  return null
}

let wordCache: number[] | null = null

/** Words per surah (index 0 = surah 1), from the index the mock serves. */
function surahWords(): number[] {
  if (wordCache) return wordCache
  const index: QuranIndex = fixtures.cachedIndex() ?? syntheticIndex()
  const first = (n: number): number => {
    const s = index.surahs[n - 1]
    return s ? (index.ayahFirstWord[s.firstAyahId - 1] ?? 0) : 0
  }
  const out: number[] = []
  for (let n = 1; n <= 114; n++) {
    const start = first(n)
    const end = n < 114 ? first(n + 1) : Math.max(QURAN_WORDS + 1, start + 1)
    out.push(Math.max(1, end - start))
  }
  return (wordCache = out)
}

/** A stable pseudo-random value in [0, 1) for page `n` (font files vary in size around the mean). */
function wobble(n: number): number {
  const x = Math.sin(n * 12.9898) * 43_758.5453
  return x - Math.floor(x)
}

const sizeCache = new Map<string, number[]>()

/** KiB of every item of a per-item pack (index 0 = item 1), summing to about the pack's `sizeKib`. */
function itemSizes(p: PackInfo): number[] {
  const cached = sizeCache.get(p.id)
  if (cached && cached.length === p.itemCount) return cached
  let weights: number[]
  let fixed = 0
  if (p.itemCount === 114) {
    weights = surahWords()
    if (p.kind === 'recitation') fixed = SURAH_OVERHEAD_KIB
  } else {
    weights = Array.from({ length: p.itemCount }, (_, i) => 0.7 + 0.6 * wobble(i + 1))
  }
  const sum = weights.reduce((a, b) => a + b, 0) || 1
  const spread = Math.max(0, p.sizeKib - fixed * p.itemCount)
  const sizes = weights.map((w) => Math.max(1, Math.round(fixed + (spread * w) / sum)))
  sizeCache.set(p.id, sizes)
  return sizes
}

function itemKib(p: PackInfo, item: number): number {
  return itemSizes(p)[item - 1] ?? 1
}

/** Recomputes a pack's registry state from its items and job (WP5b deviation 11). */
function syncState(p: PackInfo): void {
  const sim = sims.get(p.id)
  if (itemized(p)) {
    const pinned = itemsOf(p.id).filter((i) => i.pinned)
    const present = pinned.length
    p.installedKib = pinned.reduce((sum, i) => sum + i.kib, 0)
    if (sim?.phase === 'paused') {
      p.state = { type: 'paused', data: { itemsPresent: present, itemsTotal: p.itemCount } }
    } else if (sim?.phase === 'failed' && sim.error) {
      p.state = { type: 'failed', data: { error: { ...sim.error } } }
    } else if (present === 0) {
      p.state = { type: 'not_installed' }
    } else if (present >= p.itemCount) {
      p.state = { type: 'installed', data: { version: p.version } }
    } else {
      p.state = { type: 'partial', data: { itemsPresent: present, itemsTotal: p.itemCount } }
    }
    return
  }
  const version = installedVersion(p)
  if (version !== null) {
    p.state =
      version === p.version
        ? { type: 'installed', data: { version } }
        : { type: 'update_available', data: { installed: version, latest: p.version } }
  } else if (sim?.phase === 'paused') {
    p.state = { type: 'paused', data: { itemsPresent: 0, itemsTotal: 1 } }
  } else if (sim?.phase === 'failed' && sim.error) {
    p.state = { type: 'failed', data: { error: { ...sim.error } } }
  } else {
    p.state = { type: 'not_installed' }
    p.installedKib = 0
  }
}

/** A copy of the pack as `packs_list` reports it (with its live job). */
function view(p: PackInfo): PackInfo {
  const sim = sims.get(p.id)
  return { ...structuredClone(p), job: sim ? snapshotOf(sim) : null }
}

/** Adds or upgrades a present item. */
function putItem(p: PackInfo, item: number, pinned: boolean): void {
  const list = itemsOf(p.id)
  const kib = itemKib(p, item)
  const at = list.findIndex((i) => i.item === item)
  if (at < 0) list.push({ item, pinned, queued: false, kib })
  else {
    const prev = list[at]
    if (prev) list[at] = { item, pinned: prev.pinned || pinned, queued: false, kib }
  }
  list.sort((a, b) => a.item - b.item)
}

function sourceUrl(p: PackInfo): string {
  switch (p.kind) {
    case 'mushaf_fonts':
      return `https://verses.quran.foundation/fonts/quran/hafs/${p.id.slice(7)}/woff2/p1.woff2`
    case 'decor':
      return 'https://static-cdn.tarteel.ai/qul/fonts/QCF_SurahHeader.woff2'
    case 'recitation':
      return `https://download.quranicaudio.com/qdc/${p.id.slice(10)}/001.mp3`
    case 'wbw':
      return `https://api.quran.com/api/v4/verses/by_chapter/1?words=true&language=${p.language ?? 'en'}`
    default:
      return itemized(p)
        ? 'https://api.quran.com/api/v4/tafsirs/169/by_chapter/1'
        : `https://quranenc.com/downloads/sqlite/${p.id.split('.').slice(1).join('_')}.zip`
  }
}

function failure(p: PackInfo, kind: ErrorKind): AppError {
  const url = sourceUrl(p)
  switch (kind) {
    case 'offline':
      return { kind, message: 'offline' }
    case 'integrity':
      return { kind, message: `integrity: sha256 mismatch for ${url}` }
    case 'network':
      return { kind, message: `http 503 for ${url}` }
    default:
      return { kind, message: `simulated ${kind} failure for ${url}` }
  }
}

/** A scripted failure for the pack's next job: `packsMock.failNext`, else an unused `?mockPackFail` entry. */
function takeFailure(packId: string): { kind: ErrorKind; pct: number } | null {
  const own = scripted.get(packId)
  if (own) {
    scripted.delete(packId)
    return own
  }
  if (urlFailuresUsed.has(packId)) return null
  for (const raw of params()
    .getAll('mockPackFail')
    .flatMap((v) => v.split(','))) {
    const m = /^([^:@\s]+)(?::([a-z_]+))?(?:@(\d{1,3}))?$/.exec(raw.trim())
    if (!m || m[1] !== packId) continue
    urlFailuresUsed.add(packId)
    const kind = (m[2] ?? 'network') as ErrorKind
    const pct = Math.min(99, Math.max(1, Number(m[3] ?? DEFAULT_FAIL_PCT)))
    return { kind, pct }
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------------
// Persistence and restart

function loadMirror(): Record<string, SimMirror> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SIM_KEY) ?? '{}')
    return typeof raw === 'object' && raw !== null ? (raw as Record<string, SimMirror>) : {}
  } catch {
    return {}
  }
}

function persist(force = true): void {
  const now = Date.now()
  if (!force && now - lastSave < SAVE_EVERY_MS) return
  lastSave = now
  state.packs.update((v) => {
    v.jobs = [...sims.values()].map(snapshotOf)
  })
  try {
    const mirror: Record<string, SimMirror> = {}
    for (const s of sims.values()) mirror[s.packId] = { scope: s.scope, receivedKib: s.receivedKib }
    localStorage.setItem(SIM_KEY, JSON.stringify(mirror))
  } catch {
    // Storage blocked or full: jobs still run for this session.
  }
}

/**
 * Restores the jobs of the current slice once (`JobQueue::restore`): queued and running jobs are queued again from
 * their progress, paused and failed ones stay resumable. A reset slice (a new value object) restores again.
 */
function ensureRestored(): void {
  const value = state.packs.value
  if (restoredFrom === value) return
  restoredFrom = value
  stopTicker()
  sims.clear()
  const mirror = loadMirror()
  const requeue: Sim[] = []
  for (const job of value.jobs) {
    const p = findPack(job.packId)
    if (!p) continue
    const scope = mirror[job.packId]?.scope ?? { type: 'all' }
    const sim = newSim(p, job.jobId, scope, job.receivedKib)
    if (job.phase === 'paused' || job.phase === 'failed') {
      sim.phase = job.phase
      sim.error = job.error
      sim.receivedKib = job.receivedKib
      sim.itemsDone = job.itemsDone
    } else requeue.push(sim)
    sims.set(p.id, sim)
  }
  for (const p of packs()) syncState(p)
  if (value.jobs.length > 0 || requeue.length > 0) persist()
  if (requeue.length > 0) pump()
}

// ---------------------------------------------------------------------------------------------------------------------
// The queue

function newSim(p: PackInfo, jobId: number, scope: InstallScope, resumeKib = 0): Sim {
  let items: number[] = []
  if (itemized(p)) {
    const wanted =
      scope.type === 'all'
        ? Array.from({ length: p.itemCount }, (_, i) => i + 1)
        : [...new Set(scope.data.items)].sort((a, b) => a - b)
    const pinned = new Set(
      itemsOf(p.id)
        .filter((i) => i.pinned)
        .map((i) => i.item),
    )
    // A recitation's basmala plays from surah 1: pinning any surah pins surah 1 too (§2.5.6).
    if (p.kind === 'recitation' && wanted.length > 0 && !wanted.includes(1)) wanted.unshift(1)
    items = wanted.filter((n) => !pinned.has(n))
  }
  const totalKib = itemized(p) ? items.reduce((sum, n) => sum + itemKib(p, n), 0) : Math.max(1, p.sizeKib)
  return {
    jobId,
    packId: p.id,
    scope,
    phase: 'queued',
    items,
    cursor: 0,
    itemKib: 0,
    receivedKib: itemized(p) ? 0 : Math.min(resumeKib, totalKib),
    totalKib,
    itemsDone: 0,
    itemsTotal: itemized(p) ? items.length : 1,
    rate: 0,
    error: null,
    phaseLeftMs: 0,
    resumeKib: itemized(p) ? 0 : Math.min(resumeKib, totalKib),
    failAt: null,
    lastProgress: '',
  }
}

function enqueue(p: PackInfo, scope: InstallScope, resumeKib = 0): number {
  const jobId = state.packs.value.nextJobId
  state.packs.value.nextJobId = jobId + 1
  const sim = newSim(p, jobId, scope, resumeKib)
  const scriptedFailure = takeFailure(p.id)
  if (scriptedFailure) {
    sim.failAt = {
      kind: scriptedFailure.kind,
      kib: Math.max(1, (sim.totalKib * scriptedFailure.pct) / 100),
    }
  }
  sims.delete(p.id)
  sims.set(p.id, sim)
  syncState(p)
  persist()
  emit({ type: 'queued', data: { jobId, packId: p.id } })
  pump()
  return jobId
}

function runningCount(): number {
  let n = 0
  for (const s of sims.values()) if (RUNNING.has(s.phase)) n++
  return n
}

/** Starts queued jobs, oldest first, up to {@link MAX_RUNNING}. */
function pump(): void {
  for (const sim of sims.values()) {
    if (runningCount() >= MAX_RUNNING) break
    if (sim.phase === 'queued') start(sim)
  }
  if (runningCount() > 0) startTicker()
}

function start(sim: Sim): void {
  const p = findPack(sim.packId)
  if (!p) return
  sim.phase = 'downloading'
  sim.rate = 0
  emit({
    type: 'started',
    data: {
      jobId: sim.jobId,
      packId: sim.packId,
      totalKib: Math.round(sim.totalKib),
      itemsTotal: sim.itemsTotal,
    },
  })
  // The network setting fails every new operation before any IO (WP5b deviation 7).
  if (!online()) fail(sim, failure(p, 'offline'))
  else persist()
}

function startTicker(): void {
  if (ticker !== null) return
  lastTick = Date.now()
  ticker = setInterval(tick, TICK_MS)
}

function stopTicker(): void {
  if (ticker !== null) clearInterval(ticker)
  ticker = null
}

function tick(): void {
  const now = Date.now()
  const dt = Math.min(1_000, Math.max(0, now - lastTick))
  lastTick = now
  for (const sim of [...sims.values()]) {
    if (RUNNING.has(sim.phase)) advance(sim, dt, now)
  }
  persist(false)
  if (runningCount() === 0) stopTicker()
}

function advance(sim: Sim, dt: number, now: number): void {
  const p = findPack(sim.packId)
  if (!p) return
  if (sim.phase === 'verifying' || sim.phase === 'installing') {
    sim.phaseLeftMs -= dt
    if (sim.phaseLeftMs > 0) return
    if (sim.phase === 'verifying') {
      sim.phase = 'installing'
      sim.phaseLeftMs = INSTALL_MS
      persist()
      emit({ type: 'installing', data: { jobId: sim.jobId, packId: sim.packId } })
    } else complete(sim, p)
    return
  }
  // A running transfer stops at its next chunk when the network goes away (WP5b deviation 7).
  if (!online()) {
    fail(sim, failure(p, 'offline'))
    return
  }
  const target = rateKibS() * (1 + 0.06 * Math.sin(now / 900))
  sim.rate += (target - sim.rate) * (1 - Math.exp(-dt / RATE_WINDOW_MS))
  let budget = (target * dt) / 1_000
  if (itemized(p)) {
    while (budget > 0 && sim.cursor < sim.items.length) {
      const item = sim.items[sim.cursor] ?? 0
      const take = Math.min(budget, itemKib(p, item) - sim.itemKib)
      sim.itemKib += take
      sim.receivedKib += take
      budget -= take
      if (sim.itemKib >= itemKib(p, item) - 1e-6) {
        putItem(p, item, true)
        sim.cursor += 1
        sim.itemKib = 0
        sim.itemsDone += 1
      }
      if (sim.failAt && sim.receivedKib >= sim.failAt.kib) {
        fail(sim, failure(p, sim.failAt.kind))
        return
      }
    }
    if (sim.cursor >= sim.items.length) {
      complete(sim, p)
      return
    }
  } else {
    sim.receivedKib = Math.min(sim.totalKib, sim.receivedKib + budget)
    if (sim.failAt && sim.receivedKib >= sim.failAt.kib) {
      fail(sim, failure(p, sim.failAt.kind))
      return
    }
    if (sim.receivedKib >= sim.totalKib) {
      sim.itemsDone = 1
      sim.phase = 'verifying'
      sim.phaseLeftMs = VERIFY_MS
      sendProgress(sim)
      persist()
      emit({ type: 'verifying', data: { jobId: sim.jobId, packId: sim.packId } })
      return
    }
  }
  sendProgress(sim)
}

function sendProgress(sim: Sim): void {
  const s = snapshotOf(sim)
  const key = `${s.receivedKib}/${s.itemsDone}/${s.rateKibS}/${s.etaS ?? ''}`
  if (key === sim.lastProgress) return
  sim.lastProgress = key
  emit({
    type: 'progress',
    data: {
      jobId: s.jobId,
      packId: s.packId,
      receivedKib: s.receivedKib,
      totalKib: s.totalKib,
      itemsDone: s.itemsDone,
      itemsTotal: s.itemsTotal,
      rateKibS: s.rateKibS,
      etaS: s.etaS,
    },
  })
}

function complete(sim: Sim, p: PackInfo): void {
  if (!itemized(p)) {
    p.state = { type: 'installed', data: { version: p.version } }
    p.installedKib = p.sizeKib
  }
  sims.delete(p.id)
  syncState(p)
  persist()
  emit({ type: 'completed', data: { jobId: sim.jobId, packId: p.id } })
  packsChanged([p.id])
  pump()
}

function fail(sim: Sim, error: AppError): void {
  const p = findPack(sim.packId)
  sim.phase = 'failed'
  sim.error = error
  sim.rate = 0
  if (p) syncState(p)
  persist()
  emit({ type: 'failed', data: { jobId: sim.jobId, packId: sim.packId, error: { ...error } } })
  packsChanged([sim.packId])
  pump()
}

function pause(sim: Sim): void {
  const p = findPack(sim.packId)
  sim.phase = 'paused'
  sim.rate = 0
  if (p) syncState(p)
  persist()
  emit({ type: 'paused', data: { jobId: sim.jobId, packId: sim.packId } })
  packsChanged([sim.packId])
  pump()
}

function cancel(sim: Sim): void {
  sims.delete(sim.packId)
  const p = findPack(sim.packId)
  if (p) syncState(p)
  persist()
  emit({ type: 'cancelled', data: { jobId: sim.jobId, packId: sim.packId } })
  packsChanged([sim.packId])
  pump()
}

// ---------------------------------------------------------------------------------------------------------------------
// Demo data (`?mockPacks=demo`)

const DEMO = {
  installed: ['decor', 'tr.en.saheeh', 'tafsir.ar.muyassar'],
  /** Installed one version behind the catalogue. */
  outdated: 'tr.en.hilali_khan',
  /** reciter pack → [downloaded surahs, stream-cached surahs] */
  audio: {
    'audio.qdc.7': [
      [1, 18, 36, 55, 56, 67, 78, 112, 113, 114],
      [2, 19, 32, 103, 110],
    ],
    'audio.qdc.2': [[], [1, 36, 67]],
  } as Record<string, [number[], number[]]>,
  /** Pages of the recommended Mushaf fetched while reading (not pinned). */
  pages: { pack: 'mushaf.v2', count: 24 },
  /** WBW chapters fetched while reading. */
  wbw: { pack: 'wbw.en', chapters: [1, 2, 18, 36, 67] },
}

function olderVersion(version: string): string {
  const semver = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (semver) {
    const [, a, b, c] = semver
    return Number(c) > 0 ? `${a}.${b}.${Number(c) - 1}` : `${a}.${Math.max(0, Number(b) - 1)}.9`
  }
  const month = /^(\d{4})\.(\d{2})$/.exec(version)
  if (month) {
    const [, y, m] = month
    return Number(m) > 1 ? `${y}.${String(Number(m) - 1).padStart(2, '0')}` : `${Number(y) - 1}.12`
  }
  return `${version}-old`
}

/** The slice value the demo was seeded into (once per slice). */
let seededInto: object | null = null

/**
 * Seeds `?mockPacks=demo` into a fresh slice (nothing installed, no jobs, no items), at the first packs command after
 * the parameter appears (a QA scenario can add it with `history.replaceState`). Tells the UI with `packs-changed`.
 */
function seedFromUrl(): void {
  const value = state.packs.value
  if (seededInto === value || params().get('mockPacks') !== 'demo') return
  seededInto = value
  const fresh =
    value.jobs.length === 0 &&
    Object.values(value.items).every((list) => list.length === 0) &&
    value.list.every((p) => p.state.type === 'not_installed')
  if (!fresh) return
  for (const id of DEMO.installed) {
    const p = findPack(id)
    if (!p || itemized(p)) continue
    p.state = { type: 'installed', data: { version: p.version } }
    p.installedKib = p.sizeKib
  }
  const outdated = findPack(DEMO.outdated)
  if (outdated && !itemized(outdated)) {
    outdated.state = { type: 'installed', data: { version: olderVersion(outdated.version) } }
    outdated.installedKib = outdated.sizeKib
  }
  for (const [id, [pinned, cached]] of Object.entries(DEMO.audio)) {
    const p = findPack(id)
    if (!p) continue
    for (const n of pinned) putItem(p, n, true)
    for (const n of cached) putItem(p, n, false)
  }
  const mushaf = findPack(DEMO.pages.pack)
  if (mushaf) for (let n = 1; n <= DEMO.pages.count; n++) putItem(mushaf, n, false)
  const wbw = findPack(DEMO.wbw.pack)
  if (wbw) for (const n of DEMO.wbw.chapters) putItem(wbw, n, false)
  for (const p of packs()) syncState(p)
  state.packs.save()
  packsChanged(
    packs()
      .filter((p) => p.state.type !== 'not_installed' || itemsOf(p.id).length > 0)
      .map((p) => p.id),
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation

function validateScope(p: PackInfo, scope: InstallScope): void {
  if (scope.type === 'all') return
  if (!itemized(p)) {
    throw new MockError('invalid_argument', `${p.id} has no per-item scope (install it whole)`)
  }
  if (scope.data.items.length === 0) throw new MockError('invalid_argument', 'no items to install')
  for (const n of scope.data.items) {
    if (!Number.isInteger(n) || n < 1 || n > p.itemCount) {
      throw new MockError('invalid_argument', `item ${n} is outside 1..=${p.itemCount} for ${p.id}`)
    }
  }
}

function freeItems(p: PackInfo, keep: (i: PackItemState) => boolean): number {
  const list = itemsOf(p.id)
  let freed = 0
  state.packs.value.items[p.id] = list.filter((i) => {
    if (keep(i)) return true
    freed += i.kib
    return false
  })
  syncState(p)
  return freed
}

// ---------------------------------------------------------------------------------------------------------------------
// Disk usage

function sumItems(kind: PackInfo['kind'], pinned: boolean | null): number {
  let kib = 0
  for (const p of packs()) {
    if (p.kind !== kind || !itemized(p)) continue
    for (const i of itemsOf(p.id)) if (pinned === null || i.pinned === pinned) kib += i.kib
  }
  return kib
}

function wholeKib(kind: PackInfo['kind']): number {
  return packs()
    .filter((p) => p.kind === kind && !itemized(p))
    .reduce((sum, p) => sum + (installedVersion(p) !== null ? p.installedKib || p.sizeKib : 0), 0)
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value).length
  } catch {
    return 0
  }
}

function diskUsage(): DiskUsage {
  const recitationItems = packs()
    .filter((p) => p.kind === 'recitation')
    .reduce((n, p) => n + itemsOf(p.id).length, 0)
  const userJson = jsonLength(state.user.value)
  const usage = {
    mushafKib: sumItems('mushaf_fonts', null),
    decorKib: wholeKib('decor'),
    translationKib: wholeKib('translation'),
    tafsirKib: wholeKib('tafsir'),
    audioPinnedKib: sumItems('recitation', true),
    audioStreamKib: sumItems('recitation', false),
    // content.db: Quran.com chapters (WBW, tafsir) and recitation timings (≈ 6 KiB per surah) over an empty database.
    contentDbKib: 96 + sumItems('wbw', null) + sumItems('tafsir', null) + recitationItems * 6,
    userDbKib: 160 + Math.ceil(userJson / 1024),
  }
  const totalKib = Object.values(usage).reduce((a, b) => a + b, 0)
  return { totalKib, ...usage, dataDir: DATA_DIR }
}

// ---------------------------------------------------------------------------------------------------------------------
// Handlers

/** `packs_items`: present items plus the not-yet-present items of a running or paused job (`queued`). */
function itemStates(p: PackInfo): PackItemState[] {
  if (!itemized(p)) return []
  const out = new Map(itemsOf(p.id).map((i) => [i.item, { ...i }] as const))
  const sim = sims.get(p.id)
  if (sim && (ACTIVE.has(sim.phase) || sim.phase === 'paused')) {
    for (const n of sim.items.slice(sim.cursor)) {
      const present = out.get(n)
      if (present?.pinned) continue
      out.set(n, present ? { ...present, queued: true } : { item: n, pinned: false, queued: true, kib: 0 })
    }
  }
  return [...out.values()].sort((a, b) => a.item - b.item)
}

/** Wraps a handler body: restores the simulated jobs first (after a reload or a reset slice). */
function run<A extends unknown[], T>(fn: (...args: A) => T | Promise<T>) {
  return handle((...args: A) => {
    ensureRestored()
    seedFromUrl()
    return fn(...args)
  })
}

export const packsHandlers: Handlers<
  | 'packsList'
  | 'packsSubscribe'
  | 'packsInstall'
  | 'packsPause'
  | 'packsResume'
  | 'packsCancel'
  | 'packsRemove'
  | 'packsItems'
  | 'packsRemoveItems'
  | 'packsDiskUsage'
  | 'packsCheckUpdates'
  | 'packsClearStreamCache'
  | 'cacheClear'
> = {
  packsList: run(() =>
    packs().map((p) => {
      syncState(p)
      return view(p)
    }),
  ),

  packsSubscribe: run((onEvent: Channel<DownloadEvent>) => {
    packsChannels.events = onEvent
    return [...sims.values()].map(snapshotOf)
  }),

  packsInstall: run((packId: string, scope: InstallScope) => {
    const p = requirePack(packId)
    validateScope(p, scope)
    const current = sims.get(packId)
    if (current && ACTIVE.has(current.phase)) {
      throw new MockError('conflict', `a job is already queued or running for ${packId}`)
    }
    // A full install brings what the pack requires (every Mushaf needs the ornaments, §2.5.3).
    if (scope.type === 'all') {
      for (const id of p.requires) {
        const req = findPack(id)
        const job = sims.get(id)
        if (!req || (job && ACTIVE.has(job.phase))) continue
        const ready = itemized(req) ? req.state.type === 'installed' : installedVersion(req) !== null
        if (!ready) enqueue(req, { type: 'all' })
      }
    }
    // A paused or failed whole-pack download resumes from its partial file.
    const resumeKib = current && !itemized(p) ? current.receivedKib : 0
    return enqueue(p, structuredClone(scope), resumeKib)
  }),

  packsPause: run((packId: string) => {
    const sim = sims.get(packId)
    if (!sim) throw new MockError('not_found', `no job for ${packId}`)
    // Idempotent on a paused or failed job; the flip of `installing` is the point of no return.
    if (sim.phase === 'paused' || sim.phase === 'failed' || sim.phase === 'installing') return null
    pause(sim)
    return null
  }),

  packsResume: run((packId: string) => {
    const sim = sims.get(packId)
    if (!sim) throw new MockError('not_found', `nothing to resume for ${packId}`)
    if (ACTIVE.has(sim.phase)) return sim.jobId
    const p = requirePack(packId)
    return enqueue(p, sim.scope, itemized(p) ? 0 : sim.receivedKib)
  }),

  packsCancel: run((packId: string) => {
    const sim = sims.get(packId)
    if (!sim) throw new MockError('not_found', `no job for ${packId}`)
    if (sim.phase === 'installing') return null
    cancel(sim)
    return null
  }),

  packsRemove: run((packId: string) => {
    const p = requirePack(packId)
    const sim = sims.get(packId)
    if (sim) {
      sims.delete(packId)
      emit({ type: 'cancelled', data: { jobId: sim.jobId, packId } })
    }
    if (itemized(p)) state.packs.value.items[packId] = []
    p.state = { type: 'not_installed' }
    p.installedKib = 0
    syncState(p)
    persist()
    packsChanged([packId])
    pump()
    return null
  }),

  packsItems: run((packId: string) => itemStates(requirePack(packId))),

  packsRemoveItems: run((packId: string, items: number[]) => {
    const p = requirePack(packId)
    if (!itemized(p)) throw new MockError('invalid_argument', `${packId} has no per-item scope`)
    const remove = new Set(items)
    const pinned = itemsOf(packId).filter((i) => i.pinned)
    // Surah 1 holds the basmala of every other downloaded surah of this reciter (WP5d).
    if (p.kind === 'recitation' && pinned.some((i) => i.item !== 1 && !remove.has(i.item))) {
      remove.delete(1)
    }
    const freed = freeItems(p, (i) => !remove.has(i.item))
    persist()
    packsChanged([packId])
    return freed
  }),

  packsDiskUsage: run(() => diskUsage()),

  packsCheckUpdates: run((): PackUpdate[] =>
    packs().flatMap((p) =>
      p.state.type === 'update_available'
        ? [
            {
              packId: p.id,
              installed: p.state.data.installed,
              latest: p.state.data.latest,
              sizeKib: p.sizeKib,
            },
          ]
        : [],
    ),
  ),

  packsClearStreamCache: run(() => {
    let freed = 0
    const changed: string[] = []
    for (const p of packs()) {
      if (p.kind !== 'recitation') continue
      const kib = freeItems(p, (i) => i.pinned)
      if (kib > 0) changed.push(p.id)
      freed += kib
    }
    persist()
    packsChanged(changed)
    return freed
  }),

  cacheClear: run(() => {
    // Unpinned audio plus content.db's unpinned chapters and timings; installs and pinned items survive (D20).
    let freed = 0
    const changed: string[] = []
    for (const p of packs()) {
      if (!itemized(p) || p.kind === 'mushaf_fonts') continue
      const kib = freeItems(p, (i) => i.pinned)
      if (kib > 0) changed.push(p.id)
      freed += kib
    }
    persist()
    packsChanged(changed)
    return freed
  }),
}

// ---------------------------------------------------------------------------------------------------------------------
// Hooks for other mock handlers, tests and QA

/**
 * Records an item fetched without an explicit download (`pinned = false`): a surah the audio mock streamed and
 * cached (§2.3.7), a page font or a chapter fetched on demand. Emits `packs-changed` when it is new.
 */
export function recordCachedItem(packId: string, item: number): void {
  ensureRestored()
  const p = findPack(packId)
  if (!p || !itemized(p) || !Number.isInteger(item) || item < 1 || item > p.itemCount) return
  if (itemsOf(packId).some((i) => i.item === item)) return
  putItem(p, item, false)
  syncState(p)
  persist()
  packsChanged([packId])
}

/**
 * Records a whole pack installed outside a Downloads job: `decor` installed by `decor_ensure` (the fonts mock), as
 * Rust's `sync_decor_row` records it. Emits `packs-changed` when it was not installed yet.
 */
export function recordWholeInstalled(packId: string): void {
  ensureRestored()
  const p = findPack(packId)
  if (!p || itemized(p) || installedVersion(p) !== null) return
  p.state = { type: 'installed', data: { version: p.version } }
  p.installedKib = p.sizeKib
  syncState(p)
  persist()
  packsChanged([packId])
}

/** A recitation streamed and cached by the audio mock (`audio.qdc.{reciterId}`, surah 1–114). */
export function recordStreamCached(reciterId: number, surah: number): void {
  recordCachedItem(`audio.qdc.${reciterId}`, surah)
}

/** Test and QA controls of the simulation. */
export const packsMock = {
  /** Makes the pack's next job fail once, at `pct` % of its bytes. */
  failNext(packId: string, kind: ErrorKind = 'network', pct = DEFAULT_FAIL_PCT): void {
    scripted.set(packId, { kind, pct })
  },
  /** Overrides the simulated throughput (KiB/s); `null` restores 2 MB/s (or `?mockPackRate`). */
  setRate(kibPerSec: number | null): void {
    rateOverride = kibPerSec
  },
  /** The KiB an item of a per-item pack weighs in the simulation. */
  itemKib(packId: string, item: number): number {
    const p = findPack(packId)
    return p ? itemKib(p, item) : 0
  },
  /** Stops every simulated job and forgets scripted failures (tests; the slice itself is reset separately). */
  reset(): void {
    stopTicker()
    sims.clear()
    scripted.clear()
    urlFailuresUsed.clear()
    rateOverride = null
    restoredFrom = null
    seededInto = null
    packsChannels.events = null
    try {
      localStorage.removeItem(SIM_KEY)
    } catch {
      // Nothing to remove.
    }
  },
}

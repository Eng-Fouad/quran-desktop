/**
 * Mock handlers: audio (§5.17). Owner: WP9a.
 *
 * A simulated `quran-audio` engine (§2.3; WP4b–WP4d deviations) on a wall clock, so the dock, the Mushaf highlights and
 * follow-along can be built and tested in a browser without any sound:
 *
 * - **Plan.** `audio_play` validates like the commands (WP4d deviation 15), resolves `to` from `stopAt` (else the
 *   settings' `stopAt`, §5.8) and plans like the planner (§2.3.3): a basmala segment (from surah 1's timings) before
 *   ayah 1 of every surah except 1 and 9, ayah segments from the fixture (or synthetic) timings, continuous ends when
 *   nothing repeats, in mushaf order across surahs.
 * - **Status** (WP4c deviation 6). The answer is the optimistic `loading` snapshot (reciter, range, repeats, gap); the
 *   plan "loads" for {@link LOAD_MS}, then plays (or rests `paused` with `startPaused`, or after a pause that arrived
 *   while loading). A seek, skip or A-B loop sent while loading is held and applied to that play once it starts. The
 *   end of the queue goes `idle` keeping `reciterId` and `range` (`current` cleared); `audio_stop` clears both.
 * - **Clock.** While playing, the position advances by the elapsed wall time × `speedPct` / 100, and an `AudioTick` goes
 *   to the subscribed channel every {@link TICK_MS} ms (30 Hz) with the word heard (by time: positions may repeat or go
 *   backwards, FACT §5.2). Paused or idle, one tick follows each change.
 * - **Repeats, gaps and A-B** (§2.3.4, WP4b deviations 10–12). `ayahRepeat` plays every ayah segment N times (never the
 *   basmala), `rangeRepeat` replays the queue, the gap (fixed or × the ayah's length, in wall time) follows every ayah
 *   play except the very last, with the position frozen at the ayah's end. The counters read "left after the current
 *   play", 0 when infinite or not applicable. An A-B loop binds to the file being heard; reaching B (or entering past
 *   it) wraps to A, and repeats and gaps are suspended inside it.
 * - **Commands.** `skip(next)` at the last segment starts the next pass while range repeats remain, else stops;
 *   `skip(previous)` within 1.5 s (wall time) of a segment start goes back one segment, else restarts it; `seek(ayah)`
 *   outside the queue is ignored; file-timeline seeks and A-B loops are bounded to the **run** of the heard file (the
 *   consecutive segments that play it in order, `plan::file_run`), and a loop that the bounds leave under 300 ms is
 *   ignored, clearing the one in force; a speed change is a flush (new generation) at the audible position; volume
 *   applies at once.
 * - **Events.** `audio-state-changed` on every status, segment, repeat-counter, speed, volume, gap, A-B or error change;
 *   `audio-ayah-changed` when the heard ayah differs from the last one reported (not for a repeat of the same ayah).
 * - **Network** (D21, §2.5.7). A surah file is local when the reciter's `packs_items` hold it (downloaded or stream
 *   cached). Otherwise it streams when online: `bufferedPct` fills at 2 MB/s for a 128 kbps file, the position waits
 *   (`buffering`) when it catches up, and a complete stream is recorded as stream-cached (WP12a's
 *   `recordStreamCached`). Offline, a missing surah fails the play with `offline` before it starts (the snapshot keeps
 *   the reciter and the range), and a missing surah 1 skips the basmala (`basmalaSkipped`). A stream stalls while
 *   network use is off: when the position catches up with it, the play fails **mid-way** with `offline`, keeping the
 *   segment heard and the range; Play (`resume`, `toggle`) then plans the request again with the repeats and gap in
 *   force and continues from that segment, in the pass it was heard in (`control.rs` `retry`), or leaves the failed
 *   play as it was while still offline. `audio_get_timings` answers `offline` for timings neither stored nor
 *   fetchable.
 * - **QA switches.** `?mockNoAudio` simulates a machine without an output device (status `error`, "no audio output
 *   device", WP4c deviation 6); `?mockAudioRate=<KB/s>` slows the simulated streaming down.
 * - **Restart.** Like the real app, a reload starts idle: the slice keeps only the idle snapshot (speed, volume,
 *   repeats, gap). A snapshot seeded into the `audio` slice with an active status (QA scenarios) is adopted as a paused
 *   play at that position.
 */
import type { Channel } from '@tauri-apps/api/core'
import {
  events,
  type AbLoop,
  type AppError,
  type AudioSnapshot,
  type AudioTick,
  type AyahRef,
  type GapSetting,
  type PlaybackStatus,
  type PlayRequest,
  type QuranIndex,
  type ReciterInfo,
  type SeekTarget,
  type SkipDirection,
  type StopAt,
  type SurahTimings,
  type WordTiming,
} from '../../bindings'
import { fixtures } from '../fixtures'
import { type ErrorKind, type Handlers, handle, MockError, send } from '../result'
import { idleSnapshot, state } from '../state'
import { AYAH_COUNT, divisionOf, floorIndex, layoutInfo, refOf } from '../synthetic'
import { recordStreamCached } from './packs'
import { mockOnline } from './settings'

/** The tick cadence: 30 Hz (`EngineConfig::tick_hz`). */
export const TICK_MS = 33
/** How long a play stays `loading` (timings, plan, source open). */
export const LOAD_MS = 120
/** `skip(previous)` within this much wall time of a segment start goes back one segment (§2.3.2). */
export const PREVIOUS_WINDOW_MS = 1_500
/** A-B loops shorter than this are rejected (`b − a ≥ 300`, §5.8). */
export const MIN_AB_MS = 300
/** Simulated streaming throughput (2 MB/s, like the packs mock), in KB per second. */
export const STREAM_KB_S = 2_000
/** The bit rate of a QDC file (128 kbps MPEG-1 Layer III, FACT §5.2), in KB per second of audio. */
const FILE_KB_PER_S = 16
/** The output device label the mock reports. */
export const MOCK_DEVICE = 'Mock output'
/** The engine's message for a machine without an output device (`AudioError::NoOutputDevice`). */
export const NO_OUTPUT_MESSAGE = 'no audio output device'

/** The channel `audio_subscribe` registered last (replaces any previous one, like `AudioService`). */
export const audioChannels: { tick: Channel<AudioTick> | null } = { tick: null }

// ---------------------------------------------------------------------------------------------------------------------
// Model

type SegmentKind = 'ayah' | 'basmala'

/** One planned segment (§2.3.3), in the timeline of its file. */
interface Segment {
  kind: SegmentKind
  /** The surah the segment belongs to (a basmala: the surah it opens). */
  surah: number
  /** 0 for the basmala. */
  ayah: number
  /** 0 for the basmala. */
  ayahId: number
  /** The surah whose file holds the audio (surah 1 for every basmala of a QDC reciter, FACT C8). */
  fileSurah: number
  fileDurationMs: number
  startMs: number
  endMs: number
  /** The ayah's own span in the timings (the snapshot's `ayahFromMs`/`ayahToMs`). */
  spanFromMs: number
  spanToMs: number
  /** Word timings, sorted by start (empty for the basmala: its words are 1:1's, not on the page being read). */
  words: readonly WordTiming[]
}

interface Session {
  reciterId: number
  range: { from: AyahRef; to: AyahRef }
  queue: Segment[]
  index: number
  /** File position of the current segment's file (ms). */
  posMs: number
  /** Plays of the current segment so far, counting the current one (1-based). */
  plays: number
  /** Passes over the queue so far, counting the current one (1-based). */
  passes: number
  /** Wall time left in a gap, or `null` outside one. */
  gapLeftMs: number | null
  /** What follows the gap: the same segment again, or the next one. */
  afterGap: 'replay' | 'next'
  /** The A-B loop and the file it is bound to. */
  ab: (AbLoop & { fileSurah: number }) | null
  basmalaSkipped: boolean
  /** The play failed mid-way: the session stays for its view (segment, range) until Play continues it. */
  failed: boolean
}

/** Where a retried play starts in its new queue (`control.rs` `StartAt`): the segment heard, in its pass. */
interface StartAt {
  kind: SegmentKind
  surah: number
  /** 0 for a basmala. */
  ayah: number
  passes: number
}

interface Engine {
  status: PlaybackStatus
  generation: number
  seq: number
  reciterId: number | null
  speedPct: number
  volumePct: number
  ayahRepeat: number
  rangeRepeat: number
  gap: GapSetting
  error: AppError | null
  session: Session | null
  /** The range of a play that ended (kept after the end, cleared by a stop). */
  endedRange: { from: AyahRef; to: AyahRef } | null
  /** Bumped by every play and stop: a plan still loading for an older token is dropped. */
  playToken: number
  /** A pause (`true`) that arrived while the play was loading. */
  pauseQueued: boolean
  /** Seeks, skips and A-B loops that arrived while loading (WP4c deviation 7). */
  held: (() => void)[]
  /** The last ayah reported through `audio-ayah-changed` (`surah:ayah`). */
  lastAyahKey: string | null
  /** Wall time of the last clock step. */
  lastStepAt: number
}

/** A simulated progressive download of one surah file (§2.3.7). */
interface StreamSim {
  reciterId: number
  surah: number
  fileDurationMs: number
  /** KB downloaded so far. */
  kb: number
  /** Wall time `kb` was last brought up to date. */
  at: number
}

let engine: Engine | null = null
let timer: ReturnType<typeof setInterval> | null = null
/** Live streams per file (`reciter:surah`). A complete stream is promoted (recorded as cached) and removed. */
const streams = new Map<string, StreamSim>()
/** Timings fetched in this session (`reciter:surah`): the content.db of the mock, readable offline. */
const storedTimings = new Set<string>()
/** Scripted failure of the next play (tests and QA). */
let failNext: { kind: ErrorKind; message: string } | null = null
let noOutputOverride: boolean | null = null
let streamRateOverride: number | null = null
let adoptingSeed: Promise<void> | null = null

function params(): URLSearchParams {
  return new URLSearchParams(typeof location === 'undefined' ? '' : location.search)
}

function now(): number {
  return Date.now()
}

function noOutput(): boolean {
  return noOutputOverride ?? params().has('mockNoAudio')
}

function streamKbS(): number {
  if (streamRateOverride !== null) return streamRateOverride
  const kb = Number(params().get('mockAudioRate'))
  return Number.isFinite(kb) && kb > 0 ? kb : STREAM_KB_S
}

function online(): boolean {
  return mockOnline(state.settings.value)
}

function fileKey(reciterId: number, surah: number): string {
  return `${reciterId}:${surah}`
}

/** The surahs of a reciter present on the simulated disk (downloaded or stream-cached). */
function localSurahs(reciterId: number): Set<number> {
  const items = state.packs.value.items[`audio.qdc.${reciterId}`] ?? []
  return new Set(items.filter((i) => !i.queued).map((i) => i.item))
}

function isLocal(reciterId: number, surah: number): boolean {
  return localSurahs(reciterId).has(surah)
}

/** The slice value the engine was built from: a reset or reloaded slice (`?mockReset`, tests) restarts the engine. */
let engineSlice: object | null = null

/** The engine, created on first use from the slice (adopting a seeded active snapshot, see the file comment). */
function eng(): Engine {
  const slice = state.audio.value
  if (engine && engineSlice === slice) return engine
  if (engine) {
    stopClock()
    streams.clear()
    adoptingSeed = null
  }
  engineSlice = slice
  const s = slice.snapshot
  const settings = state.settings.value
  engine = {
    status: noOutput() ? 'error' : 'idle',
    generation: 1,
    seq: 0,
    reciterId: s.reciterId ?? settings.reciterId,
    speedPct: s.speedPct || settings.speedPct,
    volumePct: s.volumePct,
    ayahRepeat: s.ayahRepeat,
    rangeRepeat: s.rangeRepeat,
    gap: s.gap,
    error: noOutput() ? { kind: 'audio', message: NO_OUTPUT_MESSAGE } : null,
    session: null,
    endedRange: null,
    playToken: 0,
    pauseQueued: false,
    held: [],
    lastAyahKey: null,
    lastStepAt: now(),
  }
  if (s.status !== 'idle' && s.status !== 'error' && s.range && s.current) adoptingSeed = adoptSeed(s)
  return engine
}

/** A snapshot seeded into the slice (QA) becomes a paused play at its position. */
async function adoptSeed(seed: AudioSnapshot): Promise<void> {
  const e = eng()
  const range = seed.range
  const current = seed.current
  if (!range || !current) return
  const token = ++e.playToken
  e.status = 'loading'
  try {
    const index = await fixtures.index()
    const reciterId = seed.reciterId ?? state.settings.value.reciterId
    const plan = await planQueue(index, reciterId, range.from, range.to, e.ayahRepeat, e.gap, null)
    if (token !== e.playToken) return
    const i = plan.queue.findIndex((g) => g.surah === current.surah && g.ayah === current.ayah)
    const index0 = Math.max(0, i)
    const seg = plan.queue[index0]
    if (!seg) throw new MockError('invalid_argument', 'empty plan')
    e.reciterId = reciterId
    e.session = {
      reciterId,
      range: { from: range.from, to: range.to },
      queue: plan.queue,
      index: index0,
      posMs: clampMs(seed.fileMs, seg.startMs, Math.max(seg.startMs, seg.endMs - 1)),
      plays: 1,
      passes: 1,
      gapLeftMs: null,
      afterGap: 'next',
      ab: null,
      basmalaSkipped: plan.basmalaSkipped,
      failed: false,
    }
    e.status = noOutput() ? 'error' : 'paused'
    e.generation++
    emitState()
    sendTick()
  } catch (err) {
    console.warn('[mock IPC] audio: could not adopt the seeded snapshot', err)
    e.status = 'idle'
    e.session = null
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation (WP4d deviation 15) and `to` resolution (§5.8)

function check(ok: boolean, message: string): void {
  if (!ok) throw new MockError('invalid_argument', message)
}

function checkSpeed(pct: number): void {
  check(
    Number.isInteger(pct) && pct >= 50 && pct <= 200 && pct % 5 === 0,
    `speed ${pct} is not 50..=200 step 5`,
  )
}

function checkVolume(pct: number): void {
  check(Number.isInteger(pct) && pct >= 0 && pct <= 100, `volume ${pct} is not 0..=100`)
}

function checkRepeat(name: string, n: number): void {
  check(Number.isInteger(n) && n >= 0 && n <= 99, `${name} ${n} is not 0..=99`)
}

function checkGap(gap: GapSetting): void {
  switch (gap.type) {
    case 'none':
      return
    case 'fixed':
      check(
        Number.isInteger(gap.data.ms) && gap.data.ms >= 0 && gap.data.ms <= 30_000,
        'gap ms is not 0..=30000',
      )
      return
    case 'multiplier':
      check(
        Number.isInteger(gap.data.pct) && gap.data.pct >= 0 && gap.data.pct <= 300,
        'gap multiplier is not 0..=300',
      )
  }
}

function ayahIdOf(index: QuranIndex, ref: AyahRef): number {
  const s = index.surahs[ref.surah - 1]
  if (!s || s.id !== ref.surah || !Number.isInteger(ref.ayah) || ref.ayah < 1 || ref.ayah > s.ayahCount) {
    throw new MockError('invalid_argument', `no ayah ${ref.surah}:${ref.ayah}`)
  }
  return s.firstAyahId + ref.ayah - 1
}

/** The last ayah of `from`'s stop-at unit (§5.8). */
function resolveTo(index: QuranIndex, request: PlayRequest, fromId: number): number {
  if (request.to) return ayahIdOf(index, request.to)
  const stopAt: StopAt = request.stopAt ?? state.settings.value.stopAt
  switch (stopAt) {
    case 'end_of_surah': {
      const s = index.surahs[request.from.surah - 1]
      return s ? s.firstAyahId + s.ayahCount - 1 : fromId
    }
    case 'end_of_page': {
      const pages = layoutInfo(index, request.layout).pageFirstWord
      const firstWord = index.ayahFirstWord[fromId - 1] ?? 1
      const page = floorIndex(pages, firstWord) + 1
      const nextPageWord = pages[page]
      if (nextPageWord === undefined) return AYAH_COUNT
      return Math.max(fromId, floorIndex(index.ayahFirstWord, nextPageWord - 1) + 1)
    }
    case 'end_of_juz': {
      const juz = index.juz[divisionOf(index.juz, fromId) - 1]
      return juz ? juz.lastAyahId : fromId
    }
    case 'end_of_quran':
      return AYAH_COUNT
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Planner (§2.3.3)

async function timingsFor(reciterId: number, surah: number): Promise<SurahTimings> {
  const t = await fixtures.timings(reciterId, surah)
  storedTimings.add(fileKey(reciterId, surah))
  return t
}

function sortedWords(words: readonly WordTiming[]): WordTiming[] {
  return [...words].sort((a, b) => a.startMs - b.startMs)
}

function offlineError(reciterId: number, surah: number): MockError {
  return new MockError(
    'offline',
    `surah ${surah} of reciter ${reciterId} is not cached and the network is unavailable`,
  )
}

async function planQueue(
  index: QuranIndex,
  reciterId: number,
  from: AyahRef,
  to: AyahRef,
  ayahRepeat: number,
  gap: GapSetting,
  ab: AbLoop | null,
): Promise<{ queue: Segment[]; basmalaSkipped: boolean }> {
  const fromId = ayahIdOf(index, from)
  const toId = ayahIdOf(index, to)
  check(fromId <= toId, `from ${from.surah}:${from.ayah} is after to ${to.surah}:${to.ayah}`)
  const offline = !online()
  const queue: Segment[] = []
  let basmalaSkipped = false
  let basmala: Segment | null | undefined
  const continuous = ayahRepeat === 1 && gap.type === 'none' && ab === null

  for (let surah = from.surah; surah <= to.surah; surah++) {
    const info = index.surahs[surah - 1]
    if (!info) continue
    const first = surah === from.surah ? from.ayah : 1
    const last = surah === to.surah ? to.ayah : info.ayahCount
    if (offline && !isLocal(reciterId, surah)) throw offlineError(reciterId, surah)
    const timings = await timingsFor(reciterId, surah)
    if (first === 1 && surah !== 1 && surah !== 9) {
      if (basmala === undefined) {
        // The basmala is 1:1 of the reciter's surah-1 file (`basmala_in_file = false`, FACT C8); offline and not
        // cached, it is skipped with a notice instead of failing the play (§2.3.3 rule 2).
        if (offline && !isLocal(reciterId, 1)) {
          basmala = null
        } else {
          const t1 = await timingsFor(reciterId, 1)
          const a1 = t1.ayahs[0]
          basmala = a1
            ? {
                kind: 'basmala',
                surah,
                ayah: 0,
                ayahId: 0,
                fileSurah: 1,
                fileDurationMs: t1.durationMs,
                startMs: a1.fromMs,
                endMs: a1.toMs,
                spanFromMs: a1.fromMs,
                spanToMs: a1.toMs,
                words: [],
              }
            : null
        }
      }
      if (basmala) queue.push({ ...basmala, surah })
      else basmalaSkipped = true
    }
    for (let a = first; a <= last; a++) {
      const span = timings.ayahs.find((x) => x.ayah === a)
      if (!span) throw new MockError('audio', `timings: no ayah ${surah}:${a}`)
      queue.push({
        kind: 'ayah',
        surah,
        ayah: a,
        ayahId: info.firstAyahId + a - 1,
        fileSurah: surah,
        fileDurationMs: timings.durationMs,
        startMs: span.fromMs,
        endMs: span.toMs,
        spanFromMs: span.fromMs,
        spanToMs: span.toMs,
        words: sortedWords(span.words),
      })
    }
  }
  // Continuous mode: an ayah runs to the next one's start when that is ayah a+1 of the same file (§2.3.3 rule 3).
  if (continuous) {
    for (let i = 0; i + 1 < queue.length; i++) {
      const g = queue[i]
      const n = queue[i + 1]
      if (
        g &&
        n &&
        g.kind === 'ayah' &&
        n.kind === 'ayah' &&
        n.fileSurah === g.fileSurah &&
        n.ayah === g.ayah + 1
      ) {
        g.endMs = n.startMs
      }
    }
  }
  return { queue, basmalaSkipped }
}

// ---------------------------------------------------------------------------------------------------------------------
// Snapshot, ticks and events

function clampMs(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(v)))
}

function current(s: Session | null): Segment | null {
  return s ? (s.queue[s.index] ?? null) : null
}

/**
 * A stream's progress (0–100) for a 128 kbps file. It fills at the simulated rate (2 MB/s) while network use is
 * possible and stalls while it is not (brought up to date whenever it is read).
 */
function streamPct(sim: StreamSim): number {
  const t = now()
  if (online()) sim.kb += ((t - sim.at) / 1000) * streamKbS()
  sim.at = t
  const fileKb = (sim.fileDurationMs / 1000) * FILE_KB_PER_S
  if (fileKb <= 0) return 100
  return Math.min(100, Math.max(0, Math.floor((sim.kb * 100) / fileKb)))
}

/** Starts streaming a file that is not on the simulated disk (one writer per file, §2.3.7 rule 2). */
function openStream(reciterId: number, seg: Segment): void {
  const key = fileKey(reciterId, seg.fileSurah)
  if (isLocal(reciterId, seg.fileSurah) || streams.has(key)) return
  streams.set(key, { reciterId, surah: seg.fileSurah, fileDurationMs: seg.fileDurationMs, kb: 0, at: now() })
}

/** Promotes complete streams to the cache; with `abandon`, drops the incomplete ones (their temp is deleted). */
function settleStreams(abandon: boolean): void {
  for (const [key, sim] of streams) {
    if (streamPct(sim) >= 100) {
      streams.delete(key)
      recordStreamCached(sim.reciterId, sim.surah)
    } else if (abandon) {
      streams.delete(key)
    }
  }
}

/** Buffered share of the current file (0–100): complete when local, else the simulated stream's progress. */
function bufferedPct(s: Session, seg: Segment): number {
  const sim = streams.get(fileKey(s.reciterId, seg.fileSurah))
  if (sim === undefined) return 100
  const pct = streamPct(sim)
  if (pct >= 100) settleStreams(false)
  return pct
}

/** How far into the current file the audio is there (ms): all of it when local, else what the stream has brought. */
function bufferedMs(s: Session, seg: Segment): number {
  if (bufferedPct(s, seg) >= 100) return seg.fileDurationMs
  const sim = streams.get(fileKey(s.reciterId, seg.fileSurah))
  return sim ? Math.min(seg.fileDurationMs, (sim.kb / FILE_KB_PER_S) * 1000) : seg.fileDurationMs
}

function repeatLeft(e: Engine, s: Session, seg: Segment): { ayah: number; range: number } {
  const ayah = e.ayahRepeat === 0 || seg.kind !== 'ayah' || s.ab ? 0 : Math.max(0, e.ayahRepeat - s.plays)
  const range = e.rangeRepeat === 0 ? 0 : Math.max(0, e.rangeRepeat - s.passes)
  return { ayah, range }
}

/** The engine's snapshot (§5.8), computed when read (WP4c deviation 9). */
export function snapshot(): AudioSnapshot {
  const e = eng()
  const s = e.session
  const seg = current(s)
  const base: AudioSnapshot = {
    status: e.status,
    reciterId: e.reciterId,
    current: null,
    currentAyahId: null,
    range: s ? structuredClone(s.range) : e.endedRange ? structuredClone(e.endedRange) : null,
    ayahRepeat: e.ayahRepeat,
    ayahRepeatLeft: 0,
    rangeRepeat: e.rangeRepeat,
    rangeRepeatLeft: 0,
    gap: structuredClone(e.gap),
    abLoop: s?.ab ? { aMs: s.ab.aMs, bMs: s.ab.bMs } : null,
    speedPct: e.speedPct,
    volumePct: e.volumePct,
    fileMs: 0,
    fileDurationMs: 0,
    ayahFromMs: 0,
    ayahToMs: 0,
    bufferedPct: 0,
    device: noOutput() ? null : MOCK_DEVICE,
    basmalaSkipped: s?.basmalaSkipped ?? false,
    error: e.error ? structuredClone(e.error) : null,
  }
  if (!s || !seg) return base
  const left = repeatLeft(e, s, seg)
  return {
    ...base,
    current: { surah: seg.surah, ayah: seg.ayah },
    currentAyahId: seg.ayahId,
    ayahRepeatLeft: left.ayah,
    rangeRepeatLeft: left.range,
    fileMs: Math.round(s.posMs),
    fileDurationMs: seg.fileDurationMs,
    ayahFromMs: seg.spanFromMs,
    ayahToMs: seg.spanToMs,
    bufferedPct: bufferedPct(s, seg),
  }
}

/** The word heard at the position: the last word starting at or before it, by time (FACT §5.2); 0 in a gap. */
function wordPos(s: Session, seg: Segment): number {
  if (s.gapLeftMs !== null || seg.words.length === 0) return 0
  let pos = 0
  for (const w of seg.words) {
    if (w.startMs > s.posMs) break
    pos = w.pos
  }
  return pos
}

function sendTick(): void {
  const e = eng()
  const s = e.session
  const seg = current(s)
  e.seq++
  send(audioChannels.tick, {
    seq: e.seq,
    generation: e.generation,
    status: e.status,
    surah: seg?.surah ?? 0,
    ayah: seg?.ayah ?? 0,
    ayahId: seg?.ayahId ?? 0,
    fileMs: s ? Math.round(s.posMs) : 0,
    wordPos: s && seg ? wordPos(s, seg) : 0,
    speedPct: e.speedPct,
    inGap: s?.gapLeftMs != null,
    bufferedPct: s && seg ? bufferedPct(s, seg) : 0,
  })
}

function emitState(): void {
  const snap = snapshot()
  void events.audioStateChanged
    .emit(snap)
    .catch((err: unknown) => console.error('[mock IPC] audio-state-changed', err))
  reportAyah()
}

/** `audio-ayah-changed` when the heard ayah differs from the last one reported (WP4c deviation 10). */
function reportAyah(): void {
  const e = eng()
  const seg = current(e.session)
  if (!seg || (e.status !== 'playing' && e.status !== 'buffering')) return
  const key = `${seg.surah}:${seg.ayah}`
  if (key === e.lastAyahKey) return
  e.lastAyahKey = key
  void events.audioAyahChanged
    .emit({ reciterId: e.session?.reciterId ?? 0, surah: seg.surah, ayah: seg.ayah, ayahId: seg.ayahId })
    .catch((err: unknown) => console.error('[mock IPC] audio-ayah-changed', err))
}

/** Persists what a restart keeps: the idle snapshot with the engine's speed, volume, repeats and gap. */
function persist(): void {
  const e = eng()
  state.audio.update((a) => {
    a.snapshot = {
      ...idleSnapshot(state.settings.value),
      reciterId: e.reciterId,
      speedPct: e.speedPct,
      volumePct: e.volumePct,
      ayahRepeat: e.ayahRepeat,
      rangeRepeat: e.rangeRepeat,
      gap: structuredClone(e.gap),
      device: noOutput() ? null : MOCK_DEVICE,
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// Clock

function startClock(): void {
  const e = eng()
  e.lastStepAt = now()
  if (timer !== null) return
  timer = setInterval(step, TICK_MS)
}

function stopClock(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
}

function step(): void {
  const e = eng()
  const t = now()
  const dt = Math.max(0, t - e.lastStepAt)
  e.lastStepAt = t
  if (e.status !== 'playing' && e.status !== 'buffering') {
    stopClock()
    return
  }
  advance(dt)
  if (eng().status === 'playing' || eng().status === 'buffering') sendTick()
}

/** Advances the session by `dt` ms of wall time. */
function advance(dt: number): void {
  const e = eng()
  const s = e.session
  const first = current(s)
  if (!s || !first) return

  // Streaming: the position waits for the download (status `buffering` while it does), 1 s of audio ahead.
  const starving = bufferedMs(s, first) < Math.min(first.fileDurationMs, s.posMs + 1_000)
  if (starving && !online()) {
    // The stream stalled with network use gone: the play fails mid-way at the segment heard (decode's stalled source).
    failMidway(asAppError(offlineError(s.reciterId, first.fileSurah)))
    return
  }
  if (starving !== (e.status === 'buffering')) {
    e.status = starving ? 'buffering' : 'playing'
    emitState()
  }
  if (starving) return

  let wallMs = dt
  if (s.gapLeftMs !== null) {
    s.gapLeftMs -= wallMs
    if (s.gapLeftMs > 0) return
    wallMs = -s.gapLeftMs
    s.gapLeftMs = null
    if (s.afterGap === 'replay') replay(s)
    else if (!next(s)) return
  }

  s.posMs += (wallMs * e.speedPct) / 100
  for (let guard = 0; guard < 1_000; guard++) {
    const seg = current(s)
    if (!seg || s.gapLeftMs !== null) return
    if (s.ab && s.ab.fileSurah === seg.fileSurah && s.posMs >= s.ab.bMs) {
      wrapToA(s, s.posMs - s.ab.bMs)
      continue
    }
    if (s.posMs < seg.endMs) return
    const overflow = s.posMs - seg.endMs
    const outcome = segmentEnd(s, seg)
    if (outcome !== 'moved') return
    s.posMs += overflow
  }
}

/** A-B: back to A (plus `overflow` ms), in the segment of the heard run that holds it (the seeks' rule). */
function wrapToA(s: Session, overflow: number): void {
  if (!s.ab) return
  const a = s.ab.aMs
  const at = s.queue[s.index]?.fileSurah === s.ab.fileSurah ? seekInRun(s.queue, s.index, a) : null
  const before = s.index
  if (at) s.index = at.index
  s.posMs = a + Math.max(0, overflow)
  if (s.index !== before) emitState()
}

/**
 * Handles the end of the current segment: the next play starts at its segment's start (`moved`), a gap freezes the
 * position at the ayah's end (`gap`), or the queue is over (`ended`).
 */
function segmentEnd(s: Session, seg: Segment): 'moved' | 'gap' | 'ended' {
  const e = eng()
  if (s.ab && s.ab.fileSurah === seg.fileSurah) {
    // Inside an A-B loop playback is linear from A to B: segment ends only move on (WP4b deviation 10), and the end
    // of the file (or of the queue) before B wraps too.
    const n = s.queue[s.index + 1]
    if (n && n.fileSurah === seg.fileSurah) {
      s.index++
      s.posMs = n.startMs
      emitState()
    } else {
      wrapToA(s, 0)
    }
    return 'moved'
  }
  const lastPlay = seg.kind !== 'ayah' || (e.ayahRepeat !== 0 && s.plays >= e.ayahRepeat)
  const finalOfQueue =
    lastPlay && s.index === s.queue.length - 1 && e.rangeRepeat !== 0 && s.passes >= e.rangeRepeat
  if (seg.kind === 'ayah' && e.gap.type !== 'none' && !finalOfQueue) {
    // The gap follows every ayah play except the very last; the position freezes at the ayah's end.
    const ms = gapMs(e.gap, seg)
    if (ms > 0) {
      s.posMs = seg.endMs
      s.gapLeftMs = ms
      s.afterGap = lastPlay ? 'next' : 'replay'
      emitState()
      return 'gap'
    }
  }
  if (!lastPlay) {
    replay(s)
    return 'moved'
  }
  return next(s) ? 'moved' : 'ended'
}

function gapMs(gap: GapSetting, seg: Segment): number {
  switch (gap.type) {
    case 'none':
      return 0
    case 'fixed':
      return gap.data.ms
    case 'multiplier':
      return Math.round(((seg.endMs - seg.startMs) * gap.data.pct) / 100)
  }
}

function replay(s: Session): void {
  const seg = current(s)
  if (!seg) return
  s.plays++
  s.posMs = seg.startMs
  emitState()
}

/** Moves to the next segment (or the next pass); ends the play after the last one. `false` when it ended. */
function next(s: Session): boolean {
  const e = eng()
  if (s.index + 1 < s.queue.length) {
    s.index++
    s.plays = 1
    s.posMs = s.queue[s.index]?.startMs ?? 0
    emitState()
    return true
  }
  if (e.rangeRepeat === 0 || s.passes < e.rangeRepeat) {
    s.passes++
    s.index = 0
    s.plays = 1
    s.posMs = s.queue[0]?.startMs ?? 0
    emitState()
    return true
  }
  end()
  return false
}

/** The End marker was heard: `idle`, keeping the reciter and the range (WP4c deviation 6). */
function end(): void {
  const e = eng()
  e.endedRange = e.session ? structuredClone(e.session.range) : null
  e.session = null
  e.status = noOutput() ? 'error' : 'idle'
  e.lastAyahKey = null
  stopClock()
  persist()
  emitState()
  sendTick()
}

// ---------------------------------------------------------------------------------------------------------------------
// Commands

async function play(request: PlayRequest): Promise<AudioSnapshot> {
  const e = eng()
  const index = await fixtures.index()
  const reciters = state.audio.value.reciters
  if (reciters.length > 0 && !reciters.some((r) => r.id === request.reciterId)) {
    throw new MockError('not_found', `reciter ${request.reciterId} is not in the catalog`)
  }
  check(request.from.ayah >= 1, 'from.ayah must be ≥ 1')
  const fromId = ayahIdOf(index, request.from)
  const toId = resolveTo(index, request, fromId)
  check(fromId <= toId, `from ${fromId} is after to ${toId}`)
  checkRepeat('ayah repeat', request.ayahRepeat)
  checkRepeat('range repeat', request.rangeRepeat)
  checkGap(request.gap)
  // `record` is optional (absent ⇒ true); the mock keeps no listen history, so a preview's `false` changes nothing here.
  check(request.record === undefined || typeof request.record === 'boolean', 'record must be a boolean')
  if (failNext) {
    const f = failNext
    failNext = null
    throw new MockError(f.kind, f.message)
  }

  const token = ++e.playToken
  stopClock()
  settleStreams(true)
  e.session = null
  e.endedRange = null
  e.held = []
  e.pauseQueued = request.startPaused
  e.lastAyahKey = null
  e.reciterId = request.reciterId
  e.ayahRepeat = request.ayahRepeat
  e.rangeRepeat = request.rangeRepeat
  e.gap = structuredClone(request.gap)
  e.error = null
  e.status = 'loading'
  const to = refOf(index, toId)
  const range = { from: { ...request.from }, to: { surah: to.surah, ayah: to.ayah } }
  const answer: AudioSnapshot = { ...snapshot(), range: structuredClone(range) }
  emitState()
  void load(token, index, request, range)
  return answer
}

/**
 * Plans and opens a play, then starts it (`playing`, or `paused` after a pause sent while loading). `at`: a failed play
 * retried from the segment heard ({@link retry}); while that still fails before it starts, the failed play stays as it
 * was.
 */
async function load(
  token: number,
  index: QuranIndex,
  request: Pick<PlayRequest, 'reciterId'>,
  range: { from: AyahRef; to: AyahRef },
  at: StartAt | null = null,
): Promise<void> {
  const e = eng()
  try {
    await new Promise((resolve) => setTimeout(resolve, LOAD_MS))
    if (token !== e.playToken) return
    const plan = await planQueue(index, request.reciterId, range.from, range.to, e.ayahRepeat, e.gap, null)
    if (token !== e.playToken) return
    const start = at ? startIndex(plan.queue, at) : 0
    const first = plan.queue[start]
    if (!first) throw new MockError('invalid_argument', 'empty range')
    for (const seg of plan.queue) openStream(request.reciterId, seg)
    e.session = {
      reciterId: request.reciterId,
      range,
      queue: plan.queue,
      index: start,
      posMs: first.startMs,
      plays: 1,
      passes: at?.passes ?? 1,
      gapLeftMs: null,
      afterGap: 'next',
      ab: null,
      basmalaSkipped: plan.basmalaSkipped,
      failed: false,
    }
    e.error = null
    e.generation++
    if (noOutput()) {
      e.status = 'error'
      e.error = { kind: 'audio', message: NO_OUTPUT_MESSAGE }
    } else {
      e.status = e.pauseQueued ? 'paused' : 'playing'
    }
    e.pauseQueued = false
    const held = e.held
    e.held = []
    for (const run of held) run()
    emitState()
    sendTick()
    if (e.status === 'playing') startClock()
  } catch (err) {
    if (token !== e.playToken) return
    const error = asAppError(err)
    e.status = 'error'
    e.error = error
    e.held = []
    e.pauseQueued = false
    if (!(at && e.session?.failed)) {
      // A play that fails before it starts keeps its reciter and range for the dock (`fail_play`).
      e.session = null
      e.endedRange = structuredClone(range)
    }
    emitState()
    sendTick()
  }
}

/** The error a failed play reports in its snapshot. */
function asAppError(err: unknown): AppError {
  return err instanceof MockError
    ? { kind: err.kind, message: err.message }
    : { kind: 'internal', message: err instanceof Error ? err.message : String(err) }
}

/** The index of a retried play's start in its new queue (`StartAt::index_in`). */
function startIndex(queue: readonly Segment[], at: StartAt): number {
  const same = queue.findIndex((g) => g.kind === at.kind && g.surah === at.surah && g.ayah === at.ayah)
  if (same >= 0) return same
  // A basmala no longer planned (its file went offline): the first ayah at or after it.
  const later = queue.findIndex(
    (g) => g.kind === 'ayah' && (g.surah > at.surah || (g.surah === at.surah && g.ayah >= at.ayah)),
  )
  return Math.max(0, later)
}

/**
 * The play failed mid-way (a stalled stream with network use off): it stops where it was, and the failed session stays
 * for its view (the segment heard and the range) with the error, until Play continues it ({@link retry}), a new play
 * replaces it, or a stop clears it.
 */
function failMidway(error: AppError): void {
  const e = eng()
  const s = e.session
  if (!s) return
  s.failed = true
  s.gapLeftMs = null
  e.status = 'error'
  e.error = error
  stopClock()
  settleStreams(true)
  emitState()
  sendTick()
}

/**
 * Play after a mid-way failure (`control.rs` `retry`): the same play, planned again with the repeats and gap in force,
 * from the segment that was heard, in its pass. It loads like a play; while it still fails before it starts, the failed
 * play stays as it was, so the next Play tries again from the same place.
 */
function retry(): void {
  const e = eng()
  const s = e.session
  const seg = current(s)
  if (!s?.failed || !seg) return
  const at: StartAt = { kind: seg.kind, surah: seg.surah, ayah: seg.ayah, passes: s.passes }
  const token = e.playToken
  e.status = 'loading'
  e.error = null
  e.pauseQueued = false
  e.held = []
  emitState()
  void fixtures.index().then((index) => load(token, index, { reciterId: s.reciterId }, s.range, at))
}

/** Runs a transport command now, or holds it until the loading play starts (WP4c deviation 7). */
function whenLoaded(run: () => void): void {
  const e = eng()
  if (e.status === 'loading') e.held.push(run)
  else run()
}

function pause(): void {
  const e = eng()
  if (e.status === 'loading') {
    e.pauseQueued = true
    return
  }
  if (e.status !== 'playing' && e.status !== 'buffering') return
  e.status = 'paused'
  stopClock()
  emitState()
  sendTick()
}

function resume(): void {
  const e = eng()
  if (e.status === 'loading') {
    e.pauseQueued = false
    return
  }
  // A play that failed mid-way starts again where it stopped.
  if (e.status === 'error' && e.session?.failed) {
    retry()
    return
  }
  if (e.status !== 'paused' || !e.session) return
  e.status = 'playing'
  emitState()
  sendTick()
  startClock()
}

function stop(): void {
  const e = eng()
  e.playToken++
  stopClock()
  settleStreams(true)
  e.session = null
  e.endedRange = null
  e.held = []
  e.pauseQueued = false
  e.lastAyahKey = null
  e.error = noOutput() ? { kind: 'audio', message: NO_OUTPUT_MESSAGE } : null
  e.status = noOutput() ? 'error' : 'idle'
  persist()
  emitState()
  sendTick()
}

/** A user seek or jump: a flush (new generation) to `ms` of the current file, inside the planned range. */
function flushTo(s: Session, index: number, ms: number): void {
  const e = eng()
  const seg = s.queue[index]
  if (!seg) return
  const sameSegment = index === s.index
  s.index = index
  s.posMs = clampMs(ms, seg.startMs, Math.max(seg.startMs, seg.endMs - 1))
  s.gapLeftMs = null
  if (!sameSegment) s.plays = 1
  if (s.ab && s.ab.fileSurah === seg.fileSurah && s.posMs >= s.ab.bMs) s.posMs = s.ab.aMs
  e.generation++
  e.lastStepAt = now()
  emitState()
  sendTick()
}

function seek(target: SeekTarget): void {
  const e = eng()
  const s = e.session
  const seg = current(s)
  if (!s || !seg || s.failed) return
  switch (target.type) {
    case 'ayah': {
      const i = s.queue.findIndex((g) => g.kind === 'ayah' && g.ayahId === target.data.ayahId)
      if (i < 0) {
        console.info(
          `[mock IPC] audio: seek to ayah ${target.data.ayahId} outside the playing range is ignored`,
        )
        return
      }
      flushTo(s, i, s.queue[i]?.startMs ?? 0)
      return
    }
    case 'file_ms':
    case 'relative_ms': {
      const base = s.gapLeftMs !== null ? seg.endMs : s.posMs
      const ms = target.type === 'file_ms' ? target.data.ms : base + target.data.deltaMs
      // Bounded to the heard run: before it, its start; past it, its end (which ends its last segment at once).
      const to = seekInRun(s.queue, s.index, ms)
      if (to) flushTo(s, to.index, to.ms)
    }
  }
}

/**
 * The run around `idx`: the consecutive segments that play its file in order, each starting at or after the one
 * before (`plan::file_run`). Outside it lies audio of that file the queue does not play: the ayahs before or after the
 * range, or the surah-1 file's 1:1 that backs a basmala elsewhere in the queue.
 */
function fileRun(queue: readonly Segment[], idx: number): { first: number; last: number } | null {
  if (!queue[idx]) return null
  const inOrder = (a: number, b: number) => {
    const x = queue[a]
    const y = queue[b]
    return x !== undefined && y !== undefined && x.fileSurah === y.fileSurah && y.startMs >= x.startMs
  }
  let first = idx
  while (first > 0 && inOrder(first - 1, first)) first--
  let last = idx
  while (inOrder(last, last + 1)) last++
  return { first, last }
}

/** The part of the file timeline a seek or an A-B loop may reach while segment `idx` is heard (`file_run_span`). */
function fileRunSpan(queue: readonly Segment[], idx: number): { start: number; end: number } | null {
  const run = fileRun(queue, idx)
  const head = run ? queue[run.first] : undefined
  if (!run || !head) return null
  let end = head.startMs
  for (let i = run.first; i <= run.last; i++) end = Math.max(end, queue[i]?.endMs ?? end)
  return { start: head.startMs, end }
}

/**
 * Where a seek to `ms` on the heard file continues (`plan::seek_in_run`): `ms` bounded to the run around `idx`, and the
 * segment of that run that holds it (else the earliest starting after it, else the latest), nearest to `idx`.
 */
function seekInRun(queue: readonly Segment[], idx: number, ms: number): { index: number; ms: number } | null {
  const run = fileRun(queue, idx)
  const span = fileRunSpan(queue, idx)
  if (!run || !span) return null
  const t = Math.min(span.end, Math.max(span.start, Math.round(ms)))
  const indices: number[] = []
  for (let i = run.first; i <= run.last; i++) indices.push(i)
  const seg = (i: number) => queue[i] as Segment
  const near = (i: number) => Math.abs(i - idx)
  const holding = indices.filter((i) => seg(i).startMs <= t && t < seg(i).endMs)
  if (holding.length > 0) {
    holding.sort((a, b) => near(a) - near(b) || a - b)
    return { index: holding[0] as number, ms: t }
  }
  const after = indices.filter((i) => seg(i).startMs > t)
  if (after.length > 0) {
    after.sort((a, b) => seg(a).startMs - seg(b).startMs || near(a) - near(b))
    return { index: after[0] as number, ms: t }
  }
  indices.sort((a, b) => seg(b).startMs - seg(a).startMs || near(a) - near(b))
  return { index: indices[0] as number, ms: t }
}

function skip(direction: SkipDirection): void {
  const e = eng()
  const s = e.session
  const seg = current(s)
  if (!s || !seg || s.failed) return
  if (direction === 'next') {
    if (s.index + 1 >= s.queue.length) {
      // The last segment: what its end would do. While range repeats remain, the next pass; else the play stops.
      if (e.rangeRepeat === 0 || s.passes < e.rangeRepeat) {
        s.passes++
        s.plays = 1
        flushTo(s, 0, s.queue[0]?.startMs ?? 0)
      } else {
        stop()
      }
      return
    }
    flushTo(s, s.index + 1, s.queue[s.index + 1]?.startMs ?? 0)
    return
  }
  const heardMs = ((s.posMs - seg.startMs) * 100) / e.speedPct
  const target = heardMs <= PREVIOUS_WINDOW_MS && s.index > 0 ? s.index - 1 : s.index
  flushTo(s, target, s.queue[target]?.startMs ?? 0)
}

function setSpeed(pct: number): void {
  const e = eng()
  if (pct === e.speedPct) return
  e.speedPct = pct
  if (e.session) {
    e.generation++
    e.lastStepAt = now()
  }
  persist()
  emitState()
  sendTick()
}

function setVolume(pct: number): void {
  const e = eng()
  if (pct === e.volumePct) return
  e.volumePct = pct
  persist()
  emitState()
}

function setRepeat(ayahRepeat: number, rangeRepeat: number): void {
  const e = eng()
  e.ayahRepeat = ayahRepeat
  e.rangeRepeat = rangeRepeat
  persist()
  emitState()
}

function setGap(gap: GapSetting): void {
  const e = eng()
  e.gap = structuredClone(gap)
  const s = e.session
  if (s && gap.type === 'none' && s.gapLeftMs !== null) s.gapLeftMs = 0
  persist()
  emitState()
}

function setAbLoop(ab: AbLoop | null): void {
  const e = eng()
  const s = e.session
  const seg = current(s)
  if (!s || !seg || s.failed) return
  if (ab === null) {
    if (!s.ab) return
    s.ab = null
    emitState()
    return
  }
  // Bounded to the heard run, so the snapshot reports the loop that plays. An inverted loop, or one the bounds leave
  // under 300 ms, is ignored and clears the loop in force (`control.rs` `set_ab_loop`).
  const span = fileRunSpan(s.queue, s.index) ?? { start: 0, end: Number.MAX_SAFE_INTEGER }
  const aMs = Math.min(span.end, Math.max(span.start, ab.aMs))
  const bMs = Math.min(span.end, Math.max(span.start, ab.bMs))
  if (ab.bMs <= ab.aMs || bMs - aMs < MIN_AB_MS) {
    console.info(
      `[mock IPC] audio: ignoring A-B loop ${ab.aMs}..${ab.bMs} ms (the queue plays ${span.start}..${span.end} ms)`,
    )
    if (s.ab) {
      s.ab = null
      emitState()
    }
    return
  }
  s.ab = { aMs, bMs, fileSurah: seg.fileSurah }
  s.gapLeftMs = null
  if (s.posMs >= bMs || s.posMs < aMs) wrapToA(s, 0)
  emitState()
  sendTick()
}

function toggle(): void {
  const e = eng()
  if (e.status === 'playing' || e.status === 'buffering' || e.status === 'loading') pause()
  else if (e.status === 'paused' || (e.status === 'error' && e.session?.failed)) resume()
}

// ---------------------------------------------------------------------------------------------------------------------
// Handlers

/** The `null` result of a command without data (the commands answer `Result<(), AppError>`). */
function done(_effect: void): null {
  return null
}

/** Reciters with their downloaded (pinned) and stream-cached counts from the simulated disk. */
async function reciters(): Promise<ReciterInfo[]> {
  const fixture = await fixtures.json<ReciterInfo[]>('packs/reciters.json')
  const base = fixture && fixture.length > 0 ? fixture : state.audio.value.reciters
  return base.map((r) => {
    const items = state.packs.value.items[r.packId] ?? []
    const present = items.filter((i) => !i.queued)
    return {
      ...structuredClone(r),
      downloadedSurahs: present.filter((i) => i.pinned).length,
      cachedSurahs: present.filter((i) => !i.pinned).length,
    }
  })
}

export const audioHandlers: Handlers<
  | 'audioSubscribe'
  | 'audioPlay'
  | 'audioPause'
  | 'audioResume'
  | 'audioToggle'
  | 'audioStop'
  | 'audioSkip'
  | 'audioSeek'
  | 'audioSetSpeed'
  | 'audioSetVolume'
  | 'audioSetRepeat'
  | 'audioSetGap'
  | 'audioSetAbLoop'
  | 'audioGetSnapshot'
  | 'audioGetTimings'
  | 'audioListReciters'
> = {
  audioSubscribe: handle((onTick: Channel<AudioTick>) => {
    audioChannels.tick = onTick
    return snapshot()
  }),
  audioPlay: handle((request: PlayRequest) => play(request)),
  audioPause: handle(() => done(pause())),
  audioResume: handle(() => done(resume())),
  audioToggle: handle(() => done(toggle())),
  audioStop: handle(() => done(stop())),
  audioSkip: handle((direction: SkipDirection) => done(whenLoaded(() => skip(direction)))),
  audioSeek: handle((target: SeekTarget) => {
    if (target.type === 'ayah') check(target.data.ayahId >= 1 && target.data.ayahId <= AYAH_COUNT, 'ayah id')
    return done(whenLoaded(() => seek(target)))
  }),
  audioSetSpeed: handle((speedPct: number) => {
    checkSpeed(speedPct)
    return done(setSpeed(speedPct))
  }),
  audioSetVolume: handle((volumePct: number) => {
    checkVolume(volumePct)
    return done(setVolume(volumePct))
  }),
  audioSetRepeat: handle((ayahRepeat: number, rangeRepeat: number) => {
    checkRepeat('ayah repeat', ayahRepeat)
    checkRepeat('range repeat', rangeRepeat)
    return done(setRepeat(ayahRepeat, rangeRepeat))
  }),
  audioSetGap: handle((gap: GapSetting) => {
    checkGap(gap)
    return done(setGap(gap))
  }),
  audioSetAbLoop: handle((abLoop: AbLoop | null) => {
    if (abLoop) check(abLoop.bMs - abLoop.aMs >= MIN_AB_MS, `an A-B loop needs b − a ≥ ${MIN_AB_MS} ms`)
    return done(whenLoaded(() => setAbLoop(abLoop)))
  }),
  audioGetSnapshot: handle(() => snapshot()),
  audioGetTimings: handle(async (reciterId: number, surah: number) => {
    check(Number.isInteger(surah) && surah >= 1 && surah <= 114, `surah ${surah} is outside 1..=114`)
    const key = fileKey(reciterId, surah)
    if (!online() && !storedTimings.has(key) && !isLocal(reciterId, surah))
      throw offlineError(reciterId, surah)
    return timingsFor(reciterId, surah)
  }),
  audioListReciters: handle(() => reciters()),
}

/** Test and QA controls of the simulation. */
export const audioMock = {
  /** Fails the next `audio_play` with this error (after validation). */
  failNextPlay(kind: ErrorKind, message = 'scripted failure'): void {
    failNext = { kind, message }
  },
  /** Simulates a machine without an output device (`null`: follow `?mockNoAudio`). */
  setNoOutput(on: boolean | null): void {
    noOutputOverride = on
    const e = eng()
    if (noOutput()) {
      e.status = 'error'
      e.error = { kind: 'audio', message: NO_OUTPUT_MESSAGE }
      stopClock()
    } else if (e.status === 'error' && e.error?.message === NO_OUTPUT_MESSAGE) {
      e.error = null
      e.status = e.session ? 'paused' : 'idle'
    }
    emitState()
  },
  /** Overrides the simulated streaming rate (KB/s); `null` restores 2 MB/s (or `?mockAudioRate`). */
  setStreamRate(kbPerSec: number | null): void {
    streamRateOverride = kbPerSec
  },
  /** Advances the simulation now (tests drive it with fake timers; this flushes a partial tick). */
  step(): void {
    step()
  },
  /** The planned queue of the current play (tests): `[surah, ayah]` per segment. */
  queue(): [number, number][] {
    return eng().session?.queue.map((g) => [g.surah, g.ayah] as [number, number]) ?? []
  },
  /** The seeded-snapshot adoption in flight, if any (tests). */
  get adopting(): Promise<void> | null {
    return adoptingSeed
  },
  /** Forgets the engine, streams, stored timings and scripted failures (the slice itself is reset separately). */
  reset(): void {
    stopClock()
    engine = null
    engineSlice = null
    streams.clear()
    storedTimings.clear()
    failNext = null
    noOutputOverride = null
    streamRateOverride = null
    adoptingSeed = null
    audioChannels.tick = null
  },
}

/**
 * `player` store (§7.3, §7.8): the audio snapshot, the 30 Hz tick channel, rAF position interpolation, word timings,
 * the resume candidate and every transport command. Owner: WP9a. Layer L2: never imports `reader` or `memo` (§7.2);
 * the dock and the audio shortcuts pass the reader's target in (`toggle(idleTarget)`).
 *
 * - **Sources of truth.** `snapshot` follows `audio-state-changed` (status, ayah edges, repeats, speed, volume, A-B,
 *   errors); `tick` follows the `AudioTick` channel. The heard ayah (`currentRef`) comes from whichever is newer, and is
 *   only replaced when it changes, so consumers re-run at ayah edges, not at 30 Hz.
 * - **Position.** While playing in a visible document, `positionMs` is interpolated (§7.3:
 *   `tick.fileMs + (now − tickAt) × speedPct / 100`, clamped to the ayah's end + 250 ms) at each tick and, between
 *   ticks, exactly when the UI would show a change: the next word's start, or the next boundary of the finest step a
 *   component asked for (`needPosition`: the scrubber's device pixel; else {@link POSITION_STEP_MS}, the readouts'
 *   whole seconds). Nothing runs on every animation frame, so a recitation costs the webview no frames of its own
 *   (§13.6 playback CPU). Otherwise it is the latest tick's or snapshot's `fileMs`. Within one flush generation it never
 *   steps back by less than {@link BACKSTEP_TOLERANCE_MS} (tick jitter), while real jumps (a repeat, an A-B wrap) pass
 *   through.
 * - **Active word** (§7.3, FACT §5.2). The last word of the current ayah whose `startMs ≤ positionMs`, by time (word
 *   positions may repeat or go backwards), held through inter-word gaps, `null` in a gap or during the basmala. Without
 *   timings the tick's `wordPos` is used. The object is reused while the word is the same.
 * - **Settings.** Speed and volume are settings (`speedPct`, `volumePct`); the store applies their value to the engine
 *   whenever it differs from what was last sent, so a change from Settings, the palette or the dock is heard at once
 *   in the real app and in the mock alike. Mute is session state (volume 0 without touching the setting). Repeats,
 *   gap and stop-at are the defaults of the next play; the dock's repeat and gap changes also apply to the current play.
 * - **Resume** (§7.8). The `audio` reading position is written as the recitation moves (debounced 1 s, at once when
 *   the app quits: `app.beforeQuit`), at a stop (the ayah heard last) and at the natural end of a play (the ayah after
 *   the range). `resumeCandidate` offers it for 7 days. Space resumes it before anything else; it never plays by
 *   itself. A restore of the library (`user-data-changed` with `positions`) reloads it.
 * - **Previews** (`preview`, the onboarding's ▶ 1:1, §9.7): a play that is no part of the user's listening. It writes
 *   no position, leaves the resume candidate and the dock's error alone, and is never "the last play" Space replays.
 *   It is sent with `record: false`, so the app records no listen history for it and the media keys never replay it.
 * - **Failures.** A play that fails (the command or the engine's `error` status) is kept in `error` with its request,
 *   so the dock can show the §9.8 copy with Retry or "Download when online". Play methods therefore resolve normally.
 *   An `offline` failure clears itself once network use is possible again (`app.online` and `networkAllowed`). A play
 *   that failed mid-way (the snapshot keeps the ayah heard, `current`) names the surah that failed, and Play or Retry
 *   continue it in the engine from where it stopped (`audio_resume`); one that failed before it started plays its
 *   request again.
 * - **Timings** are cached per reciter and surah, at most {@link TIMINGS_CACHE} surahs (least recently used out),
 *   never those of the loaded play's reciter for the surahs it is heard in or spans.
 */
import { Channel } from '@tauri-apps/api/core'
import { untrack } from 'svelte'
import type { Store } from '$lib/contracts/stores'
import { type Api, api, call, events, toAppError } from '$lib/ipc'
import type {
  AppError,
  AudioSnapshot,
  AudioTick,
  AyahChange,
  AyahRef,
  AyahTiming,
  Bootstrap,
  GapSetting,
  MushafLayout,
  MushafStyle,
  PlaybackStatus,
  PlayRequest,
  ReadingPosition,
  ReciterInfo,
  StopAt,
  SurahTimings,
  WordTiming,
} from '$lib/ipc/bindings'
import { floorIndex } from '$lib/util/binsearch'
import { LRU } from '$lib/util/lru'
import { app, listenEvent } from './app.svelte'
import { history } from './history.svelte'
import { i18n } from './i18n.svelte'
import { quran } from './quran.svelte'
import { settings } from './settings.svelte'
import { ui } from './ui.svelte'

/** The word being recited: its ayah, word id and position within the ayah. */
export interface ActiveWord {
  ayahId: number
  wordId: number
  pos: number
}

/** The idle dock's "Resume Al-Kahf · 18:45 · Mishary Alafasy" candidate (§7.8). */
export interface ResumeCandidate {
  ayahId: number
  reciterId: number
  updatedAt: number
}

/** Where `playFrom` starts. */
export interface PlayTarget {
  ayahId: number
}

/** Options of a play; anything left out comes from the settings (`stopAt`, repeats, gap). */
export interface PlayOptions {
  /** The last ayah to play (inclusive), as a reference (the wave-0 signature). */
  stopAt?: AyahRef
  /** The last ayah to play (inclusive), as an id. Without it (or `stopAt`) the play ends at the stop-at unit. */
  to?: number
  /** The unit the play ends with when no last ayah is given (default: the `stopAt` setting). */
  until?: StopAt
  ayahRepeat?: number
  rangeRepeat?: number
  gap?: GapSetting
  startPaused?: boolean
}

/** What Space plays when nothing is loaded and there is no resume candidate (§10.1): an ayah, or a range. */
export interface IdleTarget {
  from: number
  to?: number
}

/** The heard ayah (`ayah = 0`, `ayahId = 0` during the basmala before `surah`). */
export interface HeardRef {
  surah: number
  ayah: number
  ayahId: number
}

/** How the dock presents a failure (§9.8). */
export type PlayerErrorKind = 'offline' | 'output' | 'other'

export interface PlayerError {
  kind: PlayerErrorKind
  error: AppError
  /** The surah the failed play was for, when known. */
  surah: number | null
  reciterId: number | null
}

/** The A-B step `abMark()` took (for the announcement). */
export type AbStep = 'a' | 'b' | 'cleared' | 'short' | 'inactive'

/** A resume candidate is offered for this long after the position was written (§7.8). */
export const RESUME_MAX_AGE_S = 7 * 24 * 60 * 60
/** The interpolated position may run this far past the current ayah's end before the next tick (§7.3). */
export const AYAH_END_SLACK_MS = 250
/** Backward tick jitter (ms) the interpolation absorbs within one generation; larger jumps are real. */
export const BACKSTEP_TOLERANCE_MS = 120
/** The `audio` position is written this long after the last ayah change. */
export const POSITION_DEBOUNCE_MS = 1_000
/** The position step of the readouts (whole seconds), when no component asks for a finer one (`needPosition`). */
export const POSITION_STEP_MS = 1_000
/** Bounds of the wait (wall ms) between two samples of the position while playing. */
const SAMPLE_WAIT_MIN_MS = 4
const SAMPLE_WAIT_MAX_MS = 1_000
/** A-B loops shorter than this are rejected (§5.8). */
export const MIN_AB_MS = 300
/** Surahs of word timings kept in memory (a whole surah of a long one is thousands of words, §7.3). */
export const TIMINGS_CACHE = 12
/** Speed steps (§10.1): `]`/`[` ±5 %, `}`/`{` ±25 %, within 50–200 %. */
export const SPEED_STEP = 5
export const SPEED_STEP_LARGE = 25
export const SPEED_MIN = 50
export const SPEED_MAX = 200

/** What a command without data resolves with (`Result<(), AppError>`). */
type CommandResult = ReturnType<Api['audioPause']>

const LAYOUT_OF: Record<MushafStyle, MushafLayout> = { hafs: 'v2', qcf_v2: 'v2', qcf_v1: 'v1', qcf_v4: 'v4' }

/** Statuses in which a play is loaded (§2.3.6). */
export function isActiveStatus(status: PlaybackStatus | undefined): boolean {
  return status === 'loading' || status === 'playing' || status === 'paused' || status === 'buffering'
}

/**
 * §7.3: `clamp(tick.fileMs + (now − tickAt) × speedPct / 100, tick.fileMs, ayahEndMs + 250)`. The upper bound never
 * falls below the tick itself (a stale ayah end must not pull the position back).
 */
export function interpolate(tick: AudioTick, tickAt: number, now: number, ayahEndMs: number): number {
  const ahead = tick.fileMs + (Math.max(0, now - tickAt) * tick.speedPct) / 100
  const ceiling = Math.max(tick.fileMs, ayahEndMs + AYAH_END_SLACK_MS)
  return Math.min(ceiling, Math.max(tick.fileMs, ahead))
}

/** The word heard at `positionMs`: the last word (in time order) starting at or before it, else `null`. */
export function activeWordAt(words: readonly WordTiming[], positionMs: number): WordTiming | null {
  const i = floorIndex(words, positionMs, (w) => w.startMs)
  return i >= 0 ? (words[i] ?? null) : null
}

/** `r` (§10.1): off → ayah ×3 → ayah ∞ → off. A custom count moves on to ∞. */
export function nextAyahRepeat(ayahRepeat: number): number {
  if (ayahRepeat === 1) return 3
  if (ayahRepeat === 0) return 1
  return 0
}

/** Clamps a speed to 50–200 % on the 5 % grid. */
export function clampSpeed(pct: number): number {
  const stepped = Math.round(pct / SPEED_STEP) * SPEED_STEP
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, stepped))
}

/** An ayah's timings (`ayahs` is in ayah order, normally dense from 1). */
export function ayahTiming(timings: SurahTimings | null, ayah: number): AyahTiming | undefined {
  if (!timings || ayah < 1) return undefined
  const direct = timings.ayahs[ayah - 1]
  return direct?.ayah === ayah ? direct : timings.ayahs.find((a) => a.ayah === ayah)
}

/**
 * A speed as the dock shows it, in UI digits: 125 → "1.25×", 100 → "1×", 150 → "1.5×" (`١٫٢٥×` with Arabic-Indic
 * digits).
 */
export function formatSpeed(pct: number): string {
  return `${formatters(i18n.intlLocale).decimal.format(pct / 100)}×`
}

/**
 * A file time for the readout (§9.7: "01:23 / 07:12"): `mm:ss`, or `h:mm:ss` when `scaleMs` (the file's duration)
 * reaches an hour, so both halves of a readout share one shape. UI digits; render inside `direction: ltr`.
 */
export function formatClock(ms: number, scaleMs: number = ms): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0
  const { one, two } = formatters(i18n.intlLocale)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  if (scaleMs >= 3_600_000 || h > 0) return `${one.format(h)}:${two.format(m)}:${two.format(sec)}`
  return `${two.format(m)}:${two.format(sec)}`
}

interface Formatters {
  one: Intl.NumberFormat
  two: Intl.NumberFormat
  decimal: Intl.NumberFormat
}

/** Number formats per UI locale, built once: the readouts format the position every animation frame. */
const formatCache: Record<string, Formatters> = {}

function formatters(locale: string): Formatters {
  let f = formatCache[locale]
  if (!f) {
    f = {
      one: new Intl.NumberFormat(locale, { useGrouping: false }),
      two: new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false }),
      decimal: new Intl.NumberFormat(locale, { maximumFractionDigits: 2, useGrouping: false }),
    }
    formatCache[locale] = f
  }
  return f
}

/** Left-to-right isolate and its end (built from code points: the Svelte compiler flags literal bidi controls). */
const LRI = String.fromCharCode(0x2066)
const PDI = String.fromCharCode(0x2069)

/**
 * A file time inside a left-to-right isolate (LRI … PDI), for messages: with Arabic-Indic digits the separators between
 * two times would otherwise resolve right to left and swap them ("١٢:١٢ / ٠٠:٤٦", §11.3).
 */
export function isolatedClock(ms: number, scaleMs: number = ms): string {
  return LRI + formatClock(ms, scaleMs) + PDI
}

function timingsKey(reciterId: number, surah: number): string {
  return `${reciterId}:${surah}`
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000)
}

function errorKey(e: AppError): string {
  return `${e.kind}:${e.message}`
}

/** The engine reports a missing or failing output device as `audio` errors naming the device (WP4c deviation 6). */
function isOutputError(e: AppError): boolean {
  return e.kind === 'audio' && /output device|no audio output/i.test(e.message)
}

/** Words sorted by start time (the sanitizer already sorts them stably, §3.3; this keeps the store safe anyway). */
function byTime(timings: SurahTimings): SurahTimings {
  const sorted = timings.ayahs.every((a) =>
    a.words.every((w, i, ws) => i === 0 || (ws[i - 1]?.startMs ?? 0) <= w.startMs),
  )
  if (sorted) return timings
  return {
    ...timings,
    ayahs: timings.ayahs.map((a) => ({ ...a, words: [...a.words].sort((x, y) => x.startMs - y.startMs) })),
  }
}

class PlayerStore implements Store {
  snapshot = $state.raw<AudioSnapshot | null>(null)
  tick = $state.raw<AudioTick | null>(null)
  /** `performance.now()` when `tick` arrived. */
  tickAt = $state(0)
  /** The rAF-interpolated file position (ms). */
  positionMs = $state(0)
  /** Timings per `reciterId:surah` (bounded, see the header); `version` is bumped when it changes. */
  timings = new LRU<string, SurahTimings>(TIMINGS_CACHE)
  version = $state(0)
  reciters = $state.raw<ReciterInfo[]>([])
  /** The A point of an A-B loop being marked (file ms), until B is set. */
  abPending = $state<number | null>(null)
  /** Session mute: the engine's volume is 0 while the `volumePct` setting is kept. */
  muted = $state(false)
  /** The heard ayah, replaced only when it changes. */
  heard = $state.raw<HeardRef | null>(null)
  /** The recitation is in a gap between ayah plays (the highlight stays on the finished ayah, no word). */
  inGap = $state(false)
  /** The stored `audio` reading position (§7.8). */
  audioPosition = $state.raw<ReadingPosition | null>(null)
  /** The user dismissed the resume candidate (until the next position is written). */
  resumeDismissed = $state(false)
  /** A play whose command failed, with its request (Retry). */
  failure = $state.raw<{ error: AppError; request: PlayRequest } | null>(null)

  readonly status: PlaybackStatus = $derived(this.snapshot?.status ?? 'idle')
  readonly isPlaying = $derived(this.status === 'playing')
  readonly isActive = $derived(isActiveStatus(this.status))
  /** Playback is wanted (playing, starting or waiting for data): the transport shows Pause. */
  readonly wantsPlay = $derived(
    this.status === 'playing' || this.status === 'buffering' || this.status === 'loading',
  )
  readonly currentRef: AyahRef | null = $derived.by(() => {
    const h = this.heard
    return h ? this.#refOf(h) : null
  })
  /** The recited ayah; `null` during the basmala and when nothing plays. */
  readonly currentAyahId: number | null = $derived(
    this.heard && this.heard.ayah > 0 ? this.heard.ayahId : null,
  )
  readonly timingsForCurrent: SurahTimings | null = $derived.by(() => {
    void this.version
    const reciterId = this.snapshot?.reciterId
    const surah = this.heard?.surah
    if (reciterId == null || !surah) return null
    return this.timings.get(timingsKey(reciterId, surah)) ?? null
  })
  /** The current ayah's span in the file (timings, else the snapshot's). */
  readonly ayahSpan: { fromMs: number; toMs: number } | null = $derived.by(() => {
    const h = this.heard
    const s = this.snapshot
    if (!h || !s) return null
    const a = ayahTiming(this.timingsForCurrent, h.ayah)
    if (a) return { fromMs: a.fromMs, toMs: a.toMs }
    return { fromMs: s.ayahFromMs, toMs: s.ayahToMs }
  })
  readonly activeWord: ActiveWord | null = $derived.by(() => this.#cacheWord(this.#activeWord()))
  /** How far the current ayah has been recited (0–1). */
  readonly ayahProgress: number = $derived.by(() => {
    const span = this.ayahSpan
    if (!span || span.toMs <= span.fromMs) return 0
    return Math.min(1, Math.max(0, (this.positionMs - span.fromMs) / (span.toMs - span.fromMs)))
  })
  readonly resumeCandidate: ResumeCandidate | null = $derived.by(() => {
    const p = this.audioPosition
    if (!p || this.resumeDismissed || !quran.isAyahId(p.ayahId)) return null
    if (nowSecs() - p.updatedAt > RESUME_MAX_AGE_S) return null
    return { ayahId: p.ayahId, reciterId: settings.value.reciterId, updatedAt: p.updatedAt }
  })
  /** The failure the dock shows, if any (§9.8). */
  readonly error: PlayerError | null = $derived.by(() => {
    const f = this.failure
    if (f) return this.#describe(f.error, f.request.from.surah, f.request.reciterId)
    const s = this.snapshot
    if (s?.status !== 'error' || !s.error || errorKey(s.error) === this.#dismissedError) return null
    // Mid-way, the surah that failed (the range may start earlier); before the start, the range's first.
    const surah = s.current?.surah ?? s.range?.from.surah ?? this.#lastRequest?.from.surah ?? null
    return this.#describe(s.error, surah, s.reciterId ?? this.#lastRequest?.reciterId ?? null)
  })
  /** The reciter the dock shows: the playing one, else the setting. */
  readonly reciter: ReciterInfo | null = $derived.by(() => {
    const id = this.isActive
      ? (this.snapshot?.reciterId ?? settings.value.reciterId)
      : settings.value.reciterId
    return this.reciters.find((r) => r.id === id) ?? null
  })
  /** The engine's speed while a play is loaded, else the setting. */
  readonly speedPct: number = $derived(
    this.isActive ? (this.snapshot?.speedPct ?? settings.value.speedPct) : settings.value.speedPct,
  )

  #gen = 0
  #channel: Channel<AudioTick> | null = null
  #disposers: (() => void)[] = []
  #disposeEffects: (() => void) | null = null
  /** The position clock runs (playing in a visible document), and its next sample, if one is scheduled. */
  #clocked = false
  #clock: ReturnType<typeof setTimeout> | null = null
  /** The position steps the components showing the position asked for (`needPosition`). */
  #steps = new Set<{ stepMs: number }>()
  #visible = $state(true)
  #dismissedError = $state<string | null>(null)
  #lastRequest: PlayRequest | null = null
  /** The preview being played (`preview`), until it ends or another play replaces it. */
  #preview: PlayRequest | null = null
  #lastHeardAyahId = 0
  #lastGeneration = -1
  #word: ActiveWord | null = null
  #sentSpeed: number | null = null
  #sentVolume: number | null = null
  #basmalaNoted = false
  #positionTimer: ReturnType<typeof setTimeout> | null = null
  #pendingPosition: ReadingPosition | null = null
  /** The last `position_set` on its way (a quit waits for it). */
  #positionWrite: Promise<void> | null = null
  #recitersTimer: ReturnType<typeof setTimeout> | null = null
  #timingLoads = new Map<string, Promise<SurahTimings | null>>()

  async init(b: Bootstrap): Promise<void> {
    this.#dispose()
    const gen = ++this.#gen
    this.reciters = b.reciters
    this.audioPosition = b.positions.find((p) => p.context === 'audio') ?? null
    this.#sentSpeed = b.audio.speedPct
    this.#sentVolume = b.audio.volumePct
    this.#visible = typeof document === 'undefined' || document.visibilityState !== 'hidden'
    this.#onState(b.audio)

    this.#disposers.push(
      listenEvent(events.audioStateChanged, (s) => {
        if (gen === this.#gen) this.#onState(s)
      }),
      listenEvent(events.audioAyahChanged, (c) => {
        if (gen === this.#gen) this.#onAyah(c)
      }),
      listenEvent(events.packsChanged, ({ packIds }) => {
        if (gen === this.#gen && packIds.some((id) => id.startsWith('audio.'))) this.#refreshRecitersSoon()
      }),
      // A restored library brings its own positions (`user_backup_restore` is the only command that reports them).
      listenEvent(events.userDataChanged, ({ kinds }) => {
        if (gen === this.#gen && kinds.includes('positions')) void this.#reloadPosition(gen)
      }),
      app.beforeQuit(() => this.#beforeQuit()),
    )
    const onVisibility = () => (this.#visible = document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onVisibility)
    this.#disposers.push(() => document.removeEventListener('visibilitychange', onVisibility))

    this.#disposeEffects = $effect.root(() => {
      // Interpolate while playing in a visible document (§7.3), sampling when the UI would show a change.
      $effect(() => {
        const animate = this.isPlaying && this.#visible
        untrack(() => (animate ? this.#startLoop() : this.#stopLoop()))
      })
      // Timings of the heard surah (scrubber ticks, word highlight), else of the loading play's first surah.
      $effect(() => {
        const reciterId = this.snapshot?.reciterId ?? null
        const surah = this.heard?.surah ?? this.snapshot?.range?.from.surah ?? null
        if (reciterId === null || surah === null || surah === 0) return
        untrack(() => void this.ensureTimings(reciterId, surah))
      })
      // Speed and volume settings reach the engine (also when changed outside the dock).
      $effect(() => {
        const speed = settings.value.speedPct
        untrack(() => this.#sendSpeed(speed))
      })
      $effect(() => {
        const volume = this.muted ? 0 : settings.value.volumePct
        untrack(() => this.#sendVolume(volume))
      })
      // Back online (the connection, or network use allowed again): an "Offline — not downloaded" failure no longer
      // holds, so the dock stops offering "Download when online" (Play now streams it).
      $effect(() => {
        const online = app.online && settings.value.networkAllowed
        untrack(() => {
          if (online && this.error?.kind === 'offline') this.dismissError()
        })
      })
    })

    try {
      const channel = new Channel<AudioTick>()
      channel.onmessage = (t) => {
        if (gen === this.#gen) this.#onTick(t)
      }
      this.#channel = channel
      const snapshot = await call(api.audioSubscribe(channel))
      if (gen === this.#gen) this.#onState(snapshot)
    } catch (e) {
      console.warn('[qd] player: audio ticks unavailable', e)
    }
  }

  // --- playing ------------------------------------------------------------------------------------------------------

  /** Plays from an ayah to `opts.to`, else to the stop-at setting (or `opts.stopAt`). */
  async playFrom(target: PlayTarget, opts: PlayOptions = {}): Promise<void> {
    const from = quran.ayahRef(target.ayahId)
    if (from.surah === 0) return
    const lastId = opts.to ?? (opts.stopAt ? quran.ayahId(opts.stopAt.surah, opts.stopAt.ayah) : 0)
    const toRef = lastId > 0 ? quran.ayahRef(Math.max(lastId, target.ayahId)) : null
    const s = settings.value
    await this.#play({
      reciterId: s.reciterId,
      from,
      to: toRef && toRef.surah > 0 ? toRef : null,
      stopAt: opts.until ?? null,
      layout: LAYOUT_OF[s.mushafStyle],
      ayahRepeat: opts.ayahRepeat ?? s.ayahRepeat,
      rangeRepeat: opts.rangeRepeat ?? s.rangeRepeat,
      gap: opts.gap ?? s.gap,
      startPaused: opts.startPaused ?? false,
    })
  }

  /** Plays an ayah range (ids, either order), with optional repeats and gap for this play only. */
  async playRange(
    from: number,
    to: number,
    opts: { ayahRepeat?: number; rangeRepeat?: number; gap?: GapSetting } = {},
  ): Promise<void> {
    await this.playFrom({ ayahId: Math.min(from, to) }, { ...opts, to: Math.max(from, to) })
  }

  /**
   * Plays a reciter's preview of one ayah (the onboarding's ▶ 1:1, §9.7) from the start, alone. It is no part of the
   * user's listening: no position is written, the resume candidate and the dock's error state are left alone, and it is
   * never the play Space repeats. Rejects when the command fails (the caller reports it).
   */
  async preview(reciterId: number, ayah: AyahRef): Promise<void> {
    const request: PlayRequest = {
      reciterId,
      from: ayah,
      to: ayah,
      stopAt: null,
      layout: LAYOUT_OF[settings.value.mushafStyle],
      ayahRepeat: 1,
      rangeRepeat: 1,
      gap: { type: 'none' },
      startPaused: false,
      // No listen history, and never the recitation a media key's "play with nothing loaded" replays (§2.8.4).
      record: false,
    }
    this.#preview = request
    const before = this.snapshot
    try {
      const s = await call(api.audioPlay(request))
      if (this.snapshot === before) this.#onState(s)
    } catch (e) {
      if (this.#preview === request) this.#preview = null
      throw e
    }
  }

  /** Stops the preview, if one is loaded or starting (rejects when the command fails). */
  async stopPreview(): Promise<void> {
    if (this.#preview === null) return
    await call(api.audioStop())
  }

  /** A preview (`preview`) is loaded or starting. */
  get previewing(): boolean {
    return this.#preview !== null
  }

  /**
   * The engine's play failed mid-way: it keeps the ayah heard (`current`), and `audio_resume` continues it from there
   * (the media keys and the tray do the same). A failure before the start has no `current`.
   */
  get #failedMidway(): boolean {
    const s = this.snapshot
    return this.failure === null && s?.status === 'error' && s.current !== null
  }

  /** Paused, or failed mid-way: continue. Idle: play from the start of the resume candidate's ayah (§7.8). */
  async resume(): Promise<void> {
    if (this.status === 'paused' || this.#failedMidway) return this.#command(api.audioResume())
    const candidate = this.resumeCandidate
    if (!this.isActive && candidate) await this.playFrom({ ayahId: candidate.ayahId })
  }

  /**
   * Play/pause (`Space`, §10.1). When nothing is loaded: the resume candidate, else `idleTarget` (the dock and the
   * shortcut pass the selection or the first ayah of the visible page), else the last play again.
   */
  async toggle(idleTarget?: IdleTarget | null): Promise<void> {
    switch (this.status) {
      case 'playing':
      case 'buffering':
      case 'paused':
        return this.#command(api.audioToggle())
      case 'loading':
        return this.#command(api.audioPause())
      case 'error':
        if (this.#failedMidway) return this.#command(api.audioResume())
    }
    if (this.resumeCandidate) return this.resume()
    if (idleTarget) {
      return idleTarget.to !== undefined && idleTarget.to !== idleTarget.from
        ? this.playRange(idleTarget.from, idleTarget.to)
        : this.playFrom({ ayahId: idleTarget.from })
    }
    if (this.#lastRequest) await this.#play(this.#lastRequest)
  }

  async pause(): Promise<void> {
    if (this.isActive) await this.#command(api.audioPause())
  }

  async stop(): Promise<void> {
    if (this.isActive || this.status === 'error') await this.#command(api.audioStop())
    this.failure = null
  }

  /**
   * Next ayah (`.`). At the last one it does what the range's end would do (WP4c deviation 11): the next pass while
   * range repeats remain, else the play stops.
   */
  async next(): Promise<void> {
    if (this.isActive) await this.#command(api.audioSkip('next'))
  }

  /** Previous ayah (`,`): within 1.5 s of an ayah's start the previous one, else the start of this one. */
  async prev(): Promise<void> {
    if (this.isActive) await this.#command(api.audioSkip('previous'))
  }

  /** Jumps to an ayah of the playing range; with nothing loaded, plays from it. */
  async seekAyah(ayahId: number): Promise<void> {
    if (!quran.isAyahId(ayahId)) return
    if (!this.isActive) return this.playFrom({ ayahId })
    await this.#command(api.audioSeek({ type: 'ayah', data: { ayahId } }))
  }

  /** Seeks the file timeline. */
  async seekMs(ms: number): Promise<void> {
    if (!this.isActive) return
    const target = Math.max(0, Math.round(ms))
    this.positionMs = target
    await this.#command(api.audioSeek({ type: 'file_ms', data: { ms: target } }))
  }

  /** Seeks relative to the audible position (`>`/`<` ±5 s). */
  async nudge(deltaMs: number): Promise<void> {
    if (!this.isActive) return
    await this.#command(api.audioSeek({ type: 'relative_ms', data: { deltaMs: Math.round(deltaMs) } }))
  }

  /**
   * The dock's Retry: a play that failed mid-way continues from where it stopped (as Play does); otherwise the failed
   * play is sent again.
   */
  async retry(): Promise<void> {
    if (this.#failedMidway) return this.#command(api.audioResume())
    const request = this.failure?.request ?? this.#lastRequest
    if (request) await this.#play(request)
  }

  /** Hides the current failure. */
  dismissError(): void {
    this.failure = null
    const e = this.snapshot?.error
    if (this.snapshot?.status === 'error' && e) this.#dismissedError = errorKey(e)
  }

  /** Forgets the resume candidate for now (the idle pill's ×); the next position written brings one back. */
  dismissResume(): void {
    this.resumeDismissed = true
  }

  // --- speed, volume, repeats ----------------------------------------------------------------------------------------

  /** Sets the speed setting (50–200 %, step 5); the engine follows at once. */
  async setSpeed(pct: number): Promise<void> {
    const next = clampSpeed(pct)
    if (next !== settings.value.speedPct) await settings.update({ speedPct: next })
  }

  /** `]`/`[` (±5 %) and `}`/`{` (±25 %). Returns the new speed. */
  async speedStep(direction: 1 | -1, large = false): Promise<number> {
    const next = clampSpeed(settings.value.speedPct + direction * (large ? SPEED_STEP_LARGE : SPEED_STEP))
    await this.setSpeed(next)
    return next
  }

  /** Sets the volume setting (0–100) and unmutes. */
  async setVolume(pct: number): Promise<void> {
    const next = Math.min(100, Math.max(0, Math.round(pct)))
    this.muted = false
    if (next !== settings.value.volumePct) await settings.update({ volumePct: next })
  }

  /** `m`: mutes or unmutes for this session. */
  async toggleMute(): Promise<void> {
    this.muted = !this.muted
  }

  /** The repeat settings, applied to the current play too. */
  async setRepeat(ayahRepeat: number, rangeRepeat: number): Promise<void> {
    const a = Math.min(99, Math.max(0, Math.round(ayahRepeat)))
    const r = Math.min(99, Math.max(0, Math.round(rangeRepeat)))
    const s = settings.value
    if (s.ayahRepeat !== a || s.rangeRepeat !== r) void settings.update({ ayahRepeat: a, rangeRepeat: r })
    if (this.isActive) await this.#command(api.audioSetRepeat(a, r))
  }

  /** `r` (§10.1): off → ayah ×3 → ayah ∞ → off. Returns the new ayah repeat (1 = off, 0 = ∞). */
  async cycleRepeat(): Promise<number> {
    const source = this.isActive && this.snapshot ? this.snapshot : settings.value
    const next = nextAyahRepeat(source.ayahRepeat)
    await this.setRepeat(next, source.rangeRepeat)
    return next
  }

  /** The gap setting, applied to the current play too. */
  async setGap(gap: GapSetting): Promise<void> {
    void settings.update({ gap })
    if (this.isActive) await this.#command(api.audioSetGap(gap))
  }

  /** `l` (§10.1): set A → set B → clear, on the file timeline. */
  async abMark(): Promise<AbStep> {
    if (!this.isActive) {
      this.abPending = null
      return 'inactive'
    }
    if (this.snapshot?.abLoop) {
      this.abPending = null
      await this.#command(api.audioSetAbLoop(null))
      return 'cleared'
    }
    const here = Math.round(this.positionMs)
    if (this.abPending === null) {
      this.abPending = here
      return 'a'
    }
    const aMs = Math.min(this.abPending, here)
    const bMs = Math.max(this.abPending, here)
    if (bMs - aMs < MIN_AB_MS) return 'short'
    this.abPending = null
    await this.#command(api.audioSetAbLoop({ aMs, bMs }))
    return 'b'
  }

  /** Clears an A-B loop or a pending A. */
  async clearAb(): Promise<void> {
    this.abPending = null
    if (this.snapshot?.abLoop) await this.#command(api.audioSetAbLoop(null))
  }

  /**
   * Chooses the reciter (persisted in settings; the palette and the picker call this). A loaded play continues with the
   * new reciter from the ayah being heard, keeping its range, repeats, gap and paused state.
   */
  async setReciter(reciterId: number): Promise<void> {
    if (reciterId === settings.value.reciterId && (!this.isActive || this.snapshot?.reciterId === reciterId))
      return
    void settings.update({ reciterId })
    const s = this.snapshot
    if (!s || !this.isActive || !s.range) return
    const h = this.heard
    const fromId = h && h.ayah > 0 ? h.ayahId : quran.ayahId(s.range.from.surah, s.range.from.ayah)
    const toId = quran.ayahId(s.range.to.surah, s.range.to.ayah)
    if (fromId === 0 || toId === 0) return
    await this.playFrom(
      { ayahId: fromId },
      {
        to: Math.max(fromId, toId),
        ayahRepeat: s.ayahRepeat,
        rangeRepeat: s.rangeRepeat,
        gap: s.gap,
        startPaused: s.status === 'paused',
      },
    )
  }

  /** Loaded timings of a surah (reactive: re-read when timings load), or `null`. Use `ensureTimings` to load them. */
  timingsFor(reciterId: number, surah: number): SurahTimings | null {
    void this.version
    return this.timings.get(timingsKey(reciterId, surah)) ?? null
  }

  /**
   * Caches a surah's timings, dropping the least recently used beyond {@link TIMINGS_CACHE}, except those the loaded
   * play needs (its reciter's heard surah and every surah of its range), which go back in as the most recent.
   */
  #cacheTimings(key: string, timings: SurahTimings): void {
    const keep = this.#neededTimings()
    // Fewer are kept than the cache holds, so putting them back ends with the oldest others out.
    const evicted = this.timings.set(key, timings)
    for (let e = evicted.shift(); e !== undefined; e = evicted.shift()) {
      if (keep.includes(e[0])) evicted.push(...this.timings.set(e[0], e[1]))
    }
  }

  /**
   * The `reciterId:surah` keys the loaded play needs (none when nothing is loaded): the heard surah and the next one,
   * and every surah of a range short enough to keep whole (a juz or the whole Quran is played surah by surah).
   */
  #neededTimings(): string[] {
    const keys: string[] = []
    const s = untrack(() => this.snapshot)
    if (!s || !isActiveStatus(s.status) || s.reciterId === null) return keys
    const reciterId = s.reciterId
    const heard = untrack(() => this.heard)?.surah || s.range?.from.surah || 0
    if (heard > 0) {
      keys.push(timingsKey(reciterId, heard))
      if (s.range && heard < s.range.to.surah) keys.push(timingsKey(reciterId, heard + 1))
    }
    if (s.range && s.range.to.surah - s.range.from.surah < TIMINGS_CACHE / 2) {
      for (let n = s.range.from.surah; n <= s.range.to.surah; n++) keys.push(timingsKey(reciterId, n))
    }
    return keys
  }

  /** The timings of a surah (cached; loads once, `null` when unavailable, e.g. offline). */
  async ensureTimings(reciterId: number, surah: number): Promise<SurahTimings | null> {
    const key = timingsKey(reciterId, surah)
    const cached = this.timings.get(key)
    if (cached) return cached
    let load = this.#timingLoads.get(key)
    if (!load) {
      const gen = this.#gen
      load = call(api.audioGetTimings(reciterId, surah)).then(
        (t) => {
          this.#timingLoads.delete(key)
          if (gen !== this.#gen) return null
          const timings = byTime(t)
          this.#cacheTimings(key, timings)
          this.version++
          return timings
        },
        (e: unknown) => {
          this.#timingLoads.delete(key)
          console.debug(`[qd] player: no timings for ${key}`, e)
          return null
        },
      )
      this.#timingLoads.set(key, load)
    }
    return load
  }

  /** Reloads the reciters (downloaded and cached counts change with downloads and streaming). */
  async refreshReciters(): Promise<void> {
    try {
      const list = await call(api.audioListReciters())
      this.reciters = list
    } catch (e) {
      console.warn('[qd] player: reciters unavailable', e)
    }
  }

  /**
   * A component that shows the position while playing asks for it every `stepMs` of file time (the scrubber: one device
   * pixel of its track). The finest request sets how often `positionMs` moves between ticks. Returns the function that
   * withdraws the request (an effect's cleanup).
   */
  needPosition(stepMs: number): () => void {
    const request = { stepMs: Number.isFinite(stepMs) && stepMs > 0 ? stepMs : POSITION_STEP_MS }
    this.#steps.add(request)
    return () => void this.#steps.delete(request)
  }

  /** Samples the interpolated position at `now` (`performance.now()`): at each tick and when the clock is due. */
  sample(now: number): void {
    const t = this.tick
    if (!t) return
    if (t.status !== 'playing' || t.inGap) {
      this.#setPosition(t.fileMs)
      return
    }
    const span = this.ayahSpan
    let pos = interpolate(t, this.tickAt, now, span ? span.toMs : (this.snapshot?.ayahToMs ?? t.fileMs))
    if (
      t.generation === this.#lastGeneration &&
      pos < this.positionMs &&
      this.positionMs - pos < BACKSTEP_TOLERANCE_MS
    ) {
      pos = this.positionMs
    }
    this.#lastGeneration = t.generation
    this.#setPosition(pos)
  }

  reset(): void {
    this.#dispose()
    this.#gen++
    this.snapshot = null
    this.tick = null
    this.tickAt = 0
    this.positionMs = 0
    this.timings.clear()
    this.version = 0
    this.reciters = []
    this.abPending = null
    this.muted = false
    this.heard = null
    this.inGap = false
    this.audioPosition = null
    this.resumeDismissed = false
    this.failure = null
    this.#dismissedError = null
    this.#lastRequest = null
    this.#preview = null
    this.#lastHeardAyahId = 0
    this.#lastGeneration = -1
    this.#word = null
    this.#sentSpeed = null
    this.#sentVolume = null
    this.#basmalaNoted = false
    this.#pendingPosition = null
    this.#timingLoads.clear()
  }

  // --- internals ----------------------------------------------------------------------------------------------------

  async #play(request: PlayRequest): Promise<void> {
    this.failure = null
    this.#dismissedError = null
    this.abPending = null
    this.#basmalaNoted = false
    this.#lastRequest = request
    this.#preview = null
    const before = this.snapshot
    try {
      const s = await call(api.audioPlay(request))
      // An event may already have moved past the `loading` answer (events and replies are not ordered).
      if (this.snapshot === before) this.#onState(s)
    } catch (e) {
      this.failure = { error: toAppError(e), request }
      ui.pokeDock()
    }
  }

  async #command(p: CommandResult): Promise<void> {
    try {
      await call(p)
    } catch (e) {
      ui.toastError(e)
    }
  }

  #describe(error: AppError, surah: number | null, reciterId: number | null): PlayerError {
    const kind: PlayerErrorKind =
      error.kind === 'offline' ? 'offline' : isOutputError(error) ? 'output' : 'other'
    return { kind, error, surah, reciterId }
  }

  #refOf(h: HeardRef): AyahRef {
    return { surah: h.surah, ayah: h.ayah }
  }

  #setHeard(surah: number, ayah: number, ayahId: number): void {
    const h = this.heard
    if (h && h.surah === surah && h.ayah === ayah && h.ayahId === ayahId) return
    this.heard = { surah, ayah, ayahId }
  }

  #setPosition(ms: number): void {
    if (ms !== this.positionMs) this.positionMs = ms
  }

  #onState(s: AudioSnapshot): void {
    const prev = this.snapshot
    // Another play replaced the preview (a media key, the tray): from now on it is the user's listening again.
    if (this.#preview !== null && isActiveStatus(s.status) && !this.#isPreview(s)) this.#preview = null
    const preview = this.#preview !== null
    this.snapshot = s
    // A new play (from the dock, the tray or a media key) may note its skipped basmala once more.
    if (s.status === 'loading' && prev?.status !== 'loading') this.#basmalaNoted = false
    if (isActiveStatus(s.status)) {
      if (s.current) this.#setHeard(s.current.surah, s.current.ayah, s.currentAyahId ?? 0)
      else this.heard = null
      if (s.basmalaSkipped && !this.#basmalaNoted) {
        this.#basmalaNoted = true
        ui.toast({ message: i18n.t('player.notes.basmalaSkipped') })
      }
    } else {
      this.heard = null
      this.inGap = false
      this.tick = null
      this.abPending = null
    }
    if (!this.isPlaying) this.#setPosition(s.fileMs)
    if (s.status === 'error') {
      // A preview's failure is its caller's to report: the dock keeps its own state.
      if (preview && s.error) this.#dismissedError = errorKey(s.error)
      else ui.pokeDock()
    }
    if (s.status !== 'error') this.#dismissedError = null

    // The preview's end (or stop) is not a listening position, and the preview is over. (Before it started, an idle
    // snapshot, such as the command's answer racing the events, says nothing about it.)
    if (preview && !isActiveStatus(s.status)) {
      if (prev && isActiveStatus(prev.status)) this.#preview = null
      return
    }
    // A stop keeps the ayah heard last; a natural end (range kept) moves the resume point past the range (§7.8).
    if (prev && isActiveStatus(prev.status) && s.status === 'idle') {
      if (s.range) {
        const last = quran.ayahId(s.range.to.surah, s.range.to.ayah)
        if (last > 0 && last < quran.ayahCount) this.#writePosition(last + 1, true)
        else this.resumeDismissed = true
      } else if (this.#lastHeardAyahId > 0) {
        this.#writePosition(this.#lastHeardAyahId, true)
      }
    }
  }

  #onTick(t: AudioTick): void {
    this.tick = t
    this.tickAt = performance.now()
    if (isActiveStatus(t.status) && t.surah > 0) this.#setHeard(t.surah, t.ayah, t.ayahId)
    if (this.inGap !== t.inGap) this.inGap = t.inGap
    if (this.#clocked) this.#sampleNow()
    else this.sample(this.tickAt)
  }

  #onAyah(c: AyahChange): void {
    if (c.ayah < 1 || c.ayahId < 1 || this.#preview !== null) return
    this.#lastHeardAyahId = c.ayahId
    this.#writePosition(c.ayahId, false)
    if (settings.value.announceRecitation) ui.announce(quran.refLabel(c.ayahId, 'long'))
  }

  /** Whether a snapshot shows the preview's play (its reciter and ayah; the range is unknown while loading). */
  #isPreview(s: AudioSnapshot): boolean {
    const p = this.#preview
    if (p === null || s.reciterId !== p.reciterId) return false
    if (!s.range) return true
    const same = (a: AyahRef, b: AyahRef) => a.surah === b.surah && a.ayah === b.ayah
    return same(s.range.from, p.from) && (p.to === null || same(s.range.to, p.to))
  }

  /** Reads the stored `audio` position again (after a restore replaced the library); the candidate follows it. */
  async #reloadPosition(gen: number): Promise<void> {
    const positions = await history.reloadPositions()
    if (gen !== this.#gen || positions === null) return
    if (this.#positionTimer !== null) clearTimeout(this.#positionTimer)
    this.#positionTimer = null
    this.#pendingPosition = null
    this.audioPosition = positions.find((p) => p.context === 'audio') ?? null
    this.resumeDismissed = false
  }

  /** Records the `audio` position (§7.8): at once in the store, to Rust after a pause in the changes (or now). */
  #writePosition(ayahId: number, now: boolean): void {
    const layout = LAYOUT_OF[settings.value.mushafStyle]
    const position: ReadingPosition = {
      context: 'audio',
      layout,
      page: quran.pageOfAyah(layout, ayahId),
      ayahId,
      scrollPx: null,
      updatedAt: nowSecs(),
    }
    this.audioPosition = position
    this.resumeDismissed = false
    this.#pendingPosition = position
    if (this.#positionTimer !== null) clearTimeout(this.#positionTimer)
    this.#positionTimer = setTimeout(() => this.#flushPosition(), now ? 0 : POSITION_DEBOUNCE_MS)
  }

  #flushPosition(): void {
    if (this.#positionTimer !== null) clearTimeout(this.#positionTimer)
    this.#positionTimer = null
    const position = this.#pendingPosition
    this.#pendingPosition = null
    if (!position) return
    const write = call(api.positionSet(position)).then(
      () => {},
      (e: unknown) => console.warn('[qd] player: position not saved', e),
    )
    this.#positionWrite = write
    void write.finally(() => {
      if (this.#positionWrite === write) this.#positionWrite = null
    })
  }

  /**
   * Before the app exits (`app.beforeQuit`): the `audio` position still waiting for its debounce is written now, and the
   * exit waits for it (and for one already on its way), so "Resume" offers the ayah that was playing.
   */
  #beforeQuit(): Promise<void> | null {
    this.#flushPosition()
    return this.#positionWrite
  }

  #sendSpeed(pct: number): void {
    if (pct === this.#sentSpeed) return
    this.#sentSpeed = pct
    call(api.audioSetSpeed(pct)).catch((e: unknown) => {
      this.#sentSpeed = null
      ui.toastError(e)
    })
  }

  #sendVolume(pct: number): void {
    if (pct === this.#sentVolume) return
    this.#sentVolume = pct
    call(api.audioSetVolume(pct)).catch((e: unknown) => {
      this.#sentVolume = null
      ui.toastError(e)
    })
  }

  #refreshRecitersSoon(): void {
    if (this.#recitersTimer !== null) clearTimeout(this.#recitersTimer)
    this.#recitersTimer = setTimeout(() => {
      this.#recitersTimer = null
      void this.refreshReciters()
    }, 300)
  }

  #activeWord(): ActiveWord | null {
    const h = this.heard
    if (!h || h.ayah === 0 || h.ayahId === 0 || this.inGap || !this.isActive) return null
    const ayah = ayahTiming(this.timingsForCurrent, h.ayah)
    const tick = this.tick
    // Without timings (not loaded yet, or offline) the engine's own word (`wordPos`) still drives the highlight.
    const pos = ayah
      ? (activeWordAt(ayah.words, this.positionMs)?.pos ?? 0)
      : tick && tick.ayahId === h.ayahId
        ? tick.wordPos
        : 0
    if (pos < 1) return null
    const first = quran.firstWordOf(h.ayahId)
    if (first === 0) return null
    return { ayahId: h.ayahId, wordId: first + pos - 1, pos }
  }

  #cacheWord(next: ActiveWord | null): ActiveWord | null {
    const prev = this.#word
    if (prev === next) return prev
    if (prev && next && prev.ayahId === next.ayahId && prev.wordId === next.wordId && prev.pos === next.pos)
      return prev
    this.#word = next
    return next
  }

  #startLoop(): void {
    if (this.#clocked) return
    this.#clocked = true
    this.#sampleNow()
  }

  /** Samples the position now, then waits until it next shows a change (a tick may come first and do the same). */
  #sampleNow = (): void => {
    if (this.#clock !== null) clearTimeout(this.#clock)
    this.#clock = null
    if (!this.#clocked) return
    this.sample(performance.now())
    this.#clock = setTimeout(this.#sampleNow, this.#nextChangeIn())
  }

  /** Wall time (ms) until the position next shows a change: the next word's start, or the next step boundary. */
  #nextChangeIn(): number {
    const t = this.tick
    if (!t || t.status !== 'playing' || t.inGap) return SAMPLE_WAIT_MAX_MS
    const pos = this.positionMs
    let step = POSITION_STEP_MS
    for (const r of this.#steps) step = Math.min(step, r.stepMs)
    let next = (Math.floor(pos / step) + 1) * step
    const h = this.heard
    const words = h && h.ayah > 0 ? ayahTiming(this.timingsForCurrent, h.ayah)?.words : undefined
    if (words) {
      const after = words[floorIndex(words, pos, (w) => w.startMs) + 1]
      if (after && after.startMs > pos) next = Math.min(next, after.startMs)
    }
    const wall = ((next - pos) * 100) / Math.max(1, t.speedPct)
    return Math.min(SAMPLE_WAIT_MAX_MS, Math.max(SAMPLE_WAIT_MIN_MS, Math.ceil(wall)))
  }

  #stopLoop(): void {
    this.#clocked = false
    if (this.#clock !== null) clearTimeout(this.#clock)
    this.#clock = null
    const t = this.tick
    if (t) this.#setPosition(t.status === 'playing' ? this.positionMs : t.fileMs)
  }

  #dispose(): void {
    for (const d of this.#disposers.splice(0)) d()
    this.#disposeEffects?.()
    this.#disposeEffects = null
    this.#stopLoop()
    if (this.#channel) this.#channel.onmessage = () => {}
    this.#channel = null
    if (this.#positionTimer !== null) clearTimeout(this.#positionTimer)
    this.#positionTimer = null
    this.#positionWrite = null
    if (this.#recitersTimer !== null) clearTimeout(this.#recitersTimer)
    this.#recitersTimer = null
  }
}

export const player = new PlayerStore()

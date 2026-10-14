/**
 * `memo` store: hide mode, peeking, random-start self-tests, memorisation progress and loop presets. Layer L2: imports
 * `reader` and `player` (and lower layers), never the other way round.
 *
 * **Hide mode** (`active.mode = 'hide'`). Every word of `[from, to]` is hidden except the ayah-end markers, which stay
 * visible as anchors (the ayah number is not something to recite). `revealedThrough` is the last revealed word id: `W`
 * reveals the next word, `Shift+W` the rest of the next ayah, holding `Q` peeks at everything (`peeking`). The renderer
 * applies the class map `.w-hid` from `isHidden(id)` (`GlyphLayer`, one effect per rendition): the check
 * reads `active`, `revealedThrough` and `peeking`, so the class map follows each of them, and costs O(1) per word.
 * Revealing onto a page that is not on screen turns the page.
 *
 * **Self-test** (`active.mode = 'test'`, `test` set). `memo_test_start` picks a random start ayah in the range; the reader
 * jumps there and everything from it to `to` is hidden. The reciter asks for words (`W`, counted as reveals) and counts
 * slips (`M`, mistakes). Finishing rates the recited span `[start, to]` (1 again … 4 easy): `memo_test_finish` records
 * the test and `memo_review` reschedules the span with the Leitner table.
 *
 * **Progress** is a sparse `Map<ayahId, MemoProgress>` of the ranges loaded so far (`loadProgress`, `loadAll`): an ayah
 * without an entry is `new`. Mutations merge the rows they return; `user-data-changed` (`memo`) re-reads the loaded
 * span, so another surface's change (the context menu, the index) shows up everywhere. `clock` (Unix seconds, ticking
 * each half minute) keeps "due" current without re-reading.
 *
 * **Presets** are the `loop_preset_*` rows (range, repeats, gap, speed, reciter), shared with the dock's repeat popover.
 * `applyPreset` plays one.
 *
 * The store also mirrors the session onto `<html>` for `styles/mushaf/memo.css`: `data-memo` (`hide`|`test`),
 * `data-memo-style` (`blur`|`blank`, the `memoHideStyle` setting) and `data-memo-hover` (`memoRevealOnHover`). The
 * blank style draws each hidden word as a short rule through an SVG filter that it installs while needed (opacity alone
 * would also hide the rule; `color: transparent` does not hide COLR glyphs).
 *
 * Mutations never reject: failures are shown with `ui.toastError` and resolve `false`/`null`; `startTest` and
 * `finishTest` resolve whether they succeeded, so the self-test dialog can stay open on a failure.
 */
import type { Store } from '$lib/contracts/stores'
import { api, call, events } from '$lib/ipc'
import type {
  Bootstrap,
  LoopPreset,
  LoopPresetInput,
  MemoProgress,
  MemoStatus,
  MemoTest,
  UserDataKind,
} from '$lib/ipc/bindings'
import { installMemoKeys, memorizeShortcuts } from '$lib/shortcuts/memorize'
import { listenEvent } from './app.svelte'
import { history } from './history.svelte'
import { i18n } from './i18n.svelte'
import { player } from './player.svelte'
import { quran } from './quran.svelte'
import { reader } from './reader.svelte'
import { settings } from './settings.svelte'
import { shortcuts } from './shortcuts.svelte'
import { ui } from './ui.svelte'

export type MemoMode = 'hide' | 'test'

export interface MemoSession {
  from: number
  to: number
  mode: MemoMode
}

/** A self-test answer: 1 again, 2 hard, 3 good, 4 easy. */
export type Rating = 1 | 2 | 3 | 4
export const RATINGS: readonly Rating[] = [1, 2, 3, 4]
export const RATING_NAMES: Readonly<Record<Rating, 'again' | 'hard' | 'good' | 'easy'>> = {
  1: 'again',
  2: 'hard',
  3: 'good',
  4: 'easy',
}

/** An inclusive ayah-id range. */
export interface AyahSpan {
  from: number
  to: number
}

/** Word ids run 1..=83,665 in (surah, ayah, position) order, end markers included. */
export const QURAN_WORDS = 83_665
/** Strengths of the schedule: 0..=5, memorised from 4. */
export const MAX_STRENGTH = 5
export const MEMORIZED_STRENGTH = 4
/** "Again" brings the ayahs back after 10 minutes. */
export const AGAIN_S = 10 * 60
export const DAY_S = 24 * 60 * 60
/** A hide session shorter than this is not worth a history entry. */
export const HISTORY_MIN_S = 30
/** `clock` ticks this often (ms). */
const CLOCK_MS = 30_000
/** Changes from elsewhere are re-read after this quiet period (ms). */
const RELOAD_DEBOUNCE_MS = 150

/** The id of the SVG filter that draws a hidden word as a rule in the blank style (memo.css). */
export const BLANK_FILTER_ID = 'qd-memo-blank'
const SVG_NS = 'http://www.w3.org/2000/svg'

/** The schedule after one review at `strength`: the new strength and the interval until the next one. */
export function schedule(strength: number, rating: Rating): { strength: number; intervalS: number } {
  const s = Math.min(MAX_STRENGTH, Math.max(0, Math.floor(strength)))
  switch (rating) {
    case 1:
      return { strength: Math.max(s - 2, 0), intervalS: AGAIN_S }
    case 2:
      return { strength: Math.max(s, 1), intervalS: DAY_S }
    case 3:
      return { strength: Math.min(s + 1, MAX_STRENGTH), intervalS: 2 ** s * DAY_S }
    case 4:
      return { strength: Math.min(s + 2, MAX_STRENGTH), intervalS: 2 ** (s + 1) * DAY_S }
  }
}

export function isRating(n: number): n is Rating {
  return n === 1 || n === 2 || n === 3 || n === 4
}

/**
 * The answer a self-test suggests from its hints and mistakes over the recited words: none → easy; up to 3 % of the
 * words (at least one) → good; up to 15 % (at least three) → hard; more → again. The reciter always decides.
 */
export function suggestRating(hints: number, mistakes: number, words: number): Rating {
  const slips = Math.max(0, hints) + Math.max(0, mistakes)
  const n = Math.max(0, words)
  if (slips === 0) return 4
  if (slips <= Math.max(1, Math.round(n * 0.03))) return 3
  if (slips <= Math.max(3, Math.round(n * 0.15))) return 2
  return 1
}

/** The status a reader sees: a memorised ayah whose review is overdue is `review`; no entry is `new`. */
export function effectiveStatus(p: MemoProgress | undefined, nowS: number): MemoStatus {
  if (!p) return 'new'
  if (p.status === 'memorized' && p.dueAt !== null && p.dueAt < nowS) return 'review'
  return p.status
}

/** Whether an ayah is due for practice now: an overdue review, or a learning ayah whose time has come. */
export function isDue(p: MemoProgress | undefined, nowS: number): boolean {
  if (!p || p.dueAt === null) return false
  const status = effectiveStatus(p, nowS)
  return (status === 'review' || status === 'learning') && p.dueAt <= nowS
}

/** Counts by status over a range (ayahs without an entry count as new). */
export interface ProgressSummary {
  total: number
  new: number
  learning: number
  /** Memorised and not overdue. */
  memorized: number
  /** Memorised but overdue (`review`). */
  review: number
  /** Learning or review ayahs whose due time has passed. */
  due: number
}

export function emptySummary(): ProgressSummary {
  return { total: 0, new: 0, learning: 0, memorized: 0, review: 0, due: 0 }
}

/** Counts the statuses of `[from, to]`. Iterates the sparse map when it is smaller than the range. */
export function summarize(
  progress: ReadonlyMap<number, MemoProgress>,
  from: number,
  to: number,
  nowS: number,
): ProgressSummary {
  const out = emptySummary()
  if (!(to >= from) || from < 1) return out
  out.total = to - from + 1
  const add = (p: MemoProgress) => {
    const status = effectiveStatus(p, nowS)
    if (status === 'new') return
    out[status] += 1
    if (isDue(p, nowS)) out.due += 1
  }
  if (progress.size < out.total) {
    for (const [id, p] of progress) if (id >= from && id <= to) add(p)
  } else {
    for (let id = from; id <= to; id++) {
      const p = progress.get(id)
      if (p) add(p)
    }
  }
  out.new = out.total - out.learning - out.memorized - out.review
  return out
}

/** A run of due ayahs inside one surah. */
export interface DueRange extends AyahSpan {
  /** The earliest due time in the run (Unix seconds). */
  dueAt: number
  count: number
}

/**
 * Due ayahs grouped into runs of consecutive ayahs of one surah, most overdue first (ties: Mushaf order). `surahOf`
 * maps an ayah id to its surah.
 */
export function dueRanges(
  progress: ReadonlyMap<number, MemoProgress>,
  nowS: number,
  surahOf: (ayahId: number) => number,
): DueRange[] {
  const ids = [...progress.keys()].filter((id) => isDue(progress.get(id), nowS)).sort((a, b) => a - b)
  const out: DueRange[] = []
  let run: DueRange | null = null
  for (const id of ids) {
    const due = progress.get(id)?.dueAt ?? nowS
    if (run && id === run.to + 1 && surahOf(id) === surahOf(run.to)) {
      run.to = id
      run.count += 1
      run.dueAt = Math.min(run.dueAt, due)
    } else {
      run = { from: id, to: id, dueAt: due, count: 1 }
      out.push(run)
    }
  }
  return out.sort((a, b) => a.dueAt - b.dueAt || a.from - b.from)
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000)
}

/** Installs (once) the SVG filter of the blank style; returns its remover. */
function installBlankFilter(): () => void {
  if (typeof document === 'undefined' || document.getElementById(BLANK_FILTER_ID)) return () => {}
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.setAttribute('class', 'qd-memo-defs')
  const filter = document.createElementNS(SVG_NS, 'filter')
  filter.id = BLANK_FILTER_ID
  // The whole word box is the filter region (object bounding box units); the output is a rule in its lower part only,
  // so the glyph itself (whatever its colours) never paints.
  for (const [k, v] of Object.entries({
    x: '0',
    y: '0',
    width: '1',
    height: '1',
    filterUnits: 'objectBoundingBox',
    primitiveUnits: 'objectBoundingBox',
    'color-interpolation-filters': 'sRGB',
  })) {
    filter.setAttribute(k, v)
  }
  const flood = document.createElementNS(SVG_NS, 'feFlood')
  for (const [k, v] of Object.entries({ x: '0.1', y: '0.7', width: '0.8', height: '0.035' }))
    flood.setAttribute(k, v)
  filter.append(flood)
  svg.append(filter)
  document.body.append(svg)
  return () => svg.remove()
}

class MemoStore implements Store {
  active = $state.raw<MemoSession | null>(null)
  /** Words up to this id are revealed while hiding. */
  revealedThrough = $state(0)
  peeking = $state(false)
  test = $state.raw<MemoTest | null>(null)
  /** Sparse progress of the loaded ranges (no entry = new). */
  progress = $state.raw(new Map<number, MemoProgress>())
  /** The loop presets (`loop_preset_list`), by name. */
  presets = $state.raw<LoopPreset[]>([])
  /** The whole Quran's progress is loaded (the Memorize panel's overview). */
  loaded = $state(false)
  /** Hints taken (`W`/`Shift+W`) and mistakes counted (`M`) in the running self-test. */
  testReveals = $state(0)
  testMistakes = $state(0)
  /** When the running self-test started (`Date.now()`). */
  testStartedAt = $state(0)
  /** Unix seconds, ticking every half minute: "due" follows the time without a re-read. */
  clock = $state(nowSecs())

  /** First and last word id of the session's range (0 when idle). */
  readonly firstWord: number = $derived(this.active ? quran.firstWordOf(this.active.from) : 0)
  readonly lastWord: number = $derived(this.active ? this.lastWordOf(this.active.to) : 0)
  /** Ayah-end word ids: they stay visible (anchors) and reveals step over them. */
  readonly #endWords: ReadonlySet<number> = $derived.by(() => {
    const firsts = quran.index.ayahFirstWord
    if (firsts.length === 0) return new Set<number>()
    // The word before each ayah's first word ends the previous ayah; the Quran's last word ends the last one.
    return new Set([...firsts.slice(1).map((w) => w - 1), QURAN_WORDS])
  })
  /** Recitable words in the session (end markers excluded) and how many of them are revealed. */
  readonly wordCounts: { total: number; revealed: number } = $derived.by(() => {
    const s = this.active
    const first = this.firstWord
    const last = this.lastWord
    if (!s || first <= 0 || last < first) return { total: 0, revealed: 0 }
    const ayahs = s.to - s.from + 1
    const total = Math.max(0, last - first + 1 - ayahs)
    const through = Math.min(this.revealedThrough, last)
    if (through < first) return { total, revealed: 0 }
    const markers = through >= last ? ayahs : Math.max(0, quran.ayahOfWord(through + 1) - s.from)
    return { total, revealed: Math.min(total, Math.max(0, through - first + 1 - markers)) }
  })
  /** The first hidden word, or `null` when everything is revealed (or idle). */
  readonly nextHidden: number | null = $derived.by(() => {
    if (!this.active) return null
    const last = this.lastWord
    let w = Math.max(this.revealedThrough + 1, this.firstWord)
    while (w <= last && this.#endWords.has(w)) w++
    return w <= last ? w : null
  })
  /** Counts by status over the whole Quran (meaningful once `loaded`). */
  readonly overview: ProgressSummary = $derived(summarize(this.progress, 1, quran.ayahCount, this.clock))
  /** Due runs, most overdue first. */
  readonly due: DueRange[] = $derived(dueRanges(this.progress, this.clock, (id) => quran.ayahRef(id).surah))

  /** Spans whose progress was loaded (re-read on `user-data-changed`). */
  #loadedSpans: AyahSpan[] = []
  /** Read sequence per span key (`from:to`): only the newest read of a span applies. */
  #loadSeqs = new Map<string, number>()
  /** Bumped by every merged mutation: a read that started before it is repeated. */
  #epoch = 0
  /** Bumped by `reset`: answers to an earlier generation are dropped. */
  #gen = 0
  #sessionStartedAt = 0
  #finishedTestId: number | null = null
  #reloadTimer: ReturnType<typeof setTimeout> | undefined
  #clockTimer: ReturnType<typeof setInterval> | undefined
  #presetsLoaded = false
  #presetSeq = 0
  #disposers: (() => void)[] = []

  init(_b: Bootstrap): void {
    this.#dispose()
    this.clock = nowSecs()
    this.#clockTimer = setInterval(() => (this.clock = nowSecs()), CLOCK_MS)
    this.#disposers.push(
      () => clearInterval(this.#clockTimer),
      shortcuts.register(memorizeShortcuts),
      installMemoKeys(),
      listenEvent(events.userDataChanged, ({ kinds }) => this.#onChanged(kinds)),
      $effect.root(() => this.#effects()),
    )
  }

  // --- hide mode -----------------------------------------------------------------------------------------------------

  /** Whether a word is hidden right now (the renderer's class map; O(1)). End markers are never hidden. */
  isHidden(wordId: number): boolean {
    const s = this.active
    if (s === null || this.peeking) return false
    if (wordId <= this.revealedThrough || wordId < this.firstWord || wordId > this.lastWord) return false
    return !this.#endWords.has(wordId)
  }

  /** The weakest strength over a range (an ayah never reviewed is 0): what the schedule preview assumes. */
  minStrength(from: number, to: number): number {
    let min = MAX_STRENGTH
    for (let id = from; id <= to && min > 0; id++) min = Math.min(min, this.progress.get(id)?.strength ?? 0)
    return to >= from ? min : 0
  }

  /** The last word id of an ayah (its end marker). */
  lastWordOf(ayahId: number): number {
    if (!quran.isAyahId(ayahId)) return 0
    if (ayahId >= quran.ayahCount) return Math.max(QURAN_WORDS, quran.firstWordOf(ayahId))
    const next = quran.firstWordOf(ayahId + 1)
    return next > 0 ? next - 1 : 0
  }

  /**
   * Hides `[from, to]` (either order) with nothing revealed. Starting while a self-test runs ends the test unrated.
   * The reader is not moved: callers navigate when the range is off screen (the panel does).
   */
  startHide(from: number, to: number): void {
    const span = this.#span(from, to)
    if (!span) return
    this.#closeSession()
    this.#ensureMushaf()
    this.active = { ...span, mode: 'hide' }
    this.revealedThrough = quran.firstWordOf(span.from) - 1
    this.peeking = false
    this.#sessionStartedAt = Date.now()
    ui.announce(i18n.t('memo.announce.hiding', { range: this.label(span.from, span.to) }))
  }

  /** Ends hide mode (a running self-test ends unrated). */
  stop(): void {
    if (!this.active) return
    const wasTest = this.active.mode === 'test'
    this.#closeSession()
    ui.announce(i18n.t(wasTest ? 'memo.announce.testCancelled' : 'memo.announce.stopped'))
  }

  /** Hides every word of the session again. */
  restart(): void {
    const s = this.active
    if (!s) return
    this.revealedThrough = quran.firstWordOf(s.from) - 1
    this.peeking = false
    this.#follow(quran.firstWordOf(s.from))
    ui.announce(i18n.t('memo.announce.restarted'))
  }

  /** `W`: reveals the next hidden word (a hint in a self-test); turns the page when it lies on the next one. */
  revealNextWord(): void {
    const next = this.nextHidden
    if (next === null) {
      if (this.active) ui.announce(i18n.t('memo.announce.allRevealed'))
      return
    }
    this.revealedThrough = next
    this.#hinted()
    this.#follow(next)
  }

  /** `Shift+W`: reveals the rest of the ayah that holds the next hidden word. */
  revealNextAyah(): void {
    const next = this.nextHidden
    if (next === null) {
      if (this.active) ui.announce(i18n.t('memo.announce.allRevealed'))
      return
    }
    const ayah = quran.ayahOfWord(next)
    this.revealedThrough = Math.min(this.lastWord, Math.max(next, this.lastWordOf(ayah)))
    this.#hinted()
    this.#follow(next)
  }

  /** Hold `Q` (or the toolbar's Peek): every hidden word shows while `on`. In a self-test a peek counts as a hint. */
  peek(on: boolean): void {
    const next = on && this.active !== null
    if (this.peeking === next) return
    this.peeking = next
    if (next) this.#hinted()
  }

  // --- self-test -----------------------------------------------------------------------------------------------------

  /**
   * Starts a self-test over `[from, to]`: a random start ayah (`memo_test_start`), the reader jumps there and hides from
   * it to `to`. A playing recitation pauses (it would give the answer away). Resolves whether the test started.
   */
  async startTest(from: number, to: number): Promise<boolean> {
    const span = this.#span(from, to)
    if (!span) return false
    let t: MemoTest
    try {
      t = await call(api.memoTestStart(span.from, span.to))
    } catch (e) {
      ui.toastError(e)
      return false
    }
    this.#closeSession()
    this.#ensureMushaf()
    this.test = t
    this.#finishedTestId = null
    this.testReveals = 0
    this.testMistakes = 0
    this.testStartedAt = Date.now()
    this.#sessionStartedAt = this.testStartedAt
    this.active = { from: t.startAyahId, to: t.toAyahId, mode: 'test' }
    this.revealedThrough = quran.firstWordOf(t.startAyahId) - 1
    this.peeking = false
    if (player.wantsPlay) void player.pause()
    reader.goToAyah(t.startAyahId, { flash: true })
    ui.announce(i18n.t('memo.announce.testStarted', { ref: this.label(t.startAyahId) }))
    return true
  }

  /** `M` (or the bar's Mistake): counts a slip in the running self-test. */
  addMistake(): void {
    if (!this.test) return
    this.testMistakes += 1
    ui.announce(i18n.tp('memo.announce.mistakes', this.testMistakes))
  }

  /** Takes back the last counted mistake. */
  undoMistake(): void {
    if (this.test && this.testMistakes > 0) this.testMistakes -= 1
  }

  /** Ends the running self-test without rating it (it stays unfinished in the record). */
  cancelTest(): void {
    if (this.test) this.stop()
  }

  /**
   * Rates the running self-test: records it (`memo_test_finish`) and reschedules the recited span `[start, to]`
   * (`memo_review`). Resolves whether it was saved; on a failure the test keeps running (retry or cancel).
   */
  async finishTest(rating: number): Promise<boolean> {
    const t = this.test
    if (!t || !isRating(rating)) return false
    const mistakes = this.testMistakes
    try {
      if (this.#finishedTestId !== t.id) {
        await call(api.memoTestFinish({ id: t.id, reveals: this.testReveals, mistakes, rating }))
        this.#finishedTestId = t.id
      }
      const rows = await call(
        api.memoReview({ fromAyahId: t.startAyahId, toAyahId: t.toAyahId, rating, mistakes }),
      )
      this.#merge(rows)
    } catch (e) {
      ui.toastError(e)
      return false
    }
    const seconds = Math.round((Date.now() - this.testStartedAt) / 1000)
    this.#recordHistory(t.startAyahId, seconds)
    this.test = null
    this.active = null
    this.revealedThrough = 0
    this.peeking = false
    this.testReveals = 0
    this.testMistakes = 0
    ui.toast({
      message: i18n.t('memo.toast.testSaved', {
        range: this.label(t.startAyahId, t.toAyahId),
        rating: i18n.t(`memo.rating.${RATING_NAMES[rating]}`),
      }),
      description: this.#nextReviewText(t.startAyahId, t.toAyahId),
      tone: 'success',
    })
    return true
  }

  // --- progress ------------------------------------------------------------------------------------------------------

  /** Rates a range by hand (`memo_review`). */
  async rate(from: number, to: number, rating: number): Promise<boolean> {
    const span = this.#span(from, to)
    if (!span || !isRating(rating)) return false
    try {
      this.#merge(
        await call(api.memoReview({ fromAyahId: span.from, toAyahId: span.to, rating, mistakes: 0 })),
      )
    } catch (e) {
      ui.toastError(e)
      return false
    }
    ui.toast({
      message: i18n.t('memo.toast.rated', {
        range: this.label(span.from, span.to),
        rating: i18n.t(`memo.rating.${RATING_NAMES[rating]}`),
      }),
      description: this.#nextReviewText(span.from, span.to),
    })
    return true
  }

  /** Sets the status of a range (`memo_set_status`): memorised, learning, due for review, or reset (`new`). */
  async setStatus(from: number, to: number, status: MemoStatus): Promise<boolean> {
    const span = this.#span(from, to)
    if (!span) return false
    try {
      this.#merge(await call(api.memoSetStatus(span.from, span.to, status)))
    } catch (e) {
      ui.toastError(e)
      return false
    }
    ui.toast({ message: i18n.t(`memo.toast.status.${status}`, { range: this.label(span.from, span.to) }) })
    return true
  }

  /** Loads the stored progress of a range into `progress` (replacing what was there for it). */
  async loadProgress(from: number, to: number): Promise<boolean> {
    const span = this.#span(from, to)
    if (!span) return false
    this.#remember(span)
    const key = `${span.from}:${span.to}`
    const seq = (this.#loadSeqs.get(key) ?? 0) + 1
    this.#loadSeqs.set(key, seq)
    const epoch = this.#epoch
    const gen = this.#gen
    try {
      const rows = await call(api.memoProgress(span.from, span.to))
      // A newer read of the same span, or a reset, wins.
      if (this.#loadSeqs.get(key) !== seq || gen !== this.#gen) return true
      // A change landed while this read was on its way: its answer may predate it, so read again.
      if (this.#epoch !== epoch) return this.loadProgress(span.from, span.to)
      this.#replace(span, rows)
      return true
    } catch (e) {
      console.warn('[qd] memo: progress could not be loaded', e)
      return false
    }
  }

  /** Loads the whole Quran's progress (the panel's overview, heatmap and due list). */
  async loadAll(): Promise<boolean> {
    const count = quran.ayahCount
    if (count <= 0) return false
    const ok = await this.loadProgress(1, count)
    if (ok) this.loaded = true
    return ok
  }

  // --- loop presets --------------------------------------------------------------------------------------------------

  /** Loads the presets (once, then on `user-data-changed`; `force` re-reads). */
  async loadPresets(force = false): Promise<void> {
    if (this.#presetsLoaded && !force) return
    const seq = ++this.#presetSeq
    try {
      const list = await call(api.loopPresetList())
      if (seq !== this.#presetSeq) return
      this.presets = list
      this.#presetsLoaded = true
    } catch (e) {
      console.warn('[qd] memo: loop presets could not be loaded', e)
    }
  }

  /** Creates (`id: null`) or updates a preset; resolves the stored row, or `null` on a failure (toasted). */
  async savePreset(input: LoopPresetInput): Promise<LoopPreset | null> {
    try {
      const saved = await call(api.loopPresetUpsert(input))
      await this.loadPresets(true)
      return saved
    } catch (e) {
      ui.toastError(e)
      return null
    }
  }

  /** Deletes a preset; the toast offers to bring it back. */
  async deletePreset(id: number): Promise<boolean> {
    const preset = this.presets.find((p) => p.id === id)
    try {
      await call(api.loopPresetDelete(id))
    } catch (e) {
      ui.toastError(e)
      return false
    }
    this.presets = this.presets.filter((p) => p.id !== id)
    if (preset) {
      ui.toast({
        message: i18n.t('memo.toast.presetDeleted', { name: preset.name }),
        action: {
          label: i18n.t('common.undo'),
          run: () => {
            const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = preset
            void this.savePreset({ ...rest, id: null })
          },
        },
      })
    }
    return true
  }

  /**
   * Plays a preset: its reciter and speed become the settings, then its range plays with its repeats and gap;
   * the reader turns to the range when it is off screen.
   */
  async applyPreset(p: LoopPreset): Promise<void> {
    if (p.reciterId !== null && p.reciterId !== settings.value.reciterId) {
      await settings.update({ reciterId: p.reciterId })
    }
    await player.setSpeed(p.speedPct)
    if (!reader.isVisible(p.fromAyahId)) reader.goToAyah(p.fromAyahId)
    await player.playRange(p.fromAyahId, p.toAyahId, {
      ayahRepeat: p.ayahRepeat,
      rangeRepeat: p.rangeRepeat,
      gap: p.gap,
    })
    ui.announce(i18n.t('memo.announce.presetPlaying', { name: p.name }))
  }

  // --- labels --------------------------------------------------------------------------------------------------------

  /** "Al-Mulk 67:1–30" (or one ayah), bidi-isolated. */
  label(from: number, to: number = from): string {
    return quran.refLabel(from, 'long', to)
  }

  /** "Next review in 4 days" for the weakest ayah of a range after a change (from `progress`). */
  #nextReviewText(from: number, to: number): string | undefined {
    let soonest: number | null = null
    for (let id = from; id <= to; id++) {
      const due = this.progress.get(id)?.dueAt ?? null
      if (due !== null && (soonest === null || due < soonest)) soonest = due
    }
    return soonest === null ? undefined : i18n.t('memo.toast.nextReview', { when: i18n.relTime(soonest) })
  }

  reset(): void {
    this.#dispose()
    clearTimeout(this.#reloadTimer)
    this.#reloadTimer = undefined
    this.active = null
    this.revealedThrough = 0
    this.peeking = false
    this.test = null
    this.progress = new Map()
    this.presets = []
    this.loaded = false
    this.testReveals = 0
    this.testMistakes = 0
    this.testStartedAt = 0
    this.#loadedSpans = []
    this.#loadSeqs.clear()
    this.#gen++
    this.#presetSeq++
    this.#presetsLoaded = false
    this.#sessionStartedAt = 0
    this.#finishedTestId = null
    if (typeof document !== 'undefined') {
      const root = document.documentElement
      delete root.dataset.memo
      delete root.dataset.memoStyle
      delete root.dataset.memoHover
    }
  }

  // --- internals -----------------------------------------------------------------------------------------------------

  #effects(): void {
    // The session onto <html> for memo.css, and the blank style's filter while it is needed.
    $effect(() => {
      const s = this.active
      const style = settings.value.memoHideStyle
      const hover = settings.value.memoRevealOnHover
      const root = document.documentElement
      if (s) {
        root.dataset.memo = s.mode
        root.dataset.memoStyle = style
        // Hovering reveals while hiding only: in a self-test every hint is counted (W, Shift+W, Q).
        if (hover && s.mode === 'hide') root.dataset.memoHover = ''
        else delete root.dataset.memoHover
      } else {
        delete root.dataset.memo
        delete root.dataset.memoStyle
        delete root.dataset.memoHover
      }
    })
    $effect(() => {
      if (this.active && settings.value.memoHideStyle === 'blank') return installBlankFilter()
    })
  }

  /** A valid, ordered span inside the index, or `null`. */
  #span(from: number, to: number): AyahSpan | null {
    const count = quran.ayahCount
    if (count <= 0 || !Number.isFinite(from) || !Number.isFinite(to)) return null
    const a = Math.min(count, Math.max(1, Math.round(Math.min(from, to))))
    const b = Math.min(count, Math.max(1, Math.round(Math.max(from, to))))
    return { from: a, to: b }
  }

  /** Ends the current session: a hide session long enough is recorded in the history; a test ends unrated. */
  #closeSession(): void {
    const s = this.active
    if (s && s.mode === 'hide') {
      const seconds = Math.round((Date.now() - this.#sessionStartedAt) / 1000)
      if (seconds >= HISTORY_MIN_S) this.#recordHistory(s.from, seconds)
    }
    this.active = null
    this.test = null
    this.revealedThrough = 0
    this.peeking = false
    this.testReveals = 0
    this.testMistakes = 0
    this.#finishedTestId = null
  }

  /** Hiding shows on the Mushaf: leave translation mode (the position is kept by ayah). */
  #ensureMushaf(): void {
    if (settings.value.readingMode !== 'mushaf') reader.toggleReadingMode()
  }

  #hinted(): void {
    if (this.active?.mode === 'test') this.testReveals += 1
  }

  /** Turns to a revealed word's page when it is not on screen. */
  #follow(wordId: number): void {
    if (wordId <= 0 || settings.value.readingMode !== 'mushaf') return
    const page = quran.pageOfWord(reader.layout, wordId)
    if (!reader.visiblePages.includes(page)) reader.goToPage(page, { push: false })
  }

  #recordHistory(ayahId: number, seconds: number): void {
    const layout = reader.layout
    void history.record({
      mode: 'memorize',
      layout,
      page: quran.pageOfAyah(layout, ayahId),
      ayahId,
      dwellS: Math.max(0, seconds),
    })
  }

  /** Rows returned by a mutation (one per ayah) replace their entries; `new` rows drop out (sparse map). */
  #merge(rows: readonly MemoProgress[]): void {
    if (rows.length === 0) return
    this.#epoch++
    const ids = new Set(rows.map((r) => r.ayahId))
    const kept = [...this.progress].filter(([id]) => !ids.has(id))
    const fresh = rows
      .filter((r) => !(r.status === 'new' && r.reviews === 0 && r.dueAt === null))
      .map((r) => [r.ayahId, r] as const)
    this.progress = new Map([...kept, ...fresh])
    this.clock = nowSecs()
  }

  /** A read of `span` (sparse) replaces everything the map held for it. */
  #replace(span: AyahSpan, rows: readonly MemoProgress[]): void {
    const inside = (id: number) => id >= span.from && id <= span.to
    const kept = [...this.progress].filter(([id]) => !inside(id))
    const fresh = rows.filter((r) => inside(r.ayahId)).map((r) => [r.ayahId, r] as const)
    this.progress = new Map([...kept, ...fresh])
    this.clock = nowSecs()
  }

  #remember(span: AyahSpan): void {
    if (this.#loadedSpans.some((s) => s.from <= span.from && s.to >= span.to)) return
    this.#loadedSpans = [...this.#loadedSpans.filter((s) => !(s.from >= span.from && s.to <= span.to)), span]
  }

  #onChanged(kinds: readonly UserDataKind[]): void {
    if (kinds.includes('presets') && this.#presetsLoaded) void this.loadPresets(true)
    if (!kinds.includes('memo') || this.#loadedSpans.length === 0) return
    clearTimeout(this.#reloadTimer)
    this.#reloadTimer = setTimeout(() => {
      this.#reloadTimer = undefined
      const spans = this.#loadedSpans
      const from = Math.min(...spans.map((s) => s.from))
      const to = Math.max(...spans.map((s) => s.to))
      void this.loadProgress(from, to)
    }, RELOAD_DEBOUNCE_MS)
  }

  #dispose(): void {
    for (const dispose of this.#disposers.splice(0)) dispose()
  }
}

export const memo = new MemoStore()

/**
 * The study pane's subject: which ayah, or range of ayahs, the side pane shows, and its pin. Imported only by
 * `src/components/sidepane/*` and their tests.
 *
 * **Precedence** (`resolveSubject`, pure; `settings.sidePane.follow`):
 * 1. `follow = pinned` with a pin: the pinned span, whatever the reader or the recitation do.
 * 2. An explicit selection that pins the pane (`reader.paneFollow = 'selection'`): the selection.
 * 3. `follow ≠ selection` and a recitation is active: the recited ayah (the surah's first ayah during its basmala).
 * 4. A selection (kept on screen after "Follow recitation", or while nothing plays): the selection.
 * 5. The reader's action target: the visible cursor, else the ayah being read (`reader.actionTarget`).
 *
 * **Pin** (the header's pin toggle): pinning stores the shown span and switches `sidePane.follow` to `pinned`;
 * unpinning returns to the mode used before (default `selection_or_audio`). The pinned span is kept in localStorage
 * (a per-viewer convenience, never authoritative), so a pinned pane reopens on the same ayah. Leaving `pinned` by any
 * route (the toggle, Settings, the follow chip) drops the pin; choosing `pinned` in Settings pins what is shown then.
 *
 * **Chips** (the header's second line): "Follow recitation" while a pin (selection or toggle) holds the pane during a
 * recitation; "Show 2:256" while the pane is pinned and the reader selected something else.
 */
import { untrack } from 'svelte'
import { parseRef } from '$lib/text/html'
import type { SidePaneFollow } from '$lib/ipc/bindings'
import { app, i18n, packs, player, quran, reader, settings } from '$lib/stores'

/** An inclusive range of ayah ids (`from === to` for one ayah). */
export interface AyahSpan {
  from: number
  to: number
}

/** Why the pane shows what it shows. */
export type SubjectSource = 'pinned' | 'selection' | 'recitation' | 'reading'

export interface Subject extends AyahSpan {
  source: SubjectSource
}

/** Everything the subject depends on (a plain snapshot, so the rules are unit-testable). */
export interface SubjectInput {
  follow: SidePaneFollow
  pin: AyahSpan | null
  selection: { fromAyahId: number; toAyahId: number } | null
  paneFollow: 'selection' | 'audio'
  /** The recited ayah while a recitation is active, else `null`. */
  recited: number | null
  /** The reader's action target (visible cursor, else the ayah being read); `null` before the index loads. */
  reading: number | null
}

/** The most ayahs a tab lists for a range (a long selection shows its first `MAX_SPAN` ayahs and says so). */
export const MAX_SPAN = 30
/** Words in the Quran, end markers included. */
export const WORD_TOTAL = 83_665
/** localStorage key of the pinned span. */
const PIN_KEY = 'qd-sidepane-pin-v1'

/** The pane's subject under the precedence (see the file comment); `null` when there is nothing to show. */
export function resolveSubject(i: SubjectInput): Subject | null {
  if (i.follow === 'pinned' && i.pin !== null) return { ...i.pin, source: 'pinned' }
  const sel = i.selection ? { from: i.selection.fromAyahId, to: i.selection.toAyahId } : null
  if (sel !== null && i.paneFollow === 'selection') return { ...sel, source: 'selection' }
  if (i.follow !== 'selection' && i.recited !== null) {
    return { from: i.recited, to: i.recited, source: 'recitation' }
  }
  if (sel !== null) return { ...sel, source: 'selection' }
  if (i.reading !== null && i.reading > 0) return { from: i.reading, to: i.reading, source: 'reading' }
  return null
}

/** Whether a span holds an ayah. */
export function spanHas(span: AyahSpan | null, ayahId: number | null): boolean {
  return span !== null && ayahId !== null && ayahId >= span.from && ayahId <= span.to
}

/** The header chip: offer to follow the recitation, or to show the reader's selection, or nothing. */
export type PaneChip = { kind: 'follow'; ayahId: number } | { kind: 'selection'; span: AyahSpan } | null

export function chipFor(i: SubjectInput, subject: Subject | null): PaneChip {
  if (subject === null) return null
  if (i.recited !== null) {
    // A pin holds the pane during a recitation: the toggle's pin, or a selection in "selected or recited" mode.
    if (subject.source === 'pinned') return { kind: 'follow', ayahId: i.recited }
    if (subject.source === 'selection' && i.paneFollow === 'selection' && i.follow === 'selection_or_audio') {
      return { kind: 'follow', ayahId: i.recited }
    }
  }
  if (subject.source === 'pinned' && i.selection !== null) {
    const span = { from: i.selection.fromAyahId, to: i.selection.toAyahId }
    if (span.from !== subject.from || span.to !== subject.to) return { kind: 'selection', span }
  }
  return null
}

/** The ayahs a tab lists for a subject: all of them up to `MAX_SPAN`. */
export function listedAyahs(span: AyahSpan): number[] {
  const out: number[] = []
  for (let a = span.from; a <= span.to && out.length < MAX_SPAN; a++) out.push(a)
  return out
}

/** An ayah's words: the first word id, the last word before its end marker, and the end marker. */
export interface WordSpan {
  first: number
  last: number
  marker: number
}

/** The word ids of an ayah from the index (`null` before the index loads or for an unknown ayah). */
export function wordSpanOf(ayahId: number): WordSpan | null {
  const first = quran.firstWordOf(ayahId)
  if (first <= 0) return null
  const next = quran.firstWordOf(ayahId + 1)
  const marker = (next > 0 ? next : WORD_TOTAL + 1) - 1
  return marker > first ? { first, last: marker - 1, marker } : null
}

/** A reference from rendered HTML (`data-ref="2:255"`, `"2:255-257"`) as the ayah id it starts at, or 0. */
export function refAyahId(ref: string): number {
  const parsed = parseRef(ref)
  return parsed ? quran.ayahId(parsed.surah, parsed.fromAyah) : 0
}

/** A reference in tafsir, translation or note text: the page goes there and flashes it; the pane and focus stay. */
export function goToRef(ref: string): void {
  const id = refAyahId(ref)
  if (id > 0) reader.goToAyah(id, { flash: true })
}

/** Where a pack's download stands, for a status line: its phase and how far it got. */
export interface JobLine {
  state: 'queued' | 'downloading' | 'installing' | 'paused'
  /** 0–100. */
  percent: number
  /** The percentage in the UI's digits ("45%"). */
  label: string
}

/** The download state of a pack that is on its way (`translations.packMeta(id).availability === 'downloading'`). */
export function jobLine(packId: string): JobLine {
  const job = packs.jobs.get(packId)
  const pack = packs.pack(packId)
  const ratio = job
    ? job.totalKib > 0
      ? job.receivedKib / job.totalKib
      : 0
    : pack && pack.sizeKib > 0
      ? pack.installedKib / pack.sizeKib
      : 0
  const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)))
  let state: JobLine['state'] = 'downloading'
  if (job) {
    if (job.phase === 'queued') state = 'queued'
    else if (job.phase === 'verifying' || job.phase === 'installing') state = 'installing'
    else if (job.phase === 'paused') state = 'paused'
  } else if (pack?.state.type === 'paused') state = 'paused'
  else if (packs.pending.has(packId)) state = 'queued'
  const label = new Intl.NumberFormat(i18n.intlLocale, { style: 'percent' }).format(percent / 100)
  return { state, percent, label }
}

/** The language's name in the UI language ("English", "الإنجليزية"), or the code. */
export function languageName(code: string | null, locale: string): string {
  if (!code) return ''
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

function validSpan(v: unknown): AyahSpan | null {
  if (typeof v !== 'object' || v === null) return null
  const { from, to } = v as Record<string, unknown>
  if (typeof from !== 'number' || typeof to !== 'number') return null
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) return null
  return { from, to }
}

function readStoredPin(): AyahSpan | null {
  try {
    return validSpan(JSON.parse(localStorage.getItem(PIN_KEY) ?? 'null'))
  } catch {
    return null
  }
}

function storePin(span: AyahSpan | null): void {
  try {
    if (span === null) localStorage.removeItem(PIN_KEY)
    else localStorage.setItem(PIN_KEY, JSON.stringify(span))
  } catch {
    // Storage blocked or full: the pin lives in memory for this session.
  }
}

class PaneStore {
  #pin = $state.raw<AyahSpan | null>(null)
  /** The follow mode to return to when the pin is released. */
  #before: Exclude<SidePaneFollow, 'pinned'> = 'selection_or_audio'
  /** `pinTo` switched the mode itself: the follow watcher keeps the pin it set. */
  #pinning = false
  #disposeWatch: (() => void) | null = null

  /** The recited ayah while a recitation is active; the surah's first ayah during its basmala. */
  readonly recited: number | null = $derived.by(() => {
    if (!player.isActive) return null
    const id = player.currentAyahId
    if (id !== null && quran.isAyahId(id)) return id
    const heard = player.heard
    if (heard && heard.ayah === 0 && heard.surah > 0) {
      const first = quran.ayahId(heard.surah, 1)
      return first > 0 ? first : null
    }
    return null
  })

  readonly input: SubjectInput = $derived({
    follow: settings.value.sidePane.follow,
    pin: this.#pin,
    selection: reader.selection,
    paneFollow: reader.paneFollow,
    recited: this.recited,
    reading: quran.isAyahId(reader.actionTarget) ? reader.actionTarget : null,
  })

  /**
   * The subject held while the reader types in the pane (a note, a picker's filter): the recitation or the reading
   * position moving on must not swap the editor away mid-sentence. Released when focus leaves the field.
   */
  #held = $state.raw<Subject | null>(null)

  readonly subject: Subject | null = $derived(this.#held ?? resolveSubject(this.input))
  /** The pin toggle is on (`sidePane.follow = pinned`). */
  readonly pinned = $derived(settings.value.sidePane.follow === 'pinned')
  readonly chip: PaneChip = $derived(chipFor(this.input, this.subject))
  /** The span the pane would show without the pin. */
  readonly live: Subject | null = $derived(
    resolveSubject({
      ...this.input,
      pin: null,
      follow: this.pinned ? 'selection_or_audio' : this.input.follow,
    }),
  )

  constructor() {
    this.#pin = readStoredPin()
    if (typeof window !== 'undefined') this.#watch()
  }

  /**
   * Watches `sidePane.follow` for the life of the app (from the first import, before the stores start, so the
   * start-up value is seen too): leaving `pinned` drops the pin; choosing `pinned` elsewhere (Settings) pins what is
   * shown then. During start-up (`app.ready` false) a stored pin is kept: the pane reopens where it was pinned.
   */
  #watch(): void {
    if (this.#disposeWatch !== null) return
    let prev: SidePaneFollow | null = null
    this.#disposeWatch = $effect.root(() => {
      $effect(() => {
        const follow = settings.value.sidePane.follow
        untrack(() => {
          if (prev === 'pinned' && follow !== 'pinned') this.#setPin(null)
          if (prev !== null && prev !== 'pinned' && follow === 'pinned') {
            if (this.#pinning) this.#pinning = false
            else if (app.ready || this.#pin === null) this.#setPin(this.live ? spanOf(this.live) : null)
            this.#before = prev
          }
          prev = follow
        })
      })
    })
  }

  /** A pinned pane without a pin (first start in `pinned` mode): pin what it shows. Called by the pane's effect. */
  settlePin(): void {
    if (this.pinned && this.#pin === null && this.live !== null) this.#setPin(spanOf(this.live))
  }

  /** The header's pin toggle. */
  togglePin(): void {
    if (this.pinned) this.unpin()
    else if (this.subject !== null) this.pinTo(spanOf(this.subject))
  }

  /** Pins the pane to a span (switching `sidePane.follow` to `pinned` when it is not yet). */
  pinTo(span: AyahSpan): void {
    this.release()
    this.#setPin({ from: span.from, to: span.to })
    const current = settings.value.sidePane
    if (current.follow === 'pinned') return
    this.#before = current.follow
    this.#pinning = true
    void settings.update({ sidePane: { ...current, follow: 'pinned' } })
  }

  /** Releases the pin: the pane follows again as it did before it was pinned. */
  unpin(): void {
    const current = settings.value.sidePane
    this.release()
    this.#setPin(null)
    if (current.follow === 'pinned') void settings.update({ sidePane: { ...current, follow: this.#before } })
  }

  /** The "Follow recitation" chip: drop any pin, keep the selection on the page. */
  followRecitation(): void {
    this.release()
    if (this.pinned) this.unpin()
    reader.followRecitation()
  }

  /** Keeps the current subject while a field in the pane has focus (see `#held`). */
  hold(): void {
    if (this.#held === null && this.subject !== null) this.#held = this.subject
  }

  /** Lets the pane follow again. */
  release(): void {
    if (this.#held !== null) this.#held = null
  }

  /** The ayah the chevrons lead to (`null` at either end of the Quran or with nothing shown). */
  stepTarget(delta: 1 | -1): number | null {
    const s = this.subject
    if (s === null) return null
    const target = delta > 0 ? s.to + 1 : s.from - 1
    return quran.isAyahId(target) ? target : null
  }

  /**
   * The header chevrons: the previous or next ayah. A pinned pane moves its pin and leaves the page alone; otherwise
   * the reader selects that ayah (turning the page when needed), so the page and the pane stay together.
   */
  step(delta: 1 | -1): void {
    const target = this.stepTarget(delta)
    const s = this.subject
    if (target === null || s === null) return
    this.release()
    if (s.source === 'pinned') {
      this.#setPin({ from: target, to: target })
      return
    }
    reader.goToAyah(target, { select: true })
  }

  /** Tests: forget the pin (the follow watcher keeps running). */
  reset(): void {
    this.#pinning = false
    this.#held = null
    this.#before = 'selection_or_audio'
    this.#setPin(null)
  }

  #setPin(span: AyahSpan | null): void {
    const same = span === this.#pin || (span !== null && this.#pin !== null && sameSpan(span, this.#pin))
    if (!same) this.#pin = span
    storePin(span)
  }
}

function spanOf(s: AyahSpan): AyahSpan {
  return { from: s.from, to: s.to }
}

function sameSpan(a: AyahSpan, b: AyahSpan): boolean {
  return a.from === b.from && a.to === b.to
}

export const pane = new PaneStore()

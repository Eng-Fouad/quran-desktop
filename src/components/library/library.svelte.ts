/**
 * Shared helpers of the library panels (Bookmarks, Highlights, Notes, History; §9.8). Owner: WP11c.
 *
 * - `previews`: the opening words of ayahs (`quran_get_ayahs`, `text_hafs`) for the rows' Quran-text line, fetched
 *   lazily for the rows that scroll into view and batched into a few windows.
 * - `openSpan`: a jump from a panel row to an ayah (§7.4: through `reader.goToAyah`; focus moves to the ayah, §8.15).
 * - `focusAfterRemoval`: a deleted row hands keyboard focus to its neighbour (or the panel's filter).
 * - Text helpers: the panels' filter matching, note excerpts, day groups.
 * - `panelPrefs`: per-viewer panel conveniences (sort order, filters), kept in `localStorage`.
 */
import { foldForMatch } from '$components/ui/filter'
import { api, call } from '$lib/ipc'
import type { HighlightColor } from '$lib/ipc/bindings'
import type { AyahSpan } from '$lib/stores/library.svelte'
import { i18n, quran, reader, ui } from '$lib/stores'

// --- focus after a deletion -------------------------------------------------------------------------------------------

/** The element of a panel that holds its roving rows (`[data-roving]`, possibly in several groups). */
export const ROVING_LIST = 'data-qd-roving-list'

/** Frames to wait for the deleted row to leave (the store removes it optimistically, after the command). */
const REMOVAL_FRAMES = 90

/**
 * Keeps keyboard focus in the panel when `row` is about to be deleted (Delete, or the item menu's Delete). The row's
 * button leaves with the row, so focus would fall to `<body>`, and the next keys would reach the reader (arrows move
 * the cursor, B bookmarks). Once the row has left, focus goes to the row now in its place (the next one), else the new
 * last row, else the panel's filter field, else the panel's tab in the rail. The rows are found again then: a list may
 * re-create them (a group keyed by its first item). That row becomes the list's tab stop (the panels follow
 * `focusin`). Nothing moves when the deletion failed (the row stays) or focus already went elsewhere on purpose.
 */
export function focusAfterRemoval(row: HTMLElement | null | undefined): void {
  if (!row) return
  const list = row.closest<HTMLElement>(`[${ROVING_LIST}]`)
  const panel = row.closest<HTMLElement>('[data-tab]') ?? list?.parentElement ?? null
  if (!list || !panel) return
  const at = [...list.querySelectorAll<HTMLElement>('[data-roving]')].indexOf(row)
  const tab = panel.dataset.tab
  let frames = 0
  const land = () => {
    // Wait for the row to leave, and for the item menu (when Delete came from it) to close and hand focus back.
    if (row.isConnected || ui.layerOpen) {
      if (++frames < REMOVAL_FRAMES) requestAnimationFrame(land)
      return
    }
    const active = document.activeElement
    if (active !== null && active !== document.body) {
      // The closing menu still holds focus for a moment (it drops it to `<body>` as it leaves): wait for that.
      if (active.closest('[role="menu"]') !== null && ++frames < REMOVAL_FRAMES) requestAnimationFrame(land)
      return
    }
    const rows = [
      ...(panel.querySelector(`[${ROVING_LIST}]`)?.querySelectorAll<HTMLElement>('[data-roving]') ?? []),
    ]
    const next =
      rows[Math.min(Math.max(0, at), rows.length - 1)] ??
      panel.querySelector<HTMLElement>('input[type="search"]') ??
      (tab ? document.querySelector<HTMLElement>(`button[data-tab="${CSS.escape(tab)}"]`) : null)
    next?.focus()
  }
  requestAnimationFrame(land)
}

// --- ayah text previews ------------------------------------------------------------------------------------------------

/** `quran_get_ayahs` answers at most this many ayahs. */
const WINDOW_MAX = 300
/** Requested ids closer than this share one request (the ayahs between them come along). */
const WINDOW_GAP = 24
/** Requests that arrive within this window are batched. */
const BATCH_MS = 16

class AyahPreviews {
  /** Bumped whenever texts arrive (rows re-read `text`). */
  version = $state(0)
  #texts = new Map<number, string>()
  #wanted = new Set<number>()
  #inflight = new Set<number>()
  #failed = new Set<number>()
  #timer: ReturnType<typeof setTimeout> | undefined

  /** The ayah's Quran text (`text_hafs`), or `undefined` while it loads. */
  text(ayahId: number): string | undefined {
    void this.version
    return this.#texts.get(ayahId)
  }

  /** Asks for an ayah's text (a row scrolled into view). Batched; each ayah is fetched at most once. */
  want(ayahId: number): void {
    if (!quran.isAyahId(ayahId)) return
    if (this.#texts.has(ayahId) || this.#inflight.has(ayahId) || this.#failed.has(ayahId)) return
    this.#wanted.add(ayahId)
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined
      void this.#flush()
    }, BATCH_MS)
  }

  /** Forgets everything (tests). */
  reset(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#texts.clear()
    this.#wanted.clear()
    this.#inflight.clear()
    this.#failed.clear()
    this.version = 0
  }

  async #flush(): Promise<void> {
    const ids = [...this.#wanted].sort((a, b) => a - b)
    this.#wanted.clear()
    for (const id of ids) this.#inflight.add(id)
    const windows: [number, number][] = []
    for (const id of ids) {
      const last = windows.at(-1)
      if (last && id - last[1] <= WINDOW_GAP && id - last[0] < WINDOW_MAX) last[1] = id
      else windows.push([id, id])
    }
    await Promise.all(
      windows.map(async ([from, to]) => {
        try {
          const rows = await call(api.quranGetAyahs(reader.layout, from, to))
          for (const r of rows) this.#texts.set(r.id, r.textHafs)
        } catch (e) {
          console.warn('[qd] ayah previews could not be loaded', e)
          for (const id of ids) if (id >= from && id <= to) this.#failed.add(id)
        } finally {
          for (const id of ids) if (id >= from && id <= to) this.#inflight.delete(id)
        }
      }),
    )
    this.version += 1
  }
}

export const previews = new AyahPreviews()

/**
 * A Svelte action: asks for the ayah's preview once the element scrolls near the viewport (so a long list never fetches
 * the text of rows nobody sees).
 */
export function wantPreview(
  node: HTMLElement,
  ayahId: number,
): { update(id: number): void; destroy(): void } {
  let id = ayahId
  let seen = false
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        seen = true
        previews.want(id)
      }
    },
    { rootMargin: '200px 0px' },
  )
  observer.observe(node)
  return {
    update(next: number) {
      id = next
      if (seen) previews.want(id)
    },
    destroy() {
      observer.disconnect()
    },
  }
}

/** A chip on a library row: a collection or a tag. */
export interface ItemChip {
  id: string
  label: string
  /** A colour for the chip's dot (a collection's colour token, `var(--user-hl-red-solid)`). */
  color?: string | null
}

// --- navigation ----------------------------------------------------------------------------------------------------------

/**
 * Shows the reader at a span from a panel row (§7.4): its first ayah flashes and takes focus once it renders; a range is
 * selected when `select` is set. In a narrow window the floating sidebar closes on its own when the pages change.
 */
export function openSpan(span: AyahSpan, opts: { select?: boolean } = {}): void {
  if (!quran.isAyahId(span.from)) return
  ui.setView('reader')
  const range = opts.select === true && span.to > span.from
  reader.goToAyah(span.from, {
    select: opts.select === true,
    selectTo: range ? span.to : undefined,
    flash: true,
    focus: true,
  })
}

/** Shows a page (a page bookmark, a history entry) in the reader. */
export function openPage(page: number): void {
  ui.setView('reader')
  reader.goToPage(page, { push: true, transition: true })
}

// --- text ---------------------------------------------------------------------------------------------------------------

/** Every query token occurs in one of the fields (case-, accent- and harakat-insensitive, §9.5 `foldForMatch`). */
export function matches(query: string, fields: readonly (string | null | undefined)[]): boolean {
  const tokens = foldForMatch(query).split(/\s+/u).filter(Boolean)
  if (tokens.length === 0) return true
  const hay = fields.map((f) => foldForMatch(stripIsolates(f ?? ''))).join('\n')
  return tokens.every((t) => hay.includes(t))
}

/** No-break space: the words of one meta part stay on one line ("3 days ago"). */
const NBSP = String.fromCharCode(0xa0)

/**
 * A row's meta line: its parts joined with the UI separator, each kept whole, so a narrow sidebar wraps the line between
 * parts and never inside one.
 */
export function metaLine(parts: readonly (string | null | undefined | false)[]): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p !== '')
    .map((p) => p.replace(/ /gu, NBSP))
    .join(i18n.t('library.sep'))
}

/** The bidi isolates references carry (§11.3), removed for matching. */
export function stripIsolates(text: string): string {
  return text.replace(/[\u2066-\u2069]/gu, '')
}

/** Every searchable name of the span's surah and its references, for the filters ("kahf", "18:10", "الكهف"). */
export function spanKeywords(span: AyahSpan): string[] {
  const { surah, ayah } = quran.ayahRef(span.from)
  const s = quran.surah(surah)
  const end = quran.ayahRef(span.to)
  return [
    s?.nameSimple,
    s?.nameAr,
    s?.nameComplex,
    s?.nameEn,
    `${surah}:${ayah}`,
    span.to !== span.from ? `${end.surah}:${end.ayah}` : '',
  ].filter((x): x is string => typeof x === 'string' && x !== '')
}

/**
 * A plain one-paragraph excerpt of a Markdown note body (the panel never renders the body itself): markup, links and
 * line breaks are flattened.
 */
export function noteExcerpt(body: string, max = 240): string {
  const flat = body
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gmu, '')
    .replace(/[*_~`]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat
}

/** The first line of a note (its title when it has none). */
export function noteHeadline(title: string | null, body: string): string {
  if (title !== null && title.trim() !== '') return title
  const first = body.split('\n').find((l) => l.trim() !== '') ?? ''
  return noteExcerpt(first, 80)
}

// --- days ----------------------------------------------------------------------------------------------------------------

/** Local midnight of the day of a Unix time (seconds), as ms. */
function dayStart(secs: number): number {
  const d = new Date(secs * 1000)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** "Today", "Yesterday", "Monday" (this week), else the date. */
export function dayLabel(secs: number, nowMs: number = Date.now()): string {
  const today = dayStart(nowMs / 1000)
  const day = dayStart(secs)
  const days = Math.round((today - day) / 86_400_000)
  if (days <= 0) return i18n.t('library.history.today')
  if (days === 1) return i18n.t('library.history.yesterday')
  if (days < 7) return new Intl.DateTimeFormat(i18n.intlLocale, { weekday: 'long' }).format(day)
  return i18n.date(secs)
}

/** Items grouped by local day, in their order. */
export function groupByDay<T>(items: readonly T[], at: (item: T) => number): { day: number; items: T[] }[] {
  const out: { day: number; items: T[] }[] = []
  for (const item of items) {
    const day = dayStart(at(item))
    const last = out.at(-1)
    if (last && last.day === day) last.items.push(item)
    else out.push({ day, items: [item] })
  }
  return out
}

/** A clock time ("14:05", locale digits). */
export function clockTime(secs: number): string {
  return new Intl.DateTimeFormat(i18n.intlLocale, { hour: 'numeric', minute: '2-digit' }).format(secs * 1000)
}

// --- colours -------------------------------------------------------------------------------------------------------------

/** The solid swatch colour of a highlight colour (§9.2). */
export function swatch(color: HighlightColor): string {
  return `var(--user-hl-${color}-solid)`
}

// --- per-viewer preferences ----------------------------------------------------------------------------------------------

const PREFS_KEY = 'qd-library-panels-v1'

export type BookmarkSort = 'recent' | 'mushaf'

interface PanelPrefsData {
  bookmarkSort: BookmarkSort
  /** The Bookmarks panel's collection filter (`null`: all bookmarks). */
  collectionId: string | null
  /** The Highlights panel's colour filter (`null`: every colour). */
  highlightColor: HighlightColor | null
}

const DEFAULT_PREFS: PanelPrefsData = { bookmarkSort: 'recent', collectionId: null, highlightColor: null }

function loadPrefs(): PanelPrefsData {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null')
    if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_PREFS }
    const r = raw as Partial<Record<keyof PanelPrefsData, unknown>>
    return {
      bookmarkSort: r.bookmarkSort === 'mushaf' ? 'mushaf' : 'recent',
      collectionId: typeof r.collectionId === 'string' ? r.collectionId : null,
      highlightColor:
        typeof r.highlightColor === 'string' &&
        ['yellow', 'green', 'blue', 'red', 'purple'].includes(r.highlightColor)
          ? (r.highlightColor as HighlightColor)
          : null,
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

/** The panels' sort order and filters: per viewer, remembered across sessions when storage allows. */
class PanelPrefs {
  #data = $state<PanelPrefsData>(loadPrefs())

  get bookmarkSort(): BookmarkSort {
    return this.#data.bookmarkSort
  }
  set bookmarkSort(v: BookmarkSort) {
    this.#data.bookmarkSort = v
    this.#save()
  }

  get collectionId(): string | null {
    return this.#data.collectionId
  }
  set collectionId(v: string | null) {
    this.#data.collectionId = v
    this.#save()
  }

  get highlightColor(): HighlightColor | null {
    return this.#data.highlightColor
  }
  set highlightColor(v: HighlightColor | null) {
    this.#data.highlightColor = v
    this.#save()
  }

  reset(): void {
    this.#data = { ...DEFAULT_PREFS }
    this.#save()
  }

  #save(): void {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.#data))
    } catch {
      // Blocked or full storage: the choice lasts for this session.
    }
  }
}

export const panelPrefs = new PanelPrefs()

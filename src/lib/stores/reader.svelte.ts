/**
 * `reader` store: the page, the reading cursor and the selection, the viewport fit and zoom, page turns and flipping,
 * navigation history, the follow-along and the reading position. Layer L2: may import `player` (never `memo`).
 *
 * - **Pages.** `page` is the page the reader asked for; `visiblePages` is what is on screen, in reading (RTL) order: a
 *   spread is `[odd, odd + 1]` (page 604 pairs with 603), single-page mode shows `page` alone. The fit (`spread`,
 *   `dock`, `qfs`, `scrolls`) comes from `fitLayout` over the canvas size, the page mode and the zoom.
 * - **Turns** go through `transitions.ts` (`turnTo`: readiness wait, staggered view transition, one pending turn);
 *   the reader is its `TurnHost`. Key repeat flips instead (`flip`): instant, 1 page per 70 ms, prefetching ±8 pages
 *   in the flip direction. A manual turn clears a selection that lies entirely off the visible pages.
 * - **Cursor and selection**: one reading cursor; `select` follows `nextSelection` (`interactions.ts`) and pins the
 *   side pane (`paneFollow = 'selection'`); cursor moves select the ayah, turn the page when they cross it and move DOM
 *   focus to the ayah's roving item. `actionTarget` is the visible selection, else the visible cursor, else the first
 *   visible ayah. "Visible" is what is on screen: the ayahs of the visible pages, or in translation mode the verses
 *   its feed shows (`translationRows`, measured from the view as it scrolls), never a cursor left far above.
 * - **Focus across turns**: a turn that takes the focused roving item off screen moves focus to the new view's tab
 *   stop once it renders (after a flip, once it settles), so the keyboard never drops to `<body>`.
 * - **Jumps** (`goToAyah` and friends) are recorded in `navBack`/`navFwd` (Alt+←/→, mouse buttons 4/5), may flash the
 *   ayah (`flash`, drawn by the highlight layer for 1.2 s), and with `focus` move focus to the ayah and announce it
 *   ("Al-Baqarah 2:255, page 42"). A range jump (`selectTo`, Go to "2:255-257") selects the range and flashes,
 *   focuses and announces its first ayah. A newer jump, or the user moving the cursor before it lands, cancels that.
 * - **Follow-along**: while the recitation plays with `followAlong` on, the page turns to the recited word's page.
 *   After a manual navigation in the last 4 s it does not turn; `followChip` then offers "Return to recitation".
 * - **Persistence**: the reading position of the current mode is written 1 s after it settles (`history.setPosition`),
 *   and a page read for 3 s is recorded in the history (`history.record`, dwell counted while the window is visible,
 *   topped up every minute and when leaving the page). Hiding the window and quitting (`app.beforeQuit`) write
 *   both at once, and a quit waits for them.
 * - **Startup**: the position of the reading mode, mapped into the current layout; first run opens pages 1–2.
 *
 * `init` also registers the navigation and view shortcuts, the deep-navigation handler (`ui.onNavigate`) and the
 * mouse back/forward buttons. The shortcut files import this store only inside their handlers.
 */
import { tick, untrack } from 'svelte'
import { SETTING_LIMITS } from '$lib/contracts/settings'
import type { Dock, Store } from '$lib/contracts/stores'
import type {
  Bootstrap,
  HistoryInput,
  MushafLayout,
  MushafStyle,
  NavTarget,
  PageMode,
  ReadingPosition,
} from '$lib/ipc/bindings'
import { a11yItemId } from '$lib/mushaf/a11y'
import { fitLayout, PAGE_COUNT } from '$lib/mushaf/geometry'
import { cancelTurns, setTurnHost, turnTo, type TurnDir } from '$lib/mushaf/transitions'
import { glyphKey, shapeWarmer } from '$lib/mushaf/warmup'
import { navigationShortcuts } from '$lib/shortcuts/navigation'
import { viewShortcuts } from '$lib/shortcuts/view'
import { app } from './app.svelte'
import { aroundPages, fonts } from './fonts.svelte'
import { history } from './history.svelte'
import { i18n } from './i18n.svelte'
import { pages } from './pages.svelte'
import { player } from './player.svelte'
import { quran } from './quran.svelte'
import { settings } from './settings.svelte'
import { shortcuts } from './shortcuts.svelte'
import { translations } from './translations.svelte'
import { RAIL_W, TITLEBAR_H, ui } from './ui.svelte'

/** A navigation-history location. */
export interface Loc {
  page: number
  ayahId: number | null
}

export interface Selection {
  fromAyahId: number
  toAyahId: number
  anchorAyahId: number
}

export interface GoToAyahOptions {
  /** Select the ayah (pins the side pane to it). */
  select?: boolean
  /**
   * With `select`: select the range from the ayah to this one (Go to "2:255-257", a range note). The jump's first ayah
   * still flashes, takes focus and is announced, with the range.
   */
  selectTo?: number
  /** Mark these words with the search-hit layer (`searchHit`). */
  highlightWords?: number[]
  /** Flash the ayah on arrival (the highlight layer draws it). */
  flash?: boolean
  /** Move focus to the ayah once it renders and announce it. */
  focus?: boolean
}

export interface GoToPageOptions {
  /** Record the jump in the navigation history (default true). */
  push?: boolean
  /** Animate the turn (default true; reduced motion and the setting still apply). */
  transition?: boolean
}

const LAYOUT_OF: Record<MushafStyle, MushafLayout> = { hafs: 'v2', qcf_v2: 'v2', qcf_v1: 'v1', qcf_v4: 'v4' }
/** The spread stage `MushafView` renders (`SpreadStage`); turns animate only while it is on screen. */
export const STAGE_SELECTOR = '[data-qd-stage]'
/** The view's one roving tab stop among the pages' ayah items (A11yLayer). */
export const A11Y_TAB_STOP = `${STAGE_SELECTOR} .mp-a11y li[tabindex="0"]`
/** Translation mode's feed (TranslationView: its scroller and its verse rows `#tv-a{ayahId}`). */
const TRANSLATION_FEED = '[data-qd-view="translation"] .qd-virtual-list'
const VERSE_ROW_ID = /^tv-a(\d+)$/
const PAGE_MODES: readonly PageMode[] = ['auto', 'single', 'spread']

/** Flipping turns at most one page per this long. */
export const FLIP_INTERVAL_MS = 70
/** Flipping ends this long after the last flip (then the page settles: prefetch, announcement, history). */
export const FLIP_SETTLE_MS = 250
/** How long an arrival flash lasts (`flash.until`, drawn by `HighlightLayer`). */
export const FLASH_MS = 1200
/** A manual navigation holds the follow-along this long. */
export const MANUAL_HOLD_MS = 4000
/** The reading position is written this long after it settles. */
export const POSITION_DEBOUNCE_MS = 1000
/** A page is recorded in the history after this much (visible) dwell. */
export const HISTORY_DWELL_MS = 3000
/** While the reader stays on a page, the dwell is topped up this often. */
export const HISTORY_FLUSH_MS = 60_000
/** Navigation history depth (each direction). */
export const NAV_HISTORY_MAX = 50

/** The selection after selecting `ayahId` (the semantics of `nextSelection` in `interactions.ts`). */
export function nextSelection(
  current: Selection | null,
  cursorAyahId: number | null,
  ayahId: number,
  extend: boolean,
): Selection {
  const anchor = extend ? (current?.anchorAyahId ?? cursorAyahId ?? ayahId) : ayahId
  return { fromAyahId: Math.min(anchor, ayahId), toAyahId: Math.max(anchor, ayahId), anchorAyahId: anchor }
}

/** The pages on screen for a requested page: a spread is `[odd, odd + 1]`, page 604 pairs with 603. */
export function spreadPages(page: number, spread: boolean, last: number = PAGE_COUNT): number[] {
  if (!spread) return [page]
  const odd = page >= last && last % 2 === 0 ? last - 1 : page % 2 === 1 ? page : page - 1
  return odd + 1 <= last ? [odd, odd + 1] : [odd]
}

const sameSelection = (a: Selection | null, b: Selection | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.fromAyahId === b.fromAyahId &&
    a.toAyahId === b.toAyahId &&
    a.anchorAyahId === b.anchorAyahId)

/** What a committed page change does besides moving the page. */
interface CommitMeta {
  /** The user asked for it (a selection off the new pages is cleared; the follow-along holds). */
  manual: boolean
  /** Someone else announces the arrival (a focused jump). */
  quiet: boolean
  /** Someone else moves focus on arrival (a focused jump, a cursor move): the turn leaves focus alone. */
  focuses: boolean
}

/** Whether focus is on a roving ayah item of the Mushaf (A11yLayer). */
function a11yHasFocus(): boolean {
  return typeof document !== 'undefined' && document.activeElement?.closest('.mp-a11y') != null
}

/**
 * The verses translation mode shows: the verse rows of its feed that reach into the feed's viewport (rows virtua keeps
 * mounted off screen, or hidden until measured, do not count). `null` without a feed or a row on screen.
 */
function translationRowsOnScreen(): { from: number; to: number } | null {
  if (typeof document === 'undefined') return null
  const feed = document.querySelector<HTMLElement>(TRANSLATION_FEED)
  if (!feed) return null
  const view = feed.getBoundingClientRect()
  let from = Number.POSITIVE_INFINITY
  let to = Number.NEGATIVE_INFINITY
  for (const row of feed.querySelectorAll<HTMLElement>('[id^="tv-a"]')) {
    const id = Number(VERSE_ROW_ID.exec(row.id)?.[1])
    if (!Number.isInteger(id) || id <= 0) continue
    const r = row.getBoundingClientRect()
    if (r.height <= 0 || r.bottom <= view.top || r.top >= view.bottom) continue
    if (typeof row.checkVisibility === 'function' && !row.checkVisibility({ visibilityProperty: true }))
      continue
    from = Math.min(from, id)
    to = Math.max(to, id)
  }
  return from <= to ? { from, to } : null
}

/** The visible-time dwell on one place, for the history. */
interface Dwell {
  key: string
  input: Omit<HistoryInput, 'dwellS'>
  /** Visible milliseconds accumulated before `since`. */
  shownMs: number
  /** When the current visible stretch started (`performance.now()`), or `null` while hidden. */
  since: number | null
  /** Seconds already recorded. */
  recordedS: number
  timer: ReturnType<typeof setTimeout> | undefined
}

class ReaderStore implements Store {
  page = $state(1)
  /** The single reading cursor. */
  cursorAyahId = $state<number | null>(null)
  selection = $state.raw<Selection | null>(null)
  /** The side pane follows the selection (pinned by an explicit selection) or the recitation. */
  paneFollow = $state<'selection' | 'audio'>('audio')
  hover = $state.raw<{ ayahId: number; wordId: number } | null>(null)
  searchHit = $state.raw<{ ayahId: number; wordIds: number[] } | null>(null)
  /** An arrival flash: `until` is a `Date.now()` time (`HighlightLayer`). */
  flash = $state.raw<{ ayahId: number; until: number } | null>(null)
  viewport = $state.raw({ w: 0, h: 0 })
  /** How far above the canvas bottom the book must end for a persistent overlay-slot bar (`setViewport`). */
  #clearBottom = $state(0)
  navBack = $state.raw<Loc[]>([])
  navFwd = $state.raw<Loc[]>([])
  /** A page turn (or a chain of them) is in progress (`transitions.ts`). */
  turning = $state(false)
  /** Key-repeat flipping is in progress (`FlipHUD`). */
  flipping = $state(false)
  /** The recitation's page is off screen after a manual navigation; `FollowChip` offers to return. */
  followChip = $state(false)
  /** `P`: bumped to ask the page rail (`PageRail`) to show and take focus. */
  railRequest = $state(0)
  /** A request to scroll an ayah into view on a canvas that scrolls (cursor keys, jumps), read by `MushafView`. */
  revealRequest = $state.raw<{ ayahId: number; seq: number } | null>(null)
  /**
   * The verses translation mode has on screen (its feed's rows inside the viewport), measured a frame after the feed
   * scrolls, reflows or loads text; `null` in Mushaf mode and until the feed has laid out (what `isVisible` means
   * there).
   */
  translationRows = $state.raw<{ from: number; to: number } | null>(null)
  /**
   * The client point the next zoom keeps under the pointer (`zoomAt`); `null` keeps the canvas centre. Read once by
   * `MushafView` when `qfs` changes (`takeZoomAnchor`).
   */
  #zoomAnchor: { x: number; y: number } | null = null

  readonly style: MushafStyle = $derived(settings.value.mushafStyle)
  readonly layout: MushafLayout = $derived(LAYOUT_OF[this.style])
  readonly zoomPct = $derived(settings.value.zoomPct)
  /** Pages of the current layout (604; the full Mushaf before the index is loaded). */
  readonly #lastPage = $derived(quran.pageCount(this.layout) || PAGE_COUNT)
  /**
   * The canvas size from the shell layout: the window minus the title bar, the rail, a docked sidebar and a
   * docked side pane. Used until `MushafView` measures the canvas, and while it is not mounted (translation mode, other
   * views), so the dock placement and `qfs` always follow the window.
   */
  readonly #estimatedCanvas = $derived.by(() => {
    const { w, h } = ui.windowSize
    if (w <= 0 || h <= 0) return { w: 0, h: 0 }
    if (ui.zen) return { w, h }
    const sidebar = ui.sidebarOpen && !ui.sidebarOverlay ? settings.value.sidebar.widthPx : 0
    const pane = ui.sidePaneOpen && ui.paneDocked ? ui.paneWidthPx : 0
    return { w: Math.max(0, w - RAIL_W - sidebar - pane), h: Math.max(0, h - TITLEBAR_H) }
  })
  /** The canvas the fit uses: `MushafView`'s measurement while it is mounted, else the estimate. */
  readonly #canvas = $derived(
    this.viewport.w > 0 && this.viewport.h > 0 ? this.viewport : this.#estimatedCanvas,
  )
  readonly #fit = $derived(
    fitLayout(this.#canvas.w, this.#canvas.h, settings.value.pageMode, this.zoomPct, this.#clearBottom),
  )
  readonly spread = $derived(this.#fit.spread)
  readonly dock: Dock = $derived(this.#fit.dock)
  readonly qfs = $derived(this.#fit.qfs)
  /** The canvas scrolls (zoomed past the fit, or `qfs` held at `QFS_MIN`): the wheel scrolls, turns do not animate. */
  readonly scrolls = $derived(this.#fit.scroll)
  /** Pages in RTL reading order: a spread is `[odd, odd + 1]` (page 604 pairs with 603). */
  readonly visiblePages: number[] = $derived(spreadPages(this.page, this.spread, this.#lastPage))
  readonly pageBox = $derived({ w: this.qfs * 21, h: this.qfs * 31.95 })
  /** The ayahs with words on the visible pages (`{ from: 0, to: -1 }` before the index is loaded). */
  readonly visibleRange: { from: number; to: number } = $derived.by(() => {
    const first = quran.pageRange(this.layout, this.visiblePages[0] ?? this.page)
    const last = quran.pageRange(this.layout, this.visiblePages.at(-1) ?? this.page)
    return { from: first.from, to: Math.max(first.to, last.to) }
  })
  /**
   * The ayah being read: in translation mode the verse at the top of the view (`translations.topAyahId`), else the
   * first ayah of the first visible page. Drives the breadcrumb (`headSurah`, `juz`).
   */
  readonly currentAyahId: number = $derived(
    settings.value.readingMode === 'translation' && translations.topAyahId !== null
      ? translations.topAyahId
      : this.visibleRange.from,
  )
  readonly headSurah = $derived(quran.ayahRef(this.currentAyahId).surah)
  readonly juz = $derived(quran.juzOf(this.currentAyahId))
  /**
   * The ayahs on screen: those of the visible pages; in translation mode the verses its feed shows (`translationRows`),
   * else, until it has laid out, the verse it is reading (`{ from: 0, to: -1 }`: none known).
   */
  readonly #onScreen: { from: number; to: number } = $derived.by(() => {
    if (settings.value.readingMode !== 'translation') return this.visibleRange
    const top = translations.topAyahId
    return this.translationRows ?? (top !== null ? { from: top, to: top } : { from: 0, to: -1 })
  })
  /** The visible selection, else the visible cursor, else the first visible ayah. Always an ayah id. */
  readonly actionTarget: number = $derived.by(() => {
    const sel = this.selection
    if (sel && this.isVisible(sel.fromAyahId, sel.toAyahId)) return sel.fromAyahId
    const cursor = this.cursorAyahId
    if (cursor !== null && this.isVisible(cursor)) return cursor
    return this.currentAyahId
  })
  /**
   * The page the recitation is on, while it plays with `followAlong` in Mushaf mode: the page of the recited
   * word, else of the ayah's first word, else (basmala) of the surah's first ayah. `null` otherwise.
   */
  readonly followTarget: number | null = $derived.by(() => {
    if (!settings.value.followAlong || !player.isActive || settings.value.readingMode !== 'mushaf')
      return null
    const layout = this.layout
    const word = player.activeWord?.wordId
    if (word !== undefined && word > 0) return quran.pageOfWord(layout, word)
    const ayah = player.currentAyahId
    if (ayah !== null && quran.isAyahId(ayah)) return quran.pageOfAyah(layout, ayah)
    const heard = player.heard
    if (heard && heard.ayah === 0 && heard.surah > 0) {
      const first = quran.ayahId(heard.surah, 1)
      if (first > 0) return quran.pageOfAyah(layout, first)
    }
    return null
  })

  /** Where the reading position stands in Mushaf mode: the visible cursor, else the first visible ayah. */
  readonly #positionAyah = $derived.by(() => {
    const cursor = this.cursorAyahId
    return cursor !== null && this.isVisible(cursor) ? cursor : this.visibleRange.from
  })

  /** The page the latest turn request is heading to (next/prev count on from it). */
  #target: number | null = null
  #commits = new Map<number, CommitMeta>()
  #manualAt = Number.NEGATIVE_INFINITY
  /** The follow-along target the user dismissed the chip for (Esc / ×). */
  #dismissedTarget: number | null = null
  #lastFlipAt = Number.NEGATIVE_INFINITY
  #pendingFlip: TurnDir | null = null
  #flipTimer: ReturnType<typeof setTimeout> | undefined
  #flipEnd: ReturnType<typeof setTimeout> | undefined
  #revealSeq = 0
  /** Bumped by every jump (`goToAyah`): a jump still on its way after a newer one never flashes or takes focus. */
  #jumpSeq = 0
  /** A flip took the focused roving item off screen: its settle moves focus to the new tab stop. */
  #refocusAfterFlip = false
  /** The frame that measures translation mode's rows (`translationRows`), when one is scheduled. */
  #rowsFrame: (() => void) | null = null
  #positionTimer: ReturnType<typeof setTimeout> | undefined
  #pendingPosition: ReadingPosition | null = null
  #lastPositionKey = ''
  /** Position and history writes on their way (`#track`). */
  #writes = new Set<Promise<void>>()
  #dwell: Dwell | null = null
  #prefetchHandle: (() => void) | null = null
  #disposers: (() => void)[] = []

  /** Restores the position of the current reading mode, mapped into the current layout; else pages 1–2. */
  init(b: Bootstrap): void {
    this.#dispose()
    const context = b.settings.readingMode === 'translation' ? 'translation' : 'mushaf'
    const position = b.positions.find((p) => p.context === context)
    const layout = LAYOUT_OF[b.settings.mushafStyle]
    if (position && quran.isAyahId(position.ayahId)) {
      const page =
        position.layout === layout && position.page !== null
          ? position.page
          : quran.pageOfAyah(layout, position.ayahId)
      this.page = this.#clampPage(page)
      // The cursor on the restored ayah, with no visible selection.
      this.cursorAyahId = position.ayahId
      this.#lastPositionKey = positionKey(position)
    } else {
      this.page = 1
      this.cursorAyahId = null
    }

    this.#disposers.push(
      setTurnHost({
        style: () => this.style,
        pagesFor: (p) => this.pagesFor(p),
        setPageNow: (p) => this.setPageNow(p),
        // The spread stage is mounted (MushafView) and fits the canvas: a zoomed spread would overflow it while animating.
        canAnimate: () =>
          this.#mushafShown() && !this.scrolls && document.querySelector(STAGE_SELECTOR) !== null,
        setTurning: (on) => {
          this.turning = on
          if (!on) this.#target = null
        },
        // The neighbours are warmed in idle time (MushafView); a page that is not yet draws without the transition.
        glyphsReady: (p) =>
          this.style === 'hafs' || shapeWarmer.hasGlyphsNow(glyphKey(this.style, p, this.qfs)),
      }),
      shortcuts.register([...navigationShortcuts, ...viewShortcuts]),
      ui.onNavigate((target) => this.#navigateRequest(target)),
      this.#listenMouseButtons(),
      this.#listenVisibility(),
      this.#listenTranslationFeed(),
      app.beforeQuit(() => this.#beforeQuit()),
      $effect.root(() => this.#effects()),
    )
  }

  // --- pages and turns -----------------------------------------------------------------------------------------------

  /** The pages that would be on screen with `page` as the reader's page. */
  pagesFor(page: number): number[] {
    return spreadPages(this.#clampPage(page), this.spread, this.#lastPage)
  }

  /**
   * Whether an ayah (or a range) is on screen: has words on the visible pages, or in translation mode a verse row the
   * feed shows (`translationRows`).
   */
  isVisible(from: number, to: number = from): boolean {
    const r = this.#onScreen
    return r.to >= r.from && to >= r.from && from <= r.to
  }

  /**
   * Goes to a page. A jump (`push`, default) is recorded in the navigation history; the turn animates unless
   * `transition: false`. In translation mode the page only follows the view (no history unless asked, no
   * selection change, no announcement).
   */
  goToPage(page: number, opts: GoToPageOptions = {}): void {
    void this.#navigate(page, { push: opts.push ?? true, transition: opts.transition ?? true, manual: true })
  }

  /** Goes to an ayah's page and puts the cursor there; see `GoToAyahOptions`. */
  goToAyah(ayahId: number, opts: GoToAyahOptions = {}): void {
    void this.#goToAyah(ayahId, opts)
  }

  /** The first ayah of a surah, flashed. */
  goToSurah(surah: number): void {
    const { from } = quran.surahRange(surah)
    if (from > 0) this.goToAyah(from, { flash: true })
  }

  goToJuz(juz: number): void {
    const { from } = quran.juzRange(juz)
    if (from > 0) this.goToAyah(from, { flash: true })
  }

  goToHizb(hizb: number): void {
    const { from } = quran.hizbRange(hizb)
    if (from > 0) this.goToAyah(from, { flash: true })
  }

  /** The next page (single) or spread, animated. */
  next(): void {
    const target = this.#step('next')
    if (target !== null) void this.#navigate(target, { push: false, transition: true, manual: true })
  }

  /** The previous page or spread, animated. */
  prev(): void {
    const target = this.#step('prev')
    if (target !== null) void this.#navigate(target, { push: false, transition: true, manual: true })
  }

  /**
   * Key-repeat flipping: renders the next page at once, without the view transition (the fallback rendition
   * if its font is not ready), at most one page per 70 ms with a single pending flip, prefetching ±8 pages ahead.
   */
  flip(dir: TurnDir): void {
    if (!this.#mushafShown()) {
      if (dir === 'next') this.next()
      else this.prev()
      return
    }
    const now = performance.now()
    const wait = FLIP_INTERVAL_MS - (now - this.#lastFlipAt)
    if (wait > 0) {
      this.#pendingFlip = dir
      this.#flipTimer ??= setTimeout(() => {
        this.#flipTimer = undefined
        const pending = this.#pendingFlip
        this.#pendingFlip = null
        if (pending) this.#flipStep(pending)
      }, wait)
      return
    }
    this.#flipStep(dir)
  }

  /** Alt+← / mouse button 4: back to where the last jump started. */
  back(): void {
    const loc = this.navBack.at(-1)
    if (!loc) return
    this.navBack = this.navBack.slice(0, -1)
    this.navFwd = [...this.navFwd, this.#here()].slice(-NAV_HISTORY_MAX)
    this.#goLoc(loc)
  }

  /** Alt+→ / mouse button 5. */
  forward(): void {
    const loc = this.navFwd.at(-1)
    if (!loc) return
    this.navFwd = this.navFwd.slice(0, -1)
    this.navBack = [...this.navBack, this.#here()].slice(-NAV_HISTORY_MAX)
    this.#goLoc(loc)
  }

  /** Shift+← / Shift+→: the next surah starting after the visible pages, or the last one starting before them. */
  surahStep(delta: 1 | -1): void {
    const layout = this.layout
    const visible = this.visiblePages
    const lo = Math.min(...visible)
    const hi = Math.max(...visible)
    const surahs = quran.index.surahs
    const startOf = (s: { firstAyahId: number }) => quran.pageOfAyah(layout, s.firstAyahId)
    const found = delta > 0 ? surahs.find((s) => startOf(s) > hi) : surahs.findLast((s) => startOf(s) < lo)
    if (found) this.goToSurah(found.id)
  }

  /** Mod+Home / Mod+End: the first or the last page. */
  edgePage(which: 'first' | 'last'): void {
    this.goToPage(which === 'first' ? 1 : this.#lastPage)
  }

  /**
   * Commits a page at once (the `TurnHost` side of a turn): moves the page, clears the hover, and for a manual change
   * clears a selection that lies entirely off the new pages and announces the pages. When the keyboard
   * was on a roving item of the pages leaving the screen, focus moves to the new view's tab stop (after a flip, once it
   * settles), unless the navigation moves focus itself; the cursor stays where it is.
   */
  setPageNow(page: number): void {
    const p = this.#clampPage(page)
    const meta = this.#commits.get(p) ?? { manual: false, quiet: false, focuses: false }
    this.#commits.delete(p)
    if (this.#target === p) this.#target = null
    if (p === this.page) return
    const before = this.visiblePages
    const keepFocus = !meta.focuses && this.#mushafShown() && a11yHasFocus()
    this.page = p
    if (this.hover !== null) this.hover = null
    if (!this.#mushafMode()) return
    const sel = this.selection
    if (meta.manual && sel && !this.isVisible(sel.fromAyahId, sel.toAyahId)) this.clearSelection()
    const after = this.visiblePages
    if (!this.flipping && !meta.quiet && after.join() !== before.join()) this.#announcePages(after)
    if (keepFocus) {
      if (this.flipping) this.#refocusAfterFlip = true
      else void this.#refocusTabStop()
    }
  }

  // --- cursor and selection ------------------------------------------------------------------------------------------

  /**
   * ↓/↑, j/k: the cursor to the next/previous ayah, selecting it (`extend`: extending the selection). A cursor
   * that is off screen starts from the visible pages. Crossing a page edge turns the page; DOM focus follows to the
   * ayah's roving item, and a scrolled canvas brings the ayah into view.
   */
  moveCursor(delta: 1 | -1, opts: { extend?: boolean } = {}): void {
    const count = quran.ayahCount
    if (count <= 0) return
    const cursor = this.cursorAyahId
    const range = this.#onScreen
    let target: number
    if (cursor === null || !this.isVisible(cursor)) {
      if (range.to < range.from) return
      target = delta > 0 ? range.from : range.to
    } else {
      target = Math.min(count, Math.max(1, cursor + delta))
    }
    this.select(target, opts.extend === true && this.#canExtend())
    void this.#arrive(target, { focus: true })
  }

  /** Home / End: the first or the last ayah on the visible pages. */
  cursorToEdge(which: 'first' | 'last', opts: { extend?: boolean } = {}): void {
    const range = this.visibleRange
    if (range.to < range.from) return
    const target = which === 'first' ? range.from : range.to
    this.select(target, opts.extend === true && this.#canExtend())
    void this.#arrive(target, { focus: true })
  }

  /** Selects an ayah, or extends the selection to it; the cursor moves there and the pane pins to it. */
  select(ayahId: number, extend = false): void {
    if (!quran.isAyahId(ayahId)) return
    const next = nextSelection(this.selection, this.cursorAyahId, ayahId, extend)
    if (!sameSelection(this.selection, next)) this.selection = next
    if (this.cursorAyahId !== ayahId) this.cursorAyahId = ayahId
    this.paneFollow = 'selection'
  }

  clearSelection(): void {
    if (this.selection !== null) this.selection = null
    this.paneFollow = 'audio'
  }

  /** The "Follow recitation" chip of the side pane: the pane follows the recitation again. */
  followRecitation(): void {
    this.paneFollow = 'audio'
  }

  setHover(ayahId: number | null, wordId: number | null): void {
    this.hover = ayahId !== null && wordId !== null ? { ayahId, wordId } : null
  }

  /**
   * The reader's Escape (after the layers): clears the selection and the search hit, else dismisses the
   * "Return to recitation" chip. Returns whether it did anything.
   */
  escape(): boolean {
    if (this.selection !== null || this.searchHit !== null) {
      this.clearSelection()
      this.searchHit = null
      return true
    }
    if (this.followChip) {
      this.dismissFollowChip()
      return true
    }
    return false
  }

  // --- follow-along --------------------------------------------------------------------------------------------------

  /** `FollowChip`: turn to the recitation and follow it again. */
  returnToRecitation(): void {
    const target = this.followTarget
    this.followChip = false
    this.#dismissedTarget = null
    this.#manualAt = Number.NEGATIVE_INFINITY
    if (target === null || this.visiblePages.includes(target)) return
    void this.#navigate(target, { push: false, transition: true, manual: false })
  }

  /** `FollowChip` × or Escape: hide it until the recitation reaches another page. */
  dismissFollowChip(): void {
    this.#dismissedTarget = this.followTarget
    this.followChip = false
  }

  // --- zoom and view -------------------------------------------------------------------------------------------------

  zoomIn(): void {
    this.zoomAt(SETTING_LIMITS.zoomPct.step, Number.NaN, Number.NaN)
  }

  zoomOut(): void {
    this.zoomAt(-SETTING_LIMITS.zoomPct.step, Number.NaN, Number.NaN)
  }

  /** `Mod+0`: back to the fit (100 %). */
  zoomReset(): void {
    this.zoomAt(100 - this.zoomPct, Number.NaN, Number.NaN)
  }

  /**
   * Zooms by `delta` percent (50–300 %, steps of 10) keeping the client point (`x`, `y`) under the pointer, or the
   * canvas centre when the point is not finite. `MushafView` applies the scroll anchor once `qfs` changes.
   */
  zoomAt(delta: number, x: number, y: number): void {
    const { min, max, step } = SETTING_LIMITS.zoomPct
    const current = this.zoomPct
    const next = Math.min(max, Math.max(min, Math.round((current + delta) / step) * step))
    if (next === current || !Number.isFinite(next)) return
    this.#zoomAnchor = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
    void settings.update({ zoomPct: next })
  }

  /** The anchor of the zoom that changed `qfs` (consumed once by `MushafView`; `null` = the canvas centre). */
  takeZoomAnchor(): { x: number; y: number } | null {
    const anchor = this.#zoomAnchor
    this.#zoomAnchor = null
    return anchor
  }

  /**
   * `MushafView` reports the canvas size it measures (CSS px); `0 × 0` when it unmounts (the estimate takes over). With
   * `clearBottom`, the book ends that far above the canvas bottom: a bar stays in the overlay slot for the whole
   * memorisation mode (`slotClearance`); it caps `qfs` without moving the dock (`fitLayout`).
   */
  setViewport(w: number, h: number, clearBottom = 0): void {
    if (w !== this.viewport.w || h !== this.viewport.h) this.viewport = { w, h }
    if (clearBottom !== this.#clearBottom) this.#clearBottom = clearBottom
  }

  /** `D`: page mode auto → single → spread → auto; announced. */
  cyclePageMode(): void {
    const current = settings.value.pageMode
    const next = PAGE_MODES[(PAGE_MODES.indexOf(current) + 1) % PAGE_MODES.length] ?? 'auto'
    void settings.update({ pageMode: next })
    ui.toast({ message: i18n.t('reader.pageMode.changed', { mode: i18n.t(`reader.pageMode.${next}`) }) })
  }

  /** `T`: Mushaf ↔ translation, keeping the reading position by ayah. */
  toggleReadingMode(): void {
    const toMushaf = settings.value.readingMode === 'translation'
    if (toMushaf) {
      const top = translations.topAyahId
      if (top !== null && quran.isAyahId(top)) {
        this.page = this.#clampPage(quran.pageOfAyah(this.layout, top))
        this.cursorAyahId = top
      }
    }
    const mode = toMushaf ? 'mushaf' : 'translation'
    void settings.update({ readingMode: mode })
    ui.announce(i18n.t(`reader.mode.${mode}`))
  }

  /** `P`: ask the page rail (`PageRail`) to show and take focus. */
  revealRail(): void {
    this.railRequest += 1
  }

  reset(): void {
    this.#dispose()
    clearTimeout(this.#flipTimer)
    clearTimeout(this.#flipEnd)
    clearTimeout(this.#positionTimer)
    this.#flipTimer = undefined
    this.#flipEnd = undefined
    this.#positionTimer = undefined
    this.#pendingPosition = null
    this.#lastPositionKey = ''
    this.#target = null
    this.#commits.clear()
    this.#manualAt = Number.NEGATIVE_INFINITY
    this.#dismissedTarget = null
    this.#lastFlipAt = Number.NEGATIVE_INFINITY
    this.#pendingFlip = null
    this.#refocusAfterFlip = false
    this.#zoomAnchor = null
    this.translationRows = null
    this.page = 1
    this.cursorAyahId = null
    this.selection = null
    this.paneFollow = 'audio'
    this.hover = null
    this.searchHit = null
    this.flash = null
    this.viewport = { w: 0, h: 0 }
    this.#clearBottom = 0
    this.navBack = []
    this.navFwd = []
    this.turning = false
    this.flipping = false
    this.followChip = false
    this.railRequest = 0
    this.revealRequest = null
  }

  // --- internals -----------------------------------------------------------------------------------------------------

  #clampPage(page: number): number {
    const p = Math.round(page)
    return Number.isFinite(p) ? Math.min(this.#lastPage, Math.max(1, p)) : 1
  }

  #mushafMode(): boolean {
    return settings.value.readingMode === 'mushaf'
  }

  /** The Mushaf is the canvas view right now (turns are drawn, focus goes to its roving items). */
  #mushafShown(): boolean {
    return ui.view === 'reader' && this.#mushafMode()
  }

  /** Shift+cursor keys extend a visible selection, or start one from a visible cursor (never from off screen). */
  #canExtend(): boolean {
    const sel = this.selection
    if (sel !== null) return this.isVisible(sel.fromAyahId, sel.toAyahId)
    const cursor = this.cursorAyahId
    return cursor !== null && this.isVisible(cursor)
  }

  /** The page next() / prev() lead to, counting on from a turn still on its way; `null` at the ends. */
  #step(dir: TurnDir): number | null {
    const base = this.#target ?? this.page
    const shown = this.pagesFor(base)
    const target = dir === 'next' ? Math.max(...shown) + 1 : Math.min(...shown) - 1
    return target >= 1 && target <= this.#lastPage ? target : null
  }

  #flipStep(dir: TurnDir): void {
    const target = this.#step(dir)
    this.#lastFlipAt = performance.now()
    if (target === null) return
    cancelTurns()
    this.#target = null
    this.flipping = true
    this.#manualAt = performance.now()
    this.#commits.set(target, { manual: true, quiet: true, focuses: false })
    this.setPageNow(target)
    const style = this.style
    pages.prefetch(style, this.visiblePages, dir)
    fonts.prefetchAround(style, this.page, this.spread, dir === 'next' ? 1 : -1)
    clearTimeout(this.#flipEnd)
    this.#flipEnd = setTimeout(() => {
      this.#flipEnd = undefined
      this.flipping = false
      if (this.#mushafMode()) this.#announcePages(this.visiblePages)
      if (this.#refocusAfterFlip) {
        this.#refocusAfterFlip = false
        void this.#refocusTabStop()
      }
    }, FLIP_SETTLE_MS)
  }

  /**
   * After a turn took the focused roving item off screen: focuses the new view's tab stop once it renders (the cursor's
   * item when it is on screen, else the first ayah, A11yLayer), unless focus has gone somewhere else meanwhile.
   */
  async #refocusTabStop(): Promise<void> {
    await tick()
    const active = document.activeElement
    if (active !== null && active !== document.body && !a11yHasFocus()) return
    await ui.focusWhenRendered(A11Y_TAB_STOP)
  }

  /**
   * Moves to a page: an animated turn when the Mushaf shows, else at once. `push` records a jump in the
   * navigation history; `manual` marks a user navigation (follow-along hold, selection clearing). Resolves whether the
   * page is on screen afterwards.
   */
  async #navigate(
    page: number,
    opts: { push: boolean; transition: boolean; manual: boolean; quiet?: boolean; focuses?: boolean },
  ): Promise<boolean> {
    const target = this.#clampPage(page)
    if (opts.push) this.#pushHistory(target)
    if (!this.#mushafMode()) {
      // Translation mode: the view drives the page; just move it.
      this.page = target
      return true
    }
    if (opts.manual) this.#manualAt = performance.now()
    if (this.visiblePages.includes(target) && this.#target === null) {
      if (this.page !== target) this.page = target
      return true
    }
    const shownBefore = this.pagesFor(this.#target ?? this.page)
    const dir: TurnDir = target > Math.max(...shownBefore) ? 'next' : 'prev'
    this.#commits.set(target, {
      manual: opts.manual,
      quiet: opts.quiet === true,
      focuses: opts.focuses === true,
    })
    this.#target = target
    if (!this.#mushafShown()) {
      this.setPageNow(target)
      return true
    }
    await turnTo(target, dir, { instant: !opts.transition })
    return this.visiblePages.includes(target)
  }

  async #goToAyah(ayahId: number, opts: GoToAyahOptions): Promise<void> {
    if (!quran.isAyahId(ayahId)) return
    const page = this.#clampPage(quran.pageOfAyah(this.layout, ayahId))
    // Where the jump starts (the cursor still on its old ayah) goes into the navigation history first.
    this.#pushHistory(page)
    const words = opts.highlightWords
    this.searchHit = words && words.length > 0 ? { ayahId, wordIds: [...words] } : this.searchHit
    const to = opts.selectTo
    if (opts.select) {
      this.select(ayahId)
      if (to !== undefined && to !== ayahId && quran.isAyahId(to)) this.select(to, true)
    } else if (this.cursorAyahId !== ayahId) this.cursorAyahId = ayahId
    // The jump expects the cursor it leaves when it lands; another jump, or the user moving the cursor meanwhile, wins
    // (no flash, focus or announcement then). A caller that still extends the selection right after this call, in the
    // same task (`select(to, true)`, the older form of `selectTo`), is part of the jump: the cursor is read again once
    // that task has ended.
    const jump = ++this.#jumpSeq
    let expected = this.cursorAyahId
    queueMicrotask(() => {
      if (jump === this.#jumpSeq) expected = this.cursorAyahId
    })
    /** The far end of the range the jump selected ("Al-Baqarah 2:255–257, page 42"). */
    const rangeEnd = (): number | undefined => {
      const sel = this.selection
      return opts.select && sel?.fromAyahId === ayahId && sel.toAyahId > ayahId ? sel.toAyahId : undefined
    }
    if (!this.#mushafMode()) {
      // Translation mode: the view scrolls to the flashed (or cursor) verse and focuses it.
      this.page = page
      if (opts.flash) this.flash = { ayahId, until: Date.now() + FLASH_MS }
      if (opts.focus) {
        await Promise.resolve()
        if (jump === this.#jumpSeq) this.#announceAyah(ayahId, page, rangeEnd())
      }
      return
    }
    const arrived = await this.#navigate(page, {
      push: false,
      transition: true,
      manual: true,
      quiet: opts.focus === true,
      focuses: opts.focus === true,
    })
    if (!arrived || jump !== this.#jumpSeq || this.cursorAyahId !== expected) return
    if (opts.flash) this.flash = { ayahId, until: Date.now() + FLASH_MS }
    await this.#arrive(ayahId, { focus: opts.focus === true, cursor: expected })
    if (opts.focus && jump === this.#jumpSeq) this.#announceAyah(ayahId, page, rangeEnd())
  }

  /**
   * After a cursor move or a jump: turns to the ayah's page if it is off screen, then (Mushaf) focuses its roving item
   * and asks a scrolled canvas to bring it into view; (translation) focuses its verse. `cursor`: where the cursor must
   * still be after a turn (the ayah; the far end of a range a jump selected).
   */
  async #arrive(ayahId: number, opts: { focus: boolean; cursor?: number | null }): Promise<void> {
    if (!this.#mushafMode()) {
      if (opts.focus) await ui.focusWhenRendered(`#tv-a${ayahId}`)
      return
    }
    if (!this.isVisible(ayahId)) {
      const page = quran.pageOfAyah(this.layout, ayahId)
      const shown = await this.#navigate(page, {
        push: false,
        transition: true,
        manual: true,
        focuses: opts.focus,
      })
      if (!shown || this.cursorAyahId !== (opts.cursor ?? ayahId)) return
    }
    this.revealRequest = { ayahId, seq: ++this.#revealSeq }
    if (!opts.focus || !this.#mushafShown()) return
    const page = this.visiblePages.find((p) => {
      const r = quran.pageRange(this.layout, p)
      return ayahId >= r.from && ayahId <= r.to
    })
    if (page !== undefined) await ui.focusWhenRendered(`#${a11yItemId(page, ayahId)}`)
  }

  #here(): Loc {
    const cursor = this.cursorAyahId
    return { page: this.page, ayahId: cursor !== null && this.isVisible(cursor) ? cursor : null }
  }

  /** Records a jump to `target` in the navigation history (not when it is already on screen). */
  #pushHistory(target: number): void {
    if (this.#mushafMode() && this.visiblePages.includes(target)) return
    if (!this.#mushafMode() && target === this.page) return
    const here = this.#here()
    const last = this.navBack.at(-1)
    if (!last || last.page !== here.page || last.ayahId !== here.ayahId)
      this.navBack = [...this.navBack, here].slice(-NAV_HISTORY_MAX)
    if (this.navFwd.length > 0) this.navFwd = []
  }

  #goLoc(loc: Loc): void {
    this.#jumpSeq += 1
    if (loc.ayahId !== null && quran.isAyahId(loc.ayahId)) this.cursorAyahId = loc.ayahId
    void this.#navigate(loc.page, { push: false, transition: true, manual: true })
  }

  #announcePages(pagesShown: readonly number[]): void {
    const first = pagesShown[0]
    const last = pagesShown.at(-1)
    if (first === undefined || last === undefined) return
    ui.announce(
      first === last
        ? i18n.t('reader.announce.page', { page: i18n.num(first) })
        : i18n.t('reader.announce.spread', { first: i18n.num(first), last: i18n.num(last) }),
    )
  }

  /** "Al-Baqarah 2:255, page 42", or with a range "Al-Baqarah 2:255–257, page 42". */
  #announceAyah(ayahId: number, page: number, to?: number): void {
    const ref = quran.ayahRef(ayahId)
    if (ref.surah === 0) return
    const end = to !== undefined ? quran.ayahRef(to) : null
    const range = end && end.surah > 0 ? i18n.ref(ref.surah, ref.ayah, end.ayah, end.surah) : null
    ui.announce(
      i18n.t('reader.announce.ayah', {
        surah: quran.surahName(ref.surah),
        ref: range ?? i18n.ref(ref.surah, ref.ayah),
        page: i18n.num(page),
      }),
    )
  }

  #navigateRequest(target: NavTarget): boolean {
    switch (target.type) {
      case 'ayah':
        if (!quran.isAyahId(target.data.ayahId)) return false
        this.goToAyah(target.data.ayahId, { flash: true, focus: true })
        return true
      case 'page':
        this.goToPage(target.data.page)
        return true
      case 'surah': {
        const { from } = quran.surahRange(target.data.surah)
        if (from <= 0) return false
        this.goToAyah(from, { flash: true, focus: true })
        return true
      }
      default:
        return false
    }
  }

  /** Mouse buttons 4 and 5: navigation history, in the reader; the webview's own history never moves. */
  #listenMouseButtons(): () => void {
    const isNav = (e: MouseEvent) => e.button === 3 || e.button === 4
    const swallow = (e: MouseEvent) => {
      if (isNav(e)) e.preventDefault()
    }
    const onUp = (e: MouseEvent) => {
      if (!isNav(e)) return
      e.preventDefault()
      if (ui.view !== 'reader' || ui.layerOpen) return
      if (e.button === 3) this.back()
      else this.forward()
    }
    window.addEventListener('mousedown', swallow)
    window.addEventListener('auxclick', swallow)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousedown', swallow)
      window.removeEventListener('auxclick', swallow)
      window.removeEventListener('mouseup', onUp)
    }
  }

  /** The history dwell counts visible time only; leaving the app also flushes the position. */
  #listenVisibility(): () => void {
    const onVisibility = () => {
      const d = this.#dwell
      if (d) {
        const now = performance.now()
        if (document.visibilityState === 'hidden') {
          if (d.since !== null) d.shownMs += now - d.since
          d.since = null
          this.#flushDwell(false)
        } else if (d.since === null) {
          d.since = now
          this.#armDwell()
        }
      }
      if (document.visibilityState === 'hidden') this.#flushPosition()
    }
    const onPageHide = () => this.#flushPosition()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
    }
  }

  /** Translation mode's feed scrolling or the window resizing: its rows on screen are measured again. */
  #listenTranslationFeed(): () => void {
    const onScroll = (e: Event) => {
      if (e.target instanceof Element && e.target.closest('[data-qd-view="translation"]'))
        this.#measureTranslationRowsSoon()
    }
    const onResize = () => this.#measureTranslationRowsSoon()
    const options = { capture: true, passive: true } as const
    document.addEventListener('scroll', onScroll, options)
    window.addEventListener('resize', onResize, { passive: true })
    return () => {
      document.removeEventListener('scroll', onScroll, options)
      window.removeEventListener('resize', onResize)
      this.#rowsFrame?.()
      this.#rowsFrame = null
    }
  }

  /** Measures `translationRows` at the next frame (once per frame), while translation mode is on. */
  #measureTranslationRowsSoon(): void {
    if (this.#rowsFrame || settings.value.readingMode !== 'translation') return
    const run = () => {
      this.#rowsFrame = null
      if (settings.value.readingMode !== 'translation') return
      const rows = translationRowsOnScreen()
      const current = this.translationRows
      if (rows?.from !== current?.from || rows?.to !== current?.to) this.translationRows = rows
    }
    if (typeof requestAnimationFrame === 'function') {
      const frame = requestAnimationFrame(run)
      this.#rowsFrame = () => cancelAnimationFrame(frame)
    } else {
      const timer = setTimeout(run, 16)
      this.#rowsFrame = () => clearTimeout(timer)
    }
  }

  /** The store's effects (inside `$effect.root`, disposed by `reset`). */
  #effects(): void {
    // Translation mode's rows on screen (`translationRows`): measured once the feed has reported where it reads and
    // whenever its text loads (rows grow); scrolling and resizing are measured by `#listenTranslationFeed`.
    $effect(() => {
      const translation = settings.value.readingMode === 'translation'
      void translations.topAyahId
      void translations.version
      untrack(() => {
        if (translation) this.#measureTranslationRowsSoon()
        else if (this.translationRows !== null) this.translationRows = null
      })
    })

    // Follow-along: turn to the recitation's page unless the user just navigated; else offer the chip.
    let lastTarget: number | null = null
    $effect(() => {
      const target = this.followTarget
      const visible = this.visiblePages
      untrack(() => {
        const moved = target !== lastTarget
        lastTarget = target
        if (moved) this.#dismissedTarget = null
        if (target === null || visible.includes(target)) {
          if (this.followChip) this.followChip = false
          return
        }
        if (!moved) {
          // The pages changed (a navigation) while the recitation is elsewhere: offer to return.
          this.followChip = this.#dismissedTarget !== target
          return
        }
        if (performance.now() - this.#manualAt < MANUAL_HOLD_MS || this.flipping) {
          this.followChip = this.#dismissedTarget !== target
          return
        }
        this.followChip = false
        void this.#navigate(target, { push: false, transition: true, manual: false })
      })
    })

    // A layout change (style v2 ↔ v1 ↔ v4) keeps the reading place by ayah, not by page number.
    let lastLayout = untrack(() => this.layout)
    let lastPlace = untrack(() => this.#positionAyah)
    $effect.pre(() => {
      const layout = this.layout
      const place = this.#positionAyah
      untrack(() => {
        if (layout !== lastLayout && quran.isAyahId(lastPlace)) {
          this.page = this.#clampPage(quran.pageOfAyah(layout, lastPlace))
          lastLayout = layout
          return
        }
        lastLayout = layout
        lastPlace = place
      })
    })

    // A spread collapsing to a single page (a narrower canvas, the side pane, page mode) keeps the page the reader is
    // on: the visible cursor's, else the visible selection's, so they never vanish with the other half of the book.
    let lastSpread = untrack(() => this.spread)
    $effect.pre(() => {
      const spread = this.spread
      untrack(() => {
        if (lastSpread && !spread) {
          const before = spreadPages(this.page, true, this.#lastPage)
          const sel = this.selection
          for (const ayah of [this.cursorAyahId, sel?.toAyahId, sel?.fromAyahId]) {
            if (ayah === null || ayah === undefined || !quran.isAyahId(ayah)) continue
            const page = quran.pageOfAyah(this.layout, ayah)
            if (before.includes(page)) {
              if (page !== this.page) this.page = page
              break
            }
          }
        }
        lastSpread = spread
      })
    })

    // The reading position, 1 s after it settles.
    $effect(() => {
      const mode = settings.value.readingMode
      const layout = this.layout
      const page = this.page
      const ayahId = mode === 'translation' ? translations.topAyahId : this.#positionAyah
      if (this.flipping || ayahId === null || !quran.isAyahId(ayahId)) return
      untrack(() => this.#schedulePosition(mode, layout, page, ayahId))
    })

    // A page read for 3 s goes into the history.
    $effect(() => {
      const mode = settings.value.readingMode
      const reading = ui.view === 'reader' && !this.flipping && !this.turning
      const layout = this.layout
      const page = mode === 'translation' ? this.page : (this.visiblePages[0] ?? this.page)
      const ayahId =
        mode === 'translation' ? (translations.topAyahId ?? this.visibleRange.from) : this.visibleRange.from
      untrack(() => {
        if (!reading || !quran.isAyahId(ayahId)) {
          this.#endDwell()
          return
        }
        const key = `${mode}:${layout}:${page}`
        if (this.#dwell?.key === key) return
        this.#endDwell()
        this.#startDwell(key, { mode: 'read', layout, page, ayahId })
      })
    })

    // Once the pages settle, warm the neighbours (page data and fonts) at the next idle moment.
    $effect(() => {
      const style = this.style
      const page = this.visiblePages[0] ?? this.page
      const spread = this.spread
      if (this.flipping || !this.#mushafMode()) return
      untrack(() => this.#prefetchAround(style, page, spread))
      return () => {
        this.#prefetchHandle?.()
        this.#prefetchHandle = null
      }
    })
  }

  /** The neighbours' font prefetch is scheduled and has not started yet (QA's `waitIdle`). */
  get prefetchPending(): boolean {
    return this.#prefetchHandle !== null
  }

  #prefetchAround(style: MushafStyle, page: number, spread: boolean): void {
    this.#prefetchHandle?.()
    const around = aroundPages(page, spread)
    pages.prefetch(style, around)
    const run = () => {
      this.#prefetchHandle = null
      fonts.prefetchAround(style, page, spread)
    }
    if (typeof requestIdleCallback === 'function') {
      const handle = requestIdleCallback(run, { timeout: 1000 })
      this.#prefetchHandle = () => cancelIdleCallback(handle)
    } else {
      const handle = setTimeout(run, 50)
      this.#prefetchHandle = () => clearTimeout(handle)
    }
  }

  #schedulePosition(
    mode: 'mushaf' | 'translation',
    layout: MushafLayout,
    page: number,
    ayahId: number,
  ): void {
    let position: ReadingPosition = {
      context: mode,
      layout,
      page,
      ayahId,
      scrollPx: null,
      updatedAt: 0,
    }
    if (mode === 'translation') {
      // The view's anchor carries the pixel offset within the verse.
      const anchor = translations.anchor
      if (anchor && anchor.ayahId === ayahId)
        position = { ...position, page: anchor.page, scrollPx: Math.max(0, Math.round(anchor.delta)) }
    }
    if (positionKey(position) === this.#lastPositionKey) {
      clearTimeout(this.#positionTimer)
      this.#positionTimer = undefined
      this.#pendingPosition = null
      return
    }
    this.#pendingPosition = position
    clearTimeout(this.#positionTimer)
    this.#positionTimer = setTimeout(() => this.#flushPosition(), POSITION_DEBOUNCE_MS)
  }

  #flushPosition(): void {
    clearTimeout(this.#positionTimer)
    this.#positionTimer = undefined
    let position = this.#pendingPosition
    this.#pendingPosition = null
    if (!position) return
    if (position.context === 'translation') {
      const anchor = translations.anchor
      if (anchor && anchor.ayahId === position.ayahId)
        position = { ...position, page: anchor.page, scrollPx: Math.max(0, Math.round(anchor.delta)) }
    }
    const key = positionKey(position)
    if (key === this.#lastPositionKey) return
    this.#lastPositionKey = key
    this.#track(history.setPosition(position))
  }

  /** Keeps a background write until it lands, so that a quit can wait for it (`#beforeQuit`). */
  #track(write: Promise<void>): void {
    this.#writes.add(write)
    void write.finally(() => this.#writes.delete(write))
  }

  /**
   * Before the app exits (`app.beforeQuit`): the position still waiting for its debounce and the dwell due so far are
   * written now, and the exit waits for every write still on its way (one the window's hiding just flushed, too).
   */
  #beforeQuit(): Promise<unknown> {
    this.#flushDwell(true)
    this.#flushPosition()
    return Promise.allSettled([...this.#writes])
  }

  #startDwell(key: string, input: Omit<HistoryInput, 'dwellS'>): void {
    const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden'
    this.#dwell = {
      key,
      input,
      shownMs: 0,
      since: visible ? performance.now() : null,
      recordedS: 0,
      timer: undefined,
    }
    if (visible) this.#armDwell()
  }

  /** The next dwell checkpoint: the 3 s threshold, then a top-up every minute. */
  #armDwell(): void {
    const d = this.#dwell
    if (!d || d.since === null) return
    clearTimeout(d.timer)
    const shown = d.shownMs + (performance.now() - d.since)
    const due = d.recordedS === 0 ? HISTORY_DWELL_MS - shown : HISTORY_FLUSH_MS
    d.timer = setTimeout(
      () => {
        this.#flushDwell(true)
        this.#armDwell()
      },
      Math.max(0, due),
    )
  }

  /** Records the dwell not recorded yet, once the place has been read for 3 s. */
  #flushDwell(alive: boolean): void {
    const d = this.#dwell
    if (!d) return
    if (!alive) clearTimeout(d.timer)
    const shown = d.shownMs + (d.since === null ? 0 : performance.now() - d.since)
    if (shown < HISTORY_DWELL_MS) return
    const seconds = Math.floor(shown / 1000) - d.recordedS
    if (seconds <= 0) return
    d.recordedS += seconds
    this.#track(history.record({ ...d.input, dwellS: seconds }))
  }

  #endDwell(): void {
    if (!this.#dwell) return
    this.#flushDwell(false)
    clearTimeout(this.#dwell.timer)
    this.#dwell = null
  }

  /** Stops listeners, effects and timers. Pending writes are dropped: only leaving the window or quitting flushes them. */
  #dispose(): void {
    if (this.#dwell) clearTimeout(this.#dwell.timer)
    this.#dwell = null
    clearTimeout(this.#positionTimer)
    this.#positionTimer = undefined
    this.#pendingPosition = null
    this.#writes.clear()
    this.#prefetchHandle?.()
    this.#prefetchHandle = null
    for (const dispose of this.#disposers.splice(0)) dispose()
  }
}

function positionKey(
  p: Pick<ReadingPosition, 'context' | 'layout' | 'page' | 'ayahId' | 'scrollPx'>,
): string {
  return `${p.context}|${p.layout ?? ''}|${p.page ?? ''}|${p.ayahId}|${p.scrollPx ?? ''}`
}

export const reader = new ReaderStore()

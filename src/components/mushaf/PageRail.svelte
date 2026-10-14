<!--
  PageRail. The 604-step page rail at the bottom of the Mushaf canvas. Takes no props: it reads stores.

  - **Reveal.** The pointer resting 90 ms (within 4 px) anywhere under the bottom edge of the pages' frame (the
    page-number strip and below, across the book, down to the canvas bottom) or in the bottom 24 px of the page area
    shows it (`inRevealZone`), never over the dock, the overlay slot's chips and bars, a toast, the ayah action bar or
    anything else drawn over the Mushaf (the floating sidebar and its scrim); passing through on the way to the dock
    or out of the window does nothing. The zone
    follows the book through zoom, scroll, turns and resizes: a resting pointer is tested again when the book moves
    under it. It stays while the pointer is over it or in the band between it and the canvas bottom, and leaves 450 ms
    after the pointer does. A held button (a drag on the page) never reveals or keeps it. `P`
    (`reader.railRequest`) shows it and moves focus to it. It floats just above whatever sits at the bottom of the page
    area (the bar dock, the follow chip, the memorisation bars), else 8 px off the bottom edge.
  - **Book order, never mirrored**: page 1 at the right end, the last page at the left end, in both UI
    languages. The fill runs from page 1 to the page shown; 30 juz ticks carry labels in Eastern Arabic numbers while
    the rail is hovered or focused (thinned so they never collide); a live label above the thumb reads
    "surah · page · juz".
  - **Pointer.** Hover previews the page under the pointer in the live label. Dragging only previews (the FlipHUD shows
    the page in the canvas centre); the release, or a click, navigates with a single turn. A pointer never focuses the
    rail, so ← → keep turning pages afterwards.
  - **Keyboard** (`role=slider`, `aria-valuetext` "Page 262, Al-Hijr, Juz 14"): ← / → ±1 page (← = next, book
    semantics), Shift ±10, ↑ / ↓ ±1, PageDown / PageUp the next / previous juz start, Home / End the first / last page.
    Steps preview at once and turn 350 ms after the last one (a single turn, one history entry per visit). Enter turns
    now and returns focus; Escape drops the preview and returns focus. While focused the rail is a floating layer
    (`ui.pushFloating`), so Escape closes it before the reader's or the app's Escape.

  The module script also exports the rail state the FlipHUD and the slot chips read, the page label shared with the
  FlipHUD, and the pure rail geometry (unit-tested).
-->
<script module lang="ts">
  import { LRI, PDI, RLI } from '$lib/stores/i18n.svelte'
  import { i18n, quran, reader, settings } from '$lib/stores'

  /** The rail state other page-navigation parts read: the FlipHUD (the preview) and the slot chips (`open`). */
  export const railState = $state({
    /** The strip is on screen. */
    open: false,
    /** The page a drag or keyboard steps preview, not yet turned to. */
    preview: null as number | null,
  })

  /** The strip's height. */
  export const RAIL_H = 28
  /** The band at the bottom of the page area that always reveals the rail, the frame in view or not. */
  export const HOT_ZONE_PX = 24
  /** The strip never grows wider than this (a long rail is hard to aim along). */
  export const RAIL_MAX_W = 1120
  /** Keyboard steps turn this long after the last one. */
  export const KEY_COMMIT_MS = 350
  /** The rail leaves this long after the pointer does. */
  export const CLOSE_GRACE_MS = 450
  /** The pointer must rest in the reveal zone this long (passing through it on the way out does nothing). */
  export const REVEAL_INTENT_MS = 90
  /** A move this far from where the rest began starts it again (a reach for the dock never rests). */
  export const REST_SLOP_PX = 4
  /** Juz labels stay at least this far apart. */
  export const LABEL_MIN_GAP = 22

  const SEP = ' · '

  /** Where a page sits along the rail: 0 = page 1 (the right end), 1 = the last page (the left end). */
  export function railFraction(page: number, last: number): number {
    if (!(last > 1) || !Number.isFinite(page)) return 0
    return Math.min(1, Math.max(0, (page - 1) / (last - 1)))
  }

  /** The page at a fraction of the rail (rounded to the nearest page). */
  export function pageAtFraction(fraction: number, last: number): number {
    const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
    return last > 1 ? Math.round(f * (last - 1)) + 1 : 1
  }

  /** The page under a client x on a track box (book order: page 1 at the right edge, never mirrored). */
  export function pageAtX(x: number, left: number, width: number, last: number): number {
    if (!(width > 0)) return 1
    return pageAtFraction((left + width - x) / width, last)
  }

  /** Where the rail's reveal zone lies (client px), measured on each test: it follows the book. */
  export interface RevealGeometry {
    /** The page area: the canvas minus the side card's column. */
    left: number
    right: number
    /** The canvas's top and bottom edges. */
    top: number
    bottom: number
    /** The book on screen (`[data-qd-stage]`): its extent and its frame's bottom edge; `null` before it is laid out. */
    book: { left: number; right: number; frameBottom: number } | null
  }

  /**
   * Whether (x, y) is in the rail's reveal zone: under the bottom edge of the pages' frame (the page-number
   * strip and below), across the book's width, down to the canvas bottom; and always the bottom `HOT_ZONE_PX` of the
   * page area. A book zoomed past the canvas whose frame bottom is out of view (or none laid out) leaves only that
   * band. The dock and the overlay slot are excepted by the caller.
   */
  export function inRevealZone(x: number, y: number, g: RevealGeometry): boolean {
    if (!(x >= g.left && x <= g.right && y >= g.top && y < g.bottom)) return false
    if (y >= g.bottom - HOT_ZONE_PX) return true
    const b = g.book
    return (
      b !== null &&
      Number.isFinite(b.frameBottom) &&
      y >= b.frameBottom &&
      x >= Math.max(g.left, b.left) &&
      x <= Math.min(g.right, b.right)
    )
  }

  /**
   * Which juz get a label on a track this wide: every juz while they are at least `minGap` apart on average, else a
   * coarser step (1, 3, 5, … with step 2 or 3; 1, 5, 10, … from step 5).
   */
  export function juzLabelStep(trackWidth: number, count = 30, minGap = LABEL_MIN_GAP): number {
    if (count <= 1 || !(trackWidth > 0)) return Math.max(1, count)
    const spacing = trackWidth / count
    for (const step of [1, 2, 3, 5, 10, 15]) if (spacing * step >= minGap) return step
    return count
  }

  /** Whether juz `n` is labelled at a label step (see `juzLabelStep`). */
  export function juzLabelled(n: number, step: number): boolean {
    if (step <= 1) return true
    return step <= 3 ? (n - 1) % step === 0 : n === 1 || n % step === 0
  }

  /**
   * The page a key moves the rail to from `value`, or `null` for a key the rail does not take: ← / ↑ +1 and
   * → / ↓ −1 (book order: ← is the next page), Shift ×10; PageDown / PageUp the next / previous juz start; Home / End
   * the first / last page. Clamped to 1…last.
   */
  export function railKeyTarget(
    key: string,
    shift: boolean,
    value: number,
    last: number,
    juzStarts: readonly number[],
  ): number | null {
    const clamp = (p: number) => Math.min(last, Math.max(1, p))
    const step = shift ? 10 : 1
    switch (key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        return clamp(value + step)
      case 'ArrowRight':
      case 'ArrowDown':
        return clamp(value - step)
      case 'Home':
        return 1
      case 'End':
        return last
      case 'PageDown':
        return clamp(juzStarts.find((p) => p > value) ?? last)
      case 'PageUp':
        return clamp(juzStarts.findLast((p) => p < value) ?? 1)
      default:
        return null
    }
  }

  /** A page range "261–262" isolated for bidi, like references: RLI for Eastern Arabic numbers, else LRI. */
  export function isolatedRange(first: number, last: number): string {
    return `${settings.arabicDigits ? RLI : LRI}${i18n.num(first)}–${i18n.num(last)}${PDI}`
  }

  export interface PageLabel {
    /** The surah of the first ayah on the (first) page: its Arabic name. */
    surahAr: string
    /** The same surah in the UI language (`quran.surahName`). */
    surah: string
    /** "Page 262" / "ص ٢٦٢", or "Pages 261–262" for a spread. */
    pages: string
    /** "Juz 14" / "ج ١٤". */
    juz: string
    /** "Al-Hijr · Page 262 · Juz 14" / "الحجر · ص ٢٦٢ · ج ١٤". */
    text: string
    /** `aria-valuetext` of the rail: "Page 262, Al-Hijr, Juz 14" (the first page). */
    valueText: string
  }

  /**
   * The page label ("surah · page · juz") for the pages shown (one page, or a spread in reading order). The
   * surah and the juz are those of the first ayah on the first page, as in the running head. `null` before the index
   * is loaded.
   */
  export function pageLabel(pagesShown: readonly number[]): PageLabel | null {
    const first = pagesShown[0]
    if (first === undefined) return null
    const last = pagesShown.at(-1) ?? first
    const ayahId = quran.pageRange(reader.layout, first).from
    const surahNo = quran.ayahRef(ayahId).surah
    const juzNo = quran.juzOf(ayahId)
    if (surahNo === 0 || juzNo === 0) return null
    const surah = quran.surahName(surahNo)
    const pages =
      last === first
        ? i18n.t('pagenav.label.page', { page: first })
        : i18n.t('pagenav.label.pages', { range: isolatedRange(first, last) })
    const juz = i18n.t('pagenav.label.juz', { juz: juzNo })
    return {
      surahAr: quran.surah(surahNo)?.nameAr ?? surah,
      surah,
      pages,
      juz,
      text: [surah, pages, juz].join(SEP),
      valueText: i18n.t('pagenav.rail.valueText', { page: first, surah, juz: juzNo }),
    }
  }
</script>

<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte'
  import { fly } from 'svelte/transition'
  import { FRAME_BOTTOM, PAD_X, PAGE_COUNT, PH, SIDE_DOCK_W } from '$lib/mushaf/geometry'
  import { ui } from '$lib/stores'

  /** Gap between the strip and what it floats above; and its distance from a free canvas bottom. */
  const LIFT_GAP = 8
  const EDGE_GAP = 8
  /** Things more than this far above the canvas bottom are not in the rail's way. */
  const LIFT_REACH = 240
  /** The band around an open strip that keeps it open (px beyond its ends, px above it). */
  const BAND_X = 24
  const BAND_TOP = 16
  /** A committed page the reader has not reached in this long is forgotten. */
  const PENDING_MS = 1500

  /** The always-present layer (its parent is `.mushaf-view`). */
  let layer: HTMLDivElement | undefined = $state()
  let strip: HTMLDivElement | undefined = $state()
  let track: HTMLDivElement | undefined = $state()
  let trackWidth = $state(0)
  let bubble: HTMLDivElement | undefined = $state()
  /** The live label's border-box width (its 1 px border included, so it centres on the thumb). */
  let bubbleWidth = $state(0)

  /** Reasons to be open. */
  let pointerNear = $state(false)
  let hovering = $state(false)
  let focused = $state(false)
  let dragging = $state(false)

  let shown = $state(false)
  /** The strip's distance from the canvas bottom. */
  let lift = $state(EDGE_GAP)
  let hoverPage = $state<number | null>(null)
  /** A turned-to page the reader has not reached yet: the thumb waits there instead of jumping back. */
  let pending = $state<number | null>(null)

  const last = $derived(quran.pageCount(reader.layout) || PAGE_COUNT)
  const clampPage = (p: number) => Math.min(last, Math.max(1, Math.round(p)))
  const current = $derived(clampPage(reader.page))
  const value = $derived(railState.preview ?? pending ?? current)
  const juzStarts = $derived(
    quran.index.juz.map((j) => ({ juz: j.id, page: quran.pageOfAyah(reader.layout, j.firstAyahId) })),
  )
  const juzPages = $derived(juzStarts.map((j) => j.page))
  const labelStep = $derived(juzLabelStep(trackWidth, juzStarts.length))
  const labelsOn = $derived(hovering || focused || dragging)
  /** The live label follows the pointer while hovering, else the value. */
  const labelPage = $derived(
    hovering && !dragging && railState.preview === null && hoverPage !== null ? hoverPage : value,
  )
  const label = $derived(pageLabel([labelPage]))
  const valueText = $derived(pageLabel([value])?.valueText ?? i18n.t('pagenav.label.page', { page: value }))
  const motion = $derived(settings.reducedMotion ? 0 : 160)

  /** The live label's start offset (from the right end of the track), kept inside the track. */
  const bubbleAt = $derived.by(() => {
    const centre = railFraction(labelPage, last) * trackWidth
    return Math.round(Math.min(Math.max(0, centre - bubbleWidth / 2), Math.max(0, trackWidth - bubbleWidth)))
  })

  // A new label is measured as soon as it renders, so the label is centred in the same frame as the step that changed
  // it; the resize observer of `bind:offsetWidth` only reports a frame later (it still catches a web font arriving).
  $effect(() => {
    void label
    if (bubble) bubbleWidth = bubble.offsetWidth
  })

  // --- open and close --------------------------------------------------------------------------------------------------

  let closeTimer: ReturnType<typeof setTimeout> | undefined
  let intentTimer: ReturnType<typeof setTimeout> | undefined
  let commitTimer: ReturnType<typeof setTimeout> | undefined
  let pendingTimer: ReturnType<typeof setTimeout> | undefined
  /** Where focus was before `P`; restored by Enter and Escape. */
  let returnFocus: HTMLElement | null = null
  /** One navigation-history entry per visit of the rail. */
  let visitPushed = false
  let floating = false

  const wanted = $derived(focused || dragging || hovering || pointerNear)

  $effect(() => {
    const want = wanted
    untrack(() => {
      if (want) {
        clearTimeout(closeTimer)
        closeTimer = undefined
        if (!shown) open()
        return
      }
      if (shown && closeTimer === undefined)
        closeTimer = setTimeout(() => {
          closeTimer = undefined
          if (!wanted) close()
        }, CLOSE_GRACE_MS)
    })
  })

  function open(): void {
    lift = measureLift()
    shown = true
    railState.open = true
  }

  function close(): void {
    shown = false
    railState.open = false
    hoverPage = null
    visitPushed = false
  }

  // `P`: show the rail and focus it.
  let seenRequest = untrack(() => reader.railRequest)
  $effect(() => {
    const request = reader.railRequest
    if (request === seenRequest) return
    seenRequest = request
    untrack(() => void reveal())
  })

  async function reveal(): Promise<void> {
    const active = document.activeElement
    if (!strip?.contains(active)) returnFocus = active instanceof HTMLElement ? active : null
    if (!shown) open()
    await tick()
    strip?.focus({ preventScroll: true })
  }

  /** Enter / Escape: focus goes back where it was before `P`, and the rail leaves unless the pointer holds it. */
  function leave(): void {
    const target = returnFocus
    returnFocus = null
    if (target && target.isConnected && target !== document.body && target !== strip)
      target.focus({ preventScroll: true })
    else strip?.blur()
    if (!hovering && !pointerNear && !dragging) {
      clearTimeout(closeTimer)
      closeTimer = undefined
      close()
    }
  }

  // While open, the strip rises when something appears under it (zen showing the dock, a placement change) but never
  // drops under the pointer: in zen the dock hides again as soon as the pointer moves up onto the rail.
  $effect(() => {
    void reader.dock
    void ui.zen
    void ui.zenDock
    void ui.windowSize
    if (!shown) return
    untrack(() => (lift = Math.max(lift, measureLift())))
  })

  // --- geometry ----------------------------------------------------------------------------------------------------------

  /** The page area of the canvas (physical px): the canvas minus the side card's column. */
  function pageArea(view: DOMRect): { left: number; right: number } {
    const reserve = reader.dock === 'side' && !ui.zen ? SIDE_DOCK_W : 0
    const rtl = i18n.dir === 'rtl'
    return { left: view.left + (rtl ? reserve : 0), right: view.right - (rtl ? 0 : reserve) }
  }

  /** The dock's visible parts (none while zen hides it): its pill, not the canvas-wide box it morphs in. */
  function dockParts(): Element[] {
    if (ui.zen && !ui.zenDock) return []
    return [...document.querySelectorAll('[data-qd-region="dock"] [data-qd-dock-pill]')]
  }

  /**
   * The overlay slot's visible chips and bars: the follow, division and hint chips, the memorisation bars.
   * While the pointer aims at one the rail stays away: it would hide the chips (they step aside while it is open) and
   * lift itself over the bars.
   */
  function slotParts(): Element[] {
    const slot = layer?.parentElement?.querySelector('.mv-slot')
    return [...(slot?.children ?? [])].filter((el) => {
      const b = el.getBoundingClientRect()
      return b.width > 0 && b.height > 0
    })
  }

  function inside(b: DOMRect, x: number, y: number): boolean {
    return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom
  }

  /**
   * The pointer is using something at the bottom of the canvas, not reaching for the rail: the dock, the slot's chips
   * and bars, or what is portalled over the zone: the toasts (above the dock) and the ayah action bar (below a
   * selection that ends on the last line).
   */
  function inUse(x: number, y: number): boolean {
    const parts = [
      ...dockParts(),
      ...slotParts(),
      ...document.querySelectorAll('[data-sonner-toast], .ab[role="toolbar"]'),
    ]
    return parts.some((el) => inside(el.getBoundingClientRect(), x, y))
  }

  /**
   * The book on screen (`[data-qd-stage]`, PH·qfs tall): its extent and its frame's bottom edge, in client px. Read
   * from the stage's own box, so it holds under any zoom and scroll offset, and before a still-blank page has a footer.
   */
  function bookBox(view: Element): RevealGeometry['book'] {
    const s = view.querySelector('[data-qd-stage]')?.getBoundingClientRect()
    if (!s || !(s.width > 0) || !(s.height > 0)) return null
    return { left: s.left, right: s.right, frameBottom: s.top + s.height * (FRAME_BOTTOM / PH) }
  }

  /** How far above the canvas bottom the strip floats: clear of the dock and the slot's chips under its span. */
  function measureLift(): number {
    const view = layer?.parentElement
    if (!view) return EDGE_GAP
    const r = view.getBoundingClientRect()
    const area = pageArea(r)
    const width = Math.min(area.right - area.left - 2 * PAD_X, RAIL_MAX_W)
    const left = (area.left + area.right - width) / 2
    const right = left + width
    const slot = view.querySelector('.mv-slot')
    const obstacles = [
      ...dockParts(),
      ...[...(slot?.children ?? [])].filter((el) => !el.hasAttribute('data-qd-pagenav')),
    ]
    let top = r.bottom
    for (const el of obstacles) {
      const b = el.getBoundingClientRect()
      if (b.width <= 0 || b.height <= 0 || b.right <= left || b.left >= right) continue
      if (b.bottom < r.bottom - LIFT_REACH) continue
      top = Math.min(top, b.top)
    }
    return top < r.bottom ? Math.round(r.bottom - top + LIFT_GAP) : EDGE_GAP
  }

  /** Where a pointer is: in the reveal zone, in the band that holds an open rail, or elsewhere. */
  function zoneAt(x: number, y: number): 'hot' | 'band' | null {
    const view = layer?.parentElement
    if (!view) return null
    const r = view.getBoundingClientRect()
    if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) return null
    // Only over the Mushaf itself: not over what floats above the canvas (the floating sidebar, its scrim).
    const hit = document.elementFromPoint(x, y)
    if (!hit || !view.contains(hit)) return null
    // Over the dock, a slot chip or bar the pointer is using it: the rail lets go (after the grace, which covers
    // crossing the dock from the edge up to the rail).
    if (inUse(x, y)) return null
    if (shown && strip) {
      const s = strip.getBoundingClientRect()
      if (x >= s.left - BAND_X && x <= s.right + BAND_X && y >= s.top - BAND_TOP) return 'band'
    }
    const area = pageArea(r)
    const g = { left: area.left, right: area.right, top: r.top, bottom: r.bottom, book: bookBox(view) }
    return inRevealZone(x, y, g) ? 'hot' : null
  }

  let inHot = false
  /** Where the pointer's rest in the zone began: a move of `REST_SLOP_PX` or more from it starts the wait again. */
  let rest: { x: number; y: number } | null = null
  /** The mouse's last place and buttons (no touch), to test it again when the book moves under it. */
  let lastPointer: { x: number; y: number; buttons: number } | null = null

  /** Whether the pointer at (x, y) wants the rail: after the intent delay in the zone, at once in the band. */
  function evaluate(x: number, y: number, buttons: number): void {
    // A button held down (a drag on the page, a text selection elsewhere) or an open menu never reveals the rail. A
    // recheck keeps the buttons of the last move, so a drag that scrolls or turns the book never reveals it either;
    // after the release the rail comes once the pointer moves again.
    const zone = (buttons !== 0 && !dragging) || ui.layerOpen ? null : zoneAt(x, y)
    if (zone === 'band' || (zone === 'hot' && shown)) {
      clearTimeout(intentTimer)
      intentTimer = undefined
      inHot = zone === 'hot'
      if (!pointerNear) pointerNear = true
      return
    }
    if (zone === 'hot') {
      inHot = true
      // A rest, not time spent in the zone: a pointer still moving through it (to the dock, out of the window) never
      // reveals the rail. A recheck at the same place keeps the wait going.
      if (rest && Math.hypot(x - rest.x, y - rest.y) >= REST_SLOP_PX) {
        clearTimeout(intentTimer)
        intentTimer = undefined
      }
      if (intentTimer === undefined) {
        rest = { x, y }
        intentTimer = setTimeout(() => {
          intentTimer = undefined
          if (inHot && !reader.flipping) pointerNear = true
        }, REVEAL_INTENT_MS)
      }
      return
    }
    inHot = false
    rest = null
    clearTimeout(intentTimer)
    intentTimer = undefined
    if (pointerNear) pointerNear = false
  }

  function onWindowPointerMove(e: PointerEvent): void {
    if (e.pointerType === 'touch') return
    lastPointer = { x: e.clientX, y: e.clientY, buttons: e.buttons }
    evaluate(e.clientX, e.clientY, e.buttons)
  }

  function onWindowMouseOut(e: MouseEvent): void {
    if (e.relatedTarget !== null) return
    lastPointer = null
    inHot = false
    rest = null
    clearTimeout(intentTimer)
    intentTimer = undefined
    pointerNear = false
  }

  $effect(() => {
    window.addEventListener('pointermove', onWindowPointerMove, { passive: true })
    window.addEventListener('mouseout', onWindowMouseOut, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onWindowPointerMove)
      window.removeEventListener('mouseout', onWindowMouseOut)
    }
  })

  // The zone follows the book: a resting pointer is tested again (next frame, once laid out) when the book moves or
  // resizes under it (a zoom, a turn, a resize, the dock changing, the canvas scrolling). Engines differ on whether
  // such a change sends a pointer move, so the rail never waits for one.
  let recheckFrame = 0

  function recheck(): void {
    if (recheckFrame !== 0) return
    recheckFrame = requestAnimationFrame(() => {
      recheckFrame = 0
      const p = lastPointer
      if (p) evaluate(p.x, p.y, p.buttons)
    })
  }

  $effect(() => {
    void reader.qfs
    void reader.visiblePages
    void reader.spread
    void reader.scrolls
    void reader.dock
    void ui.zen
    void ui.zenDock
    void ui.windowSize
    untrack(recheck)
  })

  // …and the scroll area's viewport scrolling (zoomed), as the turn zones follow it.
  $effect(() => {
    const scroller = layer?.parentElement?.querySelector('[data-scroll-area-viewport]')
    if (!scroller) return
    scroller.addEventListener('scroll', recheck, { passive: true })
    return () => scroller.removeEventListener('scroll', recheck)
  })

  // --- turning -------------------------------------------------------------------------------------------------------------

  /** Turns to a page with a single (animated) turn; the first turn of a visit is a jump in the navigation history. */
  function commit(page: number): void {
    clearTimeout(commitTimer)
    commitTimer = undefined
    railState.preview = null
    const p = clampPage(page)
    if (p === current) {
      pending = null
      return
    }
    pending = p
    clearTimeout(pendingTimer)
    pendingTimer = setTimeout(() => (pending = null), PENDING_MS)
    reader.goToPage(p, { push: !visitPushed })
    visitPushed = true
  }

  /** The reader reached the turned-to page: the thumb follows the reader again. */
  $effect(() => {
    const page = reader.page
    const target = pending
    if (target !== null && (page === target || reader.visiblePages.includes(target)))
      untrack(() => {
        pending = null
        clearTimeout(pendingTimer)
      })
  })

  function flushCommit(): void {
    const p = railState.preview
    clearTimeout(commitTimer)
    commitTimer = undefined
    if (p !== null) commit(p)
  }

  function cancelPreview(): void {
    clearTimeout(commitTimer)
    commitTimer = undefined
    railState.preview = null
  }

  // --- keyboard ------------------------------------------------------------------------------------------------------------

  function onkeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelPreview()
      leave()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      flushCommit()
      leave()
      return
    }
    const next = railKeyTarget(e.key, e.shiftKey, value, last, juzPages)
    if (next === null) return
    e.preventDefault()
    if (next === value) return
    railState.preview = next
    clearTimeout(commitTimer)
    commitTimer = setTimeout(flushCommit, KEY_COMMIT_MS)
  }

  function onfocus(): void {
    focused = true
    if (!floating) {
      ui.pushFloating()
      floating = true
    }
  }

  function onblur(): void {
    focused = false
    flushCommit()
    if (floating) {
      ui.popFloating()
      floating = false
    }
  }

  // --- pointer -------------------------------------------------------------------------------------------------------------

  function pageAtPointer(x: number): number {
    const box = track?.getBoundingClientRect()
    return box ? pageAtX(x, box.left, box.width, last) : value
  }

  function onpointerdown(e: PointerEvent): void {
    if (e.button !== 0 || !e.isPrimary || !strip) return
    // A pointer never takes focus (← → keep turning pages) and never starts a text selection.
    e.preventDefault()
    try {
      strip.setPointerCapture(e.pointerId)
    } catch {
      // Not an active pointer (a synthetic event): the drag still follows moves over the strip.
    }
    dragging = true
    clearTimeout(commitTimer)
    commitTimer = undefined
    railState.preview = pageAtPointer(e.clientX)
  }

  function onpointermove(e: PointerEvent): void {
    const page = pageAtPointer(e.clientX)
    if (dragging) {
      if (page !== railState.preview) railState.preview = page
    } else if (page !== hoverPage) {
      hoverPage = page
    }
  }

  function onpointerup(e: PointerEvent): void {
    if (!dragging) return
    dragging = false
    const page = railState.preview ?? pageAtPointer(e.clientX)
    commit(page)
  }

  function endDrag(): void {
    if (!dragging) return
    dragging = false
    railState.preview = null
  }

  function onpointerenter(e: PointerEvent): void {
    if (e.pointerType === 'touch') return
    hovering = true
    hoverPage = pageAtPointer(e.clientX)
  }

  function onpointerleave(): void {
    hovering = false
    if (!dragging) hoverPage = null
  }

  onDestroy(() => {
    clearTimeout(closeTimer)
    clearTimeout(intentTimer)
    clearTimeout(commitTimer)
    clearTimeout(pendingTimer)
    cancelAnimationFrame(recheckFrame)
    if (floating) ui.popFloating()
    floating = false
    railState.open = false
    railState.preview = null
  })
</script>

<div class="rail-layer" bind:this={layer}>
  {#if shown}
    <!-- The lift is the strip's own, so a new strip starts at the height `open()` measured. Set on the layer, it reached
      the strip only after the strip's first style resolution, so a reveal at a new height (the first one: 8 px to
      above the dock) rose from the previous lift through the dock in the 200 ms `inset-block-end` transition. -->
    <div
      bind:this={strip}
      class="strip"
      style:--rail-lift={`${lift}px`}
      class:labels={labelsOn}
      class:dragging
      role="slider"
      tabindex="0"
      aria-label={i18n.t('pagenav.rail.name')}
      aria-orientation="horizontal"
      aria-valuemin={1}
      aria-valuemax={last}
      aria-valuenow={value}
      aria-valuetext={valueText}
      data-qd-page-rail=""
      transition:fly={{ y: 6, duration: motion }}
      {onkeydown}
      {onfocus}
      {onblur}
      {onpointerdown}
      {onpointermove}
      {onpointerup}
      onpointercancel={endDrag}
      onlostpointercapture={endDrag}
      {onpointerenter}
      {onpointerleave}
    >
      <!-- Book order in both UI languages: the track runs right to left (page 1 at the right end). -->
      <div class="track" bind:this={track} bind:clientWidth={trackWidth} dir="rtl">
        <div class="line" aria-hidden="true">
          <div class="fill" style:inline-size={`${railFraction(value, last) * 100}%`}></div>
        </div>
        {#each juzStarts as j (j.juz)}
          <span
            class="tick"
            style:inset-inline-start={`${railFraction(j.page, last) * 100}%`}
            aria-hidden="true"
          ></span>
          {#if juzLabelled(j.juz, labelStep)}
            <span
              class="tick-label"
              lang="ar"
              style:inset-inline-start={`${railFraction(j.page, last) * 100}%`}
              aria-hidden="true">{i18n.mushafNum(j.juz)}</span
            >
          {/if}
        {/each}
        {#if hovering && !dragging && railState.preview === null && hoverPage !== null && hoverPage !== value}
          <span
            class="ghost"
            style:inset-inline-start={`${railFraction(hoverPage, last) * 100}%`}
            aria-hidden="true"
          ></span>
        {/if}
        <span
          class="thumb"
          style:inset-inline-start={`${railFraction(value, last) * 100}%`}
          aria-hidden="true"
        ></span>
        {#if label}
          <!-- The box keeps the track's direction (its offset counts from the right end); the text takes the UI's. -->
          <div
            class="bubble"
            bind:this={bubble}
            bind:offsetWidth={bubbleWidth}
            style:inset-inline-start={`${bubbleAt}px`}
            aria-hidden="true"
          >
            <!-- Tabular digits for the numbers only (Inter's tabular forms widen the hyphen of "Al-Hijr"). -->
            <span dir={i18n.dir}
              >{label.surah}<span class="sep">{SEP}</span><span class="num">{label.pages}</span><span
                class="sep">{SEP}</span
              ><span class="num">{label.juz}</span></span
            >
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  /* The page area's bottom edge (the side card's column excluded); the strip floats above it. */
  .rail-layer {
    position: absolute;
    inset-inline: 0 var(--mv-reserve-end, 0px);
    inset-block-end: 0;
    z-index: var(--z-popover);
    block-size: 0;
    pointer-events: none;
  }

  .strip {
    position: absolute;
    inset-inline: var(--space-6);
    inset-block-end: var(--rail-lift);
    max-inline-size: 1120px;
    block-size: 28px;
    margin-inline: auto;
    padding-inline: 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background-color: var(--glass-fill);
    backdrop-filter: var(--backdrop-dock);
    box-shadow: var(--shadow-2);
    cursor: pointer;
    touch-action: none;
    user-select: none;
    pointer-events: auto;
    outline: none;
    transition: inset-block-end var(--dur-normal) var(--ease-standard);
  }

  .strip:focus-visible {
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .track {
    position: relative;
    block-size: 100%;
  }

  /* The track: 4 px, `--border-input` at 40 % with a 1 px outline (≥ 3:1, like the dock scrubber). */
  .line {
    position: absolute;
    inset-inline: 0;
    inset-block-start: 17px;
    block-size: 4px;
    border-radius: var(--radius-full);
    background-color: color-mix(in srgb, var(--border-input) 40%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--border-input) 55%, transparent);
    overflow: hidden;
  }

  /* Book progress: page 1 (the right end) to the page shown. */
  .fill {
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;
    border-radius: var(--radius-full);
    background-color: var(--accent);
  }

  /* Physical translates below centre a mark on its point: the track is always right to left (physical-ok). */
  .tick {
    position: absolute;
    inset-block-start: 14px;
    inline-size: 1px;
    block-size: 10px;
    translate: 50% 0;
    border-radius: 1px;
    background-color: color-mix(in srgb, var(--text-muted) 70%, transparent);
  }

  .tick-label {
    position: absolute;
    inset-block-start: 1px;
    translate: 50% 0;
    color: var(--text-muted);
    font-family: var(--font-arabic);
    font-size: 10px;
    line-height: 12px;
    white-space: nowrap;
    opacity: 0;
    transition: opacity var(--dur-quick) var(--ease-standard);
  }

  .labels .tick-label {
    opacity: 1;
  }

  /* The page under the pointer, while hovering. */
  .ghost {
    position: absolute;
    inset-block-start: 12px;
    inline-size: 2px;
    block-size: 14px;
    translate: 50% 0;
    border-radius: var(--radius-full);
    background-color: color-mix(in srgb, var(--text) 45%, transparent);
  }

  /* 14 px accent with a 2 px ring; 18 px while hovered or dragged (the dock scrubber's thumb). */
  .thumb {
    position: absolute;
    inset-block-start: 12px;
    inline-size: 14px;
    block-size: 14px;
    translate: 50% 0;
    border-radius: 50%;
    background-color: var(--accent);
    box-shadow:
      0 0 0 2px var(--surface-raised),
      var(--shadow-1);
    transition: scale var(--dur-fast) var(--ease-standard);
  }

  .labels .thumb,
  .dragging .thumb {
    scale: 1.2857;
  }

  /* The live label "surah · page · juz", above the strip. */
  .bubble {
    position: absolute;
    inset-block-end: calc(100% + 10px);
    padding-block: 3px;
    padding-inline: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-2);
    color: var(--text);
    font-size: var(--text-xs);
    font-weight: var(--weight-label);
    line-height: var(--leading-ui);
    white-space: nowrap;
    pointer-events: none;
  }

  .bubble .num {
    font-variant-numeric: tabular-nums;
  }

  .bubble .sep {
    color: var(--text-faint);
    white-space: pre;
  }

  @media (forced-colors: active) {
    .strip {
      border-color: CanvasText;
    }

    .fill,
    .thumb {
      background-color: Highlight;
    }

    .tick,
    .ghost {
      background-color: CanvasText;
    }
  }
</style>

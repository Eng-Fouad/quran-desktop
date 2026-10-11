<!--
  PageTurnZones (§8.11). Owner: WP8f. The two click zones at the sides of the book. Takes no props: it reads stores
  (§7.9).

  - **Book order, never mirrored** (§11.3): the left zone turns to the next page and the right zone to the previous one,
    in both UI languages.
  - **Where.** 56 px wide and the full canvas height, in the free canvas space beside the paper, hugging it with a
    16 px gap when there is room, narrowed to the free space when there is less. When the free space is too narrow
    for even a narrow zone, only the chevron stays, over the outer paper margin; nothing ever covers the text block.
    A zone that would cover it, or has no page to turn to, is not drawn.
  - **Look.** A 40 px circular chevron (`--surface-raised`, `shadow-1`) at the height of the book's centre: invisible,
    60 % while the pointer is over the canvas, 100 % over the zone or with keyboard focus. In zen they stay hidden
    until the pointer moves, and again when it rests (`ui.pointerIdle`).
  - **Behaviour.** A click turns with the animation (`reader.next()` / `reader.prev()`). A pointer never takes focus,
    so ← → keep turning pages; the zones come after the pages in tab order and carry "Next page" / "Previous page".
    The wheel over a zone scrolls the canvas when it scrolls (zoomed), as over the pages.
-->
<script module lang="ts">
  /** A zone's geometry, in px from its own edge of the page area. */
  export interface ZoneGeometry {
    /** Offset of the zone's outer edge from the page-area edge. */
    start: number
    /** Zone width (the chevron's width in a compact zone). */
    width: number
    /** Chevron diameter. */
    chevron: number
    /** Only the chevron, centred on the book (the free space is too narrow for a full-height zone). */
    compact: boolean
  }

  /** §8.11 zone width. */
  export const ZONE_W = 56
  /** Chevron diameter. */
  export const CHEVRON = 40
  /** Gap between a zone and the paper when there is room. */
  export const ZONE_GAP = 16
  /** A full-height zone needs this much free space; a compact one this much room before the text block. */
  const FULL_MIN = 36
  const COMPACT = 32
  const COMPACT_ROOM = COMPACT + 12

  /** Kept clear at the canvas edges while the canvas scrolls: its overlay scrollbars live there (§9.5). */
  export const SCROLLBAR_CLEARANCE = 12

  /**
   * One side's zone (§8.11) from the free space between the page-area edge and the paper (`free`) and the room up to
   * the text block (`toText`): a full-height zone of at most 56 px in the free space, hugging the paper with a 16 px
   * gap when there is room; a compact chevron over the outer paper margin when the free space is narrower than 36 px;
   * `null` when even that would reach the text block. `edge` px at the page-area edge stay free (scrollbars).
   */
  export function zoneGeometry(free: number, toText: number, edge = 0): ZoneGeometry | null {
    if (!Number.isFinite(free) || !Number.isFinite(toText)) return null
    if (edge > 0) {
      const inner = zoneGeometry(free - edge, toText - edge)
      return inner && { ...inner, start: inner.start + edge }
    }
    if (free >= FULL_MIN) {
      const gap = Math.min(ZONE_GAP, Math.max(4, free - ZONE_W))
      const width = Math.min(ZONE_W, free - gap)
      return {
        start: Math.max(0, free - gap - width),
        width,
        chevron: Math.max(28, Math.min(CHEVRON, width - 4)),
        compact: false,
      }
    }
    if (toText >= COMPACT_ROOM)
      return {
        start: Math.max(4, Math.min(free / 2 - COMPACT / 2, toText - COMPACT - 8)),
        width: COMPACT,
        chevron: COMPACT,
        compact: true,
      }
    return null
  }
</script>

<script lang="ts">
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import { untrack } from 'svelte'
  import { BAR_RESERVE, COMPACT_BAR_RESERVE, PAGE_COUNT, SIDE_DOCK_W } from '$lib/mushaf/geometry'
  import { i18n, quran, reader, ui } from '$lib/stores'

  interface Geometry {
    left: ZoneGeometry | null
    right: ZoneGeometry | null
    /** Offsets of the page area from the canvas's physical left and right edges. */
    areaLeft: number
    areaRight: number
    /** The chevrons' centre line, from the canvas top: the middle of the book's visible part. */
    cy: number
  }

  const NONE: Geometry = { left: null, right: null, areaLeft: 0, areaRight: 0, cy: 0 }

  let layer: HTMLDivElement | undefined = $state()
  let geo = $state.raw<Geometry>(NONE)
  let overCanvas = $state(false)
  /** Zen: the pointer has moved since zen started (§9.6). */
  let zenMoved = $state(false)

  const last = $derived(quran.pageCount(reader.layout) || PAGE_COUNT)
  const canNext = $derived(Math.max(...reader.visiblePages) < last)
  const canPrev = $derived(Math.min(...reader.visiblePages) > 1)
  const zenHidden = $derived(ui.zen && (!zenMoved || ui.pointerIdle))
  const reserveEnd = $derived(reader.dock === 'side' && !ui.zen ? SIDE_DOCK_W : 0)
  const reserveBottom = $derived(
    ui.zen ? 0 : reader.dock === 'bar' ? BAR_RESERVE : reader.dock === 'compact' ? COMPACT_BAR_RESERVE : 0,
  )

  // --- measuring the book --------------------------------------------------------------------------------------------

  function measure(): void {
    const view = layer?.parentElement
    const stage = view?.querySelector('[data-qd-stage]') ?? null
    watchStage(stage)
    const sections = stage ? [...stage.querySelectorAll<HTMLElement>('section.mp')] : []
    if (!view || sections.length === 0) {
      if (geo !== NONE) geo = NONE
      return
    }
    const v = view.getBoundingClientRect()
    const rtl = getComputedStyle(view).direction === 'rtl'
    const areaL = v.left + (rtl ? reserveEnd : 0)
    const areaR = v.right - (rtl ? 0 : reserveEnd)
    let paperL = Number.POSITIVE_INFINITY
    let paperR = Number.NEGATIVE_INFINITY
    let paperT = Number.POSITIVE_INFINITY
    let paperB = Number.NEGATIVE_INFINITY
    let textL = Number.POSITIVE_INFINITY
    let textR = Number.NEGATIVE_INFINITY
    for (const section of sections) {
      const p = section.getBoundingClientRect()
      paperL = Math.min(paperL, p.left)
      paperR = Math.max(paperR, p.right)
      paperT = Math.min(paperT, p.top)
      paperB = Math.max(paperB, p.bottom)
      const b = section.querySelector('.mp-block')?.getBoundingClientRect()
      if (b) {
        textL = Math.min(textL, b.left)
        textR = Math.max(textR, b.right)
      }
    }
    if (!Number.isFinite(textL)) {
      textL = paperL
      textR = paperR
    }
    const top = Math.max(v.top, paperT)
    const bottom = Math.min(v.bottom - reserveBottom, paperB)
    const cy = bottom > top ? (top + bottom) / 2 - v.top : (v.height - reserveBottom) / 2
    const edge = reader.scrolls ? SCROLLBAR_CLEARANCE : 0
    const next: Geometry = {
      left: zoneGeometry(paperL - areaL, textL - areaL, edge),
      right: zoneGeometry(areaR - paperR, areaR - textR, edge),
      areaLeft: areaL - v.left,
      areaRight: v.right - areaR,
      cy: Math.round(cy),
    }
    if (!sameGeometry(geo, next)) geo = next
  }

  function sameGeometry(a: Geometry, b: Geometry): boolean {
    const zone = (x: ZoneGeometry | null, y: ZoneGeometry | null) =>
      x === y ||
      (x !== null &&
        y !== null &&
        Math.abs(x.start - y.start) < 0.5 &&
        Math.abs(x.width - y.width) < 0.5 &&
        x.chevron === y.chevron &&
        x.compact === y.compact)
    return (
      zone(a.left, b.left) &&
      zone(a.right, b.right) &&
      Math.abs(a.areaLeft - b.areaLeft) < 0.5 &&
      Math.abs(a.areaRight - b.areaRight) < 0.5 &&
      a.cy === b.cy
    )
  }

  let frame = 0
  function schedule(): void {
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      measure()
    })
  }

  // Re-measure when the book can move: its pages, size, mode, the dock reserves and the UI direction.
  $effect(() => {
    void reader.visiblePages
    void reader.qfs
    void reader.spread
    void reader.scrolls
    void reserveEnd
    void reserveBottom
    void i18n.dir
    untrack(schedule)
  })

  /** Resizes of the canvas and of the book (the stage element is re-checked on every measure). */
  let resizes: ResizeObserver | null = null
  let observedStage: Element | null = null

  function watchStage(stage: Element | null): void {
    if (!resizes || stage === observedStage) return
    if (observedStage) resizes.unobserve(observedStage)
    observedStage = stage
    if (stage) resizes.observe(stage)
  }

  // …the canvas or the book resizing, and the canvas scrolling (zoomed).
  $effect(() => {
    const view = layer?.parentElement
    if (!view) return
    resizes = new ResizeObserver(schedule)
    resizes.observe(view)
    watchStage(view.querySelector('[data-qd-stage]'))
    const scroller = view.querySelector('[data-scroll-area-viewport]')
    const onScroll = () => schedule()
    scroller?.addEventListener('scroll', onScroll, { passive: true })
    const onMove = () => {
      if (!overCanvas) overCanvas = true
      if (ui.zen && !zenMoved) zenMoved = true
    }
    const onLeave = () => (overCanvas = false)
    view.addEventListener('pointermove', onMove, { passive: true })
    view.addEventListener('pointerleave', onLeave, { passive: true })
    return () => {
      resizes?.disconnect()
      resizes = null
      observedStage = null
      scroller?.removeEventListener('scroll', onScroll)
      view.removeEventListener('pointermove', onMove)
      view.removeEventListener('pointerleave', onLeave)
      cancelAnimationFrame(frame)
      frame = 0
    }
  })

  // Zen starts with the zones hidden until the pointer moves (§9.6).
  $effect(() => {
    if (ui.zen) untrack(() => (zenMoved = false))
  })

  // --- turning -------------------------------------------------------------------------------------------------------

  /** A pointer press never moves focus here: ← → must keep turning pages after a click. */
  function keepFocus(e: MouseEvent): void {
    e.preventDefault()
  }

  /** Over a zone the wheel still scrolls a zoomed canvas, as it does over the pages (§8.13). */
  function onwheel(e: WheelEvent): void {
    if (!reader.scrolls || e.ctrlKey || e.metaKey) return
    const scroller = layer?.parentElement?.querySelector<HTMLElement>('[data-scroll-area-viewport]')
    if (!scroller) return
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? scroller.clientHeight : 1
    scroller.scrollBy({ left: e.deltaX * unit, top: e.deltaY * unit })
  }
</script>

<div
  class="zones"
  bind:this={layer}
  data-active={overCanvas ? '' : undefined}
  data-zen-hidden={zenHidden ? '' : undefined}
  style:--zones-cy={`${geo.cy}px`}
  style:--area-left={`${geo.areaLeft}px`}
  style:--area-right={`${geo.areaRight}px`}
>
  {#if geo.left && canNext}
    <button
      type="button"
      class="zone left"
      class:compact={geo.left.compact}
      style:--zone-start={`${geo.left.start}px`}
      style:--zone-w={`${geo.left.width}px`}
      style:--chev={`${geo.left.chevron}px`}
      aria-label={i18n.t('shortcuts.nav.nextPage')}
      data-qd-turn-zone="next"
      onmousedown={keepFocus}
      onclick={() => reader.next()}
      {onwheel}
    >
      <span class="chev"><ChevronLeft size={20} strokeWidth={1.75} aria-hidden="true" /></span>
    </button>
  {/if}
  {#if geo.right && canPrev}
    <button
      type="button"
      class="zone right"
      class:compact={geo.right.compact}
      style:--zone-start={`${geo.right.start}px`}
      style:--zone-w={`${geo.right.width}px`}
      style:--chev={`${geo.right.chevron}px`}
      aria-label={i18n.t('shortcuts.nav.prevPage')}
      data-qd-turn-zone="prev"
      onmousedown={keepFocus}
      onclick={() => reader.prev()}
      {onwheel}
    >
      <span class="chev"><ChevronRight size={20} strokeWidth={1.75} aria-hidden="true" /></span>
    </button>
  {/if}
</div>

<style>
  /* No box of its own: the zones are positioned against the canvas (`.mushaf-view`). */
  .zones {
    display: contents;
  }

  .zone {
    all: unset;
    position: absolute;
    inset-block: 0;
    z-index: 2;
    inline-size: var(--zone-w);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  /* Physical book order: the left zone is the next page in both UI languages (§8.11, §11.3). */
  .zone.left {
    left: calc(var(--area-left) + var(--zone-start)); /* physical-ok: book order */
  }

  .zone.right {
    right: calc(var(--area-right) + var(--zone-start)); /* physical-ok: book order */
  }

  /* Too little free space for a full-height zone: only the chevron, centred on the book. */
  .zone.compact {
    inset-block: auto;
    inset-block-start: calc(var(--zones-cy) - var(--chev) / 2);
    block-size: var(--chev);
    border-radius: 50%;
  }

  .chev {
    position: absolute;
    inset-block-start: calc(var(--zones-cy) - var(--chev) / 2);
    inset-inline-start: calc(50% - var(--chev) / 2);
    display: grid;
    place-items: center;
    inline-size: var(--chev);
    block-size: var(--chev);
    border-radius: 50%;
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-1);
    color: var(--text-muted);
    opacity: 0;
    transition:
      opacity var(--dur-quick) var(--ease-standard),
      color var(--dur-quick) var(--ease-standard),
      scale var(--dur-fast) var(--ease-standard);
  }

  .compact .chev {
    inset-block-start: 0;
  }

  .zones[data-active] .chev {
    opacity: 0.6;
  }

  .zone:hover .chev {
    opacity: 1;
    color: var(--text);
  }

  .zone:active .chev {
    scale: 0.94;
  }

  /* Zen: hidden until the pointer moves, and again while it rests. */
  .zones[data-zen-hidden] .chev {
    opacity: 0;
  }

  .zone:focus-visible .chev {
    opacity: 1;
    color: var(--text);
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  @media (forced-colors: active) {
    .chev {
      border: 1px solid ButtonText;
    }
  }
</style>

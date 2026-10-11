<!--
  ZoomControl (§8.13). Owner: WP8e. The Mushaf's zoom without the wheel: + / the level / − in a small vertical glass
  capsule pinned to the canvas's top inline-end corner (top right in the English UI, top left in the Arabic UI). Takes
  no props: it reads stores (§7.9). MushafView mounts it once, outside the scroll viewport, so no drag (pan.ts) starts
  on it.

  - **Where.** 40 px wide, 16 px below the canvas top and 12 px in from its inline end (clear of the overlay
    scrollbars). Every fit leaves at least PAD_X + M_OUT·qfs ≥ 58 px between the canvas edge and the running head or
    the text, so at the fit the capsule (52 px in at most) never covers the page, in any dock mode; with the side card
    it sits in the card's reserved column, above the card. "+ above −" needs no mirroring. In zen it moves down by the
    title bar's reveal zone (`ZEN_TOP_ZONE_PX`), so reaching for it never brings the title bar.
  - **Buttons.** + zooms in, the level ("120%", in the UI's numbers) goes back to the fit, − zooms out, all around the
    canvas centre like `Mod+=` / `Mod+0` / `Mod+-`, whose keys their tooltips show (as the user bound them). The button
    that would do nothing (+ at 300 %, the level at the fit, − at 50 %) is `aria-disabled`, so it keeps focus. It is
    also the zoom readout: any zoom in the reader (wheel, pinch, keys, palette) wakes it at full strength for 0.9 s and
    is announced ("Zoom 120%").
  - **Look.** Always there while the Mushaf shows, and quiet so it never competes with the page: 40 % while the
    pointer is elsewhere, 60 % while it is over the canvas (as the turn-zone chevrons, §8.11), 100 % hovered, focused
    or woken. When the Quran text, a running head or a mark lies under it (a zoomed or scrolled book, a dog-ear in the
    tightest fit), it yields: hidden and click-through until the pointer comes within 24 px, it takes focus or a zoom
    wakes it. A held press (a drag on the page) never brings it back. In zen it is hidden until the pointer moves, and
    again while the pointer rests (`ui.pointerIdle`).
  - **Keys.** `role="toolbar"` (vertical) with one tab stop, after the pages, the turn zones, the rail and the slot's
    chips: ↑/↓ and Home/End move between its buttons; Escape hands focus back to the reading cursor and keeps the
    selection. A pointer never takes focus, so ← → keep turning pages after a click. The wheel over it scrolls a zoomed
    canvas, as over the pages, and turns the page while it fits.
-->
<script module lang="ts">
  /** A client rect's edges (px). */
  export interface Box {
    left: number
    top: number
    right: number
    bottom: number
  }

  /**
   * How the control shows: `hidden` (invisible and click-through), `idle` (40 %, the pointer elsewhere), `quiet` (60 %,
   * the pointer over the canvas) or `active` (100 %).
   */
  export type ZoomControlState = 'hidden' | 'idle' | 'quiet' | 'active'

  /** How long any zoom wakes the control at full strength. */
  export const ZOOM_WAKE_MS = 900
  /** A control that yielded to the page comes back when the pointer comes this close (px). */
  export const REACH_PX = 24
  /** It yields to what comes within this distance of it (px). */
  export const TEXT_GAP = 4
  /** What the control never rests on: the Quran text, the running heads and the user's marks. */
  export const PROTECTED = '.mp-block, .mp-head, .mp-dogear, .mp-ribbon, .mp-margin .mk, .mp-margin .mm'

  /** Whether `box` meets any non-empty rect of `rects`, each grown by `gap` on every side. */
  export function overlapsAny(box: Box, rects: readonly Box[], gap = TEXT_GAP): boolean {
    return rects.some(
      (r) =>
        r.right > r.left &&
        r.bottom > r.top &&
        r.left - gap < box.right &&
        r.right + gap > box.left &&
        r.top - gap < box.bottom &&
        r.bottom + gap > box.top,
    )
  }

  /** Whether the client point (`x`, `y`) lies in `box` or within `reach` of it. */
  export function nearBox(x: number, y: number, box: Box, reach = REACH_PX): boolean {
    const dx = Math.max(box.left - x, 0, x - box.right)
    const dy = Math.max(box.top - y, 0, y - box.bottom)
    return Math.hypot(dx, dy) <= reach
  }

  /**
   * §8.13: hovered, focused or woken by a zoom, the control is at full strength; zen hides it until the pointer moves
   * (and while it rests); over the page it yields unless the pointer reaches for it; otherwise it is quiet over the
   * canvas and quieter still away from it.
   */
  export function zoomControlState(s: {
    engaged: boolean
    zenHidden: boolean
    overText: boolean
    near: boolean
    overCanvas: boolean
  }): ZoomControlState {
    if (s.engaged) return 'active'
    if (s.zenHidden) return 'hidden'
    if (s.overText) return s.near ? 'active' : 'hidden'
    return s.overCanvas ? 'quiet' : 'idle'
  }
</script>

<script lang="ts">
  import Minus from '@lucide/svelte/icons/minus'
  import Plus from '@lucide/svelte/icons/plus'
  import { untrack } from 'svelte'
  import IconButton from '$components/ui/IconButton.svelte'
  import { SETTING_LIMITS } from '$lib/contracts/settings'
  import { forwardWheel } from '$lib/mushaf/wheel'
  import { i18n, reader, shortcuts, ui } from '$lib/stores'
  import { A11Y_TAB_STOP, STAGE_SELECTOR } from '$lib/stores/reader.svelte'
  import { ZEN_TOP_ZONE_PX } from '$lib/stores/ui.svelte'

  type Item = 'in' | 'fit' | 'out'
  /** The buttons, top to bottom. */
  const ITEMS: readonly Item[] = ['in', 'fit', 'out']
  const { min, max } = SETTING_LIMITS.zoomPct

  let pill: HTMLDivElement | undefined = $state()

  const pct = $derived(reader.zoomPct)
  const atMin = $derived(pct <= min)
  const atMax = $derived(pct >= max)
  const atFit = $derived(pct === 100)
  const level = $derived(i18n.t('reader.zoom.level', { pct: i18n.num(pct) }))
  /** Tooltips open into the canvas, away from its edge. */
  const tipSide = $derived(i18n.dir === 'rtl' ? 'right' : 'left')

  /** A registered shortcut's label (`shortcuts.format`, as the user bound it), or `undefined`. */
  function keyOf(id: string): string | undefined {
    const def = shortcuts.defs.find((d) => d.id === id)
    return def ? shortcuts.format(def) || undefined : undefined
  }

  const inKey = $derived(keyOf('view.zoomIn'))
  const fitKey = $derived(keyOf('view.zoomFit'))
  const outKey = $derived(keyOf('view.zoomOut'))

  // --- how it shows --------------------------------------------------------------------------------------------------

  let overCanvas = $state(false)
  /** Something `PROTECTED` lies under the capsule. */
  let overText = $state(false)
  /** The pointer is within `REACH_PX` of the capsule. */
  let near = $state(false)
  let hovering = $state(false)
  let focusWithin = $state(false)
  /** Within `ZOOM_WAKE_MS` of a zoom. */
  let woken = $state(false)
  /** Zen: the pointer has moved since zen started (§9.6). */
  let zenMoved = $state(false)
  /** The toolbar's one tab stop. */
  let roving = $state<Item>('in')

  const zenHidden = $derived(ui.zen && (!zenMoved || ui.pointerIdle))
  const presence = $derived(
    zoomControlState({ engaged: hovering || focusWithin || woken, zenHidden, overText, near, overCanvas }),
  )

  // Zen starts with the control hidden until the pointer moves (§9.6).
  $effect(() => {
    if (ui.zen) untrack(() => (zenMoved = false))
  })

  // Any zoom wakes the control and is announced: it is the zoom readout.
  let wakeTimer: ReturnType<typeof setTimeout> | undefined
  let seen = untrack(() => reader.zoomPct)
  $effect(() => {
    const value = reader.zoomPct
    untrack(() => {
      if (value === seen) return
      seen = value
      woken = true
      clearTimeout(wakeTimer)
      wakeTimer = setTimeout(() => (woken = false), ZOOM_WAKE_MS)
      ui.announce(i18n.t('reader.zoom.announce', { pct: i18n.num(value) }))
    })
  })
  $effect(() => () => clearTimeout(wakeTimer))

  // --- what lies under it --------------------------------------------------------------------------------------------

  /** The capsule's client box at the last measure (it keeps its layout while hidden); `null` before the first. */
  let box: Box | null = null

  function measure(): void {
    const view = pill?.parentElement
    if (!pill || !view) return
    const stage = view.querySelector(STAGE_SELECTOR)
    watchStage(stage)
    const r = pill.getBoundingClientRect()
    box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    const rects = stage ? [...stage.querySelectorAll(PROTECTED)].map((el) => el.getBoundingClientRect()) : []
    const over = overlapsAny(box, rects)
    if (over !== overText) overText = over
  }

  let frame = 0
  /** One measure per frame at most, and none while flipping (the flip's end measures once). */
  function schedule(): void {
    if (frame !== 0 || reader.flipping) return
    frame = requestAnimationFrame(() => {
      frame = 0
      measure()
    })
  }

  // Re-measure when the capsule or the book can move: zen, the UI direction, the book's size, a flip ending.
  $effect(() => {
    void ui.zen
    void i18n.dir
    void reader.qfs
    void reader.scrolls
    if (reader.flipping) return
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

  // …the canvas or the book resizing, the canvas scrolling, pages turning and marks arriving late, and the pointer.
  $effect(() => {
    const view = pill?.parentElement
    if (!view) return
    resizes = new ResizeObserver(schedule)
    resizes.observe(view)
    watchStage(view.querySelector(STAGE_SELECTOR))
    const scroller = view.querySelector('[data-scroll-area-viewport]')
    const onScroll = () => schedule()
    scroller?.addEventListener('scroll', onScroll, { passive: true })
    // Highlights (hover, selection, recitation) never move what the control yields to.
    const mutations = new MutationObserver((records) => {
      if (records.some((r) => !(r.target instanceof Element && r.target.closest('.mp-hl')))) schedule()
    })
    if (scroller) mutations.observe(scroller, { childList: true, subtree: true })
    const onMove = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') return
      if (!overCanvas) overCanvas = true
      if (ui.zen && !zenMoved) zenMoved = true
      // A held press (a drag on the page) never brings a yielded control back.
      if (e.buttons !== 0) return
      const reach = box !== null && nearBox(e.clientX, e.clientY, box)
      if (reach !== near) near = reach
    }
    const onLeave = (): void => {
      overCanvas = false
      near = false
    }
    view.addEventListener('pointermove', onMove, { passive: true })
    view.addEventListener('pointerleave', onLeave, { passive: true })
    return () => {
      resizes?.disconnect()
      resizes = null
      observedStage = null
      mutations.disconnect()
      scroller?.removeEventListener('scroll', onScroll)
      view.removeEventListener('pointermove', onMove)
      view.removeEventListener('pointerleave', onLeave)
      cancelAnimationFrame(frame)
      frame = 0
    }
  })

  // --- input ---------------------------------------------------------------------------------------------------------

  /** A pointer press never moves focus here: ← → must keep turning pages after a click (§8.11). */
  function keepFocus(e: MouseEvent): void {
    e.preventDefault()
  }

  function onpointerenter(e: PointerEvent): void {
    if (e.pointerType !== 'touch') hovering = true
  }

  function onpointerleave(e: PointerEvent): void {
    if (e.pointerType !== 'touch') hovering = false
  }

  /** Over the capsule the wheel scrolls a zoomed canvas, as over the pages; it bubbles on to `use:wheel` (§8.13). */
  function onwheel(e: WheelEvent): void {
    const view = pill?.parentElement
    if (view) forwardWheel(e, view)
  }

  function onfocusin(e: FocusEvent): void {
    focusWithin = true
    const item = e.target instanceof HTMLElement ? e.target.dataset.zoom : undefined
    if (item === 'in' || item === 'fit' || item === 'out') roving = item
  }

  function onfocusout(e: FocusEvent): void {
    if (!(e.relatedTarget instanceof Node && pill?.contains(e.relatedTarget))) focusWithin = false
  }

  /** Toolbar keys; plain keys inside a toolbar never reach the reader's shortcuts (§7.7 widget guard). */
  function onkeydown(e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const i = ITEMS.indexOf(roving)
    let next: Item | undefined
    switch (e.key) {
      case 'ArrowDown':
        next = ITEMS[(i + 1) % ITEMS.length]
        break
      case 'ArrowUp':
        next = ITEMS[(i - 1 + ITEMS.length) % ITEMS.length]
        break
      case 'Home':
        next = ITEMS[0]
        break
      case 'End':
        next = ITEMS[ITEMS.length - 1]
        break
      case 'Escape': {
        // Consumed, so the reader's Escape keeps the selection: focus goes back to the reading cursor.
        e.preventDefault()
        const cursor =
          document.querySelector<HTMLElement>(A11Y_TAB_STOP) ?? document.getElementById('qd-main')
        cursor?.focus({ preventScroll: true })
        return
      }
      default:
        return
    }
    e.preventDefault()
    if (next === undefined) return
    roving = next
    pill?.querySelector<HTMLElement>(`[data-zoom="${next}"]`)?.focus()
  }
</script>

<div
  bind:this={pill}
  class="zoom"
  role="toolbar"
  aria-orientation="vertical"
  aria-label={i18n.t('reader.zoom.control')}
  tabindex="-1"
  data-qd-zoom-control=""
  data-qd-keep-selection=""
  data-state={presence}
  style:--zc-zen-top={ui.zen ? `${ZEN_TOP_ZONE_PX}px` : undefined}
  onmousedown={keepFocus}
  {onkeydown}
  {onfocusin}
  {onfocusout}
  {onpointerenter}
  {onpointerleave}
  {onwheel}
>
  <IconButton
    data-zoom="in"
    size="sm"
    icon={Plus}
    label={i18n.t('shortcuts.view.zoomIn')}
    shortcut={inKey}
    tooltipSide={tipSide}
    tabindex={roving === 'in' ? 0 : -1}
    aria-disabled={atMax || undefined}
    onclick={() => {
      if (!atMax) reader.zoomIn()
    }}
  />
  <IconButton
    data-zoom="fit"
    size="sm"
    class="zc-level"
    label={i18n.t('reader.zoom.reset', { pct: i18n.num(pct) })}
    tooltip={i18n.t('reader.zoom.fit')}
    shortcut={fitKey}
    tooltipSide={tipSide}
    tabindex={roving === 'fit' ? 0 : -1}
    aria-disabled={atFit || undefined}
    onclick={() => {
      if (!atFit) reader.zoomReset()
    }}
  >
    {level}
  </IconButton>
  <IconButton
    data-zoom="out"
    size="sm"
    icon={Minus}
    label={i18n.t('shortcuts.view.zoomOut')}
    shortcut={outKey}
    tooltipSide={tipSide}
    tabindex={roving === 'out' ? 0 : -1}
    aria-disabled={atMin || undefined}
    onclick={() => {
      if (!atMin) reader.zoomOut()
    }}
  />
</div>

<style>
  /* 40 × 92 px: 3 px padding, 28 / 24 / 28 px buttons, 2 px gaps. */
  .zoom {
    position: absolute;
    inset-block-start: calc(var(--space-4) + var(--zc-zen-top, 0px));
    inset-inline-end: var(--space-3);
    z-index: var(--z-popover);
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    inline-size: 40px;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    /* Floating glass (§9.4); an opaque raised surface where blur is not allowed (reduced transparency, Linux, forced
       colours). */
    background-color: var(--glass-fill);
    backdrop-filter: var(--backdrop-dock);
    box-shadow: var(--shadow-2);
    color: var(--text-muted);
    -webkit-user-select: none;
    user-select: none;
    opacity: 0.4;
    transition: opacity var(--dur-quick) var(--ease-standard);
  }

  .zoom[data-state='quiet'] {
    opacity: 0.6;
  }

  .zoom[data-state='active'] {
    opacity: 1;
  }

  /* Yielded to the page, or zen: invisible, and a click reaches the page under it. */
  .zoom[data-state='hidden'] {
    opacity: 0;
    pointer-events: none;
  }

  .zoom :global(.icon-button) {
    inline-size: 100%;
    block-size: 28px;
    border-radius: var(--radius-full);
  }

  .zoom :global(.zc-level) {
    block-size: 24px;
    color: var(--text);
    font-size: var(--text-2xs);
    font-weight: var(--weight-label);
    font-variant-numeric: tabular-nums;
    line-height: 1;
    white-space: nowrap;
  }

  /* At the fit the level stays a readable readout, not a dimmed button. */
  .zoom :global(.zc-level[aria-disabled='true']) {
    opacity: 1;
    color: var(--text-muted);
  }

  @media (forced-colors: active) {
    .zoom {
      border-color: CanvasText;
    }
  }
</style>

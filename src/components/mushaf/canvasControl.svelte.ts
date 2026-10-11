/**
 * How a control floating on the reading canvas shows (§8.13). Owner: WP8e. Shared by the Mushaf's zoom capsule
 * (`ZoomControl`) and the "Aa" display button (`DisplayControl`, in both reading modes), so the two look and yield
 * alike.
 *
 * - `idle` (40 %) with the pointer off the canvas, `quiet` (60 %) over it, `active` (100 %) while engaged: hovered,
 *   focused, or whatever the control adds (an open popover, a zoom's wake).
 * - It yields to what the caller names (`covers`: the Quran text, running heads and marks; the translation paper):
 *   while any of it lies within `TEXT_GAP` of the control, the control is `hidden` and click-through until the pointer
 *   comes within `REACH_PX` of it, it takes focus or it is engaged. A held press (a drag on the page) never brings it
 *   back.
 * - Zen (§9.6): hidden until the pointer moves, and again while it rests (`ui.pointerIdle`).
 * - Measured at most once a frame, after the canvas or `watched` resizes, the `scroller` scrolls or changes, or `deps`
 *   change; never while `paused` (a flip), whose end measures once.
 *
 * Create it during component initialisation (it registers effects) and wire its pointer and focus methods to the
 * control's root.
 */
import { untrack } from 'svelte'
import { ui } from '$lib/stores/ui.svelte'

/** A client rect's edges (px). */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * How a control shows: `hidden` (invisible and click-through), `idle` (40 %, the pointer elsewhere), `quiet` (60 %,
 * the pointer over the canvas) or `active` (100 %).
 */
export type CanvasControlState = 'hidden' | 'idle' | 'quiet' | 'active'

/** A control that yielded to the page comes back when the pointer comes this close (px). */
export const REACH_PX = 24
/** It yields to what comes within this distance of it (px). */
export const TEXT_GAP = 4
/** What the Mushaf's controls never rest on: the Quran text, the running heads and the user's marks. */
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
 * §8.13: engaged (hovered, focused, open, woken), the control is at full strength; zen hides it until the pointer
 * moves (and while it rests); over what it yields to it hides unless the pointer reaches for it; otherwise it is quiet
 * over the canvas and quieter still away from it.
 */
export function canvasControlState(s: {
  engaged: boolean
  zenHidden: boolean
  overText: boolean
  near: boolean
  overCanvas: boolean
}): CanvasControlState {
  if (s.engaged) return 'active'
  if (s.zenHidden) return 'hidden'
  if (s.overText) return s.near ? 'active' : 'hidden'
  return s.overCanvas ? 'quiet' : 'idle'
}

export interface CanvasControlOptions {
  /** The control's root (`bind:this`); its parent element is the canvas view whose size and pointer it follows. */
  element: () => HTMLElement | undefined
  /** What it never rests on, as client rects (empty ones are ignored). */
  covers: (view: HTMLElement) => readonly Box[]
  /** An element whose resizes move what it yields to (the book), looked up again at every measure. */
  watched?: (view: HTMLElement) => Element | null
  /** The view's scroller: its scrolling and its DOM changes move what it yields to. */
  scroller?: (view: HTMLElement) => Element | null
  /** DOM changes in the scroller that never move what it yields to (the Mushaf's highlights). */
  ignore?: (target: Node) => boolean
  /** Read in an effect: whatever moves the control or what it yields to (zen, the direction, the book's size). */
  deps?: () => void
  /** No measure while this holds (a flip); it is read with `deps`, so its end measures once. */
  paused?: () => boolean
}

export class CanvasControl {
  /** The pointer is over the canvas. */
  overCanvas = $state(false)
  /** Something it yields to lies under it. */
  overText = $state(false)
  /** The pointer is within `REACH_PX` of it. */
  near = $state(false)
  hovering = $state(false)
  focusWithin = $state(false)
  /** Zen: the pointer has moved since zen started (§9.6). */
  zenMoved = $state(false)

  readonly #options: CanvasControlOptions
  /** The control's client box at the last measure (it keeps its layout while hidden); `null` before the first. */
  #box: Box | null = null
  #frame = 0
  /** Resizes of the canvas and of `watched` (re-checked on every measure). */
  #resizes: ResizeObserver | null = null
  #observed: Element | null = null

  constructor(options: CanvasControlOptions) {
    this.#options = options

    // Zen starts with the control hidden until the pointer moves (§9.6).
    $effect(() => {
      if (ui.zen) untrack(() => (this.zenMoved = false))
    })

    // Re-measure when the control or what it yields to can move.
    $effect(() => {
      options.deps?.()
      if (options.paused?.()) return
      untrack(() => this.#schedule())
    })

    // …the canvas resizing, the scroller scrolling or changing, and the pointer over the canvas.
    $effect(() => {
      const view = options.element()?.parentElement
      if (!view) return
      return untrack(() => this.#follow(view))
    })
  }

  /** How it shows; `engaged` adds what the control itself counts (an open popover, a zoom's wake). */
  state(engaged = false): CanvasControlState {
    return canvasControlState({
      engaged: engaged || this.hovering || this.focusWithin,
      zenHidden: ui.zen && (!this.zenMoved || ui.pointerIdle),
      overText: this.overText,
      near: this.near,
      overCanvas: this.overCanvas,
    })
  }

  pointerEnter(e: PointerEvent): void {
    if (e.pointerType !== 'touch') this.hovering = true
  }

  pointerLeave(e: PointerEvent): void {
    if (e.pointerType !== 'touch') this.hovering = false
  }

  focusIn(): void {
    this.focusWithin = true
  }

  focusOut(e: FocusEvent): void {
    const root = this.#options.element()
    if (!(e.relatedTarget instanceof Node && root?.contains(e.relatedTarget))) this.focusWithin = false
  }

  #measure(): void {
    const control = this.#options.element()
    const view = control?.parentElement
    if (!control || !view) return
    this.#observe(this.#options.watched?.(view) ?? null)
    const r = control.getBoundingClientRect()
    const box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    this.#box = box
    const over = overlapsAny(box, this.#options.covers(view))
    if (over !== this.overText) this.overText = over
  }

  /** One measure per frame at most, and none while paused (its end measures once). */
  #schedule(): void {
    if (this.#frame !== 0 || this.#options.paused?.()) return
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0
      this.#measure()
    })
  }

  #observe(el: Element | null): void {
    if (!this.#resizes || el === this.#observed) return
    if (this.#observed) this.#resizes.unobserve(this.#observed)
    this.#observed = el
    if (el) this.#resizes.observe(el)
  }

  #follow(view: HTMLElement): () => void {
    const schedule = (): void => this.#schedule()
    this.#resizes = new ResizeObserver(schedule)
    this.#resizes.observe(view)
    this.#observe(this.#options.watched?.(view) ?? null)
    const scroller = this.#options.scroller?.(view) ?? null
    scroller?.addEventListener('scroll', schedule, { passive: true })
    const ignore = this.#options.ignore
    const mutations = new MutationObserver((records) => {
      if (records.some((r) => !ignore?.(r.target))) schedule()
    })
    if (scroller) mutations.observe(scroller, { childList: true, subtree: true })
    const onMove = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') return
      if (!this.overCanvas) this.overCanvas = true
      if (ui.zen && !this.zenMoved) this.zenMoved = true
      // A held press (a drag on the page) never brings a yielded control back.
      if (e.buttons !== 0) return
      const reach = this.#box !== null && nearBox(e.clientX, e.clientY, this.#box)
      if (reach !== this.near) this.near = reach
    }
    const onLeave = (): void => {
      this.overCanvas = false
      this.near = false
    }
    view.addEventListener('pointermove', onMove, { passive: true })
    view.addEventListener('pointerleave', onLeave, { passive: true })
    return () => {
      this.#resizes?.disconnect()
      this.#resizes = null
      this.#observed = null
      mutations.disconnect()
      scroller?.removeEventListener('scroll', schedule)
      view.removeEventListener('pointermove', onMove)
      view.removeEventListener('pointerleave', onLeave)
      cancelAnimationFrame(this.#frame)
      this.#frame = 0
    }
  }
}

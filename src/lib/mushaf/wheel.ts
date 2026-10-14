/**
 * Wheel and touchpad gestures on the Mushaf canvas.
 *
 * - **Zoom.** `Mod`+wheel, and a touchpad pinch (which browsers deliver as Ctrl+wheel), zoom by 10 % steps anchored at
 *   the pointer (`reader.zoomAt`). A wheel notch (one event of ≥ 50 px, or a line/page-mode event) is one step; the
 *   small deltas of a pinch accumulate, one step per 60 px.
 * - **Turns, while the page fits.** Deltas are normalised (`deltaMode`: lines × 16 px, pages × the canvas height). A
 *   *gesture* ends after 160 ms without wheel events, and one gesture turns **at most one page** (touchpad flings and
 *   free-spinning wheels stream events for 600–1200 ms and used to turn twice). Per gesture, 120 px vertical or 80 px
 *   horizontal turn the page: `deltaY > 0` (scrolling down) is the next page, and so is swiping right (`deltaX < 0`,
 *   RTL book). A gesture that opens with a single large event (a mouse-wheel notch, ≥ 50 px) turns at once, so one
 *   notch is one page. A 400 ms floor between turns remains.
 * - **Scrolling.** When zoomed past the fit, or when the canvas scrolls because `qfs` hit `QFS_MIN`, the wheel scrolls
 *   natively (`reader.scrolls`).
 *
 * The decision logic is the pure `WheelGestures` class (unit-tested with synthetic event streams); `wheel` is the Svelte
 * action that feeds it from the canvas and acts on its answers.
 */
import { app } from '$lib/stores/app.svelte'
import { reader } from '$lib/stores/reader.svelte'
import { ui } from '$lib/stores/ui.svelte'

/** `deltaMode` line height in px. */
export const LINE_PX = 16
/** A gesture ends after this long without wheel events. */
export const GESTURE_IDLE_MS = 160
/** Per gesture: this much vertical travel turns the page. */
export const TURN_Y_PX = 120
/** Per gesture: this much horizontal travel turns the page. */
export const TURN_X_PX = 80
/** At least this long between two wheel turns. */
export const TURN_FLOOR_MS = 400
/** A gesture that opens with one event at least this large is a mouse-wheel notch: it acts at once. */
export const NOTCH_PX = 50
/** A pinch (small Ctrl+wheel deltas) zooms one step per this much accumulated travel. */
export const PINCH_STEP_PX = 60
/** One zoom step, in percent. */
export const ZOOM_STEP_PCT = 10

/** Wheel delta in px (`deltaMode`: lines × 16 px, pages × the canvas height). */
export function normalizeDelta(delta: number, deltaMode: number, pageHeight: number): number {
  if (!Number.isFinite(delta)) return 0
  return deltaMode === 1 ? delta * LINE_PX : deltaMode === 2 ? delta * pageHeight : delta
}

/** The fields of a `WheelEvent` the gesture logic reads. */
export interface WheelSample {
  deltaX: number
  deltaY: number
  deltaMode: number
  ctrlKey: boolean
  metaKey: boolean
  /** `Event.timeStamp` (ms). */
  timeStamp: number
}

export interface WheelContext {
  /** The canvas height (px), for `deltaMode` 2. */
  pageHeight: number
  /** The page fits the canvas: plain wheel turns pages instead of scrolling. */
  fits: boolean
  /** macOS: `Mod` is ⌘ (a pinch still arrives as Ctrl+wheel). */
  isMac: boolean
}

/** What to do with one wheel event. */
export type WheelIntent =
  | { type: 'turn'; dir: 'next' | 'prev' }
  /** Zoom by `steps` × 10 % (positive zooms in). */
  | { type: 'zoom'; steps: number }
  /** Swallow the event: part of a gesture that already turned, or below the threshold. */
  | { type: 'consume' }
  /** Leave it to native scrolling. */
  | { type: 'scroll' }

const CONSUME: WheelIntent = { type: 'consume' }
const SCROLL: WheelIntent = { type: 'scroll' }

/** The gesture rules over a stream of wheel events (one instance per canvas). */
export class WheelGestures {
  #lastAt = Number.NEGATIVE_INFINITY
  #accX = 0
  #accY = 0
  #opening = true
  #turned = false
  #lastTurnAt = Number.NEGATIVE_INFINITY
  #zoomAt = Number.NEGATIVE_INFINITY
  #zoomAcc = 0

  next(e: WheelSample, ctx: WheelContext): WheelIntent {
    const t = e.timeStamp
    if (e.ctrlKey || (ctx.isMac && e.metaKey)) return this.#zoom(e, ctx, t)
    if (!ctx.fits) {
      this.#lastAt = Number.NEGATIVE_INFINITY
      return SCROLL
    }
    if (t - this.#lastAt > GESTURE_IDLE_MS || t < this.#lastAt) {
      this.#accX = 0
      this.#accY = 0
      this.#opening = true
      this.#turned = false
    }
    this.#lastAt = t
    if (this.#turned) return CONSUME

    const dx = normalizeDelta(e.deltaX, e.deltaMode, ctx.pageHeight)
    const dy = normalizeDelta(e.deltaY, e.deltaMode, ctx.pageHeight)
    this.#accX += dx
    this.#accY += dy
    const notch = this.#opening && (e.deltaMode !== 0 || Math.max(Math.abs(dx), Math.abs(dy)) >= NOTCH_PX)
    this.#opening = false

    let dir: 'next' | 'prev' | null = null
    if (Math.abs(this.#accY) >= TURN_Y_PX || (notch && Math.abs(dy) >= Math.abs(dx) && dy !== 0)) {
      dir = this.#accY > 0 ? 'next' : 'prev'
    } else if (Math.abs(this.#accX) >= TURN_X_PX || (notch && dx !== 0)) {
      // RTL book: swiping right (content follows the fingers to the right, deltaX < 0) brings the next page.
      dir = this.#accX < 0 ? 'next' : 'prev'
    }
    if (dir === null || t - this.#lastTurnAt < TURN_FLOOR_MS) return CONSUME
    this.#turned = true
    this.#lastTurnAt = t
    return { type: 'turn', dir }
  }

  #zoom(e: WheelSample, ctx: WheelContext, t: number): WheelIntent {
    if (t - this.#zoomAt > GESTURE_IDLE_MS || t < this.#zoomAt) this.#zoomAcc = 0
    this.#zoomAt = t
    const dy = normalizeDelta(e.deltaY, e.deltaMode, ctx.pageHeight)
    if (dy === 0) return CONSUME
    if (e.deltaMode !== 0 || Math.abs(dy) >= NOTCH_PX) {
      // A wheel notch: one step, whatever its size.
      this.#zoomAcc = 0
      return { type: 'zoom', steps: dy < 0 ? 1 : -1 }
    }
    this.#zoomAcc += dy
    const n = Math.trunc(this.#zoomAcc / PINCH_STEP_PX)
    if (n === 0) return CONSUME
    this.#zoomAcc -= n * PINCH_STEP_PX
    return { type: 'zoom', steps: -n }
  }

  reset(): void {
    this.#lastAt = Number.NEGATIVE_INFINITY
    this.#accX = 0
    this.#accY = 0
    this.#opening = true
    this.#turned = false
    this.#lastTurnAt = Number.NEGATIVE_INFINITY
    this.#zoomAt = Number.NEGATIVE_INFINITY
    this.#zoomAcc = 0
  }
}

/**
 * A plain wheel over a control that floats on the canvas outside its scroll viewport (the zoom control): it scrolls a
 * zoomed canvas as it would over the pages, by the event's normalised deltas. Nothing happens while the page
 * fits (`use:wheel` turns it as the event bubbles on) or with `Mod`/Ctrl held (a zoom at the pointer).
 */
export function forwardWheel(e: WheelEvent, view: Element, scrolls = reader.scrolls): void {
  if (!scrolls || e.ctrlKey || e.metaKey) return
  const scroller = view.querySelector<HTMLElement>('[data-scroll-area-viewport]')
  if (!scroller) return
  const h = scroller.clientHeight
  scroller.scrollBy({
    left: normalizeDelta(e.deltaX, e.deltaMode, h),
    top: normalizeDelta(e.deltaY, e.deltaMode, h),
  })
}

/**
 * The Svelte action on the Mushaf canvas (`use:wheel` in `MushafView`): zoom anchored at the pointer, one page per
 * gesture while the page fits, native scrolling otherwise. Nothing happens while a menu, popover or dialog is open.
 */
export function wheel(node: HTMLElement): { destroy(): void } {
  const gestures = new WheelGestures()
  const onWheel = (e: WheelEvent): void => {
    if (ui.layerOpen) return
    const intent = gestures.next(e, {
      pageHeight: node.clientHeight,
      fits: !reader.scrolls,
      isMac: app.isMac,
    })
    switch (intent.type) {
      case 'scroll':
        return
      case 'consume':
        e.preventDefault()
        return
      case 'zoom':
        e.preventDefault()
        reader.zoomAt(intent.steps * ZOOM_STEP_PCT, e.clientX, e.clientY)
        return
      case 'turn':
        e.preventDefault()
        if (intent.dir === 'next') reader.next()
        else reader.prev()
    }
  }
  node.addEventListener('wheel', onWheel, { passive: false })
  return {
    destroy() {
      node.removeEventListener('wheel', onWheel)
    },
  }
}

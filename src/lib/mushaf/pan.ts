/**
 * Drag on the Mushaf canvas (§8.13, §10.2). Owner: WP8e.
 *
 * A left-button press of the mouse or a pen on the book or its margins (anything inside the canvas's scroll viewport)
 * is a click until it travels past the slop, and a drag from then on. What the drag does is fixed at the press, from
 * the zoom (`reader.zoomPct`):
 *
 * - **At the fit or below (≤ 100 %): a swipe.** A horizontal-dominant drag turns one page **on release**: 80 px of
 *   travel (`TURN_X_PX`, the wheel's horizontal swipe), or a flick of 30 px within 250 ms of the press. Book order,
 *   never mirrored by the UI language: dragging right brings the next page, as swiping right on a touchpad does
 *   (wheel.ts), and the next page enters from the left. Deciding on release lets the user drag back to cancel; one
 *   drag turns at most one page, through `reader.next()` / `reader.prev()` (animated, like a turn-zone click, so the
 *   `pageTurnAnimation` setting and reduced motion apply as there). While the canvas still scrolls at the fit (`qfs`
 *   held at `QFS_MIN`), a drag that sets off vertical-dominant pans the canvas vertically instead and never turns.
 *   No rubber band: the spread stays put (a turn is a view-transition snapshot of it); the cursor and the lit chevron
 *   of the zone the release turns to (PageTurnZones) are the feedback.
 * - **Zoomed past the fit (> 100 %): a pan.** The canvas follows the pointer on both axes, with no inertia.
 *
 * A swipe's slop is 8 px, so a slightly shaky click on a word still selects its ayah; a pan's is 4 px (the click rule
 * of interactions.ts). The pointer is captured only once the slop is crossed, so word clicks keep their targets. After
 * a drag, the click (and dblclick) the browser dispatches with the release is swallowed at `window`, so nothing on the
 * page (a word, the blank-canvas clear, a surah header, a margin marker or mark) takes the drag for a click. The book
 * is never a native text-selection surface (`user-select: none`, MushafView and lines.css): copy goes through the ayah
 * selection (§8.14).
 *
 * Touch stays native. Another button, a non-primary pointer, macOS Ctrl+click (a secondary click) and a press while a
 * menu, popover or dialog is open (it is the outside click that closes the layer) never arm a drag. Escape, a context
 * menu, a pointercancel, losing the pointer capture or the window's focus, and a layer opening cancel one without a
 * turn.
 *
 * The decision logic is the pure `DragGesture` class (unit-tested); `pan` is the Svelte action that feeds it from the
 * canvas and acts on its answers.
 */
import { app } from '$lib/stores/app.svelte'
import { reader } from '$lib/stores/reader.svelte'
import { ui } from '$lib/stores/ui.svelte'
import { CLICK_SLOP_PX, pointerDragEnded, pointerDragStarted } from './interactions'
import type { TurnDir } from './transitions'
import { TURN_X_PX } from './wheel'

/** A swipe (at the fit or below) is a drag past this much travel from the press; below it the press is a click. */
export const SWIPE_SLOP_PX = 8
/** A pan (zoomed past the fit) follows the pointer past this much travel (the click rule of interactions.ts). */
export const PAN_SLOP_PX = CLICK_SLOP_PX
/** A swipe turns the page with this much horizontal travel (the wheel's horizontal swipe threshold). */
export const DRAG_TURN_PX = TURN_X_PX
/** …or with a flick: this much horizontal travel… */
export const FLICK_PX = 30
/** …within this long of the press. */
export const FLICK_MS = 250

/** How a press is read, fixed at the press: `swipe` at the fit or below, `pan` zoomed past it. */
export type DragMode = 'swipe' | 'pan'
/** What a drag does past the slop: pan both axes, pan vertically only (a swipe on a canvas that scrolls), or swipe. */
export type DragKind = 'pan' | 'pan-y' | 'swipe'

export interface DragPoint {
  x: number
  y: number
  /** `Event.timeStamp` (ms). */
  t: number
}

export interface DragMove {
  /** This move took the press past the slop: the drag starts here. */
  started: boolean
  /**
   * The travel the canvas follows (px), 0 on an axis that does not pan: since the previous move, or on the move that
   * starts the drag the whole travel from the press, so the grabbed point stays under the pointer.
   */
  dx: number
  dy: number
  /** A swipe: the page its release here would turn to (by distance; the feedback), else `null`. */
  armed: TurnDir | null
}

/** A release: a press that never became a drag is a click; a drag may turn a page. */
export type DragEnd = { type: 'click' } | { type: 'drag'; turn: TurnDir | null }

const STILL: DragMove = { started: false, dx: 0, dy: 0, armed: null }
const CLICK: DragEnd = { type: 'click' }

/**
 * The page a swipe of (`dx`, `dy`) px over `ms` turns to: horizontal-dominant, and far enough or quick enough. RTL
 * book: right (`dx > 0`) is the next page.
 */
export function swipeTurn(dx: number, dy: number, ms: number): TurnDir | null {
  const ax = Math.abs(dx)
  if (ax <= Math.abs(dy)) return null
  if (ax < DRAG_TURN_PX && !(ax >= FLICK_PX && ms <= FLICK_MS)) return null
  return dx > 0 ? 'next' : 'prev'
}

/** The §8.13 drag rules over one press at a time (one instance per canvas). */
export class DragGesture {
  #start: DragPoint | null = null
  #lastX = 0
  #lastY = 0
  #mode: DragMode = 'swipe'
  #scrolls = false
  #kind: DragKind | null = null

  /** A press. `scrolls`: the canvas scrolls at the fit (`qfs` held at `QFS_MIN`), so a vertical swipe pans instead. */
  down(p: DragPoint, mode: DragMode, scrolls = false): void {
    this.#start = p
    this.#lastX = p.x
    this.#lastY = p.y
    this.#mode = mode
    this.#scrolls = scrolls
    this.#kind = null
  }

  move(p: DragPoint): DragMove {
    const start = this.#start
    if (!start) return STILL
    const tx = p.x - start.x
    const ty = p.y - start.y
    const started = this.#kind === null
    if (started && !this.#begin(tx, ty)) return STILL
    const dx = p.x - this.#lastX
    const dy = p.y - this.#lastY
    this.#lastX = p.x
    this.#lastY = p.y
    switch (this.#kind) {
      case 'pan':
        return { started, dx, dy, armed: null }
      case 'pan-y':
        return { started, dx: 0, dy, armed: null }
      default:
        return { started, dx: 0, dy: 0, armed: swipeTurn(tx, ty, Number.POSITIVE_INFINITY) }
    }
  }

  /** The release at `p`, which ends the press; `null` without one (never pressed, or cancelled). */
  up(p: DragPoint): DragEnd | null {
    const start = this.#start
    if (!start) return null
    const tx = p.x - start.x
    const ty = p.y - start.y
    const dragged = this.#kind !== null || this.#begin(tx, ty)
    const kind = this.#kind
    this.cancel()
    if (!dragged) return CLICK
    return { type: 'drag', turn: kind === 'swipe' ? swipeTurn(tx, ty, p.t - start.t) : null }
  }

  /** Forgets the press. */
  cancel(): void {
    this.#start = null
    this.#kind = null
  }

  /** A press is being followed (a click or a drag). */
  get active(): boolean {
    return this.#start !== null
  }

  /** The press went past the slop. */
  get dragging(): boolean {
    return this.#kind !== null
  }

  /** What the drag does, once it started. */
  get kind(): DragKind | null {
    return this.#kind
  }

  get mode(): DragMode {
    return this.#mode
  }

  /** Past the slop, the drag starts: its kind is decided by the mode and, for a swipe that scrolls, the first axis. */
  #begin(tx: number, ty: number): boolean {
    const slop = this.#mode === 'pan' ? PAN_SLOP_PX : SWIPE_SLOP_PX
    if (Math.hypot(tx, ty) <= slop) return false
    this.#kind =
      this.#mode === 'pan' ? 'pan' : this.#scrolls && Math.abs(ty) > Math.abs(tx) ? 'pan-y' : 'swipe'
    const start = this.#start
    if (start) {
      this.#lastX = start.x
      this.#lastY = start.y
    }
    return true
  }
}

/** Presses that are never a drag: form fields, editable text, and anything that opts out. */
const NO_DRAG = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-qd-no-drag]'

/**
 * Swallows the click (and dblclick) the browser dispatches with a drag's release, in the same task as the pointerup.
 * Its target differs by engine under pointer capture (Chromium: the capturing canvas; WebKit: the common ancestor), so
 * it is caught at `window` before any of them; the next task removes the trap, so a later real click is never eaten.
 */
function swallowClick(): void {
  const swallow = (e: MouseEvent): void => {
    e.preventDefault()
    e.stopImmediatePropagation()
  }
  window.addEventListener('click', swallow, true)
  window.addEventListener('dblclick', swallow, true)
  setTimeout(() => {
    window.removeEventListener('click', swallow, true)
    window.removeEventListener('dblclick', swallow, true)
  }, 0)
}

/**
 * The Svelte action on the Mushaf canvas (`use:pan` in `MushafView`): a swipe turns a page on release at the fit or
 * below, a pan moves the zoomed canvas, a press that never travels stays a click.
 */
export function pan(node: HTMLElement): { destroy(): void } {
  const gesture = new DragGesture()
  let pointerId = Number.NaN
  let viewport: HTMLElement | null = null
  let captured = false
  /** The last position of the press's pointer (a cancelled drag parks it there, `pointerDragEnded`). */
  let lastX = 0
  let lastY = 0
  /** Pan travel not yet scrolled: one `scrollBy` per frame. */
  let pendX = 0
  let pendY = 0
  let frame = 0
  /** Removes the wait for a cancelled drag's release (`swallowRelease`). */
  let releaseWait: (() => void) | null = null

  const point = (e: PointerEvent): DragPoint => ({ x: e.clientX, y: e.clientY, t: e.timeStamp })

  function flush(): void {
    cancelAnimationFrame(frame)
    frame = 0
    // scrollBy is physical, so it is right for LTR and RTL viewports alike.
    if (viewport && (pendX !== 0 || pendY !== 0))
      viewport.scrollBy({ left: -pendX, top: -pendY, behavior: 'instant' })
    pendX = 0
    pendY = 0
  }

  function follow(m: DragMove): void {
    if (m.dx === 0 && m.dy === 0) return
    pendX += m.dx
    pendY += m.dy
    if (frame === 0) frame = requestAnimationFrame(flush)
  }

  function arm(dir: TurnDir | null): void {
    if (dir === null) delete node.dataset.swipe
    else if (node.dataset.swipe !== dir) node.dataset.swipe = dir
  }

  /** The press went past the slop: capture the pointer, show the grabbing cursor, quiet the word interactions. */
  function start(e: PointerEvent): void {
    try {
      node.setPointerCapture(e.pointerId)
      captured = true
    } catch {
      // A synthetic pointer (tests) cannot be captured; its events still reach the window listeners.
    }
    node.dataset.drag = gesture.kind === 'swipe' ? 'swipe' : 'pan'
    pointerDragStarted()
  }

  function track(e: PointerEvent): void {
    lastX = e.clientX
    lastY = e.clientY
    const m = gesture.move(point(e))
    if (m.started) start(e)
    if (gesture.kind === 'swipe') arm(m.armed)
    else follow(m)
  }

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !e.isPrimary || e.pointerType === 'touch') return
    const vp = node.querySelector<HTMLElement>('[data-scroll-area-viewport]')
    const target = e.target
    // Only the book and its margins: the turn zones, the rail, the chips and the scrollbars sit outside the viewport.
    if (!vp || !(target instanceof Element) || !vp.contains(target) || target.closest(NO_DRAG)) return
    // `user-select: none` never collapses a selection made elsewhere (the side pane): a press on the page does, as a
    // click anywhere else would, so the selection never shadows the ayah selection's copy.
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) selection.removeAllRanges()
    // A second press of the same pointer means its release never reached us: that press is over, and this one's
    // release is not the one to swallow.
    if (gesture.active && e.pointerId === pointerId) {
      cancel()
      releaseWait?.()
    }
    if (gesture.active || ui.layerOpen || (app.isMac && e.ctrlKey)) return
    // Never preventDefault here: the compatibility mouse events (§8.14 mousedown rule, dblclick) and focus must happen.
    viewport = vp
    pointerId = e.pointerId
    lastX = e.clientX
    lastY = e.clientY
    gesture.down(point(e), reader.zoomPct > 100 ? 'pan' : 'swipe', reader.scrolls)
    listen()
  }

  const onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return
    // The release was lost (outside the window, a native interruption): this move is the release.
    if ((e.buttons & 1) === 0) {
      onPointerUp(e)
      return
    }
    if (ui.layerOpen) {
      cancel()
      return
    }
    track(e)
  }

  const onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return
    track(e)
    const end = gesture.up(point(e))
    flush()
    cleanup()
    if (end?.type !== 'drag') return
    swallowClick()
    pointerDragEnded(e.clientX, e.clientY)
    if (end.turn === 'next') reader.next()
    else if (end.turn === 'prev') reader.prev()
  }

  const onPointerCancel = (e: PointerEvent): void => {
    if (e.pointerId === pointerId) cancel()
  }

  const onLostCapture = (): void => cancel()

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !gesture.dragging) return
    // This Escape is the drag's: the shortcut store skips a consumed Escape, so the reader keeps its selection.
    e.preventDefault()
    cancel()
  }

  const onCancel = (): void => cancel()
  const onDragStart = (e: DragEvent): void => e.preventDefault()

  function listen(): void {
    window.addEventListener('pointermove', onPointerMove, true)
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerCancel, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onCancel)
    window.addEventListener('contextmenu', onCancel, true)
    node.addEventListener('lostpointercapture', onLostCapture)
    node.addEventListener('dragstart', onDragStart)
  }

  function cleanup(): void {
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('pointerup', onPointerUp, true)
    window.removeEventListener('pointercancel', onPointerCancel, true)
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('blur', onCancel)
    window.removeEventListener('contextmenu', onCancel, true)
    node.removeEventListener('lostpointercapture', onLostCapture)
    node.removeEventListener('dragstart', onDragStart)
    if (captured) {
      captured = false
      try {
        if (node.hasPointerCapture(pointerId)) node.releasePointerCapture(pointerId)
      } catch {
        // Already released (the pointer is gone).
      }
    }
    delete node.dataset.drag
    delete node.dataset.swipe
    cancelAnimationFrame(frame)
    frame = 0
    pendX = 0
    pendY = 0
    pointerId = Number.NaN
    viewport = null
  }

  /** Ends the press without a turn; a drag's travel so far stays panned, and its eventual release clicks nothing. */
  function cancel(): void {
    const dragging = gesture.dragging
    const id = pointerId
    gesture.cancel()
    flush()
    cleanup()
    if (!dragging) return
    pointerDragEnded(lastX, lastY)
    swallowRelease(id)
  }

  /** The release of a cancelled drag must not click either; any new press ends the wait (the release was lost). */
  function swallowRelease(id: number): void {
    releaseWait?.()
    const onRelease = (e: PointerEvent): void => {
      if (e.pointerId !== id) return
      done()
      swallowClick()
    }
    const done = (): void => {
      window.removeEventListener('pointerup', onRelease, true)
      window.removeEventListener('pointerdown', done, true)
      releaseWait = null
    }
    window.addEventListener('pointerup', onRelease, true)
    window.addEventListener('pointerdown', done, true)
    releaseWait = done
  }

  node.addEventListener('pointerdown', onPointerDown, { capture: true })
  return {
    destroy() {
      node.removeEventListener('pointerdown', onPointerDown, { capture: true })
      gesture.cancel()
      cleanup()
      releaseWait?.()
    },
  }
}

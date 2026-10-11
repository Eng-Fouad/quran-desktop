/**
 * Toasts never cover the Quran text (§7.5, §9.5). The shell's toasts sit above the dock (or the overlay slot). That
 * place is under the text block only while the canvas leaves a band under the book for the dock: in zen the book is
 * centred in the whole canvas, and once `qfs` is held at `QFS_MIN` (or zoomed) the book fills or overflows it. There,
 * an Undo toast (≥ 10 s) would lie over the last lines.
 *
 * - `trackTextClear` measures how far the text block of the book on the canvas (`[data-qd-stage]`) stays from the
 *   canvas's top and bottom edges: the paper's edges plus its running-head or page-number band, frame and margin, as
 *   the page geometry defines them in qfs (§8.2). It measures again whenever the canvas or the book resizes, the canvas
 *   scrolls, or the caller's inputs change (it is re-armed then).
 * - `toastSide` keeps the toasts at the bottom when they fit under the text, else moves them to the top edge when they
 *   fit over it (the paper's top margin and running head), else to the side that covers less of it.
 */
import { BLOCK_TOP, FOOT, FR, M_TB } from '$lib/mushaf/geometry'
import { STAGE_SELECTOR } from '$lib/stores/reader.svelte'

/** The room one toast takes: 48 px for one line, ≈ 64 px when its message wraps to two. */
export const TOAST_ROOM = 64
/** A toast at the top edge sits this far below the canvas top (or below the zen hint). */
export const TOAST_TOP_GAP = 12
/** The text block's bottom edge above the paper's bottom edge (qfs): frame band, page-number band, paper margin. */
export const BLOCK_BOTTOM = FR + FOOT + M_TB

/** How far the text block stays from the canvas's top and bottom edges (CSS px; negative: it passes the edge). */
export interface TextClear {
  above: number
  below: number
}

export type ToastSide = 'bottom' | 'top'

/** The text block's clearance of `book` (the spread or the single page, `[data-qd-stage]`) on `canvas` at `qfs`. */
export function textClearOf(canvas: Element, book: Element, qfs: number): TextClear {
  const c = canvas.getBoundingClientRect()
  const b = book.getBoundingClientRect()
  return {
    above: b.top + BLOCK_TOP * qfs - c.top,
    below: c.bottom - (b.bottom - BLOCK_BOTTOM * qfs),
  }
}

/**
 * Publishes the clearance of the book on `canvas` (or `null` while the canvas shows no book) now and on every resize
 * of the canvas or the book, and on every scroll inside the canvas (coalesced to one measurement per frame), until the
 * returned function stops it.
 */
export function trackTextClear(
  canvas: HTMLElement,
  qfs: number,
  publish: (clear: TextClear | null) => void,
): () => void {
  let frame = 0
  let observed: Element | null = null
  const observer = new ResizeObserver(() => schedule())
  const measure = () => {
    frame = 0
    const book = canvas.querySelector(STAGE_SELECTOR)
    if (book !== observed) {
      if (observed) observer.unobserve(observed)
      if (book) observer.observe(book)
      observed = book
    }
    publish(book && qfs > 0 ? textClearOf(canvas, book, qfs) : null)
  }
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(measure)
  }
  observer.observe(canvas)
  canvas.addEventListener('scroll', schedule, { capture: true, passive: true })
  measure()
  return () => {
    observer.disconnect()
    canvas.removeEventListener('scroll', schedule, { capture: true })
    if (frame !== 0) cancelAnimationFrame(frame)
  }
}

/**
 * Which canvas edge the toasts take. `bottom` is the toast list's distance from the canvas bottom there (above the dock
 * or the overlay slot), `top` its distance from the canvas top at the other edge. Without a book (`null`: translation
 * mode, the other views) the toasts stay at the bottom.
 */
export function toastSide(
  clear: TextClear | null,
  bottom: number,
  top: number,
  room: number = TOAST_ROOM,
): ToastSide {
  if (clear === null) return 'bottom'
  const overBottom = bottom + room - clear.below
  if (overBottom <= 0) return 'bottom'
  const overTop = top + room - clear.above
  if (overTop <= 0) return 'top'
  // The text fills the canvas (a held `qfs`, a zoom): cover the fewest lines.
  return overTop <= overBottom ? 'top' : 'bottom'
}

/**
 * Bottom-centre canvas overlays and the toasts. The overlay slot above the dock (the Mushaf view's
 * "Return to recitation", division and hint chips, the memorisation toolbar and self-test bar) and translation mode's
 * "Return to recitation" share the toasts' place over the canvas. Each publishes how far it reaches above the canvas
 * bottom (`ui.setOverlayReach`), and the shell's `Toaster` keeps toasts above the highest, so an Undo toast never hides
 * the way back to the recitation for its 10 s.
 *
 * `trackOverlayReach(source, el)` measures `el` (empty: 0) whenever it or the canvas resizes, until the returned
 * function stops it; `overlayReach(source)` is the same as a Svelte attachment.
 */
import type { Attachment } from 'svelte/attachments'
import { ui } from '$lib/stores/ui.svelte'

/** The shell's canvas (`App.svelte`'s `<main>`): the toast layer covers exactly it. */
const CANVAS = '#qd-main'

/** How far `el` reaches above the bottom of `canvas` (CSS px), 0 while it shows nothing. */
export function reachOf(el: Element, canvas: Element): number {
  const box = el.getBoundingClientRect()
  if (box.height <= 0 || box.width <= 0) return 0
  return Math.max(0, canvas.getBoundingClientRect().bottom - box.top)
}

export function trackOverlayReach(source: string, el: HTMLElement): () => void {
  const canvas = el.closest(CANVAS) ?? document.documentElement
  let frame = 0
  const measure = () => {
    frame = 0
    ui.setOverlayReach(source, reachOf(el, canvas))
  }
  // Coalesced to one measurement per frame (a resize settles the layout of both first).
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(measure)
  }
  const observer = new ResizeObserver(schedule)
  observer.observe(el)
  observer.observe(canvas)
  measure()
  return () => {
    observer.disconnect()
    if (frame !== 0) cancelAnimationFrame(frame)
    ui.setOverlayReach(source, 0)
  }
}

export function overlayReach(source: string): Attachment<HTMLElement> {
  return (el) => trackOverlayReach(source, el)
}

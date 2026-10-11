/**
 * The Settings dialog's frame (§7.4, §9.7; owner request 2026-10-11), a pure function of the window: whether it fills
 * the room under the title bar, the band at the bottom a floating dialog stays above (the player dock's), and how much
 * room its views keep free at the bottom for the dock when it fills.
 */
import type { Dock } from '$lib/contracts/stores'

/** The frame: at most 1040 × 760 CSS px, 24 px from the room's edges, centred. */
export const SETTINGS_FRAME = { maxW: 1040, maxH: 760, margin: 24 } as const
/** Below this room (CSS px after the UI zoom) the dialog fills it edge to edge. */
export const FILL_BELOW = { w: 880, h: 560 } as const

/** How far the dock reaches above the window's bottom edge: 10 px off it, then the 64/56 px bar or the 120 px card. */
const DOCK_REACH: Readonly<Record<Dock, number>> = { bar: 10 + 64, compact: 10 + 56, side: 10 + 120 }
/** Between a floating dialog's bottom edge and the top of the dock. */
const DOCK_GAP = 8

export interface FrameInput {
  /** The window in CSS px (`ui.windowSize`); 0 before it is measured. */
  windowW: number
  windowH: number
  /** The band at the top the dialog stays below: the title bar's (in zen too, where it is the bar's reveal zone). */
  insetTop: number
  dock: Dock
}

export interface Frame {
  /** The dialog fills the room edge to edge (no margin, radius or shadow). */
  fill: boolean
  /**
   * The band (px) at the window's bottom a floating dialog stays above, on top of its margin: the dock's, so the
   * dialog is centred between the title bar and the dock and never lies under it. 0 when it fills.
   */
  insetBottom: number
  /** Room (px) its views keep free at their end, where the dock lies over the filled dialog's bottom; else 0. */
  dockReserve: number
}

export function settingsFrame({ windowW, windowH, insetTop, dock }: FrameInput): Frame {
  const roomW = windowW
  const roomH = windowH - insetTop
  const fill = windowW > 0 && windowH > 0 && (roomW < FILL_BELOW.w || roomH < FILL_BELOW.h)
  if (fill) return { fill, insetBottom: 0, dockReserve: DOCK_REACH[dock] }
  return { fill, insetBottom: DOCK_REACH[dock] + DOCK_GAP - SETTINGS_FRAME.margin, dockReserve: 0 }
}

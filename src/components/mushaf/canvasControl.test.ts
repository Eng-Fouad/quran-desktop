/**
 * The canvas controls' presence, pure parts (the zoom control and the "Aa" display button): what they yield to
 * (`overlapsAny`), when the pointer reaches for one (`nearBox`) and how it shows (`canvasControlState`).
 */
import { describe, expect, it } from 'vitest'
import {
  type Box,
  canvasControlState,
  nearBox,
  overlapsAny,
  REACH_PX,
  TEXT_GAP,
} from './canvasControl.svelte'
import { ZOOM_WAKE_MS } from './ZoomControl.svelte'

/** The capsule: 40 × 92 px, 12 px in from the right of a canvas whose top right is at (1000, 0). */
const PILL: Box = { left: 948, top: 16, right: 988, bottom: 108 }
const rect = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom })

describe('overlapsAny (what the capsule yields to)', () => {
  it('ignores what lies clear of it, and an empty list', () => {
    expect(overlapsAny(PILL, [])).toBe(false)
    // The text block of a page at the fit: 58 px in from the canvas edge, beyond the capsule's 52.
    expect(overlapsAny(PILL, [rect(300, 40, 942, 900)])).toBe(false)
    expect(overlapsAny(PILL, [rect(948, 120, 988, 400)])).toBe(false)
  })

  it('takes anything within the gap as covered', () => {
    expect(TEXT_GAP).toBe(4)
    expect(overlapsAny(PILL, [rect(300, 40, PILL.left - 3, 900)])).toBe(true)
    expect(overlapsAny(PILL, [rect(300, 40, PILL.left - TEXT_GAP, 900)])).toBe(false)
    expect(overlapsAny(PILL, [rect(950, PILL.bottom + 2, 990, 400)])).toBe(true)
    expect(overlapsAny(PILL, [rect(960, 30, 970, 40)])).toBe(true)
    // One of several is enough.
    expect(overlapsAny(PILL, [rect(0, 0, 10, 10), rect(900, 0, 960, 20)])).toBe(true)
  })

  it('ignores empty rects (an element without layout)', () => {
    expect(overlapsAny(PILL, [rect(960, 50, 960, 50)])).toBe(false)
    expect(overlapsAny(PILL, [rect(950, 60, 980, 60)])).toBe(false)
    expect(overlapsAny(PILL, [rect(970, 20, 960, 90)])).toBe(false)
  })
})

describe('nearBox (the pointer reaching for a yielded capsule)', () => {
  it('is near inside the box and within the reach, not beyond', () => {
    expect(REACH_PX).toBe(24)
    expect(nearBox(960, 60, PILL)).toBe(true)
    expect(nearBox(PILL.left - REACH_PX, 60, PILL)).toBe(true)
    expect(nearBox(PILL.left - REACH_PX - 1, 60, PILL)).toBe(false)
    expect(nearBox(960, PILL.bottom + 20, PILL)).toBe(true)
    expect(nearBox(960, PILL.bottom + 25, PILL)).toBe(false)
    // Diagonally, by distance: 18 px left and 18 px below is 25.5 px away.
    expect(nearBox(PILL.left - 18, PILL.bottom + 18, PILL)).toBe(false)
    expect(nearBox(PILL.left - 15, PILL.bottom + 15, PILL)).toBe(true)
  })
})

describe('canvasControlState', () => {
  const base = { engaged: false, zenHidden: false, overText: false, near: false, overCanvas: false }

  it('is quieter away from the canvas and quiet over it, never hidden at rest', () => {
    expect(canvasControlState(base)).toBe('idle')
    expect(canvasControlState({ ...base, overCanvas: true })).toBe('quiet')
    expect(canvasControlState({ ...base, overCanvas: true, near: true })).toBe('quiet')
  })

  it('is at full strength while hovered, focused or woken, whatever else holds', () => {
    expect(canvasControlState({ ...base, engaged: true })).toBe('active')
    expect(canvasControlState({ ...base, engaged: true, zenHidden: true })).toBe('active')
    expect(canvasControlState({ ...base, engaged: true, overText: true })).toBe('active')
    expect(ZOOM_WAKE_MS).toBe(900)
  })

  it('hides in zen until the pointer moves', () => {
    expect(canvasControlState({ ...base, zenHidden: true, overCanvas: true })).toBe('hidden')
    expect(canvasControlState({ ...base, zenHidden: true, overText: true, near: true })).toBe('hidden')
  })

  it('yields to the page under it until the pointer reaches for it', () => {
    expect(canvasControlState({ ...base, overText: true, overCanvas: true })).toBe('hidden')
    expect(canvasControlState({ ...base, overText: true })).toBe('hidden')
    expect(canvasControlState({ ...base, overText: true, overCanvas: true, near: true })).toBe('active')
  })
})

/**
 * Wheel and touchpad gestures (§8.13, §10.2; WP8e): `deltaMode` normalisation, one page per gesture, the thresholds,
 * the 400 ms floor, notches, horizontal swipes in book direction, native scrolling past the fit, zoom steps from
 * wheel notches and pinches, and the wheel over a control floating on a zoomed canvas (`forwardWheel`).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  forwardWheel,
  GESTURE_IDLE_MS,
  normalizeDelta,
  PINCH_STEP_PX,
  TURN_FLOOR_MS,
  type WheelContext,
  WheelGestures,
  type WheelIntent,
  type WheelSample,
} from './wheel'

const FITS: WheelContext = { pageHeight: 900, fits: true, isMac: false }

const sample = (timeStamp: number, patch: Partial<WheelSample> = {}): WheelSample => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  metaKey: false,
  timeStamp,
  ...patch,
})

/** Feeds a stream of events and returns the intents that were not `consume`. */
function feed(g: WheelGestures, events: WheelSample[], ctx: WheelContext = FITS): WheelIntent[] {
  return events.map((e) => g.next(e, ctx)).filter((i) => i.type !== 'consume')
}

/** A touchpad stream: `n` events of `dy` px every `every` ms from `start`. */
function stream(start: number, n: number, patch: Partial<WheelSample>, every = 16): WheelSample[] {
  return Array.from({ length: n }, (_, i) => sample(start + i * every, patch))
}

describe('normalizeDelta (§8.13)', () => {
  it('turns lines into 16 px and pages into the canvas height', () => {
    expect(normalizeDelta(3, 0, 900)).toBe(3)
    expect(normalizeDelta(3, 1, 900)).toBe(48)
    expect(normalizeDelta(-1, 2, 900)).toBe(-900)
  })

  it('treats a non-finite delta as no movement', () => {
    expect(normalizeDelta(Number.NaN, 0, 900)).toBe(0)
    expect(normalizeDelta(Number.POSITIVE_INFINITY, 1, 900)).toBe(0)
  })
})

describe('WheelGestures: page turns while the page fits', () => {
  it('turns at once on a mouse-wheel notch: down is the next page, up the previous one', () => {
    const g = new WheelGestures()
    expect(g.next(sample(0, { deltaY: 100 }), FITS)).toEqual({ type: 'turn', dir: 'next' })
    expect(g.next(sample(1000, { deltaY: -100 }), FITS)).toEqual({ type: 'turn', dir: 'prev' })
  })

  it('turns a line-mode notch (Firefox, WebKitGTK) at once as well', () => {
    const g = new WheelGestures()
    expect(g.next(sample(0, { deltaY: 3, deltaMode: 1 }), FITS)).toEqual({ type: 'turn', dir: 'next' })
  })

  it('accumulates a touchpad stream to 120 px and turns exactly one page per gesture', () => {
    const g = new WheelGestures()
    // 1.2 s of inertia at 60 Hz, 6 px per event: 432 px, a single gesture.
    const intents = feed(g, stream(0, 72, { deltaY: 6 }))
    expect(intents).toEqual([{ type: 'turn', dir: 'next' }])
  })

  it('does not turn below the threshold', () => {
    const g = new WheelGestures()
    expect(feed(g, stream(0, 10, { deltaY: 11 }))).toEqual([])
  })

  it('starts a new gesture after 160 ms without events', () => {
    const g = new WheelGestures()
    const first = stream(0, 30, { deltaY: 6 })
    const gap = (first.at(-1)?.timeStamp ?? 0) + GESTURE_IDLE_MS + 1 + TURN_FLOOR_MS
    const second = stream(gap, 30, { deltaY: 6 })
    expect(feed(g, [...first, ...second])).toEqual([
      { type: 'turn', dir: 'next' },
      { type: 'turn', dir: 'next' },
    ])
  })

  it('keeps 400 ms between turns, then turns within the same gesture', () => {
    const g = new WheelGestures()
    expect(g.next(sample(0, { deltaY: 100 }), FITS).type).toBe('turn')
    // A second gesture right after the first one: over the threshold, but inside the floor.
    expect(g.next(sample(200, { deltaY: 130 }), FITS).type).toBe('consume')
    expect(g.next(sample(300, { deltaY: 5 }), FITS).type).toBe('consume')
    // Still the same gesture (events < 160 ms apart), past the floor: it turns now, once.
    expect(g.next(sample(410, { deltaY: 5 }), FITS)).toEqual({ type: 'turn', dir: 'next' })
    expect(g.next(sample(420, { deltaY: 5 }), FITS).type).toBe('consume')
  })

  it('reads horizontal swipes in book order: right (deltaX < 0) is the next page', () => {
    const g = new WheelGestures()
    expect(feed(g, stream(0, 10, { deltaX: -9 }))).toEqual([{ type: 'turn', dir: 'next' }])
    expect(feed(g, stream(2000, 10, { deltaX: 9 }))).toEqual([{ type: 'turn', dir: 'prev' }])
  })

  it('needs only 80 px horizontally, against 120 px vertically', () => {
    const g = new WheelGestures()
    expect(feed(g, stream(0, 9, { deltaX: -10 }))).toEqual([{ type: 'turn', dir: 'next' }])
    expect(feed(g, stream(2000, 9, { deltaY: 10 }))).toEqual([])
  })

  it('leaves the wheel to native scrolling when the canvas scrolls', () => {
    const g = new WheelGestures()
    const ctx = { ...FITS, fits: false }
    expect(g.next(sample(0, { deltaY: 100 }), ctx)).toEqual({ type: 'scroll' })
    expect(g.next(sample(10, { deltaY: 300 }), ctx)).toEqual({ type: 'scroll' })
  })

  it('forgets everything on reset', () => {
    const g = new WheelGestures()
    expect(g.next(sample(0, { deltaY: 100 }), FITS).type).toBe('turn')
    g.reset()
    expect(g.next(sample(10, { deltaY: 100 }), FITS).type).toBe('turn')
  })
})

describe('WheelGestures: zoom (§8.13)', () => {
  it('zooms one step per Ctrl+wheel notch: up zooms in, down zooms out', () => {
    const g = new WheelGestures()
    expect(g.next(sample(0, { deltaY: -100, ctrlKey: true }), FITS)).toEqual({ type: 'zoom', steps: 1 })
    expect(g.next(sample(50, { deltaY: -100, ctrlKey: true }), FITS)).toEqual({ type: 'zoom', steps: 1 })
    expect(g.next(sample(100, { deltaY: 120, ctrlKey: true }), FITS)).toEqual({ type: 'zoom', steps: -1 })
  })

  it('accumulates a pinch, one step per 60 px', () => {
    const g = new WheelGestures()
    const pinch = stream(0, 12, { deltaY: -10, ctrlKey: true })
    expect(feed(g, pinch)).toEqual([
      { type: 'zoom', steps: 1 },
      { type: 'zoom', steps: 1 },
    ])
    expect(12 * 10).toBe(2 * PINCH_STEP_PX)
  })

  it('zooms whether or not the page fits, and with ⌘ on macOS', () => {
    const g = new WheelGestures()
    const scrolled = { ...FITS, fits: false }
    expect(g.next(sample(0, { deltaY: -100, ctrlKey: true }), scrolled)).toEqual({ type: 'zoom', steps: 1 })
    const mac = { ...FITS, isMac: true }
    expect(g.next(sample(500, { deltaY: 100, metaKey: true }), mac)).toEqual({ type: 'zoom', steps: -1 })
    // ⌘ is not a zoom chord elsewhere: a plain notch turns.
    expect(g.next(sample(1000, { deltaY: 100, metaKey: true }), FITS)).toEqual({ type: 'turn', dir: 'next' })
  })

  it('drops a pinch remainder after the gesture ends', () => {
    const g = new WheelGestures()
    expect(feed(g, stream(0, 5, { deltaY: -10, ctrlKey: true }))).toEqual([])
    expect(feed(g, stream(1000, 5, { deltaY: -10, ctrlKey: true }))).toEqual([])
  })
})

describe('forwardWheel (the zoom control over a zoomed canvas)', () => {
  /** A canvas whose scroll viewport is 800 px high, with `scrollBy` recorded. */
  function canvas(): { view: HTMLElement; scrollBy: ReturnType<typeof vi.fn> } {
    const view = document.createElement('div')
    const scroller = document.createElement('div')
    scroller.setAttribute('data-scroll-area-viewport', '')
    Object.defineProperty(scroller, 'clientHeight', { value: 800 })
    const scrollBy = vi.fn()
    scroller.scrollBy = scrollBy
    view.append(scroller)
    return { view, scrollBy }
  }

  it('scrolls the canvas by the normalised deltas while it scrolls', () => {
    const { view, scrollBy } = canvas()
    forwardWheel(new WheelEvent('wheel', { deltaX: 5, deltaY: 40 }), view, true)
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 5, top: 40 })
    forwardWheel(new WheelEvent('wheel', { deltaY: 3, deltaMode: 1 }), view, true)
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 0, top: 48 })
    forwardWheel(new WheelEvent('wheel', { deltaY: 1, deltaMode: 2 }), view, true)
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 0, top: 800 })
  })

  it('leaves a fitted page (use:wheel turns it) and Ctrl or Mod (a zoom at the pointer) alone', () => {
    const { view, scrollBy } = canvas()
    forwardWheel(new WheelEvent('wheel', { deltaY: 100 }), view, false)
    forwardWheel(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true }), view, true)
    forwardWheel(new WheelEvent('wheel', { deltaY: -100, metaKey: true }), view, true)
    expect(scrollBy).not.toHaveBeenCalled()
    // No scroll viewport: nothing to scroll.
    forwardWheel(new WheelEvent('wheel', { deltaY: 100 }), document.createElement('div'), true)
  })
})

/**
 * Drag on the Mushaf canvas (§8.13, §10.2; WP8e): the click/drag slop of each mode, the travel a pan follows, the swipe
 * thresholds and flicks in book direction, the decision on release, the vertical pan of a swipe on a canvas that
 * scrolls, and cancelling.
 */
import { describe, expect, it } from 'vitest'
import {
  DRAG_TURN_PX,
  DragGesture,
  type DragMode,
  type DragMove,
  FLICK_MS,
  FLICK_PX,
  PAN_SLOP_PX,
  swipeTurn,
  SWIPE_SLOP_PX,
} from './pan'

const at = (x: number, y: number, t = 0) => ({ x, y, t })

/** A press at (100, 100) at t = 0. */
function press(mode: DragMode, scrolls = false): DragGesture {
  const g = new DragGesture()
  g.down(at(100, 100), mode, scrolls)
  return g
}

/** Moves along `points` (relative to the press) and returns every answer. */
function path(g: DragGesture, points: [number, number, number?][]): DragMove[] {
  return points.map(([dx, dy, t]) => g.move(at(100 + dx, 100 + dy, t ?? 1_000)))
}

describe('swipeTurn (§8.13)', () => {
  it.each([
    [80, 0, 1_000, 'next'],
    [-80, 0, 1_000, 'prev'],
    [79, 0, 1_000, null],
    [120, 60, 1_000, 'next'],
    [90, 120, 1_000, null],
    [80, 80, 1_000, null],
    [FLICK_PX, 0, FLICK_MS, 'next'],
    [-FLICK_PX, 10, 100, 'prev'],
    [FLICK_PX - 1, 0, 50, null],
    [FLICK_PX, 0, FLICK_MS + 1, null],
    [60, 0, 400, null],
  ] as const)('a swipe of (%i, %i) px over %i ms turns to %s', (dx, dy, ms, turn) => {
    expect(swipeTurn(dx, dy, ms)).toBe(turn)
  })

  it('uses the wheel’s horizontal swipe threshold', () => {
    expect(DRAG_TURN_PX).toBe(80)
  })
})

describe('DragGesture: click or drag', () => {
  it('keeps a press that never travels past the slop a click, and never reports a start', () => {
    const swipe = press('swipe')
    expect(
      path(swipe, [
        [3, 2],
        [6, 0],
        [-5, 4],
      ]).some((m) => m.started),
    ).toBe(false)
    expect(swipe.dragging).toBe(false)
    expect(swipe.up(at(106, 100, 120))).toEqual({ type: 'click' })
    expect(swipe.active).toBe(false)

    const pan = press('pan')
    expect(
      path(pan, [
        [2, 2],
        [-3, 0],
      ]).some((m) => m.started),
    ).toBe(false)
    expect(pan.up(at(103, 100))).toEqual({ type: 'click' })
  })

  it('reads a 6 px jitter as a click and a 9 px move as a drag in swipe mode; 5 px is a drag in pan mode', () => {
    expect(SWIPE_SLOP_PX).toBe(8)
    expect(PAN_SLOP_PX).toBe(4)
    const jitter = press('swipe')
    path(jitter, [[6, 0]])
    expect(jitter.up(at(106, 100, 200))).toEqual({ type: 'click' })

    const nine = press('swipe')
    expect(path(nine, [[9, 0]])[0]?.started).toBe(true)
    expect(nine.dragging).toBe(true)
    expect(nine.up(at(109, 100, 600))).toEqual({ type: 'drag', turn: null })

    const pan = press('pan')
    expect(path(pan, [[5, 0]])[0]?.started).toBe(true)
    expect(pan.up(at(105, 100))).toEqual({ type: 'drag', turn: null })
  })

  it('decides a release past the slop as a drag even without a move before it', () => {
    const g = press('swipe')
    expect(g.up(at(200, 100, 1_000))).toEqual({ type: 'drag', turn: 'next' })
  })
})

describe('DragGesture: pan (zoomed past the fit)', () => {
  it('reports the whole travel on the move that starts the drag, then the deltas, summing to the pointer travel', () => {
    const g = press('pan')
    const moves = path(g, [
      [2, 1],
      [10, -6],
      [25, -20],
      [24, -40],
      [-30, 15],
    ])
    expect(moves[0]).toEqual({ started: false, dx: 0, dy: 0, armed: null })
    expect(moves[1]).toEqual({ started: true, dx: 10, dy: -6, armed: null })
    expect(moves[2]).toEqual({ started: false, dx: 15, dy: -14, armed: null })
    const sum = moves.reduce((s, m) => ({ dx: s.dx + m.dx, dy: s.dy + m.dy }), { dx: 0, dy: 0 })
    expect(sum).toEqual({ dx: -30, dy: 15 })
    expect(g.kind).toBe('pan')
  })

  it('never turns a page, whatever the travel or speed', () => {
    const g = press('pan')
    path(g, [[200, 0, 50]])
    expect(g.up(at(400, 100, 80))).toEqual({ type: 'drag', turn: null })
  })
})

describe('DragGesture: swipe (the page fits)', () => {
  it('turns on release in book order: right is the next page, left the previous one', () => {
    const right = press('swipe')
    path(right, [
      [40, 3, 300],
      [80, 5, 600],
    ])
    expect(right.up(at(180, 105, 650))).toEqual({ type: 'drag', turn: 'next' })
    const left = press('swipe')
    path(left, [[-80, 0, 600]])
    expect(left.up(at(20, 100, 650))).toEqual({ type: 'drag', turn: 'prev' })
  })

  it('needs 80 px, or a flick of 30 px within 250 ms; vertical-dominant drags never turn', () => {
    const short = press('swipe')
    path(short, [[79, 0, 600]])
    expect(short.up(at(179, 100, 700))).toEqual({ type: 'drag', turn: null })
    const steep = press('swipe')
    path(steep, [[90, 120, 600]])
    expect(steep.up(at(190, 220, 700))).toEqual({ type: 'drag', turn: null })
    const flick = press('swipe')
    path(flick, [[30, 0, 100]])
    expect(flick.up(at(130, 100, 200))).toEqual({ type: 'drag', turn: 'next' })
    const slow = press('swipe')
    path(slow, [[30, 0, 300]])
    expect(slow.up(at(130, 100, 400))).toEqual({ type: 'drag', turn: null })
  })

  it('decides at the release: dragging back cancels, and `armed` follows the travel', () => {
    const g = press('swipe')
    const moves = path(g, [
      [40, 0, 300],
      [85, 0, 500],
      [20, 0, 900],
    ])
    expect(moves.map((m) => m.armed)).toEqual([null, 'next', null])
    // A swipe never pans the canvas.
    expect(moves.every((m) => m.dx === 0 && m.dy === 0)).toBe(true)
    expect(g.up(at(120, 100, 1_000))).toEqual({ type: 'drag', turn: null })
  })

  it('pans vertically when the canvas scrolls at the fit and the drag sets off vertical-dominant', () => {
    const g = press('swipe', true)
    const moves = path(g, [
      [2, 12],
      [3, 40],
      [90, 50],
    ])
    expect(g.kind).toBe('pan-y')
    expect(moves.map((m) => [m.dx, m.dy])).toEqual([
      [0, 12],
      [0, 28],
      [0, 10],
    ])
    expect(g.up(at(190, 150, 1_000))).toEqual({ type: 'drag', turn: null })
    // Setting off horizontally it stays a swipe and turns.
    const h = press('swipe', true)
    path(h, [
      [12, 2],
      [100, 10],
    ])
    expect(h.kind).toBe('swipe')
    expect(h.up(at(200, 110, 1_000))).toEqual({ type: 'drag', turn: 'next' })
  })

  it('never pans a canvas that does not scroll', () => {
    const g = press('swipe')
    const moves = path(g, [
      [0, 30],
      [0, 150],
    ])
    expect(g.kind).toBe('swipe')
    expect(moves.every((m) => m.dx === 0 && m.dy === 0)).toBe(true)
    expect(g.up(at(100, 250, 1_000))).toEqual({ type: 'drag', turn: null })
  })
})

describe('DragGesture: cancel', () => {
  it('forgets the press: no move, and the release is no drag', () => {
    const g = press('swipe')
    path(g, [[120, 0]])
    g.cancel()
    expect(g.active).toBe(false)
    expect(g.dragging).toBe(false)
    expect(g.move(at(250, 100))).toEqual({ started: false, dx: 0, dy: 0, armed: null })
    expect(g.up(at(250, 100, 1_000))).toBeNull()
  })

  it('answers nothing before a press', () => {
    const g = new DragGesture()
    expect(g.up(at(0, 0))).toBeNull()
    expect(g.active).toBe(false)
  })
})

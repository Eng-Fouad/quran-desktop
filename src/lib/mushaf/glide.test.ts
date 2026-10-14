/**
 * The compositor glide (glide.ts): the spring's step response as an easing, and the FLIP transforms.
 */
import { describe, expect, it } from 'vitest'
import {
  boxMoved,
  boxTransform,
  flipFrom,
  flipTo,
  GLIDE_BEZIER,
  GLIDE_LINEAR,
  GLIDE_MS,
  GLIDE_POINTS,
  glideEasing,
  glideProgress,
  shownBox,
} from './glide'
import { GLIDE_SPRING } from './metrics'

/** Svelte's `tick_spring` on a display of `hz` (`dt = 60 / hz` frame units), as the old `Spring` glide ran. */
function svelteSpringAt(ms: number, hz: number): number {
  const dt = 60 / hz
  let last = 0
  let current = 0
  for (let frame = 0; frame < Math.round((ms * hz) / 1000); frame++) {
    const velocity = (current - last) / dt
    const acceleration = GLIDE_SPRING.stiffness * (1 - current) - GLIDE_SPRING.damping * velocity
    last = current
    current += (velocity + acceleration) * dt
  }
  return current
}

describe('the glide easing (the spring’s step response)', () => {
  it('lasts until the spring has covered 99.8 % of the way, about a third of a second', () => {
    expect(GLIDE_MS).toBeGreaterThan(250)
    expect(GLIDE_MS).toBeLessThan(450)
  })

  it('rises from 0 to 1 without overshoot, as the spring did', () => {
    let previous = -1
    for (let i = 0; i <= 200; i++) {
      const p = glideProgress(i / 200)
      expect(p).toBeGreaterThanOrEqual(previous)
      expect(p).toBeLessThanOrEqual(1)
      previous = p
    }
    expect(glideProgress(0)).toBe(0)
    expect(glideProgress(1)).toBe(1)
  })

  it('follows the Svelte spring it replaces, which itself ran a little faster on a 60 Hz display than at 120 Hz', () => {
    for (const ms of [17, 50, 100, 150, 200, 250, 300]) {
      const p = glideProgress(ms / GLIDE_MS)
      expect(Math.abs(p - svelteSpringAt(ms, 120))).toBeLessThan(0.03)
      expect(Math.abs(p - svelteSpringAt(ms, 60))).toBeLessThan(0.06)
    }
  })

  it('is a CSS linear() of evenly spaced samples, with a cubic Bézier fallback', () => {
    const values = /^linear\((.*)\)$/.exec(GLIDE_LINEAR)?.[1]?.split(', ').map(Number) ?? []
    expect(values).toHaveLength(GLIDE_POINTS + 1)
    expect(values[0]).toBe(0)
    expect(values.at(-1)).toBe(1)
    expect(GLIDE_BEZIER).toMatch(/^cubic-bezier\(/)
    // jsdom has no CSS.supports for it: the fallback.
    expect([GLIDE_LINEAR, GLIDE_BEZIER]).toContain(glideEasing())
  })
})

describe('the FLIP transforms', () => {
  const a = { x: 10, y: 20, w: 40, h: 30 }
  const b = { x: 70, y: 20, w: 80, h: 30 }

  it('places a pill at its box, and shows the old box on an element laid out at the new one', () => {
    expect(boxTransform(b)).toBe('translate3d(70px, 20px, 0)')
    expect(flipFrom(a, b)).toBe('translate3d(10px, 20px, 0) scale(0.5, 1)')
    expect(flipTo(b)).toBe('translate3d(70px, 20px, 0) scale(1, 1)')
  })

  it('reads the drawn box back only under a running glide', () => {
    const el = document.createElement('div')
    expect(shownBox(el, b, false)).toBe(b)
  })

  it('tells a visible move from a rounding difference', () => {
    expect(boxMoved(a, b)).toBe(true)
    expect(boxMoved(b, { ...b, x: b.x + 0.001 })).toBe(false)
  })
})

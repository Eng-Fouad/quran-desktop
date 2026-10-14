/**
 * The audio word glide as a compositor animation.
 *
 * The word pill used to glide on a Svelte `Spring`: a script loop that wrote the pill's transform and size on every
 * frame of every glide (≈ 100 inline-style writes a second while reciting, and on, with the Mushaf hidden). Now a word
 * change writes the pill's final box once and plays a Web Animation of `transform` from the box the pill was showing
 * onto it (FLIP: the old box as a translate and a scale of the new one). The compositor runs it on its own thread: no
 * script, style, layout or paint on the page's thread per frame, and nothing at all while the page is not drawn.
 *
 * - **The spring's motion.** {@link GLIDE_SPRING} is simulated as Svelte's `Spring` ticks it (`tick_spring`, in fine
 *   steps), and its step response becomes a `linear()` easing of {@link GLIDE_POINTS} samples over {@link GLIDE_MS},
 *   the time it takes to cover 99.8 % of the way (these settings do not overshoot). Where `linear()` is not supported
 *   (WebKit before Safari 17.2), a cubic Bézier close to the curve.
 * - **Retargeting.** A new word mid-glide starts from the box the pill shows at that moment (its computed transform),
 *   as the spring did from its current value.
 * - The pill is anchored at its top-left corner (`transform-origin: 0 0`, highlights.css), in the layer's LTR
 *   coordinates.
 */
import { GLIDE_SPRING } from './metrics'

/** A pill's box in the highlight layer (px; `x`, `y` its top-left corner). */
export interface GlideBox {
  x: number
  y: number
  w: number
  h: number
}

/** Samples of the easing curve. */
export const GLIDE_POINTS = 32
/** The share of the way after which the glide is over (the rest is under a tenth of a pixel for a typical glide). */
const SETTLED = 0.998
/** The simulation's step, in Svelte's 60 fps frame units (`dt = elapsed × 60 / 1000`): 1/600 s. */
const STEP = 0.1

/** The spring's step response from 0 to 1, in Svelte's frame units: one value per {@link STEP}. */
function stepResponse(): number[] {
  const { stiffness, damping } = GLIDE_SPRING
  const values = [0]
  let last = 0
  let current = 0
  // `tick_spring` with an inverse mass of 1 (no momentum option), towards the target 1.
  for (let i = 0; i < 10_000 && current < SETTLED; i++) {
    const velocity = (current - last) / STEP
    const acceleration = stiffness * (1 - current) - damping * velocity
    last = current
    current += (velocity + acceleration) * STEP
    values.push(current)
  }
  return values
}

const RESPONSE = stepResponse()

/** How long a glide takes (ms): the spring's time to {@link SETTLED} of the way. */
export const GLIDE_MS = Math.round(((RESPONSE.length - 1) * STEP * 1000) / 60)

/** The spring's progress (0–1) at `t` (0–1) of {@link GLIDE_MS}: its step response, read off the simulation. */
export function glideProgress(t: number): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  const at = t * (RESPONSE.length - 1)
  const i = Math.floor(at)
  const a = RESPONSE[i] ?? 1
  const b = RESPONSE[i + 1] ?? 1
  return Math.min(1, (a + (b - a) * (at - i)) / SETTLED)
}

/** The spring as a CSS `linear()` easing: {@link GLIDE_POINTS} evenly spaced samples, ending at 1. */
export const GLIDE_LINEAR = `linear(${Array.from({ length: GLIDE_POINTS + 1 }, (_, i) =>
  Number(glideProgress(i / GLIDE_POINTS).toFixed(4)),
).join(', ')})`

/** The fallback where `linear()` is not supported: a cubic Bézier through the curve's first half and its tail. */
export const GLIDE_BEZIER = 'cubic-bezier(0.25, 0.85, 0.35, 1)'

let easing: string | null = null

/** The glide's easing: the spring as `linear()`, or the Bézier where the engine lacks it. */
export function glideEasing(): string {
  easing ??=
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('animation-timing-function', GLIDE_LINEAR)
      ? GLIDE_LINEAR
      : GLIDE_BEZIER
  return easing
}

/** The transform that places a pill at `box` (its size is the element's own). */
export function boxTransform(box: GlideBox): string {
  return `translate3d(${box.x}px, ${box.y}px, 0)`
}

/**
 * The transform that makes a pill laid out as `to` look like `from`: `from`'s corner, and `to` scaled to `from`'s size.
 * Animating it to `scale(1, 1)` at `to`'s corner glides the pill from one box to the other.
 */
export function flipFrom(from: GlideBox, to: GlideBox): string {
  const sx = to.w > 0 ? from.w / to.w : 1
  const sy = to.h > 0 ? from.h / to.h : 1
  return `${boxTransform(from)} scale(${sx}, ${sy})`
}

/** The end keyframe of a glide onto `to` (the same functions as {@link flipFrom}, so each interpolates on its own). */
export function flipTo(to: GlideBox): string {
  return `${boxTransform(to)} scale(1, 1)`
}

/**
 * The box a pill laid out as `laid` shows now: under a running glide, its animated transform read back (a translate
 * and a scale, `matrix(sx, 0, 0, sy, x, y)`); otherwise `laid` itself.
 */
export function shownBox(el: Element, laid: GlideBox, gliding: boolean): GlideBox {
  if (!gliding || typeof DOMMatrixReadOnly !== 'function') return laid
  const transform = getComputedStyle(el).transform
  if (!transform || transform === 'none') return laid
  const m = new DOMMatrixReadOnly(transform)
  return { x: m.e, y: m.f, w: laid.w * m.a, h: laid.h * m.d }
}

/** Whether two boxes differ by a visible amount (a hundredth of a pixel). */
export function boxMoved(a: GlideBox, b: GlideBox): boolean {
  return (
    Math.abs(a.x - b.x) > 0.01 ||
    Math.abs(a.y - b.y) > 0.01 ||
    Math.abs(a.w - b.w) > 0.01 ||
    Math.abs(a.h - b.h) > 0.01
  )
}

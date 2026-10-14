/**
 * Page turns: `turnTo` with the staggered view transition, the 120 ms readiness wait and the single pending turn.
 *
 * A turn first waits up to 120 ms for the destination to be *instantly renderable* (its `PageData` cached, its page
 * fonts loaded and its glyphs warm, warmup.ts), so a prefetched page appears in its QCF font without ever
 * showing the Hafs fallback, and its layout inside the transition is no long task. It then
 * commits the page inside `document.startViewTransition`, which animates only the spread (`view-transition-name:
 * qd-spread`; the root is `none`, so the title bar and the rest of the chrome update instantly) with the staggered
 * out/in keyframes of `spread.css`, never a 50 % double exposure of two calligraphy pages. Without animation (reduced
 * motion, `pageTurnAnimation` off, no View Transitions API, a canvas zoomed past the fit, or a destination that is not
 * ready), the page is committed directly.
 *
 * **Turning never queues more than one pending page.** A turn requested while one runs replaces any turn still
 * waiting, and skips the running animation so the newest request starts at once; superseded requests resolve without
 * committing. `cancelTurns()` drops everything (flipping takes over).
 *
 * The reader registers itself as the `TurnHost` (`setTurnHost`) in `init`, so this module never imports the reader.
 */
import { tick } from 'svelte'
import type { MushafStyle } from '$lib/ipc/bindings'
import { fonts } from '$lib/stores/fonts.svelte'
import { pages } from '$lib/stores/pages.svelte'
import { settings } from '$lib/stores/settings.svelte'

/** How long a turn waits for its destination to be instantly renderable. */
export const TURN_WAIT_MS = 120

export type TurnDir = 'next' | 'prev'

export interface TurnOptions {
  /** Commit without the view transition, still after the readiness wait (`goToPage(p, { transition: false })`). */
  instant?: boolean
}

/** What a turn needs from the reader. */
export interface TurnHost {
  /** The current Mushaf style (page data and fonts are per style). */
  style(): MushafStyle
  /** The pages that would be on screen with `page` as the reader's page (a spread is `[odd, odd + 1]`). */
  pagesFor(page: number): number[]
  /** Commits the page now, without a transition. */
  setPageNow(page: number): void
  /** Whether a turn may animate: the Mushaf spread is on screen and fits the canvas. */
  canAnimate(): boolean
  /** A turn (or a chain of them) started or ended (`reader.turning`). */
  setTurning(on: boolean): void
  /** Whether `page`'s glyphs are warm at the current size (warmup.ts); absent: always. */
  glyphsReady?(page: number): boolean
}

interface TurnJob {
  page: number
  dir: TurnDir
  opts: TurnOptions
  /** `cancelTurns()` generation the job was requested in: a later cancel supersedes it. */
  epoch: number
  resolve: () => void
}

let host: TurnHost | null = null
/** A chain of turns is being driven (at most one job runs and one waits). */
let active = false
let pending: TurnJob | null = null
let current: ViewTransition | null = null
let epoch = 0

/** Registers the reader as the turn host; returns the function that removes it again. */
export function setTurnHost(next: TurnHost | null): () => void {
  cancelTurns()
  host = next
  return () => {
    if (host === next) {
      cancelTurns()
      host = null
    }
  }
}

/**
 * Whether `page` can be drawn in its final font right now: page data cached, every page font loaded and its glyphs
 * warm (a cold page would be laid out in one long task inside the transition).
 */
export function isInstantReady(page: number): boolean {
  const h = host
  if (!h) return false
  const style = h.style()
  return h
    .pagesFor(page)
    .every((p) => pages.has(style, p) && fonts.isReady(style, p) && (h.glyphsReady?.(p) ?? true))
}

/** Loads what `page` needs to render instantly (page data and page fonts). Never rejects. */
export async function readyForInstantRender(page: number): Promise<void> {
  const h = host
  if (!h) return
  const style = h.style()
  const wanted = h.pagesFor(page)
  await Promise.all([
    pages.ensure(style, wanted).catch((e: unknown) => console.debug('[qd] turn: page data', e)),
    fonts.ensure(style, wanted, 'interactive'),
  ])
}

/** Whether the page turn may be animated at all (settings, motion preference, API support). */
export function turnsAnimate(): boolean {
  return (
    settings.value.pageTurnAnimation &&
    !settings.reducedMotion &&
    typeof document !== 'undefined' &&
    typeof document.startViewTransition === 'function'
  )
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Turns to `page`: waits up to 120 ms for it to be instantly renderable, then commits it with the staggered
 * view transition when allowed, else directly. Resolves once the page is committed, or once a newer turn superseded
 * this one (the caller checks `reader.visiblePages` when it matters).
 */
export function turnTo(page: number, dir: TurnDir, opts: TurnOptions = {}): Promise<void> {
  return new Promise<void>((resolve) => {
    const job: TurnJob = { page, dir, opts, epoch, resolve }
    if (active) {
      // One pending turn at most: the newest replaces it, and the running animation ends now.
      pending?.resolve()
      pending = job
      current?.skipTransition()
      return
    }
    active = true
    void drive(job)
  })
}

/** Drops a waiting turn and ends a running animation at once (flipping, a reset). */
export function cancelTurns(): void {
  epoch += 1
  pending?.resolve()
  pending = null
  current?.skipTransition()
}

/** Whether a turn is running or waiting. */
export function turnInProgress(): boolean {
  return active
}

async function drive(first: TurnJob): Promise<void> {
  host?.setTurning(true)
  let job: TurnJob | null = first
  try {
    while (job !== null) {
      try {
        await perform(job)
      } catch (e) {
        console.error('[qd] page turn failed', e)
      } finally {
        job.resolve()
      }
      // A cancel clears `pending`, so whatever waits now was requested after it and is valid.
      job = pending
      pending = null
    }
  } finally {
    active = false
    current = null
    host?.setTurning(false)
  }
}

async function perform(job: TurnJob): Promise<void> {
  const h = host
  if (!h || job.epoch !== epoch) return
  const animate = !job.opts.instant && turnsAnimate() && h.canAnimate()
  await Promise.race([readyForInstantRender(job.page), sleep(TURN_WAIT_MS)])
  // Superseded while waiting: the newer request goes next, this one never shows.
  if (pending !== null || job.epoch !== epoch || host !== h) return
  if (!animate || !isInstantReady(job.page) || typeof document.startViewTransition !== 'function') {
    h.setPageNow(job.page)
    await tick()
    return
  }
  const root = document.documentElement
  root.dataset.turn = job.dir
  try {
    const vt = document.startViewTransition(async () => {
      // Flipping may have cancelled this turn between the start and this callback: then it never commits.
      if (job.epoch !== epoch) return
      h.setPageNow(job.page)
      // The page, then the renditions its effects mount (RenditionStack reconciles in an effect).
      await tick()
      await tick()
    })
    current = vt
    // A skipped transition (a newer turn, flipping) rejects `ready`: expected, never an unhandled rejection.
    vt.ready.catch(() => {})
    vt.updateCallbackDone.catch((e: unknown) => console.debug('[qd] page turn update', e))
    await vt.finished
  } catch (e) {
    // A skipped or failed transition still committed the page in its update callback, or never started: commit now.
    console.debug('[qd] page turn transition', e)
    if (job.epoch === epoch) h.setPageNow(job.page)
  } finally {
    current = null
    delete root.dataset.turn
  }
}

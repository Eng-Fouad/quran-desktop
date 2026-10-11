/**
 * Shaping warm-up (§8.5, §8.18 "page turn < 50 ms", "no long task during navigation"). Owner: WP8e (integration gate).
 *
 * The first layout of a QCF page measures and shapes every one of its words in the page's font at the page's exact
 * size. Each word is its own flex item and its own glyph, and WebView2 154 spends ≈ 0.2 ms on a word it has never
 * drawn at that size (glyph metrics and shaping), ≈ 30 ms a page, ≈ 60–80 ms a spread: most of a turn's or a jump's
 * long task (traced: `InlineNode::ShapeTextIncludingFirstLine` ×320 inside the forced layout of `fitLines`), and the
 * turn missed its budget (key → painted 80–112 ms). Chromium keeps both per font and size: glyph metrics for as long as
 * the face lives, shaped words until the font set changes (a face added to or removed from `document.fonts`, which
 * then costs ≈ 3 ms per 800 words to reshape). So laying a page's words out once beforehand makes its real layout cheap:
 * measured in the app, key → painted 80–89 ms became 29–39 ms.
 *
 * `shapeWarmer` lays pages out off screen, a few lines per slice, so no slice is a long task or delays a frame:
 * - `prefer(…)` (MushafView): the pages the next and the previous turn show, in idle time. A newer call replaces the
 *   list (the reader moved on).
 * - `need(…)` (RenditionStack): a page about to be drawn whose glyphs are cold, urgently (one slice per task, back to
 *   back) and ahead of everything else; the stack waits for it (within its font wait, §8.5 b) instead of laying the
 *   whole page out in one long task.
 * - Each line is a `div.qd-warm-ln` of `inline-block` word spans (each its own run, as in `GlyphLayer`) in a
 *   `.quran-text` box with the page's `--glyph-family` and `--glyph-scale`, inside a `.qd-warm` host that inherits the
 *   page's `--qfs`; lines.css gives the lines the `.ln` font size `calc(var(--qfs) * var(--glyph-scale))`, so the size
 *   is bit-for-bit the one the page uses (0.01 px off and everything is measured again).
 * - A slice forces the layout of its lines and removes them at once: nothing stays in the DOM and nothing is painted
 *   (the host is hidden and size-contained).
 * - `hasGlyphs(key)` (reactive) says a page's glyphs are warm at a size; `isWarm(key, epoch)` that its words are also
 *   still shaped for the current font set (`fonts.faceEpoch`).
 * - `wasPainted(key)` (reactive) says a page has been drawn in its QCF font at that size: its glyph images exist too.
 *   Laying out is half of a new page's cost; WebView2 also rasterises every new calligraphic glyph (on the raster
 *   threads, but a frame waits for it), which no off-screen layout can do beforehand. A flip (§8.11, a page every
 *   70 ms, no frame over 32 ms) therefore draws only painted pages in their QCF font and the Hafs fallback for the
 *   others, whose one face is drawn all the time (RenditionStack); the QCF rendition takes over when the flip ends.
 */
import { createSubscriber } from 'svelte/reactivity'
import type { MushafStyle } from '$lib/ipc/bindings'
import { STYLE_METRICS } from '$lib/mushaf/metrics'
import { pageFamily } from '$lib/stores/fonts.svelte'

/**
 * The CSS `font-family` a rendition draws its words in (`GlyphLayer`, and the warm-up, which must match it exactly):
 * a QCF page font alone (its PUA codes have no fallback), or the bundled Hafs face over Naskh for Unicode text.
 */
export function renditionFontFamily(family: string, unicode: boolean): string {
  const name = family.replace(/[^\w -]/g, '')
  return unicode || name === 'qd-hafs' ? `"qd-hafs", var(--font-naskh)` : `"${name}"`
}

/**
 * What a page's glyphs are warm under: its words (the page), its font and the font size. The page is part of the key
 * because the hafs style draws every page in one font. The size is `qfs` × the glyph scale the page is drawn at: the
 * style's (`STYLE_METRICS`), or for the hafs style the spread's (unicodeFit.ts), which its callers pass.
 */
export function glyphKey(
  style: MushafStyle,
  page: number,
  qfs: number,
  glyphScale: number = STYLE_METRICS[style].glyphScale,
): string {
  const family = renditionFontFamily(pageFamily(style, page), false)
  return `${style}:${page}|${family}|${glyphScale}|${qfs}`
}

/** One page to warm: what `GlyphLayer` draws for it, line by line. */
export interface WarmPage {
  /** `glyphKey(style, page, qfs, glyphScale)`. */
  key: string
  /** The CSS `font-family` of the rendition (`"qcf-v2-p51"`; `"qd-hafs", var(--font-naskh)` for the hafs style). */
  family: string
  /** `--glyph-scale` the page is drawn at (the style's; the spread's for the hafs style). */
  glyphScale: number
  /** The word texts of each ayah line, as the QCF rendition draws them (`PageWord.glyph`). */
  lines: readonly (readonly string[])[]
}

/**
 * The `WarmPage` of a page's data in its own style, at `glyphScale` (default: the style's; the hafs style passes its
 * spread's, `unicodeScale`, so the words are shaped at the size the page will draw them at).
 */
export function warmPageOf(
  data: { style: MushafStyle; page: number; lines: readonly { words: readonly { glyph: string }[] }[] },
  qfs: number,
  glyphScale: number = STYLE_METRICS[data.style].glyphScale,
): WarmPage {
  return {
    key: glyphKey(data.style, data.page, qfs, glyphScale),
    family: renditionFontFamily(pageFamily(data.style, data.page), false),
    glyphScale,
    lines: data.lines.filter((l) => l.words.length > 0).map((l) => l.words.map((w) => w.glyph)),
  }
}

/** Lines laid out per slice (≈ 30 words, ≈ 5 ms cold). */
export const WARM_LINES_PER_SLICE = 3
/** A slice starts only with this much idle time left in the frame (or when the idle callback timed out). */
export const WARM_MIN_IDLE_MS = 6
/** An idle callback runs at the latest after this long, even when the main thread never goes idle. */
export const WARM_IDLE_TIMEOUT_MS = 2000
/** Pages remembered as warm (LRU): the faces themselves are limited to 24 per style (§8.5). */
export const WARM_REMEMBER = 64

interface IdleDeadlineLike {
  didTimeout: boolean
  timeRemaining(): number
}

export type Scheduler = {
  request(run: (deadline: IdleDeadlineLike) => void): number
  cancel(handle: number): void
}

/** One slice per task, as soon as possible (frames still come between tasks). */
const urgentScheduler: Scheduler = {
  request: (run) =>
    setTimeout(() => run({ didTimeout: true, timeRemaining: () => 0 }), 0) as unknown as number,
  cancel: (handle) => clearTimeout(handle),
}

/** `requestIdleCallback` where there is one (WebView2, WebKit 18+, Chromium), else a short timeout. */
const idleScheduler: Scheduler =
  typeof requestIdleCallback === 'function'
    ? {
        request: (run) => requestIdleCallback(run, { timeout: WARM_IDLE_TIMEOUT_MS }),
        cancel: (handle) => cancelIdleCallback(handle),
      }
    : {
        request: (run) =>
          setTimeout(() => run({ didTimeout: true, timeRemaining: () => 0 }), 50) as unknown as number,
        cancel: (handle) => clearTimeout(handle),
      }

interface Job {
  page: WarmPage
  host: HTMLElement
  epoch: number
  /** The next line to lay out. */
  line: number
}

export class ShapeWarmer {
  /** Pages a drawn page waits for (`need`), first come first served, ahead of everything else. */
  #needed: Job[] = []
  /** The reader's neighbours (`prefer`). */
  #preferred: Job[] = []
  /** Warm keys and the font-set epoch they were laid out in, oldest first (a Map keeps insertion order: the LRU). */
  #warm = new Map<string, number>()
  #handle: number | null = null
  /** The lane the pending callback was scheduled in. */
  #lane: Scheduler | null = null
  readonly #idle: Scheduler
  readonly #urgent: Scheduler
  #changed: (() => void) | null = null
  readonly #subscribe = createSubscriber((update) => {
    this.#changed = update
    return () => {
      this.#changed = null
    }
  })

  constructor(idle: Scheduler = idleScheduler, urgent: Scheduler = urgentScheduler) {
    this.#idle = idle
    this.#urgent = urgent
  }

  /**
   * The pages to warm next (nearest first) in `host`, in idle time, replacing the previous list; a page still queued
   * keeps the lines it has done. Pages warm at `epoch` (the font set) are skipped.
   */
  prefer(host: HTMLElement, pages: readonly WarmPage[], epoch = 0): void {
    const started = new Map(this.#preferred.map((job) => [job.page.key, job.line]))
    const queued = new Set<string>()
    this.#preferred = []
    for (const page of pages) {
      if (this.isWarm(page.key, epoch) || queued.has(page.key) || page.lines.length === 0) continue
      queued.add(page.key)
      this.#preferred.push({ page, host, epoch, line: started.get(page.key) ?? 0 })
    }
    this.#reschedule()
  }

  /**
   * Warms one page urgently, ahead of everything else, until the returned function cancels it. `hasGlyphs(page.key)`
   * turns true when it is done (at once if it already is).
   */
  need(host: HTMLElement, page: WarmPage, epoch = 0): () => void {
    if (this.hasGlyphsNow(page.key) || page.lines.length === 0) return () => {}
    let job = this.#needed.find((j) => j.page.key === page.key)
    if (!job) {
      const preferred = this.#preferred.find((j) => j.page.key === page.key)
      job = { page, host, epoch, line: preferred?.line ?? 0 }
      this.#needed.push(job)
    }
    const mine = job
    this.#reschedule()
    return () => {
      this.#needed = this.#needed.filter((j) => j !== mine)
      this.#reschedule()
    }
  }

  /** Records a page laid out by its own rendition (its glyphs and words are warm now). */
  markWarm(key: string, epoch = 0): void {
    if (this.#warm.get(key) === epoch) return
    this.#remember(key, epoch)
  }

  /** Pages drawn in their QCF font at a size (their glyph images exist): what a flip may show without stalling. */
  #painted = new Set<string>()

  /** Records a page drawn in its QCF font at a size (RenditionStack, once the rendition is laid out). */
  markPainted(key: string): void {
    if (this.#painted.has(key)) return
    this.#painted.add(key)
    if (this.#painted.size > WARM_REMEMBER) {
      const oldest = this.#painted.values().next().value
      if (oldest !== undefined) this.#painted.delete(oldest)
    }
    this.#changed?.()
  }

  /** Whether a page has been drawn in its QCF font at a size (reactive). */
  wasPainted(key: string): boolean {
    this.#subscribe()
    return this.#painted.has(key)
  }

  /** Whether a page's glyphs are warm at its size (reactive: re-runs effects when a page is done). */
  hasGlyphs(key: string): boolean {
    this.#subscribe()
    return this.#warm.has(key)
  }

  /** `hasGlyphs` without subscribing. */
  hasGlyphsNow(key: string): boolean {
    return this.#warm.has(key)
  }

  /** Whether a page's words are also still shaped for the font set `epoch`. */
  isWarm(key: string, epoch = 0): boolean {
    return this.#warm.get(key) === epoch
  }

  /** Pages still queued (`waitIdle` in test mode, diagnostics). */
  get pending(): number {
    return this.#needed.length + this.#preferred.length
  }

  /** Drops the preferred list (the view unmounted); pages a drawn page needs stay. */
  cancel(): void {
    this.#preferred = []
    this.#reschedule()
  }

  /** Forgets everything (tests; the caches themselves belong to the webview). */
  reset(): void {
    this.#needed = []
    this.#preferred = []
    this.#warm.clear()
    this.#painted.clear()
    this.#reschedule()
    this.#changed?.()
  }

  #reschedule(): void {
    if (this.#needed.length === 0 && this.#preferred.length === 0) {
      if (this.#handle !== null) this.#lane?.cancel(this.#handle)
      this.#handle = null
      this.#lane = null
      return
    }
    const lane = this.#needed.length > 0 ? this.#urgent : this.#idle
    if (this.#handle !== null) {
      if (this.#lane === lane) return
      this.#lane?.cancel(this.#handle)
    }
    this.#lane = lane
    this.#handle = lane.request((deadline) => {
      this.#handle = null
      this.#lane = null
      this.#run(deadline)
    })
  }

  #run(deadline: IdleDeadlineLike): void {
    let first = true
    for (;;) {
      const queue = this.#needed.length > 0 ? this.#needed : this.#preferred
      const job = queue[0]
      if (!job) break
      // One slice always runs when the callback timed out (or is urgent), so a busy main thread still gets there.
      if (!(first && deadline.didTimeout) && deadline.timeRemaining() < WARM_MIN_IDLE_MS) break
      first = false
      // A needed page only wants its glyphs (any font set); a preferred one its words for this font set too.
      const satisfied =
        queue === this.#needed ? this.hasGlyphsNow(job.page.key) : this.isWarm(job.page.key, job.epoch)
      if (!job.host.isConnected || satisfied) {
        queue.shift()
        continue
      }
      const end = Math.min(job.page.lines.length, job.line + WARM_LINES_PER_SLICE)
      layOut(job.host, job.page, job.line, end)
      job.line = end
      if (job.line >= job.page.lines.length) {
        queue.shift()
        this.#remember(job.page.key, job.epoch)
      }
    }
    this.#reschedule()
  }

  #remember(key: string, epoch: number): void {
    this.#warm.delete(key)
    this.#warm.set(key, epoch)
    while (this.#warm.size > WARM_REMEMBER) {
      const oldest = this.#warm.keys().next().value
      if (oldest === undefined) break
      this.#warm.delete(oldest)
    }
    this.#changed?.()
  }
}

/** Lays out lines `[from, to)` of `page` in `host` (forcing the layout, which shapes their words) and removes them. */
function layOut(host: HTMLElement, page: WarmPage, from: number, to: number): void {
  const doc = host.ownerDocument
  const box = doc.createElement('div')
  box.className = 'quran-text'
  box.lang = 'ar'
  box.dir = 'rtl'
  box.style.setProperty('--glyph-family', page.family)
  box.style.setProperty('--glyph-scale', String(page.glyphScale))
  for (let i = from; i < to; i++) {
    const line = doc.createElement('div')
    line.className = 'qd-warm-ln'
    for (const word of page.lines[i] ?? []) {
      const span = doc.createElement('span')
      span.textContent = word
      line.append(span)
    }
    box.append(line)
  }
  host.append(box)
  // Reading a layout value lays the lines out now, which measures and shapes every word.
  void box.offsetHeight
  box.remove()
}

/** The app's warmer (one webview, one set of caches). */
export const shapeWarmer = new ShapeWarmer()

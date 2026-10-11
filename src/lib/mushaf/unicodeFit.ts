/**
 * The glyph scale of the hafs style, fitted per spread (§8.2, §8.4). Owner: WP8b (integration, Mushaf round 2).
 *
 * The hafs style (the default) draws Unicode text in the bundled KFGQPC Hafs face. Its words are not cut to the printed
 * lines like a QCF page font's, so their natural line widths vary a lot: one global `--glyph-scale`
 * (`STYLE_METRICS.hafs`, the p99 over all 604 pages) leaves the typical page with a lot of slack, which `space-between`
 * spreads into wide word gaps. So the scale is fitted to the pages on screen together:
 *
 *   scale = clamp(floor2(0.98 / max demand), 0.82, 0.92)
 *
 * - **demand** of a line: its natural width in em (the words, plus the 0.22 em minimum gap between them, lines.css)
 *   over its line box in qfs (16.5; 12.1 inside the opening medallion). The widest line of the spread then takes 98 %
 *   of its box, unsqueezed (the §8.2 fit target); the bounded line-fit stays the safety net below the floor.
 * - **one value per spread** (`SpreadContext`, set by `SpreadStage`), so facing pages always match. Single-page mode
 *   fits the one page; pages outside the reader's stage (previews, thumbnails) fit themselves.
 * - **floor** 0.82: the global measured scale, at which every line of the Mushaf fits (p99). **Cap** 0.92: bounds the
 *   size step between two spreads to ≈ 12 %. A spread without a justified line (the opening pages) keeps the floor.
 * - **Measured from the page data before the first layout**, not from the laid-out lines: the canvas `measureText` of
 *   each word in the face (each word is its own span, so its own run, as in `GlyphLayer`), at 100 px, cached per word
 *   text and per page. The page is then laid out once, at its final size: no second shaping pass at another size (a
 *   long task on a cold size, warmup.ts), no layout shift (CLS 0), and the shaping warm-up of the neighbours uses the
 *   same value (`MushafView`). It matches the DOM layout within 0.0015 em a line (all 3 × 604 pages, Edge).
 * - Until the face is loaded (the app loads it before it mounts, §8.5), or where there is no canvas (jsdom), the floor
 *   applies; readers inside effects re-run once the face is there.
 * - The fallback rendition of a QCF style (the same face) keeps the floor: it is transient, never faces a page in the
 *   same rendition for long, and it is what a flip draws, where one size keeps every glyph warm (warmup.ts).
 *
 * Measured over the 604 pages (V2 layout, hafs): the median words-to-line fill goes from 70 % to 75 % and the median
 * word gap from 0.58 to 0.48 qfs (p95 1.05 → 0.90); 80 of 302 spreads reach the cap, 62 keep the floor.
 */
import { getContext, hasContext, setContext } from 'svelte'
import { createSubscriber } from 'svelte/reactivity'
import type { PageData, PageWord } from '$lib/ipc/bindings'
import { isOpeningPage, OPENING_INSET, TB_W } from './geometry'
import { STYLE_METRICS } from './metrics'

/** The bounds and target of the per-spread fit. */
export const UNICODE_FIT = {
  /** The floor: the global measured scale of the Unicode renditions (`STYLE_METRICS.hafs`). */
  min: STYLE_METRICS.hafs.glyphScale,
  /** The cap: the size step between two spreads stays within ≈ 12 %. */
  max: 0.92,
  /** The widest line of a spread takes this share of its line box (§8.2: lines fit at `--fit ≥ 0.98`). */
  fill: 0.98,
} as const

/** The minimum word gap of justified Unicode lines and the gap of centred ones, in em (lines.css, `--center-gap`). */
export const UNICODE_GAP = STYLE_METRICS.hafs.centerGap

/** The size words are measured at (widths scale linearly with the font size). */
const MEASURE_PX = 100
/** The bundled Hafs face (`HAFS_FAMILY`), as the canvas font. */
const MEASURE_FONT = `${MEASURE_PX}px "qd-hafs"`
/** Word widths remembered (≈ 21,500 distinct word texts in the whole Mushaf). */
const WORD_CACHE_MAX = 30_000

/** What a page asks of the scale. */
export interface PageDemand {
  /** The largest natural width of an ayah line (em, minimum gaps included) over its line box (qfs). */
  ratio: number
  /** The page has a justified ayah line (the opening pages have none). */
  justified: boolean
}

const floor2 = (x: number) => Math.floor(x * 100 + 1e-9) / 100
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The scale of pages with these demands (the floor while one is unknown). */
export function scaleFor(demands: readonly (PageDemand | null)[]): number {
  let ratio = 0
  let justified = false
  for (const d of demands) {
    if (!d) return UNICODE_FIT.min
    ratio = Math.max(ratio, d.ratio)
    justified ||= d.justified
  }
  if (!justified || !(ratio > 0)) return UNICODE_FIT.min
  return clamp(floor2(UNICODE_FIT.fill / ratio), UNICODE_FIT.min, UNICODE_FIT.max)
}

/** The text a Unicode rendition draws for a word: the hafs style's glyph (its QPC Hafs text), else the word's text. */
export function unicodeText(data: Pick<PageData, 'style'>, word: Pick<PageWord, 'glyph' | 'text'>): string {
  return data.style === 'hafs' ? word.glyph : word.text
}

/**
 * The demand of a page from its line data and a word measure (advance in em). Every ayah line counts, centred ones
 * included (they must fit too); header and basmala lines carry no words.
 */
export function demandOf(
  data: Pick<PageData, 'page' | 'style' | 'lines'>,
  advance: (text: string) => number,
): PageDemand {
  const box = isOpeningPage(data.page) ? TB_W - 2 * OPENING_INSET : TB_W
  let ratio = 0
  let justified = false
  for (const line of data.lines) {
    if (line.words.length === 0) continue
    let natural = (line.words.length - 1) * UNICODE_GAP
    for (const w of line.words) natural += advance(unicodeText(data, w))
    ratio = Math.max(ratio, natural / box)
    if (!line.centered) justified = true
  }
  return { ratio, justified }
}

// --- measuring --------------------------------------------------------------------------------------------------------

class UnicodeMeasure {
  #ctx: CanvasRenderingContext2D | null | undefined
  #words = new Map<string, number>()
  #pages = new WeakMap<PageData, PageDemand>()
  #fontLoad: Promise<void> | null = null
  #changed: (() => void) | null = null
  readonly #subscribe = createSubscriber((update) => {
    this.#changed = update
    return () => {
      this.#changed = null
    }
  })

  /** The canvas context words are measured with, or `null` (no DOM, or jsdom, which has no canvas). */
  #context(): CanvasRenderingContext2D | null {
    if (this.#ctx !== undefined) return this.#ctx
    this.#ctx = null
    if (typeof document === 'undefined' || /jsdom/i.test(globalThis.navigator?.userAgent ?? '')) return null
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return null
    ctx.font = MEASURE_FONT
    // As the page lines (`.quran-text`): kerning on, no letter or word spacing.
    if ('fontKerning' in ctx) ctx.fontKerning = 'normal'
    this.#ctx = ctx
    return ctx
  }

  /** Whether the Hafs face is loaded; if not, loads it and tells the readers once it is. */
  #faceReady(): boolean {
    const set = typeof document === 'undefined' ? undefined : document.fonts
    if (!set || set.check(MEASURE_FONT)) return true
    if (this.#fontLoad) return false
    this.#fontLoad = set.load(MEASURE_FONT).then(
      () => {
        this.#fontLoad = null
        this.#changed?.()
      },
      () => {
        this.#fontLoad = null
      },
    )
    return false
  }

  /**
   * The demand of a page, measured now if it is not cached (≤ 8 ms for a page of words never measured before, 0.5 ms
   * typically: word widths are cached across pages); `null` while it cannot be measured (see the header).
   */
  demand(data: PageData): PageDemand | null {
    this.#subscribe()
    const cached = this.#pages.get(data)
    if (cached) return cached
    const ctx = this.#context()
    if (!ctx || !this.#faceReady()) return null
    const demand = demandOf(data, (text) => this.#advance(ctx, text))
    this.#pages.set(data, demand)
    return demand
  }

  #advance(ctx: CanvasRenderingContext2D, text: string): number {
    let em = this.#words.get(text)
    if (em === undefined) {
      em = ctx.measureText(text).width / MEASURE_PX
      if (this.#words.size >= WORD_CACHE_MAX) this.#words.clear()
      this.#words.set(text, em)
    }
    return em
  }
}

const measure = new UnicodeMeasure()

/** The demand of a page in the Hafs face (`null` while the face is loading, or without a canvas). */
export function pageDemand(data: PageData): PageDemand | null {
  return measure.demand(data)
}

/**
 * The `--glyph-scale` of the Unicode renditions of pages drawn together (a spread, or one page), measuring what is not
 * measured yet (pages are measured once; the reader's stage measures the pages it shows as they render, `MushafView`
 * the neighbours it warms once a turn has ended). Reactive: re-runs once the face has loaded.
 */
export function unicodeScale(pages: readonly PageData[]): number {
  return scaleFor(pages.map((p) => measure.demand(p)))
}

// --- the spread context (SpreadStage → the renditions of its pages) ---------------------------------------------------

/** What `SpreadStage` tells the pages it holds: the data of every page on screen with them. */
export interface SpreadContext {
  /** One entry per slot, in reading order; `undefined` while that page's data loads. */
  readonly pages: readonly (PageData | undefined)[]
}

const SPREAD_CONTEXT = Symbol('qd.mushaf.spread')

/** Provides the spread context (call during `SpreadStage` initialisation with an object of reactive getters). */
export function setSpreadContext(context: SpreadContext): SpreadContext {
  return setContext(SPREAD_CONTEXT, context)
}

/** The enclosing stage's spread, or `undefined` for a page outside the reader's stage. */
export function getSpreadContext(): SpreadContext | undefined {
  return hasContext(SPREAD_CONTEXT) ? getContext<SpreadContext>(SPREAD_CONTEXT) : undefined
}

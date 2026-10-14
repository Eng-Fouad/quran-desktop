/**
 * The word window of a Quran hit: whole words around the **first matched word**, at most 12 on each side, from
 * `SearchHit.words` (never by splitting text).
 *
 * With a measured line width the window is also fitted to `maxLines` lines of the 22 px Quran text, keyword-in-context
 * style: the words before the first match take at most `LEAD` of the first line, then the words after it fill the
 * lines; an ayah that fits whole shows whole. Line breaks are simulated with the browser's own greedy rule (break
 * before a word that does not fit), so the match is on the first line and a hit is never taller than `maxLines`.
 * Without a measurer (tests, no canvas) the window is the plain ±12 words.
 */

/** Words on each side of the first matched word. */
export const WINDOW_RADIUS = 12
/** At most this share of the first line goes to the words before the match. */
export const LEAD = 0.4
/** Quran hit lines (22 px, line-height 2.1). */
export const MAX_LINES = 3

export interface HitWindow {
  /** First word shown (index into `words`). */
  start: number
  /** One past the last word shown. */
  end: number
  /** Words were left out before / after the window: the edge word gets a fade (never an ellipsis). */
  cutBefore: boolean
  cutAfter: boolean
  /** Matched words outside the window ("+2 more in this ayah"). */
  hiddenMatches: number
}

export interface LineFit {
  /** Advance width of a word in px (the Quran font at the hit size). */
  measure: (word: string) => number
  /** Width of the space between words in px. */
  space: number
  /** Width of a line in px. */
  lineWidth: number
  maxLines?: number
}

/** Indices into `words` of the matched word ids, ascending, out-of-range ids dropped. */
export function matchedIndices(
  firstWordId: number,
  wordCount: number,
  matchedWordIds: readonly number[],
): number[] {
  const out = new Set<number>()
  for (const id of matchedWordIds) {
    const i = id - firstWordId
    if (Number.isInteger(i) && i >= 0 && i < wordCount) out.add(i)
  }
  return [...out].sort((a, b) => a - b)
}

/** How many lines `words[start..end)` take when wrapped greedily into `lineWidth`. */
export function countLines(words: readonly string[], start: number, end: number, fit: LineFit): number {
  let lines = 0
  let x = 0
  for (let i = start; i < end; i++) {
    const w = fit.measure(words[i] ?? '')
    if (lines === 0) {
      lines = 1
      x = w
    } else if (x + fit.space + w > fit.lineWidth) {
      lines++
      x = w
    } else {
      x += fit.space + w
    }
  }
  return lines
}

/**
 * The window of a hit: ±`WINDOW_RADIUS` words around the first match (the ayah's start when nothing matched), fitted
 * to `fit.maxLines` lines when a fit is given.
 */
export function hitWindow(
  words: readonly string[],
  matched: readonly number[],
  fit?: LineFit | null,
): HitWindow {
  const n = words.length
  const focus = matched[0] ?? 0
  let start = Math.max(0, focus - WINDOW_RADIUS)
  let end = Math.min(n, focus + WINDOW_RADIUS + 1)

  if (fit && fit.lineWidth > 0 && n > 0) {
    const maxLines = fit.maxLines ?? MAX_LINES
    if (countLines(words, start, end, fit) > maxLines) {
      // Lead: the words just before the match, within LEAD of a line.
      start = focus
      let lead = 0
      while (start > Math.max(0, focus - WINDOW_RADIUS)) {
        const w = fit.measure(words[start - 1] ?? '') + fit.space
        if (lead + w > LEAD * fit.lineWidth) break
        lead += w
        start--
      }
      // Tail: as many words after the match as fit the lines.
      end = focus + 1
      const lastEnd = Math.min(n, focus + WINDOW_RADIUS + 1)
      while (end < lastEnd && countLines(words, start, end + 1, fit) <= maxLines) end++
      // Reaching the ayah's end with room to spare: give the room back to the lead.
      if (end === n) {
        while (
          start > Math.max(0, focus - WINDOW_RADIUS) &&
          countLines(words, start - 1, end, fit) <= maxLines
        ) {
          start--
        }
      }
    }
  }

  return {
    start,
    end,
    cutBefore: start > 0,
    cutAfter: end < n,
    hiddenMatches: matched.filter((i) => i < start || i >= end).length,
  }
}

const widths = new Map<string, number>()
let context: CanvasRenderingContext2D | null | undefined
let contextFont = ''

function measureContext(): CanvasRenderingContext2D | null {
  if (context !== undefined) return context
  context = null
  try {
    // A document canvas measures with the document's fonts (qd-hafs is a document FontFace).
    if (typeof document !== 'undefined') context = document.createElement('canvas').getContext('2d')
  } catch {
    context = null
  }
  return context
}

/**
 * A canvas measurer for a CSS font (`22px qd-hafs`), cached per word; `null` without a 2D canvas. Call
 * `forgetWidths()` when fonts finish loading (a fallback face measures differently).
 */
export function canvasMeasurer(font: string): ((word: string) => number) | null {
  const ctx = measureContext()
  if (!ctx) return null
  return (word: string) => {
    const key = `${font}\u0000${word}`
    let w = widths.get(key)
    if (w === undefined) {
      if (contextFont !== font) {
        ctx.font = font
        contextFont = font
      }
      w = ctx.measureText(word).width
      widths.set(key, w)
    }
    return w
  }
}

/** Drops cached word widths (fonts changed). */
export function forgetWidths(): void {
  widths.clear()
  contextFont = ''
}

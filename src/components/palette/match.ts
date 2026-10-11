/**
 * Text matching for the command palette (§9.7): one fold for Arabic and Latin text, word-based scoring of a query
 * against an item's fields, and the ranges of a Latin label to emphasise. Pure, no store access. Owner: WP10c.
 *
 * - **Fold.** Apostrophes are dropped ("Qur'an" = "quran"), then `normalizeAr` (loose: harakat, tatweel, hamza seats,
 *   teh marbuta, Arabic-Indic digits; punctuation becomes a word break) and `foldLatin` (case, diacritics). So "Al-Kahf",
 *   "al kahf" and "AL KAHF" fold alike, and so do "السورة" and "السوره".
 * - **Words.** A folded field splits on spaces. An Arabic word that starts with the article (ال) also answers to its
 *   bare form, so "سرعة" finds "السرعة".
 * - **Score.** Every query token must match a word of the field: the whole word (3), a word prefix (2), or, from three
 *   letters, anywhere inside a word (1). Matching the field's first word and keeping the query's word order add a
 *   little. The result is in (0, 1]; 0 means no match. A field's weight scales it (labels 1, keywords less).
 */
import { foldLatin, hasArabic, normalizeAr } from '$lib/text/normalize'

/** Apostrophe-like characters removed before folding, so they never split a word. */
const APOSTROPHES = /['\u2018\u2019\u02bc\u02bb\u0060\u00b4]/gu
/** The Arabic definite article, folded. */
const ARTICLE = 'ال'

/** Folds text for matching (see the file comment). */
export function fold(text: string): string {
  return foldLatin(normalizeAr(text.replace(APOSTROPHES, ''), 'loose'))
}

/** The words of a text, folded (empties dropped). */
export function words(text: string): string[] {
  return fold(text)
    .split(' ')
    .filter((w) => w !== '')
}

/** A field to match against: its folded words and a weight (1 for the visible label). */
export interface MatchField {
  words: readonly string[]
  weight: number
}

/** Builds a field from text. */
export function field(text: string, weight = 1): MatchField {
  return { words: words(text), weight }
}

/** How well one token matches one word: 3 whole word, 2 prefix, 1 inside (three letters or more), 0 none. */
function wordScore(token: string, word: string): number {
  if (word === token) return 3
  if (word.startsWith(token)) return 2
  if (word.length > ARTICLE.length + 1 && word.startsWith(ARTICLE)) {
    const bare = word.slice(ARTICLE.length)
    if (bare === token) return 3
    if (bare.startsWith(token)) return 2
  }
  if (token.length >= 3 && word.includes(token)) return 1
  return 0
}

/** The score of a query (folded tokens) against one field, in [0, 1]. */
export function scoreField(tokens: readonly string[], f: MatchField): number {
  if (tokens.length === 0 || f.words.length === 0) return 0
  let total = 0
  let previous = -1
  let ordered = true
  for (const [i, token] of tokens.entries()) {
    let best = 0
    let at = -1
    for (const [j, word] of f.words.entries()) {
      const s = wordScore(token, word)
      if (s > best) {
        best = s
        at = j
        if (s === 3) break
      }
    }
    if (best === 0) return 0
    if (i === 0 && at === 0) total += 1
    if (at < previous) ordered = false
    previous = at
    total += best
  }
  if (ordered) total += 0.5
  // Shorter fields win ties: "Zoom in" before "Zoom in on the page" for "zoom".
  const brevity = 1 / (1 + 0.04 * Math.max(0, f.words.length - tokens.length))
  return (total / (3 * tokens.length + 1.5)) * brevity * f.weight
}

/** The best score of a query over several fields (0 when none matches). */
export function score(tokens: readonly string[], fields: readonly MatchField[]): number {
  let best = 0
  for (const f of fields) best = Math.max(best, scoreField(tokens, f))
  return best
}

/** The folded tokens of a query. */
export function queryTokens(query: string): string[] {
  return words(query)
}

/** A range `[start, end)` of UTF-16 indices into a label. */
export type MarkRange = readonly [start: number, end: number]

const WORD_CHAR = /[\p{L}\p{N}]/u

/**
 * The ranges of a label to emphasise for a query: each token's first match at the start of a word, by the same fold
 * as the scoring. Labels with Arabic letters get none: a weight change inside an Arabic word breaks its joining.
 */
export function markRanges(label: string, tokens: readonly string[]): MarkRange[] {
  if (tokens.length === 0 || hasArabic(label)) return []
  // Fold character by character, remembering where each folded unit came from.
  let folded = ''
  const origin: number[] = []
  const starts: boolean[] = []
  let index = 0
  let previousWord = false
  for (const ch of label) {
    const isWord = WORD_CHAR.test(ch)
    const f = isWord ? foldLatin(ch) : ' '
    for (let k = 0; k < f.length; k++) {
      origin.push(index)
      starts.push(isWord && !previousWord && k === 0)
    }
    folded += f
    previousWord = isWord
    index += ch.length
  }
  origin.push(label.length)

  const ranges: [number, number][] = []
  for (const token of tokens) {
    if (token === '') continue
    for (let at = folded.indexOf(token); at >= 0; at = folded.indexOf(token, at + 1)) {
      if (!starts[at]) continue
      const start = origin[at] ?? 0
      const lastOrigin = origin[at + token.length - 1] ?? start
      const lastWidth = (label.codePointAt(lastOrigin) ?? 0) > 0xffff ? 2 : 1
      ranges.push([start, Math.min(label.length, lastOrigin + lastWidth)])
      break
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const r of ranges) {
    const last = merged.at(-1)
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  return merged
}

/** A label cut into plain and emphasised parts, for rendering. */
export interface LabelPart {
  text: string
  mark: boolean
}

/** Splits a label at its mark ranges. */
export function splitMarks(label: string, ranges: readonly MarkRange[]): LabelPart[] {
  if (ranges.length === 0) return [{ text: label, mark: false }]
  const parts: LabelPart[] = []
  let at = 0
  for (const [start, end] of ranges) {
    if (start > at) parts.push({ text: label.slice(at, start), mark: false })
    parts.push({ text: label.slice(start, end), mark: true })
    at = end
  }
  if (at < label.length) parts.push({ text: label.slice(at), mark: false })
  return parts
}

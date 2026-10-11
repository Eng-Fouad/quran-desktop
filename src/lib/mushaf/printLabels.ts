/**
 * The 1441H print's own furniture calligraphy (§8.9; LEAD 25): the bundled "Quran Print Labels" face
 * (`public/fonts/QuranPrintLabels.otf`, CSS family `qd-print-labels`), its code points, its metrics and the sizes that
 * set it in the print's proportion. Owner: WP8c.
 *
 * The face carries the non-Quranic furniture of the KFGQPC Madinah print as outlines cut from the Mushaf Database
 * "Ligature-Based SVG Mushaf" V1.01 (`assets/print-labels/`): the running heads «سُورَةُ name» and «الجُزۡءُ …», the
 * stacked margin labels of the 240 rubs, six label words and the print's Eastern Arabic digits. It is print furniture,
 * not the decor pack: it ships with the app (`main.ts` loads it before the first paint, like qd-hafs) and is drawn
 * whatever `ornateHeaders` says. Its private-use code points have bidi class L, so a line composed of its words is
 * laid out as an RTL flex row of spans, never left to the bidi algorithm.
 *
 * Pure (no DOM, no stores): the face's readiness is `fonts.printLabelsReady`.
 */
import type { GlyphInk } from './ornaments'

/** The CSS family of the face (`src/styles/fonts.css`). */
export const PRINT_LABELS_FAMILY = 'qd-print-labels'

/** Code points (fixed by `assets/print-labels/build_print_labels.py`). */
export const PRINT_CP = {
  /** U+0660–0669: the print's Eastern Arabic digits (the same code points as `arabicNum`'s). */
  digit0: 0x0660,
  /** U+F600 + n: the running head «سُورَةُ name» of surah n (2–114; pages 1–2 carry no running head). */
  surah: 0xf600,
  /** U+F700 + j: the running head «الجُزۡءُ …» of juz j (1–30), the juz's ordinal in words as the print writes it. */
  juz: 0xf700,
  /** U+F800 + r: the stacked margin label of rub r (1–240). */
  rub: 0xf800,
} as const

/** The single words (U+F500–F505), set at the size of the margin labels' «الحِزۡبُ», on their baseline. */
export const PRINT_WORD = {
  rub: String.fromCodePoint(0xf500), // رُبُع
  nisf: String.fromCodePoint(0xf501), // نِصۡف
  thalatha: String.fromCodePoint(0xf502), // ثَلَاثَةُ أَرۡبَاعِ
  hizb: String.fromCodePoint(0xf503), // الحِزۡبُ
  juz: String.fromCodePoint(0xf504), // الجُزۡءُ
  surah: String.fromCodePoint(0xf505), // سُورَةُ
} as const

/**
 * The face's metrics in font units (UPM 1000), numbers only: generated from the committed font by
 * `python assets/print-labels/print_label_metrics.py public/fonts/QuranPrintLabels.otf` (fontTools; the union of the
 * ink boxes of each kind of glyph, rounded outwards, and its widest advance). The header glyphs share the running-head
 * baseline; every margin label and word shares the baseline of its «الحِزۡبُ» (the bottom of its alef), so a margin
 * label's extent depends on its stacked layout: a juz start «الجُزۡءُ j» over «الحِزۡبُ h» (the numbers beside the
 * words), a hizb start «الحِزۡبُ» over h, a quarter's word over «الحِزۡبُ» over h.
 */
export const PRINT_METRICS = {
  unitsPerEm: 1000,
  ascent: 615,
  descent: 384,
  space: 37,
  surah: { count: 113, yMin: -267, yMax: 516, advance: 2299 },
  juz: { count: 30, yMin: -210, yMax: 506, advance: 3523 },
  marginJuz: { count: 30, yMin: -90, yMax: 615, advance: 972 },
  marginHizb: { count: 30, yMin: -384, yMax: 280, advance: 823 },
  marginQuarter1: { count: 60, yMin: -343, yMax: 486, advance: 787 },
  marginQuarter2: { count: 60, yMin: -355, yMax: 474, advance: 787 },
  marginQuarter3: { count: 60, yMin: -343, yMax: 485, advance: 787 },
} as const

/**
 * The face's size for the print's proportion, in qfs: 1.7. Every glyph keeps the print's scale (40 font units per unit
 * of the source page, whose 15-line block is 243.2 units wide); that line is the app's `TB_W` (16.5·qfs), so 1 qfs is
 * 14.74 units and 1 em (25 units) is 1.696·qfs. A head glyph is then about a line of text tall with its marks
 * (0.9–1.3·qfs), and a margin label as wide as the print sets it beside its line.
 */
export const PRINT_EM = 1.7

/** The face's size in px for a page of `qfs`. */
export function printFontSize(qfs: number): number {
  return PRINT_EM * qfs
}

/**
 * Where the head glyphs sit: their baseline 0.5·qfs above the bottom of the HEAD band (the frame's outer edge), which
 * keeps every head inside the 1.4·qfs band at `PRINT_EM`: the deepest descender (-267 units) 0.05·qfs clear of the
 * frame and the tallest mark (516 units) 0.02·qfs under the band's top.
 */
export const PRINT_HEAD_BASELINE = 0.5

/**
 * The downward shift (px) that puts the baseline of a head glyph at `PRINT_HEAD_BASELINE`: the glyph's box has
 * `line-height: normal` and its bottom on the band's bottom, so the baseline sits the face's descent (0.384 em; it has
 * no line gap) above that bottom. Negative moves up. A normal line height is the face's own ascent and descent, which
 * the engines round to whole pixels (at most half a pixel off); a fixed one adds a split leading that Chromium floors,
 * up to a pixel off.
 */
export function printHeadDrop(qfs: number): number {
  return (PRINT_METRICS.descent / PRINT_METRICS.unitsPerEm) * printFontSize(qfs) - PRINT_HEAD_BASELINE * qfs
}

/** The running head «سُورَةُ name» of a surah (2–114), or null (no glyph: surah 1's pages carry no running head). */
export function printSurahHead(surah: number): string | null {
  return Number.isInteger(surah) && surah >= 2 && surah <= 114
    ? String.fromCodePoint(PRINT_CP.surah + surah)
    : null
}

/** The running head «الجُزۡءُ …» of a juz (1–30), or null. */
export function printJuzHead(juz: number): string | null {
  return Number.isInteger(juz) && juz >= 1 && juz <= 30 ? String.fromCodePoint(PRINT_CP.juz + juz) : null
}

/** The stacked margin label of a rub (1–240), or null. */
export function printRubLabel(rub: number): string | null {
  return Number.isInteger(rub) && rub >= 1 && rub <= 240 ? String.fromCodePoint(PRINT_CP.rub + rub) : null
}

/** The stacked layout of a rub's margin label, from its number alone (every juz starts on a hizb, every 8 rubs). */
export type PrintMarginKind =
  'marginJuz' | 'marginHizb' | 'marginQuarter1' | 'marginQuarter2' | 'marginQuarter3'

export function printMarginKind(rub: number): PrintMarginKind {
  const q = (((rub - 1) % 4) + 4) % 4
  if (q === 1) return 'marginQuarter1'
  if (q === 2) return 'marginQuarter2'
  if (q === 3) return 'marginQuarter3'
  return (((rub - 1) % 8) + 8) % 8 === 0 ? 'marginJuz' : 'marginHizb'
}

const FACE = {
  family: PRINT_LABELS_FAMILY,
  ascent: PRINT_METRICS.ascent / PRINT_METRICS.unitsPerEm,
  descent: PRINT_METRICS.descent / PRINT_METRICS.unitsPerEm,
} as const

/**
 * A rub's margin label as a glyph the margin sizes by its ink (`markerGlyphBox`): the extent of its kind of label
 * (so labels of a kind stack the same), drawn at `PRINT_EM`·qfs. Null for a rub outside 1–240.
 */
export function printLabelInk(rub: number): GlyphInk | null {
  const char = printRubLabel(rub)
  if (char === null) return null
  const { yMin, yMax } = PRINT_METRICS[printMarginKind(rub)]
  const top = yMax / PRINT_METRICS.unitsPerEm
  const bottom = -yMin / PRINT_METRICS.unitsPerEm
  return { char, ...FACE, top, bottom, size: PRINT_EM * (top + bottom) }
}

/**
 * The vertical shift (em) that puts a margin label's ink top on its box's top. The label's box (`markerGlyphBox`: as tall
 * as the ink of its kind) has `line-height: normal`, so its line starts at the box's top and puts the baseline the
 * face's ascent below it; the ink top is `top` em above the baseline. Negative moves up.
 */
export function printLabelShift(ink: Pick<GlyphInk, 'top' | 'ascent'>): number {
  return ink.top - ink.ascent
}

/** The fraction words of a quarter (1–3), in the face. */
const QUARTER_WORD = [null, PRINT_WORD.rub, PRINT_WORD.nisf, PRINT_WORD.thalatha] as const

/**
 * The running head's one-line quarter in the face, in reading order (right to left): the fraction word, «الحِزۡبُ», and
 * the hizb in the print's digits; «الحِزۡبُ h» for a hizb start. Each part is one span of an RTL flex row.
 */
export function printQuarterLine(rub: number, hizb: number): string[] {
  const q = (((rub - 1) % 4) + 4) % 4
  const digits = [...String(Math.max(0, Math.round(hizb)))]
    .map((d) => String.fromCodePoint(PRINT_CP.digit0 + Number(d)))
    .join('')
  const word = QUARTER_WORD[q]
  return word ? [word, PRINT_WORD.hizb, digits] : [PRINT_WORD.hizb, digits]
}

/** The gap between the words of a one-line label: the face's space (the print's gap before a number), in em. */
export const PRINT_WORD_GAP = PRINT_METRICS.space / PRINT_METRICS.unitsPerEm

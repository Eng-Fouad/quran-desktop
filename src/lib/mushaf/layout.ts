/**
 * Word-box measurement and highlight geometry (§8.7). Owner: WP8d.
 *
 * - `measure` is the renderer's only layout read: one batch of `getBoundingClientRect` over a rendition's word spans,
 *   once per rendition after `fitLines` and again after a `qfs` change (RenditionStack, WP8b). Boxes are in CSS px
 *   relative to `.mp-block` and include the line-fit transforms.
 * - `ayahPills` / `wordPill` turn boxes into the pill shapes of §8.7, and `planHighlights` composes every highlight state
 *   of a page into shape-separated layers with **at most one fill per word** (a user highlight under a state fill becomes
 *   a bar). All of it is pure arithmetic on the boxes, so a state change never reads layout.
 *
 * Geometry, in qfs (LH = 1.75 qfs):
 * - The vertical band of every pill is the line's centre ± 0.38·LH, i.e. `line top + 0.12·LH`, height `0.76·LH`.
 * - Ayah pill, per line: the range's words, each side extended by half the gap to the neighbouring word of another
 *   ayah (at most `MAX_EXTEND`), or by `EDGE_PAD` past the outermost word when there is none; radius 0.28·qfs.
 * - Word pill: the word box ± 0.10·qfs horizontally, the same band, radius 0.24·qfs.
 * - Bars sit at the bottom of the band, below the glyphs' em box at every style's `--glyph-scale` (`layout.test.ts`).
 */
import type { Rect, WordBox } from '$lib/contracts/components'
import type { HighlightColor } from '$lib/ipc/bindings'
import { LH } from './geometry'

export type { Rect, WordBox }

/** Pill and bar geometry in qfs (or in LH where noted), §8.7. */
export const PILL = {
  /** Half the band height, in LH: the band is the line centre ± 0.38·LH (top + 0.12·LH, height 0.76·LH). */
  halfBand: 0.38,
  ayahRadius: 0.28,
  wordRadius: 0.24,
  /** Word pills extend the word box by this much on each side. */
  wordPad: 0.1,
  /** An ayah pill end with no neighbouring word extends this far past the outermost word. */
  edgePad: 0.2,
  /** An ayah pill end never extends further than this towards a neighbouring word (sparse justified lines). */
  maxExtend: 0.6,
  /** The bar a demoted user highlight leaves at the bottom of the pill. */
  userBar: 0.08,
  /** The search hit's underline at the bottom of its word pill. */
  searchBar: 0.1,
} as const

/**
 * How far (in qfs) the highlight layer reaches past the text block on each side: the pills of a justified line's
 * outermost words overhang the line edge by `edgePad`/`wordPad`, into the 0.40·qfs gap before the frame band (§8.2).
 */
export const HL_OUTSET = 0.3

// --- measurement -------------------------------------------------------------------------------------------------------

/**
 * One batch of `getBoundingClientRect` over the word spans of a rendition, relative to `.mp-block` (§8.7). Boxes are in
 * the block's own CSS px: an ancestor's scale (the browser mock's CSS `zoom` for the UI scale, a view transition) is
 * divided out. A rendition that is not laid out yields no boxes.
 */
export function measure(rendition: HTMLElement, block: HTMLElement): WordBox[] {
  const origin = block.getBoundingClientRect()
  if (origin.width <= 0 || origin.height <= 0) return []
  const sx = block.offsetWidth > 0 ? origin.width / block.offsetWidth : 1
  const sy = block.offsetHeight > 0 ? origin.height / block.offsetHeight : 1
  const boxes: WordBox[] = []
  for (const ln of rendition.children) {
    if (!(ln instanceof HTMLElement) || !ln.classList.contains('ln')) continue
    const line = Number(ln.dataset.l)
    if (!Number.isInteger(line)) continue
    for (const span of ln.getElementsByClassName('w')) {
      if (!(span instanceof HTMLElement)) continue
      const id = Number(span.dataset.w)
      const ayahId = Number(span.dataset.a)
      if (!Number.isInteger(id) || !Number.isInteger(ayahId)) continue
      const r = span.getBoundingClientRect()
      boxes.push({
        id,
        ayahId,
        line,
        x: (r.left - origin.left) / sx,
        y: (r.top - origin.top) / sy,
        w: r.width / sx,
        h: r.height / sy,
      })
    }
  }
  return boxes
}

// --- lines -------------------------------------------------------------------------------------------------------------

/** The words of one line, left to right, with the line's vertical centre. */
export interface LineBoxes {
  line: number
  /** Words sorted by `x` (physical left to right; the reading order is right to left). */
  words: WordBox[]
  /** Vertical centre of the line's words (the median, robust to a glyph with odd metrics). */
  cy: number
}

/** Groups boxes by line (ascending line number), each line sorted left to right. */
export function lineBoxes(boxes: readonly WordBox[]): LineBoxes[] {
  const byLine = new Map<number, WordBox[]>()
  for (const b of boxes) {
    const list = byLine.get(b.line)
    if (list) list.push(b)
    else byLine.set(b.line, [b])
  }
  return [...byLine.entries()]
    .sort(([a], [b]) => a - b)
    .map(([line, words]) => {
      words.sort((a, b) => a.x - b.x)
      const centres = words.map((w) => w.y + w.h / 2).sort((a, b) => a - b)
      const mid = centres.length >> 1
      const cy =
        centres.length % 2 === 1 ? (centres[mid] ?? 0) : ((centres[mid - 1] ?? 0) + (centres[mid] ?? 0)) / 2
      return { line, words, cy }
    })
}

/** qfs from the line pitch (`lh = 1.75·qfs`). */
const qfsOf = (lh: number): number => lh / LH

const clampRadius = (r: number, w: number, h: number): number => Math.max(0, Math.min(r, w / 2, h / 2))

/**
 * The horizontal extent of a run of words `[from, to]` (indices into `words`, left to right): each end extends by half
 * the gap to its neighbour, at most `maxExtend`, or by `edgePad` past the word when the line has no neighbour there.
 * `boundary(i)` may fix the end next to word `i` instead (a word pill drawn there, see `planHighlights`).
 */
function runExtent(
  words: readonly WordBox[],
  from: number,
  to: number,
  qfs: number,
  boundary?: (side: 'left' | 'right', neighbour: number) => number | null,
): { x0: number; x1: number } {
  const first = words[from]
  const last = words[to]
  if (!first || !last) return { x0: 0, x1: 0 }
  const left = words[from - 1]
  const right = words[to + 1]
  let x0 = first.x - PILL.edgePad * qfs
  if (left) {
    const fixed = boundary?.('left', from - 1) ?? null
    const gapMid = (left.x + left.w + first.x) / 2
    x0 = fixed ?? Math.max(gapMid, first.x - PILL.maxExtend * qfs)
    x0 = Math.min(x0, first.x)
  }
  let x1 = last.x + last.w + PILL.edgePad * qfs
  if (right) {
    const fixed = boundary?.('right', to + 1) ?? null
    const gapMid = (last.x + last.w + right.x) / 2
    x1 = fixed ?? Math.min(gapMid, last.x + last.w + PILL.maxExtend * qfs)
    x1 = Math.max(x1, last.x + last.w)
  }
  return { x0, x1 }
}

/** Splits the indices of `words` that satisfy `pick` into maximal consecutive runs. */
function consecutiveRuns(words: readonly WordBox[], pick: (w: WordBox) => boolean): [number, number][] {
  const runs: [number, number][] = []
  let start = -1
  words.forEach((w, i) => {
    if (pick(w)) {
      if (start < 0) start = i
    } else if (start >= 0) {
      runs.push([start, i - 1])
      start = -1
    }
  })
  if (start >= 0) runs.push([start, words.length - 1])
  return runs
}

// --- pills ---------------------------------------------------------------------------------------------------------------

/**
 * Ayah pills for the ayah range `[ayahFrom, ayahTo]`, one per line (more if the range's words are not consecutive on a
 * line), top to bottom (§8.7). `blockW` bounds the result to the highlight layer (`HL_OUTSET` past the block).
 */
export function ayahPills(
  boxes: readonly WordBox[],
  ayahFrom: number,
  ayahTo: number,
  lh: number,
  blockW: number,
): Rect[] {
  const qfs = qfsOf(lh)
  const half = PILL.halfBand * lh
  const rects: Rect[] = []
  for (const { words, cy } of lineBoxes(boxes)) {
    for (const [from, to] of consecutiveRuns(words, (w) => w.ayahId >= ayahFrom && w.ayahId <= ayahTo)) {
      const { x0, x1 } = runExtent(words, from, to, qfs)
      rects.push(pill(x0, x1, cy - half, 2 * half, PILL.ayahRadius * qfs, qfs, blockW))
    }
  }
  return rects
}

/** The pill of one word (§8.7): the box ± 0.10·qfs horizontally, the line's band vertically, radius 0.24·qfs. */
export function wordPill(box: WordBox, qfs: number, lh: number): Rect {
  const half = PILL.halfBand * lh
  const cy = box.y + box.h / 2
  const w = box.w + 2 * PILL.wordPad * qfs
  const h = 2 * half
  return { x: box.x - PILL.wordPad * qfs, y: cy - half, w, h, r: clampRadius(PILL.wordRadius * qfs, w, h) }
}

function pill(x0: number, x1: number, y: number, h: number, r: number, qfs: number, blockW: number): Rect {
  const lo = -HL_OUTSET * qfs
  const hi = blockW + HL_OUTSET * qfs
  const a = Math.max(lo, Math.min(x0, x1))
  const b = Math.min(hi, Math.max(x0, x1))
  const w = Math.max(0, b - a)
  return { x: a, y, w, h, r: clampRadius(r, w, h) }
}

// --- the highlight plan (§8.7) -------------------------------------------------------------------------------------------

/** The page's highlight states, as plain values (HighlightLayer reads them from the stores). */
export interface HighlightState {
  /** User highlights overlapping the page (`UserMarks.highlights`). */
  user: readonly { id: string; fromAyahId: number; toAyahId: number; color: HighlightColor }[]
  /** The search hit's words (`reader.searchHit`). */
  search: { ayahId: number; wordIds: readonly number[] } | null
  /** The selected ayah range (`reader.selection`). */
  selection: { fromAyahId: number; toAyahId: number } | null
  /** The hovered ayah when `hoverHighlight` is on (`reader.hover`). */
  hoverAyahId: number | null
  /** The recited ayah (`player.currentAyahId`). */
  audioAyahId: number | null
  /** An ayah that just flashed after a jump (`reader.flash`). */
  flashAyahId: number | null
  /** The reading cursor while DOM focus is on its roving item (layer 7). */
  cursorAyahId: number | null
}

/** A fill's source, in the §8.7 layer order. `search` is word-shaped; every other fill is ayah-shaped. */
export type FillKind = 'user' | 'search' | 'selection' | 'hover' | 'audio' | 'flash'

/** A drawn highlight shape: a rect with what it shows. `key` is stable while the shape keeps its meaning. */
export interface HighlightShape extends Rect {
  key: string
  kind: FillKind | 'user-bar' | 'search-bar' | 'selection-ring' | 'cursor-ring'
  /** The user highlight colour (`user` fills and `user-bar`s). */
  color?: HighlightColor
}

/** Every shape of a page, by paint order: fills, then rings, then bars (above the audio word pill). */
export interface HighlightPlan {
  fills: HighlightShape[]
  rings: HighlightShape[]
  bars: HighlightShape[]
}

/**
 * State fills, strongest first. A word takes the first that covers it, else its user highlight, else the hover tint:
 * at most one fill per word. The four state fills that §8.7 names (search, audio, the transient arrival flash and the
 * selection) demote a user highlight under them to a bar; the hover tint is the weakest and never covers a user fill.
 */
type StateFill = 'search' | 'audio' | 'flash' | 'selection'

/**
 * Composes the page's highlight states into shapes (§8.7): one fill per word (state fill, else user fill, else hover),
 * user highlights under a state fill drawn as bars, the search underline, and the selection and cursor rings around
 * the full ayah pills of their ranges.
 */
export function planHighlights(
  boxes: readonly WordBox[],
  state: HighlightState,
  geom: { qfs: number; lh: number; blockW: number },
): HighlightPlan {
  const { qfs, lh, blockW } = geom
  const half = PILL.halfBand * lh
  const searchWords = new Set(state.search?.wordIds ?? [])
  const inSelection = (a: number) =>
    state.selection !== null && a >= state.selection.fromAyahId && a <= state.selection.toAyahId
  const userOf = (a: number) => {
    let hit: HighlightState['user'][number] | undefined
    for (const h of state.user) if (a >= h.fromAyahId && a <= h.toAyahId) hit = h
    return hit
  }
  const stateOf = (w: WordBox): StateFill | null => {
    if (searchWords.has(w.id)) return 'search'
    if (state.audioAyahId !== null && w.ayahId === state.audioAyahId) return 'audio'
    if (state.flashAyahId !== null && w.ayahId === state.flashAyahId) return 'flash'
    if (inSelection(w.ayahId)) return 'selection'
    return null
  }

  const fills: HighlightShape[] = []
  const bars: HighlightShape[] = []
  for (const { line, words, cy } of lineBoxes(boxes)) {
    // The fill key of each word: a state, else `user:<id>`, else hover, else none.
    const keys = words.map((w): string | null => {
      const s = stateOf(w)
      if (s) return s
      const user = userOf(w.ayahId)
      if (user) return `user:${user.id}`
      if (state.hoverAyahId !== null && w.ayahId === state.hoverAyahId) return 'hover'
      return null
    })
    // An ayah-shaped run ends at the edge of a neighbouring search pill (never overlapping it, never leaving a gap).
    const boundary = (side: 'left' | 'right', i: number): number | null => {
      if (keys[i] !== 'search') return null
      const n = words[i]
      if (!n) return null
      return side === 'left' ? n.x + n.w + PILL.wordPad * qfs : n.x - PILL.wordPad * qfs
    }
    let i = 0
    while (i < words.length) {
      const key = keys[i] ?? null
      let j = i
      while (j + 1 < words.length && (keys[j + 1] ?? null) === key) j++
      const first = words[i]
      if (key !== null && first) {
        if (key === 'search') {
          const last = words[j] ?? first
          const x0 = first.x - PILL.wordPad * qfs
          const x1 = last.x + last.w + PILL.wordPad * qfs
          fills.push({
            ...pill(x0, x1, cy - half, 2 * half, PILL.wordRadius * qfs, qfs, blockW),
            key: `search:${line}:${first.id}`,
            kind: 'search',
          })
          bars.push({
            ...pill(x0, x1, cy + half - PILL.searchBar * qfs, PILL.searchBar * qfs, Infinity, qfs, blockW),
            key: `search-bar:${line}:${first.id}`,
            kind: 'search-bar',
          })
        } else {
          const { x0, x1 } = runExtent(words, i, j, qfs, boundary)
          const user = key.startsWith('user:') ? userOf(first.ayahId) : undefined
          const kind: FillKind = user ? 'user' : (key as FillKind)
          fills.push({
            ...pill(x0, x1, cy - half, 2 * half, PILL.ayahRadius * qfs, qfs, blockW),
            key: `${key}:${line}:${first.id}`,
            kind,
            ...(user ? { color: user.color } : {}),
          })
        }
      }
      i = j + 1
    }
    // Demoted user highlights: a bar under each run of words that a state fill covers (same highlight, consecutive).
    let k = 0
    while (k < words.length) {
      const w = words[k]
      const user = w && stateOf(w) !== null ? userOf(w.ayahId) : undefined
      if (!w || !user) {
        k++
        continue
      }
      let m = k
      while (m + 1 < words.length) {
        const next = words[m + 1]
        if (!next || stateOf(next) === null || userOf(next.ayahId)?.id !== user.id) break
        m++
      }
      const last = words[m] ?? w
      bars.push({
        ...pill(
          w.x - PILL.wordPad * qfs,
          last.x + last.w + PILL.wordPad * qfs,
          cy + half - PILL.userBar * qfs,
          PILL.userBar * qfs,
          Infinity,
          qfs,
          blockW,
        ),
        key: `user-bar:${user.id}:${line}:${w.id}`,
        kind: 'user-bar',
        color: user.color,
      })
      k = m + 1
    }
  }

  const rings: HighlightShape[] = []
  if (state.selection) {
    const { fromAyahId, toAyahId } = state.selection
    for (const r of ayahPills(boxes, fromAyahId, toAyahId, lh, blockW))
      rings.push({
        ...r,
        key: `selection-ring:${Math.round(r.y)}:${Math.round(r.x)}`,
        kind: 'selection-ring',
      })
  }
  if (state.cursorAyahId !== null) {
    for (const r of ayahPills(boxes, state.cursorAyahId, state.cursorAyahId, lh, blockW))
      rings.push({ ...r, key: `cursor-ring:${Math.round(r.y)}:${Math.round(r.x)}`, kind: 'cursor-ring' })
  }
  return { fills, rings, bars }
}

/** The word box of a word id (the audio word's pill), or `undefined` when the word is not on this rendition. */
export function boxOf(boxes: readonly WordBox[], wordId: number): WordBox | undefined {
  for (const b of boxes) if (b.id === wordId) return b
  return undefined
}

/**
 * Mushaf geometry (§8.2, §8.4, §9.6). Owner: WP8a.
 *
 * - The page constants, in qfs units (the Quran font size in CSS px, §0.4). Every page box, line box and margin is a
 *   multiple of `--qfs`, so nothing moves when a font swaps (CLS 0, §8.1).
 * - `fitLayout`: spread or single page, dock placement (geometry only, D28) and the fitted qfs for a canvas.
 * - `paneCanDock`: whether the side pane can sit beside the canvas without squeezing the page (§9.6).
 * - `lineFit`/`fitLines`: the bounded line-fit of §8.4 (horizontal squeeze ≥ 0.96, uniform scale below).
 * - The page context that `MushafPage` provides to the layers rendered inside it (`GlyphLayer` reads `qfs` from it).
 *
 * The same numbers are mirrored as CSS custom properties in `src/styles/mushaf/page.css` (`--mp-*`); a unit test keeps
 * the two in step.
 */
import { getContext, hasContext, setContext } from 'svelte'
import type { Dock } from '$lib/contracts/stores'
import type { PageSide } from '$lib/contracts/components'
import type { PageMode } from '$lib/ipc/bindings'

// ---------------------------------------------------------------------------------------------------------------------
// Page constants (qfs units, §8.2)

/** Text block width (line width). */
export const TB_W = 16.5
/** Line pitch (line box height). */
export const LH = 1.75
/** Lines in the text block. */
export const LINES = 15
/** Text block height: 15 × LH. */
export const TB_H = LINES * LH
/** Frame band, each side: gap 0.40 + inner rule + band 0.32 + outer rule. */
export const FR = 0.85
/** Running-head band. */
export const HEAD = 1.4
/** Page-number band. */
export const FOOT = 1.4
/** Outer margin (margin markers). */
export const M_OUT = 1.9
/** Spine margin. */
export const M_IN = 0.9
/** Paper margin, top and bottom. */
export const M_TB = 0.6
/** Page width: M_IN + FR + TB_W + FR + M_OUT = 21.00. */
export const PW = M_IN + FR + TB_W + FR + M_OUT
/** Page height: M_TB + HEAD + FR + TB_H + FR + FOOT + M_TB = 31.95. */
export const PH = M_TB + HEAD + FR + TB_H + FR + FOOT + M_TB
/** Single-page paper offset that keeps the text block still across page turns (§8.10): (M_OUT − M_IN) / 2. */
export const SHIFT = (M_OUT - M_IN) / 2
/** Single-page footprint: PW + 2·SHIFT = 22.00. */
export const SINGLE_W = PW + 2 * SHIFT

/** Top of the text block from the top paper edge: M_TB + HEAD + FR = 2.85. */
export const BLOCK_TOP = M_TB + HEAD + FR
/** Text block edge from the page's outer edge: M_OUT + FR = 2.75. */
export const BLOCK_OUTER = M_OUT + FR
/** Text block edge from the spine edge: M_IN + FR = 1.75. */
export const BLOCK_INNER = M_IN + FR

/** Opening pages (1–2): 8 lines, centred vertically in the 15-line block (§8.4). */
export const OPENING_LAST_PAGE = 2
export const OPENING_LINES = 8
/** Line offset of the opening block: (15 − 8) / 2 lines. */
export const OPENING_TOP_LINES = (LINES - OPENING_LINES) / 2
/** Inline inset of the opening lines on each side, inside the medallion. */
export const OPENING_INSET = 2.2

/** Pages per layout (all three layouts, §0.2). */
export const PAGE_COUNT = 604

// ---------------------------------------------------------------------------------------------------------------------
// Fit constants (CSS px, §8.2)

/** Canvas padding around the pages. */
export const PAD_X = 24
export const PAD_Y = 16
/** Width reserved beside the pages for the side dock card (272 px card + gap). */
export const SIDE_DOCK_W = 288
/** Height reserved for the bottom dock: the 64 px bar, or the 56 px compact bar under 860 px of canvas height. */
export const BAR_RESERVE = 84
export const COMPACT_BAR_RESERVE = 64
/** Below this canvas height the bottom dock is the compact bar. */
export const COMPACT_BELOW_H = 860
/**
 * The canvas overlay slot (§7.5): its bottom edge above the canvas bottom, above the 64/56 px bar dock (10 px off the
 * edge, 14 px between), or 24 px with the side card.
 */
export const SLOT_ABOVE_BAR = 10 + 64 + 14
export const SLOT_ABOVE_COMPACT = 10 + 56 + 14
export const SLOT_SIDE = 24
/** The gap kept between a persistent slot bar and the book (px). */
export const SLOT_CLEAR_GAP = 12
/** In `auto`, a bar-dock spread beats a side-dock single page when its qfs is at least this share of the single's. */
export const SPREAD_PREFERENCE = 0.85
/** Legibility floor of the fitted qfs (§8.1 invariant 7): below it the canvas scrolls instead. */
export const QFS_MIN = 18
/** Upper bound of qfs (any zoom). */
export const QFS_MAX = 160
/** Lower bound of qfs, reachable only by an explicit zoom-out. */
export const QFS_ZOOM_MIN = 8
/** qfs moves in quarter-px steps, which avoids sub-pixel jitter. */
export const QFS_STEP = 0.25
/** Extra room the side pane must leave beside a single page before it docks (§9.6). */
export const PANE_DOCK_SLACK = 16

export interface FitResult {
  /** Two pages side by side. */
  spread: boolean
  /** Player dock placement (geometry only, D28). */
  dock: Dock
  /** Quran font size in px, in quarter-px steps. */
  qfs: number
  /** The canvas scrolls: the fit fell below `QFS_MIN` or the zoom exceeds 100 %. */
  scroll: boolean
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
/** A finite, non-negative size; anything else counts as 0 (an unmeasured canvas). */
const size = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0)

/** The bottom-dock height reserve for a canvas height. */
export function barReserve(canvasH: number): number {
  return size(canvasH) < COMPACT_BELOW_H ? COMPACT_BAR_RESERVE : BAR_RESERVE
}

/** Where the overlay slot's bottom edge sits above the canvas bottom for a dock placement (§7.5). */
export function slotBottom(dock: Dock): number {
  return dock === 'side' ? SLOT_SIDE : dock === 'compact' ? SLOT_ABOVE_COMPACT : SLOT_ABOVE_BAR
}

/**
 * How far above the canvas bottom the book must end while a bar `barH` px tall stays in the overlay slot for a whole
 * mode (the memorisation toolbar, the self-test bar): the slot's bottom, the bar and a 12 px gap; 0 without one.
 * Transient chips (follow, division, hint) float over the page instead.
 */
export function slotClearance(dock: Dock, barH: number): number {
  return Number.isFinite(barH) && barH > 0 ? slotBottom(dock) + barH + SLOT_CLEAR_GAP : 0
}

/** `qfs` rounded down to the quarter-px grid (with a tolerance for floating-point noise: 22.75 stays 22.75). */
export function snapQfs(qfs: number): number {
  return Math.floor(qfs / QFS_STEP + 1e-9) * QFS_STEP
}

/**
 * §8.2: spread or single page, the dock placement and the qfs for a canvas of `canvasW × canvasH` CSS px.
 * - A side-dock spread is taken whenever it fits (page mode `auto` or `spread`).
 * - Otherwise the best single page (side dock if it fits beside the pages, else the bar) competes with a bar-dock
 *   spread: in `auto` the spread wins when its qfs is ≥ 85 % of the single page's; `spread` always takes it.
 * - The fitted qfs never drops below `QFS_MIN` (the canvas scrolls instead); zoom multiplies it afterwards. In `auto`,
 *   the floor ranks above the spread preference: a spread that would fall below `QFS_MIN` loses to a single page that
 *   does not, and, when both fall below it, to a single page that still fits the canvas width at `QFS_MIN` while the
 *   spread does not (the canvas then scrolls vertically only, §12.6 S29). See `floorSingle`.
 * Non-finite or negative sizes count as 0 and a non-positive zoom as 100 %, so an unmeasured canvas still yields a
 * usable result (`QFS_MIN`, scrolling).
 *
 * `clearBottom` (px, default 0): how far above the canvas bottom the book must end because a bar stays in the canvas
 * overlay slot for a whole mode (the memorisation toolbar or the self-test bar, §7.5). It only caps the fitted qfs:
 * the spread and dock decisions are those of the full canvas, so the book re-fits once, above the bar, and the dock
 * never moves when the mode starts or ends.
 */
export function fitLayout(
  canvasW: number,
  canvasH: number,
  pageMode: PageMode,
  zoomPct: number,
  clearBottom = 0,
): FitResult {
  const w = size(canvasW)
  const h = size(canvasH)
  const zoom = Number.isFinite(zoomPct) && zoomPct > 0 ? zoomPct : 100
  const barDock: Dock = h < COMPACT_BELOW_H ? 'compact' : 'bar'
  const hSide = (h - 2 * PAD_Y) / PH
  const hBar = (h - 2 * PAD_Y - barReserve(h)) / PH
  const wSide = w - 2 * PAD_X - SIDE_DOCK_W
  const wBar = w - 2 * PAD_X
  const sideSpread = 2 * PW * hSide <= wSide
  const sideSingle = SINGLE_W * hSide <= wSide
  const barSpreadQ = Math.min(hBar, wBar / (2 * PW))
  const barSingleQ = Math.min(hBar, wBar / SINGLE_W)

  let spread: boolean
  let dock: Dock
  let fit: number
  if (pageMode !== 'single' && sideSpread) {
    spread = true
    dock = 'side'
    fit = hSide
  } else {
    const barSingle = { q: barSingleQ, dock: barDock }
    const single = sideSingle ? { q: hSide, dock: 'side' as Dock } : barSingle
    const preferSpread =
      pageMode === 'spread' || (pageMode === 'auto' && barSpreadQ >= SPREAD_PREFERENCE * single.q)
    const floored =
      pageMode === 'auto' && preferSpread ? floorSingle(barSpreadQ, single, barSingle, wSide, wBar) : null
    if (floored) {
      spread = false
      dock = floored.dock
      fit = floored.q
    } else if (preferSpread) {
      spread = true
      dock = barDock
      fit = barSpreadQ
    } else {
      spread = false
      dock = single.dock
      fit = single.q
    }
  }
  // A persistent slot bar: the page box ends `clearBottom` above the canvas bottom (PAD_Y stays above it).
  const clear = size(clearBottom)
  if (clear > 0) fit = Math.min(fit, (h - PAD_Y - clear) / PH)
  const base = Math.max(fit, QFS_MIN)
  const qfs = clamp(snapQfs((base * zoom) / 100), QFS_ZOOM_MIN, QFS_MAX)
  return { spread, dock, qfs, scroll: fit < QFS_MIN || zoom > 100 }
}

/**
 * The single page that beats a preferred bar-dock spread at the legibility floor, or `null` (§8.1 invariant 7, S29):
 * - the spread fits at `QFS_MIN` or above: `null` (the preference stands);
 * - the single page fits at or above it: that single page, which does not scroll;
 * - both fall below it and the spread is wider than the canvas at `QFS_MIN`: the single page if it fits the width at
 *   `QFS_MIN` (beside the side card, else above the bar), so the canvas scrolls vertically only.
 */
function floorSingle(
  spreadQ: number,
  single: { q: number; dock: Dock },
  barSingle: { q: number; dock: Dock },
  wSide: number,
  wBar: number,
): { q: number; dock: Dock } | null {
  if (spreadQ >= QFS_MIN) return null
  if (single.q >= QFS_MIN) return single
  if (2 * PW * QFS_MIN <= wBar) return null
  if (single.dock === 'side' && SINGLE_W * QFS_MIN <= wSide) return single
  if (SINGLE_W * QFS_MIN <= wBar) return barSingle
  return null
}

/**
 * §9.6: whether a side pane `paneW` px wide docks beside a canvas of `canvasW × canvasH` (measured before the pane).
 * It docks when the remaining width still holds a single page at the bar-dock height fit, plus the canvas padding and
 * 16 px of slack. Monotonic in `paneW` (the shell searches the widest pane that docks).
 */
export function paneCanDock(canvasW: number, canvasH: number, paneW: number): boolean {
  const h = size(canvasH)
  const qfsH = (h - 2 * PAD_Y - barReserve(h)) / PH
  return size(canvasW) - paneW >= SINGLE_W * qfsH + 2 * PAD_X + PANE_DOCK_SLACK
}

// ---------------------------------------------------------------------------------------------------------------------
// Page boxes

/** The book side of a page (§8.10): odd pages on the right, even pages on the left, in spreads and single mode. */
export function pageSide(page: number): PageSide {
  return page % 2 === 1 ? 'right' : 'left'
}

/** Whether a page is one of the two opening pages (8 centred lines inside the medallion, §8.4). */
export function isOpeningPage(page: number): boolean {
  return page >= 1 && page <= OPENING_LAST_PAGE
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Browser mock only (§4.6): the mock marks the pages it invents (outside the exported fixture list) with this
 * registered symbol, as a non-enumerable property, so `MushafPage` can show a "synthetic" badge. Real `PageData` from
 * IPC never carries it.
 */
export const SYNTHETIC_PAGE: unique symbol = Symbol.for('qd.syntheticPage')

/** Whether the browser mock invented this page (always false for data from the real app). */
export function isSyntheticPage(data: object): boolean {
  return (data as { [SYNTHETIC_PAGE]?: unknown })[SYNTHETIC_PAGE] === true
}

/** The page box in px. */
export function pageBox(qfs: number): Box {
  return { x: 0, y: 0, w: PW * qfs, h: PH * qfs }
}

/** The text block (`.mp-block`) in px, relative to the page box: the outer margin is on the page's own side. */
export function blockBox(qfs: number, side: PageSide): Box {
  const x = side === 'right' ? (PW - BLOCK_OUTER - TB_W) * qfs : BLOCK_OUTER * qfs
  return { x, y: BLOCK_TOP * qfs, w: TB_W * qfs, h: TB_H * qfs }
}

/** The box of line `n` (1-based) in px, relative to the text block; opening pages use their centred 8-line block. */
export function lineBox(qfs: number, line: number, opening = false): Box {
  const top = opening ? line - 1 + OPENING_TOP_LINES : line - 1
  const inset = opening ? OPENING_INSET * qfs : 0
  return { x: inset, y: top * LH * qfs, w: TB_W * qfs - 2 * inset, h: LH * qfs }
}

// ---------------------------------------------------------------------------------------------------------------------
// Line-fit (§8.4)

/** At or above this fit a line is squeezed horizontally only (invisible at ≤ 4 %); below it, scaled uniformly. */
export const FIT_UNIFORM_BELOW = 0.96
/** Lines that need more than 2 % are logged at debug level: the tuning signal for `--glyph-scale` (§8.2). */
export const FIT_LOG_BELOW = 0.98

export interface LineFit {
  /** `min(1, line box width / natural line width)`. */
  fit: number
  /** Horizontal scale (`--fx`). */
  fx: number
  /** Vertical scale (`--fy`): 1 for a horizontal-only squeeze, else equal to `fx`. */
  fy: number
}

/** The fit of one line: never stretches, squeezes horizontally down to 0.96, then scales uniformly (never squashes). */
export function lineFit(lineWidth: number, naturalWidth: number): LineFit {
  if (!(lineWidth > 0) || !(naturalWidth > 0) || naturalWidth <= lineWidth) return { fit: 1, fx: 1, fy: 1 }
  const fit = lineWidth / naturalWidth
  return { fit, fx: fit, fy: fit >= FIT_UNIFORM_BELOW ? 1 : fit }
}

export interface LineFitReport {
  /** Ayah lines measured. */
  lines: number
  /** Lines that needed any squeeze (fit < 1). */
  squeezed: number
  /** Lines scaled uniformly (fit < 0.96). */
  uniform: number
  /** The smallest fit, 1 when nothing was squeezed. */
  minFit: number
}

/** Four decimals are far below a device pixel on a 16.5 qfs line and keep the inline styles short. */
const fmt = (v: number) => (v === 1 ? '1' : v.toFixed(4))

/**
 * Runs the bounded line-fit over one rendition (`.mp-glyphs`): reads every `.ln` box width and its `.lw` natural width
 * first, then writes `--fx`/`--fy` on every line, so there is exactly one layout read and no interleaving (§8.4).
 * `offsetWidth` ignores transforms, so a second run (after a qfs change) measures the natural width again. A rendition
 * that is not laid out (`display: none`, detached) is left untouched. Call it once per rendition after its font is
 * ready, and again after a qfs change; the transforms never affect layout, so nothing shifts (CLS 0).
 */
export function fitLines(rendition: ParentNode): LineFitReport {
  const measured: { ln: HTMLElement; fit: LineFit }[] = []
  for (const ln of rendition.querySelectorAll<HTMLElement>('.ln')) {
    const lw = ln.querySelector<HTMLElement>(':scope > .lw')
    if (!lw) continue
    const lineWidth = ln.clientWidth
    const naturalWidth = lw.offsetWidth
    if (lineWidth <= 0 || naturalWidth <= 0) continue
    measured.push({ ln, fit: lineFit(lineWidth, naturalWidth) })
  }
  const report: LineFitReport = { lines: measured.length, squeezed: 0, uniform: 0, minFit: 1 }
  for (const { ln, fit } of measured) {
    ln.style.setProperty('--fx', fmt(fit.fx))
    ln.style.setProperty('--fy', fmt(fit.fy))
    if (fit.fit < 1) report.squeezed++
    if (fit.fy !== 1) report.uniform++
    report.minFit = Math.min(report.minFit, fit.fit)
    if (fit.fit < FIT_LOG_BELOW) {
      const page = ln.closest<HTMLElement>('[data-page]')?.dataset.page ?? '?'
      console.debug(`[mushaf] line-fit p${page} l${ln.dataset.l ?? '?'}: ${fit.fit.toFixed(3)}`)
    }
  }
  return report
}

// ---------------------------------------------------------------------------------------------------------------------
// Page context (MushafPage → the layers inside it)

/** What `MushafPage` tells the layers rendered inside it (the glyph layers reach it through `RenditionStack`). */
export interface PageContext {
  readonly page: number
  readonly qfs: number
  readonly side: PageSide
  /** Pointer interactions and roving a11y items (`MushafPageProps.interactive`). */
  readonly interactive: boolean
}

const PAGE_CONTEXT = Symbol('qd.mushaf.page')

/** Provides the page context (call during `MushafPage` initialisation with an object of reactive getters). */
export function setPageContext(context: PageContext): PageContext {
  return setContext(PAGE_CONTEXT, context)
}

/** The enclosing page's context, or `undefined` outside a `MushafPage` (call during component initialisation). */
export function getPageContext(): PageContext | undefined {
  return hasContext(PAGE_CONTEXT) ? getContext<PageContext>(PAGE_CONTEXT) : undefined
}

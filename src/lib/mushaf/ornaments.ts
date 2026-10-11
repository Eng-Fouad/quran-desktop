/**
 * Page furniture geometry and model (§8.8, §8.9). Owner: WP8c.
 *
 * Everything here is pure (no DOM, no stores), so the frame, the surah cartouche, the opening medallion and the margin
 * layout can be unit-tested and memoised. All artwork is original: an 8-point khatam (two squares at 45°), a four-petal
 * interlace band, a scalloped rosette, an ogee-ended cartouche and an ogee-arched medallion, drawn from a few parameters.
 *
 * Units: the page functions (`frameGeometry`, `medallionGeometry`, the margin layout) return CSS px for a given `qfs`;
 * the cartouche is drawn in its own viewBox where 100 units = 1 qfs (`viewBox="0 0 1650 155"` for a full line), so it
 * scales with whatever box it is given. Physical left/right is intentional (book geometry never mirrors, §8.1).
 */
import type { PageSide } from '$lib/contracts/components'
import type { PageAyah, PageData, SajdaKind } from '$lib/ipc/bindings'
import {
  BLOCK_TOP,
  FR,
  HEAD,
  LH,
  M_IN,
  M_OUT,
  M_TB,
  OPENING_INSET,
  OPENING_TOP_LINES,
  PAGE_COUNT,
  PH,
  PW,
  TB_H,
  TB_W,
  isOpeningPage,
} from './geometry'

/** An SVG path `d` attribute. */
export type PathData = string

/** An axis-aligned rectangle (px unless stated otherwise). */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A circle (px unless stated otherwise). */
export interface Circle {
  cx: number
  cy: number
  r: number
}

// ---------------------------------------------------------------------------------------------------------------------
// Path helpers

/** Rounds to 1/100 so path data stays short and stable (sub-pixel precision is plenty at any zoom). */
export function round2(n: number): number {
  const v = Math.round(n * 100) / 100
  return Object.is(v, -0) ? 0 : v
}

const pt = (x: number, y: number): string => `${round2(x)} ${round2(y)}`

/**
 * The 8-point khatam: two squares at 45° (§8.9 corners, §8.8 cartouche medallions), centred at (cx, cy), with every
 * vertex at distance `r`. Two closed subpaths, so a stroke shows the interlaced squares and a non-zero fill covers the
 * star once.
 */
export function khatam(cx: number, cy: number, r: number): PathData {
  const s = r / Math.SQRT2
  return (
    `M${pt(cx - s, cy - s)}H${round2(cx + s)}V${round2(cy + s)}H${round2(cx - s)}Z` +
    `M${pt(cx, cy - r)}L${pt(cx + r, cy)}L${pt(cx, cy + r)}L${pt(cx - r, cy)}Z`
  )
}

/**
 * A scalloped rosette outline (§8.9 footer medallion, the opening medallion's beads): `lobes` quadratic lobes whose
 * valleys lie on the circle of radius `r * depth` and whose crests reach exactly `r`. One closed subpath.
 */
export function rosette(cx: number, cy: number, r: number, lobes = 12, depth = 0.84): PathData {
  const n = Math.max(3, Math.round(lobes))
  const inner = r * Math.min(0.98, Math.max(0.3, depth))
  const half = Math.PI / n
  // A quadratic's midpoint is (P0 + 2C + P1) / 4: the control radius that puts the crest exactly on `r`.
  const control = 2 * r - inner * Math.cos(half)
  const at = (radius: number, angle: number) =>
    pt(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle))
  let d = ''
  for (let i = 0; i < n; i++) {
    const a0 = -Math.PI / 2 + (2 * Math.PI * i) / n
    if (i === 0) d += `M${at(inner, a0)}`
    d += `Q${at(control, a0 + half)} ${at(inner, a0 + 2 * half)}`
  }
  return `${d}Z`
}

/** A full circle as path data (two arcs), for paths that combine circles with other shapes. */
export function circlePath(cx: number, cy: number, r: number): PathData {
  return `M${pt(cx - r, cy)}A${round2(r)} ${round2(r)} 0 1 0 ${pt(cx + r, cy)}A${round2(r)} ${round2(r)} 0 1 0 ${pt(cx - r, cy)}Z`
}

// ---------------------------------------------------------------------------------------------------------------------
// The frame band tile (§8.9): a four-petal interlace

/** The band's tile in qfs (0.32 × 0.32 nominal; stretched by ≤ 2 % so whole tiles fill each band exactly). */
export const BAND_TILE = 0.32
/** The interlace stroke in qfs. */
export const BAND_STROKE = 0.018

/**
 * One interlace tile `w × h`: four half-ellipses, one on each edge, bulging inwards. They cross at the centre and
 * their overlaps form four petals on the diagonals; neighbouring tiles complete each other's ellipses, so a band of
 * tiles reads as a continuous interlace with a four-petal flower on every tile centre and every tile corner.
 */
export function bandTile(w: number, h: number): PathData {
  const rx = round2(w / 2)
  const ry = round2(h / 2)
  const W = round2(w)
  const H = round2(h)
  return (
    `M0 0A${rx} ${ry} 0 0 0 ${W} 0` +
    `M0 ${H}A${rx} ${ry} 0 0 1 ${W} ${H}` +
    `M0 0A${rx} ${ry} 0 0 1 0 ${H}` +
    `M${W} 0A${rx} ${ry} 0 0 0 ${W} ${H}`
  )
}

/** Splits `length` into whole tiles as close as possible to `nominal`: the count and the exact tile length. */
export function fitTiles(length: number, nominal: number): { count: number; size: number } {
  if (!(length > 0) || !(nominal > 0)) return { count: 0, size: nominal > 0 ? nominal : 0 }
  const count = Math.max(1, Math.round(length / nominal))
  return { count, size: length / count }
}

// ---------------------------------------------------------------------------------------------------------------------
// Page frame (§8.9)

/** Outer rule stroke (qfs). */
export const OUTER_RULE = 0.09
/** Inner rule stroke (qfs), never thinner than 1 px. */
export const INNER_RULE = 0.04
/** Corner block side (qfs): the whole frame band, FR. */
export const CORNER = FR
/** Khatam radius in a corner block (qfs). */
export const CORNER_STAR = 0.3
/** Khatam stroke (qfs). */
export const STAR_STROKE = 0.03

/** A band of the frame: where it lies and the tile that fills it. */
export interface Band extends Rect {
  tile: { w: number; h: number }
}

/** Everything `PageFrame` draws, in px for one `qfs` and page side. */
export interface FrameGeometry {
  /** The page box (the SVG's size). */
  width: number
  height: number
  /** The frame's outer box: the text block grown by FR on every side. */
  box: Rect
  /** The outer rule: a rectangle along the stroke's centre line. */
  outerRule: Rect
  outerStroke: number
  /** The inner rule, interrupted by the corner blocks: four segments. */
  innerRule: PathData
  innerStroke: number
  /** The four bands between the rules (top, bottom, right, left). */
  bands: { top: Band; bottom: Band; right: Band; left: Band }
  /** The inner edges of the four corner blocks. */
  corners: PathData
  /** The four corner khatams. */
  stars: PathData
  starStroke: number
  /** The tiles' interlace stroke. */
  tileStroke: number
  /** Pages 1–2: the arched medallion around the 8-line block. */
  medallion: MedallionGeometry | null
}

const frameCache = new Map<string, FrameGeometry>()
const FRAME_CACHE_SIZE = 16

/**
 * The page frame in px (§8.9): outer rule 0.09·qfs, the 0.32·qfs interlace band, the inner rule `max(1px, 0.04·qfs)`,
 * 0.85·qfs corner blocks with a khatam each, and on the opening pages the arched medallion. Memoised per
 * (qfs, side, opening): a page re-renders its frame only when `qfs` changes.
 */
export function frameGeometry(qfs: number, side: PageSide, opening = false): FrameGeometry {
  const key = `${qfs}|${side}|${opening ? 1 : 0}`
  const hit = frameCache.get(key)
  if (hit) {
    frameCache.delete(key)
    frameCache.set(key, hit)
    return hit
  }
  const geometry = computeFrame(Number.isFinite(qfs) && qfs > 0 ? qfs : 0, side, opening)
  frameCache.set(key, geometry)
  if (frameCache.size > FRAME_CACHE_SIZE) {
    const oldest = frameCache.keys().next().value
    if (oldest !== undefined) frameCache.delete(oldest)
  }
  return geometry
}

/** The frame's outer box in qfs units: the block grown by FR, against the outer margin of its side. */
export function frameBoxQ(side: PageSide): Rect {
  const x = side === 'right' ? M_IN : M_OUT
  return { x, y: M_TB + HEAD, w: TB_W + 2 * FR, h: TB_H + 2 * FR }
}

function computeFrame(q: number, side: PageSide, opening: boolean): FrameGeometry {
  const boxQ = frameBoxQ(side)
  const box: Rect = { x: boxQ.x * q, y: boxQ.y * q, w: boxQ.w * q, h: boxQ.h * q }
  const so = OUTER_RULE * q
  const si = Math.max(1, INNER_RULE * q)
  const bw = BAND_TILE * q
  const c = CORNER * q
  // Bands run between the corner blocks, between the outer rule's inner edge and the inner rule's outer edge.
  const hLen = box.w - 2 * c
  const vLen = box.h - 2 * c
  const hTile = fitTiles(hLen, bw)
  const vTile = fitTiles(vLen, bw)
  const top: Band = { x: box.x + c, y: box.y + so, w: hLen, h: bw, tile: { w: hTile.size, h: bw } }
  const bottom: Band = { ...top, y: box.y + box.h - so - bw }
  const right: Band = {
    x: box.x + box.w - so - bw,
    y: box.y + c,
    w: bw,
    h: vLen,
    tile: { w: bw, h: vTile.size },
  }
  const left: Band = { ...right, x: box.x + so }
  // The inner rule's centre line, inset from the outer edge by the outer rule, the band and half its own stroke.
  const ri = so + bw + si / 2
  const x0 = box.x
  const y0 = box.y
  const x1 = box.x + box.w
  const y1 = box.y + box.h
  const innerRule =
    `M${pt(x0 + c, y0 + ri)}H${round2(x1 - c)}` +
    `M${pt(x0 + c, y1 - ri)}H${round2(x1 - c)}` +
    `M${pt(x0 + ri, y0 + c)}V${round2(y1 - c)}` +
    `M${pt(x1 - ri, y0 + c)}V${round2(y1 - c)}`
  // Corner blocks: the outer rule closes their outer sides; their inner sides are drawn here, from the outer rule's
  // inner edge to the block's inner corner.
  const corners =
    `M${pt(x0 + c, y0 + so)}V${round2(y0 + c)}H${round2(x0 + so)}` +
    `M${pt(x1 - c, y0 + so)}V${round2(y0 + c)}H${round2(x1 - so)}` +
    `M${pt(x0 + c, y1 - so)}V${round2(y1 - c)}H${round2(x0 + so)}` +
    `M${pt(x1 - c, y1 - so)}V${round2(y1 - c)}H${round2(x1 - so)}`
  const half = c / 2
  const sr = CORNER_STAR * q
  const stars =
    khatam(x0 + half, y0 + half, sr) +
    khatam(x1 - half, y0 + half, sr) +
    khatam(x0 + half, y1 - half, sr) +
    khatam(x1 - half, y1 - half, sr)
  return {
    width: PW * q,
    height: PH * q,
    box,
    outerRule: { x: x0 + so / 2, y: y0 + so / 2, w: box.w - so, h: box.h - so },
    outerStroke: so,
    innerRule,
    innerStroke: si,
    bands: { top, bottom, right, left },
    corners,
    stars,
    starStroke: Math.max(0.75, STAR_STROKE * q),
    tileStroke: Math.max(0.5, BAND_STROKE * q),
    medallion: opening ? medallionGeometry(q, side) : null,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Cubic Bézier segments: the ogee curves are drawn once per quarter and mirrored

/** A point `[x, y]`. */
export type Point = readonly [number, number]
/** A cubic Bézier segment: start, two control points, end. */
export type Cubic = readonly [Point, Point, Point, Point]

/** The same curve traversed backwards. */
export function reverseCubic(c: Cubic): Cubic {
  return [c[3], c[2], c[1], c[0]]
}

/** Maps every point of a run of segments (mirroring, translation, scaling). */
export function mapCubics(cubics: readonly Cubic[], f: (p: Point) => Point): Cubic[] {
  return cubics.map((c) => [f(c[0]), f(c[1]), f(c[2]), f(c[3])] as const)
}

/** A run of segments traversed backwards (last segment first, each reversed). */
export function reverseCubics(cubics: readonly Cubic[]): Cubic[] {
  return [...cubics].reverse().map(reverseCubic)
}

/** `C` commands for a run of segments; the current point must already be the first segment's start. */
export function cubicsPath(cubics: readonly Cubic[]): PathData {
  return cubics
    .map((c) => `C${pt(c[1][0], c[1][1])} ${pt(c[2][0], c[2][1])} ${pt(c[3][0], c[3][1])}`)
    .join('')
}

// ---------------------------------------------------------------------------------------------------------------------
// The opening medallion (§8.9, pages 1–2)

/** Half-width of the medallion body in qfs, from the block's centre line (0.95 qfs outside the 8 lines). */
export const MEDALLION_HALF_W = TB_W / 2 - OPENING_INSET + 0.95
/** Where the arch springs from the straight sides, in qfs above/below the block's centre. */
export const MEDALLION_SPRING = 5.65
/** The apex of the ogee arch, in qfs from the block's centre. */
export const MEDALLION_APEX = 10.05
/** Outer outline stroke and the inner companion line (qfs), and the gap between them. */
export const MEDALLION_STROKE = 0.06
export const MEDALLION_INNER_STROKE = 0.02
export const MEDALLION_INNER_GAP = 0.14
/** The twelve rosettes: radius in qfs. */
export const MEDALLION_ROSETTE = 0.3

/** The arched medallion of the opening pages, in px. */
export interface MedallionGeometry {
  /** The medallion's outer outline (closed). */
  outline: PathData
  /** The inner companion line. */
  inner: PathData
  stroke: number
  innerStroke: number
  /** The illuminated spandrels: the inside of the frame minus the medallion (fill-rule evenodd). */
  spandrels: PathData
  /** The 12 rosettes on the outline. */
  rosettes: Circle[]
  rosettePaths: PathData
  rosetteStars: PathData
}

/**
 * The upper-left quarter of the medallion's arch in qfs units relative to the block's centre, from the springing point
 * on the left side up to the apex: a convex shoulder, then the reverse curve that makes it an ogee, arriving almost
 * vertically in a pointed apex.
 */
export function archQuarter(halfW: number, spring: number, apex: number): Cubic[] {
  const w = halfW
  const rise = apex - spring
  const shoulder: Point = [-w + 0.5 * w, -spring - 0.62 * rise]
  return [
    [[-w, -spring], [-w, -spring - 0.42 * rise], [-w + 0.12 * w, shoulder[1]], shoulder],
    [shoulder, [-w + 0.84 * w, shoulder[1]], [-0.04 * w, -apex + 0.3 * rise], [0, -apex]],
  ]
}

/**
 * The medallion's outline at `inset` qfs inside the outer line, mapped to px by `f` (from qfs relative to the block's
 * centre): straight sides, the ogee arch on top and its mirror below.
 */
export function medallionOutline(inset: number, f: (p: Point) => Point): PathData {
  const w = MEDALLION_HALF_W - inset
  const quarter = archQuarter(w, MEDALLION_SPRING, MEDALLION_APEX - inset * 1.35)
  const flipX = (p: Point): Point => [-p[0], p[1]]
  const flipY = (p: Point): Point => [p[0], -p[1]]
  const upperRight = reverseCubics(mapCubics(quarter, flipX))
  const lowerRight = mapCubics(quarter, (p) => flipY(flipX(p)))
  const lowerLeft = reverseCubics(mapCubics(quarter, flipY))
  const start = f([-w, -MEDALLION_SPRING])
  const rightBottom = f([w, MEDALLION_SPRING])
  return (
    `M${pt(start[0], start[1])}` +
    cubicsPath(mapCubics(quarter, f)) +
    cubicsPath(mapCubics(upperRight, f)) +
    `L${pt(rightBottom[0], rightBottom[1])}` +
    cubicsPath(mapCubics(lowerRight, f)) +
    cubicsPath(mapCubics(lowerLeft, f)) +
    'Z'
  )
}

/** The opening medallion in page px for one `qfs` and page side (§8.9). */
export function medallionGeometry(qfs: number, side: PageSide): MedallionGeometry {
  const q = qfs
  const bx = side === 'right' ? (PW - M_OUT - FR - TB_W) * q : (M_OUT + FR) * q
  const by = BLOCK_TOP * q
  const cx = bx + (TB_W / 2) * q
  const cy = by + (TB_H / 2) * q
  const f = (p: Point): Point => [cx + p[0] * q, cy + p[1] * q]
  const outline = medallionOutline(0, f)
  const inner = medallionOutline(MEDALLION_INNER_GAP, f)
  // The spandrels: the inside of the frame's inner rule (the block grown by the 0.40 gap) minus the medallion.
  const gap = (FR - OUTER_RULE - BAND_TILE - INNER_RULE) * q
  const x0 = bx - gap
  const y0 = by - gap
  const x1 = bx + TB_W * q + gap
  const y1 = by + TB_H * q + gap
  const inside = `M${pt(x0, y0)}H${round2(x1)}V${round2(y1)}H${round2(x0)}Z`
  const w = MEDALLION_HALF_W
  const rr = MEDALLION_ROSETTE * q
  const side5 = (x: number): Circle[] =>
    [0, 1, 2, 3, 4].map((i) => {
      const [px, py] = f([x, -MEDALLION_SPRING + (i * 2 * MEDALLION_SPRING) / 4])
      return { cx: px, cy: py, r: rr }
    })
  const [topX, topY] = f([0, -MEDALLION_APEX])
  const [botX, botY] = f([0, MEDALLION_APEX])
  // Clockwise from the apex: the apex, the right side top to bottom, the foot, the left side bottom to top.
  const rosettes: Circle[] = [
    { cx: topX, cy: topY, r: rr },
    ...side5(w),
    { cx: botX, cy: botY, r: rr },
    ...side5(-w).reverse(),
  ]
  return {
    outline,
    inner,
    stroke: Math.max(1, MEDALLION_STROKE * q),
    innerStroke: Math.max(0.75, MEDALLION_INNER_STROKE * q),
    spandrels: `${inside}${outline}`,
    rosettes,
    rosettePaths: rosettes.map((c) => rosette(c.cx, c.cy, c.r, 8, 0.72)).join(''),
    rosetteStars: rosettes.map((c) => khatam(c.cx, c.cy, c.r * 0.55)).join(''),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The surah cartouche (§8.8 fallback): 100 units = 1 qfs

/** Cartouche height in qfs (1.55): the viewBox is `W × 155`. */
export const CARTOUCHE_H = 1.55
/** End medallion diameter (qfs). */
export const CARTOUCHE_MEDALLION = 1.1
/** The three nested strokes (qfs): outer, middle, inner. */
export const CARTOUCHE_STROKES = [0.06, 0.02, 0.02] as const
/** The insets of the three outlines from the box edge (qfs, to the stroke centre). */
export const CARTOUCHE_INSETS = [0.05, 0.15, 0.22] as const
/** How far each ogee end reaches in from its tip (qfs). */
export const CARTOUCHE_END = 0.7
/** The surah name's font size (qfs). */
export const CARTOUCHE_TEXT = 0.85

/** Everything `SurahCartouche` draws, in viewBox units (100 = 1 qfs). */
export interface CartoucheGeometry {
  width: number
  height: number
  viewBox: string
  /** The outer outline (filled with `--cartouche-fill`). */
  body: PathData
  /** The three nested outlines, outermost first, with their stroke widths. */
  outlines: { d: PathData; stroke: number }[]
  /** The two end medallions, the khatam each carries, and their strokes. */
  medallions: Circle[]
  medallionStroke: number
  stars: PathData
  starStroke: number
  /** The name's box between the medallions (x and width in viewBox units). */
  text: { x: number; w: number }
}

const cartoucheCache = new Map<number, CartoucheGeometry>()

/**
 * The surah cartouche for a line `widthQ` qfs wide (16.5 on ordinary pages, 12.1 on the opening pages): an
 * ogee-ended body with three nested strokes, an end medallion of 1.1 qfs with a khatam at each end, and the box the
 * name is centred in.
 */
export function cartouche(widthQ: number): CartoucheGeometry {
  const key = round2(Number.isFinite(widthQ) ? Math.max(4, widthQ) : TB_W)
  const hit = cartoucheCache.get(key)
  if (hit) return hit
  const W = key * 100
  const H = CARTOUCHE_H * 100
  const outlines = CARTOUCHE_INSETS.map((inset, i) => ({
    d: ogeeBand(W, H, inset * 100),
    stroke: (CARTOUCHE_STROKES[i] ?? 0.02) * 100,
  }))
  const r = (CARTOUCHE_MEDALLION * 100) / 2
  // The medallions sit just inside the ogee ends, on the body's centre line.
  const mx = CARTOUCHE_END * 100 + r * 0.55
  const medallions: Circle[] = [
    { cx: mx, cy: H / 2, r },
    { cx: W - mx, cy: H / 2, r },
  ]
  const stars = medallions.map((m) => khatam(m.cx, m.cy, m.r * 0.64)).join('')
  const textX = mx + r + 14
  const geometry: CartoucheGeometry = {
    width: W,
    height: H,
    viewBox: `0 0 ${round2(W)} ${round2(H)}`,
    body: outlines[0]?.d ?? '',
    outlines,
    medallions,
    medallionStroke: 2.5,
    stars,
    starStroke: 2.2,
    text: { x: textX, w: Math.max(0, W - 2 * textX) },
  }
  cartoucheCache.set(key, geometry)
  return geometry
}

/**
 * The upper-left quarter of an ogee end in a band `h` tall, inset by `inset`: from the pointed tip on the centre line
 * up to the shoulder where the straight top edge begins. A short convex lobe leaves the tip, then the reverse curve
 * sweeps into the top edge, arriving tangentially.
 */
export function ogeeEndQuarter(h: number, inset: number, endLength: number): Cubic[] {
  const mid = h / 2
  const top = inset
  const half = mid - top
  const tip = inset * 1.2
  const span = endLength - tip + inset * 0.4
  const at = (fx: number, fy: number): Point => [tip + fx * span, mid - fy * half]
  const inflection = at(0.42, 0.62)
  return [
    [[tip, mid], at(0.08, 0.34), at(0.22, 0.66), inflection],
    [inflection, at(0.6, 0.58), at(0.62, 1), at(1, 1)],
  ]
}

/**
 * An ogee-ended band `w × h` inset by `inset` (viewBox units): straight top and bottom edges, and at each end the
 * reverse curves of `ogeeEndQuarter` meeting in a pointed tip on the centre line.
 */
export function ogeeBand(w: number, h: number, inset: number): PathData {
  const quarter = ogeeEndQuarter(h, inset, CARTOUCHE_END * 100)
  const flipX = (p: Point): Point => [w - p[0], p[1]]
  const flipY = (p: Point): Point => [p[0], h - p[1]]
  const upperRight = reverseCubics(mapCubics(quarter, flipX))
  const lowerRight = mapCubics(quarter, (p) => flipY(flipX(p)))
  const lowerLeft = reverseCubics(mapCubics(quarter, flipY))
  const tip = quarter[0]?.[0] ?? [0, h / 2]
  const shoulder = quarter.at(-1)?.[3] ?? [0, inset]
  return (
    `M${pt(tip[0], tip[1])}` +
    cubicsPath(quarter) +
    `H${round2(w - shoulder[0])}` +
    cubicsPath(upperRight) +
    cubicsPath(lowerRight) +
    `H${round2(shoulder[0])}` +
    cubicsPath(lowerLeft) +
    'Z'
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Footer medallion (§8.9)

/** The footer medallion's diameter (qfs). */
export const FOOTER_MEDALLION = 1.1

/** The footer medallion's ring and disc strokes (qfs). */
export const FOOTER_STROKE = 0.03

/**
 * The footer medallion in its own `size × size` box (px): a 12-lobed rosette ring around a disc, both inside the box
 * with their strokes. `PageFooter` centres the box on the text block in the FOOT band.
 */
export function footerMedallion(qfs: number): { size: number; ring: PathData; disc: Circle; stroke: number } {
  const size = FOOTER_MEDALLION * qfs
  const stroke = Math.max(0.75, FOOTER_STROKE * qfs)
  const c = size / 2
  const r = Math.max(0, c - stroke / 2)
  return { size, ring: rosette(c, c, r, 12, 0.88), disc: { cx: c, cy: c, r: r * 0.8 }, stroke }
}

// ---------------------------------------------------------------------------------------------------------------------
// Margin markers and marks (§8.9)

/** Arabic-Indic digits, never grouped (§0.2: Mushaf furniture always uses them). */
const ARABIC_DIGITS = new Intl.NumberFormat('ar-u-nu-arab', { useGrouping: false })

/** `n` in Arabic-Indic digits. */
export function arabicNum(n: number): string {
  return ARABIC_DIGITS.format(n)
}

/** §3.1.2 `ayah.flags` bits. */
export const FLAG_RUB_START = 1
export const FLAG_HIZB_START = 2
export const FLAG_JUZ_START = 4
export const FLAG_SURAH_START = 8

/** The quarter of a hizb a rub opens: 0 (the hizb itself), 1 ¼, 2 ½, 3 ¾. */
export function rubQuarter(rub: number): 0 | 1 | 2 | 3 {
  const q = (((rub - 1) % 4) + 4) % 4
  return q as 0 | 1 | 2 | 3
}

const QUARTER_GLYPH = ['', '¼', '½', '¾'] as const

/** The kind of division a rub-start ayah opens (§3.1.2): a juz, a hizb, or a quarter of a hizb. */
export type RubKind = 'juz' | 'hizb' | 'quarter'

/** What a rub-start ayah opens, by its flags. */
export function rubKind(a: Pick<PageAyah, 'flags' | 'rub'>): RubKind {
  if (a.flags & FLAG_JUZ_START) return 'juz'
  if (a.flags & FLAG_HIZB_START || rubQuarter(a.rub) === 0) return 'hizb'
  return 'quarter'
}

/** The Arabic margin label of a rub start (§3.1.2): `الجزء ١٤`, `الحزب ٢٧`, or `¾ الحزب ٢٧`. */
export function rubLabel(a: Pick<PageAyah, 'flags' | 'rub' | 'juz' | 'hizb'>): string {
  const kind = rubKind(a)
  if (kind === 'juz') return `الجزء ${arabicNum(a.juz)}`
  if (kind === 'hizb') return `الحزب ${arabicNum(a.hizb)}`
  return `${QUARTER_GLYPH[rubQuarter(a.rub)]} الحزب ${arabicNum(a.hizb)}`
}

/** The short hizb label of a rub start for the running head (§8.9): `الحزب ٢٧` or `¾ الحزب ٢٧`. */
export function rubShortLabel(a: Pick<PageAyah, 'rub' | 'hizb'>): string {
  const quarter = rubQuarter(a.rub)
  return quarter === 0 ? `الحزب ${arabicNum(a.hizb)}` : `${QUARTER_GLYPH[quarter]} الحزب ${arabicNum(a.hizb)}`
}

/** The Arabic sajda label: `سجدة`, plus ` واجبة` for an obligatory one (§8.9). */
export function sajdaLabel(kind: SajdaKind): string {
  return kind === 'obligatory' ? 'سجدة واجبة' : 'سجدة'
}

/** ۞ U+06DE ARABIC START OF RUB EL HIZB. */
export const RUB_SIGN = String.fromCodePoint(0x06de)
/** ۩ U+06E9 ARABIC PLACE OF SAJDAH. */
export const SAJDA_SIGN = String.fromCodePoint(0x06e9)
/** quran-common (decor) margin ornaments: `marker-full` for a hizb start, `marker-half` for the other quarters. */
export const DECOR_HIZB = String.fromCodePoint(0xfc23)
export const DECOR_QUARTER = String.fromCodePoint(0xfc22)
/** quran-common basmala calligraphy (§8.8). */
export const DECOR_BASMALA = String.fromCodePoint(0xfdfd)
/**
 * quran-common's juz calligraphy for the running head: `juz001`…`juz030` = U+E001 + (juz − 1), which reads
 * "الجزء الأول" … "الجزء الثلاثون" (the word form of the fallback "الجزء ١٤", as the printed head reads). The other
 * series, `j001`…`j030` = U+E900…, names each juz by its opening words ("رُبَمَا"), which the Madani print does not use.
 */
export function decorJuzGlyph(juz: number): string {
  const n = Math.min(30, Math.max(1, Math.round(juz)))
  return String.fromCodePoint(0xe001 + n - 1)
}
/** The Unicode basmala of the fallback line (§8.8). */
export const BASMALA_TEXT = 'بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ'

/**
 * A furniture glyph's ink box in em, measured in the bundled and decor faces (canvas `measureText`, 2026-10-10):
 * `top`/`bottom` are the ink's extent above/below the baseline, `ascent`/`descent` the face's line metrics. The
 * furniture sizes each glyph by its ink, not its em, and centres the ink in its box.
 */
export interface GlyphInk {
  char: string
  /** CSS font family. */
  family: string
  top: number
  bottom: number
  ascent: number
  descent: number
  /**
   * The empty frame of a quran-common ornament (in print it frames the division's text): its centre `cy` above the
   * baseline and its inner width `w`, in em, measured at 1000 px (canvas, 2026-10-10) a little off the centre line,
   * where the frame's top and bottom edges are straight (both frames have a small notch on the centre line).
   */
  hollow?: { cy: number; w: number }
  /** The drawn ink height in qfs, when not `MARKER_INK` (the ornaments). */
  size?: number
}

/** qd-hafs (KFGQPC Hafs V30): ascent 1.17, descent 0.59 em. */
const HAFS_METRICS = { family: 'qd-hafs', ascent: 1.17, descent: 0.59 } as const
/** quran-common: ascent 0.8, descent 0.2 em. */
const COMMON_METRICS = { family: 'qd-quran-common', ascent: 0.8, descent: 0.2 } as const

export const INK = {
  rub: { char: RUB_SIGN, top: 0.4, bottom: 0.05, ...HAFS_METRICS },
  sajda: { char: SAJDA_SIGN, top: 0.63, bottom: 0, ...HAFS_METRICS },
  /**
   * A slender upright: crest, a rounded frame 0.207 × 0.235 em centred on the ink, crest. Drawn a line tall
   * (`DECOR_HIZB_INK`), so its narrow frame holds a two-digit hizb number at about 0.3·qfs.
   */
  decorHizb: {
    char: DECOR_HIZB,
    top: 0.82,
    bottom: 0.19,
    ...COMMON_METRICS,
    hollow: { cy: 0.313, w: 0.207 },
    size: 1.75,
  },
  /** A crest over an arched frame 0.387 × 0.266 em at the foot. */
  decorQuarter: {
    char: DECOR_QUARTER,
    top: 0.82,
    bottom: 0.19,
    ...COMMON_METRICS,
    hollow: { cy: -0.018, w: 0.387 },
    size: 1.45,
  },
} as const satisfies Record<string, GlyphInk>

/** Ink height of a glyph in em. */
export function inkHeight(g: GlyphInk): number {
  return g.top + g.bottom
}

/**
 * The vertical shift (em) that centres a glyph's ink in a box whose `line-height` equals its height: the line box puts
 * the baseline at half the leading below the face's ascent, so the ink centre lands `(ascent − descent)/2 − (top −
 * bottom)/2` em below the box centre.
 */
export function inkShift(g: GlyphInk): number {
  return (g.top - g.bottom) / 2 - (g.ascent - g.descent) / 2
}

/** One margin marker of a page (§8.9). */
export interface MarginMarker {
  /** Stable key: `rub-<ayahId>` or `sajda-<ayahId>`. */
  key: string
  kind: 'rub' | 'sajda'
  ayahId: number
  surah: number
  ayah: number
  /** The line of the ayah's first word on this page. */
  line: number
  /** The Arabic label (always Arabic-Indic digits). */
  label: string
  /** Rub starts: what it opens and its numbers. */
  rub: { kind: RubKind; quarter: 0 | 1 | 2 | 3; hizb: number; juz: number } | null
  /** Sajdas: recommended or obligatory. */
  sajda: SajdaKind | null
  /**
   * A rub start whose ayah's first word carries the ۞ inline (LEAD 17: kept verbatim, as the printed Mushaf does): the
   * margin shows the label alone, never a second ۞ beside it.
   */
  inline: boolean
}

/**
 * The margin markers of a page (§8.9), in line order: a rub start (`flags & 1`, the mushaf-source rub, D6) where its
 * ayah starts on the page, and a sajda where its ayah ends on the page (the ۩ follows the sajda word, so it belongs
 * to the line where the ayah's text actually finishes; that is the first line when the ayah has one). The opening
 * pages carry none: their 8 lines sit inside the illuminated medallion, with no margin furniture, as in print. A rub
 * start whose first word begins with ۞ (about 198 of the 240) is `inline`.
 */
export function pageMarkers(data: Pick<PageData, 'page' | 'ayahs' | 'lines'>): MarginMarker[] {
  if (isOpeningPage(data.page)) return []
  const out: MarginMarker[] = []
  for (const a of data.ayahs) {
    if (a.flags & FLAG_RUB_START && a.startsOnPage) {
      out.push({
        key: `rub-${a.id}`,
        kind: 'rub',
        ayahId: a.id,
        surah: a.surah,
        ayah: a.ayah,
        line: a.line,
        label: rubLabel(a),
        rub: { kind: rubKind(a), quarter: rubQuarter(a.rub), hizb: a.hizb, juz: a.juz },
        sajda: null,
        inline: startsWithRubSign(data.lines, a),
      })
    }
    if (a.sajda && a.endsOnPage) {
      out.push({
        key: `sajda-${a.id}`,
        kind: 'sajda',
        ayahId: a.id,
        surah: a.surah,
        ayah: a.ayah,
        line: lastLineOf(data.lines, a.lastWordId, a.line),
        label: sajdaLabel(a.sajda),
        rub: null,
        sajda: a.sajda,
        inline: false,
      })
    }
  }
  return out.sort((x, y) => x.line - y.line || x.ayahId - y.ayahId || (x.kind === 'rub' ? -1 : 1))
}

/**
 * Whether the ayah's first word (on this page, `firstWordId`, which is its first word at all when it starts here)
 * begins with ۞: the QPC Hafs text of the ≈198 quarter starts that print the sign inline (`"۞ تِلۡكَ"`, 2:253).
 */
function startsWithRubSign(lines: PageData['lines'], a: Pick<PageAyah, 'id' | 'firstWordId'>): boolean {
  for (const line of lines) {
    const word = line.words.find((w) => w.id === a.firstWordId)
    if (word) return word.ayahId === a.id && word.position === 1 && word.text.trimStart().startsWith(RUB_SIGN)
  }
  return false
}

/** The line holding a word, else `fallback`. */
function lastLineOf(lines: PageData['lines'], wordId: number, fallback: number): number {
  for (const line of lines) {
    const first = line.words[0]
    const last = line.words.at(-1)
    if (first && last && wordId >= first.id && wordId <= last.id) return line.line
  }
  return fallback
}

/** The first rub start of a page (the running head appends its quarter when labels are glyph-only, §8.9). */
export function firstRubStart(data: Pick<PageData, 'page' | 'ayahs'>): PageAyah | null {
  if (isOpeningPage(data.page)) return null
  return data.ayahs.find((a) => (a.flags & FLAG_RUB_START) !== 0 && a.startsOnPage) ?? null
}

/** Marker label size (qfs) and the legibility rule: labels only when `0.36·qfs ≥ 10 px` (qfs ≥ 27.8, §8.9). */
export const MARKER_LABEL = 0.36
export const MARKER_LABEL_MIN_PX = 11
export const MARKER_LABEL_SHOW_PX = 10
/**
 * The drawn (ink) height of ۞ and ۩ in qfs, with a px floor. §8.9 gives the glyph `max(0.95·qfs, 14px)` as a font
 * size, but the KFGQPC Hafs ۞ has an ink only 0.45 em tall (a 0.43·qfs mark); sizing by ink keeps the printed
 * proportion of about half a line.
 */
export const MARKER_INK = 0.75
export const MARKER_INK_MIN_PX = 13
/**
 * The quran-common ornaments are tall, slender frames: their ink is drawn taller, 1.45·qfs (U+FC22), and a line tall
 * for the narrower U+FC23 (`INK.*.size`).
 */
export const DECOR_MARKER_INK = INK.decorQuarter.size
export const DECOR_HIZB_INK = INK.decorHizb.size
/** The gap between stacked margin items (qfs). */
export const STACK_GAP = 0.2
/** Label line height (em) and the gap between a glyph and its label (qfs). */
export const LABEL_LEADING = 1.3
export const LABEL_GAP = 0.08
/** Margin marks (qfs): the ayah bookmark and the note glyph. */
export const MARK_BOOKMARK = 0.55
export const MARK_NOTE = 0.5

/** Whether margin labels are drawn at this size (§8.9: `0.36·qfs ≥ 10`). */
export function marginLabelsVisible(qfs: number): boolean {
  return MARKER_LABEL * qfs >= MARKER_LABEL_SHOW_PX - 1e-9
}

/** The label font size in px (§8.9: `max(0.36·qfs, 11px)`). */
export function labelSize(qfs: number): number {
  return Math.max(MARKER_LABEL * qfs, MARKER_LABEL_MIN_PX)
}

/**
 * The glyph a marker draws: ۞ or the decor ornament for a rub start, ۩ for a sajda. The quran-common ornaments are
 * drawn only with their labels (`labels`): their hairline frames need the size, and the frame carries the division's
 * number (`markerInset`), which is legible only from there on; smaller pages draw the solid ۞, which reads at any size.
 */
export function markerInk(m: Pick<MarginMarker, 'kind' | 'rub'>, decor: boolean, labels = true): GlyphInk {
  if (m.kind === 'sajda') return INK.sajda
  if (!decor || !labels) return INK.rub
  return m.rub?.kind === 'quarter' ? INK.decorQuarter : INK.decorHizb
}

/** Whether a glyph is a quran-common ornament (thickened hairlines, a filled frame). */
export function isDecorInk(ink: GlyphInk): boolean {
  return ink.family === COMMON_METRICS.family
}

/** A marker glyph's box in px: its drawn height, the font size that gives it, and the centring shift in em. */
export function markerGlyphBox(
  qfs: number,
  ink: GlyphInk,
): { height: number; fontSize: number; shift: number } {
  const height = Math.max((ink.size ?? MARKER_INK) * qfs, MARKER_INK_MIN_PX)
  return { height, fontSize: height / inkHeight(ink), shift: inkShift(ink) }
}

/** The height in px of one marker: its glyph box, plus its label when labels are visible. */
export function markerHeight(qfs: number, ink: GlyphInk, labels: boolean): number {
  const glyph = markerGlyphBox(qfs, ink).height
  return glyph + (labels ? LABEL_GAP * qfs + labelSize(qfs) * LABEL_LEADING : 0)
}

/**
 * Whether a marker is drawn at this size: an `inline` rub start shows its label alone, so only while labels are
 * visible; below that the ۞ in the text marks the place and the running head names the quarter (§8.9).
 */
export function markerDrawn(m: Pick<MarginMarker, 'inline'>, labels: boolean): boolean {
  return !m.inline || labels
}

/** The height in px of a drawn marker: the label line of an `inline` rub start, else glyph plus label. */
export function markerBoxHeight(
  m: Pick<MarginMarker, 'kind' | 'rub' | 'inline'>,
  qfs: number,
  labels: boolean,
  decor = false,
): number {
  if (m.inline) return labelSize(qfs) * LABEL_LEADING
  return markerHeight(qfs, markerInk(m, decor, labels), labels)
}

/**
 * The hairline thickening of a quran-common ornament (px, for its font size): `-webkit-text-stroke` of
 * `max(0.5px, 0.018em)` under the fill. At 1.45·qfs the ornament's strokes are only ≈0.01 em, which antialias to
 * 2.4–2.9:1; thickened they reach the 3:1 non-text minimum in every theme (§9.2).
 */
export const DECOR_STROKE_EM = 0.018
export const DECOR_STROKE_MIN_PX = 0.5

export function decorStroke(fontSize: number): number {
  return Math.max(DECOR_STROKE_MIN_PX, DECOR_STROKE_EM * fontSize)
}

/** The text in an ornament's frame (qfs): `0.34·qfs`, smaller when the frame is narrower than the text. */
export const INSET_TEXT = 0.34
/** The share of the frame's inner width (less the thickening) the text may take. */
export const INSET_FILL = 0.8

/**
 * What an ornament's frame holds (in print it frames the division's text): the hizb number in U+FC23 (a hizb or juz
 * start: the hizb it opens), the quarter (¼ ½ ¾) in U+FC22. `null` for ۞, ۩ and a label-only marker. The full label
 * stays under the ornament and in the tooltip.
 */
export function markerInset(m: Pick<MarginMarker, 'rub'>, ink: GlyphInk): string | null {
  if (!ink.hollow || !m.rub) return null
  return ink.char === DECOR_QUARTER ? QUARTER_GLYPH[m.rub.quarter] || null : arabicNum(m.rub.hizb)
}

/**
 * The frame text in qd-hafs (measured with canvas `measureText`, 2026-10-10): the advance of each Arabic-Indic digit
 * ٠…٩ (no kerning between them), and the vulgar fractions' advance; the ink above the baseline of the digits (0.52 em)
 * and of the fractions (0.68 em, 0.01 below); the baseline 0.79 em below the top of a `line-height: 1` box
 * (ascent 1.17, descent 0.59).
 */
const INSET_DIGIT_EM = [0.256, 0.287, 0.341, 0.466, 0.385, 0.351, 0.424, 0.453, 0.479, 0.4] as const
const INSET_FRACTION_EM = 0.75
const INSET_DIGIT_INK = { top: 0.52, bottom: 0 } as const
const INSET_FRACTION_INK = { top: 0.68, bottom: 0.01 } as const
const INSET_BASELINE_EM = 0.79

/** The advance of a frame text in qd-hafs (em). */
function insetWidthEm(text: string): number {
  let em = 0
  for (const ch of text) {
    const digit = (ch.codePointAt(0) ?? 0) - 0x0660
    em += digit >= 0 && digit <= 9 ? (INSET_DIGIT_EM[digit] ?? 0.48) : INSET_FRACTION_EM
  }
  return em
}

/**
 * Where an ornament's frame text goes and how large it is, in px from the glyph box's top (the ornament's ink fills
 * the box, its top at the box's top): `top` of the text's `line-height: 1` box, placed so that the text's ink is
 * centred on the frame, and `fontSize`, `0.34·qfs` or less so the text fits the frame's inner width.
 */
export function insetBox(qfs: number, ink: GlyphInk, text: string): { top: number; fontSize: number } | null {
  if (!ink.hollow) return null
  const { fontSize: glyph } = markerGlyphBox(qfs, ink)
  const room = Math.max(0, ink.hollow.w * glyph - decorStroke(glyph)) * INSET_FILL
  const textEm = insetWidthEm(text)
  const fontSize = Math.min(INSET_TEXT * qfs, textEm > 0 ? room / textEm : INSET_TEXT * qfs)
  const textInk = /[¼½¾]/u.test(text) ? INSET_FRACTION_INK : INSET_DIGIT_INK
  const inkMid = INSET_BASELINE_EM - (textInk.top - textInk.bottom) / 2
  const cy = (ink.top - ink.hollow.cy) * glyph
  return { top: cy - inkMid * fontSize, fontSize }
}

/** The vertical centre of a line, in px from the page top (§8.9: block top + (line − 1)·LH + LH/2). */
export function lineCenterY(qfs: number, line: number, opening = false): number {
  const offset = opening ? OPENING_TOP_LINES : 0
  return (BLOCK_TOP + (offset + line - 0.5) * LH) * qfs
}

/** Tops of a stack of items centred on `center`, `gap` apart. */
export function stackCentered(center: number, heights: readonly number[], gap: number): number[] {
  const total = heights.reduce((sum, h) => sum + h, 0) + gap * Math.max(0, heights.length - 1)
  return stackFrom(center - total / 2, heights, gap)
}

/** Tops of a stack of items starting at `start`, `gap` apart. */
export function stackFrom(start: number, heights: readonly number[], gap: number): number[] {
  const tops: number[] = []
  let y = start
  for (const h of heights) {
    tops.push(y)
    y += h + gap
  }
  return tops
}

/** A margin item placed in px from the page top. */
export interface Placed<T> {
  item: T
  top: number
  height: number
}

/**
 * Places the markers of a page (§8.9): those on the same line stack with 0.2·qfs between them, the stack centred on
 * the line. Returns the placed markers and, per line, the bottom edge of its stack (where the marks continue). An
 * `inline` rub start is a label line, and is left out while labels are hidden (`markerDrawn`).
 */
export function placeMarkers(
  markers: readonly MarginMarker[],
  qfs: number,
  labels: boolean,
  decor = false,
  opening = false,
): { placed: Placed<MarginMarker>[]; bottoms: Map<number, number> } {
  const placed: Placed<MarginMarker>[] = []
  const bottoms = new Map<number, number>()
  for (const [line, items] of groupByLine(markers.filter((m) => markerDrawn(m, labels)))) {
    const heights = items.map((m) => markerBoxHeight(m, qfs, labels, decor))
    const tops = stackCentered(lineCenterY(qfs, line, opening), heights, STACK_GAP * qfs)
    items.forEach((item, i) => placed.push({ item, top: tops[i] ?? 0, height: heights[i] ?? 0 }))
    const last = tops.length - 1
    if (last >= 0) bottoms.set(line, (tops[last] ?? 0) + (heights[last] ?? 0))
  }
  return { placed, bottoms }
}

/** One margin mark beside an ayah (§8.9). */
export interface MarginMark {
  key: string
  kind: 'bookmark' | 'note'
  ayahId: number
  line: number
  /** Bookmark id or note id. */
  id: string
}

/** Height in px of a mark's glyph box. */
export function markHeight(kind: MarginMark['kind'], qfs: number): number {
  return (kind === 'bookmark' ? MARK_BOOKMARK : MARK_NOTE) * qfs
}

/**
 * Places the marks (§8.9): stacked after the markers on the ayah's first line with a 0.2·qfs gap, or, on a line with
 * no marker, as a stack centred on the line.
 */
export function placeMarks(
  marks: readonly MarginMark[],
  qfs: number,
  markerBottoms: ReadonlyMap<number, number>,
  opening = false,
): Placed<MarginMark>[] {
  const placed: Placed<MarginMark>[] = []
  const gap = STACK_GAP * qfs
  for (const [line, items] of groupByLine(marks)) {
    const heights = items.map((m) => markHeight(m.kind, qfs))
    const after = markerBottoms.get(line)
    const tops =
      after === undefined
        ? stackCentered(lineCenterY(qfs, line, opening), heights, gap)
        : stackFrom(after + gap, heights, gap)
    items.forEach((item, i) => placed.push({ item, top: tops[i] ?? 0, height: heights[i] ?? 0 }))
  }
  return placed
}

function groupByLine<T extends { line: number }>(items: readonly T[]): Map<number, T[]> {
  const out = new Map<number, T[]>()
  for (const item of items) {
    const list = out.get(item.line)
    if (list) list.push(item)
    else out.set(item.line, [item])
  }
  return new Map([...out].sort((a, b) => a[0] - b[0]))
}

/** The line of an ayah's first word on a page, or null when the ayah has no word there. */
export function ayahLine(data: Pick<PageData, 'ayahs'>, ayahId: number): number | null {
  return data.ayahs.find((a) => a.id === ayahId)?.line ?? null
}

/**
 * The marks of a page from `UserMarks` (§8.9): one bookmark per bookmarked ayah and one note glyph per note, on the
 * first line of the ayah the note starts with on this page (a note covering a range that began on an earlier page is
 * marked on the page's first ayah of the range).
 */
export function pageMarks(
  data: Pick<PageData, 'ayahs'>,
  bookmarks: readonly { ayahId: number; bookmarkId: string }[],
  notes: readonly { id: string; fromAyahId: number; toAyahId: number }[],
): MarginMark[] {
  const out: MarginMark[] = []
  const seenBookmark = new Set<number>()
  for (const b of bookmarks) {
    const line = ayahLine(data, b.ayahId)
    if (line === null || seenBookmark.has(b.ayahId)) continue
    seenBookmark.add(b.ayahId)
    out.push({ key: `bookmark-${b.ayahId}`, kind: 'bookmark', ayahId: b.ayahId, line, id: b.bookmarkId })
  }
  for (const n of notes) {
    const anchor = data.ayahs.find((a) => a.id >= n.fromAyahId && a.id <= n.toAyahId)
    if (!anchor) continue
    out.push({ key: `note-${n.id}`, kind: 'note', ayahId: anchor.id, line: anchor.line, id: n.id })
  }
  // Bookmarks before notes on a line, each in ayah order (groupByLine keeps this order per line).
  return out.sort((a, b) => a.ayahId - b.ayahId || (a.kind === b.kind ? 0 : a.kind === 'bookmark' ? -1 : 1))
}

// ---------------------------------------------------------------------------------------------------------------------
// The reading ribbon, the page dog-ear and the page-stack edges (§8.9)

/** The ribbon's width (qfs), how far below its line's centre the notched tail reaches (qfs), and the notch depth. */
export const RIBBON_W = 0.55
export const RIBBON_BELOW = 0.6
export const RIBBON_NOTCH = 0.32

/** The reading ribbon in px: hanging from the top paper edge on the spine side, centred in the spine margin. */
export function ribbonGeometry(
  qfs: number,
  side: PageSide,
  line: number,
  opening = false,
): { x: number; w: number; h: number; notch: number } {
  const w = RIBBON_W * qfs
  const spineX = side === 'right' ? 0 : PW * qfs
  const center = side === 'right' ? spineX + (M_IN * qfs) / 2 : spineX - (M_IN * qfs) / 2
  return {
    x: center - w / 2,
    w,
    h: lineCenterY(qfs, line, opening) + RIBBON_BELOW * qfs,
    notch: RIBBON_NOTCH * qfs,
  }
}

/** The ribbon's outline in a `w × h` box: a strip with a V-notched tail. */
export function ribbonPath(w: number, h: number, notch: number): PathData {
  const n = Math.min(notch, h)
  return `M0 0H${round2(w)}V${round2(h)}L${pt(w / 2, h - n)}L0 ${round2(h)}Z`
}

/** The page dog-ear's size (qfs). */
export const DOG_EAR = 1.2

/** How many page-stack hairlines an outer edge gets (§8.9): 1–5, proportional to the pages on that side. */
export function stackEdgeCount(page: number, side: PageSide): number {
  const p = Number.isFinite(page) ? Math.min(PAGE_COUNT, Math.max(1, Math.round(page))) : 1
  const fraction = side === 'right' ? p / PAGE_COUNT : (PAGE_COUNT - p) / PAGE_COUNT
  return 1 + Math.round(Math.min(1, Math.max(0, fraction)) * 4)
}

/** Hairline spacing of the page-stack edges (px). */
export const STACK_EDGE_STEP = 1.5

// ---------------------------------------------------------------------------------------------------------------------
// Text helpers

/**
 * A plain-text preview of a note body (§8.9 tooltip): Markdown markers dropped, whitespace collapsed, at most `max`
 * characters (whole grapheme clusters, an ellipsis when cut).
 */
export function notePreview(body: string, max = 80): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(plain)]
  if (segments.length <= max) return plain
  return `${segments
    .slice(0, max)
    .map((s) => s.segment)
    .join('')
    .trimEnd()}…`
}

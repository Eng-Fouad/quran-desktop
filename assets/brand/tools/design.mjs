// @ts-check
/**
 * Brand drawings: the github.com/quran identity, gold calligraphic قرآن on a navy tile.
 *
 * Everything is derived from one owner-approved raster, quran_android's `ic_upcoming_app_icon.webp` (1024 px, GPL-3.0).
 * No pixel is drawn from scratch: this file holds the parameters that turn that master into each OS size, and the
 * functions that apply them (pixels.mjs does the arithmetic).
 *
 *  - 128 px and up (and the ICO's 256 px entry): the master itself, Lanczos-resampled.
 *  - 16–64 px (Windows ICO, tray, title bar): hand-tuned. The gold glyph is cut out of the master (`analyse`), cropped
 *    tighter and enlarged on the tile (less navy padding), emboldened through its distance field (the diacritic dots
 *    less, so they stay separate specks), given a contrast stretch and an unsharp mask, and painted in the flat gold
 *    of the github.com/quran avatar. The tile keeps the master's own outline and navy gradient, without the bevel.
 *    16–32 px are the 100 % slots; 40–64 px are the same slots at 125–200 % scaling, where the master's thin bevelled
 *    strokes, dark at the bottom of the gold gradient, read far worse than the tuned drawing.
 *  - macOS: the master on the Apple grid (824 px body, 100 px margin, soft shadow); 16, 32 and 64 px tuned on that grid.
 *  - Single colour (macOS template, UI mark): the glyph's silhouette, alpha only.
 *  - Media artwork: the master's interior on an opaque square of its own navy gradient.
 *
 * Edit the constants, run `node assets/brand/tools/build.mjs --review` and look at artifacts/brand/review.png.
 */
import * as px from './pixels.mjs'

/** @typedef {import('./pixels.mjs').Plane} Plane */
/** @typedef {import('./pixels.mjs').Layer} Layer */
/** @typedef {import('./pixels.mjs').Rgb} Rgb */
/** @typedef {import('./pixels.mjs').Rect} Rect */

/** The owner-approved source artwork (kept unmodified; build.mjs refuses any other bytes). */
export const SOURCE = Object.freeze({
  file: 'assets/brand/source/ic_upcoming_app_icon.webp',
  mime: 'image/webp',
  size: 1024,
  sha256: 'fbdeeb52553482f118c29d1e7f84a161b90e507ea9dbc1dcc840f51f1c951c6d',
})

/** Colours sampled from the source. */
export const PALETTE = Object.freeze({
  /** The flat gold of the github.com/quran avatar (#e2af56): the small sizes, where the bevel cannot be resolved. */
  gold: /** @type {Rgb} */ ([226, 175, 86]),
  /** The master tile's navy, a linear fit of its interior at y = 0 and y = 1024 (residual σ ≈ 2.7 levels). */
  navyTop: /** @type {Rgb} */ ([1, 0, 102]),
  navyBottom: /** @type {Rgb} */ ([0, 0, 44]),
})

/**
 * Cutting the gold glyph out of the master. Gold has a high red channel; the tile is pure blue (R ≈ 0) and its bevel
 * highlight is bluish (B > R), so coverage = clamp(R / redFull) · clamp((R − B + warmOffset) / warmSpan).
 */
export const GLYPH = Object.freeze({
  /** Ignore this many pixels along the canvas edge (the tile's bevelled rim). */
  inset: 48,
  redFull: 90,
  warmOffset: 20,
  warmSpan: 40,
  /** Connected parts smaller than this (px²) are the diacritic dots: the nun's dot and the qaf's pair. */
  dotMaxArea: 15000,
  /** The glyph's bounding box in the master (inclusive edges) — checked, so a different source fails loudly. */
  box: Object.freeze({ x0: 128, y0: 151, x1: 895, y1: 886 }),
})

/**
 * @typedef {{
 *   glyph: { width: number, x: number, y: number },
 *   bold: number,
 *   dotBold: number,
 *   levels: [number, number],
 *   unsharp: [number, number],
 * }} TunedSpec
 * - glyph: the glyph's bounding box on the target grid: its width (height follows the 768 : 736 aspect) and top-left
 *   corner, in target pixels. Positions were chosen by searching ⅛-px offsets for the crispest coverage, then by eye.
 * - bold / dotBold: outline offset of the body (madda included) and of the dots, in master pixels (negative = thinner).
 * - levels: coverage contrast stretch [lo, hi] → [0, 1].
 * - unsharp: [sigma, amount] on the coverage, in target pixels.
 */

/**
 * Full-bleed tuned icons (Windows ICO entries, tray, title bar). The glyph fills 85–90 % of the tile width (75 % in the
 * master); the smaller the icon, the bolder the strokes and the harder the contrast stretch.
 * @type {Readonly<Record<16 | 20 | 24 | 32 | 40 | 48 | 64, TunedSpec>>}
 */
export const SMALL = Object.freeze({
  16: {
    glyph: { width: 14, x: 1, y: 1.042 },
    bold: 10,
    dotBold: -8,
    levels: [0.2, 0.7],
    unsharp: [0.6, 0.6],
  },
  20: {
    glyph: { width: 18, x: 1.25, y: 1.5 },
    bold: 9,
    dotBold: -4,
    levels: [0.18, 0.72],
    unsharp: [0.6, 0.6],
  },
  24: {
    glyph: { width: 21, x: 1.625, y: 1.438 },
    bold: 8,
    dotBold: 0,
    levels: [0.15, 0.75],
    unsharp: [0.6, 0.6],
  },
  32: {
    glyph: { width: 28, x: 1.625, y: 1.825 },
    bold: 6,
    dotBold: 2,
    levels: [0.12, 0.8],
    unsharp: [0.7, 0.5],
  },
  40: {
    glyph: { width: 34, x: 3.25, y: 4.085 },
    bold: 5,
    dotBold: 3,
    levels: [0.06, 0.94],
    unsharp: [0.7, 0.4],
  },
  48: {
    glyph: { width: 41, x: 3.875, y: 3.975 },
    bold: 4,
    dotBold: 3,
    levels: [0.05, 0.95],
    unsharp: [0.7, 0.4],
  },
  64: {
    glyph: { width: 54, x: 5.125, y: 5.745 },
    bold: 3,
    dotBold: 2,
    levels: [0.04, 0.96],
    unsharp: [0.8, 0.35],
  },
})

/** Apple icon grid: an 824 px body centred on the 1024 canvas (100 px margin) with a soft drop shadow. */
export const MACOS = Object.freeze({
  inset: 100,
  shadow: Object.freeze({ dy: 12, sigma: 12, opacity: 0.3 }),
  /**
   * Tuned 16, 32 and 64 px on the grid: the body is inset by a whole number of pixels (closest to 100/1024), and the glyph
   * box is relative to the canvas.
   * @type {Readonly<Record<16 | 32 | 64, TunedSpec & { inset: number }>>}
   */
  small: Object.freeze({
    16: {
      inset: 1,
      glyph: { width: 12.5, x: 2, y: 2.125 },
      bold: 11,
      dotBold: -9,
      levels: [0.2, 0.7],
      unsharp: [0.6, 0.6],
    },
    32: {
      inset: 3,
      glyph: { width: 23, x: 4.125, y: 4.375 },
      bold: 7,
      dotBold: 1,
      levels: [0.12, 0.8],
      unsharp: [0.7, 0.5],
    },
    64: {
      inset: 6,
      glyph: { width: 45, x: 9, y: 10.815 },
      bold: 4,
      dotBold: 3,
      levels: [0.05, 0.95],
      unsharp: [0.7, 0.4],
    },
  }),
})

/**
 * macOS menu-bar template images (black + alpha; `icon_as_template`). tray-icon draws the image at 18 pt, so they are
 * designed on 18 and 36 px grids: the glyph's silhouette alone, no tile.
 * @type {Readonly<Record<18 | 36, TunedSpec>>}
 */
export const TEMPLATE = Object.freeze({
  18: {
    glyph: { width: 17, x: 0.25, y: 0.875 },
    bold: 6,
    dotBold: -6,
    levels: [0.15, 0.8],
    unsharp: [0.6, 0.5],
  },
  36: {
    glyph: { width: 34, x: 1.375, y: 2.125 },
    bold: 6,
    dotBold: 2,
    levels: [0.08, 0.9],
    unsharp: [0.7, 0.4],
  },
})

/** The single-colour UI mark (src/assets/app-mark.svg): the silhouette at 128 px, used as a mask. */
export const MARK = Object.freeze({
  size: 128,
  spec: /** @type {TunedSpec} */ ({
    glyph: { width: 124, x: 2, y: 4.6 },
    bold: 2,
    dotBold: 2,
    levels: [0, 1],
    unsharp: [0, 0],
  }),
})

/** Media-session artwork: an opaque square; the glyph spans `glyphWidth` of it (room for round crops). */
export const ARTWORK = Object.freeze({
  size: 512,
  glyphWidth: 0.7,
  /** The master is kept inside this distance from the tile edge (px); the rim and corners become the navy fit. */
  keep: Object.freeze({ from: 40, to: 64 }),
})

// ---------------------------------------------------------------------------------------------------------------------
// Analysis of the master

/**
 * @typedef {{
 *   size: number,
 *   master: Layer,
 *   tile: Plane,
 *   glyph: Plane,
 *   bodySdf: Plane,
 *   dotsSdf: Plane,
 *   box: { x: number, y: number, w: number, h: number },
 *   parts: { area: number, x0: number, y0: number, x1: number, y1: number }[],
 * }} Analysis
 */

/**
 * Split the master into the tile (its alpha) and the gold glyph (coverage), and the glyph into body and dots.
 * @param {import('./pixels.mjs').Rgba8} rgba
 * @returns {Analysis}
 */
export function analyse(rgba) {
  const n = rgba.width
  if (rgba.height !== n || n !== SOURCE.size) throw new Error(`master is ${rgba.width}×${rgba.height}`)
  const master = px.fromRgba8(rgba)
  const tile = px.plane(n, n)
  const glyph = px.plane(n, n)
  const { inset, redFull, warmOffset, warmSpan } = GLYPH
  const clamp = (/** @type {number} */ v) => (v < 0 ? 0 : v > 1 ? 1 : v)
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const p = y * n + x
      const r = rgba.data[p * 4] ?? 0
      const b = rgba.data[p * 4 + 2] ?? 0
      const a = rgba.data[p * 4 + 3] ?? 0
      tile.data[p] = a / 255
      if (a !== 255 || x < inset || y < inset || x >= n - inset || y >= n - inset) continue
      glyph.data[p] = clamp(r / redFull) * clamp((r - b + warmOffset) / warmSpan)
    }
  const bb = px.bounds(glyph)
  const want = GLYPH.box
  if (!bb || bb.x0 !== want.x0 || bb.y0 !== want.y0 || bb.x1 !== want.x1 || bb.y1 !== want.y1)
    throw new Error(
      `glyph bounds ${JSON.stringify(bb)} ≠ ${JSON.stringify(want)}: is this the approved source?`,
    )

  // Body (the word and its madda) vs the diacritic dots, by connected part.
  const parts = px.components(glyph)
  const dots = parts.filter((c) => c.area < GLYPH.dotMaxArea)
  const body = px.plane(n, n)
  const dot = px.plane(n, n)
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const p = y * n + x
      const isDot = dots.some((c) => x >= c.x0 - 4 && x <= c.x1 + 4 && y >= c.y0 - 4 && y <= c.y1 + 4)
      ;(isDot ? dot : body).data[p] = glyph.data[p] ?? 0
    }
  return {
    size: n,
    master,
    tile,
    glyph,
    bodySdf: px.signedDistance(body),
    dotsSdf: px.signedDistance(dot),
    box: { x: want.x0, y: want.y0, w: want.x1 + 1 - want.x0, h: want.y1 + 1 - want.y0 },
    parts,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Drawings

/**
 * The tuned glyph coverage on a size×size grid.
 * @param {Analysis} a
 * @param {number} size
 * @param {TunedSpec} spec
 * @returns {Plane}
 */
export function tunedGlyph(a, size, spec) {
  const body = px.offsetShape(a.bodySdf, spec.bold)
  const dots = px.offsetShape(a.dotsSdf, spec.dotBold)
  const shape = px.plane(a.size, a.size)
  for (let p = 0; p < shape.data.length; p++) shape.data[p] = Math.max(body.data[p] ?? 0, dots.data[p] ?? 0)
  const k = spec.glyph.width / a.box.w // target px per master px
  /** @type {Rect} */
  const rect = { x: a.box.x - spec.glyph.x / k, y: a.box.y - spec.glyph.y / k, w: size / k, h: size / k }
  let cov = px.resamplePlane(shape, rect, size, size, 'box')
  cov = px.levels(cov, spec.levels[0], spec.levels[1])
  cov = px.unsharp(cov, spec.unsharp[0], spec.unsharp[1])
  return cov
}

/**
 * The master's tile outline (its alpha) on a body×body square placed at `inset` on a size×size canvas.
 * @param {Analysis} a
 * @param {number} size
 * @param {number} inset
 */
function tileAlpha(a, size, inset) {
  const body = size - 2 * inset
  const k = body / a.size
  return px.resamplePlane(
    a.tile,
    { x: -inset / k, y: -inset / k, w: size / k, h: size / k },
    size,
    size,
    'box',
  )
}

/**
 * A tuned small icon: flat navy tile (the master's outline and gradient) with the tuned gold glyph.
 * @param {Analysis} a
 * @param {number} size
 * @param {TunedSpec} spec
 * @param {number} [inset] body inset (macOS grid); 0 = full-bleed
 * @returns {Layer}
 */
export function tunedIcon(a, size, spec, inset = 0) {
  const tile = tileAlpha(a, size, inset)
  const body = size - 2 * inset
  // The navy gradient spans the body, as in the master (the canvas edges extend it).
  const navy = px.fill(tile, navyAt(-inset / body), navyAt(1 + inset / body))
  const cov = px.multiply(tunedGlyph(a, size, spec), tile)
  return px.over(navy, px.fill(cov, PALETTE.gold))
}

/** The master's navy at fraction `t` of the tile height (0 = top edge, 1 = bottom edge; extrapolates outside). */
function navyAt(/** @type {number} */ t) {
  const top = PALETTE.navyTop
  const bottom = PALETTE.navyBottom
  return /** @type {Rgb} */ (top.map((v, i) => v + ((bottom[i] ?? 0) - v) * t))
}

/** The master resampled (Lanczos-3) to `size`, full-bleed. */
export function masterIcon(/** @type {Analysis} */ a, /** @type {number} */ size) {
  return px.resampleLayer(a.master, { x: 0, y: 0, w: a.size, h: a.size }, size, size, 'lanczos3')
}

/** The master on the Apple grid at 1024: 824 px body, 100 px margin, soft shadow. */
export function macosCanvas(/** @type {Analysis} */ a) {
  const { inset, shadow } = MACOS
  const n = a.size
  const k = (n - 2 * inset) / n
  const rect = { x: -inset / k, y: -inset / k, w: n / k, h: n / k }
  const body = px.resampleLayer(a.master, rect, n, n, 'lanczos3')
  const shadowAlpha = px.shift(px.blur(px.alphaOf(body), shadow.sigma), 0, shadow.dy)
  for (let p = 0; p < shadowAlpha.data.length; p++)
    shadowAlpha.data[p] = (shadowAlpha.data[p] ?? 0) * shadow.opacity
  return px.over(px.fill(shadowAlpha, [0, 0, 0]), body)
}

/** Downsample the 1024 macOS canvas. */
export function macosIcon(/** @type {Layer} */ canvas, /** @type {number} */ size) {
  return px.resampleLayer(canvas, { x: 0, y: 0, w: canvas.width, h: canvas.height }, size, size, 'lanczos3')
}

/** A single-colour silhouette (template image, UI mark): the tuned glyph coverage, no tile. */
export function silhouette(
  /** @type {Analysis} */ a,
  /** @type {number} */ size,
  /** @type {TunedSpec} */ spec,
) {
  return tunedGlyph(a, size, spec)
}

/** Opaque square media artwork. */
export function artwork(/** @type {Analysis} */ a) {
  const { size, glyphWidth, keep } = ARTWORK
  const n = a.size
  // Keep the master inside the tile, away from its rim; outside that, the fitted navy takes over.
  const tileSdf = px.signedDistance(a.tile)
  const inner = px.layer(n, n)
  for (let p = 0; p < n * n; p++) {
    // Depth inside the tile; the tile touches the canvas edge mid-side, so the edge counts as outside too.
    const x = p % n
    const y = (p - x) / n
    const depth = Math.min(-(tileSdf.data[p] ?? 0), x + 0.5, y + 0.5, n - x - 0.5, n - y - 0.5)
    const w = Math.min(1, Math.max(0, (depth - keep.from) / (keep.to - keep.from)))
    inner.r[p] = (a.master.r[p] ?? 0) * w
    inner.g[p] = (a.master.g[p] ?? 0) * w
    inner.b[p] = (a.master.b[p] ?? 0) * w
    inner.a[p] = (a.master.a[p] ?? 0) * w
  }
  const span = a.box.w / glyphWidth // master px across the square
  const cx = a.box.x + a.box.w / 2
  const cy = a.box.y + a.box.h / 2
  const rect = { x: cx - span / 2, y: cy - span / 2, w: span, h: span }
  const fg = px.resampleLayer(inner, rect, size, size, 'lanczos3')
  const bg = px.fill(px.plane(size, size, 1), navyAt(rect.y / n), navyAt((rect.y + rect.h) / n))
  return px.over(bg, fg)
}

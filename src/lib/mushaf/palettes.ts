/**
 * The shared V4 `@font-palette-values --qd-v4` rule.
 *
 * The QCF V4 page fonts are COLRv0 + CPAL with the same six palettes of 16 entries on every page:
 * 0/1/2 = tajweed light/dark/sepia, 3/4/5 = plain light/dark/sepia; entries 1–9 are the tajweed rules and 10–13 the
 * ayah-marker colours. `var()` is invalid inside `@font-palette-values`, so one generated rule names every loaded V4
 * family and is rewritten whenever the family set, the theme, tajweed, the ink brightness or the contrast preference
 * changes (`fonts.regeneratePalettes()`, written into `<style id="qd-v4-palettes">`).
 *
 * **No `override-colors`** (`MAX_OVERRIDES = 0`). Chromium (WebView2 and Edge 154) crashes the renderer (a deliberate
 * `0x80000003` break) some minutes after a V4 face was drawn through a rule with two or more override entries, once the
 * UI language and the views have changed a few times: whether or not V4 is still shown, whether or not its faces are
 * still loaded. Bisected in headed Edge with the reviewer's loop: 9 of 9 runs with ≥ 2 entries crashed (rounds 6–12),
 * 0 of 9 with one or none (14 rounds each); a base palette with an SVG colour matrix on the lines passes too. One entry
 * could carry the ink of entry 0 only, but the ink also lives in entry 14 (the diacritics), 13 (the marker digits) and
 * 1–9 (the plain palettes), so the rule carries the base palette alone and the theme is applied by a colour map on the
 * V4 lines (`V4_LINES_SELECTOR { filter: url(#qd-v4-ink) }`, an `feColorMatrix` in `<svg id="qd-v4-ink-svg">`):
 * - **Ink.** The map takes the palette's ink to the theme's `--ink` exactly, in every ink entry: black → ink on light
 *   pages (white stays white), white → ink on dark pages at the ink brightness, mixed with the page as `--ink` is.
 *   The other colours follow the same map: on a light page they lighten by the ink's few levels, and on a dark page
 *   they dim with the text.
 * - **High contrast** (`high_contrast`, or `prefers-contrast: more` in any theme) with tajweed on: palette 0 on a light
 *   page, palette 1 on a dark page, and the map times the mildest factor (`brightness`, computed in sRGB as Chromium
 *   applies it) that brings every rule colour to ≥ 4.5:1 on the page. Where no factor in `HC_LIFT_RANGE` does, V4 draws
 *   its plain palette: night with `prefers-contrast: more`, whose page holds pure red at 4.3:1 at most.
 */
import type { ResolvedTheme } from '$lib/contracts/stores'

/** The CPAL table of the QCF V4 fonts (identical on every page). */
export const V4_CPAL: readonly (readonly string[])[] = [
  // 0 tajweed light
  [
    '#000000', '#a5a5a5', '#a3a5a5', '#b50000', '#ff7b00', '#ce9e00', '#09b000', '#3f48e6',
    '#2fadff', '#f40000', '#2ca4ab', '#ff0080', '#d8e9d8', '#000000', '#040000', '#9fa5a5',
  ],
  // 1 tajweed dark
  [
    '#ffffff', '#9d9999', '#999999', '#e30000', '#ff8e3b', '#ffc1e0', '#26b55d', '#3c84d5',
    '#00deff', '#ff5e8e', '#009b68', '#aa8a1c', '#2e544f', '#ffffff', '#fbffff', '#919999',
  ],
  // 2 tajweed sepia
  [
    '#000000', '#afabab', '#ababab', '#b7001c', '#e67b00', '#c09725', '#09b000', '#134fe1',
    '#00b4e0', '#ff0000', '#d52b5e', '#56a977', '#ffffff', '#6c0000', '#000009', '#a6abab',
  ],
  // 3 plain light
  [
    '#000000', '#000000', '#000000', '#000000', '#000000', '#000000', '#000000', '#000000',
    '#000000', '#000000', '#2ca4ab', '#ff0080', '#d8e9d8', '#000000', '#000000', '#000000',
  ],
  // 4 plain dark
  [
    '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff',
    '#ffffff', '#ffffff', '#019e73', '#aa8a1c', '#2e544f', '#ffffff', '#ffffff', '#ffffff',
  ],
  // 5 plain sepia
  [
    '#000000', '#000000', '#000000', '#000000', '#000000', '#000000', '#000000', '#000000',
    '#000000', '#000000', '#d52b5e', '#56a977', '#ffffff', '#6c0000', '#000000', '#000000',
  ],
] // prettier-ignore

/** The palette indices by meaning. */
export const PALETTE = {
  tajweedLight: 0,
  tajweedDark: 1,
  tajweedSepia: 2,
  plainLight: 3,
  plainDark: 4,
  plainSepia: 5,
} as const

/** The tajweed rule entries (the colours a reader must tell apart). */
export const TAJWEED_RULE_ENTRIES = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const

/** The `font-palette` name GlyphLayer's `.lw` uses for `qcf_v4` renditions (lines.css). */
export const PALETTE_NAME = '--qd-v4'

/** The `<style>` element the rule lives in (CSP `style-src 'unsafe-inline'`). */
export const PALETTE_STYLE_ID = 'qd-v4-palettes'

/** The V4 lines that draw through the palette (lines.css gives them `font-palette`); the colour map's selector. */
export const V4_LINES_SELECTOR = ".mp[data-style='qcf_v4'] .mp-glyphs[data-rendition='qcf'] .lw"

/** The SVG filter of the colour map, and the hidden `<svg>` that holds it. */
export const INK_FILTER_ID = 'qd-v4-ink'
export const INK_SVG_ID = 'qd-v4-ink-svg'

/** `override-colors` entries the rule may carry: none, two or more crash Chromium's renderer later (see above). */
export const MAX_OVERRIDES = 0

/**
 * The high-contrast lift: a factor from 1 towards `min` (light page) or `max` (dark page) in steps of 0.01. Palette 0
 * needs about 0.71 on white, 0.69 on paper and 0.64 on sepia; palette 1 needs 1.04 on black.
 */
export const HC_LIFT_RANGE = { min: 0.5, max: 1.5, step: 0.01 } as const

// ---------------------------------------------------------------------------------------------------------------------
// Colour helpers

export type Rgb = readonly [number, number, number]

const clampByte = (v: number) => Math.min(255, Math.max(0, Math.round(v)))

/** Parses `#rgb`/`#rrggbb`. */
export function parseHex(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  const digits = m?.[1]
  if (!digits) return null
  const full = digits.length === 3 ? [...digits].map((c) => c + c).join('') : digits
  const n = Number.parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * Normalises a computed CSS colour to an opaque `Rgb`: `#hex`, `rgb()`/`rgba()` in legacy or space syntax (percent
 * channels included) and `color(srgb r g b)` (Chromium's computed value of `color-mix()`). Alpha is ignored: `--ink` is
 * opaque in every theme. Anything else (a system colour keyword, `oklch()`) gives `null`.
 */
export function parseCssColor(css: string): Rgb | null {
  const s = css.trim().toLowerCase()
  if (s.startsWith('#')) return parseHex(s)
  const rgb = /^rgba?\(\s*([^)]*)\)$/.exec(s)
  if (rgb?.[1] !== undefined) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean)
    if (parts.length < 3) return null
    const channels = parts.slice(0, 3).map((p) => {
      const v = Number.parseFloat(p)
      return p.endsWith('%') ? (v / 100) * 255 : v
    })
    if (channels.some((v) => !Number.isFinite(v))) return null
    return [clampByte(channels[0] ?? 0), clampByte(channels[1] ?? 0), clampByte(channels[2] ?? 0)]
  }
  const color = /^color\(\s*srgb\s+([^)]*)\)$/.exec(s)
  if (color?.[1] !== undefined) {
    const parts = color[1].split(/[\s/]+/).filter(Boolean)
    if (parts.length < 3) return null
    const channels = parts.slice(0, 3).map((p) => {
      const v = Number.parseFloat(p)
      return p.endsWith('%') ? v / 100 : v
    })
    if (channels.some((v) => !Number.isFinite(v))) return null
    return [
      clampByte((channels[0] ?? 0) * 255),
      clampByte((channels[1] ?? 0) * 255),
      clampByte((channels[2] ?? 0) * 255),
    ]
  }
  return null
}

/** `rgb(r g b)`, the form `override-colors` takes. */
export function rgbCss([r, g, b]: Rgb): string {
  return `rgb(${r} ${g} ${b})`
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG 2.x contrast ratio of two opaque colours (1–21). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Light ink means a dark page: decides the high-contrast variant without a separate argument. */
export function isLightInk(ink: Rgb): boolean {
  return relativeLuminance(ink) > 0.5
}

// ---------------------------------------------------------------------------------------------------------------------
// The rule

/** What `paletteRule` resolved, exposed for tests and the Settings preview. */
export interface PalettePlan {
  basePalette: number
  /**
   * The V4 lines' colour map, `c' = scale · c + offset` per sRGB channel (0–1), written as an SVG `feColorMatrix`
   * (`inkFilterValues`), or `null` when it is the identity.
   */
  map: ChannelMap | null
}

/** A per-channel affine colour map (sRGB, 0–1): `c' = scale · c + offset`. */
export interface ChannelMap {
  scale: readonly [number, number, number]
  offset: readonly [number, number, number]
}

/** The ink brightness and the page a plan needs besides the theme (both optional: without them, no dimming or lift). */
export interface PaletteContext {
  /** The page colour (`--surface-page`). */
  page?: Rgb | null
  /** `inkBrightnessPct / 100` (night and black; 1 under `prefers-contrast: more`). */
  inkLevel?: number
}

const IDENTITY: ChannelMap = { scale: [1, 1, 1], offset: [0, 0, 0] }

/** A colour (0–255) through a channel map, unrounded and clamped to 0–255. */
export function applyMap(map: ChannelMap | null, [r, g, b]: Rgb): [number, number, number] {
  const m = map ?? IDENTITY
  const channel = (c: number, i: 0 | 1 | 2) => Math.min(255, Math.max(0, m.scale[i] * c + m.offset[i] * 255))
  return [channel(r, 0), channel(g, 1), channel(b, 2)]
}

/** The two 8-bit neighbours of a mapped colour (the contrast checks hold for both, whichever way Chromium rounds). */
function neighbours(c: readonly [number, number, number]): [Rgb, Rgb] {
  return [
    [Math.floor(c[0]), Math.floor(c[1]), Math.floor(c[2])],
    [Math.ceil(c[0]), Math.ceil(c[1]), Math.ceil(c[2])],
  ]
}

/**
 * A colour after Chromium's `brightness(f)` filter: every sRGB channel times `f`, clamped. Measured in Edge 154 (the
 * filter works on the sRGB values, not in linear light, and truncates: 165 × 0.5 → 82); `round: 'up'` gives the
 * other neighbour. The high-contrast lift is the same multiplication, folded into the lines' colour map.
 */
export function brighten([r, g, b]: Rgb, f: number, round: 'down' | 'up' = 'down'): Rgb {
  const channel = (c: number) =>
    Math.min(255, Math.max(0, round === 'up' ? Math.ceil(c * f) : Math.floor(c * f)))
  return [channel(r), channel(g), channel(b)]
}

/**
 * The mildest lift `f` (closest to 1, within `HC_LIFT_RANGE`; every channel times `f`) that brings every tajweed rule
 * colour of `palette`, after `map`, to ≥ 4.5:1 on `page`, whichever way the channels round: darker on a light page,
 * lighter on a dark one. `1` when the colours already pass, `null` when no factor in range does.
 */
export function contrastLift(
  palette: readonly string[],
  page: Rgb,
  map: ChannelMap | null = null,
): number | null {
  const rules = TAJWEED_RULE_ENTRIES.map((e) => parseHex(palette[e] ?? ''))
    .filter((c): c is Rgb => c !== null)
    .map((c) => applyMap(map, c))
  const passes = (f: number) =>
    rules.every((c) =>
      neighbours([Math.min(255, c[0] * f), Math.min(255, c[1] * f), Math.min(255, c[2] * f)]).every(
        (n) => contrastRatio(n, page) >= 4.5,
      ),
    )
  const { min, max, step } = HC_LIFT_RANGE
  const towards = relativeLuminance(page) > 0.5 ? -1 : 1
  for (let k = 0; ; k++) {
    const f = Math.round((1 + towards * k * step) * 100) / 100
    if (f < min - 1e-9 || f > max + 1e-9) return null
    if (passes(f)) return f
  }
}

/**
 * The map that takes a palette's ink to the theme ink (sRGB 0–1, per channel):
 * - a black-ink palette (light pages): `c' = c · (1 − t) + t`, so black becomes the ink `t` and white stays white;
 * - a white-ink palette (dark pages): `c' = c · F · k + P · (1 − k)`, so white becomes the ink `F` at brightness `k`
 *   over the page `P`, as `--ink` is (`color-mix(F k, P)`); every other colour dims with it, like the text it sits in.
 *   `F` is recovered from the resolved ink: `P + (ink − P) / k`.
 */
function inkMap(paletteInk: Rgb, ink: Rgb, page: Rgb | null, level: number): ChannelMap {
  const t = [ink[0] / 255, ink[1] / 255, ink[2] / 255] as const
  if (relativeLuminance(paletteInk) < 0.5) {
    return { scale: [1 - t[0], 1 - t[1], 1 - t[2]], offset: t }
  }
  if (!page || !(level > 0 && level < 1)) return { scale: t, offset: [0, 0, 0] }
  const p = [page[0] / 255, page[1] / 255, page[2] / 255] as const
  const full = (i: 0 | 1 | 2) => Math.min(1, Math.max(0, p[i] + (t[i] - p[i]) / level))
  return {
    scale: [full(0) * level, full(1) * level, full(2) * level],
    offset: [p[0] * (1 - level), p[1] * (1 - level), p[2] * (1 - level)],
  }
}

const isIdentity = (m: ChannelMap) =>
  m.scale.every((s) => Math.abs(s - 1) < 0.002) && m.offset.every((o) => Math.abs(o) < 0.002)

/**
 * The base palette and the lines' colour map for a theme, with no `override-colors` (`MAX_OVERRIDES`):
 * - tajweed: paper 0, sepia 2, night 1, black 1, high_contrast 0 (1 when the ink is light, i.e. HC dark);
 * - plain: paper 3, sepia 5, night 4, black 4, high_contrast 3 (4 when HC dark);
 * - the map takes the palette's ink to the theme ink (`inkMap`): every ink entry (0, the diacritics' 14, the marker
 *   digits' 13, the plain palettes' 1–9) becomes exactly the theme's `--ink`, at the ink brightness on night and black;
 * - high contrast with tajweed (the theme, or `contrastMore` in any theme): palette 0 on light pages, 1 on dark ones,
 *   and the map times the mildest lift that brings every rule colour to 4.5:1 (`contrastLift`, when the page is
 *   known); the plain palette when no lift in range reaches it.
 */
export function planPalette(
  theme: ResolvedTheme,
  tajweed: boolean,
  ink: Rgb | null,
  contrastMore: boolean,
  context: PaletteContext = {},
): PalettePlan {
  const page = context.page ?? null
  const darkPage =
    theme === 'night' || theme === 'black' || (theme === 'high_contrast' && ink !== null && isLightInk(ink))
  const highContrast = theme === 'high_contrast' || contrastMore
  const level = highContrast ? 1 : (context.inkLevel ?? 1)
  const mapFor = (palette: number): ChannelMap | null => {
    const paletteInk = parseHex(V4_CPAL[palette]?.[0] ?? '')
    return ink && paletteInk ? inkMap(paletteInk, ink, page, level) : null
  }
  let basePalette: number
  let lift = 1
  if (tajweed && highContrast) {
    basePalette = darkPage ? PALETTE.tajweedDark : PALETTE.tajweedLight
    const found = page ? contrastLift(V4_CPAL[basePalette] ?? [], page, mapFor(basePalette)) : 1
    if (found === null) basePalette = darkPage ? PALETTE.plainDark : PALETTE.plainLight
    else lift = found
  } else if (tajweed) {
    basePalette =
      theme === 'sepia' ? PALETTE.tajweedSepia : darkPage ? PALETTE.tajweedDark : PALETTE.tajweedLight
  } else {
    basePalette = theme === 'sepia' ? PALETTE.plainSepia : darkPage ? PALETTE.plainDark : PALETTE.plainLight
  }
  const base = mapFor(basePalette) ?? IDENTITY
  const map: ChannelMap = {
    scale: [base.scale[0] * lift, base.scale[1] * lift, base.scale[2] * lift],
    offset: [base.offset[0] * lift, base.offset[1] * lift, base.offset[2] * lift],
  }
  return { basePalette, map: isIdentity(map) ? null : map }
}

/** The `feColorMatrix` `values` of a plan's map (4 × 5, row-major), or `null` for none. */
export function inkFilterValues(plan: PalettePlan): string | null {
  const m = plan.map
  if (!m) return null
  const n = (v: number) => String(Math.round(v * 10000) / 10000)
  return [
    `${n(m.scale[0])} 0 0 0 ${n(m.offset[0])}`,
    `0 ${n(m.scale[1])} 0 0 ${n(m.offset[1])}`,
    `0 0 ${n(m.scale[2])} 0 ${n(m.offset[2])}`,
    '0 0 0 1 0',
  ].join('  ')
}

/** Only `qcf-v4-p{N}`-like family names (word characters and hyphens) are written into the rule. */
const FAMILY = /^[\w-]+$/

/**
 * The CSS for a plan, or `''` when no V4 family is loaded: the `@font-palette-values --qd-v4` rule naming the
 * loaded V4 families with the base palette and no `override-colors`, then, when the plan maps colours, the lines' rule
 * `… .lw { filter: url(#qd-v4-ink); }` (the matrix itself is `writeInkFilter`'s). Families are deduplicated and
 * sorted, so equal inputs give an identical string.
 */
export function paletteCss(families: readonly string[], plan: PalettePlan): string {
  const names = [...new Set(families.filter((f) => FAMILY.test(f)))].sort((a, b) =>
    a.localeCompare(b, 'en', { numeric: true }),
  )
  if (names.length === 0) return ''
  const familyList = names.map((n) => `"${n}"`).join(', ')
  return (
    `@font-palette-values ${PALETTE_NAME} { font-family: ${familyList}; base-palette: ${plan.basePalette}; }` +
    (plan.map ? `\n${V4_LINES_SELECTOR} { filter: url(#${INK_FILTER_ID}); }` : '')
  )
}

/**
 * `paletteCss` for a theme: `inkRgb` and `pageRgb` are the computed `--ink` and `--surface-page` (any CSS colour
 * syntax `parseCssColor` reads); an unreadable ink leaves the palette's own ink.
 */
export function paletteRule(
  families: readonly string[],
  theme: ResolvedTheme,
  tajweed: boolean,
  inkRgb: string,
  contrastMore: boolean,
  pageRgb = '',
  inkLevel = 1,
): string {
  const plan = planPalette(theme, tajweed, parseCssColor(inkRgb), contrastMore, {
    page: parseCssColor(pageRgb),
    inkLevel,
  })
  return paletteCss(families, plan)
}

// ---------------------------------------------------------------------------------------------------------------------
// DOM

/**
 * The resolved, opaque `--ink` of the current theme, read through a hidden probe element (`var()` is invalid inside
 * `@font-palette-values`). The probe lives under `<html>` so it inherits the theme attributes and `--ink-alpha`.
 */
export function readInkColor(doc: Document = document): string {
  return readToken('--ink', doc)
}

/** The resolved page colour (`--surface-page`): the high-contrast lift and the dark-page ink brightness need it. */
export function readPageColor(doc: Document = document): string {
  return readToken('--surface-page', doc)
}

function readToken(name: '--ink' | '--surface-page', doc: Document): string {
  const probe = doc.createElement('span')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText = `position:absolute;inline-size:0;block-size:0;overflow:hidden;visibility:hidden;pointer-events:none;color:var(${name})`
  doc.documentElement.append(probe)
  try {
    return getComputedStyle(probe).color
  } finally {
    probe.remove()
  }
}

/** Writes the rule into `<style id="qd-v4-palettes">` (created on first use). Returns whether the text changed. */
export function writePaletteStyle(css: string, doc: Document = document): boolean {
  let style = doc.getElementById(PALETTE_STYLE_ID)
  if (!(style instanceof HTMLStyleElement)) {
    style?.remove()
    style = doc.createElement('style')
    style.id = PALETTE_STYLE_ID
    doc.head.append(style)
  }
  if (style.textContent === css) return false
  style.textContent = css
  return true
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Writes the colour map into `<svg id="qd-v4-ink-svg"><filter id="qd-v4-ink"><feColorMatrix>` (created on first use,
 * hidden, in sRGB: SVG filters work in linear light by default), or removes it for `null`. Write it before the rule
 * that references it. Returns whether anything changed.
 */
export function writeInkFilter(values: string | null, doc: Document = document): boolean {
  const existing = doc.getElementById(INK_SVG_ID)
  if (values === null) {
    existing?.remove()
    return existing !== null
  }
  let matrix = existing?.querySelector('feColorMatrix') ?? null
  if (!matrix) {
    existing?.remove()
    const svg = doc.createElementNS(SVG_NS, 'svg')
    svg.id = INK_SVG_ID
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')
    svg.setAttribute('width', '0')
    svg.setAttribute('height', '0')
    svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none')
    const filter = doc.createElementNS(SVG_NS, 'filter')
    filter.id = INK_FILTER_ID
    filter.setAttribute('color-interpolation-filters', 'sRGB')
    matrix = doc.createElementNS(SVG_NS, 'feColorMatrix')
    matrix.setAttribute('type', 'matrix')
    filter.append(matrix)
    svg.append(filter)
    ;(doc.body ?? doc.documentElement).append(svg)
  }
  if (matrix.getAttribute('values') === values) return false
  matrix.setAttribute('values', values)
  return true
}

/** Removes the palette `<style>` and the colour map's `<svg>` (store reset). */
export function removePaletteStyle(doc: Document = document): void {
  doc.getElementById(PALETTE_STYLE_ID)?.remove()
  doc.getElementById(INK_SVG_ID)?.remove()
}

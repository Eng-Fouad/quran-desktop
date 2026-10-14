import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ResolvedTheme } from '$lib/contracts/stores'
import {
  applyMap,
  brighten,
  contrastLift,
  contrastRatio,
  INK_FILTER_ID,
  INK_SVG_ID,
  inkFilterValues,
  isLightInk,
  MAX_OVERRIDES,
  PALETTE,
  PALETTE_NAME,
  PALETTE_STYLE_ID,
  type PalettePlan,
  paletteRule,
  parseCssColor,
  parseHex,
  planPalette,
  removePaletteStyle,
  type Rgb,
  rgbCss,
  TAJWEED_RULE_ENTRIES,
  V4_CPAL,
  V4_LINES_SELECTOR,
  writeInkFilter,
  writePaletteStyle,
} from './palettes'

const hex = (h: string): Rgb => {
  const rgb = parseHex(h)
  if (!rgb) throw new Error(`bad hex ${h}`)
  return rgb
}

/** The page surfaces and inks the palette rule meets. */
const PAPER = hex('#fdf8ec')
const SEPIA = hex('#f6ead2')
const NIGHT = hex('#1a1c1f')
const BLACK = hex('#000000')
const WHITE = hex('#ffffff')
const INK_PAPER = hex('#1c1a16')
const INK_SEPIA = hex('#2e2418')
/** Night ink at 88 % (the default brightness): color-mix(#e9e4d8 88 %, #1a1c1f). */
const INK_NIGHT: Rgb = [208, 204, 194]

describe('V4 CPAL table', () => {
  it('has six palettes of sixteen entries', () => {
    expect(V4_CPAL).toHaveLength(6)
    for (const palette of V4_CPAL) {
      expect(palette).toHaveLength(16)
      for (const color of palette) expect(parseHex(color)).not.toBeNull()
    }
  })

  it('keeps the high-chroma ayah-marker colours the COLR probe relies on (palette 0, entries 10 and 11)', () => {
    expect(V4_CPAL[0]?.[10]).toBe('#2ca4ab')
    expect(V4_CPAL[0]?.[11]).toBe('#ff0080')
  })
})

describe('planPalette (base palettes)', () => {
  const cases: [ResolvedTheme, boolean, Rgb, number][] = [
    ['paper', true, INK_PAPER, 0],
    ['sepia', true, INK_SEPIA, 2],
    ['night', true, INK_NIGHT, 1],
    ['black', true, INK_NIGHT, 1],
    ['high_contrast', true, BLACK, 0],
    ['high_contrast', true, WHITE, 1],
    ['paper', false, INK_PAPER, 3],
    ['sepia', false, INK_SEPIA, 5],
    ['night', false, INK_NIGHT, 4],
    ['black', false, INK_NIGHT, 4],
    ['high_contrast', false, BLACK, 3],
    ['high_contrast', false, WHITE, 4],
  ]
  it.each(cases)('%s, tajweed %s, ink %j → palette %i', (theme, tajweed, ink, expected) => {
    expect(planPalette(theme, tajweed, ink, false).basePalette).toBe(expected)
  })

  /** Every ink entry of the plan's palette (the entries drawn in its entry-0 colour). */
  const inkEntries = (palette: number) =>
    (V4_CPAL[palette] ?? []).flatMap((c, i) => {
      const a = hex(c)
      const b = hex(V4_CPAL[palette]?.[0] ?? '')
      return Math.max(...a.map((v, k) => Math.abs(v - (b[k] ?? 0)))) <= 12 ? [i] : []
    })

  it.each([
    ['paper', true, INK_PAPER, PAPER, 1],
    ['sepia', true, INK_SEPIA, SEPIA, 1],
    ['paper', false, INK_PAPER, PAPER, 1],
    ['sepia', false, INK_SEPIA, SEPIA, 1],
    ['night', true, INK_NIGHT, NIGHT, 0.88],
    ['night', false, INK_NIGHT, NIGHT, 0.88],
    ['black', true, [140, 137, 130] as Rgb, BLACK, 0.6],
    ['night', false, [233, 228, 216] as Rgb, NIGHT, 1],
  ] as const)(
    '%s (tajweed %s): every ink entry becomes the theme ink',
    (theme, tajweed, ink, page, inkLevel) => {
      const plan = planPalette(theme, tajweed, ink, false, { page, inkLevel })
      const palette = V4_CPAL[plan.basePalette] ?? []
      const entries = inkEntries(plan.basePalette)
      // Entry 0 and the diacritics' 14 always; the plain palettes' 1–9 too.
      expect(entries).toEqual(expect.arrayContaining([0, 14]))
      const base = hex(palette[0] ?? '')
      for (const entry of entries) {
        const own = hex(palette[entry] ?? '')
        const drawn = applyMap(plan.map, own)
        // Exactly the ink, give or take the entry's own few levels from the palette ink (#040000, #fbffff).
        for (let i = 0; i < 3; i++) {
          const slack = Math.abs((own[i] ?? 0) - (base[i] ?? 0)) + 1
          expect(Math.abs((drawn[i] ?? 0) - (ink[i] ?? 0)), `entry ${entry}`).toBeLessThanOrEqual(slack)
        }
      }
    },
  )

  it('dims every colour of a night page with the ink, as --ink mixes with the page', () => {
    const plan = planPalette('night', true, INK_NIGHT, false, { page: NIGHT, inkLevel: 0.88 })
    const red = applyMap(plan.map, hex('#e30000'))
    // #e30000 × #e9e4d8 at 88 % over #1a1c1f.
    expect(red[0]).toBeCloseTo(0.88 * 227 * (233 / 255) + 0.12 * 26, 0)
    expect(red[1]).toBeCloseTo(0.12 * 28, 0)
  })

  it('maps nothing when the palette already draws the ink (high contrast plain: pure black or white)', () => {
    expect(planPalette('high_contrast', false, BLACK, false).map).toBeNull()
    expect(planPalette('high_contrast', false, WHITE, false).map).toBeNull()
  })

  it('leaves the palette ink when the theme ink cannot be read', () => {
    expect(planPalette('paper', true, null, false)).toEqual({ basePalette: 0, map: null })
  })
})

describe('no override-colors at all (Chromium renderer crash)', () => {
  const themes: ResolvedTheme[] = ['paper', 'sepia', 'night', 'black', 'high_contrast']
  const inks: Rgb[] = [INK_PAPER, INK_SEPIA, INK_NIGHT, BLACK, WHITE, [161, 158, 151]]
  const pages: Rgb[] = [PAPER, SEPIA, NIGHT, BLACK, WHITE]
  it('holds for every theme, tajweed, ink, page, brightness and contrast preference', () => {
    expect(MAX_OVERRIDES).toBe(0)
    for (const theme of themes)
      for (const tajweed of [true, false])
        for (const contrastMore of [true, false])
          for (const ink of inks)
            for (const page of pages)
              for (const inkLevel of [0.5, 0.88, 1]) {
                const rule = paletteRule(
                  ['qcf-v4-p1'],
                  theme,
                  tajweed,
                  rgbCss(ink),
                  contrastMore,
                  rgbCss(page),
                  inkLevel,
                )
                expect(rule).not.toContain('override-colors')
                expect(rule).toMatch(
                  /^@font-palette-values --qd-v4 \{ font-family: "qcf-v4-p1"; base-palette: \d; \}/,
                )
              }
  })
})

/** The two 8-bit roundings of each tajweed rule colour under a plan. */
function ruleColours(
  theme: ResolvedTheme,
  ink: Rgb,
  page: Rgb,
  contrastMore: boolean,
): { plan: PalettePlan; colours: Map<number, Rgb[]> } {
  const plan = planPalette(theme, true, ink, contrastMore, { page })
  const palette = V4_CPAL[plan.basePalette] ?? []
  const colours = new Map<number, Rgb[]>()
  for (const entry of TAJWEED_RULE_ENTRIES) {
    const c = applyMap(plan.map, hex(palette[entry] ?? '#000000'))
    colours.set(entry, [
      [Math.floor(c[0]), Math.floor(c[1]), Math.floor(c[2])],
      [Math.ceil(c[0]), Math.ceil(c[1]), Math.ceil(c[2])],
    ])
  }
  return { plan, colours }
}

describe('high contrast keeps every tajweed rule at ≥ 4.5:1 on the page', () => {
  const pages: [string, ResolvedTheme, Rgb, Rgb, boolean][] = [
    ['high_contrast (light) on white', 'high_contrast', WHITE, BLACK, false],
    ['high_contrast (dark) on black', 'high_contrast', BLACK, WHITE, false],
    ['paper + contrast more', 'paper', PAPER, INK_PAPER, true],
    ['sepia + contrast more', 'sepia', SEPIA, INK_SEPIA, true],
    ['night + contrast more', 'night', NIGHT, [233, 228, 216], true],
    ['black + contrast more', 'black', BLACK, [233, 228, 216], true],
  ]
  it.each(pages)('%s', (_name, theme, page, ink, contrastMore) => {
    const { colours } = ruleColours(theme, ink, page, contrastMore)
    for (const [entry, variants] of colours)
      for (const color of variants)
        expect(contrastRatio(color, page), `entry ${entry} ${rgbCss(color)}`).toBeGreaterThanOrEqual(4.5)
  })

  it('lifts with the mildest factor: about 0.7 on white, just over 1 on black', () => {
    const white = ruleColours('high_contrast', BLACK, WHITE, false).plan
    expect(white.basePalette).toBe(PALETTE.tajweedLight)
    const fw = white.map?.scale[0] ?? 1
    expect(fw).toBeGreaterThan(0.6)
    expect(fw).toBeLessThan(0.8)
    expect(white.map?.offset).toEqual([0, 0, 0])
    const black = ruleColours('high_contrast', WHITE, BLACK, false).plan
    expect(black.basePalette).toBe(PALETTE.tajweedDark)
    const fb = black.map?.scale[0] ?? 1
    expect(fb).toBeGreaterThan(1)
    expect(fb).toBeLessThan(1.15)
    // The mildest: a step closer to 1 fails.
    expect(contrastLift(V4_CPAL[0] ?? [], WHITE)).toBe(fw)
    const p0 = V4_CPAL[0] ?? []
    const weaker = TAJWEED_RULE_ENTRIES.map((e) => brighten(hex(p0[e] ?? ''), fw + 0.01, 'up'))
    expect(weaker.some((c) => contrastRatio(c, WHITE) < 4.5)).toBe(true)
  })

  it('draws the plain palette where no lift in range reaches 4.5:1 (pure red on night is 4.3:1 at most)', () => {
    expect(contrastLift(V4_CPAL[1] ?? [], NIGHT)).toBeNull()
    const { plan } = ruleColours('night', [233, 228, 216], NIGHT, true)
    expect(plan.basePalette).toBe(PALETTE.plainDark)
  })

  it('needed lifting: palette 0 alone fails on white, and palette 1 entry 3 fails on black', () => {
    const p0 = V4_CPAL[0] ?? []
    expect(contrastRatio(hex(p0[1] ?? ''), WHITE)).toBeLessThan(3)
    const p1 = V4_CPAL[1] ?? []
    expect(contrastRatio(hex(p1[3] ?? ''), BLACK)).toBeLessThan(4.5)
  })

  it('matches the brightness() filter of Chromium (sRGB channels, truncated; measured in Edge 154)', () => {
    expect(brighten(hex('#a5a5a5'), 0.5)).toEqual([82, 82, 82])
    expect(brighten(hex('#ff7b00'), 0.5)).toEqual([127, 61, 0])
    expect(brighten(hex('#3c84d5'), 1.2)).toEqual([72, 158, 255])
  })
})

describe('paletteRule, the colour map and its filter', () => {
  it('writes the base palette for the loaded V4 families and points the lines at the colour map', () => {
    expect(paletteRule(['qcf-v4-p262', 'qcf-v4-p1'], 'night', true, 'rgb(220, 215, 205)', false)).toBe(
      '@font-palette-values --qd-v4 { font-family: "qcf-v4-p1", "qcf-v4-p262"; base-palette: 1; }\n' +
        `${V4_LINES_SELECTOR} { filter: url(#${INK_FILTER_ID}); }`,
    )
    // Nothing to map: no filter.
    expect(paletteRule(['qcf-v4-p1'], 'high_contrast', false, '#000000', false, '#ffffff')).toBe(
      '@font-palette-values --qd-v4 { font-family: "qcf-v4-p1"; base-palette: 3; }',
    )
  })

  it('writes the map as an feColorMatrix', () => {
    const plan = planPalette('paper', false, INK_PAPER, false, { page: PAPER })
    expect(inkFilterValues(plan)).toBe(
      '0.8902 0 0 0 0.1098  0 0.898 0 0 0.102  0 0 0.9137 0 0.0863  0 0 0 1 0',
    )
    expect(inkFilterValues({ basePalette: 3, map: null })).toBeNull()
  })

  it('names the lines lines.css gives the palette', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/mushaf/lines.css'), 'utf8')
    expect(css).toContain(`${V4_LINES_SELECTOR} {\n    font-palette: ${PALETTE_NAME};`)
  })

  it('is empty without families, and drops duplicates and names that are not plain identifiers', () => {
    expect(paletteRule([], 'paper', true, 'rgb(0 0 0)', false)).toBe('')
    const rule = paletteRule(
      ['qcf-v4-p2', 'qcf-v4-p2', 'x"; } body { color: red', 'qcf-v4-p10'],
      'paper',
      true,
      '',
      false,
    )
    expect(rule).toContain('font-family: "qcf-v4-p2", "qcf-v4-p10";')
    expect(rule).not.toContain('body')
  })

  it('reads the computed ink in any CSS colour syntax (color-mix computes to color(srgb …))', () => {
    const plan = planPalette('night', false, parseCssColor('color(srgb 0.629608 0.619608 0.593137)'), false)
    expect(plan.basePalette).toBe(4)
    expect(applyMap(plan.map, WHITE).map(Math.round)).toEqual([161, 158, 151])
  })

  it('is stable for equal inputs', () => {
    const a = paletteRule(['qcf-v4-p3', 'qcf-v4-p1'], 'sepia', true, '#2e2418', false)
    const b = paletteRule(['qcf-v4-p1', 'qcf-v4-p3'], 'sepia', true, '#2e2418', false)
    expect(a).toBe(b)
  })
})

describe('colour helpers', () => {
  it.each([
    ['rgb(28, 26, 22)', [28, 26, 22]],
    ['rgb(28 26 22)', [28, 26, 22]],
    ['rgba(28, 26, 22, 0.5)', [28, 26, 22]],
    ['rgb(100% 0% 50%)', [255, 0, 128]],
    ['color(srgb 1 0.5 0)', [255, 128, 0]],
    ['color(srgb 100% 50% 0% / 0.5)', [255, 128, 0]],
    ['#fff', [255, 255, 255]],
    ['#1C1A16', [28, 26, 22]],
  ])('parses %s', (css, rgb) => {
    expect(parseCssColor(css)).toEqual(rgb)
  })

  it.each(['CanvasText', 'oklch(0.5 0.1 200)', 'rgb(1 2)', '#12', ''])('rejects %s', (css) => {
    expect(parseCssColor(css)).toBeNull()
  })

  it('computes WCAG contrast and tells light ink from dark', () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 5)
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 5)
    expect(isLightInk(INK_NIGHT)).toBe(true)
    expect(isLightInk(INK_PAPER)).toBe(false)
  })
})

describe('the <style id="qd-v4-palettes"> element', () => {
  afterEach(() => removePaletteStyle())

  it('is created once, rewritten only when the text changes, and removed on reset', () => {
    expect(writePaletteStyle('@font-palette-values --qd-v4 { base-palette: 0; }')).toBe(true)
    const style = document.getElementById(PALETTE_STYLE_ID)
    expect(style?.tagName).toBe('STYLE')
    expect(style?.parentElement).toBe(document.head)
    expect(writePaletteStyle('@font-palette-values --qd-v4 { base-palette: 0; }')).toBe(false)
    expect(writePaletteStyle('')).toBe(true)
    expect(document.getElementById(PALETTE_STYLE_ID)).toBe(style)
    removePaletteStyle()
    expect(document.getElementById(PALETTE_STYLE_ID)).toBeNull()
  })

  it('holds the colour map in a hidden sRGB SVG filter, rewritten in place and removed with the rule', () => {
    expect(writeInkFilter('0.9 0 0 0 0.1  0 0.9 0 0 0.1  0 0 0.9 0 0.1  0 0 0 1 0')).toBe(true)
    const svg = document.getElementById(INK_SVG_ID)
    const filter = document.getElementById(INK_FILTER_ID)
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(filter?.getAttribute('color-interpolation-filters')).toBe('sRGB')
    const matrix = filter?.querySelector('feColorMatrix')
    expect(matrix?.getAttribute('type')).toBe('matrix')
    expect(writeInkFilter('0.9 0 0 0 0.1  0 0.9 0 0 0.1  0 0 0.9 0 0.1  0 0 0 1 0')).toBe(false)
    expect(writeInkFilter('1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0')).toBe(true)
    expect(document.getElementById(INK_SVG_ID)).toBe(svg)
    expect(matrix?.getAttribute('values')).toBe('1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0')
    expect(writeInkFilter(null)).toBe(true)
    expect(document.getElementById(INK_SVG_ID)).toBeNull()
    writeInkFilter('1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0')
    removePaletteStyle()
    expect(document.getElementById(INK_SVG_ID)).toBeNull()
  })
})

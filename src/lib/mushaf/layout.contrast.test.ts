/**
 * §8.7 highlight composites (WP8d extends WP7a's token harness, §9.2): what the highlight layer actually paints, read
 * from `src/styles/mushaf/highlights.css` and resolved through `src/styles/tokens.css` for every theme (+ high-contrast
 * dark) × accent × ink 65/88/100 %, with and without `prefers-contrast: more`.
 *
 * - Glyph ink is ≥ 4.5:1 on every allowed composite: the page plus at most one fill (`planHighlights` never stacks two
 *   fills under a word, layout.test.ts), the opaque audio-word pill included. Bars sit below the glyphs' em box
 *   (layout.test.ts), so ink never sits on a bar.
 * - The selection ring is ≥ 3:1 against the page and every fill its pills can carry; the reading cursor's outline is
 *   ≥ 3:1 against the page it runs over.
 * - Bars (a demoted user highlight, the search underline) sit on a page-coloured hairline and read against the page.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrast, hex, parseTokens, stack, type ResolvedTokens, type Rgba } from '$styles/token-harness'

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')
const tokens = parseTokens(read('src/styles/tokens.css'))
const HIGHLIGHTS_CSS = read('src/styles/mushaf/highlights.css')

const THEMES = {
  paper: { 'data-theme': 'paper' },
  sepia: { 'data-theme': 'sepia' },
  night: { 'data-theme': 'night' },
  black: { 'data-theme': 'black' },
  'hc-light': { 'data-theme': 'high_contrast', 'data-hc': 'light' },
  'hc-dark': { 'data-theme': 'high_contrast', 'data-hc': 'dark' },
} as const
type ThemeId = keyof typeof THEMES
const ACCENTS = ['teal', 'emerald', 'blue', 'indigo', 'rose', 'amber'] as const
const INK = ['0.65', '0.88', '1'] as const
const CONTRAST = ['no-preference', 'more'] as const
const COLORS = ['yellow', 'green', 'blue', 'red', 'purple'] as const

/**
 * The `background-color: var(--token)` of each highlight class in highlights.css (outside `@media` blocks), so this
 * test follows the stylesheet instead of restating it.
 */
function backgrounds(css: string): Map<string, string> {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '')
  // Drop the @media blocks (forced colours, reduced motion): a brace counter is enough for this file.
  let out = ''
  let depth = 0
  let skipAt = -1
  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i]
    if (skipAt < 0 && flat.startsWith('@media', i)) skipAt = depth
    if (ch === '{') depth++
    if (skipAt < 0) out += ch
    if (ch === '}') {
      depth--
      if (skipAt >= 0 && depth === skipAt) skipAt = -1
    }
  }
  const map = new Map<string, string>()
  for (const m of out.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const bg = /background-color:\s*var\((--[\w-]+)\)/.exec(m[2] ?? '')?.[1]
    if (!bg) continue
    for (const selector of (m[1] ?? '').split(',')) map.set(selector.trim(), bg)
  }
  return map
}

const BG = backgrounds(HIGHLIGHTS_CSS)

/** The token of every fill the highlight layer can draw under a word, by kind. */
const FILLS: Record<string, string> = {}
for (const c of COLORS) FILLS[`user ${c}`] = BG.get(`.hl-user.hl-${c}`) ?? ''
for (const kind of ['hover', 'selection', 'search', 'audio', 'flash', 'word'])
  FILLS[kind] = BG.get(`.hl-${kind}`) ?? ''
const BARS: Record<string, string> = { search: BG.get('.hl-search-bar') ?? '' }
for (const c of COLORS) BARS[`user ${c}`] = BG.get(`.hl-user-bar.hl-${c}`) ?? ''

describe('highlights.css paints the §8.7 tokens', () => {
  it('maps every fill and bar class to its token', () => {
    expect(FILLS).toEqual({
      'user yellow': '--user-hl-yellow',
      'user green': '--user-hl-green',
      'user blue': '--user-hl-blue',
      'user red': '--user-hl-red',
      'user purple': '--user-hl-purple',
      hover: '--hl-hover',
      selection: '--hl-selection',
      search: '--hl-search',
      audio: '--hl-audio',
      flash: '--hl-audio',
      word: '--hl-word',
    })
    expect(BARS).toEqual({
      search: '--hl-search-solid',
      'user yellow': '--user-hl-yellow-solid',
      'user green': '--user-hl-green-solid',
      'user blue': '--user-hl-blue-solid',
      'user red': '--user-hl-red-solid',
      'user purple': '--user-hl-purple-solid',
    })
  })

  it('draws the selection ring, the cursor outline and the bar hairline with their tokens', () => {
    expect(HIGHLIGHTS_CSS).toMatch(
      /\.hl-selection-ring\s*\{[^}]*inset 0 0 0 max\(1px, calc\(var\(--qfs\) \* 0\.05\)\) var\(--hl-selection-ring\)/,
    )
    expect(HIGHLIGHTS_CSS).toMatch(
      /\.hl-cursor-ring\s*\{[^}]*outline: var\(--focus-ring-w\) solid var\(--focus-ring\)/,
    )
    expect(HIGHLIGHTS_CSS).toMatch(
      /\.hl-user-bar,\s*\.hl-search-bar\s*\{[^}]*box-shadow: 0 0 0 1px var\(--surface-page\)/,
    )
  })
})

const ROWS = (Object.keys(THEMES) as ThemeId[]).flatMap((theme) =>
  ACCENTS.flatMap((accent) =>
    INK.flatMap((ink) =>
      CONTRAST.map(
        (more) => [`${theme} × ${accent} · ink ${ink} · contrast ${more}`, theme, accent, ink, more] as const,
      ),
    ),
  ),
)

function at(theme: ThemeId, accent: string, ink: string, more: (typeof CONTRAST)[number]): ResolvedTokens {
  return tokens.resolve({
    attrs: { lang: 'en', ...THEMES[theme], 'data-accent': accent },
    media: { 'prefers-contrast': more },
    inline: { '--ink-alpha': ink },
  })
}

describe('§8.7 composite contrast', () => {
  it.each(ROWS)('%s', (_label, theme, accent, ink, more) => {
    const t = at(theme, accent, ink, more)
    const page = t.color('--surface-page')
    const glyphs = t.color('--ink')
    const problems: string[] = []
    const need = (name: string, fg: Rgba, bg: Rgba, min: number) => {
      const r = contrast(fg, bg)
      if (r < min) problems.push(`${name}: ${hex(fg)} on ${hex(bg)} = ${r.toFixed(2)}:1 (< ${min})`)
    }
    const over = (kind: string) => stack(page, t.color(FILLS[kind] ?? ''))
    need('ink on page', glyphs, page, 4.5)
    // Ink on the page plus exactly one fill (planHighlights' guarantee), the opaque audio-word pill included.
    for (const kind of Object.keys(FILLS)) need(`ink on ${kind}`, glyphs, over(kind), 4.5)
    // The ring is inset in the selection's own pills, which carry the selection fill or a stronger state fill (a user
    // highlight there is demoted to a bar, and the hover tint is weaker than the selection).
    const ring = t.color('--hl-selection-ring')
    need('selection ring on page', ring, page, 3)
    for (const kind of ['selection', 'search', 'audio', 'flash'])
      need(`selection ring on ${kind}`, ring, over(kind), 3)
    // The reading cursor's outline runs 1 px outside its pills, along the gaps between line bands (page).
    const focus = t.color('--focus-ring')
    need('cursor ring on page', focus, page, 3)
    need('cursor ring on hover', focus, over('hover'), 3)
    expect(problems).toEqual([])
  })

  it.each(ROWS)(
    '%s: bars read against the page hairline that sets them off',
    (_label, theme, accent, ink, more) => {
      const t = at(theme, accent, ink, more)
      const page = t.color('--surface-page')
      const problems: string[] = []
      for (const [name, token] of Object.entries(BARS)) {
        const bar = t.color(token)
        const d = deltaE(bar, page)
        if (d < MIN_BAR_DELTA)
          problems.push(`${name} bar ${hex(bar)} vs page ${hex(page)}: ΔE ${d.toFixed(3)}`)
      }
      expect(problems).toEqual([])
    },
  )
})

/**
 * The margin markers (§8.9, WP8c, read from `src/styles/mushaf/frame.css`): ۞, ۩, the quran-common ornaments with
 * the division's label in their box, and the labels are all drawn in `--marker-ink` on the page. The ornaments' and the
 * print labels' hairlines are thickened with a text stroke in the same colour, so the drawn ink is `--marker-ink`
 * itself, not an antialiased tint of it (the ornaments' darkest pixel 5.9:1 at qfs 18 on paper, WP8c deviation 9; the
 * labels' share of inked pixels at 3:1 is measured by `furniture.browser.test.ts`). Labels are text: 4.5:1 in every
 * theme and contrast preference.
 */
describe('margin markers in --marker-ink (§8.9, §9.2)', () => {
  const FRAME_CSS = read('src/styles/mushaf/frame.css').replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = (selector: string): string => {
    const at = FRAME_CSS.indexOf(`${selector} {`)
    return at < 0 ? '' : FRAME_CSS.slice(at, FRAME_CSS.indexOf('}', at))
  }

  it('draws markers, ornaments and labels in --marker-ink, the ornaments and print labels thickened in that ink', () => {
    expect(rule('  .mk')).toMatch(/color: var\(--marker-ink\)/)
    const ornament = rule('.mk-glyph[data-ornament]')
    expect(ornament).toMatch(
      /-webkit-text-stroke: calc\(var\(--mk-stroke, 0\.5px\) \* var\(--mk-stroke-k, 1\)\) currentColor/,
    )
    expect(ornament).toMatch(/paint-order: stroke fill/)
    const label = rule('.mk-label[data-print]')
    expect(label).toMatch(
      /-webkit-text-stroke: calc\(var\(--mk-label-stroke, 0px\) \* var\(--mk-stroke-k, 1\)\) currentColor/,
    )
    expect(label).toMatch(/paint-order: stroke fill/)
    // Nothing inside a marker sets another colour.
    for (const part of [
      '.mk-glyph',
      '.mk-glyph[data-ornament]',
      '.mk-label',
      '.mk-label[data-print]',
      '.mk-label[data-inside]',
    ])
      expect(rule(part)).not.toMatch(/(^|[^-])color:/)
  })

  const MARKER_ROWS = (Object.keys(THEMES) as ThemeId[]).flatMap((theme) =>
    CONTRAST.map((more) => [`${theme} · contrast ${more}`, theme, more] as const),
  )

  it.each(MARKER_ROWS)('%s: --marker-ink is ≥ 4.5:1 on the page', (_label, theme, more) => {
    const t = at(theme, 'teal', '1', more)
    const ink = t.color('--marker-ink')
    const page = t.color('--surface-page')
    expect(contrast(ink, page), `${hex(ink)} on ${hex(page)}`).toBeGreaterThanOrEqual(4.5)
  })
})

/**
 * A bar is a colour cue on a hairline of page colour, so its hue must read against the page: a perceptual distance in
 * OKLab (luminance contrast alone undersells saturated yellow on cream, which is unmistakable). 0.15 is well past
 * "different colour"; the closest pair, yellow on sepia, is 0.19.
 */
const MIN_BAR_DELTA = 0.15

/** Euclidean distance in OKLab (0 = identical, about 0.02 = just noticeable). */
function deltaE(a: Rgba, b: Rgba): number {
  const [l1, a1, b1] = oklab(a)
  const [l2, a2, b2] = oklab(b)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

/** sRGB (0–255) → OKLab (Björn Ottosson's reference matrices). */
function oklab(c: Rgba): [number, number, number] {
  const lin = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const r = lin(c.r)
  const g = lin(c.g)
  const b = lin(c.b)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

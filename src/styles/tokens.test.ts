/**
 * Design-token tests (ARCHITECTURE §9.1–§9.4, §8.6–§8.7). Owner: WP7a.
 *
 * tokens.css is parsed and resolved per context by ./token-harness (cascade layers, specificity, var(), calc(),
 * color-mix()), so these tests check what the browser computes, not what the file looks like. They cover:
 *   - the §9.2 theme and accent tables, reproduced exactly (values corrected by WP7a are marked `corrected(spec, shipped)`
 *     and explained in docs/deviations/WP7a.md);
 *   - the §9.2 contrast rules for all 5 themes + high-contrast dark × 6 accents;
 *   - the §8.7 highlight composites at ink 65/88/100 %, with and without prefers-contrast: more;
 *   - the §9.3 type scale, the §9.4 scale, motion, elevation and the translucency rule;
 *   - the preference overrides (reduced motion, more contrast, forced colours, reduced transparency);
 *   - the stylesheet wiring (app.css layer order and imports, fonts.css faces, the base.css guards).
 * tokens.browser.test.ts checks the harness itself against real Chromium.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  contrast,
  hex,
  over,
  parseColor,
  parseTokens,
  sameColor,
  stack,
  type ResolvedTokens,
  type Rgba,
  type TokenContext,
} from './token-harness'

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')
const TOKENS_CSS = read('src/styles/tokens.css')
const tokens = parseTokens(TOKENS_CSS)

// ───────────────────────────── contexts ─────────────────────────────

const THEMES = {
  paper: { 'data-theme': 'paper' },
  sepia: { 'data-theme': 'sepia' },
  night: { 'data-theme': 'night' },
  black: { 'data-theme': 'black' },
  'hc-light': { 'data-theme': 'high_contrast', 'data-hc': 'light' },
  'hc-dark': { 'data-theme': 'high_contrast', 'data-hc': 'dark' },
} as const satisfies Record<string, Record<string, string>>
type ThemeId = keyof typeof THEMES
const THEME_IDS = Object.keys(THEMES) as ThemeId[]
const ACCENTS = ['teal', 'emerald', 'blue', 'indigo', 'rose', 'amber'] as const
type AccentId = (typeof ACCENTS)[number]
const INK_LEVELS = ['0.65', '0.88', '1'] as const
const isDarkInk = (theme: ThemeId): boolean => theme === 'night' || theme === 'black'

function ctx(theme: ThemeId, accent: AccentId = 'teal', extra: TokenContext = {}): TokenContext {
  return {
    attrs: { lang: 'en', ...THEMES[theme], 'data-accent': accent, ...extra.attrs },
    media: extra.media,
    inline: { '--ink-alpha': '0.88', ...extra.inline },
  }
}
const at = (theme: ThemeId, accent: AccentId = 'teal', extra: TokenContext = {}): ResolvedTokens =>
  tokens.resolve(ctx(theme, accent, extra))

/** Every theme × accent, as `[label, theme, accent]` rows for `it.each`. */
const MATRIX = THEME_IDS.flatMap((theme) =>
  ACCENTS.map((accent) => [`${theme} × ${accent}`, theme, accent] as const),
)

/** The opaque surfaces text sits on (§9.2 contrast test), composited the way the UI stacks them. */
function surfaces(t: ResolvedTokens): Record<string, Rgba> {
  const app = t.color('--surface-app')
  const page = t.color('--surface-page')
  const raised = t.color('--surface-raised')
  const chrome = over(t.color('--surface-chrome'), app)
  const hover = t.color('--surface-hover')
  const overlay = t.color('--surface-overlay')
  return {
    app,
    'chrome (over app)': chrome,
    page,
    raised,
    sunken: t.color('--surface-sunken'),
    'hover (over raised)': over(hover, raised),
    'hover (over chrome)': over(hover, chrome),
    'overlay (over page)': over(overlay, page),
    'overlay (over app)': over(overlay, app),
  }
}

/** Every pair below `min`, formatted for the failure message. */
function failures(fg: Rgba, bgs: Record<string, Rgba>, min: number): string[] {
  return Object.entries(bgs)
    .map(([name, bg]) => [name, contrast(fg, bg)] as const)
    .filter(([, ratio]) => ratio < min)
    .map(
      ([name, ratio]) => `${hex(fg)} on ${name} ${hex(bgs[name] ?? fg)} = ${ratio.toFixed(2)}:1 (< ${min})`,
    )
}

const pick = (all: Record<string, Rgba>, ...names: string[]): Record<string, Rgba> =>
  Object.fromEntries(
    names.map((n) => {
      const c = all[n]
      if (!c) throw new Error(`unknown surface ${n}`)
      return [n, c]
    }),
  )

const expectColor = (t: ResolvedTokens, name: string, expected: string): void => {
  const actual = t.color(name)
  expect(
    sameColor(actual, parseColor(expected)),
    `${name} is ${hex(actual)} (${t.value(name)}), expected ${expected}`,
  ).toBe(true)
}

/** A §9.2 value WP7a corrected so the table's own contrast rules hold (docs/deviations/WP7a.md): spec, then shipped. */
const corrected = (_spec: string, shipped: string): string => shipped

// ───────────────────────────── structure ─────────────────────────────

describe('tokens.css structure (§9.1)', () => {
  it('declares the app layer order first, then the token sub-layers', () => {
    expect(tokens.layerStatement).toBe('@layer reset, tokens, base, components, mushaf, utilities')
    expect(tokens.layers.slice(0, 9)).toEqual([
      'reset',
      'tokens',
      'base',
      'components',
      'mushaf',
      'utilities',
      'tokens.scale',
      'tokens.theme',
      'tokens.preference',
    ])
  })

  it('keeps every rule inside @layer tokens', () => {
    for (const rule of tokens.rules) expect(rule.layer[0], rule.selectors.join(', ')).toBe('tokens')
  })

  /** The semantic tokens components may use (§9.2–§9.4 plus the WP7a additions documented in WP7a.md). */
  const PUBLIC_COLOURS = [
    '--surface-app',
    '--surface-chrome',
    '--surface-page',
    '--surface-raised',
    '--surface-sunken',
    '--surface-hover',
    '--surface-overlay',
    '--ink',
    '--text',
    '--text-muted',
    '--text-faint',
    '--border',
    '--border-strong',
    '--border-input',
    '--frame-gold',
    '--frame-green',
    '--marker-ink',
    '--ribbon',
    '--frame-band',
    '--cartouche-fill',
    '--surah-header-ink',
    '--danger',
    '--success',
    '--warning',
    '--danger-text',
    '--success-text',
    '--warning-text',
    '--danger-soft',
    '--success-soft',
    '--warning-soft',
    '--danger-ink',
    '--focus-ring',
    '--accent',
    '--accent-text',
    '--accent-strong',
    '--accent-ink',
    '--accent-soft',
    '--selection-bg',
    '--hl-hover',
    '--hl-selection',
    '--hl-selection-ring',
    '--hl-audio',
    '--hl-word',
    '--hl-search',
    '--hl-search-solid',
    '--user-hl-yellow',
    '--user-hl-green',
    '--user-hl-blue',
    '--user-hl-red',
    '--user-hl-purple',
    '--user-hl-yellow-solid',
    '--user-hl-green-solid',
    '--user-hl-blue-solid',
    '--user-hl-red-solid',
    '--user-hl-purple-solid',
    '--glass-fill',
  ]

  it.each(MATRIX)('%s resolves every public colour token to a valid colour', (_label, theme, accent) => {
    const t = at(theme, accent)
    for (const name of PUBLIC_COLOURS) expect(() => t.color(name), name).not.toThrow()
    expect(['light', 'dark']).toContain(t.value('color-scheme'))
    expect(t.number('--spine-a')).toBeGreaterThanOrEqual(0)
  })

  it('resolves before the settings store runs (no data-theme, no data-accent: paper + teal)', () => {
    const t = tokens.resolve({})
    expectColor(t, '--surface-page', '#fdf8ec')
    expectColor(t, '--accent', '#1f7a6d')
    expect(t.number('--ink-alpha')).toBe(0.88)
  })

  it('keeps --ink opaque in every theme and at every ink level (§8.6)', () => {
    for (const theme of THEME_IDS)
      for (const ink of INK_LEVELS) {
        const t = at(theme, 'teal', { inline: { '--ink-alpha': ink } })
        expect(t.color('--ink').a, `${theme} ink ${ink}`).toBe(1)
        expect(t.color('--hl-word').a, `${theme} hl-word ${ink}`).toBe(1)
      }
  })
})

// ───────────────────────────── §9.2 tables ─────────────────────────────

describe('§9.2 colour table', () => {
  type Row = [paper: string, sepia: string, night: string, black: string, hc: string]
  const TABLE: Record<string, Row> = {
    '--surface-app': ['#f3efe6', '#e9dcc3', '#111315', '#000000', '#ffffff'],
    '--surface-page': ['#fdf8ec', '#f6ead2', '#1a1c1f', '#000000', '#ffffff'],
    '--surface-raised': ['#ffffff', '#fbf3e4', '#222529', '#161616', '#ffffff'],
    '--surface-sunken': ['#ebe5d8', '#e2d3b6', '#0c0d0f', '#0a0a0a', '#f0f0f0'],
    '--surface-hover': [
      'rgb(60 45 20 / 0.06)',
      'rgb(70 45 10 / 0.07)',
      'rgb(255 255 255 / 0.06)',
      'rgb(255 255 255 / 0.08)',
      'rgb(0 0 0 / 0.08)',
    ],
    '--surface-overlay': [
      'rgb(255 255 255 / 0.86)',
      'rgb(251 243 228 / 0.90)',
      'rgb(34 37 41 / 0.86)',
      'rgb(22 22 22 / 0.94)',
      '#ffffff',
    ],
    '--text': ['#24211c', '#3a2f22', '#e3ded2', '#d6d1c5', '#000000'],
    '--text-muted': [
      '#6b6457',
      corrected('#695a45', '#625441'),
      '#a39d90',
      corrected('#8f8a80', '#938f85'),
      '#1a1a1a',
    ],
    '--text-faint': ['#8b8273', '#86755a', '#736e65', '#6b6761', '#3a3a3a'],
    '--border': ['#e2dac9', '#dccaa8', '#2c3035', '#2a2a2a', '#000000'],
    '--border-strong': ['#cbbfa6', '#c7b08a', '#3a3f45', '#3d3d3d', '#000000'],
    '--border-input': [
      corrected('#908876', '#8a8371'),
      corrected('#8b7b61', '#85755d'),
      '#6b6f74',
      corrected('#606060', '#636363'),
      '#000000',
    ],
    '--frame-gold': ['#ac8a55', '#9c7638', '#8f7444', '#6e5a36', '#000000'],
    '--frame-green': ['#2f6b5e', '#4b5d3a', '#3f8a7b', '#2f6b5e', '#000000'],
    '--marker-ink': ['#2f6b5e', '#4b5d3a', '#499082', '#4a7e73', '#000000'],
    '--ribbon': ['#8c2f39', '#7d2a2a', '#a34c54', '#854a4f', '#000000'],
    '--frame-band': [
      'rgb(176 141 87 / 0.08)',
      'rgb(156 118 56 / 0.10)',
      'rgb(143 116 68 / 0.10)',
      'rgb(110 90 54 / 0.10)',
      'transparent',
    ],
    '--cartouche-fill': [
      'rgb(176 141 87 / 0.10)',
      'rgb(156 118 56 / 0.12)',
      'rgb(143 116 68 / 0.12)',
      'rgb(110 90 54 / 0.14)',
      '#ffffff',
    ],
    '--surah-header-ink': ['#2f6b5e', '#5a4128', '#c9b98f', '#a8996f', '#000000'],
    '--danger': ['#b3261e', '#a3361f', '#f2827a', '#f2827a', '#a00000'],
    '--success': ['#2e7d32', '#4b6b2a', '#6fcf7a', '#6fcf7a', '#005a00'],
    '--warning': ['#a86400', '#9a5a00', '#f0b24a', '#f0b24a', '#7a4a00'],
  }
  const COLUMNS = ['paper', 'sepia', 'night', 'black', 'hc-light'] as const

  it.each(COLUMNS.map((theme, i) => [theme, i] as const))('%s matches the table', (theme, i) => {
    const t = at(theme)
    for (const [name, row] of Object.entries(TABLE)) expectColor(t, name, row[i] ?? '')
    expect(t.value('color-scheme')).toBe(['light', 'light', 'dark', 'dark', 'light'][i])
    expect(t.number('--spine-a')).toBeCloseTo([0.1, 0.12, 0.35, 0.5, 0][i] ?? -1, 5)
  })

  it('paper, sepia and high contrast use the table ink; night and black precomposite it (§8.6)', () => {
    expectColor(at('paper'), '--ink', '#1c1a16')
    expectColor(at('sepia'), '--ink', '#2e2418')
    expectColor(at('hc-light'), '--ink', '#000000')
    for (const theme of ['night', 'black'] as const)
      for (const ink of INK_LEVELS) {
        const t = at(theme, 'teal', { inline: { '--ink-alpha': ink } })
        const page = t.color('--surface-page')
        const expected = over({ ...parseColor('#e9e4d8'), a: Number(ink) }, page)
        expect(sameColor(t.color('--ink'), expected), `${theme} ink ${ink}: ${hex(t.color('--ink'))}`).toBe(
          true,
        )
      }
  })

  it('high contrast dark overrides surfaces, text, borders, accent and shadows', () => {
    const t = at('hc-dark', 'rose')
    const expected: Record<string, string> = {
      '--surface-page': '#000000',
      '--surface-app': '#000000',
      '--surface-raised': '#000000',
      '--surface-sunken': '#000000',
      '--ink': '#ffffff',
      '--text': '#ffffff',
      '--text-muted': '#e6e6e6',
      '--border': '#ffffff',
      '--border-strong': '#ffffff',
      '--border-input': '#ffffff',
      '--accent': '#ffd600',
      '--accent-text': '#ffd600',
      '--focus-ring': '#ffd600',
      '--accent-ink': '#000000',
    }
    for (const [name, value] of Object.entries(expected)) expectColor(t, name, value)
    expect(t.value('color-scheme')).toBe('dark')
    for (const shadow of ['--shadow-1', '--shadow-2', '--shadow-3'])
      expect(sameShadow(t.value(shadow), '0 0 0 2px #ffffff'), shadow).toBe(true)
  })

  it('--surface-chrome is translucent only with data-chrome="vibrant" in paper and night (note ¹)', () => {
    const opaque: Record<string, string> = {
      paper: '#f3efe6',
      sepia: '#e4d5b8',
      night: '#111315',
      black: '#000000',
      'hc-light': '#ffffff',
      'hc-dark': '#000000',
    }
    const vibrant: Record<string, string> = {
      ...opaque,
      paper: 'rgb(243 239 230 / 0.72)',
      night: 'rgb(17 19 21 / 0.70)',
    }
    for (const theme of THEME_IDS) {
      expectColor(at(theme), '--surface-chrome', opaque[theme] ?? '')
      expectColor(
        at(theme, 'teal', { attrs: { 'data-chrome': 'vibrant' } }),
        '--surface-chrome',
        vibrant[theme] ?? '',
      )
    }
  })
})

describe('§9.2 accents', () => {
  const ACCENT_TABLE: Record<
    AccentId,
    { light: string; textPaper: string; textSepia: string; dark: string; strong: string }
  > = {
    teal: {
      light: '#1f7a6d',
      textPaper: corrected('#1d7366', '#1d7265'),
      textSepia: corrected('#1a675c', '#186056'),
      dark: '#4fb8a8',
      strong: '#6fd3c3',
    },
    emerald: {
      light: '#1e7b4a',
      textPaper: corrected('#1d7547', '#1d7447'),
      textSepia: corrected('#1a693f', '#18623b'),
      dark: '#4cc38a',
      strong: '#74dba7',
    },
    blue: {
      light: '#2563a8',
      textPaper: '#2563a8',
      textSepia: corrected('#235e9f', '#215794'),
      dark: '#6ea8e8',
      strong: '#92c0f2',
    },
    indigo: {
      light: '#4b4fae',
      textPaper: '#4b4fae',
      textSepia: corrected('#4b4fae', '#484ca7'),
      dark: '#9196f0',
      strong: '#b0b4f6',
    },
    rose: {
      light: '#b0405d',
      textPaper: corrected('#af405d', '#ad3f5c'),
      textSepia: corrected('#9d3953', '#93354e'),
      dark: '#ec8aa4',
      strong: '#f3a9bc',
    },
    amber: {
      light: '#9a6410',
      textPaper: corrected('#8e5c0f', '#8d5b0f'),
      textSepia: corrected('#7f530d', '#764d0c'),
      dark: '#e3a948',
      strong: '#efc275',
    },
  }

  it.each(ACCENTS)('%s maps onto every theme', (accent) => {
    const a = ACCENT_TABLE[accent]
    for (const theme of ['paper', 'sepia'] as const) {
      const t = at(theme, accent)
      expectColor(t, '--accent', a.light)
      expectColor(t, '--accent-text', theme === 'paper' ? a.textPaper : a.textSepia)
      expectColor(t, '--accent-ink', '#ffffff')
      expectColor(t, '--focus-ring', a.light)
    }
    for (const theme of ['night', 'black'] as const) {
      const t = at(theme, accent)
      expectColor(t, '--accent', a.dark)
      expectColor(t, '--accent-text', a.dark)
      expectColor(t, '--accent-strong', a.strong)
      expectColor(t, '--accent-ink', '#0b1513')
      expectColor(t, '--focus-ring', a.strong)
    }
    // High contrast forces its own accent whatever data-accent says.
    for (const name of ['--accent', '--accent-text', '--focus-ring']) {
      expectColor(at('hc-light', accent), name, '#0040c0')
      expectColor(at('hc-dark', accent), name, '#ffd600')
    }
  })

  it('derives --accent-soft, --hl-selection-ring and the status soft fills from their base colours', () => {
    for (const [, theme, accent] of MATRIX) {
      const t = at(theme, accent)
      expect(sameColor(t.color('--accent-soft'), { ...t.color('--accent'), a: 0.12 })).toBe(true)
      expect(sameColor(t.color('--hl-selection-ring'), t.color('--accent'))).toBe(true)
      for (const s of ['danger', 'success', 'warning'])
        expect(sameColor(t.color(`--${s}-soft`), { ...t.color(`--${s}`), a: 0.12 }), `${theme} ${s}`).toBe(
          true,
        )
    }
  })
})

describe('§9.2 derived highlight tokens', () => {
  const USER = ['yellow', 'green', 'blue', 'red', 'purple'] as const
  const LIGHT_ALPHA = { yellow: 0.3, green: 0.24, blue: 0.22, red: 0.2, purple: 0.2 }
  const DARK_ALPHA = { yellow: 0.18, green: 0.22, blue: 0.24, red: 0.24, purple: 0.26 }
  const SOLID = { yellow: '#f9a825', green: '#2e7d32', blue: '#1565c0', red: '#c62828', purple: '#6a1b9a' }
  const RGB = { yellow: '#f9a825', green: '#2e7d32', blue: '#1565c0', red: '#c62828', purple: '#6a1b9a' }

  it.each(THEME_IDS)('%s: fills follow the §9.2 formulas (× ink in night/black)', (theme) => {
    for (const ink of INK_LEVELS) {
      const t = at(theme, 'teal', { inline: { '--ink-alpha': ink } })
      const k = isDarkInk(theme) ? Number(ink) : 1
      const accent = t.color('--accent')
      const page = t.color('--surface-page')
      const near = (name: string, expected: Rgba): void =>
        expect(sameColor(t.color(name), expected), `${theme} ink ${ink} ${name}: ${hex(t.color(name))}`).toBe(
          true,
        )
      near('--hl-hover', { ...t.color('--ink'), a: 0.06 * k })
      near('--hl-selection', { ...accent, a: 0.06 * k })
      near('--hl-audio', { ...accent, a: 0.14 * k })
      near('--hl-search', { ...parseColor('rgb(232 176 32)'), a: 0.18 * k })
      const wordP = (isDarkInk(theme) ? 0.26 : 0.28) * k
      near('--hl-word', {
        r: accent.r * wordP + page.r * (1 - wordP),
        g: accent.g * wordP + page.g * (1 - wordP),
        b: accent.b * wordP + page.b * (1 - wordP),
        a: 1,
      })
      const alphas = isDarkInk(theme) || theme === 'hc-dark' ? DARK_ALPHA : LIGHT_ALPHA
      for (const c of USER) {
        near(`--user-hl-${c}`, { ...parseColor(RGB[c]), a: alphas[c] * k })
        expectColor(t, `--user-hl-${c}-solid`, SOLID[c])
      }
    }
  })

  it('uses the dark search underline in night and black', () => {
    expectColor(at('paper'), '--hl-search-solid', '#c98a00')
    expectColor(at('sepia'), '--hl-search-solid', '#c98a00')
    expectColor(at('night'), '--hl-search-solid', '#e8b020')
    expectColor(at('black'), '--hl-search-solid', '#e8b020')
  })
})

// ───────────────────────────── §9.2 contrast ─────────────────────────────

describe('§9.2 contrast', () => {
  describe.each([
    ['default', {}],
    ['prefers-contrast: more', { media: { 'prefers-contrast': 'more' } }],
  ] as const)('%s', (_mode, extra) => {
    it.each(MATRIX)('%s: text tokens ≥ 4.5:1 on every surface they are used on', (_label, theme, accent) => {
      const t = at(theme, accent, extra)
      const all = surfaces(t)
      const bad = [
        '--text',
        '--text-muted',
        '--accent-text',
        '--danger-text',
        '--success-text',
        '--warning-text',
      ].flatMap((name) => failures(t.color(name), all, 4.5).map((f) => `${name}: ${f}`))
      expect(bad).toEqual([])
    })

    it.each(MATRIX)(
      '%s: ink on fills ≥ 4.5:1 (accent-ink, danger-ink, status text on soft)',
      (_label, theme, accent) => {
        const t = at(theme, accent, extra)
        expect(contrast(t.color('--accent-ink'), t.color('--accent'))).toBeGreaterThanOrEqual(4.5)
        expect(contrast(t.color('--danger-ink'), t.color('--danger'))).toBeGreaterThanOrEqual(4.5)
        const all = surfaces(t)
        for (const s of ['danger', 'success', 'warning']) {
          const soft = t.color(`--${s}-soft`)
          const bases = pick(all, 'app', 'chrome (over app)', 'page', 'raised')
          const onSoft = Object.fromEntries(
            Object.entries(bases).map(([n, c]) => [`${s}-soft over ${n}`, over(soft, c)]),
          )
          expect(failures(t.color(`--${s}-text`), onSoft, 4.5)).toEqual([])
        }
      },
    )

    it.each(MATRIX)('%s: non-text ≥ 3:1 (faint text, inputs, focus ring, marks)', (_label, theme, accent) => {
      const t = at(theme, accent, extra)
      const all = surfaces(t)
      const plain = pick(
        all,
        'app',
        'chrome (over app)',
        'page',
        'raised',
        'sunken',
        'overlay (over page)',
        'overlay (over app)',
      )
      const page = t.color('--surface-page')
      expect(failures(t.color('--text-faint'), plain, 3)).toEqual([])
      expect(failures(t.color('--border-input'), plain, 3)).toEqual([])
      expect(failures(t.color('--focus-ring'), all, 3)).toEqual([])
      for (const s of ['--danger', '--success', '--warning'])
        expect(failures(t.color(s), plain, 3)).toEqual([])
      expect(contrast(t.color('--hl-selection-ring'), page)).toBeGreaterThanOrEqual(3)
      expect(contrast(t.color('--marker-ink'), page)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(t.color('--ribbon'), page)).toBeGreaterThanOrEqual(3)
      // §8.8: the surah-header glyph is large text (1.55 qfs) on the cartouche fill.
      expect(
        contrast(t.color('--surah-header-ink'), over(t.color('--cartouche-fill'), page)),
      ).toBeGreaterThanOrEqual(3)
    })

    it.each(MATRIX)('%s: player scrubber (§9.7) ≥ 3:1', (_label, theme, accent) => {
      const t = at(theme, accent, extra)
      const docks: Record<string, Rgba> = {
        'glass over app': over(t.color('--glass-fill'), t.color('--surface-app')),
        'glass over page': over(t.color('--glass-fill'), t.color('--surface-page')),
        'opaque (raised)': t.color('--surface-raised'),
      }
      for (const [name, dock] of Object.entries(docks)) {
        const input = t.color('--border-input')
        const track = over({ ...input, a: 0.4 }, dock)
        const where = `${theme} × ${accent}, dock ${name}`
        expect(contrast(input, dock), `${where}: track outline`).toBeGreaterThanOrEqual(3)
        expect(
          contrast(t.color('--text-muted'), track),
          `${where}: ticks on the track`,
        ).toBeGreaterThanOrEqual(3)
        expect(
          contrast(t.color('--text-muted'), dock),
          `${where}: ticks beyond the track`,
        ).toBeGreaterThanOrEqual(3)
        // The thumb (14 px accent with a 2 px --surface-raised ring) carries the value.
        expect(contrast(t.color('--accent'), dock), `${where}: thumb on the dock`).toBeGreaterThanOrEqual(3)
        const ring = t.color('--surface-raised')
        expect(contrast(t.color('--accent'), ring), `${where}: thumb in its ring`).toBeGreaterThanOrEqual(3)
      }
    })
  })
})

// ───────────────────────────── §8.7 highlight composites ─────────────────────────────

describe('§8.7 highlight composites', () => {
  const FILLS = [
    '--user-hl-yellow',
    '--user-hl-green',
    '--user-hl-blue',
    '--user-hl-red',
    '--user-hl-purple',
    '--hl-search',
    '--hl-selection',
    '--hl-hover',
    '--hl-audio',
    '--hl-word',
  ]
  const ROWS = MATRIX.flatMap(([label, theme, accent]) =>
    INK_LEVELS.flatMap((ink) =>
      (['no-preference', 'more'] as const).map(
        (more) => [`${label} · ink ${ink} · contrast ${more}`, theme, accent, ink, more] as const,
      ),
    ),
  )

  it.each(ROWS)('%s: glyph ink ≥ 4.5:1 on page + any one fill', (_label, theme, accent, ink, more) => {
    const t = at(theme, accent, { inline: { '--ink-alpha': ink }, media: { 'prefers-contrast': more } })
    const page = t.color('--surface-page')
    const glyphs = t.color('--ink')
    const backgrounds = Object.fromEntries([
      ['page', page],
      ...FILLS.map((fill) => [`${fill} over page`, stack(page, t.color(fill))]),
    ])
    expect(failures(glyphs, backgrounds, 4.5)).toEqual([])
    expect(contrast(t.color('--hl-selection-ring'), page)).toBeGreaterThanOrEqual(3)
  })

  it('makes every fill stronger under prefers-contrast: more (× 1.6) and keeps night ink at full brightness', () => {
    const base = at('paper', 'teal')
    const more = at('paper', 'teal', { media: { 'prefers-contrast': 'more' } })
    for (const fill of ['--hl-search', '--hl-selection', '--hl-audio', '--user-hl-yellow'])
      expect(more.color(fill).a).toBeCloseTo(base.color(fill).a * 1.6, 3)
    const dim = at('night', 'teal', {
      inline: { '--ink-alpha': '0.65' },
      media: { 'prefers-contrast': 'more' },
    })
    expectColor(dim, '--ink', '#e9e4d8')
  })
})

// ───────────────────────────── §9.3 typography ─────────────────────────────

describe('§9.3 typography', () => {
  const norm = (v: string): string => v.replace(/'/g, '"').replace(/\s*,\s*/g, ', ')

  it('defines the font stacks verbatim', () => {
    const t = at('paper')
    const raw = (name: string): string => {
      const rule = tokens.rules.find((r) => r.declarations.some((d) => d.prop === name))
      return norm(rule?.declarations.find((d) => d.prop === name)?.value ?? '')
    }
    expect(raw('--font-latin')).toBe(
      '"Inter Variable", "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
    )
    expect(raw('--font-arabic')).toBe(
      '"IBM Plex Sans Arabic", "Noto Naskh Arabic Variable", "Segoe UI", system-ui, sans-serif',
    )
    expect(raw('--font-naskh')).toBe('"Noto Naskh Arabic Variable", "IBM Plex Sans Arabic", serif')
    expect(raw('--font-nastaliq')).toBe('"qd-nastaliq", var(--font-naskh)')
    expect(raw('--font-quran')).toBe('"qd-hafs"')
    expect(raw('--font-mono')).toBe('ui-monospace, "Cascadia Code", "SF Mono", Menlo, monospace')
    expect(norm(t.value('--font-ui'))).toBe(`${norm(t.value('--font-latin'))}, "IBM Plex Sans Arabic"`)
    const ar = at('paper', 'teal', { attrs: { lang: 'ar' } })
    expect(norm(ar.value('--font-ui'))).toBe(`${norm(ar.value('--font-arabic'))}, "Inter Variable"`)
  })

  it('has the Latin and Arabic type columns', () => {
    const SIZES: [string, number, number][] = [
      ['--text-2xs', 11, 13],
      ['--text-xs', 12, 14],
      ['--text-sm', 13, 15],
      ['--text-md', 14, 16],
      ['--text-lg', 16, 18],
      ['--text-xl', 18, 21],
      ['--text-2xl', 22, 26],
      ['--text-3xl', 28, 32],
      ['--text-4xl', 36, 40],
    ]
    const en = at('paper')
    const ar = at('paper', 'teal', { attrs: { lang: 'ar' } })
    for (const [name, latin, arabic] of SIZES) {
      expect(en.value(name)).toBe(`${latin}px`)
      expect(ar.value(name)).toBe(`${arabic}px`)
    }
    const LEADING: [string, number, number][] = [
      ['--leading-ui', 1.45, 1.6],
      ['--leading-reading', 1.7, 1.9],
      ['--leading-naskh', 2, 2],
      ['--leading-quran', 2.25, 2.25],
      ['--leading-nastaliq', 2.4, 2.4],
    ]
    for (const [name, latin, arabic] of LEADING) {
      expect(en.number(name)).toBe(latin)
      expect(ar.number(name)).toBe(arabic)
    }
    expect([en.value('--weight-body'), en.value('--weight-label'), en.value('--weight-title')]).toEqual([
      '400',
      '500',
      '600',
    ])
    expect([en.value('--text-reading'), en.value('--text-quran-reading')]).toEqual(['18px', '28px'])
  })
})

// ───────────────────────────── §9.4 scale ─────────────────────────────

/** Compares box-shadow values layer by layer: lengths numerically, colours by value. */
function sameShadow(a: string, b: string): boolean {
  const layers = (v: string): string[][] =>
    v === 'none'
      ? []
      : v.split(/,(?![^(]*\))/).map((l) => l.trim().match(/(?:rgb|rgba|color-mix)\([^)]*\)|[^\s]+/g) ?? [])
  const la = layers(a.trim())
  const lb = layers(b.trim())
  if (la.length !== lb.length) return false
  return la.every((parts, i) => {
    const other = lb[i] ?? []
    if (parts.length !== other.length) return false
    return parts.every((p, j) => {
      const q = other[j] ?? ''
      if (/^-?[\d.]+(px)?$/.test(p) && /^-?[\d.]+(px)?$/.test(q)) return parseFloat(p) === parseFloat(q)
      if (p === 'currentColor' || q === 'currentColor') return p === q
      return sameColor(parseColor(p), parseColor(q))
    })
  })
}

describe('§9.4 spacing, radius, elevation, motion, z-index, focus', () => {
  const t = at('paper')

  it('has the spacing and radius scales', () => {
    const SPACE = { '0': '0', '0_5': '2px', '1': '4px', '2': '8px', '3': '12px', '4': '16px', '5': '20px' }
    const SPACE2 = { '6': '24px', '8': '32px', '10': '40px', '12': '48px', '16': '64px' }
    for (const [k, v] of Object.entries({ ...SPACE, ...SPACE2 })) expect(t.value(`--space-${k}`)).toBe(v)
    const RADIUS = { xs: '4px', sm: '6px', md: '10px', lg: '14px', xl: '20px', full: '999px', page: '3px' }
    for (const [k, v] of Object.entries(RADIUS)) expect(t.value(`--radius-${k}`)).toBe(v)
  })

  it('has the motion tokens', () => {
    const DUR = {
      instant: '50ms',
      fast: '100ms',
      quick: '150ms',
      normal: '200ms',
      gentle: '250ms',
      slow: '300ms',
      page: '260ms',
      'glyph-swap': '180ms',
    }
    for (const [k, v] of Object.entries(DUR)) expect(t.value(`--dur-${k}`)).toBe(v)
    expect(t.value('--ease-standard')).toBe('cubic-bezier(0.33, 0, 0.67, 1)')
    expect(t.value('--ease-decelerate')).toBe('cubic-bezier(0.1, 0.9, 0.2, 1)')
    expect(t.value('--ease-accelerate')).toBe('cubic-bezier(0.9, 0.1, 1, 0.2)')
    expect(t.value('--ease-emphasized')).toBe('cubic-bezier(0.2, 0, 0, 1)')
  })

  it('has the z-index ladder and focus geometry', () => {
    const Z = {
      canvas: 0,
      chrome: 10,
      sidebar: 20,
      player: 30,
      popover: 40,
      menu: 50,
      dialog: 60,
      palette: 70,
      toast: 80,
      tooltip: 90,
      drag: 100,
    }
    for (const [k, v] of Object.entries(Z)) expect(t.number(`--z-${k}`)).toBe(v)
    expect([t.value('--focus-ring-w'), t.value('--focus-ring-offset')]).toEqual(['2px', '2px'])
    expect(at('hc-light').value('--focus-ring-w')).toBe('3px')
    expect(at('hc-dark').value('--focus-ring-w')).toBe('3px')
  })

  it('has the per-theme shadows', () => {
    const LIGHT = {
      '--shadow-1': '0 1px 2px rgb(60 45 20 / 0.08), 0 0 0 1px rgb(60 45 20 / 0.04)',
      '--shadow-2': '0 4px 12px rgb(60 45 20 / 0.10), 0 0 0 1px rgb(60 45 20 / 0.05)',
      '--shadow-3': '0 16px 40px rgb(60 45 20 / 0.16), 0 0 0 1px rgb(60 45 20 / 0.06)',
      '--shadow-page': '0 1px 1px rgb(60 45 20 / 0.06), 0 8px 28px rgb(60 45 20 / 0.10)',
    }
    const NIGHT = {
      '--shadow-1': '0 0 0 1px rgb(255 255 255 / 0.05)',
      '--shadow-2': '0 0 0 1px rgb(255 255 255 / 0.06), 0 8px 24px rgb(0 0 0 / 0.45)',
      '--shadow-3': '0 0 0 1px rgb(255 255 255 / 0.07), 0 20px 50px rgb(0 0 0 / 0.6)',
      '--shadow-page': '0 0 0 1px rgb(255 255 255 / 0.04)',
    }
    const BLACK = {
      '--shadow-1': '0 0 0 1px #2a2a2a',
      '--shadow-2': '0 0 0 1px #333333',
      '--shadow-3': '0 0 0 1px #3d3d3d',
      '--shadow-page': 'none',
    }
    const HC = {
      '--shadow-1': '0 0 0 2px #000000',
      '--shadow-2': '0 0 0 2px #000000',
      '--shadow-3': '0 0 0 2px #000000',
      '--shadow-page': '0 0 0 2px currentColor',
    }
    const HC_DARK = {
      '--shadow-1': '0 0 0 2px #ffffff',
      '--shadow-2': '0 0 0 2px #ffffff',
      '--shadow-3': '0 0 0 2px #ffffff',
      '--shadow-page': '0 0 0 2px currentColor',
    }
    const EXPECTED: Record<ThemeId, Record<string, string>> = {
      paper: LIGHT,
      sepia: LIGHT,
      night: NIGHT,
      black: BLACK,
      'hc-light': HC,
      'hc-dark': HC_DARK,
    }
    for (const theme of THEME_IDS) {
      const r = at(theme)
      for (const [name, value] of Object.entries(EXPECTED[theme]))
        expect(sameShadow(r.value(name), value), `${theme} ${name}: ${r.value(name)}`).toBe(true)
    }
  })
})

// ───────────────────────────── preferences ─────────────────────────────

describe('preferences', () => {
  const DURATIONS = ['instant', 'fast', 'quick', 'normal', 'gentle', 'slow', 'page', 'glyph-swap'].map(
    (d) => `--dur-${d}`,
  )

  it('zeroes every duration under reduced motion (setting, or OS unless the user chose full)', () => {
    const zero = (t: ResolvedTokens): boolean => DURATIONS.every((d) => t.value(d) === '0ms')
    const reduceOs = { media: { 'prefers-reduced-motion': 'reduce' } } as const
    expect(zero(at('paper', 'teal', { attrs: { 'data-motion': 'reduce' } }))).toBe(true)
    expect(zero(at('paper', 'teal', reduceOs))).toBe(true)
    expect(zero(at('paper', 'teal', { ...reduceOs, attrs: { 'data-motion': 'reduce' } }))).toBe(true)
    expect(zero(at('paper', 'teal', { ...reduceOs, attrs: { 'data-motion': 'full' } }))).toBe(false)
    expect(zero(at('paper', 'teal', { attrs: { 'data-motion': 'full' } }))).toBe(false)
    expect(at('night', 'teal', { ...reduceOs, attrs: { 'data-motion': 'full' } }).value('--dur-page')).toBe(
      '260ms',
    )
  })

  it('prefers-contrast: more mutes nothing and strengthens borders in every theme', () => {
    for (const theme of THEME_IDS) {
      const t = at(theme, 'teal', { media: { 'prefers-contrast': 'more' } })
      expect(sameColor(t.color('--text-muted'), t.color('--text')), theme).toBe(true)
      expect(sameColor(t.color('--border'), t.color('--border-strong')), theme).toBe(true)
    }
  })

  it('forced colours map ink, page, frame and focus to system colours and clear every fill', () => {
    const t = at('sepia', 'rose', { media: { 'forced-colors': 'active' } })
    expect(t.value('--ink')).toBe('CanvasText')
    expect(t.value('--surface-page')).toBe('Canvas')
    expect(t.value('--focus-ring')).toBe('Highlight')
    for (const name of ['--frame-gold', '--frame-green', '--marker-ink', '--surah-header-ink', '--ribbon'])
      expect(t.value(name), name).toBe('CanvasText')
    const fills = [
      '--hl-hover',
      '--hl-selection',
      '--hl-audio',
      '--hl-word',
      '--hl-search',
      '--accent-soft',
      ...['yellow', 'green', 'blue', 'red', 'purple'].map((c) => `--user-hl-${c}`),
    ]
    for (const name of fills) expect(t.value(name), name).toBe('transparent')
    expect(t.value('--hl-selection-ring')).toBe('Highlight')
  })

  it('applies the translucency rule (§9.4): glass only on Windows/macOS without reduced transparency', () => {
    for (const theme of THEME_IDS) {
      const glass = at(theme)
      expect(sameColor(glass.color('--glass-fill'), glass.color('--surface-overlay'))).toBe(true)
      expect(glass.value('--backdrop-dock')).toBe('blur(24px) saturate(1.4)')
      expect(glass.value('--backdrop-palette')).toBe('blur(20px) saturate(1.4)')
      for (const extra of [
        { media: { 'prefers-reduced-transparency': 'reduce' } },
        { attrs: { 'data-platform': 'linux' } },
      ] as const) {
        const opaque = at(theme, 'teal', extra)
        expect(sameColor(opaque.color('--glass-fill'), opaque.color('--surface-raised')), theme).toBe(true)
        expect(opaque.color('--glass-fill').a).toBe(1)
        expect([opaque.value('--backdrop-dock'), opaque.value('--backdrop-palette')]).toEqual([
          'none',
          'none',
        ])
      }
      for (const platform of ['windows', 'macos'])
        expect(at(theme, 'teal', { attrs: { 'data-platform': platform } }).value('--backdrop-dock')).not.toBe(
          'none',
        )
    }
  })
})

// ───────────────────────────── stylesheet wiring ─────────────────────────────

describe('stylesheet wiring', () => {
  const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')
  /** The declarations of the first flat rule whose selector is exactly `selector`. */
  function declarations(css: string, selector: string): Record<string, string> {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^{}]*)\\}`).exec(strip(css))
    if (!m || m[1] === undefined) throw new Error(`no rule for ${selector}`)
    return Object.fromEntries(
      m[1]
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const i = d.indexOf(':')
          return [d.slice(0, i).trim(), d.slice(i + 1).trim()]
        }),
    )
  }

  it('app.css declares the layer order, then imports tokens, fonts, base and the Mushaf styles', () => {
    const css = strip(read('src/app.css'))
    const statements = css.match(/@(?:layer|import)[^;{]*;/g) ?? []
    expect(statements.map((s) => s.replace(/\s+/g, ' '))).toEqual([
      '@layer reset, tokens, base, components, mushaf, utilities;',
      "@import './styles/tokens.css';",
      "@import './styles/fonts.css';",
      "@import './styles/base.css';",
      "@import './styles/mushaf/index.css';",
    ])
    expect(css.replace(/@(?:layer|import)[^;{]*;/g, '').trim()).toBe('')
  })

  it('fonts.css imports the §9.3 UI faces and declares qd-hafs (§8.5) and qd-print-labels (LEAD 25)', () => {
    const css = strip(read('src/styles/fonts.css'))
    const imports = [...css.matchAll(/@import\s+'([^']+)'/g)].map((m) => m[1])
    expect(imports).toEqual([
      '@fontsource-variable/inter/wght.css',
      '@fontsource-variable/noto-naskh-arabic/wght.css',
      '@fontsource/ibm-plex-sans-arabic/400.css',
      '@fontsource/ibm-plex-sans-arabic/500.css',
      '@fontsource/ibm-plex-sans-arabic/600.css',
    ])
    for (const file of imports)
      expect(existsSync(resolve(process.cwd(), 'node_modules', file ?? '')), file).toBe(true)
    // Both bundled faces block (main.ts awaits them before the first paint), and their files ship in public/fonts.
    const faces = [...css.matchAll(/@font-face\s*\{([^{}]*)\}/g)].map((m) =>
      Object.fromEntries(
        (m[1] ?? '')
          .split(';')
          .map((d) => d.trim())
          .filter(Boolean)
          .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]),
      ),
    )
    expect(faces).toEqual([
      {
        'font-family': "'qd-hafs'",
        src: "url('/fonts/KFGQPC-Hafs-V30.ttf') format('truetype')",
        'font-display': 'block',
      },
      {
        'font-family': "'qd-print-labels'",
        src: "url('/fonts/QuranPrintLabels.otf') format('opentype')",
        'font-display': 'block',
      },
    ])
    expect(existsSync(resolve(process.cwd(), 'public/fonts/QuranPrintLabels.otf'))).toBe(true)
    expect(existsSync(resolve(process.cwd(), 'public/fonts/QuranPrintLabels.LICENSE.txt'))).toBe(true)
  })

  it('base.css carries the §9.3 .quran-text guard verbatim (enforced with !important)', () => {
    const decls = declarations(read('src/styles/base.css'), '.quran-text')
    expect(decls).toEqual({
      'font-weight': '400 !important',
      'font-style': 'normal !important',
      'font-synthesis': 'none !important',
      'letter-spacing': '0 !important',
      'word-spacing': 'normal !important',
      'text-transform': 'none !important',
      'font-variant-ligatures': 'normal !important',
      'font-feature-settings': 'normal !important',
      'font-kerning': 'normal !important',
      'text-shadow': 'none !important',
    })
  })

  it('base.css has the §9.4 focus ring, RTL icon mirroring and the Arabic letter-spacing guard', () => {
    const css = read('src/styles/base.css')
    expect(declarations(css, ':focus-visible')).toEqual({
      outline: 'var(--focus-ring-w) solid var(--focus-ring)',
      'outline-offset': 'var(--focus-ring-offset)',
    })
    expect(declarations(css, '.icon-dir')).toEqual({ scale: 'var(--_icon-mirror, none)' })
    expect(declarations(css, "[dir='rtl']")).toEqual({ '--_icon-mirror': '-1 1' })
    expect(declarations(css, "[dir='ltr']")).toEqual({ '--_icon-mirror': 'none' })
    expect(strip(css)).not.toContain(':dir(')
    expect(declarations(css, ':lang(ar)')).toEqual({ 'letter-spacing': '0 !important' })
  })

  it('index.html carries no <style> element (§6.4)', () => {
    expect(read('index.html')).not.toMatch(/<style[\s>]/i)
  })
})

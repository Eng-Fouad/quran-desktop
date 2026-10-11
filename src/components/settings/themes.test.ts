/**
 * The theme and accent pickers draw from a table (`themes.ts`), because tokens.css resolves only the active theme.
 * These tests resolve tokens.css for every theme and accent with WP7a's token harness, so the miniatures always match
 * the real themes.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hex, parseTokens } from '../../styles/token-harness'
import {
  ACCENT_SWATCHES,
  accentSwatch,
  HIGH_CONTRAST_ACCENT,
  THEME_SWATCHES,
  themeSwatch,
  type ThemeSwatch,
} from './themes'

const tokens = parseTokens(readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8'))

const CONTEXTS: Record<keyof typeof THEME_SWATCHES, Record<string, string>> = {
  paper: { 'data-theme': 'paper' },
  sepia: { 'data-theme': 'sepia' },
  night: { 'data-theme': 'night' },
  black: { 'data-theme': 'black' },
  high_contrast: { 'data-theme': 'high_contrast', 'data-hc': 'light' },
  high_contrast_dark: { 'data-theme': 'high_contrast', 'data-hc': 'dark' },
}

const TOKEN_OF: Record<Exclude<keyof ThemeSwatch, 'dark'>, string> = {
  app: '--surface-app',
  page: '--surface-page',
  text: '--text',
  muted: '--text-muted',
  border: '--border',
  gold: '--frame-gold',
}

describe('theme swatches', () => {
  it.each(Object.keys(CONTEXTS) as (keyof typeof THEME_SWATCHES)[])('%s matches tokens.css', (theme) => {
    const resolved = tokens.resolve({ attrs: CONTEXTS[theme] })
    const swatch = THEME_SWATCHES[theme]
    for (const [field, token] of Object.entries(TOKEN_OF) as [keyof typeof TOKEN_OF, string][]) {
      expect(swatch[field], `${theme} ${token}`).toBe(hex(resolved.color(token)))
    }
    expect(swatch.dark).toBe(resolved.value('color-scheme') === 'dark')
  })

  it('draws high contrast as the OS asks (light or dark), like the app (§9.1)', () => {
    expect(themeSwatch('high_contrast', false)).toBe(THEME_SWATCHES.high_contrast)
    expect(themeSwatch('high_contrast', true)).toBe(THEME_SWATCHES.high_contrast_dark)
    expect(themeSwatch('night', false)).toBe(THEME_SWATCHES.night)
  })
})

describe('accent swatches', () => {
  it.each(Object.keys(ACCENT_SWATCHES) as (keyof typeof ACCENT_SWATCHES)[])(
    '%s matches tokens.css',
    (accent) => {
      const light = tokens.resolve({ attrs: { 'data-theme': 'paper', 'data-accent': accent } })
      const dark = tokens.resolve({ attrs: { 'data-theme': 'night', 'data-accent': accent } })
      expect(ACCENT_SWATCHES[accent].light).toBe(hex(light.color('--accent')))
      expect(ACCENT_SWATCHES[accent].dark).toBe(hex(dark.color('--accent')))
    },
  )

  it('forces the high-contrast accent, whatever the setting', () => {
    for (const [hc, colour] of [
      ['light', HIGH_CONTRAST_ACCENT.light],
      ['dark', HIGH_CONTRAST_ACCENT.dark],
    ] as const) {
      const resolved = tokens.resolve({
        attrs: { 'data-theme': 'high_contrast', 'data-hc': hc, 'data-accent': 'rose' },
      })
      expect(colour).toBe(hex(resolved.color('--accent')))
    }
    expect(accentSwatch('high_contrast', 'rose', false)).toBe(HIGH_CONTRAST_ACCENT.light)
    expect(accentSwatch('high_contrast', 'rose', true)).toBe(HIGH_CONTRAST_ACCENT.dark)
  })

  it('uses the light shade on paper and sepia and the dark one on night and black', () => {
    expect(accentSwatch('sepia', 'blue', false)).toBe(ACCENT_SWATCHES.blue.light)
    expect(accentSwatch('black', 'blue', false)).toBe(ACCENT_SWATCHES.blue.dark)
  })
})

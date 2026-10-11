/**
 * Colours of the theme and accent pickers (Settings › Appearance). Owner: WP12b.
 *
 * Components use semantic tokens only (§9.1), but a picker has to show the themes that are *not* applied, and tokens.css
 * resolves only the active theme on `:root`. So the cards draw from this table, which holds the shipped §9.2 values of
 * the few tokens a miniature needs. `themes.test.ts` resolves tokens.css for every theme and accent with WP7a's token
 * harness and fails on any difference, so the table cannot drift from the real themes.
 */
import type { Accent, ThemeMode } from '$lib/ipc/bindings'

/** The tokens a theme miniature is drawn with. */
export interface ThemeSwatch {
  /** `--surface-app`: the window around the page. */
  app: string
  /** `--surface-page`: the paper. */
  page: string
  /** `--text`: the lines of text. */
  text: string
  /** `--text-muted`: the secondary lines. */
  muted: string
  /** `--border`: hairlines. */
  border: string
  /** `--frame-gold`: the page frame. */
  gold: string
  /** Whether the theme is dark (`color-scheme`). */
  dark: boolean
}

export type ResolvedThemeName = Exclude<ThemeMode, 'system'>

export const THEME_SWATCHES: Readonly<Record<ResolvedThemeName | 'high_contrast_dark', ThemeSwatch>> = {
  paper: {
    app: '#f3efe6',
    page: '#fdf8ec',
    text: '#24211c',
    muted: '#6b6457',
    border: '#e2dac9',
    gold: '#ac8a55',
    dark: false,
  },
  sepia: {
    app: '#e9dcc3',
    page: '#f6ead2',
    text: '#3a2f22',
    muted: '#625441',
    border: '#dccaa8',
    gold: '#9c7638',
    dark: false,
  },
  night: {
    app: '#111315',
    page: '#1a1c1f',
    text: '#e3ded2',
    muted: '#a39d90',
    border: '#2c3035',
    gold: '#8f7444',
    dark: true,
  },
  black: {
    app: '#000000',
    page: '#000000',
    text: '#d6d1c5',
    muted: '#938f85',
    border: '#2a2a2a',
    gold: '#6e5a36',
    dark: true,
  },
  high_contrast: {
    app: '#ffffff',
    page: '#ffffff',
    text: '#000000',
    muted: '#1a1a1a',
    border: '#000000',
    gold: '#000000',
    dark: false,
  },
  high_contrast_dark: {
    app: '#000000',
    page: '#000000',
    text: '#ffffff',
    muted: '#e6e6e6',
    border: '#ffffff',
    gold: '#ffffff',
    dark: true,
  },
}

/** `--accent` of each accent in the light themes (paper, sepia) and in the dark ones (night, black). */
export const ACCENT_SWATCHES: Readonly<Record<Accent, { light: string; dark: string }>> = {
  teal: { light: '#1f7a6d', dark: '#4fb8a8' },
  emerald: { light: '#1e7b4a', dark: '#4cc38a' },
  blue: { light: '#2563a8', dark: '#6ea8e8' },
  indigo: { light: '#4b4fae', dark: '#9196f0' },
  rose: { light: '#b0405d', dark: '#ec8aa4' },
  amber: { light: '#9a6410', dark: '#e3a948' },
}

/** High contrast forces its own accent, whatever the accent setting says (§9.2). */
export const HIGH_CONTRAST_ACCENT = { light: '#0040c0', dark: '#ffd600' } as const

/** The swatch a theme is drawn with; high contrast follows the OS light/dark preference like the app (§9.1). */
export function themeSwatch(theme: ResolvedThemeName, systemDark: boolean): ThemeSwatch {
  return theme === 'high_contrast' && systemDark ? THEME_SWATCHES.high_contrast_dark : THEME_SWATCHES[theme]
}

/** The accent colour a theme shows for an accent setting. */
export function accentSwatch(theme: ResolvedThemeName, accent: Accent, systemDark: boolean): string {
  if (theme === 'high_contrast') return systemDark ? HIGH_CONTRAST_ACCENT.dark : HIGH_CONTRAST_ACCENT.light
  const swatch = ACCENT_SWATCHES[accent]
  return THEME_SWATCHES[theme].dark ? swatch.dark : swatch.light
}

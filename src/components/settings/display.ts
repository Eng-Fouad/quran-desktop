/**
 * The reading-display popover (`DisplayPopover`, owner request 2026-10-11): which of Settings' rows it shows and where
 * its "All settings" leads. Owner: WP12b. Only what changes the page on screen is offered, with Settings' own rules,
 * which live here for both: the themes that dim their ink and the note under ink brightness (Settings › Appearance),
 * and the page layouts (Settings › Mushaf).
 */
import type { TextKey } from '$lib/contracts/i18n'
import type { PageMode, ReadingMode } from '$lib/ipc/bindings'
import type { ResolvedThemeName } from './themes'
import type { SettingsSection } from './meta'

/** The popover's width (px), as the app's other chrome-button popovers (the reciter picker is 360). */
export const DISPLAY_W = 340

/** A row of the popover, top to bottom in this order. */
export type DisplayRow = 'theme' | 'ink' | 'style' | 'pages' | 'textSize'

export interface DisplayContext {
  mode: ReadingMode
  /** The theme that shows (`settings.resolvedTheme`). */
  theme: ResolvedThemeName
  /** The study pane shows its Translation tab (translation text beside the Mushaf). */
  paneTranslation: boolean
}

/** The page layouts Settings › Mushaf offers, in its order; the popover offers the same. */
export const PAGE_MODES: readonly PageMode[] = ['auto', 'single', 'spread']

/** The system setting under which the ink stays at full brightness (tokens.css, WP7a deviation 4). */
export const MORE_CONTRAST = '(prefers-contrast: more)'

/** Whether a theme dims its ink, so Settings' ink brightness applies (Night and Black, §9.2). */
export function dimsInk(theme: ResolvedThemeName): boolean {
  return theme === 'night' || theme === 'black'
}

/**
 * The note under ink brightness, if any: on a theme that dims its ink, "increase contrast" (`MORE_CONTRAST`) keeps the
 * ink at full brightness, and the row says so (Settings › Appearance and the popover alike).
 */
export function inkNoteKey(theme: ResolvedThemeName, moreContrast: boolean): TextKey | undefined {
  return dimsInk(theme) && moreContrast ? 'settings.appearance.inkContrast' : undefined
}

/**
 * The rows that change what is on screen: the theme always; ink brightness on Night and Black; the Mushaf style and
 * page layout beside the Mushaf only (translation mode sets its Arabic in Hafs, in one column); the translation text
 * size wherever translation text shows (translation mode, or the study pane's Translation tab).
 */
export function displayRows(c: DisplayContext): DisplayRow[] {
  const rows: DisplayRow[] = ['theme']
  if (dimsInk(c.theme)) rows.push('ink')
  if (c.mode === 'mushaf') rows.push('style', 'pages')
  if (c.mode === 'translation' || c.paneTranslation) rows.push('textSize')
  return rows
}

/** The Settings section "All settings" opens on: the reading mode's own (Mushaf, or Translations with its text size). */
export function displaySection(mode: ReadingMode): SettingsSection {
  return mode === 'mushaf' ? 'mushaf' : 'translations'
}

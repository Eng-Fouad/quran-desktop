/**
 * The reading-display popover, pure parts (§9.7; owner request 2026-10-11): which of Settings' rows it shows in each
 * reading mode and theme (`displayRows`), the rules it shares with Settings (`dimsInk`, `inkNoteKey`, `PAGE_MODES`),
 * and where "All settings" leads (`displaySection`).
 */
import { describe, expect, it } from 'vitest'
import { dimsInk, DISPLAY_W, displayRows, displaySection, inkNoteKey, PAGE_MODES } from './display'
import { SETTINGS_SECTIONS } from './meta'

describe('displayRows', () => {
  it('beside the Mushaf: the theme, the style and the pages; the text size only with the pane on Translation', () => {
    expect(displayRows({ mode: 'mushaf', theme: 'paper', paneTranslation: false })).toEqual([
      'theme',
      'style',
      'pages',
    ])
    expect(displayRows({ mode: 'mushaf', theme: 'sepia', paneTranslation: true })).toEqual([
      'theme',
      'style',
      'pages',
      'textSize',
    ])
  })

  it('in translation mode: the theme and the text size, never the Mushaf style or pages', () => {
    expect(displayRows({ mode: 'translation', theme: 'paper', paneTranslation: false })).toEqual([
      'theme',
      'textSize',
    ])
    // The study pane changes nothing there: the text size is shown once.
    expect(displayRows({ mode: 'translation', theme: 'high_contrast', paneTranslation: true })).toEqual([
      'theme',
      'textSize',
    ])
  })

  it('adds the ink brightness on Night and Black only, right after the theme', () => {
    expect(displayRows({ mode: 'mushaf', theme: 'night', paneTranslation: false })).toEqual([
      'theme',
      'ink',
      'style',
      'pages',
    ])
    expect(displayRows({ mode: 'translation', theme: 'black', paneTranslation: false })).toEqual([
      'theme',
      'ink',
      'textSize',
    ])
    for (const theme of ['paper', 'sepia', 'high_contrast'] as const) {
      expect(displayRows({ mode: 'mushaf', theme, paneTranslation: false })).not.toContain('ink')
    }
  })
})

describe('dimsInk', () => {
  it('holds for the two dark reading themes (§9.2), as Settings › Appearance', () => {
    expect(dimsInk('night')).toBe(true)
    expect(dimsInk('black')).toBe(true)
    expect(dimsInk('paper')).toBe(false)
    expect(dimsInk('sepia')).toBe(false)
    expect(dimsInk('high_contrast')).toBe(false)
  })
})

describe('inkNoteKey', () => {
  it('notes the full-brightness ink under "increase contrast", on Night and Black only', () => {
    expect(inkNoteKey('night', true)).toBe('settings.appearance.inkContrast')
    expect(inkNoteKey('black', true)).toBe('settings.appearance.inkContrast')
    expect(inkNoteKey('night', false)).toBeUndefined()
    for (const theme of ['paper', 'sepia', 'high_contrast'] as const)
      expect(inkNoteKey(theme, true)).toBeUndefined()
  })
})

describe('PAGE_MODES', () => {
  it('lists every page layout once, in the order Settings › Mushaf and the popover offer them', () => {
    expect(PAGE_MODES).toEqual(['auto', 'single', 'spread'])
  })
})

describe('displaySection', () => {
  it("opens Settings on the reading mode's own section", () => {
    expect(displaySection('mushaf')).toBe('mushaf')
    expect(displaySection('translation')).toBe('translations')
    expect(SETTINGS_SECTIONS).toContain(displaySection('mushaf'))
    expect(SETTINGS_SECTIONS).toContain(displaySection('translation'))
  })
})

describe('DISPLAY_W', () => {
  it('is the popover width the spec asks for (about 340 px)', () => {
    expect(DISPLAY_W).toBe(340)
  })
})

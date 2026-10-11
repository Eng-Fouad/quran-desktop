import { describe, expect, it } from 'vitest'
import {
  allowsTranslucency,
  CAPTION_GLYPHS,
  captionGlyphFont,
  isModPressed,
  modKeyLabel,
  titleBarKind,
  TRAFFIC_LIGHT_INSET,
} from './platform'

describe('platform helpers', () => {
  it('maps Mod to ⌘ on macOS and Ctrl elsewhere', () => {
    expect(modKeyLabel('macos')).toBe('⌘')
    expect(modKeyLabel('windows')).toBe('Ctrl')
    const e = new KeyboardEvent('keydown', { key: 'k', metaKey: true })
    expect(isModPressed(e, 'macos')).toBe(true)
    expect(isModPressed(e, 'linux')).toBe(false)
    expect(isModPressed(new MouseEvent('click', { ctrlKey: true }), 'windows')).toBe(true)
  })

  it('allows translucency on Windows and macOS only (§9.4)', () => {
    expect(allowsTranslucency('windows')).toBe(true)
    expect(allowsTranslucency('macos')).toBe(true)
    expect(allowsTranslucency('linux')).toBe(false)
  })

  it('describes the title bar per platform (§9.6)', () => {
    expect(titleBarKind('windows')).toEqual({ drag: true, windowControls: true, trafficLightInset: 0 })
    expect(titleBarKind('macos')).toEqual({
      drag: true,
      windowControls: false,
      trafficLightInset: TRAFFIC_LIGHT_INSET,
    })
    expect(titleBarKind('linux')).toEqual({ drag: false, windowControls: false, trafficLightInset: 0 })
    expect(TRAFFIC_LIGHT_INSET).toBe(78)
  })

  it('names the Segoe caption glyphs, and falls back to SVG without canvas text measurement', () => {
    expect(Object.values(CAPTION_GLYPHS).map((g) => g.codePointAt(0)?.toString(16))).toEqual([
      'e921',
      'e922',
      'e923',
      'e8bb',
    ])
    // jsdom has no OffscreenCanvas: no font is detected, and the answer is cached.
    expect(captionGlyphFont()).toBeNull()
    expect(captionGlyphFont()).toBeNull()
  })
})

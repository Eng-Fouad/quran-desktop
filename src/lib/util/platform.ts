/**
 * Platform helpers. The platform comes from `AppInfo.platform` (bootstrap), never from user-agent sniffing; these
 * helpers take it as an argument. Owner: WP7c (created by WP0C).
 */
import type { Platform } from '$lib/ipc/bindings'

/** `Mod` is ⌘ on macOS and Ctrl elsewhere (§7.7). */
export function modKeyLabel(platform: Platform): string {
  return platform === 'macos' ? '⌘' : 'Ctrl'
}

/** Whether the `Mod` modifier of an event is down on this platform. */
export function isModPressed(e: KeyboardEvent | MouseEvent, platform: Platform): boolean {
  return platform === 'macos' ? e.metaKey : e.ctrlKey
}

/** Whether translucent chrome (`backdrop-filter`) may be used (§9.4: Windows and macOS only). */
export function allowsTranslucency(platform: Platform): boolean {
  return platform !== 'linux'
}

/** Which title bar the platform gets (§9.6). */
export interface TitleBarKind {
  /** The bar is the window's drag region (custom or overlay title bar): Windows and macOS. */
  drag: boolean
  /** Custom caption buttons (minimise, maximise, close): Windows only (`decorations: false`). */
  windowControls: boolean
  /** Space kept free on the physical left for the traffic lights (macOS overlay title bar), in px. */
  trafficLightInset: number
}

/** The macOS traffic-light reserve (§9.6; `trafficLightPosition` x 16 + three 12 px lights with 8 px gaps + margin). */
export const TRAFFIC_LIGHT_INSET = 78

export function titleBarKind(platform: Platform): TitleBarKind {
  switch (platform) {
    case 'windows':
      return { drag: true, windowControls: true, trafficLightInset: 0 }
    case 'macos':
      return { drag: true, windowControls: false, trafficLightInset: TRAFFIC_LIGHT_INSET }
    case 'linux':
      // Native decorations above a plain 40 px toolbar.
      return { drag: false, windowControls: false, trafficLightInset: 0 }
  }
}

/** Windows icon fonts carrying the caption glyphs (§9.6): Windows 11, then Windows 10. */
export const CAPTION_FONTS = ['Segoe Fluent Icons', 'Segoe MDL2 Assets'] as const
export type CaptionFont = (typeof CAPTION_FONTS)[number]

/** The caption glyph code points (Segoe Fluent Icons / MDL2 Assets). */
export const CAPTION_GLYPHS = {
  minimize: String.fromCodePoint(0xe921),
  maximize: String.fromCodePoint(0xe922),
  restore: String.fromCodePoint(0xe923),
  close: String.fromCodePoint(0xe8bb),
} as const

let captionFont: CaptionFont | null | undefined

/**
 * The installed icon font that has the caption glyphs, or `null` (then the controls draw SVG). Detected once by measuring
 * the glyphs in each font against two different fallbacks: a missing font renders them with the fallback, so the two
 * measurements differ; an installed one renders them itself, so they agree (`document.fonts.check` cannot tell, it
 * reports load state, not presence).
 */
export function captionGlyphFont(): CaptionFont | null {
  if (captionFont !== undefined) return captionFont
  captionFont = null
  try {
    const ctx = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(8, 8).getContext('2d') : null
    if (ctx === null) return captionFont
    const probe = Object.values(CAPTION_GLYPHS).join('')
    const width = (font: string) => {
      ctx.font = font
      return ctx.measureText(probe).width
    }
    for (const family of CAPTION_FONTS) {
      const a = width(`20px "${family}", monospace`)
      const b = width(`20px "${family}", serif`)
      if (a === b && (a !== width('20px monospace') || b !== width('20px serif'))) {
        captionFont = family
        break
      }
    }
  } catch {
    // No canvas text measurement: fall back to the SVG glyphs.
  }
  return captionFont
}

/**
 * The COLR/CPAL support probe (§8.6, FACT §8.4). Owner: WP8b.
 *
 * QCF V4 is COLRv0 + CPAL. WebView2 and WKWebView draw it (except Safari 17.0–17.1's COLRv0 regression); WebKitGTK is
 * unverified. After the first V4 face loads, the page's first ayah-end glyph is drawn at 48 px on a 64 × 64 canvas.
 * That glyph uses CPAL entries 10–13, the high-chroma ayah-marker colours (palette 0: #2ca4ab, #ff0080), so a webview
 * that renders colour fonts produces strongly coloured pixels, and one that does not draws flat ink. (An arbitrary
 * glyph was the wrong probe: many V4 glyphs use only entry 0, black.) The result is cached in `localStorage` per
 * webview version and the probe re-runs when the version changes.
 */
import type { PageData } from '$lib/ipc/bindings'

/** Canvas side and font size of the probe (§8.6). */
export const PROBE_CANVAS_PX = 64
export const PROBE_FONT_PX = 48
/** A pixel counts as palette colour when it is mostly opaque and clearly chromatic. */
export const PROBE_MIN_ALPHA = 128
export const PROBE_MIN_CHROMA = 48

/** `localStorage` key of the cached result (`{ webview, supported }`). */
export const V4_SUPPORT_KEY = 'qd-v4-colr-support'

/** Whether RGBA pixel data holds at least one opaque, strongly chromatic pixel (`alpha > 128`, `max − min > 48`). */
export function hasPaletteColour(rgba: ArrayLike<number>): boolean {
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const a = rgba[i + 3] ?? 0
    if (a <= PROBE_MIN_ALPHA) continue
    const r = rgba[i] ?? 0
    const g = rgba[i + 1] ?? 0
    const b = rgba[i + 2] ?? 0
    if (Math.max(r, g, b) - Math.min(r, g, b) > PROBE_MIN_CHROMA) return true
  }
  return false
}

/** The style glyph of the page's first ayah-end word (`code_v2` for V4), or `null` when the page has none. */
export function firstEndGlyph(data: PageData): string | null {
  for (const line of data.lines) {
    for (const word of line.words) if (word.isEnd && word.glyph) return word.glyph
  }
  return null
}

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function context(): Context2D | null {
  const options: CanvasRenderingContext2DSettings = { willReadFrequently: true }
  if (typeof OffscreenCanvas === 'function') {
    try {
      const ctx = new OffscreenCanvas(PROBE_CANVAS_PX, PROBE_CANVAS_PX).getContext('2d', options)
      if (ctx) return ctx
    } catch {
      // Fall through to a DOM canvas.
    }
  }
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = PROBE_CANVAS_PX
  canvas.height = PROBE_CANVAS_PX
  return canvas.getContext('2d', options)
}

/**
 * Draws `glyph` in `family` (which must be loaded, or loadable through `document.fonts`) at 48 px, centred on its ink
 * box in a 64 × 64 canvas (canvas text renders palette 0), and resolves whether any pixel shows palette colour.
 * Rejects when no 2D canvas is available (the caller then leaves support unknown instead of guessing).
 */
export async function probeColr(family: string, glyph: string): Promise<boolean> {
  const font = `${PROBE_FONT_PX}px "${family}"`
  if (typeof document !== 'undefined' && document.fonts) await document.fonts.load(font, glyph)
  const ctx = context()
  if (!ctx) throw new Error('COLR probe: no 2D canvas context')
  ctx.clearRect(0, 0, PROBE_CANVAS_PX, PROBE_CANVAS_PX)
  ctx.font = font
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.direction = 'ltr'
  // The ink colour is neutral, so any chroma must come from the font's palette.
  ctx.fillStyle = '#000000'
  const m = ctx.measureText(glyph)
  const left = Number.isFinite(m.actualBoundingBoxLeft) ? m.actualBoundingBoxLeft : 0
  const right = Number.isFinite(m.actualBoundingBoxRight) ? m.actualBoundingBoxRight : m.width
  const ascent = Number.isFinite(m.actualBoundingBoxAscent) ? m.actualBoundingBoxAscent : PROBE_FONT_PX * 0.8
  const descent = Number.isFinite(m.actualBoundingBoxDescent)
    ? m.actualBoundingBoxDescent
    : PROBE_FONT_PX * 0.2
  const width = Math.max(1, left + right)
  const height = Math.max(1, ascent + descent)
  // Shrink a glyph whose ink box would not fit, so its colour layers are never cropped away.
  const fit = Math.min(1, (PROBE_CANVAS_PX - 4) / Math.max(width, height))
  ctx.save()
  ctx.translate(PROBE_CANVAS_PX / 2, PROBE_CANVAS_PX / 2)
  ctx.scale(fit, fit)
  ctx.fillText(glyph, left - width / 2, ascent - height / 2)
  ctx.restore()
  return hasPaletteColour(ctx.getImageData(0, 0, PROBE_CANVAS_PX, PROBE_CANVAS_PX).data)
}

interface CachedSupport {
  webview: string
  supported: boolean
}

/** The cached probe result for this webview version, or `null` (not probed, another version, or no storage). */
export function readCachedSupport(webviewVersion: string): boolean | null {
  try {
    const raw = localStorage.getItem(V4_SUPPORT_KEY)
    if (raw === null) return null
    const value = JSON.parse(raw) as Partial<CachedSupport> | null
    if (value && value.webview === webviewVersion && typeof value.supported === 'boolean')
      return value.supported
  } catch {
    // Blocked or corrupt storage: probe again.
  }
  return null
}

/** Caches the probe result for this webview version (a per-viewer convenience: failures are ignored). */
export function writeCachedSupport(webviewVersion: string, supported: boolean): void {
  try {
    localStorage.setItem(V4_SUPPORT_KEY, JSON.stringify({ webview: webviewVersion, supported }))
  } catch {
    // Storage full or blocked: the probe simply runs again next session.
  }
}

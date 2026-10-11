/**
 * WOFF2-only UI fonts (ARCHITECTURE §13.6 installer budget; docs/deviations/INTEGRATION.md, "Tooling fix").
 *
 * Fontsource's static faces (IBM Plex Sans Arabic 400/500/600) list a WOFF 1 fallback after every WOFF2 source:
 * `src: url(x.woff2) format('woff2'), url(x.woff) format('woff')`. Every webview the app runs in reads WOFF2 (WebView2,
 * WKWebView on macOS 13.3+, WebKitGTK on Ubuntu 22.04+), so the fallbacks are never fetched, yet Vite emits them into
 * `dist/` and Tauri embeds them in the binary: about 210 KB of already-compressed bytes that LZMA cannot shrink, enough
 * to push the NSIS installer over its 8 MiB budget.
 *
 * At the end of a production build this plugin drops every `format('woff')` entry from an `@font-face` `src` list that
 * also offers a WOFF2 entry, then deletes the `.woff` assets nothing references any more. A face whose only source is
 * WOFF 1 is left alone. `scripts/check-dist.mjs` fails when a `.woff` file reaches `dist/` again.
 */
import type { Plugin } from 'vite'

/** The result of {@link dropWoffFallbacks}. */
export interface WoffRewrite {
  css: string
  /** The `url(…)` targets of the removed entries (file URLs and data: URIs alike), in order. */
  removed: string[]
}

/**
 * Scans `text` from `from` and calls `visit(index, char)` for every character outside quotes and parentheses (so
 * `url(data:…;base64,…)` and quoted strings never count); stops when `visit` returns true.
 */
function scanTopLevel(text: string, from: number, visit: (index: number, char: string) => boolean): number {
  let depth = 0
  let quote: string | null = null
  for (let i = from; i < text.length; i++) {
    const c = text.charAt(i)
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && visit(i, c)) return i
  }
  return text.length
}

/** Splits a value list at its top-level commas. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let start = 0
  scanTopLevel(text, 0, (i, c) => {
    if (c === ',') {
      parts.push(text.slice(start, i))
      start = i + 1
    }
    return false
  })
  parts.push(text.slice(start))
  return parts
}

const FORMAT = /format\(\s*(["']?)([\w-]+)\1\s*\)/i
const URL_OF = /url\(\s*(["']?)(.*?)\1\s*\)/is
const SRC = /^(\s*src\s*:)([\s\S]*)$/i

/**
 * Removes the WOFF 1 entries from every `@font-face` `src` list that also has a WOFF2 entry. Works on minified and
 * formatted CSS alike; everything else is returned byte for byte.
 * @param css a stylesheet
 */
export function dropWoffFallbacks(css: string): WoffRewrite {
  const removed: string[] = []
  const pieces: string[] = []
  let at = 0
  const faces = /@font-face\s*\{/gi
  for (let face = faces.exec(css); face; face = faces.exec(css)) {
    const bodyStart = face.index + face[0].length
    const close = scanTopLevel(css, bodyStart, (_, c) => c === '}')
    for (let start = bodyStart; start < close;) {
      const end = Math.min(
        scanTopLevel(css, start, (_, c) => c === ';' || c === '}'),
        close,
      )
      const src = SRC.exec(css.slice(start, end))
      if (src) {
        const entries = splitTopLevel(src[2] ?? '')
        const kinds = entries.map((e) => FORMAT.exec(e)?.[2]?.toLowerCase() ?? null)
        if (kinds.includes('woff') && kinds.includes('woff2')) {
          for (const [i, entry] of entries.entries())
            if (kinds[i] === 'woff') removed.push(URL_OF.exec(entry)?.[2] ?? entry.trim())
          const lead = /^\s*/.exec(src[2] ?? '')?.[0] ?? ''
          const kept = entries.filter((_, i) => kinds[i] !== 'woff').map((e) => e.trim())
          pieces.push(css.slice(at, start), src[1] ?? '', lead, kept.join(', '))
          at = end
        }
      }
      start = end + 1
    }
    faces.lastIndex = close + 1
  }
  pieces.push(css.slice(at))
  return { css: pieces.join(''), removed }
}

/** Vite plugin: WOFF2-only `@font-face` sources and no orphaned `.woff` assets in production builds. */
export function woff2Only(): Plugin {
  let info: (message: string) => void = () => {}
  return {
    name: 'qd:woff2-only',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      info = (message) => config.logger.info(message)
    },
    generateBundle(_options, bundle) {
      /** Basenames of the WOFF 1 files the stylesheets no longer reference. */
      const dropped = new Set<string>()
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset' || !file.fileName.endsWith('.css')) continue
        const source = typeof file.source === 'string' ? file.source : new TextDecoder().decode(file.source)
        const { css, removed } = dropWoffFallbacks(source)
        if (removed.length === 0) continue
        file.source = css
        for (const url of removed)
          if (!url.startsWith('data:')) dropped.add(url.split(/[?#]/)[0]?.split('/').pop() ?? url)
      }
      const textOf = (name: string): string => {
        const f = bundle[name]
        if (!f) return ''
        if (f.type === 'chunk') return f.code
        return typeof f.source === 'string' ? f.source : ''
      }
      let files = 0
      let bytes = 0
      for (const [name, file] of Object.entries(bundle)) {
        if (file.type !== 'asset' || !/\.woff$/i.test(name)) continue
        const base = name.split('/').pop() ?? name
        if (!dropped.has(base)) continue
        // A reference is the name not followed by another name character (`a.woff` is a prefix of `a.woff2`).
        const used = new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`)
        if (Object.keys(bundle).some((other) => other !== name && used.test(textOf(other)))) continue
        bytes += typeof file.source === 'string' ? file.source.length : file.source.byteLength
        files++
        delete bundle[name]
      }
      if (files > 0)
        info(
          `[qd] woff2-only: dropped ${files} WOFF 1 fallback font file(s), ${(bytes / 1024).toFixed(0)} KiB`,
        )
    },
  }
}

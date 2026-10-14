/**
 * Theme previews (onboarding theme cards).
 *
 * The design tokens apply themes on the root element only (`:root[data-theme="…"]`), yet each theme card shows
 * page 1 in its own theme. Rather than copying colour values (components never hard-code colours), this reads the
 * theme's own declarations from the loaded token sheet: every custom property (and `color-scheme`) of the style
 * rules whose selector is exactly `:root[data-theme="<theme>"]` (paper is also the bare `:root` default), in sheet
 * order. Set as an inline style on a wrapper, they re-theme that subtree: `var()` references inside them (the night
 * ink's `color-mix` over `--surface-page` and `--ink-alpha`, the accent mapping) resolve against the wrapper.
 *
 * Only the theme layer's inputs move into the preview. Tokens derived once on `:root` (highlight fills) and the
 * preference overrides (forced colours, more contrast) stay global, which is right for a decorative, inert thumbnail.
 */
import type { ResolvedTheme } from '$lib/contracts/stores'

/** A selector item naming exactly one theme on the root, quoted or not (minifiers drop the quotes). */
const ROOT_THEME = /^:root\[data-theme=(["']?)([a-z_]+)\1\]$/

/** The theme a selector list declares tokens for (`:root, :root[data-theme='paper']` → paper), or null. */
export function selectorTheme(selectorText: string): string | null {
  for (const part of selectorText.split(',')) {
    const m = ROOT_THEME.exec(part.trim())
    if (m) return m[2] ?? null
  }
  return null
}

function isLayerBlock(rule: CSSRule): rule is CSSRule & { cssRules: CSSRuleList } {
  return typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule
}

/** Collects the declarations of `theme` from rules and unconditional `@layer` blocks (never `@media`/`@supports`). */
function collect(rules: CSSRuleList, theme: string, out: Map<string, string>): void {
  for (const rule of rules) {
    if (rule instanceof CSSStyleRule) {
      if (selectorTheme(rule.selectorText) !== theme) continue
      for (const name of rule.style) {
        if (!name.startsWith('--') && name !== 'color-scheme') continue
        const value = rule.style.getPropertyValue(name).trim()
        if (value !== '') out.set(name, value)
      }
    } else if (isLayerBlock(rule)) {
      collect(rule.cssRules, theme, out)
    }
  }
}

const cache = new Map<string, string>()
let cachedSheets: number = -1

/**
 * The inline style that re-themes a subtree to `theme`: `--surface-page: #f6ead2; --ink: …; color-scheme: light`.
 * Empty when the token sheet is not loaded. Cached until the number of loaded style sheets changes.
 */
export function themeStyle(theme: ResolvedTheme, doc: Document = document): string {
  const sheets = doc.styleSheets.length
  if (sheets !== cachedSheets) {
    cache.clear()
    cachedSheets = sheets
  }
  const hit = cache.get(theme)
  if (hit !== undefined) return hit
  const declarations = new Map<string, string>()
  for (const sheet of doc.styleSheets) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue // a cross-origin sheet cannot be read (none of ours is)
    }
    collect(rules, theme, declarations)
  }
  const style = [...declarations].map(([name, value]) => `${name}: ${value}`).join('; ')
  if (style !== '') cache.set(theme, style)
  return style
}

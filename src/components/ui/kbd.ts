/**
 * Keycap helpers for `Kbd`. `shortcuts.format(def)` produces one label per chord: `Ctrl+Shift+K` on
 * Windows and Linux, `⌘⇧K` on macOS; `splitChord` turns such a label into the keycaps `Kbd` draws.
 */

/** macOS modifier glyphs, in the order `formatChord` writes them (⌃ ⌥ ⇧ ⌘). */
const MAC_MODIFIERS = new Set(['⌃', '⌥', '⇧', '⌘'])

export function isMacModifier(cap: string): boolean {
  return MAC_MODIFIERS.has(cap)
}

/**
 * Splits a chord label into keycaps: `Ctrl+Shift+K` → `[Ctrl, Shift, K]`, `Ctrl++` → `[Ctrl, +]`, `⌘⇧K` → `[⌘, ⇧, K]`,
 * `Space` → `[Space]`. A `+` that is the key itself is kept. Blank input gives `[]`.
 */
export function splitChord(label: string): string[] {
  const text = label.trim()
  if (text === '') return []
  const caps: string[] = []
  let rest = text
  // Leading macOS modifier glyphs are one keycap each.
  for (const ch of Array.from(text)) {
    if (!MAC_MODIFIERS.has(ch) || rest.length <= ch.length) break
    caps.push(ch)
    rest = rest.slice(ch.length)
  }
  // A `+` joins two keys only when something follows it, so `Ctrl++` ends with the `+` key.
  for (const part of rest.split(/\+(?=.)/u)) if (part !== '') caps.push(part)
  return caps
}

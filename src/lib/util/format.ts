/**
 * Locale-independent formatting helpers (the localised ones live on the `i18n` store, §11.2). Owner: WP7c (created by
 * WP0C).
 */

/** `m:ss` or `h:mm:ss` with ASCII digits (scrubber readouts are `direction: ltr`, §11.3). */
export function clock(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** Clamps a number into `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** A speed percentage as the dock shows it: 125 → `1.25×`, 100 → `1×`, 150 → `1.5×`. */
export function speedLabel(pct: number): string {
  const text = (pct / 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  return `${text}×`
}

/**
 * Splits a localised message around one `{name}` placeholder, so markup (a `<Kbd>`, a `<code>`) can stand in its
 * place: `splitAround('Press {key} anytime', 'key')` → `['Press ', ' anytime']`. `null` when the placeholder is absent.
 */
export function splitAround(text: string, name: string): [before: string, after: string] | null {
  const token = `{${name}}`
  const at = text.indexOf(token)
  if (at < 0) return null
  return [text.slice(0, at), text.slice(at + token.length)]
}

/** The last segment of a path with either separator (`C:\data\user.db.corrupt-1` → `user.db.corrupt-1`). */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut < 0 ? trimmed : trimmed.slice(cut + 1)
}

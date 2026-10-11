/**
 * Number ranges for the Index (page spans, juz spans), isolated like references (§11.3): Latin digits inside
 * LRI…PDI, Arabic-Indic digits inside RLI…PDI, so "1–21" never reads backwards in the Arabic UI or vice versa.
 * Owner: WP10a.
 */
import { i18n, settings } from '$lib/stores'
import { LRI, PDI, RLI } from '$lib/stores/i18n.svelte'

/** "1–21" (or "7" when both ends are equal) in UI digits, bidi-isolated. */
export function numRange(from: number, to: number): string {
  const text = from === to ? i18n.num(from) : `${i18n.num(from)}–${i18n.num(to)}`
  return `${settings.arabicDigits ? RLI : LRI}${text}${PDI}`
}

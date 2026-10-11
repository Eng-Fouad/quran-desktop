/**
 * Formatting helpers of the onboarding (§9.7, §11.2). Owner: WP12c.
 */
import type { Locale } from '$lib/contracts/i18n'
import type { PackKind } from '$lib/ipc/bindings'
import type { StarterFetch } from '$lib/stores/packs.svelte'

const displayNames = new Map<Locale, Intl.DisplayNames | null>()

/** A content language named in the UI language ("Urdu", "الأردية"); the code itself when unknown; '' for none. */
export function languageName(code: string | null, locale: Locale): string {
  if (!code) return ''
  let names = displayNames.get(locale)
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([locale], { type: 'language' })
    } catch {
      names = null
    }
    displayNames.set(locale, names)
  }
  try {
    return names?.of(code) ?? code
  } catch {
    return code
  }
}

/** The `onboarding.summary.when.*` message of a starter-set row (§2.5.4: now, on demand, timings on first play). */
export type WhenKey = 'now' | 'pages' | 'chapters' | 'timings' | 'installed' | 'background'

export function whenKey(kind: PackKind, fetch: StarterFetch, installed: boolean): WhenKey {
  if (fetch === 'timings_on_first_play') return 'timings'
  if (fetch === 'on_demand') return kind === 'mushaf_fonts' ? 'pages' : 'chapters'
  if (installed) return 'installed'
  return kind === 'mushaf_fonts' ? 'background' : 'now'
}

/** Below this many KiB a starter-set total is shown in kB, exact to the KiB (it is the sum of the rows above it). */
export const EXACT_KB_BELOW = 10 * 1024

/**
 * The "Download now" total (§9.7 "the exact total"): under 10 MB in kB, grouped and exact ("1,119 kB", the sum of the
 * rows, which are in kB too); larger totals in the units of `bytes()`. `unitDisplay` is `i18n.sizeUnitDisplay`, the
 * spelling `bytes()` uses ("kB", «ك.ب»).
 */
export function exactTotal(
  kib: number,
  intlLocale: string,
  bytes: (kib: number) => string,
  unitDisplay: 'short' | 'narrow' = 'short',
): string {
  const value = Number.isFinite(kib) ? Math.max(0, Math.round(kib)) : 0
  if (value >= EXACT_KB_BELOW) return bytes(value)
  return new Intl.NumberFormat(intlLocale, { style: 'unit', unit: 'kilobyte', unitDisplay }).format(value)
}

/**
 * `i18n` store: the reactive locale, `t`/`tp` and the formatters. Layer L0 (imports `settings`).
 *
 * - The locale follows `settings.value.uiLanguage`, so `settings.update({ uiLanguage: 'ar' })` switches the whole UI
 *   live; `html[lang][dir]` follow through `settings.applyEffects()`.
 * - UI numbers use the digits the settings ask for (`settings.arabicDigits`); numeric `t`/`tp` parameters are
 *   formatted with them, so `t('common.pageNumber', { page: 262 })` reads "صفحة ٢٦٢" in the Arabic UI.
 * - Mushaf furniture always uses Eastern Arabic numbers (`mushafNum`).
 * - References are bidi-isolated strings: Western Arabic numbers inside LRI…PDI (`<bdi dir="ltr">`), Eastern
 *   Arabic numbers inside RLI…PDI (`<bdi dir="rtl">`), so "2:255–257" never reorders inside Arabic text and vice versa.
 * - The digit systems are named "Western Arabic numbers" and "Eastern Arabic numbers"; the setting's value
 *   `arabic_indic` is a serialized name only.
 */
import type { I18nParams, Locale, PluralKey, TextKey } from '$lib/contracts/i18n'
import type { Store } from '$lib/contracts/stores'
import { translate, translatePlural } from '$lib/i18n'
import type { Bootstrap } from '$lib/ipc/bindings'
import { settings } from './settings.svelte'

/** Unicode isolates, written as code points (literal bidi controls in source are a review hazard). */
export const LRI = String.fromCodePoint(0x2066)
export const RLI = String.fromCodePoint(0x2067)
export const PDI = String.fromCodePoint(0x2069)

/** En dash between the ends of a range ("2:255–257"). */
const RANGE_DASH = '–'

/** The precomposed vulgar fractions `fraction()` uses, by "numerator/denominator": they exist only in Western digits. */
const VULGAR: Readonly<Record<string, string>> = { '1/4': '¼', '1/2': '½', '3/4': '¾' }

const mushafDigits = new Intl.NumberFormat('ar-u-nu-arab', { useGrouping: false })

const SECOND = 1
const MINUTE = 60
const HOUR = 3_600
const DAY = 86_400
const MONTH = 2_629_746 // 30.436875 days
const YEAR = 31_556_952 // 365.2425 days

/** Size units for `bytes()`, from KiB (sizes arrive as KiB). Labels come from `Intl` in the UI language. */
const SIZE_UNITS = [
  ['kilobyte', 1],
  ['megabyte', 1024],
  ['gigabyte', 1024 ** 2],
  ['terabyte', 1024 ** 3],
] as const

class I18nStore implements Store {
  /** The UI language (`settings.value.uiLanguage`). */
  readonly locale: Locale = $derived(settings.value.uiLanguage)
  readonly dir: 'ltr' | 'rtl' = $derived(this.locale === 'ar' ? 'rtl' : 'ltr')
  /** The `Intl` locale for words plus digits: `ar-u-nu-arab`, `ar-u-nu-latn`, `en-u-nu-latn`, `en-u-nu-arab`. */
  readonly intlLocale: string = $derived(`${this.locale}-u-nu-${settings.arabicDigits ? 'arab' : 'latn'}`)
  /**
   * How size units are spelled: English "kB / MB / GB". CLDR's short Arabic forms mix the word «كيلوبايت»
   * with the abbreviations «م.ب» and «غ.ب», so Arabic takes the narrow forms, abbreviated alike: «ك.ب / م.ب / غ.ب».
   */
  readonly sizeUnitDisplay: 'short' | 'narrow' = $derived(this.locale === 'ar' ? 'narrow' : 'short')
  /**
   * How other units (milliseconds) are spelled: CLDR's short Arabic «ملي ث» reads as a broken word, so Arabic spells
   * them out («مللي ثانية»).
   */
  readonly unitDisplay: 'short' | 'long' = $derived(this.locale === 'ar' ? 'long' : 'short')

  /** `Intl.NumberFormat(arabicDigits ? 'ar-u-nu-arab' : 'en-US')`. */
  readonly #numbers = $derived(new Intl.NumberFormat(settings.arabicDigits ? 'ar-u-nu-arab' : 'en-US'))
  /** Digits without grouping (references, clock times). */
  readonly #plain = $derived(new Intl.NumberFormat(this.intlLocale, { useGrouping: false }))
  readonly #twoDigits = $derived(
    new Intl.NumberFormat(this.intlLocale, { useGrouping: false, minimumIntegerDigits: 2 }),
  )
  readonly #relative = $derived(new Intl.RelativeTimeFormat(this.intlLocale, { numeric: 'auto' }))
  readonly #date = $derived(new Intl.DateTimeFormat(this.intlLocale, { dateStyle: 'medium' }))

  init(_b: Bootstrap): void {
    // Nothing to load: the locale and digits derive from the settings store, initialised just before this one.
  }

  /** A message: the locale's string, else English, else the key. Numeric parameters use UI digits. */
  t(key: TextKey, params?: I18nParams): string {
    return translate(this.locale, key, this.#params(params))
  }

  /** A plural message for `count` (`Intl.PluralRules` of the UI language); `{count}` is formatted with UI digits. */
  tp(key: PluralKey, count: number, params?: I18nParams): string {
    return translatePlural(this.locale, key, count, { count: this.num(count), ...this.#params(params) })
  }

  /** A UI number in the digits the settings ask for, grouped. */
  num(n: number): string {
    return this.#numbers.format(n)
  }

  /** Mushaf furniture digits: always Eastern Arabic numbers, never grouped. */
  mushafNum(n: number): string {
    return mushafDigits.format(n)
  }

  /**
   * A simple fraction in UI digits: with Western Arabic numbers the precomposed ¼ ½ ¾ (else `n/d`); with
   * Eastern Arabic numbers, which have no precomposed fractions, `١/٤`. The solidus between two Eastern Arabic digits
   * joins them into one left-to-right number in either paragraph direction (UAX #9 W4), so no isolate is needed and
   * `×١/٢` reads like `×١` in the Arabic UI. Never reverse the digits or add marks to "fix" the order.
   */
  fraction(numerator: number, denominator: number): string {
    const d = (n: number) => this.#plain.format(n)
    if (!settings.arabicDigits) {
      const vulgar = VULGAR[`${numerator}/${denominator}`]
      if (vulgar !== undefined) return vulgar
    }
    return `${d(numerator)}/${d(denominator)}`
  }

  /**
   * A bidi-isolated reference: `2:255`, `2:255–257`, or across surahs `2:286–3:2`; `٢:٢٥٥` with
   * Eastern Arabic numbers.
   */
  ref(surah: number, ayah: number, toAyah?: number, toSurah?: number): string {
    const d = (n: number) => this.#plain.format(n)
    let text = `${d(surah)}:${d(ayah)}`
    if (toAyah !== undefined) {
      if (toSurah !== undefined && toSurah !== surah) text += `${RANGE_DASH}${d(toSurah)}:${d(toAyah)}`
      else if (toAyah !== ayah) text += `${RANGE_DASH}${d(toAyah)}`
    }
    return `${settings.arabicDigits ? RLI : LRI}${text}${PDI}`
  }

  /** A size given in KiB as KB/MB/GB with locale digits and unit labels. */
  bytes(kib: number): string {
    const value = Number.isFinite(kib) ? Math.max(0, kib) : 0
    let unit: (typeof SIZE_UNITS)[number] = SIZE_UNITS[0]
    for (const candidate of SIZE_UNITS) if (value >= candidate[1]) unit = candidate
    const amount = value / unit[1]
    const fraction = unit[0] === 'kilobyte' || amount >= 10 ? 0 : 1
    return new Intl.NumberFormat(this.intlLocale, {
      style: 'unit',
      unit: unit[0],
      unitDisplay: this.sizeUnitDisplay,
      maximumFractionDigits: fraction,
    }).format(amount)
  }

  /** A duration as `m:ss`, or `h:mm:ss` from one hour (render with tabular numerals). */
  duration(ms: number): string {
    const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0
    const h = Math.floor(total / HOUR)
    const m = Math.floor((total % HOUR) / MINUTE)
    const s = total % MINUTE
    const two = (n: number) => this.#twoDigits.format(n)
    const one = (n: number) => this.#plain.format(n)
    return h > 0 ? `${one(h)}:${two(m)}:${two(s)}` : `${one(m)}:${two(s)}`
  }

  /** "3 days ago", "yesterday", "in 2 hours" for a Unix time in seconds (`Intl.RelativeTimeFormat`). */
  relTime(secs: number, nowMs: number = Date.now()): string {
    const diff = secs - nowMs / 1000
    const abs = Math.abs(diff)
    const fmt = (size: number, unit: Intl.RelativeTimeFormatUnit) =>
      this.#relative.format(Math.round(diff / size), unit)
    if (abs < 45 * SECOND) return this.#relative.format(0, 'second')
    if (abs < 45 * MINUTE) return fmt(MINUTE, 'minute')
    if (abs < 22 * HOUR) return fmt(HOUR, 'hour')
    if (abs < 30 * DAY) return fmt(DAY, 'day')
    if (abs < 11 * MONTH) return fmt(MONTH, 'month')
    return fmt(YEAR, 'year')
  }

  /** A calendar date for a Unix time in seconds (`dateStyle: 'medium'`). */
  date(secs: number): string {
    return this.#date.format(new Date(secs * 1000))
  }

  reset(): void {
    // Nothing of its own: the locale and digits follow the settings store.
  }

  #params(params?: I18nParams): I18nParams | undefined {
    if (!params) return params
    const out: I18nParams = {}
    for (const [name, v] of Object.entries(params)) out[name] = typeof v === 'number' ? this.num(v) : v
    return out
  }
}

export const i18n = new I18nStore()

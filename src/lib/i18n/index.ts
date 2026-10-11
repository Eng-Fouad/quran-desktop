/**
 * The i18n runtime (§11.1): dictionary lookup with the English and then the key fallback, `{name}` interpolation and
 * `Intl.PluralRules` plurals. Pure functions over the typed dictionaries; the reactive locale, the digit-aware number
 * formatting of parameters and the §11.2 formatters live in the `i18n` store (`$lib/stores/i18n.svelte`), which is what
 * components use (`i18n.t('common.cancel')`). Owner: WP0E → WP7c.
 */
import type { I18nParams, Locale, Plural, PluralCategory, PluralKey, TextKey } from '$lib/contracts/i18n'
import { ar } from './ar'
import { en } from './en'

export type {
  Dict,
  I18nKey,
  I18nParams,
  Locale,
  Plural,
  PluralCategory,
  PluralKey,
  TextKey,
} from '$lib/contracts/i18n'
export { ar, en }

/** Every UI language's dictionary. */
export const dictionaries = { en, ar } as const

/** The UI languages, in the order the language picker lists them. */
export const LOCALES = ['en', 'ar'] as const satisfies readonly Locale[]

/** The value at a dotted path, or `undefined`. */
export function lookup(locale: Locale, key: string): unknown {
  let node: unknown = dictionaries[locale]
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, part)) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}

/** Replaces `{name}` placeholders; unknown names stay visible so a missing parameter is noticed. */
export function interpolate(template: string, params?: I18nParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = Object.hasOwn(params, name) ? params[name] : undefined
    return v === undefined ? whole : String(v)
  })
}

/** A dictionary group with both `one` and `other` string keys is a plural (§11.1, `Plural`). */
export function isPlural(v: unknown): v is Plural {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Record<string, unknown>
  return typeof p.one === 'string' && typeof p.other === 'string'
}

/** Whether a runtime string names a plain message (for keys built at runtime, such as `errors.${kind}`). */
export function isTextKey(key: string): key is TextKey {
  return typeof lookup('en', key) === 'string'
}

/** Whether a runtime string names a plural message. */
export function isPluralKey(key: string): key is PluralKey {
  return isPlural(lookup('en', key))
}

const warned = new Set<string>()

/** Development aid: a key missing from a dictionary is reported once (the type system makes it rare). */
function warnMissing(locale: Locale, key: string): void {
  if (!import.meta.env.DEV) return
  const id = `${locale}:${key}`
  if (warned.has(id)) return
  warned.add(id)
  console.warn(`[i18n] missing ${locale} message "${key}"`)
}

/** `t()`: the locale's string, else English, else the key itself (§11.1 key fallback). */
export function translate(locale: Locale, key: TextKey, params?: I18nParams): string {
  let v = lookup(locale, key)
  if (typeof v !== 'string') {
    warnMissing(locale, key)
    v = lookup('en', key)
  }
  return interpolate(typeof v === 'string' ? v : key, params)
}

const pluralRules = new Map<Locale, Intl.PluralRules>()

/** The CLDR plural category of `count` in a locale (`ar`: zero, one, two, few, many, other). */
export function pluralCategory(locale: Locale, count: number): PluralCategory {
  let rules = pluralRules.get(locale)
  if (!rules) pluralRules.set(locale, (rules = new Intl.PluralRules(locale)))
  return rules.select(count) as PluralCategory
}

/**
 * `tp()`: the message for the plural category of `count` (`Intl.PluralRules`), falling back to `other`, then to the
 * English plural, then to the key. `{count}` is `count` unless `params` provides a formatted one.
 */
export function translatePlural(locale: Locale, key: PluralKey, count: number, params?: I18nParams): string {
  let plural = lookup(locale, key)
  let pluralLocale = locale
  if (!isPlural(plural)) {
    warnMissing(locale, key)
    plural = lookup('en', key)
    pluralLocale = 'en'
  }
  if (!isPlural(plural)) return key
  const template = plural[pluralCategory(pluralLocale, count)] ?? plural.other
  return interpolate(template, { count, ...params })
}

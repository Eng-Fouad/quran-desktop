/**
 * Typed dictionary contract. The English dictionary is the source of truth: `Dict` is its widened shape, which the
 * Arabic dictionary must satisfy (missing or extra keys are compile errors), and `I18nKey` is the set of its dotted
 * leaf paths. Runtime helpers (`t`, `tp`, formatters) live in `$lib/i18n`.
 */
import type { AppError } from '$lib/ipc/bindings'
import type { en } from '$lib/i18n/en'

/**
 * A pluralised message, chosen with `Intl.PluralRules(locale).select(count)`. English needs `one` and `other`; Arabic
 * entries define all six categories (enforced by a unit test). A dictionary group that has both `one` and `other`
 * string keys is treated as a plural, so never use those two names for ordinary keys.
 */
export type Plural = {
  zero?: string
  one: string
  two?: string
  few?: string
  many?: string
  other: string
}

/** The CLDR plural categories, in canonical order. */
export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const
export type PluralCategory = (typeof PLURAL_CATEGORIES)[number]

/** Widens the literal string types of `typeof en` so another language can satisfy the same shape. */
export type Widen<T> = {
  [K in keyof T]: T[K] extends string ? string : T[K] extends Plural ? Plural : Widen<T[K]>
}

/** The shape every language dictionary satisfies (`export const ar = {...} satisfies Dict`). */
export type Dict = Widen<typeof en>

type Join<P extends string, K extends string> = P extends '' ? K : `${P}.${K}`

type TextPaths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? Join<P, K>
    : T[K] extends Plural
      ? never
      : TextPaths<T[K], Join<P, K>>
}[keyof T & string]

type PluralPaths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? never
    : T[K] extends Plural
      ? Join<P, K>
      : PluralPaths<T[K], Join<P, K>>
}[keyof T & string]

/** Dotted paths of plain string messages, for `t()`. */
export type TextKey = TextPaths<typeof en>
/** Dotted paths of `Plural` messages, for `tp()`. */
export type PluralKey = PluralPaths<typeof en>
/** Every message key. */
export type I18nKey = TextKey | PluralKey
/** Shortcut labels: `ShortcutDef.labelKey` is always one of the `shortcuts.*` keys. */
export type ShortcutLabelKey = Extract<TextKey, `shortcuts.${string}`>
/** The localised message of an `AppError` kind lives at `errors.<kind>`. */
export type ErrorKey = `errors.${AppError['kind']}`

/** `{name}` interpolation values for `t()`/`tp()`. */
export type I18nParams = Record<string, string | number>

/** The UI languages (mirrors the generated `UiLanguage`). */
export type Locale = 'en' | 'ar'

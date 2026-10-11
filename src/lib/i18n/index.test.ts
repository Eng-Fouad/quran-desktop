import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  interpolate,
  isPlural,
  isPluralKey,
  isTextKey,
  LOCALES,
  lookup,
  pluralCategory,
  translate,
  translatePlural,
  type TextKey,
} from './index'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('lookup', () => {
  it('walks dotted paths and only own keys', () => {
    expect(lookup('en', 'common.cancel')).toBe('Cancel')
    expect(lookup('en', 'shortcuts.keys')).toMatchObject({ space: 'Space' })
    expect(lookup('en', 'common.nope')).toBeUndefined()
    expect(lookup('en', 'common.cancel.deeper')).toBeUndefined()
    // Prototype members are not messages.
    expect(lookup('en', 'constructor')).toBeUndefined()
    expect(lookup('en', 'common.toString')).toBeUndefined()
  })
})

describe('interpolate', () => {
  it('fills own parameters only', () => {
    expect(interpolate('{a} and {b}', { a: 1, b: 'two' })).toBe('1 and two')
    expect(interpolate('{toString}', {})).toBe('{toString}')
    expect(interpolate('{a}{a}', { a: 'x' })).toBe('xx')
  })
})

describe('translate', () => {
  it('falls back to the key for a missing message or a non-message path, and warns once in development', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(translate('en', 'common.missing' as TextKey)).toBe('common.missing')
    expect(translate('ar', 'common.missing2' as TextKey)).toBe('common.missing2')
    expect(translate('ar', 'common.missing2' as TextKey)).toBe('common.missing2')
    expect(translate('en', 'shortcuts.keys' as TextKey)).toBe('shortcuts.keys')
    expect(warn.mock.calls.filter(([m]) => String(m).includes('common.missing2'))).toHaveLength(1)
  })

  it('interpolates after the lookup', () => {
    expect(translate('ar', 'common.pageNumber', { page: '٢٦٢' })).toBe('الصفحة ٢٦٢')
  })
})

describe('plurals', () => {
  it('recognises plural messages', () => {
    expect(isPlural({ one: 'a', other: 'b' })).toBe(true)
    expect(isPlural({ one: 'a' })).toBe(false)
    expect(isPlural('x')).toBe(false)
    expect(isPluralKey('common.ayahCount')).toBe(true)
    expect(isPluralKey('common.cancel')).toBe(false)
    expect(isTextKey('common.cancel')).toBe(true)
    expect(isTextKey('errors.offline')).toBe(true)
    expect(isTextKey('common.ayahCount')).toBe(false)
    expect(isTextKey('common')).toBe(false)
  })

  it('uses the CLDR categories of each locale', () => {
    expect([0, 1, 2, 3, 11, 100].map((n) => pluralCategory('ar', n))).toEqual([
      'zero',
      'one',
      'two',
      'few',
      'many',
      'other',
    ])
    expect([0, 1, 2].map((n) => pluralCategory('en', n))).toEqual(['other', 'one', 'other'])
  })

  it('selects the plural form and lets a formatted count override the raw one', () => {
    expect(translatePlural('en', 'common.pageCount', 1)).toBe('1 page')
    expect(translatePlural('en', 'common.pageCount', 0)).toBe('0 pages')
    expect(translatePlural('ar', 'common.ayahCount', 7, { count: '٧' })).toBe('٧ آيات')
    expect(translatePlural('en', 'common.ayahCount', 1234, { count: '1,234' })).toBe('1,234 ayahs')
  })

  it('lists the UI languages', () => {
    expect(LOCALES).toEqual(['en', 'ar'])
  })
})

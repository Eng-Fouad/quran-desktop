import { describe, expect, it } from 'vitest'
import { PLURAL_CATEGORIES } from '$lib/contracts/i18n'
import { APP_ERROR_KINDS } from '$lib/ipc'
import { ar, dictionaries, en, interpolate, lookup, translate, translatePlural } from './index'

type Tree = { [key: string]: string | Tree }

const isPlural = (v: unknown): v is Record<string, string> =>
  typeof v === 'object' && v !== null && 'one' in v && 'other' in v

/** Dotted leaf paths; plural groups are leaves. */
function leaves(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k
    return typeof v === 'string' || isPlural(v) ? [path] : leaves(v, path)
  })
}

function plurals(tree: Tree, prefix = ''): [string, Record<string, string>][] {
  return Object.entries(tree).flatMap(([k, v]): [string, Record<string, string>][] => {
    const path = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') return []
    return isPlural(v) ? [[path, v]] : plurals(v, path)
  })
}

const enTree = en as unknown as Tree
const arTree = ar as unknown as Tree

describe('dictionaries', () => {
  it('have the same keys in English and Arabic', () => {
    expect(leaves(arTree).sort()).toEqual(leaves(enTree).sort())
  })

  it('import every §11.1 domain', () => {
    expect(Object.keys(en).sort()).toEqual(
      [
        'about',
        'common',
        'content',
        'downloads',
        'errors',
        'fonts',
        'furniture',
        'interactions',
        'library',
        'memo',
        'mushaf',
        'navigation',
        'notes',
        'onboarding',
        'pagenav',
        'palette',
        'player',
        'reader',
        'search',
        'settings',
        'shell',
        'shortcuts',
        'sidepane',
      ].sort(),
    )
  })

  it('define all six plural categories in every Arabic plural', () => {
    for (const [path, plural] of plurals(arTree)) {
      expect(Object.keys(plural).sort(), path).toEqual([...PLURAL_CATEGORIES].sort())
    }
    for (const [path, plural] of plurals(enTree)) {
      expect(plural.one && plural.other, path).toBeTruthy()
    }
  })

  it('have a non-empty string for every key', () => {
    for (const [lang, tree] of [
      ['en', enTree],
      ['ar', arTree],
    ] as const) {
      for (const path of leaves(tree)) {
        const v = lookup(lang, path)
        const values = isPlural(v) ? Object.values(v) : [v]
        for (const s of values)
          expect(typeof s === 'string' && s.trim().length > 0, `${lang} ${path}`).toBe(true)
      }
    }
  })

  it('give every AppError kind a message (§11.1)', () => {
    expect(Object.keys(en.errors).sort()).toEqual([...APP_ERROR_KINDS].sort())
  })

  it('label every §10.1 shortcut row', () => {
    const rows = leaves(enTree.shortcuts as Tree).filter((p) => !/^(groups|keys)\.|^or$/.test(p))
    expect(rows.length).toBeGreaterThanOrEqual(60)
    expect(Object.keys(en.shortcuts.groups).sort()).toEqual(
      ['app', 'audio', 'memorize', 'navigation', 'study', 'view'].sort(),
    )
  })

  it('carry the common seed of §11.1', () => {
    for (const key of [
      'ok',
      'cancel',
      'undo',
      'redo',
      'retry',
      'close',
      'delete',
      'save',
      'edit',
      'search',
      'download',
      'remove',
      'pause',
      'resume',
      'loading',
      'error',
      'details',
      'install',
      'update',
      'offline',
      'copy',
      'play',
    ]) {
      expect(en.common, key).toHaveProperty(key)
    }
  })

  it('name the digit systems Western and Eastern Arabic numbers, never Indic or Indian (IMPLEMENTATION_NOTES §13)', () => {
    expect(en.settings.options.digits).toEqual({
      auto: 'Automatic',
      latin: 'Western Arabic numbers',
      arabic_indic: 'Eastern Arabic numbers',
    })
    expect(ar.settings.options.digits).toEqual({
      auto: 'تلقائي',
      latin: 'الأرقام العربية الغربية',
      arabic_indic: 'الأرقام العربية الشرقية',
    })
    const texts = (lang: 'en' | 'ar', tree: Tree, under = '') =>
      leaves(tree)
        .filter((p) => p.startsWith(under))
        .flatMap((p) => {
          const v = lookup(lang, p)
          return (isPlural(v) ? Object.values(v) : [v]).map((t) => [p, String(t)] as const)
        })
    for (const [path, text] of texts('en', enTree)) expect(text, path).not.toMatch(/\bindic\b|\bindian\b/iu)
    // Only the settings: «الهندية» names the Hindi language of a translation elsewhere, which is right.
    for (const [path, text] of texts('ar', arTree, 'settings.')) {
      expect(text, path).not.toMatch(/هندي|indic|indian/iu)
    }
  })

  it('keep Arabic text Arabic', () => {
    expect(ar.common.cancel).toMatch(/\p{Script=Arabic}/u)
    expect(ar.shortcuts.nav.nextPage).toMatch(/\p{Script=Arabic}/u)
    expect(ar.errors.offline).toMatch(/\p{Script=Arabic}/u)
    expect(dictionaries.ar).toBe(ar)
  })
})

describe('runtime helpers', () => {
  it('interpolates named parameters and leaves unknown ones visible', () => {
    expect(interpolate('Page {page} of {total}', { page: 3, total: 604 })).toBe('Page 3 of 604')
    expect(interpolate('Page {page}', {})).toBe('Page {page}')
    expect(interpolate('plain')).toBe('plain')
  })

  it('translates with fallback to the key', () => {
    expect(translate('en', 'common.cancel')).toBe('Cancel')
    expect(translate('ar', 'common.cancel')).toBe('إلغاء')
    expect(translate('en', 'common.pageNumber', { page: 262 })).toBe('Page 262')
    expect(translate('ar', 'shortcuts.app.palette')).toBe('لوحة الأوامر')
    expect(translate('en', 'missing.key' as 'common.ok')).toBe('missing.key')
  })

  it('selects plural categories with Intl.PluralRules', () => {
    expect(translatePlural('en', 'common.ayahCount', 1)).toBe('1 ayah')
    expect(translatePlural('en', 'common.ayahCount', 7)).toBe('7 ayahs')
    expect(translatePlural('ar', 'common.ayahCount', 0)).toBe('لا آيات')
    expect(translatePlural('ar', 'common.ayahCount', 2)).toBe('آيتان')
    expect(translatePlural('ar', 'common.ayahCount', 7)).toBe('7 آيات')
    expect(translatePlural('ar', 'common.ayahCount', 11)).toBe('11 آية')
    expect(translatePlural('ar', 'common.ayahCount', 100)).toBe('100 آية')
  })
})

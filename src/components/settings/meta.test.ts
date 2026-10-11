/**
 * `settingsMeta` (WP12b acceptance, §14.3): every `Settings` field, nested sub-fields included, has an entry; every text
 * it names exists in both dictionaries; ranges are the validated ranges; and the settings search finds rows by their
 * texts in either UI language.
 */
import { describe, expect, it } from 'vitest'
import { defaultSettings, SETTING_LIMITS } from '$lib/contracts/settings'
import { isTextKey, lookup } from '$lib/i18n'
import type { Settings } from '$lib/ipc/bindings'
import {
  metaOf,
  ROW_IDS,
  rowsOf,
  SETTING_ACTIONS,
  type SettingMeta,
  settingsMeta,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  searchRows,
  searchText,
} from './meta'

const NESTED = ['sidePane', 'sidebar', 'copy'] as const
const defaults = defaultSettings()

/** Every (path, meta) pair: the flat fields, the nested sub-fields and the action rows. */
function allMeta(): [string, SettingMeta][] {
  const out: [string, SettingMeta][] = []
  for (const [key, meta] of Object.entries(settingsMeta) as [string, SettingMeta & { fields?: object }][]) {
    if (meta.fields) {
      out.push([key, meta])
      for (const [sub, subMeta] of Object.entries(meta.fields) as [string, SettingMeta][])
        out.push([`${key}.${sub}`, subMeta])
    } else out.push([key, meta])
  }
  for (const [key, meta] of Object.entries(SETTING_ACTIONS)) out.push([key, meta])
  return out
}

describe('settingsMeta covers every setting', () => {
  it('has an entry for every Settings key and no other', () => {
    expect(Object.keys(settingsMeta).sort()).toEqual(Object.keys(defaults).sort())
  })

  it.each(NESTED)('lists every sub-field of %s', (key) => {
    const fields = Object.keys(settingsMeta[key].fields).sort()
    expect(fields).toEqual(Object.keys(defaults[key]).sort())
  })

  it('gives every row id exactly once: flat fields, nested sub-fields, then actions', () => {
    const expected = [
      ...Object.keys(defaults).flatMap((k) =>
        (NESTED as readonly string[]).includes(k)
          ? Object.keys(defaults[k as (typeof NESTED)[number]]).map((sub) => `${k}.${sub}`)
          : [k],
      ),
      ...Object.keys(SETTING_ACTIONS),
    ]
    expect([...ROW_IDS].sort()).toEqual(expected.sort())
    expect(new Set(ROW_IDS).size).toBe(ROW_IDS.length)
  })

  it('finds the metadata of every row, and nothing for unknown ids', () => {
    for (const id of ROW_IDS) expect(metaOf(id), id).toBeDefined()
    expect(metaOf('sidePane.widthPx')?.range).toEqual({ min: 320, max: 640, step: 10 })
    expect(metaOf('sidePane')).toBeUndefined() // a parent is not a row
    expect(metaOf('nope')).toBeUndefined()
    expect(metaOf('theme.nope')).toBeUndefined()
    expect(metaOf('sidePane.nope')).toBeUndefined()
    expect(metaOf('constructor')).toBeUndefined()
  })

  it('places every row in a known section and group, and every section has rows', () => {
    for (const [id, meta] of allMeta()) {
      expect(SETTINGS_SECTIONS, id).toContain(meta.section)
      expect(SETTINGS_GROUPS, id).toContain(meta.group)
    }
    for (const section of SETTINGS_SECTIONS) expect(rowsOf(section).length, section).toBeGreaterThan(0)
  })
})

describe('settingsMeta texts', () => {
  it.each(['en', 'ar'] as const)('resolves every label, description and keyword list in %s', (locale) => {
    for (const [id, meta] of allMeta()) {
      for (const key of [meta.label, meta.description, meta.keywords]) {
        if (key === undefined) continue
        expect(typeof lookup(locale, key), `${id}: ${key}`).toBe('string')
      }
    }
  })

  it('labels every boolean field with a translatable key (the command palette shows them, WP10c)', () => {
    for (const [key, value] of Object.entries(defaults)) {
      if (typeof value !== 'boolean') continue
      const label = settingsMeta[key as keyof Settings].label
      expect(isTextKey(label), key).toBe(true)
    }
  })

  it.each(['en', 'ar'] as const)('names the options of every choice in %s', (locale) => {
    for (const [id, meta] of allMeta()) {
      if (!meta.options) continue
      const node = lookup(locale, meta.options)
      expect(typeof node, `${id}: ${meta.options}`).toBe('object')
    }
    // Each value of the enums the view offers has a label.
    const theme = lookup(locale, 'settings.options.theme') as Record<string, string>
    for (const v of ['system', 'paper', 'sepia', 'night', 'black', 'high_contrast'])
      expect(theme[v]).toBeTruthy()
  })

  it.each(['en', 'ar'] as const)('titles every section and group in %s', (locale) => {
    for (const s of SETTINGS_SECTIONS) {
      expect(typeof lookup(locale, `settings.sections.${s}.title`), s).toBe('string')
      expect(typeof lookup(locale, `settings.sections.${s}.lede`), s).toBe('string')
    }
    for (const g of SETTINGS_GROUPS) expect(typeof lookup(locale, `settings.groups.${g}`), g).toBe('string')
  })
})

describe('settingsMeta ranges', () => {
  const L = SETTING_LIMITS
  it.each([
    ['uiScalePct', L.uiScalePct],
    ['inkBrightnessPct', L.inkBrightnessPct],
    ['zoomPct', L.zoomPct],
    ['translationFontPct', L.translationFontPct],
    ['speedPct', L.speedPct],
    ['volumePct', L.volumePct],
    ['ayahRepeat', L.repeat],
    ['rangeRepeat', L.repeat],
    ['streamCacheCapMib', L.streamCacheCapMib],
    ['sidePane.widthPx', L.sidePaneWidthPx],
    ['sidebar.widthPx', L.sidebarWidthPx],
  ] as const)('%s spans the validated range, on a step grid that holds the default', (id, limit) => {
    const range = metaOf(id)?.range
    expect(range).toBeDefined()
    if (!range) return
    expect([range.min, range.max]).toEqual([limit.min, limit.max])
    // The step is a multiple of the validated step, and the UI steps divide the range.
    expect(range.step % limit.step).toBe(0)
    expect((range.max - range.min) % range.step).toBe(0)
  })

  it('keeps the UI scale and speed steps of §5.11', () => {
    expect(settingsMeta.uiScalePct.range).toEqual({ min: 80, max: 200, step: 10 })
    expect(settingsMeta.speedPct.range).toEqual({ min: 50, max: 200, step: 5 })
    expect(settingsMeta.inkBrightnessPct.range).toEqual({ min: 65, max: 100, step: 1 })
  })

  it('gives the pause between repeats both of its ranges', () => {
    expect(settingsMeta.gap.ranges?.fixedMs).toMatchObject({ min: L.gapFixedMs.min, max: L.gapFixedMs.max })
    expect(settingsMeta.gap.ranges?.multiplierPct).toMatchObject({
      min: L.gapMultiplierPct.min,
      max: L.gapMultiplierPct.max,
    })
  })

  it('caps the translations list at five', () => {
    expect(settingsMeta.translations.range?.max).toBe(L.maxTranslations)
  })
})

describe('settings search', () => {
  it('matches nothing for a blank query', () => {
    expect(searchRows('', 'en').size).toBe(0)
    expect(searchRows('   ', 'ar').size).toBe(0)
  })

  it('finds rows by label, description, keywords and option names', () => {
    expect(searchRows('theme', 'en')).toContain('theme')
    expect(searchRows('sepia', 'en')).toContain('lightVariant') // an option name
    expect(searchRows('glare', 'en')).toContain('inkBrightnessPct') // the description
    expect(searchRows('mica', 'en')).toContain('chromeEffect') // a keyword
    expect(searchRows('offline', 'en')).toContain('networkAllowed')
    expect(searchRows('cache', 'en')).toEqual(new Set(['clearCache', 'streamCacheCapMib']))
  })

  it('needs every word of the query, in any order', () => {
    const both = searchRows('pane width', 'en')
    expect(both).toContain('sidePane.widthPx')
    expect(both).not.toContain('sidePane.open')
    expect(searchRows('width pane', 'en')).toEqual(both)
    expect(searchRows('zzzz', 'en').size).toBe(0)
  })

  it('matches section and group names too', () => {
    const storage = searchRows('storage', 'en')
    for (const id of rowsOf('storage')) expect(storage).toContain(id)
  })

  it('finds rows by Arabic words in the Arabic UI, folding letter forms and harakat', () => {
    expect(searchRows('السمة', 'ar')).toContain('theme')
    expect(searchRows('الشبكة', 'ar')).toContain('networkAllowed')
    // Alef with hamza and ta marbuta fold like the combobox filter: "اعادة" finds "إعادة".
    expect(searchRows('اعادة ضبط', 'ar')).toContain('resetAll')
  })

  it('also finds rows by their English words in the Arabic UI', () => {
    expect(searchRows('theme', 'ar')).toContain('theme')
    expect(searchRows('volume', 'ar')).toContain('volumePct')
  })

  it('is case-insensitive', () => {
    expect(searchRows('TAJWEED', 'en')).toContain('tajweedColors')
    expect(searchText('tajweedColors', 'en')).toBe(searchText('tajweedColors', 'en').toLowerCase())
  })
})

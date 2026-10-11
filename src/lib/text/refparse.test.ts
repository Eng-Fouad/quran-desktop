/**
 * The reference parser (§10.4) against its golden vectors (`refparse.vectors.json`, §12.3), plus the localised reasons,
 * the options and the target helpers. The index is the synthetic one (Tanzil metadata and names), so surah-name cases
 * hold for any transliteration style.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { defaultSettings } from '$lib/contracts/settings'
import type { Bootstrap, QuranIndex } from '$lib/ipc/bindings'
import { syntheticIndex } from '$lib/ipc/mock/synthetic'
import { LRI, PDI, RLI } from '$lib/stores/i18n.svelte'
import { quran } from '$lib/stores/quran.svelte'
import { settings } from '$lib/stores/settings.svelte'
import {
  DEFAULT_LIMITS,
  describeTarget,
  limits,
  type ParseResult,
  parseReference,
  type ParsedTarget,
  targetAyahId,
  targetKey,
  targetPage,
} from './refparse'
import vectors from './refparse.vectors.json'

interface Expected {
  target: ParsedTarget
  source: ParseResult['source']
  issue?: ParseResult['issue']
}

interface Case {
  in: string
  out?: Expected[]
  first?: Expected
}

let index: QuranIndex

function boot(uiLanguage: 'en' | 'ar' = 'en'): void {
  settings.value = { ...settings.value, uiLanguage }
  quran.init({ index, settings: { ...defaultSettings(), uiLanguage } } as unknown as Bootstrap)
}

/** The comparable part of a result (the reason text is language-dependent and checked separately). */
const shape = (r: ParseResult): Expected =>
  r.issue === undefined
    ? { target: r.target, source: r.source }
    : { target: r.target, source: r.source, issue: r.issue }

beforeAll(() => {
  index = syntheticIndex()
})

afterEach(() => {
  quran.reset()
  settings.reset()
})

describe('parseReference: golden vectors', () => {
  const cases = (vectors as { cases: Case[] }).cases

  it('has vectors for every form of §10.4', () => {
    expect(cases.length).toBeGreaterThanOrEqual(60)
  })

  it.each(cases.map((c) => [c.in, c] as const))('%j', (_label, c) => {
    boot()
    const results = parseReference(c.in)
    if (c.out !== undefined) expect(results.map(shape)).toEqual(c.out)
    if (c.first !== undefined) expect(results[0] && shape(results[0])).toEqual(c.first)
    for (const r of results) {
      // A reason exactly when there is an issue.
      expect(r.disabledReason === undefined).toBe(r.issue === undefined)
    }
  })
})

describe('parseReference: reasons and options', () => {
  it('explains out-of-range targets in the UI language', () => {
    boot()
    expect(parseReference('2:300')[0]?.disabledReason).toBe('Al-Baqara has 286 ayahs')
    expect(parseReference('p 700')[0]?.disabledReason).toBe('The Mushaf has 604 pages')
    expect(parseReference('j 31')[0]?.disabledReason).toBe('There are 30 juz')
    expect(parseReference('h 61')[0]?.disabledReason).toBe('There are 60 hizb')
    expect(parseReference('s 115')[0]?.disabledReason).toBe('There are 114 surahs')
    expect(parseReference('2:9-3')[0]?.disabledReason).toBe('The range ends before it starts')
    boot('ar')
    expect(parseReference('2:300')[0]?.disabledReason).toBe('في سورة البقرة ٢٨٦ آية')
    expect(parseReference('ص ٧٠٠')[0]?.disabledReason).toBe('عدد صفحات المصحف ٦٠٤')
  })

  it('skips surah names when asked, and limits them', () => {
    boot()
    expect(parseReference('kahf', { names: false })).toEqual([])
    expect(parseReference('kahf 10', { names: false })).toEqual([])
    expect(parseReference('2:255', { names: false })).toHaveLength(1)
    expect(parseReference('al', { nameLimit: 3 })).toHaveLength(3)
    expect(parseReference('al').length).toBeLessThanOrEqual(5)
  })

  it('works before the index is loaded (Madani limits, no names)', () => {
    expect(limits()).toEqual(DEFAULT_LIMITS)
    expect(parseReference('p 604').map(shape)).toEqual([
      { target: { type: 'page', page: 604 }, source: 'ref' },
    ])
    expect(parseReference('kahf')).toEqual([])
  })
})

describe('targets', () => {
  it('has stable keys', () => {
    expect(targetKey({ type: 'ayah', surah: 2, ayah: 255 })).toBe('ayah:2:255')
    expect(targetKey({ type: 'ayah', surah: 2, ayah: 255, toAyah: 257 })).toBe('ayah:2:255-257')
    expect(targetKey({ type: 'page', page: 262 })).toBe('page:262')
    expect(targetKey({ type: 'juz', juz: 15 })).toBe('juz:15')
    expect(targetKey({ type: 'hizb', hizb: 30 })).toBe('hizb:30')
    expect(targetKey({ type: 'surah', surah: 18 })).toBe('surah:18')
  })

  it('resolves the first ayah and the page of every kind', () => {
    boot()
    expect(targetAyahId({ type: 'ayah', surah: 2, ayah: 255 }, 'v2')).toBe(262)
    expect(targetAyahId({ type: 'surah', surah: 18 }, 'v2')).toBe(quran.surahRange(18).from)
    expect(targetAyahId({ type: 'juz', juz: 2 }, 'v2')).toBe(149)
    expect(targetAyahId({ type: 'hizb', hizb: 60 }, 'v2')).toBe(quran.hizbRange(60).from)
    expect(targetAyahId({ type: 'page', page: 2 }, 'v2')).toBe(8)
    expect(targetAyahId({ type: 'ayah', surah: 2, ayah: 300 }, 'v2')).toBe(0)
    expect(targetAyahId({ type: 'juz', juz: 31 }, 'v2')).toBe(0)
    expect(targetPage({ type: 'ayah', surah: 2, ayah: 6 }, 'v2')).toBe(3)
    expect(targetPage({ type: 'page', page: 262 }, 'v2')).toBe(262)
    expect(targetPage({ type: 'page', page: 605 }, 'v2')).toBe(0)
    expect(targetPage({ type: 'surah', surah: 1 }, 'v2')).toBe(1)
  })

  it('describes targets in English', () => {
    boot()
    const page262 = quran.pageOfAyah('v2', 262)
    expect(describeTarget({ type: 'ayah', surah: 2, ayah: 255 }, 'v2')).toEqual({
      title: `Al-Baqara ${LRI}2:255${PDI}`,
      detail: `Juz 3 · Page ${page262}`,
    })
    expect(describeTarget({ type: 'ayah', surah: 2, ayah: 255, toAyah: 257 }, 'v2').title).toBe(
      `Al-Baqara ${LRI}2:255–257${PDI}`,
    )
    expect(describeTarget({ type: 'page', page: 1 }, 'v2')).toEqual({
      title: 'Page 1',
      detail: 'Al-Faatiha · Juz 1',
    })
    expect(describeTarget({ type: 'juz', juz: 1 }, 'v2')).toEqual({
      title: 'Juz 1',
      detail: `Al-Faatiha ${LRI}1:1${PDI} · Page 1`,
    })
    expect(describeTarget({ type: 'hizb', hizb: 1 }, 'v2').title).toBe('Hizb 1')
    expect(describeTarget({ type: 'surah', surah: 18 }, 'v2')).toEqual({
      title: 'Al-Kahf',
      detail: 'Surah 18 · The Cave · Meccan · 110 ayahs',
    })
    // Out of range: the title keeps its form, the reason is the result's.
    expect(describeTarget({ type: 'ayah', surah: 2, ayah: 300 }, 'v2')).toEqual({
      title: `Al-Baqara ${LRI}2:300${PDI}`,
      detail: '',
    })
    expect(describeTarget({ type: 'page', page: 700 }, 'v2')).toEqual({ title: 'Page 700', detail: '' })
  })

  it('describes targets in Arabic with Arabic-Indic digits', () => {
    boot('ar')
    expect(describeTarget({ type: 'surah', surah: 18 }, 'v2')).toEqual({
      title: 'الكهف',
      detail: 'سورة ١٨، مكية، ١١٠ آيات', // CLDR: 110 is "few"
    })
    expect(describeTarget({ type: 'ayah', surah: 2, ayah: 255 }, 'v2').title).toBe(`البقرة ${RLI}٢:٢٥٥${PDI}`)
  })
})

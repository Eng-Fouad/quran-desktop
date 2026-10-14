import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { defaultSettings } from '$lib/contracts/settings'
import type { Bootstrap, QuranIndex } from '$lib/ipc/bindings'
import { syntheticIndex } from '$lib/ipc/mock/synthetic'
import { app } from './app.svelte'
import { i18n, LRI, PDI, RLI } from './i18n.svelte'
import { buildSurahKeys, EMPTY_RANGE, editDistance, quran, rankSurahNames } from './quran.svelte'
import { settings } from './settings.svelte'

// The synthetic index carries the real Tanzil metadata (surahs, divisions, the 604 page starts) with invented word ids.
let index: QuranIndex
/** The exported fixture index (Quran.com names; generated, gitignored): its test runs only when it exists. */
const FIXTURE_INDEX = resolve('src/lib/ipc/mock/fixtures/index.json')

function boot(idx: QuranIndex, uiLanguage: 'en' | 'ar' = 'en'): void {
  const b = { index: idx, settings: { ...defaultSettings(), uiLanguage } } as unknown as Bootstrap
  settings.value = { ...settings.value, uiLanguage }
  quran.init(b)
}

beforeAll(() => {
  index = syntheticIndex()
})

afterEach(() => {
  quran.reset()
  settings.reset()
  app.reset()
})

describe('quran store: ayahs and surahs', () => {
  it('is empty before bootstrap', () => {
    expect(quran.ayahCount).toBe(0)
    expect(quran.surah(1)).toBeUndefined()
    expect(quran.ayahRef(1)).toEqual({ surah: 0, ayah: 0 })
    expect(quran.pageRange('v2', 1)).toEqual(EMPTY_RANGE)
    expect(quran.pageOfAyah('v2', 1)).toBe(1)
  })

  it('maps ayah ids and references both ways', () => {
    boot(index)
    expect(quran.ayahCount).toBe(6236)
    expect(quran.surah(2)?.nameAr).toBe('البقرة')
    expect(quran.ayahRef(1)).toEqual({ surah: 1, ayah: 1 })
    expect(quran.ayahRef(262)).toEqual({ surah: 2, ayah: 255 })
    expect(quran.ayahRef(6236)).toEqual({ surah: 114, ayah: 6 })
    expect(quran.ayahId(2, 255)).toBe(262)
    expect(quran.ayahId(114, 6)).toBe(6236)
    for (let id = 1; id <= 6236; id += 97) {
      const { surah, ayah } = quran.ayahRef(id)
      expect(quran.ayahId(surah, ayah)).toBe(id)
    }
  })

  it('rejects ids that do not exist', () => {
    boot(index)
    expect(quran.ayahRef(0)).toEqual({ surah: 0, ayah: 0 })
    expect(quran.ayahRef(6237)).toEqual({ surah: 0, ayah: 0 })
    expect(quran.ayahRef(1.5)).toEqual({ surah: 0, ayah: 0 })
    expect(quran.ayahId(2, 287)).toBe(0)
    expect(quran.ayahId(2, 0)).toBe(0)
    expect(quran.ayahId(115, 1)).toBe(0)
    expect(quran.surah(0)).toBeUndefined()
    expect(quran.surah(115)).toBeUndefined()
    expect(quran.firstWordOf(0)).toBe(0)
    expect(quran.isAyahId(6236)).toBe(true)
    expect(quran.isAyahId(6237)).toBe(false)
  })

  it('maps words to ayahs', () => {
    boot(index)
    for (const id of [1, 2, 262, 6235, 6236]) {
      const first = quran.firstWordOf(id)
      expect(quran.ayahOfWord(first)).toBe(id)
      if (id > 1) expect(quran.ayahOfWord(first - 1)).toBe(id - 1)
    }
    expect(quran.ayahOfWord(0)).toBe(0)
  })

  it('names surahs in the UI language', () => {
    boot(index)
    expect(quran.surahName(18)).toBe('Al-Kahf')
    boot(index, 'ar')
    expect(quran.surahName(18)).toBe('الكهف')
    expect(quran.surahName(0)).toBe('')
  })
})

describe('quran store: divisions', () => {
  it('finds the juz, hizb, rub and manzil of an ayah', () => {
    boot(index)
    expect(quran.juzOf(1)).toBe(1)
    expect(quran.juzOf(148)).toBe(1)
    expect(quran.juzOf(149)).toBe(2) // 2:142
    expect(quran.juzOf(5673)).toBe(30) // 78:1
    expect(quran.juzOf(6236)).toBe(30)
    expect(quran.hizbOf(1)).toBe(1)
    expect(quran.hizbOf(6236)).toBe(60)
    expect(quran.rubOf(1)).toBe(1)
    expect(quran.rubOf(6236)).toBe(240)
    expect(quran.manzilOf(6236)).toBe(7)
    expect(quran.juzOf(0)).toBe(0)
    expect(quran.juzOf(6237)).toBe(0)
  })

  it('gives surahs, juz and hizb as ayah-id ranges', () => {
    boot(index)
    expect(quran.surahRange(1)).toEqual({ from: 1, to: 7 })
    expect(quran.surahRange(2)).toEqual({ from: 8, to: 293 })
    expect(quran.surahRange(114)).toEqual({ from: 6231, to: 6236 })
    expect(quran.surahRange(115)).toEqual(EMPTY_RANGE)
    expect(quran.juzRange(1)).toEqual({ from: 1, to: 148 })
    expect(quran.juzRange(30)).toEqual({ from: 5673, to: 6236 })
    expect(quran.juzRange(31)).toEqual(EMPTY_RANGE)
    expect(quran.hizbRange(1).from).toBe(1)
    expect(quran.hizbRange(60).to).toBe(6236)
  })
})

describe('quran store: pages', () => {
  it('finds the page of an ayah and of a word', () => {
    boot(index)
    expect(quran.pageCount('v2')).toBe(604)
    expect(quran.pageOfAyah('v2', 1)).toBe(1)
    expect(quran.pageOfAyah('v2', 7)).toBe(1)
    expect(quran.pageOfAyah('v2', 8)).toBe(2) // 2:1
    expect(quran.pageOfAyah('v2', 13)).toBe(3) // 2:6
    expect(quran.pageOfAyah('v1', 6236)).toBe(604)
    expect(quran.pageOfWord('v2', quran.firstWordOf(13))).toBe(3)
    expect(quran.pageOfWord('v2', quran.firstWordOf(13) - 1)).toBe(2)
    expect(quran.pageOfAyah('v2', 0)).toBe(1)
  })

  it('gives every page its ayahs, covering the whole Quran exactly once', () => {
    boot(index)
    expect(quran.pageRange('v2', 1)).toEqual({ from: 1, to: 7 })
    expect(quran.pageRange('v2', 2)).toEqual({ from: 8, to: 12 })
    expect(quran.pageRange('v2', 604).to).toBe(6236)
    expect(quran.pageRange('v2', 0)).toEqual(EMPTY_RANGE)
    expect(quran.pageRange('v2', 605)).toEqual(EMPTY_RANGE)
    let next = 1
    for (let p = 1; p <= 604; p++) {
      const { from, to } = quran.pageRange('v2', p)
      expect(from, `page ${p}`).toBe(next)
      expect(quran.pageOfAyah('v2', from), `page ${p}`).toBe(p)
      expect(quran.pageOfAyah('v2', to), `page ${p}`).toBe(p)
      next = to + 1
    }
    expect(next).toBe(6237)
  })

  it('includes an ayah that continues from the previous page', () => {
    // Move page 3's start one word into 2:5 (ayah 12): 2:5 then shows on pages 2 and 3.
    const v2 = index.layouts.find((l) => l.layout === 'v2')
    if (!v2) throw new Error('no v2 layout')
    const pageFirstWord = [...v2.pageFirstWord]
    pageFirstWord[2] = (index.ayahFirstWord[11] ?? 0) + 1
    boot({ ...index, layouts: [{ ...v2, pageFirstWord }] })
    expect(quran.pageRange('v2', 2)).toEqual({ from: 8, to: 12 })
    expect(quran.pageRange('v2', 3).from).toBe(12)
    expect(quran.pageOfAyah('v2', 12)).toBe(2)
  })

  it('falls back to page-start ayahs without word tables, and to neutral values without a layout', () => {
    boot({ ...index, ayahFirstWord: [] })
    expect(quran.pageRange('v2', 2)).toEqual({ from: 8, to: 12 })
    expect(quran.pageOfAyah('v2', 13)).toBe(3)
    boot({ ...index, layouts: index.layouts.filter((l) => l.layout !== 'v4') })
    expect(quran.layout('v4')).toBeUndefined()
    expect(quran.pageCount('v4')).toBe(0)
    expect(quran.pageOfAyah('v4', 262)).toBe(1)
    expect(quran.pageRange('v4', 1)).toEqual(EMPTY_RANGE)
  })
})

describe('quran store: surah names', () => {
  const top = (q: string) => quran.surahMatches(q)[0]?.id
  const ids = (q: string, n = 5) => quran.surahMatches(q, n).map((s) => s.id)

  it('matches nothing before bootstrap, for blank and for numeric queries', () => {
    expect(quran.surahMatches('kahf')).toEqual([])
    boot(index)
    expect(quran.surahMatches('')).toEqual([])
    expect(quran.surahMatches('   ')).toEqual([])
    expect(quran.surahMatches('18')).toEqual([])
    expect(quran.surahMatches('١٨')).toEqual([])
  })

  it('finds a surah by its Latin name, with or without the article', () => {
    boot(index)
    expect(top('Al-Kahf')).toBe(18)
    expect(top('kahf')).toBe(18)
    expect(top('al kahf')).toBe(18)
    expect(top('Surah al-Kahf')).toBe(18)
    expect(top('baqara')).toBe(2)
    expect(top('Baqarah')).toBe(2)
    expect(top('bakara')).toBe(2)
    expect(top('ash-shams')).toBe(91)
    expect(top('shams')).toBe(91)
    expect(top('an nas')).toBe(114)
    expect(top('nas')).toBe(114)
  })

  it('folds transliteration variants (Tanzil and Quran.com spellings)', () => {
    boot(index)
    expect(top('yasin')).toBe(36)
    expect(top('Ya-Sin')).toBe(36)
    expect(top('yaseen')).toBe(36)
    expect(top('fatiha')).toBe(1)
    expect(top('Al-Fātiĥah')).toBe(1)
    expect(top('rahman')).toBe(55)
    expect(top('ikhlas')).toBe(112)
    expect(top('muzammil')).toBe(73)
    expect(top('nuh')).toBe(71)
    expect(top("Ali 'Imran")).toBe(3)
    expect(top('al imran')).toBe(3)
    expect(top('imran')).toBe(3)
    expect(top('quraysh')).toBe(106)
    expect(top('layl')).toBe(92)
    expect(top('muminun')).toBe(23)
  })

  it('finds surahs by their English meaning and by common aliases', () => {
    boot(index)
    expect(top('the cave')).toBe(18)
    expect(top('cave')).toBe(18)
    expect(top('cow')).toBe(2)
    expect(top('tabarak')).toBe(67)
    expect(top('bani israil')).toBe(17)
    expect(top('dahr')).toBe(76)
    expect(top('inshirah')).toBe(94)
    expect(top('lahab')).toBe(111)
    expect(top('tawbah')).toBe(9)
    expect(top("bara'ah")).toBe(9)
    expect(top('amma')).toBe(78)
  })

  it('finds a surah by its Arabic name, ignoring harakat, hamza, alef and ta marbuta forms', () => {
    boot(index)
    expect(top('الكهف')).toBe(18)
    expect(top('كهف')).toBe(18)
    expect(top('سورة الكهف')).toBe(18)
    expect(top('البقرة')).toBe(2)
    expect(top('بقره')).toBe(2)
    expect(top('ٱلْبَقَرَة')).toBe(2)
    expect(top('الرحمان')).toBe(55)
    expect(top('النبأ')).toBe(78)
    expect(top('سبأ')).toBe(34)
    expect(top('آل عمران')).toBe(3)
    expect(top('عمران')).toBe(3)
    expect(top('إبراهيم')).toBe(14)
    expect(top('ياسين')).toBe(36)
    expect(top('يس')).toBe(36)
    expect(top('تبارك')).toBe(67)
    expect(top('ص')).toBe(38)
    expect(top('ق')).toBe(50)
    expect(top('ن')).toBe(68)
  })

  it('ranks exact names before prefixes and prefixes before substrings', () => {
    boot(index)
    // An-Nas (exact) before An-Nasr (prefix); Al-Fath (exact) before Al-Fatihah (Arabic prefix).
    expect(ids('nas', 2)).toEqual([114, 110])
    expect(ids('الفتح', 2)).toEqual([48, 1])
    // As-Sajdah (core.db name) before Fussilat ("Ha Mim Sajdah", an alias).
    expect(ids('sajdah', 2)).toEqual([32, 41])
    // A prefix while typing.
    expect(ids('ka', 3)).toEqual(expect.arrayContaining([18]))
    expect(top('kah')).toBe(18)
  })

  it('ranks a name matching as written before one matching only through the skeleton', () => {
    boot(index)
    // "ka" is a prefix of Al-Kahf as written; Qaf matches only because q and k fold together.
    expect(top('ka')).toBe(18)
    const ka = ids('ka', 10)
    expect(ka.indexOf(18)).toBeLessThan(ka.indexOf(50))
    expect(top('qa')).toBe(50)
  })

  it.runIf(existsSync(FIXTURE_INDEX))('matches the Quran.com names of a real core.db', () => {
    boot(JSON.parse(readFileSync(FIXTURE_INDEX, 'utf8')) as QuranIndex)
    expect(top('fatiha')).toBe(1)
    expect(top('Al-Fātiĥah')).toBe(1)
    expect(top('yaseen')).toBe(36)
    expect(top('imraan')).toBe(3)
    expect(top('muminoon')).toBe(23)
    expect(top('ad-duha')).toBe(93)
    expect(top('النبأ')).toBe(78)
    expect(top('الانسان')).toBe(76)
    expect(top('kahf')).toBe(18)
  })

  it('tolerates a typo', () => {
    boot(index)
    expect(top('kahff')).toBe(18)
    expect(top('baqqarah')).toBe(2)
    expect(top('maryem')).toBe(19)
    expect(top('zukhrof')).toBe(43)
    expect(top('xyzzy')).toBeUndefined()
  })

  it('honours the limit and never repeats a surah', () => {
    boot(index)
    const all = quran.surahMatches('a')
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length)
    expect(quran.surahMatches('a', 3)).toHaveLength(3)
  })
})

describe('surah-name helpers', () => {
  it('computes the optimal-string-alignment distance with a cut-off', () => {
    expect(editDistance('kahf', 'kahf', 2)).toBe(0)
    expect(editDistance('kahf', 'khaf', 2)).toBe(1)
    expect(editDistance('kahf', 'kaf', 2)).toBe(1)
    expect(editDistance('abc', 'xyz', 1)).toBe(2)
    expect(editDistance('a', 'abcdef', 2)).toBe(3)
  })

  it('builds keys for core.db names and aliases', () => {
    const keys = buildSurahKeys(index.surahs)
    const of36 = keys.filter((k) => k.surah === 36)
    expect(of36.some((k) => k.arabic && k.key === 'يس')).toBe(true)
    expect(of36.some((k) => !k.arabic && k.key === 'iasin')).toBe(true)
    expect(rankSurahNames(keys, 'Yasin')[0]).toBe(36)
  })
})

describe('quran store: reference labels', () => {
  it('labels ayahs and ranges in each style', () => {
    boot(index)
    expect(quran.refLabel(262)).toBe(`Al-Baqara ${LRI}2:255${PDI}`)
    expect(quran.refLabel(262, 'short')).toBe(`${LRI}2:255${PDI}`)
    expect(quran.refLabel(262, 'short', 264)).toBe(`${LRI}2:255–257${PDI}`)
    expect(quran.refLabel(293, 'short', 295)).toBe(`${LRI}2:286–3:2${PDI}`)
    expect(quran.refLabel(262, 'arabic')).toBe('البقرة: ٢٥٥')
    expect(quran.refLabel(262, 'arabic', 264)).toBe('البقرة: ٢٥٥–٢٥٧')
    expect(quran.refLabel(0)).toBe('')
  })

  it('uses the Arabic name and digits in the Arabic UI', () => {
    boot(index, 'ar')
    expect(i18n.locale).toBe('ar')
    expect(quran.refLabel(262)).toBe(`البقرة ${RLI}٢:٢٥٥${PDI}`)
  })
})

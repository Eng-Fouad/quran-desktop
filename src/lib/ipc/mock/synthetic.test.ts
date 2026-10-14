import { describe, expect, it } from 'vitest'
import type { PageData } from '../bindings'
import {
  AYAH_COUNT,
  END_OF_AYAH,
  isSyntheticIndex,
  lastWordOf,
  PAGE_COUNT,
  PLACEHOLDER_WORD,
  recitersFromPacks,
  refOf,
  syntheticAyahs,
  syntheticIndex,
  syntheticPacks,
  syntheticPage,
  syntheticTimings,
  wordTotal,
} from './synthetic'

const index = syntheticIndex()
const pages: PageData[] = Array.from({ length: PAGE_COUNT }, (_, i) => syntheticPage(index, 'hafs', i + 1))

describe('synthetic index (Tanzil metadata)', () => {
  it('has the canonical counts', () => {
    expect(index.surahs).toHaveLength(114)
    expect(index.surahs.reduce((n, s) => n + s.ayahCount, 0)).toBe(AYAH_COUNT)
    expect(index.juz).toHaveLength(30)
    expect(index.hizb).toHaveLength(60)
    expect(index.rub).toHaveLength(240)
    expect(index.manzil).toHaveLength(7)
    expect(index.sajdas).toHaveLength(15)
    expect(index.ayahFirstWord).toHaveLength(AYAH_COUNT)
    expect(index.layouts.map((l) => l.layout)).toEqual(['v2', 'v1', 'v4'])
    for (const l of index.layouts) {
      expect(l.pageFirstAyah).toHaveLength(PAGE_COUNT)
      expect(l.pageFirstWord).toHaveLength(PAGE_COUNT)
    }
    expect(isSyntheticIndex(index)).toBe(true)
    expect(syntheticIndex()).toBe(index)
  })

  it('knows well-known surahs, divisions and sajdas', () => {
    expect(index.surahs[0]).toMatchObject({ id: 1, nameAr: 'الفاتحة', ayahCount: 7, bismillahPre: false })
    expect(index.surahs[1]).toMatchObject({
      id: 2,
      ayahCount: 286,
      revelationPlace: 'madinah',
      firstAyahId: 8,
    })
    expect(index.surahs[8]?.bismillahPre).toBe(false)
    expect(index.surahs[113]).toMatchObject({ id: 114, ayahCount: 6, firstAyahId: 6231 })
    expect(refOf(index, 262)).toEqual({ surah: 2, ayah: 255 })
    // Juz 2 starts at 2:142 (ayah id 149); juz 30 at 78:1.
    expect(index.juz[1]?.firstAyahId).toBe(149)
    expect(index.juz[29]?.firstAyahId).toBe(index.surahs[77]?.firstAyahId)
    expect(index.juz[29]?.lastAyahId).toBe(AYAH_COUNT)
    expect(index.sajdas.filter((s) => s.kind === 'obligatory')).toHaveLength(4)
    expect(index.layouts[0]?.pageFirstAyah.slice(0, 3)).toEqual([1, 8, 13])
  })

  it('numbers words contiguously from 1', () => {
    expect(index.ayahFirstWord[0]).toBe(1)
    for (let a = 1; a < AYAH_COUNT; a++) {
      expect((index.ayahFirstWord[a] ?? 0) - (index.ayahFirstWord[a - 1] ?? 0)).toBeGreaterThanOrEqual(2)
    }
    expect(lastWordOf(index, AYAH_COUNT)).toBe(wordTotal(index))
  })
})

describe('synthetic pages', () => {
  it('cover every word exactly once, in order, within the line budget', () => {
    let expected = 1
    for (const page of pages) {
      const budget = page.page <= 2 ? 8 : 15
      expect(page.lines.length, `page ${page.page}`).toBeLessThanOrEqual(budget)
      expect(page.lines.map((l) => l.line)).toEqual(page.lines.map((_, i) => i + 1))
      for (const line of page.lines) {
        for (const w of line.words) {
          expect(w.id, `page ${page.page}`).toBe(expected)
          expected++
        }
      }
    }
    expect(expected - 1).toBe(wordTotal(index))
  })

  it('fill the standard pages and give every surah start its header lines', () => {
    for (const page of pages) {
      if (page.page > 2) expect(page.lines.length, `page ${page.page}`).toBe(15)
      for (const a of page.ayahs.filter((x) => x.ayah === 1 && x.startsOnPage)) {
        const header = page.lines.find((l) => l.kind === 'surah_name' && l.surah === a.surah)
        expect(header, `surah ${a.surah} header on page ${page.page}`).toBeDefined()
        const basmala = page.lines.some((l) => l.kind === 'basmallah' && l.surah === a.surah)
        expect(basmala).toBe(a.surah !== 1 && a.surah !== 9)
      }
    }
  })

  it('use placeholder words, end markers with Arabic-Indic numbers, and consistent ayah rows', () => {
    const p262 = pages[261]
    expect(p262).toBeDefined()
    const words = p262?.lines.flatMap((l) => l.words) ?? []
    for (const w of words) {
      expect(w.glyph).toBe(w.text)
      if (w.isEnd) expect(w.text.startsWith(END_OF_AYAH)).toBe(true)
      else expect(w.text).toBe(PLACEHOLDER_WORD)
    }
    for (const a of p262?.ayahs ?? []) {
      expect(a.firstWordId).toBeLessThanOrEqual(a.lastWordId)
      expect(words.some((w) => w.id === a.firstWordId && w.ayahId === a.id)).toBe(true)
    }
    const p1 = pages[0]
    const end = p1?.lines.flatMap((l) => l.words).find((w) => w.isEnd && w.ayah === 7)
    expect(end?.text).toBe(`${END_OF_AYAH}٧`)
    expect(p1?.info).toMatchObject({ firstAyahId: 1, lastAyahId: 7, juz: 1, headSurah: 1, surahIds: [1] })
  })

  it('set the ayah flags from the divisions', () => {
    const first = pages[0]?.ayahs[0]
    expect(first?.flags).toBe(1 | 2 | 4 | 8)
    const juz2 = pages.flatMap((p) => p.ayahs).find((a) => a.id === 149)
    expect((juz2?.flags ?? 0) & 4).toBe(4)
  })

  it('serve every style with the style and layout set', () => {
    expect(syntheticPage(index, 'qcf_v1', 3)).toMatchObject({ style: 'qcf_v1', layout: 'v1', page: 3 })
    expect(syntheticPage(index, 'qcf_v4', 604)).toMatchObject({ style: 'qcf_v4', layout: 'v4', page: 604 })
    expect(() => syntheticPage(index, 'hafs', 605)).toThrow(RangeError)
  })
})

describe('synthetic ayahs, timings and catalogue', () => {
  it('builds ayah texts with pages', () => {
    const rows = syntheticAyahs(index, 'v2', 255, 262)
    expect(rows.map((r) => r.id)).toEqual([255, 256, 257, 258, 259, 260, 261, 262])
    expect(rows[7]).toMatchObject({ surah: 2, ayah: 255 })
    expect(rows[7]?.textHafs.endsWith(`${END_OF_AYAH}٢٥٥`)).toBe(true)
    expect(rows[0]?.page).toBeGreaterThan(1)
  })

  it('times ayahs at 1200 ms + 380 ms per word, words split evenly', () => {
    const t = syntheticTimings(index, 7, 1)
    expect(t).toMatchObject({ reciterId: 7, surah: 1, wordLevel: true })
    expect(t.ayahs).toHaveLength(7)
    const first = t.ayahs[0]
    const words = lastWordOf(index, 1) - (index.ayahFirstWord[0] ?? 0)
    expect(first?.toMs).toBe(1200 + 380 * words)
    expect(first?.words).toHaveLength(words)
    expect(t.ayahs[1]?.fromMs).toBe(first?.toMs)
    expect(t.durationMs).toBe(t.ayahs[6]?.toMs)
  })

  it('lists the seed catalogue, not installed, and derives the reciters', () => {
    const packs = syntheticPacks()
    expect(new Set(packs.map((p) => p.id)).size).toBe(packs.length)
    expect(packs.every((p) => p.state.type === 'not_installed' && p.job === null)).toBe(true)
    for (const id of ['mushaf.v2', 'decor', 'tr.en.saheeh', 'tafsir.ar.muyassar', 'audio.qdc.7', 'wbw.en']) {
      expect(
        packs.some((p) => p.id === id),
        id,
      ).toBe(true)
    }
    const reciters = recitersFromPacks(packs)
    expect(reciters.find((r) => r.id === 7)?.name.en).toBe('Mishary Rashid Alafasy')
    expect(reciters.every((r) => r.packId === `audio.qdc.${r.id}`)).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { syntheticIndex } from '$lib/ipc/mock/synthetic'
import { buildRows, estimateVerseHeight } from './rows'

const index = syntheticIndex()
const model = buildRows(index)

describe('buildRows', () => {
  it('lists a card before every surah, every verse once, and an end row', () => {
    expect(model.rows).toHaveLength(114 + 6236 + 1)
    expect(model.rows.filter((r) => r.kind === 'surah')).toHaveLength(114)
    expect(model.rows.filter((r) => r.kind === 'ayah')).toHaveLength(6236)
    expect(model.rows.at(-1)).toMatchObject({ kind: 'end', ayahId: 6236, surah: 114 })
    expect(model.rows[0]).toMatchObject({ kind: 'surah', surah: 1, ayahId: 1 })
    expect(model.rows[1]).toMatchObject({ kind: 'ayah', surah: 1, ayahId: 1, ayah: 1 })
    expect(model.rows[8]).toMatchObject({ kind: 'surah', surah: 2, ayahId: 8 })
    // Keys are unique (virtua's getKey).
    expect(new Set(model.rows.map((r) => r.key)).size).toBe(model.rows.length)
  })

  it('finds the row of an ayah, a surah and the row that shows an ayah best', () => {
    expect(model.rowOfAyah(1)).toBe(1)
    expect(model.rowOfAyah(7)).toBe(7)
    expect(model.rowOfAyah(8)).toBe(9) // 2:1, after the Al-Baqarah card
    expect(model.rowOfAyah(262)).toBe(262 + 1) // 2:255
    expect(model.rowOfAyah(6236)).toBe(6236 + 113)
    expect(model.rowOfSurah(2)).toBe(8)
    expect(model.rowOfSurah(114)).toBe(6236 + 113 - 6)
    // Ayah 1 is shown with its surah card; any other verse by itself.
    expect(model.targetRow(8)).toBe(8)
    expect(model.targetRow(9)).toBe(10)
    for (const bad of [0, -1, 6237, 1.5, Number.NaN]) {
      expect(model.rowOfAyah(bad)).toBe(-1)
      expect(model.targetRow(bad)).toBe(-1)
    }
    expect(model.rowOfSurah(0)).toBe(-1)
  })

  it('maps rows back to ayahs (cards to their first ayah, the end row to the last)', () => {
    for (const ayahId of [1, 7, 8, 262, 2141, 6236])
      expect(model.ayahAt(model.rowOfAyah(ayahId))).toBe(ayahId)
    expect(model.ayahAt(8)).toBe(8)
    expect(model.ayahAt(model.rows.length - 1)).toBe(6236)
    // Out of range indexes clamp to the list.
    expect(model.ayahAt(-5)).toBe(1)
    expect(model.ayahAt(1e9)).toBe(6236)
    expect(model.at(3)?.kind).toBe('ayah')
  })

  it('is empty for an empty index', () => {
    const empty = buildRows({ ...index, surahs: [] })
    expect(empty.rows).toHaveLength(0)
    expect(empty.rowOfAyah(1)).toBe(-1)
    expect(empty.targetRow(1)).toBe(-1)
    expect(empty.ayahAt(0)).toBe(0)
  })
})

describe('estimateVerseHeight', () => {
  it('grows with words, packs, the text scale and the Arabic line', () => {
    const base = estimateVerseHeight(10, 1, 1, true)
    expect(estimateVerseHeight(40, 1, 1, true)).toBeGreaterThan(base)
    expect(estimateVerseHeight(10, 2, 1, true)).toBeGreaterThan(base)
    expect(estimateVerseHeight(10, 1, 1.5, true)).toBeGreaterThan(base)
    expect(estimateVerseHeight(10, 1, 1, false)).toBeLessThan(base)
    expect(Number.isInteger(base)).toBe(true)
  })
})

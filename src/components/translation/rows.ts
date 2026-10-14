/**
 * Translation mode's row model: the whole Quran as one virtualised list, a surah card before the first
 * verse of every surah and an end row after the last verse (the closing ornament and the room the dock needs). Pure
 * functions over the index, so the list keeps one stable shape (114 + 6,236 + 1 rows for a real index) and every lookup
 * is O(1) or O(log n).
 */
import type { QuranIndex } from '$lib/ipc/bindings'

export type Row =
  | { kind: 'surah'; key: string; surah: number; ayahId: number }
  | {
      kind: 'ayah'
      key: number
      surah: number
      ayahId: number
      /** The ayah number within its surah. */ ayah: number
    }
  | { kind: 'end'; key: 'end'; surah: number; ayahId: number }

export interface RowModel {
  readonly rows: readonly Row[]
  /** The verse row of an ayah id (−1 when unknown). */
  rowOfAyah(ayahId: number): number
  /** The card row of a surah (−1 when unknown). */
  rowOfSurah(surah: number): number
  /** The row that shows an ayah best: its surah's card for ayah 1 (so the card is on screen), else its verse row. */
  targetRow(ayahId: number): number
  /** The row at an index, clamped to the list. */
  at(row: number): Row | undefined
  /** The ayah a row stands for: its own, a card's first ayah, the last ayah for the end row. */
  ayahAt(row: number): number
}

const EMPTY: RowModel = {
  rows: [],
  rowOfAyah: () => -1,
  rowOfSurah: () => -1,
  targetRow: () => -1,
  at: () => undefined,
  ayahAt: () => 0,
}

/** Builds the rows of an index (surahs in order, each followed by its ayahs). */
export function buildRows(index: QuranIndex): RowModel {
  const surahs = index.surahs
  if (surahs.length === 0) return EMPTY
  const rows: Row[] = []
  /** Row of each surah's card, by surah position. */
  const cardRows: number[] = []
  const firstAyahs: number[] = []
  let lastAyah = 0
  for (const s of surahs) {
    cardRows.push(rows.length)
    firstAyahs.push(s.firstAyahId)
    rows.push({ kind: 'surah', key: `s${s.id}`, surah: s.id, ayahId: s.firstAyahId })
    for (let k = 0; k < s.ayahCount; k++) {
      const ayahId = s.firstAyahId + k
      rows.push({ kind: 'ayah', key: ayahId, surah: s.id, ayahId, ayah: k + 1 })
      lastAyah = ayahId
    }
  }
  const lastSurah = surahs.at(-1)?.id ?? 0
  rows.push({ kind: 'end', key: 'end', surah: lastSurah, ayahId: lastAyah })

  /** Position (0-based) of the surah containing an ayah, or −1. */
  const surahPos = (ayahId: number): number => {
    let lo = 0
    let hi = firstAyahs.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if ((firstAyahs[mid] ?? Infinity) <= ayahId) {
        found = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return found
  }

  const rowOfAyah = (ayahId: number): number => {
    if (!Number.isInteger(ayahId) || ayahId < 1 || ayahId > lastAyah) return -1
    const pos = surahPos(ayahId)
    const card = cardRows[pos]
    const first = firstAyahs[pos]
    return card === undefined || first === undefined ? -1 : card + 1 + (ayahId - first)
  }

  const rowOfSurah = (surah: number): number => {
    const pos = surahs.findIndex((s) => s.id === surah)
    return pos < 0 ? -1 : (cardRows[pos] ?? -1)
  }

  const at = (row: number): Row | undefined => rows[Math.max(0, Math.min(rows.length - 1, Math.trunc(row)))]

  return {
    rows,
    rowOfAyah,
    rowOfSurah,
    targetRow(ayahId) {
      const row = rowOfAyah(ayahId)
      if (row < 0) return -1
      return rows[row - 1]?.kind === 'surah' ? row - 1 : row
    },
    at,
    ayahAt(row) {
      return at(row)?.ayahId ?? 0
    },
  }
}

/** Estimated height (px) of a verse row before it is measured: text lines from its word count. */
export function estimateVerseHeight(words: number, packs: number, scale: number, arabic: boolean): number {
  const arabicLines = arabic ? Math.max(1, Math.ceil(words / 8)) : 0
  const translationLines = Math.max(1, Math.ceil((words * 1.7) / 11))
  return Math.round(
    40 + // padding
      30 + // header (key badge, actions)
      arabicLines * 63 * scale +
      packs * (24 + translationLines * 30.6 * scale) +
      1, // separator
  )
}

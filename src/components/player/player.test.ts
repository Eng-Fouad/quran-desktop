/**
 * Pure parts of the dock: the scrubber's tick density rules, labels, Shift-snapping, and the reciter monogram.
 */
import { describe, expect, it } from 'vitest'
import type { ReciterInfo } from '$lib/ipc/bindings'
import { monogram } from './dock.svelte'
import { type AyahStart, ayahIndexAt, labelStep, MIN_LABEL_SPACING, planTicks, snapToAyah } from './scrubber'

/** `n` ayahs of equal length over `durationMs`, 15 ayahs per page. */
function starts(n: number, durationMs = n * 10_000, perPage = 15): AyahStart[] {
  return Array.from({ length: n }, (_, i) => ({
    ayah: i + 1,
    fromMs: Math.round((i * durationMs) / n),
    page: 1 + Math.floor(i / perPage),
  }))
}

function count(path: string): number {
  return (path.match(/M/g) ?? []).length
}

describe('planTicks (tick density)', () => {
  it('ticks every ayah start when they are at least 4 px apart, and never at the ends', () => {
    const plan = planTicks(starts(7), 70_000, 280) // 40 px apart
    expect(plan.mode).toBe('ayah')
    expect(count(plan.small)).toBe(6) // ayah 1 sits at x = 0
    expect(plan.tall).toBe('')
    expect(plan.labels).toEqual([])
  })

  it('falls back to every 10 ayahs below 4 px, or to page boundaries when those are sparser', () => {
    const al_baqarah = starts(286, 286_000, 6) // 48 pages: tens (28) are sparser
    let plan = planTicks(al_baqarah, 286_000, 400)
    expect(plan.mode).toBe('ten')
    expect(count(plan.small)).toBe(28)
    const long = starts(286, 286_000, 30) // 10 pages: page boundaries (9) are sparser
    plan = planTicks(long, 286_000, 400)
    expect(plan.mode).toBe('page')
    expect(count(plan.small)).toBe(9)
  })

  it('makes every-tenth ticks tall and labelled on a track of 480 px or more, without collisions', () => {
    const plan = planTicks(starts(110, 110_000), 110_000, 600) // ~5.5 px apart: per ayah
    expect(plan.mode).toBe('ayah')
    expect(count(plan.tall)).toBe(11)
    expect(count(plan.small)).toBe(110 - 1 - 11)
    // 110 starts 5.5 px before the end: its label would overhang the track, so it is left out.
    expect(plan.labels.map((l) => l.ayah)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
    for (let i = 1; i < plan.labels.length; i++) {
      expect((plan.labels[i]?.x ?? 0) - (plan.labels[i - 1]?.x ?? 0)).toBeGreaterThanOrEqual(
        MIN_LABEL_SPACING,
      )
    }
    const dense = planTicks(starts(286, 286_000, 6), 286_000, 520)
    expect(dense.labels.every((l) => l.ayah % labelStep(286, 520) === 0)).toBe(true)
    expect(labelStep(286, 520)).toBe(20)
  })

  it('draws nothing without timings or width', () => {
    expect(planTicks([], 1_000, 400).mode).toBe('none')
    expect(planTicks(starts(7), 0, 400).mode).toBe('none')
    expect(planTicks(starts(7), 70_000, 0).mode).toBe('none')
  })
})

describe('scrubber lookups', () => {
  const s = starts(5, 50_000)

  it('finds the ayah holding a time', () => {
    expect(ayahIndexAt(s, 0)).toBe(0)
    expect(ayahIndexAt(s, 19_999)).toBe(1)
    expect(ayahIndexAt(s, 20_000)).toBe(2)
    expect(ayahIndexAt(s, -1)).toBe(-1)
  })

  it('snaps to the nearest ayah start inside the range', () => {
    expect(snapToAyah(s, 14_000, 0, 50_000)).toBe(10_000)
    expect(snapToAyah(s, 16_000, 0, 50_000)).toBe(20_000)
    expect(snapToAyah(s, 16_000, 25_000, 50_000)).toBe(30_000)
  })
})

describe('monogram', () => {
  const reciter = (en: string, ar: string): ReciterInfo => ({
    id: 1,
    packId: 'audio.qdc.1',
    name: { en, ar },
    style: null,
    wordLevel: true,
    sizeKib: 1,
    downloadedSurahs: 0,
    cachedSurahs: 0,
  })

  it('uses Latin initials of the first and last name in the English UI, skipping articles', () => {
    expect(monogram(reciter('Mishary Rashid Alafasy', 'مشاري راشد العفاسي'), 'en')).toBe('MA')
    expect(monogram(reciter('Mahmoud Khalil Al-Husary', 'محمود خليل الحصري'), 'en')).toBe('MH')
    expect(monogram(reciter("Sa'ud ash-Shuraym", 'سعود الشريم'), 'en')).toBe('SS')
    expect(monogram(reciter('Alafasy', 'العفاسي'), 'en')).toBe('A')
  })

  it('uses the first Arabic letter in the Arabic UI', () => {
    expect(monogram(reciter('Mishary Rashid Alafasy', 'مشاري راشد العفاسي'), 'ar')).toBe('م')
    expect(monogram(reciter('Abdul Basit', 'عبد الباسط'), 'ar')).toBe('ع')
    expect(monogram(null, 'en')).toBe('Q')
  })
})

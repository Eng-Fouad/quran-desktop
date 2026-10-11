/**
 * Pure helpers of the §9.5 primitives: keycap splitting for `Kbd`, the px ↔ % adapter for `Splitter`, and the
 * combobox matcher (case, accents, harakat and Arabic letter variants folded; grouping).
 */
import { describe, expect, it } from 'vitest'
import { filterItems, foldForMatch, groupItems } from './filter'
import { isMacModifier, splitChord } from './kbd'
import { panePct, pctToPx, pxToPct } from './splitter'
import type { SelectItem } from './types'

describe('splitChord', () => {
  it.each([
    ['Ctrl+K', ['Ctrl', 'K']],
    ['Ctrl+Shift+C', ['Ctrl', 'Shift', 'C']],
    ['Ctrl++', ['Ctrl', '+']],
    ['Ctrl+Shift++', ['Ctrl', 'Shift', '+']],
    ['+', ['+']],
    ['Shift+?', ['Shift', '?']],
    ['Space', ['Space']],
    ['⌘K', ['⌘', 'K']],
    ['⌘⇧K', ['⌘', '⇧', 'K']],
    ['⌃⌥⇧⌘F', ['⌃', '⌥', '⇧', '⌘', 'F']],
    ['⌘', ['⌘']],
    ['⌘+', ['⌘', '+']],
    ['  Alt+ArrowRight ', ['Alt', 'ArrowRight']],
    ['', []],
  ])('%s → %j', (label, caps) => {
    expect(splitChord(label)).toEqual(caps)
  })

  it('knows the macOS modifier glyphs', () => {
    expect(['⌃', '⌥', '⇧', '⌘'].every(isMacModifier)).toBe(true)
    expect(isMacModifier('K')).toBe(false)
  })
})

describe('px ↔ % adapter', () => {
  it('converts both ways and clamps to 0–100 %', () => {
    expect(pxToPct(300, 1200)).toBe(25)
    expect(pxToPct(400, 1500)).toBe(26.6667)
    expect(pctToPx(25, 1200)).toBe(300)
    expect(pctToPx(26.6667, 1500)).toBe(400)
    expect(pxToPct(2000, 1000)).toBe(100)
    expect(pxToPct(-5, 1000)).toBe(0)
    expect(pctToPx(150, 1000)).toBe(1000)
  })

  it('is 0 before the group has a size', () => {
    expect(pxToPct(300, 0)).toBe(0)
    expect(pctToPx(25, 0)).toBe(0)
    expect(pxToPct(Number.NaN, 1000)).toBe(0)
  })

  it('maps pixel pane limits to paneforge percentages, clamping the size into them', () => {
    expect(panePct({ size: 300, min: 240, max: 420 }, 1200)).toEqual({ size: 25, minSize: 20, maxSize: 35 })
    expect(panePct({ size: 900, min: 320, max: 640 }, 1600)).toEqual({ size: 40, minSize: 20, maxSize: 40 })
    expect(panePct({ size: 100, min: 320, max: 640 }, 1600).size).toBe(20)
    expect(panePct({ size: 500, min: 320, max: 640 }, 400)).toEqual({ size: 100, minSize: 80, maxSize: 100 })
  })
})

describe('combobox matching', () => {
  const items: SelectItem[] = [
    { value: 'afasy', label: 'Mishary Alafasy', hint: 'مشاري العفاسي' },
    { value: 'husary', label: 'Mahmoud Khalil Al-Husary', hint: 'محمود خليل الحصري' },
    { value: 'muyassar', label: 'التفسير الميسر', group: 'العربية' },
    { value: 'ibn-kathir', label: 'تفسير ابن كثير', group: 'العربية', keywords: ['Ibn Kathir'] },
    { value: 'saadi', label: 'تفسير السعدي', group: 'العربية' },
    { value: 'qurtubi', label: 'Tafsīr al-Qurṭubī', group: 'English' },
  ]
  const values = (q: string) => filterItems(items, q).map((i) => i.value)

  it('folds case, Latin accents, harakat, tatweel and Arabic letter variants', () => {
    expect(foldForMatch('Tafsīr al-Qurṭubī')).toBe('tafsir al-qurtubi')
    expect(foldForMatch('الْحُصَرِيّ')).toBe('الحصري')
    expect(foldForMatch('إبن كثير')).toBe('ابن كثير')
    expect(foldForMatch('ٱلرَّحْمَٰن')).toBe('الرحمن')
    expect(foldForMatch('مكّة')).toBe('مكه')
    expect(foldForMatch('هدى')).toBe('هدي')
    expect(foldForMatch('الـرحـمن')).toBe('الرحمن')
  })

  it('needs every token somewhere in the label, hint or keywords', () => {
    expect(values('')).toHaveLength(items.length)
    expect(values('   ')).toHaveLength(items.length)
    expect(values('alafasy')).toEqual(['afasy'])
    expect(values('الحُصَري')).toEqual(['husary'])
    expect(values('kathir')).toEqual(['ibn-kathir'])
    expect(values('qurtubi')).toEqual(['qurtubi'])
    expect(values('mahmoud husary')).toEqual(['husary'])
    expect(values('nothing like it')).toEqual([])
  })

  it('lists label prefix matches first, otherwise keeps the order', () => {
    expect(values('تفسير')).toEqual(['ibn-kathir', 'saadi', 'muyassar'])
    expect(values('m')).toEqual(['afasy', 'husary'])
  })

  it('groups by first appearance, ungrouped rows under an empty heading', () => {
    expect(groupItems(items).map((g) => [g.heading, g.items.length])).toEqual([
      ['', 2],
      ['العربية', 3],
      ['English', 1],
    ])
  })
})

/**
 * The palette's text matching (`match.ts`): the fold, word scoring and the emphasised ranges of a label.
 */
import { describe, expect, it } from 'vitest'
import { field, fold, markRanges, queryTokens, score, scoreField, splitMarks, words } from './match'

describe('fold', () => {
  it('folds Latin case, diacritics, hyphens and apostrophes', () => {
    expect(fold('Al-Kahf')).toBe('al kahf')
    expect(fold('AL  KAHF')).toBe('al kahf')
    expect(fold('Al-Fātiḥah')).toBe('al fatihah')
    expect(fold("Qur'an")).toBe('quran')
    expect(fold('Qur’an')).toBe('quran')
  })

  it('folds Arabic loosely: harakat, hamza seats, teh marbuta, digits', () => {
    expect(fold('السُّورَةِ')).toBe('السوره')
    expect(fold('أُمّ الكِتاب')).toBe('ام الكتاب')
    expect(fold('٢:٢٥٥')).toBe('2 255')
    expect(words('سورة  الكهف،  ١٨')).toEqual(['سوره', 'الكهف', '18'])
  })
})

describe('scoreField', () => {
  const sidebar = field('Show or hide the sidebar')

  it('needs every token to match a word', () => {
    expect(scoreField(['sidebar'], sidebar)).toBeGreaterThan(0)
    expect(scoreField(['side'], sidebar)).toBeGreaterThan(0)
    expect(scoreField(['hide', 'side'], sidebar)).toBeGreaterThan(0)
    expect(scoreField(['hide', 'pane'], sidebar)).toBe(0)
    expect(scoreField([], sidebar)).toBe(0)
  })

  it('ranks a whole word above a prefix above a match inside a word', () => {
    const whole = scoreField(['sidebar'], field('sidebar tab'))
    const prefix = scoreField(['side'], field('sidebar tab'))
    const inside = scoreField(['bar'], field('sidebar tab'))
    expect(whole).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(inside)
    expect(inside).toBeGreaterThan(0)
    // Short tokens never match inside a word.
    expect(scoreField(['ba'], field('sidebar tab'))).toBe(0)
  })

  it('prefers the first word, the typed order and shorter fields', () => {
    expect(scoreField(['zoom'], field('Zoom in'))).toBeGreaterThan(
      scoreField(['zoom'], field('Reset the zoom')),
    )
    expect(scoreField(['zoom', 'in'], field('Zoom in'))).toBeGreaterThan(
      scoreField(['in', 'zoom'], field('Zoom in')),
    )
    expect(scoreField(['zoom'], field('Zoom in'))).toBeGreaterThan(
      scoreField(['zoom'], field('Zoom in on the page around the pointer')),
    )
  })

  it('matches an Arabic word with or without its article', () => {
    const speed = field('السرعة العادية')
    expect(scoreField(queryTokens('سرعة'), speed)).toBeGreaterThan(0)
    expect(scoreField(queryTokens('السرعه'), speed)).toBeGreaterThan(0)
    expect(scoreField(queryTokens('سرع'), speed)).toBeGreaterThan(0)
  })

  it('scales by the field weight and keeps the best field', () => {
    const tokens = ['theme']
    const strong = score(tokens, [field('Theme', 1)])
    const weak = score(tokens, [field('Theme', 0.5)])
    expect(weak).toBeCloseTo(strong / 2)
    expect(score(tokens, [field('Language'), field('Theme', 0.5)])).toBeCloseTo(weak)
    expect(score(tokens, [field('Language')])).toBe(0)
    expect(strong).toBeLessThanOrEqual(1)
  })
})

describe('markRanges', () => {
  it('marks each token at the start of a word', () => {
    const label = 'Show or hide the sidebar'
    expect(markRanges(label, ['side'])).toEqual([[17, 21]])
    expect(markRanges(label, ['hide', 'side'])).toEqual([
      [8, 12],
      [17, 21],
    ])
    // Not inside a word.
    expect(markRanges(label, ['bar'])).toEqual([])
  })

  it('marks references and folded letters, merging neighbours', () => {
    expect(markRanges('Al-Baqarah 2:255', queryTokens('2:255'))).toEqual([
      [11, 12],
      [13, 16],
    ])
    expect(markRanges('Al-Fātiḥah', ['fati'])).toEqual([[3, 7]])
    expect(markRanges('Zoom in', ['zoom', 'zo'])).toEqual([[0, 4]])
  })

  it('never marks inside Arabic text', () => {
    expect(markRanges('الكهف', queryTokens('الكهف'))).toEqual([])
    expect(markRanges('Language: العربية', ['language'])).toEqual([])
  })
})

describe('splitMarks', () => {
  it('cuts a label into plain and marked parts', () => {
    expect(splitMarks('Cycle theme: paper', [[6, 11]])).toEqual([
      { text: 'Cycle ', mark: false },
      { text: 'theme', mark: true },
      { text: ': paper', mark: false },
    ])
    expect(splitMarks('Zoom in', [])).toEqual([{ text: 'Zoom in', mark: false }])
    expect(splitMarks('Zoom', [[0, 4]])).toEqual([{ text: 'Zoom', mark: true }])
  })
})

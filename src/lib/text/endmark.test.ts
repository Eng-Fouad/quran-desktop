/** The end-of-ayah mark stays on the line of the ayah's last word. */
import { describe, expect, it } from 'vitest'
import { bindEndMark, bindsToPrevious, NBSP } from './endmark'

describe('bindEndMark', () => {
  it('replaces the space before ۝N with a no-break space', () => {
    expect(bindEndMark('عَلَىٰ كُلِّ شَيۡءٖ قَدِيرٌ ۝١٥')).toBe(`عَلَىٰ كُلِّ شَيۡءٖ قَدِيرٌ${NBSP}۝١٥`)
  })

  it('binds a standalone sign before the mark too (the sajda mark)', () => {
    expect(bindEndMark('وَخَرَّ رَاكِعٗاۤ وَأَنَابَ ۩ ۝٢٤')).toBe(
      `وَخَرَّ رَاكِعٗاۤ وَأَنَابَ${NBSP}۩${NBSP}۝٢٤`,
    )
  })

  it('keeps the other spaces, and leaves text without a final mark alone', () => {
    const out = bindEndMark('ٱلۡحَمۡدُ لِلَّهِ رَبِّ ٱلۡعَٰلَمِينَ ۝٢ ')
    expect(out.split(' ')).toHaveLength(4)
    expect(out.endsWith(`${NBSP}۝٢`)).toBe(true)
    expect(bindEndMark('بِسۡمِ ٱللَّهِ')).toBe('بِسۡمِ ٱللَّهِ')
    expect(bindEndMark('')).toBe('')
  })
})

describe('bindsToPrevious', () => {
  it('is the end mark or a standalone sign, never a word', () => {
    expect(bindsToPrevious('۝٢٥٥')).toBe(true)
    expect(bindsToPrevious('۩')).toBe(true)
    expect(bindsToPrevious('ٱللَّهُ')).toBe(false)
    expect(bindsToPrevious('۞')).toBe(false) // U+06DE opens a quarter: it starts the line
    expect(bindsToPrevious(undefined)).toBe(false)
  })
})

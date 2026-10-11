/**
 * `buildCopyText` (§5.5, §8.14, §12.3; WP8e) against the golden file shared with Rust's `quran_copy_text`
 * (`crates/quran-core/tests/data/copy_vectors.json`, WP1a), plus the cases a native selection produces that the
 * command never sees: a range that starts or ends inside an ayah, end markers alone, unordered input from two
 * renditions.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CopySettings, PageWord } from '$lib/ipc/bindings'
import { arabicIndic, buildCopyText, copyArabic, copyReference, type CopyRefs } from './copy'

interface CopyVectors {
  surahs: Record<string, { nameSimple: string; nameAr: string }>
  cases: {
    name: string
    fromAyahId: number
    toAyahId: number
    options: CopySettings
    words: PageWord[]
    reference: string
    expected: string
  }[]
}

const vectors = JSON.parse(
  readFileSync(resolve('crates/quran-core/tests/data/copy_vectors.json'), 'utf8'),
) as CopyVectors

const refs: CopyRefs = { surah: (n) => vectors.surahs[String(n)] }

describe('buildCopyText: the shared golden vectors (§12.3)', () => {
  it('has the nine cases WP1a wrote', () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(9)
  })

  for (const c of vectors.cases) {
    it(c.name, () => {
      expect(buildCopyText(c.words, c.options, refs)).toBe(c.expected)
    })

    it(`${c.name}: the reference line`, () => {
      const first = c.words[0]
      const last = c.words.at(-1)
      if (!first || !last) throw new Error('a vector without words')
      const line = copyReference(
        c.options.referenceStyle,
        { surah: first.surah, ayah: first.ayah },
        { surah: last.surah, ayah: last.ayah },
        refs,
      )
      if (c.options.includeReference) expect(line).toBe(c.reference)
    })
  }

  it('never puts a PUA glyph code on the clipboard: words are copied from `text`, not `glyph`', () => {
    const c = vectors.cases[0]
    if (!c) throw new Error('no vectors')
    const qcf = c.words.map((w, i) => ({ ...w, glyph: String.fromCodePoint(0xfb51 + i) }))
    const text = buildCopyText(qcf, c.options, refs)
    expect(text).toBe(c.expected)
    // QCF glyph codes live in the Private Use Area and the Arabic presentation forms; only ﴿ ﴾ may appear.
    const glyphCodes = [...text].filter((ch) => {
      const cp = ch.codePointAt(0) ?? 0
      if (cp === 0xfd3e || cp === 0xfd3f) return false
      return (
        (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff)
      )
    })
    expect(glyphCodes).toEqual([])
  })
})

describe('buildCopyText: native selections (§8.14)', () => {
  const word = (id: number, surah: number, ayah: number, text: string, isEnd = false): PageWord => ({
    id,
    ayahId: 0,
    surah,
    ayah,
    position: 1,
    isEnd,
    glyph: text,
    text,
  })
  const opts = (patch: Partial<CopySettings> = {}): CopySettings => ({
    includeReference: true,
    referenceStyle: 'short',
    ayahNumbers: true,
    translationPackId: null,
    ...patch,
  })

  it('copies a partial ayah and references the ayah it touches', () => {
    const words = [word(30, 2, 2, 'ذَٰلِكَ'), word(31, 2, 2, 'ٱلۡكِتَٰبُ')]
    expect(buildCopyText(words, opts(), refs)).toBe('ذَٰلِكَ ٱلۡكِتَٰبُ\n(2:2)')
  })

  it('references from the first to the last touched ayah, across the end marker between them', () => {
    const words = [word(36, 2, 2, 'لِّلۡمُتَّقِينَ'), word(37, 2, 2, '٢', true), word(38, 2, 3, 'ٱلَّذِينَ')]
    expect(buildCopyText(words, opts(), refs)).toBe('لِّلۡمُتَّقِينَ ﴿٢﴾ ٱلَّذِينَ\n(2:2–3)')
    expect(buildCopyText(words, opts({ ayahNumbers: false, referenceStyle: 'arabic' }), refs)).toBe(
      'لِّلۡمُتَّقِينَ ٱلَّذِينَ\n[البقرة: ٢–٣]',
    )
  })

  it('copies a lone end marker as its number, or as the reference alone', () => {
    const marker = [word(37, 2, 2, '٢', true)]
    expect(buildCopyText(marker, opts(), refs)).toBe('﴿٢﴾\n(2:2)')
    expect(buildCopyText(marker, opts({ ayahNumbers: false }), refs)).toBe('(2:2)')
    expect(buildCopyText(marker, opts({ ayahNumbers: false, includeReference: false }), refs)).toBe('')
  })

  it('copies nothing for no words', () => {
    expect(buildCopyText([], opts(), refs)).toBe('')
  })

  it('keeps an unknown surah name empty rather than failing', () => {
    const words = [word(1, 200, 1, 'x')]
    // `— {name} 200:1` with an empty name: the separator spaces stay, nothing throws.
    expect(buildCopyText(words, opts({ referenceStyle: 'long' }), refs)).toBe('x\n—  200:1')
  })
})

describe('copy helpers', () => {
  it('writes Arabic-Indic digits', () => {
    expect(arabicIndic(0)).toBe('٠')
    expect(arabicIndic(255)).toBe('٢٥٥')
    expect(arabicIndic(6236)).toBe('٦٢٣٦')
  })

  it('joins words with one space and drops markers without numbers', () => {
    const w = (text: string, isEnd = false, ayah = 1): PageWord => ({
      id: 1,
      ayahId: 1,
      surah: 1,
      ayah,
      position: 1,
      isEnd,
      glyph: text,
      text,
    })
    expect(copyArabic([w('a'), w('b'), w('١', true)], false)).toBe('a b')
    expect(copyArabic([w('a'), w('١', true, 1), w('c', false, 2)], true)).toBe('a ﴿١﴾ c')
  })
})

/**
 * The TS normaliser against the shared golden file: `crates/quran-core/tests/data/normalize_vectors.json` is also read
 * by the Rust suite, so the two implementations cannot drift. The Rust unit tests' extra examples (Latin folding,
 * separators, the deletion set) are mirrored here.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  asciiDigits,
  foldLatin,
  hasArabic,
  isStripped,
  isWhiteSpace,
  NORMALIZER_VERSION,
  normalizeAr,
  tokens,
} from './normalize'

interface Vector {
  in: string
  strict: string
  loose: string
}

const vectors = JSON.parse(
  readFileSync(resolve('crates/quran-core/tests/data/normalize_vectors.json'), 'utf8'),
) as Vector[]

const show = (s: string) =>
  [...s].map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ')

describe('normalizeAr: shared golden vectors', () => {
  it('has the minimum set', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(14)
  })

  it.each(vectors.map((v) => [v.in, v] as const))('strict and loose of %j', (_label, v) => {
    expect(normalizeAr(v.in, 'strict'), show(v.in)).toBe(v.strict)
    expect(normalizeAr(v.in, 'loose'), show(v.in)).toBe(v.loose)
  })

  it('maps every vector to a fixed point (idempotent, loose(strict(x)) = loose(x))', () => {
    for (const v of vectors) {
      expect(normalizeAr(v.strict, 'strict')).toBe(v.strict)
      expect(normalizeAr(v.loose, 'loose')).toBe(v.loose)
      expect(normalizeAr(v.strict, 'loose')).toBe(v.loose)
    }
  })

  it('never leaves a deleted character, a leading/trailing space or a double space', () => {
    for (const v of vectors) {
      for (const out of [normalizeAr(v.in, 'strict'), normalizeAr(v.in, 'loose')]) {
        expect([...out].some((c) => isStripped(c.codePointAt(0) ?? 0))).toBe(false)
        expect(out.startsWith(' ') || out.endsWith(' ') || out.includes('  ')).toBe(false)
      }
    }
  })

  it('mirrors the Rust version constant', () => {
    expect(NORMALIZER_VERSION).toBe(1)
  })
})

describe('normalizeAr: rules', () => {
  it('defaults to loose', () => {
    expect(normalizeAr('الصَّلَاةَ')).toBe('الصلاه')
  })

  it('collapses and trims separators', () => {
    expect(normalizeAr('', 'loose')).toBe('')
    expect(normalizeAr(' \t\n ', 'loose')).toBe('')
    expect(normalizeAr('\u064E\u0651', 'strict')).toBe('')
    expect(normalizeAr('  أ - ب ؛ ج  ', 'strict')).toBe('ا ب ج')
    // A dropped hamza between separators leaves one space, not two.
    expect(normalizeAr('و ء ه', 'loose')).toBe('و ه')
  })

  it('treats U+0085 as whitespace (Rust White_Space), unlike the JS \\s class', () => {
    expect(normalizeAr('كتاب\u0085كتب', 'strict')).toBe('كتاب كتب')
    expect(normalizeAr('a\u3000b', 'strict')).toBe('a b')
  })

  it('keeps Latin case and Latin letters', () => {
    expect(normalizeAr('Al-Fatihah 1:1', 'loose')).toBe('Al Fatihah 1 1')
  })

  it('deletes exactly the step-1 set', () => {
    for (const cp of [
      0x0610, 0x061a, 0x064b, 0x065f, 0x0670, 0x06d6, 0x06dd, 0x06e9, 0x06ed, 0x08d3, 0x08ff, 0x0640, 0x200b,
      0x200f, 0x202a, 0x202e, 0x2066, 0x2069, 0xfeff,
    ]) {
      expect(isStripped(cp), cp.toString(16)).toBe(true)
    }
    for (const cp of [
      0x060f, 0x061b, 0x064a, 0x0660, 0x066f, 0x0671, 0x06d5, 0x06ee, 0x08d2, 0x2010, 0x0627,
    ]) {
      expect(isStripped(cp), cp.toString(16)).toBe(false)
    }
  })

  it('knows the White_Space set', () => {
    for (const cp of [
      0x09, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
    ]) {
      expect(isWhiteSpace(cp), cp.toString(16)).toBe(true)
    }
    for (const cp of [0x200b, 0xfeff, 0x61, 0x0627, 0x180e])
      expect(isWhiteSpace(cp), cp.toString(16)).toBe(false)
  })
})

describe('foldLatin', () => {
  it('matches the Rust examples', () => {
    expect(foldLatin('Mūsā')).toBe('musa')
    expect(foldLatin('  Ünïcödé \t TEST  ')).toBe('unicode test')
    expect(foldLatin('ﬁnal Straße')).toBe('final straße')
    expect(foldLatin('İstanbul')).toBe('istanbul')
    expect(foldLatin('Ἀθῆναι')).toBe('αθηναι')
    expect(foldLatin('ÇA VA')).toBe('ca va')
    expect(foldLatin('')).toBe('')
    expect(foldLatin(normalizeAr('يُؤْمِنُونَ ٱلصَّلَوٰةَ', 'loose'))).toBe('يومنون الصلوه')
  })

  it('keeps spacing marks and drops nonspacing ones', () => {
    expect(foldLatin('का')).toBe('का')
    expect(foldLatin('क्')).toBe('क')
  })

  it('lowercases per code point (a final sigma stays σ, as in Rust)', () => {
    expect(foldLatin('ΑΣ')).toBe('ασ')
  })

  it('folds the surah transliterations of core.db', () => {
    expect(foldLatin('Al-Fātiĥah')).toBe('al-fatihah')
    expect(foldLatin('Aş-Şāffāt')).toBe('as-saffat')
    expect(foldLatin('Ađ-Đuĥaá')).toBe('ađ-đuhaa')
  })
})

describe('helpers', () => {
  it('splits normalised text into tokens', () => {
    expect(tokens('بسم  الله ')).toEqual(['بسم', 'الله'])
    expect(tokens('')).toEqual([])
  })

  it('converts Arabic-Indic and Persian digits only', () => {
    expect(asciiDigits('٢:٢٥٥')).toBe('2:255')
    expect(asciiDigits('ص ۲۶۲')).toBe('ص 262')
    expect(asciiDigits('page 9')).toBe('page 9')
  })

  it('detects Arabic script', () => {
    expect(hasArabic('الكهف')).toBe(true)
    expect(hasArabic('kahf')).toBe(false)
    expect(hasArabic('٢٥٥')).toBe(false)
    expect(hasArabic('ﷲ')).toBe(true)
  })
})

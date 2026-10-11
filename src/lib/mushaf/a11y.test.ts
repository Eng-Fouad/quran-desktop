/**
 * `toSpeech` and the spoken page items (§8.15, §12.5). The vectors are the QPC Hafs text of 1:1–7, 2:255 and 38:24 (as in
 * core.db `word.text_hafs`, end markers excluded) and their expected speech text, written out literally so a change to
 * the mapping shows up as a diff here. NVDA + OneCore Arabic results for the same ayahs are recorded in
 * docs/deviations/WP8d.md.
 */
import { describe, expect, it } from 'vitest'
import type { PageAyah, PageData, PageLine, PageWord } from '$lib/ipc/bindings'
import { a11yItemId, AYAH_FLAG, ayahNumberSuffix, divisionsOf, pageSegments, toSpeech } from './a11y'

const VECTORS: readonly (readonly [ref: string, qpcHafs: string, speech: string])[] = [
  ['1:1', 'بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ', 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ'],
  ['1:2', 'ٱلۡحَمۡدُ لِلَّهِ رَبِّ ٱلۡعَٰلَمِينَ', 'الْحَمْدُ لِلَّهِ رَبِّ الْعَٰلَمِينَ'],
  ['1:3', 'ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ', 'الرَّحْمَٰنِ الرَّحِيمِ'],
  ['1:4', 'مَٰلِكِ يَوۡمِ ٱلدِّينِ', 'مَٰلِكِ يَوْمِ الدِّينِ'],
  ['1:5', 'إِيَّاكَ نَعۡبُدُ وَإِيَّاكَ نَسۡتَعِينُ', 'إِيَّاكَ نَعْبُدُ وَإِيَّاكَ نَسْتَعِينُ'],
  ['1:6', 'ٱهۡدِنَا ٱلصِّرَٰطَ ٱلۡمُسۡتَقِيمَ', 'اهْدِنَا الصِّرَٰطَ الْمُسْتَقِيمَ'],
  [
    '1:7',
    'صِرَٰطَ ٱلَّذِينَ أَنۡعَمۡتَ عَلَيۡهِمۡ غَيۡرِ ٱلۡمَغۡضُوبِ عَلَيۡهِمۡ وَلَا ٱلضَّآلِّينَ',
    'صِرَٰطَ الَّذِينَ أَنْعَمْتَ عَلَيْهِمْ غَيْرِ الْمَغْضُوبِ عَلَيْهِمْ وَلَا الضَّآلِّينَ',
  ],
  [
    '2:255',
    'ٱللَّهُ لَآ إِلَٰهَ إِلَّا هُوَ ٱلۡحَيُّ ٱلۡقَيُّومُۚ لَا تَأۡخُذُهُۥ سِنَةٞ وَلَا نَوۡمٞۚ لَّهُۥ مَا فِي ٱلسَّمَٰوَٰتِ وَمَا فِي ' +
      'ٱلۡأَرۡضِۗ مَن ذَا ٱلَّذِي يَشۡفَعُ عِندَهُۥٓ إِلَّا بِإِذۡنِهِۦۚ يَعۡلَمُ مَا بَيۡنَ أَيۡدِيهِمۡ وَمَا خَلۡفَهُمۡۖ وَلَا يُحِيطُونَ ' +
      'بِشَيۡءٖ مِّنۡ عِلۡمِهِۦٓ إِلَّا بِمَا شَآءَۚ وَسِعَ كُرۡسِيُّهُ ٱلسَّمَٰوَٰتِ وَٱلۡأَرۡضَۖ وَلَا يَـُٔودُهُۥ حِفۡظُهُمَاۚ وَهُوَ ' +
      'ٱلۡعَلِيُّ ٱلۡعَظِيمُ',
    'اللَّهُ لَآ إِلَٰهَ إِلَّا هُوَ الْحَيُّ الْقَيُّومُ لَا تَأْخُذُهُو سِنَةٌ وَلَا نَوْمٌ لَّهُو مَا فِي السَّمَٰوَٰتِ وَمَا فِي ' +
      'الْأَرْضِ مَن ذَا الَّذِي يَشْفَعُ عِندَهُوٓ إِلَّا بِإِذْنِهِي يَعْلَمُ مَا بَيْنَ أَيْدِيهِمْ وَمَا خَلْفَهُمْ وَلَا يُحِيطُونَ ' +
      'بِشَيْءٍ مِّنْ عِلْمِهِيٓ إِلَّا بِمَا شَآءَ وَسِعَ كُرْسِيُّهُ السَّمَٰوَٰتِ وَالْأَرْضَ وَلَا يَـُٔودُهُو حِفْظُهُمَا وَهُوَ ' +
      'الْعَلِيُّ الْعَظِيمُ',
  ],
  [
    '38:24',
    'قَالَ لَقَدۡ ظَلَمَكَ بِسُؤَالِ نَعۡجَتِكَ إِلَىٰ نِعَاجِهِۦۖ وَإِنَّ كَثِيرٗا مِّنَ ٱلۡخُلَطَآءِ لَيَبۡغِي بَعۡضُهُمۡ عَلَىٰ بَعۡضٍ ' +
      'إِلَّا ٱلَّذِينَ ءَامَنُواْ وَعَمِلُواْ ٱلصَّٰلِحَٰتِ وَقَلِيلٞ مَّا هُمۡۗ وَظَنَّ دَاوُۥدُ أَنَّمَا فَتَنَّٰهُ فَٱسۡتَغۡفَرَ رَبَّهُۥ ' +
      'وَخَرَّۤ رَاكِعٗاۤ وَأَنَابَ ۩',
    'قَالَ لَقَدْ ظَلَمَكَ بِسُؤَالِ نَعْجَتِكَ إِلَىٰ نِعَاجِهِي وَإِنَّ كَثِيرًا مِّنَ الْخُلَطَآءِ لَيَبْغِي بَعْضُهُمْ عَلَىٰ بَعْضٍ ' +
      'إِلَّا الَّذِينَ ءَامَنُواْ وَعَمِلُواْ الصَّٰلِحَٰتِ وَقَلِيلٌ مَّا هُمْ وَظَنَّ دَاوُودُ أَنَّمَا فَتَنَّٰهُ فَاسْتَغْفَرَ رَبَّهُو ' +
      'وَخَرَّ رَاكِعًا وَأَنَابَ',
  ],
]

/** Code points that must never reach a speech engine (§8.15). */
const FORBIDDEN: readonly (readonly [number, number])[] = [
  [0x06d6, 0x06ed],
  [0x0671, 0x0671],
  [0x08f0, 0x08f2],
  [0x0656, 0x0657],
  [0x065e, 0x065e],
]
const forbidden = (s: string): string[] =>
  [...s].filter((c) => {
    const p = c.codePointAt(0) ?? 0
    return FORBIDDEN.some(([from, to]) => p >= from && p <= to)
  })

/** A string from code points (keeps lone combining marks readable in this file). */
const cp = (...points: number[]): string => String.fromCodePoint(...points)

const cps = (s: string): string =>
  [...s].map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ')

describe('toSpeech (§8.15)', () => {
  it.each(VECTORS)('%s', (_ref, input, expected) => {
    const out = toSpeech(input)
    expect(out).toBe(expected)
    expect(forbidden(out)).toEqual([])
  })

  it('maps the Uthmani marks TTS reads as names to the plain vocalised orthography', () => {
    expect(cps(toSpeech(cp(0x06e1)))).toBe(cps(cp(0x0652))) // small high dotless head of khah → sukun
    expect(cps(toSpeech(cp(0x0671)))).toBe(cps(cp(0x0627))) // alef wasla → alef
    expect(cps(toSpeech(cp(0x06e5)))).toBe(cps(cp(0x0648))) // small waw → waw
    expect(cps(toSpeech(cp(0x06e6)))).toBe(cps(cp(0x064a))) // small yeh → yeh
    // Open (staggered) tanween, in KFGQPC's and in Unicode's encoding, → the plain tanween.
    expect(cps(toSpeech(cp(0x0657, 0x065e, 0x0656)))).toBe(cps(cp(0x064b, 0x064c, 0x064d)))
    expect(cps(toSpeech(cp(0x08f0, 0x08f1, 0x08f2)))).toBe(cps(cp(0x064b, 0x064c, 0x064d)))
  })

  it('strips waqf signs, the end-of-ayah and rub signs, and the annotation marks', () => {
    const strip = [
      ...range(0x06d6, 0x06dc),
      0x06dd,
      0x06de,
      0x06df,
      0x06e0,
      0x06e2,
      0x06e3,
      0x06e4,
      ...range(0x06e7, 0x06ed),
    ]
    for (const p of strip) expect(toSpeech(`ب${cp(p)}ب`), cps(cp(p))).toBe('بب')
  })

  it('keeps letters, harakat, shadda, maddah, hamza, tatweel and the superscript alef', () => {
    // hamza, alef with madda/hamza, waw/yeh with hamza, tatweel, the six harakat, shadda, sukun, superscript alef,
    // maddah and hamza above.
    const keep =
      cp(0x0621, 0x0622, 0x0623, 0x0624, 0x0625, 0x0626, 0x0640) +
      cp(0x0628, 0x064b, 0x064c, 0x064d, 0x064e, 0x064f, 0x0650, 0x0651, 0x0652, 0x0670, 0x0653, 0x0654)
    expect(cps(toSpeech(keep))).toBe(cps(keep))
  })

  it('collapses the space a stand-alone sign leaves behind', () => {
    expect(toSpeech('۞ إِنَّ')).toBe('إِنَّ')
    expect(toSpeech('وَأَنَابَ ۩ ۝٢٤')).toBe('وَأَنَابَ ٢٤')
    expect(toSpeech('  ب  ۖ  ب ')).toBe('ب ب')
  })

  it('is idempotent and leaves non-Quranic text alone', () => {
    for (const [, input] of VECTORS) expect(toSpeech(toSpeech(input))).toBe(toSpeech(input))
    expect(toSpeech('Al-Baqarah 2:255')).toBe('Al-Baqarah 2:255')
    expect(toSpeech('')).toBe('')
  })
})

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i)
}

// --- the spoken items of a page -------------------------------------------------------------------------------------------

function word(id: number, ayahId: number, ayah: number, text: string, isEnd = false): PageWord {
  return { id, ayahId, surah: 2, ayah, position: 1, isEnd, glyph: text, text }
}

function ayahRow(id: number, ayah: number, patch: Partial<PageAyah> = {}): PageAyah {
  return {
    id,
    surah: 2,
    ayah,
    juz: 3,
    hizb: 5,
    rub: 17,
    sajda: null,
    flags: 0,
    firstWordId: 0,
    lastWordId: 0,
    startsOnPage: true,
    endsOnPage: true,
    line: 1,
    ...patch,
  }
}

function pageOf(lines: PageWord[][], ayahs: PageAyah[]): PageData {
  const pageLines: PageLine[] = lines.map((words, i) => ({
    line: i + 1,
    kind: 'ayah',
    centered: false,
    surah: null,
    words,
  }))
  return {
    layout: 'v2',
    style: 'hafs',
    page: 42,
    lines: pageLines,
    ayahs,
    info: { firstAyahId: 261, lastAyahId: 263, juz: 3, hizb: 5, headSurah: 2, surahIds: [2] },
  }
}

describe('pageSegments (§8.15)', () => {
  const data = pageOf(
    [
      [word(1, 261, 254, 'ٱلۡكَٰفِرُونَ'), word(2, 261, 254, '۝٢٥٤', true), word(3, 262, 255, 'ٱللَّهُ')],
      [word(4, 262, 255, 'لَآ'), word(5, 262, 255, '۝٢٥٥', true), word(6, 263, 256, 'لَآ')],
    ],
    [ayahRow(261, 254, { startsOnPage: false }), ayahRow(262, 255), ayahRow(263, 256, { endsOnPage: false })],
  )

  it('speaks each ayah segment once, end marker excluded, followed by its Arabic-Indic number', () => {
    const segments = pageSegments(data)
    expect(segments.map((s) => s.ayah.id)).toEqual([261, 262, 263])
    expect(segments.map((s) => s.words.map((w) => w.id))).toEqual([[1], [3, 4], [6]])
    expect(segments[1]?.speech).toBe('اللَّهُ لَآ (٢٥٥)')
    expect(segments[0]?.speech).toBe('الْكَٰفِرُونَ (٢٥٤)')
  })

  it('marks segments continued from the previous page and continuing on the next', () => {
    const segments = pageSegments(data)
    expect(segments.map((s) => [s.continued, s.continues])).toEqual([
      [true, false],
      [false, false],
      [false, true],
    ])
  })

  it('formats the ayah number suffix and the item id', () => {
    expect(ayahNumberSuffix(255)).toBe(' (٢٥٥)')
    expect(ayahNumberSuffix(1000)).toBe(' (١٠٠٠)')
    expect(a11yItemId(262, 1802)).toBe('a11y-262-1802')
  })
})

describe('divisionsOf (§3.1.2, §8.9)', () => {
  it('names the juz before the hizb before the quarter, then the sajda', () => {
    const { juzStart, hizbStart, rubStart } = AYAH_FLAG
    expect(divisionsOf(ayahRow(1, 1, { flags: juzStart | hizbStart | rubStart, juz: 15, hizb: 29 }))).toEqual(
      [{ kind: 'juz', juz: 15 }],
    )
    expect(divisionsOf(ayahRow(1, 1, { flags: hizbStart | rubStart, hizb: 27 }))).toEqual([
      { kind: 'hizb', hizb: 27 },
    ])
    expect(divisionsOf(ayahRow(1, 1, { flags: rubStart, rub: 106, hizb: 27 }))).toEqual([
      { kind: 'quarter', hizb: 27, quarter: 1 },
    ])
    expect(divisionsOf(ayahRow(1, 1, { flags: rubStart, rub: 107, hizb: 27 }))).toEqual([
      { kind: 'quarter', hizb: 27, quarter: 2 },
    ])
    expect(divisionsOf(ayahRow(1, 1, { flags: rubStart, rub: 108, hizb: 27 }))).toEqual([
      { kind: 'quarter', hizb: 27, quarter: 3 },
    ])
    expect(divisionsOf(ayahRow(1, 1, { sajda: 'obligatory' }))).toEqual([{ kind: 'sajda', obligatory: true }])
    expect(divisionsOf(ayahRow(1, 1, { flags: rubStart, rub: 106, sajda: 'recommended' }))).toEqual([
      { kind: 'quarter', hizb: 5, quarter: 1 },
      { kind: 'sajda', obligatory: false },
    ])
  })

  it('has nothing for an ayah continued from the previous page or without a marker', () => {
    expect(divisionsOf(ayahRow(1, 1, { flags: AYAH_FLAG.juzStart, startsOnPage: false }))).toEqual([])
    expect(divisionsOf(ayahRow(1, 1, { flags: AYAH_FLAG.surahStart }))).toEqual([])
  })
})

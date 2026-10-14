/**
 * `quran` store: constant-time and binary-search lookups over the immutable `QuranIndex` from the bootstrap
 * (surahs, divisions, ayah ↔ word ↔ page per layout) and surah-name matching. Layer L0 (imports `i18n` for the
 * localised reference labels).
 *
 * The index is held in `$state.raw` (never a deep proxy over 6,236 entries). Lookups validate their input and
 * return a documented neutral value instead of throwing: an empty range `{ from: 0, to: -1 }`, id `0`, `undefined`,
 * or page 1 for page lookups (the reader always has a page to show).
 *
 * **Surah names.** `surahMatches(q)` ranks surahs by every name core.db has (`name_ar`, `name_simple`,
 * `name_complex`, `name_en`) plus the common alternative names below (`SURAH_ALIASES`). Arabic is compared after
 * `normalizeAr` (loose); Latin after `foldLatin` with `-`/`'` removed and a transliteration skeleton (doubled vowels,
 * `ee`/`oo`, `y`/`i`, `w`/`u`, `q`/`k`, `th`/`t`, … folded), so "Yaseen", "Ya-Sin" and "yasin", or "Al-Faatiha" and
 * "Fatihah", are the same key. Articles (`al-`, `an-`, `as-`, … ; `ال`) and a leading "surah"/"سورة" are optional.
 * Exact beats prefix beats substring beats a one- or two-letter typo; ties keep the surah order.
 */
import type { Store } from '$lib/contracts/stores'
import type {
  Bootstrap,
  Division,
  LayoutInfo,
  MushafLayout,
  QuranIndex,
  ReferenceStyle,
  SurahInfo,
} from '$lib/ipc/bindings'
import { foldLatin, hasArabic, normalizeAr } from '$lib/text/normalize'
import { i18n } from './i18n.svelte'

const EMPTY: QuranIndex = {
  surahs: [],
  juz: [],
  hizb: [],
  rub: [],
  manzil: [],
  sajdas: [],
  layouts: [],
  ayahFirstWord: [],
}

/** An inclusive ayah-id range. `{ from: 0, to: -1 }` is the empty range. */
export interface AyahIdRange {
  from: number
  to: number
}

/** `(surah, ayah)`; `{ surah: 0, ayah: 0 }` for an unknown ayah id. */
export interface AyahRef {
  surah: number
  ayah: number
}

export const EMPTY_RANGE: Readonly<AyahIdRange> = Object.freeze({ from: 0, to: -1 })
const NO_REF: Readonly<AyahRef> = Object.freeze({ surah: 0, ayah: 0 })

/** Index of the last element `<= value` of an ascending list (by `key`), or -1. */
function floorBy<T>(list: readonly T[], value: number, key: (item: T) => number): number {
  let lo = 0
  let hi = list.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const item = list[mid]
    if (item !== undefined && key(item) <= value) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

const identity = (n: number) => n
const isId = (n: number) => Number.isInteger(n) && n >= 1

// --- surah-name matching ---------------------------------------------------------------------------------------------

/**
 * Alternative names in common use besides core.db's four (Latin transliteration variants that the skeleton already
 * folds, such as "Yaseen" or "Baqara", are not listed). Arabic entries are matched against Arabic queries only.
 */
export const SURAH_ALIASES: Readonly<Record<number, readonly string[]>> = {
  1: ['Al-Hamd', 'Umm al-Kitab', "As-Sab' al-Mathani", 'الحمد', 'أم الكتاب', 'أم القرآن', 'السبع المثاني'],
  3: ['Al Imran'],
  9: ["Bara'ah", 'Baraat', 'Tauba', 'براءة'],
  10: ['Jonah'],
  17: ["Bani Isra'il", 'Bani Israel', 'Subhan', 'بني إسرائيل', 'سبحان'],
  20: ['Ta Ha', 'طاها'],
  35: ["Al-Mala'ikah", 'Malaika', 'The Angels', 'الملائكة'],
  36: ['Ya Sin', 'ياسين'],
  38: ['صاد'],
  40: ["Al-Mu'min", 'The Believer', 'المؤمن', 'الطول'],
  41: ['Ha Mim Sajdah', 'Hamim Sajdah', 'حم السجدة'],
  45: ['الشريعة'],
  47: ['Al-Qital', 'القتال'],
  50: ['قاف'],
  58: ['Al-Mujadalah'],
  60: ['Al-Mumtahinah'],
  62: ["Al-Jum'ah"],
  67: ['Tabarak', 'تبارك'],
  68: ['Nun', 'Noon', 'ن', 'نون'],
  70: ['سأل سائل'],
  76: ['Ad-Dahr', 'هل أتى', 'الدهر'],
  78: ["'Amma", 'عم', 'التساؤل'],
  81: ['كورت'],
  82: ['انفطرت'],
  83: ['At-Tatfif', 'التطفيف'],
  84: ['انشقت'],
  87: ['Sabbih', 'سبح'],
  94: ['Al-Inshirah', 'Alam Nashrah', 'الانشراح', 'ألم نشرح'],
  95: ['Teen'],
  96: ['Iqra', 'اقرأ'],
  98: ['لم يكن'],
  99: ['Az-Zilzal', 'الزلزال'],
  105: ['Feel'],
  107: ['أرأيت'],
  108: ['Al-Kausar', 'Al-Kauthar'],
  111: ['Al-Lahab', 'Tabbat', 'اللهب', 'تبت'],
  112: ['At-Tawhid', 'التوحيد'],
}

/** Latin articles that may be omitted ("Al-Baqarah" = "Baqarah", "Ash-Shams" = "Shams"); "the" for English names. */
const LATIN_ARTICLES = new Set(['al', 'el', 'an', 'ar', 'as', 'ash', 'at', 'ath', 'ad', 'adh', 'az', 'the'])
/** A leading "surah" word in a query ("Surah Yasin", "Surat al-Baqara"). */
const LATIN_SURAH_WORDS = new Set(['surah', 'surat', 'sura', 'suratu', 'soorah', 'surah-e'])
/** Latin letters NFKD does not decompose, and apostrophe-like marks (ayn/hamza) that are dropped. */
const LATIN_LETTERS: Readonly<Record<string, string>> = {
  đ: 'd',
  ħ: 'h',
  ı: 'i',
  ł: 'l',
  ø: 'o',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  þ: 'th',
}
const LATIN_DROP = /['`\u00b4\u02bc\u02bd\u02be\u02bf\u2018\u2019]/gu
/** Digraphs folded to one letter, then single letters, in order (the transliteration skeleton). */
const LATIN_FOLDS: readonly (readonly [RegExp, string])[] = [
  [/ou/g, 'u'],
  [/ee/g, 'i'],
  [/oo/g, 'u'],
  [/th/g, 't'],
  [/dh/g, 'd'],
  [/kh/g, 'k'],
  [/gh/g, 'g'],
  [/sh/g, 's'],
  [/ph/g, 'f'],
  [/q/g, 'k'],
  [/e/g, 'i'],
  [/o/g, 'u'],
  [/y/g, 'i'],
  [/w/g, 'u'],
  [/(.)\1+/g, '$1'],
]
/** A final "h" after a vowel is silent ("Fatihah" = "Fatiha", "Nuh" = "Nu"). */
const FINAL_H = /([aiu])h$/

/** The Latin words of a name or query: folded, apostrophes dropped, split on anything that is not a letter or digit. */
function latinWords(text: string): string[] {
  const folded = foldLatin(text)
    .replace(LATIN_DROP, '')
    .replace(/[^\s\p{L}\p{N}]/gu, ' ')
  let out = ''
  for (const ch of folded) out += LATIN_LETTERS[ch] ?? ch
  return out.split(/\s+/u).filter((w) => w !== '')
}

/** The transliteration skeleton: `ee`/`oo`/`ou`, `th`/`dh`/`kh`/`gh`/`sh`/`ph`, `q`/`e`/`o`/`y`/`w` and doubled letters. */
function latinSkeleton(words: readonly string[]): string {
  let s = words.join('')
  for (const [pattern, to] of LATIN_FOLDS) s = s.replace(pattern, to)
  return s
}

/** The Arabic words of a name or query (`normalizeAr` loose). */
function arabicWords(text: string): string[] {
  return normalizeAr(text, 'loose')
    .split(' ')
    .filter((w) => w !== '')
}

/** Joined without spaces, every alef after the first letter dropped ("الرحمان" = "الرحمن", "طاها" = "طه"). */
function arabicSkeleton(words: readonly string[]): string {
  const s = words.join('')
  return s.slice(0, 1) + s.slice(1).replaceAll('ا', '')
}

/**
 * One form of a name: `key` is its skeleton (transliteration variants folded) and `raw` its letters as written
 * (folded and lower-cased only), which ranks a literal match first ("ka" → Al-Kahf before Qaf).
 */
interface NameForm {
  key: string
  raw: string
}

/** The forms of a name: the whole name, and without its article (and, for queries, without a "surah" word). */
function nameVariants(text: string, query: boolean): { arabic: boolean; forms: NameForm[] } {
  const forms: NameForm[] = []
  const add = (key: string, raw: string) => {
    if (key !== '' && !forms.some((f) => f.key === key && f.raw === raw)) forms.push({ key, raw })
  }
  if (hasArabic(text)) {
    let words = arabicWords(text)
    if (query && words.length > 1 && (words[0] === 'سوره' || words[0] === 'السوره')) words = words.slice(1)
    add(arabicSkeleton(words), words.join(''))
    const first = words[0]
    if (first !== undefined && first.startsWith('ال') && first.length > 3) {
      const bare = [first.slice(2), ...words.slice(1)]
      add(arabicSkeleton(bare), bare.join(''))
    }
    return { arabic: true, forms }
  }
  let words = latinWords(text)
  if (query && words.length > 1 && LATIN_SURAH_WORDS.has(words[0] ?? '')) words = words.slice(1)
  const variants = [words]
  if (words.length > 1 && LATIN_ARTICLES.has(words[0] ?? '')) variants.push(words.slice(1))
  for (const w of variants) {
    const key = latinSkeleton(w)
    const raw = w.join('')
    // Names always drop a silent final "h"; a query keeps both forms, since "kah" may still become "kahf".
    if (query) add(key, raw)
    add(key.replace(FINAL_H, '$1'), raw)
  }
  return { arabic: false, forms }
}

/** One searchable name of a surah: its forms, its script, and whether it is one of core.db's names. */
export interface SurahNameKey extends NameForm {
  surah: number
  arabic: boolean
  primary: boolean
}

/** Every name key of every surah (core.db names, then aliases). */
export function buildSurahKeys(surahs: readonly SurahInfo[]): SurahNameKey[] {
  const out: SurahNameKey[] = []
  for (const s of surahs) {
    const names: [string, boolean][] = [
      [s.nameAr, true],
      [s.nameSimple, true],
      [s.nameComplex, true],
      [s.nameEn, true],
      ...(SURAH_ALIASES[s.id] ?? []).map((a): [string, boolean] => [a, false]),
    ]
    const first = out.length
    for (const [name, primary] of names) {
      const { arabic, forms } = nameVariants(name, false)
      for (const { key, raw } of forms) {
        const known = out.some((k, i) => i >= first && k.arabic === arabic && k.key === key && k.raw === raw)
        if (!known) out.push({ surah: s.id, key, raw, arabic, primary })
      }
    }
  }
  return out
}

/**
 * Optimal-string-alignment distance (Levenshtein plus adjacent transpositions), or `max + 1` as soon as it must exceed
 * `max`.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const cols = b.length + 1
  let prev2 = new Array<number>(cols).fill(0)
  let prev = Array.from({ length: cols }, (_, j) => j)
  let cur = new Array<number>(cols).fill(0)
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    let rowMin = i
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, (prev2[j - 2] ?? 0) + 1)
      cur[j] = v
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return max + 1
    ;[prev2, prev, cur] = [prev, cur, prev2]
  }
  return prev[b.length] ?? max + 1
}

/** Scores at or above this are prefix or substring matches; below it, typo matches. */
const TYPO_CEILING = 50
/** Added when the name also matches as written, not only through the transliteration skeleton. */
const LITERAL_BONUS = 5
/** Added for core.db's own names over aliases. */
const PRIMARY_BONUS = 2

/** How well a query skeleton matches a name skeleton (0 = no match). */
function scoreKey(query: string, key: string): number {
  if (key === query) return 100
  if (key.startsWith(query)) return 80 + (10 * query.length) / key.length
  if (query.length >= 3 && key.includes(query)) return 50 + (10 * query.length) / key.length
  if (query.length < 3) return 0
  // A typo: against the whole key, or against the key's start while the query is still being typed.
  const max = query.length >= 7 ? 2 : 1
  const whole = editDistance(query, key, max)
  const head = query.length < key.length ? editDistance(query, key.slice(0, query.length), max) : max + 1
  const d = Math.min(whole, head)
  if (d > max) return 0
  return (whole <= max ? 40 : 30) - 8 * d
}

/** Surah ids ranked by how well `query` matches their names (best first; ties in surah order). */
export function rankSurahNames(keys: readonly SurahNameKey[], query: string): number[] {
  const trimmed = query.trim()
  if (trimmed === '' || /^[\d\s\u0660-\u0669\u06f0-\u06f9]+$/u.test(trimmed)) return []
  const { arabic, forms } = nameVariants(trimmed, true)
  if (forms.length === 0) return []
  /** The best score per surah id (sparse; 0 or missing = no match). */
  const best: number[] = []
  for (const k of keys) {
    if (k.arabic !== arabic) continue
    let score = 0
    for (const q of forms) {
      score = Math.max(score, scoreKey(q.key, k.key))
      const literal = scoreKey(q.raw, k.raw)
      if (literal >= TYPO_CEILING) score = Math.max(score, literal + LITERAL_BONUS)
    }
    if (score <= 0) continue
    if (k.primary) score += PRIMARY_BONUS
    if (score > (best[k.surah] ?? 0)) best[k.surah] = score
  }
  const ranked: [number, number][] = []
  best.forEach((score, id) => {
    if (score > 0) ranked.push([id, score])
  })
  // Typo matches only fill in when nothing matches as a prefix or substring ("kahf" is not also "Qaf").
  const strong = ranked.some(([, score]) => score >= TYPO_CEILING)
  return ranked
    .filter(([, score]) => !strong || score >= TYPO_CEILING)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([id]) => id)
}

class QuranStore implements Store {
  index = $state.raw<QuranIndex>(EMPTY)

  /** Ayahs in the index (6,236 for a real core.db). */
  readonly ayahCount: number = $derived.by(() => {
    if (this.index.ayahFirstWord.length > 0) return this.index.ayahFirstWord.length
    const last = this.index.surahs.at(-1)
    return last ? last.firstAyahId + last.ayahCount - 1 : 0
  })
  readonly #layouts = $derived(new Map(this.index.layouts.map((l) => [l.layout, l] as const)))
  /** Name keys for `surahMatches`, built once per index. */
  readonly #nameKeys = $derived(buildSurahKeys(this.index.surahs))

  init(b: Bootstrap): void {
    this.index = b.index
  }

  // --- surahs and ayahs ----------------------------------------------------------------------------------------------

  /** Surah `n` (1–114), or `undefined`. */
  surah(n: number): SurahInfo | undefined {
    if (!isId(n)) return undefined
    const s = this.index.surahs[n - 1]
    return s?.id === n ? s : this.index.surahs.find((x) => x.id === n)
  }

  /** The surah's name in the UI language: `name_ar` in the Arabic UI, `name_simple` otherwise. */
  surahName(n: number): string {
    const s = this.surah(n)
    if (!s) return ''
    return i18n.locale === 'ar' ? s.nameAr : s.nameSimple
  }

  /** Whether `id` is an ayah id of the index. */
  isAyahId(id: number): boolean {
    return isId(id) && id <= this.ayahCount
  }

  /** `(surah, ayah)` of an ayah id; `{ surah: 0, ayah: 0 }` when unknown. */
  ayahRef(id: number): AyahRef {
    if (!this.isAyahId(id)) return NO_REF
    const s = this.index.surahs[floorBy(this.index.surahs, id, (x) => x.firstAyahId)]
    return s ? { surah: s.id, ayah: id - s.firstAyahId + 1 } : NO_REF
  }

  /** The ayah id of `surah:ayah`, or 0 when it does not exist. */
  ayahId(surah: number, ayah: number): number {
    const s = this.surah(surah)
    return s && isId(ayah) && ayah <= s.ayahCount ? s.firstAyahId + ayah - 1 : 0
  }

  /** The first word id of an ayah, or 0. */
  firstWordOf(ayahId: number): number {
    return this.isAyahId(ayahId) ? (this.index.ayahFirstWord[ayahId - 1] ?? 0) : 0
  }

  /** The ayah a word belongs to, or 0. */
  ayahOfWord(wordId: number): number {
    if (!isId(wordId)) return 0
    return floorBy(this.index.ayahFirstWord, wordId, identity) + 1
  }

  // --- pages ---------------------------------------------------------------------------------------------------------

  /** A layout's page tables, or `undefined` when the index has none for it. */
  layout(layout: MushafLayout): LayoutInfo | undefined {
    return this.#layouts.get(layout)
  }

  /** Pages of a layout (604 for every Madani layout). */
  pageCount(layout: MushafLayout): number {
    return this.layout(layout)?.pages ?? 0
  }

  /** The page holding a word (the largest page start ≤ the word); page 1 when unknown. */
  pageOfWord(layout: MushafLayout, wordId: number): number {
    const l = this.layout(layout)
    if (!l || !isId(wordId)) return 1
    return Math.max(1, floorBy(l.pageFirstWord, wordId, identity) + 1)
  }

  /** The page holding the first word of an ayah; page 1 when unknown. */
  pageOfAyah(layout: MushafLayout, ayahId: number): number {
    const word = this.firstWordOf(ayahId)
    if (word > 0) return this.pageOfWord(layout, word)
    const l = this.layout(layout)
    if (!l || !this.isAyahId(ayahId)) return 1
    return Math.max(1, floorBy(l.pageFirstAyah, ayahId, identity) + 1)
  }

  /**
   * Every ayah with at least one word on the page (a page that starts inside an ayah includes it), from the word
   * tables; the page-start ayahs when the index has no word tables. Empty for an unknown page.
   */
  pageRange(layout: MushafLayout, page: number): AyahIdRange {
    const l = this.layout(layout)
    if (!l || !isId(page) || page > l.pages) return EMPTY_RANGE
    const firstWord = l.pageFirstWord[page - 1]
    if (firstWord !== undefined && this.index.ayahFirstWord.length > 0) {
      const nextWord = l.pageFirstWord[page]
      const from = this.ayahOfWord(firstWord)
      const to = nextWord === undefined ? this.ayahCount : this.ayahOfWord(nextWord - 1)
      return from > 0 && to >= from ? { from, to } : EMPTY_RANGE
    }
    const first = l.pageFirstAyah[page - 1]
    if (first === undefined) return EMPTY_RANGE
    const next = l.pageFirstAyah[page]
    return { from: first, to: next === undefined ? this.ayahCount : Math.max(first, next - 1) }
  }

  // --- divisions -----------------------------------------------------------------------------------------------------

  #divisionOf(list: readonly Division[], ayahId: number): number {
    if (!this.isAyahId(ayahId)) return 0
    return list[floorBy(list, ayahId, (d) => d.firstAyahId)]?.id ?? 0
  }

  #divisionRange(list: readonly Division[], n: number): AyahIdRange {
    if (!isId(n)) return EMPTY_RANGE
    const d = list[n - 1]?.id === n ? list[n - 1] : list.find((x) => x.id === n)
    return d ? { from: d.firstAyahId, to: d.lastAyahId } : EMPTY_RANGE
  }

  /** The juz (1–30) of an ayah, or 0. */
  juzOf(ayahId: number): number {
    return this.#divisionOf(this.index.juz, ayahId)
  }

  /** The hizb (1–60) of an ayah, or 0. */
  hizbOf(ayahId: number): number {
    return this.#divisionOf(this.index.hizb, ayahId)
  }

  /** The rub' al-hizb (1–240) of an ayah, or 0. */
  rubOf(ayahId: number): number {
    return this.#divisionOf(this.index.rub, ayahId)
  }

  /** The manzil (1–7) of an ayah, or 0. */
  manzilOf(ayahId: number): number {
    return this.#divisionOf(this.index.manzil, ayahId)
  }

  /** Surah `n` as an ayah-id range. */
  surahRange(n: number): AyahIdRange {
    const s = this.surah(n)
    return s ? { from: s.firstAyahId, to: s.firstAyahId + s.ayahCount - 1 } : EMPTY_RANGE
  }

  /** Juz `n` as an ayah-id range. */
  juzRange(n: number): AyahIdRange {
    return this.#divisionRange(this.index.juz, n)
  }

  /** Hizb `n` as an ayah-id range. */
  hizbRange(n: number): AyahIdRange {
    return this.#divisionRange(this.index.hizb, n)
  }

  /** Rub' al-hizb `n` (1–240) as an ayah-id range; rubs 4h−3 … 4h are the quarters of hizb h. */
  rubRange(n: number): AyahIdRange {
    return this.#divisionRange(this.index.rub, n)
  }

  // --- search and labels ---------------------------------------------------------------------------------------------

  /**
   * Surahs whose names match a query: Arabic or Latin, any of core.db's names or a common alias, articles and a
   * leading "surah" optional, tolerant of transliteration variants and small typos. Best match first; at most `limit`.
   * A query of digits only matches nothing (numbers are references: `parseReference`).
   */
  surahMatches(query: string, limit = Number.POSITIVE_INFINITY): SurahInfo[] {
    const out: SurahInfo[] = []
    for (const id of rankSurahNames(this.#nameKeys, query)) {
      if (out.length >= limit) break
      const s = this.surah(id)
      if (s) out.push(s)
    }
    return out
  }

  /**
   * A reference label for an ayah or a range (`toId`), in the UI language:
   * - `short`: `2:255`, `2:255–257`, `2:286–3:2`;
   * - `long`: `Al-Baqarah 2:255` (`البقرة ٢:٢٥٥` in the Arabic UI);
   * - `arabic`: `البقرة: ٢٥٥` (Arabic name, Arabic-Indic digits, like the copy format).
   * Digits and isolation follow `i18n.ref`. Empty for an unknown ayah.
   */
  refLabel(ayahId: number, style: ReferenceStyle = 'long', toId?: number): string {
    const from = this.ayahRef(ayahId)
    if (from.surah === 0) return ''
    const to = toId !== undefined && toId !== ayahId ? this.ayahRef(toId) : null
    const range = to !== null && to.surah !== 0 ? to : null
    if (style === 'arabic') {
      const name = this.surah(from.surah)?.nameAr ?? ''
      const ayahs =
        range === null
          ? i18n.mushafNum(from.ayah)
          : range.surah === from.surah
            ? `${i18n.mushafNum(from.ayah)}–${i18n.mushafNum(range.ayah)}`
            : `${i18n.mushafNum(from.ayah)}–${this.surah(range.surah)?.nameAr ?? ''}: ${i18n.mushafNum(range.ayah)}`
      return `${name}: ${ayahs}`
    }
    const ref = i18n.ref(from.surah, from.ayah, range?.ayah, range?.surah)
    return style === 'short' ? ref : `${this.surahName(from.surah)} ${ref}`
  }

  reset(): void {
    this.index = EMPTY
  }
}

export const quran = new QuranStore()

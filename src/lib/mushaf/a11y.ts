/**
 * Screen-reader text for the Mushaf (§8.15). Owner: WP8d.
 *
 * Every glyph layer is `aria-hidden` (QCF glyphs are PUA code points that read as nothing), so each page carries a
 * visually hidden ayah list (`A11yLayer.svelte`) whose items speak the ayah's QPC Hafs text. Arabic TTS engines (NVDA +
 * OneCore Arabic, VoiceOver "Majed") read several Uthmani marks as symbol names ("small high seen", "end of ayah") or
 * not at all, so `toSpeech` maps the text to the plain vocalised orthography they pronounce correctly:
 *
 * - **mapped** (pronunciation kept): U+06E1 small high dotless head of khah → U+0652 sukun; U+0671 alef wasla → U+0627
 *   alef; U+06E5 small waw → و; U+06E6 small yeh → ي; the open (staggered) tanween → the plain tanween: U+08F0/U+0657 →
 *   U+064B fathatan, U+08F1/U+065E → U+064C dammatan, U+08F2/U+0656 → U+064D kasratan. The QPC Hafs text encodes the
 *   open tanween with U+0657, U+065E and U+0656 (KFGQPC's code points, which predate U+08F0–U+08F2), e.g. `كَثِيرٗا`,
 *   `سِنَةٞ`, `بِشَيۡءٖ` in 2:255 and 38:24 (docs/deviations/WP8d.md).
 * - **stripped** (pause signs, annotation marks and symbols TTS reads as names): U+06D6–U+06DC (small high ligatures and
 *   waqf signs), U+06DD end of ayah, U+06DE rub el hizb, U+06DF–U+06E4 (U+06E1 is mapped first), U+06E7–U+06ED (small
 *   high yeh, small high noon, place of sajdah, stops, small low meem).
 *
 * Then whitespace collapses (a stripped stand-alone sign such as `۞ ` or ` ۩` leaves no double space). The function is
 * pure and idempotent; vectors for 1:1–7, 2:255 and 38:24 live in `a11y.test.ts`.
 */
import type { PageAyah, PageData, PageWord } from '$lib/ipc/bindings'

/** Code points replaced by another (applied before stripping, so U+06E1 survives as a sukun). */
const SPEECH_MAP: ReadonlyMap<number, number> = new Map([
  [0x06e1, 0x0652], // small high dotless head of khah → sukun
  [0x0671, 0x0627], // alef wasla → alef
  [0x06e5, 0x0648], // small waw → waw
  [0x06e6, 0x064a], // small yeh → yeh
  [0x08f0, 0x064b], // open fathatan → fathatan
  [0x0657, 0x064b], // (KFGQPC open fathatan) → fathatan
  [0x08f1, 0x064c], // open dammatan → dammatan
  [0x065e, 0x064c], // (KFGQPC open dammatan) → dammatan
  [0x08f2, 0x064d], // open kasratan → kasratan
  [0x0656, 0x064d], // (KFGQPC open kasratan) → kasratan
])

/** Inclusive code point ranges removed from speech text. */
const SPEECH_STRIP: readonly (readonly [number, number])[] = [
  [0x06d6, 0x06dc],
  [0x06dd, 0x06dd],
  [0x06de, 0x06de],
  [0x06df, 0x06e4],
  [0x06e7, 0x06ed],
]

function stripped(cp: number): boolean {
  for (const [from, to] of SPEECH_STRIP) if (cp >= from && cp <= to) return true
  return false
}

/** Speech text for QPC Hafs Quran text (§8.15): see the module comment for the exact mapping. */
export function toSpeech(text: string): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    const mapped = SPEECH_MAP.get(cp)
    if (mapped !== undefined) out += String.fromCodePoint(mapped)
    else if (!stripped(cp)) out += ch
  }
  return out.replace(/\s+/gu, ' ').trim()
}

/** Arabic-Indic digits for the ayah number that ends each spoken item (§0.2: Mushaf numbers are always Arabic-Indic). */
const ARABIC_DIGITS = new Intl.NumberFormat('ar-u-nu-arab', { useGrouping: false })

/** The ayah number suffix of a spoken item: ` (٢٥٥)`. */
export function ayahNumberSuffix(ayah: number): string {
  return ` (${ARABIC_DIGITS.format(ayah)})`
}

/** The `ayah.flags` bits of §3.1.2. */
export const AYAH_FLAG = {
  /** The mushaf-source rub changes at this ayah (the ۞ margin marker). */
  rubStart: 1,
  /** That new rub starts a hizb. */
  hizbStart: 2,
  /** The juz changes at this ayah. */
  juzStart: 4,
  /** The first ayah of a surah. */
  surahStart: 8,
} as const

/** A margin marker of an ayah (§8.9), as data: what starts there, and its sajda. */
export type Division =
  | { kind: 'juz'; juz: number }
  | { kind: 'hizb'; hizb: number }
  | { kind: 'quarter'; hizb: number; quarter: 1 | 2 | 3 }
  | { kind: 'sajda'; obligatory: boolean }

/**
 * The margin markers of an ayah that starts on the page (§3.1.2 label rule, §8.9): the division that starts there (juz,
 * else hizb, else the rub's quarter within its hizb), then the sajda. Empty for an ayah continued from the previous page.
 */
export function divisionsOf(ayah: PageAyah): Division[] {
  if (!ayah.startsOnPage) return []
  const out: Division[] = []
  if (ayah.flags & AYAH_FLAG.juzStart) out.push({ kind: 'juz', juz: ayah.juz })
  else if (ayah.flags & AYAH_FLAG.hizbStart) out.push({ kind: 'hizb', hizb: ayah.hizb })
  else if (ayah.flags & AYAH_FLAG.rubStart) {
    const quarter = (((ayah.rub - 1) % 4) + 4) % 4
    if (quarter === 1 || quarter === 2 || quarter === 3)
      out.push({ kind: 'quarter', hizb: ayah.hizb, quarter })
  }
  if (ayah.sajda !== null) out.push({ kind: 'sajda', obligatory: ayah.sajda === 'obligatory' })
  return out
}

/** One spoken item of a page: an ayah's words on that page (§8.15). */
export interface A11ySegment {
  ayah: PageAyah
  /** The ayah's words on the page in reading order, end marker excluded. */
  words: PageWord[]
  /** `toSpeech` of the words followed by the Arabic-Indic ayah number: `ٱللَّهُ لَآ …` → `اللَّهُ لَا … (٢٥٥)`. */
  speech: string
  /** The ayah continues on the next page. */
  continues: boolean
  /** The ayah started on the previous page. */
  continued: boolean
}

/** The spoken items of a page, one per ayah segment, in reading order (§8.15). */
export function pageSegments(data: PageData): A11ySegment[] {
  const byAyah = new Map<number, PageWord[]>()
  for (const line of data.lines) {
    for (const w of line.words) {
      if (w.isEnd) continue
      const list = byAyah.get(w.ayahId)
      if (list) list.push(w)
      else byAyah.set(w.ayahId, [w])
    }
  }
  return data.ayahs.map((ayah) => {
    const words = byAyah.get(ayah.id) ?? []
    const text = toSpeech(words.map((w) => w.text).join(' '))
    return {
      ayah,
      words,
      speech: `${text}${ayahNumberSuffix(ayah.ayah)}`.trim(),
      continues: !ayah.endsOnPage,
      continued: !ayah.startsOnPage,
    }
  })
}

/** The DOM id of a page's roving item for an ayah (§8.15): `a11y-262-1802`. */
export function a11yItemId(page: number, ayahId: number): string {
  return `a11y-${page}-${ayahId}`
}

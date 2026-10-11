/**
 * The reference parser of the command palette and the Go to dialog (§10.4; golden vectors in `refparse.vectors.json`).
 * Owner: WP10a. Pure over the L0 `quran` index (limits, ayah counts, surah names) and `i18n` (reasons and labels).
 *
 * Digits are normalised first (Arabic-Indic and Persian → ASCII), then the first matching form wins:
 *
 * | Input | Result |
 * |---|---|
 * | `2:255`, `2.255`, `2/255`, `2 255`, `2:255-257` (`–`, `—`) | ayah, or ayah range |
 * | `2:` | surah 2 (an ayah reference being typed) |
 * | `p 262`, `page 262`, `ص ٢٦٢`, `صفحة 262` | page |
 * | `j 15`, `juz 15`, `ج ١٥`, `جزء 15` | juz |
 * | `h 30`, `hizb 30`, `حزب 30` | hizb |
 * | `s 18`, `surah 18`, `سورة 18` | surah |
 * | bare `n` | surah `n` (if ≤ 114) and page `n` (if ≤ 604) |
 * | `kahf 10`, `البقرة ٢٥٥`, `Yasin:1-12` | ayah of the best name matches (`source: 'name'`) |
 * | anything else | surah-name matches (`quran.surahMatches`, `source: 'name'`) |
 *
 * Out-of-range values produce a result with `issue` and a localised `disabledReason` (shown as a disabled item), never
 * an error. Number fields accept one more digit than the spec's patterns (`p 1000`, `2:1000`) only so that those inputs
 * explain themselves instead of matching nothing.
 */
import type { MushafLayout } from '$lib/ipc/bindings'
import { i18n } from '$lib/stores/i18n.svelte'
import { quran } from '$lib/stores/quran.svelte'
import { asciiDigits } from './normalize'

export type ParsedTarget =
  | { type: 'ayah'; surah: number; ayah: number; toAyah?: number }
  | { type: 'page'; page: number }
  | { type: 'juz'; juz: number }
  | { type: 'hizb'; hizb: number }
  | { type: 'surah'; surah: number }

/** Which limit an out-of-range target exceeds (`range`: the range ends before it starts). */
export type RefIssue = 'surah' | 'ayah' | 'range' | 'page' | 'juz' | 'hizb'

/** How the input was understood: a reference form, a bare number, or a surah name. */
export type ParseSource = 'ref' | 'number' | 'name'

/** One candidate target for an input. `disabledReason` (localised) and `issue` are set together, for invalid targets. */
export interface ParseResult {
  target: ParsedTarget
  disabledReason?: string
  issue?: RefIssue
  source: ParseSource
}

export interface ParseOptions {
  /** Include surah-name matches and "name ayah" references (default true). */
  names?: boolean
  /** At most this many name matches (default 5). */
  nameLimit?: number
}

/** The counts used when the index is not loaded (the Madani Mushaf, Hafs numbering). */
export const DEFAULT_LIMITS = { surahs: 114, pages: 604, juz: 30, hizb: 60 } as const

const NUM = '(\\d{1,4})'
const AYAH = new RegExp(`^${NUM}\\s*[:.\\s/]\\s*${NUM}(?:\\s*[-–—]\\s*${NUM})?$`, 'u')
const SURAH_PENDING = /^(\d{1,4})\s*[:.]$/u
const prefixed = (words: string) => new RegExp(`^(?:${words})\\.?\\s*${NUM}$`, 'iu')
const PAGE = prefixed('p|pg|page|ص|صفحة|صفحه|الصفحة|الصفحه')
const JUZ = prefixed("j|juz|juz'|jz|para|ج|جز|جزء|الجزء")
const HIZB = prefixed('h|hizb|حزب|الحزب')
const SURAH = prefixed('s|surah|sura|surat|سورة|سوره|السورة|السوره')
const BARE = new RegExp(`^${NUM}$`, 'u')
const NAMED_AYAH = new RegExp(`^(.*?\\p{L}.*?)\\s*[:\\s]\\s*${NUM}(?:\\s*[-–—]\\s*${NUM})?$`, 'u')
/** A pasted reference with its name: "Al-Baqarah 2:255", "— Al-Baqarah 2:255–257" (the numbers decide). */
const NAMED_REF = new RegExp(
  `^[^\\d]*\\p{L}[^\\d]*?\\s${NUM}\\s*[:./]\\s*${NUM}(?:\\s*[-–—]\\s*${NUM})?$`,
  'u',
)
/**
 * Harakat, dagger alef and tatweel (an Arabic prefix typed with marks, "صَفْحَة", still matches), and bidi controls (a
 * reference copied from an isolated label, LRI 2:255 PDI).
 */
const MARKS = /[\u064b-\u065f\u0670\u0640\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu
/** Brackets and dashes around a copied reference: "(2:255)", "[البقرة: ٢٥٥]", "﴿…﴾", "— Al-Baqarah 2:255". */
const WRAPPERS = /^[\s([{﴿«"'\-–—]+|[\s)\]}﴾»"']+$/gu

/** The current limits: from the index once it is loaded, else the Madani defaults. */
export function limits(): { surahs: number; pages: number; juz: number; hizb: number } {
  const index = quran.index
  return {
    surahs: index.surahs.length || DEFAULT_LIMITS.surahs,
    pages: Math.max(0, ...index.layouts.map((l) => l.pages)) || DEFAULT_LIMITS.pages,
    juz: index.juz.length || DEFAULT_LIMITS.juz,
    hizb: index.hizb.length || DEFAULT_LIMITS.hizb,
  }
}

/** The localised reason an issue disables a target. */
export function issueReason(issue: RefIssue, target: ParsedTarget): string {
  const max = limits()
  switch (issue) {
    case 'surah':
      return i18n.t('navigation.reason.surah', { count: max.surahs })
    case 'ayah': {
      const surah = target.type === 'ayah' ? quran.surah(target.surah) : undefined
      return surah
        ? i18n.tp('navigation.reason.ayah', surah.ayahCount, { surah: quran.surahName(surah.id) })
        : i18n.t('navigation.reason.surah', { count: max.surahs })
    }
    case 'range':
      return i18n.t('navigation.reason.range')
    case 'page':
      return i18n.t('navigation.reason.page', { count: max.pages })
    case 'juz':
      return i18n.t('navigation.reason.juz', { count: max.juz })
    case 'hizb':
      return i18n.t('navigation.reason.hizb', { count: max.hizb })
  }
}

function result(target: ParsedTarget, source: ParseSource, issue: RefIssue | null): ParseResult {
  return issue === null
    ? { target, source }
    : { target, source, issue, disabledReason: issueReason(issue, target) }
}

/** The ayah count of a surah, using the index (0 when the surah does not exist). */
function ayahCount(surah: number): number {
  return quran.surah(surah)?.ayahCount ?? 0
}

function ayahResult(surah: number, ayah: number, to: number | null, source: ParseSource): ParseResult {
  const max = limits()
  const target: ParsedTarget =
    to !== null && to !== ayah ? { type: 'ayah', surah, ayah, toAyah: to } : { type: 'ayah', surah, ayah }
  if (surah < 1 || surah > max.surahs) return result(target, source, 'surah')
  const count = ayahCount(surah)
  if (ayah < 1 || (count > 0 && ayah > count)) return result(target, source, 'ayah')
  if (target.toAyah !== undefined) {
    if (target.toAyah < ayah) return result(target, source, 'range')
    if (count > 0 && target.toAyah > count) return result(target, source, 'ayah')
  }
  return result(target, source, null)
}

function inRange(n: number, max: number): boolean {
  return n >= 1 && n <= max
}

const num = (s: string | undefined): number => Number.parseInt(s ?? '', 10)
const optNum = (s: string | undefined): number | null => (s === undefined ? null : num(s))

/**
 * Candidate targets for an input (§10.4), best first. Empty for blank input or when nothing matches.
 */
export function parseReference(input: string, options: ParseOptions = {}): ParseResult[] {
  const names = options.names ?? true
  const nameLimit = options.nameLimit ?? 5
  const text = asciiDigits(input.normalize('NFKC')).replace(MARKS, '').replace(WRAPPERS, '').trim()
  if (text === '') return []
  const max = limits()

  let m = AYAH.exec(text) ?? NAMED_REF.exec(text)
  if (m) return [ayahResult(num(m[1]), num(m[2]), optNum(m[3]), 'ref')]

  m = SURAH_PENDING.exec(text)
  if (m) {
    const surah = num(m[1])
    return [result({ type: 'surah', surah }, 'ref', inRange(surah, max.surahs) ? null : 'surah')]
  }

  m = PAGE.exec(text)
  if (m) {
    const page = num(m[1])
    return [result({ type: 'page', page }, 'ref', inRange(page, max.pages) ? null : 'page')]
  }
  m = JUZ.exec(text)
  if (m) {
    const juz = num(m[1])
    return [result({ type: 'juz', juz }, 'ref', inRange(juz, max.juz) ? null : 'juz')]
  }
  m = HIZB.exec(text)
  if (m) {
    const hizb = num(m[1])
    return [result({ type: 'hizb', hizb }, 'ref', inRange(hizb, max.hizb) ? null : 'hizb')]
  }
  m = SURAH.exec(text)
  if (m) {
    const surah = num(m[1])
    return [result({ type: 'surah', surah }, 'ref', inRange(surah, max.surahs) ? null : 'surah')]
  }

  m = BARE.exec(text)
  if (m) {
    const n = num(m[1])
    const out: ParseResult[] = []
    if (inRange(n, max.surahs)) out.push(result({ type: 'surah', surah: n }, 'number', null))
    out.push(result({ type: 'page', page: n }, 'number', inRange(n, max.pages) ? null : 'page'))
    return out
  }

  if (!names) return []

  m = NAMED_AYAH.exec(text)
  if (m) {
    const ayah = num(m[2])
    const to = optNum(m[3])
    const matches = quran.surahMatches(m[1] ?? '', nameLimit)
    if (matches.length > 0) return matches.map((s) => ayahResult(s.id, ayah, to, 'name'))
  }

  return quran.surahMatches(text, nameLimit).map((s) => result({ type: 'surah', surah: s.id }, 'name', null))
}

// --- what a target is and where it leads -----------------------------------------------------------------------------

/** A stable key for a target (list keys, deduplication): `ayah:2:255-257`, `page:262`, `surah:18`. */
export function targetKey(t: ParsedTarget): string {
  switch (t.type) {
    case 'ayah':
      return `ayah:${t.surah}:${t.ayah}${t.toAyah === undefined ? '' : `-${t.toAyah}`}`
    case 'page':
      return `page:${t.page}`
    case 'juz':
      return `juz:${t.juz}`
    case 'hizb':
      return `hizb:${t.hizb}`
    case 'surah':
      return `surah:${t.surah}`
  }
}

/** The first ayah id a target opens at (0 when the target is out of range). */
export function targetAyahId(t: ParsedTarget, layout: MushafLayout): number {
  switch (t.type) {
    case 'ayah':
      return quran.ayahId(t.surah, t.ayah)
    case 'page':
      return Math.max(0, quran.pageRange(layout, t.page).from)
    case 'juz':
      return Math.max(0, quran.juzRange(t.juz).from)
    case 'hizb':
      return Math.max(0, quran.hizbRange(t.hizb).from)
    case 'surah':
      return Math.max(0, quran.surahRange(t.surah).from)
  }
}

/** The page a target opens (0 when the target is out of range). */
export function targetPage(t: ParsedTarget, layout: MushafLayout): number {
  if (t.type === 'page') return inRange(t.page, quran.pageCount(layout) || DEFAULT_LIMITS.pages) ? t.page : 0
  const id = targetAyahId(t, layout)
  return id > 0 ? quran.pageOfAyah(layout, id) : 0
}

/** A target as a title and a detail line in the UI language, for lists (Go to, the palette, the index filter). */
export interface TargetDescription {
  title: string
  detail: string
}

/** Between the parts of a detail line: " · ", or the Arabic comma in the Arabic UI (`navigation.sep`). */
export function listSeparator(): string {
  return i18n.t('navigation.sep')
}

/**
 * Describes a valid target:
 * - ayah: "Al-Baqarah 2:255" · "Juz 3 · Page 42";
 * - page: "Page 262" · "Al-Hijr · Juz 14";
 * - juz/hizb: "Juz 15" · "Al-Isra 17:1 · Page 282";
 * - surah: "Al-Kahf" · "Surah 18 · The Cave · 110 ayahs" (the Arabic UI: "الكهف" · "سورة ١٨ · مكية · ١١٠ آية").
 * Invalid targets keep a title in the same form and use their `disabledReason` as the detail.
 */
export function describeTarget(t: ParsedTarget, layout: MushafLayout): TargetDescription {
  const firstId = targetAyahId(t, layout)
  const page = firstId > 0 ? quran.pageOfAyah(layout, firstId) : 0
  const where = (id: number) =>
    [i18n.t('common.juzNumber', { juz: quran.juzOf(id) }), i18n.t('common.pageNumber', { page })].join(
      listSeparator(),
    )
  switch (t.type) {
    case 'ayah': {
      if (firstId === 0) {
        const name = quran.surahName(t.surah)
        const ref = i18n.ref(t.surah, t.ayah, t.toAyah)
        return { title: name === '' ? ref : `${name} ${ref}`, detail: '' }
      }
      const toId = t.toAyah === undefined ? undefined : quran.ayahId(t.surah, t.toAyah) || undefined
      return { title: quran.refLabel(firstId, 'long', toId), detail: where(firstId) }
    }
    case 'page': {
      const title = i18n.t('common.pageNumber', { page: t.page })
      const from = quran.pageRange(layout, t.page).from
      if (from <= 0) return { title, detail: '' }
      const surah = quran.ayahRef(from).surah
      return {
        title,
        detail: [quran.surahName(surah), i18n.t('common.juzNumber', { juz: quran.juzOf(from) })].join(
          listSeparator(),
        ),
      }
    }
    case 'juz':
    case 'hizb': {
      const title =
        t.type === 'juz'
          ? i18n.t('common.juzNumber', { juz: t.juz })
          : i18n.t('common.hizbNumber', { hizb: t.hizb })
      if (firstId === 0) return { title, detail: '' }
      return {
        title,
        detail: [quran.refLabel(firstId, 'long'), i18n.t('common.pageNumber', { page })].join(
          listSeparator(),
        ),
      }
    }
    case 'surah': {
      const s = quran.surah(t.surah)
      if (!s) return { title: i18n.t('navigation.surahNumber', { surah: t.surah }), detail: '' }
      const parts = [i18n.t('navigation.surahNumber', { surah: s.id })]
      if (i18n.locale === 'en') parts.push(s.nameEn)
      parts.push(
        s.revelationPlace === 'makkah' ? i18n.t('common.meccan') : i18n.t('common.medinan'),
        i18n.tp('common.ayahCount', s.ayahCount),
      )
      return { title: quran.surahName(s.id), detail: parts.join(listSeparator()) }
    }
  }
}

/**
 * Mock handlers: Mushaf pages and copy text (§5.17). Owner: WP8a.
 *
 * - `mushaf_get_pages`: the exported fixture page (`fixtures/pages/{style}/p{NNN}.json`, real core.db data), else a
 *   synthetic page with the real page, surah, juz and word numbering of the index (§4.6), marked for the "synthetic"
 *   badge (`SYNTHETIC_PAGE`). Validation mirrors `CoreDb::pages` (1..=8 pages, each in 1..=604, a known style); every
 *   call returns fresh objects in the requested order after a 2–8 ms delay, like IPC.
 * - `quran_copy_text`: the §5.5 format of `CoreDb::copy_text` + the command's translation part. Words come from the
 *   exported ayah windows, else from the fixture pages, else the synthetic text; the translation is appended only when
 *   its pack is installed in the mock's packs slice (as the real command, which copies the Arabic alone otherwise).
 */
import type { CopyOptions, MushafStyle, PageData, QuranIndex, ReferenceStyle } from '../../bindings'
import { SYNTHETIC_PAGE } from '$lib/mushaf/geometry'
import { fixtures } from '../fixtures'
import { assertRange, type Handlers, handle, jitter, MockError } from '../result'
import { state } from '../state'
import {
  arabicIndic,
  AYAH_COUNT,
  END_OF_AYAH,
  floorIndex,
  lastWordOf,
  layoutInfo,
  PAGE_COUNT,
  refOf,
  syntheticAyahs,
} from '../synthetic'

const STYLES: readonly MushafStyle[] = ['hafs', 'qcf_v2', 'qcf_v1', 'qcf_v4']
/** `mushaf_get_pages` takes 1..=8 pages per call (§5.13, `CoreDb::pages`). */
export const MAX_PAGES_PER_CALL = 8

/** Ornate parentheses around an ayah number in copied text: ` ﴿N﴾` (U+FD3F, Arabic-Indic digits, U+FD3E), §5.5. */
const AYAH_NUMBER_OPEN = '﴿'
const AYAH_NUMBER_CLOSE = '﴾'
const EN_DASH = '–'
const EM_DASH = '—'

// ---------------------------------------------------------------------------------------------------------------------
// Pages

async function page(style: MushafStyle, n: number): Promise<PageData> {
  const synthetic = !fixtures.hasPage(style, n)
  // Fixture JSON is parsed once and shared; every IPC call returns fresh objects.
  const data = structuredClone(await fixtures.page(style, n))
  if (synthetic) Object.defineProperty(data, SYNTHETIC_PAGE, { value: true, enumerable: false })
  return data
}

// ---------------------------------------------------------------------------------------------------------------------
// Copy text (§5.5)

/** One end of a copy range, for the reference. */
interface RefPoint {
  surah: number
  ayah: number
  nameSimple: string
  nameAr: string
}

function refPoint(index: QuranIndex, ayahId: number): RefPoint {
  const { surah, ayah } = refOf(index, ayahId)
  const info = index.surahs.find((s) => s.id === surah)
  return { surah, ayah, nameSimple: info?.nameSimple ?? '', nameAr: info?.nameAr ?? '' }
}

/** The reference line (§5.5), exactly as Rust's `reference()`: one ayah, a range in one surah, a range across surahs. */
export function reference(style: ReferenceStyle, from: RefPoint, to: RefPoint): string {
  const sameSurah = from.surah === to.surah
  const single = sameSurah && from.ayah === to.ayah
  switch (style) {
    case 'short':
      if (single) return `(${from.surah}:${from.ayah})`
      if (sameSurah) return `(${from.surah}:${from.ayah}${EN_DASH}${to.ayah})`
      return `(${from.surah}:${from.ayah}${EN_DASH}${to.surah}:${to.ayah})`
    case 'long':
      if (single) return `${EM_DASH} ${from.nameSimple} ${from.surah}:${from.ayah}`
      if (sameSurah) return `${EM_DASH} ${from.nameSimple} ${from.surah}:${from.ayah}${EN_DASH}${to.ayah}`
      return `${EM_DASH} ${from.nameSimple} ${from.surah}:${from.ayah} ${EN_DASH} ${to.nameSimple} ${to.surah}:${to.ayah}`
    case 'arabic': {
      const a = arabicIndic(from.ayah)
      const b = arabicIndic(to.ayah)
      if (single) return `[${from.nameAr}: ${a}]`
      if (sameSurah) return `[${from.nameAr}: ${a}${EN_DASH}${b}]`
      return `[${from.nameAr}: ${a} ${EN_DASH} ${to.nameAr}: ${b}]`
    }
  }
}

/** The trailing end marker (`۝` + Arabic-Indic digits) of an ayah's `text_hafs`, with the space before it. */
const TRAILING_END_MARKER = new RegExp(`\\s*${END_OF_AYAH}[\\u0660-\\u0669]+\\s*$`)

let ayahWindows: Promise<Map<number, string>> | null = null

/** `text_hafs` (end marker removed) of every exported ayah window (`fixtures/ayahs/{from}-{to}.json`). */
function windowTexts(): Promise<Map<number, string>> {
  ayahWindows ??= (async () => {
    const out = new Map<number, string>()
    for (const rel of fixtures.list()) {
      if (!/^ayahs\/\d+-\d+\.json$/.test(rel)) continue
      for (const row of (await fixtures.json<{ id: number; textHafs: string }[]>(rel)) ?? []) {
        out.set(row.id, row.textHafs.replace(TRAILING_END_MARKER, ''))
      }
    }
    return out
  })()
  return ayahWindows
}

/** The v2 pages holding an ayah's words (an ayah may continue on the next page). */
function pagesOfAyah(index: QuranIndex, ayahId: number): number[] {
  const firstWord = index.ayahFirstWord[ayahId - 1]
  if (firstWord === undefined) return []
  const starts = layoutInfo(index, 'v2').pageFirstWord
  const first = floorIndex(starts, firstWord) + 1
  const last = floorIndex(starts, lastWordOf(index, ayahId)) + 1
  const pages: number[] = []
  for (let p = Math.max(1, first); p <= Math.min(PAGE_COUNT, last); p++) pages.push(p)
  return pages
}

/** Where the copy text of an ayah comes from: an exported ayah window, the hafs fixture pages, or the generator. */
export async function arabicSource(
  index: QuranIndex,
  ayahId: number,
): Promise<'window' | 'pages' | 'synthetic'> {
  if ((await windowTexts()).has(ayahId)) return 'window'
  const pages = pagesOfAyah(index, ayahId)
  return pages.length > 0 && pages.every((p) => fixtures.hasPage('hafs', p)) ? 'pages' : 'synthetic'
}

/**
 * The non-end words of an ayah joined by U+0020 (whole words, so the space inside `وَأَنَابَ ۩` is kept once): from an
 * ayah window, else from the hafs fixture pages that hold the ayah, else the synthetic text.
 */
async function ayahArabic(index: QuranIndex, ayahId: number): Promise<string> {
  const source = await arabicSource(index, ayahId)
  if (source === 'window') return (await windowTexts()).get(ayahId) ?? ''
  if (source === 'pages') {
    const words: string[] = []
    for (const p of pagesOfAyah(index, ayahId)) {
      for (const line of (await fixtures.page('hafs', p)).lines) {
        for (const w of line.words) if (w.ayahId === ayahId && !w.isEnd) words.push(w.text)
      }
    }
    return words.join(' ')
  }
  const [row] = syntheticAyahs(index, 'v2', ayahId, ayahId)
  return row ? row.textHafs.replace(TRAILING_END_MARKER, '') : ''
}

/** Builds the Arabic part token by token, like Rust's `CopyText` (§5.5). */
function arabicPart(texts: readonly { arabic: string; ayah: number }[], ayahNumbers: boolean): string {
  const tokens: string[] = []
  for (const { arabic, ayah } of texts) {
    if (arabic) tokens.push(arabic)
    if (ayahNumbers) tokens.push(`${AYAH_NUMBER_OPEN}${arabicIndic(ayah)}${AYAH_NUMBER_CLOSE}`)
  }
  return tokens.join(' ')
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/**
 * Plain text of a translation's sanitised HTML, as WP1a's command derives it: footnote markers are dropped with their
 * content, block tags separate words, other tags are removed, entities decoded and whitespace collapsed.
 */
export function plainText(html: string): string {
  return html
    .replace(/<sup\b[^>]*\bclass\s*=\s*["'][^"']*\bfn\b[^"']*["'][^>]*>[\s\S]*?<\/sup>/gi, '')
    .replace(/<\/?(?:p|div|br|li|ul|ol|h[1-6]|blockquote|tr|td|th)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name: string) => {
      if (name[0] === '#') {
        const code =
          name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
        return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all
      }
      return ENTITIES[name.toLowerCase()] ?? all
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/** Whether the mock's packs slice has this translation installed (the real command copies the Arabic alone otherwise). */
function translationInstalled(packId: string): boolean {
  const pack = state.packs.value.list.find((p) => p.id === packId)
  return (
    pack?.kind === 'translation' &&
    (pack.state.type === 'installed' || pack.state.type === 'update_available')
  )
}

let translationWindows = new Map<string, Promise<Map<number, string>>>()

/** Plain text per ayah of a pack's exported windows (`fixtures/translations/{packId}/{from}-{to}.json`). */
function translationTexts(packId: string): Promise<Map<number, string>> {
  let texts = translationWindows.get(packId)
  if (!texts) {
    texts = (async () => {
      const out = new Map<number, string>()
      const prefix = `translations/${packId}/`
      for (const rel of fixtures.list()) {
        if (!rel.startsWith(prefix)) continue
        type Row = { ayahId: number; items: { packId: string; html: string }[] }
        for (const row of (await fixtures.json<Row[]>(rel)) ?? []) {
          const item = row.items.find((i) => i.packId === packId)
          if (item) out.set(row.ayahId, plainText(item.html))
        }
      }
      return out
    })()
    translationWindows.set(packId, texts)
  }
  return texts
}

/**
 * The translation part of a copy (§5.5): each ayah's plain text in order, joined by one space; blank ones skipped.
 * Ayahs outside the exported windows get a synthetic line, like the fixtures' own synthetic packs.
 */
async function translationPart(index: QuranIndex, packId: string, from: number, to: number): Promise<string> {
  const texts = await translationTexts(packId)
  const out: string[] = []
  for (let a = from; a <= to; a++) {
    const { surah, ayah } = refOf(index, a)
    const text = texts.get(a) ?? `Synthetic translation of ${surah}:${ayah}.`
    if (text.trim()) out.push(text.trim())
  }
  return out.join(' ')
}

/** `quran_copy_text`, validated like the real command before any data is read. */
export async function copyText(from: number, to: number, options: CopyOptions): Promise<string> {
  assertRange('fromAyahId', from, 1, AYAH_COUNT)
  assertRange('toAyahId', to, 1, AYAH_COUNT)
  if (from > to) throw new MockError('invalid_argument', `fromAyahId ${from} > toAyahId ${to}`)
  const index = await fixtures.index()
  const texts: { arabic: string; ayah: number }[] = []
  for (let a = from; a <= to; a++)
    texts.push({ arabic: await ayahArabic(index, a), ayah: refOf(index, a).ayah })
  let text = arabicPart(texts, options.ayahNumbers)
  if (options.includeReference) {
    text += `\n${reference(options.referenceStyle, refPoint(index, from), refPoint(index, to))}`
  }
  const packId = options.translationPackId?.trim()
  if (packId) {
    if (translationInstalled(packId)) {
      const plain = await translationPart(index, packId, from, to)
      if (plain) text += `\n\n${plain}`
    } else {
      console.warn(`[mock IPC] copy: translation ${packId} is not installed; copying the Arabic only`)
    }
  }
  return text
}

/** Drops the per-session caches (tests). */
export function resetMushafMock(): void {
  ayahWindows = null
  translationWindows = new Map()
}

// ---------------------------------------------------------------------------------------------------------------------

export const mushafHandlers: Handlers<'mushafGetPages' | 'quranCopyText'> = {
  mushafGetPages: handle(async (style: MushafStyle, pages: number[]) => {
    if (!STYLES.includes(style))
      throw new MockError('invalid_argument', `unknown mushaf style ${String(style)}`)
    if (!Array.isArray(pages) || pages.length < 1 || pages.length > MAX_PAGES_PER_CALL) {
      throw new MockError(
        'invalid_argument',
        `mushaf_get_pages takes 1..=${MAX_PAGES_PER_CALL} pages, got ${Array.isArray(pages) ? pages.length : 0}`,
      )
    }
    for (const p of pages) assertRange('page', p, 1, PAGE_COUNT)
    await jitter()
    return Promise.all(pages.map((p) => page(style, p)))
  }),
  quranCopyText: handle((fromAyahId: number, toAyahId: number, options: CopyOptions) =>
    copyText(fromAyahId, toAyahId, options),
  ),
}

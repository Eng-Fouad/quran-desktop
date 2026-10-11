/**
 * Copy text (§5.5, §8.14): the clipboard text of Mushaf words, in exactly the format of Rust's `quran_copy_text`
 * (`crates/quran-core/src/core_db/text.rs`). Both are golden-tested against the same file,
 * `crates/quran-core/tests/data/copy_vectors.json` (§12.3). Owner: WP8e.
 *
 * - The Arabic: the non-end words' QPC Hafs `text`, joined by U+0020. A word is copied whole, so the space inside a
 *   sajda word such as `وَأَنَابَ ۩` (38:24, 22:77) is kept once and never doubled. PUA glyph codes (`glyph`) never
 *   reach the clipboard (BRIEF).
 * - Each end marker becomes ` ﴿N﴾` (U+FD3F, Arabic-Indic digits, U+FD3E) with `ayahNumbers`; otherwise it is dropped.
 * - Then `\n{reference}` with `includeReference`:
 *
 *   | style    | one ayah             | range in one surah       | range across surahs                 |
 *   |----------|----------------------|--------------------------|-------------------------------------|
 *   | `short`  | `(2:255)`            | `(2:255–257)`            | `(1:7–2:2)`                         |
 *   | `long`   | `— Al-Baqarah 2:255` | `— Al-Baqarah 2:255–257` | `— Al-Fatihah 1:7 – Al-Baqarah 2:2` |
 *   | `arabic` | `[البقرة: ٢٥٥]`      | `[البقرة: ٢٥٥–٢٥٧]`      | `[الفاتحة: ٧ – البقرة: ٢]`          |
 *
 *   (`–` U+2013, `—` U+2014; `long` uses the surah's `nameSimple`, `arabic` its `nameAr`.)
 * - The translation part (`\n\n{plain text}`) needs the pack, so it is appended by the caller from `quran_copy_text`
 *   (`withTranslation`), as on the Rust side, where the command owns pack access.
 *
 * The reference spans the first and the last copied word's ayah, so a native selection that starts or ends inside an
 * ayah is referenced by the ayahs it touches.
 */
import type { CopySettings, PageData, PageWord, ReferenceStyle } from '$lib/ipc/bindings'

/** The surah names a copy reference needs (the `quran` store satisfies it: `quran.surah(n)`). */
export interface CopyRefs {
  surah(n: number): { nameSimple: string; nameAr: string } | undefined
}

/** One end of a copied range. */
export interface CopyPoint {
  surah: number
  ayah: number
}

/** Ornate parentheses around an ayah number in copied text, exactly as §5.5 spells ` ﴿N﴾`. */
const AYAH_NUMBER_OPEN = '\u{FD3F}'
const AYAH_NUMBER_CLOSE = '\u{FD3E}'
const EN_DASH = '–'
const EM_DASH = '—'

/** `n` in Arabic-Indic digits (U+0660–U+0669): Mushaf text always uses them (§11.2). */
export function arabicIndic(n: number): string {
  return String(n).replace(/[0-9]/g, (d) => String.fromCodePoint(0x0660 + Number(d)))
}

/** The reference line of a copy (§5.5; the table in the file comment). */
export function copyReference(style: ReferenceStyle, from: CopyPoint, to: CopyPoint, refs: CopyRefs): string {
  const sameSurah = from.surah === to.surah
  const single = sameSurah && from.ayah === to.ayah
  switch (style) {
    case 'short':
      if (single) return `(${from.surah}:${from.ayah})`
      if (sameSurah) return `(${from.surah}:${from.ayah}${EN_DASH}${to.ayah})`
      return `(${from.surah}:${from.ayah}${EN_DASH}${to.surah}:${to.ayah})`
    case 'long': {
      const a = refs.surah(from.surah)?.nameSimple ?? ''
      if (single) return `${EM_DASH} ${a} ${from.surah}:${from.ayah}`
      if (sameSurah) return `${EM_DASH} ${a} ${from.surah}:${from.ayah}${EN_DASH}${to.ayah}`
      const b = refs.surah(to.surah)?.nameSimple ?? ''
      return `${EM_DASH} ${a} ${from.surah}:${from.ayah} ${EN_DASH} ${b} ${to.surah}:${to.ayah}`
    }
    case 'arabic': {
      const a = refs.surah(from.surah)?.nameAr ?? ''
      const x = arabicIndic(from.ayah)
      const y = arabicIndic(to.ayah)
      if (single) return `[${a}: ${x}]`
      if (sameSurah) return `[${a}: ${x}${EN_DASH}${y}]`
      const b = refs.surah(to.surah)?.nameAr ?? ''
      return `[${a}: ${x} ${EN_DASH} ${b}: ${y}]`
    }
  }
}

/**
 * The Arabic part of a copy (§5.5): the words in the given order, end markers as ` ﴿N﴾` or dropped. Callers pass the
 * words in reading order (ascending word id).
 */
export function copyArabic(words: readonly PageWord[], ayahNumbers: boolean): string {
  const parts: string[] = []
  for (const w of words) {
    if (w.isEnd) {
      if (ayahNumbers) parts.push(`${AYAH_NUMBER_OPEN}${arabicIndic(w.ayah)}${AYAH_NUMBER_CLOSE}`)
    } else {
      parts.push(w.text)
    }
  }
  return parts.join(' ')
}

/**
 * Builds the clipboard text for Mushaf words (§5.5, §8.14): the Arabic, then the reference line when the copy settings
 * ask for one. Empty when there is nothing to copy. The translation part is not included (see the file comment).
 */
export function buildCopyText(words: readonly PageWord[], options: CopySettings, refs: CopyRefs): string {
  const first = words[0]
  const last = words.at(-1)
  if (first === undefined || last === undefined) return ''
  const arabic = copyArabic(words, options.ayahNumbers)
  if (!options.includeReference) return arabic
  const reference = copyReference(
    options.referenceStyle,
    { surah: first.surah, ayah: first.ayah },
    { surah: last.surah, ayah: last.ayah },
    refs,
  )
  return arabic === '' ? reference : `${arabic}\n${reference}`
}

/**
 * The page words a native DOM selection covers (§8.14), in reading order: every word span (`.w[data-w]`) of the
 * renditions (`.mp-glyphs`) under `root` that a selected range intersects, mapped to its `PageWord` through the page's
 * data (`section.mp[data-page]`). A word drawn by two stacked renditions (a cross-fade, §8.5) counts once.
 */
export function selectedPageWords(
  selection: Selection,
  root: ParentNode,
  pageData: (page: number) => PageData | undefined,
): PageWord[] {
  const seen = new Set<number>()
  const words: PageWord[] = []
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i)
    for (const layer of root.querySelectorAll<HTMLElement>('.mp-glyphs')) {
      if (!range.intersectsNode(layer)) continue
      const data = pageData(Number(layer.closest<HTMLElement>('section.mp')?.dataset.page))
      if (!data) continue
      const byId = new Map(data.lines.flatMap((l) => l.words.map((w) => [w.id, w] as const)))
      for (const span of layer.querySelectorAll<HTMLElement>('.w[data-w]')) {
        const id = Number(span.dataset.w)
        if (seen.has(id) || !range.intersectsNode(span)) continue
        const word = byId.get(id)
        if (!word) continue
        seen.add(id)
        words.push(word)
      }
    }
  }
  return words.sort((a, b) => a.id - b.id)
}

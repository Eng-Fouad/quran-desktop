/**
 * `mushaf` messages, English. The same keys live in `../ar/mushaf.ts`. Numbers passed to `t()` are formatted with the
 * UI digits; surah names come from core.db (`quran.surahName`), never from here.
 */
export const mushaf = {
  page: {
    /** The page `<section>`'s accessible name: "Page 262 · Al-Hijr · Juz 14". */
    label: 'Page {page} · {surah} · Juz {juz}',
    /** `aria-roledescription` of the page `<section>`. */
    roleDescription: 'page',
  },
  synthetic: {
    /** Browser mock only: a page outside the exported fixtures. */
    badge: 'Synthetic page',
    hint: 'This page is not in the exported fixtures. The browser mock shows placeholder words with the real page, surah and juz numbering.',
  },
  /** The one-time toast after the COLR probe failed and the style fell back to QCF V2 (shown by the fonts store). */
  v4Unsupported:
    "This system can't draw the colour-coded Tajweed font, so the Mushaf switched to the QCF V2 style.",
} as const

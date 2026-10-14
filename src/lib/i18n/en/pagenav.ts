/**
 * `pagenav` messages, English. The same keys live in `../ar/pagenav.ts`.
 * Page navigation affordances: the flip HUD, the page rail, the first-run hint and the juz/hizb arrival chip. The turn
 * zones use the `shortcuts.nav.nextPage` / `prevPage` labels.
 */
export const pagenav = {
  /** The page label of the flip HUD and the rail's live label: "Al-Hijr · Page 262 · Juz 14". */
  label: {
    page: 'Page {page}',
    /** A two-page spread; `{range}` is "261–262", bidi-isolated. */
    pages: 'Pages {range}',
    juz: 'Juz {juz}',
  },
  rail: {
    /** The slider's accessible name. */
    name: 'Page rail',
    /** `aria-valuetext`. */
    valueText: 'Page {page}, {surah}, Juz {juz}',
  },
  hint: {
    /** The first-run hint; `{keys}` is replaced by the ← → keycaps. */
    pageTurn: 'Scroll, swipe or press {keys} to turn pages',
    /** Its plain-text form for the accessible name. */
    pageTurnText: 'Scroll, swipe or press the left and right arrow keys to turn pages',
    dismiss: 'Got it',
  },
  division: {
    /** The arrival chip and its polite announcement. `{n}` is the number, `{ordinal}` the Arabic ordinal. */
    juz: 'Beginning of Juz {n}',
    hizb: 'Beginning of Hizb {n}',
  },
} as const

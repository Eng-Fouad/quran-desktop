/**
 * `pagenav` messages, English (§11.1). Owner: WP8f. The same keys live in `../ar/pagenav.ts`.
 * Page navigation affordances (§8.11, §8.12): the flip HUD, the page rail, the first-run hint and the juz/hizb arrival
 * chip. The turn zones use the frozen `shortcuts.nav.nextPage` / `prevPage` labels.
 */
export const pagenav = {
  /** The page label of the flip HUD and the rail's live label: "Al-Hijr · Page 262 · Juz 14" (§8.11). */
  label: {
    page: 'Page {page}',
    /** A two-page spread; `{range}` is "261–262", bidi-isolated. */
    pages: 'Pages {range}',
    juz: 'Juz {juz}',
  },
  rail: {
    /** The slider's accessible name (§8.11). */
    name: 'Page rail',
    /** `aria-valuetext` (§8.11). */
    valueText: 'Page {page}, {surah}, Juz {juz}',
  },
  hint: {
    /** The first-run hint (§8.11); `{keys}` is replaced by the ← → keycaps. */
    pageTurn: 'Scroll, swipe or press {keys} to turn pages',
    /** Its plain-text form for the accessible name. */
    pageTurnText: 'Scroll, swipe or press the left and right arrow keys to turn pages',
    dismiss: 'Got it',
  },
  division: {
    /** The arrival chip and its polite announcement (§8.12). `{n}` is the number, `{ordinal}` the Arabic ordinal. */
    juz: 'Beginning of Juz {n}',
    hizb: 'Beginning of Hizb {n}',
  },
} as const

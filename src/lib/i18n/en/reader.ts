/**
 * `reader` messages, English (§11.1). Owner: WP8e. The same keys live in `../ar/reader.ts`.
 * The Mushaf view: page and jump announcements (§8.15), page mode and reading mode (§10.1), zoom (§8.13), the
 * "Return to recitation" chip (§8.12) and the page error state.
 */
export const reader = {
  announce: {
    /** Polite announcement on a page change (§8.15). */
    page: 'Page {page}',
    spread: 'Pages {first} and {last}',
    /** After a jump that moves focus (§7.4): "Al-Baqarah 2:255, page 42". */
    ayah: '{surah} {ref}, page {page}',
  },
  mode: {
    mushaf: 'Mushaf mode',
    translation: 'Translation mode',
  },
  pageMode: {
    changed: 'Page mode: {mode}',
    auto: 'automatic',
    single: 'single page',
    spread: 'two-page spread',
  },
  zoom: {
    /** The zoom indicator (§8.13). */
    level: '{pct}%',
    /** The indicator at 100 %: the page fits the canvas. */
    fit: 'Fit to window',
    announce: 'Zoom {pct}%',
  },
  follow: {
    /** The chip in the canvas overlay slot (§8.12). */
    back: 'Return to recitation',
    /** Its description: where the recitation is. */
    where: 'The recitation is on page {page}',
  },
  error: {
    page: "This page couldn't be loaded",
  },
} as const

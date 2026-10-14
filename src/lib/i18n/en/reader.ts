/**
 * `reader` messages, English. The same keys live in `../ar/reader.ts`.
 * The Mushaf view: page and jump announcements, page mode and reading mode, the zoom control, the "Aa" display button
 * and popover of both reading modes, the "Return to recitation" chip and the page error state.
 */
export const reader = {
  announce: {
    /** Polite announcement on a page change. */
    page: 'Page {page}',
    spread: 'Pages {first} and {last}',
    /** After a jump that moves focus: "Al-Baqarah 2:255, page 42". */
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
    /** The zoom control's toolbar: + / level / − in the canvas's top inline-end corner. */
    control: 'Zoom',
    /** The zoom control's level. */
    level: '{pct}%',
    /** The level button's tooltip: a click goes back to the fit (100 %). */
    fit: 'Fit to window',
    /** The level button's accessible name (it contains the visible level). */
    reset: 'Zoom {pct}%, fit to window',
    announce: 'Zoom {pct}%',
  },
  display: {
    /** The "Aa" button on the reading canvas, and its popover's title (owner request 2026-10-11). */
    button: 'Display',
    /** The popover's text size: translation mode, or the study pane's Translation tab beside the Mushaf. */
    textSize: 'Translation text size',
    /** The popover's footer: the Settings dialog, on the reading mode's own section. */
    allSettings: 'All settings',
  },
  follow: {
    /** The chip in the canvas overlay slot. */
    back: 'Return to recitation',
    /** Its description: where the recitation is. */
    where: 'The recitation is on page {page}',
  },
  error: {
    page: "This page couldn't be loaded",
  },
} as const

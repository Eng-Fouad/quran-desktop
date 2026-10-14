/**
 * `fonts` messages, English. The same keys live in `../ar/fonts.ts`.
 * The page's font-status dot: the page shows the bundled Hafs font because its QCF font is not available.
 */
export const fonts = {
  dot: {
    /** `Unavailable`: offline or network not allowed, and the page font is not on disk. */
    offline: 'Offline — showing the Hafs font',
    /** `Failed`: download or integrity failure; the tooltip offers Retry. */
    failed: "Couldn't download this page's font",
    /** The dot's accessible name while it offers a retry. */
    failedAction: "Couldn't download this page's font. Retry",
    /** After Retry, until the font is ready or fails again. */
    retrying: "Downloading this page's font…",
    /** The tooltip's action hint (the dot itself retries on click or Enter). */
    retry: 'Retry',
  },
} as const

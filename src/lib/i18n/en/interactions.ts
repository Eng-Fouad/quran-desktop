/**
 * `interactions` messages, English (§11.1). Owner: WP8d. The same keys live in `../ar/interactions.ts`.
 * The ayah action bar (§8.17, D26), the word-by-word tooltip and the Mushaf's screen-reader text (§8.15).
 */
export const interactions = {
  actionBar: {
    /** The toolbar's accessible name: the selection it acts on. */
    label: 'Ayah actions · {ref}',
    play: 'Play from here',
    /** Tooltip hint for the mouse gesture that does the same from the page. */
    playHint: '{mod}+Click',
    repeat: 'Repeat',
    repeatAyah: 'This ayah ×{n}',
    repeatAyahForever: 'This ayah ∞',
    repeatSelection: 'Selection ×{n}',
    repeatSelectionForever: 'Selection ∞',
    bookmark: 'Bookmark',
    removeBookmark: 'Remove bookmark',
    highlight: 'Highlight',
    highlightColor: 'Highlight {color}',
    removeHighlight: 'Remove highlight',
    /** The swatch strip's accessible name. */
    highlightColors: 'Highlight colours',
    addNote: 'Add note',
    editNote: 'Edit note',
    copy: 'Copy',
    copied: 'Copied {ref}',
    copyFailed: "Couldn't copy {ref}",
    study: 'Translation and tafsir',
    more: 'More actions',
  },
  colors: {
    yellow: 'Yellow',
    green: 'Green',
    blue: 'Blue',
    red: 'Red',
    purple: 'Purple',
  },
  wbw: {
    /** The word has no word-by-word entry (pack missing, offline, or not in the pack). */
    unavailable: 'No word-by-word translation for this word',
  },
  a11y: {
    /** The visually hidden ayah list of a page. */
    list: 'Text of page {page}',
    /** After the Arabic of each item: where it is. */
    ref: '{surah}, ayah {ayah}',
    continued: 'continued from the previous page',
    continues: 'continues on the next page',
    juz: 'start of Juz {n}',
    hizb: 'start of Hizb {n}',
    quarter: 'quarter of Hizb {n}',
    half: 'half of Hizb {n}',
    threeQuarters: 'three quarters of Hizb {n}',
    sajda: 'place of prostration',
    sajdaObligatory: 'obligatory prostration',
  },
} as const

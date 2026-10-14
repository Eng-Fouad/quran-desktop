/**
 * `content` messages, English: translation mode (verse rows, surah cards, footnotes, its empty states and notices) and
 * the copy action. The same keys live in `../ar/content.ts`. References only this domain plus the `common`,
 * `shortcuts` and `errors` keys.
 */
export const content = {
  /**
   * Between the parts of a meta line ("Meccan · 7 ayahs · p 1"). The Arabic UI uses the Arabic comma: a middle dot
   * next to Arabic-Indic digits reads as the digit zero (٠).
   */
  sep: ' · ',
  view: {
    /** Accessible name of the verse feed. */
    label: 'Verses with translation',
    loading: 'Loading verses…',
  },
  surah: {
    /** The surah card's heading for screen readers: "Surah 2, Al-Baqarah, The Cow". */
    heading: 'Surah {number}, {name}, {meaning}',
    /** Compact page reference: "p 2". */
    pageShort: 'p {page}',
    /** Accessible name of the basmala line. */
    basmala: 'Basmala',
  },
  verse: {
    bookmarked: 'Bookmarked',
    noted: 'Has a note',
    /** "Highlighted yellow". */
    highlighted: 'Highlighted {color}',
    playing: 'Now reciting',
    loadError: "This verse couldn't be loaded",
    translationError: "The translation couldn't be loaded",
  },
  actions: {
    /** Accessible name of a verse's toolbar: "Actions for 2:255". */
    label: 'Actions for {ref}',
    play: 'Play from here',
    bookmark: 'Bookmark',
    unbookmark: 'Remove bookmark',
    highlight: 'Highlight',
    note: 'Add note',
    editNote: 'Edit note',
    copy: 'Copy',
    study: 'Tafsir and word by word',
    more: 'More actions',
    /** Toast after copying: "Copied 2:255". */
    copied: 'Copied {ref}',
  },
  highlight: {
    label: 'Highlight colour',
    yellow: 'Yellow',
    green: 'Green',
    blue: 'Blue',
    red: 'Red',
    purple: 'Purple',
    remove: 'Remove highlight',
  },
  footnote: {
    /** Accessible name of a footnote marker: "Footnote 1". */
    marker: 'Footnote {marker}',
    /** Popover heading: "Footnote 1 · Saheeh International". */
    title: 'Footnote {marker}',
    /** A note on the whole verse (an empty upstream marker), shown without a number. */
    note: 'Translator’s note',
    /** Heading of the footnotes listed under a translation (`footnotesInline`). */
    notes: 'Notes',
    /** A marker whose note the translation does not include (kept as published). */
    missing: 'This note is not included in the translation.',
  },
  empty: {
    title: 'Add a translation',
    body: 'Read the meaning of each verse beside the Arabic text.',
    offline: 'Translations download when you’re online',
    listLabel: 'Translations to add',
    /** Pack row meta: "English · 507 KB". */
    meta: '{language} · {size}',
    use: 'Show',
    installed: 'Installed',
    /** "Downloading… 45%". */
    downloading: 'Downloading… {percent}',
    failed: 'Download failed',
    more: 'More translations',
    mushaf: 'Back to the Mushaf',
  },
  notice: {
    /** A selected translation that is not installed: "Hilali and Khan isn't downloaded". */
    missing: '{name} isn’t downloaded',
    downloading: 'Downloading {name} · {percent}',
    /** A selected translation the backend could not open. */
    broken: '{name} couldn’t be opened',
    hide: 'Hide',
  },
  follow: {
    back: 'Return to recitation',
  },
} as const

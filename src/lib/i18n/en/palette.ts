/**
 * `palette` messages, English: the command palette. The same keys live in `../ar/palette.ts`. References only this
 * domain plus the `common`, `shortcuts` and `errors` keys.
 */
export const palette = {
  /** The dialog's accessible name. */
  title: 'Command palette',
  description: 'Go to a reference or a surah, run a command, change a setting or pick a reciter.',
  /** `{ref}` is an example reference in UI digits ("2:255"); `{surah}` an Arabic surah name. */
  placeholder: 'Go to {ref}, a surah like {surah}, or a command…',
  placeholderScope: {
    commands: 'Search commands and settings…',
    surahs: 'Surah name or number…',
    reciters: 'Search reciters…',
  },
  inputLabel: 'Search the palette',
  listLabel: 'Results',
  groups: {
    goto: 'Go to',
    surahs: 'Surahs',
    commands: 'Commands',
    settings: 'Settings',
    reciters: 'Reciters',
    recent: 'Recent',
    search: 'Search',
  },
  /** The scope chip at the end of the input and its menu. */
  scope: {
    menuLabel: 'Search in',
    /** Accessible name of the chip: "Search in: Everything". */
    chipLabel: 'Search in: {scope}',
    all: 'Everything',
    commands: 'Commands',
    surahs: 'Surahs',
    reciters: 'Reciters',
  },
  /** The empty state: "No matches. Try 2:255, p 262, j 15, الكهف" (the examples are buttons). */
  empty: {
    title: 'No matches.',
    try: 'Try',
  },
  /** Compact references for the examples, as typed: "p 262", "j 15". */
  pageShort: 'p {page}',
  juzShort: 'j {juz}',
  /** Key hints in the footer: the keycap, then these words. */
  hints: {
    choose: 'to choose',
    open: 'to open',
    close: 'to close',
    scopes: 'Prefix',
    commands: 'commands',
    surahs: 'surahs',
    reciters: 'reciters',
  },
  /** The polite status line for screen readers. */
  status: { one: '{count} result', other: '{count} results' },
  statusNone: 'No matches',
  recent: {
    continue: 'Continue from reading bookmark',
    read: 'Read',
    listen: 'Listened',
    memorize: 'Memorized',
  },
  search: {
    /** `{query}` is what was typed. */
    item: 'Search the Quran for “{query}”',
  },
  reciters: {
    current: 'Current',
    downloaded: { one: '{count} surah downloaded', other: '{count} surahs downloaded' },
    /** The reciter has word timings: the page highlights each word as it is recited. */
    wordTiming: 'Word highlighting',
    /** Toast after choosing one. */
    chosen: 'Reciter: {name}',
  },
  settings: {
    current: 'Current',
    /** "Theme: Night" (`{setting}` is the field's label, `{value}` the option). */
    choice: '{setting}: {value}',
    /** Toast after a toggle: "Page frame: Off". */
    toggled: '{setting}: {state}',
    /** Option labels of the settings the palette offers as choices. */
    values: {
      theme: {
        system: 'Match system',
        paper: 'Paper',
        sepia: 'Sepia',
        night: 'Night',
        black: 'Black',
        high_contrast: 'High contrast',
      },
      accent: {
        teal: 'Teal',
        emerald: 'Emerald',
        blue: 'Blue',
        indigo: 'Indigo',
        rose: 'Rose',
        amber: 'Amber',
      },
      readingMode: {
        mushaf: 'Mushaf',
        translation: 'Translation',
      },
      pageMode: {
        auto: 'Automatic',
        single: 'Single page',
        spread: 'Two-page spread',
      },
      mushafStyle: {
        hafs: 'Hafs (built in)',
        qcf_v2: 'QCF V2 (1421H print)',
        qcf_v1: 'QCF V1 (1405H print)',
        qcf_v4: 'Tajweed (QCF V4)',
      },
      /** Language names are endonyms in both UI languages. */
      uiLanguage: {
        en: 'English',
        ar: 'العربية',
      },
    },
  },
  /** Commands that have no shortcut. */
  commands: {
    about: 'About Quran',
  },
} as const

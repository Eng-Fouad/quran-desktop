/**
 * `navigation` messages, English: the Index panel, Go to, the reference parser's reasons. The same keys live in
 * `../ar/navigation.ts`. References only this domain plus the `common`, `shortcuts` and `errors` keys.
 */
export const navigation = {
  /**
   * Between the parts of a list line ("Meccan · 286 · p 2"). The Arabic UI uses the Arabic comma: a middle dot next to
   * Arabic-Indic digits reads as the digit zero (٠).
   */
  sep: ' · ',
  /** Between the parts of an accessible name ("Page 262, Al-Hijr, Reading bookmark"). */
  labelSep: ', ',
  /** "Surah 18" (a surah by number). */
  surahNumber: 'Surah {surah}',
  /** Compact page reference in lists: "p 262". */
  pageShort: 'p {page}',
  /** Compact page range: "p 1–21" (`{range}` is bidi-isolated). */
  pageRangeShort: 'p {range}',
  /** Compact juz and hizb references, as typed into Go to: "j 15", "h 30". */
  juzShort: 'j {juz}',
  hizbShort: 'h {hizb}',
  index: {
    tabsLabel: 'Browse the Quran by',
    tabs: {
      surahs: 'Surahs',
      juz: 'Juz',
      hizb: 'Hizb',
      pages: 'Pages',
    },
  },
  surahs: {
    /** `{ref}` is an example reference in UI digits ("2:255"). */
    filterPlaceholder: 'Name, number or {ref}',
    filterLabel: 'Filter surahs',
    listLabel: 'Surahs',
    /** Accessible name of a surah row: "18. Al-Kahf, The Cave, Meccan, 110 ayahs, page 293". */
    rowLabel: '{number}. {name}, {meaning}, {place}, {ayahs}, page {page}',
    downloaded: 'Recitation downloaded',
    cached: 'Recitation cached',
    empty: 'No surah matches “{query}”',
    emptyBody: 'Try another spelling, the Arabic name, or a number such as {number} or {ref}',
    jumpTo: 'Go to {target}',
  },
  menu: {
    label: 'Surah {name}',
    play: 'Play surah',
    info: 'Surah info',
    download: 'Download recitation for this surah',
    memorize: 'Memorize',
    hide: 'Hide this surah',
    selfTest: 'Self-test this surah',
    markMemorized: 'Mark memorized',
    markLearning: 'Mark learning',
  },
  info: {
    revelation: 'Revelation',
    order: '{place}, revelation order {order}',
    ayahs: 'Ayahs',
    pages: 'Pages',
    juz: 'Juz',
  },
  juz: {
    listLabel: 'Juz',
    rowLabel: 'Juz {juz}, starts at {start}, page {page}',
  },
  hizb: {
    rowLabel: 'Hizb {hizb}, starts at {start}, page {page}',
    quarters: 'Quarters of hizb {hizb}',
    quarter1: 'A quarter of hizb {hizb}, {start}, page {page}',
    quarter2: 'Half of hizb {hizb}, {start}, page {page}',
    quarter3: 'Three quarters of hizb {hizb}, {start}, page {page}',
  },
  pages: {
    findPlaceholder: 'Go to page…',
    findLabel: 'Page number',
    /** Accessible name of a page cell: "Page 262, Al-Hijr". */
    cellLabel: 'Page {page}, {surah}',
    surahStarts: '{surah} begins',
    bookmark: 'Reading bookmark',
  },
  continue: {
    /** The card's heading: one line in the narrowest sidebar (240 px). */
    title: 'Continue reading',
    /** Its accessible name: "Continue from reading bookmark, Al-Kahf 18:45, p 297, 3 days ago". */
    label: 'Continue from reading bookmark, {detail}',
    dismiss: 'Hide until the bookmark moves',
  },
  goto: {
    title: 'Go to',
    description: 'Type an ayah such as {ref}, a page, a juz, a hizb or a surah name.',
    /** Examples in UI digits; `{surah}` is a surah name from core.db. */
    placeholder: '{ref}, p {page}, j {juz}, h {hizb}, {surah}',
    results: 'Destinations',
    examples: 'Try',
    noMatch: 'Nothing matches “{query}”.',
    noMatchHint: 'Try {ref}, p {page}, j {juz} or a surah name.',
    hintChoose: 'Choose',
    hintGo: 'Go',
  },
  reason: {
    surah: 'There are {count} surahs',
    ayah: { one: '{surah} has {count} ayah', other: '{surah} has {count} ayahs' },
    range: 'The range ends before it starts',
    page: 'The Mushaf has {count} pages',
    juz: 'There are {count} juz',
    hizb: 'There are {count} hizb',
  },
} as const

/**
 * `search` messages, English (§11.1): the Search panel, its states (§9.8), hits and announcements. Owner: WP10b. The
 * same keys live in `../ar/search.ts`. References only this domain plus the frozen `common`, `shortcuts` and `errors`.
 */
export const search = {
  field: {
    /** Placeholder and accessible name of the field, per scope. */
    quran: 'Search the Quran',
    translation: 'Search the translation',
    notes: 'Search your notes',
  },
  scope: {
    label: 'Search in',
    quran: 'Quran',
    translation: 'Translation',
    notes: 'Notes',
    /** The translation picker under the scope. */
    pack: 'Translation to search',
  },
  mode: {
    label: 'Matching',
    smart: 'Smart',
    exact: 'Exact letters',
    substring: 'Contains',
    /** Tooltips of the mode button. */
    smartHint: 'Ignores harakat and spelling variants, completes the last word and corrects small typos',
    exactHint: 'Whole words with hamza and ta marbuta as written',
    substringHint: 'The letters anywhere, even across words',
  },
  filter: {
    label: 'Limit the search',
    everywhere: 'All surahs',
    surahs: 'Surahs',
    juz: 'Juz',
    /** "Juz 3" in the picker and on the button. */
    juzItem: 'Juz {juz}',
    /** "Al-Baqarah · Juz 3" when both filters apply (`{sep}` is the list separator). */
    both: '{surah}{sep}{juz}',
    none: 'No surah or juz matches',
    clear: 'Search all surahs',
    /** The filter button of a surah group. */
    onlyThis: 'Only in {name}',
  },
  summary: {
    results: { one: '{count} result', other: '{count} results' },
    inSurahs: { one: 'in {count} surah', other: 'in {count} surahs' },
    searching: 'Searching…',
  },
  typo: {
    /** `{terms}`: the corrected words the results are for. */
    showing: 'Showing results for {terms}',
    noExact: 'No exact match for {query}',
  },
  truncated: {
    /** `{shown}` and `{total}` are formatted numbers. */
    showing: 'Showing {shown} of {total}',
    filter: 'Filter by surah',
  },
  empty: {
    title: 'Search the Quran',
    body: 'Arabic with or without harakat, a word of a translation, or a reference such as {ref}.',
    recent: 'Recent searches',
    clearRecent: 'Clear',
    examples: 'Try',
    /** The caption of the reference example. */
    reference: 'Reference',
    /** Accessible name of a recent search: "Search again for الرحمن in Quran". */
    again: 'Search again for {query} in {scope}',
  },
  none: {
    title: 'No matches for “{query}”',
    /** Per scope: what to try next. */
    bodyQuran: 'Try Smart mode, another spelling, or search the translations.',
    bodyTranslation: 'Try another word or Smart mode, or search the Quran text.',
    bodyNotes: 'Try another word or Smart mode, or search the Quran text.',
    /** The same advice while Smart mode is already on (it is not suggested again). */
    bodyQuranSmart: 'Try another spelling, or search the translations.',
    bodyTranslationSmart: 'Try another word, or search the Quran text.',
    bodyNotesSmart: 'Try another word, or search the Quran text.',
    trySmart: 'Use Smart mode',
    translations: 'Search translations',
    quran: 'Search the Quran text',
    everywhere: 'Search all surahs',
  },
  noPack: {
    title: 'Search a translation',
    body: 'Install a translation to search its text.',
    offline: 'Translations download when you’re online.',
    listLabel: 'Translations to install',
    downloading: 'Downloading',
    more: 'More translations',
  },
  failed: {
    title: 'The search failed',
  },
  jump: {
    /** "Go to Al-Baqarah 2:255". */
    goTo: 'Go to {target}',
  },
  complete: {
    label: 'Complete the word',
    /** Accessible name of a completion chip: "الرحمن, 45 ayahs". */
    chip: '{term}, {ayahs}',
  },
  results: {
    label: 'Search results',
  },
  group: {
    /** Accessible name of a group heading: "Al-Fatihah, 2 results". */
    label: '{name}, {results}',
  },
  hit: {
    /** Compact page in the hit's meta line: "p 42". */
    page: 'p {page}',
    /** Accessible name of a hit: "Al-Baqarah 2:255, page 42". */
    label: '{ref}, page {page}',
    note: 'Note',
    /** Matches of the ayah outside the shown words. */
    more: { one: '+{count} more in this ayah', other: '+{count} more in this ayah' },
    moreShort: '+{count}',
  },
  menu: {
    /** Accessible name of a hit's context menu. */
    label: 'Result {ref}',
    openPane: 'Open in side pane',
    bookmark: 'Bookmark',
    unbookmark: 'Remove bookmark',
  },
  announce: {
    /** F3 / Enter stepping through hits: "Result 3 of 45: Al-Baqarah 2:255". */
    hit: 'Result {n} of {total}: {ref}',
  },
} as const

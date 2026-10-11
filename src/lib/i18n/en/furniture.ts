/**
 * `furniture` messages, English (§11.1). Owner: WP8c. The same keys live in `../ar/furniture.ts`.
 *
 * Only the UI around the page furniture is localised here (tooltips, the reading-ribbon popover, the surah info
 * popover). The furniture drawn on the page itself (running heads, margin labels, the page number) is always Arabic
 * with Arabic-Indic digits (§0.2), and surah names come from core.db (`quran`), never from here. Numbers passed to
 * `t()` are formatted with the UI digits; `{ref}` values are bidi-isolated references from `i18n.ref`.
 */
export const furniture = {
  marker: {
    /** Margin marker tooltips (§8.9): the Arabic label is shown above this line. */
    juz: 'Juz {juz} begins · {ref}',
    hizb: 'Hizb {hizb} begins · {ref}',
    quarter1: 'First quarter of hizb {hizb} · {ref}',
    quarter2: 'Half of hizb {hizb} · {ref}',
    quarter3: 'Three quarters of hizb {hizb} · {ref}',
    sajda: 'Place of prostration · {ref}',
    sajdaObligatory: 'Place of prostration, obligatory · {ref}',
    /** A hint under the tooltip text: the marker selects its ayah. */
    select: 'Click to select the ayah',
  },
  marks: {
    /** The ayah-bookmark mark's tooltip. */
    bookmark: 'Bookmarked · {ref}',
    /** The note mark's tooltip heading; the note's first 80 characters follow. */
    note: 'Note · {ref}',
    /** A note with no text yet. */
    noteEmpty: 'Empty note',
    /** The note mark's hint: it opens the side pane's Notes tab. */
    noteOpen: 'Click to open the note',
    /** The page dog-ear's tooltip. */
    pageBookmark: 'Page {page} is bookmarked',
    /** The dog-ear's hint: it opens the Bookmarks panel. */
    pageBookmarkOpen: 'Click to show your bookmarks',
  },
  ribbon: {
    /** The reading ribbon's popover (§8.9): "Reading bookmark · 2:255 · moved 3 days ago · Move here". */
    title: 'Reading bookmark',
    /** `{time}` is a relative time ("3 days ago"). */
    moved: 'Moved {time}',
    moveHere: 'Move here',
    /** The ribbon's own tooltip, before it is clicked. */
    tooltip: 'Reading bookmark · {ref}',
    /** The popover's hint when the reading position already is the bookmark. */
    alreadyHere: 'This is where you are reading',
    /** "Move here" moves the ribbon to this ayah (the selection or the reading cursor). */
    moveTarget: 'Moves it to {ref}',
  },
  surahInfo: {
    /** The surah info popover's accessible name (§8.8). */
    label: 'About surah {name}',
    meccan: 'Meccan',
    medinan: 'Medinan',
    /** The surah's place in the order of revelation. */
    revelationOrder: 'Revelation order {order}',
    revealed: 'Revealed',
    ayahs: 'Ayahs',
    pages: 'Pages',
    juz: 'Juz',
    /** A range of pages or juz: "2–49". */
    range: '{from}–{to}',
    play: 'Play surah',
    download: 'Download recitation',
    downloaded: 'Recitation downloaded',
    downloading: 'Downloading…',
    /** Shown under the buttons when downloads are off or there is no connection. */
    offline: 'Downloads are available when you are online',
    /** The toast after "Download recitation". */
    downloadStarted: 'Downloading {surah} · {reciter}',
    /** Who "Play surah" and "Download recitation" use. */
    reciter: 'Recitation by {reciter}',
  },
} as const

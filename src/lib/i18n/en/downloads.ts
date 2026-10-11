/**
 * `downloads` messages, English (§11.1): the Downloads manager (§9.7), the packs store's job toasts and the surah grid.
 * Owner: WP12a. The same keys live in `../ar/downloads.ts`. References only this domain plus the frozen `common`,
 * `shortcuts` and `errors` keys.
 */
export const downloads = {
  title: 'Downloads',
  lede: 'Mushaf fonts, translations, tafsir and recitations kept on this computer.',
  /**
   * Between the parts of a row's subtitle ("English · 507 kB"). The Arabic UI uses the Arabic comma: a middle dot next
   * to Arabic-Indic digits reads as the digit zero (٠).
   */
  sep: ' · ',
  header: {
    openFolder: 'Open folder',
    clearStream: 'Clear streaming cache',
    clearStreamHint: 'Removes recitations cached while listening. Downloaded surahs stay.',
    clearStreamEmpty: 'Nothing is cached from streaming',
    actions: 'Storage actions',
  },
  usage: {
    title: 'Storage',
    /** `{size}` is the total ("1.9 GB"). */
    used: '{size} used',
    measuring: 'Measuring…',
    empty: 'Nothing downloaded yet',
    /** `{path}` is the data folder. */
    where: 'Stored in {path}',
    label: 'Disk use by kind',
    /** Accessible name of a bar segment and a legend entry: "Translations, 1.2 MB". */
    item: '{label}, {size}',
    segments: {
      mushaf: 'Mushaf fonts',
      decor: 'Ornaments',
      translation: 'Translations',
      tafsir: 'Tafsir',
      audio: 'Recitations',
      stream: 'Streaming cache',
      content: 'Online content',
      library: 'Your library',
    },
    /** Tooltips of the legend entries that are not self-explanatory. */
    hints: {
      stream: 'Recitations cached while you listened. Clearing them keeps your downloads.',
      content: 'Word by word, tafsir chapters and recitation timings fetched as you read.',
      library: 'Bookmarks, highlights, notes, history and settings.',
    },
  },
  banner: {
    offlineTitle: 'You’re offline',
    offlineBody: 'Downloads continue when you’re back online.',
    networkOffTitle: 'Work offline is on',
    networkOffBody: 'Nothing downloads until you allow network use.',
    allowNetwork: 'Allow network use',
    updates: { one: '{count} update available', other: '{count} updates available' },
    updatesBody: 'Newer versions of installed translations and tafsir.',
    updateAll: 'Update all',
  },
  filters: {
    label: 'Kinds of packs',
    kinds: {
      all: 'All',
      mushaf: 'Mushaf',
      recitation: 'Recitations',
      translation: 'Translations',
      tafsir: 'Tafsir',
      wbw: 'Word by word',
    },
    language: 'Language',
    allLanguages: 'All languages',
    search: 'Search packs',
    searchPlaceholder: 'Name or language',
    emptyQuery: 'No pack matches “{query}”',
    empty: 'No pack matches these filters',
    emptyBody: 'Try another name, or show every kind and language.',
    clear: 'Clear filters',
  },
  sections: {
    mushaf: 'Mushaf and fonts',
    mushafHint: 'Page fonts download as you read. Download a whole Mushaf to read it offline.',
    recitation: 'Recitations',
    recitationHint: 'Recitations stream as you listen and are cached. Download surahs to listen offline.',
    translation: 'Translations',
    translationHint: 'Translations of the meanings, each a small download.',
    tafsir: 'Tafsir',
    tafsirHint: 'Commentary in the side pane. Online tafsir downloads by surah as you read.',
    wbw: 'Word by word',
    wbwHint: 'Word meanings and transliteration, downloaded by surah as you read.',
  },
  kinds: {
    mushaf_fonts: 'Mushaf fonts',
    decor: 'Fonts',
    translation: 'Translation',
    tafsir: 'Tafsir',
    recitation: 'Recitation',
    wbw: 'Word by word',
  },
  row: {
    /** On-demand packs that are not on this computer yet. */
    asYouRead: 'Downloads as you read',
    asYouListen: 'Streams as you listen',
    byChapter: 'By surah',
    /** "Version 1.1.2". */
    version: 'Version {version}',
    /** An update: "1.1.1 → 1.1.2" (versions are bidi-isolated). */
    versions: '{installed} → {latest}',
    /** Size of a complete download: "1.6 GB in all". */
    sizeAll: '{size} in all',
    /** Items of a per-item pack on this computer: "{present} of {count}" by the total. */
    itemsOf: {
      page: { one: '{present} of {count} page', other: '{present} of {count} pages' },
      surah: { one: '{present} of {count} surah', other: '{present} of {count} surahs' },
      chapter: { one: '{present} of {count} surah', other: '{present} of {count} surahs' },
    },
    /** Surahs cached while streaming (not downloaded): "3 cached". */
    cached: { one: '{count} cached', other: '{count} cached' },
    /** Fonts of an ornament pack: "3 fonts". */
    fonts: { one: '{count} font', other: '{count} fonts' },
    actionsLabel: 'Actions for {name}',
    menuLabel: '{name}',
  },
  badge: {
    installed: 'Installed',
    partial: 'Partial',
    update: 'Update',
    paused: 'Paused',
    failed: 'Failed',
    queued: 'Queued',
    /** A download that waits for a connection ("Download when online", or a job that failed for being offline). */
    waiting: 'Waiting',
    downloading: 'Downloading',
    verifying: 'Verifying',
    installing: 'Installing',
    recommended: 'Recommended',
    inUse: 'In use',
  },
  actions: {
    download: 'Download',
    downloadAll: 'Download all',
    /** "Download all · 1.6 GB". */
    downloadAllSize: 'Download all · {size}',
    /** Some items are already on this computer: "Download the rest · 1.5 GB". */
    downloadRestSize: 'Download the rest · {size}',
    update: 'Update',
    pause: 'Pause',
    resume: 'Resume',
    retry: 'Retry',
    stop: 'Stop download',
    remove: 'Remove',
    removeAll: 'Remove all',
    openFolder: 'Open folder',
    showSurahs: 'Surahs',
    showSurahsOf: 'Show the surahs of {name}',
    hideSurahsOf: 'Hide the surahs of {name}',
    more: 'More actions',
    needsNetwork: 'Needs a connection',
  },
  progress: {
    /** Accessible name of a job's progress bar. */
    label: 'Downloading {name}',
    /** "12.4 of 93.2 MB": `{done}` is a number in the unit of `{total}`. */
    of: '{done} of {total}',
    rate: '{size}/s',
    left: '{time} left',
    queued: 'Waiting to start',
    starting: 'Starting…',
    verifying: 'Checking the download…',
    installing: 'Installing…',
    paused: 'Paused',
    failed: 'Couldn’t download',
    /** It starts (or resumes) by itself once the app is online with network use allowed. */
    waiting: 'Waits for a connection',
  },
  grid: {
    label: 'Surahs of {name}',
    /** A cell's accessible name: "18. Al-Kahf, downloaded, 34 MB". */
    cell: '{number}. {surah}, {state}',
    cellSize: '{number}. {surah}, {state}, {size}',
    state: {
      pinned: 'Downloaded',
      cached: 'Cached while streaming',
      queued: 'Queued',
      none: 'Not downloaded',
    },
    /** About a not-yet-downloaded surah's size: "about 34 MB". */
    about: 'about {size}',
    hint: 'Select a surah to download it, or to remove a downloaded one.',
    offlineHint: 'Downloading needs a connection. Downloaded surahs can still be removed.',
    basmala: 'Kept while other surahs are downloaded: their basmala plays from it.',
    legend: {
      pinned: 'Downloaded',
      cached: 'Cached',
      queued: 'Queued',
    },
    download: 'Download',
    remove: 'Remove',
    play: 'Play surah',
    menuLabel: 'Surah {surah}',
  },
  confirm: {
    removeTitle: 'Remove {name}?',
    removeBody: 'This frees {size} on this computer. You can download it again at any time.',
    removeItemsBody: 'Everything of this pack on this computer goes ({size}). It still works online.',
    removeAllTitle: 'Remove the downloaded surahs of {name}?',
    removeAllBody: 'This frees {size}. The recitation still streams when you’re online.',
    stopTitle: 'Stop downloading {name}?',
    stopWholeBody: 'The part downloaded so far is discarded.',
    stopItemsBody: 'What finished downloading stays on this computer.',
  },
  toast: {
    done: 'Downloaded {name}',
    updated: 'Updated {name}',
    /** One surah of a recitation: "Downloaded Al-Kahf · Mishary Rashid Alafasy". */
    surahDone: 'Downloaded {surah} · {name}',
    itemsDone: {
      page: { one: 'Downloaded {count} page of {name}', other: 'Downloaded {count} pages of {name}' },
      surah: { one: 'Downloaded {count} surah of {name}', other: 'Downloaded {count} surahs of {name}' },
      chapter: { one: 'Downloaded {count} surah of {name}', other: 'Downloaded {count} surahs of {name}' },
    },
    failed: 'Couldn’t download {name}',
    removed: 'Removed {name} · freed {size}',
    surahRemoved: 'Removed {surah} · {name}',
    surahsRemoved: { one: 'Removed {count} surah of {name}', other: 'Removed {count} surahs of {name}' },
    streamCleared: 'Cleared {size} of streamed recitations',
    streamEmpty: 'The streaming cache was already empty',
  },
  state: {
    loading: 'Loading packs…',
    errorTitle: 'Couldn’t load the packs',
  },
  /** The rail's Downloads flyout (owner request 2026-10-11): what runs, waits, failed and just finished. */
  flyout: {
    /** Accessible name of the list of jobs and requests. */
    jobs: 'Current downloads',
    nothing: 'Nothing downloading',
    /** Links that open the manager on a kind of pack. */
    getContent: 'Get content',
    recent: 'Recently finished',
    /** A finished job's line, before its size: a whole pack, an update, one surah, several items. */
    finished: 'Downloaded',
    updated: 'Updated',
    finishedSurah: 'Downloaded {surah}',
    finishedItems: {
      page: { one: '{count} page downloaded', other: '{count} pages downloaded' },
      surah: { one: '{count} surah downloaded', other: '{count} surahs downloaded' },
      chapter: { one: '{count} surah downloaded', other: '{count} surahs downloaded' },
    },
    manage: 'Manage downloads',
  },
} as const

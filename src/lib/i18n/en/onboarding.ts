/**
 * `onboarding` messages, English (§11.1, §9.7 onboarding). Owner: WP12c. The same keys live in `../ar/onboarding.ts`.
 * References only this domain plus the frozen `common`, `shortcuts` and `errors` keys.
 */
export const onboarding = {
  /** The dialog's accessible name (screen readers announce it when the dialog opens). */
  title: 'Set up Quran for Desktop',
  stepOf: 'Step {step} of {total}',
  steps: {
    welcome: 'Welcome',
    mushaf: 'Mushaf',
    reading: 'Translation and recitation',
    summary: 'Starter set',
    keys: 'Keys',
  },
  progressLabel: 'Setup progress',
  finish: 'Finish',
  welcome: {
    title: 'Welcome to Quran for Desktop',
    lede: 'The Madani Mushaf on your desktop: quiet, fast and ready offline.',
    features: {
      page: {
        title: 'The printed page',
        body: 'All {pages} pages, each line where the print puts it.',
      },
      recite: {
        title: 'Recitation',
        body: '{reciters} reciters, highlighted word by word as they recite.',
      },
      study: {
        title: 'Study and memorize',
        body: 'Search, bookmarks, notes and memorization.',
      },
    },
    language: 'Language',
    theme: 'Theme',
    themes: {
      system: 'Match system',
      paper: 'Paper',
      sepia: 'Sepia',
      night: 'Night',
      black: 'Black',
    },
    systemHint: '{light} in light mode, {dark} in dark mode',
  },
  mushaf: {
    title: 'Choose your Mushaf',
    lede: 'See how the page will look. You can change this later in Settings.',
    /** The style cards' accessible name (a radio group). */
    label: 'Mushaf',
    styles: {
      hafs: {
        name: 'Hafs',
        body: 'The KFGQPC Hafs typeface on the Madani page layout.',
        meta: 'Works offline',
      },
      qcf_v2: {
        name: 'Madani print, 1421 AH',
        body: 'The authentic page fonts of the 1421 AH print.',
        meta: 'Pages download as you read',
      },
      qcf_v4: {
        name: 'Tajweed',
        body: 'The same pages, with the rules of tajweed in colour.',
        meta: '≈ {size} · pages download as you read',
      },
    },
    included: 'Included',
    ornaments: 'Ornate surah headers · {size}',
    /** The same option once the ornaments are on this computer (nothing left to download). */
    ornamentsReady: 'Ornate surah headers',
    allPages: 'Download all pages in the background ({size})',
    needsDownload: "Needs download — available when you're online",
    /** A Tajweed card this system's web view cannot draw (§8.6). */
    unsupported: 'Not supported on this system',
    preview: {
      /** The live preview's accessible name. */
      label: 'Preview of the first page',
      /** Under the preview: "Madani print, 1421 AH · Ornate headers". */
      caption: '{style} · {headers}',
      ornate: 'Ornate headers',
      plain: 'Plain headers',
      loading: 'Downloading this page…',
      fallback: 'Shown in Hafs until this page downloads.',
      ornamentsLoading: 'Downloading the ornaments…',
      ornamentsLater: 'The ornaments show once they download.',
    },
  },
  reading: {
    title: 'Translation and recitation',
    lede: 'Pick a translation and a reciter. You can change them later in Settings.',
    translation: 'Translation',
    noTranslation: 'No translation',
    tafsir: 'Tafsir',
    reciter: 'Reciter',
    preview: 'Listen',
    stopPreview: 'Stop',
    previewLabel: 'Listen to {reciter} recite the first ayah',
    previewOffline: 'Listening needs a connection',
    streams: 'Recitation streams as you listen and is cached.',
  },
  summary: {
    title: 'Your starter set',
    /** The Mushaf step's preview may have fetched page 1 of the chosen print (and the ticked ornaments, listed here). */
    lede: "Exactly what downloads, and when. Apart from the Mushaf preview's first page, nothing is fetched without asking.",
    listLabel: 'Starter set',
    when: {
      now: 'Downloads now',
      pages: 'Pages download as you read',
      chapters: 'Downloads as you read',
      timings: 'Timings on first play · audio streams and is cached',
      installed: 'Already downloaded',
      background: 'Every page, in the background',
    },
    later: 'Later',
    total: 'Downloads now',
    nothing: 'Nothing to download now',
    workOffline: 'Work offline',
    workOfflineBody: 'Use no network at all. Downloads, streaming and updates wait until you turn this off.',
    offline: "You're offline. Downloads can start once you're back online.",
    startReading: 'Start reading',
    downloadNow: 'Download now',
  },
  keys: {
    title: 'Three keys to remember',
    lede: 'Quran for Desktop is made for the keyboard. These three take you anywhere.',
    palette: {
      title: 'Search and jump',
      body: 'Surahs, 2:255, p 262, juz 15 and every command.',
    },
    play: {
      title: 'Play or pause',
      body: 'Recite from the page you are on, or resume where you stopped.',
    },
    sheet: {
      title: 'Every shortcut',
      body: 'The full list of keys, whenever you need it.',
    },
    downloading: 'Downloading your starter set · {percent}%',
    ready: 'Your starter set is ready',
    failed: "Part of your starter set didn't download. You can retry it from Downloads.",
    openDownloads: 'Open Downloads',
  },
} as const

/**
 * `settings` messages, English (§11.1): the Settings view (§9.7) and the labels of `settingsMeta`
 * (`src/components/settings/meta.ts`), which the command palette shows too. Owner: WP12b. The same keys live in
 * `../ar/settings.ts`. References only this domain plus the frozen `common`, `shortcuts` and `errors` keys.
 *
 * `fields.<name>` names one `Settings` field: `label` (the row title), `description` (the line under it) and `keywords`
 * (extra search words, never shown). Nested settings (`sidePane`, `sidebar`, `copy`) hold one entry per sub-field.
 */
export const settings = {
  title: 'Settings',
  /** Between the parts of a caption ("Paper · Hafs"). The Arabic UI uses the Arabic comma. */
  sep: ' · ',
  nav: {
    label: 'Settings sections',
    search: 'Search settings',
  },
  search: {
    heading: 'Search results',
    count: { one: '{count} setting matches “{query}”', other: '{count} settings match “{query}”' },
    empty: 'No settings match “{query}”',
    emptyBody: 'Try another word, such as theme, speed or offline.',
    clear: 'Clear the search',
  },
  sections: {
    appearance: { title: 'Appearance', lede: 'Theme, accent colour, interface size and layout.' },
    mushaf: { title: 'Mushaf', lede: 'The style of the pages and how they respond while you read.' },
    translations: {
      title: 'Translations',
      lede: 'Translations, tafsir, the study pane and how ayahs are copied.',
    },
    audio: { title: 'Audio', lede: 'The reciter, how recitations play and repeat, and following along.' },
    memorization: { title: 'Memorization', lede: 'How words look while they are hidden for revision.' },
    language: { title: 'Language', lede: 'The language of the app and how its numbers are written.' },
    keyboard: { title: 'Keyboard', lede: 'Every shortcut, shown with the keys of your keyboard.' },
    storage: { title: 'Storage', lede: 'Disk space, the streaming cache and network use.' },
    system: { title: 'System', lede: 'The tray, closing the window, tips and resetting settings.' },
    about: { title: 'About', lede: 'The version of the app and of its Quran data.' },
  },
  groups: {
    theme: 'Colours',
    display: 'Display',
    layout: 'Layout',
    style: 'Style',
    pages: 'Pages',
    furniture: 'On the page',
    interaction: 'Interaction',
    wbw: 'Word by word',
    reading: 'Reading',
    translations: 'Translations',
    studyPane: 'Study pane',
    copy: 'Copying',
    playback: 'Playback',
    repeat: 'Repetition',
    followAlong: 'Following along',
    hiding: 'Hidden words',
    keys: 'Keys while memorizing',
    language: 'Interface',
    shortcuts: 'Shortcuts',
    usage: 'Disk space',
    library: 'Library backup',
    streaming: 'Streaming',
    network: 'Network',
    window: 'Window and tray',
    guidance: 'Guidance',
    reset: 'Reset',
    app: 'Quran for Desktop',
  },
  fields: {
    theme: {
      label: 'Theme',
      description: 'Colours of the pages and the app.',
      keywords: 'dark light mode colour color appearance',
    },
    lightVariant: {
      label: 'Light theme',
      description: 'Used while the system is in light mode and the theme matches the system.',
      keywords: 'day system',
    },
    darkVariant: {
      label: 'Dark theme',
      description: 'Used while the system is in dark mode and the theme matches the system.',
      keywords: 'night system',
    },
    accent: {
      label: 'Accent colour',
      description: 'Buttons, selections and the recitation highlight.',
      keywords: 'color tint highlight',
    },
    uiLanguage: {
      label: 'Language',
      description: 'Menus, labels and messages. The Mushaf is always in Arabic.',
      keywords: 'english arabic interface locale',
    },
    digits: {
      label: 'Numbers',
      description: 'How numbers are written in the app. The Mushaf always uses Arabic-Indic numerals.',
      keywords: 'digits numerals indic western',
    },
    uiScalePct: {
      label: 'Interface size',
      description: 'Makes text and controls larger or smaller. The Mushaf still fits the window.',
      keywords: 'scale zoom bigger smaller text font accessibility',
    },
    motion: {
      label: 'Motion',
      description: 'Animations such as page turns and panels sliding in.',
      keywords: 'animation reduce reduced movement accessibility',
    },
    inkBrightnessPct: {
      label: 'Ink brightness',
      description: 'Dims the Quran text on the Night and Black themes to reduce glare.',
      keywords: 'dim glare dark night text',
    },
    chromeEffect: {
      label: 'Translucent window',
      description:
        'Lets the desktop colour show through the title bar and sidebar on the Paper and Night themes.',
      keywords: 'mica vibrancy transparency blur glass',
    },
    mushafStyle: {
      label: 'Mushaf style',
      description: 'The script and page layout of the Mushaf.',
      keywords: 'font qcf hafs madani print tajweed script',
    },
    pageMode: {
      label: 'Pages',
      description: 'Automatic shows two pages side by side when they fit.',
      keywords: 'spread single double one two',
    },
    zoomPct: {
      label: 'Zoom',
      description: '100 % fits the page to the height of the window.',
      keywords: 'size magnify bigger',
    },
    tajweedColors: {
      label: 'Tajweed colours',
      description: 'Shows the tajweed rules in colour.',
      keywords: 'color rules',
    },
    showPageFrame: {
      label: 'Page frame',
      description: 'The gold border around the text.',
      keywords: 'border ornament decoration',
    },
    showRunningHeads: {
      label: 'Running heads',
      description: 'The surah name and juz above the text.',
      keywords: 'header title juz surah name',
    },
    showMarginMarkers: {
      label: 'Margin markers',
      description: 'Hizb, quarter and sajda signs beside the lines.',
      keywords: 'hizb rub sajda prostration quarter',
    },
    highlightBookmarks: {
      label: 'Your marks in the margin',
      description: 'Bookmarks, notes and the reading bookmark beside their ayahs.',
      keywords: 'bookmark note ribbon',
    },
    hoverHighlight: {
      label: 'Highlight on hover',
      description: 'Tints the ayah under the pointer.',
      keywords: 'mouse pointer tint',
    },
    ayahActionBar: {
      label: 'Ayah action bar',
      description:
        'A click on an ayah offers play, bookmark, highlight, note and copy. Off: a click only selects.',
      keywords: 'toolbar click select actions',
    },
    pageTurnAnimation: {
      label: 'Page-turn animation',
      description: 'Slides the pages when you turn them. Never shown while motion is reduced.',
      keywords: 'animation flip slide',
    },
    wbwPackId: {
      label: 'Word meanings',
      description: 'The language of word-by-word meanings in tooltips and the study pane.',
      keywords: 'wbw word by word gloss dictionary',
    },
    wbwTooltip: {
      label: 'Meaning on hover',
      description: 'Shows the meaning of the word under the pointer.',
      keywords: 'wbw tooltip gloss',
    },
    wbwShowTransliteration: {
      label: 'Transliteration',
      description: 'Adds the pronunciation in Latin letters to word meanings.',
      keywords: 'wbw pronunciation latin',
    },
    readingMode: {
      label: 'Reading view',
      description: 'Translation view lists the ayahs with their translations.',
      keywords: 'mode mushaf translation view',
    },
    translations: {
      label: 'Shown translations',
      description: 'Shown in translation view and in the study pane, in this order. Up to 5.',
      keywords: 'translation language english order',
    },
    tafsirPackId: {
      label: 'Tafsir',
      description: 'The commentary the study pane shows.',
      keywords: 'tafseer commentary exegesis',
    },
    translationFontPct: {
      label: 'Text size',
      description: 'Translations, and the Arabic text in translation view.',
      keywords: 'font size bigger smaller',
    },
    translationArabic: {
      label: 'Arabic text',
      description: 'Shows each ayah in Arabic above its translations in translation view.',
      keywords: 'arabic ayah text',
    },
    footnotesInline: {
      label: 'Footnotes under the ayah',
      description: 'Shows translators’ footnotes in the text instead of in a popover.',
      keywords: 'notes footnote inline',
    },
    sidePane: {
      label: 'Study pane',
      open: {
        label: 'Show the study pane',
        description: 'Translation, tafsir, notes and word meanings beside the page.',
        keywords: 'side pane panel',
      },
      widthPx: {
        label: 'Study pane width',
        description: 'Narrower when the window has no room for it.',
        keywords: 'side pane size',
      },
      tab: {
        label: 'Opens on',
        description: 'The tab the study pane shows.',
        keywords: 'side pane tab',
      },
      follow: {
        label: 'Follows',
        description: 'Which ayah the study pane shows.',
        keywords: 'side pane selection recitation pin',
      },
      autoCollapseSidebar: {
        label: 'Make room for the pane',
        description:
          'Hides the sidebar while the study pane is open, when both would not fit beside the page.',
        keywords: 'sidebar collapse hide',
      },
    },
    sidebar: {
      label: 'Sidebar',
      open: {
        label: 'Show the sidebar',
        description: 'The index, search, bookmarks and other panels beside the page.',
        keywords: 'panel index',
      },
      widthPx: {
        label: 'Sidebar width',
        description: 'You can also drag the edge of the sidebar.',
        keywords: 'panel size',
      },
      tab: {
        label: 'Sidebar panel',
        description: 'The panel the sidebar shows.',
        keywords: 'tab index search bookmarks',
      },
    },
    reciterId: {
      label: 'Reciter',
      description: 'Every recitation uses this reciter. Word highlighting needs word timings.',
      keywords: 'qari voice recitation',
    },
    speedPct: {
      label: 'Speed',
      description: 'Each recitation starts at this speed. The pitch stays natural.',
      keywords: 'tempo rate faster slower',
    },
    volumePct: {
      label: 'Volume',
      description: 'Recitation volume, relative to the system volume.',
      keywords: 'loud quiet sound',
    },
    followAlong: {
      label: 'Turn pages with the recitation',
      description: 'Keeps the recited ayah on screen.',
      keywords: 'follow scroll auto',
    },
    wordHighlight: {
      label: 'Highlight the recited word',
      description: 'For reciters with word timings.',
      keywords: 'word timing karaoke',
    },
    ayahRepeat: {
      label: 'Repeat each ayah',
      description: 'How many times each ayah is recited. ∞ repeats it until you stop.',
      keywords: 'loop times memorize',
    },
    rangeRepeat: {
      label: 'Repeat a selection',
      description: 'How many times a selected range of ayahs is recited.',
      keywords: 'loop range times',
    },
    gap: {
      label: 'Pause between repeats',
      description:
        'Silence before an ayah is recited again: a fixed time, or a share of the ayah’s own length.',
      keywords: 'gap silence delay wait',
    },
    stopAt: {
      label: 'Stop at',
      description: 'Where a recitation started from an ayah ends.',
      keywords: 'end surah page juz continue',
    },
    streamCacheCapMib: {
      label: 'Streaming cache limit',
      description: 'Recitations you listen to are kept for next time, up to this size. The oldest go first.',
      keywords: 'cache disk space audio',
    },
    memoHideStyle: {
      label: 'Style',
      description: 'How words appear while they are hidden for revision.',
      keywords: 'memorize memorise hide blur blank hifz',
    },
    memoRevealOnHover: {
      label: 'Peek on hover',
      description: 'Pointing at a hidden word shows it while the pointer stays.',
      keywords: 'memorize reveal peek mouse',
    },
    copy: {
      label: 'Copying',
      includeReference: {
        label: 'Add the reference',
        description: 'Ends copied ayahs with the surah and ayah number.',
        keywords: 'copy citation source',
      },
      referenceStyle: {
        label: 'Reference style',
        description: 'How the reference is written.',
        keywords: 'copy citation format',
      },
      ayahNumbers: {
        label: 'Ayah numbers',
        description: 'Keeps the end-of-ayah sign with its number.',
        keywords: 'copy marker verse number',
      },
      translationPackId: {
        label: 'Add a translation',
        description: 'Copies this translation after the Arabic.',
        keywords: 'copy translation',
      },
    },
    announceRecitation: {
      label: 'Announce ayahs to screen readers',
      description: 'Reads out each new ayah reference during a recitation.',
      keywords: 'accessibility screen reader nvda voiceover a11y',
    },
    closeToTray: {
      label: 'Keep reciting after closing the window',
      description: 'Closing the window during a recitation keeps it playing from the tray.',
      keywords: 'tray background minimize quit',
    },
    closeToTrayAsked: {
      label: 'Ask when closing during a recitation',
      description: 'The next time you close the window while a recitation plays, asks what to do.',
      keywords: 'tray question prompt dialog',
    },
    showTrayIcon: {
      label: 'Tray icon',
      description: 'An icon with playback controls in the system tray.',
      keywords: 'notification area menu bar',
    },
    networkAllowed: {
      label: 'Use the network',
      description: 'Off: nothing is downloaded or streamed, and the app uses only what is on this computer.',
      keywords: 'offline internet online work offline',
    },
    onboardingDone: {
      label: 'Welcome tour',
      description: 'The first-run guide to language, theme, Mushaf style and downloads.',
      keywords: 'onboarding introduction guide setup',
    },
    hintsSeen: {
      label: 'Tips',
      description: 'Short hints shown once, such as how to turn pages.',
      keywords: 'hints help',
    },
  },
  /** Rows that act rather than hold a setting (search finds them too). */
  actions: {
    clearCache: {
      label: 'Clear cache',
      description:
        'Removes recitations cached while listening, and tafsir, word meanings and timings fetched as you read. Your downloads stay.',
      keywords: 'free space delete temporary',
    },
    downloads: {
      label: 'Downloads',
      description: 'Download or remove Mushaf fonts, translations, tafsir and recitations.',
      keywords: 'packs manage install remove',
    },
    resetAll: {
      label: 'Reset all settings',
      description: 'Returns every setting to its default. Your library, downloads and language are kept.',
      keywords: 'defaults restore factory',
    },
    shortcuts: {
      label: 'Keyboard shortcuts',
      description: 'Keys follow your keyboard layout, Arabic layouts included.',
      keywords: 'keys hotkeys keybindings',
    },
    about: {
      label: 'Credits and licences',
      description:
        'Sources of the Quran text, fonts, translations and recitations, and open-source licences.',
      keywords: 'attribution license copyright',
    },
    version: {
      label: 'Version',
      description: 'The app and its Quran data.',
      keywords: 'build release update',
    },
    backupCreate: {
      label: 'Back up your library',
      description:
        'Saves your bookmarks, highlights, notes, history, memorization progress and settings in one file.',
      keywords: 'backup export save copy file library',
    },
    backupRestore: {
      label: 'Restore from a backup',
      description:
        'Replaces your library with a backup file. Your current library is kept as a backup first.',
      keywords: 'restore import recover backup file library',
    },
  },
  options: {
    theme: {
      system: 'Match system',
      paper: 'Paper',
      sepia: 'Sepia',
      night: 'Night',
      black: 'Black',
      high_contrast: 'High contrast',
    },
    /** The line under each theme card; `{light}` and `{dark}` name the variants "Match system" switches between. */
    themeHint: {
      system: '{light} or {dark}',
      paper: 'Warm white',
      sepia: 'Soft cream',
      night: 'Dim grey',
      black: 'True black',
      high_contrast: 'Strongest legibility',
    },
    accent: {
      teal: 'Teal',
      emerald: 'Emerald',
      blue: 'Blue',
      indigo: 'Indigo',
      rose: 'Rose',
      amber: 'Amber',
    },
    motion: { system: 'Match system', reduce: 'Reduced', full: 'Full' },
    digits: { auto: 'Automatic', latin: 'Western', arabic_indic: 'Arabic-Indic' },
    /** The example line under the Numbers row. */
    digitsSample: 'Page {page} · {ref} · {size}',
    mushafStyle: {
      hafs: 'Hafs',
      qcf_v2: 'Madani 1421 AH',
      qcf_v1: 'Madani 1405 AH',
      qcf_v4: 'Tajweed',
    },
    mushafStyleHint: {
      hafs: 'The Uthmani Hafs font, included with the app.',
      qcf_v2: 'The pages of the 1421 AH Madani print.',
      qcf_v1: 'The earlier 1405 AH print, with its own page layout.',
      qcf_v4: 'The 1421 AH pages with tajweed rules in colour.',
    },
    pageMode: { auto: 'Automatic', single: 'One page', spread: 'Two pages' },
    readingMode: { mushaf: 'Mushaf', translation: 'Translation' },
    sidebarTab: {
      index: 'Index',
      search: 'Search',
      bookmarks: 'Bookmarks',
      highlights: 'Highlights',
      notes: 'Notes',
      history: 'History',
      memorize: 'Memorize',
    },
    sidePaneTab: { translation: 'Translation', tafsir: 'Tafsir', notes: 'Notes', words: 'Words' },
    sidePaneFollow: {
      selection: 'The selected ayah',
      selection_or_audio: 'The selected or recited ayah',
      pinned: 'Only the pinned ayah',
    },
    referenceStyle: { short: 'Short', long: 'With the surah name', arabic: 'Arabic' },
    stopAt: {
      end_of_surah: 'End of the surah',
      end_of_page: 'End of the page',
      end_of_juz: 'End of the juz',
      end_of_quran: 'End of the Quran',
    },
    gap: { none: 'None', fixed: 'Fixed', multiplier: 'Ayah length' },
    memoHideStyle: { blur: 'Blurred', blank: 'Blank' },
    memoHideStyleHint: {
      blur: 'The shape of each line stays visible.',
      blank: 'Only the space of each word is shown.',
    },
    uiLanguage: { en: 'English', ar: 'العربية' },
    none: 'None',
  },
  /** Formats of values next to sliders and steppers (percentages: `Intl.NumberFormat` "150%", «١٥٠٪»). */
  units: {
    /** "300 px". */
    px: '{value} px',
    /** Playback speed: "1.25×". */
    speed: '{value}×',
    /** A pause in seconds: "1.5 s". */
    seconds: '{value} s',
    /** A pause as a share of the ayah's length: "×1.5". */
    multiplier: '×{value}',
    /** A repeat count of 0. */
    infinite: '∞',
    infiniteLong: 'Until you stop',
    times: { one: 'Once', other: '{count} times' },
  },
  controls: {
    less: 'Less',
    more: 'More',
    resetValue: 'Reset to {value}',
    /** A list item's reorder buttons, named with the item ("Move Saheeh International up"). */
    moveUp: 'Move {name} up',
    moveDown: 'Move {name} down',
  },
  preview: {
    label: 'Preview',
    /** The caption under the preview: "Paper · Hafs". */
    caption: '{theme}{sep}{style}',
    translationMissing: 'Choose a translation to see it here.',
    chooseTranslation: 'Choose a translation',
    loading: 'Loading the page…',
  },
  appearance: {
    accentForced: 'The High contrast theme uses its own accent colour.',
    inkContrast: 'Your system asks for more contrast, so the ink stays at full brightness.',
    chromeLinux: 'Not available on Linux.',
    chromeUnsupported: 'This system can’t show a translucent window.',
    chromeTheme: 'Shown with the Paper and Night themes.',
  },
  mushaf: {
    styleBadge: {
      included: 'Included',
      downloaded: 'Downloaded',
      partial: '{present} of {total} pages',
      onDemand: 'Downloads as you read',
      offline: 'Needs a connection',
      /** Tajweed needs colour fonts this system's web view cannot draw (§8.6). */
      unsupported: 'Not supported on this system',
    },
    tajweedOnly: 'Only with the Tajweed style.',
    wbwNone: 'None',
    wbwOnDemand: 'Fetched as you read',
    wbwDownloaded: 'Downloaded',
  },
  translations: {
    selected: { one: '{count} of {max} shown', other: '{count} of {max} shown' },
    limit: 'Up to {max} translations can be shown. Turn one off to add another.',
    empty: 'No translations are downloaded yet.',
    emptyBody: 'Download one or more to read them beside the Arabic.',
    getMore: 'Get translations',
    notDownloaded: 'Not downloaded',
    tafsirDownloaded: 'Downloaded',
    tafsirOnDemand: 'Fetched as you read',
    copyPreview: 'Copies as',
    copyPreviewError: 'The preview could not be made.',
  },
  audio: {
    noReciters: 'No reciters are available.',
    findReciter: 'Find a reciter',
    noReciterMatch: 'No reciter matches',
    wordTimings: 'Word timings',
    pauseSeconds: 'Pause in seconds',
    pauseShare: 'Pause as a share of the ayah’s length',
  },
  language: {
    sample: 'Example: {sample}',
  },
  keyboard: {
    filter: 'Filter shortcuts',
    openSheet: 'Shortcut sheet',
  },
  storage: {
    clear: 'Clear cache…',
    confirmTitle: 'Clear the cache?',
    confirmBody:
      'Recitations cached while listening, and tafsir, word meanings and timings fetched as you read, are removed. Everything you downloaded stays.',
    confirmLabel: 'Clear cache',
    cleared: 'Freed {size}',
    alreadyEmpty: 'The cache was already empty',
    openDownloads: 'Open Downloads',
    openFolder: 'Open folder',
    offlineNote:
      'While the network is off, downloads wait and recitations play only if they are on this computer.',
  },
  /** Settings › Storage › Library backup, and the startup banner's restore (`backup.ts`). */
  backup: {
    create: 'Back up…',
    restore: 'Restore…',
    saveTitle: 'Save a backup of your library',
    openTitle: 'Choose a library backup',
    /** The file type in the open and save dialogs (`.qdb`). */
    filter: 'Library backups',
    created: 'Library backed up to {file}',
    confirmTitle: 'Restore this backup?',
    confirmBody:
      'Your bookmarks, highlights, notes, history, memorization progress and settings will be replaced with those in {file}. Your current library is kept as a backup first.',
    confirmLabel: 'Restore',
    restored: 'Library restored from {file}',
  },
  system: {
    trayNeeded: 'Needs the tray icon.',
    showTour: 'Show the tour',
    showTips: 'Show tips again',
    tipsShown: 'Tips will show again',
    tipsNone: 'No tips seen yet.',
    tipsSeen: { one: '{count} tip seen.', other: '{count} tips seen.' },
    reset: 'Reset…',
    resetTitle: 'Reset all settings?',
    resetBody:
      'Every setting returns to its default. Bookmarks, notes, highlights, downloads and the app language are kept.',
    resetConfirm: 'Reset settings',
    resetDone: 'Settings were reset',
  },
  about: {
    version: 'Version {version}',
    data: 'Quran data: {source}{sep}{date}{sep}schema {schema}',
    platform: '{os}{sep}{arch}',
    webview: 'Web view {version}',
    debug: 'Development build',
    credits: 'Credits and licences',
    copy: 'Copy version details',
    copied: 'Version details copied',
  },
} as const

/**
 * `shell` messages, English (§11.1): the window chrome, rail, panes, startup banner, fatal screen, shortcut sheet and
 * confirmation dialog. Owner: WP7c. Every key exists in `../ar/shell.ts` too; plurals have `one` and `other` here and
 * all six categories in Arabic.
 */
export const shell = {
  /** The first tab stop of the app (§8.15). */
  skipToText: 'Skip to Quran text',
  landmarks: {
    sections: 'Sections',
    player: 'Recitation player',
    sidePane: 'Study pane',
    toasts: 'Notifications',
  },
  /** Sidebar tab names: rail buttons and the sidebar heading. */
  tabs: {
    index: 'Index',
    search: 'Search',
    bookmarks: 'Bookmarks',
    highlights: 'Highlights',
    notes: 'Notes',
    history: 'History',
    memorize: 'Memorize',
  },
  views: {
    reader: 'Reading',
    downloads: 'Downloads',
    settings: 'Settings',
    about: 'About',
  },
  rail: {
    downloadsActive: { one: '{count} download in progress', other: '{count} downloads in progress' },
    /** Downloads that wait for a connection (the rail button's status, after the active count). */
    downloadsWaiting: { one: '{count} waiting for a connection', other: '{count} waiting for a connection' },
    downloadsFailed: { one: '{count} failed', other: '{count} failed' },
  },
  titleBar: {
    /** The command-centre button that opens the palette. */
    search: 'Search or jump to…',
    location: 'Location',
    /** Breadcrumb for a two-page spread. */
    pages: 'Pages {from}–{to}',
    goTo: 'Go to…',
    backToReading: 'Back to reading',
  },
  window: {
    minimize: 'Minimize',
    maximize: 'Maximize',
    restore: 'Restore down',
    close: 'Close',
  },
  sidebar: {
    hide: 'Hide sidebar',
    resize: 'Resize sidebar',
  },
  sidePane: {
    resize: 'Resize study pane',
  },
  offline: {
    badge: 'Offline',
    networkOff: 'Offline mode',
    /** Tooltip while the network is unreachable. */
    unreachable: "No internet connection. Everything you've downloaded keeps working.",
    /** Tooltip while network use is turned off in Settings. */
    disallowed: 'Network use is turned off. Downloads and streaming wait until you allow it in Settings.',
  },
  zen: {
    hint: 'Zen mode · press {key} to leave',
  },
  banner: {
    userDbRecovered: "Your library couldn't be opened. A copy was kept.",
    keptAs: 'Kept as {file}',
    /** Picks a library backup and restores it (Settings › Storage has the same action). */
    restore: 'Restore from backup…',
    /** Reveals the data folder that holds the kept copy and the backups. */
    showFiles: 'Show files…',
  },
  fatal: {
    coreMissingTitle: 'Core data missing (dev build)',
    coreMissingBody: 'Build the Quran database with {command}, then start the app again.',
    browserTitle: 'Run Quran in Tauri',
    browserBody:
      'This is a browser preview of the production build, which has no backend. Start the app with {command}.',
    genericTitle: "Quran couldn't start",
    tryAgain: 'Try again',
    quit: 'Quit',
    copyDetails: 'Copy details',
  },
  shortcutSheet: {
    description: 'Shortcuts work everywhere except while you type in a field.',
    filter: 'Filter shortcuts',
    noMatches: 'No shortcut matches “{query}”.',
    footer: 'Press {key} anytime to open this list.',
  },
  shortcutTable: {
    action: 'Action',
    keys: 'Keys',
    empty: 'No shortcuts in this group yet.',
  },
} as const

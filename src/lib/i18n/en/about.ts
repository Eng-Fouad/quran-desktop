/**
 * `about` messages, English: the About screen and its attributions. The same keys live in `../ar/about.ts`. References
 * only this domain plus the `common`, `shortcuts` and `errors` keys. The attributed sources' own names, credits and
 * licences are data (`src/lib/about/attributions.ts`, catalog attributions), not messages.
 */
export const about = {
  tagline: 'The Madani Mushaf on your desktop.',
  version: 'Version {version}',
  platforms: {
    windows: 'Windows',
    macos: 'macOS',
    linux: 'Linux',
  },
  debugBuild: 'Development build',
  build: 'core.db: {source} · {date} · schema {schema}',
  copyDiagnostics: 'Copy diagnostics',
  diagnosticsHint: 'The app, system and data versions as JSON, for a bug report.',
  diagnosticsCopied: 'Diagnostics copied',
  diagnosticsFailed: "The diagnostics couldn't be copied",
  dataFolder: 'Open data folder',
  attribution: {
    title: 'Attribution',
    lede: 'Quran for Desktop is free software built on the work of these sources. Each is credited here with its licence.',
  },
  groups: {
    app: 'This app',
    text: 'Quran text and layout',
    fonts: 'Fonts',
    translations: 'Translations',
    tafsir: 'Tafsir',
    wbw: 'Word by word',
    recitations: 'Recitations',
  },
  empty: {
    translations: 'Translations you download are credited here, with their version.',
    tafsir: 'Tafsir you download is credited here, with its version.',
  },
  entry: {
    version: 'Version {version}',
    licence: 'Licence',
    site: 'Website',
    source: 'Source code',
    licenceText: 'Licence text',
    showNotice: 'Show the licence',
    hideNotice: 'Hide the licence',
    noticeLoading: 'Loading the licence…',
    noticeFailed: "The licence text couldn't be loaded.",
  },
  openSource: {
    title: 'Open-source licences',
    lede: 'Quran for Desktop includes open-source software. Each package is listed with the licence it is used under.',
    count: { one: '{count} package', other: '{count} packages' },
    show: 'Show the licences',
    hide: 'Hide the licences',
    filter: 'Filter packages',
    filterPlaceholder: 'Name or licence',
    matches: { one: '{count} match', other: '{count} matches' },
    empty: 'No package matches “{query}”.',
    loading: 'Loading the licences…',
    failed: "The licence list couldn't be loaded.",
    ecosystems: {
      cargo: 'Rust crate',
      npm: 'npm package',
    },
    by: 'By {authors}',
    declared: 'Declared as {licence}',
    noText:
      'This package ships no licence file; it is licensed under {licence}. Its repository has the details.',
  },
} as const

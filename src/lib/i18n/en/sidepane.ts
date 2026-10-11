/**
 * `sidepane` messages, English (§11.1): the study pane (§9.7) — its ayah header, the Translation, Tafsir, Notes and
 * Words tabs, and their §9.8 states. Owner: WP11b. The same keys live in `../ar/sidepane.ts`. References only this
 * domain plus the frozen `common`, `shortcuts` and `errors` keys.
 */
export const sidepane = {
  /**
   * Between the parts of a meta line ("البقرة · Juz 3 · Page 42"). The Arabic UI uses the Arabic comma: a middle dot
   * next to Arabic-Indic digits reads as the digit zero (٠).
   */
  sep: ' · ',
  header: {
    /** The pane's heading: "Al-Baqarah 2:255". */
    title: '{surah} {ref}',
    previous: 'Previous ayah',
    next: 'Next ayah',
    pin: 'Pin the pane to this ayah',
    unpin: 'Unpin: follow the selection again',
    close: 'Hide the study pane',
    /** The rosette's state while the shown ayah is being recited. */
    reciting: 'Now reciting',
    /** §8.15 chip while a selection (or the pin) holds the pane during a recitation. */
    followRecitation: 'Follow recitation',
    /** Its tooltip and accessible name: "Follow recitation (now at 2:258)". */
    followRecitationAt: 'Follow recitation (now at {ref})',
    /** Chip while the pane is pinned and the reader selected another ayah: "Show 2:256". */
    showSelection: 'Show {ref}',
    showSelectionHint: 'Move the pin to the selected ayah',
  },
  tabs: {
    /** Accessible name of the tab list. */
    label: 'Study',
    translation: 'Translation',
    tafsir: 'Tafsir',
    notes: 'Notes',
    words: 'Words',
  },
  empty: {
    title: 'Nothing selected',
    body: 'Select an ayah on the page to study it here.',
  },
  /** A long selection lists its first ayahs only. */
  truncated: {
    one: 'Showing the first ayah of {count} selected',
    other: 'Showing the first {shown} of {count} selected ayahs',
  },
  /** Shared by the "add" cards of the three tabs (§9.8). */
  packs: {
    /** Row meta: "English · 507 KB". */
    meta: '{language} · {size}',
    /** Row meta of a pack fetched chapter by chapter: "English · fetched as you read". */
    onDemand: '{language} · fetched as you read',
    use: 'Use',
    show: 'Show',
    queued: 'Waiting to download',
    downloading: 'Downloading… {percent}',
    installing: 'Installing…',
    paused: 'Paused at {percent}',
    failed: 'Download failed',
    more: 'More in Downloads',
  },
  translation: {
    loading: 'Loading the translation…',
    textError: "This ayah couldn't be loaded",
    error: "The translation couldn't be loaded",
    pickTitle: 'Add a translation',
    pickBody: 'Read the meaning of each ayah beside the Arabic text.',
    pickOffline: 'Translations download when you’re online',
    pickLabel: 'Translations to add',
  },
  tafsir: {
    /** Label of the tafsir picker in the tab's toolbar. */
    source: 'Tafsir',
    pickTitle: 'Choose a tafsir',
    pickBody: 'Commentary on each ayah, beside the page you are reading.',
    pickOffline: 'Tafsir downloads when you’re online',
    pickLabel: 'Tafsir to choose from',
    loading: 'Loading the tafsir…',
    /** A range entry (§9.7): "Covers 2:255–257". */
    covers: 'Covers {ref}',
    /** §9.8 offline state: "This tafsir needs a connection for Al-Kahf (≈180 KB)". */
    needsConnection: 'This tafsir needs a connection for {surah} (≈{size})',
    needsConnectionPlain: 'This tafsir needs a connection for {surah}',
    offlineHint: 'It is saved for offline reading once it has loaded.',
    notInstalled: '{name} isn’t downloaded',
    notInstalledBody: 'Download it once to read it offline.',
    queued: '{name} is waiting to download',
    downloading: 'Downloading {name}… {percent}',
    installing: 'Installing {name}…',
    paused: 'The download of {name} is paused at {percent}',
    failed: '{name} couldn’t be downloaded',
    error: 'The tafsir couldn’t be loaded',
    empty: 'This tafsir has no commentary on this ayah.',
    /** An on-demand tafsir whose upstream has nothing on the surah (Ibn Kathir on Al-Fil): no Retry. */
    noCommentary: '{name} has no commentary on {surah}',
    noCommentaryHint: 'Choose another tafsir above to read about this surah.',
    /** Footer of fetched content: "Saved 3 days ago". */
    saved: 'Saved {time}',
    /** §9.8 footer of stale content: "Saved 9 days ago · refreshes when online". */
    stale: 'Saved {time} · refreshes when online',
    /** Footer of an installed pack: "Version 2025.03". */
    version: 'Version {version}',
    /** Accessible name of the tafsir text: "Tafsir of 2:255". */
    label: 'Tafsir of {ref}',
  },
  notes: {
    /** Above a note on a wider range than the pane shows: "On Al-Baqarah 2:253–257". */
    covering: 'On {ref}',
    /** Accessible name of the list: "Notes on 2:255". */
    label: 'Notes on {ref}',
  },
  words: {
    /** Label of the word-by-word picker in the tab's toolbar. */
    source: 'Word by word',
    transliteration: 'Transliteration',
    pickTitle: 'Word-by-word meanings',
    pickBody: 'See what each word means, with its transliteration.',
    pickOffline: 'Word-by-word meanings download when you’re online',
    pickLabel: 'Languages to choose from',
    loading: 'Loading the words…',
    needsConnection: 'Word-by-word meanings need a connection for {surah}',
    offlineHint: 'They are saved for offline reading once they have loaded.',
    error: 'The word-by-word meanings couldn’t be loaded',
    /** Accessible name of an ayah's word grid: "Words of 2:255". */
    grid: 'Words of {ref}',
    /** A word card's tooltip. */
    show: 'Show this word on the page',
    noGloss: 'No meaning listed',
    /** The card of the word being recited. */
    reciting: 'Being recited',
  },
} as const

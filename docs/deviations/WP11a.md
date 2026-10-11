# WP11a deviations (translations store and translation mode)

Delivered:
- **Store** `src/lib/stores/translations.svelte.ts`: the §7.3 caches (`rows`, `tafsir`, `wbw` + `version`),
  `ensureWindow`, `tafsirFor`, `wbwForRange`, plus the pack bookkeeping translation mode needs (deviation 6).
- **Translation mode** `src/components/translation/`: `TranslationView` (the view), `VerseRow`, `SurahCard`,
  `FootnotePopover`, and the parts §7.5 names inside them: `KeyBadge`, `VerseActions` (the row's ActionBar),
  `TranslationBlock`, `AddTranslationCard` and `PackNotice` (§9.8 states), `rows.ts` (the row model).
- **Mock** `src/lib/ipc/mock/handlers/content.ts`: `quran_get_ayahs`, `translation_get`, `tafsir_get`, `wbw_get_range`
  (deviation 9).
- **i18n** `src/lib/i18n/{en,ar}/content.ts`.
- **Scenarios** `tests/e2e/scenarios/{S21,S36}.mjs`.
- **Tests**:
  - Unit: `src/lib/stores/translations.test.ts` (23), `src/lib/ipc/mock/handlers/content.test.ts` (11),
    `src/components/translation/rows.test.ts` (5).
  - Browser: `src/components/translation/TranslationView.browser.test.ts` (17), with the fixtures
    `testing/{TranslationHarness.svelte, setup.ts}`.
  - The browser tests cover the feed, footnotes (popover and inline), the position restored by ayah within ±2 px (after
    reopening, and after a text-size change), following the reader (a page, a flash jump with focus), the recitation
    (30 %, a manual-scroll pause, Return to recitation), pointer gestures, the §9.8 states and the Arabic UI.

## Deviations from ARCHITECTURE.md

1. **One feed for the whole Quran.**
   - `TranslationView` is a single `VirtualList` of 6,351 rows: a `SurahCard` before each surah, every verse, and an
     end row. The end row carries a closing star and 160 px of room, so the dock never covers the last verse.
   - Scrolling runs from one surah into the next, as in the Mushaf.
   - Semantics follow the ARIA feed pattern. The list has `role="feed"` (named "Verses with translation"). Every verse
     and every card is an `<article>` with `aria-posinset`/`aria-setsize`. A verse is labelled by its reference; a card
     by an `h2` ("Surah 2, Al-Baqarah, The Cow").
   - The roving tab stop is the cursor's verse when it is on screen, else the first verse on screen.

2. **Row layout (§9.7).**
   - The `KeyBadge` is the Index's 28 px rosette (WP10a's `Rosette`) plus the reference ("2:255"). The reference gives
     the surah number while scrolling across surahs.
   - The badge and the `VerseActions` share a 30 px head row above the Arabic: the badge at the inline start, the
     actions at the inline end. The Arabic is right-aligned and starts at the top right, so actions placed over its first
     line would cover it in the English UI.
   - Next to the badge the row shows its marks: bookmark (`--ribbon`), note, and a dot in the highlight colour.
   - The actions are Play from here · Bookmark (pressed) · Highlight (a popover with the five swatches and Remove) · Note ·
     Copy · Tafsir and word by word (the study pane, Tafsir tab) · More (the ayah context menu at the button). They
     apply to the reader's selection when the verse is in it (the §10.3 rule), else to the verse.
   - Actions stay in the layout at opacity 0. They show on hover, on focus-within and on the selected verse, so nothing
     shifts.
   - States:
     - selected: `--hl-selection` with the 1 px `--hl-selection-ring`. Verses selected together read as one block: one
       ring, joined edges without corners, and the separator between them filled with the selection;
     - playing: `--hl-audio` and a 3 px accent bar at the inline start;
     - jump target: a 1.8 s `--accent-soft` flash while `reader.flash` names the verse;
     - loading: skeleton lines sized from the verse's word count;
     - failed: an inline error with Retry.
   - Pointer (§8.17): click selects, Shift+click extends, double-click selects and opens the study pane (Tafsir tab),
     Mod+click (and Alt+click outside Linux) plays from the verse, right-click opens the ayah menu. A click that ends a
     text selection does nothing, so translations can be selected and copied.

3. **The column sits on a sheet.** A fixed `--surface-page` sheet with `--shadow-page` (760 px, centred) lies behind the
   feed. The verses scroll over it, and the scroll bar stays at the canvas edge. In high contrast the sheet's edges are
   the 2 px page outline.

4. **Translation typography by script, not by UI language.**
   - Latin, Cyrillic and similar scripts use `--font-latin` at `18 px × translationFontPct`, leading 1.7.
   - Bengali, Devanagari and Tamil use leading 1.85.
   - Arabic-script translations (Urdu, Persian) use `--font-naskh` at 20 px, leading 2.0. Urdu uses `--font-nastaliq`,
     at leading 2.4 once `decor.nastaliq` is installed.
   - §9.3's `--leading-reading` changes with the UI language (1.9 in Arabic), which would loosen an English
     translation for an Arabic-UI reader.
   - The Arabic is `--text-quran-reading × translationFontPct` (28 px) at `--leading-quran`. Half its extra leading is
     pulled back (`margin-block: -0.3em -0.2em`), so a verse reads as one block.

5. **Footnotes** (§7.6, WP5c's notes to WP11a).
   - A marker that has a note gets an accessible name ("Footnote 3"), `aria-haspopup="dialog"` and `aria-expanded`.
   - A marker without a note (kept as published upstream) is plain text: not focusable, `aria-hidden`, in `--text-faint`.
   - A general note (empty marker) is a small "Translator's note" button after the text.
   - With `footnotesInline` the notes are listed under the text, and a marker moves focus to its note with a short
     highlight.
   - `FootnotePopover` is titled "Footnote 3 · Saheeh International" and shows the note in the pack's language and
     direction. Escape returns focus to the marker. A reference in a note goes to that verse (`reader.goToAyah`, flash).

6. **Store API beyond §7.3** (the names in §7.3 are unchanged):
   - Packs:
     - `selectedPacks` (`settings.translations`, each once, at most 5);
     - `activePacks` (selected and installed, or unknown to every catalogue, and not broken);
     - `missingPacks`, `brokenPacks`, `translationCatalog`;
     - `packMeta(id)` (title, language, direction, availability incl. a running download from `packs.jobs`, on-demand,
       size, recommended) and `packTitle(id)`;
     - `loadCatalog()`: `packs_list` only while the `packs` store has no list. The fallback is the bootstrap summaries.
   - Lookups (reactive through `version`): `row(id)`, `state(id)` (`{ text, tr, error }`), `tafsirOf(pack, id)`, plus
     `layout` and `wbwPackId`.
   - Position: `anchor` (`{ ayahId, delta, page }`, deviation 7) and `topAyahId` (the verse being read).
   - `retry(id?)` and `copyAyahs(from, to, withTranslation?)` (the row's Copy, in `settings.copy`'s format through
     `quran_copy_text`).
   - **`tafsirFor` rejects with the `IpcError`** instead of resolving `null`, so the side pane can tell `offline`
     ("This tafsir needs a connection…") from `not_found`. A cached `stale` entry is fetched again once `app.online`.
   - **`ensureWindow` never rejects.** Failures are kept per block (`state(id).error`). A later call retries a failed block
     only after 4 s; `retry()` retries at once.
   - **Cache behaviour:**
     - Text and translations load in aligned blocks of 50 ayahs, and requests in flight are shared.
     - A layout change reloads only the text. Selecting a new translation reloads only the translations.
     - Removing or reordering translations keeps what is cached, reordered.
     - The last window reloads by itself.
   - **One broken pack never hides the others.** When `translation_get` fails with `not_found` for several packs, each
     pack is fetched alone, and the failing one leaves `activePacks` until `retry()` or a `PacksChanged` for it.
   - **`PacksChanged`:**
     - An active translation that changed reloads.
     - Entries of a changed whole tafsir pack are dropped.
     - On-demand chapters keep what was read, because fetching or clearing a chapter does not change it.
     - The store's own catalogue (if it loaded one) refreshes.

7. **Position kept by ayah, to the pixel** (§7.4, §7.8).
   - `translations.anchor` is the verse at the top edge and how far the view is scrolled past its row, never negative.
     For ayah 1 the distance is measured from its surah card. It also records the page reported to the reader.
   - Entering translation mode restores the anchor when the reader is still on that page. Otherwise it shows the
     cursor's verse when the cursor is on the reader's pages, else the first verse of the reader's pages, 12 px below the
     top. Measured to ±2 px in the browser tests.
   - A text-size, Arabic-line, footnote-style or column-width change restores the anchor too.
   - `init(b)` seeds the anchor from the saved `translation` `ReadingPosition` (`ayahId`, `scrollPx`, `page`). The field
     shapes match, so the reader can save the position from the anchor (request below).
   - While scrolling, the view sets `translations.topAyahId` and calls
     `reader.goToPage(page, { push: false, transition: false })` with the page of the verse being read (debounced
     150 ms). The verse being read is the one 15 % down the viewport, at most 120 px.
   - The view follows the reader:
     - a new `reader.flash` brings that verse to the top, its card for ayah 1, and focuses it when focus is free (in
       the view, on the canvas or nowhere);
     - a page change from elsewhere shows that page's first verse, unless the page is already on screen;
     - a cursor move scrolls the cursor's verse into view (`nearest`) and focuses it.
   - Recitation (§9.7):
     - the playing verse goes 30 % down the viewport, smoothly when it is within three screens;
     - a manual scroll (wheel, touch, keys or the scroll bar within 600 ms) pauses this for 4 s;
     - "Return to recitation" (with a dismiss button) shows while the verse is off screen. Its arrow points to where
       the verse is (up or down).
   - The view has its own chip rather than WP8e's `FollowChip`, whose state belongs to the Mushaf.

8. **§9.8 states.**
   - **No translation to show** (none selected, or none of the selected installed): the full-canvas
     `AddTranslationCard` replaces the feed. It is not a row in it, so it shows wherever the reader was.
     - It lists up to three packs: selected packs that are missing first (downloading with progress, failed with
       Retry, or Install), then installed packs that are not selected ("Show"), then the catalogue's best matches.
       Matches are ranked by the UI language, the OS language, English and `recommended`.
     - Install adds the pack to `settings.translations` and calls `packs.install` (WP12a). The feed replaces the card
       once the pack is installed.
     - Offline, the body reads "Translations download when you're online" and Install is disabled.
     - It also offers "More translations" (Downloads, filtered to translations) and "Back to the Mushaf".
   - **Some selected packs cannot be shown:** `PackNotice` is a slim bar above the feed for each such pack:
     - downloading: progress;
     - not downloaded: Download;
     - failed: Retry;
     - broken: Retry.
     Each bar except a downloading one has Hide, which removes the pack from the selection.

9. **The content mock.**
   - Validation follows the commands: at most 300 ayahs, at most 5 distinct packs, at most 2,000 words, a pack of the
     right kind. An unknown pack is `not_found`.
   - **Whole packs must be installed** (QuranEnc translations and tafsir); `update_available` still works.
   - **On-demand chapters** (Quran.com tafsir and word by word) are fetched online and recorded with WP12a's
     `recordCachedItem`; offline they are `offline`.
   - A chapter already in the pack's items when the page loaded counts as fetched on an earlier run, 9 days ago.
     Offline it is `stale` (the §9.8 footer); online it is revalidated on the spot. Example: fetch a chapter, reload,
     set `networkAllowed: false`.
   - **Content:**
     - Exported fixtures win. Elsewhere the text is synthetic, deterministic and marked as such, in the pack's language
       and script (en, ur, fa, ar, id, tr, fr, es, de, ru, bn, hi, ta).
     - Translations carry QuranEnc-style footnotes: about 1,950 per pack, numbered through the pack, in Bengali digits
       for Bengali. Some notes carry an `a[data-ref]`, and some surahs open with a general note (empty marker).
     - Quran.com-style tafsir comes in ranges of 1–3 ayahs.
     - Word by word skips end markers and takes its words from the ayah fixtures.
   - No Quran text, translation or tafsir is written into the mock.
   - Every answer waits 2–8 ms.

10. **Scenarios.**
    - **S21** selects `tr.en.rwwad` (synthetic, with footnotes in Al-Fatihah) and `tr.ur.junagarhi` (an RTL fixture
      pack). It marks them installed in the mock's `packs` slice (the frozen `PacksState` shape) and relaunches, then
      opens the first footnote (1:4) and checks Escape.
    - **S36** seeds the `translation` reading position at 2:1 (the `user` slice) and starts the recitation paused at 2:1
      with `audio_play` (`startPaused`). Until WP9a's mock can play, it seeds a paused snapshot in the `audio` slice and
      relaunches. It asserts the 760 px centred column, the Al-Baqarah card with its basmala, and the playing verse at
      30 % (±4).
    - Both run in `web` mode only.

11. **Ports.** Shots ran on 1752 (exploration) and `pnpm shots:web --serve 1753` (acceptance), the orchestrator's range for
    WP11a; §14.3 says 1520.

12. **Known benign console output in browser tests.** Large script-driven jumps make Chromium report "ResizeObserver
    loop completed with undelivered notifications" (virtua re-measures rows in the same frame). It does not fail a test.
    S21 and S36 run without console errors.

## Requests

- **WP8e (reader).**
  - **Save the translation position from the anchor.** When `readingMode` is `translation`, write
    `{ context: 'translation', layout, page: anchor.page, ayahId: anchor.ayahId, scrollPx: Math.round(anchor.delta) }`
    from `translations.anchor`. The reader may import the store (L2 → L1). `init` already reads it back.
  - **Breadcrumb, juz and "first visible ayah" in translation mode.** Derive `currentAyahId`, `headSurah`, `juz` and the
    `actionTarget` fallback from `translations.topAyahId` when it is set. Today, reading 18:1 at page 293 shows "Al-Isra"
    (the page's first ayah).
  - **No side effects for the translation view's page sync.** `goToPage(p, { push: false, transition: false })` comes
    from the view as the reader scrolls. Please do not clear a selection on it, record navigation history, or announce
    "Page n" for it in translation mode.
  - **Jumps.** Set `reader.flash` on a jump (palette, Go to, search, bookmark, history) as §7.3 implies. The view then
    scrolls to the verse and focuses `#tv-a{ayahId}`. A non-flash `goToAyah` in translation mode reaches the view
    through the page change, or the cursor if you set it.
  - **Follow-along.** The view follows the recitation itself in translation mode, so the reader need not turn pages
    there. Turns it does make are tolerated.
- **WP11b (side pane).**
  - Read through the store:
    - `await translations.ensureWindow(id, id)`, then `translations.row(id)` and `translations.state(id)`;
    - `translations.tafsirFor(pack, id)`, which rejects with the `IpcError`: `offline`, or `not_found` for a missing
      pack;
    - `translations.tafsirOf(pack, id)` for the cached entry (reactive);
    - `translations.wbwForRange(pack, firstWord, lastWord)`;
    - `translations.packMeta/packTitle` for labels, language and direction.
  - `TranslationBlock.svelte` takes `{ item, meta, title, inline, nastaliq, onref }` and can render the Translation tab's
    text with the same footnote handling.
  - S37 can get "Saved 9 days ago": fetch a chapter, relaunch, then go offline (mock deviation 9).
- **WP11c (study).**
  - `translations.copyAyahs(from, to, withTranslation)` copies in `settings.copy`'s format. It can back `c` and
    `Mod+Shift+C`.
  - In translation mode the context menu opens with `ui.openContextMenu({ x, y, ayahId })` from a verse.
- **WP9a.** S36 plays with `audio_play({ …, startPaused: true })`. Once the audio mock implements it, the scenario stops
  seeding the snapshot by itself.
- **WP10a.** `KeyBadge` uses `Rosette` at 28 px and shrinks three-digit numbers (`.rosette.long .num`, 9.5 px) so "286"
  clears the star's points. A size-aware digit size in `Rosette` would make the override unnecessary.
- **Lead.** Fold deviations 1–10 into §7.3 (store API), §7.5, §9.3 (translation typography), §9.7 and §9.8.

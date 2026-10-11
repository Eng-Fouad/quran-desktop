# WP11b deviations (side pane)

Delivered (owned, §14.3):
- `src/components/sidepane/`:
  - `SidePane.svelte`: the pane (prop-less, §7.9);
  - `AyahHeader.svelte`: the 56 px header with its pin, chevrons and chip;
  - `TranslationTab.svelte`, `TafsirTab.svelte`, `NotesTab.svelte`, `WordsTab.svelte`: the tabs and their §9.8 states.
- `src/lib/i18n/{en,ar}/sidepane.ts`: 69 messages and one plural in both languages; the plural has all six Arabic
  categories.
- `tests/e2e/scenarios/{S14, S22, S37}.mjs`.

Created besides (new files in the owned directory):
- `pane.svelte.ts`:
  - what the pane shows: the pure `resolveSubject` and `chipFor`, and the `pane` singleton with the pin, the hold and
    the chevrons;
  - helpers: `wordSpanOf`, `goToRef`, `languageName`, `listedAyahs`.
- `picker.ts`: the ranking of the "add" cards (pure).
- `PackPicker.svelte`: the §9.8 "add" card shared by the three tabs.
- `PaneMessage.svelte`: the offline, not-downloaded, downloading and failed states.
- `TabBody.svelte`: a tab's frame (a fixed toolbar, a scrolling body with overlay scroll bars, back to the top on a new
  ayah).
- Tests:
  - `pane.test.ts` (unit, 13);
  - `SidePane.browser.test.ts` (browser, 21);
  - fixtures `testing/{PaneHarness.svelte, setup.ts}`.

## Deviations from ARCHITECTURE.md

### 1. What the pane shows (§8.15 with `settings.sidePane.follow`)

§8.15 gives the precedence for the default mode only. The three `SidePaneFollow` values are read like this
(`resolveSubject`, unit-tested):

1. `pinned` with a pin: the pinned ayah or range, whatever the reader or the recitation do.
2. A selection that pins the pane (`reader.paneFollow = 'selection'`): the selection.
3. Not `selection` mode, and a recitation is active (playing or paused): the recited ayah. During a basmala the pane
   shows the surah's first ayah.
4. A selection that is not pinning, for example after "Follow recitation" once nothing plays: the selection.
5. Otherwise the reader's action target: the visible cursor, else the ayah being read. In translation mode that is the
   cursor or the verse at the top. So without a selection the pane follows the reading, page by page or verse by verse.

A **selection of several ayahs is shown whole**:
- the header reads "Al-Baqarah 2:255–257";
- each tab lists the ayahs, each under its reference;
- a selection longer than 30 ayahs (`MAX_SPAN`) lists its first 30 and says "Showing the first 30 of 48 selected
  ayahs".

§9.7 is silent on ranges, and showing only the first ayah of a Shift-selection hid what was selected.

### 2. The pin and the header chips (§9.7 "a pin toggle", §8.15 chip)

- **The pin toggle is `sidePane.follow = pinned`.** It is the same setting as Settings › Study pane › Follows, "Only the
  pinned ayah".
  - Pinning stores the shown span. Unpinning returns to the mode used before (default `selection_or_audio`).
  - Choosing "pinned" in Settings pins whatever is shown at that moment. Leaving `pinned` by any route drops the pin.
    A module-level watcher sees every change of the setting.
- The pinned span is kept in localStorage (`qd-sidepane-pin-v1`, a per-viewer convenience), so a pinned pane reopens on
  the same ayah after a restart.
- In a pinned pane the chevrons move the pin and leave the page alone. Otherwise they make the reader select the
  previous or next ayah (`goToAyah(…, { select: true })`, turning the page when needed), so the page and the pane move
  together. Each step is announced politely ("Al-Baqarah 2:256").
- **Chips.** The header's second line, normally the meta line, gives way to a chip:
  - **"Follow recitation"** (§8.15) shows while a pin holds the pane during a recitation: a selection in the default
    mode, and also the pin toggle. The tooltip and accessible name name the recited ayah ("Follow recitation (now at
    2:263)"). A click drops the pin and calls `reader.followRecitation()`, so the selection stays on the page.
  - **"Show 2:256"** (an addition) shows while the pane is pinned and the reader selected something else. A click moves
    the pin there. Without it, a double-click or the action bar's "Translation/Tafsir" on another ayah would seem to do
    nothing in a pinned pane.
- The chip takes the meta line's place, so the header stays 56 px whatever it shows.

### 3. The pane holds still while you type in it

Once an editable field in the pane has focus (the note composer, a picker's filter), the pane keeps what it shows. It
lets go when focus leaves the pane, or when a layer that took the focus (the tag popover, "Discard note?") closes
without focus coming back. A chevron, a chip or the pin also lets go.

Without this, a pane that follows the recitation swapped the note being written for the next ayah's. The draft
survived (WP11d autosaves it), but the caret did not. It could also unmount the Save button between `mousedown` and
`click`.

### 4. Header details (§9.7)

- **Rosette.** WP10a's rosette at 36 px. Three-digit numbers (up to 286) need the extra size to stay inside the star;
  the digits are overridden to 13 / 11 px. The rosette fills with the accent while the shown ayah is being recited.
- **Meta line.** In the English UI: the surah's Arabic name in Naskh (§9.7), the juz and the page in the current
  layout ("البقرة · Juz 3 · Page 42"). In the Arabic UI the heading is already Arabic, so the line is the juz and the
  page ("الجزء ٣، الصفحة ٤٢", Arabic comma as in WP11a).
- **Hide button** (`PanelRightClose`, `Mod+I` in its tooltip). It shows only when the pane is docked: the narrow-window
  `Sheet` (WP7c) has its own title and close button. In the sheet the pane bleeds to the sheet's edges rather than
  being framed by its padding twice.

### 5. Translation tab (§9.7 "16 px reading text")

- **Arabic.** Each ayah's Arabic comes first: qd-hafs 24 px at leading 2.1, `.quran-text`, `--ink`. It follows
  `translationArabic` like translation mode. A study pane without the text it studies read oddly beside a translation
  view.
- **Translations.** WP11a's `TranslationBlock`: the translator label, the pack's language and direction, footnotes as
  popovers or inline per `footnotesInline`, and Nastaliq for Urdu when installed.
  - The reading size is 16 px × `translationFontPct`.
  - References turn the page there with a flash; the pane and the focus stay.
- **Loading.** Through the shared `translations` store, so translation mode and the pane never fetch twice. The pane
  asks only for ayahs nobody asked for yet (see request 1). Loading shows skeleton lines sized from the word count; a
  failure shows an inline Retry.
- **§9.8.** With no translation to show, the "Add a translation" card lists three packs:
  - first the selected packs that are missing, with their download state;
  - then installed packs that are not selected ("Show");
  - then the best matches for the UI language, the OS language and English ("Install": selects the pack and starts
    its download).

  Offline, the card says "Translations download when you're online" and Install is disabled. Selected packs that
  cannot be shown get WP11a's `PackNotice`.

### 6. Tafsir tab (§9.7, §9.8)

- **Typography.** §9.7 specifies Arabic tafsir: Naskh 18 px, leading 2.0, at most 64ch. Tafsir in other languages
  (the Quran.com English packs) uses the reading font at 16 px, leading 1.7, at most 64ch: Naskh for Latin text was
  never intended.
- **Range entries.** A range entry starts with a "Covers 2:253–255" chip.
  - For a range subject the tab walks the entries in order: each starts after the last ayah the previous one covered.
    So a Quran.com entry over 2:253–255 is shown once for a selection of 2:253–255.
  - Revisits render from the store's cache at once, with no skeleton.
- **Footer.** The source title, the pack's attribution line, and the date:
  - "Saved 3 days ago" for fetched content;
  - "Saved 9 days ago · refreshes when online" in `--warning-text` when `stale` (§9.8). A stale entry is fetched again
    as soon as the app is online;
  - the installed version for a whole pack ("Version 2025.03"). QuranEnc asks for its version to be credited.
- **States (§9.8).**
  - Loading: 6 skeleton lines spaced at the tafsir's line height (36 px for Naskh, 27 px for Latin).
  - Offline and the chapter not cached: "This tafsir needs a connection for Al-Kahf (≈180 KB)" [Retry]. The size is
    `packs.itemKib` (WP12a's per-surah estimate). It is retried by itself once the app is online.
  - A whole pack not on disk: "{name} isn't downloaded" [Download]. While it downloads the tab follows the job's
    phase: waiting, "Downloading… 45%" with progress, "Installing…" while it is verified and installed, paused with
    Resume, and Retry after a failure. The entry appears by itself once the pack is installed.
  - No tafsir chosen: the tafsir card. It lists every tafsir, ones usable now first ("Use": installed, or fetched as
    you read), then by language. "Install" chooses the pack and starts its download, so the tab shows the progress.
  - A chosen pack that no catalogue knows (a stale setting): the card again.
- **Toolbar** (an addition). A `Select` switches the tafsir among installed packs and those fetched as you read. It
  shows the same list as Settings › Study pane, so switching does not need a trip to Settings.

### 7. Notes tab (§9.7 "WP11d's editor in compact mode")

- The note on exactly the subject comes first: a card that edits in place, or the composer when there is none.
- Then every other note that covers the subject, labelled with its own range ("On Al-Baqarah 2:253–257"), by start,
  newest first. Each is a `NoteEditorDialog compact` instance (WP11d's contract).
- The tab's badge counts the notes on or around the subject.
- The pane never puts the caret in the editor by itself.

### 8. Words tab (§9.7)

- **Cards.** Each card shows:
  - the word in qd-hafs 24 px;
  - its meaning in the pack's language: Latin 13 px; Naskh 15 px for right-to-left packs, so it is sized by its own
    script, not by the UI language;
  - its transliteration, italic 12 px, when `wbwShowTransliteration` is on.
- **Reading order.** The grid runs right to left in every UI language (`dir="rtl"`). End markers have no card. A range
  groups its words under each ayah's reference.
- **Showing a word.** Clicking a card shows the word on the page with the search-hit layer (§9.7), through
  `reader.goToAyah(id, { highlightWords: [word] })`, turning the page when needed. A second click clears it
  (`aria-pressed`).
- The word being recited is tinted with `--hl-word` (an addition).
- **Toolbar** (an addition): the word-by-word language (`wbwPackId`, shared with WP8d's tooltip, so both use one
  cache) and a transliteration switch.
- **States.**
  - No pack: the card, offering word-by-word packs for the UI language first.
  - Loading: skeleton cards.
  - Offline and not cached: "Word-by-word meanings need a connection for Al-Kahf" [Retry], retried by itself when the
    app comes online.

### 9. The "add" cards (§9.8)

`PackPicker` is shared by the three tabs; its ranking is in `picker.ts` (pure, unit-tested). Each row shows the pack's
language and size ("English · 507 KB"), or "fetched as you read" for Quran.com packs, and one action:
- Use / Show;
- Install, disabled offline;
- the download's phase with progress, and Resume when it is paused;
- Retry after a failure.

"More in Downloads" opens the Downloads view filtered to that kind.

### 10. Scenarios (§12.6)

All three run in mode `web`: they seed the browser mock, as S21/S36 do.
- **S14**:
  - marks Saheeh International installed and relaunches;
  - double-clicks a word of 2:255 on page 42 (§8.17);
  - asserts the selection, the docked pane beside the page with no overlap, the 56 px header, and the Translation
    tab's Arabic and 16 px English block.
- **S22**:
  - Arabic UI; marks At-Tafsir Al-Muyassar installed;
  - opens the pane with a click on 2:255's end-of-ayah marker (§8.17: the Tafsir tab);
  - asserts the pane on the left, the Arabic heading with Arabic-Indic digits, Naskh 18 px at leading 36 px
    right to left, and the source footer.
- **S37**:
  - fetches Al-Baqarah from Ibn Kathir once (`tafsir_get`), relaunches (the mock then dates the chapter 9 days back,
    WP11a deviation 9) and switches the network off;
  - opens the Tafsir tab on 2:255;
  - asserts "Covers 2:253–255", the 16 px English text and "Saved 9 days ago · refreshes when online".
- Each writes the viewport and a `-pane` close-up.

### 11. Ports and the real app

- Shots ran on 1756 (exploration) and 1757–1758 (acceptance), the orchestrator's range for WP11b. §14.3 says 1520.
- The pane was also checked in the real app on real IPC, offline so that nothing was fetched (`pnpm tauri build --debug
  --no-bundle` into `C:\qdt\WP11b`, then `app-driver.mjs` with a scratch scenario). It showed the real catalogue
  in the "Add a translation" card, Ibn Kathir's offline state with the catalogue's per-surah size ("≈829 kB" for
  Al-Baqarah), the note composer on user.db, and the word-by-word offline state, with no console errors.

## Requests

- **WP11a (`translations` store):**
  1. **The pane's loads replace the feed's "last window".** `ensureWindow` remembers only the last window it was
     asked for, and reloads that one after a layout or pack change. In translation mode with the pane open, a pane
     load after the feed's makes a later pack change reload only the pane's ayahs; the feed's visible rows wait for
     the next scroll. The pane already asks only for ayahs nobody has asked for (`state(id)` idle), so this is rare.
     A fix: `ensureWindow(from, to, { remember: false })`, or remembering one window per caller.
  2. **Word by word offline.** `wbwForRange` fetches aligned 500-word chunks. Offline, a chunk that crosses into an
     uncached surah fails although the shown ayah's surah is cached (the mock fetches per chapter like the
     commands). The Words tab then says "needs a connection" for an ayah whose chapter is on disk. A fix: clamp chunks
     at surah boundaries, or fall back to the exact range when a chunk fails with `offline`.
- **WP10a (`Rosette`):** like WP11a, the pane overrides `.rosette .num` (13 / 11 px at 36 px). Size-aware digits in
  `Rosette` would make the override unnecessary.
- **Lead:** fold deviations 1–9 into §7.3 (what the pane shows), §8.15 (the chips and the hold), §9.7 and §9.8.

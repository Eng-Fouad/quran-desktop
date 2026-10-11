# WP12b deviations (Settings)

Owned and delivered:
- **View**: `src/components/settings/SettingsView.svelte` (§7.5, §9.7), the ten sections in `sections/*.svelte`
  (Appearance, Mushaf, Translations, Audio, Memorization, Language, Keyboard, Storage, System, About).
- **`settingsMeta`**: `src/components/settings/meta.ts`, with `meta.test.ts` (the acceptance check that every `Settings`
  key, nested sub-fields included, has an entry).
- **Building blocks** in `src/components/settings/controls/`:
  - Rows and cards: `SettingGroup`, `SettingRow`, `SwitchRow`, `SliderRow`, `ChoiceRow`, `SelectRow`, `Stepper`.
  - Pickers: `ThemePicker`, `AccentPicker`, `StylePicker`, `HideStylePicker`, `TranslationList`.
  - Previews: `PreviewCard` and `CopyPreview`.
  - Helpers: `radio.ts` (radio-group keys) and `context.ts` (the search context and shortcut labels).
- **Other modules**: `model.ts` (reading and saving by row path, value formatters), `themes.ts` (picker swatches, see
  deviation 4) with `themes.test.ts`, and `view.svelte.ts` (`settingsView`: the open section, the search and deep links).
- **i18n**: `src/lib/i18n/{en,ar}/settings.ts`. Both languages have the same keys, and every Arabic plural has all six
  categories.
- **Tests**:
  - `meta.test.ts` and `themes.test.ts` (unit, 50 tests).
  - `settings.browser.test.ts` (browser, 11 tests): every meta row is rendered once, and the settings round trip goes
    through `settings_set` into the mock's stored settings and back after a fresh bootstrap.
- **Scenario**: `tests/e2e/scenarios/S24.mjs` writes `S24.png` plus `-preview`, `-search`, `-ar` and `-paper`.

## Deviations from ARCHITECTURE.md

1. **One section at a time, with search (§7.5, §9.7).**
   - The 200 px navigation lists the ten sections, and the column (at most 720 px) shows the chosen one: its title, a
     lede, then cards of 56 px rows.
   - A search field heads the navigation. It is not in the spec. Typing shows the matching rows of every section,
     grouped under their section and card. The controls stay live in the results.
   - The navigation counts the matches per section and dims the sections with none. A section button leaves the
     search.
   - Matching uses each row's label, description, option names and keywords, in the UI language and in English, so
     "theme" still works in the Arabic UI. Arabic is folded like the combobox filter (`foldForMatch`).
   - Below 880 px of view width the navigation becomes a strip above the column: title, search, then the section
     buttons wrapping. This happens at 150 % interface size (S24) and in narrow windows. (Since 2026-10-11 the buttons
     sit in one row that scrolls sideways, and at 150 % S24's dialog keeps the column layout: 11.)
   - The open section is kept for the session (Appearance on a new launch). Other packages can deep-link with
     `settingsView.open(section, rowId)`: the row scrolls into view with a brief accent wash.

2. **`settingsMeta` shape (§9.7; the WP10c request).**
   - `label`, `description` and `keywords` are i18n keys of the `settings` domain (`settings.fields.<name>.label`),
     so the palette translates them.
   - Each entry also has `section`, `group` (the card), `options` (the dictionary group naming its options), `range`
     (`{ min, max, step }`) and `unit`. `gap` has `ranges` (fixed ms, share of the ayah).
   - Nested settings (`sidePane`, `sidebar`, `copy`) have one entry per sub-field in `fields`.
   - The type `SettingsMeta` makes a missing field a compile error. The unit test checks the same at run time and
     checks every key in both dictionaries.
   - Ranges are the validated ranges (`SETTING_LIMITS`). The control step can be coarser where the validated step is 1:
     text size 10 %, pane and sidebar widths 10 px, the pause 0.5 s or ×0.25.
   - Also exported:
     - `SETTING_ACTIONS`: rows that act (Clear cache, Downloads, Reset all, Keyboard shortcuts, Version, Credits).
     - `ROW_IDS`, `metaOf(id)`, `rowsOf(section)`, `searchRows(query, locale)` and `searchText`.
     - `SETTINGS_SECTIONS` and `SETTINGS_GROUPS`.

3. **How fields are bound.** Every field has a control, and the browser test asserts it. The less obvious ones:
   - `lightVariant` / `darkVariant`: segmented controls under the theme cards. They are always enabled, because they
     decide what "Match system" resolves to.
   - `chromeEffect`: a switch (on = `auto`). It is disabled with the reason on Linux and when `window_set_chrome`
     answered `unsupported` (always the case in the browser mock).
   - `closeToTray`: choosing it also sets `closeToTrayAsked = true`, because the user has answered the first-close
     question (§9.6).
   - `closeToTrayAsked`: shown inverted, as "Ask when closing during a recitation".
   - `onboardingDone`: "Show the tour" sets it to `false` and opens the `onboarding` overlay.
   - `hintsSeen`: "Show tips again" empties the list. The row says how many tips were seen.
   - `streamCacheCapMib`: a select of presets from 256 MB to 20 GB. A stored value that is not a preset is listed
     too.
   - `reciterId`: a searchable select (Arabic and Latin names, style, word-timing badge). It saves the setting and
     calls `player.setReciter(id)`, so a running recitation switches.
   - `tafsirPackId`: lists installed tafsir packs and the Quran.com tafsir fetched as you read. A pack fetched as you
     read can be chosen before anything is downloaded.
   - `wbwPackId`: lists every word-by-word pack, each marked downloaded or fetched as you read.
   - `copy.translationPackId`: lists the downloaded translations.
   - `translations`: an ordered list of the downloaded translations. Shown ones come first, with move up and down. A
     selected pack that is not on disk stays in place, marked "Not downloaded".
   - `ayahRepeat`, `rangeRepeat` and the pause use an APG spinbutton (`Stepper`). It takes arrows, Page Up/Down,
     Home/End and typed digits; 0 reads "∞" ("Until you stop").
   - Sliders that re-lay the window are saved when the drag or key ends: interface size, sidebar width, study pane
     width. Saving them live would move the slider out from under the pointer.
   - Sliders that only change rendering are saved live: ink brightness, text size, zoom, speed, volume. The preview
     follows the thumb.
   - Every slider has a reset-to-default button before it. Its space is kept, so sliders line up from row to row.

4. **Theme and accent miniatures use a colour table (§9.1).** tokens.css resolves only the active theme on `:root`, so
   the pickers cannot read the colours of the other themes from tokens. `themes.ts` holds the shipped values of the six
   tokens a miniature needs, for every theme including high-contrast dark, and the light and dark `--accent` of every
   accent. `themes.test.ts` resolves tokens.css for every theme and accent with WP7a's token harness and fails on any
   difference.

5. **Preview (§9.7 "live preview card").**
   - The page is a slice of page 1 at qfs 17 (the surah header, the basmala and about six lines), faded above and
     below. A whole page at card size would draw the glyphs at about 9 px, too small to judge ink brightness,
     tajweed colours or a style.
   - Beside it is 1:2 in the first translation the reader shows, at the translation text size, with the translator's
     name. Without a translation, a button opens Translations › Shown translations.
   - The Mushaf section shows the same page slice on its own, wider, so a style change is seen where it is made.
   - The preview, the disk-usage card and the memorisation key table are hidden while searching (they are not rows).

6. **Storage.**
   - WP12a's `DiskUsageBar` heads the section, with Open folder.
   - Clear cache asks first through `ui.confirm` (danger), says that downloads stay, toasts the space freed (or "already
     empty") and refreshes the usage.
   - "Downloads" opens the Downloads view, and its row shows the shortcut.
   - The network switch explains what changes while it is off.

7. **Rows show their shortcut.** A row can name a `shortcuts.*` label key. When a package has registered that
   shortcut, its keys show after the description: theme Ctrl+Shift+L, interface size, sidebar, study pane, reading
   view, page mode, zoom, Downloads. The lookup is by label, not by definition id, so it holds whoever owns the
   definition.

8. **Group titles.** The cards carry the §9.7 rows under these titles:
   - Appearance: Colours, Display, Layout.
   - Mushaf: Style, Pages, On the page, Interaction, Word by word.
   - Translations: Reading, Translations, Study pane (with the tafsir), Copying (with a live "Copies as" preview built
     by `quran_copy_text` for 112:1).
   - Audio: Playback (reciter, speed, volume, stop at), Repetition, Following along (with `announceRecitation`).
   - Memorization: Hidden words, plus the memorisation keys from `ShortcutTable`, shown once WP9b has registered them.
   - Language: Interface.
   - Keyboard: `ShortcutTable` with a filter and a button for the shortcut sheet.
   - Storage, System and About as described above.

9. **Ports.** Web shots and the review runs used `--serve 1772` (this package's range 1772–1775; §14.3 says 1520).
   S24 (`mode: 'both'`) also passed in the real app: `pnpm tauri build --debug --no-bundle` into `C:\qdt\WP12b`,
   then `app-driver.mjs --exe C:\qdt\WP12b\debug\quran-desktop.exe --only S24`, with Rust's webview zoom at 150 %.

### Owner request 2026-10-11: Settings as a dialog over the reader

10. **Shown in the shell's Settings dialog** (WP7c 22), not in the canvas. The view keeps its own headings: the
    navigation's "Settings" (`SETTINGS_TITLE_ID`) names the dialog, the column's h2 names the section, and no header row
    repeats either. The dialog's close button sits in the top inline-end corner; the view keeps `--qd-close-room` free
    there (the column's end padding, and the search field's end margin in the strip). The dock reserve is no longer the
    view's own sum: the dialog sets `--qd-dock-reserve` only in the filled frame, where the dock lies over its bottom (a
    floating frame stays above the dock).

11. **The strip is one row.** Under 880 px of view width the sections no longer wrap (2–5 rows at 150–200 %): they sit in
    one row that scrolls sideways, edge to edge of the strip, without a scrollbar. The wheel scrolls it while it can
    still move (then the page scrolls), ←/→ move between sections in reading order (↑/↓, Home and End as before), and
    the open section is brought into view when it changes or the strip resizes. The view's scrollbar paints above the
    sticky strip. At 150 % in a 1600 × 1000 window (S24) the dialog is 1019 × 579 wide enough for the column layout;
    the strip shows at 200 % (`S24-strip`).

12. **Scenario S24.** It checks the dialog over the mounted reader and the navigation beside the column at 150 % (it
    used to assert the strip there), then at 200 % in Arabic the filled dialog and the one-row strip (new shot
    `S24-strip`). The settings browser test adds the strip's wheel and arrow keys in both directions.

### Owner request 2026-10-11: the "Aa" reading-display popover

13. **`DisplayPopover`** (`src/components/settings/DisplayPopover.svelte`; the canvas's "Aa" button is WP8e 13).
    Settings' display controls beside the page, applied live with no scrim:
    - the theme cards (`ThemePicker compact`: three across, names only, 44 px miniatures; two across under 240 px);
    - ink brightness on Night and Black, with Appearance's "increase contrast" note;
    - beside the Mushaf, the style cards (`StylePicker compact`: two across, each name over one line of status in its
      tone, with the same availability rules) and the pages (Automatic, One page, Two pages);
    - the translation text size wherever translation text shows (translation mode, or the study pane on its
      Translation tab).

    `displayRows` (`display.ts`, unit-tested) leaves out what would not change the page: translation mode sets its
    Arabic in Hafs in one column, so it gets no Mushaf style or pages. Ranges, units and labels come from
    `settingsMeta`, and values save through `model.save` while a slider moves. The rules it shares with Settings live
    in `display.ts` once, read by both: `dimsInk` and `inkNoteKey` (with `MORE_CONTRAST`) by Appearance's ink row,
    `PAGE_MODES` by Mushaf's page-mode row.
    - **"All settings"** (with the `Mod+,` keycaps) opens the dialog on the reading mode's own section: Mushaf beside
      the Mushaf, Translations in translation mode. The spec named "the Appearance/Mushaf section"; Translations holds
      the text size and translation mode's other display rows, and Appearance is one click away. The popover closes
      and gives focus back first, so the dialog returns it there.
    - `Mod+,` never acts over a layer (its guard), and the popover is a floating layer, so it handles the key
      itself (`shortcuts.matches`), as the Downloads flyout does `Mod+Shift+D`.

## Requests

- **WP10c (palette).** `settingsMeta[key].label` and `.description` are now i18n keys. The palette's `metaText`
  already translates them, and the palette tests pass against the real meta. Nested settings keep their texts under
  `fields`.
- **WP12c (onboarding).** Settings › System › "Show the tour" sets `onboardingDone = false` and calls
  `ui.open('onboarding', {})`. The onboarding dialog should start at step 1 when opened this way and set
  `onboardingDone = true` again on Finish or Skip, as on the first run.
- **WP9b (memorisation).** The Memorization section draws its own sample of the two hide styles: a 5 px blur, and
  blank pills at 9 % ink. If `memo.css` settles on other values, tell WP12b, or expose a class the sample can reuse.
- **Lead.** Fold deviations 1–8 into §9.7 and §7.5. Also record the search and `settingsView` deep links, and the
  `settingsMeta` shape for other packages (the palette and any "open in Settings" link).

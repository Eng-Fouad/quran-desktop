# WP10c deviations (command palette)

Delivered:

- `src/components/palette/CommandPalette.svelte`: the §9.7 palette. It is a bare glass `Dialog` (640 px wide, 14 vh from
  the top, `layer="palette"`) holding a bits-ui `Command` (`shouldFilter={false}`, `vimBindings={false}`, `loop`). The
  input row has the search icon, the field (`dir="auto"`) and the scope chip. Below it are the grouped results, a footer
  of key hints, and a polite status line.
- `src/components/palette/PaletteRow.svelte`: one row. A 24 px badge (rosette, icon tile, highlight swatch, reciter
  monogram or reading-bookmark ribbon), the label with the query's matches emphasised, a muted detail, the surah's Arabic
  name (the sura-names glyph when decor is loaded, else Naskh), and keycaps or a state badge at the inline end.
- `src/components/palette/palette-providers.ts`: the providers and `paletteResults(text, scope)`.
- `src/components/palette/match.ts`: the text fold, word scoring and match ranges.
- `src/lib/i18n/{en,ar}/palette.ts`: 70 messages in each language. The Arabic plurals define all six categories.
- `tests/e2e/scenarios/S20.mjs`: writes `S20.png` (Mod+K, then "2:255") plus the close-ups `S20-empty.png`,
  `S20-commands.png`, `S20-glyphs.png` and `S20-ar.png`.
- Tests:
  - `match.test.ts` (unit, 11 tests).
  - `palette-providers.test.ts` (unit, 29 tests).
  - `CommandPalette.browser.test.ts` (browser, 16 keyboard and pointer flows). It runs on the real L0 stores, the shortcut
    listeners and `OverlayHost`, over the IPC mock.

## Deviations from ARCHITECTURE.md

1. **Providers (§9.7).** The six providers keep the §9.7 order. Two things were added:
   - **Search**, a seventh group, comes last. It shows "Search the Quran for “…”" for any query of two or more characters
     that is not a reference. Running it calls `ui.navigate({ type: 'search', data: { query } })` and focuses the
     sidebar search field. So a query with no matches still leads somewhere. The §9.7 empty state ("No matches. Try
     2:255, p 262, j 15, الكهف") shows above that row. Its examples are buttons that fill the field. In the Arabic UI the
     examples are "٢:٢٥٥, ص ٢٦٢, ج ١٥, Al-Kahf": the surah name is in the other script.
   - **Empty query.** The palette shows Recent first (the Continue row and up to 4 history entries), then every command.
     §9.7 lists Recent last. That order holds for typed queries, but with nothing typed, "where was I" comes first.
2. **Go to and Surahs.**
   - Go to uses `parseReference(q, { nameLimit: 3 })` without the bare surah-name results. Those belong to the Surahs
     group, which uses `quran.surahMatches` with a limit of 6.
   - "kahf 10" (`source: 'name'`, an ayah) stays in Go to. A bare number gives "Surah 18" and "Page 18" in Go to, and no
     Surahs row.
   - Out-of-range references are disabled rows, with the reason in `--danger-text`. Arrow keys skip them.
   - Ayah and surah rows run `openTarget(t, { focus: true })`, so focus moves to the ayah. Pages keep the usual focus
     return.
3. **Commands (the shortcut registry).**
   - Every registered definition is listed. Exceptions: the palette itself, `Escape`, and the hold-to-peek key (it acts
     while the key is held). A command is also left out when its scope cannot apply (`mushaf` or `translation` in the
     other reading mode) or its `when()` is false.
   - Each label appears once. Rows show the first chord as keycaps.
   - Order: a short priority list first (Go to, Search, Play/pause, reading mode, bookmark, reading bookmark, note,
     theme, panels, zen, full screen, Settings, Downloads, Keyboard shortcuts), then the shortcut sheet's group order.
     The empty palette therefore opens on the commands people reach for, not "Larger interface".
   - Running a command: the palette closes, focus returns to where it was, and then `def.run` gets a synthetic `keydown`
     built from the def's first chord on this platform (key, code and modifiers). So the command acts as if its key had
     been pressed there. A `reader`-scoped command first switches to the reader view, and `when()` is checked again at
     that moment.
   - Icons are mapped from the frozen `shortcuts.*` label keys, so they hold whoever registers the def. Highlight
     commands show their colour swatch. Directional panel and history icons mirror in RTL. Page-turn arrows do not
     mirror, because they follow the keys.
   - One command without a shortcut was added: "About Quran Desktop" (`ui.setView('about')`).
4. **Settings.**
   - Toggles: every boolean field of `Settings` (taken from `defaultSettings()`, so new fields appear on their own),
     except `onboardingDone` and `closeToTrayAsked`. Each row shows an On/Off badge.
   - Choices: theme, accent, UI language, Mushaf style, page mode and reading mode, one row per option ("Theme:
     Night"), with "Current" on the selected one. Option labels live in `palette.settings.values.*`, because
     `settingsMeta` has no option labels. Search keywords such as "dark", "Arabic" or "1421" help find them.
   - Labels come from `settingsMeta` (WP12b) and are read defensively, so any shape WP12b settles on works:
     - `label` (or `labelKey`/`title`), and `description` as the row detail;
     - a string that names an i18n key is translated;
     - a function or getter is called.
     Without metadata the label is the field name spelled out ("Show page frame", "UI language"), as §9.7 says.
   - A row saves through `settings.update` and confirms with a toast ("Page frame: Off").
5. **Reciters.**
   - Matched on the Arabic and Latin names and the style.
   - The detail shows the style, "3 surahs downloaded" and "Word highlighting" (when `wordLevel` is set). The current
     reciter (`settings.value.reciterId`) is marked "Current".
   - The monogram follows the §9.7 dock rule: Latin initials without name particles, or the first Arabic letter in
     Naskh.
   - Running a row calls `player.setReciter(id)` and toasts "Reciter: …".
6. **Recent.**
   - The Continue row follows ContinueCard's rule: the bookmark must be more than 2 pages from every page on screen.
   - History rows come newest first, one per (mode, page), and leave out the pages on screen. They show the mode icon
     and "Listened · p 440 · 2 hours ago".
   - With a query, Recent rows match the reference and the surah names in both scripts.
   - The palette calls `history.load()` when it opens. A failure leaves the group out.
7. **Scope chip and prefixes.** §9.7 names a scope chip but does not define it. Here it is:
   - A pill at the end of the field opens a menu: Everything, Commands (`>`), Surahs (`#`), Reciters (`@`).
   - Typing a prefix first sets the scope and removes the prefix from the field, as VS Code's `>` does. Backspace at the
     start of the field returns to Everything.
   - A scope lists all of its kind while the field is empty. The Commands scope also lists settings, and the Surahs
     scope lists all 114 surahs.
   - `ui.open('palette', { query: '> theme' })` opens directly in a scope.
8. **Matching (`match.ts`).** For commands, settings, reciters and recent rows:
   - Text is folded with `normalizeAr` (loose) and `foldLatin`, and apostrophes are dropped.
   - Every query word must match a word of a field: whole word, prefix, or inside a word from 3 letters on. An Arabic word
     also matches without its article.
   - Ties go to the first word and the typed order, and short labels outrank long ones.
   - Fields carry weights: label 1, English label 0.9 (so English words work in the Arabic UI), group name 0.5.
   - A group's own name lists the group ("settings", "reciters", "القرّاء").
   - Latin labels show their matches in weight 600. Arabic labels never do, because a weight change inside a word breaks
     its joining.
9. **Rows.**
   - Each row is a single 40 px line: the label, then the detail in text-xs muted. The detail ellipsises before the label
     does.
   - The active row is `--accent-soft`; under forced colours it gets a `Highlight` outline. Disabled rows are muted.
   - The surah's Arabic name sits at the inline end in the English UI: the sura-names glyph at 26 px when `qd-sura-names`
     is loaded, else Naskh at 17 px. In the Arabic UI the label is already Arabic, so only the glyph is shown, and only
     when it is loaded.
   - Details are written in the UI language and use `unicode-bidi: isolate`. A name in the other script is wrapped in
     FSI/PDI, so "Al-Kahf، مكية، ١١٠ آيات" keeps its order.
10. **Footer and status.** The footer shows key hints: ↑↓ to choose, ↵ to open, Esc to close, and the three prefixes. A
    visually hidden `role="status"` line announces the result count 350 ms after typing stops.
11. **Behaviour details.**
    - Home and End keep moving the caret in the field (bits-ui would move the selection).
    - The list height animates with `--bits-command-list-height`; `--dur-quick` is 0 under reduced motion.
    - The backdrop is `faint` (.18), as on Go to, so the page stays readable behind the glass.
    - A row runs exactly once, through the first of: the dialog's `onCloseAutoFocus`, the component's destruction
      (reduced motion), or a 450 ms fallback.
12. **Menus above the palette.** The scope menu is a WP7b `Menu`. It renders at `--z-menu` (50), under the palette layer
    (70), so it was invisible and could not be clicked. `CommandPalette.svelte` lifts any `.qd-menu` while a palette is in
    the document (`body:has(.qd-palette) .qd-menu`; bits-ui copies the content's z-index to its floating wrapper). See
    the WP7b request.
13. **S20.** The scenario runs in `web` mode. Besides `S20.png` it writes four close-ups. Its checks: the first option
    is "Al-Baqarah 2:255" (synthetic data: "Al-Baqara") and is active; `aria-activedescendant` points at it; the dialog
    is 640 px wide at 14 vh; focus is on the field; the prefix becomes the chip; the Arabic UI is `dir="rtl"`. The glyph
    close-up is taken only when `data/dev-packs` has the decor fonts; otherwise it is logged and skipped. To show Recent,
    the scenario seeds a reading bookmark and history in the mock and the stores, because the mock's
    `reading_bookmark_set` and `history_record` are still stubs.
14. **Ports.** Following the orchestrator's assignment, web shots ran on `--serve 1748`. Scratch theme reviews ran on 1749.

## Requests

- **WP7b (`Menu`, `Select`/`Combobox`, `Popover`, `Tooltip`).** Floating content is portalled to `<body>` at `--z-menu`
  (50) or `--z-popover` (40). Both are below `--z-dialog` (60) and `--z-palette` (70). A menu, select listbox or popover
  opened inside a `Dialog` or `Sheet` therefore renders behind the dialog box and its backdrop, and a click lands on the
  backdrop. This affects onboarding's selects (WP12c), the note editor's pickers (WP11d) and the side-pane sheet (WP11b).
  It showed up here as a palette scope menu that could not be clicked. Suggested fix: floating content opened from inside
  a dialog layer stacks above that layer, for example `z-index: calc(var(--z-palette) + 1)` while a modal is open, or by
  taking the layer of the trigger's dialog. The palette's local rule (deviation 12) can then go.
- **WP12b (`settingsMeta`).** Please make `label`, and `description` if you add it, localisable: an i18n key string such
  as `settings.fields.showPageFrame.label`, a getter, or a function. The palette translates the first and calls the
  other two. A static English string would show English in the Arabic UI.
- **WP11c (`history.load()`).** The palette calls it every time it opens. It should fill `history.entries` and tolerate
  a call while a load is in flight. The palette sorts entries newest first itself.
- **WP9a (`player.setReciter(id)`).** The palette marks the current reciter with `settings.value.reciterId`. Please
  persist the choice there, as the dock's ReciterPicker will.
- **WP8e / WP9a / WP11c / WP9b (shortcut definitions).** The palette lists your definitions with their labels and keys and
  runs `run(e)` with a synthetic `keydown`. That event has `key`, `code` and the modifiers, but its `target` is `null`.
  Use the stores (`reader.actionTarget`, `document.activeElement`), not `e.target`, to find what a command acts on.
  Give definitions that only make sense in a state a `when()`; the palette hides them while it is false.
- **Lead.** Fold deviations 1–13 into §9.7: the Search group, the scope chip and prefixes, the empty-query order, setting
  choices, the matching rules and the row layout.

# WP10b deviations (Search UI)

Delivered:

- `src/lib/stores/search.svelte.ts`: the §7.3 search store (debounced query, scope, mode, filters, results, the active
  hit, F3 stepping, history, word completions, re-runs).
- `src/components/search/**`:
  - `SearchPanel`, `SearchResults`, `ResultGroup`, `ResultItem` and `ScopePicker` (the wave-0 files);
  - `FilterPicker`, `IdleState` and `InstallCard` (panel parts);
  - `window.ts` (word windows) and `open.ts` (the reader-backed hit opener).
- `src/lib/ipc/mock/handlers/search.ts`: `search_query`, `search_suggest` and `search_history_*` over the fixtures, with
  a synthetic fallback.
- `src/lib/i18n/{en,ar}/search.ts`: 68 messages (3 of them plurals, all six Arabic categories).
- `tests/e2e/scenarios/S19.mjs`.

Tests:

- **Unit** (`vitest --project unit`):
  - `src/lib/stores/search.test.ts` (24), against the mock with scripted answers: the debounce and the request, late
    answers dropped, stale results, references, scopes and the translation pack, filters, the mode, deep navigation,
    the opener and F3 wrap-around, history recording, submit, re-runs keeping the active hit, notes re-runs, errors and
    Retry, completions, clearing the history.
  - `src/lib/ipc/mock/handlers/search.test.ts` (26): validation, both corpora (the exported one, and the synthetic one
    by hiding the fixtures), fixture answers cut to the limit, typos, phrases, modes, filters, word mapping, translation
    and note snippets, suggest, history, helpers.
  - `src/components/search/window.test.ts` (11): the word window and line fitting.
- **Browser** (`vitest --project browser`): `src/components/search/SearchPanel.browser.test.ts` (17), in the real `App`
  on the mock.
  - 2,000 hits scrolled to the end with fewer than 60 rows mounted, and the sticky header checked halfway and at the
    end.
  - Keyboard: ↓, End, PageUp, Home, ↑ to the field, type to search.
  - Word windows: at most three lines, marks, fades, "+2 more".
  - Opening hits: the search-hit layer; Enter, Shift+Enter and F3 with the list following; `Mod+Enter`, middle
    click; the hit menu.
  - Controls and the §9.8 states: the filter and mode controls, scopes and the install card, completions, `Mod+F`,
    the empty, no-match, error, typo, truncated and reference states.
  - The Arabic UI.

## Deviations from ARCHITECTURE.md

### 1. Store API beyond §7.3 (all additive)

- **State:** `error` (the `IpcError` of a failed search).
- **Derived:**
  - `activeHit`, `layout` (the Mushaf style's layout; hits carry its page numbers) and `trimmed`;
  - `translationPacks` (installed translations: `settings.translations` first, then recommended, then the UI
    language, then by title);
  - `needsPack` (Translation scope with nothing installed);
  - `references` (the query read as "2:255", "p 262", "j 15" or a bare number);
  - `request` (what a search would send, or null);
  - `stale` (the results answer an older request).
- **Methods:**
  - `setScope`, `setMode`, `setFilters({ surah?, juz? })`, `clearFilters`;
  - `searchFor(query, scope?)` (examples, recent searches, `NavTarget::Search`);
  - `useHistory`, `useSuggestion`, `loadHistory`, `defaultPack`;
  - `openInPane(hit)`, `setOpener(opener)`.
- **Signatures:** `move(±1, { focus })`, `submit(direction)` and `openHit(hit, { focus })` take options.
- **Exports:** `HitOpener`, `hitKey`, `requestKey`, `SEARCH_MODES` and the constants (`SEARCH_DEBOUNCE_MS`, `SEARCH_LIMIT`,
  `HISTORY_LIMIT`, `SUGGEST_LIMIT`, `MODE_STORAGE_KEY`).

### 2. Opening hits without importing the reader (§7.2)

- The store is L1 and must not import the reader (L2). It opens hits through an injected `HitOpener`.
- `src/components/search/open.ts` implements the opener. `SearchPanel`'s module script installs it; the shell's
  `Sidebar` imports the panel statically, so F3 works from startup, whichever tab is open.
- Without an opener (unit tests), hits open through `ui.navigate({ type: 'ayah' })`, without word highlights.

### 3. What opening a hit does (§1.5, §7.4)

- The opener shows the reader and calls `reader.goToAyah(id, { select: true, highlightWords, flash, focus })`.
- `flash` is set only for hits without words (translation, notes). WP8e asked for `flash: true`, but the search-hit
  layer already pulses twice on arrival (§8.7), and a flash over the selection ring and the pulse was busy.
- `focus` is true for a click, Enter on a list row, and F3 from the reader.
- `focus` is false for Enter, Shift+Enter and F3 in the search field: the field keeps focus, and Enter steps through
  the hits like a find bar. These steps are announced: "Result 3 of 45: Al-Baqarah 2:255".
- Opening a hit in the side pane (`Mod+Enter`, middle click, the menu) uses WP11c's `openPaneFor`. Note hits open on
  the Notes tab.

### 4. References instead of searching digits

- A Quran query that parses as a reference or a bare number (`parseReference(q, { names: false })`) is not sent to the
  engine; the Quran text holds no digits.
- The panel offers the jump instead ("Go to Al-Baqarah 2:255"). Enter opens it through WP10a's `openTarget`. An
  out-of-range reference shows the reason, disabled.
- Translation and notes searches still run for such queries, with the jump above their results.

### 5. Word window (§9.7)

- **The window.** ±12 words around the first match is the maximum.
- **Fitting.** With the list's measured width, words are measured with a canvas in the Quran font (cached per word,
  re-measured when fonts load). The window is fitted to **three lines**, keyword-in-context style:
  - the words before the match take at most 40 % of the first line;
  - the words after it fill the lines;
  - an ayah that fits whole shows whole.

  Rows are never taller than three lines and the match is always on the first line. At ±12 words, a long hit took
  five lines in a 300 px sidebar.
- **Cut edges.** The word at a cut edge fades over 24 px (`mask-image` on that word, set `inline-block`). It is never
  an ellipsis.
- **"+N more".** The chip counts the matches outside the window ("+2 more in this ayah", "+2" below 210 px).

### 6. Scope picker (§9.7 "Quran | Translation ▾ | Notes")

- The ▾ is a `Select` of the installed translations under the `Segmented`. It shows only in the Translation scope with
  a translation installed. `Segmented` has no per-option menu.
- Below 276 px the scope options show icons only, with the label as the tooltip and accessible name. The full-width
  `Segmented` gives each option the same width, so "Translation" clipped (see the WP7b request).

### 7. Mode and filter controls

- The mode menu is a `Menu` of radio items. Its button's tooltip explains the current mode. The last mode is
  remembered in `localStorage` (`qd.search.mode`; a per-machine convenience, since `Settings` has no field for it).
- **FilterPicker** limits the search to one surah or one juz. The engine also takes both, and the store supports both,
  but the UI sets one at a time.
  - It is a popover with a field and a listbox: "All surahs", a 6-column juz grid, then 114 surahs.
  - It filters by name in either script (`parseReference`), by number, and by `j 15`.
  - ↑/↓, ←/→ in the grid, Enter.
- Each surah header has an "Only in Al-Baqarah" button. It shows on hover, over the Arabic name.
- The truncated notice's "Filter by surah" opens the picker.

### 8. Additions in the panel

- **Word completions** (the store's `suggestions`, from `search_suggest`): chips under the field for the word being
  typed, with ayah counts. They are not shown in the Translation and Notes scopes, after a space, or in Contains mode.
- **Recent searches** in the empty state: 6 of the 12 loaded. Each shows its scope; a click runs it again in that scope.
  "Clear" calls `search_history_clear`, restoring the list if that fails.
- **Examples** are captioned cards: "الرحمن · Quran", "mercy · Translation", "2:255 · Reference". "mercy" switches to
  the Translation scope, so the install card shows when no translation is installed.
- **No matches** gets a body per scope and actions: Smart mode, translations or the Quran text, all surahs.
- **Errors** show inline, with `errors.<kind>` and Retry. A search error raises no toast.
- **Note hits** show the note's title (from `library.notes`) above the snippet.

### 9. Results list

- **Sticky header.** virtua positions items absolutely, so `position: sticky` cannot work. The header of the group at
  the top is an overlay that the next header pushes up.
  - It uses `--surface-chrome`, with a backdrop blur under vibrant chrome, and is opaque under reduced transparency.
- **Keyboard.**
  - One Tab stop, kept mounted (`keepMounted`).
  - Focus moves to far rows once they mount. Keys pressed meanwhile count from the pending row.
  - Home/End, PageUp/PageDown (6 hits), F3, Shift+F10 and the Menu key work in the list. Typing continues in the field.
- **Following the active hit.** The active hit scrolls into view clear of the sticky header. A group's first hit
  brings its header along.
- **Scroll position.** Leaving the Search tab and coming back returns to the same scroll offset, per results object.
- **No `scrollTo(0)` on mount.** virtua's `scrollTo` keeps correcting until rows are measured, which pulled a list the
  user had already scrolled back to the top.
- **Count line.**
  - "N results in M surahs · T ms". The surah count is left out when the list is truncated: the groups then cover
    only the returned hits.
  - The milliseconds use `Intl` unit formatting ("٢ ملي ث").
  - The line is a `role="status"` region that stays mounted, so the count is announced.
- **Class names.** Hit rows are `.result`; marks are `<mark class="hit">` as §9.7 names them.

### 10. History and re-runs

- A query is recorded once per (query, scope): on Enter, or when a hit of it opens. F3 stepping records nothing
  more.
- Searches run again when:
  - the Mushaf style changes the layout (page numbers);
  - `user-data-changed` reports `notes` in the Notes scope;
  - the searched translation is removed (the scope moves to another installed one);
  - the first translation is installed while the Translation scope waits for one.
- A run of the same query, scope, mode and filters keeps the active hit.

### 11. Browser mock (`handlers/search.ts`)

- **Fixture answers.** A request matching one of the manifest's queries is answered with the real engine's
  `search/results/{slug}.json`, cut to the limit and re-paged for the layout. The manifest's `queries` are
  `{ slug, request }` objects (WP1b), read through a type guard, since `FixtureManifest.queries` is typed `string[]`.
- **Ad-hoc Quran search** over `search/ayahs.json`, following WP1b's rules:
  - phrases, with typographic quotes and guillemets;
  - the prefix on the last token, also inside an unterminated quote;
  - the typo fallback, nearest tier only;
  - the `count` semantics of groups;
  - word mapping, and substring across words.
- **Exact mode** folds like Smart: the mock has no strict column.
- **The vocabulary** is built from all ayahs (ayah counts), rather than from `vocab.json`'s top 2,000. Completions and
  typo checks then also know the rare words.
- **Words of hits:**
  - the exported Hafs pages first, then the ayah windows;
  - otherwise the loose text, grouped into the Uthmani words: `يا`/`ها` particles join the next word (`يا ايها` →
    one word) and `ما` the previous one (`بعد ما`), else an even split.
- **Translation scope:** the text `translation_get` serves (fixtures or WP11a's synthetic text). A pack that is not
  installed is `not_found`. Snippets are built in the mock.
- **Notes scope:** the `user` slice (read only), with Markdown reduced to text and the title used when only the title
  matches.
- **Without fixtures,** the synthetic text is searched (the placeholder word everywhere), so the panel still works on
  a fresh clone.

### 12. S19

- **The flow.** `Mod+F` from the reader, typing "الرحمن", the count line and the groups, the Quran font at 22 px.
  Enter opens 1:1: the search-hit layer on the page, the active row, focus kept in the field.
- **Close-ups.**
  - the panel; F3 to 1:3; the scrolled list with its sticky header;
  - the typo banner ("الرحمان");
  - the reference jump ("2:255");
  - the empty panel with the recent search;
  - the Arabic UI in the night theme.
- **Modes.** The scenario runs in mode `both`.
  - Browser mock: port 1744 (orchestrator instruction; `--serve 1744`).
  - Real app: built with `pnpm tauri build --debug --no-bundle` into `C:\qdt\WP10b`, then
    `app-driver.mjs --exe C:\qdt\WP10b\debug\quran-desktop.exe --only S19`. It passes against the Rust engine and
    the qdc core.db: "45 results in 17 surahs · 4 ms", the typo fallback, the Uthmani word windows and the page
    highlight.

## Requests

- **WP0C / lead (frozen `src/lib/ipc/mock/fixtures.ts`):** type `FixtureManifest.queries` as
  `{ slug: string; request: SearchRequest }[]` (WP1b's request). The search mock reads the manifest through a guard
  until then.
- **WP7b (`Segmented`):** with `fullWidth`, every option takes the same width (`flex: 1 1 0`), so a long label
  ("Translation", 13 px, plus 2 × 12 px padding) clips once the control is narrower than about 290 px. Sizing options
  as `flex: 1 1 auto` with the label width as the minimum would keep a full-width control legible. The search panel
  works around it by going icon-only below 276 px.
- **WP8e:** opening a hit passes `flash` only for hits without word highlights (deviation 3). No change is needed in the
  reader: F3/Shift+F3 call `search.move(±1)`, which defaults to `focus: true`.
- **Lead:** fold deviations 1–11 into §7.3 (store API), §9.7 (search results) and §5.17 (the search mock).

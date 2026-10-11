# WP11c deviations (library and history stores, library panels, study shortcuts, ayah context menu, user mock)

Delivered (owned):
- `src/lib/stores/library.svelte.ts`, `src/lib/stores/history.svelte.ts` (§7.3).
- `src/components/library/{BookmarksPanel, HighlightsPanel, NotesPanel, HistoryPanel}.svelte` (§7.5, §9.8).
- `src/components/mushaf/AyahContextMenu.svelte` (§10.3).
- `src/lib/shortcuts/study.ts` (§10.1 study rows, `Mod+Z`/`Mod+Shift+Z`, `Shift+F10`/`ContextMenu`).
- `src/lib/ipc/mock/handlers/user.ts` (§5.17, mirroring WP2a deviations 3–14 and WP2b deviations 8–9, 14).
- `src/lib/i18n/{en,ar}/library.ts`.

Created besides (new files nobody else owns; WP11c's, used only by the files above):
- `src/components/library/LibraryItem.svelte`: the shared panel row.
- `src/components/library/PromptDialog.svelte`: the one-line prompt (collection name, bookmark label).
- `src/components/library/library.svelte.ts`: ayah-text previews, jumps, text helpers, per-viewer panel preferences.
- Tests: `src/lib/stores/{library, history}.test.ts`, `src/lib/ipc/mock/handlers/user.test.ts`,
  `src/components/library/library.browser.test.ts`, `src/components/mushaf/AyahContextMenu.browser.test.ts`.

## Deviations from ARCHITECTURE.md

### 1. Library store (§7.3)

- **Mutations never reject.** Every mutation shows a failure with `ui.toastError` (the localised `errors.<kind>`) and
  resolves `null` (or `false`). Callers that `void` the promise (VerseActions) or `.catch(ui.toastError)` it
  (AyahActionBar) both stay correct, and nothing is toasted twice. The placeholder's `Promise<void>` returns are widened:
  `toggleBookmark` / `bookmarkPage` → `boolean | null` (bookmarked now), `moveReadingBookmark` → the ribbon,
  `setHighlight` → the stored row, `clearHighlight` → whether anything was cleared, `saveNote` → the stored note,
  `deleteNote` → `boolean`, `setCollections` → the bookmark, `setTags` → `boolean`, `undo` / `redo` → `boolean`.
- **Serial and after the first load.** Mutations, undo and redo run one at a time in call order, and only after the
  first `loadAll()` settled (the highlight snapshot needs the list). Pressing B twice quickly is two toggles in order.
- **Lists follow the backend.** After every change the store applies the command's answer at once (bookmarks, notes,
  the ribbon) and re-reads the affected lists before the mutation resolves; `user-data-changed` re-reads the named
  lists (30 ms coalescing). Reads are sequenced per list (only the newest applies), and a read that brings nothing new
  keeps the old array, so the highlight layer and the margin marks refresh only when something changed.
- **`marks` is a cache, not state.** `marksFor` answers from a 48-entry LRU keyed by `layout|pages|from-to`, shares
  concurrent requests, and empties the cache before any list it depends on changes (local change or event). It is a
  plain `Map` so no surface can depend on it reactively (HighlightLayer depends on `library.highlights`, as WP8d asked).
  It rejects with the command's `IpcError` and never resolves `null`.
- **`status`** (`idle` | `loading` | `ready` | `error`): the panels show skeleton rows while loading and a "Try again"
  card on error.
- **API additions:** `bookmarkOf`, `pageBookmark`, `highlightAt`, `noteFor(from, to)` (the note to edit for a target),
  `collection(id)`, `tag(id)`, `deleteBookmark`, `setBookmarkLabel`, `deleteHighlight`, `toggleCollection(ayahId,
  collectionId)` (creates the bookmark when the ayah has none), `createCollection`, `renameCollection`,
  `deleteCollection`, `createTag` (get-or-create); `HIGHLIGHT_COLORS`, `UNDO_DEPTH`, `LIST_LIMIT`, `MARKS_CACHE_SIZE`;
  types `AyahSpan`, `ListKind`, `LoadStatus`, `UndoEntry`.
- **`notedAyahs`** holds every ayah a note covers (the placeholder held only each note's first ayah).
- **The reading bookmark** comes from the bootstrap and from this store's own moves. When `user-data-changed` names
  `reading_bookmark` (another surface moved it), no command reads the ribbon alone, so the store asks `user_marks` over
  the whole Quran for `readingAyahId` and derives the page in the stored layout (else v2).

### 2. Undo (§7.3)

- **Covered beyond the list in §7.3:** page bookmarks, bookmark delete and label edits, deleting one highlight row (the
  Highlights panel), note create (undo deletes it, redo restores it) and note edits (undo writes the previous version).
  Collection and tag creation and deletion are not undoable (there is no restore command); deleting a collection asks
  first.
- **Highlight undo keeps ids and tags.** Undo of a set clears the range, then re-applies each snapshot row with
  `highlight_restore` (a row the set tombstoned comes back with its id and tags) and, when the row is still live (it was
  trimmed or split), `highlight_set` over its full range (which merges the pieces back into the surviving id). The same
  protocol undoes a clear. Redo re-snapshots before setting again, so undo after redo is exact too.
- **No-op changes make no entry:** setting a colour that already covers the span toasts "… is already highlighted
  yellow"; clearing a span without highlights toasts "… has no highlight"; moving the ribbon onto itself toasts "The
  reading bookmark is already at …".
- **Toasts.** Every change toasts its own name with Undo (`ui.toastUndo`); the toast's Undo reverts exactly that entry
  (it is always the newest). Undo then toasts "Undone: …" with Redo, redo toasts "Redone: …" with Undo, and an empty
  stack toasts "Nothing to undo" / "Nothing to redo". An undo that fails drops its entry (its state is unknown).

### 3. History store (§7.3)

- Additions: `status`, `hasMore`, `loadingMore`, `loadMore()` (pages of 100 with `before_id`).
- Entries load on demand (the History panel's first paint) and, once loaded, follow `user-data-changed` with `history`
  by re-reading as many entries as are shown (at most 1,000).
- `record()` and `setPosition()` are background writes: they log failures and never toast or reject. `setPosition`
  applies the position locally at once (`updatedAt` stamped). `clear()` toasts "History cleared"; the panel confirms
  first.

### 4. Study shortcuts (§10.1)

- **Registration.** `AyahContextMenu` (mounted once by the App) registers `studyShortcuts` in `onMount`: no store may
  import `reader` (library is L1), and an `$effect` would depend on the registry it writes.
- **Span.** Highlights, notes and copies act on the selection when the action target lies inside it, else on the
  target ayah; B and Shift+B take the target ayah itself. `reader.actionTarget` is read as an ayah id.
- **`Mod+C`** runs only with an ayah selection and no native text selection (then the browser's copy and the Mushaf's
  copy handler, §8.14, win).
- **`Enter`** opens the side pane on its current tab (selecting the target unless the selection holds it).
- **Ids:** `study.*`, plus `app.undo` / `app.redo` (group `app`, scope `reader`, so text fields keep their own undo).
- Exports shared with the menus: `targetAyah`, `targetSpan`, `spanAround`, `spanLabel`, `copySpan` (modes `format`,
  `withReference`, `arabic`, `withTranslation`, `reference`), `menuAnchor`, `openMenuForTarget`, `openPaneFor`,
  `editNoteOn`, `studyKey`.

### 5. Ayah context menu (§10.3)

- Bookmark and "Move reading bookmark here" act on the span's first ayah (as the action bar does).
- Highlight ▸ is a radio group with the five swatches (the current colour checked when it covers the span) and Remove;
  hints come from the registry (`1`–`5`, `0`), so they follow the user's keyboard layout.
- Add to collection ▸ lists the collections as checkboxes (the bookmark is created when the ayah has none) and "New
  collection…" opens a name prompt that creates the collection and adds the ayah.
- **Repeat ▸ Custom…** opens a small dialog here (each ayah and, for a selection, the whole selection: 1, 2, 3, 5, 7, 10
  or ∞), which plays through `player.playRange`. WP9a's RepeatPopover has no API another package can open.
- Copy ▸: "Arabic with reference" forces the reference on (in the user's reference style), "Arabic only" drops it, "With
  translation" is `Mod+Shift+C`, "Reference (2:255)" copies the reference alone in the user's reference style.
- Translation · Tafsir · Word by word are three rows; each selects the ayah (unless the selection holds it) and opens
  the side pane on that tab.
- Memorize ▸ "Hide from here" hides the selection, or from the ayah to the end of its surah.

### 6. Panels (§9.8)

- **Rows** (`LibraryItem`): a 28 px mark, the title, the opening of the ayah in Quran text (`quran_get_ayahs`,
  fetched lazily for rows near the viewport and batched into windows), the meta line and chips. The Quran line is one
  line, faded over its last 24 px (never an ellipsis inside a word, §9.3); highlights tint it with the highlight's
  colour. User text (labels, note titles) sits in `<bdi>`; note excerpts are `dir="auto"` plain text (the Markdown is
  never rendered in a panel). Meta parts never break inside themselves.
- **Interaction:** one roving tab stop per list (WP10a's `rovingKeydown`); a character typed on a row goes to the
  filter (WP10a's `typeIntoFilter`); Enter/click open; middle click opens the side pane (§10.2; the middle press never
  starts the browser's autoscroll); right-click, Shift+F10, the Menu key or the hover "More" button open the item menu;
  Delete removes (undoable).
- **Bookmarks:** filter, sort (most recent / Mushaf order), collection chips (right-click: rename, delete), the reading
  bookmark card on top. Menu: Open · Open in side pane · Edit label… · Collections ▸ · Collections and tags… · Delete.
- **Highlights:** filter, colour chips with counts, groups per surah (rosette, name, Arabic name). Menu: Open · Open in
  side pane · Colour ▸ · Tags… · Remove highlight.
- **Notes:** search over titles, bodies, references and surah names; tag chips; "New note" on the action target. Click
  shows the note's ayahs with the side pane's Notes tab; double-click or Edit opens WP11d's editor. Menu: Open · Edit… ·
  Tags… · Delete.
- **History:** days (Today, Yesterday, weekday, date), mode marks (read, listened, memorized), the time of day, the
  page on screen marked with the accent bar, paging on scroll, and "Clear history" with a confirmation.
- **Empty states:** exactly §9.8's copy, with the key interpolated from the registry ("Press B on any ayah", "N to add a
  note"), the five coloured keys under "1–5 to highlight". With nothing stored the filters are hidden.
- **Pickers:** "Collections and tags…" (bookmarks) and "Tags…" (highlights, notes) open a popover hosting WP11d's
  `CollectionsPicker` / `TagPicker`; their `onchange` goes to `library.setCollections` / `library.setTags` (undo,
  toasts).
- **Per-viewer preferences** (sort, collection and colour filters) are kept in `localStorage` key
  `qd-library-panels-v1` (try/catch; the panels work without it).

### 7. User mock (§5.17)

- Mirrors WP2a and WP2b as written in its header: target-keyed bookmarks, toggle revival, tombstones and restore rules,
  highlight trim/split/merge (the left piece keeps the id) and `highlight_clear_range` answering rows as they were, text
  and colour normalisation and limits, list orders and `limit = 0`, get-or-create tags, history merging (10 min), the
  10,000 cap and the 1,000 page cap, the backup path rules, and the `user-data-changed` kinds of WP2a deviation 14.
- **Transactions:** a mutation works on a copy of the slice and replaces it only on success, so a rejected command
  changes nothing and emits nothing.
- Collections and tags are removed on delete (there is no restore command), and their memberships and links go with
  them; restored bookmarks, notes and highlights drop links to tags or collections deleted meanwhile.
- `user_marks` also validates the layout and every page (1–604).

## Requests

- **WP8e (reader):** keep `reader.actionTarget` an ayah id (§8.15); the study shortcuts and the context menu derive the
  span from `reader.selection`. Call `history.setPosition(…)` (debounced 1 s) and `history.record(…)` (3 s dwell) from
  the reader. The panels jump with `reader.goToAyah(id, { flash: true, focus: true })` (notes add `select: true`) and
  `reader.goToPage(p, { push: true, transition: true })`; until those are implemented a click in a panel does not move
  the page.
- **WP11d (note editor, pickers):** `library.saveNote(input)` resolves the stored note, or `null` after it has toasted
  the error (keep the draft then); it records the undo entry itself (create and edit). Pickers report through
  `onchange` only: the panels call `library.setCollections` / `library.setTags`, which toast and undo. For creating,
  `library.createCollection(name)` and `library.createTag(name)` (get-or-create) keep the store current.
- **WP8c (MarginMarks):** `library.marksFor(layout, [page], first, last)` is cached and shared with HighlightLayer;
  using it instead of calling `user_marks` directly would halve the marks queries per page.
- **WP4d:** the listening history written by the audio glue reaches the History panel through `user-data-changed`
  (`history`), as WP2b also asked.
- **Lead:** fold deviations 1–7 into §7.3, §9.8 and §10.3; the WP8d wave bridges 1 and 2 (selection, marks) can go
  once WP8e lands, since `library.marksFor` now resolves the marks.

## Acceptance (§14.3)

- `pnpm exec vitest run --project unit src/lib/stores/library src/lib/stores/history`: 2 files, 25 tests pass.
- `pnpm exec vitest run --project browser src/components/library src/components/mushaf/AyahContextMenu`: 2 files,
  19 tests pass (including "typing b in the open menu moves to Bookmark and does not bookmark").
- Also: `pnpm exec vitest run --project unit src/lib/ipc/mock/handlers/user` (26 tests, with a randomised model check
  of the highlight invariant); the whole unit project (59 files, 2,069 tests) passes.
- Real app (`C:\qdt\WP11c\debug\quran-desktop.exe`, app-driver with a scratch scenario): the four panels list what the
  real `user_library`/`user_study` commands wrote (the lists follow `user-data-changed`), the reading bookmark follows
  an external move, the context menu opens on 2:255 and the page marks agree.
- `pnpm check` (0 errors, 0 warnings), and ESLint, Prettier and `check-logical-css` on every file above are clean.

## Notes for the lead

- Running the whole browser project, six tests of other packages fail: HighlightLayer's audio tint and glide and
  TranslationView's recitation verse (they set `player.snapshot`, while WP9a's rewritten player derives `isActive` from
  its own `status`), and three WP8d dwell tests that pass when `src/lib/mushaf/interactions` runs alone (load-sensitive
  timing). None touches WP11c's files.

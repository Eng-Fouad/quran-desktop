# WP11d deviations (note editor, Markdown subset, collections and tag pickers)

Delivered (owned, §14.3):
- `src/components/dialogs/NoteEditorDialog.svelte`: the note editor (dialog, narrow-window sheet, and the side pane's
  compact mode).
- `src/lib/text/markdown.ts`: the escaping Markdown subset renderer, plus the editor's text commands.
- `src/components/library/{CollectionsPicker, TagPicker}.svelte`.
- `src/lib/i18n/{en,ar}/notes.ts` (79 keys; every Arabic plural has the six categories).

Created besides (new files nobody else owns; WP11d's):
- `src/components/dialogs/NoteEditorFields.svelte`: the fields shared by the dialog, the sheet and the compact editor.
- `src/components/dialogs/NoteInline.svelte`: the compact editor (rendered by `NoteEditorDialog` with `compact`).
- `src/components/dialogs/noteEditor.svelte.ts`: the working copy (`NoteDraft`), the session (`NoteSession`), draft
  keys and envelopes, the editor's chords and `applyToTextarea`.
- `src/components/library/NoteBody.svelte`: a rendered note body (usable by any surface that shows a note).
- `src/components/library/ChecklistPicker.svelte`: the shared body of the two pickers.
- Tests: `src/lib/text/markdown.test.ts`, `src/components/dialogs/noteEditor.test.ts` (unit);
  `src/components/dialogs/NoteEditorDialog.browser.test.ts`, `src/components/library/pickers.browser.test.ts`
  (browser).

## Deviations from ARCHITECTURE.md

### 1. The Markdown subset (§3.2 `note.body`, §7.6) — the spec names it but does not define it

- **Blocks:** paragraphs (blank lines separate them; a single line break is kept as `<br>`, since notes keep their
  lines), headings `#`/`##`/`###` (deeper read as `###`) rendered as `h2`/`h3`/`h4`, bullet lists (`-`, `*`, `+`),
  numbered lists (`1.`/`1)`, Arabic-Indic digits too), task items (`- [ ]`, `- [x]`, shown as ☐ / ☑), nesting by
  indenting under the item (two spaces are enough, as people type it), quotes (`>`, holding any block, with lazy
  continuation). Only a bullet or a list starting at 1 interrupts a paragraph ("The year\n1999. was" stays text).
- **Inline:** `**strong**`, `__strong__`, `*em*`, `_em_` (CommonMark flanking rules: no `_` emphasis inside words),
  `==highlight==` (`<mark>`), backslash escapes. Everything else, HTML included, is escaped text.
- **Ayah references:** bare `2:255`, `2:255-257` (`-` or `–`, ASCII or Arabic-Indic digits) and `[label](2:255)` become
  `<a data-ref="s:a[-b]">` only when the surah has those ayahs (the 114 ayah counts are embedded; their sum, 6,236, is
  tested); `12:30:45`, `v1.2:3` and `1:8` stay text.
- **Web links** `[label](https://…)` and `<https://…>` are rendered as text, "label (url)": the §7.6 allowlist has no
  `href`, and a note must never navigate the webview. `NoteBody` then turns `https://` addresses into links that open in
  the system browser through `system_open_external`.
- **Not in the subset** (no tag for them in the §7.6 allowlist): code spans/blocks, strikethrough, rules, images,
  tables. They stay literal text.
- The output uses only tags of the §7.6 `ALLOWED_TAGS` and no attribute but a validated `data-ref`; the unit test checks
  that, and that DOMPurify (`sanitize`) leaves the output unchanged. Notes render only through `SafeHtml` (the single
  `{@html}` site). Nesting is capped at 8 levels; links and autolinks are matched in one pass, so 100,000-character and
  pathological bodies render in milliseconds (tested).
- **API** beyond the placeholder's `renderMarkdown(source)`: `renderMarkdown(source, { refs })`, `parseMarkdown`,
  `renderBlocks`, `markdownToText`, `orderedListStarts`, `escapeHtml`, `ayahCount`, `digitsValue`, `MARKDOWN_TAGS`,
  `MAX_DEPTH`, and the editor commands `toggleInline`, `toggleLines`, `continueList`, `applyEdit` (`TextEdit`).

### 2. `NoteBody` finishes the sanitised DOM

DOMPurify keeps no attributes, so after each render `NoteBody` sets, from validated values only: `dir="auto"` on
paragraphs, headings and list items, and an explicit `dir` from the first strong character on lists and quotes
(`dir=auto` on a container skips children that carry their own `dir`); `<ol start>` from the parsed list numbers; and
`https://` links. References call `onref(fromAyahId, toAyahId)`, by default `reader.goToAyah(id, { flash: true })`
(no selection or focus change).

### 3. The note editor (§7.4, §10.1 Escape row, §9.5)

- **Draft autosave** (`ui.setDraft`, 400 ms after the last edit and at once when the editor goes away): key
  `note:<id>` or `note:new:<from>-<to>`; the value is a JSON envelope `{ v: 1, title, body, tagIds }` (a bare string
  is read as a body). A draft equal to the saved note is never kept. "Dirty" compares the way the backend stores a note
  (one-line trimmed title, body without line-ending/edge-whitespace differences, tags as a set).
- **Closing:** Escape, the close button, Cancel and a click outside all go through one path. It asks "Discard note?"
  (danger, focus on Cancel) only when unsaved body text would be lost, as §10.1 says; a title-only or unchanged editor
  closes at once (and drops its draft). The question is the `confirm` overlay, which covers the editor: cancelling it
  brings a fresh editor back on the draft with the same caret, scroll and Write/Preview view and no "restored" notice
  (`resumeMemory`). An editor closed from outside (another overlay replaced the stack, `closeOverlays`) keeps its
  draft, and reopening says "Unsaved draft restored · Revert". An editor that goes away writes only edits it made
  itself: answering Discard can show the uncovered editor for a moment before the covered one discards the draft (in
  dev builds `await` takes extra microtasks), and that editor must not write the draft back as it leaves (CI fix).
- **Saving** (`Mod+Enter`, also `Mod+S`) goes through `library.saveNote` (toast with Undo); a failure keeps the editor
  open with its draft. A saved note with no changes just closes (no write, no undo entry). Delete (saved notes) uses
  `library.deleteNote` without a confirmation: the toast's Undo restores it, as in the Notes panel.
- **Tags** chosen in the editor are saved with the note (one "Saved the note" undo entry) rather than through
  `library.setTags`.
- **Layout:** a 620 px dialog (between §9.5 md and lg) with the ayah quoted on top (Quran font, two lines, the cut line
  fading out over 24 px at its end, §9.3); below 720 px of window width a full-height sheet from the inline end whose
  writing area fills the height. The title and the writing area sit on `--surface-page` (one sheet to write on).
- **Writing:** a toolbar (bold, italic, highlight, heading, bullets, numbers, quote, insert the note's reference) that
  is one tab stop with arrow keys, a formatting-help popover rendered with `NoteBody`, `Mod+B`/`Mod+I`, and Enter that
  continues a list or quote (or ends it on an empty item). Commands go through `document.execCommand('insertText')`
  so Ctrl+Z undoes them like typing (direct replacement where that is unavailable). The editor's chords use the §7.7
  hybrid matching and stop at the editor, so the reader's `Mod+B`/`Mod+I` never fire while typing.
- A `noteId` that no longer exists opens a new note on the given range with a notice.

### 4. Compact mode (§9.7 side pane, Notes tab) — the contract for WP11b

`<NoteEditorDialog compact noteId={…} fromAyahId={…} toAyahId={…} />`, one note per instance (the component re-keys
on the target). A saved note shows as a card (title, rendered body, tags, "Edited …", Edit and Delete); double-click,
Enter or F2 on the card, or Edit, opens the fields; a range without a note shows the composer directly. Save returns to
the card (after saving a new note the instance follows the saved note even if `noteId` is not updated); Cancel/Escape
return to it, asking first like the dialog. The pane never takes the focus by itself.

### 5. Pickers (§7.9)

Both are a filter field over a checkable list (ARIA combobox + multi-select listbox; `ChecklistPicker`): accent-,
case- and harakat-insensitive filtering (prefix matches first), ↑/↓ and Enter (Enter after a filtered pick clears the
field for the next one), a "Create “name”" row when nothing has that name (`library.createTag` get-or-create,
`library.createCollection`), counts (bookmarks per collection, uses per tag), colour dots. Escape clears a typed filter
without closing the enclosing popover (it stops there), then closes it. The tag picker shows the chosen tags as chips
(× and Backspace remove). They report through `onchange` only and show the new choice at once until `selected`
catches up (or for 4 s, when the change failed and was toasted by the library).

## Requests

- **WP7b (primitives):**
  1. Floating layers opened inside a `Dialog`/`Sheet` render under it: `Popover` is `z-index: --z-popover` (40),
     `ListboxItems`/`MenuItems` `--z-menu` (50), dialogs `--z-dialog` (60), and bits-ui copies the content's z-index to
     the floating wrapper. The note editor raises its own popovers (`.note-popover`, `--z-dialog + 1`); a Select or Menu
     inside a dialog (onboarding?) is probably hidden today. Suggested: a `layer` prop or a context set by
     `Dialog`/`Sheet` that lifts floating content above it.
  2. `Tooltip` does not pass a `tabindex` to `Tooltip.Trigger`, so `IconButton`'s own `tabindex` is overridden to 0;
     the note editor keeps its roving tab stop on the DOM in an effect meanwhile. Suggested: forward `tabindex`.
  3. `Sheet` has no `onEscapeKeydown`/`dismissible` (Dialog has); the editor does not need them (it routes every close
     through `onOpenChange`), but parity would help.
- **WP11b (side pane):** the Notes tab can embed the compact editor as in §4 above (`noteId` from
  `library.noteFor(from, to)`, or one per note when several cover the ayah).
- **WP9b:** a `prettier --write` of `src/components/dialogs/*.svelte` during this package's formatting pass also
  reformatted `src/components/dialogs/SelfTestDialog.svelte` at 12:03 (whitespace and line breaks only, no content
  change). Sorry; please re-run Prettier on it if it was mid-edit.
- **Lead:** fold §1–§5 into §3.2/§7.6 (the subset), §7.4/§10.1 (editor behaviour) and §9.7 (compact mode).

## Acceptance (§14.3)

- `pnpm exec vitest run --project unit src/lib/text/markdown`: 1 file, 28 tests pass (with the unit test of the draft
  model, `src/components/dialogs/noteEditor`: 2 files, 36 tests).
- `pnpm exec vitest run --project browser src/components/dialogs/NoteEditorDialog src/components/library`: 3 files
  pass, 34 tests (WP11c's library panels included).
- `pnpm check` (0 errors, 0 warnings), ESLint, Prettier and
  `check-logical-css` clean on every file above.
- Real app (`C:\qdt\WP11d\debug\quran-desktop.exe`, app-driver with a scratch scenario): a note typed through the editor
  (title, Markdown with list continuation by Enter, a tag created in the picker) is saved into user.db with `Mod+Enter`,
  read back through the real `note_list`, reopened as "Edit note" with its preview (reference link, list), and deleted.
- Visual review in the browser mock (scratch scenarios, `web-shot --serve 1764`): new, typed, preview, tags popover,
  formatting help, discard question, resumed editor, saved toast, edit, paper/sepia/night/black/high-contrast, the
  Arabic UI (mirrored, Arabic and English blocks each in their own direction), the narrow sheet, the Bookmarks
  panel's "Collections and tags…" popover, and the compact editor (paper/night, English/Arabic).

## Notes for the lead

- The whole unit project shows one failure outside this package: `src/lib/testing/qdtest.test.ts` "opens overlays with
  QA defaults" expects the note editor's QA default target to follow `reader.cursorAyahId = 8`, and `reader.actionTarget`
  answers 1 (WP13a/WP8e); no WP11d file is involved.

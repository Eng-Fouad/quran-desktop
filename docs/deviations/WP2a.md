# WP2a deviations (UserDb library: bookmarks, reading bookmark, highlights, notes, collections, tags, marks)

Owned files: `crates/quran-core/src/user_db/{bookmarks, highlights, notes, collections, tags, marks}.rs`,
`crates/quran-core/tests/userlib_{highlights, library, perf}.rs`, `src-tauri/src/commands/user_library.rs`.
The package owns no dictionary or mock files, so it adds no i18n keys. Messages are English and developer-oriented
(§5.2), and the UI localises by `kind`.

## Deviations from ARCHITECTURE.md

1. **Acceptance command syntax (§14.3).** Cargo 1.99 accepts only one `TESTNAME`, so the first acceptance line was
   run as `cargo test -p quran-core --lib -- user_db::bookmarks user_db::highlights user_db::notes
   user_db::collections user_db::tags user_db::marks`. WP2b, WP1a and WP1c report the same issue.
2. **Additive `UserDb` API.** These methods are needed by §5.13 commands that have no §2.2.6 counterpart:
   - `bookmark_toggle_ayah(ayah_id) -> BookmarkToggle`
   - `bookmark_get(id) -> Bookmark` (live only)
   - `highlight_clear_range(from, to) -> Vec<Highlight>`
   - `collection_set_membership(bookmark_id, &[String]) -> Bookmark`
   - `item_tags_set(kind, item_id, &[String])`

   Crate-internal helpers: `note_body_search(title, body)` and the limits `NAME_MAX_CHARS` (100), `LABEL_MAX_CHARS`
   (200), `COLOR_MAX_CHARS` (32), `MAX_LINKS` (100) and `BODY_MAX_CHARS` (100,000). They live in private modules
   because `user_db/mod.rs` belongs to WP2b (see Requests).
3. **Upserts are keyed by target, and "conflict" is `InvalidArgument`.** There is at most one live bookmark per ayah,
   and per (layout, page) for page bookmarks (the unique indexes).
   - `bookmark_upsert` with `id: None` on a target that already has a bookmark updates that bookmark (the input wins:
     label, collections, tags). It does not fail and does not create a duplicate.
   - `bookmark_upsert` with `id: Some` that moves a bookmark onto another live bookmark's target is rejected.
   - `bookmark_restore` is rejected when another live bookmark took the target in the meantime.

   Both rejections use `InvalidArgument`, because `CoreError` (frozen) has no `Conflict` variant. An ayah bookmark
   ignores `layout` and `page` (stored as NULL). A page bookmark needs both, and `page` must be 1..=604.
4. **Toggle revives.** `bookmark_toggle_ayah` on an ayah without a live bookmark revives the most recently deleted
   bookmark of that ayah, with its label, collections and tags. Only when there is none does it create a new one.
   Pressing B twice therefore never loses a label. Undo of toggle-on is `bookmark_delete`; undo of toggle-off is
   `bookmark_restore`.
5. **Tombstone semantics** (bookmarks, highlights, notes):
   - Delete returns the row **as it was** before the delete.
   - Deleting a missing or already-deleted row is `NotFound`.
   - Restoring a live row returns it unchanged. Restoring a missing or purged row is `NotFound`.
   - Restore bumps `updated_at`, so for sync the change is newer than the delete. A restored row therefore moves to
     the top of the recency-ordered lists.
   - `note_get` and every list return live rows only.
   - `collection_delete` and `tag_delete` also tombstone. Their memberships and links stay but are hidden while the
     owner is deleted, and they cascade away when the tombstone is purged (`purge_tombstones`, WP2b).
6. **Highlights also merge same-colour neighbours** (§3.2 asks only for split/trim). The invariant is: live rows never
   overlap, and two live rows of the same colour never overlap **or touch**. The live rows are therefore exactly the
   maximal same-colour runs of what the user sees. The details:
   - `highlight_set` trims, splits or tombstones other colours. When a row is split, the left piece keeps its id and
     the right piece is a new row with the same `created_at` and tags.
   - It merges same-colour rows that overlap or touch into the earliest one. That row keeps its id and gains the
     others' tags; the others are tombstoned.
   - It returns the stored row that covers the input, which may be larger than the input. Painting inside a row of
     the same colour writes nothing.
   - `highlight_clear_range` returns the rows that overlapped the range **as they were** (full range, colour, tags).
     Re-setting them restores the previous state exactly, and so does the §7.3 store protocol (snapshot, then clear,
     then re-set). Both are tested, including a randomised model test (`userlib_highlights.rs`).
   - `highlight_restore` re-applies the tombstoned row on top of the current rows and keeps its id.
7. **Tags.**
   - Names are unique among live tags, ignoring ASCII case (the `tag_name_u` index).
   - Creating a tag (`id: None`) whose name is taken returns the existing tag unchanged (get-or-create), so a picker's
     "create" never fails or overwrites anything.
   - Renaming onto another live tag's name is `InvalidArgument`.
   - `usage_count` counts live items only, and every item's `tag_ids` lists live tags only, by name.
8. **Collections.** Duplicate names are allowed (the schema has no unique name).
   - Order: `sort_key`, then name (case-insensitive), then id.
   - `item_count` counts live bookmarks.
   - Membership sets append new members (`collection_item.sort_key` = last + 1, `added_at` = now), and existing
     members keep their place.
   - A bookmark's `collection_ids` follow collection order.
9. **Text and colour normalisation.**
   - Names, bookmark labels and note titles are single-line: whitespace runs collapse to one space, control characters
     are dropped, and the result is trimmed. A blank optional field becomes `None`.
   - Note bodies: `\r\n` becomes `\n`, control characters other than `\n` and `\t` are dropped, and the body is
     trimmed. A note needs a title or a body.
   - Colours are opaque tokens of at most 32 ASCII letters, digits, `#`, `-` and `_`, such as `teal` or `#2a9d8f`.
     This keeps them safe for a style attribute. A blank colour means none.
   - Id lists are deduplicated (order kept), contain at most 100 entries, and a blank id is `InvalidArgument`.
     Unknown or deleted collection, tag or item ids are `NotFound`, and nothing is written.
10. **Tagging and membership bump the item.** `item_tags_set` and `collection_set_membership` set the item's
    `updated_at`, because the link tables have no timestamps and a sync must see the change.
11. **Lists.**
    - `bookmarks_list` and `notes_list` return the most recently updated first (then id). `highlights_list` is in
      mushaf order. `tags_list` is by name.
    - `limit = 0` returns nothing, the same as the mock's `slice(0, limit)`.
    - `BookmarkFilter.surah` filters on `ayah_id`, so a page bookmark belongs to the surah of its first ayah. An
      out-of-range surah is `InvalidArgument`.
    - `NoteFilter` bounds are optional and validated, and the filter matches notes that **overlap** the range.
    - A filter on a deleted collection or tag matches nothing.
    - The filtered page of ids is chosen first, in a materialised CTE, so the collection and tag subqueries run only
      for the returned rows. On the `userlib_perf` library, `bookmarks_list(200)` has p99 2.5 ms (it was 8.6 ms
      before this change).
12. **`user_marks`.**
    - `reading_ayah_id` is set only when the reading bookmark lies in `[from, to]`, as in the mock; the §3.2 query
      does not filter it.
    - Every page must be 1..=604; duplicates are fine.
    - Highlights and notes keep their full ranges, in mushaf order.
    - Measured on a library far larger than a real one (4,900 bookmarks, 2,000 highlights, 3,000 notes; no ANALYZE):
      p99 0.15 ms for a spread and 0.25–0.9 ms for al-Baqarah, against the 3 ms budget.
13. **The reading bookmark.** An unreadable row (unknown `mushaf_id`, or ayah/page out of range; never written by this
    crate) reads as no reading bookmark and logs a warning, so `app_bootstrap` never fails on it. The next set repairs
    the row.
14. **`UserDataChanged` kinds.** Each kind names a list whose content **or counts** the change can alter:
    - bookmark upsert, toggle, delete, restore → `bookmarks`, `collections`, `tags`
    - reading bookmark → `reading_bookmark`
    - highlight set, clear, delete, restore → `highlights`, `tags`
    - note upsert, delete, restore → `notes`, `tags`
    - collection upsert → `collections`
    - collection delete and membership → `collections`, `bookmarks`
    - tag upsert → `tags`
    - tag delete → `tags`, `bookmarks`, `notes`, `highlights`
    - `item_tags_set` → `tags` plus the item's kind

    Events are emitted after a successful write, including when nothing changed. A failed command emits nothing.
    Reads emit nothing.
15. **Notes FTS.** `body_search` is computed as §3.2 specifies. Tombstoned notes stay in `note_fts` until they are
    purged (an external-content index follows the row, and the row still exists).

## Requests

- **WP1b (`search_notes`):** join `note` and keep `deleted_at IS NULL`
  (`… FROM note_fts JOIN note n ON n.rid = note_fts.rowid WHERE note_fts MATCH ?1 AND n.deleted_at IS NULL …`).
  Otherwise deleted notes show up in search until they are purged after 30 days.
- **WP2b (`user_db/mod.rs`):**
  1. Call `conn.set_prepared_statement_cache_capacity(128)` in `open_checked`. The `user_db` files hold about 85
     distinct `prepare_cached` statements against rusqlite's default LRU of 16. That is correct, but hot paths such
     as `user_marks` (5 statements) are re-prepared after other calls evict them.
  2. Optional: `pub use notes::{BODY_MAX_CHARS, note_body_search}; pub use tags::{COLOR_MAX_CHARS,
     LABEL_MAX_CHARS, MAX_LINKS, NAME_MAX_CHARS};` would make the limits reachable as `quran_core::user_db::*`.
- **WP11c (user mock and library store):** mirror deviations 3–14 in `src/lib/ipc/mock/handlers/user.ts`:
  - target-keyed upserts, toggle revival, and the tombstone and restore rules;
  - highlight merging, and `highlightClearRange` returning the rows as they were;
  - list orders and `limit = 0`;
  - `readingAyahId` only in range (already the case);
  - the text limits and colour tokens;
  - the event kinds above.

  The §7.3 undo protocol works unchanged against the real backend (tested in `userlib_library.rs` and in
  `highlights.rs`).
- **WP11d (pickers, note editor):** creating a tag is get-or-create. Mirror the limits in the inputs: names 100,
  labels and titles 200, body 100,000 characters, colours as tokens.
- **Lead:** fix WP2a's first acceptance line to the `-- <filters…>` form (deviation 1).

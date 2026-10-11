# WP1c deviations (ContentDb, PackDb, timings)

Owned paths: `crates/quran-core/src/{content_db, pack_db}/**`, `crates/quran-core/src/timings.rs`,
`crates/quran-core/tests/{content_db, content_geometry, pack_db, timings_qdc}.rs`, `xtask/src/fixtures/content.rs`.
No public signature of §2.2.7 changed; everything below is either an addition or a decision where the spec is silent.
`lib.rs` (frozen) is untouched, so the additions are reached through their module paths (`quran_core::content_db::…`,
`quran_core::pack_db::…`, `quran_core::timings::…`).

## Deviations from ARCHITECTURE.md

1. **Acceptance syntax.** `cargo test -p quran-core --lib content_db pack_db timings` is rejected by cargo ("unexpected
   argument 'pack_db'": cargo takes one TESTNAME). The equivalent libtest form was run:
   `cargo test -p quran-core --lib -- content_db pack_db timings`. WP2b's acceptance line has the same problem.
2. **New file `content_db/geometry.rs`** (canonical surah geometry): `surah_ayah_ids`, `surah_word_ids`,
   `surah_ayah_count`, `ayah_ref`, `surah_of_word`. §3.3's `wbw` and `tafsir_entry` have no surah column, yet chapters
   are replaced, stamped and cleared per `(pack_id, surah)` (§3.3 `clear_unpinned`). Ayah and word ids are dense and in
   (surah, ayah, position) order (§0.2), so a chapter is one contiguous id range of each, fixed by 114 ayah counts and
   114 word counts (end markers included). The tables are asserted at compile time to total 6,236 / 83,665, and
   `tests/content_geometry.rs` (ignored, `QD_CORE_DB`) checks every surah's word and ayah range and every `ayah_ref`
   against a built core.db: **passed against the qdc core.db on 2026-10-10**. Writers reject rows outside the chapter.
3. **Additive API.**
   - `ContentDb::timing_stamps(reciter: Option<u32>) -> Vec<TimingStamp>` (`timing_file` rows without ayahs: url,
     length, source, fetched_at, word_level, pinned) for WP5e's re-sync, the revalidator and the reciter's real
     `word_level`; `ContentDb::chapter_pack_ids()` (packs that have WBW/tafsir chapters).
   - `PackDb::{path, has_fts, fts_search_in, fts_count, like_search_in, like_count, plain_texts}`. §2.2.5 steps 4 and 7
     need the ayah-id range filter, the `total` count and the `plain` text for Rust-built snippets, which the frozen
     `fts_search(fts, limit)` / `like_search(needle, limit)` cannot express. Those two keep their signatures and equal the
     `_in` variants over `1..=6236`.
   - `PackDb::plain_range(from, to) -> Vec<(ayah_id, plain)>` (entries starting in `from..=to`, by ayah id), answering
     WP1a's request: `quran_copy_text` can append the stored `plain` column (tags stripped, footnote markers removed,
     §3.4) instead of re-deriving it from `html`. `PackEntry` keeps its three fields, so no struct literal or pattern
     elsewhere breaks.
   - `PackDbWriter::set_source_sha256` (§3.4 lists a `source_sha256` meta key that `PackMeta` has no field for; it is
     written as `''` until set). `created_at` is written as Unix seconds. `pack_db::PACK_FORMAT = 1`.
   - `timings::{qdc_file_info, QdcFileInfo, is_word_level}`, `SanitizeReport::is_clean`. `sanitize_qdc` returns no
     `word_level`, so `is_word_level(&ayahs)` is how the adapter fills `StoredTimings::word_level`.
4. **`sanitize_qdc` decisions** (rules 1–7 otherwise verbatim):
   - "words are not valid" (rule 7) = some ayah keeps no usable word after rules 3–5. Then **every** word is dropped
     (ayah-level only, counted in `dropped_segments`), so the output is word-level everywhere or nowhere.
   - Rule 4 when the next ayah does not start later than `from`: `to = from + 1` (as for the last ayah).
   - A row with an unparseable `verse_key` is dropped like a row of another surah; a missing/non-numeric
     `timestamp_from`/`timestamp_to` is `Corrupt`; a word position outside `1..=65535` is a dropped segment.
   - The four counters' exact meaning is documented on `SanitizeReport`.
   - Real responses (Afasy 1 and 2, Dussary 112, Ghamdi 1 ayah-level) all sanitise; Afasy 2: 3 dropped, 286 clamped.
5. **`StoredTimings::to_dto().duration_ms` = max(file `duration_ms`, last ayah end)** (was "file duration, else last
   end"). QDC rounds file durations to whole seconds, so Afasy 1 reports 46,000 ms while 1:7 ends at 46,490 ms.
6. **Pins only go up on writes.** `timings_put` keeps `pinned = 1` (spec); `wbw_put_chapter`/`tafsir_put_chapter` do
   the same for chapter stamps (a revalidation refetch must not unpin an installed pack's chapter). Unpinning is explicit:
   `timings_set_pinned` / `chapters_set_pinned`. `timings_set_pinned(r, s, true)` on missing timings is `NotFound` (a
   pinned file without timings could not play offline); unpinning missing timings is a no-op.
7. **`delete_pack("audio.{source}.{reciter}")`** also deletes that reciter's timings from that source (pinned or not);
   for any pack id it deletes WBW rows, tafsir entries and chapter stamps.
8. **`stale()`** returns items oldest first; chapters are classified by pack-id prefix (`wbw.*`, `tafsir.*`, §2.5.3),
   anything else is skipped with a warning; timings carry `audio.{source}.{reciter}`.
9. **`clear_unpinned`** then compacts the file (`VACUUM` + `wal_checkpoint(TRUNCATE)`, best effort, logged on failure)
   so "Clear cache" frees disk space. `ClearReport::bytes` = payload of the removed rows (TEXT/BLOB octets + 8 bytes per
   INTEGER value), exact and testable.
10. **`open_or_recover`** runs `quick_check` before `PRAGMA optimize`, so nothing is written into a corrupt file.
    Quarantine happens on corruption (`SQLITE_CORRUPT`/`NOTADB`, failed `quick_check`) and on any migration failure
    except environmental SQLite codes (CANTOPEN, READONLY, FULL, IOERR, PERM, BUSY, LOCKED, NOMEM, NOLFS, INTERRUPT):
    renaming would not fix those, so they are returned. Sidecars move to `<quarantined>-wal`/`-shm`/`-journal`; note that
    SQLite itself usually checkpoints or deletes a WAL when the failed connection closes. Logs carry file names only.
    `open` creates the parent directory.
11. **`PackDb::open`** errors: missing file → `NotFound`; no `meta` table (0-byte file, unfinished build) →
    `SchemaMismatch { expected: 1, found: 0 }`; `format ≠ 1` → `SchemaMismatch`; a missing key or an invalid
    kind/dir/tokenizer/normalizer_version → `Corrupt`; not a database → SQLite `NOTADB` (`is_corruption()`). Messages
    carry only the last three path components (`{id}/{version}/pack.db`). The pool is lazy (`min_idle = 0`) after one
    direct validating connection, so a bad file fails fast instead of after r2d2's connection timeout.
12. **`PackDbWriter`** rejects (`InvalidArgument`): a kind other than translation/tafsir, `format ≠ 1`,
    `normalizer_version ≠ NORMALIZER_VERSION` (the `fold` column is built with the current normaliser), an empty
    `pack_id`/`lang`, out-of-range or duplicate entries, translation entries spanning several ayahs, duplicate footnote
    ids; `finish` rejects an empty pack and overlapping ranges. `create` replaces a leftover file (and journals) of the
    same name. Rows are written in one transaction with an in-memory journal; `finish` VACUUMs with `synchronous=FULL`
    so the file is durable before the installer renames it.
13. **`export-fixtures --only content`.**
    - Timings and WBW are keyed by word positions/ids, so they need a built core.db (`--db`). Without one they are not
      exported and the mock's own synthetic generator serves them (it matches the mock's synthetic index; fixtures from
      the real numbering would not). Translations and tafsir never need core.db.
    - Timings are exported for the §4.6 timing surahs (1, 2, 18, 36, 67, 112–114) of every reciter the content.db holds,
      also with a real `--content-db`: a development content.db may cache hundreds of surah files, and each becomes a
      lazily imported Vite chunk. Every other `(reciter, surah)` falls back to the mock's synthetic timings.
    - core.db is read with read-only SQL (ayah word ranges, page word ranges, word `text_hafs`): `CoreDb` has no
      word-text API, and this keeps the exporter independent of WP1a. Every DTO written still comes from WP1c's own API
      (`PackDb`, `ContentDb`, `StoredTimings::to_dto`).
    - Synthetic ids (catalog ids, so the mock's pack list lines up): translations `tr.en.saheeh` (footnote on every 10th
      ayah; "mercy" and "light" each in > 500 rows for the translation search fixtures) and `tr.ur.junagarhi` (RTL);
      pack-DB tafsir `tafsir.ar.muyassar` (RTL, one entry per ayah); content.db tafsir `tafsir.en.ibn_kathir` (groups of
      3 ayahs, `fetchedAt`, `a[data-ref]`); WBW `wbw.en`. Synthetic timings use reciter `Settings::default().reciter_id`
      (7). Translations are exported per `AYAH_WINDOWS` window, tafsir per ayah of the windows, WBW for the words on the
      fixture pages (any layout), split per surah.
    - `--packs <dir>` takes every `pack.db` below `dir` (one per pack id; the last path in sorted order wins);
      `--content-db` must exist (it is not created). Both fail loudly instead of falling back to synthetic data.
    - `write_synthetic_pack(pack_id, path)` is public so WP1b's search exporter can build its `tr.en.*` pack.

## Requests answered

- **WP1a** (expose the pack's `plain` column): `PackDb::plain_range(from, to)` (item 3), tested in
  `tests/pack_db.rs::plain_range_serves_the_stored_plain_text`.
- **WP5a** (`clippy::manual_is_multiple_of` in `xtask/src/fixtures/content.rs`): fixed (`a.is_multiple_of(10)`);
  `cargo clippy -p xtask --all-targets -- -D warnings` is clean for this file.

## Requests

- **Lead:** fix the acceptance line in §14.3 (WP1c and WP2b) to `cargo test -p quran-core --lib -- <filters…>` (or three
  runs, one per filter), and fold items 2–3 into §2.2.7. Only that edit can turn the literal line green: cargo's own
  argument parser rejects a second TESTNAME before any test is built, and `cargo test` cannot be aliased.
- **WP1a (`quran_copy_text`):** `PackDb::plain_range(from, to)` returns the stored plain translation text per ayah.
- **WP5d (qdc_audio, qurancom_tafsir, qurancom_wbw):** read `chapter_id`/`audio_url`/`duration` with
  `timings::qdc_file_info`, then `sanitize_qdc(file, surah_ayah_count)`, `word_level = timings::is_word_level(&ayahs)`,
  `content_length` from HTTP `Content-Length`. Chapter writers validate that rows lie inside the chapter (word ids of the
  surah; tafsir ranges inside the surah, non-overlapping) and return `InvalidArgument` otherwise; `ChapterStamp.sha256`
  is the payload's sha256 and `pinned` only goes up.
- **WP5e (manager):** `timing_stamps(Some(reciter))` gives the real `word_level` and pin state per surah;
  `chapter_pack_ids()` + `chapters(pack)` drive the content re-sync; `delete_pack` also clears a recitation pack's
  timings; `clear_unpinned` already compacts content.db.
- **WP1b (search_pack):** use `PackDb::{fts_search_in, fts_count, like_search_in, like_count, plain_texts, has_fts}`;
  `like_*` expects a needle already folded like the pack's `fold` column and escapes `%`, `_`, `\` itself.
- **WP11a (content mock handlers):** fixtures exist at `translations/{packId}/{from}-{to}.json`,
  `tafsir/{packId}/{ayahId}.json`, `wbw/{packId}/{surah}.json`; `manifest.packs` lists the pack ids.

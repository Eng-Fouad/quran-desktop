# WP1a deviations (CoreDb, mushaf/quran commands, page fixtures)

Status: complete. Owned paths: `crates/quran-core/src/core_db/{mod,index,page,text}.rs`,
`crates/quran-core/tests/support/mini_core.rs`, `crates/quran-core/tests/core_{mini,pages,index,text}.rs`,
`crates/quran-core/tests/data/copy_vectors.json`, `src-tauri/src/commands/{mushaf,quran}.rs`,
`xtask/src/fixtures/mushaf.rs`. Fixtures (`src/lib/ipc/mock/fixtures/{index.json,pages/**,ayahs/**}`) are exported
from WP3a's qdc core.db (`cargo xtask export-fixtures --only mushaf`), so the browser mock now serves real pages for the
§4.6 page list in all four styles.

## Deviations from ARCHITECTURE.md

1. **Acceptance command form.** `cargo test -p quran-desktop --lib commands::mushaf commands::quran` is rejected by
   cargo 1.99 (`unexpected argument 'commands::quran'`: cargo takes one TESTNAME). The equivalent that runs both
   filters is `cargo test -p quran-desktop --lib -- commands::mushaf commands::quran` (libtest accepts several).
   WP2b's line (`--lib user_db::migrations user_db::positions …`) has the same problem.
2. **Additive public items in `quran_core::core_db`** (inside the owned module; `lib.rs` untouched):
   - `PAGE_SQL`: the exact §3.1.4 page statement, so `verify-core` G15 (WP3b) and tests assert the plan of the
     statement the app runs instead of a copy.
   - `MAX_PAGES_PER_CALL = 8`, `MAX_AYAHS_PER_CALL = 300`, `UNAVAILABLE_MESSAGE` (`"core.db missing — run pnpm
     core:qdc"`), `CoreConn` (the pooled connection type `conn()` returns), and a `Debug` impl for `CoreDb` (no path).
3. **`EXPLAIN QUERY PLAN` text.** SQLite 3.53 reports the joined steps as
   `SEARCH w USING INTEGER PRIMARY KEY (rowid>? AND rowid<?) LEFT-JOIN` and `SEARCH a … (rowid=?) LEFT-JOIN`. The plan is
   the required one; the tests compare after stripping the ` LEFT-JOIN` suffix. **WP3b (G15)** must do the same.
4. **`CoreDb::open` details.** A probe connection opens and reads `meta` first, so a missing file or a non-database
   fails at once with SQLite's own error (r2d2's `build()` would retry until its timeout); the pool is then built
   lazily (`min_idle = 0`, 10 s checkout timeout). Relative paths resolve against the cwd; UNC paths become
   `file:////server/share/…` (SQLite rejects a URI authority). A non-numeric `meta.schema_version` is `Corrupt`; a
   `meta.normalizer_version` different from `NORMALIZER_VERSION` is a logged **warning**, not an error (pages stay
   correct; search would be stale; G13 makes it a build error for every shipped core.db).
5. **Validation lives in `CoreDb`** (before any IO) and the commands delegate to it: 1..=8 pages in 1..=604, ayah ids in
   1..=6236 with `from ≤ to`, at most 300 ayahs per `ayahs` call (`to − from < 300`). An unavailable core answers
   `NotFound(UNAVAILABLE_MESSAGE)` from every query, after validation. A page the layout lacks is `NotFound`; rows that
   break the §4.5 invariants the renderer relies on (unknown line kind, header without surah, words on a header line,
   an empty ayah line, decreasing word ids, an ayah split on one page, a word without its ayah row, an unknown sajda
   value, non-contiguous index ids, a layout whose page count ≠ `mushaf.pages`) are `Corrupt` instead of guessed.
6. **`PageInfo.surah_ids`** lists the surahs of header lines and of words in order of appearance. With WP3a's split
   headers (see Requests) page 76 (v2) is `[3, 4]`: surah 4's `surah_name` line is the page's last line.
7. **`CoreDb::copy_text` returns words + markers + the optional `\n{reference}`** ("Arabic part only" read as "without
   the translation"); `quran_copy_text` appends `\n\n{translation}`. References for ranges **across surahs** (the spec
   only shows same-surah ranges): short `(1:7–2:2)`, long `— Al-Fatihah 1:7 – Al-Baqarah 2:2`, arabic
   `[الفاتحة: ٧ – البقرة: ٢]` (en dash U+2013, spaced when the range crosses surahs). Long uses `surah.name_simple`,
   arabic uses `surah.name_ar`.
8. **Translation text for copy.** `quran_copy_text` reads the pack's stored `plain` column (§3.4: tags stripped,
   footnote markers removed) through WP1c's `PackDb::plain_texts` for every ayah of the range, trims each text, skips
   ayahs the pack lacks or leaves blank, and joins the rest with one space (§5.5). The `html` column is never parsed.
   A pack that is not there yields the Arabic part only (logged at warn): `PackError::NotFound` (not installed) or
   `PackError::Core(CoreError::NotFound)` (its `pack.db` is gone). Any other pack error is returned, so a corrupt pack
   is reported instead of silently dropped. Until WP5e implements `PackManager::translation_db`, a copy with a
   translation pack set returns that stub's `Unsupported` error.
9. **`copy_vectors.json` format** (§5.5, §12.3; for WP8e's `copy.ts` test): `{ description, surahs: { "<id>":
   { nameSimple, nameAr } }, cases: [{ name, fromAyahId, toAyahId, options: CopyOptions, words: PageWord[] (hafs style,
   glyph == text), reference, expected }] }`. Nine cases: 1:1–7 (with/without numbers), 2:255 (long), 2:255–257
   (arabic), 1:7–2:2 (short), 1:6–2:1 (plain, arabic), 38:24 and 22:77 (the "space + ۩" words), 112:1–114:6 (long).
   They were derived independently of xtask from the raw QDC page responses; `tests/core_text.rs` proves every word and
   every expected string against core.db, and the `core_db::text` unit test re-renders them from their own words.
10. **Command tests** need a core.db: they use `QD_CORE_DB` or `src-tauri/resources/core.db` when it is a real build and
    print a skip note otherwise (fresh clone stays green). Validation, the degrade path and the translation part (a
    pack written with WP1c's `PackDbWriter` and read back through `PackDb::plain_texts`) are tested without core.db.
11. **`mini_core.rs`** is self-contained (std + rusqlite + `schema/core.sql` via a file-relative `include_str!`), so it is
    shared three ways: `tests/support/mod.rs` (integration tests), `src/core_db/mod.rs` (`#[cfg(test)] #[path]`, unit
    tests) and `xtask/src/fixtures/mushaf.rs` (`#[cfg(test)] #[path]`, exporter test). WP1b may build its search tests
    on it: its FTS index and `vocab_loose` are finalised like a real build.
12. **The exporter recreates `pages/` and `ayahs/`** under the fixture directory on every run (stale pages from an older
    page list never linger); `index.json` is overwritten; other domains' files are untouched.

## Measurements (debug test profile, WP3a qdc core.db, this machine)

- `CoreDb::pages` (1 page): median 0.15 ms, p99 0.26 ms over 3 × 604 pages (budget p99 < 5 ms, target < 1 ms).
- `CoreDb::index` first call: 2.5–3.1 ms over five fresh handles (budget < 30 ms); cached clone < 5 ms.

## Requests

- **WP3a / WP3b (data, G4/G5b):** the qdc core.db has **198 words whose `code_v1`/`code_v2` contain a space** and
  **199 `text_hafs` values with a `"۞ "` prefix**: QDC prepends the rub-el-hizb glyph to the first word of a rub (e.g.
  2:26:1 `text_hafs = "۞ إِنَّ"`, `code_v1 = "ﭹ ﭺ"`, `code_v2 = "ﱨ ﱩ"`, `text_imlaei = "۞ ان"`). G4 forbids whitespace in
  codes and G5b allows a space only before ۩, and FACT §2 says the app draws ۞ itself (the §8.9 margin marker), so the
  page would show it twice. Suggest stripping the leading ۞ code + space from the codes and `"۞ "` from
  `text_hafs`/`text_imlaei` in `qdc.rs`/`derive.rs`. WP1a's code passes whatever the DB holds; its tests check glyph
  *selection* fidelity and leave the code shape to verify-core.
- **Lead / WP3a (FACT C15, G8):** in the QDC responses 18 v2 surahs (pages 76/77, 207/208, 331/332, 341/342, 349/350,
  366/367, 376/377, 414/415, 417/418, 445/446, 452/453, 498/499, 506/507, 525/526, 548/549, 555/556, 557/558,
  584/585) and 21 v1 surahs start on line 2 of a page while line 15 of the previous page is empty, i.e. the
  `surah_name` line sits at the bottom of the previous page. FACT C15 ("no header is ever orphaned") and G8 ("header
  lines are on the same page as the surah's first ayah line") do not hold for this source; WP3a's build places the
  `surah_name` at P−1:15 and the `basmallah` at P:1. v4 has none. Page assembly handles both shapes.
- **WP5e:** `PackManager::translation_db(pack_id)` should answer `PackError::NotFound` for a pack id that is not
  installed (or not a translation): `quran_copy_text` then copies the Arabic part only, as the copy settings may still
  name a pack the user has removed. Other errors are surfaced to the user.
- **WP8e:** `src/lib/mushaf/copy.ts` can test against `crates/quran-core/tests/data/copy_vectors.json` directly: pass
  `case.words` and `case.options`, and let `refLabel` return `case.reference` (or compute it from `surahs`).

# Implementation notes (ARCHITECTURE v1.2)

What the build changed relative to [`ARCHITECTURE.md`](ARCHITECTURE.md) v1.1, organised by the spec's sections. This file
is the lead's fold-in of every accepted deviation (`docs/deviations/WP*.md`), every lead decision
([`deviations/LEAD.md`](deviations/LEAD.md)) and the integration phase ([`deviations/INTEGRATION.md`](deviations/INTEGRATION.md)).

- **Precedence.** ARCHITECTURE.md plus these notes is the v1.2 spec. Where the two disagree, these notes win; where both
  are silent, the code and its tests decide. The few in-place corrections in ARCHITECTURE.md are marked "(v1.2)".
- **References.** `WP4b 5` is item 5 of `docs/deviations/WP4b.md` (a section number for files with numbered sections).
  `INT <round>` is a section of `INTEGRATION.md` (`rust`, `web`, `gate 1–3`, `fix 1/2 <area>`). `LEAD n` is a lead
  decision. The deviation files keep the measurements, the evidence and the reasoning; this file keeps the outcome.
- **Superseded** deviations are listed only in their final form. Where a package's choice was later replaced, the
  replacement is given and the package item named as "was".
- **Additive API** (extra helpers, constants, store methods, exports) is not listed one by one: every package added
  some, always without changing a frozen signature. The deviation files list them.

## 0. Lead decisions at a glance

| # | Decision |
|---|---|
| LEAD 1 | `pnpm bindings:check` is git-free: it regenerates `bindings.ts`, fails on any difference and restores the file. |
| LEAD 2, 19 | `reqwest` is a `src-tauri` dependency; the audio stream uses the pack layer's client (`PackManager::http_client()`). `webview2-com = "=0.39.1"` is pinned in the workspace (already in the tree); `async-executor` left the workspace table; `Cargo.lock` versions are unchanged. |
| LEAD 3 | The audio engine reaches the tray and the OS media session through a UI sink (`AudioService::set_ui_sink`), registered by `AudioService::start` itself (WP4d 20). |
| LEAD 4 | `#[allow(clippy::unreachable)]` only on `pub mod commands` (a tauri-macros artefact); `dist/` is not needed for plain cargo builds. |
| LEAD 5 | `src/lib/mushaf/metrics.ts` belongs to WP8b. |
| LEAD 6 | `rg` is not assumed installed; `check:tooling` only warns about it. |
| LEAD 7, 8 | The KFGQPC TTF is pinned by sha256 (`C9DD7E71…EC47A`, 301,356 B); the QDC prefetch layout under `data/cache/` is the build's cache. |
| LEAD 9 | Nothing ever plays through the real output device in tests or checks: `QD_AUDIO_SINK=null` or `wav:<path>`. |
| LEAD 10, 11 | One short `CARGO_TARGET_DIR` per worktree or agent (MAX_PATH, lock contention). |
| LEAD 12 | No agent commits or stages. |
| LEAD 13 | The first-run look (S03: pages 1–2, hafs, paper, own cartouche and medallion, Unicode basmala) is signed off. |
| LEAD 14, 17 | `cargo test` takes one TESTNAME: an acceptance line with several filters runs as `cargo test -p X --lib -- f1 f2` (§14.3 corrected in place). |
| LEAD 16, 18 | The app adopts the github.com/quran (Quran.com) identity, pending the organisation's approval: product **Quran**, full name **Quran for Desktop** (قرآن / قرآن لسطح المكتب), identifier and AUMID `com.quran.labs.desktop`, licence **GPL-3.0-or-later**, User-Agent `QuranForDesktop/<version>`, the قرآن mark of quran_android as the icon. Repository, crates and binary keep `quran-desktop`. |
| LEAD 17 | Data rulings: cross-page surah headers are authentic print geometry (FACT C15 was wrong); the inline ۞ stays verbatim in the text; the Imla'i search seed is QDC `text_imlaei` (QUL 54). |
| LEAD 20 | Contract: `PlayRequest.record: bool` (serde default `true`); `false` marks the onboarding preview. |
| LEAD 21 | No kashida (tatweel) justification of the Unicode text; the hafs style is fitted per spread instead (§10.1 below; ARCHITECTURE §8.4). |
| LEAD 22 | Release build: `opt-level = "z"` with decode, resampling and WSOLA at 3; tauri without `dynamic-acl`; rustls stays on aws-lc-rs; the setup and uninstall executables carry the app icon; the MSI upgrade code is pinned (NSIS is the only Windows release asset). |
| LEAD 23 | Contract: event `quit-requested`. A user's quit hides the window and lets the page save its debounced writes before `app_quit` (§8 below). |

## 1. Process, tooling and acceptance (§0.2, §13.1–13.2, §14)

- **Acceptance commands.** Multi-filter `cargo test` lines are run in the libtest form (LEAD 14; WP1a 1, WP1c 1, WP2a 1,
  WP2b 1, WP4b 17, WP4d 18, WP5e 20, WP6a 1, WP6b). Ports: every package ran web shots on its orchestrator-assigned
  `--serve` port instead of 1520; the scripts take the last `--serve` given.
- **`check:tooling`** reads the command list from ARCHITECTURE.md itself (§13.3, §14.3, §14.4), checks `-p <crate>`
  against `cargo metadata`, vitest projects against the config and every file a script runs; later-wave gaps are
  `pending` (`--strict` fails them; `--xtask` also checks every `cargo xtask <cmd>`) (WP0D 6).
- **Vitest.** No `passWithNoTests`: a filtered run that finds no file fails (WP0D 3). The browser project runs Chromium
  only locally, through the installed Edge on Windows (`QD_BROWSERS`, `QD_BROWSER_CHANNEL`), Chromium and WebKit on CI;
  viewport 1280×800; failure screenshots and attachments go to `artifacts/vitest-browser/` (WP0D 1, INT web).
- **ESLint** adds to the §5.16 rule: no `core` namespace import from `@tauri-apps/api`, no mock or
  `@tauri-apps/api/mocks` import outside tests, and the local rule `qd/no-html-escape-hatch` (only `SafeHtml.svelte` may
  disable `svelte/no-at-html-tags`) (WP0D 4).
- **Prettier** skips `docs/`, `src-tauri/`, `crates/`, `xtask/`, `data/` and the generated files (WP0D 5).
- **`check:dist`** also fails on mock-only strings or modules (bundle and source maps), any SQLite file, any WOFF 1 font or
  `format("woff")` source, and reads "6 MB" as 6 MiB (WP0D 7, WP13b 2). A debug `dist/` (source maps) is not the
  production bundle: run `pnpm build` before it.
- **Runes** are forced for project components; `svelte` is a runtime dependency (WP0D 10–11). `package.json` gained
  `check:artifacts`, `check:ci`, `brand`, `brand:check` (INT web).
- **Windows test executables** embed the comctl32 v6 manifest (`build.rs`), or `cargo test -p quran-desktop` dies with
  `STATUS_ENTRYPOINT_NOT_FOUND` (WP0A 3). `build.rs` also creates `resources/` and the 0-byte placeholders (WP0A 5).
- **Bindings** are rewritten only when the content changes; `bindings_cover_the_contract` pins the command count, the
  events, no `font_bytes` and no `bigint` (WP0A 11).
- **Settings snapshot.** `crates/quran-types/tests/data/settings_default.json` pins every IPC name and default;
  `QD_UPDATE_SNAPSHOTS=1` accepts an intentional (contract) change.

## 2. Workspace and crates (§2.1, §2.6)

- `[workspace.package]` keeps `license`, `repository`, `authors`; every crate inherits the publisher "Quran for Desktop
  contributors" as `authors` (the deb Maintainer) (WP0A 6, LEAD 19). `repository` is the working repository until the
  move to github.com/quran is settled (a release-checklist item).
- `[profile.dev.package]` keeps opt-level 3 for `symphonia-core`, `symphonia-bundle-mp3`, `rubato` (WP0A 6).
- `src-tauri` has no `staticlib`/`cdylib` crate types; `regex` is no longer a dependency (the protocol has its own
  parser); `fastrand` and `reqwest` were added at wave-0 exit; `webview2-com` is a direct Windows dependency (WP0A 7,
  WP0-GATE 3, INT rust, LEAD 19).
- `media-session`: `objc2-foundation` uses `default-features = false` with the verified feature list; `async-executor` is
  gone (WP6d, INT rust).
- Glue constructors and window/tray/media hooks are generic over the tauri `Runtime`, so `setup::build_state` is testable
  with `tauri::test::mock_app()` (WP0B 1, WP6b 1, WP6c 7).
- App events from Rust use `tauri::Emitter::emit(E::NAME, …)` (tauri-specta's `Event::emit` panics without its registry,
  an abort under `panic = "abort"`); names and payloads are identical (WP0B 2, WP2b 7).
- `quran-types` helpers: counts (`AYAH_COUNT` …), `MushafLayout::ALL`, `Platform::current()`, `UiLanguage::from_os_locale()`
  (primary subtag `ar`), the `limits` module shared by settings and command validation. `Settings::validated()` clamps
  unstepped ranges, rounds stepped ones (ties up), dedupes `hintsSeen`, turns blank pack ids into `null`; it is
  idempotent (WP0A 8–9).

## 3. `quran-core` and the databases (§2.2, §3)

### 3.1 `normalize_ar` (§2.2.3)

- `fold_latin` drops exactly `General_Category = Mn` (Unicode 17 table); the golden file has 48 rows (the 14 spec rows plus
  34 cross-checked extras) (WP0B 4–5). The TS twin (`normalize.ts`) uses Rust's `White_Space` and per-code-point
  lower-casing so both sides agree on every input (WP10a 4).

### 3.2 `CoreDb` (§2.2.4, §3.1)

- `PAGE_SQL` is public, so G15 and the tests assert the plan of the statement the app runs. SQLite 3.53 suffixes the
  joined steps with ` LEFT-JOIN`; plan comparisons strip it (WP1a 2–3, WP3a 4.7, WP3b 6).
- `open` validates with one direct connection, then builds the pool lazily (`min_idle = 0`, 10 s checkout); UNC paths
  become `file:////…`; a different `normalizer_version` is a warning, not an error (G13 makes it a build error) (WP1a 4).
- Validation precedes IO: 1–8 pages, ayah ids 1..=6236 with `from ≤ to`, ≤ 300 ayahs per call. An unavailable core answers
  `NotFound("core.db missing — run pnpm core:qdc")`; rows that break the §4.5 invariants are `Corrupt`, never guessed
  (WP1a 5).
- `PageInfo.surah_ids` includes the surah of a header line even when its first ayah is on the next page (v2 p76 is
  `[3, 4]`) (WP1a 6).
- **Copy text** (§5.5): references across surahs read `(1:7–2:2)`, `— Al-Fatihah 1:7 – Al-Baqarah 2:2`,
  `[الفاتحة: ٧ – البقرة: ٢]`. The translation part is the pack's stored `plain` column (`PackDb::plain_range`, one query),
  trimmed and joined by a space; a pack that is not installed copies the Arabic alone (logged); any other pack error is
  returned. The shared vectors are `crates/quran-core/tests/data/copy_vectors.json` (WP1a 7–9, INT rust).

### 3.3 `SearchEngine` (§2.2.5)

- Limits: `limit` 1..=2000, query ≤ 2000 characters and ≤ 200 tokens, suggest 1..=100; a query that folds to nothing is an
  empty result before any IO (WP1b 1–2).
- Parsing: phrase quotes include `“ ” „ « »`; an unterminated quote is a phrase being typed (its last token a prefix in
  smart mode); tokens split exactly where FTS5 `unicode61` splits (WP1b 2).
- FTS rendering: typo groups are joined with an explicit `AND` (FTS5's implicit AND cannot join a parenthesised OR group)
  (WP1b 3).
- Typo fallback: only tokens that are not vocabulary terms are expanded, and only the nearest edit-distance tier is kept
  (≤ 8 terms); `suggestions` appear only when the fallback found hits (WP1b 4).
- `SearchGroup.count` is the surah's match count within the filters even when the hit list is cut; groups exist only for
  surahs with returned hits (WP1b 5). Translation and note hits carry the ayah's first word and empty `words` (WP1b 6).
- Notes: live notes only; a note overlapping the filter is grouped at its first ayah inside the range (WP1b 7, WP2a 15).
- Pack scope: queries are folded per tokenizer (Arabic packs `normalize_ar`, `like_fallback` packs `fold_latin`,
  `unicode61` packs not at all); `LIKE` serves substring mode, `like_fallback` packs and folded queries under 3
  characters; exact mode on a pack means "no prefix" (WP1b 8).
- Snippets are HTML with only `<mark>`: FTS5 `snippet()` for `plain` packs, otherwise built in Rust from the display text
  (±12 words, CJK by characters), marking the original vocalised word; notes are reduced from Markdown to text first
  (WP1b 9). Substring mode maps a needle that spans words to every word it touches (WP1b 10).

### 3.4 `UserDb` (§2.2.6, §3.2)

- **Bookmarks:** upserts are keyed by target (one live bookmark per ayah, per layout+page); a conflicting move or restore
  is `InvalidArgument` (no `Conflict` variant). `bookmark_toggle_ayah` revives the most recently deleted bookmark of the
  ayah with its label, collections and tags (WP2a 3–4).
- **Tombstones:** delete returns the row as it was; deleting twice is `NotFound`; restore bumps `updated_at`; collections
  and tags tombstone too; `purge_tombstones` (30 days) also removes the polymorphic `item_tag` links (WP2a 5, WP2b 16).
- **Highlights** never overlap, and two of the same colour never overlap or touch: `highlight_set` trims, splits (the
  left piece keeps its id) and merges same-colour neighbours into the earliest; `highlight_clear_range` returns the rows
  as they were, so re-setting them restores the state exactly (WP2a 6).
- **Tags** are unique case-insensitively, and creating a taken name returns the existing tag (get-or-create);
  **collections** allow duplicate names. Text is normalised (single-line names, trimmed bodies); colours are opaque tokens
  of ≤ 32 `[A-Za-z0-9#_-]`; limits: names 100, labels and titles 200, bodies 100,000, ≤ 100 linked ids. Tagging and
  membership bump the item's `updated_at` (WP2a 7–10).
- **Lists** are newest-updated first (bookmarks, notes), Mushaf order (highlights), by name (tags); `limit = 0` returns
  nothing; `user_marks.reading_ayah_id` is set only inside the asked range; an unreadable reading bookmark reads as none
  (WP2a 11–13). `UserDataChanged` kinds per mutation are WP2a 14's table; search-history changes are reported as
  `history` (no extra kind) (WP2b 7).
- **Settings** are stored sparsely (no row = default; only differing keys are written; unparsable rows heal), written in
  one transaction (`settings_replace`, `settings_edit`) and serialised with their hooks and event by one gate
  (WP2b 3–6, INT rust). `settings_reset` keeps `ui_language`, `onboarding_done`, `hints_seen`, `close_to_tray_asked`
  (the frontend's optimistic reset does too, WP7c 12).
- **History** merges a visit to the same mode and place within 10 minutes (moved to the top, dwell summed); 10,000 entries
  kept; lists capped at 1,000. **Search history:** trimmed, ≤ 500 characters, 200 entries LRU (WP2b 9–10).
- **Memorisation:** `memo_progress` is sparse; `memo_set_status` semantics (new deletes; learning caps strength 3 and makes
  the ayahs due; memorized schedules like "good"; review makes them due); `memo_test_finish` never touches the schedule
  (WP2b 11). **Loop presets** are normalised like settings and hard-deleted (WP2b 12).
- **Backups** (`backup_to`): `VACUUM INTO` a temp sibling, verify read-only, atomic rename. Default name
  `backups/user-YYYYMMDD-HHMMSSZ.qdb`. A destination naming the live database or its companions is refused, compared by
  identity, and `user_backup_create` refuses anything inside the data folder other than `backups/` (WP2b 14, INT fix 1).
- **Restore** (`user_backup_restore`, new command): the file is verified first; the current library is kept as a new
  backup; the restore copies in place without ever waiting on another program's lock while holding the writer lock
  (busy handlers off, 20 ms pauses, 10 s budget, then `Database` "the library is in use by another program") (INT rust,
  INT fix 2 rust-core).
- **A newer schema is refused, never quarantined** (`CoreError::NewerSchema` → `AppError::Database`, a localised fatal
  dialog): the file is left byte for byte. Corruption, foreign schemas and failed migrations still quarantine; transient
  SQLite errors never do (WP2b 15 was "quarantine on DatabaseTooFarAhead"; INT fix 1 rust-core).
- user.db keeps 128 prepared statements (INT rust).

### 3.5 `ContentDb`, `PackDb`, timings (§2.2.7, §3.3, §3.4)

- Chapters are contiguous id ranges fixed by the 114 ayah and word counts (`content_db/geometry.rs`, checked against a
  built core.db); writers reject rows outside the chapter (WP1c 2).
- `sanitize_qdc`: if any ayah keeps no usable word, every word is dropped (word-level everywhere or nowhere); a missing or
  non-numeric timestamp is `Corrupt` (WP1c 4). `duration_ms` is `max(file duration, last ayah end)` (QDC rounds file
  durations) (WP1c 5).
- Pins only go up on writes; unpinning is explicit; pinning missing timings is `NotFound` (WP1c 6). Deleting an
  `audio.*` pack deletes its timings; `ContentDb::delete_chapter` removes one chapter atomically (WP1c 7, INT rust).
- `clear_unpinned` compacts (`VACUUM`, checkpoint) so "Clear cache" frees disk (WP1c 9). `open_or_recover` runs
  `quick_check` before `PRAGMA optimize` and quarantines only on corruption or a failed migration (WP1c 10).
- `PackDb::open` maps a missing file to `NotFound`, a 0-byte or unfinished file to `SchemaMismatch`; `PackDbWriter`
  validates everything and finishes with `VACUUM` under `synchronous=FULL` (WP1c 11–12). `footnotes_for` orders by the
  marker's number in any script's digits (INT rust).

## 4. Data pipeline (§4)

### 4.1 Build (`build-core`, §4.1–4.4)

- **Search seed (LEAD 17; WP3a 1).** QDC's word-level `text_imlaei` (diacritised; = QUL script 54), not
  `text_imlaei_simple`: the simple form writes the dagger alef as a full alef and pre-folds hamza seats, so `الرحمن` had
  0 hits. `word_fields` is `code_v1,code_v2,text_qpc_hafs,text_imlaei,location`; `word.text_imlaei` carries harakat and
  waqf marks and is never displayed raw. `vocab_loose` has 14,615 terms.
- **Cross-page surah headers (LEAD 17; WP3a 2).** In V2 (18 surahs: 4, 10, 22, 23, 24, 26, 27, 32, 33, 37, 38, 45, 47, 53,
  60, 64, 65, 80) and V1 (those plus 82, 86, 91) the `surah_name` line is line 15 of the previous page; V4 has none. The
  rule: the slot right above the first ayah line is on the same page (the basmallah, or the lone `surah_name` of surahs 1
  and 9); only the `surah_name` of a two-line header may sit on the previous page's last line; any other empty slot fails.
- **Source facts kept verbatim (LEAD 17; WP3a 3).** The end marker of 2:181 is labelled a word in QDC and is relabelled by
  a narrow rule. 198 `code_v1`/`code_v2` values contain one U+0020 (195 rub-sign words, 3 printed compounds). Non-end
  `text_hafs` spaces: 9 before ۩, 199 after ۞, 4 inside compounds. **The inline ۞**: the first word of 199 of the 240
  quarter starts begins with `۞ ` (all except ayah 1 of a surah); 4 codes carry the sign without a separator. It is kept as
  printed; `normalize_ar` deletes it; copy text contains it.
- `meta.source_manifest_sha256` hashes a canonical text (one `<sha256>  <path>` line per input; for qul
  `<sha256>  <key>  <file>`), so line endings cannot change it (WP3a 4.1, WP3d 5). A qdc `licence_note` says "DEVELOPMENT BUILD, NEVER
  DISTRIBUTE". With `--offline`, a QDC file older than 7 days is an error. The cache check parses every file and refetches
  an old request shape (WP3a 1, 4).
- Extra hard checks in `derive` (rub ⊂ hizb ⊂ juz, rukus within surahs, the three mushafs agree word for word, pages 1–2
  exactly lines 1..8); 1:1 counts as a rub, hizb and juz start (`flags = 15`) (WP3a 4.5–4.6).
- **qul adapter (WP3d).** `meta.rub` is QUL resource **63** (67 is the Hizb file); `script.imlaei` is **54**; optional
  `meta.juz` (68), `meta.hizb` (67), `meta.manzil` (66) feed the D6 cross-check. Manifest values are validated together;
  `sha256 = ""` means "not recorded yet" and the build prints the actual hash. Both script column variants and QUL's two
  JSON shapes are read; layouts must be SQLite. `word_index` order must equal location order; unused ids inside a range
  (FACT C7) are skipped and reported; extra rows stop the build with the candidates listed. `--source qul` is wired
  (INT rust). The committed `data/sources/qul/manifest.toml` is authoritative over the §4.3 example.

### 4.2 Gates (`verify-core`, §4.5)

- 18 gates (G1–G16, G5b, G11b), read-only, every gate runs; the report shape is in WP3b. The build verifies against its own
  Tanzil file (`verify_db_with`, INT rust).
- **G4** allows one inner U+0020 in a code, only for `۞ `-prefixed words and three listed words (8:6:4, 36:52:6, 37:130:3).
  **G5b** classifies every space of a non-end `text_hafs`: before ۩, the `۞ ` prefix, or one of four listed compounds
  (2:181:3, 8:6:4, 13:37:8, 37:130:3). **G8** applies the cross-page header rule above and checks `bismillah_pre`.
  **G9** checks the v1/v4 approximation exactly on a qdc build. **G14** reads 16 MB as 16 MiB and adds schema, `meta` and
  page-size checks. **G15** times 4 × 604 queries (one per style) with a warm-up pass and checks that every query returns
  a row per header line and per word. Extra hard checks per gate are WP3b 7's table (WP3b 1–7).

### 4.3 Fixtures, assets, licences, dev packs (§4.6–4.8)

- Fixture manifest `queries` are `{ slug, request }[]` (the TS type follows); search fixtures are `search/vocab.json` (top
  2,000), `search/ayahs.json`, `search/results/{slug}.json` (WP1b 13, INT web). Content fixtures need a built core.db for
  timings and WBW; synthetic packs `tr.en.saheeh`, `tr.ur.junagarhi`, `tafsir.ar.muyassar`, `tafsir.en.ibn_kathir`,
  `wbw.en` (WP1c 13); `packs/reciters.json` is exported too (WP5a 11). Each exporter recreates its own directories.
- **Synthetic mock data** embeds Tanzil's metadata (CC BY 3.0) for a real surah/juz/hizb/page index; words stay
  placeholders sized to fill each page (WP0C 10). Without fixtures, names differ from a real core.db ("Al-Baqara"):
  tests read names from the loaded index (INT gate 1).
- `fetch-assets` finds the TTF in the zip by name, verifies everything before writing, and **generates**
  `KFGQPC-Hafs-V30.LICENSE.txt` from the font's name table (WP3c 5). `fetch-dev-packs` fetches the `decor` pack (3 files)
  plus 3 × 47 fixture pages, validates WOFF2 headers and decor hashes (WP3c 6).
- **`thirdparty.json`** is `{ packages, texts }` with shared text segments, built from the Rust normal-dependency closure of
  the four release targets and the npm production closure (WP3c 1–2). `cargo xtask licenses` enforces a licence policy
  compatible with GPL-3.0-or-later and **fails unless every shipped package's texts contain each licence it is credited
  under**; packages that ship no text get reviewed stand-ins in `xtask/licenses/<cargo|npm>/<name>/` (version-pinned
  `source.toml`). The credited licence is chosen by what the files contain (WP3c 3–4 were "nothing invented,
  `texts: []`"; INT fix 1 rust-core).

## 5. Audio engine (§2.3)

### 5.1 DSP (§2.3.5)

- WSOLA maximises SoundTouch's centre-weighted similarity `(ncc + 0.1)·(1 − 0.25u²)`, so silence stays on the nominal
  position and near-ties no longer run to the window edge (WP4a 1). `set_speed` resets (speed 50..=200); `drain` ends
  with a reset; the timeline starts with `Hs` frames of silence (WP4a 2–4).
- `dsp/chain.rs` (`DspChain`): WSOLA (bypassed at 100 %) → resampler (rubato's delay trimmed) → channel map → raised-cosine
  4 ms fades, holding back 4 ms so a segment end can always fade. Output positions are exact by construction (≤ 12 µs over
  5 minutes) (WP4a 5–6, 8). Mono devices get `(L+R)/2`; mono sources play on L and R (WP4a 7). A rubato error (impossible
  with the fixed sizes) outputs silence of the exact length (WP4a 11).

### 5.2 Planner and decode (§2.3.3–2.3.4)

- `PlannedQueue { segments, basmala_skipped }`; `to = None` resolves to the end of the Quran or of `from`'s surah; a zero
  gap is no gap; segment ends never precede their start (WP4b 1–4). An **audio-less basmala** (reciter 173's 1:1 is
  80–80 ms) is left out of the plan (INT rust).
- Seeks are `Accurate` with a 2,304-frame pre-roll, dropping frames by packet timestamp; forward moves ≤ 2 s decode
  through (WP4b 5). Millisecond ⇄ frame: `⌈ms·rate/1000⌉`, `⌊frame·10⁶/rate⌋` µs (WP4b 6).
- A marker enters the ring only once every earlier frame is written (Sync markers excepted); Sync markers follow the first
  WSOLA hop boundary ≥ 100 ms after the previous marker (WP4b 7–8). A speed change or an A-B loop set behind the decoder
  resumes at the **consumed** position, seamlessly (WP4b 9).
- A-B: bound to the heard file, linear between A and B (repeats and gaps suspended), `b ≤ a` ignored (WP4b 10). Gaps: none
  after the final play or for a basmala; the multiplier uses file time (WP4b 11). Repeat counters are "left after the
  current one", 0 for ∞, published from the consumed position (WP4b 12). Up to two files stay open (WP4b 14); the probe
  never reads the end of a stream (WP4b 15).

### 5.3 Output, control, engine (§2.3.2, §2.3.6)

- The output stream is **opened lazily** and released after 30 s paused or 5 s idle (no "audio in use" power request all
  day); the startup probe never opens a stream (WP4c 1). Every cpal error kind except `DeviceChanged`, `Xrun`,
  `RealtimeDenied` rebuilds, with a back-off after three rebuilds in 5 s; host order PipeWire, PulseAudio, ALSA, WASAPI,
  CoreAudio (WP4c 2–3).
- The callback declicks a flush over ≤ 8 ms and publishes position, segment, kind and generation as of the buffer's first
  frame (WP4c 4). A new play hands over through a **fence**, so stale messages are never pinned on the new play (WP4c 5).
- Status: `playing` once `Load` is sent; `buffering` after two starved ticks; the End marker **heard** → `idle` with range
  kept; output failures show as `error` even while idle (WP4c 6). Commands while control is blocked are superseded, held
  or applied through atomics (WP4c 7). Announced plays are numbered so `audio_play` always returns `loading` for its play
  (WP4c 8, INT fix 1 rust-app).
- Snapshot values are computed on read; the audible position subtracts the output latency in file time; during the
  basmala `current = {surah, 0}` (WP4c 9). Events: `state` on marker edges, `ayah_changed` only for a new ayah; repeat
  passes are state edges with live counters (WP4c 10, INT fix 1 rust-app).
- **Command semantics** (WP4c 11, INT fix 2 rust-app): Next at the last ayah starts the next range pass while passes
  remain, else stops; Previous within 1.5 s of wall time; seeks on the file timeline and the A-B wrap are bounded to the
  heard **run** of the file (`plan::file_run`), and an A-B loop left under 300 ms is ignored; Play after a mid-way
  failure re-plans and continues from the heard segment in its pass; a pre-start failure keeps its range and reciter in
  the snapshot. Speed is engine state across plays.
- **Cancellation** (INT fix 1 rust-app): one `CancelToken` per play; planning, timings fetches, stream connects and
  stalled reads (`ReadCancelled`, never `Interrupted`) give way to a newer play or a stop within ~1.5 s.
  `AudioError::{FileMismatch, Cancelled}` are new variants (`network`, `cancelled`).
- Shutdown joins for ≤ 500 ms; debug sinks run 48 kHz stereo, 10 ms buffers; an unknown `QD_AUDIO_SINK` value means the
  null sink, never the speakers (WP4c 12–13).

### 5.4 Sources and glue (§2.3.7, §2.8.4)

- Cursors read the temp through their own handle, only bytes the recorded coverage holds; stream-download does the HTTP
  work (WP4d 1). A **stall watchdog** fails a read after 30 s without bytes, at once when the network goes away (WP4d 2).
  One writer per temp path; a complete download is promoted when its last cursor goes (WP4d 3–4). Host fallback
  `.com` → `.org` once; an unreachable host is `Offline`; files without `Content-Length` stream but are never cached
  (WP4d 5–6).
- `AudioService::set_ui_sink` delivers coalesced snapshots on a `qd-audio-glue` thread (WP4d 9). Speed and volume apply
  live; `stop_at` is the default end (WP4d 12).
- Timings: content.db first; a stale copy is used **at once** and refreshed in the background (`audio_get_timings` waits
  ≤ 1.5 s); one fetch per (reciter, surah) in flight; a play prefetches the surahs the planner will need, 4 at a time
  (WP4d 10, 21; INT fix 1 rust-app).
- **Rule 7** (timings/file mismatch): `PackManager::refresh_surah_timings` replaces the pair in one step; the play is
  re-planned (first file) or continues from the changed file after the written audio drains (WP4d 11 was "delete and
  refetch, fail this play"; INT rust, INT fix 1 rust-app).
- **Listen history:** only audible time counts (not gaps or the basmala); an ayah heard 3 s records its page; one entry
  per visit, checkpointed every 5 minutes; each write emits `UserDataChanged { history }`. A play with
  `record: false` records nothing and is never replayed by a media key (WP4d 13, LEAD 20).
- Media Play with nothing loaded replays the last recorded request (WP4d 14). Command validation is WP4d 15's table
  (speed 50..=200 step 5, volume 0..=100, repeats 0..=99, gap ≤ 30 s or ≤ 300 %, A-B ≥ 300 ms).
- **Ticks to the webview** are filtered (`TickFilter`): a tick passes when what the UI shows changes, when its position is
  more than 40 ms off the webview's interpolation, and otherwise every 250 ms (≈ 5/s instead of 30) (INT gate 3).

## 6. OS media session (§2.4)

- The Windows SMTC backend runs on its own MTA thread; `GetForWindow` works with the owner thread blocked, so there is no
  `run_on_main_thread` fallback (WP6c runtime check). `MediaSession::new` falls back to the no-op backend internally;
  `media::init` returns `None` for it (WP6c 1–2).
- The session is visible only while a recitation is loaded (Stopped hides it on every OS); the basmala's title is the surah
  name alone; Arabic references use Arabic-Indic digits; metadata and state are sent on edges only (WP6c 4, 6; WP6d 4, 8).
  A failed play shows paused with Play only (INT fix 2 rust-app).
- **Artwork** is `icons/media/artwork.png` (512 px, opaque), written once to `<data>/media-artwork.png` (WP6c 5,
  INT rust).
- **Linux (MPRIS):** our own `Send + Sync` implementation on mpris-server's `Server` (one `PropertiesChanged` per burst, no
  relay panics); the bus name checks `NameHasOwner` and falls back to `….instance{pid}`; `DesktopEntry` is the productName,
  "Quran" (the bundler's `{productName}.desktop`); track ids `/com/quran/labs/desktop/track/{s}_{a}` (WP6d 1–5, LEAD 16).
- **macOS (Now Playing):** main-thread jobs, coalesced; the newest session owns Now Playing; commands enabled only while
  loaded; artwork through `MPMediaItemArtwork`; rates 0.5–2.0 (WP6d 7–9).

## 7. Packs (§2.5)

### 7.1 Catalog and starter set (§2.5.3–2.5.4)

- `catalog.json` has a `$schema` key; `quran_packs::catalog::schema` validates only the keywords the schema uses
  (WP5a 1–2). Validation rules beyond the spec (id shapes per kind, items per adapter, static-file routes, direction per
  language, tokenizer per language, WBW gloss languages, `revalidateDays` 1..=7 for QF packs only, The Clear Quran
  refused) are WP5a 3.
- **Starter set** (`Catalog::starter_set`, mirrored by `packs.starterSetFor`): decor now; the UI language's recommended
  translation, else its recommended tafsir (`en` → `tr.en.saheeh`, `ar` → `tafsir.ar.muyassar`); page fonts on demand
  (or all now); `wbw.{ui}` on demand (none for Arabic); the reciter's timings on first play. Totals: en 851,422 B, ar
  1,144,830 B (WP5a 5, WP12a 3). Installed or on-demand reading packs of the set are put to use at onboarding (INT fix 1
  ui).
- `sizeBytes` are exact download bytes (QCF sums are MiB in the old spec text) or measured storage for content.db packs;
  unversioned upstreams use `YYYY.MM`; `decor.nastaliq` comes from Fontsource's npm build (WP5a 6–8). The
  `catalog-check --online` policy (what is an error, what a warning) is WP5a 12.

### 7.2 Downloads (§2.5.5)

- Retries: the first attempt plus three rounds (0.5, 2, 8 s), every mirror once per round; 4xx and integrity failures
  retire a URL; `Retry-After` ≤ 60 s; connect failures while offline end at once; progress resets the budget (WP5b 1).
- **Interactive budget:** an interactive request must start answering within 10 s and ends by 15 s
  (`PackError::Timeout`, `network`); background work is unchanged (INT fix 1 rust-app).
- The resume sidecar advances every 1 MiB after an fsync; `If-Range` uses a strong ETag or `Last-Modified` (WP5b 2).
  Staging is `packs/.staging/{packId}/` with a job journal (`job.json`) that `JobQueue::restore` resumes (WP5b 3–4).
- Background work holds at most 4 of 6 global and 3 of 4 per-host slots (WP5b 5); two clients (gzip for JSON, identity for
  files) (WP5b 6); turning network use off stops transfers in flight (WP5b 7).
- Registry policy, failure threshold `min(3, items)`, progress accounting (estimates replaced by real lengths, events
  ≤ 10 Hz), phases `verifying → installing → completed` (a cancel during the flip is ignored), the startup sweep: WP5b
  11–16. A paused item keeps its partial progress; a resumed job reads as downloading (INT fix 2 rust-app, INT gate 3).
- `pause`/`cancel` are async (WP5e 1); `PacksChanged` is coalesced over 150 ms (WP5e 3); a scope-All install also queues
  missing `requires` (WP5e 5); a recitation **Update** is a job with one pseudo item run by the revalidator (WP5e 4).
- On-demand chapters and streamed audio are recorded as unpinned `pack_item` rows; re-sync at startup and after "Clear
  cache" reconciles rows with disk and content.db (WP5e 6–7). Known whole-pack updates survive restarts in content.db's
  `kv` (WP5e 8). Stream-cache eviction touches only unpinned recitation rows, least recently **played** (every audio
  open touches the row) (WP5e 9, INT rust).
- Command limits: `mushaf_ensure_page_fonts` ≤ 12 pages; `translation_get` 1..=300 ayahs and 1..=5 packs; `wbw_get_range`
  ≤ 2,000 words; KiB rounded up (WP5e 17).

### 7.3 Adapters and revalidation (§2.5.6–2.5.7)

- **QuranEnc** transform is data-driven over the 14 real exports: number prefixes `(n) ` and `n. `, HTML fragments
  sanitised, `[n]` notes including mid-line ones, Indonesian `n)` notes, a preamble as an empty-marker general note,
  marker digits kept in their script, upstream gaps kept as published (WP5c 1). The zip is reused from staging on resume;
  the export must have exactly 6,236 rows (WP5c 3, 5).
- **Sanitising** runs ammonia in two passes plus a tokenizer; `data-ref` is validated against the Hafs counts and
  normalised; `data-fn` matches the webview's pattern; sanitising is idempotent (WP5c 2).
- **Versions:** list-sourced QuranEnc packs record the list's version; `http_validators` packs use the nginx ETag's mtime
  (`YYYY.MM`, then `.DD`, `.HHMM`); update checks send `If-None-Match` only (QuranEnc's `Last-Modified` is a constant)
  (WP5a findings, WP5c 4, 6).
- **Fonts:** files on disk are the truth (URLs carry `?v=<sha256 prefix>`); interactive and job writes use lane-private
  temps; on-demand pages are unpinned rows; `ensure_decor` pins what it fetches (WP5c 9–11).
- **QF adapters:** chapter `pinned` follows the job's pin; an empty tafsir row extends only the adjacent entry (Sa'di has no
  row for 59 ayahs); a chapter with no commentary at all is stored empty and is valid (Ibn Kathir on 105) (WP5d 2–3,
  INT fix 1 rust-app). Timings bind to the audio file's `Content-Length` and ETag from a `HEAD` (WP5d 5).
- **Upstream changes** follow one policy (`apply_upstream`): same file, same or new payload → re-stamp or replace; new file
  unpinned → drop the file; new file pinned → keep the old pair until the revalidator swaps `{sss}.mp3.next` in (WP5d 6–7).
- **Revalidator:** startup + 60 s, then every 6 h; retried every 60 s while offline; 2 at a time on the background lane;
  QuranEnc re-checked every 24 h (WP5d 13–14). On-demand chapters older than their period are served at once marked
  `stale` and refreshed in the background (≤ 1.5 s wait) (INT fix 1 rust-app).

## 8. App shell in Rust (§2.8, §6, §11.4, §13.5)

- **Font transport (D30 spike):** `url` on Windows (WebView2), Linux (WebKitGTK 2.52 applies no CORS check to scheme
  loads) and macOS (WKWebView, checked in the real app on macOS 27) (`QD_FONT_TRANSPORT=url|bytes` in debug builds). `fontBytes` accepts the
  `number[]` of Tauri's postMessage fallback; a face that fails by URL is retried once by bytes (WP6a, INT web).
- **Startup** is split into testable parts; the first launch takes the OS locale as the UI language and stores it;
  `app_bootstrap` runs in one blocking task (≈ 4 ms) and degrades a broken pack registry to `packs: []` (WP6a 2–3, 5).
  `AppState::shutdown` stops audio, hides the media session and checkpoints user.db (TRUNCATE); every exit path runs it
  (WP6a 4, WP6b 8). A deep data directory is rewritten to its `\\?\` form when < 160 characters of headroom remain
  (SQLite's VFS has no long-path support) (WP6a 13).
- **Chrome:** `window_set_chrome` maps to Mica dark/light on Windows 11, the Sidebar material on macOS, `Unsupported` on
  Windows 10 and Linux; `set_theme` is never called (WP6a 6). The frontend sets `html[data-chrome=vibrant]` only after
  success (WP7c 5).
- **Protocol** details beyond §6.3 (400 on invalid UTF-8, 503 before state, `Allow`, `Max-Age`, `HEAD`, dot segments as
  written, Range edge cases, an exact route parser): WP6a 9. `font_bytes` refuses files over 16 MiB (WP6a 10).
- `system_open_external` accepts `https:` with a host and no credentials, and `mailto:`, ≤ 2048 bytes; the reveal command
  opens the data folder itself (WP6a 8).
- **The main window is created in code** (`create: false`, `WebviewWindowBuilder::from_config`) (INT fix 1 rust-app):
  - **Navigation guard:** only the app's own origins load; new windows are denied; `https:`/`mailto:` open in the system
    handler; external drops are off on Windows, refused by a window-level drop guard elsewhere (INT fix 1 rust-app,
    INT gate 2).
  - **WebView2 crash recovery:** a crashed or hung renderer reloads (≤ 3 per minute, then a dialog); a dead browser
    process offers Restart or Quit.
  - **Placement:** the window state plugin saves but does not restore (`skip_initial_state`); `placement::restore` settles
    the frame first, sets the exact inner size and fits the window into a monitor's work area (no 43 px growth per launch
    at 150 %).
  - **Visibility:** hidden in the tray or minimised, the WebView2 controller is marked invisible, so the page draws no
    frames while the engine plays on (INT fix 2 rust-app).
- **Capabilities** are exactly: events `listen`/`unlisten`; window `minimize`, `toggle-maximize`,
  `internal-toggle-maximize`, `is-maximized`, `close`, `start-dragging`, `set-fullscreen`, `is-fullscreen`; dialog `open`,
  `save`. `removeUnusedCommands` strips the rest (INT fix 1 rust-app).
- **Snap Layouts** (Windows 11): a transparent child window `QuranSnapTarget` over the maximise button answers
  `HTMAXBUTTON` (a subclass of the app window never sees the hit test); hover and press reach the page as
  `qd:caption-button` events; `window_set_caption(visible)` (new command) removes it while zen or a modal hides the title
  bar (WP6b, INT rust).
- **Close to tray:** the question has three buttons (Keep playing in tray, Quit, Cancel; the dialog plugin maps Esc to the
  last); the window hides only while reciting and only with a tray icon; × closes otherwise; the one-time notice is a
  Windows tray balloon remembered as `hintsSeen: "tray_background"` (WP6b 3–5, INT fix 2 rust-app).
- **Quitting saves first** (LEAD 23): × with nothing kept in the tray, the tray's Quit, the close question's Quit and a
  close from the taskbar go through `window::quit`. The window hides at once and Rust emits `quit-requested` (new
  event); the page runs `app.beforeQuit` hooks (the reader's position and dwell, the player's `audio` position, a
  note draft's autosave, and the writes still on their way; at most 800 ms) and calls `app_quit`. Rust exits anyway
  after 1.5 s, and at once before the first `window_ready`, on a second request or from the WebView2 failure dialog.
  Before, WebView2 tore the page down without `pagehide`, and a turn in the last second before × was lost
  (INT final gate).
- **Tray:** labels follow playback (`TrayPlay`/`TrayPause`), transport items are disabled while nothing is loaded;
  objects live on the main thread with coalesced updates; icons per taskbar DPI; on Linux the tray is skipped when no
  appindicator library loads, instead of a panic (WP6b 7).
- **Deep links** `quran-desktop:` (ayah `2:255`/`2/255`/`ayah/…`, surah, `page/N`, `search?q=`, `view/…`) on a second
  instance and on the first launch (`window_ready`); OS scheme registration is not done (a product decision) (WP6b 9,
  INT rust).
- **Rust strings** add the tray, close-to-tray, crash-recovery, newer-library and app-name keys (en/ar) (WP6b 2,
  INT identity, INT fix 1 rust-app).
- **Debug isolation:** `QD_DATA_DIR` also holds the logs, `window-state.json` and the webview profile (INT fix 1
  rust-app). Logs: `quran-desktop.log`, 2 MiB × 3; noisy targets capped at Info (WP0A 14, INT gate 1).
- **Installer metadata:** homepage `https://quran.com`; NSIS in English and Arabic; publisher and copyright "Quran for
  Desktop contributors"; no licence page (the GPL needs no acceptance). Every bundle runs
  `src-tauri/scripts/check-release-core.mjs` first: a qdc core.db is refused unless `QD_ALLOW_DEV_CORE=1` (INT identity,
  INT fix 1 rust-app). Per-OS configs repeat the full window object (RFC 7396 replaces arrays) and carry WP-Brand's
  per-OS icons; Linux lists the tuned tray PNGs first (WP6b 11, INT identity).

## 9. Frontend architecture (§7)

- **Contracts:** `src/lib/contracts/{i18n,shortcuts,stores,settings,components}.ts` are frozen; `t(TextKey)` and
  `tp(PluralKey)`; the settings action is `resetToDefaults()` (`reset()` is the store contract) (WP0C 1–5). The
  placeholder component was deleted with the wave bridges (INT web).
- **IPC wrapper:** a rejected promise and a malformed error both become `IpcError('internal')`; `fontBytes` refuses paths
  outside the font routes (WP0C 7). The mock handles `listen`/`unlisten` itself (@tauri-apps/api 2.12.2's event mock leaks
  listeners); mock state adds a `search` slice, tombstones, `?mockReset`, `window.__QD_MOCK__`, `?qdtest` (WP0C 8–9).
  Dev URL switches: `?mockMica`, `?mockNotice=`, `?mockFatal=`, `?mockFontLatency`, `?mockFontFail`, `?mockPacks=demo`,
  `?mockPackRate`, `?mockPackFail`, `?mockNoAudio`, `?mockAudioRate` (WP7c 17, WP8b 11, WP12a 10, WP9a 16).
- **Stores** (§7.3): `settings.update` resolves a boolean and never rejects, writes are serialised and coalesced, and a
  failed write reverts (WP0E 1). Library, memo and player mutations never reject either: failures are toasted once
  (WP11c 1, WP9b 11, WP9a 8). `listenEvent` lives in `app.svelte.ts` (WP0E 8). Stores that may not import the reader take
  injected openers or targets (search `HitOpener`, the dock's `idleTarget`) (WP10b 2, WP9a 1). Work that must reach Rust
  before an exit registers `app.beforeQuit(hook)`; `app.quit()` awaits the hooks (≤ `QUIT_FLUSH_MS`, 800 ms), then
  calls `app_quit`, and answers `quit-requested` once `markReady` ran (INT final gate).
- **Safe HTML** (§7.6): the DOMPurify allow-list adds `mark` (search snippets); an `a` without a valid `data-ref`
  (`s:a` or `s:a-b`) is unwrapped; `data-fn` must be `s:a:n` on a `sup`, in any script's digits (WP0C 6).
- **Lookups:** `quran.pageRange` is every ayah with a word on the page; invalid input gives neutral values (WP0E 5).
- **Per-viewer conveniences** are kept in `localStorage`, and nothing depends on them: unsaved note drafts
  (`qd-drafts-v1`), the index tab, the search mode, the collapsed dock, the side-pane pin and the library panels' filters
  (WP7c 11, WP10a 5, WP10b 7, WP9a 9, WP11b 2, WP11c 6).
- **i18n runtime:** numeric parameters use the UI's digits; references are bidi-isolated (LRI/RLI…PDI); sizes are binary
  values with localised `Intl` units, narrow in Arabic (ك.ب/م.ب/غ.ب/ت.ب); percentages through `Intl` (WP0E 4, INT fix 2
  ui).
- **Shell layout** is a pure function of the window (`shellLayout`); below 900 px the sidebar floats as session state
  over the canvas with a scrim (WP0E 6, WP7c 3).
- **Overlays** (§7.4): the host mounts only the top overlay, and each instance opens on its own stack entry
  (`overlayOpen(kind)`), which fixes a body lock left by an overlay opened within the 260 ms exit window (WP7c 1,
  INT web). Dialogs and sheets give floating content above them a modal-layer context (popovers +1, menus +2) (INT web).
- **Shortcuts** (§7.7): precedence is an exact chord over punctuation matched by character, then the more specific scope,
  then the most recent registration; a disallowed auto-repeat is still consumed; `Shift+`punctuation matches the physical
  US key; `Mod+Ctrl` exists only on macOS; **every capture-phase Escape is decided after propagation** (a handler that
  called `preventDefault()` wins); the app Escape chain is layer → floating sidebar → non-reader view → zen (WP0E 7,
  WP7c 3, INT fix 2 ui). The audio shortcuts are registered by the dock, the study shortcuts by `AyahContextMenu`, the
  reader's by the reader (WP9a 1, WP11c 4, WP8e 9).
- **Startup** (§7.8): the font and the bootstrap load in parallel; the onboarding opens on a first run
  (`app.firstRun && !onboardingDone`), never in test mode (WP0C 12, INT web). In test mode `App.svelte` installs the
  QA hooks after mounting, from their own chunk (WP7c).
- **Canvas overlay slot** (§7.5): the transient chips (follow, division, hint) come first and the persistent bars
  (`MemoToolbar`, `SelfTestBar`) sit at its foot; while a bar is up the book ends 12 px above it (`clearBottom`, the dock
  and spread decisions unchanged) (INT fix 1 mushaf). Toasts stay above the slot's reach and never cover the Quran text
  (top placement when the text reaches the bottom) (INT fix 1 ui, INT fix 2 ui).

## 10. Mushaf renderer (§8)

### 10.1 Geometry, fit and lines (§8.2–8.4)

- **Glyph scales** (measured over all 604 pages, `scripts/measure-glyph-scale.mjs`): qcf_v2 1.03, qcf_v1 1.11, qcf_v4 0.99,
  hafs 0.82 with a 0.22 em centre gap (the Hafs face's own space advance). Scales above 1 are kept (WP8b, WP8b 1–2).
- **Unicode renditions keep a minimum word gap** (`column-gap` = the centre gap); QCF lines are unchanged (WP8a 2).
- **The hafs style is fitted per spread** (`unicodeFit.ts`): `scale = clamp(floor2(0.98 / max line demand), 0.82, 0.92)`,
  the demand measured from the page data with canvas `measureText` before the first layout; both pages share it; the
  fallback rendition of a QCF style keeps the floor. Median fill 0.75, word gap 0.48 qfs (INT fix 2 mushaf). No kashida
  (LEAD 21).
- **`fitLayout` in `auto` ranks the legibility floor above the 85 % spread preference**: a spread below `QFS_MIN` loses to a
  single page that stays at or above it (S29 is a single page in both modes) (INT web).
- Page geometry is exposed as `--mp-*` custom properties; the page context provides `qfs`/`interactive` to glyph layers;
  `performance.measure('qd:page')` spans data to committed DOM; the `pages` cache holds 48 pages, batches 8, prefetches 8 in
  the flip direction (WP8a 3–7).

### 10.2 Fonts and palettes (§8.5–8.6)

- The COLR probe runs when the first V4 page is about to show; a cached failure switches a stored `qcf_v4` back to V2 with
  the `mushaf.v4Unsupported` toast, and Settings marks Tajweed unsupported (WP8b 6, INT web).
- **No `override-colors`** (D14 changed): a multi-entry `override-colors` rule crashes Chromium's renderer (Edge and
  WebView2 154) after V4 has been drawn. The rule carries only the base palette, and the theme ink is applied by an SVG
  `feColorMatrix` colour map on the V4 lines (`filter: url(#qd-v4-ink)`), exact for every ink entry. High contrast
  multiplies the map by the mildest lift that brings every rule colour to ≥ 4.5:1; night with `prefers-contrast: more`
  draws the plain palette (WP8b 4–5 were override tables; INT fix 1 mushaf).
- A style left behind is unloaded once nothing draws it (budget 0); renditions hold their face through a cross-fade
  (INT fix 1 mushaf). Decor is requested automatically for QCF styles once per session while online, never for hafs
  (WP8b 8). The font-status dot sits in the footer band, drawn by `RenditionStack`, and retries a failed page (WP8b 7).
- **Shaping warm-up** (`warmup.ts`): the next and previous spreads are laid out off screen in idle time (3 lines per
  slice); a cold page on screen is warmed urgently inside the 120 ms font wait; a turn animates only into warm pages.
  **While flipping** a page shows its QCF rendition only if it was painted in that font before, else the Hafs fallback
  (and the cartouche header), cross-fading to QCF when the flip ends (INT gate 2).

### 10.3 Highlights, accessibility, interactions (§8.7, §8.14–8.15, §8.17)

- Pill geometry: an end with no neighbour extends 0.2·qfs; towards a neighbour ≤ 0.6·qfs; the layer reaches 0.3·qfs past
  the block (WP8d 1). One fill per word in the order search > audio ayah > arrival flash > selection > user > hover; bars
  under fills carry a page-coloured hairline and are checked by OKLab ΔE ≥ 0.15 (WP8d 2–3). In forced colours the layer
  moves above the glyphs (WP8d 4).
- **The word glide** is a compositor animation: a word change writes the pill's final box once and plays a FLIP `transform`
  animation with the spring's curve as a `linear()` easing; the player samples its position at word starts and pixel
  steps instead of every frame (INT gate 3).
- `toSpeech` maps before stripping, and maps the open tanween (U+08F0–08F2 and KFGQPC's U+0657, U+065E, U+0656) instead
  of dropping them; the spoken list adds a context span (reference, continuation, divisions); one tab stop per view; focus
  moves the cursor (WP8d 6–7). The a11y list uses the Hafs face (no system-font fallback lookup) (INT gate 2).
- **Visible** means on screen: in translation mode, the verse rows inside the feed's viewport (`reader.translationRows`);
  focus survives a page turn (INT fix 2 mushaf).
- Dwell rule for the word tooltip: ≥ 4 px of travel on the word, then 450 ms at rest; end markers get none; a hidden
  memorised word gets none (WP8d 8, INT web). The action bar is a `role="toolbar"` anchored on the selection ring; Escape
  closes it before the selection (WP8d 9, INT gate 3).

### 10.4 Furniture and marks (§8.8–8.9)

- Decor glyphs are sized by their measured metrics (`--sh-scale` 4.4, `--basmala-scale` 1.4); markers by ink height
  (0.75·qfs, ≥ 13 px). The juz calligraphy is `U+E001 + (juz − 1)` (the `juz001` ligatures), not U+E900 (WP8c 1).
- **Quarter markers with an inline ۞** (199 of 240) draw the label alone, centred on the line, and nothing below qfs 28;
  never a second ۞. Ornaments appear only with their labels (qfs ≥ 28), stroked (`max(0.5px, 0.018em)`), with the hizb
  number or the fraction inside the frame; below 28 the solid ۞ is drawn; marker ink ≥ 4.5:1 in every theme (LEAD 17,
  INT fix 1 mushaf).
- Sajda markers sit on the line where the ayah ends; the opening pages carry none; each marker appears once, on the page
  that shows its sign (WP8c 2). The CSS sajda overline is dropped: both renditions already draw the printed overline
  (WP8c print-scan 1).
- Running heads: the quarter separator is a small gold khatam (a middle dot beside Arabic-Indic digits reads as ٠); below
  qfs 20 the juz reads `ج ١٤`; the head's calligraphy is aligned on the text's ink centre (WP8c 3, INT fix 2 mushaf).
  Furniture text is set in the bundled Hafs face, so a late web font never shifts it (CLS 0) (WP8c 3a). Running head and
  footer are `div`s.
- Margin marks come from `library.marksFor` (one request per page for both layers); the ribbon uses a drop-shadow; the
  surah header opens `SurahInfoPopover` through its module controller (WP8c 5–6).

### 10.5 Spread, turns, zoom, follow-along, copy (§8.10–8.14)

- One book shadow for the spread; the spine follows a gutter curve; pages are keyed by number; a loading slot is blank
  paper in final geometry; the stage reserves the dock (84/64 px) and the side card (288 px) except in zen (WP8e 3).
- Turns: a turn requested during another replaces the waiting one and skips the running animation; turns do not animate
  while the canvas scrolls; single-page mode animates too (WP8e 2).
- Zoom keeps the point under the pointer on the book; a 0.9 s indicator shows the level; `Mod++` also zooms in (WP8e 4).
  Wheel: a single large event (≥ 50 px, one Windows notch) turns at once; a notch is one 10 % zoom step; a pinch 60 px per
  step (WP8e 5).
- Follow-along turns unless the user navigated in the last 4 s; otherwise the follow chip offers the way back (WP8e 6).
- Selection: `select` pins the side pane; a cursor off screen starts from the visible pages; history ≤ 50 jumps;
  range jumps (`goToAyah(…, { selectTo })`) flash, focus and announce the first ayah (WP8e 8, INT fix 2 mushaf).
- Copy completes the clipboard with the translation asynchronously after the synchronous Arabic part (WP8e 1); in the
  menu, C marks the format C produces (INT fix 2 mushaf).
- Persistence: the reading position is written 1 s after it settles (and flushed when the window hides); a place read
  for 3 s of visible time enters the history, topped up every minute; turns and flips do not count (WP8e 10).

### 10.6 Page navigation affordances (§8.11–8.12; WP8f)

- The page label reads "Pages 261–262", bidi-isolated; the flip HUD in the English UI leads with the Arabic surah name.
- The page rail floats above whatever is at the bottom; it reveals after 90 ms in the bottom 24 px, leaves 450 ms after the
  pointer, previews key steps and turns 350 ms after the last one, never takes focus from a pointer, and counts one history
  jump per visit.
- Turn zones hug the paper and never cover it; the first-run hint appears after the onboarding and is gone after 12 s, "Got
  it" or a turn (`hintsSeen: "page_turn"`); division arrivals greet juz and hizb once per session.

### 10.7 Memorisation rendering (§8.16; WP9b 1–4)

- End markers stay visible in hide mode; the blank style is an SVG filter (`url(#qd-memo-blank)`) because `opacity: 0`
  also hides a box-shadow underline; reveals are instant (only hover fades); `<html>` carries `data-memo`,
  `data-memo-style`, `data-memo-hover`. The Linux default stays `blur` (unmeasured on WebKitGTK).

## 11. Design system and surfaces (§9)

### 11.1 Tokens (§9.1–9.4; WP7a)

- Five §9.2 values are corrected so the table's own contrast rules hold (the smallest step that passes), and text tokens
  are derived against the real darkest surface (hover over the chrome). Night/black `--hl-word` mixes 26 %;
  `prefers-contrast: more` keeps night/black ink at full brightness (WP7a 1–4).
- Added tokens: `--accent-strong` (light), `--{danger,success,warning}-text` and `-soft`, `--danger-ink`, `--selection-bg`,
  `--glass-fill`, `--backdrop-dock`, `--backdrop-palette`, `--ink-alpha`, weight and leading tokens, `--text-reading`,
  `--text-quran-reading`; high-contrast dark values (WP7a 5–6).
- `.quran-text` uses `!important`; Arabic never gets letter-spacing; `.icon-dir` mirrors by the nearest `dir` attribute,
  not `:dir()` (the production CSS target rewrites `:dir()` into a `:lang()` list); the logical-CSS lint enforces both
  (WP7a 7–8).
- One-line ellipsis clips only the inline axis (`overflow-x: clip`, with `min-inline-size: 0`) so Arabic dots and marks
  above the line survive; text inputs stretch instead of taking a percent height (Blink resets their line box);
  `--text-faint` is for disabled and decorative text only; `src/styles/text-guards.test.ts` enforces all three
  (INT fix 2 ui).

### 11.2 Primitives (§9.5; WP7b)

- Toast is `Toaster.svelte` (svelte-sonner unstyled, F6 hotkey, paused while hovered or focused); Skeleton tints with
  `--text`; Badge fills are opaque; `VirtualList` overscan is in px; Select uses `role="combobox"` and aligns to the
  trigger's start edge; Segmented always keeps a value and arrows move focus (WP7b 2–7).
- Dialog: initial focus on `[data-autofocus]`, else the first enabled body control (never the header close button);
  variants `bare`, `placement="top"`, `backdrop="faint"`, `layer="palette"`, `dismissible`; dialogs and sheets are floating
  layers (WP7b 9, INT fix 1 ui).
- Segmented fits its group (normal, then tight, then clipped with a `title`); Tooltip is floating glass and defers Escape
  to its layer; IconButton's `aria-disabled` stays focusable; Rosette digits are size-aware (INT web, INT fix 1 ui,
  INT fix 2 ui).

### 11.3 Shell (§9.6; WP7c)

- The shell draws the sidebar heading; panels render bodies only (WP7c 2). PaneLayout keeps pixel widths, persists on drag
  end, moves 16 px per arrow key; the side pane is a `Sheet` when it cannot dock (WP7c 4).
- Window controls sit at the inline end (left in Arabic), use Segoe Fluent/MDL2 glyphs when present and show the native
  snap target's hover state; zen brings the title bar back as an overlay at the top edge (Windows has no other caption
  buttons); the pointer hides after 2.5 s (WP7c 6, 10, INT web).
- The fatal screen has three variants (`core_missing`, `no_backend`, `error`); the startup banner offers "Restore from
  backup…" and "Show files…" (WP7c 7–8, INT web). Undo toasts replace each other (`ui.toastUndo`) (WP7c 9).
- The breadcrumb opens Go to, names a spread "Pages 261–262", and separates segments with "،" in Arabic; it is keyed on
  text so a turn never shifts it (WP7c 13, INT web).

### 11.4 Surfaces (§9.7)

- **Player dock (WP9a):** Space with nothing loaded plays the resume candidate, else the selection, else the first visible
  ayah (in translation mode the top verse), exactly what the idle dock offers; the dock's box is fixed and the pill morphs
  with a `clip-path` (CLS 0); the scrubber moves on the device-pixel grid; times are LTR isolates; popovers close when
  their pane leaves; the onboarding preview is `player.preview` (`record: false`) and never becomes the resume point
  (WP9a 2, 9–10, 14; INT fix 1 ui, INT fix 2 ui, INT gate 2). Speed and volume are settings the store sends to the
  engine (mute is session state); the player writes the `audio` reading position (1 s after each heard ayah, at a stop,
  and the ayah after the range at a natural end) (WP9a 6–7). A play that failed mid-way names the surah that failed, and
  Space or Retry continue it (INT gate 3).
- **Memorisation (WP9b):** the self-test dialog has setup and rating steps (suggested answer by hints and mistakes, keys
  1–4); a test rates only the recited span; M is the registry definition `memo.mistake` during a test (beats mute); the
  Mushaf map shades pages by progress (WP9b 7, 12–13, INT web). Starting a test jumps to its start and pauses a
  recitation; hide and test leave translation mode; a finished test and a hide session of ≥ 30 s enter the history
  (WP9b 8, 10).
- **Index and Go to (WP10a):** `parseReference` accepts pasted references, `kahf 10`, Arabic forms with the article, and
  reports why an out-of-range target is disabled; surah names match through aliases and a transliteration skeleton; the
  Arabic UI joins list parts with "،"; the Continue card shows while the reading bookmark is > 2 pages from the screen.
- **Search (WP10b):** a reference query offers the jump instead of searching digits; Enter and F3 in the field step
  through hits like a find bar (focus stays); hit rows fit a three-line keyword-in-context window; the mode is remembered
  per machine.
- **Palette (WP10c):** a seventh "Search the Quran" group; Recent first when empty; commands come from the shortcut
  registry and run through a synthetic `keydown` after the palette closes; every boolean setting and the main choices
  are rows (from `defaultSettings()` and `settingsMeta`); scope prefixes `>`, `#`, `@`.
- **Translation mode (WP11a):** one virtual feed of 6,351 rows (`role="feed"`) on a 760 px sheet; typography by the
  translation's script; the position is kept by ayah to the pixel; the recited verse sits 30 % down; the column clears the
  side card; end-of-ayah marks never wrap alone (NBSP) (INT fix 1 ui, INT fix 2 ui).
- **Side pane (WP11b):** what it shows follows a fixed precedence (pin, pinning selection, recitation, selection, action
  target); a multi-ayah selection shows whole (first 30); the pin is `sidePane.follow = pinned`; the pane holds still
  while you type in it; tafsir typography follows its language; "Covers 2:253–255" for range entries; a tafsir with no
  commentary on a surah says so without Retry (INT gate 2).
- **Library (WP11c):** undo covers page bookmarks, deletes, labels, single highlight rows, note creates and edits; no-op
  changes make no entry; a restore clears both undo stacks; Delete keeps focus in the list (INT fix 2 ui).
- **Notes (WP11d):** the Markdown subset is defined (paragraphs with kept line breaks, `#`–`###`, lists incl. Arabic-Indic
  numbers and tasks, quotes, `**`/`*`/`==`, validated ayah references, web links as text that NoteBody opens externally;
  no code, tables, images); drafts autosave after 400 ms; "Discard note?" only when body text would be lost.
- **Downloads (WP12a):** one job per pack, items asked meanwhile wait in `pending`; a full download puts the pack to use;
  offline failures resume when online; "Download when online" waits instead of failing; "Download the rest" counts
  on-demand items as present (INT fix 2 ui). Surah 1 of a reciter cannot be removed while another of its surahs stays
  downloaded (it holds the basmala) (WP12a 9, WP5e 11).
- **Settings (WP12b):** one section at a time with a cross-section search; `settingsMeta` names i18n keys, options and ranges
  (the palette reads it); sliders that re-lay the window save on release; theme miniatures read a colour table verified
  against the tokens; choosing close-to-tray also marks the first-close question answered; the Mica switch is disabled on
  Linux and where `window_set_chrome` is unsupported; Settings › Storage has "Library backup" (Back up…, Restore…)
  (WP12b 1–4, INT web).
- **Onboarding and About (WP12c):** the flow state outlives the dialog; both step-3 buttons lead to the Keys step; Escape is
  Skip, outside clicks do nothing; offline locks the QCF cards; unticking "Ornate surah headers" on the Hafs card drops
  `decor` from the set; totals under 10 MB are exact kB (en 832 kB, ar 1,119 kB). About opens with a "This app" group (the GPL notice and
  "Show the licence", the source-code link, the icon credit); core-data credit follows the build (QUL for qul, the
  Quran.com API for qdc); QUL's licence line says "QUL publishes no licence for this data" until the permission is
  recorded (`QUL_PERMISSION`) (INT identity, INT fix 1 ui).

### 11.5 Brand (§9.9)

- The icon is the Quran.com قرآن mark (gold calligraphy on navy, quran_android's `ic_upcoming_app_icon.webp`, GPL-3.0;
  LEAD 16); WP-Brand's first identity (a khatam star with an open book) and §9.9's "geometry only" rule are replaced.
  Every icon is derived from that one raster by `pnpm brand` (`pnpm brand:check` verifies): the master art from 128 px
  up, a tuned redraw of the glyph for 16–64 px, a silhouette for the macOS tray template. The structure WP-Brand built
  stays: per-OS ICO (16/20/24/32/40/48/64/256) and ICNS beside the plain `tauri icon` set, colour tray icons per DPI on
  Windows and Linux, the 512 px opaque `media/artwork.png` for media sessions, `icon.icns` compared entry by entry (tauri
  writes it in random order) (WP-Brand 1–6, `assets/brand/README.md`).

## 12. Keyboard, mouse, context menus (§10)

- Alt+←/→ and F3/Shift+F3 are always handled (else the webview navigates or opens its find bar); mouse buttons 4/5 go
  back and forward; `D` toasts the page mode; `T` announces the reading mode (WP8e 9).
- Space follows the idle-target order above; the mistake key is a registry definition; Escape is decided after
  propagation (§9 above).
- The ayah context menu adds Repeat ▸ Custom… (a small dialog), Copy ▸ forms, three study rows (Translation, Tafsir, Word by
  word) and Memorize ▸ Hide from here (WP11c 5).
- The reference parser's extra forms and the vectors in `src/lib/text/refparse.vectors.json` are WP10a 1–2.

## 13. Internationalisation (§11)

- `common` adds `appName` ("Quran" / "قرآن") and `appFullName`; `errors.*` keys are the snake_case `AppError` kinds
  (WP0C 4, INT identity). Furniture drawn on the page is always Arabic with Arabic-Indic digits and lives in
  `ornaments.ts`, not in dictionaries (WP8c 7).
- Arabic list separators are "،" wherever a middle dot would sit beside Arabic-Indic digits (index, breadcrumb, side pane)
  (WP10a 6, INT web). Two numbers around a separator in Arabic digits are LTR isolates (WP9a 14).
- The Arabic UI uses IBM Plex Sans Arabic from WOFF2 only (the WOFF 1 fallbacks are dropped at build time) (WP13b 2).

## 14. Testing and QA (§12)

- **QA harness (WP13a):** the scenario context adds `qd`, `boot`, `relaunch()`, `pending()`, `allowConsole()`; `meta` is
  validated strictly; a third status `pending`; the mock server runs inside the driver (no orphaned Vite); the app driver
  gives each scenario a fresh app and `QD_DATA_DIR`, picks a free CDP port from 9333, takes a machine-wide lock, and
  forces the null sink; ids outside the registry are found in sibling suites (`--only metrics`); baselines live in
  `tests/e2e/baselines/` (gitignored) and fail only with `--fail-on-diff`; console errors fail a scenario.
- **`window.__QD_TEST__`** adds `state()`, `ipc()`, `busy()`, `closeOverlays()`, `sampleFrames(on)`; `waitIdle` also waits
  for a queued shaping warm-up and neighbour prefetch; `metrics()` adds `pageCacheSize` and `qcfFontFaces` (WP13a 8,
  INT gate 2, INT gate 3).
- **Metrics suite** (`pnpm shots:app --only metrics`, `tests/e2e/metrics/`): one app process measures CLS, long tasks,
  `qd:page`, turn and flip timing, the glide, FontFaces, palettes and CSP, and writes `metrics-report.json`
  (`qd-metrics-report/2`); CPU and memory count the app **and** its WebView2 processes; `scripts/qa/idle-cpu.mjs` measures
  idle CPU without test mode (WP13b 5, INT fix 2 tooling).
- **Scenarios** S01–S38, `smoke`, `ic2` (IC1/IC2 pass in the real app). S38 (new) asserts that a recitation requests no frame
  loop and that the page draws nothing while hidden in the tray (INT gate 3). `relaunch({ close: true })` quits the way a
  user does (the window's close, not the harness's `app_quit`); S35 uses it to check that a turn made inside the
  position's debounce survives the close (INT final gate).
- **Single instance** is keyed by the bundle identifier: concurrent real-app runs of renamed exes forward to each other,
  so ad-hoc scenarios take the driver's app lock (INT fix 2 rust-app).

## 15. Build, CI and release (§13)

- **CI (WP-CI):** `check-artifacts.mjs` refuses every SQLite file, QDC responses, fixture-shaped JSON, executables and fonts
  by content, opens archives recursively and fails closed; one composite action holds every upload; the policy check
  (pinned SHAs, guarded uploads, caches, fork guard, triggers, permissions, the default-icon hash, release uploads) runs in
  `lint`; actions are pinned to releases ≥ two weeks old; `ci-result` is the one required check; `QD_CORE_DB` is absolute
  in `test-core`.
- **Build job:** every OS builds its installers around the 0-byte core.db and enforces the size rows and the installer
  contents (`check-bundles.mjs`) (WP13b 3).
- **Release (WP13b):** `release.yml` builds a draft release from a `v*` tag (versions checked by `check-version.mjs`) with a
  core.db built from the private QUL store (`QUL_SOURCES_URL`/`QUL_SOURCES_TOKEN` in the `release` environment; the
  committed manifest's hashes decide); tauri-action is pinned at v1.0.0 and only builds; uploads go through the guarded
  `release-upload` action; a person publishes after `docs/RELEASE_CHECKLIST.md`.
- **Signing:** macOS ad hoc with the hardened runtime until a Developer ID exists (then notarised with no workflow
  change); Windows unsigned until the lead picks Azure Trusted Signing or SignPath Foundation; Linux assets get `.sha256`
  (WP13b signing).
- **Budgets (§13.6):** "MB" means MiB; `BUDGETS` in `scripts/size-budget.mjs` is the single table; runtime rows are measured
  on the debug build (an upper bound): cold start to first contentful paint, idle CPU ≤ 0.5 % (app and webview, no test
  mode), memory as private working sets, playback CPU of the app and webview over 20 s on the null sink (WP13b 1, 5).
  The NSIS installer is 7.69 MiB after dropping the unused WOFF 1 fonts (WP13b 2).

## 16. Open items and what remains (§15)

**For a person to decide or do** (release blockers are in `docs/RELEASE_CHECKLIST.md`):
- Brand approval from the quran organisation's maintainers (LEAD 16).
- Written permission for QUL (and ideally QF) data in a distributed core.db, recorded in `data/sources/README.md` and as
  `QUL_PERMISSION` in About; until then no qul core.db ships (§15.3 item 1).
- Code signing (Windows certificate; Apple Developer ID).
- The final `repository` URL (`SOURCE_URL` in About follows Cargo), the Debian Maintainer e-mail, the QUL archive and its
  hashes in the manifest.
- A Chromium bug report for the multi-entry `override-colors` crash (repro in the Mushaf round's scratch scenario); once
  fixed upstream, the high-contrast override tables could return.
- Product decisions left open: OS registration of the `quran-desktop:` scheme; reciter 173's missing basmala (borrowing
  reciter 7's would need a catalog field); a dedicated "close the other program" restore message (needs an error kind).

**Measured misses** (`pnpm shots:app --only metrics`, debug build with CDP, shared machine): the jump to page 1 is one
≈ 240 ms task (the first raster of the opening spread's surah-header glyphs); one turn in twelve takes ≈ 55 ms (first visit
of freshly loaded page fonts); a flip has 4–5 frames over 32 ms. §13.6 rows: playback CPU 5.3 % / 7.9 % against 3 % / 6 %,
memory ≈ 430 MiB against 350 (mostly the WebView2 renderer and GPU processes), cold start 0.95–1.2 s against 0.8 s. All
need the release build on a quiet machine; memory also a renderer-heap profile.

**Not verifiable on the Windows dev machine:** Linux runtime behaviour (WebKitGTK memo budget, window placement, drop and
navigation guards, MPRIS live tests), the macOS drop and navigation guards and Control Center's Now Playing, the
installers on CI, a real GitHub run, NVDA and VoiceOver passes over 1:1–7, 2:255 and 38:24, and the R4 listening test
(`dsp_listen`, 3 reciters × 5 speeds). Each is a `RELEASE_CHECKLIST.md` row. The rest of the macOS rows were checked on a
Mac ([`deviations/WP-macOS.md`](deviations/WP-macOS.md)); there the app menu's Quit (Cmd+Q) now goes through
`window::quit` and saves like the tray's Quit (LEAD 23), while the Dock's Quit and logout still end the app without
`quit-requested`.

**Optional, not done (reasoned in INTEGRATION.md):** lazy audio planning; a `position_list` command; a `search_history`
`UserDataKind`; `ContentDb` stamp-only updates; the CSP's unused `blob:` and `media-src quran:` sources.

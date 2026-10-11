# WP0B deviations (Rust crate skeletons)

## Deviations from ARCHITECTURE.md

1. **Glue constructors are generic over the tauri `Runtime`.** `packs_glue::build<R: Runtime>(app: &AppHandle<R>, ..)` and
   `AudioService::start<R: Runtime>(app: &AppHandle<R>, ..)` instead of `&tauri::AppHandle` (callers passing
   `&tauri::AppHandle` still compile, `R = Wry`), so `setup::build_state` stays generic and testable with
   `tauri::test::mock_app()` (WP0A request). The glue stores a type-erased emitter, not an `AppHandle`.
2. **Events from the glue use `tauri::Emitter::emit(E::NAME, ..)`**, not tauri-specta's `Event::emit`: the latter
   `expect`s the event registry (panics, i.e. aborts in release) when `mount_events` has not run. For app events the
   name is identical (`resolve_tauri_event_name` returns `E::NAME` without a plugin); a test pins `"packs-changed"` and
   `"network-changed"` and their payloads.
3. **quran-core frozen surface additions:** `CORE_SQL`, `CONTENT_SQL`, `PACK_SQL`, `USER_MIGRATIONS` (`include_str!` of the
   §3 files, so xtask and the DB owners share one copy); `normalize::{is_stripped, register_ar_norm}` (the step-1 set
   for G13; the one `ar_norm(text)` = Loose definition for CoreDb and UserDb: NULL→NULL, numbers as text, BLOB is an
   error); `CoreError::is_corruption()` (for `open_or_recover`); `InstalledStatus` (`installed_pack.status`).
   `NORMALIZER_VERSION` is defined in `normalize.rs` (§2.2.3) and re-exported by `lib.rs`. Each SQL file starts with a
   one-line provenance comment; the statements are verbatim and a unit test applies each of them (pack.sql for all four
   tokenizers, user migrations through `rusqlite_migration::validate`).
4. **`fold_latin` drops exactly `General_Category = Mn`** via an embedded table generated from Unicode 17 (Node ICU
   78.3); spacing marks (Mc) are kept, as the spec says.
5. **Golden vectors**: 48 rows = the 14 §2.2.3 rows (parsed from the spec text, so the code points are the spec's) + 34
   extra rows, every row cross-checked against an independent JS implementation using `String.normalize('NFKC')`.
   Extra rows pin e.g. QPC dagger alef (`ٱلۡكِتَٰبُ` → `الكتب`), ZWNJ joining words, `ﷺ` expansion, NBSP, decomposed
   hamza/maddah composition. Kept to the exact `{"in","strict","loose"}` shape.
6. **Extra file** `crates/quran-core/tests/normalize_golden.rs` (WP0B): the golden file through the public API, which
   also compiles `tests/support/mod.rs` (otherwise unchecked until WP1a's first test).
7. **quran-audio**: extra deps `serde`, `serde_json` (QD_AUDIO_SINK=wav JSON-lines log, D24); feature `testing` plus a
   self dev-dependency so `tests/*.rs` see `fake_out`; all modules `pub` (tests drive decode/output/dsp), `sink` is
   `#[cfg(debug_assertions)]`. `AudioError` derives `Clone + PartialEq + Eq`. It has no NotImplemented variant, so
   wave-0 stubs return `Invalid`/`Source("not implemented: …")`. `traits.rs` adds `SurahTimingSet::ayah`,
   `OpenedSource::complete` and `NullEventSink`. `shared.rs` (frozen) defines: constants (`MARKER_RING_SLOTS` 4096,
   `SYNC_INTERVAL_MS` 100, `FADE_MS` 4, `PAUSE_RAMP_MS` 8, `DEVICE_RETRY_MS` 2000, `SKIP_RESTART_WINDOW_MS` 1500,
   `FULLY_BUFFERED` 1000); `MediaRate::{FROZEN, new, advance_us}` (128-bit, never divides by 0); `Marker::{INITIAL,
   position_at}`; `Shared` helpers; `status_to_u8`/`status_from_u8`; `idle_snapshot()`; `DecodeParams`;
   `OutCmd { Rebuild { generation /* output generation */ }, DeviceChanged, Shutdown }`;
   `DecodeCmd { Load, SourceReady, SourceFailed, Jump, Seek, SetSpeed, SetRepeat, SetGap, SetAbLoop, NewOutput {..,
   resume_at_us: Option<u64> }, Stop, Shutdown }`; `CtlMsg { NeedSource, DecodeFailed, QueueEnded, OutputReady,
   OutputFailed }`. `CtlCmd` (engine → control) stays private to WP4c's `control.rs`/`engine.rs`. `source.rs` adds the
   `OnlineFn` alias and `LocalFileSource::new(root)`. `dsp/{resample,mix}.rs` and the thread modules are doc-only:
   their APIs are not in the spec and belong to WP4a/WP4b/WP4c.
8. **quran-packs**: extra deps `hex`, `regex`, `rusqlite` (reads QuranEnc's `translations` table), `url`, `parking_lot`,
   `time`, `dunce`. `Adapter` is also the catalog `source` union (`#[serde(tag = "adapter")]`, configs
   `deny_unknown_fields`): `QcfFontPagesConfig` (+`FontVariant`), `StaticFilesConfig` (+`StaticFile`),
   `QuranEncSqliteConfig` (+`VersionSource`, `ContentKind`), `QurancomTafsirConfig`, `QurancomWbwConfig`,
   `QdcAudioConfig`. `ItemKey` maps `p262`/`002`/`ch18`/`file:{path}` and a new `pack` key for whole packs.
   `AdapterCtx` holds owned clones (`pack_id, kind, packs_root, http: http::Http, core, user, content,
   writers: writers::Writers, job: Option<jobs::JobHandle>, pin`), which fixes the type **names** `Http`, `JobHandle`,
   `Writers` for WP5b (fields and methods are WP5b's). `ItemOutcome { Stored { bytes, sha256 }, Present { bytes } }`,
   `StagedPack`. Fixed per-adapter signatures: `qcf_font_pages::fetch_page`, `static_files::fetch_file`,
   `quranenc_sqlite::{install, check_update}`, `qurancom_tafsir::fetch_chapter`, `qurancom_wbw::fetch_chapter`,
   `qdc_audio::{fetch_surah, check_update}`; a compile-time test requires every adapter future to be `Send`.
   `Adapter::items` adds surah 1 to any `qdc_audio` item scope; an out-of-range item is
   `PackError::Core(CoreError::InvalidArgument)` (→ `invalid_argument`; `PackError` has no such variant).
   `PackError::Io` → `AppError::Io` (missing from the §5.2 table). `CatalogPack.attribution` reuses
   `quran_types::Attribution` (same shape). `PackManagerConfig` and `PackEvents` live in `manager.rs`, re-exported.
9. **xtask**: `quick-xml` with the `serialize` feature; `fetch-dev-packs --all-pages` (WP3c deliverable);
   `verify-core --report` has no default (written only when given). Defaults are anchored at the workspace root;
   paths given on the command line are relative to the cwd. `verify::verify_db(db, report)` is what `build-core` calls:
   the WP0B stub warns and returns `Ok` so WP3a's pipeline runs end to end before WP3b, while the `verify-core`
   command itself fails until WP3b. `fixtures/mod.rs` holds the §4.6 lists (`PAGES`, `AYAH_WINDOWS`, `TIMING_SURAHS`,
   `SEARCH_QUERIES` with file slugs; `الرح*` is stored as `الرح`, since smart mode prefixes the last token) and fixes
   the `manifest.json` shape `{ builtAt, source, pages: [n], ayahWindows: [[from, to]], packs: [id],
   timings: [{ reciterId, surah }], queries: [{ slug, request: SearchRequest }] }`; `--only` keeps the other domains'
   parts. Exporter signature: `export(ctx: &FixtureCtx, manifest: &mut Manifest) -> anyhow::Result<()>`.
10. **media-session**: `CommandHandler` alias, `PlaybackState::STOPPED` + `Default`, `Status: Default`,
    `MediaSessionError: Clone + Eq`. `set_process_app_user_model_id` is complete (WP0A request done; `media.rs` calls it).
11. **src-tauri**: `AppPaths::{user_db, content_db}`; `Fatal` gains `Core`, `Database { name }`, `Packs`, `Audio`;
    `init` uses a private `build` that also returns the loaded `Settings` for step 5 (`build_state` keeps its
    signature). A failing `settings_load` falls back to `Settings::default()` with a warning (always in wave 0). The
    media `on_command` routes `Raise` to `window::show_main` and the rest to `AudioService::handle_media_command`
    (implemented: SetRate rounded to 5 % and clamped, NaN → 100). `media.rs` uses `desktop_entry = "quran-desktop"`
    until WP6d pins it.

## Requests

- **WP0A / lead (src-tauri/Cargo.toml):** `memo_test_start` picks a random start "(fastrand)" (§5.13), but `fastrand` is
  not a src-tauri dependency. Add `fastrand = { workspace = true }` (2.5.0 is already in Cargo.lock).
- **WP5e / WP4d:** `CachingHttpSource::new` takes a `reqwest::Client` and src-tauri has no `reqwest` dependency. Expose the
  shared client from the pack manager (e.g. `PackManager::http_client() -> reqwest::Client`); the glue can then use it
  without naming the crate.
- **WP4d / WP6a / WP6b:** `tray::set_now_playing` and `media::on_audio_state` take `&tauri::AppHandle` (Wry), while
  `AudioService` is built inside the generic `build_state`. Suggested: an `AudioService::attach_ui(&tauri::AppHandle)`
  called from `setup::after_manage` (already Wry) to install the tray/media hooks, or generic hooks from WP6b/WP6c.
- **WP1b:** `fold_latin` drops Mn marks (viramas, nuktas in Devanagari/Bengali) but `unicode61 remove_diacritics 2` keeps
  them in `plain`-folded packs (hi, bn, …): fold queries for those packs with the tokenizer's own rule, not `fold_latin`.
- **WP4b:** `plan()` returns `Vec<Segment>` per §2.3.3, but the offline basmala skip must reach
  `AudioSnapshot.basmala_skipped`; record the chosen channel (e.g. a plan outcome type) as a deviation.
- **Lead:** `xtask` is a binary crate, so the §4.6 list constants carry `#[allow(dead_code)]` until their readers land.

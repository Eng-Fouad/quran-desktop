# WP5e deviations (PackManager, packs glue, content/packs commands, IC2)

Owned and delivered:
- `crates/quran-packs/src/manager.rs`;
- `crates/quran-packs/tests/{manager_jobs, manager_registry, manager_cache, manager_content, live}.rs` and their helper
  module `tests/manager_support/mod.rs` (named after the owned `manager_*` prefix; not a test target);
- `src-tauri/src/packs_glue.rs`, `src-tauri/src/commands/{packs, content}.rs`;
- the IC2 scenario `tests/e2e/scenarios/ic2.mjs` (deviation 19).

WP5e owns no i18n dictionary, mock handler or web scenario PNG (the IC2 shot is from the real app).

## Deviations from ARCHITECTURE.md

1. **`PackManager::pause` and `cancel` are `async`** (§2.5.2 has them synchronous).
   - The job runner settles a queued, paused or failed job (journal, registry row, terminal event) asynchronously.
   - Awaiting it lets `packs_pause`/`packs_cancel` return after the state is settled and report `NotFound`.
   - Their only callers are the commands in `commands/packs.rs`.
2. **Public API additions** (all in `manager.rs`):
   - `ManagerOptions` and `PackManager::with_catalog(cfg, catalog, events, options)`: a manager on an already loaded
     catalog with explicit tunables. `new` loads and validates the catalog, logs `starter_issues()` as warnings (WP5a's
     request), then calls it. Tests point catalog packs at a local server; the validator requires https.
   - `http_client()`: the pack layer's file client (LEAD item 2).
   - `refresh_surah_timings(reciter, surah)`: WP4d's request 2, wrapping `qdc_audio::refresh_timings`.
   - `startup() -> Option<StartupReport>`: what `start_background` spawns, awaitable and run once.
   - `resync(pack_ids) -> ResyncReport` (deviation 7).
   - `stream_cache_cap_bytes()`, `shutdown()` and `impl Debug`.
   - Constants `CHANGES_COALESCE` (150 ms) and `CHAPTER_CONCURRENCY` (4).
3. **`packs_changed` is coalesced over 150 ms** (`ManagerOptions::changes_coalesce`).
   - A prefetch or a reading session records many on-demand items in a row; the UI gets one `PacksChanged` per burst.
   - Duplicate ids are merged.
4. **The "Update" of a recitation pack is a job.**
   - The trigger is `install(id, All)` on a recitation pack whose update the revalidator knows (WP5d's and WP12a's
     requests).
   - The job runner skips pinned items, so this job has one pseudo item, `file:update`. Its work is
     `Revalidator::revalidate_pack(id)`, which is serialised with the scheduled passes: two writers can never share a
     `.mp3.next` temp. A pause or cancel stops it between chunks; the `.next` temps stay for the next attempt.
   - The UI therefore gets a real job id with `queued → started → completed` (or `failed`/`paused`/`cancelled`) and a
     completion toast. Nothing downloads the 114 surahs of a partial pack.
   - The update job is the only recitation job that does not pin. That is how the spec source rebuilds it after a
     restart (`JobSpec::pin == false`).
   - The pseudo `pack_item` row is deleted when the job ends, and again before an update is queued.
   - A swap that failed in the revalidator is reported as `PackError::Http { status: 0 }` (kind `network`) with
     "n of m changed recitations could not be updated". The old pairs stay in use and the next pass retries them.
5. **Requirements.** A scope-`All` install also queues `All` for every pack in `requires` that is neither installed
   nor already queued (WP12a's request). A failure there is logged, and the pack itself still installs. Item
   installs never pull requirements in.
6. **On-demand items are recorded.**
   - Chapters that `tafsir_entry`/`wbw_range` fetch become `pack_item` rows `ch{N}` with the adapters' size measure.
   - They are unpinned, or pinned when the pack's row is `installed`, which is the "scope `All`" pin of WP5d's request.
   - `PacksChanged` is emitted for a new row.
   - The fetch runs once per `(pack, chapter)` in flight (`InFlight`), recording included.
   - Streamed audio is recorded by `audio_stream_end` as `{sss}` with `pinned = 0`, keeping an existing pin, and
     `sha256 = ""` (not hashed). The cache cap is then enforced.
7. **Re-sync** (§2.5.5 "Content DB re-sync") runs at startup and after "Clear cache". Every item row is checked
   against what backs it:
   - **Rows dropped:**
     - a page, decor or audio row whose file is gone;
     - a chapter row whose content.db chapter is gone;
     - a row that is not an item of its pack (such as the update job's pseudo row).
   - **Rows added:** a chapter stored in content.db without a row (fetched by an older build, or the row was lost).
   - **Whole packs:** an `installed` whole pack whose `pack.db` has gone is no longer installed. Its rows are dropped
     and its cached handle released.
   - **The pack row is recomputed** with the runner's policy: `installed` when every catalog item is present and
     pinned, else `partial`; no row without a pinned item. `paused`/`failed`/`removing` are kept.
   - **Pinned recitations whose timings are missing** (a recovered content.db):
     - they keep their pin, so they are never demoted to the evictable cache, which the cap would then delete;
     - they count as not present, so the pack is `partial` and never "installed" without its data;
     - they are reported in `ResyncReport::missing_timings`.

     At startup, when the network is allowed and reachable, their timings are fetched again on the background lane
     (`qdc_audio::refresh_timings`, no audio), and stored pinned when the file on disk is the one they describe. The
     pack is then re-synced.
   - A pack with pinned items that are all incomplete keeps a `partial` row with `items_present = 0`.
8. **Known updates of whole packs survive restarts.**
   - They are kept in content.db's `kv` under `packs.known_updates`, as `{update, checkedAt}`.
   - An update stays valid while the installed version is the one it was found for, and no later check has run
     (`installed_pack.last_checked_at <= checkedAt`).
   - Without this, an "Update available" badge vanished at the next start for up to 24 h, until the revalidator's
     daily QuranEnc re-check.
   - Recitation updates use only the revalidator's live findings, because it applies them in the background.
   - "Clear cache" clears `kv`, and the findings with it.
9. **Stream-cache eviction.**
   - Only `pinned = 0` rows of recitation packs are evicted (WP5c's request: on-demand Mushaf pages are unpinned rows
     too).
   - The order is least recently used first (`last_used_at`, set when a stream promotes the file).
   - The glue has no hook for a play from the cache, so "used" means "last streamed".
   - Never evicted:
     - a file being streamed or claimed by a job (`Writers::info`);
     - an item of an active or paused recitation job;
     - a file Windows still holds (it is skipped, not an error).
   - "Clear stream cache" also deletes `{sss}.mp3` files that no row accounts for, unless a job of that reciter is
     active. Job and stream temps are never touched.
10. **Removing single chapters.** ContentDb has no per-chapter delete (Request to WP1c below), so `remove_items` on a
    Quran.com pack works in two steps:
    - it reads the pack's other chapters (rows and stamps) and deletes the pack in one transaction (`delete_pack`);
    - it writes each kept chapter back with its own stamp (`fetched_at`, sha256, pin).

    An interruption between the two steps loses the kept chapters' rows, which the next re-sync turns into a
    `partial` pack. Nothing is ever reported present without its data. The integration test checks that stamps and
    rows of the kept chapters are unchanged.
11. **Removal.**
    - **Per-item packs:** `remove` deletes the variant directory (Mushaf pages, including pages read on demand), the
      pack's decor files, or the reciter's directory. A live stream's temp is kept. It then deletes the pack's
      content.db rows (chapters, or a reciter's timings) and the rows.
    - **A file that cannot be deleted:** the row stays `removing` (shown as not installed). The startup sweep reports
      it in `pending_removals` and `startup()` finishes it. A later `install` finishes it first, or answers `conflict`
      while the file is still held.
    - **`remove_items`:**
      - for a surah, it also deletes the pending `.mp3.next` swap and its temps, and an abandoned stream temp;
      - the surah's pinned timings become cache (they are kept);
      - surah 1 stays while another surah of the reciter stays pinned (WP5d's request);
      - an item whose file is held keeps its row; the call fails only when no item could be removed.
12. **`disk_usage`.**
    - Directory sizes per category.
    - Audio is split by its row's pin: job temps and a pending `.mp3.next` count as pinned; `.stream.part` and files
      without a pinned row count as stream cache.
    - `total_kib` also counts in-progress downloads (`packs/.staging`).
    - `data_dir` is the dunce-simplified parent of `packs/`.
13. **`translation_db`** serves every installed whole pack with a pack DB (QuranEnc translations and tafsir: search
    and `tafsir_get` use it).
    - A pack that is not installed, or has no pack DB, is `NotFound` (WP1a's and WP1b's requests).
    - A missing file is `Core(NotFound)`.
    - Handles are cached per pack and reopened when the installed path changes. The flip's `release_pack` and the
      removal drop them.
14. **`tafsir_entry`:**
    - **Quran.com packs:** `lang`/`dir` come from the catalog pack (`language`, `direction`, else `en`/its script
      direction). `fetched_at` is the chapter's stamp in seconds. `stale` is true when the copy is older than
      `revalidateDays` and could not be refetched.
    - **QuranEnc packs:** `lang`/`dir` come from the pack DB's `meta`, with `fetched_at: None`.
15. **`wbw_range`** fills `WbwEntry.text` with `word.text_hafs` from core.db through one range query, since CoreDb
    has no API for it. With an unavailable core.db (the debug degrade path) it answers `not_found`.
16. **`reciters()`.**
    - `word_level` stays the catalog's until timings of the reciter are stored; then it is true when any stored surah
      has word segments.
    - `downloaded_surahs` / `cached_surahs` count pinned / unpinned surah rows.
    - It reads user.db and content.db (Request to WP4d).
17. **Command details** (`commands/{packs, content}.rs`); the bindings are unchanged:
    - **Pack ids** are trimmed. An empty id, or one over 64 bytes, is `invalid_argument`.
    - **`mushaf_ensure_page_fonts`:**
      - at most 12 pages, each in 1..=604;
      - an empty list answers an empty list;
      - one status per requested page, in order.
    - **`translation_get`:**
      - 1..=300 ayahs and 1..=5 packs;
      - ids are deduplicated, first occurrence wins;
      - a pack without an entry for an ayah is left out of that row;
      - footnotes are read per ayah;
      - a pack that is not installed fails the call with `not_found`, which the store handles pack by pack.
    - **`wbw_get_range`:** at most 2,000 words.
    - **KiB** results are rounded up.
    - **`packs_subscribe`** registers the channel before it snapshots the jobs, so nothing falls between the two.
18. **LEAD item 2 done in WP4d's file.** `AudioService::start` now passes `Some(packs.http_client())`, and its private
    client builder and two timeout constants are removed. LEAD item 2 assigns this switch to WP5e.
    - The pack layer's file client has the same User-Agent, system proxies, connect and idle-read timeouts, and no
      decompression.
    - WP4d's suites still pass: `cargo test -p quran-desktop --lib` gives 157 passed.
19. **IC2 scenario `tests/e2e/scenarios/ic2.mjs`** (`meta.mode: 'app'`; not in any package's owned list; IC2 is
    WP5e's acceptance).
    - **Recitation.** It plays Alafasy 1:1–1:7 into `QD_AUDIO_SINK=wav:artifacts/ic2.wav` (absolute path; never the
      speakers). It checks:
      - every playing tick of the sink log, in ayah order, against the stored timings: `wordPos` must equal the
        engine's rule (the last word that started), with no tolerance;
      - every ayah highlights at least 2 words;
      - the WAV size;
      - the stream-cache count.
    - **Fonts.** It downloads the QCF v2 fonts of pages 1–3 through `mushaf_ensure_page_fonts`. It checks:
      - the `wOF2` files in the data dir, and the content-hashed URLs and `rel`;
      - the cached (unpinned) items;
      - that page 1 renders in `qcf_v2` with WP8b's `assertPage`: one QCF rendition in its page font, every line
        fitted;
      - that the `qcf-v2-p1` FontFace is loaded.
    - **Cleanup.** It deletes the 18 MB WAV at the end; set `QD_KEEP_IC2_WAV=1` to keep it.
20. **Acceptance syntax.**
    - `cargo test -p quran-desktop --lib packs_glue commands::packs commands::content` is rejected by cargo 1.99,
      which accepts one TESTNAME (WP1a, WP4d and WP6b report the same). It runs as
      `cargo test -p quran-desktop --lib -- packs_glue commands::packs commands::content`.
    - The command tests build the app's real `AppState` (`setup::tests::build_mock`), so they are debug-only like
      WP4d's: the audio service needs the debug null sink.

## Requests

- **WP6a:** call `state.packs.shutdown()` in `AppState::shutdown`. It stops the revalidator and its requests at their
  next chunk. Jobs need nothing: their journals resume them at the next start.
- **WP4d:**
  - `audio_list_reciters` should call `state.audio.reciters()` inside `blocking`, because `PackManager::reciters`
    reads user.db and content.db (15 small indexed queries).
  - Optional: the rule-7 path in `TimingsStore::on_file_mismatch` can call `PackManager::refresh_surah_timings`
    instead of "delete unpinned, then `surah_timings`".
- **WP1c:** `ContentDb::delete_chapter(pack_id, surah)`, deleting the chapter's `wbw`/`tafsir_entry` rows and its
  `content_chapter` stamp in one transaction. `remove_items` would then delete one chapter in place of deviation 10's
  two-step rewrite.
- **WP12a:** none needed. `install(All)` on an `update_available` recitation returns a real job id (deviation 4).
  `packs_items` lists the not-yet-present items of a running or paused job as `queued`, and `PackInfo.job` carries the
  live job.
- **Lead:**
  - fold deviations 1–17 into §2.5.2, §2.5.5 and §2.5.7, and 18–19 into LEAD item 2 and §12.6;
  - fix the multi-filter acceptance syntax in §14.3.

## Verification (Windows 11, `CARGO_TARGET_DIR=C:\qdt\WP5e`)

| Command | Result |
|---|---|
| `cargo test -p quran-packs --test 'manager_*'` | manager_cache 7, manager_content 6, manager_jobs 6, manager_registry 8 passed |
| `QD_NET_TESTS=1 cargo test -p quran-packs --test live -- --ignored` | 2 passed (`install_resume`, `on_demand`) |
| `cargo test -p quran-desktop --lib -- packs_glue commands::packs commands::content` | 11 passed |
| `cargo test -p quran-packs` / `cargo test -p quran-desktop --lib` | every suite green / 157 passed |
| IC2: `pnpm tauri build --debug --no-bundle` + `node scripts/qa/app-driver.mjs --scenario tests/e2e/scenarios/ic2.mjs --exe C:\qdt\WP5e\debug\quran-desktop.exe --strict` | passed |
| `cargo clippy -p quran-packs -p quran-desktop --all-targets -- -D warnings` | clean (also `--release`) |
| `pnpm bindings:check` | up to date |
| `rustfmt --edition 2024 --check` (owned files), `prettier`/`eslint`/`tsc` on `ic2.mjs` | clean |
| DoD grep `NotImplemented\|not implemented` on the owned paths | no match |

**Live run, 2026-10-10:**
- `tr.en.saheeh` 1.1.2 was installed from quranenc.com (6,236 entries).
- `mushaf.v2` pages 1–3 and Alafasy surah 1 were installed, its timings bound to the file's `Content-Length`.
- Surah 67 (7,107,428 bytes) was killed at 1,051,444 durable bytes. After the restart the job resumed, and the
  smallest temp size seen was exactly 1,051,444. It never restarted from 0. It completed byte-exact.

**IC2 run:**
- 1,391 playing ticks over ayahs 1–7, with 0 `wordPos` mismatches. Words highlighted per ayah: 4/4/2/3/4/3/9.
- WAV of 18,424,378 bytes.
- Pages 1–3 downloaded on demand. Page 1 rendered in one `qcf-v2-p1` rendition at glyph scale 1.03 (minimum
  line fit 0.93).
- No page or console error, and no panic.

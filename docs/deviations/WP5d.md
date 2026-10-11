# WP5d deviations (QF adapters and revalidation)

Owned and delivered: `crates/quran-packs/src/adapters/{qurancom_tafsir, qurancom_wbw, qdc_audio}.rs`,
`crates/quran-packs/src/revalidate.rs`, `crates/quran-packs/tests/{qf_tafsir, qf_wbw, qf_audio, revalidate_pass,
revalidate_updates}.rs` and their shared helpers `crates/quran-packs/tests/qf_support/mod.rs` (see deviation 15).
WP5d is Rust-only: it has no i18n dictionary, mock handler or scenario PNG.

## Deviations from ARCHITECTURE.md

1. **Shared QF plumbing lives in `revalidate.rs`.** That module holds the QF policy the three adapters share:
   - `MAX_AGE` (7 days), `max_age(pack)` (`revalidateDays` clamped to 1..=7) and `is_fresh`;
   - `ChapterChange`/`ChapterState`, the pagination helper (`next_page` loop, payload hash, at most 64 pages), and
     `blocking`;
   - the **API roots** `QURAN_COM_API` (`https://api.quran.com/api/v4`) and `QDC_API`
     (`https://api.qurancdn.com/api/qdc`). They are process-wide `ApiRoot`s that can be pointed at a mirror. The
     integration tests use them to point at a local server; `adapters/mod.rs` is frozen, so the config types could
     not carry an endpoint. Audio file URLs need no override: they come from the timings payload.
2. **Chapter `pinned` = the job's `pin`** (an explicit download). For "download all" that is the spec's "installed
   with scope `All`". It also covers chapters downloaded explicitly one at a time, so `content_chapter.pinned` always
   agrees with `pack_item.pinned`, which the job runner writes from the same flag. On-demand fetches store
   unpinned rows. Pins only ever go up (`*_put_chapter`, `timings_put`).
3. **Tafsir grouping (§2.5.6 "a row with empty text extends the previous row's range").**
   - An empty row extends the previous entry **only when that entry ends on the ayah right before it**. Quran.com
     tafsir 91 (As-Sa'di) has no row at all for 59 ayahs (WP5a). Without this rule an entry could claim an ayah
     upstream gave nothing for; with it, such an ayah is a legitimate "no tafsir for this ayah".
   - Text that sanitises to nothing counts as empty.
   - Rows of another surah or past the surah's end are dropped, and a repeated ayah keeps its first non-empty text.
   - A chapter without any text is an integrity failure. It is never stamped as present.
   - The HTML goes through WP5c's `transform::html::sanitize`, off the async workers.
4. **Payload sha256.** For a chapter it is the sha256 of every page body concatenated in page order. For timings it
   is the sha256 of the `audio_files` JSON body. ContentDb has no stamp-only update, so "only `fetched_at` is
   updated" stores the identical rows again with the new stamp (one transaction). This has the same effect.
5. **Timings binding.**
   - `content_length` comes from a `HEAD` of `audio_url`, tried on each catalog host in turn. It is never QDC's
     `file_size`.
   - `timing_file.etag` is the **audio file's** ETag.
   - The stored `audio_url` is QDC's canonical URL, never the mirror that answered.
   - If the `HEAD` sends no `Content-Length`, the pair is bound by URL only (logged). An explicit download then binds
     it to the downloaded length.
   - Mirrors: `audio_url`, then the same path on every catalog `host` / `host:port`. This applies only when
     `audio_url` is on one of those hosts; a URL on any other host is used alone.
6. **Upstream changes (§2.5.7) are one policy, `qdc_audio::apply_upstream`, used everywhere:**
   - **Same file, same payload:** `fetched_at` is re-stamped (`Unchanged`).
   - **Same file, new payload:** the timings are replaced (`Updated`). Pins are kept.
   - **New file, unpinned:** the cached mp3 **and its stream-cache `pack_item` row** are deleted, and the new timings
     are stored (`FileReplaced { freed }`).
   - **New file, pinned:** the old pair stays in use and stays stale (`PinnedFileChanged`).
     - "Pinned" means the timings **or** the `pack_item` row are pinned.
     - A pinned file with no timings at all gets the new timings: pinned if the file is the length they describe,
       otherwise `PinnedFileChanged` and a swap.
7. **The pinned swap is done by the revalidator, not by a job.**
   - The job runner skips items already pinned, and only one job per pack may run, so a queued job could neither
     re-download a pinned file nor run beside the user's own job (WP5b's request).
   - `revalidate_surah` downloads the new file on the background lane to `{sss}.mp3.next`, resumably, with temps
     `{sss}.mp3.dl.part` and `.json`. These never collide with a job's `{sss}.dl.part`, and a completed `.next` from an
     interrupted run is reused.
   - It then takes the writer claim and checks the surah is still pinned. If it is, it renames `.next` over
     `{sss}.mp3`, runs `timings_put(new, pinned)`, updates the `pack_item` bytes and sha256 and
     `installed_pack.bytes`, and emits `PacksChanged`.
   - If the user removed the surah meanwhile, the change is applied as an unpinned one.
   - A failed swap leaves the old pair, which stays stale, so the next pass retries it.
   - Every pass deletes `.next` files and their temps that no swap waits for, that is, when their timings are fresh
     again.
8. **`fetch_surah` (job item) always refreshes the timings first** (`GET` + `HEAD`), so the pair it pins is the one
   upstream serves now.
   - If the API fails, it falls back to the stored pair. It does not fall back when offline or cancelled, because the
     download could not run anyway.
   - If the refresh finds a pinned pair that changed upstream, the job downloads the new file and its final rename is
     the swap.
   - It always holds `Writers::claim_job` and uses `Expect::len(content_length).keep_existing()`. A file a stream
     completed is therefore only pinned (`Present`, no `GET`), and a live stream of the same surah is waited for.
   - Surah 1 is pinned with any surah through `Adapter::items` (frozen) and gets the same treatment, so its timings
     are pinned too.
9. **Chapter job items reuse fresh chapters.** `fetch_chapter` on a chapter already stored within 7 days, for example
   fetched on demand before "download all", sends no request. It only raises the pin and returns `Present { bytes }`.
10. **`bytes` of content.db items** use WP5a's `sizeBytes` measure: tafsir is the HTML bytes plus 32 B per row; WBW is
    the gloss and transliteration bytes plus 24 B per word.
11. **WBW join.**
    - Only `char_type_name == "word"` words are kept, each location once.
    - A location that core.db does not know is dropped with a warning; a chapter where none resolves is an integrity
      failure.
    - The join needs a real core.db: an unavailable one gives `not_found`.
    - The catalog language code is reduced to `[A-Za-z0-9-]` before it goes into the URL.
12. **`qdc_audio::check_update` (frozen dispatch).** It is cheap and only reports.
    - Only pinned surahs whose timings are older than 7 days, or that have a pending `.next`, are refetched. A
      surah verified within the week sends no request.
    - Unchanged pairs are re-stamped on the way.
    - Changed pairs are returned as `Some(latest)`. `latest` is the newest upstream `Last-Modified` as `YYYY.MM.DD`
      (catalog versions are `YYYY.MM`), else today's date.
    - The revalidator applies the change. See `Revalidator::check_updates` / `revalidate_pack`.
13. **Revalidator (§2.5.7).**
    - **Schedule:** startup + 60 s, then every 6 h.
    - **Network:** while it is not allowed or not reachable, a due pass is retried every 60 s rather than skipped for
      6 h. A pass the network cut short is finished 60 s later.
    - **Due items:**
      - Each pack is refetched after its own `revalidateDays`.
      - An item exactly 7 days old is due (`stale()` is strict, so the query adds 1 ms).
      - Items of packs that are not in the catalog are left alone.
    - **How:** 2 at a time on the background lane. Each request runs under a detached `JobHandle` that `shutdown()`
      cancels.
    - **Failures:** a failed item stays stale for the next pass. A pass also stops starting new items once the network
      goes away.
    - **`PacksChanged`** is emitted only for audio file changes (dropped or swapped). Chapter and timing refreshes do
      not change pack states.
14. **Update checks.**
    - `Revalidator::check_updates()` checks installed and partially installed packs: QuranEnc through WP5c's
      `check_update`, recitations through deviation 12.
    - It stamps `installed_pack.last_checked_at`.
    - It keeps a cache of known updates. `update_for(row)` is valid only while `row.version` equals the version the
      update was found for.
    - It starts applying audio changes at once (`wake`).
    - `Err(Offline)` when the network is off or every check failed for that reason. Paused, failed and removing packs
      are not checked.
    - Each pass also re-checks QuranEnc packs not checked for 24 h. QuranEnc's terms require the latest version.
15. **Test helpers in `tests/qf_support/`.** The shared `support::http::TestServer` routes on the path only. Paginated
    and per-language endpoints differ only in their query, so `qf_support` adds a small std-only JSON server routed on
    the full target. It also has:
    - a serial guard that points the API roots at that server for one test;
    - a mini core.db (`meta` plus `ayah` rows);
    - catalog packs and payload builders.

    Audio files are still served by WP5b's `TestServer` (ranges, throttling, scripts). The directory follows the
    package's `qf_*` naming but is not a test target.

## Handoff (APIs other packages build on)

- **`revalidate::Revalidator`**:
  - `Revalidator::new(RevalidateEnv { packs_root, http, core, user, content, writers, catalog: Arc<Catalog> },
    RevalidatorConfig::default(), move |ids| events.packs_changed(ids))`.
  - Scheduling and passes: `start(&rt)` (idempotent), `wake()`, `shutdown()`, `run_pass()` → `PassReport`,
    `revalidate_pack(id)`, `revalidate_item(&StaleItem, &CatalogPack)`.
  - Updates: `check_updates()` → `Vec<PackUpdate>`, `known_updates()`, `update_for(&InstalledPackRow)`,
    `forget_update(id)`.
- **`qdc_audio`**:
  - **Playback:** `ensure_timings(ctx, cfg, surah, max_age)` → `EnsuredTimings { timings, stale, change }`. It returns
    the stored timings while fresh, else refreshes them, and returns the stored copy as `stale` when the refresh fails.
    `Offline` when they are missing and cannot be fetched.
  - **Refresh:** `refresh_timings` / `fetch_timings` refresh without downloading audio. `TimingsChange` tells the
    caller what happened: `FileReplaced` means a cached file was dropped, so emit `PacksChanged`.
  - **Revalidation and updates:** `revalidate_surah` (refresh, then swap), `pinned_changes`, `changes_label`.
  - **Helpers:** `fetch_upstream`, `audio_mirrors`, `timings_url`, `next_path`, `NEXT_SUFFIX`, `SOURCE`.
- **`qurancom_tafsir` / `qurancom_wbw`**:
  - `ensure_chapter(ctx, cfg, surah, max_age)` → `ChapterState { fetched_at_ms, stale, change }` (on demand).
  - `fetch_chapter` (job item), `revalidate_chapter`, `fetch_remote`.
  - The pure `group_rows` / `join_words`, `chapter_url`, `stored_size`.

## Requests

- **WP5e (manager):**
  - **Wiring.** Build one `Revalidator` and keep it in `Inner`.
    - In `start_background`, after the sweep and `jobs.restore()`: `revalidator.start(&rt)`.
    - In the `Http` listener: `if online { revalidator.wake() }`.
    - On exit: `revalidator.shutdown()`.
  - **`surah_timings(reciter, surah)`:**
    - `qdc_audio::ensure_timings(&ctx, cfg, surah, revalidate::max_age(pack))` with an interactive ctx (`job: None`,
      `pin: false`), deduplicated with `InFlight<(u32, u32), EnsuredTimings>`.
    - Emit `packs_changed` when `change == Some(FileReplaced { .. })`.
    - Call `revalidator.wake()` when `change == Some(PinnedFileChanged)`. The old pair keeps playing, and the swap
      then happens now instead of at the next 6-hourly pass.
  - **`tafsir_entry` / `wbw_range`:**
    - `ensure_chapter(..)` for the chapter (or chapters) of the request, then read content.db.
    - `TafsirEntry.fetched_at = fetched_at_ms / 1000` and `stale = state.stale`.
    - Use `ctx.pin = true` when the pack is installed with scope `All`.
    - Deduplicate with `InFlight<(String, u32), ChapterState>`.
  - **Updates:**
    - `check_updates()` = `revalidator.check_updates()`.
    - `PackState::UpdateAvailable` comes from `revalidator.update_for(&row)`.
    - The **"Update" of a recitation pack** must call `revalidator.revalidate_pack(id)`, not `install(id, All)`. The
      job runner skips pinned items, and `All` would start downloading all 114 surahs of a partial pack.
    - Call `forget_update(id)` when a pack is removed.
  - **`remove_items`:** must not unpin or delete surah 1 while another surah of the reciter stays pinned. Every other
    surah's basmala plays from it (§2.5.6).
- **WP4d (audio glue):** on `AudioError::Source("timings/file mismatch")` (§2.3.7 step 7), call
  `qdc_audio::refresh_timings` once, which is the spec's "drop the stored timings and refetch them once".
  - An unpinned changed file is dropped, and the new pair is returned.
  - A pinned pair is kept until the revalidator swaps it. Do not delete pinned timings by hand.
- **WP2b:** an `UserDb::pack_set_checked(pack_id, at_ms)` (a one-column update). `last_checked_at` is stamped today
  by a read-then-upsert of the row, back to back in one blocking call. A job finishing in that window could see its
  row overwritten by the older copy.
- **WP1c (optional):** `ContentDb::{chapter_touch, timings_touch}(…, fetched_at_ms)`, so an unchanged revalidation
  updates the stamp without rewriting identical rows.
- **Lead:** fold deviations 1–15 into §2.5.6–§2.5.7. They cover the tafsir contiguity rule, the pinned-swap mechanics
  (`.mp3.next`, done by the revalidator) and the update-check semantics for recitations.

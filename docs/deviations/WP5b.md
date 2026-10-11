# WP5b deviations (HTTP, jobs, install and writers)

Owned and delivered: `crates/quran-packs/src/{http, jobs, install, writers}.rs`, `crates/quran-packs/tests/support/**`
(`mod.rs`, `http.rs` = the in-repo HTTP test server, `work.rs` = fake pack work), `crates/quran-packs/tests/{http_requests,
http_files, http_resume, jobs_queue, jobs_items, jobs_whole, install_flip, install_sweep, writers_registry}.rs`.
WP5b is Rust-only: it has no i18n dictionary, mock handler or scenario PNG.

## Deviations from ARCHITECTURE.md

1. **Retry schedule (§2.5.5 "Retries").** The text "up to 3 attempts with backoff 0.5 s, 2 s, 8 s" is read as one
   first attempt plus **3 retry rounds**, with 0.5, 2 and 8 s before them, so all three delays are used. Mirrors work
   in rounds: each round tries every live URL once, in order.
   - **Next mirror now; same URL again next round:** a connect error, a 5xx, a 408/425/429, a timeout or a broken
     body.
   - **URL retired for the request:** a 404/410, any other 4xx, or a payload that fails integrity (wrong length or
     hash, wrong magic). A captive-portal page or a stale mirror falls back to the next mirror instead of failing.
   - **`Retry-After`** on 429/503 is honoured up to 60 s; a longer value retires the URL.
   - **Offline:** when a round failed only on connect errors and the tracker says offline, the request ends at once
     with `PackError::Offline` instead of waiting through the ladder.
   - **Progress:** a resumable download that made progress starts a fresh budget, so a long mp3 on a flaky link
     never fails just because it broke 4 times.
   - The probe and connect-error handling are tested on Windows. Windows needs about 2 s to refuse a loopback
     connection, which the tests account for.
2. **Sidecar cadence (§2.5.5 "Resume").** `received` is advanced only after the bytes are written and **fsynced**,
   as specified, but every 1 MiB (`SIDECAR_EVERY`) and whenever a response ends (completion, error, pause/cancel,
   network turned off). It is not advanced every 64 KiB chunk: an fsync per 64 KiB costs seconds per 100 MB on
   Windows. The invariant "`received` ≤ durable bytes" is unchanged, and a crash re-downloads at most 1 MiB.
   Resume truncates the temp to `received`, re-hashes that prefix and never trusts the file length. `If-Range`
   uses a strong ETag, else `Last-Modified`; weak ETags are never used. With neither, the download restarts.
   Sidecars are written atomically (`.tmp` + rename).
3. **Staging is per pack: `packs/.staging/{packId}/`, not `{uuid}`.** There is one job per pack, so the name never
   collides. A stable name is what lets pause, resume and a restart find the resumable download and the job
   journal, and lets the sweep attribute a staging directory to its pack.
4. **New: job journal** `packs/.staging/{packId}/job.json`:
   `{packId, scope, pin, state: active|paused|failed, error?, createdAt, updatedAt}`.
   - It is written at enqueue and updated on pause and failure.
   - It is deleted with the staging directory on completion and on cancel.
   - `JobQueue::restore()` re-queues `active` jobs (interrupted by quitting or a crash) and lists `paused`/`failed`
     jobs with their error, so they can be resumed, cancelled and shown. Journals of packs that are no longer in the
     catalog are removed.
5. **Interactive reserve (§2.5.5 "Lanes").** Background work (jobs, the revalidator) may hold at most **4 of the 6
   global** and **3 of the 4 per-host** slots, so the interactive lane (the visible page's font, tafsir, WBW,
   timings) always finds capacity. The interactive lane still skips the queue and shares the host limits.
   Permits are acquired in one global order (host-bg, host, global-bg, global), so this cannot deadlock.
6. **Two clients.**
   - The **API client** (gzip) is used for JSON.
   - The **file client** (no decompression, `Accept-Encoding: identity`, so `Content-Length` is the file's) is used
     for files, `HEAD` and the probe.
   - `Http::client()` returns the file client for the audio streaming source. This answers LEAD item 2 / WP0B's
     request: WP5e exposes it as `PackManager::http_client()`.
7. **The network setting also stops transfers in flight.** `network_allowed = false` fails every new operation with
   `Offline` before any IO, and also ends running transfers at their next chunk with `Offline`, keeping resumable
   temps.
8. **Writers registry shape.** `WriterState::{Stream(Arc<Notify>), Job}` is kept as counters per
   `(reciter, surah)`: live streams, a job flag and waiters, with one `Notify`. A stream may begin while a job
   writes, and two stream cursors may overlap. A **second job claim waits for the first without a time limit**
   (two jobs must never share a `.dl.part`), but stays cancellable. Only the job-versus-stream wait is capped at
   10 min. `JobClaim` is an RAII guard that reports `waited_for_stream()`, `promoted_bytes()` (what a stream
   promoted meanwhile) and `stream_still_live()` (the wait expired, so the first file to complete wins).
9. **`Expect::keep_existing`** ("first complete wins", §2.3.7):
   - **Before any request:** a `dest` of exactly the expected length (plus the hash or magic, when given) is
     accepted without a request. This covers audio a stream already promoted, and a whole-pack resume after the
     download finished but the build did not.
   - **After a download:** a `dest` that appeared meanwhile is kept only when its length **and sha256** equal the
     verified download. Otherwise the download replaces it.
10. **Version directory collision.** Reinstalling the same version (a repair) goes to `{version}~{n}`, never over the
    live directory. Version strings are sanitised to `[A-Za-z0-9._-]` (at most 64 bytes). `installed_pack.path`
    stores whatever directory was used.
11. **Registry policy written by the runner** (the module docs of `jobs.rs` have the full rules):
    - **Per-item packs:** `installed_pack` is recomputed from the pinned `pack_item` rows. It becomes `installed`
      when every catalog item is pinned, `partial` otherwise, and `paused`/`failed` while the job is paused or
      failed. After a cancel with nothing pinned, there is no row.
    - **Whole packs:** a paused or failed job writes `paused`/`failed` only when no version is installed. An update
      that stops leaves the installed row untouched. A cancel deletes a non-installed row.
    - **`Present` outcomes:** an item an adapter reports `Present` keeps the existing row's hash and pin, ORed with
      the job's `pin`. A row created for it has `sha256 = ""` (not hashed).
12. **Failure threshold.** "3 failed items fail the job" applies as `min(3, items to fetch)`, so a 1- or 2-item job
    whose items all fail is `Failed`, not `Completed`. Completed items are always kept. When the threshold is hit,
    in-flight items are stopped through an internal abort; that abort is not reported as pause or cancel.
13. **Progress accounting.**
    - The total starts from the catalog estimate: `sizeBytes / itemCount` per item, or `sizeBytes` for a whole pack.
    - As soon as an item's real length is known, it replaces that item's estimate.
    - A finished item contributes what it actually transferred; a failed item leaves the totals.
    - Bytes reused from disk (resumed downloads, items already present) count as progress but not as rate, so the
      3 s EWMA does not spike.
    - `Progress` events are emitted only when a value changed: at most every 100 ms, plus a final one before the
      terminal event.
14. **Phases.** If a whole-pack adapter does not report `Verifying` itself (`JobHandle::set_phase`), the runner
    emits it after the build. `Installing` always precedes the flip, so the UI always sees `verifying → installing →
    completed`. A cancel that arrives during the flip is ignored: the flip is the point of no return.
15. **Testable runner.** Jobs run a `PackWork` trait. `Adapter` implements it by delegating to the frozen dispatch,
    and tests plug in fakes that download through the real HTTP layer. `JobSpec::from_catalog`, `SpecSource` and
    `catalog_specs(Arc<Catalog>)` rebuild specs on resume, cancel and restore.
16. **Startup sweep** (`install::sweep`), run before any job resumes or stream starts. It deletes:
    - stale `*.stream.part` (a live stream's temp is kept);
    - `*.dl.part` and sidecars of reciters without a job journal;
    - interrupted `.part`/`.tmp` temps in `mushaf/` and `decor/`;
    - staging entries without a readable journal;
    - unreferenced version directories of whole packs (an old version Windows held), and orphan pack directories.

    It also finishes interrupted whole-pack removals (rows marked `removing`). Per-item packs stuck in `removing`
    are only reported (`SweepReport::pending_removals`), because their files and content.db rows need the catalog
    and the manager.
17. **The test server is std-only** (`tests/support/http.rs`), because the crate has no dev-dependencies and
    dependencies are frozen. It supports:
    - `Range` with 206/416, `If-Range` (ETag or Last-Modified), `If-None-Match`/`If-Modified-Since` with 304, `HEAD`;
    - scripted 404/5xx, 429/503 with `Retry-After`, mid-stream disconnects, ignored or wrong ranges;
    - throttled bodies, gates, bodies without `Content-Length`;
    - a request log and peak concurrency per host.

## Handoff (APIs other packages build on)

- **`http::Http`** (`AdapterCtx::http`). Build it with `Http::new(HttpConfig::new(ua).network_allowed(b))`. Requests
  take a `Request`:
  - `Request::for_ctx(ctx, &urls)` puts a job's request on the background lane, with progress and cancel.
  - `Request::new(&urls)` is interactive; add `.lane(Lane::Background)` for the revalidator.

  Methods:
  - `get` → `Body {bytes, url, validators, content_length}` (`Body::sha256_hex`, `Body::json`), and `get_json::<T>`.
  - `head(req, Some(&Validators))`: a `304` gives `not_modified`.
  - `fetch_file(req, dest, &Expect)` for small files (`.part` + rename).
  - `download(req, dest, &Expect)` for large files (`.dl.part` + sidecar, resumable). Both return
    `Downloaded {path, bytes, sha256, url, validators, resumed_from, kept_existing}`.
  - `Expect` builders: `len`, `sha256`, `magic(WOFF2_MAGIC)`, `max_len`, `keep_existing`.
  - Network state: `set_network_allowed`, `online`, `set_listener`, `start_probe(&rt)`, `probe`, `client()`.

  `http::InFlight<K, T>::run(key, || future)` dedupes concurrent interactive fetches. `http::duplicate_error` gives
  every waiter an equivalent `PackError`, with the same IPC kind.
- **`jobs`**:
  - `JobQueue::new(JobEnv {..}, catalog_specs(catalog))`.
  - Queue methods: `enqueue(JobSpec::from_catalog(pack, scope, pin))`, `pause`, `resume` (also Retry), `cancel`,
    `restore`, `jobs`, `snapshot`, `is_active`, `job_items` (for `PackItemState.queued`), `handle`, `wait`.
  - `JobObserver { download, packs_changed, release_pack }`.
  - `JobHandle` (`AdapterCtx::job`) offers `check`, `stopped`, `sleep`, `set_phase`, `add_received`,
    `set_expected_len` and `for_item`; `JobHandle::detached` is for adapter tests.
- **`install`**:
  - layout helpers: `font_page_path`, `decor_path`, `audio_path`, `stream_part_path`, `part_path`, `dl_part_path`,
    `dl_sidecar_path`, `pack_dir`, `staging_dir`, `kind_dir`, `relative`/`resolve` (path-escape safe);
  - file operations: `commit`, `write_atomic`, `remove_file`, `remove_dir`, `file_len`, `dir_size`, `Staging`;
  - pack operations: `flip_whole`, `remove_whole`, `item_files`, `remove_item_files`, `sweep`.
- **`writers::Writers`**: `stream_begin`/`stream_end` (the glue's `StreamRegistry`), `claim_job` (wait at most 10 min
  for a stream), `info`, `is_streaming`, `live_streams`.
- **Test support** for WP5c/WP5d/WP5e tests: `mod support;` gives `TestServer`/`Route`/`Action`/`Gate`/
  `closed_port_url`, `TestEnv` (temp `packs/`, real `UserDb` and `ContentDb`, unavailable `CoreDb`, fast `Http`,
  `Recorder` observer, `queue`, `ctx`), `fast_http_config`, `bytes`, `sha256_hex`, `eventually`,
  `work::{ItemsWork, WholeWork, spec, spec_source}`.

## Requests

- **WP5e (manager)**:
  - **Wiring.** Build one `Http`, with `set_listener(move |on| events.network(on))`, one `Writers`, and one
    `JobQueue` whose observer forwards `download`/`packs_changed` to `PackEvents` and implements `release_pack` by
    dropping the cached `PackDb`.
  - **`start_background`:** `http.start_probe(&rt)`, then `install::sweep(..)` (finish `pending_removals` with the
    catalog), then `jobs.restore()`, then the content.db re-sync (§2.5.5 "Content DB re-sync"; it needs the catalog,
    so it is yours).
  - `http_client()` is `http.client()`.
  - `remove()` of a pack with an active job should `cancel` and then `wait(job_id)` before deleting files.
  - `audio_stream_begin`/`end` map to `writers.stream_begin`/`stream_end`, plus the `pack_item` row for a promoted
    file.
- **WP5c**:
  - Fonts: `fetch_file` with `Expect::default().magic(WOFF2_MAGIC)` into `install::font_page_path`; an item already
    on disk is `ItemOutcome::Present`.
  - Decor: `Expect::default().len(file.bytes)` plus `.sha256(..)`.
  - QuranEnc: `download` the zip into the staging directory, and call `job.set_phase(JobPhase::Verifying)` before
    the unzip and transform. Do **not** pass the catalog size as `Expect::len` for QuranEnc zips: an upstream update
    changes the length, and the install would then fail integrity. Rely on `Downloaded.validators` and
    `Downloaded.bytes` for `source_version`.
  - The interactive font lane can use `InFlight<(variant, page), PathBuf>`.
- **WP5d**: `qdc_audio::fetch_surah` should:
  1. claim the file with `ctx.writers.claim_job(reciter, surah, ctx.job.as_ref())`;
  2. call `download(..., &Expect::default().len(timings.content_length).keep_existing())` with every host as a URL;
  3. return `Present` when `done.kept_existing`.

  The revalidator's re-download of a pinned file should target a different `dest` (for example `{sss}.mp3.next`)
  and swap afterwards. Use `Lane::Background` without a job, and `Body::sha256_hex` for the payload comparison.
- **Lead:** fold deviations 1–17 into §2.5.5 and §2.8.3: the per-pack staging directory and the job journal in the
  layout tree, the interactive reserve, the sidecar cadence and the retry schedule. The §14.3 acceptance line runs
  as written (cargo 1.99 accepts the `--test 'glob'` patterns).

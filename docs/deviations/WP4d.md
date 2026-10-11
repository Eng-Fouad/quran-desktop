# WP4d deviations (streaming source, audio glue, audio commands)

Owned and written: `crates/quran-audio/src/source.rs`, `crates/quran-audio/tests/source_{common, cache, stream,
engine}.rs`, `src-tauri/src/audio_glue.rs` and `src-tauri/src/commands/audio.rs`. No other file was touched and no
dependency was added. `bindings.ts` is unchanged: the command signatures and their `///` docs are the wave-0 ones, and
the `State` parameters do not appear in it (`pnpm bindings:check`: up to date). WP4d owns no dictionary, mock handler
or scenario, so it adds no en/ar strings and no PNGs.

## Deviations from ARCHITECTURE.md

1. **Cursors do not read through stream-download** (§2.3.7 rule 2 describes cursors over the shared `StreamDownload`
   that seek it before each read).
   - **Found.** After a Range seek, stream-download restarts its prefetch and wakes a blocked reader only on the next
     write after that prefetch, or when the whole download ends. A read in the last 64 KiB of a file (a decoder probing
     the end, the last ayah of a short surah) therefore waited for the entire back-fill of the gap. The first version
     of `a_stream_that_seeked_past_a_gap_never_promotes_holes` showed it: the tail read of a 1 MiB file served at
     800 KiB/s returned only after the whole file had arrived.
   - Also, the sketch's `BufReader` over a temp pre-sized with `set_len` can read ahead into bytes that are not written
     yet, i.e. zeros.
   - **Now.** stream-download still does all the HTTP work: the first GET, Range requests for seeks, reconnects and the
     final back-fill of gaps. It writes through this module's storage (`PartWriter`), which records exactly which byte
     ranges were written (`ByteRanges`). Cursors read the temp through their own unbuffered handle, and only bytes the
     coverage holds.
   - A read of bytes that are not written yet asks stream-download for that range with `StreamDownload::seek`. The
     request runs on the blocking pool, one at a time, and the latest target replaces a queued one. It is skipped when
     the download is at most 256 KiB behind the position and will reach it anyway. The read then waits for a 64 KiB
     cushion (`PREFETCH_BYTES`, or the rest of the file), so playback does not stutter right behind the download.
     stream-download's own reader is an empty dummy.
   - **Result.** `a_read_near_the_end_is_served_without_waiting_for_the_whole_file` requires the last 8 KiB of a file
     that takes 1.3 s to download to arrive within 0.7 s. `back_filled_gaps_promote_byte_exact` shows that no
     zero-filled hole is ever read or promoted.
2. **Stall watchdog** (an addition). stream-download reconnects a stalled connection forever. That would leave
   `qd-audio-decode` blocked in a read, and a new play would then wait on WP4c's fence (WP4c deviation 5). A watchdog
   task per stream fails the stream:
   - when a blocked reader has seen no new byte for `STALL_TIMEOUT` (30 s, the pack layer's idle-read timeout); the
     read fails with `TimedOut`;
   - at once when the network becomes unavailable (`online()` false); the read fails with `NotConnected`;
   - when the download task ended without covering a known length; the read fails with `Other`.

   A failed read is never `UnexpectedEof`, which the decoder would take for the end of the file. A failed stream is
   never handed to another cursor: the next open starts a new download.
3. **One writer per temp path.** The temp path depends on `(reciter, surah)` only, while a live stream is keyed by its
   `FileKey`.
   - A new stream of the same surah first **retires** the old one, under a path lock. That happens when the timings now
     point at another file, or when the old stream failed. Retiring promotes a complete download and abandons anything
     else. Abandoning revokes the old write handle, so a cancelled task's late writes fail instead of landing in the
     successor's file, and deletes the temp.
   - Promotion and abandonment are mutually exclusive under that lock, so a late rename can never move a successor's
     temp into the cache.
   - When the last cursor goes away and the download is **already complete**, the file is promoted rather than deleted.
     The spec deletes a stream dropped "without promotion", but promotion runs on the blocking pool and can trail the
     last read by a moment; deleting a complete download there would throw it away.
   - Creating the temp retries for up to 1.5 s on `PermissionDenied`. On a filesystem without POSIX delete semantics
     (not NTFS on Windows 10 1809 or later), a retired temp whose last handle is still closing is delete-pending.
4. **`StreamRegistry` calls.** `begin` is called once the HTTP response has been accepted (the length check passed),
   right before the temp is created. `end` is called exactly once per `begin`: `Some(bytes)` after the rename or after
   deleting our temp next to an explicit download of the same length, else `None`. It is dispatched to the blocking
   pool, because the decode thread may drop the last cursor and the glue's registry may write to SQLite.
5. **Error classification.**
   - A connect error, or a 5xx from the first host, is retried once on the fallback. Rule 6's
     `download.quranicaudio.com` → `.org` is the default (`DEFAULT_HOST_FALLBACKS`); `with_host_fallbacks` replaces
     it.
   - A host that cannot be reached at all is `AudioError::Offline`, so an uncached basmala is skipped as §2.3.3 intends
     even before the pack manager notices that the network is gone.
   - 4xx statuses, TLS failures and timeouts are `Source` (`network` over IPC).
   - Messages carry the error's cause chain: reqwest alone says only "error sending request for url (…)".
6. **Files without `Content-Length`** stream, but are never cached: promotion needs a length to verify coverage
   against.
7. **Release guard.** `CachingHttpSource::open` and the glue's `TimingsSource::surah_timings` keep the spec's
   `debug_assert!`. In release builds they also return an error instead of reaching `Handle::block_on` when called from
   async code, because a panic there would abort the app.
8. **Additive public API (`quran-audio`):**
   - `ByteRanges`, `cached_file_path`, `stream_part_path`;
   - the constants `PREFETCH_BYTES`, `STALL_TIMEOUT`, `TIMINGS_FILE_MISMATCH`, `DEFAULT_HOST_FALLBACKS`,
     `STREAM_PART_SUFFIX`;
   - `CachingHttpSource::{with_host_fallbacks, with_prefetch_bytes, with_stall_timeout, root, live_streams}`;
   - `LocalFileSource::root`.

   The frozen constructor `CachingHttpSource::new` is unchanged.
9. **`AudioService` additions (§2.8.4).**
   - **`set_ui_sink(sink: UiSinkFn)`, with `UiSinkFn = Arc<dyn Fn(&AudioSnapshot) + Send + Sync>`** (LEAD item 3). The
     "event" is the snapshot at each playback-state or ayah edge, never per tick. It is exactly the type that WP6a's
     `setup::AudioUiSink::into_sink()` returns; a compile-only test in `audio_glue.rs` (`setup_registers_the_ui_sink`)
     type-checks the registration line.
     - The sink runs on a new `qd-audio-glue` thread, so the engine threads never wait on the tray or the media session.
     - Snapshots coalesce: a burst of edges delivers only the newest one.
     - Registering a sink hands it the current state at once.
     - `AudioService::start` registers the app's sink itself (item 20).
   - `index_ready()`.
   - `start_with(GlueParts)` (crate-internal): tests choose the output, the timings fetcher, the network switch and the
     listen threshold.
10. **Timings policy.** content.db first. A fetch happens when the timings are missing, or older than
    `revalidate::MAX_AGE` (7 days) while online. It goes through a `TimingsFetcher`: `PackManager::surah_timings` in the
    app, fixtures in tests. A stored copy is used when the refresh fails or the network is off (§2.5.7 "Offline").
    Overlapping fetches of one surah share one request (item 21). For the planner:
    - "not stored and offline", or a network error that is a connect error or a timeout → `Offline`, so the basmala is
      skipped;
    - any other HTTP or network failure → `Source`;
    - everything else → `Timings`.
11. **Rule 7 (timings/file mismatch).** When the source reports `Source("timings/file mismatch")`, the glue does three
    things, once per `FileKey` per run:
    - deletes the stored timings, unpinned ones only (pinned pairs belong to the revalidator, per WP5d);
    - refetches them through the pack manager;
    - returns the error, so this play fails and the next one uses the new pair.

    WP5d suggested calling `qdc_audio::refresh_timings` instead, but that needs an `AdapterCtx`, which only the manager
    has (see Requests).
12. **`apply_settings`.**
    - Speed applies live too. WP4c made speed engine state that persists across plays; §5.13 called it a default for
      the next play.
    - Volume applies live.
    - `stop_at` becomes the default end of plays that carry neither `to` nor `stop_at`.
    - Repeats and gap travel in every `PlayRequest`, so the glue keeps nothing for them.
13. **Listen history (§2.8.4: "≥ 3 s, at most one per page").**
    - **What counts.** Time counts only while the recitation is audible: playing and not in a gap. It is measured in
      wall time between ticks, with each interval capped at 0.5 s. The basmala does not count.
    - **When a page is recorded.** An ayah heard for 3 s qualifies its page, in the play's layout. The entry is written
      then, with the dwell so far. The rest of the visit is added when:
      - the page changes;
      - the play ends, stops, fails or is replaced;
      - the app quits (`AudioService::shutdown` writes it synchronously before WP6a's WAL checkpoint).

      Visits longer than 5 minutes are checkpointed.
    - **One entry per visit.** user.db merges records of the same page within 10 minutes (WP2b), so a visit is one entry
      that carries its full dwell.
    - Each write is followed by `UserDataChanged { kinds: [history] }`, as WP2b requested.
    - In the real app, a 5.6 s play of 1:1–1:7 recorded `{ mode: listen, layout: v2, page: 1, ayahId: 7, dwellS: 5 }`.
14. **OS media commands.** When nothing is loaded, Play and Play/Pause replay the last request, as media keys do in
    players. "Nothing loaded" means the play ended, was stopped, or failed before it started. The other mappings are
    as specified.
15. **Command validation (§5.1, `InvalidArgument`).**

    | Argument | Valid values |
    |---|---|
    | Speed | 50..=200 in steps of 5 |
    | Volume | 0..=100 |
    | Repeats | 0..=99 |
    | Gap | fixed ≤ 30,000 ms; multiplier ≤ 300 % |
    | A-B loop | `b − a ≥ 300` ms |
    | Seek to an ayah | ayah id in 1..=6236 |
    | `audio_get_timings` | surah in 1..=114 |
    | Play | `from` and `to` are real ayahs, `from ≤ to`, repeats and gap as above |

    A reciter the catalog does not list is `NotFound`. That check is skipped while the catalog lists no reciter, as
    with the inert wave-0 manager.
16. **`audio_play` warms the Quran index** on the blocking pool when it is not ready yet, so resolving `to` never runs
    SQLite on an async worker. `app_bootstrap` normally warms it first.
17. **Streaming client** (LEAD item 2, until WP5e's `PackManager::http_client()`):
    - User-Agent `QuranDesktop/<version>` and system proxies;
    - connect timeout 10 s, idle-read timeout 30 s, no total timeout (streams are long);
    - **no gzip**, so `Content-Length` is the file's length, which the timings are bound to.

    If the client cannot be built, the app plays cached files only (`LocalFileSource`).
18. **Acceptance command syntax.** `cargo test -p quran-desktop --lib audio_glue commands::audio` is rejected by cargo
    1.99, which accepts one TESTNAME (WP1a, WP1c, WP2b and WP6a report the same). It was run in its libtest form,
    `cargo test -p quran-desktop --lib -- audio_glue commands::audio`.
19. **Test gating.** The engine tests (`source_engine.rs`, the service tests in `audio_glue.rs` and all of
    `commands/audio.rs`) compile only in debug builds. The debug null sink does not exist in release builds, and these
    tests must never reach the audio device (LEAD item 9).
20. **The UI sink is registered by `AudioService::start`** (LEAD item 3 has WP6a register it in
    `setup::after_manage`).
    - **Why.** That line was still a marked comment, so the OS media session never heard of playback. WP6a's Request
      hands the line to WP4d, but `setup.rs` is WP6a's file.
    - **How.** `start` is generic over the runtime so `setup::build_state` stays testable. When its handle is the app's
      Wry handle (`&dyn Any` downcast), `start` registers WP6a's sink itself:
      `AudioUiSink::new(app, settings.ui_language).into_sink()`. Other runtimes (`tauri::test`) get no sink.
    - **Timing.** The sink's first delivery comes before `AppState` is managed. It is a no-op: the media and tray hooks
      look the state up with `try_state`.
    - **The planned line stays valid.** Adding it in `after_manage` replaces the sink, at the cost of one more
      `settings-changed` listener.
    - **Verified on Windows** (scratch scenario, app-driver, null sink). The app's SMTC session (`com.qurandesktop.app`,
      read with WinRT's `GlobalSystemMediaTransportControlsSessionManager`) shows:

      | Moment | SMTC session |
      |---|---|
      | Before the play | none |
      | Playing | title "Al-Fatihah 1:1", album "The Holy Quran", status `Playing` |
      | After `audio_pause` | status `Paused` |
      | After `audio_stop` | none |

      The artist is empty only because the inert pack manager has no reciter names yet (WP5e).
21. **Timings: shared fetches and a per-play prefetch** (additions; they mitigate the planner Request below).
    - **Shared fetches.** At most one fetch per `(reciter, surah)` runs at a time. The planner on `qd-audio-ctl`,
      `audio_get_timings` and the prefetch join a fetch in flight and share its outcome, a failure included. The table
      is a `tokio::sync::OnceCell` per key; a finished flight leaves it, so a later miss fetches again.
    - **Prefetch.** WP4b's planner loads every surah's timings one by one before the first sound. A play to the end of
      juz 30 from 78:1 by an uncached reciter is 38 QDC round trips in a row (37 surahs plus surah 1 for the basmala).
      `AudioService::play` now hands the surahs the planner will load to `TimingsStore::prefetch`:
      - `planned_surahs` lists them in the planner's order: each surah of the range, and surah 1 right after the first
        surah that opens with a basmala from it.
      - From that list, the prefetch fetches the missing or stale ones, 4 at a time (`PREFETCH_CONCURRENCY`), on the
        runtime.
      - The planner's own requests find them stored or join them in flight: the wait drops to about a quarter.
    - **When it does nothing or stops.**
      - It does nothing offline, or when fewer than two surahs need a fetch.
      - It starts no further fetch after a failure; the planner reports the error itself.
      - A newer play supersedes it.
    - **Tests.**
      - One request for 3 async callers plus the planner, failures shared too.
      - Planner order and basmala rules.
      - The prefetch: 9 fetches, at most 4 at once, each once, 79 skipped as fresh.
      - The planner joining it: two 500 ms round trips done in under 950 ms.
      - Superseded, offline, single-surah and failure stops.
      - On the service: 112:1 to the end of the Quran fetches 112, 1, 113 and 114 once each, overlapped.

## Handoff

- **WP6a / lead (the UI sink).** Nothing is required any more: `AudioService::start` registers
  `setup::AudioUiSink` in the app (item 20).
  - The marked comment in `setup::after_manage` can be deleted.
  - If the line is added anyway, it replaces the sink and does no harm:

    ```rust
    state.audio.set_ui_sink(AudioUiSink::new(app, settings.ui_language).into_sink());
    ```

  - The tray follows `audio-state-changed` itself as well, and both paths derive the same model.
- **WP5e (IC2).**
  - Timings for a missing surah come from `PackManager::surah_timings`. The glue boxes that future, so it must stay
    `Send`.
  - At play time several `surah_timings` calls for one reciter run concurrently (item 21, at most 4). Calls for the
    same surah never overlap.
  - Until that method works, a play needs the timings in content.db. That includes surah 1 for the basmala before
    surahs 2–114: a missing surah-1 timing is skipped only when it is `Offline`, and the inert manager's `Unsupported`
    fails the play.
  - `audio_stream_begin` is called from `qd-audio-ctl`. `audio_stream_end` is called from the blocking pool, with
    `Some(bytes)` when the stream was promoted.
  - The stream temp is `packs/audio/{r}/{sss}.stream.part`. The startup sweep may delete stale ones, as WP5b does.
  - Swapping in the shared client is one line in `AudioService::start`: `client: Some(packs.http_client())`.
- **WP9a (player) and the audio mock owner.** Mirror item 15's validation in the mock (`invalid_argument`).
  - `audio_play` returns the `loading` snapshot with `range.to` resolved.
  - `audio_get_timings` answers `offline` for timings that are neither stored nor fetchable.
  - Play/Pause with nothing loaded replays the last recitation.
- **Real app, verified on Windows** (scratch scenarios, not committed; app-driver, debug build, null sink):
  - **Cached recitation:** 1:1–1:7 seeded into a data dir, `audio_play` with `stopAt: end_of_page` (resolved to 1:7
    on v2), every ayah heard, idle after 5.7 s, the listen entry above, `audio_set_speed(52)` rejected with
    `invalid_argument`.
  - **Real CDN:** Afasy 112:1 with its basmala streamed from `download.quranicaudio.com`. The basmala came from the
    surah-1 file; 112 was opened ahead by the next-file prefetch. `001.mp3` (793,327 B) and `112.mp3` (214,038 B) were
    promoted byte-exact. With `networkAllowed: false`, the same play was then served from the cache, basmala included.
  - **OS media session:** the SMTC session followed play, pause and stop, as shown in item 20. The app log reads
    `audio: UI sink registered (OS media session and tray)`.
  - None of the runs logged a panic.

## Requests

- **WP6a or lead:** none for the UI sink any more (item 20). The marked comment in `setup::after_manage` is obsolete.
- **WP5e:**
  1. `PackManager::http_client()`, then the one-line switch in `AudioService::start`.
  2. `PackManager::refresh_surah_timings(reciter, surah)`, wrapping `qdc_audio::refresh_timings`. The rule-7 path
     would then refresh in place instead of "delete unpinned, then `surah_timings`".
- **WP4b / WP4c:** the planner loads every surah's timings before the first sound.
  - The glue's prefetch (item 21) cuts the wait to about a quarter of the round trips. Even so, a play to the end of
    the Quran from an uncached reciter still fetches up to 115 timing files while showing `loading`.
  - Planning lazily per surah would start the sound at once. So would planning the first surah and extending the queue
    in the background.
  - If planning becomes lazy, `planned_surahs` should shrink to the window actually planned.
- **Lead:** fold in these items:
  - items 1–4 into §2.3.7;
  - items 9 and 20 into §2.8.4 and LEAD item 3;
  - item 12 into §5.13;
  - item 13 into §2.8.4;
  - item 21 into §2.8.4 and §2.5.6.

## Verification (this machine, Windows 11, debug profile; `CARGO_TARGET_DIR=C:\qdt\WP4d`)

| Command | Result |
|---|---|
| `cargo test -p quran-audio --test 'source_*'` | source_cache 4, source_stream 20, source_engine 1 passed (source_common: 0 tests) |
| `cargo test -p quran-desktop --lib audio_glue commands::audio` | rejected by cargo ("unexpected argument"); see item 18 |
| `cargo test -p quran-desktop --lib -- audio_glue commands::audio` | 28 passed |
| `cargo test -p quran-desktop --lib audio_glue` / `… --lib commands::audio` | 26 + 2 passed |
| `cargo clippy -p quran-audio -p quran-desktop --all-targets -- -D warnings` | clean |
| `cargo clippy -p quran-audio -p quran-desktop --release --all-targets -- -D warnings` | clean |
| `cargo test -p quran-audio` | every suite green (lib 96, WP4a/WP4b/WP4c suites included) |
| `cargo test -p quran-desktop --lib` | 147 passed |
| `rustfmt --edition 2024 --check` on the owned files | clean |
| `pnpm bindings:check` | up to date |
| DoD grep `NotImplemented\|not implemented` on the owned paths | no match |

The timing-sensitive tests ran repeatedly while other packages were building on the machine:

- the new glue tests (shared fetches, prefetch, the planner joining it, the service prefetch);
- the `source_*` suites (9 runs in a row after their last change).

- **`source_stream`** covers:
  - progressive reads and promotion, with exactly one GET;
  - live-stream reuse, with two cursors on two threads and one writer;
  - abandonment: temp deleted, `end(None)`, the download cancelled;
  - a stream with a gap never promoted; back-filled gaps promoted byte-exact;
  - a tail read without waiting for the whole file;
  - the length mismatch;
  - no `Content-Length`;
  - fallback after a 5xx and after a connect error; no fallback after a 404;
  - an unreachable host as `Offline`; offline without a request;
  - an explicit download that finished first keeps its file;
  - the stall watchdog, and a failed stream not reused;
  - going offline mid-read;
  - a new file of the same surah replaces the old stream;
  - independent surahs;
  - the `debug_assert` on async callers.
- **`source_engine`** plays 1:1–1:7 through the whole engine from a throttled stream on the null sink. It checks the
  promotion, then replays offline from the cache with no new request.
- **`audio_glue`** covers:
  - `to` resolution and its validation;
  - page ends against a brute-force scan and, when core.db is built, against core.db's own `page_of_ayah` for all
    three layouts;
  - the listen-history rules;
  - the timings policy (fresh, missing, stale, offline, failing);
  - shared fetches and the prefetch (item 21);
  - the rule-7 refetch (once per file; pinned pairs kept);
  - the full service on the null sink: events, ticks, UI edges (fewer than half the ticks), listen history,
    `UserDataChanged`, settings applied live, a play across surahs that prefetches;
  - replay on Play;
  - no app UI sink on a non-Wry runtime;
  - async `timings`.
- **`commands::audio`** runs the real `AppState`, from `setup::build_state` on a mock app, through every command: the
  validation table, subscribe, play to the end of page 1, timings, offline errors.

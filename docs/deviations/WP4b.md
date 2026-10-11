# WP4b deviations (planner and decode)

Owned and written: `crates/quran-audio/src/{plan, decode, fake_out}.rs`, `crates/quran-audio/tests/plan_rules.rs`,
`crates/quran-audio/tests/decode_{markers, flush, sources, stress}.rs`. `tests/data/**` is unused: every fixture is
generated in memory (see 18). No other file was touched and no dependency was added.

## Deviations from ARCHITECTURE.md

1. **How the offline basmala reaches `AudioSnapshot.basmala_skipped` (WP0B's request).** `plan()` keeps its §2.3.3
   signature. The flag travels three ways:
   - `plan_queue()` returns `PlannedQueue { segments, basmala_skipped }`. This covers surah-1 timings that are
     offline.
   - `PlannedQueue::skip_basmalas_in(&FileKey)` covers the surah-1 file being offline when control opens the start
     source. It drops that file's Basmala segments and sets the flag. Ayah segments are never dropped.
   - Mid-queue, decode skips a Basmala segment whose `SourceFailed` error is `Offline` and continues with ayah 1.
     `CtlMsg` (frozen) has no variant for this. Control knows anyway, because it sent that `SourceFailed`, so control
     sets the flag (request below).
2. **`PlayRequest.to == None` is resolved by the planner** as a fallback: `stop_at == EndOfQuran` gives 114:6 and
   anything else gives the end of `from`'s surah. The glue still owns page and juz resolution (§5.8).
3. **A zero gap counts as no gap.** `fixed{0}` and `multiplier{0}` keep continuous mode (`gap_is_none`), and decode
   writes neither a Gap marker nor silence for them.
4. **Segment ends never precede their start.** The planner uses `end = max(next.from, from)`. A zero-length segment is
   legal: it plays once, is never replayed, and a pass that decoded no frames never restarts. This prevents an endless
   marker loop with `ayah_repeat = 0` or `range_repeat = 0`.
5. **Seek mechanics (§2.3.4 "drop `required_ts − actual_ts`").** Seeks use `SeekMode::Accurate`. They target a frame
   2,304 source frames (two MP3 frames) before the requested one, then drop frames by **packet timestamp**
   (`pts + trim_start`, after symphonia's encoder-delay trim) instead of by `required_ts − actual_ts`. The result is
   the same, but it is also robust:
   - a lost or undecodable packet becomes silence of its exact length, so the timeline never shifts;
   - the MP3 overlap and bit reservoir are primed before the first audible frame.

   A forward move of up to 2 s decodes through without a demuxer seek. The spec's `seek_index_fill_period_ms = 250`
   is kept. Positions are verified to the frame on WAV and on MP3 (§12.1).
6. **Millisecond ⇄ frame convention.**
   - A millisecond maps to the first source frame at or after it: `⌈ms·rate/1000⌉`. Two segments that share a
     boundary in ms therefore share it in frames.
   - Marker positions are `⌊frame·10⁶/rate⌋` µs, which never reads before the millisecond the frame stands for.
7. **When a marker enters the marker ring.** A marker is pushed only once every frame before it is in the sample ring,
   and no frame at or after it is written before it. A contiguous boundary marker is computed early, at
   `gen_origin + chain.out_frame_at_src(E − origin)` (the spec's "written + latency", exact). It then waits in decode
   until its frame is reached. Without this rule, a future marker of an old generation could sit in the FIFO ahead of
   a flush marker, and the callback would discard the new generation's frames up to it.
   - Sync markers are the one exception. They mark the latest WSOLA hop boundary already released, so they can be
     *behind* the callback's read position when it meets them. The callback applies them at once, and
     `Marker::position_at` keeps that exact.
8. **Sync cadence ("~every 100 ms").** A Sync marker is pushed at the first hop boundary released at least 100 ms
   after the previous marker of any kind. Measured spacing:

   | Path | Spacing |
   |---|---|
   | Bypass (100 %, equal rates) | 100–112 ms |
   | 44.1 → 48 kHz at 50–200 % | 100–137 ms, mean < 125 ms (1024-frame resampler blocks plus one hop) |

   `file_pos_us` is `origin + sync_point().src_us`, the p_k-based position the spec asks for. It stays within half a
   source frame (11.3 µs at 44.1 kHz) of the exact rational extrapolation. This is asserted at every speed and in 600
   randomised runs.
9. **Where a flush resumes.**
   - **Speed change, and an A-B loop set behind the decoder.** Playback resumes at the **consumed** position: the
     ring frame the callback reads next, mapped back through this generation's markers. Decode derives that frame
     from the ring's occupancy. It does not use `Shared::audible_us()`, which cannot tell which generation it belongs
     to right after a flush.
     - The continuation is seamless: nothing is repeated or skipped. Only the audio already handed to the device
       (its latency) plays at the old speed.
     - Repeat counters, passes and a gap in progress (with the frames it has left) are restored from that marker.
   - **`NewOutput`.** Uses control's `resume_at_us`. If that position lies in the previous segment (the device's
     latency), that segment is selected and finished as its last play. A gap in progress continues with its
     remaining frames, rescaled to the new device rate.
10. **A-B semantics left open by §2.3.4.**
    - The loop is bound to the file of the segment being heard when it is set; on `Load`, to `queue[start]`.
    - While it is active on the current file, playback is linear from A to B. Segment starts inside the loop push
      Segment markers only. Repeats and gaps are suspended, and `ayah_repeat_left` reads 0.
    - Setting a loop whose B decode has already passed flushes and resumes at the consumed position, so the wrap
      lands exactly on B.
    - Any entry at or after B (seek, jump, resume) wraps to A at once. EOF before B also wraps.
    - A loop with `b ≤ a` is ignored, and so is a loop whose wrap decodes nothing (A at or after EOF). A warning is
      logged in both cases.
11. **Gap details.**
    - No gap after the final play of the queue: End follows directly.
    - Basmala segments get no gap.
    - The multiplier uses the file-time duration, `(end − start)·pct/100`, as §2.3.4 states, whatever the speed.
    - During a gap the Gap marker freezes the position at the finished ayah's end (`rate = FROZEN`). No Sync
      markers are pushed during a gap.
12. **Repeat counters in `Shared`.**
    - `ayah_repeat_left` and `range_repeat_left` are the plays and passes left **after the current one**.
    - They read 0 when the setting is ∞ (the UI shows ∞ from the setting 0) or not applicable (basmala, A-B).
    - Decode publishes them from the consumed position, every pump or poll (5–50 ms), not when it decodes, so they
      change when the listener hears the change.
13. **Format changes inside a file.**
    - A channel-count change rebuilds the chain: the old format fades out, and a Sync marker re-anchors the position.
    - A sample-rate change mid-file is `DecodeFailed(Decode)`.
14. **Open files are parked.** Up to two files stay open when playback moves to another file of the queue. The
    surah-1 file behind every basmala of a cross-surah range is opened once, not once per surah. `NeedSource` is sent
    only for a file that is not open, parked, ready, requested or failed.
15. **The probe never reads the end of a file.** Opening wraps the source so its length is hidden while symphonia
    probes it. With symphonia's `ape`/`id3v1` features enabled, a probe on a seekable source of known length seeks to
    the end for trailing tags. On a progressive stream that read would wait for the whole download.
    - Those features are off in this workspace today, so this is a guard against a future feature change. It is
      unit-tested with a spy source.
    - After the probe the length is visible again.
16. **Additional public API**, all `pub` for WP4c/WP4d (the spec fixes only `Segment`, `SegmentKind` and `plan`):
    - **`plan.rs`:**
      - `Segment::{duration_ms, contains_ms, ayah_ref, word_at}` (`word_at` is the ticker's binary search: the last
        word with `start ≤ ms`, held through gaps);
      - `PlannedQueue`, `plan_queue`, `is_continuous`, `gap_is_none`, `gap_ms`;
      - `index_of_ayah` (for `SeekTarget::Ayah`);
      - `segment_for_position(queue, file, ms, near)` (seek and A-B: the containing segment, else the next one, else
        the last one; nearest to `near`, because the surah-1 file appears several times).
    - **`decode.rs`:**
      - `DecodeConfig` (`From<&EngineConfig>`) and `spawn(cfg, cmds, ctl, shared)`;
      - `Decoder::{new, run, handle, pump, publish_progress, generation, queue, params, written_frames, position,
        state}`, `Pump`, `DecodeState`;
      - the exact conversions `ms_to_frame`, `us_to_frame`, `frame_to_us`, `frame_to_ms`, `silence_frames`.
    - **`fake_out.rs`** (`cfg(test)` / feature `testing`):
      - `FakeOut`, the §2.3.4 callback minus the gain ramp, and `Applied`;
      - `Rig`, which steps the decoder and the fake output deterministically and answers `NeedSource`;
      - `fixtures`, with:
        - `SURAH_AYAHS`, `ayah_count`, `ayah_id`;
        - `Layout`, `FixtureTimings` (a `TimingsSource`) and `FixtureSources` (a `SourceProvider` with offline
          toggles);
        - ramp WAVs (`ramp_wav`, `ramp_sample`, `ramp_frame`, `wav_f32`) and `silent_mp3`.
17. **The acceptance line `cargo test -p quran-audio --lib plan decode` is rejected by cargo's CLI** ("unexpected
    argument 'decode'": cargo takes a single TESTNAME). The equivalent libtest form was run instead:
    `cargo test -p quran-audio --lib -- plan decode`.
18. **No recitation audio in the repo.** No QDC MP3 was downloaded or committed: QF content is never committed (FACT
    §2.1, D10). The decode tests use in-memory fixtures instead:
    - 32-bit float WAVs whose every sample encodes its own source frame index. At 100 % with equal rates the chain
      is bit-transparent outside the 4 ms fades, so a test reads the exact source frame back from any played ring
      frame. This is how "marker frames ±0" is verified on audio content, not just on marker arithmetic.
    - Synthesised silent CBR MPEG-1 Layer III streams for the MP3 path: probe, timestamps, accurate seeks, and exact
      segment lengths through 44.1 → 44.1 and 44.1 → 48 kHz.

## Handoff to WP4c (output, control, engine) and WP4d (sources, glue)

- **Start decode** with `decode::spawn(DecodeConfig::from(&cfg), cmd_rx, ctl_tx, shared)`. It returns
  `Result<JoinHandle<()>, AudioError>` and never panics.
  - The thread exits on `DecodeCmd::Shutdown` or when every `DecodeCmd` sender is dropped.
  - **`ctl_tx` must be unbounded:** decode `send`s `NeedSource`, `DecodeFailed` and `QueueEnded`, and a bounded
    channel that is full would block it.
- **The callback.** `fake_out::FakeOut::render` is a working reference of §2.3.4 steps 1, 2, 4 and 5:
  - **Catch-up.** When `cur.generation != shared.generation`, discard frames up to the first marker of the current
    generation, popping stale markers on the way. If no such marker exists yet, every frame in the ring is stale.
  - **Copy.** Split at the head marker's `ring_frame`. Apply every marker with `ring_frame ≤ read`: Sync markers can
    arrive with `ring_frame < read`.
  - **Pause.** Copy nothing.
  - **Publish.** Store `cur.position_at(read at buffer start)`, `seg_index`, and `marker_kind` unless the marker is a
    Sync.
- **Control:**
  - Answer `CtlMsg::NeedSource(key)` with `DecodeCmd::SourceReady` or `SourceFailed`. Decode never requests a file it
    already has.
  - On `QueueEnded`, decode has already released its files. On `DecodeFailed(e)`, decode is idle: set the error
    status.
  - Seeks:
    - `SeekTarget::Ayah` → `index_of_ayah` → `Jump`;
    - `SeekTarget::FileMs` / `RelativeMs` → `Seek { file_ms }` on the audible file's timeline.
  - Skip: `skip(Previous)` within 1.5 s → `Jump(idx − 1)`, else `Jump(idx)`.
  - Stop: ramp the gain to 0 (pause) before `Stop`. Stop bumps the generation, so the callback drops the ring at
    once.
- **Snapshot.** `basmala_skipped` is true when any of these holds:
  - `PlannedQueue::basmala_skipped`;
  - control called `skip_basmalas_in` for the start source;
  - control answered `SourceFailed(Offline)` for a file that only Basmala segments use.

  `ayah_repeat_left` and `range_repeat_left` come from `Shared`.
- **Ticker.** It maps `seg_index` through the published `Arc<[Segment]>`. `Segment::word_at(file_ms)` gives the
  active word.
- **WP4c acceptance** ("1:1–1:7 synthetic plan → marker log"): use `fixtures::FixtureTimings::new(r)` and
  `FixtureSources::new(layout, rate, ch)`. Expected frames at 100 %: each segment adds exactly
  `ms_to_frame(end) − ms_to_frame(start)` frames.
- **WP4d.** Decode reads only the head of a source to open it. Accurate MP3 seeks parse frame headers forward from the
  current position, so a forward seek on a stream reads the bytes in between, and a backward seek re-reads from the
  start of the stream.

## Requests

- **WP4c (control):** set `AudioSnapshot.basmala_skipped` when you answer `SourceFailed(Offline)` for a file used only
  by Basmala segments, or when you call `PlannedQueue::skip_basmalas_in`. Decode cannot report it: `CtlMsg` is frozen.
- **WP4c:** create the decode → control `CtlMsg` channel unbounded (see handoff).
- **Lead:** fold items 5 (pts-based frame drop), 7 (marker push rule), 8 (Sync cadence), 9 (consumed-position resume)
  and 10 (A-B semantics) into §2.3.4. Item 17 is a typo in the §14.3 acceptance line.

## Verification (this machine, debug profile; quran-audio is built at opt-level 3)

| Command | Result |
|---|---|
| `cargo test -p quran-audio --lib -- plan decode` | 16 passed (8 plan, 7 decode, 1 WP4a test whose name contains "decode") |
| `cargo test -p quran-audio --test 'plan_*' --test 'decode_*'` | 13 + 11 + 9 + 9 + 2 passed |
| `QD_DECODE_STRESS_SEEDS=300 cargo test -p quran-audio --test decode_stress` | 600 randomised runs pass every invariant, in 42 s |
| `cargo test -p quran-audio` | all suites green, WP4a's included |
| `cargo clippy -p quran-audio --all-targets -- -D warnings` | clean |
| `cargo fmt -p quran-audio --check` | clean |

Each randomised run uses random device buffers (1–1,500 frames), pauses, and random jump, seek, speed, A-B, repeat
and gap commands over 112:1–114:6 (three surah files plus basmalas). It checks five invariants:
- every Segment, Gap and End marker is applied on exactly its ring frame;
- ring frames are ordered within a generation, and generations only increase;
- every flush marker sits exactly where the ring stood at the flush;
- every Sync agrees with the exact extrapolation of its anchor;
- the decoder never loops without blocking, and the queue still reaches End.

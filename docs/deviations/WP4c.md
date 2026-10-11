# WP4c deviations (output, sink, ticker, control, engine)

Owned and written: `crates/quran-audio/src/{output, sink, ticker, control, engine}.rs` and
`crates/quran-audio/tests/engine_{common, wav, output, control, stress}.rs`. No other file was touched and no dependency
was added. WP4c owns no dictionary, mock handler or scenario, so it adds no en/ar strings and no PNGs.

## Deviations from ARCHITECTURE.md

1. **The output stream is opened lazily and released when not needed** (§2.3.6 says what the output thread does, not
   when).
   - Control sends the output thread a `Demand` after every command and status change:
     - `Play` (loading, playing, buffering): a stream must run.
     - `Pause`: keep the stream, or reopen it, for `PAUSED_LINGER` (30 s).
     - `Idle` (stopped, ended, failed): release it after `IDLE_LINGER` (5 s).
   - Why: an open output stream keeps the OS audio engine awake. On Windows it is an "audio stream in use" power request,
     so a reader left open all day would block idle sleep. It also holds Bluetooth headsets in A2DP and costs battery.
   - A reopen hands decode a new ring with `resume_at_us: None`, so decode continues at the consumed ring position, which
     is exact.
   - A command while paused (a seek, for example) reopens the stream, so the new position is heard and published.
   - **Startup probe.** At start the output thread looks for a default device without opening a stream.
     - Found: `CtlMsg::OutputReady` carries the device label.
     - Not found: `OutputFailed(NoOutputDevice)`, so status `error`, with a retry every 2 s (§2.3.2 is unchanged).
   - An idle engine never opens the device. This is tested on the real device path without a stream.
2. **The device-event policy covers every cpal error kind** (`output::classify`).
   - `StreamInvalidated` and `DeviceNotAvailable` rebuild, as the spec says.
   - Every other error kind except `DeviceChanged`, `Xrun` and `RealtimeDenied` also rebuilds. cpal's WASAPI run loop
     reports an error and then exits, so the stream is dead whatever the kind.
   - `Xrun` is counted (`EngineDiagnostics::xruns`). `RealtimeDenied` is logged.
   - **Rebuild back-off.** Three rebuilds within 5 s back off to the 2 s retry. Until a stream runs again the status is
     `error(Device("the output device keeps failing; retrying"))`, so a device that fails on every start can't spin.
     The debounce is unchanged: at most one rebuild per output generation.
3. **Host and format selection.**
   - The thread takes the first host in preference order that both initialises **and** has a default output device.
     The order is PipeWire (if it is ever compiled in), PulseAudio, ALSA, WASAPI, CoreAudio, then any other host.
   - If the device's default sample format is not one of F32, I32, I16 or U16, a supported format is searched at the
     default rate.
   - The stream is built with `build_output_stream_raw`. A buffer of the wrong type is skipped rather than reaching
     cpal's `expect`.
4. **Callback (`output::Renderer`), additions to §2.3.4.**
   - **Flush declick.** When the generation changes while audio is audible, up to 8 ms of the stale frames play with a
     slew to silence before they are discarded. A seek, jump, speed change or stop therefore never cuts a waveform
     mid-swing.
     - The new generation starts at the volume with no ramp, because decode already fades it in over 4 ms.
     - Markers keep their exact frames, because the fade only uses frames before the next marker.
   - **Publication is consistent.**
     - The position, the segment index, the marker kind (the last non-Sync one) and the generation heard are all
       published as of the buffer's **first** frame.
     - So a marker met inside a buffer is published by the next buffer.
     - In WP4b's `FakeOut` reference, the position is taken at the buffer start but the segment and kind at its end. A
       snapshot then paired the basmala's position with ayah 1, which is how this was found.
   - **Cross-thread order.** The ring occupancy is read *before* the marker ring is peeked. Otherwise, frames that decode
     writes right after a flush marker that was not visible yet would be discarded as stale (a lost fade-in).
   - Integer device formats are converted through a scratch buffer allocated when the stream is built.
5. **Exact queue hand-over (the fence).** A new play first sends decode `Stop`, then a *fence*: a `SourceReady` for a
   key no queue uses (`fence://n`, surah 0), whose source records its own drop.
   - Decode drops an unneeded source as soon as it processes the command. Once the fence is dropped, decode has dropped
     the previous queue, and everything it sent about that queue is already in the channel.
   - Control drains those messages as stale (output messages are still handled), then sends `Load`. It publishes the new
     queue to the ticker as valid for generations *after* the one in force at that moment.
   - The effect: `NeedSource`, `DecodeFailed` and `QueueEnded` are never attributed to the wrong play, even when decode
     was blocked on a stalled stream of the old play. A segment index is never mapped through the wrong queue.
   - Control keeps serving commands while it waits for the fence.
   - Side effect: decode logs `dropping unneeded source for reciter 0 surah 000` at debug level once per play.
6. **Status machine details.**
   - `loading` covers the timings, the plan, the start-source open and the fence. Status becomes `playing` (or `paused`
     for `start_paused`) when `Load` is sent, not when the first frame is heard.
   - `buffering` is reported by the ticker. It requires two consecutive ticks (≈ 66 ms) in which:
     - the underrun counter rose while less than half the expected frames played, and
     - the heard source is incomplete, a source is being opened, or the current generation is not heard yet.

     It ends after two ticks that flow.
   - The End marker **heard** → `idle` (control acts on the ticker's report).
   - After the end, the snapshot keeps `reciter_id` and `range`, and `current` is `None`. After a stop it keeps neither.
   - While the output is failing, the status is `error` carrying the output's own failure: `NoOutputDevice`, or
     `Device(..)` for the back-off. This holds while idle too, as §2.3.2 says. The next `OutputReady` clears it and
     restores `loading`, `playing`/`paused` or `idle`.
   - Every `OutputReady` forces a state event, including a reroute (`DeviceChanged`) to a device with the same name
     (§2.3.6: "emit a state change").
7. **Commands while control is blocked.** Planning and opening a source can block on the network.
   - A play followed by a newer play or a stop is superseded, so its `Load` is never sent.
   - A pause that is queued when the play starts makes it start paused.
   - A seek, skip or A-B loop that arrives while a play is loading is held, then applied to that play once it starts.
     So "play, then seek" (S16) lands on the new play rather than being dropped.
   - `pause`, `stop`, `toggle` (when audible) and `set_volume` also act on the callback's atomics directly in
     `AudioEngine`. They are heard within one device buffer whatever control is doing.
8. **`AudioEngine::play` updates the snapshot optimistically** (`loading`, reciter, range, repeats, gap, no error)
   before control picks the play up. `audio_play` then returns `loading` rather than the previous state.
9. **Snapshot and tick values.**
   - `file_ms`, `current`, `ayah_from_ms`/`ayah_to_ms`, `file_duration_ms`, `buffered_pct` and the repeat counters are
     computed when read, from the callback's atomics and the published queue.
   - `ayah_from_ms`/`ayah_to_ms` are the ayah's own span from the timings. A continuous segment ends at the next ayah
     instead.
   - **Audible position.** It is the published position minus the output latency in *file* time (latency ×
     speed / 100). It is never placed before the start of the segment it is in, so the reported word and ayah agree.
     During a gap and at the end the position is frozen and not compensated.
   - **During the basmala.** `current = {surah, 0}`, `current_ayah_id = Some(0)` and `word_pos = 0`. The basmala's
     words are 1:1's and are not on the page being read.
   - **While a flush is not heard yet,** the last heard values are reported (no flicker to "nothing").
10. **Events.**
    - `state` is emitted on every heard marker edge: generation, segment or kind (segment, gap, end), and on control's
      changes.
    - `ayah_changed` is emitted only when the heard **ayah** differs from the last one reported. It is not emitted for
      a repeat of the same ayah, a seek inside it, or a gap.
    - Ticks run at `tick_hz` while playing or buffering. Otherwise one tick is sent per change, during a 1 s window after
      each control wake-up, and then the ticker parks.
11. **Command semantics the spec leaves open.**
    - `skip(Next)` at the last segment does what its end would do: while range repeats remain (∞, or fewer passes
      started than asked for) it starts the next pass (`DecodeCmd::NextPass`); on the last pass it stops. (Integration,
      Rust-app fixes round 2; it stopped in every case before.)
    - `skip(Previous)` measures the 1.5 s in wall time (file time × 100 / speed).
    - `seek(Ayah)` outside the playing range is ignored (logged).
    - `seek(RelativeMs)` before anything was heard is ignored.
    - `seek(FileMs)`/`seek(RelativeMs)` are bounded to the **run** of the heard file (`plan::file_run`: the consecutive
      segments that play it in order): before it, its start; past it, its end. So a seek never plays audio of the file
      that the queue does not (the ayahs outside the range, or the surah-1 file's 1:1 that backs a basmala elsewhere);
      the A-B wrap to A follows the same rule (round 2).
    - `set_ab_loop` without a play, or with `b ≤ a`, is ignored, and the snapshot shows no loop. A and B are bounded to
      the heard run, so the snapshot reports the loop that plays; a loop that the bounds leave shorter than 300 ms
      (`MIN_AB_LOOP_MS`) is ignored like an inverted one, which clears the loop in force (round 2).
    - Play (`resume`, `toggle`) after a play failed mid-way plans the request again with the repeats and gap in force
      and continues from the segment that was heard, in its pass (`control.rs` `retry`); still failing before it
      starts, the failed play stays as it was (round 2). The browser mock (`src/lib/ipc/mock/handlers/audio.ts`) follows
      all of these since integration gate 3.
    - Speed is engine state that persists across plays (`PlayRequest` has no speed). Repeats and gap come from each
      `PlayRequest`, and later `set_*` calls override them.
12. **Shutdown** sends `Shutdown` to every thread directly, not through control, so a control thread blocked in a
    network open does not delay it.
    - It joins for at most 500 ms in total. A thread still blocked after that is detached and logged.
    - `Drop` calls it too.
13. **Debug sinks (D24).**
    - The sinks run at 48 kHz stereo in 480-frame (10 ms) buffers paced by the wall clock. They run the same `Renderer`
      as the cpal callback, with zero latency.
    - The WAV is 32-bit float. Missing parent directories of the WAV and its log are created.
    - An unrecognised `QD_AUDIO_SINK` value selects the null sink with a warning, never the speakers.
    - The log format is documented in `sink.rs`:
      - `{"event":"marker",…}` lines carry `ringFrame`, `readFrame`, `deviceFrame` and `outputGeneration`;
      - `{"event":"tick","tick":{…AudioTick…}}`;
      - `{"event":"output",…}` for every stream built, with its reason and `resumeAtUs`.
14. **Public API additions.** The spec fixes only `EngineConfig` and the `AudioEngine` methods.
    - **`engine.rs`:**
      - `AudioEngine::start_with_output(cfg, timings, sources, sink, OutputKind)`; `start` uses `OutputKind::from_env()`;
      - `OutputKind`, re-exported;
      - `EngineDiagnostics` and `AudioEngine::diagnostics()`;
      - `EngineConfig::validated()` (1..=120 Hz, 100..=5000 ms ring);
      - `AudioEngine::inject_output_command(OutCmd)` (`cfg(test)` or feature `testing` only).
    - **`output.rs`:** `Renderer`, `OutputStats`, `MarkerObserver`, `AppliedMarker`, `classify`/`StreamEvent`,
      `polls_default_device`, `host_rank`, `Demand`, `PAUSED_LINGER`, `IDLE_LINGER`, `DEFAULT_DEVICE_POLL`.
    - **`sink.rs`** (debug only): `SinkKind`, `WavWriter`, `EventLog`, `LogLine`, `SinkFiles`, `marker_line`, the
      `SINK_*` constants.
    - `CtlCmd`, `Hub` and the thread bodies are `pub(crate)`.
15. **Acceptance command.** `cargo test -p quran-audio --test 'engine_*'` works as written (cargo accepts the glob). It
    also builds `engine_common.rs`, the shared test helpers, as an empty target.

## Handoff (WP4d glue, WP6a/WP6c hooks, WP9a player, WP13 QA)

- The `AudioEngine` signatures are unchanged.
  - `start` honours `QD_AUDIO_SINK` in debug builds.
  - Tests can choose the output explicitly with `start_with_output(.., OutputKind::Sink(SinkKind::Null))`.
- **`AudioService::play`** can return `engine.snapshot()` right after `engine.play(req)`: it already reads `loading`.
- **Speed** is engine state: call `set_speed(settings.speed_pct)` once at start and on settings changes. Volume works
  the same way (`set_volume`, applied at once).
- **Status values the UI will see:**
  - `idle → loading → playing ⇄ paused`; `playing ⇄ buffering`; `error`, with `snapshot.error` set;
  - `error(NoOutputDevice)` at idle when there is no device;
  - at the end, `idle` with `range` kept.
- **`EventSink` threads.** It is called from `qd-audio-ctl` (state changes and errors) and `qd-audio-tick` (ticks,
  `ayah_changed`, state on marker edges). An implementation must not block. It may call engine commands, which only
  send on a channel.
- **Listen history (WP4d).** `ayah_changed` fires once per heard ayah (not per repeat). Measure the ≥ 3 s from the
  ticks.
- **IC2 (WP5e).** With `QD_AUDIO_SINK=wav:artifacts/ic2.wav` the log is `artifacts/ic2.wav.log`. Tick lines carry
  `tick.wordPos` and `tick.fileMs` exactly as sent to the app. `tests/engine_wav.rs` shows how to check them against a
  plan.
- **Device policy, real hardware.** It was not exercised on hardware here (LEAD item 9). Unit tests cover it with cpal
  error values; integration tests cover it through injected `OutCmd`s on the sinks.
  - WASAPI default-device switches arrive as `StreamInvalidated` (or `DeviceNotAvailable`) and rebuild within one
    output-thread wake-up.
  - The macOS/Linux checklist item "device unplug and default-device switch" (§12.6) is the hardware check.

## Requests

- **Lead:** fold items 1 (lazy output stream), 4 (declick, publication as of the buffer start, occupancy-first catch-up),
  5 (the fence), 6, 9 and 10 into §2.3.4/§2.3.6.
- **WP4b (optional):** `fake_out::FakeOut::render` publishes the position as of the buffer start but `seg_index` and
  `marker_kind` as of its end, and it reads the ring occupancy after peeking the marker ring. Neither matters for the
  single-threaded `Rig`, but the real callback (`output::Renderer`) does both the other way (item 4). Mirroring it would
  keep the reference exact.

## Verification (this machine, Windows 11, debug profile; quran-audio built at opt-level 3)

| Command | Result |
|---|---|
| `cargo test -p quran-audio --test 'engine_*'` | engine_wav 1, engine_output 4, engine_control 11, engine_stress 1 passed (engine_common: 0 tests) |
| `cargo test -p quran-audio --lib -- output:: sink:: control:: ticker:: engine::` | 34 passed |
| `cargo test -p quran-audio` | every suite green (91 lib tests, WP4a/WP4b suites included) |
| `cargo test -p quran-desktop --lib` | 121 passed: src-tauri's tests start the real engine (on the null sink) |
| `QD_ENGINE_STRESS_SEEDS=8 cargo test -p quran-audio --test engine_stress` | 3 × 8 storms pass every invariant |
| `cargo clippy -p quran-audio --all-targets -- -D warnings` | clean (debug) |
| `cargo clippy -p quran-audio --release --all-targets -- -D warnings` | clean (no debug sinks compiled) |
| `rustfmt --edition 2024 --check` on the owned files | clean |
| `cargo check -p quran-desktop --all-targets` | compiles against the engine |

**`engine_wav`** (WAV sink, 1:1–1:7, real time) checks:
- the 7 Segment markers and the End marker land on the planned ring frames (each segment exactly
  `ms_to_frame(end) − ms_to_frame(start)` frames, within ±1);
- each marker is applied on its own frame, with no gap in device frames;
- at every contiguous boundary, the WAV sample is the planned first source frame and the sample before it is its
  predecessor (no frame skipped or repeated);
- the ticks are in ayah order, with every `wordPos` equal to the planned active word;
- `ayah_changed` fires for 1..=7, and the statuses go idle → loading → playing → idle.

**`engine_output`** checks:
- an injected `Rebuild` resumes within 2 s, on a fresh ring, at the audible position (flush marker within one frame of
  `resumeAtUs`);
- a second `Rebuild` for the same generation is ignored;
- `DeviceChanged` relabels with no rebuild and no flush;
- a rebuild while paused keeps the position (±1 ms) and stays paused;
- the output opens on play and is released 5 s after idle;
- an engine on the real device path never opens a stream while idle.

**`engine_control`** also checks that a replaced play's decode failure is never pinned on the play that replaced it.
In the test, the old play's file stalls and then fails while the new play's timings are still loading. With the fence's
stale-message drain disabled, the test fails in its first round.

**`engine_stress`** checks, under 30–80 random commands (seeks, jumps, skips, speeds, repeats, gaps, A-B loops,
pauses, toggles, injected rebuilds over 112:1–114:6):
- every Segment/Gap/End marker is applied on its exact frame;
- ring frames are ordered within a stream, and generations only increase;
- every segment index is inside the queue;
- samples stay finite in [−1, 1];
- no error other than the rebuild back-off, and the engine plays and stops cleanly afterwards.

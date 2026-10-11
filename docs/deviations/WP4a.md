# WP4a deviations (DSP: WSOLA, resampler, mix)

Owned: `crates/quran-audio/src/dsp/**` (`mod.rs`, `wsola.rs`, `resample.rs`, `mix.rs`, new `chain.rs`, new test-only
`signals.rs`) and `crates/quran-audio/tests/dsp_*.rs` (`dsp_wsola.rs`, `dsp_cpu.rs`, `dsp_listen.rs`).
No other file was touched. No dependency was added.

## Deviations from ARCHITECTURE.md

1. **Centre-weighted similarity (§2.3.5 step 3).** The search maximises SoundTouch's heuristic
   `(ncc + 0.1)·(1 − 0.25·u²)`, `u = δ/Δ`, instead of the bare normalised cross-correlation. Everything else in step 3 is
   unchanged: a mono mix decimated ×4 searched in steps of 4, then refined at full rate ±3, over `δ ∈ [−Δ, Δ]`.
   The reason is measured. With the bare NCC maximum, `δ` runs to the edge of the window: whenever the natural
   continuation lies outside it, the nearest pitch-period peak wins. That happened on 35–65 % of voiced hops (more
   than 5 ms off the nominal position) on the synthetic recitation at 50–200 %, and on all silent hops, because ties
   resolve to `−Δ`. With the weighting, 0–0.1 % of voiced hops exceed 5 ms, silence stays exactly on `p_k`, and a
   candidate with clearly better correlation still wins. The weighting only breaks near-ties, so splice quality is
   unchanged.
2. **`Wsola::set_speed` resets.** §2.3.5 says it is "called only right after reset()". Changing the speed mid-stream would
   make `p_k = round(k·Hs·α)` jump, so the call itself flushes. The speed is clamped to 50..=200 (`MIN/MAX_SPEED_PCT`);
   `DspChain::new`/`reset_with_speed` clamp the same way.
3. **`Wsola::drain` ends with a reset** (the speed is kept), so the next `push` starts a new stream at nominal position 0.
   It emits exactly `Hs + ⌈L·100/pct⌉` frames for `L` pushed frames, and 0 frames when nothing was pushed.
4. **WSOLA timeline, made precise.** The input is conceptually preceded by `Hs` frames of silence, so frame `k` is centred
   on source frame `q_k`. The first `latency_frames()` = `N/2` output frames are exact zeros. Output frame `t` carries the
   nominal source position `α·(t − Hs)`. `nominal_input_pos()` is `p_{K−1}` after `K` hops, which is the position of the
   next output frame, as WP0B's stub doc says. Frames after the first never read the leading silence (`q_k ≥ Hs`).
   At exactly 100 % there is no search, and the output is the input delayed by `Hs`, up to the f32 rounding of
   `w[i] + w[i+Hs] = 1`.
5. **Additional public API** (the spec fixes only the `Wsola` signatures; WP0B left `resample`/`mix` to WP4a):
   - `Wsola`: `actual_input_pos()` (`q_k`), `hop_positions(k) -> Option<(p_k, q_k)>` (last 64 hops),
     `nominal_pos_of_hop(k)`, `output_frames_for(len)`, and accessors (`frame_frames`, `hop_frames`, `tolerance_frames`,
     `input_frames_pushed`, `output_frames_emitted`, `hops_emitted`, …). Constants `MIN_SPEED_PCT`, `MAX_SPEED_PCT`,
     `UNITY_SPEED_PCT`.
   - `resample::Resampler`: `new(src_rate, out_rate, channels) -> Result<_, AudioError>`, `push`, `pull`, `drain`, `reset`,
     `ratio()` (exact, lowest terms), `delay_frames()`, `latency_frames()`, `out_frames_for`, `in_frames_for`. Equal
     rates are a passthrough. **The wrapper trims rubato's startup delay** (`output_delay()` = `fft_out/2`), so output
     frame `u` is input position `u·src/out`. `drain` emits exactly `⌈in·out/src⌉` frames in total.
   - `mix`: `map_channels`, `Fade` (4 ms), `GainRamp` (for the cpal callback: `apply_linear` for volume, `apply_slew` and
     `frames_to_reach` for the 8 ms pause ramp), `volume_gain(pct)` (square law), and `ms_to_frames`.
   - **New file `dsp/chain.rs`:** `DspChain`, `StreamFormat`, `SyncPoint`. This is the decode chain, WSOLA (bypassed at
     100 %) → resampler (passthrough at equal rates) → channel map → fades. It drops WSOLA's pre-roll, so output frame
     `u` is exactly source position `u·speed_pct·10⁶/(100·out_rate)` µs = `MediaRate::advance_us(u)`. The positions are
     exact by construction: `p_k` is absolute and rubato's block ratio is exact. The chain always holds back the last
     4 ms, so `drain(out, fade_out = true)` can fade out a segment end even when no stage has latency.
   - **New file `dsp/signals.rs`** (`cfg(any(test, feature = "testing"))`): deterministic `SineGen`, `VoiceGen`
     (recitation-like voice with `is_voiced_at`), `Lcg`, and `noise`, for WP4b/WP4c tests too.
6. **Fade shape.** The 4 ms fades are raised-cosine, not linear, so there is no slope discontinuity at either end. The
   spec gives no shape for "4 ms fades"; the volume ramp stays linear, as §2.3.4 step 3 says.
7. **Channel map edge cases the spec leaves open.** A source with 2 or more channels on a **mono device** is downmixed to
   `(L+R)/2`. On a surround device, mono goes to the first two channels (L and R) and the other channels are silent. Two
   or more source channels go to the first `min(src_ch, out_ch)` device channels and the rest are silent, as §2.3.4 says.
8. **Position criterion (§2.3.5: "within ±5 ms of the true source position").** §2.3.4 defines the Sync position as
   exact from `p_k`, so the test reads "true source position" as the exact stretched timeline `u·α/out_rate`, computed
   independently in f64. The test derives positions exactly as decode and the callback will: a flush Segment marker,
   Sync markers from `DspChain::sync_point()` every 100 ms, and `Marker::position_at` extrapolation. Measured over 5
   minutes at 44.1 → 48 kHz, every 5 % step: at most **12 µs** off anywhere in the run.
   The audible content is checked as well, using WSOLA's actual frame centre `q_k` (`SyncPoint::actual_src_us`):
   - it never strays more than `Δ` + 1 frame (10.05 ms) from the nominal position;
   - the mean offset in every 10 s window is at most 0.62 ms, so there is no drift and no bias;
   - on steadily voiced content it is within ±5 ms on **100 %** of probes.

   WSOLA itself bounds the content offset by `Δ` = 10 ms, so the criterion can't hold sample-exactly on noise or
   fricatives, where the alignment chases the exact continuation.
9. **Listening test (R4: 3 reciters × 5 speeds).** It cannot be done here: no audio may be played (LEAD item 9), and the
   machine has no recitation MP3s. `tests/dsp_listen.rs` (`#[ignore]`) renders any MP3/WAV list (`QD_DSP_LISTEN="a.mp3;b.mp3"`)
   through the real chain at 50/75/125/150/200 % into `artifacts/dsp-listen/*.wav` (16-bit, 48 kHz stereo). Without
   the variable it renders the synthetic voice; that path ran here, and so did a WAV round trip through symphonia.
10. **Resampler delay for odd FFT blocks.** The wrapper uses rubato's `output_delay()` (`fft_out/2`). For an odd `fft_in`
    the true delay differs by under half an output frame. Every common pair (44.1↔48, 22.05→48, 32→48, 8→44.1) has an even
    `fft_in`; the impulse test pins 44.1 → 48 kHz to ±1 frame.
11. **Infallible `pull`/`drain`.** rubato errors cannot occur with the buffer sizes fixed in `new`. If one ever did, the
    wrapper logs it at error level and outputs silence of the exact expected length, so marker frames stay exact. It
    does not panic and does not change the signature. Only constructors return `Result`.

## Measurements (release, this machine)

- Length over 10 min, 62 configurations (44.1 and 48 kHz × 31 speeds): output minus latency is exactly
  `⌈len·100/pct⌉`, and the worst error is 0.0015 hop off `len/α`.
- Sine continuity, full-scale 440 Hz at 0.5/0.75/1.25/1.5/2.0, through WSOLA alone and through the chain: the largest
  step is 0.063 at 44.1 kHz and 0.058 at 48 kHz, which is the sine's own slope. The bound is 0.25.
- Pitch, 440 Hz by zero-crossing count: at 1.5× the error is +0.022 % (44.1 kHz) and −0.029 % (48 kHz). Every other
  listed speed is within ±0.06 %.
- CPU (best of 5): WSOLA at 48 kHz stereo, 1.5×, uses **0.27–0.30 %** of one core. The bound is 3 %.
- The full chain (44.1 kHz stereo → 48 kHz stereo) uses 0.28–0.33 % of one core at 50, 150 and 200 %, and 0.06 % at
  100 %.

## Handoff (how WP4b decode and WP4c callback use this)

- **Per file and per output:** build `DspChain::new(StreamFormat { src_rate, src_channels, out_rate, out_channels },
  speed_pct)`. Build a new one when the decoded format or the device format changes (`NewOutput`).
- **Flush** (play, seek, jump, speed change, new output): call `chain.reset()` or `chain.reset_with_speed(pct)`. Then push
  the Segment marker at the current `written_frames` with `file_pos_us` = the exact seek position and
  `rate = chain.media_rate()`. The 4 ms fade-in is automatic.
- **Steady state:** call `chain.push(&decoded_interleaved)`, then `chain.pull(&mut buf)`, then write `buf` to the ring.
- **Sync markers:**
  1. Call `let sp = chain.sync_point()` after a pull.
  2. Set `ring_frame = gen_origin + sp.out_frame` and `file_pos_us = origin_us + sp.src_us`.
  3. Push it every ~100 ms of output.

  `sp.out_frame ≤ out_frames_pulled()`. `Marker::position_at` extrapolates from `ring_frame`, so a Sync marker the
  callback meets late is still exact. Any frame works too: `chain.src_us_at(u)`.
- **Contiguous segment boundary** at absolute source frame `E` (`origin` = the source frame of the last reset): use
  `ring_frame = gen_origin + chain.out_frame_at_src(E − origin)`. That is "written_frames + dsp latency", computed
  exactly. Push source up to exactly `E` first, then ask. The answer is at least 4 ms past `out_frames_pulled()`
  because of the hold-back, so the marker is never behind frames already written (unit-tested).
- **Non-contiguous end, A-B wrap, or end of queue:**
  1. Call `chain.drain(&mut buf, true)` (the last 4 ms fade out).
  2. Write `buf` to the ring.
  3. Seek.

  The chain is reset by then: its fade-in is armed and its positions restart at 0, which is the new origin.
- **The callback (WP4c):**
  - Set the volume with `shared.set_gain(volume_gain(pct))`.
  - For volume changes, `ramp.apply_linear(buf, ch, shared.gain())`.
  - To pause, `ramp.apply_slew(buf, ch, 0.0, ms_to_frames(PAUSE_RAMP_MS, rate))`. It returns how many frames were
    processed before the gain reached 0. After that, output silence without consuming the ring.
    `ramp.frames_to_reach(0.0, n)` tells beforehand how many ring frames the ramp needs.
- `chain.pending_out_frames()` gives the output still owed for the input pushed so far. `chain.latency_frames()` is its
  steady-state bound.

## Requests

- **Lead / R4:** run `QD_DSP_LISTEN="<3 reciters' MP3s>" cargo test -p quran-audio --release --test dsp_listen -- --ignored`
  and listen to `artifacts/dsp-listen/`.

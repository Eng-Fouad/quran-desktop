# rust-audio-media

## Recommendation in brief
**Play audio natively in Rust, not through HTML5 `<audio>` or Web Audio in the webview.** Build a small custom engine on these crates:
- **cpal 0.18.2**: device output.
- **symphonia 0.6.1**: decoding.
- **rtrb 0.4.0**: lock-free ring buffer.
- **rubato 5.0.1**: sample-rate conversion.
- **signalsmith-stretch 0.1.3**: speed change that keeps the pitch.
- **stream-download 0.24.4**: progressive HTTP download with seeking, plus our own disk-cache provider.

**OS media controls:** write our own small `media_session` module on the same bindings Tauri already uses:
- Windows: `windows` 0.62.2, using SMTC (System Media Transport Controls).
- macOS: `objc2-media-player` 0.3.2.
- Linux: `mpris-server` 0.10.0, which uses zbus 5.

A quick start is to vendor playwire 2.0.0 and add playback rate. souvlaki 0.8.3 works, but it never reports playback rate, and its released version pulls in `windows` 0.44.

All Rust sketches below were run through **`cargo check`** on this machine (Rust 1.99.0, x86_64-pc-windows-msvc, tauri 2.12.2). That check is Windows-only: the macOS and Linux backends were not compiled, and the sketches have not played real audio. A silent cpal probe did run on WASAPI.

## 1. Crate versions (from the crates.io API, 2026-10-10)
| crate | version (date) | licence | MSRV | notes |
|---|---|---|---|---|
| tauri | **2.12.2** (2026-10-09) | Apache-2.0 OR MIT | 1.90 | 3.0.0-alpha.4 also exists. Resolves to wry 0.57.0, tao 0.37.1, windows 0.62.2, webview2-com 0.39.1 |
| cpal | **0.18.2** (2026-08-16) | Apache-2.0 | 1.85 | New `pulseaudio` and `pipewire` features. Streams no longer auto-start |
| symphonia | **0.6.1** (2026-08-13) | MPL-2.0 | 1.85 | Breaking API change from 0.5. **MP3 is not in the default features** |
| rodio | 0.22.2 (2026-03-05) | MIT OR Apache-2.0 | 1.87 | Still on cpal ^0.17 and symphonia ^0.5.5. Master has moved to cpal 0.18 but is unreleased |
| kira | 0.12.5 (2026-09-26) | MIT OR Apache-2.0 | – | cpal ^0.18.1, symphonia ^0.6.0 |
| awedio | 0.8.0 (2026-06-12) | MIT OR Apache-2.0 | – | cpal ^0.18, symphonia ^0.6. Small user base (1.7k recent downloads) |
| stream-download | **0.24.4** (2026-08-29) | MIT OR Apache-2.0 | **1.91** | reqwest ^0.13.4 (resolves to 0.13.5) |
| rtrb | **0.4.0** | MIT OR Apache-2.0 | 1.38 | |
| rubato | **5.0.1** (2026-10-01) | MIT OR Apache-2.0 | 1.87 | Uses the audioadapter 5 API |
| signalsmith-stretch | **0.1.3** (2025-09-18) | MIT | – | Needs cc (C++14) and bindgen ^0.70, so **libclang** at build time |
| rodio-wsola / wsola | 0.2.0 / 0.1.0 | Apache-2.0 / MIT | – | Pure-Rust WSOLA time-stretch. Both brand new (Jul 2026) |
| timestretch | 0.15.0 | MIT | 1.85 | Built for EDM DJ decks (about ±20% speed). Not suitable for 0.5x–2x |
| ssstretch | 0.1.0 | MIT | – | GitHub repo returns 404. Avoid |
| souvlaki | 0.8.3 (2025-06-24) | MIT | 1.67 | Master updated 2026-08-25 (windows 0.62, zbus 5.15) but no release since |
| playwire | 2.0.0 (2026-10-06) | MIT OR Apache-2.0 | 1.75 | 0 stars, 1,849 lines of code. Uses windows 0.62.2, objc2-media-player 0.3.2, zbus 5.19 |
| mpris-server | **0.10.0** (2026-04-19) | MPL-2.0 | – | zbus ^5.14. The docs.rs build for 0.10.0 failed |
| objc2-media-player | **0.3.2** | Zlib OR Apache-2.0 OR MIT | 1.71 | |
| windows | **0.62.2** | MIT OR Apache-2.0 | 1.82 | Same version Tauri 2.12.2 uses |
| zbus | 5.19.0 | MIT | 1.87 | |

**Workspace MSRV:** set `rust-version = "1.91"`, because stream-download 0.24.4 requires it.

## 2. API facts confirmed in source code
### rodio 0.22
- **Renames:** `OutputStream` → `MixerDeviceSink`, `OutputStreamBuilder` → `DeviceSinkBuilder`, `Sink` → `Player`, `open_default_stream` → `open_default_sink`.
- **Doc mismatch:** the 0.22.2 source still names the method `DeviceSinkBuilder::open_stream`. UPGRADE.md says it is `open_mixer`.
- **`Player` methods:** `connect_new(&Mixer)`, `append`, `set_speed`, `try_seek`, `get_pos`, `skip_one`, `clear`, `len`, `empty`, `sleep_until_end`.
- **`Decoder::builder()` options:** `.with_data`, `.with_byte_len`, `.with_seekable`, `.with_gapless(true)` (true is the default), `.with_hint`.
- **Reasons not to use rodio here:**
  - `Player::set_speed` changes sample rate, so pitch shifts with speed.
  - `get_pos` resets to zero for each appended source.
  - Under speed ≠ 1, `get_pos` reports elapsed wall time, not position in the recording (its `TrackPosition` sits after `Speed`).
  - `try_seek` only works within the current source.
  - Decoding runs inside the audio callback, so a network reader that blocks would stall output.
  - The output buffer is about 50 ms, rounded to a power-of-two frame count (`sample_rate / 20`).

### symphonia 0.6.1
- `FormatOptions` is `#[non_exhaustive]` (fields: `prebuild_seek_index`, `seek_index_fill_period_ms` defaulting to 1000, `external_data`). The old `enable_gapless` option is gone.
- Gapless playback is automatic: packets carry `trim_start`/`trim_end`, the MP3 demuxer reads the LAME `enc_delay`/`enc_padding`, and the decoder trims each buffer.
- Main API calls:
  - `get_probe().probe(&hint, mss, fmt_opts, meta_opts)`
  - `reader.default_track(TrackType::Audio)`
  - `get_codecs().make_audio_decoder(params.audio(), &AudioDecoderOptions)`
  - `next_packet() -> Result<Option<Packet>>`
  - `buf.copy_to_vec_interleaved::<f32>()`
  - `seek(SeekMode::Accurate, SeekTo::Time{time: Time::from_micros_u64(..), track_id})`, which returns `SeekedTo{required_ts, actual_ts}`. Drop `required − actual` frames afterwards for sample-accurate positioning.

### cpal 0.18
- `build_output_stream(config: StreamConfig /*by value*/, data_cb, err_cb, timeout: Option<Duration>)`. Call `stream.play()` explicitly; the unreleased master renames it to `start`.
- `info.timestamp().playback.checked_duration_since(ts.callback)` gives output latency; on WASAPI and CoreAudio this includes hardware latency.
- **Linux:** host priority is PipeWire > PulseAudio > ALSA. The ALSA backend is always compiled in.
- **WASAPI:** default-device streams automatically follow a change of system default device. The built-in resampler accepts formats it can convert.
- **CoreAudio:** reports `DeviceChanged` and `StreamInvalidated` on sample-rate changes.
- `Stream` is asserted `Send + Sync` for the WASAPI, CoreAudio and ALSA hosts.
- **Probe result here:** WASAPI on "Voicemeeter Input", 48000 Hz, stereo, f32, 480-frame callbacks, reported latency up to about 44.8 ms.

### kira 0.12.5
- `StreamingSoundData::from_media_source`, `handle.position()`, `seek_to`, `set_loop_region` (built-in A-B loop), `playback_rate`.
- `playback_rate` shifts pitch, and kira is designed for games. Usable as a fallback, not the first choice.

## 3. Engine architecture (as implemented in `sketches/src/engine.rs`)
```
Tauri command / OS media key -> crossbeam Cmd -> [decode thread: symphonia -> stretch(sig.) -> rubato -> channel map]
   -> rtrb<f32> samples + rtrb<Marker> -> [cpal callback] -> atomics -> 30 Hz ticker -> tauri::ipc::Channel<\Tick> -> UI (rAF interpolation)
```
- **Unit of playback:** a `Segment {surah, ayah, file, start_ms, end_ms}`.
- **Markers instead of flushes:** every discontinuity (next ayah, repeat, A-B wrap, file switch) is pushed as an in-band `Marker{generation, ring_frame, seg_index, file_pos_us, media_ns_per_frame}`. The audio callback applies it at the exact frame it belongs to. Repeats and loops never flush the buffer, so they are gapless and sample-accurate.
- **User seek or jump:** increments `flush_gen`. The callback then discards stale ring frames up to the first marker of the new generation.
- **Audible position:** `file_pos_us − out_latency_us`.

How each requirement is met:
- **(a) Surah MP3 with ayah timings.** All segments share one decoder and boundaries are markers only, so playback is truly gapless.
- **(b) One MP3 per ayah.** The next file is opened in the decode thread; the ring buffer holds about 1.5 s. symphonia trims LAME delay and padding. Files without a LAME/Xing header may still have a small gap.
- **(c) Repeat ayah N times, repeat range, A-B loop.** `Repeat{each, range}` and `SetAbLoop` are handled in `segment_finished`, with no flush. A "pause between repeats" option only needs silence frames plus a marker.
- **(d) Speed 0.5x–2x.** Bypass the stretcher at exactly 1.0. Otherwise feed `signalsmith_stretch::Stretch::preset_default(ch, rate)` with `process(in[N], out[round(N/speed)])`, and call `reset()` plus `seek(preroll, rate)` after a seek. Markers carry `media_ns_per_frame = 1e9·speed/out_rate` so highlighting stays exact.
  - Pure-Rust fallback behind a trait: `wsola` 0.1.0 or rodio-wsola 0.2.0.
  - rubato only resamples. Its `Async` mode with a sweeping ratio is varispeed, which shifts pitch.
- **(e) Streaming plus cache.** In `cache_stream.rs`, a custom `StorageProvider` writes `<app_cache_dir>/audio/<reciter>/<sss>.mp3.part`. On `StreamPhase::Complete`, rename it to `.mp3`. stream-download fills any download gaps before it reports Complete. `HttpMediaSource` implements symphonia's `MediaSource`. Reads block until data arrives, so call them only from the decode thread. For per-ayah files, plain reqwest downloads with prefetch of the next N ayahs are enough.
- **(f) Seeking.** `SeekMode::Accurate`, then skip `required_ts − actual_ts` frames. Set `seek_index_fill_period_ms = 250`. When streaming, a seek past the downloaded part triggers an HTTP Range request.
- **Sample rate.** Open the device at its default rate and resample in the decode thread: `rubato::Fft` with `FixedSync::Input` for a fixed 44.1→48 kHz ratio. Do not ask CoreAudio for 44.1 kHz; cpal 0.18 sets the hardware format directly.
- **Device changes.** In cpal's `err_cb`, rebuild only the output stream on `DeviceChanged`, `DeviceNotAvailable` or `StreamInvalidated`. The ring buffer and decode thread stay as they are.
- **Getting position to the UI.**
  - Tauri's docs say events are "not designed for low latency or high throughput" and that channels are "designed to be fast and deliver ordered data". So send about 30 Hz `Tick`s over `tauri::ipc::Channel`.
  - Emit `audio://ayah-changed` the moment the marker flips.
  - The UI interpolates between ticks with `requestAnimationFrame`.
  - Update the OS media session only when the ayah, play/pause state or seek position changes, not on every tick.

Dependencies:
```toml
cpal = "0.18.2"
symphonia = { version = "0.6.1", default-features = false, features = ["mp3", "opt-simd"] } # add "aac","isomp4" only if needed
rtrb = "0.4.0"
rubato = "5.0.1"
crossbeam-channel = "0.5.17"
signalsmith-stretch = "0.1.3"
stream-download = { version = "0.24.4", default-features = false, features = ["reqwest-rustls"] }

[target.'cfg(target_os = "linux")'.dependencies]
cpal = { version = "0.18.2", features = ["pulseaudio"] } # pure-Rust protocol; works on PipeWire-pulse; avoids libpipewire + bindgen
```

## 4. Native engine vs HTML5 `<audio>` / Web Audio in the webview — decision: native
| | Native Rust engine | `<audio>` / Web Audio via a custom protocol with Range support |
|---|---|---|
| Ayah sync | Sample-accurate in-band markers plus cpal latency timestamps | `timeupdate` fires at roughly 4–66 Hz (MDN). Ayah logic runs in JS |
| Window minimised or hidden | Logic runs on a Rust thread and is unaffected | Tauri's `backgroundThrottling` setting is **unsupported on Windows and Linux** and works only on macOS 14+. Browsers "throttle timers and even unload the whole tab… after roughly 5 minutes". Tauri issue #5250 is still open ("Don't wait for this feature") |
| Gapless and repeats | Built in | Switching `<audio>` elements leaves gaps. Web Audio needs whole files decoded in memory and JS scheduling |
| Speed with pitch kept | Needs signalsmith-stretch (C++ and libclang at build) | Free: `preservesPitch` defaults to true and is "Baseline widely available" |
| Linux codecs and size | symphonia with MP3 only; no GStreamer | WebKitGTK needs GStreamer. The AppImage `bundleMediaFramework` option adds about 15–35 MB |
| Media keys | One consistent implementation in our code | WebView2, WebKitGTK and WKWebView differ; not confirmed |

The webview's only real advantage is free pitch-preserving speed. That does not outweigh background-throttling breaking repeat/A-B/memorization logic on Windows and Linux.

## 5. OS media controls
- **souvlaki 0.8.3** (compiles with Tauri 2.12.2 on Windows).
  - Config: `PlatformConfig{display_name, dbus_name, hwnd: Option<*mut c_void>}`. Get the HWND with `win.hwnd()?.0 as *mut c_void`; Tauri 2.12.2 has `WebviewWindow::hwnd() -> tauri::Result<HWND>` (windows 0.62).
  - Problems:
    - Released 0.8.3 pulls in `windows` 0.44.0 (a duplicate) and either libdbus (`use_dbus`, the default, needs `libdbus-1-dev`) or zbus 3 (`use_zbus`).
    - The MPRIS `Rate`, `MinimumRate` and `MaximumRate` are hardcoded to 1.0, and `mpris:trackid` is "/".
    - macOS never sets a playback rate and reads the private `_positionTime` ivar.
    - Next and Previous are always enabled.
- **playwire 2.0.0.**
  - Already built on modern dependencies, and on macOS it sets `MPNowPlayingInfoPropertyPlaybackRate`.
  - Problems: that rate is only 1.0 or 0.0 (so wrong at 1.5x), it has 0 stars, and it is 4 days old.
- **Recommendation:** add a `media_session` workspace crate seeded from playwire (its licence permits this), with a `rate: f64` field added. Backends:
  - **Windows:** `SystemMediaTransportControls` through `ISystemMediaTransportControlsInterop::GetForWindow(hwnd)`, with `SetPlaybackRate` and `PlaybackRateChangeRequested`. Already compiled in `smtc_native.rs`.
  - **macOS:** objc2-media-player 0.3.2 with features `MPNowPlayingInfoCenter`, `MPRemoteCommandCenter`, `MPRemoteCommand`, `MPRemoteCommandEvent`, `MPMediaItem` and `block2`. Set `playbackState` and `MPNowPlayingInfoPropertyPlaybackRate` to the real speed.
  - **Linux:** mpris-server 0.10.0 with `MinimumRate 0.5` and `MaximumRate 2.0`. Its `Player` is built on `Rc` (not `Send`), so run it on a dedicated thread with a local executor and talk to it over async-channel.
- **Windows app name in the media flyout.**
  - Tauri's NSIS installer (`SetLnkAppUserModelId`) and MSI (`System.AppUserModel.ID`) stamp the shortcut's AUMID with the bundle identifier.
  - Tauri, tao and wry never call `SetCurrentProcessExplicitAppUserModelID`, so call it at startup with the same identifier (sketch included). Otherwise the flyout can show "Unknown app".
- **Keep the main window alive** when closing to the tray: hide it instead of destroying it, so SMTC keeps its HWND.

## 6. Build dependencies, entitlements, licences
- **Linux build packages:**
  - `libasound2-dev` and `pkg-config`: the alsa-sys build.rs probes `alsa` and says to install libasound2-dev. cpal always links ALSA.
  - Optional cpal `pipewire` feature: `libpipewire-0.3-dev` and `libclang-dev`, because pipewire-sys and libspa-sys use bindgen ^0.72.
  - The souvlaki default backend needs `libdbus-1-dev`; zbus does not.
  - signalsmith-stretch needs `clang`/`libclang-dev` and `g++`.
  - Add `libasound2` (or `libasound2t64`) to `bundle.linux.deb.depends`.
- **Windows CI:** LLVM for bindgen (`LIBCLANG_PATH`). Not tested here because libclang is not installed on this machine.
- **macOS entitlements (from general knowledge, not confirmed):**
  - Audio output needs none; `com.apple.security.device.audio-input` covers microphone input only.
  - A sandboxed (App Store) build needs `com.apple.security.network.client` for downloads.
  - Now Playing needs an NSApplication run loop, which Tauri provides, and should be initialised in `setup` on the main thread.
- **Licences:** symphonia and mpris-server are MPL-2.0 (copyleft at file level only; fine if those files are unmodified). Everything else in the stack is MIT, Apache-2.0 or Zlib.

## Key code (verified to compile; full files in `sketches/`)
```rust
// tauri setup (Windows): souvlaki
let hwnd = Some(app.get_webview_window("main").ok_or("no main")?.hwnd()?.0 as *mut std::ffi::c_void);
let mut c = souvlaki::MediaControls::new(souvlaki::PlatformConfig{ display_name:"Quran Desktop", dbus_name:"quran_desktop", hwnd })?;
// own SMTC (windows 0.62.2)
let i = windows::core::factory::<SystemMediaTransportControls, ISystemMediaTransportControlsInterop>()?;
let smtc: SystemMediaTransportControls = unsafe { i.GetForWindow(win.hwnd()?)? };
smtc.SetPlaybackRate(1.25)?;
// cpal 0.18.2 callback latency
let ts = info.timestamp(); let lat = ts.playback.checked_duration_since(ts.callback);
```

## Facts
- [V] Latest stable versions as of 2026-10-10: tauri 2.12.2, cpal 0.18.2, symphonia 0.6.1, rodio 0.22.2, kira 0.12.5, awedio 0.8.0, stream-download 0.24.4, rtrb 0.4.0, rubato 5.0.1, signalsmith-stretch 0.1.3, souvlaki 0.8.3, playwire 2.0.0, mpris-server 0.10.0, objc2-media-player 0.3.2, windows 0.62.2, zbus 5.19.0, raw-window-handle 0.6.2 — curl https://crates.io/api/v1/crates/<name> (saved crate_*.json); tauri/windows JSON deleted after parsing because they were over 200 KB
- [V] rodio 0.22.2 depends on cpal ^0.17 and symphonia ^0.5.5. rodio master (Cargo.toml version still 0.22.2, unreleased) moved to cpal 0.18 but keeps symphonia 0.5.5 and rubato 3.0 — https://crates.io/api/v1/crates/rodio/0.22.2/dependencies (deps_rodio_0.22.2.json); raw.githubusercontent.com/RustAudio/rodio/master/Cargo.toml; cargo tree resolved cpal v0.17.3 + symphonia 0.5.5 via rodio
- [V] rodio 0.22 renamed OutputStream->MixerDeviceSink, OutputStreamBuilder->DeviceSinkBuilder, Sink->Player, open_default_stream->open_default_sink. In 0.22.2 the builder method is still DeviceSinkBuilder::open_stream, even though UPGRADE.md says open_mixer — rodio_0.22.2_UPGRADE.md and rodio_0.22.2_src_stream.rs (line 380 `pub fn open_stream`) from raw.githubusercontent.com/RustAudio/rodio/v0.22.2; rodio_variant.rs compiled
- [V] rodio Player::set_speed changes pitch (it raises the sample rate). get_pos is per-source and reports wall time under speed != 1. try_seek only seeks within the current source. The default output buffer is about 50 ms (nearest power of two to sample_rate/20) — rodio_0.22.2_src_player.rs, rodio_0.22.2_src_source_speed.rs, rodio_0.22.2_src_source_position.rs, rodio_0.22.2_src_stream.rs lines 196-216
- [V] rodio DecoderBuilder has with_gapless (default true), with_byte_len, with_seekable, with_coarse_seek, with_hint, with_mime_type. EmptyCallback::new(Box<dyn Send + Fn()>) exists for marking per-source boundaries — rodio_0.22.2_src_decoder_builder.rs, rodio_0.22.2_src_source_empty_callback.rs; sketches/src/rodio_variant.rs passes cargo check
- [V] symphonia 0.6.1 default features are opt-simd, all-meta, adpcm, flac, mkv, ogg, pcm, vorbis, wav. MP3 is NOT a default feature and must be enabled with features=["mp3"] — crate_symphonia.json, versions[0.6.1].features
- [V] symphonia 0.6 removed FormatOptions.enable_gapless. FormatOptions is #[non_exhaustive] with fields prebuild_seek_index, seek_index_fill_period_ms (default 1000) and external_data. Gapless trimming is automatic through Packet.trim_start/trim_end, and the MP3 demuxer reads the LAME enc_delay/enc_padding — ~/.cargo/registry/src/.../symphonia-core-0.6.1/src/formats/mod.rs:124, packet.rs; symphonia-bundle-mp3-0.6.1/src/demuxer.rs:431-435 and decoder.rs:131; a struct-literal construction failed to compile with E0639
- [V] symphonia 0.6 seeking: FormatReader::seek(SeekMode::{Coarse,Accurate}, SeekTo::Time{time, track_id: Option<u32>}) returns SeekedTo{track_id, required_ts, actual_ts}. Accurate mode always lands at or before the requested position — symphonia-core-0.6.1/src/formats/mod.rs lines 75-120; used in sketches/src/engine.rs which compiles
- [V] cpal 0.18.2: build_output_stream takes StreamConfig by value plus timeout: Option<Duration>. Streams no longer auto-start, so play() is required. OutputCallbackInfo.timestamp() gives {callback, playback} StreamInstant values with checked_duration_since — cpal-0.18.2/src/traits.rs:318-330, timestamp.rs:56-101; cpal_CHANGELOG.md 0.18.0; sketches compile
- [V] cpal 0.18.0 added a PipeWire host (feature pipewire) and a PulseAudio host (feature pulseaudio, the pure-Rust pulseaudio 0.3.1 crate). Linux/BSD default host priority is PipeWire > PulseAudio > ALSA. The ALSA backend (alsa ^0.11 -> alsa-sys) is always compiled on Linux — cpal_CHANGELOG.md; deps_cpal_0.18.2.json; crates.io pulseaudio 0.3.1 description 'A native rust implementation of the PulseAudio protocol'
- [V] cpal 0.18: on WASAPI, default output streams follow a change of system default device. WASAPI timestamps include hardware latency. 0.18.2 accepts output formats the WASAPI resampler can convert. CoreAudio reports DeviceChanged and StreamInvalidated on sample-rate change — cpal_CHANGELOG.md sections [0.18.0] and [0.18.2]
- [V] cpal 0.18.2 Stream is asserted Send + Sync for the WASAPI, CoreAudio and ALSA hosts (and AAudio, JACK, ASIO, WebAudio). The new PipeWire/PulseAudio host files have no such assertion — grep assert_stream_send in cpal-0.18.2/src/host/*
- [V] On this machine cpal 0.18.2 opened WASAPI default output at 48000 Hz, 2 channels, F32 with 480-frame callbacks (max 1056), and reported playback-callback latency up to 44.8 ms — cargo run --bin latency (sketches/src/bin/latency.rs); output saved in cpal_wasapi_latency_probe_output.txt
- [V] The full custom-engine sketch (cpal 0.18.2 + symphonia 0.6.1 + rtrb 0.4.0 + crossbeam-channel 0.5.17), the stream-download cache provider, souvlaki + Tauri wiring, the native SMTC backend (windows 0.62.2) and the Tauri ipc::Channel ticker all pass cargo check on Windows with tauri 2.12.2 — cargo check in the scratchpad ac crate: 'Finished dev profile'; copies in research/rust-audio-media/sketches/
- [V] Tauri 2.12.2 resolves to windows 0.62.2, wry 0.57.0, tao 0.37.1 and webview2-com 0.39.1. souvlaki 0.8.3 adds a duplicate windows v0.44.0 — cargo tree -e normal on the check crate (cpal_wasapi_latency_probe_output.txt notes)
- [V] Tauri 2.12.2 API: WebviewWindow::hwnd() -> crate::Result<HWND> (cfg windows, windows 0.62), ns_window() -> Result<*mut c_void> (macOS), gtk_window() (Linux). Also PathResolver::app_cache_dir/app_data_dir and register_asynchronous_uri_scheme_protocol — ~/.cargo/registry/src/.../tauri-2.12.2/src/webview/webview_window.rs:1954-1980; tauri Cargo.toml windows = 0.62; path/desktop.rs:251-278
- [V] Tauri config backgroundThrottling (disabled|suspend|throttle) is unsupported on Linux, Windows and Android; it is supported on macOS 14+ and iOS 17+. The schema text says browsers throttle timers and may unload the view after about 5 minutes when minimised or hidden — https://schema.tauri.app/config/2 (excerpt saved in tauri_backgroundThrottling_schema_excerpt.json)
- [V] Tauri issue #5250 (no background-throttling control) is still open. Maintainers say WebView2 lacks the API ('Don't wait for this feature'), and timers are throttled on Windows even when the window is only minimised — WebFetch https://github.com/tauri-apps/tauri/issues/5250
- [V] Tauri docs: 'The event system is not designed for low latency or high throughput situations'; channels 'are designed to be fast and deliver ordered data' — WebFetch https://v2.tauri.app/develop/calling-frontend/
- [V] The Tauri AppImage option bundleMediaFramework 'Include[s] additional gstreamer dependencies needed for audio and video playback', adding about 15-35 MB — https://schema.tauri.app/config/2 AppImageConfig.bundleMediaFramework
- [V] HTMLMediaElement timeupdate fires at roughly 4 Hz to 66 Hz depending on system load. preservesPitch defaults to true and is Baseline widely available — WebFetch MDN timeupdate_event and preservesPitch pages
- [?] Whether WebView2, WebKitGTK and WKWebView route OS media keys to navigator.mediaSession is not established — WebSearch found no WebView2-specific documentation
- [V] Tauri's NSIS installer sets each shortcut's AppUserModelID to BUNDLEID (the bundle identifier), and the MSI sets System.AppUserModel.ID={{bundle_id}}. Tauri, tao and wry do not call SetCurrentProcessExplicitAppUserModelID — raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi lines 949-977 and utils.nsh:78-89; msi/main.wxs:205; grep of tauri-2.12.2/tao-0.37.1/wry-0.57.0 sources
- [V] souvlaki 0.8.3 (2025-06-24) is the latest release. Master has later commits (last 2026-08-25) that move to windows 0.62, zbus 5.15 and pollster 1, but they are unreleased. Released 0.8.3 depends on windows ^0.44, cocoa/objc 0.2, zbus ^3.9 (use_zbus) or dbus 0.9 (use_dbus, the default) — crates.io souvlaki JSON; api.github.com/repos/Sinono3/souvlaki/commits; souvlaki_master_Cargo.toml; deps_souvlaki_0.8.3.json
- [V] souvlaki gaps: MPRIS (zbus) hardcodes rate, minimum_rate and maximum_rate to 1.0 and mpris:trackid to '/'. macOS reads the private _positionTime ivar and never sets a playback rate. Windows always enables Next/Previous. PlatformConfig{display_name, dbus_name, hwnd: Option<*mut c_void>} — souvlaki_mpris_zbus.rs lines 274-352, souvlaki_macos_mod.rs line 260, souvlaki_windows_mod.rs lines 74-90, souvlaki_config.rs
- [V] playwire 2.0.0 is 1,849 lines of Rust across Linux (zbus 5.19), Windows (windows 0.62.2) and macOS (objc2-media-player 0.3.2). It sets MPNowPlayingInfoPropertyPlaybackRate, but only to 1.0 or 0.0. PlayerConfig::hwnd(u64); app_media_id(); desktop_entry() — ~/.cargo/registry/src/.../playwire-2.0.0/src (wc -l; platform/macos.rs:227-231; config.rs); playwire_README.md; deps_playwire_2.0.0.json
- [V] mpris-server 0.10.0 depends on zbus ^5.14 (optional tokio feature). Its ready-made Player wraps Rc<LocalServer> (not Send), with connect_set_rate, set_rate, set_minimum_rate, set_maximum_rate and seeked. docs.rs failed to build 0.10.0 — mpris-server_player.rs (raw GitHub main) lines 24-30, 598-742; deps_mpris-server_0.10.0.json; docsrs_mpris_player.html
- [V] objc2-media-player 0.3.2 has features MPNowPlayingInfoCenter, MPRemoteCommandCenter, MPRemoteCommand, MPRemoteCommandEvent, MPMediaItem, MPNowPlayingSession and block2 — crate_objc2-media-player.json versions[0.3.2].features
- [V] stream-download 0.24.4: StreamDownload::new_http(Url, P: StorageProvider, Settings<HttpStream<Client>>) is async and implements Read + Seek. Settings has prefetch_bytes, on_progress (StreamState{phase: Prefetching|Downloading|Complete}) and cancel_on_drop. Storage backends are temp, memory, bounded and adaptive; there is no persistent-file backend, but StorageProvider is easy to implement. After the end it back-fills missing ranges before Complete — ~/.cargo/registry/src/.../stream-download-0.24.4/src/lib.rs, settings.rs, storage/mod.rs, source/mod.rs:331-341; cache_stream.rs compiles
- [V] signalsmith-stretch 0.1.3 (MIT) builds vendored Signalsmith Stretch C++ with cc (C++14) and generates bindings with bindgen ^0.70, so libclang is required at build. API: Stretch::preset_default/preset_cheaper(ch, rate), process(in, out) (length ratio = stretch), seek(input, playback_rate), reset, input_latency, output_latency, set_transpose_factor, flush. Upstream Signalsmith-Audio/signalsmith-stretch is MIT, 564 stars, pushed 2026-09-25 — signalsmith-stretch-rs_build.rs; registry src signalsmith-stretch-0.1.3/src/lib.rs; api.github.com/repos/Signalsmith-Audio/signalsmith-stretch
- [?] signalsmith-stretch 0.1.3 compiles on Windows, macOS and Linux CI once LLVM/libclang is installed — Not tested: libclang is not installed on this machine, so the crate was fetched but not built
- [V] rubato 5.0.1 offers Fft (FixedSync::Input/Output/Both) for fixed ratios like 44.1->48 kHz, Async::new_sinc/new_poly for variable ratios, and Slip for drift. Input and output go through audioadapter 5 adapters (audioadapter_buffers::direct::InterleavedSlice) — rubato-5.0.1/README.md and examples/process_raw.rs in the cargo registry
- [V] kira 0.12.5 streaming sounds support from_media_source, position(), seek_to/seek_by, set_loop_region (built-in A-B) and playback_rate. It updated to symphonia 0.6 and cpal 0.18.1 in 0.12.2. Clocks are not sample-accurate (128-frame chunks) — kira-0.12.5/src/sound/streaming/{data.rs,handle.rs}; kira_changelog.md
- [V] The alsa-sys build.rs uses pkg-config to probe 'alsa' and fails with a message to install libasound2-dev (Debian/Ubuntu) or alsa-lib-devel (Fedora). libdbus-sys 0.2.7 needs pkg-config by default (a vendored feature exists). pipewire-sys and libspa-sys 0.10.1 use bindgen ^0.72 and system-deps — raw.githubusercontent.com/diwic/alsa-sys/master/build.rs; crates.io dependencies for libdbus-sys 0.2.7, pipewire-sys 0.10.1, libspa-sys 0.10.1
- [?] Audio output on macOS needs no entitlement (com.apple.security.device.audio-input is microphone-only). A sandboxed App Store build needs com.apple.security.network.client for downloads — The Apple entitlement page loaded only its title in WebFetch; this is general knowledge
- [V] souvlaki on macOS sets MPNowPlayingInfoCenter playbackState (Playing=1, Paused=2, Stopped=3) — souvlaki_macos_mod.rs lines 78-103
- [V] ssstretch's GitHub repository (bmisiak/ssstretch) returns 404 — curl raw README returned 404; GitHub API returned undefined

## Recommendations
- Play audio natively in Rust. Do not use HTML5 <audio> or Web Audio for recitation: Tauri cannot turn off webview background throttling on Windows or Linux, and repeat/A-B/memorization logic must keep running while the window is minimised or in the tray.
- Build a custom engine with cpal =0.18.2, symphonia =0.6.1 (default-features=false, features=["mp3","opt-simd"]; add aac/isomp4 only if needed), rtrb =0.4.0, rubato =5.0.1, crossbeam-channel 0.5.17 and signalsmith-stretch =0.1.3. Start from sketches/src/engine.rs: decode thread, lock-free ring buffer, cpal callback, and in-band markers for ayah, repeat and A-B boundaries.
- Model playback as a list of Segment{surah, ayah, file, start_ms, end_ms}. Prefer surah-level MP3s with ayah timings: one decoder means truly gapless playback, and ayah boundaries become markers only. Use per-ayah files as a fallback, opening the next file ahead of time.
- Do not adopt rodio 0.22.2. It pulls cpal 0.17 and symphonia 0.5.5, its speed changes pitch, get_pos resets per source and reports wall time under speed changes, and decoding runs on the audio thread (a blocking network read would cause dropouts). Keep kira 0.12.5 as the fallback engine if the custom engine slips.
- Speed 0.5x-2x: bypass the stretcher at exactly 1.0. Otherwise run signalsmith_stretch::Stretch::preset_default(ch, rate) in the decode thread with out_len = round(in_len / speed). On seek, call reset() then seek(preroll, speed). Carry media_ns_per_frame in markers so highlighting stays exact. Put it behind a Stretcher trait with a pure-Rust WSOLA fallback (`wsola` 0.1.0 or rodio-wsola 0.2.0) in case libclang is unavailable.
- Open the output device at its default config and resample in the decode thread with rubato::Fft (FixedSync::Input). Do not request 44.1 kHz from CoreAudio; cpal 0.18 changes the hardware format directly. In cpal's error callback, rebuild only the output stream on DeviceChanged, DeviceNotAvailable or StreamInvalidated.
- Streaming: use stream-download =0.24.4 (default-features=false, features=["reqwest-rustls"]) with the CacheFileProvider from cache_stream.rs, writing <app_cache_dir>/audio/<reciter>/<sss>.mp3.part and renaming it on StreamPhase::Complete. Never read from it on the audio callback. Per-ayah files are small enough for plain reqwest download plus prefetch of the next N ayahs.
- Send position to the UI over tauri::ipc::Channel at about 30 Hz, interpolate in the UI with requestAnimationFrame, and emit a discrete 'audio://ayah-changed' event when the marker flips. Update OS media controls only on ayah, play/pause or seek changes, not every tick.
- OS media controls: create a workspace crate `media_session`, seeded by vendoring playwire 2.0.0 (MIT OR Apache-2.0, about 1.8k lines, same windows/objc2/zbus versions as Tauri). Add a real `rate` field: SMTC SetPlaybackRate plus PlaybackRateChangeRequested (see smtc_native.rs); MPNowPlayingInfoPropertyPlaybackRate = speed while playing; MPRIS Rate with Min 0.5 and Max 2.0. Map Next/Previous to next/previous ayah. If time is short, use souvlaki 0.8.3 (it works with `win.hwnd()?.0 as *mut c_void`), ideally as a git dependency pinned to master 93ff3d1 to avoid windows 0.44 and libdbus.
- Windows: call SetCurrentProcessExplicitAppUserModelID(<tauri identifier>) at startup so the media flyout shows the app name and icon; Tauri's installers already stamp the shortcut AUMID with the identifier. Hide the main window on close-to-tray instead of destroying it, so the SMTC HWND stays valid.
- Linux: enable cpal's `pulseaudio` feature (pure Rust; works on PipeWire through pipewire-pulse) and skip `pipewire` (it needs libpipewire-0.3-dev and libclang). CI packages: libasound2-dev, pkg-config, clang/libclang-dev and g++ (for signalsmith). Add libasound2 / libasound2t64 to bundle.linux.deb.depends. Use the zbus-based MPRIS backend so libdbus-1-dev is not needed.
- Set workspace rust-version = "1.91" because stream-download 0.24.4 requires it; the local toolchain is 1.99.0. Note that cpal master renames StreamTrait::play to start (deprecated), which matters for the next cpal upgrade.
- macOS: no audio entitlement is needed for playback. If the app is sandboxed for the App Store, add com.apple.security.network.client. Initialise media controls in Tauri's setup closure on the main thread.

## Risks
- The custom engine is more code than rodio or kira, roughly 1.5-2.5k lines with stretch, resampling and device-change handling. It has not been tested beyond cargo check plus a silent cpal probe on Windows; it has not played real recitation audio on macOS or Linux.
- signalsmith-stretch 0.1.3 needs libclang (bindgen) and a C++14 compiler on every OS and was not compiled here. The crate has had no release since 2025-09-18, although upstream C++ is active. Mitigate with the pure-Rust WSOLA fallback behind a trait.
- Whether cpal's PulseAudio and PipeWire host Streams are Send/Sync was not verified, because those host files carry no assert_stream_send. If they are not, putting Engine (which owns cpal::Stream) into Tauri state will fail to compile on Linux. Mitigation: create and own the stream on a dedicated audio thread.
- Per-ayah MP3s without LAME/Xing headers keep encoder/decoder delay, so small gaps remain between ayahs. Prefer surah files with timings, or trim leading and trailing silence or apply a short crossfade.
- playwire 2.0.0 is 4 days old with 0 stars and one author. Vendoring it means we maintain it. souvlaki's maintenance is slow (no release for about 15 months) and its released version lacks rate support.
- mpris-server 0.10.0 failed to build on docs.rs (documentation only, but API docs must be read from source). Its Player is not Send and needs its own thread and executor.
- symphonia and mpris-server are MPL-2.0. Modified copies of those files must be published; using them unmodified is fine.
- WebView2, WebKitGTK and WKWebView handling of media keys was not verified. If a webview also claims SMTC or MPRIS, keys could be handled twice, so test media keys with the webview present.
- The SMTC HWND must stay alive. Destroying the main window on close-to-tray would break Windows media controls, so hide the window instead (whether SMTC works with a hidden window is unverified).
- On Windows, the Rust compile check needed rust-lld because MSVC link.exe fails on paths longer than 260 characters in the scratchpad. This does not affect the real project path C:\Users\fouad\RustroverProjects\quran-desktop.

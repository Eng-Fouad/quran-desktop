# WP6c deviations (media-session: model, Windows SMTC, noop; media glue)

## Runtime check (first task, §2.4) — outcome

`cargo run -p media-session --example smtc_check` on the dev machine (Windows 11 Pro 10.0.26200, windows 0.62.2):

- **`ISystemMediaTransportControlsInterop::GetForWindow` works on the MTA backend thread for a window owned by an STA
  thread, while that owner thread is blocked** (not pumping messages), which is exactly how `media::init` runs inside
  tauri's setup closure. Measured 7.6–85 ms for the backend to start (85 ms cold). The window was hidden and never
  shown (the app's main window is still hidden at setup time). A first raw probe compared a blocked owner thread with
  a pumping one: both succeed, so `GetForWindow` does not need the owner's message loop.
- **Confirmed in the real app**: the tauri-built debug exe (`pnpm tauri build --debug --no-bundle`, then
  `node scripts/qa/app-driver.mjs --shot wp6c-startup --exe C:\qdt\WP6c\debug\quran-desktop.exe --verbose`) logs
  ``media session `Quran Desktop` started (Smtc backend)`` from `setup::after_manage` on tao's main window, with no
  panic and a passing screenshot.
- Therefore **the `run_on_main_thread` fallback is not implemented**: the controls are obtained and owned by the
  `qd-media` thread, and `dispatch` is ignored on Windows (it stays required on macOS for WP6d).
- The check then verifies the session **from the outside**, through the system's
  `GlobalSystemMediaTransportControlsSessionManager` (what the media flyout and the lock screen read): it is listed
  with source app `com.qurandesktop.app` (the process AUMID), title/artist/album and the thumbnail bytes match, status,
  rate, buttons and timeline match, every command sent through the system (play, pause, toggle, stop, next, previous,
  rate, seek) arrives at `on_command` exactly once, and `Stopped` removes the session from the system list. It never
  plays audio: Paused/Playing are status flags only (LEAD item 9).
- Observed system behaviour worth knowing: the flyout offers **Play while Paused and Pause while Playing** regardless of
  `IsPauseEnabled`/`IsPlayEnabled` (the system's `Controls()` reports the other one disabled), and a toggle request
  arrives as `Play` or `Pause` according to the current status (never as `Toggle`). `IsPlaybackRateEnabled` and
  `IsPlaybackPositionEnabled` become true because the backend registers those handlers (and a seek range is set).

## Deviations from ARCHITECTURE.md

1. **`MediaSession::new` falls back internally.** When the platform backend cannot start (Windows: no HWND, COM or SMTC
   failure, or no answer within 5 s; macOS/Linux until WP6d), it logs the reason and returns `Ok` with a session on the
   no-op backend, as §2.4 "Fallback" describes. Its only error is an unusable config. Additive public API in
   `media-session` (lib.rs is WP6c's): `MediaSession::kind() -> BackendKind` (`Smtc`, `NowPlaying`, `Mpris`, `Noop`),
   `SessionConfig::validate()` (non-empty `app_id`/`display_name`/`desktop_entry`, `desktop_entry` without
   `.desktop`, `dbus_name` a valid D-Bus bus-name suffix), `PlaybackState::{is_active, effective_rate}`,
   `MediaSessionError::InvalidConfig(String)` (new variant), `impl Debug for MediaSession`.
2. **`media::init` returns `None` for a no-op session** (it shuts it down): `state.media` then stays empty, as for a
   failed init, and `on_audio_state` costs nothing.
3. **Backend contract for WP6d** (`lib.rs`, crate-private): `trait Backend: Send + Sync { set_metadata(&self, Metadata);
   set_state(&self, PlaybackState); shutdown(self: Box<Self>) }` with the rules in its doc comment (non-blocking, never
   failing, hide on `Stopped`, drop = shutdown without waiting). `start_platform` answers `Unsupported` on macOS and
   Linux, because `macos.rs`/`linux.rs` are WP6d's placeholders and calling into them would break the macOS/Linux
   build until WP6d lands. Helpers for every backend: `model::rate_command(f64) -> Option<MediaCommand>` (drops NaN,
   ±∞, ≤ 0) and `MediaSessionError::platform(call, err)`.
4. **Session visibility (Windows).** The controls start **disabled** and are enabled on the first Playing/Paused state;
   `Status::Stopped` (engine idle, or nothing loaded) disables them again, so "Quran Desktop" appears in the media
   flyout only while a recitation is loaded. Fast-forward, rewind, record and channel buttons stay disabled. Next and
   previous follow `can_next`/`can_previous`; the seek range is `[0, duration]` only when `can_seek`.
5. **Artwork.** The fallback artwork (§9.9) is the bundled 256 px icon `src-tauri/icons/128x128@2x.png` (always in
   `bundle.icon`), embedded with `include_bytes!` and written once to **`<data>/media-artwork.png`** (temp file +
   rename; rewritten only when the bytes differ), because every backend takes a file path. Add it to the §2.8.3 tree.
   On Windows the file is read into an `InMemoryRandomAccessStream` thumbnail (≤ 4 MiB), so the shell never needs
   file access and no `Windows.Storage` feature is needed.
6. **Mapping details (`media.rs`)**, beyond §2.4:
   - Title during the basmala (`ayah = 0`) is the surah name alone; without core data (degraded debug build) the
     title is the reference alone. Arabic references use Arabic-Indic digits (`البقرة ٢:٢٥٥`, §11.2). A reciter name
     falls back to the other language when the UI language's variant is empty.
   - Engine status → OS: Playing/Loading/Buffering → Playing; Paused/Error (with an ayah loaded) → Paused; Idle or no
     current ayah → Stopped. Rate = `speed_pct / 100`. `can_next` = not the last ayah of the range, or range repeats
     left / infinite; `can_previous` always (restart or previous ayah); `can_seek` = known file duration.
   - Edges only: metadata on any change of title/reciter/album/duration/artwork; the state on a status, rate or
     capability change, after every metadata change, and on a seek (position > 1 s away from the position
     extrapolated at the sent rate). Stop hides once and forgets the metadata, so the next play re-sends it.
7. **`media.rs` hooks are generic over the tauri `Runtime`** (`init`, `on_audio_state`, plus the new helpers), like
   WP0B's glue constructors: callers passing `&tauri::AppHandle` compile unchanged.
8. **New `media.rs` helpers** (for the tray and the settings hook): `now_playing(app, &AudioSnapshot) ->
   Option<NowPlaying { title, reciter }>` (the localised labels; `title` is also the tray's `{ref}`) and
   `on_ui_language_changed(app, UiLanguage)` (re-sends the metadata in the new language, §11.4). `on_audio_state`
   derives `title`/`reciter` itself when the caller passes an empty string. The UI language is read once from
   `settings_load` (falling back to the OS locale) and then kept current by `on_ui_language_changed`.
9. **Dev-dependency features.** `crates/media-session/Cargo.toml` enables `Win32_UI_WindowsAndMessaging` and
   `Media_Control` on the existing `windows` crate for the example and the test only (no new crate, Cargo.lock
   unchanged).
10. **Tests.** `tests/windows_smtc.rs` runs the same end-to-end check as the example (shared `tests/support/smtc.rs`);
    on a CI runner (`CI` set) where SMTC cannot start it reports a skip instead of failing, a developer machine must
    pass it. `media.rs` has 9 unit tests (`cargo test -p quran-desktop --lib media`): titles in both languages and
    digits, basmala titles, status mapping, capabilities, the edge-only update sequence, language re-send, position
    extrapolation, artwork materialisation. `cargo clippy -p media-session --all-targets -- -D warnings` is also clean
    for `--target x86_64-unknown-linux-gnu` and `--target aarch64-apple-darwin` (the no-op path WP6d starts from).

## Requests

- **WP6a (setup sink, LEAD item 3):** in the `AudioService` UI sink, on ayah/state edges call
  `let np = media::now_playing(app, &snapshot);` then
  `media::on_audio_state(app, &snapshot, np.as_ref().map_or("", |n| &n.title), np.as_ref().map_or("", |n| &n.reciter))`
  and `tray::set_now_playing(app, np.map(|n| i18n::text(lang, RustText::TrayNowPlaying).replace("{ref}", &n.title)), playing)`
  (passing `""` for both labels is also fine: `on_audio_state` derives them). `media::init` must keep running after
  `app.manage(AppState)` (it already does in `after_manage`).
- **WP6b (`window::apply_settings`):** when `prev.ui_language != next.ui_language`, call
  `crate::media::on_ui_language_changed(app, next.ui_language)` (§11.4 "re-send the media metadata").
- **WP6d (macOS/Linux backends):** implement `pub(crate) fn start(cfg: &SessionConfig, dispatch:
  Option<MainThreadDispatch>, on_command: CommandHandler) -> Result<impl Backend, MediaSessionError>` in
  `macos.rs`/`linux.rs` following the `Backend` contract in `lib.rs`, and use `model::rate_command` for rate requests.
  Plugging them in is a two-line change in `lib.rs::start_platform` (the `not(windows)` arm → `macos::start` /
  `linux::start` returning `BackendKind::NowPlaying` / `BackendKind::Mpris`); WP6c hands exactly that function over
  to WP6d for this edit. Also pin `DESKTOP_ENTRY` in `src-tauri/src/media.rs` (WP6c hands that constant over too).
  Status `Stopped` must hide the session (macOS: `playbackState = Stopped` + empty `nowPlayingInfo`; MPRIS:
  `PlaybackStatus = Stopped`).
- **Lead:** fold deviations 1, 4, 5 and the runtime-check outcome into §2.4/§2.8.3; `docs/research` R5's "SMTC sketch
  was never run" is resolved.

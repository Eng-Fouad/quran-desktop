# WP6d deviations (media-session: macOS Now Playing and Linux MPRIS backends)

Owned: `crates/media-session/src/{macos, linux}.rs`. Handed over by WP6c and edited only where handed over:
`crates/media-session/src/lib.rs` → `start_platform` (the Linux and macOS arms), and `src-tauri/src/media.rs` →
`DESKTOP_ENTRY`.

## The .deb's desktop-file name (§13.5, §2.4)

**`Quran Desktop.desktop`**, so `DESKTOP_ENTRY = "Quran Desktop"` (pinned in `src-tauri/src/media.rs`).

- Source: the tauri bundler of the pinned CLI (`@tauri-apps/cli` 2.12.1, tag `tauri-cli-v2.12.1`),
  `crates/tauri-bundler/src/bundle/linux/freedesktop/mod.rs` → `generate_desktop_file`:
  `let desktop_file_name = format!("{product_name}.desktop");` installed at `usr/share/applications/`. The deb
  bundler (`linux/debian.rs`) calls it for the package data. The AppImage bundler (`linux/appimage/linuxdeploy.rs`)
  builds its AppDir from the same deb data and links `usr/share/applications/{product_name}.desktop` at the AppDir
  root, so both formats ship one desktop file named after `productName` ("Quran Desktop", `tauri.conf.json`). Its
  `Icon=` and `Exec=` are the binary name (`quran-desktop`); GNOME and KDE resolve the player's name and icon through
  the desktop file, so `DesktopEntry` must be the file's basename, spaces included.
  `SessionConfig::validate` accepts it (non-empty, no `.desktop`).
  The deb's `Package:` field is the kebab-cased product name (`quran-desktop`, `debian.rs` `generate_control_file`),
  but nothing renames the desktop file. Both source files were read again at the tag on 2026-10-10 (second pass).
- **Substitution.** This dev machine is Windows and cannot build a .deb: the Linux CLI binary and the GTK/WebKit dev
  packages are not installed, and installing them is out of bounds. That was checked again in WSL: `pkg-config` finds
  no `webkit2gtk-4.1`, `gtk+-3.0` or `libsoup-3.0`, and no Linux `tauri` CLI is present. The name comes from the
  bundler source of the exact pinned version, not from a built package. The Ubuntu runner can confirm it with one line
  (Request below).
- An AppImage run without desktop integration installs no desktop file. Integration tools such as AppImageLauncher
  rename the file they install. In both cases GNOME and KDE show the player under its `Identity` ("Quran Desktop")
  with a generic icon. This is inherent to AppImage, and the .deb is unaffected.

## Acceptance substitution (the macOS and Ubuntu runners are not available here)

- **Linux: real runs, native Ubuntu 24.04 (WSL2) on this machine, against real D-Bus session buses.**
  `cargo clippy -p media-session --all-targets --locked -- -D warnings` and `cargo test -p media-session --locked`
  pass natively. The live tests exercise the backend against the WSLg session bus. They pass again with no session
  bus at all (they skip and the session falls back to no-op), and under `dbus-run-session` (a private bus, which is
  how a headless CI runner would get one). They passed 20 repeated runs with no flake. All of these were run again
  in the second pass on 2026-10-10 against the current tree, with the same results.
  - Setup: WSL's rustup installed the 1.99.0 toolchain from `rust-toolchain.toml` on first use. A scratch
    `CARGO_HOME` in WSL `/tmp` was filled from this machine's cargo cache (index and `.crate` files), and cargo ran
    `--offline --locked` with `CARGO_TARGET_DIR` in WSL `/tmp`. Nothing was downloaded and nothing in the repo
    changed.
- **macOS: cross-target type-check and full code generation of the library and its tests**, from Windows:
  - `cargo clippy -p media-session --all-targets --target aarch64-apple-darwin -- -D warnings` is clean.
  - `cargo build -p media-session --lib --target aarch64-apple-darwin` builds the rlib, in both `dev` and `--release`.
    Monomorphisation and LLVM code generation run, not just type-checking. Every `objc2`, `objc2-foundation`,
    `objc2-app-kit`, `objc2-media-player` and `block2` dependency builds without a native toolchain; none needs an
    Apple SDK before link time.
  - The unit-test harness compiles to a Mach-O arm64 object: `cargo rustc -p media-session --lib --profile test
    --target aarch64-apple-darwin -- --emit=obj` writes a 2.5 MB `media_session-*.o`. All nine `macos::tests` are in
    it, and only the final link fails (`linker cc not found`, no Xcode).
  - The platform-neutral half of `macos.rs` runs on the host. That half is the section between the
    `What Now Playing shows` and `The main-thread side` markers: the `Display` mapping, the `Remote` commands, the
    seek/rate filters and the session `claim` policy, with its five unit tests (the section of `mod tests` before
    the `The handle` marker). A script extracts both sections verbatim into a scratch host crate together with
    `model.rs`, and the run passed on Windows: 5 macOS + 5 model tests.
  - Linking and running the full macOS suite needs the macOS runner. `cargo test -p media-session` there runs the
    mapping tests, the coalescing and dispatch tests, and a live `MPNowPlayingInfoCenter`/`MPRemoteCommandCenter`
    read-back test.
- `cargo clippy -p media-session --all-targets --target x86_64-unknown-linux-gnu -- -D warnings` is also clean from
  Windows. The Windows build is unchanged: `cargo test -p media-session` gives 20 + 1 passed, and clippy is clean.

## Deviations from ARCHITECTURE.md

### Linux (MPRIS)

1. **mpris-server `Server<Mpris>` instead of its `Player` on a `LocalExecutor`.** The thread layout is unchanged.
   `qd-media` runs one future with `futures_lite::future::block_on`, and updates still arrive over `async-channel`.
   The MPRIS object is our own `Send + Sync` implementation of `RootInterface + PlayerInterface`, served on zbus's
   executor thread. It reads the published view under a mutex and calls the `CommandHandler`. Why:
   - **One** `PropertiesChanged` per update burst, carrying only what changed. `Player`'s setters emit one signal
     per property.
   - No relay channel. `LocalServer` relays every D-Bus call through a channel with `send().await.unwrap()` /
     `rx.await.unwrap()`, so a call racing the shutdown would panic on zbus's thread, which is an abort under
     `panic = "abort"`.
   - `async-executor` stays an (unused) Linux dependency, because `Cargo.toml` is frozen (Request below).
2. **Bus name and instances.** zbus 5.19's connection builder requests names **without** `DoNotQueue`, although
   its documentation says it always sets it. This was verified on a real bus: a second registration of a taken
   name succeeded silently and stayed queued and invisible. `serve` therefore checks `NameHasOwner` first. The
   player takes `org.mpris.MediaPlayer2.{dbus_name}`, or `….{dbus_name}.instance{pid}` (the MPRIS convention)
   when another connection owns it. When both are taken, start fails and the session falls back to no-op. The test
   `a_taken_name_falls_back_to_an_instance_name` covers all three cases.
   - A gap remains between the check and the request. Two players registering in the same instant could both see
     the name free, and the later one would then be queued without notice. mpris-server exposes its connection only
     behind its `unstable` feature, so the reply cannot be inspected. `tauri-plugin-single-instance` already rules
     this out for two copies of the app.
3. **`mpris:trackid`.** The model's `Metadata` has no ayah field, so `/com/qurandesktop/track/{surah}_{ayah}` is
   read from the reference that ends the title (`"Al-Baqarah 2:255"`, `"البقرة ٢:٢٥٥"`, ASCII or Arabic-Indic
   digits), which `media.rs` always writes. A language change keeps the same id. During the basmala the title is
   the surah name alone, so a per-track sequence id is used (`/com/qurandesktop/track/t{n}`, new per distinct
   title). `SetPosition` with a stale id is ignored, as MPRIS requires.
4. **Visibility.** `Status::Stopped` publishes `PlaybackStatus = Stopped`, an **empty** `Metadata`, and sets
   `CanPlay`, `CanPause`, `CanSeek`, `CanGoNext` and `CanGoPrevious` to false. GNOME Shell shows a player only while
   `CanPlay` is true. This mirrors the Windows behaviour (WP6c deviation 4). `CanControl` is always true.
5. **MPRIS details beyond §2.4:**
   - `Rate` is the real speed, clamped to `MinimumRate..=MaximumRate` (0.5..=2.0).
   - `Position` is extrapolated live, `position + elapsed × Rate` while playing, clamped to `mpris:length`.
   - `Seeked` is emitted when a state's position is more than 1 s from the extrapolated one within the same track.
     It is not emitted when playback starts or the track changes (per MPRIS).
   - Metadata: `xesam:title`, `xesam:artist` ([reciter]), `xesam:album`, `mpris:length` (surah-file duration) and
     `mpris:artUrl` (a percent-encoded `file://` URL of the artwork file).
   - Requests follow the published capabilities. A disabled one "has no effect". `PlayPause` raises
     `NotSupported` when nothing is loaded. Setting `Rate` to 0 acts as `Pause`; a NaN or negative rate is ignored.
     `Stop` while stopped is ignored.
   - `Raise` → `MediaCommand::Raise` (`CanRaise` true). `Quit` has no effect (`CanQuit` false).
   - `OpenUri`, and setting `LoopStatus`, `Shuffle` or `Volume`, answer `NotSupported`. `Fullscreen` is false.
6. **Shutdown** hides the player (one last `PropertiesChanged`), releases the bus name and joins within 1 s. A drop
   without `shutdown` closes the channel and does the same without waiting.

### macOS (Now Playing)

7. **Main-thread model.** `start` never blocks, and fails only without a dispatcher. Called on the main thread (tauri
   `setup`), it registers the remote-command handlers at once; elsewhere, registration is the first dispatched job.
   Updates are coalesced: a burst of `set_metadata`/`set_state` schedules **one** main-thread job, which applies the
   latest of each. The Objective-C side (command targets, artwork) lives in a main-thread-local `Center`. Jobs that
   ever run off the main thread are refused and logged. The newest session owns Now Playing, and an older one never
   takes it back. The pure `claim` function decides this and is unit-tested. `shutdown` on the main thread clears synchronously. Off the main thread it dispatches and waits at
   most 1 s, because the main thread may itself be waiting. Drop clears without waiting.
8. **Visibility.** The commands (play, pause, toggle, stop, next, previous, `changePlaybackPosition`,
   `changePlaybackRate`) are enabled only while a recitation is loaded:
   - next and previous follow `can_next`/`can_previous`;
   - position needs `can_seek` and a known duration.
   `Status::Stopped`, `shutdown` and drop set `playbackState = Stopped`, clear `nowPlayingInfo` and disable every
   command. `playbackState` is set on every update.
9. **Extra `nowPlayingInfo` keys:**
   - `MPNowPlayingInfoPropertyDefaultPlaybackRate` = 1.0 and `MPNowPlayingInfoPropertyMediaType` = audio (both
     macOS 10.12.2+).
   - **Artwork**: the §9.9 fallback artwork file goes in as an `MPMediaItemArtwork`, loaded once per path. §2.4
     listed no artwork for macOS. The `NSImage` comes from the Objective-C runtime (`NSImage` class,
     `initWithContentsOfFile:`), and the artwork initialiser is the typed binding, with the image class inferred
     from its signature. No AppKit binding crate is needed, and no artwork is set when AppKit is absent (bare test
     binaries).
   - Supported rates: 0.5, 0.75, 1.0, 1.25, 1.5, 1.75 and 2.0. Any request goes through `model::rate_command`; the
     app rounds to 5 %.
   - A malformed position or rate event (NaN, negative, ±∞) answers `CommandFailed`.

## Requests

> Integration note (LEAD.md items 16 and 18, 2026-10-10): `productName` is now "Quran", so the desktop file is
> `Quran.desktop`, `DESKTOP_ENTRY = "Quran"` (a `media.rs` test keeps it equal to `productName`), the MPRIS `Identity` is
> "Quran" and track ids live under `/com/quran/labs/desktop/track`. Read the names below accordingly; the bus name stays
> `org.mpris.MediaPlayer2.quran_desktop`.

- **WP-CI (`ci.yml`, ubuntu job):**
  - Run the media-session tests under a private session bus, `dbus-run-session -- cargo test -p media-session`
    (`dbus-daemon` is preinstalled on ubuntu runners), so the end-to-end MPRIS test runs. Without a bus it skips.
  - After the deb bundle, assert the desktop-file name: `dpkg-deb -c target/release/bundle/deb/*.deb | grep -F
    "./usr/share/applications/Quran Desktop.desktop"`. If it ever fails, `DESKTOP_ENTRY` in `media.rs` must follow.
- **Lead (frozen `crates/media-session/Cargo.toml`, §2.1 "WP6d finalises the objc2-foundation feature list"):**
  - The macOS code needs exactly `objc2-foundation = { workspace = true, default-features = false, features =
    ["std", "NSArray", "NSDictionary", "NSGeometry", "NSObject", "NSString", "NSValue", "objc2-core-foundation"] }`.
    This was verified with a scratch copy of the crate: `cargo clippy --all-targets --target aarch64-apple-darwin
    -- -D warnings` is clean.
  - `objc2-media-player` must keep its default `block2`, `objc2-app-kit` and `objc2-core-foundation` features,
    because the artwork initialiser is gated on them.
  - `async-executor` can be dropped from the Linux dependencies (unused, see 1).
  - Folding these in changes `Cargo.lock`, so it belongs in a contract PR.
- **WP6c (lib.rs and model.rs, cosmetic):**
  - The comment in `tests::a_session_without_a_platform_backend_falls_back_to_noop` ("macOS and Linux have no
    backend before WP6d") is stale. On Linux with a session bus the session is now `Mpris`; on macOS without a
    dispatcher it is `Noop`.
  - The crate doc says the Linux backend is "a `LocalExecutor` thread". It is now the `qd-media` thread running
    one future (see 1).
  - `#[cfg_attr(not(windows), allow(dead_code))]` on `model::rate_command` can go: every backend uses it now.
    `MediaSessionError::platform` is used on Windows and Linux but not on macOS, so its attribute could become
    `cfg_attr(target_os = "macos", …)`.
  - An additive `Metadata` field naming the ayah (e.g. `track: Option<(u32, u32)>`) would let MPRIS stop parsing
    the title (3). It is optional; the parser is complete and tested.
- **WP13b (release manual checklist, §12.6):**
  - Linux: GNOME Shell and KDE show "Quran Desktop" with the app icon in the media widget while a recitation is
    loaded, and hide it after stop. `playerctl -p quran_desktop metadata` shows the trackid, title, reciter and
    album. Media keys toggle and skip.
  - macOS: Control Center's Now Playing shows title, reciter, album, artwork and a moving scrubber. Play/pause keys
    toggle (`playbackState`), and the item disappears after stop.

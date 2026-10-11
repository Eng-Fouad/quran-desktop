# WP0A deviations (Rust contract and app skeleton)

## Deviations from ARCHITECTURE.md

1. **`clippy::unreachable` vs `#[tauri::command]` (§0.2, §2.1).** tauri-macros 2.7.1 checks every async command with a
   borrowed argument (`State<'_, _>`) through a `const _` item that contains `unreachable!()`, spanned on the command's
   return type (`command/wrapper.rs`). With the crate-root `deny(clippy::unreachable)` every stateful command fails clippy
   (verified on `window_ready`). `lib.rs` therefore puts `#[allow(clippy::unreachable)]` on `pub mod commands;` only; the
   other four denials stay crate-wide and `unreachable` stays denied everywhere else (protocol, setup, glue, window).
   Consequence for WP6a: `protocol::font_bytes` reaches the state through `app: AppHandle` + `app.state::<AppState>()`
   instead of the §5.13 `state: State<'_, AppState>` parameter (the TS side never sees either).
2. **AUMID call (§2.8.1).** `run()`'s first statement is `media::set_app_user_model_id(APP_ID)` (a hook in `media.rs`,
   which WP0A creates and hands over) instead of `media_session::set_process_app_user_model_id(..)`, because the
   media-session crate is still a placeholder owned by WP0B. The hook is a no-op returning `Ok(())` until WP0B/WP6c call
   the crate (see Requests).
3. **Windows test executables need the comctl32 v6 manifest.** tauri-build links its manifest into binaries only, so
   `cargo test -p quran-desktop` died with `STATUS_ENTRYPOINT_NOT_FOUND` (0xc0000139) before running a test (the dialog
   plugin imports `TaskDialogIndirect`). On MSVC, `build.rs` now writes tauri's default manifest to `OUT_DIR`, embeds it
   for every linked target via `/MANIFEST:EMBED /MANIFESTINPUT:…`, and calls `tauri_build::try_build` with
   `WindowsAttributes::new_without_app_manifest()` (same contract as `tauri_build::build()` on error).
4. **`dist/` is not needed by plain cargo commands (§5.15).** In tauri 2.12 `generate_context!` embeds `frontendDist` only
   when `custom-protocol` is on (`tauri build`/`tauri dev`); `cargo build`/`cargo test -p quran-desktop` compile in dev
   mode with `devUrl` and never read `../dist` (tauri-codegen 2.7.1 `context.rs`). `tauri build` runs `pnpm build` first
   (`beforeBuildCommand`). No placeholder `dist/` is created. Verified on a fresh copy without `dist/` and without
   `resources/`.
5. **`build.rs` extras.** It also creates `resources/` when missing (a fresh clone has no such directory, so the §5.15
   `fs::write(..).ok()` would silently fail and tauri-build would then stop with `ResourcePathNotFound`) and emits
   `rerun-if-changed` for both placeholder files.
6. **Root `Cargo.toml`.** `[workspace.package]` keeps the scaffold's `license`, `repository` and `authors` (every crate
   inherits them) next to the spec's keys. `[profile.dev.package]` keeps the scaffold's opt-level 3 for `symphonia-core`,
   `symphonia-bundle-mp3` and `rubato` besides the spec's `"*" = 2` and `quran-audio = 3`; cargo prints "profile package
   spec … did not match any packages" for those three until WP0B adds them to quran-audio.
7. **`src-tauri/Cargo.toml`.** No `staticlib`/`cdylib` crate types (mobile-only artifacts that tripled release LTO link
   time; the binary links the rlib). Dependencies are final for the app shell: the five workspace crates, tauri + the six
   plugins, specta/specta-typescript/tauri-specta (all three direct, as verified), serde, serde_json, thiserror, log, tokio
   (setup timer, `PackManagerConfig.runtime`), parking_lot, dunce, percent-encoding, regex (protocol routes), url
   (`system_open_external`), and on Windows `windows` with `Win32_Foundation`, `Win32_Graphics_Gdi`, `Win32_UI_HiDpi`,
   `Win32_UI_Shell`, `Win32_UI_WindowsAndMessaging` for WP6b's Snap Layouts hit-testing (§9.6). Dev-dependencies: tauri
   with the `test` feature (`tauri::test::mock_app()` for WP6a's setup/protocol tests) and tempfile.
8. **quran-types helpers beyond §2.6** (small and pure): `AYAH_COUNT`, `WORD_COUNT`, `SURAH_COUNT`, `PAGE_COUNT`,
   `JUZ_COUNT`; `MushafLayout::ALL`, `MushafStyle::ALL`; `Platform::current()`; `AppError::kind()`/`message()`;
   `UiLanguage::from_os_locale()` (primary subtag `ar` ⇒ Arabic, so `arn` is not Arabic); `GapSetting::clamped()`; and the
   `limits` module (`Bounds { min, max, step }` + one constant per numeric setting, reusable by `audio_set_speed` & co).
   DTOs also derive `Eq` everywhere (no floats exist) and `Copy`/`Hash` where cheap.
9. **`Settings::validated()` details.** Ranges without a documented step (`translationFontPct`, pane/sidebar widths, ink,
   volume, repeats, gap, cache cap) are clamped only; stepped values round to the nearest step (ties up). Beyond the spec
   it also dedupes `hintsSeen`, drops blank ids from `translations`/`hintsSeen`, turns blank `wbwPackId`/`tafsirPackId`/
   `copy.translationPackId` into `null`, and clamps the gap. It is idempotent (tested).
10. **Wave-0 command stubs** omit `State`/`AppHandle` (allowed by §2.8.1) and return
    `Unsupported("not implemented: <cmd>")`, except two that already work so the skeleton behaves: `window_ready` (shows
    and focuses the main window once, sets `state.ready`) and `app_quit` (`app.exit(0)`). Doc comments on commands are
    exported into `bindings.ts`, so each stub file says that editing a `///` command doc is a contract change.
11. **Bindings export.** `export_bindings` renders into a temp dir and rewrites `src/lib/ipc/bindings.ts` only when the
    content changed (no Vite reload for an unchanged contract), with the path anchored on `CARGO_MANIFEST_DIR` instead of
    the cwd. A second test, `bindings_cover_the_contract`, asserts 90 typed commands all returning `AppError`, the 7 events,
    no `"font_bytes"` and no `bigint`.
12. **Hook stubs with minimal real bodies** (files handed over): `window::show_main` (unminimize/show/focus, failures
    logged), `on_second_instance` → `show_main`, macOS `Reopen` → `show_main`, `set_ui_zoom`/`apply_settings` (zoom only);
    `tray::*` are no-ops; `i18n.rs` has the complete en/ar table (`TrayNowPlaying` = `"Now: {ref}"` and
    `StartupErrorBody` with `{detail}` are templates); the `quran://` handler already sends the §6.3 headers with 404
    (GET/HEAD), 204 (OPTIONS, plus `Allow-Methods`/`Allow-Headers: range`) and 405.
13. **Setup (handed over).** `build_state` is generic over the tauri `Runtime` (testable with `mock_app()`), resolves every
    §2.8.2 path with the D24 overrides (`QD_DATA_DIR`, `QD_CORE_DB`, `QD_TEST`; empty values count as unset; compiled out of
    release), creates `data/` and `packs/`, and logs paths only at debug level (they contain the user name, §0.2).
    `AppInfo.core` is `{ schemaVersion: 0, normalizerVersion: 0, source: "unavailable", builtAt: "" }` until the core is
    opened. The fatal dialog picks its language from the OS locale (settings are not loaded yet).
14. **Logging (§13.5).** Log file `quran-desktop.log` (instead of the product name with a space), 2 MiB per file,
    `KeepSome(3)` rotation; in debug builds `tao`, `wry`, `hyper`, `hyper_util`, `reqwest`, `rustls`, `tracing`,
    `symphonia_core` and `zbus` are capped at Info.
15. **`tauri.conf.json`.** `font-src`/`media-src` keep the scaffold's `blob:` (allowed by §6.4). The scaffold's bundle
    `targets`, macOS `minimumSystemVersion` and Linux `deb.depends` are dropped from the base file: §13.5 puts them in
    WP6b's per-OS files.

## Requests

- **WP0B:** in `src-tauri/src/media.rs`, make `set_app_user_model_id(app_id)` call
  `media_session::set_process_app_user_model_id(app_id).map_err(|e| e.to_string())` once the crate exports it (keep the
  name and signature: frozen `lib.rs` calls it). Add the crate-typed `AppState` fields and hooks as planned; keep
  `build_state` generic over `R: Runtime`.
- **WP6a:** `font_bytes` takes `app: AppHandle` (deviation 1). The setup tests can use `tauri::test::mock_app()` (dev
  feature enabled) with `QD_DATA_DIR`/`QD_CORE_DB` pointing into a tempdir.
- **Lead:** fold deviations 1, 3 and 4 into §0.2/§2.8.1/§5.15. `pnpm bindings:check` cannot pass while the repository has
  no commit (by design, `git add -N` + `git diff` reports the whole untracked file); WP0A verified determinism instead
  (two consecutive exports leave the file byte-identical) and did not touch the git index.

//! App and window commands (§5.13). Owner: WP6a.
//!
//! `///` docs on commands are exported to `bindings.ts` (a frozen contract file): editing one is a contract change.
//! Keep implementation notes in `//` comments.
//
// - `app_bootstrap` assembles everything the first paint needs in one blocking-pool task (budget < 40 ms, §3.5): the
//   cached core index, the stored settings, positions and reading bookmark, the pack summaries, reciters, decor status,
//   the audio snapshot, the network state and the startup notices. The core and user.db parts are required (their
//   errors reach the frontend's fatal screen); the pack summaries degrade to an empty list with a log line, because a
//   broken pack registry must not keep the reader from starting.
// - `window_set_chrome` maps the frontend's appearance onto the native backdrop: Windows 11 Mica (light or dark tint),
//   the macOS sidebar material, nothing on Linux. Effects the platform cannot show are `Unsupported`, so the frontend
//   can keep its chrome opaque. The last applied appearance is remembered, so repeats are free.
// - `window_set_caption` (integration, WP6b's request): the frontend reports whether its caption buttons are on screen,
//   so the native Snap Layouts target never outlives the title bar (zen, full-window overlays). Default: visible.
// - `window_ready` also opens the deep link the app was started with (the frontend listens by then).
// - `app_quit` runs the orderly shutdown (`AppState::shutdown`: audio, media session, user.db checkpoint) on the
//   blocking pool, then exits with code 0. A user's quit reaches it from the page: `window::quit` emits
//   `quit-requested`, and the page calls `app_quit` once its pending writes are saved.
// - `window_ready` also tells the window layer that the page listens for `quit-requested` (`window::page_ready`).

use std::sync::atomic::Ordering;
use std::time::Instant;

use quran_core::core_db::UNAVAILABLE_MESSAGE;
use quran_packs::PackError;
use quran_types::{AppError, Bootstrap, ChromeAppearance, ChromeEffect, Platform};
use tauri::utils::config::WindowEffectsConfig;
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::MAIN_WINDOW;
use crate::state::AppState;
use crate::util::{blocking, internal};

/// Everything the frontend needs before its first paint. Fails with `NotFound("core.db missing — run pnpm core:qdc")`
/// when the core is unavailable (debug degrade path, §2.8.2).
#[tauri::command]
#[specta::specta]
pub async fn app_bootstrap(app: AppHandle) -> Result<Bootstrap, AppError> {
    blocking(move || bootstrap(&*managed(&app)?)).await
}

/// Shows and focuses the main window once, after the frontend's first paint (the window starts hidden, §2.8.2).
#[tauri::command]
#[specta::specta]
pub async fn window_ready(app: AppHandle, state: State<'_, AppState>) -> Result<(), AppError> {
    // The page listens for `quit-requested` by now (also after a WebView2 reload, which calls this again).
    crate::window::page_ready(&app);
    if !state.ready.swap(true, Ordering::AcqRel) {
        log::info!(
            "first paint {} ms after start; showing the main window",
            state.started_at.elapsed().as_millis()
        );
        crate::window::show_main(&app);
        crate::window::open_launch_link(&app);
    }
    Ok(())
}

/// Applies the window chrome effect for the resolved theme; the frontend is the single chrome owner (§9.6).
#[tauri::command]
#[specta::specta]
pub async fn window_set_chrome(
    app: AppHandle,
    state: State<'_, AppState>,
    appearance: ChromeAppearance,
) -> Result<(), AppError> {
    let mut applied = state.chrome.lock();
    if *applied == Some(appearance) {
        return Ok(());
    }
    let effects = chrome_effects(Platform::current(), &state.app_info.os_version, appearance)?;
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| AppError::NotFound(format!("the `{MAIN_WINDOW}` window")))?;
    window.set_effects(effects).map_err(internal)?;
    log::debug!("window chrome: {appearance:?}");
    *applied = Some(appearance);
    Ok(())
}

/// Tells the native window whether the title bar's caption buttons are on screen. Call it with `false` while zen mode
/// or a full-window overlay hides the title bar, and with `true` when it shows again: on Windows 11 the Snap Layouts
/// target over the maximise button follows it. Idempotent; a no-op on other platforms.
#[tauri::command]
#[specta::specta]
pub async fn window_set_caption(app: AppHandle, visible: bool) -> Result<(), AppError> {
    crate::window::set_caption_visible(&app, visible);
    Ok(())
}

/// Stops audio, closes the databases and exits with code 0.
#[tauri::command]
#[specta::specta]
pub async fn app_quit(app: AppHandle) -> Result<(), AppError> {
    let handle = app.clone();
    blocking(move || {
        if let Some(state) = handle.try_state::<AppState>() {
            state.shutdown();
        }
        Ok(())
    })
    .await?;
    log::info!("quitting (app_quit)");
    app.exit(0);
    Ok(())
}

/// The managed state, or `Internal` before setup managed it (never the case once the window is visible).
fn managed<R: Runtime>(app: &AppHandle<R>) -> Result<State<'_, AppState>, AppError> {
    app.try_state::<AppState>()
        .ok_or_else(|| AppError::Internal("the app state is not ready".to_owned()))
}

/// The `app_bootstrap` payload (blocking: reads core.db and user.db).
pub(crate) fn bootstrap(state: &AppState) -> Result<Bootstrap, AppError> {
    if !state.core.is_available() {
        return Err(AppError::NotFound(UNAVAILABLE_MESSAGE.to_owned()));
    }
    let started = Instant::now();
    let index = state.core.index()?;
    let settings = state.user.settings_load()?;
    let first_run = state.user.first_run()?;
    let positions = state.user.positions()?;
    let reading_bookmark = state.user.reading_bookmark_get()?;
    let packs = state.packs.summaries().unwrap_or_else(|e| {
        degraded("pack summaries", &e);
        Vec::new()
    });
    let bootstrap = Bootstrap {
        app: state.app_info.clone(),
        index,
        settings,
        first_run,
        positions,
        reading_bookmark,
        packs,
        reciters: state.audio.reciters(),
        decor: state.packs.decor_status(),
        audio: state.audio.snapshot(),
        online: state.packs.online(),
        notices: state.startup_notices.lock().clone(),
    };
    log::debug!(
        "app_bootstrap assembled in {} µs",
        started.elapsed().as_micros()
    );
    Ok(bootstrap)
}

/// A non-essential bootstrap part that failed: the reader still starts. A not-yet-implemented subsystem is expected
/// during development and logged quietly.
fn degraded(part: &str, e: &PackError) {
    if matches!(e, PackError::Unsupported(_)) {
        log::debug!("app_bootstrap: {part} unavailable: {e}");
    } else {
        log::warn!("app_bootstrap: {part} unavailable: {e}");
    }
}

/// The native backdrop for `appearance` on `platform` (§9.6): `None` clears it.
/// - Windows: Mica with a light or dark tint (`MicaLight`/`MicaDark` set the backdrop's own dark mode, independent of the
///   OS theme and of the webview's `prefers-color-scheme`); Windows 10 has no Mica → `Unsupported`.
/// - macOS: the sidebar material, active only while the window is (it follows the window's appearance).
/// - Linux: no effects (opaque chrome, §9.6) → `Unsupported` for `auto`.
fn chrome_effects(
    platform: Platform,
    os_version: &str,
    appearance: ChromeAppearance,
) -> Result<Option<WindowEffectsConfig>, AppError> {
    if appearance.effect == ChromeEffect::Off {
        return Ok(None);
    }
    match platform {
        Platform::Windows if !windows_has_mica(os_version) => Err(AppError::Unsupported(format!(
            "the Mica backdrop needs Windows 11 (this is Windows {os_version})"
        ))),
        Platform::Windows => Ok(Some(
            EffectsBuilder::new()
                .effect(if appearance.dark {
                    Effect::MicaDark
                } else {
                    Effect::MicaLight
                })
                .build(),
        )),
        Platform::Macos => Ok(Some(
            EffectsBuilder::new()
                .effect(Effect::Sidebar)
                .state(EffectState::FollowsWindowActiveState)
                .build(),
        )),
        Platform::Linux => Err(AppError::Unsupported(
            "window backdrop effects are not available on Linux".to_owned(),
        )),
    }
}

/// Windows 11 (build 22000 or later), from `AppInfo.os_version` (`"10.0.22631"`). An unreadable version gets the
/// benefit of the doubt: applying Mica where it does not exist is a no-op.
fn windows_has_mica(os_version: &str) -> bool {
    const FIRST_WINDOWS_11_BUILD: u32 = 22_000;
    os_version
        .split('.')
        .nth(2)
        .and_then(|build| build.trim().parse::<u32>().ok())
        .is_none_or(|build| build >= FIRST_WINDOWS_11_BUILD)
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )]

    use quran_types::{FontTransport, Settings, StartupNotice};
    use tempfile::TempDir;

    use super::*;
    use crate::setup::tests::{build_mock, real_core_db, temp_paths};
    use crate::setup::{CorePolicy, StartupEnv};

    fn appearance(dark: bool, effect: ChromeEffect) -> ChromeAppearance {
        ChromeAppearance { dark, effect }
    }

    #[test]
    fn bootstrap_on_the_real_core() {
        let Some(core_db) = real_core_db() else {
            return;
        };
        let dir = TempDir::new().unwrap();
        let env = StartupEnv {
            paths: temp_paths(dir.path(), core_db),
            os_locale: Some("ar-SA".to_owned()),
            test_mode: true,
            font_transport: FontTransport::Bytes,
        };
        let (_app, built) = build_mock(env, CorePolicy::Fatal);
        let (state, _) = built.unwrap();

        let started = Instant::now();
        let b = bootstrap(&state).unwrap();
        let first_ms = started.elapsed().as_millis();
        assert_eq!(b.index.surahs.len(), 114);
        assert_eq!(b.index.ayah_first_word.len(), 6236);
        assert_eq!(b.index.layouts.len(), 3);
        assert!(b.first_run);
        // The first launch on this data took the UI language from the OS locale.
        assert_eq!(b.settings.ui_language, quran_types::UiLanguage::Ar);
        assert_eq!(
            b.settings,
            Settings {
                ui_language: quran_types::UiLanguage::Ar,
                ..Settings::default()
            }
        );
        assert!(b.positions.is_empty());
        assert_eq!(b.reading_bookmark, None);
        assert!(b.notices.is_empty());
        assert_eq!(b.audio.status, quran_types::PlaybackStatus::Idle);
        assert_eq!(b.app.font_transport, FontTransport::Bytes);
        assert!(b.app.test_mode);
        assert_eq!(b.app.core.schema_version, quran_core::CORE_SCHEMA_VERSION);
        assert_eq!(
            b.app.data_dir,
            crate::util::to_js_path(&dir.path().join("data"))
        );
        assert_eq!(b.app.protocol_base, crate::protocol::PROTOCOL_BASE);
        assert_eq!(b.app.version, env!("CARGO_PKG_VERSION"));
        assert!(!b.app.os_version.is_empty());

        // The index is cached: later bootstraps are well inside the 40 ms budget (§3.5) even in a debug build. The best
        // of three keeps a busy machine from failing the check.
        let best_ms = (0..3)
            .map(|_| {
                let started = Instant::now();
                assert_eq!(bootstrap(&state).unwrap(), b);
                started.elapsed().as_millis()
            })
            .min()
            .unwrap();
        assert!(
            best_ms < 40,
            "cached bootstrap took {best_ms} ms (first {first_ms} ms)"
        );

        // A user.db notice reaches the frontend through the bootstrap.
        drop(state);
        let dir = TempDir::new().unwrap();
        let paths = temp_paths(dir.path(), real_core_db().unwrap());
        std::fs::create_dir_all(&paths.data).unwrap();
        std::fs::write(paths.user_db(), vec![0x5a; 8192]).unwrap();
        let env = StartupEnv {
            paths,
            os_locale: None,
            test_mode: false,
            font_transport: FontTransport::Url,
        };
        let (_app, built) = build_mock(env, CorePolicy::Fatal);
        let state = built.unwrap().0;
        let b = bootstrap(&state).unwrap();
        assert!(matches!(
            b.notices.as_slice(),
            [StartupNotice::UserDbRecovered { .. }]
        ));
        // A restore from a backup answers it: a later bootstrap (a webview reload) no longer shows it.
        state.library_restored();
        assert!(bootstrap(&state).unwrap().notices.is_empty());
    }

    #[test]
    fn shutdown_is_idempotent() {
        let dir = TempDir::new().unwrap();
        let core = dir.path().join("core.db");
        std::fs::write(&core, b"").unwrap();
        let env = StartupEnv {
            paths: temp_paths(dir.path(), core),
            os_locale: None,
            test_mode: false,
            font_transport: FontTransport::Url,
        };
        let (_app, built) = build_mock(env, CorePolicy::Degrade);
        let (state, _) = built.unwrap();
        assert!(!state.is_shut_down());
        state.shutdown();
        assert!(state.is_shut_down());
        state.shutdown();
        // The databases still answer after the checkpoint.
        assert!(state.user.settings_load().is_ok());
    }

    #[test]
    fn chrome_effects_per_platform() {
        let off = appearance(true, ChromeEffect::Off);
        for platform in [Platform::Windows, Platform::Macos, Platform::Linux] {
            assert_eq!(chrome_effects(platform, "10.0.22631", off), Ok(None));
            assert_eq!(
                chrome_effects(platform, "10.0.19045", appearance(false, ChromeEffect::Off)),
                Ok(None)
            );
        }

        let windows = |dark| {
            chrome_effects(
                Platform::Windows,
                "10.0.26200",
                appearance(dark, ChromeEffect::Auto),
            )
        };
        assert_eq!(
            windows(true).unwrap().unwrap().effects,
            vec![Effect::MicaDark]
        );
        assert_eq!(
            windows(false).unwrap().unwrap().effects,
            vec![Effect::MicaLight]
        );
        assert!(matches!(
            chrome_effects(
                Platform::Windows,
                "10.0.19045",
                appearance(false, ChromeEffect::Auto)
            ),
            Err(AppError::Unsupported(_))
        ));

        let mac = chrome_effects(
            Platform::Macos,
            "15.6.1",
            appearance(true, ChromeEffect::Auto),
        )
        .unwrap()
        .unwrap();
        assert_eq!(mac.effects, vec![Effect::Sidebar]);
        assert_eq!(mac.state, Some(EffectState::FollowsWindowActiveState));

        assert!(matches!(
            chrome_effects(
                Platform::Linux,
                "24.4.0",
                appearance(false, ChromeEffect::Auto)
            ),
            Err(AppError::Unsupported(_))
        ));
    }

    #[test]
    fn mica_needs_windows_11() {
        for (version, mica) in [
            ("10.0.22000", true),
            ("10.0.22631", true),
            ("10.0.26200", true),
            ("10.0.21999", false),
            ("10.0.19045", false),
            ("6.1.7601", false),
            ("10.0", true),
            ("", true),
            ("unknown", true),
        ] {
            assert_eq!(windows_has_mica(version), mica, "{version:?}");
        }
    }
}

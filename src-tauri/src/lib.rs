//! Quran for Desktop app shell (crate `quran-desktop`, lib `quran_desktop_lib`).
//!
//! A thin layer over the workspace crates: IPC commands, managed state, the `quran://` protocol, window, tray and media
//! glue. [`run`] wires everything together.
//!
//! Release builds use `panic = "abort"`, so production code here must not panic.
#![cfg_attr(
    not(test),
    deny(
        clippy::indexing_slicing,
        clippy::panic,
        clippy::todo,
        clippy::unimplemented,
        clippy::unreachable
    )
)]

pub mod audio_glue;
// tauri-macros 2.7.1 checks every async command that borrows (`State<'_, _>`) with a `const _` item containing
// `unreachable!()`, spanned on the command's return type, so the crate-root `deny(clippy::unreachable)` would reject every
// stateful command. The exemption is scoped to the command modules; `panic`/`todo`/`unimplemented`/indexing stay denied.
// (Commands elsewhere, e.g. `protocol::font_bytes`, take `AppHandle` + `app.state::<AppState>()` instead.)
#[allow(clippy::unreachable)]
pub mod commands;
pub mod i18n;
pub mod ipc;
pub mod media;
pub mod packs_glue;
pub mod protocol;
pub mod setup;
pub mod state;
pub mod tray;
pub mod util;
pub mod window;

use tauri::Wry;
use tauri::ipc::Invoke;
use tauri::plugin::TauriPlugin;

/// Bundle identifier (`tauri.conf.json` `identifier`), also the Windows AppUserModelID and the name of the data
/// directory. Never changes after release.
pub const APP_ID: &str = "com.quran.labs.desktop";
/// Label of the single app window (`tauri.conf.json`).
pub const MAIN_WINDOW: &str = "main";

/// Builds and runs the app. Exits with code 1 when Tauri cannot be built (e.g. no WebView2 runtime).
pub fn run() {
    // FIRST statement: the AUMID must be set before any window exists. Failure is reported, never fatal.
    #[cfg(windows)]
    if let Err(e) = media::set_app_user_model_id(APP_ID) {
        eprintln!("aumid: {e}");
    }

    let specta = ipc::specta_builder();
    let typed = specta.invoke_handler();
    let raw = raw_handler();
    let built = tauri::Builder::default()
        // single-instance must be the first plugin
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            window::on_second_instance(app, argv)
        }))
        .plugin(log_plugin())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(window_state_plugin())
        .register_asynchronous_uri_scheme_protocol("quran", protocol::handle)
        .invoke_handler(move |invoke| {
            if invoke.message.command() == "font_bytes" {
                raw(invoke)
            } else {
                typed(invoke)
            }
        })
        .on_window_event(window::on_window_event)
        .setup(move |app| {
            specta.mount_events(app);
            // The main window is built here, not from the config (`create: false`): it gets the navigation guard, the
            // WebView2 crash recovery, its placement and, in isolated debug runs, its own WebView2 profile.
            window::create_main(app.handle()); // never fails
            setup::init(app); // never fails
            Ok(())
        })
        .build(tauri::generate_context!());

    match built {
        Ok(app) => app.run(|handle, ev| window::on_run_event(handle, &ev)),
        Err(e) => {
            log::error!("tauri build: {e}");
            eprintln!("tauri build: {e}");
            std::process::exit(1)
        }
    }
}

/// The raw (non-specta) commands: `font_bytes` returns `InvokeResponseBody::Raw`, which has no TS type.
fn raw_handler() -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![protocol::font_bytes]
}

/// Log targets capped at Info even in debug builds, so a debug log stays readable:
/// - `rusqlite_migration` would print the whole user.db and content.db DDL (about 190 lines) on every first launch; its
///   Info line "Database migrated to version N" stays;
/// - `html5ever` (with `markup5ever` and `selectors`, the rest of the HTML parser stack behind ammonia, which sanitises
///   every translation footnote and tafsir chapter) logs every token at Debug: one translation install wrote about
///   9,000 lines and rotated the 2 MB log several times a second, so the pack-job and audio lines were lost;
/// - the window, network and audio stacks' own chatter.
pub const NOISY_LOG_TARGETS: [&str; 13] = [
    "tao",
    "wry",
    "hyper",
    "hyper_util",
    "reqwest",
    "rustls",
    "tracing",
    "symphonia_core",
    "zbus",
    "rusqlite_migration",
    "html5ever",
    "markup5ever",
    "selectors",
];

/// Logging: Info (Debug in debug builds) into the OS log dir, plus stdout in debug builds; [`NOISY_LOG_TARGETS`] are
/// capped at Info. A debug run with `QD_DATA_DIR` logs into `<QD_DATA_DIR>/logs` instead (an isolated run shares no
/// file with another run or with an installed app).
fn log_plugin() -> TauriPlugin<Wry> {
    use log::LevelFilter;
    use tauri_plugin_log::{Builder, RotationStrategy, Target, TargetKind};

    let file_name = Some("quran-desktop".to_owned());
    let mut targets = vec![Target::new(match setup::dev_logs_dir() {
        Some(path) => TargetKind::Folder { path, file_name },
        None => TargetKind::LogDir { file_name },
    })];
    if cfg!(debug_assertions) {
        targets.push(Target::new(TargetKind::Stdout));
    }
    let level = if cfg!(debug_assertions) {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    };
    let mut builder = Builder::new()
        .targets(targets)
        .level(level)
        .max_file_size(2 * 1024 * 1024)
        .rotation_strategy(RotationStrategy::KeepSome(3));
    for noisy in NOISY_LOG_TARGETS {
        builder = builder.level_for(noisy, LevelFilter::Info);
    }
    builder.build()
}

/// Window state: saves size, position, maximised and fullscreen state; never `VISIBLE` (show-after-ready) or
/// `DECORATIONS` (per-OS window chrome). The main window's state is restored by `window::create_main`, not by the
/// plugin (`skip_initial_state`): the plugin restores the saved inner size with `set_size`, which on Windows makes the
/// undecorated, shadowed window taller by the hidden caption on every launch, and it never fits a restored window into
/// the monitor's work area. A debug run with `QD_DATA_DIR` keeps the file under it.
fn window_state_plugin() -> TauriPlugin<Wry> {
    use tauri_plugin_window_state::Builder;

    let builder = Builder::default()
        .with_state_flags(window::placement::SAVED_FLAGS)
        .skip_initial_state(MAIN_WINDOW);
    match setup::dev_window_state_file() {
        // The plugin joins the file name to the app config dir; an absolute path replaces it.
        Some(file) => builder.with_filename(file.to_string_lossy()),
        None => builder,
    }
    .build()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    /// The identity the code hard-codes is the one the bundle config declares: the AUMID must match the identifier the
    /// installer stamps on the Start-menu shortcut, or SMTC and the taskbar show "Unknown app".
    #[test]
    fn the_app_id_is_the_bundle_identifier() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], APP_ID);
        assert_eq!(conf["productName"], "Quran");
        assert_eq!(conf["mainBinaryName"], "quran-desktop");
        let bundle = &conf["bundle"];
        assert_eq!(bundle["license"], "GPL-3.0-or-later");
        assert_eq!(bundle["copyright"], "© Quran for Desktop contributors");
        assert_eq!(bundle["publisher"], "Quran for Desktop contributors");
        assert_eq!(env!("CARGO_PKG_LICENSE"), "GPL-3.0-or-later");
        // The Windows Apps list's support link and the deb's Homepage.
        assert_eq!(bundle["homepage"], "https://quran.com");
        // The deb bundler writes Cargo `authors` as the Maintainer: the publisher, never a person's name.
        assert_eq!(env!("CARGO_PKG_AUTHORS"), bundle["publisher"]);
    }

    /// Every HTML-parser target behind the translation and tafsir sanitiser is capped (finding: one translation install
    /// wrote about 9,000 `html5ever` Debug lines), and no target is listed twice.
    #[test]
    fn noisy_log_targets_are_capped() {
        for target in [
            "html5ever",
            "markup5ever",
            "selectors",
            "rusqlite_migration",
        ] {
            assert!(NOISY_LOG_TARGETS.contains(&target), "{target}");
        }
        let unique: std::collections::BTreeSet<_> = NOISY_LOG_TARGETS.iter().collect();
        assert_eq!(unique.len(), NOISY_LOG_TARGETS.len());
    }
}

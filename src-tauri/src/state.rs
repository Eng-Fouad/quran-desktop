//! Tauri-managed application state.
//!
//! [`AppState`] holds every long-lived handle: the databases, the search engine, the pack manager and its event bridge,
//! the audio service, the OS media session, the startup facts (`AppInfo`, notices) and two small pieces of window state.
//! It is built once by `setup::build_state`, managed before any command can run, and never replaced. Every handle is
//! `Send + Sync` (checked at compile time below).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use parking_lot::Mutex;
use quran_types::{AppInfo, ChromeAppearance, StartupNotice};

use crate::audio_glue::AudioService;
use crate::packs_glue::PackEventsImpl;

/// Every resolved path, each dunce-simplified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    /// `app_local_data_dir()` (debug builds: `QD_DATA_DIR` when set).
    pub data: PathBuf,
    /// `<data>/packs`: the `quran://` root.
    pub packs: PathBuf,
    /// `app_log_dir()` (tauri-plugin-log `LogDir` target).
    pub logs: PathBuf,
    /// Release: resource `data/core.db`. Debug: `QD_CORE_DB`, else `$CARGO_MANIFEST_DIR/resources/core.db`.
    pub core_db: PathBuf,
    /// Release: resource `data/catalog.json`. Debug: `$CARGO_MANIFEST_DIR/resources/catalog.json`.
    pub catalog: PathBuf,
}

impl AppPaths {
    /// `<data>/user.db`.
    #[must_use]
    pub fn user_db(&self) -> PathBuf {
        self.data.join("user.db")
    }

    /// `<data>/content.db`.
    #[must_use]
    pub fn content_db(&self) -> PathBuf {
        self.data.join("content.db")
    }

    /// `<data>/backups` (the default output of `user_backup_create`).
    #[must_use]
    pub fn backups(&self) -> PathBuf {
        self.data.join("backups")
    }
}

/// No `Debug` derive on purpose: the crate handles (pools, engines) need not implement it.
pub struct AppState {
    pub paths: AppPaths,
    /// `CoreDb::unavailable(..)` only in debug builds (degrade path).
    pub core: quran_core::CoreDb,
    pub search: quran_core::SearchEngine,
    pub user: quran_core::UserDb,
    pub content: quran_core::ContentDb,
    pub packs: quran_packs::PackManager,
    /// `packs_subscribe` sets its channel.
    pub pack_events: Arc<PackEventsImpl>,
    /// `AudioEngine` + `PlayRequest` resolution + timings cache.
    pub audio: AudioService,
    /// Filled after `manage()`; stays empty if the OS media session failed to start.
    pub media: OnceLock<media_session::MediaSession>,
    pub app_info: AppInfo,
    /// E.g. user.db recovered; returned by `app_bootstrap` (also after a webview reload). A backup restore answers the
    /// user.db notice, so it is dropped then ([`AppState::library_restored`]).
    pub startup_notices: Mutex<Vec<StartupNotice>>,
    /// Set by `window_ready` (the frontend's first paint).
    pub ready: AtomicBool,
    /// When startup began (`setup::init`): `window_ready` logs the time to the first paint.
    pub started_at: Instant,
    /// The window chrome last applied by `window_set_chrome` (`None` until the frontend's first call), so a repeated
    /// appearance (e.g. after a webview reload) does not rebuild the backdrop.
    pub chrome: Mutex<Option<ChromeAppearance>>,
    /// Set by the first [`AppState::shutdown`].
    shut_down: AtomicBool,
}

impl AppState {
    /// Assembles the state from its parts (`setup::build_state`). The window flags start cleared.
    #[allow(clippy::too_many_arguments)] // one argument per handle; a builder would only rename them
    #[must_use]
    pub fn new(
        paths: AppPaths,
        core: quran_core::CoreDb,
        search: quran_core::SearchEngine,
        user: quran_core::UserDb,
        content: quran_core::ContentDb,
        packs: quran_packs::PackManager,
        pack_events: Arc<PackEventsImpl>,
        audio: AudioService,
        app_info: AppInfo,
        startup_notices: Vec<StartupNotice>,
        started_at: Instant,
    ) -> Self {
        Self {
            paths,
            core,
            search,
            user,
            content,
            packs,
            pack_events,
            audio,
            media: OnceLock::new(),
            app_info,
            startup_notices: Mutex::new(startup_notices),
            ready: AtomicBool::new(false),
            started_at,
            chrome: Mutex::new(None),
            shut_down: AtomicBool::new(false),
        }
    }

    /// The orderly part of quitting, idempotent (the first call does the work, later calls return at once): stops the
    /// pack manager's background revalidation (its requests stop at their next chunk; download jobs need nothing, their
    /// journals resume them at the next start), stops the audio engine (joins its threads, ≤ 500 ms), hides the OS media
    /// session, and folds user.db's WAL back into the database file, so a copy of `user.db` taken after quitting is
    /// complete on its own. Blocking: call it from `spawn_blocking` or the event loop's exit, never from an async task.
    /// Failures are logged; quitting goes on.
    pub fn shutdown(&self) {
        if self.shut_down.swap(true, Ordering::AcqRel) {
            return;
        }
        let started = Instant::now();
        self.packs.shutdown();
        self.audio.shutdown();
        if let Some(session) = self.media.get() {
            session.set_state(media_session::PlaybackState::STOPPED);
        }
        let checkpoint = self
            .user
            .with(|c| Ok(c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?));
        if let Err(e) = checkpoint {
            log::warn!("shutdown: user.db checkpoint failed: {e}");
        }
        log::info!("shutdown finished in {} ms", started.elapsed().as_millis());
    }

    /// The library was replaced from a backup: the "library recovered" notice is answered and no longer shown, even if
    /// the webview reloads.
    pub fn library_restored(&self) {
        self.startup_notices
            .lock()
            .retain(|n| !matches!(n, StartupNotice::UserDbRecovered { .. }));
    }

    /// Whether [`AppState::shutdown`] has run.
    #[must_use]
    pub fn is_shut_down(&self) -> bool {
        self.shut_down.load(Ordering::Acquire)
    }
}

// Compile-time check: Tauri's `manage()` needs `Send + Sync`, and every field must keep it.
const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<AppState>();
};

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn derived_paths_live_under_the_data_dir() {
        let data = Path::new("data-root");
        let paths = AppPaths {
            data: data.to_path_buf(),
            packs: data.join("packs"),
            logs: PathBuf::from("logs"),
            core_db: PathBuf::from("core.db"),
            catalog: PathBuf::from("catalog.json"),
        };
        assert_eq!(paths.user_db(), data.join("user.db"));
        assert_eq!(paths.content_db(), data.join("content.db"));
        assert_eq!(paths.backups(), data.join("backups"));
    }
}

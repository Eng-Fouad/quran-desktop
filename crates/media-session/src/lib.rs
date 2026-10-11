//! `media-session`: OS media controls for Quran for Desktop (docs/ARCHITECTURE.md §2.4). No tauri dependency.
//!
//! Backends: Windows SMTC (`windows.rs`, a dedicated MTA thread), macOS Now Playing (`macos.rs`, marshalled to the main
//! thread through [`MainThreadDispatch`]), Linux MPRIS (`linux.rs`, the `qd-media` thread driving one future), and the
//! no-op fallback (`noop.rs`) used when initialisation fails, so the app always runs (without OS controls at worst).
//!
//! Every update is non-blocking: a backend owns its OS objects on its own thread (or the main thread on macOS) and
//! receives [`Metadata`] and [`PlaybackState`] over a channel, coalescing bursts. OS requests (media keys, the
//! Windows media flyout, Now Playing, MPRIS clients) arrive as [`MediaCommand`]s on the [`CommandHandler`].

mod error;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod model;
mod noop;
#[cfg(windows)]
mod windows;

use std::fmt;
use std::sync::Arc;

pub use error::MediaSessionError;
pub use model::{
    BackendKind, MainThreadDispatch, MediaCommand, Metadata, PlaybackState, SessionConfig, Status,
};

/// Receives OS media commands (called on a backend thread; must be cheap and non-blocking).
pub type CommandHandler = Arc<dyn Fn(MediaCommand) + Send + Sync>;

/// The contract every platform backend implements (`windows.rs`; `macos.rs` and `linux.rs` from WP6d on).
///
/// - `set_metadata`/`set_state` never block (a channel send or a main-thread dispatch) and never fail: OS errors are
///   logged by the backend.
/// - A backend shows the session only while a recitation is loaded ([`PlaybackState::is_active`]) and hides it on
///   [`Status::Stopped`].
/// - `shutdown` hides the session, unregisters every OS handler and stops the backend's thread; dropping a backend
///   without `shutdown` must do the same (without waiting).
pub(crate) trait Backend: Send + Sync {
    fn set_metadata(&self, m: Metadata);
    fn set_state(&self, s: PlaybackState);
    fn shutdown(self: Box<Self>);
}

/// A live media session. Updates are non-blocking (sent to the backend thread over a channel).
pub struct MediaSession {
    backend: Box<dyn Backend>,
    kind: BackendKind,
}

impl MediaSession {
    /// Starts the platform backend. `dispatch` is required on macOS (every call runs on the main thread) and ignored
    /// elsewhere; `on_command` receives play/pause/seek/rate/next/previous requests from the OS.
    ///
    /// When the platform backend cannot start (Windows: no window handle, COM or SMTC failure, or no answer within
    /// 5 s; any platform without a backend), the reason is logged and the session runs on the **no-op backend**
    /// ([`MediaSession::kind`] is [`BackendKind::Noop`]): the app never depends on OS media controls. The only error
    /// is an unusable `cfg` ([`SessionConfig::validate`]).
    pub fn new(
        cfg: SessionConfig,
        dispatch: Option<MainThreadDispatch>,
        on_command: CommandHandler,
    ) -> Result<Self, MediaSessionError> {
        cfg.validate()?;
        let (kind, backend) = match start_platform(&cfg, dispatch, on_command) {
            Ok(started) => started,
            Err(MediaSessionError::Unsupported) => {
                log::info!("media session: no OS media controls on this platform yet");
                (BackendKind::Noop, noop())
            }
            Err(e) => {
                log::warn!("media session: {e}; running without OS media controls");
                (BackendKind::Noop, noop())
            }
        };
        log::info!(
            "media session `{}` started ({kind:?} backend)",
            cfg.display_name
        );
        Ok(Self { backend, kind })
    }

    /// The backend this session runs on ([`BackendKind::Noop`] when the platform backend could not start).
    #[must_use]
    pub fn kind(&self) -> BackendKind {
        self.kind
    }

    /// Non-blocking.
    pub fn set_metadata(&self, m: Metadata) {
        self.backend.set_metadata(m);
    }

    /// Non-blocking.
    pub fn set_state(&self, s: PlaybackState) {
        self.backend.set_state(s);
    }

    /// Clears the OS state (Windows: controls disabled and display cleared; macOS: Stopped + empty
    /// `nowPlayingInfo`), unregisters the OS handlers and stops the backend thread (waiting at most about a second).
    pub fn shutdown(self) {
        self.backend.shutdown();
    }
}

impl fmt::Debug for MediaSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MediaSession")
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}

fn noop() -> Box<dyn Backend> {
    Box::new(noop::NoopBackend)
}

/// The platform backend: Windows SMTC (WP6c), Linux MPRIS and macOS Now Playing (WP6d). Other platforms answer
/// `Unsupported`.
fn start_platform(
    cfg: &SessionConfig,
    dispatch: Option<MainThreadDispatch>,
    on_command: CommandHandler,
) -> Result<(BackendKind, Box<dyn Backend>), MediaSessionError> {
    #[cfg(windows)]
    {
        // SMTC is obtained on the backend's own MTA thread: verified at runtime for a window owned by the (STA,
        // blocked) main thread, so the main-thread `dispatch` fallback of §2.4 is not needed (docs/deviations/WP6c.md).
        let _ = dispatch;
        let backend = windows::WindowsBackend::start(cfg, on_command)?;
        Ok((BackendKind::Smtc, Box::new(backend)))
    }
    #[cfg(target_os = "linux")]
    {
        // The MPRIS player lives on its own `qd-media` thread; nothing runs on the main thread.
        let _ = dispatch;
        let backend = linux::LinuxBackend::start(cfg, on_command)?;
        Ok((BackendKind::Mpris, Box::new(backend)))
    }
    #[cfg(target_os = "macos")]
    {
        // Every Now Playing call is marshalled to the main thread through `dispatch`.
        let backend = macos::MacBackend::start(cfg, dispatch, on_command)?;
        Ok((BackendKind::NowPlaying, Box::new(backend)))
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = (cfg, dispatch, on_command);
        Err(MediaSessionError::Unsupported)
    }
}

/// Sets the process AppUserModelID (the bundle identifier, the AUMID the NSIS/MSI installers stamp on the Start-menu
/// shortcut), so SMTC, the taskbar and toasts show "Quran" and its icon instead of "Unknown app".
///
/// Must run before any UI exists: it is the FIRST statement of `quran_desktop_lib::run()`, before
/// `tauri::Builder::default()`, because Tauri creates the config windows before the setup closure runs
/// (tauri-2.12.2 `app.rs` `setup()`).
#[cfg(windows)]
pub fn set_process_app_user_model_id(app_id: &str) -> Result<(), MediaSessionError> {
    self::windows::set_process_app_user_model_id(app_id)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::sync::Mutex;
    use std::time::Duration;

    use super::*;

    fn config() -> SessionConfig {
        SessionConfig {
            app_id: "com.quran.labs.desktop".into(),
            desktop_entry: "Quran".into(),
            display_name: "Quran".into(),
            dbus_name: "quran_desktop".into(),
            hwnd: None,
        }
    }

    #[test]
    fn a_session_without_a_platform_backend_falls_back_to_noop() {
        // `hwnd: None` makes the Windows backend fail, and macOS without a main-thread dispatcher has no backend, so both
        // fall back to the no-op session. On Linux the session is MPRIS when a session bus is reachable, else no-op.
        let session = MediaSession::new(config(), None, Arc::new(|_cmd| {})).unwrap();
        if !cfg!(any(target_os = "macos", target_os = "linux")) {
            assert_eq!(session.kind(), BackendKind::Noop);
        }
        session.set_metadata(Metadata {
            title: "Al-Fatihah 1:1".into(),
            artist: "Mishari Rashid al-Afasy".into(),
            album: "The Holy Quran".into(),
            duration: Some(Duration::from_secs(47)),
            artwork_path: None,
        });
        session.set_state(PlaybackState {
            status: Status::Playing,
            position: Duration::from_millis(1_500),
            rate: 1.25,
            can_next: true,
            can_previous: false,
            can_seek: true,
        });
        assert!(format!("{session:?}").contains("kind"));
        session.shutdown();
    }

    #[test]
    fn an_unusable_config_is_an_error() {
        let cfg = SessionConfig {
            display_name: String::new(),
            ..config()
        };
        let err = MediaSession::new(cfg, None, Arc::new(|_cmd| {})).unwrap_err();
        assert!(matches!(err, MediaSessionError::InvalidConfig(_)));
    }

    #[test]
    fn a_failed_backend_never_calls_the_handler() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&calls);
        let session = MediaSession::new(
            config(),
            None,
            Arc::new(move |cmd| sink.lock().unwrap().push(cmd)),
        )
        .unwrap();
        session.set_state(PlaybackState::STOPPED);
        drop(session);
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn the_default_state_is_stopped() {
        assert_eq!(PlaybackState::default(), PlaybackState::STOPPED);
        assert_eq!(Status::default(), Status::Stopped);
    }

    #[test]
    fn sessions_are_send_and_sync() {
        fn check<T: Send + Sync>() {}
        check::<MediaSession>();
    }

    #[cfg(windows)]
    #[test]
    fn sets_the_process_aumid() {
        // The test binary is its own process, so this only affects the test runner's taskbar identity.
        set_process_app_user_model_id("com.quran.labs.desktop.test").unwrap();
    }
}

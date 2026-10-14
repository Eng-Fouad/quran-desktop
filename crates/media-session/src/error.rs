//! The crate's error type.

/// Why a media session could not be created. The app logs it and runs without OS media controls.
///
/// A platform backend that fails to start is **not** an error of [`crate::MediaSession::new`]: the session then runs
/// on the no-op backend (the failure is logged; [`crate::MediaSession::kind`] reports it). `Platform` is what the
/// backends report internally and what [`crate::set_process_app_user_model_id`] returns.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MediaSessionError {
    /// An OS call failed (the message names the call and the OS error).
    #[error("platform: {0}")]
    Platform(String),
    /// The platform has no media-session backend.
    #[error("unsupported platform")]
    Unsupported,
    /// The [`crate::SessionConfig`] cannot be used by any backend (a programming error, caught before any OS call).
    #[error("invalid session config: {0}")]
    InvalidConfig(String),
}

impl MediaSessionError {
    /// `Platform("{call}: {error}")`.
    #[cfg_attr(target_os = "macos", allow(dead_code))] // the macOS backend reports its failures without it
    pub(crate) fn platform(call: &str, error: impl std::fmt::Display) -> Self {
        Self::Platform(format!("{call}: {error}"))
    }
}

//! The engine's error type and its IPC mapping (docs/ARCHITECTURE.md §2.3.2, §5.2). Frozen after wave 0.

use quran_types::AppError;

/// Every engine failure. `Clone` so a failure can be both stored in the snapshot and sent to the event sink.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AudioError {
    #[error("no audio output device")]
    NoOutputDevice,
    #[error("audio device: {0}")]
    Device(String),
    #[error("decode: {0}")]
    Decode(String),
    /// Network or file.
    #[error("source: {0}")]
    Source(String),
    /// Not cached and the network is unavailable or not allowed.
    #[error("offline: {0}")]
    Offline(String),
    #[error("timings: {0}")]
    Timings(String),
    /// §2.3.7 rule 7: the server's file is not the one the timings were recorded against (another `Content-Length`).
    /// The glue then refreshes the timings, and control plans the play again once.
    #[error("timings/file mismatch: {0}")]
    FileMismatch(String),
    #[error("invalid: {0}")]
    Invalid(String),
    /// The play was superseded (a newer play, a stop, shutdown) while this waited ([`crate::CancelToken`]).
    #[error("cancelled: a newer command superseded the play")]
    Cancelled,
    #[error("engine stopped")]
    EngineGone,
}

/// §5.2 mapping. Messages stay English and developer-oriented; the UI localises by `kind`.
impl From<AudioError> for AppError {
    fn from(e: AudioError) -> Self {
        let message = e.to_string();
        match e {
            AudioError::Source(_) | AudioError::FileMismatch(_) => Self::Network(message),
            AudioError::Offline(_) => Self::Offline(message),
            AudioError::Invalid(_) => Self::InvalidArgument(message),
            AudioError::Cancelled => Self::Cancelled(message),
            AudioError::NoOutputDevice
            | AudioError::Device(_)
            | AudioError::Decode(_)
            | AudioError::Timings(_)
            | AudioError::EngineGone => Self::Audio(message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_variant_per_the_contract() {
        let cases = [
            (AudioError::NoOutputDevice, "audio"),
            (AudioError::Device("x".into()), "audio"),
            (AudioError::Decode("x".into()), "audio"),
            (AudioError::Source("x".into()), "network"),
            (AudioError::Offline("x".into()), "offline"),
            (AudioError::Timings("x".into()), "audio"),
            (AudioError::FileMismatch("x".into()), "network"),
            (AudioError::Invalid("x".into()), "invalid_argument"),
            (AudioError::Cancelled, "cancelled"),
            (AudioError::EngineGone, "audio"),
        ];
        for (e, kind) in cases {
            let message = e.to_string();
            let app = AppError::from(e);
            assert_eq!(app.kind(), kind);
            assert_eq!(app.message(), message);
        }
    }
}

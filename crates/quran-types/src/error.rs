//! The single IPC error type (§5.2).

use serde::{Deserialize, Serialize};
use specta::Type;

/// Every command returns `Result<T, AppError>`. Over IPC: `{ "kind": "not_found", "message": "…" }`.
///
/// Messages are English and developer-oriented; the UI maps `kind` to a localised message and shows `message` only in a
/// "Details" disclosure. Note that Tauri itself rejects argument-deserialisation and unmanaged-state failures with a plain
/// string, which the frontend `call()` normalises to `internal` (§5.16).
#[derive(Debug, Clone, PartialEq, Eq, Hash, thiserror::Error, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "message", rename_all = "snake_case")]
pub enum AppError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("database: {0}")]
    Database(String),
    #[error("io: {0}")]
    Io(String),
    #[error("network: {0}")]
    Network(String),
    #[error("offline: {0}")]
    Offline(String),
    #[error("integrity: {0}")]
    Integrity(String),
    #[error("cancelled: {0}")]
    Cancelled(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("audio: {0}")]
    Audio(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("internal: {0}")]
    Internal(String),
}

impl AppError {
    /// The serialized `kind` tag (`"not_found"`, `"invalid_argument"`, …), e.g. for log lines.
    #[must_use]
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "not_found",
            Self::InvalidArgument(_) => "invalid_argument",
            Self::Database(_) => "database",
            Self::Io(_) => "io",
            Self::Network(_) => "network",
            Self::Offline(_) => "offline",
            Self::Integrity(_) => "integrity",
            Self::Cancelled(_) => "cancelled",
            Self::Conflict(_) => "conflict",
            Self::Audio(_) => "audio",
            Self::Unsupported(_) => "unsupported",
            Self::Internal(_) => "internal",
        }
    }

    /// The developer-oriented message.
    #[must_use]
    pub fn message(&self) -> &str {
        match self {
            Self::NotFound(m)
            | Self::InvalidArgument(m)
            | Self::Database(m)
            | Self::Io(m)
            | Self::Network(m)
            | Self::Offline(m)
            | Self::Integrity(m)
            | Self::Cancelled(m)
            | Self::Conflict(m)
            | Self::Audio(m)
            | Self::Unsupported(m)
            | Self::Internal(m) => m,
        }
    }
}

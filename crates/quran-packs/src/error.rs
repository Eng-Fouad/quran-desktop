//! The crate's error type and its IPC mapping (docs/ARCHITECTURE.md §2.5.2, §5.2). Frozen after wave 0.

use quran_types::AppError;

/// Every pack, download and catalog failure.
#[derive(Debug, thiserror::Error)]
pub enum PackError {
    #[error("http {status} for {url}")]
    Http { status: u16, url: String },
    #[error("network: {0}")]
    Network(#[from] reqwest::Error),
    #[error("offline")]
    Offline,
    /// An interactive request got no answer in time (`http`'s interactive budget): the link accepts connections but
    /// does not answer, or answers too slowly for someone waiting.
    #[error("timed out: {0}")]
    Timeout(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("integrity: {0}")]
    Integrity(String),
    #[error("zip: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("core: {0}")]
    Core(#[from] quran_core::CoreError),
    #[error("catalog: {0}")]
    Catalog(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("cancelled")]
    Cancelled,
    /// E.g. a job is already running for this pack.
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
}

/// §5.2 mapping. `Core` errors map as `quran_core::CoreError` does. Messages stay English and developer-oriented.
impl From<PackError> for AppError {
    fn from(e: PackError) -> Self {
        let message = e.to_string();
        match e {
            PackError::Http { status: 404, .. } => Self::NotFound(message),
            PackError::Http { .. } | PackError::Network(_) | PackError::Timeout(_) => {
                Self::Network(message)
            }
            PackError::Offline => Self::Offline(message),
            PackError::Io(_) => Self::Io(message),
            PackError::Integrity(_) | PackError::Zip(_) => Self::Integrity(message),
            PackError::Core(core) => Self::from(core),
            PackError::Catalog(_) => Self::Internal(message),
            PackError::NotFound(m) => Self::NotFound(m),
            PackError::Cancelled => Self::Cancelled(message),
            PackError::Conflict(m) => Self::Conflict(m),
            PackError::Unsupported(m) => Self::Unsupported(m),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_variant_per_the_contract() {
        let kind = |e: PackError| AppError::from(e).kind();
        let url = || "https://quranenc.com/downloads/sqlite/english_saheeh.zip".to_owned();
        assert_eq!(
            kind(PackError::Http {
                status: 404,
                url: url()
            }),
            "not_found"
        );
        assert_eq!(
            kind(PackError::Http {
                status: 503,
                url: url()
            }),
            "network"
        );
        assert_eq!(kind(PackError::Offline), "offline");
        assert_eq!(kind(PackError::Timeout("no response".into())), "network");
        assert_eq!(
            kind(PackError::Io(std::io::Error::other("disk full"))),
            "io"
        );
        assert_eq!(kind(PackError::Integrity("sha256".into())), "integrity");
        assert_eq!(
            kind(PackError::Zip(zip::result::ZipError::FileNotFound)),
            "integrity"
        );
        assert_eq!(
            kind(PackError::Core(quran_core::CoreError::InvalidArgument(
                "page 0".into()
            ))),
            "invalid_argument"
        );
        assert_eq!(
            kind(PackError::Core(quran_core::CoreError::Corrupt("x".into()))),
            "database"
        );
        assert_eq!(kind(PackError::Catalog("bad id".into())), "internal");
        assert_eq!(kind(PackError::NotFound("tr.xx".into())), "not_found");
        assert_eq!(kind(PackError::Cancelled), "cancelled");
        assert_eq!(kind(PackError::Conflict("job running".into())), "conflict");
        assert_eq!(kind(PackError::Unsupported("items".into())), "unsupported");
        assert_eq!(
            AppError::from(PackError::Unsupported("x".into())),
            AppError::Unsupported("x".into())
        );
    }
}

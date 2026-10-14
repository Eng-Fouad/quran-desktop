//! The crate's single error type and its IPC mapping.

use quran_types::AppError;

/// Every fallible `quran-core` operation returns this error.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("pool: {0}")]
    Pool(#[from] r2d2::Error),
    #[error("migration: {0}")]
    Migration(#[from] rusqlite_migration::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("schema mismatch: expected {expected}, found {found}")]
    SchemaMismatch { expected: u32, found: u32 },
    #[error("corrupt data: {0}")]
    Corrupt(String),
    /// A read-write database (user.db, content.db) written by a newer version of the app: its schema version is above
    /// every migration this build knows. The file is intact and left untouched (never quarantined); startup treats it
    /// as fatal so that updating the app opens it again.
    #[error(
        "it was written by a newer version of Quran for Desktop (schema {found}; this version reads up to \
         {supported}); update the app to open it"
    )]
    NewerSchema { found: u32, supported: u32 },
    /// Stubs only; must not survive in merged code.
    #[error("not implemented: {0}")]
    NotImplemented(&'static str),
}

/// `std::result::Result` with [`CoreError`].
pub type Result<T> = std::result::Result<T, CoreError>;

impl CoreError {
    /// True for SQLite's "this file is not a usable database" failures (`SQLITE_CORRUPT`, `SQLITE_NOTADB`), which the
    /// `open_or_recover` paths answer by quarantining the file.
    #[must_use]
    pub fn is_corruption(&self) -> bool {
        let sqlite = match self {
            Self::Sqlite(e) => e,
            Self::Migration(rusqlite_migration::Error::RusqliteError { err, .. }) => err,
            Self::Corrupt(_) => return true,
            _ => return false,
        };
        matches!(
            sqlite.sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase)
        )
    }
}

/// The IPC mapping. Messages stay English and developer-oriented; the UI localises by `kind`.
impl From<CoreError> for AppError {
    fn from(e: CoreError) -> Self {
        let message = e.to_string();
        match e {
            CoreError::NotFound(m) => Self::NotFound(m),
            CoreError::InvalidArgument(m) => Self::InvalidArgument(m),
            CoreError::Sqlite(_)
            | CoreError::Pool(_)
            | CoreError::Migration(_)
            | CoreError::SchemaMismatch { .. }
            | CoreError::NewerSchema { .. }
            | CoreError::Corrupt(_) => Self::Database(message),
            CoreError::Io(_) => Self::Io(message),
            CoreError::Json(_) => Self::Internal(message),
            CoreError::NotImplemented(_) => Self::Unsupported(message),
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn maps_every_variant_per_the_contract() {
        assert_eq!(
            AppError::from(CoreError::NotFound("ayah 9999".into())),
            AppError::NotFound("ayah 9999".into())
        );
        assert_eq!(
            AppError::from(CoreError::InvalidArgument("page 0".into())),
            AppError::InvalidArgument("page 0".into())
        );
        assert_eq!(
            AppError::from(CoreError::SchemaMismatch {
                expected: 1,
                found: 0
            }),
            AppError::Database("schema mismatch: expected 1, found 0".into())
        );
        assert_eq!(
            AppError::from(CoreError::Corrupt("x".into())),
            AppError::Database("corrupt data: x".into())
        );
        assert_eq!(
            AppError::from(CoreError::NewerSchema {
                found: 2,
                supported: 1
            }),
            AppError::Database(
                "it was written by a newer version of Quran for Desktop (schema 2; this version reads up to 1); \
                 update the app to open it"
                    .into()
            )
        );
        assert!(matches!(
            AppError::from(CoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows)),
            AppError::Database(_)
        ));
        assert!(matches!(
            AppError::from(CoreError::Io(std::io::Error::other("disk"))),
            AppError::Io(_)
        ));
        let json = serde_json::from_str::<u32>("x").unwrap_err();
        assert!(matches!(
            AppError::from(CoreError::Json(json)),
            AppError::Internal(_)
        ));
        assert_eq!(
            AppError::from(CoreError::NotImplemented("CoreDb::pages")),
            AppError::Unsupported("not implemented: CoreDb::pages".into())
        );
    }

    #[test]
    fn corruption_is_detected() {
        let corrupt = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_NOTADB),
            None,
        );
        assert!(CoreError::Sqlite(corrupt).is_corruption());
        assert!(CoreError::Corrupt("bad".into()).is_corruption());
        assert!(!CoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows).is_corruption());
        assert!(!CoreError::NotFound("x".into()).is_corruption());
        assert!(
            !CoreError::NewerSchema {
                found: 2,
                supported: 1
            }
            .is_corruption()
        );
    }
}

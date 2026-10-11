//! Schema-version handling shared by the read-write databases (user.db §3.2, content.db §3.3). Crate-private.
//!
//! A database whose `PRAGMA user_version` is above the last migration this build knows was written by a newer version
//! of the app (the user downgraded, or ran an older install on the same data). That file is intact: it is refused with
//! [`CoreError::NewerSchema`] before anything writes to it, and the `open_or_recover` paths never quarantine it, so
//! updating the app again opens the library as it was.

use rusqlite::Connection;
use rusqlite_migration::{Error as MigrationError, MigrationDefinitionError, Migrations};

use crate::{CoreError, Result};

/// `Err(NewerSchema)` when `conn`'s `user_version` is above `latest` (the number of migrations this build applies).
///
/// Reads only the database header, so it can run before `journal_mode`, the migrations or `optimize` touch the file.
/// A file that is not a database fails here with `SQLITE_NOTADB` (corruption, handled by the caller). A negative
/// version is not ours at all: it is left to the migrations, which reject it as a failed migration.
pub(crate) fn refuse_newer(conn: &Connection, latest: usize) -> Result<()> {
    let found: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let supported = u32::try_from(latest).unwrap_or(u32::MAX);
    match u32::try_from(found) {
        Ok(found) if found > supported => Err(CoreError::NewerSchema { found, supported }),
        _ => Ok(()),
    }
}

/// `migrations.to_latest(conn)`; rusqlite_migration's `DatabaseTooFarAhead` becomes [`CoreError::NewerSchema`] (with
/// the version read back), so a newer file can never pass for a failed migration.
pub(crate) fn to_latest(
    conn: &mut Connection,
    migrations: &Migrations<'_>,
    latest: usize,
) -> Result<()> {
    match migrations.to_latest(conn) {
        Ok(()) => Ok(()),
        Err(MigrationError::MigrationDefinition(MigrationDefinitionError::DatabaseTooFarAhead)) => {
            refuse_newer(conn, latest)?;
            // `refuse_newer` saw no newer version, yet the library reported one: keep its error.
            Err(CoreError::Migration(MigrationError::MigrationDefinition(
                MigrationDefinitionError::DatabaseTooFarAhead,
            )))
        }
        Err(e) => Err(e.into()),
    }
}

/// Whether `e` is rusqlite_migration's "too far ahead" (the raw form of [`CoreError::NewerSchema`]).
pub(crate) fn is_too_far_ahead(e: &CoreError) -> bool {
    matches!(
        e,
        CoreError::Migration(MigrationError::MigrationDefinition(
            MigrationDefinitionError::DatabaseTooFarAhead
        ))
    )
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use rusqlite_migration::M;

    use super::*;

    fn two() -> Migrations<'static> {
        Migrations::new(vec![
            M::up("CREATE TABLE a (x);"),
            M::up("CREATE TABLE b (y);"),
        ])
    }

    #[test]
    fn versions_up_to_latest_pass_and_newer_ones_are_refused() {
        let mut conn = Connection::open_in_memory().unwrap();
        refuse_newer(&conn, 2).unwrap();
        to_latest(&mut conn, &two(), 2).unwrap();
        refuse_newer(&conn, 2).unwrap();
        conn.pragma_update(None, "user_version", 3_i64).unwrap();
        assert!(matches!(
            refuse_newer(&conn, 2),
            Err(CoreError::NewerSchema {
                found: 3,
                supported: 2
            })
        ));
        let err = to_latest(&mut conn, &two(), 2).unwrap_err();
        assert!(
            matches!(
                err,
                CoreError::NewerSchema {
                    found: 3,
                    supported: 2
                }
            ),
            "{err}"
        );
        assert!(!is_too_far_ahead(&err));
        // A negative version is foreign, not newer: the migrations decide.
        conn.pragma_update(None, "user_version", -1_i64).unwrap();
        refuse_newer(&conn, 2).unwrap();
        assert!(is_too_far_ahead(&CoreError::Migration(
            MigrationError::MigrationDefinition(MigrationDefinitionError::DatabaseTooFarAhead)
        )));
    }
}

//! user.db migrations: the frozen SQL files of `migrations/user/` in order (§3.2). Owner: WP2b.
//!
//! `PRAGMA user_version` is owned by rusqlite_migration and nothing else may write it; PRAGMAs are set outside
//! migrations. Migrations are append-only: a schema change adds `migrations/user/000N_*.sql` to
//! `crate::USER_MIGRATIONS` (a contract change), never edits an applied file.

use rusqlite_migration::{M, Migrations};

use crate::USER_MIGRATIONS;

/// Every user.db migration, oldest first.
pub(crate) fn migrations() -> Migrations<'static> {
    Migrations::new(USER_MIGRATIONS.iter().map(|sql| M::up(sql)).collect())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use rusqlite::Connection;
    use rusqlite_migration::SchemaVersion;

    use super::*;

    #[test]
    fn migrations_validate() {
        migrations().validate().unwrap();
    }

    #[test]
    fn to_latest_is_idempotent_and_owns_user_version() {
        let mut conn = Connection::open_in_memory().unwrap();
        let m = migrations();
        assert_eq!(m.current_version(&conn).unwrap(), SchemaVersion::NoneSet);
        m.to_latest(&mut conn).unwrap();
        m.to_latest(&mut conn).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(usize::try_from(version).unwrap(), USER_MIGRATIONS.len());
        assert!(matches!(
            m.current_version(&conn).unwrap(),
            SchemaVersion::Inside(n) if n.get() == USER_MIGRATIONS.len()
        ));
    }

    #[test]
    fn a_database_from_a_newer_build_is_refused() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations().to_latest(&mut conn).unwrap();
        let ahead = i64::try_from(USER_MIGRATIONS.len()).unwrap() + 1;
        conn.pragma_update(None, "user_version", ahead).unwrap();
        let err = migrations().to_latest(&mut conn).unwrap_err();
        assert!(matches!(
            err,
            rusqlite_migration::Error::MigrationDefinition(
                rusqlite_migration::MigrationDefinitionError::DatabaseTooFarAhead
            )
        ));
    }
}

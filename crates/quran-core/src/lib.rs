//! `quran-core`: the data layer of Quran for Desktop (docs/ARCHITECTURE.md §2.2, §3).
//!
//! - [`normalize`]: the Arabic search normaliser shared with xtask and the TypeScript port (§2.2.3).
//! - [`core_db`]: the bundled, read-only `core.db` (pages, ayahs, index) behind an r2d2 pool (§2.2.4, §3.1).
//! - [`search`]: FTS5 search over core.db, pack DBs and notes (§2.2.5).
//! - [`user_db`]: the read-write `user.db` (library, study data, settings, pack registry) (§2.2.6, §3.2).
//! - [`content_db`]: QF-sourced runtime content with pinned rows (§2.2.7, §3.3, D20).
//! - [`pack_db`]: versioned translation/tafsir pack databases (§2.2.7, §3.4).
//! - [`timings`]: the recitation timing model and the QDC sanitiser (§2.2.7).
//!
//! No tauri dependency. Every handle is `Clone + Send + Sync`; call the blocking methods from `spawn_blocking`.
//! The DDL lives next to the code in `schema/` and `migrations/` and is copied verbatim from §3 (frozen contract).
//!
//! Frozen after wave 0 (§14.2): module declarations, re-exports and the version constants change only through a
//! contract PR.

pub mod content_db;
pub mod core_db;
mod error;
mod migrate;
pub mod normalize;
pub mod pack_db;
pub mod search;
pub mod timings;
pub mod user_db;

pub use content_db::{ChapterStamp, ClearReport, ContentDb, StaleItem, StaleKind, TafsirRow};
pub use core_db::{CoreDb, CoreMeta};
pub use error::{CoreError, Result};
pub use normalize::{Level, NORMALIZER_VERSION, fold_latin, normalize_ar, tokens};
pub use pack_db::{
    FootnoteInput, PackDb, PackDbWriter, PackEntry, PackEntryInput, PackMeta, PackStats,
    PackTokenizer,
};
pub use search::{Column, MatchExpr, SearchEngine, build_match, levenshtein_bounded};
pub use timings::{
    SanitizeReport, StoredTimings, TimedAyah, TimingFile, WordSeg, pack_words, sanitize_qdc,
    unpack_words,
};
pub use user_db::{InstalledPackRow, InstalledStatus, PackItemRow, UserDb};

/// `meta.schema_version` that this build reads. `CoreDb::open` fails with `SchemaMismatch` on any other value.
pub const CORE_SCHEMA_VERSION: u32 = 1;

/// The core.db DDL (§3.1.1), applied by `cargo xtask build-core` (`include_str!` consumer, WP3a).
pub const CORE_SQL: &str = include_str!("../schema/core.sql");
/// The content.db DDL (§3.3), applied as `ContentDb` migration 1 (D20).
pub const CONTENT_SQL: &str = include_str!("../schema/content.sql");
/// The pack DB DDL (§3.4). `PackDbWriter` substitutes `<T>` in the `entry_fts` statement with the tokenizer, and omits
/// that statement for `like_fallback` packs.
pub const PACK_SQL: &str = include_str!("../schema/pack.sql");
/// The user.db migrations (§3.2), in order. Append-only: a schema change adds `migrations/user/000N_*.sql` here.
pub const USER_MIGRATIONS: &[&str] = &[include_str!("../migrations/user/0001_init.sql")];

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use rusqlite::Connection;
    use rusqlite_migration::{M, Migrations};

    use super::*;

    fn table_names(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<String>>>()
            .unwrap()
    }

    #[test]
    fn core_schema_applies() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CORE_SQL).unwrap();
        let tables = table_names(&conn);
        for t in [
            "meta",
            "mushaf",
            "surah",
            "juz",
            "hizb",
            "rub",
            "manzil",
            "ruku",
            "sajda",
            "ayah",
            "word",
            "page",
            "line",
            "vocab_loose",
            "ayah_fts",
        ] {
            assert!(tables.iter().any(|n| n == t), "core.sql creates {t}");
        }
    }

    #[test]
    fn content_schema_applies_as_a_migration() {
        let migrations = Migrations::new(vec![M::up(CONTENT_SQL)]);
        migrations.validate().unwrap();
        let mut conn = Connection::open_in_memory().unwrap();
        migrations.to_latest(&mut conn).unwrap();
        let tables = table_names(&conn);
        for t in [
            "timing_file",
            "timing_ayah",
            "wbw",
            "tafsir_entry",
            "content_chapter",
            "kv",
        ] {
            assert!(tables.iter().any(|n| n == t), "content.sql creates {t}");
        }
    }

    #[test]
    fn user_migrations_validate() {
        let migrations = Migrations::new(USER_MIGRATIONS.iter().map(|sql| M::up(sql)).collect());
        migrations.validate().unwrap();
        let mut conn = Connection::open_in_memory().unwrap();
        migrations.to_latest(&mut conn).unwrap();
        let tables = table_names(&conn);
        for t in [
            "setting",
            "collection",
            "bookmark",
            "collection_item",
            "reading_bookmark",
            "highlight",
            "note",
            "note_fts",
            "tag",
            "item_tag",
            "reading_position",
            "history_entry",
            "search_history",
            "memo_ayah",
            "memo_test",
            "loop_preset",
            "installed_pack",
            "pack_item",
        ] {
            assert!(tables.iter().any(|n| n == t), "0001_init.sql creates {t}");
        }
        // The note FTS triggers keep the external-content index in sync.
        conn.execute(
            "INSERT INTO note (id, from_ayah_id, to_ayah_id, body, body_search, created_at, updated_at)
             VALUES ('n1', 1, 7, 'body', 'opening prayer', 0, 0)",
            [],
        )
        .unwrap();
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM note_fts WHERE note_fts MATCH 'prayer'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);
    }

    /// Every `<T>` of the §3.4 table, and the `like_fallback` form (no `entry_fts` statement).
    #[test]
    fn pack_schema_applies_for_every_tokenizer() {
        for tokenize in [
            Some("porter unicode61 remove_diacritics 2"),
            Some("unicode61 remove_diacritics 2"),
            Some("unicode61"),
            None,
        ] {
            let sql = match tokenize {
                Some(t) => PACK_SQL.replace("<T>", t),
                None => PACK_SQL
                    .lines()
                    .filter(|l| !l.starts_with("CREATE VIRTUAL TABLE entry_fts"))
                    .collect::<Vec<_>>()
                    .join("\n"),
            };
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(&sql).unwrap();
            let tables = table_names(&conn);
            assert!(tables.iter().any(|n| n == "entry"));
            assert!(tables.iter().any(|n| n == "footnote"));
            assert_eq!(
                tables.iter().any(|n| n == "entry_fts"),
                tokenize.is_some(),
                "{tokenize:?}"
            );
        }
    }
}

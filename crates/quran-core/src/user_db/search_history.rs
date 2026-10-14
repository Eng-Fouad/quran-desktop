//! Search history keyed by `(query, scope)`, the scope stored as serde JSON text.
//!
//! - The query is stored trimmed with whitespace runs collapsed, so `"  rahman "` and `"rahman"` are one entry. Letter
//!   case and diacritics are kept (they are what the user typed and what the entry re-runs).
//! - The scope is the IPC JSON (`{"type":"quran"}`, `{"type":"translation","data":{"packId":"tr.en.saheeh"}}`); serde's
//!   field order is fixed, so equal scopes always produce equal text.
//! - Re-adding an entry bumps `use_count` and `last_used_at`. At most [`SEARCH_HISTORY_MAX_ENTRIES`] entries are kept
//!   (least recently used dropped). Rows whose scope kind this build does not know are filtered out in SQL (so `limit`
//!   still counts usable entries); a known kind that fails to deserialise is skipped (logged at warn).

use quran_types::{SearchHistoryEntry, SearchScope};
use rusqlite::params;

use super::{UserDb, col_u32, ms_to_secs};
use crate::{CoreError, Result};

/// Least recently used entries beyond this count are dropped.
pub const SEARCH_HISTORY_MAX_ENTRIES: u32 = 200;
/// Longest query (in characters) the history stores.
pub const SEARCH_QUERY_MAX_CHARS: usize = 500;

/// The `type` tag of every `SearchScope` variant, as an SQL list (a test keeps it in sync with the enum).
const SCOPE_KINDS_SQL: &str = "'quran', 'translation', 'notes'";

/// Trims and collapses whitespace runs to one space.
fn clean_query(query: &str) -> String {
    query.split_whitespace().collect::<Vec<_>>().join(" ")
}

impl UserDb {
    /// `scope` is stored as serde JSON text, e.g. `{"type":"quran"}`.
    pub fn search_history_add(&self, query: &str, scope: &SearchScope) -> Result<()> {
        let query = clean_query(query);
        if query.is_empty() {
            return Err(CoreError::InvalidArgument("search query is empty".into()));
        }
        if query.chars().count() > SEARCH_QUERY_MAX_CHARS {
            return Err(CoreError::InvalidArgument(format!(
                "search query is longer than {SEARCH_QUERY_MAX_CHARS} characters"
            )));
        }
        if let SearchScope::Translation { pack_id } = scope
            && pack_id.trim().is_empty()
        {
            return Err(CoreError::InvalidArgument(
                "translation scope without a pack id".into(),
            ));
        }
        let scope = serde_json::to_string(scope)?;
        let now = self.now_ms();
        self.with_tx(|tx| {
            tx.prepare_cached(
                "INSERT INTO search_history (query, scope, last_used_at, use_count) VALUES (?1, ?2, ?3, 1)
                 ON CONFLICT (query, scope) DO UPDATE SET last_used_at = excluded.last_used_at,
                   use_count = use_count + 1",
            )?
            .execute(params![query, scope, now])?;
            tx.prepare_cached(
                "DELETE FROM search_history WHERE (query, scope) IN (
                   SELECT query, scope FROM search_history
                   ORDER BY last_used_at DESC, use_count DESC LIMIT -1 OFFSET ?1)",
            )?
            .execute([SEARCH_HISTORY_MAX_ENTRIES])?;
            Ok(())
        })
    }

    /// Most recently used first; at most `limit` entries (capped at [`SEARCH_HISTORY_MAX_ENTRIES`]; 0 returns none).
    pub fn search_history_list(&self, limit: u32) -> Result<Vec<SearchHistoryEntry>> {
        let limit = limit.min(SEARCH_HISTORY_MAX_ENTRIES);
        type Raw = (String, String, i64, i64);
        let raws: Vec<Raw> = self.with(|c| {
            let mut stmt = c.prepare_cached(&format!(
                "SELECT query, scope, last_used_at, use_count FROM search_history
                 WHERE json_extract(scope, '$.type') IN ({SCOPE_KINDS_SQL})
                 ORDER BY last_used_at DESC, use_count DESC, query LIMIT ?1"
            ))?;
            let rows = stmt
                .query_map([limit], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })?
                .collect::<rusqlite::Result<Vec<Raw>>>()?;
            Ok(rows)
        })?;
        let mut out = Vec::with_capacity(raws.len());
        for (query, scope_json, last_used_at, use_count) in raws {
            let scope = match serde_json::from_str::<SearchScope>(&scope_json) {
                Ok(scope) => scope,
                Err(e) => {
                    log::warn!("search history: skipping an entry with scope {scope_json}: {e}");
                    continue;
                }
            };
            out.push(SearchHistoryEntry {
                query,
                scope,
                last_used_at: ms_to_secs(last_used_at),
                use_count: col_u32(use_count, "search_history.use_count")?,
            });
        }
        Ok(out)
    }

    /// Deletes every search history entry.
    pub fn search_history_clear(&self) -> Result<()> {
        self.with(|c| {
            c.execute("DELETE FROM search_history", [])?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    const T0: i64 = 1_700_000_000_000;

    fn temp_db() -> (tempfile::TempDir, UserDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = UserDb::open(&dir.path().join("user.db")).unwrap();
        db.set_test_clock(Some(T0));
        (dir, db)
    }

    fn tr(pack_id: &str) -> SearchScope {
        SearchScope::Translation {
            pack_id: pack_id.into(),
        }
    }

    /// The SQL filter in `search_history_list` lists every scope kind. The match is exhaustive, so a new `SearchScope`
    /// variant fails to compile here until the filter is updated.
    #[test]
    fn the_sql_filter_knows_every_scope_kind() {
        fn kind(scope: &SearchScope) -> &'static str {
            match scope {
                SearchScope::Quran => "quran",
                SearchScope::Translation { .. } => "translation",
                SearchScope::Notes => "notes",
            }
        }
        for scope in [SearchScope::Quran, tr("x"), SearchScope::Notes] {
            let json = serde_json::to_value(&scope).unwrap();
            assert_eq!(json["type"].as_str(), Some(kind(&scope)));
            assert!(
                SCOPE_KINDS_SQL.contains(&format!("'{}'", kind(&scope))),
                "{scope:?}"
            );
        }
    }

    #[test]
    fn the_scope_is_stored_as_ipc_json() {
        let (_dir, db) = temp_db();
        db.search_history_add("الرحمن", &SearchScope::Quran)
            .unwrap();
        db.search_history_add("mercy", &tr("tr.en.saheeh")).unwrap();
        let scopes: Vec<String> = db
            .with(|c| {
                Ok(
                    c.prepare("SELECT scope FROM search_history ORDER BY query")?
                        .query_map([], |r| r.get(0))?
                        .collect::<rusqlite::Result<_>>()?,
                )
            })
            .unwrap();
        assert_eq!(
            scopes,
            [
                r#"{"type":"translation","data":{"packId":"tr.en.saheeh"}}"#,
                r#"{"type":"quran"}"#
            ]
        );
    }

    #[test]
    fn re_adding_bumps_the_entry_and_scopes_are_distinct() {
        let (_dir, db) = temp_db();
        db.search_history_add("mercy", &SearchScope::Quran).unwrap();
        db.set_test_clock(Some(T0 + 1_000));
        db.search_history_add("light", &SearchScope::Notes).unwrap();
        db.set_test_clock(Some(T0 + 2_000));
        db.search_history_add("  mercy \t", &SearchScope::Quran)
            .unwrap();
        db.search_history_add("mercy", &tr("tr.en.saheeh")).unwrap();
        let list = db.search_history_list(10).unwrap();
        assert_eq!(
            list.iter()
                .map(|e| (
                    e.query.as_str(),
                    e.scope.clone(),
                    e.use_count,
                    e.last_used_at
                ))
                .collect::<Vec<_>>(),
            [
                ("mercy", SearchScope::Quran, 2, 1_700_000_002),
                ("mercy", tr("tr.en.saheeh"), 1, 1_700_000_002),
                ("light", SearchScope::Notes, 1, 1_700_000_001),
            ]
        );
        assert_eq!(db.search_history_list(1).unwrap().len(), 1);
        assert!(db.search_history_list(0).unwrap().is_empty());
        db.search_history_clear().unwrap();
        assert!(db.search_history_list(10).unwrap().is_empty());
    }

    #[test]
    fn invalid_queries_are_rejected() {
        let (_dir, db) = temp_db();
        for (query, scope) in [
            ("   ", SearchScope::Quran),
            (
                &"x".repeat(SEARCH_QUERY_MAX_CHARS + 1)[..],
                SearchScope::Quran,
            ),
            ("ok", tr(" ")),
        ] {
            assert!(
                matches!(
                    db.search_history_add(query, &scope),
                    Err(CoreError::InvalidArgument(_))
                ),
                "{query}"
            );
        }
        db.search_history_add(&"ب".repeat(SEARCH_QUERY_MAX_CHARS), &SearchScope::Quran)
            .unwrap();
    }

    #[test]
    fn the_history_is_bounded_and_unknown_scopes_are_skipped() {
        let (_dir, db) = temp_db();
        for i in 0..SEARCH_HISTORY_MAX_ENTRIES + 3 {
            db.set_test_clock(Some(T0 + i64::from(i)));
            db.search_history_add(&format!("q{i}"), &SearchScope::Quran)
                .unwrap();
        }
        let list = db.search_history_list(u32::MAX).unwrap();
        assert_eq!(
            list.len(),
            usize::try_from(SEARCH_HISTORY_MAX_ENTRIES).unwrap()
        );
        assert_eq!(
            list[0].query,
            format!("q{}", SEARCH_HISTORY_MAX_ENTRIES + 2)
        );
        assert!(!list.iter().any(|e| e.query == "q0" || e.query == "q2"));

        db.with(|c| {
            c.execute(
                r#"INSERT INTO search_history (query, scope, last_used_at) VALUES ('x', '{"type":"hadith"}', ?1)"#,
                [T0 + 10_000],
            )?;
            Ok(())
        })
        .unwrap();
        assert_eq!(
            db.search_history_list(1).unwrap()[0].query,
            format!("q{}", SEARCH_HISTORY_MAX_ENTRIES + 2)
        );
    }
}

//! Disposable JSON key-value cache with fetch stamps.
//!
//! Small upstream responses (reciter lists, translation-list versions, …) cached with the time they were fetched, so
//! callers can apply their own freshness rule. Every row is removed by "Clear cache" ([`ContentDb::clear_unpinned`]).

use rusqlite::{OptionalExtension, params};

use super::ContentDb;
use crate::{CoreError, Result};

impl ContentDb {
    /// `(json, fetched_at_ms)`, or `None` when the key was never stored (or was cleared).
    pub fn kv_get(&self, key: &str) -> Result<Option<(String, i64)>> {
        self.with(|c| {
            let row = c
                .prepare_cached("SELECT value, fetched_at FROM kv WHERE key = ?1")?
                .query_row([key], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()?;
            Ok(row)
        })
    }

    /// Stores (or replaces) `json` under `key`. The value must be valid JSON.
    pub fn kv_put(&self, key: &str, json: &str, fetched_at_ms: i64) -> Result<()> {
        if key.is_empty() {
            return Err(CoreError::InvalidArgument("empty kv key".into()));
        }
        serde_json::from_str::<serde::de::IgnoredAny>(json)?;
        self.with(|c| {
            c.prepare_cached(
                "INSERT INTO kv (key, value, fetched_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at",
            )?
            .execute(params![key, json, fetched_at_ms])?;
            Ok(())
        })
    }
}

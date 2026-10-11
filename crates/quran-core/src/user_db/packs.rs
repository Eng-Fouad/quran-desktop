//! The pack registry: `installed_pack` and `pack_item` (§3.2), used by quran-packs only. Owner: WP2b.
//!
//! The row types are plain Rust structs that mirror §3.2 (not IPC types). Timestamps are Unix **milliseconds**, as
//! stored. The registry is a thin, policy-free data layer: `PackManager` (quran-packs) decides what to write.
//!
//! - `installed_pack` and `pack_item` are independent tables: stream-cached audio items (`pinned = 0`) exist for packs
//!   that were never installed. [`UserDb::pack_delete`] therefore removes only the `installed_pack` row; item rows go
//!   through [`UserDb::pack_item_delete`] or, for a whole pack, [`UserDb::pack_items_clear`].
//! - Deletes and touches of missing rows are no-ops (idempotent).
//! - Sizes are `u64` in Rust and `INTEGER` (i64) in SQLite; values above `i64::MAX` saturate.

use quran_types::PackKind;
use rusqlite::{OptionalExtension, Row, params};

use super::UserDb;
use crate::Result;

/// One `installed_pack` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledPackRow {
    pub pack_id: String,
    pub kind: PackKind,
    pub version: String,
    /// Relative to `packs/`; `None` for cache-backed packs (WBW, Quran.com tafsir, recitations, fonts).
    pub path: Option<String>,
    pub status: InstalledStatus,
    pub bytes: u64,
    pub items_total: u32,
    pub items_present: u32,
    pub sha256: Option<String>,
    /// Upstream validators/version as JSON (QuranEnc: `{etag, lastModified, contentLength}` or the list version).
    pub source_version: Option<String>,
    pub installed_at: i64,
    pub updated_at: i64,
    pub last_checked_at: Option<i64>,
}

/// `installed_pack.status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InstalledStatus {
    Installed,
    Partial,
    Paused,
    Failed,
    Removing,
}

impl InstalledStatus {
    /// The stored text (the `CHECK` constraint's values).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Installed => "installed",
            Self::Partial => "partial",
            Self::Paused => "paused",
            Self::Failed => "failed",
            Self::Removing => "removing",
        }
    }

    /// Inverse of [`Self::as_str`].
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "installed" => Self::Installed,
            "partial" => Self::Partial,
            "paused" => Self::Paused,
            "failed" => Self::Failed,
            "removing" => Self::Removing,
            _ => return None,
        })
    }
}

/// One `pack_item` row. `item` is `'p262' | '002' | 'ch18' | 'file:qcf-surah-header.woff2'` (§2.5.3 item ids).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackItemRow {
    pub pack_id: String,
    pub item: String,
    pub bytes: u64,
    pub sha256: String,
    /// `false` = evictable stream cache.
    pub pinned: bool,
    pub fetched_at: i64,
    pub last_used_at: i64,
}

/// The stored text of a pack kind: the same snake_case names as the catalog and the IPC enum.
const fn kind_str(kind: PackKind) -> &'static str {
    match kind {
        PackKind::MushafFonts => "mushaf_fonts",
        PackKind::Decor => "decor",
        PackKind::Translation => "translation",
        PackKind::Tafsir => "tafsir",
        PackKind::Recitation => "recitation",
        PackKind::Wbw => "wbw",
    }
}

/// Inverse of [`kind_str`].
fn parse_kind(s: &str) -> Option<PackKind> {
    Some(match s {
        "mushaf_fonts" => PackKind::MushafFonts,
        "decor" => PackKind::Decor,
        "translation" => PackKind::Translation,
        "tafsir" => PackKind::Tafsir,
        "recitation" => PackKind::Recitation,
        "wbw" => PackKind::Wbw,
        _ => return None,
    })
}

fn bytes_to_db(bytes: u64) -> i64 {
    i64::try_from(bytes).unwrap_or(i64::MAX)
}

fn bytes_from_db(bytes: i64) -> u64 {
    u64::try_from(bytes).unwrap_or(0)
}

fn count_from_db(n: i64) -> u32 {
    u32::try_from(n.max(0)).unwrap_or(u32::MAX)
}

const INSTALLED_COLUMNS: &str = "pack_id, kind, version, path, status, bytes, items_total, items_present, sha256, \
                                 source_version, installed_at, updated_at, last_checked_at";
const ITEM_COLUMNS: &str = "pack_id, item, bytes, sha256, pinned, fetched_at, last_used_at";

/// A raw `installed_pack` row whose `kind` and `status` are still text (a row written by a newer build may use a kind
/// this build does not know; it is skipped rather than failing the whole registry).
struct RawInstalled {
    row: InstalledPackRow,
    kind: String,
    status: String,
}

fn raw_installed(r: &Row<'_>) -> rusqlite::Result<RawInstalled> {
    Ok(RawInstalled {
        row: InstalledPackRow {
            pack_id: r.get(0)?,
            kind: PackKind::Decor, // replaced from `kind` below
            version: r.get(2)?,
            path: r.get(3)?,
            status: InstalledStatus::Installed, // replaced from `status` below
            bytes: bytes_from_db(r.get(5)?),
            items_total: count_from_db(r.get(6)?),
            items_present: count_from_db(r.get(7)?),
            sha256: r.get(8)?,
            source_version: r.get(9)?,
            installed_at: r.get(10)?,
            updated_at: r.get(11)?,
            last_checked_at: r.get(12)?,
        },
        kind: r.get(1)?,
        status: r.get(4)?,
    })
}

fn item_row(r: &Row<'_>) -> rusqlite::Result<PackItemRow> {
    Ok(PackItemRow {
        pack_id: r.get(0)?,
        item: r.get(1)?,
        bytes: bytes_from_db(r.get(2)?),
        sha256: r.get(3)?,
        pinned: r.get::<_, i64>(4)? != 0,
        fetched_at: r.get(5)?,
        last_used_at: r.get(6)?,
    })
}

impl UserDb {
    /// Every `installed_pack` row, ordered by `pack_id`. Rows with a kind or status this build does not know are
    /// skipped (logged at warn).
    pub fn packs_installed(&self) -> Result<Vec<InstalledPackRow>> {
        self.with(|c| {
            let mut stmt = c.prepare_cached(&format!(
                "SELECT {INSTALLED_COLUMNS} FROM installed_pack ORDER BY pack_id"
            ))?;
            let raws = stmt
                .query_map([], raw_installed)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(raws
                .into_iter()
                .filter_map(|raw| {
                    let (Some(kind), Some(status)) =
                        (parse_kind(&raw.kind), InstalledStatus::parse(&raw.status))
                    else {
                        log::warn!(
                            "user.db: skipping installed_pack {} (kind {:?}, status {:?})",
                            raw.row.pack_id,
                            raw.kind,
                            raw.status
                        );
                        return None;
                    };
                    Some(InstalledPackRow {
                        kind,
                        status,
                        ..raw.row
                    })
                })
                .collect())
        })
    }

    /// One `installed_pack` row, if present (same skipping rule as [`Self::packs_installed`]).
    pub fn pack_installed(&self, pack_id: &str) -> Result<Option<InstalledPackRow>> {
        let raw = self.with(|c| {
            Ok(c.prepare_cached(&format!(
                "SELECT {INSTALLED_COLUMNS} FROM installed_pack WHERE pack_id = ?1"
            ))?
            .query_row([pack_id], raw_installed)
            .optional()?)
        })?;
        Ok(raw.and_then(|raw| {
            let kind = parse_kind(&raw.kind)?;
            let status = InstalledStatus::parse(&raw.status)?;
            Some(InstalledPackRow {
                kind,
                status,
                ..raw.row
            })
        }))
    }

    /// Inserts or replaces the row for `row.pack_id` with exactly the given values (one transaction).
    pub fn pack_upsert(&self, row: &InstalledPackRow) -> Result<()> {
        self.with(|c| {
            c.prepare_cached(&format!(
                "INSERT INTO installed_pack ({INSTALLED_COLUMNS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                 ON CONFLICT (pack_id) DO UPDATE SET
                   kind = excluded.kind, version = excluded.version, path = excluded.path, status = excluded.status,
                   bytes = excluded.bytes, items_total = excluded.items_total, items_present = excluded.items_present,
                   sha256 = excluded.sha256, source_version = excluded.source_version,
                   installed_at = excluded.installed_at, updated_at = excluded.updated_at,
                   last_checked_at = excluded.last_checked_at"
            ))?
            .execute(params![
                row.pack_id,
                kind_str(row.kind),
                row.version,
                row.path,
                row.status.as_str(),
                bytes_to_db(row.bytes),
                row.items_total,
                row.items_present,
                row.sha256,
                row.source_version,
                row.installed_at,
                row.updated_at,
                row.last_checked_at,
            ])?;
            Ok(())
        })
    }

    /// Stamps `last_checked_at` of the pack's row and nothing else (one statement, so a job that rewrites the row at the
    /// same moment never loses its own columns). Returns whether a row was stamped (`false` when the pack has none).
    pub fn pack_set_checked(&self, pack_id: &str, at_ms: i64) -> Result<bool> {
        self.with(|c| {
            let n = c
                .prepare_cached(
                    "UPDATE installed_pack SET last_checked_at = ?2 WHERE pack_id = ?1",
                )?
                .execute(params![pack_id, at_ms])?;
            Ok(n > 0)
        })
    }

    /// Removes the `installed_pack` row only (no-op when absent). Item rows are independent (see the module docs).
    pub fn pack_delete(&self, pack_id: &str) -> Result<()> {
        self.with(|c| {
            c.prepare_cached("DELETE FROM installed_pack WHERE pack_id = ?1")?
                .execute([pack_id])?;
            Ok(())
        })
    }

    /// Every `pack_item` row of a pack, ordered by `item`.
    pub fn pack_items(&self, pack_id: &str) -> Result<Vec<PackItemRow>> {
        self.with(|c| {
            let mut stmt = c.prepare_cached(&format!(
                "SELECT {ITEM_COLUMNS} FROM pack_item WHERE pack_id = ?1 ORDER BY item"
            ))?;
            let rows = stmt
                .query_map([pack_id], item_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// One `pack_item` row, if present.
    pub fn pack_item(&self, pack_id: &str, item: &str) -> Result<Option<PackItemRow>> {
        self.with(|c| {
            Ok(c.prepare_cached(&format!(
                "SELECT {ITEM_COLUMNS} FROM pack_item WHERE pack_id = ?1 AND item = ?2"
            ))?
            .query_row([pack_id, item], item_row)
            .optional()?)
        })
    }

    /// Inserts or replaces one item row with exactly the given values.
    pub fn pack_item_upsert(&self, row: &PackItemRow) -> Result<()> {
        self.with(|c| {
            c.prepare_cached(&format!(
                "INSERT INTO pack_item ({ITEM_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT (pack_id, item) DO UPDATE SET
                   bytes = excluded.bytes, sha256 = excluded.sha256, pinned = excluded.pinned,
                   fetched_at = excluded.fetched_at, last_used_at = excluded.last_used_at"
            ))?
            .execute(params![
                row.pack_id,
                row.item,
                bytes_to_db(row.bytes),
                row.sha256,
                i64::from(row.pinned),
                row.fetched_at,
                row.last_used_at,
            ])?;
            Ok(())
        })
    }

    /// Removes one item row (no-op when absent).
    pub fn pack_item_delete(&self, pack_id: &str, item: &str) -> Result<()> {
        self.with(|c| {
            c.prepare_cached("DELETE FROM pack_item WHERE pack_id = ?1 AND item = ?2")?
                .execute([pack_id, item])?;
            Ok(())
        })
    }

    /// Removes every item row of a pack in one statement; returns how many were removed.
    pub fn pack_items_clear(&self, pack_id: &str) -> Result<u32> {
        self.with(|c| {
            let n = c
                .prepare_cached("DELETE FROM pack_item WHERE pack_id = ?1")?
                .execute([pack_id])?;
            Ok(u32::try_from(n).unwrap_or(u32::MAX))
        })
    }

    /// Sets `last_used_at = now` (LRU for the stream cache). A missing row is a no-op.
    pub fn pack_item_touch(&self, pack_id: &str, item: &str) -> Result<()> {
        let now = self.now_ms();
        self.with(|c| {
            c.prepare_cached(
                "UPDATE pack_item SET last_used_at = ?3 WHERE pack_id = ?1 AND item = ?2",
            )?
            .execute(params![pack_id, item, now])?;
            Ok(())
        })
    }

    /// `pinned = 0 ORDER BY last_used_at`, at most `limit` rows (least recently used first; served by the
    /// `pack_item_lru` index).
    pub fn pack_items_evictable(&self, limit: u32) -> Result<Vec<PackItemRow>> {
        self.with(|c| {
            let mut stmt = c.prepare_cached(&format!(
                "SELECT {ITEM_COLUMNS} FROM pack_item WHERE pinned = 0
                 ORDER BY last_used_at, pack_id, item LIMIT ?1"
            ))?;
            let rows = stmt
                .query_map([limit], item_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    fn temp_db() -> (tempfile::TempDir, UserDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = UserDb::open(&dir.path().join("user.db")).unwrap();
        (dir, db)
    }

    fn installed(pack_id: &str, kind: PackKind) -> InstalledPackRow {
        InstalledPackRow {
            pack_id: pack_id.into(),
            kind,
            version: "1.1.2".into(),
            path: Some(format!("translation/{pack_id}/1.1.2/pack.db")),
            status: InstalledStatus::Installed,
            bytes: 5_000_000_000,
            items_total: 1,
            items_present: 1,
            sha256: Some("ab".repeat(32)),
            source_version: Some(r#"{"version":"1.1.2"}"#.into()),
            installed_at: 1_760_000_000_000,
            updated_at: 1_760_000_000_500,
            last_checked_at: None,
        }
    }

    fn item(pack_id: &str, item: &str, pinned: bool, last_used_at: i64) -> PackItemRow {
        PackItemRow {
            pack_id: pack_id.into(),
            item: item.into(),
            bytes: 1234,
            sha256: "cd".repeat(32),
            pinned,
            fetched_at: 10,
            last_used_at,
        }
    }

    #[test]
    fn status_text_round_trips() {
        for s in [
            InstalledStatus::Installed,
            InstalledStatus::Partial,
            InstalledStatus::Paused,
            InstalledStatus::Failed,
            InstalledStatus::Removing,
        ] {
            assert_eq!(InstalledStatus::parse(s.as_str()), Some(s));
        }
        assert_eq!(InstalledStatus::parse("gone"), None);
    }

    #[test]
    fn kind_text_matches_the_ipc_names() {
        for kind in [
            PackKind::MushafFonts,
            PackKind::Decor,
            PackKind::Translation,
            PackKind::Tafsir,
            PackKind::Recitation,
            PackKind::Wbw,
        ] {
            let json = serde_json::to_value(kind).unwrap();
            assert_eq!(json.as_str(), Some(kind_str(kind)));
            assert_eq!(parse_kind(kind_str(kind)), Some(kind));
        }
        assert_eq!(parse_kind("video"), None);
    }

    #[test]
    fn installed_rows_round_trip_and_upsert_replaces() {
        let (_dir, db) = temp_db();
        assert!(db.packs_installed().unwrap().is_empty());
        let mut a = installed("tr.en.saheeh", PackKind::Translation);
        db.pack_upsert(&a).unwrap();
        db.pack_upsert(&installed("decor", PackKind::Decor))
            .unwrap();
        assert_eq!(db.pack_installed("tr.en.saheeh").unwrap(), Some(a.clone()));
        a.status = InstalledStatus::Partial;
        a.items_present = 0;
        a.last_checked_at = Some(42);
        a.bytes = u64::MAX; // saturates at i64::MAX
        db.pack_upsert(&a).unwrap();
        let rows = db.packs_installed().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].pack_id, "decor");
        assert_eq!(rows[1].status, InstalledStatus::Partial);
        assert_eq!(rows[1].last_checked_at, Some(42));
        assert_eq!(rows[1].bytes, u64::try_from(i64::MAX).unwrap());
        db.pack_delete("tr.en.saheeh").unwrap();
        db.pack_delete("tr.en.saheeh").unwrap(); // idempotent
        assert_eq!(db.pack_installed("tr.en.saheeh").unwrap(), None);
        assert_eq!(db.packs_installed().unwrap().len(), 1);
    }

    #[test]
    fn set_checked_stamps_only_last_checked_at() {
        let (_dir, db) = temp_db();
        let row = installed("tr.en.saheeh", PackKind::Translation);
        db.pack_upsert(&row).unwrap();
        assert!(
            db.pack_set_checked("tr.en.saheeh", 1_760_000_009_000)
                .unwrap()
        );
        assert_eq!(
            db.pack_installed("tr.en.saheeh").unwrap(),
            Some(InstalledPackRow {
                last_checked_at: Some(1_760_000_009_000),
                ..row
            }),
            "every other column is kept"
        );
        assert!(
            !db.pack_set_checked("tr.fr.hameedullah", 1).unwrap(),
            "no row, nothing stamped"
        );
        assert_eq!(db.pack_installed("tr.fr.hameedullah").unwrap(), None);
    }

    #[test]
    fn unknown_kinds_are_skipped() {
        let (_dir, db) = temp_db();
        db.pack_upsert(&installed("decor", PackKind::Decor))
            .unwrap();
        db.with(|c| {
            c.execute(
                "INSERT INTO installed_pack (pack_id, kind, version, status, installed_at, updated_at)
                 VALUES ('video.x', 'video', '1', 'installed', 0, 0)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let ids: Vec<String> = db
            .packs_installed()
            .unwrap()
            .into_iter()
            .map(|r| r.pack_id)
            .collect();
        assert_eq!(ids, ["decor"]);
        assert_eq!(db.pack_installed("video.x").unwrap(), None);
    }

    #[test]
    fn items_upsert_touch_delete_and_evict_in_lru_order() {
        let (_dir, db) = temp_db();
        db.pack_item_upsert(&item("audio.qdc.7", "002", false, 300))
            .unwrap();
        db.pack_item_upsert(&item("audio.qdc.7", "001", true, 100))
            .unwrap();
        db.pack_item_upsert(&item("audio.qdc.5", "018", false, 200))
            .unwrap();
        db.pack_item_upsert(&item("mushaf.v2", "p262", true, 50))
            .unwrap();
        let items = db.pack_items("audio.qdc.7").unwrap();
        assert_eq!(
            items.iter().map(|i| i.item.as_str()).collect::<Vec<_>>(),
            ["001", "002"]
        );
        assert!(items[0].pinned && !items[1].pinned);

        let evictable = db.pack_items_evictable(10).unwrap();
        assert_eq!(
            evictable
                .iter()
                .map(|i| (i.pack_id.as_str(), i.item.as_str()))
                .collect::<Vec<_>>(),
            [("audio.qdc.5", "018"), ("audio.qdc.7", "002")]
        );
        assert_eq!(db.pack_items_evictable(1).unwrap().len(), 1);
        assert!(db.pack_items_evictable(0).unwrap().is_empty());

        db.set_test_clock(Some(1_000));
        db.pack_item_touch("audio.qdc.5", "018").unwrap();
        db.pack_item_touch("audio.qdc.5", "missing").unwrap(); // no-op
        assert_eq!(
            db.pack_item("audio.qdc.5", "018")
                .unwrap()
                .unwrap()
                .last_used_at,
            1_000
        );
        assert_eq!(db.pack_items_evictable(1).unwrap()[0].item, "002");

        // Re-pinning through upsert takes the item out of the evictable set.
        db.pack_item_upsert(&item("audio.qdc.7", "002", true, 300))
            .unwrap();
        assert_eq!(db.pack_items_evictable(10).unwrap().len(), 1);

        db.pack_item_delete("audio.qdc.7", "002").unwrap();
        db.pack_item_delete("audio.qdc.7", "002").unwrap(); // idempotent
        assert_eq!(db.pack_items("audio.qdc.7").unwrap().len(), 1);
        assert_eq!(db.pack_items_clear("audio.qdc.7").unwrap(), 1);
        assert!(db.pack_items("audio.qdc.7").unwrap().is_empty());
        assert_eq!(db.pack_items("mushaf.v2").unwrap().len(), 1);
    }

    #[test]
    fn pack_delete_keeps_item_rows() {
        let (_dir, db) = temp_db();
        db.pack_upsert(&installed("audio.qdc.7", PackKind::Recitation))
            .unwrap();
        db.pack_item_upsert(&item("audio.qdc.7", "001", true, 1))
            .unwrap();
        db.pack_delete("audio.qdc.7").unwrap();
        assert_eq!(db.pack_items("audio.qdc.7").unwrap().len(), 1);
    }
}

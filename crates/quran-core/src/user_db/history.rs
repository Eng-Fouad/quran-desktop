//! Reading/listening/memorising history.
//!
//! - **Dedupe.** A record for the same mode and the same place (layout + page; the ayah when there is no page) as an
//!   entry from the last [`HISTORY_DEDUPE_MS`] replaces that entry: the merged entry moves to the top (newest id) with
//!   the summed dwell time and the latest ayah. Paging back and forth therefore never fills the list with duplicates.
//! - **Bounded.** At most [`HISTORY_MAX_ENTRIES`] entries are kept (the oldest are dropped).
//! - **Order.** Newest first by id; `before_id` pages backwards.

use quran_types::{HistoryEntry, HistoryInput, HistoryMode};
use rusqlite::{OptionalExtension, params};

use super::{UserDb, check_ayah, check_page, col_u32, layout_from_db, ms_to_secs, opt_col_u32};
use crate::Result;

/// Records of the same place within this window are merged (10 minutes).
pub const HISTORY_DEDUPE_MS: i64 = 10 * 60 * 1000;
/// Oldest entries beyond this count are dropped.
pub const HISTORY_MAX_ENTRIES: u32 = 10_000;
/// Upper bound of one `history_list` page.
pub const HISTORY_LIST_MAX: u32 = 1_000;

const fn mode_str(m: HistoryMode) -> &'static str {
    match m {
        HistoryMode::Read => "read",
        HistoryMode::Listen => "listen",
        HistoryMode::Memorize => "memorize",
    }
}

fn parse_mode(s: &str) -> Option<HistoryMode> {
    Some(match s {
        "read" => HistoryMode::Read,
        "listen" => HistoryMode::Listen,
        "memorize" => HistoryMode::Memorize,
        _ => return None,
    })
}

impl UserDb {
    /// Dedupes the same page within 10 minutes.
    pub fn history_record(&self, h: &HistoryInput) -> Result<()> {
        check_ayah(h.ayah_id, "ayah")?;
        check_page(h.page)?;
        let now = self.now_ms();
        let mushaf_id = h.layout.map(|l| l.db_id());
        self.with_tx(|tx| {
            // The same place: page (and layout) when known, else the ayah.
            let previous: Option<(i64, i64)> = tx
                .prepare_cached(
                    "SELECT id, dwell_s FROM history_entry
                     WHERE mode = ?1 AND at >= ?2
                       AND ((?4 IS NOT NULL AND page = ?4 AND mushaf_id IS ?3)
                         OR (?4 IS NULL AND page IS NULL AND ayah_id = ?5))
                     ORDER BY id DESC LIMIT 1",
                )?
                .query_row(
                    params![mode_str(h.mode), now - HISTORY_DEDUPE_MS, mushaf_id, h.page, h.ayah_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let mut dwell = i64::from(h.dwell_s);
            if let Some((id, previous_dwell)) = previous {
                tx.prepare_cached("DELETE FROM history_entry WHERE id = ?1")?.execute([id])?;
                dwell = dwell.saturating_add(previous_dwell.max(0)).min(i64::from(u32::MAX));
            }
            tx.prepare_cached(
                "INSERT INTO history_entry (at, mode, mushaf_id, page, ayah_id, dwell_s) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?
            .execute(params![now, mode_str(h.mode), mushaf_id, h.page, h.ayah_id, dwell])?;
            tx.prepare_cached(
                "DELETE FROM history_entry WHERE id <= (SELECT id FROM history_entry ORDER BY id DESC LIMIT 1 OFFSET ?1)",
            )?
            .execute([HISTORY_MAX_ENTRIES])?;
            Ok(())
        })
    }

    /// Newest first; at most `limit` entries (capped at [`HISTORY_LIST_MAX`]; 0 returns none), older than `before_id`
    /// when given.
    pub fn history_list(&self, limit: u32, before_id: Option<u32>) -> Result<Vec<HistoryEntry>> {
        let limit = limit.min(HISTORY_LIST_MAX);
        type Raw = (i64, i64, String, Option<i64>, Option<i64>, i64, i64);
        let raws: Vec<Raw> = self.with(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT id, at, mode, mushaf_id, page, ayah_id, dwell_s FROM history_entry
                 WHERE id < ?1 ORDER BY id DESC LIMIT ?2",
            )?;
            // A plain rowid range (no `?1 IS NULL OR …`), so SQLite walks the primary key backwards from `before_id`.
            let before = before_id.map_or(i64::MAX, i64::from);
            let rows = stmt
                .query_map(params![before, limit], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<Raw>>>()?;
            Ok(rows)
        })?;
        let mut out = Vec::with_capacity(raws.len());
        for (id, at, mode, mushaf_id, page, ayah_id, dwell_s) in raws {
            let Some(mode) = parse_mode(&mode) else {
                continue; // excluded by the CHECK constraint
            };
            out.push(HistoryEntry {
                id: col_u32(id, "history_entry.id")?,
                at: ms_to_secs(at),
                mode,
                layout: layout_from_db(mushaf_id),
                page: opt_col_u32(page, "history_entry.page")?,
                ayah_id: col_u32(ayah_id, "history_entry.ayah_id")?,
                dwell_s: col_u32(dwell_s, "history_entry.dwell_s")?,
            });
        }
        Ok(out)
    }

    /// Deletes every history entry.
    pub fn history_clear(&self) -> Result<()> {
        self.with(|c| {
            c.execute("DELETE FROM history_entry", [])?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use quran_types::MushafLayout;

    use super::*;
    use crate::CoreError;

    const T0: i64 = 1_700_000_000_000;

    fn temp_db() -> (tempfile::TempDir, UserDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = UserDb::open(&dir.path().join("user.db")).unwrap();
        db.set_test_clock(Some(T0));
        (dir, db)
    }

    fn read(page: u32, ayah_id: u32, dwell_s: u32) -> HistoryInput {
        HistoryInput {
            mode: HistoryMode::Read,
            layout: Some(MushafLayout::V2),
            page: Some(page),
            ayah_id,
            dwell_s,
        }
    }

    fn summary(db: &UserDb) -> Vec<(HistoryMode, Option<u32>, u32, u32)> {
        db.history_list(100, None)
            .unwrap()
            .into_iter()
            .map(|e| (e.mode, e.page, e.ayah_id, e.dwell_s))
            .collect()
    }

    #[test]
    fn records_newest_first_with_seconds() {
        let (_dir, db) = temp_db();
        db.history_record(&read(1, 1, 30)).unwrap();
        db.set_test_clock(Some(T0 + 1_000));
        db.history_record(&read(2, 8, 40)).unwrap();
        let list = db.history_list(10, None).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(
            (list[0].page, list[0].at, list[0].layout),
            (Some(2), 1_700_000_001, Some(MushafLayout::V2))
        );
        assert_eq!((list[1].page, list[1].at), (Some(1), 1_700_000_000));
        assert!(list[0].id > list[1].id);
    }

    #[test]
    fn the_same_page_within_ten_minutes_is_merged_to_the_top() {
        let (_dir, db) = temp_db();
        db.history_record(&read(10, 100, 20)).unwrap();
        db.set_test_clock(Some(T0 + 60_000));
        db.history_record(&read(11, 110, 30)).unwrap();
        db.set_test_clock(Some(T0 + 120_000));
        db.history_record(&read(10, 105, 5)).unwrap();
        assert_eq!(
            summary(&db),
            [
                (HistoryMode::Read, Some(10), 105, 25),
                (HistoryMode::Read, Some(11), 110, 30)
            ]
        );
        // Another mode on the same page is its own entry.
        db.history_record(&HistoryInput {
            mode: HistoryMode::Listen,
            dwell_s: 0,
            ..read(10, 105, 0)
        })
        .unwrap();
        assert_eq!(summary(&db).len(), 3);
        // A different layout is a different place.
        db.history_record(&HistoryInput {
            layout: Some(MushafLayout::V1),
            ..read(10, 105, 1)
        })
        .unwrap();
        assert_eq!(summary(&db).len(), 4);
        // After the window, the same page starts a new entry.
        db.set_test_clock(Some(T0 + 120_000 + HISTORY_DEDUPE_MS + 1));
        db.history_record(&read(10, 106, 7)).unwrap();
        assert_eq!(summary(&db).len(), 5);
        assert_eq!(summary(&db)[0], (HistoryMode::Read, Some(10), 106, 7));
    }

    #[test]
    fn records_without_a_page_dedupe_by_ayah() {
        let (_dir, db) = temp_db();
        let tr = |ayah_id| HistoryInput {
            mode: HistoryMode::Read,
            layout: None,
            page: None,
            ayah_id,
            dwell_s: 10,
        };
        db.history_record(&tr(7)).unwrap();
        db.history_record(&tr(8)).unwrap();
        db.history_record(&tr(7)).unwrap();
        assert_eq!(
            summary(&db),
            [
                (HistoryMode::Read, None, 7, 20),
                (HistoryMode::Read, None, 8, 10)
            ]
        );
    }

    #[test]
    fn paging_and_limits() {
        let (_dir, db) = temp_db();
        for page in 1..=5 {
            db.history_record(&read(page, 1, 1)).unwrap();
        }
        let first = db.history_list(2, None).unwrap();
        assert_eq!(
            first.iter().map(|e| e.page).collect::<Vec<_>>(),
            [Some(5), Some(4)]
        );
        let next = db.history_list(2, Some(first[1].id)).unwrap();
        assert_eq!(
            next.iter().map(|e| e.page).collect::<Vec<_>>(),
            [Some(3), Some(2)]
        );
        assert!(db.history_list(0, None).unwrap().is_empty());
        assert_eq!(db.history_list(u32::MAX, None).unwrap().len(), 5);
        db.history_clear().unwrap();
        assert!(db.history_list(10, None).unwrap().is_empty());
    }

    #[test]
    fn the_history_is_bounded() {
        let (_dir, db) = temp_db();
        db.with(|c| {
            c.execute(
                "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
                 INSERT INTO history_entry (at, mode, page, mushaf_id, ayah_id) SELECT i, 'read', 1, 1, 1 FROM n",
                [HISTORY_MAX_ENTRIES + 5],
            )?;
            Ok(())
        })
        .unwrap();
        db.history_record(&read(2, 9, 1)).unwrap();
        let count: i64 = db
            .with(|c| Ok(c.query_row("SELECT count(*) FROM history_entry", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(count, i64::from(HISTORY_MAX_ENTRIES));
        assert_eq!(
            db.history_list(1, None).unwrap()[0].page,
            Some(2),
            "the newest entry is kept"
        );
    }

    #[test]
    fn invalid_records_are_rejected() {
        let (_dir, db) = temp_db();
        assert!(matches!(
            db.history_record(&read(0, 1, 1)),
            Err(CoreError::InvalidArgument(_))
        ));
        assert!(matches!(
            db.history_record(&read(1, 7000, 1)),
            Err(CoreError::InvalidArgument(_))
        ));
        assert!(db.history_list(10, None).unwrap().is_empty());
    }
}

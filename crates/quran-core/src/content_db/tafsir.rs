//! Quran.com tafsir entries (ayah ranges) per pack and chapter (§3.3). Owner: WP1c.
//!
//! An entry covers `from_ayah_id..=to_ayah_id` (Quran.com groups ayahs: a row with empty text extends the previous
//! row's range, §2.5.6). A chapter's entries are the rows whose `from_ayah_id` lies in its surah's ayah-id range
//! ([`super::geometry`]); entries never cross a surah and never overlap.

use rusqlite::{OptionalExtension, params};

use super::{
    ChapterStamp, ContentDb, TafsirRow, check_chapter, duplicate, geometry, upsert_chapter,
};
use crate::{CoreError, Result};

impl ContentDb {
    /// The entry whose range contains `ayah_id` (`from_ayah_id <= ?2 ORDER BY from_ayah_id DESC LIMIT 1`, then
    /// `to_ayah_id >= ?2`).
    pub fn tafsir_get(&self, pack_id: &str, ayah_id: u32) -> Result<Option<TafsirRow>> {
        self.with(|c| {
            let row = c
                .prepare_cached(
                    "SELECT from_ayah_id, to_ayah_id, html FROM tafsir_entry
                     WHERE pack_id = ?1 AND from_ayah_id <= ?2 ORDER BY from_ayah_id DESC LIMIT 1",
                )?
                .query_row(params![pack_id, ayah_id], |r| {
                    Ok(TafsirRow {
                        from_ayah_id: r.get(0)?,
                        to_ayah_id: r.get(1)?,
                        html: r.get(2)?,
                    })
                })
                .optional()?;
            Ok(row.filter(|r| r.to_ayah_id >= ayah_id))
        })
    }

    /// Replaces the chapter's rows and its `content_chapter` stamp in one transaction. Rows may arrive in any order;
    /// each must lie within `surah` (`from ≤ to`) and no two may overlap. The stamp's `pinned` only ever goes up here
    /// (see [`ContentDb::chapters_set_pinned`]).
    pub fn tafsir_put_chapter(
        &self,
        pack_id: &str,
        surah: u32,
        rows: &[TafsirRow],
        stamp: &ChapterStamp,
    ) -> Result<()> {
        check_chapter(pack_id, surah, stamp)?;
        let ayahs = geometry::surah_ayah_ids(surah).ok_or_else(|| {
            CoreError::InvalidArgument(format!("surah {surah} is outside 1..=114"))
        })?;
        let mut ranges: Vec<(u32, u32)> = rows
            .iter()
            .map(|r| (r.from_ayah_id, r.to_ayah_id))
            .collect();
        ranges.sort_unstable();
        for &(from, to) in &ranges {
            if from > to || !ayahs.contains(&from) || !ayahs.contains(&to) {
                return Err(CoreError::InvalidArgument(format!(
                    "tafsir {pack_id} chapter {surah}: range {from}..={to} is not within {}..={}",
                    ayahs.start(),
                    ayahs.end()
                )));
            }
        }
        for pair in ranges.windows(2) {
            if let [(a_from, a_to), (b_from, _)] = pair
                && b_from <= a_to
            {
                return Err(CoreError::InvalidArgument(format!(
                    "tafsir {pack_id} chapter {surah}: range starting at {b_from} overlaps {a_from}..={a_to}"
                )));
            }
        }
        self.with_tx(|tx| {
            tx.prepare_cached(
                "DELETE FROM tafsir_entry WHERE pack_id = ?1 AND from_ayah_id BETWEEN ?2 AND ?3",
            )?
            .execute(params![pack_id, ayahs.start(), ayahs.end()])?;
            let mut insert = tx.prepare_cached(
                "INSERT INTO tafsir_entry (pack_id, from_ayah_id, to_ayah_id, html) VALUES (?1, ?2, ?3, ?4)",
            )?;
            for r in rows {
                insert
                    .execute(params![pack_id, r.from_ayah_id, r.to_ayah_id, r.html])
                    .map_err(|e| {
                        duplicate(e, || {
                            format!("tafsir {pack_id}: two entries start at ayah {}", r.from_ayah_id)
                        })
                    })?;
            }
            upsert_chapter(tx, pack_id, stamp)
        })
    }
}

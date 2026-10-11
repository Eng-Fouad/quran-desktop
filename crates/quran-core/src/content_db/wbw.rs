//! Word-by-word rows per pack and chapter (§3.3). Owner: WP1c.
//!
//! `wbw` has no surah column: a chapter is the contiguous word-id range of its surah ([`super::geometry`]), so a
//! chapter is replaced or cleared by range, and rows outside the surah are rejected on write.

use quran_types::WbwEntry;
use rusqlite::params;

use super::{ChapterStamp, ContentDb, check_chapter, duplicate, geometry, upsert_chapter};
use crate::{CoreError, Result};

impl ContentDb {
    /// Rows with `word_id BETWEEN from AND to`, by word id (empty when `from > to`). `WbwEntry.text` is left empty:
    /// the caller fills it from core.db.
    pub fn wbw_range(&self, pack_id: &str, from: u32, to: u32) -> Result<Vec<WbwEntry>> {
        if from > to {
            return Ok(Vec::new());
        }
        self.with(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT word_id, translation, transliteration FROM wbw
                 WHERE pack_id = ?1 AND word_id BETWEEN ?2 AND ?3 ORDER BY word_id",
            )?;
            let rows = stmt
                .query_map(params![pack_id, from, to], |r| {
                    Ok(WbwEntry {
                        word_id: r.get(0)?,
                        text: String::new(),
                        translation: r.get(1)?,
                        transliteration: r.get(2)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// Replaces the chapter's rows and its `content_chapter` stamp in one transaction. Every row must be a word of
    /// `surah` (end markers have no WBW row upstream, but are accepted), each word at most once; `WbwEntry.text` is not
    /// stored. The stamp's `pinned` only ever goes up here (see [`ContentDb::chapters_set_pinned`]).
    pub fn wbw_put_chapter(
        &self,
        pack_id: &str,
        surah: u32,
        rows: &[WbwEntry],
        stamp: &ChapterStamp,
    ) -> Result<()> {
        check_chapter(pack_id, surah, stamp)?;
        let words = geometry::surah_word_ids(surah).ok_or_else(|| {
            CoreError::InvalidArgument(format!("surah {surah} is outside 1..=114"))
        })?;
        if let Some(stray) = rows.iter().find(|r| !words.contains(&r.word_id)) {
            return Err(CoreError::InvalidArgument(format!(
                "wbw {pack_id} chapter {surah}: word {} is not in {}..={}",
                stray.word_id,
                words.start(),
                words.end()
            )));
        }
        self.with_tx(|tx| {
            tx.prepare_cached("DELETE FROM wbw WHERE pack_id = ?1 AND word_id BETWEEN ?2 AND ?3")?
                .execute(params![pack_id, words.start(), words.end()])?;
            let mut insert = tx.prepare_cached(
                "INSERT INTO wbw (pack_id, word_id, translation, transliteration) VALUES (?1, ?2, ?3, ?4)",
            )?;
            for r in rows {
                insert
                    .execute(params![pack_id, r.word_id, r.translation, r.transliteration])
                    .map_err(|e| {
                        duplicate(e, || {
                            format!("wbw {pack_id} chapter {surah}: word {} appears twice", r.word_id)
                        })
                    })?;
            }
            upsert_chapter(tx, pack_id, stamp)
        })
    }
}

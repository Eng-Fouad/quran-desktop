//! "Clear cache": every unpinned row, in one transaction.
//!
//! Removed: unpinned `timing_file` rows with their `timing_ayah` rows, unpinned `content_chapter` rows with their
//! `wbw`/`tafsir_entry` rows (by the chapter's id ranges, [`super::geometry`]), and every `kv` row. Pinned timings and
//! chapters (installed packs, pinned audio) survive. The file is then compacted (best effort) so the freed space
//! reaches the disk.

use rusqlite::params;

use super::{ClearReport, ContentDb, geometry};
use crate::Result;

/// Bytes counted per INTEGER value in [`ClearReport::bytes`].
const INT: i64 = 8;

impl ContentDb {
    /// Deletes every row with `pinned = 0` (timings, chapters and their wbw/tafsir rows) and all `kv` rows, in one
    /// transaction; returns what was removed so `PackManager` can re-sync `installed_pack`.
    /// `bytes` is the payload of the removed rows: TEXT/BLOB octets plus 8 bytes per INTEGER value.
    pub fn clear_unpinned(&self) -> Result<ClearReport> {
        let report = self.with_tx(|tx| {
            let mut report = ClearReport::default();
            let mut bytes: i64 = 0;

            // Timings.
            bytes = bytes.saturating_add(tx.query_row(
                "SELECT coalesce(sum(octet_length(audio_url) + coalesce(octet_length(etag), 0)
                                     + octet_length(source) + octet_length(payload_sha256) + ?1 * 7), 0)
                 FROM timing_file WHERE pinned = 0",
                [INT],
                |r| r.get::<_, i64>(0),
            )?);
            bytes = bytes.saturating_add(tx.query_row(
                "SELECT coalesce(sum(octet_length(words) + ?1 * 5), 0) FROM timing_ayah
                 WHERE (reciter_id, surah) IN (SELECT reciter_id, surah FROM timing_file WHERE pinned = 0)",
                [INT],
                |r| r.get::<_, i64>(0),
            )?);
            {
                let mut stmt = tx.prepare(
                    "SELECT reciter_id, surah FROM timing_file WHERE pinned = 0 ORDER BY reciter_id, surah",
                )?;
                report.timings = stmt
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
            }
            tx.execute(
                "DELETE FROM timing_ayah
                 WHERE (reciter_id, surah) IN (SELECT reciter_id, surah FROM timing_file WHERE pinned = 0)",
                [],
            )?;
            tx.execute("DELETE FROM timing_file WHERE pinned = 0", [])?;

            // WBW and tafsir chapters.
            {
                let mut stmt = tx.prepare(
                    "SELECT pack_id, surah FROM content_chapter WHERE pinned = 0 ORDER BY pack_id, surah",
                )?;
                report.chapters = stmt
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
            }
            for (pack_id, surah) in &report.chapters {
                if let Some(words) = geometry::surah_word_ids(*surah) {
                    let (lo, hi) = (*words.start(), *words.end());
                    bytes = bytes.saturating_add(tx.query_row(
                        "SELECT coalesce(sum(octet_length(pack_id) + coalesce(octet_length(translation), 0)
                                             + coalesce(octet_length(transliteration), 0) + 8), 0)
                         FROM wbw WHERE pack_id = ?1 AND word_id BETWEEN ?2 AND ?3",
                        params![pack_id, lo, hi],
                        |r| r.get::<_, i64>(0),
                    )?);
                    tx.execute(
                        "DELETE FROM wbw WHERE pack_id = ?1 AND word_id BETWEEN ?2 AND ?3",
                        params![pack_id, lo, hi],
                    )?;
                }
                if let Some(ayahs) = geometry::surah_ayah_ids(*surah) {
                    let (lo, hi) = (*ayahs.start(), *ayahs.end());
                    bytes = bytes.saturating_add(tx.query_row(
                        "SELECT coalesce(sum(octet_length(pack_id) + octet_length(html) + 16), 0)
                         FROM tafsir_entry WHERE pack_id = ?1 AND from_ayah_id BETWEEN ?2 AND ?3",
                        params![pack_id, lo, hi],
                        |r| r.get::<_, i64>(0),
                    )?);
                    tx.execute(
                        "DELETE FROM tafsir_entry WHERE pack_id = ?1 AND from_ayah_id BETWEEN ?2 AND ?3",
                        params![pack_id, lo, hi],
                    )?;
                }
            }
            bytes = bytes.saturating_add(tx.query_row(
                "SELECT coalesce(sum(octet_length(pack_id) + octet_length(sha256) + ?1 * 3), 0)
                 FROM content_chapter WHERE pinned = 0",
                [INT],
                |r| r.get::<_, i64>(0),
            )?);
            tx.execute("DELETE FROM content_chapter WHERE pinned = 0", [])?;

            // The disposable kv cache.
            bytes = bytes.saturating_add(tx.query_row(
                "SELECT coalesce(sum(octet_length(key) + octet_length(value) + ?1), 0) FROM kv",
                [INT],
                |r| r.get::<_, i64>(0),
            )?);
            tx.execute("DELETE FROM kv", [])?;

            report.bytes = u64::try_from(bytes).unwrap_or(0);
            Ok(report)
        })?;
        if report.bytes > 0 {
            self.compact();
        }
        Ok(report)
    }

    /// `VACUUM` + `wal_checkpoint(TRUNCATE)`, so a clear frees disk space. Best effort: a failure (e.g. too little
    /// free space for VACUUM's temporary copy) only means the space is reused later, so it is logged, not returned.
    fn compact(&self) {
        let outcome = self.with(|c| {
            c.execute_batch("VACUUM")?;
            c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
            Ok(())
        });
        if let Err(e) = outcome {
            log::warn!("content.db: compaction after clear failed: {e}");
        }
    }
}

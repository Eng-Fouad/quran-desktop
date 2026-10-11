//! `timing_file` + `timing_ayah` rows (§3.3). Owner: WP1c.
//!
//! A timing set belongs to one exact audio file (`audio_url` + `content_length`). `pinned = 1` while the matching audio
//! file is pinned (an explicit download, and the reciter's surah 1 that every basmala plays from), so "Clear cache"
//! keeps what offline playback of pinned audio needs (D20).

use rusqlite::{OptionalExtension, params};

use super::{ContentDb, geometry};
use crate::timings::{StoredTimings, TimedAyah, TimingFile, pack_words, unpack_words};
use crate::{CoreError, Result};

/// One `timing_file` row without its ayahs: presence, revalidation and pin state (re-sync, revalidation, and the
/// reciter's real `word_level`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimingStamp {
    pub reciter_id: u32,
    pub surah: u32,
    pub audio_url: String,
    pub content_length: Option<u64>,
    /// `"qdc"`.
    pub source: String,
    pub fetched_at_ms: i64,
    pub word_level: bool,
    pub pinned: bool,
}

impl ContentDb {
    /// The stored timings of one surah file, ayahs in order, or `None`.
    pub fn timings_get(&self, reciter: u32, surah: u32) -> Result<Option<StoredTimings>> {
        self.with(|c| {
            let file = c
                .prepare_cached(
                    "SELECT audio_url, content_length, duration_ms, word_level, source, fetched_at, etag,
                            payload_sha256
                     FROM timing_file WHERE reciter_id = ?1 AND surah = ?2",
                )?
                .query_row(params![reciter, surah], |r| {
                    Ok((
                        TimingFile {
                            reciter_id: reciter,
                            surah,
                            audio_url: r.get(0)?,
                            content_length: None,
                            duration_ms: r.get(2)?,
                            source: r.get(4)?,
                            fetched_at_ms: r.get(5)?,
                            etag: r.get(6)?,
                            payload_sha256: r.get(7)?,
                        },
                        r.get::<_, Option<i64>>(1)?,
                        r.get::<_, bool>(3)?,
                    ))
                })
                .optional()?;
            let Some((mut file, content_length, word_level)) = file else {
                return Ok(None);
            };
            file.content_length = content_length
                .map(|n| {
                    u64::try_from(n).map_err(|_| {
                        CoreError::Corrupt(format!(
                            "timings {reciter}/{surah}: negative content_length {n}"
                        ))
                    })
                })
                .transpose()?;
            let mut stmt = c.prepare_cached(
                "SELECT ayah, from_ms, to_ms, words FROM timing_ayah
                 WHERE reciter_id = ?1 AND surah = ?2 ORDER BY ayah",
            )?;
            let rows = stmt
                .query_map(params![reciter, surah], |r| {
                    Ok((
                        r.get::<_, u32>(0)?,
                        r.get::<_, u32>(1)?,
                        r.get::<_, u32>(2)?,
                        r.get::<_, Vec<u8>>(3)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let ayahs = rows
                .into_iter()
                .map(|(ayah, from_ms, to_ms, words)| {
                    Ok(TimedAyah {
                        ayah,
                        from_ms,
                        to_ms,
                        words: unpack_words(&words)?,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(Some(StoredTimings {
                file,
                ayahs,
                word_level,
            }))
        })
    }

    /// File + ayah rows in one transaction, replacing any previous timings of `(reciter, surah)`. `pinned` only ever
    /// goes up here: timings that are already pinned stay pinned (a revalidation refetch never unpins them; use
    /// [`ContentDb::timings_set_pinned`]).
    ///
    /// The ayahs must be strictly increasing, start at 1 or later and stay within the surah's ayah count.
    pub fn timings_put(&self, t: &StoredTimings, pinned: bool) -> Result<()> {
        let TimingFile {
            reciter_id, surah, ..
        } = t.file;
        check_timings(t)?;
        let content_length = t
            .file
            .content_length
            .map(|n| {
                i64::try_from(n).map_err(|_| {
                    CoreError::InvalidArgument(format!("content_length {n} is out of range"))
                })
            })
            .transpose()?;
        self.with_tx(|tx| {
            tx.prepare_cached(
                "INSERT INTO timing_file (reciter_id, surah, audio_url, content_length, duration_ms, word_level,
                                          source, fetched_at, etag, payload_sha256, pinned)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT (reciter_id, surah) DO UPDATE SET
                   audio_url = excluded.audio_url, content_length = excluded.content_length,
                   duration_ms = excluded.duration_ms, word_level = excluded.word_level, source = excluded.source,
                   fetched_at = excluded.fetched_at, etag = excluded.etag, payload_sha256 = excluded.payload_sha256,
                   pinned = max(timing_file.pinned, excluded.pinned)",
            )?
            .execute(params![
                reciter_id,
                surah,
                t.file.audio_url,
                content_length,
                t.file.duration_ms,
                t.word_level,
                t.file.source,
                t.file.fetched_at_ms,
                t.file.etag,
                t.file.payload_sha256,
                pinned,
            ])?;
            tx.prepare_cached("DELETE FROM timing_ayah WHERE reciter_id = ?1 AND surah = ?2")?
                .execute(params![reciter_id, surah])?;
            let mut insert = tx.prepare_cached(
                "INSERT INTO timing_ayah (reciter_id, surah, ayah, from_ms, to_ms, words)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for a in &t.ayahs {
                insert.execute(params![
                    reciter_id,
                    surah,
                    a.ayah,
                    a.from_ms,
                    a.to_ms,
                    pack_words(&a.words)
                ])?;
            }
            Ok(())
        })
    }

    /// Pins or unpins one surah's timings (its audio file was pinned or unpinned). Unpinning missing timings is a
    /// no-op; pinning missing timings is `NotFound` (a pinned file without timings could not play offline).
    pub fn timings_set_pinned(&self, reciter: u32, surah: u32, pinned: bool) -> Result<()> {
        self.with(|c| {
            let changed = c
                .prepare_cached(
                    "UPDATE timing_file SET pinned = ?3 WHERE reciter_id = ?1 AND surah = ?2",
                )?
                .execute(params![reciter, surah, pinned])?;
            if changed == 0 && pinned {
                return Err(CoreError::NotFound(format!(
                    "timings of reciter {reciter} surah {surah}"
                )));
            }
            Ok(())
        })
    }

    /// Deletes one surah's timings (file and ayah rows), pinned or not. Idempotent.
    pub fn timings_delete(&self, reciter: u32, surah: u32) -> Result<()> {
        self.with_tx(|tx| {
            tx.prepare_cached("DELETE FROM timing_ayah WHERE reciter_id = ?1 AND surah = ?2")?
                .execute(params![reciter, surah])?;
            tx.prepare_cached("DELETE FROM timing_file WHERE reciter_id = ?1 AND surah = ?2")?
                .execute(params![reciter, surah])?;
            Ok(())
        })
    }

    /// The stored timing files of one reciter (or of every reciter with `None`), by reciter and surah.
    pub fn timing_stamps(&self, reciter: Option<u32>) -> Result<Vec<TimingStamp>> {
        self.with(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT reciter_id, surah, audio_url, content_length, source, fetched_at, word_level, pinned
                 FROM timing_file WHERE ?1 IS NULL OR reciter_id = ?1 ORDER BY reciter_id, surah",
            )?;
            let rows = stmt
                .query_map([reciter], |r| {
                    Ok((
                        TimingStamp {
                            reciter_id: r.get(0)?,
                            surah: r.get(1)?,
                            audio_url: r.get(2)?,
                            content_length: None,
                            source: r.get(4)?,
                            fetched_at_ms: r.get(5)?,
                            word_level: r.get(6)?,
                            pinned: r.get(7)?,
                        },
                        r.get::<_, Option<i64>>(3)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows.into_iter()
                .map(|(mut stamp, len)| {
                    stamp.content_length = len.and_then(|n| u64::try_from(n).ok());
                    Ok(stamp)
                })
                .collect()
        })
    }
}

/// Shape checks before a write: a real surah, ayahs strictly increasing within it, `from ≤ to`.
fn check_timings(t: &StoredTimings) -> Result<()> {
    let (reciter, surah) = (t.file.reciter_id, t.file.surah);
    let Some(count) = geometry::surah_ayah_count(surah) else {
        return Err(CoreError::InvalidArgument(format!(
            "timings of reciter {reciter}: surah {surah} is outside 1..=114"
        )));
    };
    let mut previous = 0;
    for a in &t.ayahs {
        if a.ayah <= previous || a.ayah > count {
            return Err(CoreError::InvalidArgument(format!(
                "timings {reciter}/{surah}: ayah {} is out of order or outside 1..={count}",
                a.ayah
            )));
        }
        if a.to_ms < a.from_ms {
            return Err(CoreError::InvalidArgument(format!(
                "timings {reciter}/{surah}: ayah {} ends before it starts",
                a.ayah
            )));
        }
        previous = a.ayah;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

    use super::*;
    use crate::timings::WordSeg;

    fn t(surah: u32, ayahs: &[(u32, u32, u32)]) -> StoredTimings {
        StoredTimings {
            file: TimingFile {
                reciter_id: 7,
                surah,
                audio_url: "u".into(),
                content_length: None,
                duration_ms: None,
                source: "qdc".into(),
                fetched_at_ms: 0,
                etag: None,
                payload_sha256: String::new(),
            },
            ayahs: ayahs
                .iter()
                .map(|&(ayah, from_ms, to_ms)| TimedAyah {
                    ayah,
                    from_ms,
                    to_ms,
                    words: vec![WordSeg {
                        pos: 1,
                        start_ms: from_ms,
                        end_ms: to_ms,
                    }],
                })
                .collect(),
            word_level: true,
        }
    }

    #[test]
    fn shapes_are_checked() {
        assert!(check_timings(&t(112, &[(1, 0, 10), (2, 10, 20), (4, 20, 20)])).is_ok());
        assert!(check_timings(&t(112, &[])).is_ok());
        for bad in [
            t(0, &[(1, 0, 10)]),
            t(115, &[(1, 0, 10)]),
            t(112, &[(0, 0, 10)]),
            t(112, &[(2, 0, 10), (1, 10, 20)]),
            t(112, &[(1, 0, 10), (1, 10, 20)]),
            t(112, &[(5, 0, 10)]),
            t(112, &[(1, 10, 9)]),
        ] {
            assert!(
                matches!(check_timings(&bad), Err(CoreError::InvalidArgument(_))),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn put_get_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let db = ContentDb::open(&dir.path().join("content.db")).unwrap();
        let stored = t(1, &[(1, 0, 900), (2, 900, 2000)]);
        db.timings_put(&stored, false).unwrap();
        assert_eq!(db.timings_get(7, 1).unwrap(), Some(stored));
    }
}
